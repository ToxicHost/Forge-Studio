"""
Forge Studio — Gallery Module (Backend)
by ToxicHost & Moritz
Based on TrackImage v6.8 by Moritz (integrated with permission)

Image library manager: multi-folder scanning, character tagging from filenames,
SD/ComfyUI/EXIF metadata extraction, search, bulk rename/move/delete with undo,
video thumbnail support, trash & restore.

FastAPI routes under /studio/gallery/*, SQLite database in extension data dir.
"""

import asyncio
import hashlib
import json
import os
import platform
import re
import sqlite3
import subprocess
import time
import threading
import traceback
from io import BytesIO
from pathlib import Path
from queue import Queue, Empty
from threading import Thread
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, FileResponse, StreamingResponse

try:
    from PIL import Image, ImageOps
    from PIL.PngImagePlugin import PngInfo
    HAS_PILLOW = True
except ImportError:
    HAS_PILLOW = False
    print("[Gallery] Pillow not available — thumbnails & metadata disabled")

try:
    import imageio_ffmpeg
    FFMPEG_BIN = imageio_ffmpeg.get_ffmpeg_exe()
except ImportError:
    FFMPEG_BIN = "ffmpeg"

try:
    import imagehash
    HAS_IMAGEHASH = True
except ImportError:
    HAS_IMAGEHASH = False
    print("[Gallery] imagehash not installed — duplicate detection disabled")

try:
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler
    HAS_WATCHDOG = True
except ImportError:
    HAS_WATCHDOG = False
    try:
        import subprocess as _sp
        print("[Gallery] watchdog not found — installing...")
        _sp.check_call(
            [os.sys.executable, "-m", "pip", "install", "watchdog", "--quiet"],
            timeout=60,
        )
        from watchdog.observers import Observer
        from watchdog.events import FileSystemEventHandler
        HAS_WATCHDOG = True
        print("[Gallery] watchdog installed successfully")
    except Exception:
        print("[Gallery] watchdog auto-install failed — auto-sync disabled")

TAG = "[Gallery]"
VERSION = "1.1"

# =========================================================================
# AUTO-SYNC: FILESYSTEM WATCHER + SSE
# =========================================================================

_sse_clients = []  # list of Queue objects, one per connected SSE client
_sse_lock = threading.Lock()
_watcher_dirty = threading.Event()
_watcher_suppress = set()  # paths to ignore (set by app actions)
_watcher_suppress_lock = threading.Lock()
_watcher_observer = None
_watcher_running = False


def suppress_path(filepath):
    """Temporarily suppress watcher for a path (called on rename/move/delete)."""
    with _watcher_suppress_lock:
        _watcher_suppress.add(os.path.normpath(filepath))


def unsuppress_path(filepath):
    with _watcher_suppress_lock:
        _watcher_suppress.discard(os.path.normpath(filepath))


def sse_notify(event_type, data=None):
    """Push an SSE event to all connected clients."""
    msg = f"event: {event_type}\ndata: {json.dumps(data or {})}\n\n"
    dead = []
    with _sse_lock:
        for q in _sse_clients:
            try:
                q.put_nowait(msg)
            except Exception:
                dead.append(q)
        for q in dead:
            _sse_clients.remove(q)


def _incremental_sync():
    """Quick diff-scan: compare DB paths vs filesystem, sync differences."""
    if scan_progress.get("active"):
        return  # full scan in progress, don't compete for the DB
    try:
        db = _get_db()
        scan_folders = db.execute("SELECT path FROM scan_folders").fetchall()
        if not scan_folders:
            db.close()
            return

        existing = {}
        for r in db.execute("SELECT id, filepath, filename, folder FROM images").fetchall():
            existing[r["filepath"]] = r

        found_paths = set()
        ignore_words = {
            r["word"].lower()
            for r in db.execute("SELECT word FROM ignore_words").fetchall()
        }
        new_count, removed_count = 0, 0

        for sf in scan_folders:
            root = Path(sf["path"])
            if not root.exists() or not root.is_dir():
                continue
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames.sort()
                rel_folder = os.path.relpath(dirpath, root)
                display_folder = (
                    f"{root.name}\\{rel_folder}" if rel_folder != "." else root.name
                )
                for filename in filenames:
                    ext = Path(filename).suffix.lower()
                    if ext not in MEDIA_EXTENSIONS:
                        continue
                    filepath = os.path.join(dirpath, filename)
                    found_paths.add(filepath)
                    if filepath in existing:
                        continue
                    with _watcher_suppress_lock:
                        if os.path.normpath(filepath) in _watcher_suppress:
                            continue
                    characters = parse_characters_from_filename(filename, ignore_words)
                    file_date = get_file_date(filepath)
                    w, h = 0, 0
                    search = ""
                    ch = ""
                    is_video = ext in VIDEO_EXTENSIONS
                    if is_video:
                        media_type = "video"
                    elif ext == ".gif":
                        media_type = "gif"
                    else:
                        media_type = "image"
                    if HAS_PILLOW and not is_video:
                        try:
                            with Image.open(filepath) as im:
                                w, h = im.size
                        except Exception:
                            pass
                        search = extract_search_text(filepath)
                        ch = compute_content_hash(filepath)
                    cur = db.execute(
                        "INSERT OR IGNORE INTO images "
                        "(filename,folder,filepath,width,height,file_date,search_text,media_type,content_hash) "
                        "VALUES (?,?,?,?,?,?,?,?,?)",
                        (filename, display_folder, filepath, w, h, file_date, search, media_type, ch),
                    )
                    iid = cur.lastrowid
                    if iid == 0:
                        continue
                    new_count += 1
                    # Link orphan metadata saved by content hash before scan
                    if ch:
                        db.execute(
                            "UPDATE image_metadata SET image_id=? "
                            "WHERE content_hash=? AND image_id IS NULL",
                            (iid, ch),
                        )
                    for pos, cn in enumerate(characters):
                        db.execute(
                            "INSERT OR IGNORE INTO characters (name) VALUES (?)", (cn,)
                        )
                        cr = db.execute(
                            "SELECT id FROM characters WHERE name=? COLLATE NOCASE",
                            (cn,),
                        ).fetchone()
                        if cr:
                            db.execute(
                                "INSERT OR IGNORE INTO image_characters "
                                "(image_id,character_id,position) VALUES (?,?,?)",
                                (iid, cr["id"], pos),
                            )

        for fp in list(existing.keys()):
            if fp not in found_paths:
                with _watcher_suppress_lock:
                    if os.path.normpath(fp) in _watcher_suppress:
                        continue
                db.execute("DELETE FROM images WHERE filepath=?", (fp,))
                removed_count += 1

        if new_count or removed_count:
            db.execute(
                "DELETE FROM characters WHERE id NOT IN "
                "(SELECT DISTINCT character_id FROM image_characters)"
            )
            db.commit()
            sse_notify("sync", {"new": new_count, "removed": removed_count})
        db.close()

        with _watcher_suppress_lock:
            _watcher_suppress.clear()
    except Exception as e:
        print(f"{TAG} Auto-sync error: {e}")


def _watcher_loop():
    """Background thread: waits for dirty flag, debounces, then syncs."""
    global _watcher_running
    while _watcher_running:
        _watcher_dirty.wait(timeout=5)
        if not _watcher_dirty.is_set():
            continue
        _watcher_dirty.clear()
        time.sleep(2)
        if _watcher_dirty.is_set():
            continue
        _incremental_sync()


if HAS_WATCHDOG:
    class _FSHandler(FileSystemEventHandler):
        def on_any_event(self, event):
            if event.is_directory:
                return
            src = getattr(event, 'src_path', '')
            ext = Path(src).suffix.lower() if src else ''
            dest = getattr(event, 'dest_path', '')
            dest_ext = Path(dest).suffix.lower() if dest else ''
            if ext in MEDIA_EXTENSIONS or dest_ext in MEDIA_EXTENSIONS:
                _watcher_dirty.set()


def start_watcher():
    """Start the filesystem observer and sync thread."""
    global _watcher_observer, _watcher_running
    if not HAS_WATCHDOG:
        return
    db = _get_db()
    try:
        folders = db.execute("SELECT path FROM scan_folders").fetchall()
    finally:
        db.close()
    if not folders:
        print(f"{TAG} No folders to watch (add folders first)")
        sse_notify("watcher_status", {"active": False})
        return
    _watcher_observer = Observer()
    handler = _FSHandler()
    watched = []
    for sf in folders:
        p = sf["path"]
        if os.path.isdir(p):
            _watcher_observer.schedule(handler, p, recursive=True)
            watched.append(Path(p).name)
    if not watched:
        print(f"{TAG} No valid folders to watch")
        return
    _watcher_running = True
    _watcher_observer.start()
    t = threading.Thread(target=_watcher_loop, daemon=True)
    t.start()
    print(f"{TAG} Watching: {', '.join(watched)}")
    sse_notify("watcher_status", {"active": True})


def stop_watcher():
    global _watcher_observer, _watcher_running
    _watcher_running = False
    if _watcher_observer:
        _watcher_observer.stop()
        _watcher_observer.join(timeout=3)
        _watcher_observer = None


def restart_watcher():
    """Restart watcher (e.g. after adding/removing scan folders)."""
    stop_watcher()
    start_watcher()

IMAGE_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp",
    ".tiff", ".tif", ".ico", ".svg", ".avif", ".jfif",
}
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".wmv", ".flv", ".m4v"}
MEDIA_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS
STRIPPABLE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}

# =========================================================================
# DATABASE
# =========================================================================

_db_path = None  # set in setup_gallery_routes


def _get_db():
    """Get a thread-local-ish connection. Fine for sync route handlers."""
    global _db_path
    if _db_path is None:
        # Module identity fix: when called via _import() from studio_api.py,
        # this may be a different module instance than the one setup_gallery_routes()
        # initialized. Compute the path from __file__ so it works either way.
        _here = Path(__file__).parent
        _ext_root = _here if (_here / "frontend").is_dir() else _here.parent
        _data_dir = _ext_root / "gallery_data"
        _db_path = str(_data_dir / "gallery.db")
    conn = sqlite3.connect(_db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.create_function("natural_key", 1, _natural_sort_key)
    conn.create_function("prompt_word_match", 2, _prompt_word_match)
    return conn


def _natural_sort_key(text):
    if not text:
        return ""
    return re.sub(r'(\d+)', lambda m: m.group(1).zfill(10), text.lower())


def _prompt_word_match(text, term):
    if not text or not term:
        return False
    return term.lower() in set(text.split())


def clean_prompt_for_search(prompt):
    if not prompt:
        return ""
    cleaned = re.sub(r'[(){}\[\]:,.<>|/\\!?;"\'+*~`^=_]', ' ', prompt.lower())
    cleaned = re.sub(r'\b\d+\.?\d*\b', ' ', cleaned)
    return ' '.join(cleaned.split())


def extract_search_text(filepath):
    if not HAS_PILLOW:
        return ""
    try:
        meta = extract_metadata(filepath)
        parts = []
        for k, v in meta.items():
            if k in ("negative_prompt", "error", "raw_parameters",
                      "comfyui_prompt", "comfyui_workflow", "file_size"):
                continue
            if v is not None and str(v).strip():
                parts.append(str(v).strip())
        return clean_prompt_for_search(' '.join(parts))
    except Exception:
        return ""


def compute_phash(filepath):
    """Compute 256-bit perceptual hash. Returns hex string (~64 chars) or '' on failure."""
    if not HAS_IMAGEHASH or not HAS_PILLOW:
        return ""
    try:
        with Image.open(filepath) as im:
            im = ImageOps.exif_transpose(im)
            h = imagehash.phash(im, hash_size=16)
            return str(h)
    except Exception:
        return ""


def compute_content_hash(source):
    """SHA256 of raw RGB pixel data — format-agnostic, survives metadata strip/rename.

    Args:
        source: filepath (str/Path) or PIL Image instance.
    Returns:
        64-char hex digest, or '' on failure.
    """
    if not HAS_PILLOW:
        return ""
    try:
        if isinstance(source, (str, Path)):
            with Image.open(source) as im:
                return hashlib.sha256(im.convert("RGB").tobytes()).hexdigest()
        else:
            # PIL Image passed directly (from generation path)
            return hashlib.sha256(source.convert("RGB").tobytes()).hexdigest()
    except Exception:
        return ""


# Background hash-computation progress (shared with routes)
_hash_progress = {"active": False, "current": 0, "total": 0}


def _init_db():
    db = _get_db()
    db.executescript("""
        CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS scan_folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE,
            label TEXT
        );
        CREATE TABLE IF NOT EXISTS images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL, folder TEXT NOT NULL,
            filepath TEXT NOT NULL UNIQUE,
            width INTEGER, height INTEGER, file_date REAL,
            search_text TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS characters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE COLLATE NOCASE
        );
        CREATE TABLE IF NOT EXISTS image_characters (
            image_id INTEGER NOT NULL, character_id INTEGER NOT NULL,
            position INTEGER DEFAULT 0,
            PRIMARY KEY (image_id, character_id),
            FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
            FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS ignore_words (word TEXT PRIMARY KEY COLLATE NOCASE);
        CREATE TABLE IF NOT EXISTS trash (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            original_filepath TEXT NOT NULL,
            original_folder TEXT,
            original_filename TEXT,
            trash_path TEXT NOT NULL,
            width INTEGER, height INTEGER, file_date REAL,
            search_text TEXT DEFAULT '',
            characters_json TEXT DEFAULT '[]',
            deleted_at REAL
        );
        CREATE TABLE IF NOT EXISTS image_metadata (
            image_id INTEGER PRIMARY KEY,
            prompt TEXT,
            negative_prompt TEXT,
            seed INTEGER,
            steps INTEGER,
            cfg REAL,
            sampler TEXT,
            scheduler TEXT,
            model TEXT,
            model_hash TEXT,
            denoising REAL,
            width INTEGER,
            height INTEGER,
            clip_skip INTEGER,
            hires_upscaler TEXT,
            hires_upscale REAL,
            raw_infotext TEXT,
            created_at REAL,
            FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
        );
    """)
    # Schema migrations
    try:
        cols = [r[1] for r in db.execute("PRAGMA table_info(images)").fetchall()]
        if "thumb_hash" in cols:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS images_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    filename TEXT NOT NULL, folder TEXT NOT NULL,
                    filepath TEXT NOT NULL UNIQUE,
                    width INTEGER, height INTEGER, file_date REAL
                );
                INSERT INTO images_new (id,filename,folder,filepath,width,height)
                    SELECT id,filename,folder,filepath,width,height FROM images;
                DROP TABLE images; ALTER TABLE images_new RENAME TO images;
            """)
        elif "file_date" not in cols:
            db.execute("ALTER TABLE images ADD COLUMN file_date REAL")
        if "prompt_text" not in cols and "search_text" not in cols:
            db.execute("ALTER TABLE images ADD COLUMN search_text TEXT DEFAULT ''")
        elif "prompt_text" in cols and "search_text" not in cols:
            db.execute("ALTER TABLE images ADD COLUMN search_text TEXT DEFAULT ''")
            db.execute("UPDATE images SET search_text = prompt_text")
    except Exception:
        pass
    # Force re-index if search_text was built with older extraction
    try:
        st_ver = db.execute(
            "SELECT value FROM config WHERE key='search_text_version'"
        ).fetchone()
        if not st_ver or st_ver["value"] != "2":
            db.execute("UPDATE images SET search_text=''")
            db.execute(
                "INSERT OR REPLACE INTO config (key,value) VALUES ('search_text_version','2')"
            )
            db.commit()
    except Exception:
        pass
    # Add phash column for duplicate detection + media_type column
    try:
        cols2 = [r[1] for r in db.execute("PRAGMA table_info(images)").fetchall()]
        if "phash" not in cols2:
            db.execute("ALTER TABLE images ADD COLUMN phash TEXT DEFAULT ''")
        if "media_type" not in cols2:
            db.execute("ALTER TABLE images ADD COLUMN media_type TEXT DEFAULT 'image'")
        db.commit()
    except Exception:
        pass
    # Clear any old 64-bit hashes from prior experiments — we use 256-bit (hash_size=16).
    # Real hashes are 64 hex chars; anything shorter is stale.
    try:
        ph_ver = db.execute("SELECT value FROM config WHERE key='phash_version'").fetchone()
        if not ph_ver or ph_ver["value"] != "3":
            db.execute("UPDATE images SET phash='' WHERE length(phash) > 0 AND length(phash) < 60")
            db.execute(
                "INSERT OR REPLACE INTO config (key,value) VALUES ('phash_version','3')"
            )
            db.commit()
    except Exception:
        pass
    # Backfill media_type for existing rows (based on extension)
    try:
        needs_mt = db.execute(
            "SELECT id, filepath FROM images WHERE media_type IS NULL OR media_type=''"
        ).fetchall()
        if needs_mt:
            for r in needs_mt:
                ext = Path(r["filepath"]).suffix.lower()
                if ext in VIDEO_EXTENSIONS:
                    mt = "video"
                elif ext == ".gif":
                    mt = "gif"
                else:
                    mt = "image"
                db.execute("UPDATE images SET media_type=? WHERE id=?", (mt, r["id"]))
            db.commit()
    except Exception:
        pass
    # Migrate old single root_path to scan_folders
    try:
        row = db.execute("SELECT value FROM config WHERE key='root_path'").fetchone()
        if row and row["value"]:
            existing = db.execute(
                "SELECT id FROM scan_folders WHERE path=?", (row["value"],)
            ).fetchone()
            if not existing:
                db.execute(
                    "INSERT OR IGNORE INTO scan_folders (path, label) VALUES (?, ?)",
                    (row["value"], Path(row["value"]).name),
                )
            db.execute("DELETE FROM config WHERE key='root_path'")
    except Exception:
        pass
    # ── Content hash: pixel-identity key for durable metadata linking ────
    # content_hash on images = SHA256 of decoded RGB pixels. Survives rename,
    # metadata strip, format conversion. Also enables exact duplicate detection.
    try:
        cols_ch = [r[1] for r in db.execute("PRAGMA table_info(images)").fetchall()]
        if "content_hash" not in cols_ch:
            db.execute("ALTER TABLE images ADD COLUMN content_hash TEXT DEFAULT ''")
            db.commit()
    except Exception:
        pass
    # Migrate image_metadata to content_hash-keyed schema.
    # Old: image_id INTEGER PRIMARY KEY (requires Gallery scan before save → race condition).
    # New: content_hash as unique key, image_id nullable (generation saves immediately by hash,
    #       Gallery scan links image_id later).
    try:
        meta_cols = [r[1] for r in db.execute("PRAGMA table_info(image_metadata)").fetchall()]
        if "content_hash" not in meta_cols:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS image_metadata_v2 (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    content_hash TEXT NOT NULL DEFAULT '',
                    image_id INTEGER,
                    prompt TEXT, negative_prompt TEXT, seed INTEGER, steps INTEGER,
                    cfg REAL, sampler TEXT, scheduler TEXT, model TEXT, model_hash TEXT,
                    denoising REAL, width INTEGER, height INTEGER, clip_skip INTEGER,
                    hires_upscaler TEXT, hires_upscale REAL, raw_infotext TEXT, created_at REAL
                );
                INSERT OR IGNORE INTO image_metadata_v2
                    (image_id, prompt, negative_prompt, seed, steps, cfg,
                     sampler, scheduler, model, model_hash, denoising,
                     width, height, clip_skip, hires_upscaler, hires_upscale,
                     raw_infotext, created_at)
                    SELECT image_id, prompt, negative_prompt, seed, steps, cfg,
                           sampler, scheduler, model, model_hash, denoising,
                           width, height, clip_skip, hires_upscaler, hires_upscale,
                           raw_infotext, created_at
                    FROM image_metadata;
                DROP TABLE IF EXISTS image_metadata;
                ALTER TABLE image_metadata_v2 RENAME TO image_metadata;
                CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_hash
                    ON image_metadata(content_hash) WHERE content_hash != '';
                CREATE INDEX IF NOT EXISTS idx_meta_imgid
                    ON image_metadata(image_id) WHERE image_id IS NOT NULL;
            """)
            db.commit()
    except Exception:
        pass
    db.commit()
    db.close()


# =========================================================================
# FILENAME PARSER
# =========================================================================

def is_numeric_or_code(s):
    if re.fullmatch(r'\d+', s):
        return True
    if re.fullmatch(r'[0-9a-fA-F]{8,}', s):
        return True
    return False


def get_ignore_words(db):
    try:
        return {r["word"].lower() for r in db.execute("SELECT word FROM ignore_words").fetchall()}
    except Exception:
        return set()


def parse_characters_from_filename(filename, ignore_words=None):
    if ignore_words is None:
        ignore_words = set()
    stem = Path(filename).stem
    stem = re.sub(r'\s*\d+\s*$', '', stem).strip()
    stem = re.sub(r'\s*\([^)]*\)\s*', ' ', stem).strip()
    stem = re.sub(r'\s*\[[^\]]*\]\s*', ' ', stem).strip()
    stem = re.sub(r"['\u2019]s\b", '', stem)
    stem = re.sub(r"['\u2019'`]", ' ', stem)
    if not stem.strip():
        return ["Unknown"]
    stem = stem.strip()
    # Split on + and , as character separators (e.g. "Oliver+Luca" or "Oliver, Luca")
    # Underscores, dashes, and spaces connect parts of a single name (e.g. "Shoyo_Hinata")
    char_parts = re.split(r'[,\+]+', stem)
    characters = []
    for char_part in char_parts:
        # Split internal separators (space, underscore, dash) into name words, then rejoin
        words = re.split(r'[\s_\-]+', char_part.strip())
        # Filter out numeric/code words and short words, keep valid name parts
        valid_words = []
        for w in words:
            w = w.strip()
            if not w:
                continue
            if is_numeric_or_code(w):
                continue
            if not re.search(r'[a-zA-Z]', w):
                continue
            valid_words.append(w.title())
        name = " ".join(valid_words)
        if not name or len(name) < 2:
            continue
        if name.lower() in ignore_words:
            continue
        if name and name not in characters:
            characters.append(name)
    characters.sort(key=lambda x: x.lower())
    return characters if characters else ["Unknown"]


def get_file_date(filepath):
    try:
        stat = os.stat(filepath)
        dates = []
        if stat.st_mtime:
            dates.append(stat.st_mtime)
        birth = getattr(stat, 'st_birthtime', None)
        if birth:
            dates.append(birth)
        if platform.system() == "Windows" and stat.st_ctime:
            dates.append(stat.st_ctime)
        return min(dates) if dates else 0.0
    except Exception:
        return 0.0


def get_filepath_hash(filepath):
    return hashlib.md5(f"{VERSION}:{filepath}".encode()).hexdigest()[:8]


def find_available_filename(directory, desired_name):
    fp = os.path.join(directory, desired_name)
    if not os.path.exists(fp):
        return desired_name
    stem = Path(desired_name).stem
    ext = Path(desired_name).suffix
    m = re.match(r'^(.*?)\s*\((\d+)\)$', stem)
    base = m.group(1) if m else stem
    n = 2
    while True:
        candidate = f"{base} ({n}){ext}"
        if not os.path.exists(os.path.join(directory, candidate)):
            return candidate
        n += 1
        if n > 9999:
            break
    return desired_name


def normalize_char_key(base_name):
    parts = re.split(r'[+]', base_name.strip())
    if len(parts) <= 1:
        return base_name.strip()
    return '+'.join(sorted([p.strip() for p in parts], key=lambda x: x.lower()))


def find_next_global_number(db, base_name, exclude_ids=None):
    if exclude_ids is None:
        exclude_ids = []
    parts = re.split(r'[+]', base_name.strip())
    patterns = set()
    if len(parts) > 1:
        from itertools import permutations
        for perm in permutations([p.strip() for p in parts]):
            patterns.add('+'.join(perm))
    else:
        patterns.add(base_name.strip())

    max_n = 0
    ex_set = set(exclude_ids)
    for pattern in patterns:
        rows = db.execute(
            "SELECT id, filename FROM images WHERE filename LIKE ? OR filename LIKE ?",
            (pattern + ".%", pattern + " (%).%"),
        ).fetchall()
        for row in rows:
            if row["id"] in ex_set:
                continue
            fn = row["filename"]
            stem = Path(fn).stem
            if stem.lower() == pattern.lower():
                max_n = max(max_n, 1)
            else:
                m = re.match(
                    r'^' + re.escape(pattern) + r'\s*\((\d+)\)$', stem, re.IGNORECASE
                )
                if m:
                    max_n = max(max_n, int(m.group(1)))
    return max_n + 1


# =========================================================================
# METADATA STRIPPING
# =========================================================================


def strip_metadata_from_file(filepath):
    """Remove EXIF / PNG text / XMP metadata from an image in-place.

    Atomic tmp-replace. Bakes EXIF orientation before dropping tags (so the
    pixels stay right-side-up). Preserves the original mtime. Rejects
    animated images (stripping would flatten them).

    Returns (ok: bool, message: str).
    """
    if not HAS_PILLOW:
        return False, "Pillow not installed"
    if not os.path.isfile(filepath):
        return False, "File not found"
    ext = Path(filepath).suffix.lower()
    if ext not in STRIPPABLE_EXTS:
        return False, f"Unsupported file type ({ext or 'no extension'})"

    # Capture original mtime BEFORE we touch it — restore after atomic replace
    try:
        _stat = os.stat(filepath)
        orig_atime = _stat.st_atime
        orig_mtime = _stat.st_mtime
    except Exception:
        orig_atime = None
        orig_mtime = None

    # Reject animated images — stripping would flatten them
    try:
        with Image.open(filepath) as probe:
            if getattr(probe, "n_frames", 1) > 1:
                return False, "Animated images are not supported"
            fmt = probe.format
    except Exception as e:
        return False, f"Cannot read image: {e}"

    # Read pixels into memory, bake orientation, close handle
    try:
        with Image.open(filepath) as src:
            src = ImageOps.exif_transpose(src)
            pixels = src.copy()
    except Exception as e:
        return False, f"Cannot decode image: {e}"

    # Build a clean image with no info dict
    clean = Image.frombytes(pixels.mode, pixels.size, pixels.tobytes())

    tmp_path = filepath + ".tistrip.tmp"
    save_kwargs = {}
    out_format = fmt
    try:
        if ext in (".jpg", ".jpeg"):
            if clean.mode not in ("RGB", "L"):
                clean = clean.convert("RGB")
            save_kwargs = {"quality": 100, "subsampling": 0, "optimize": True}
            out_format = "JPEG"
        elif ext == ".png":
            save_kwargs = {"pnginfo": PngInfo(), "optimize": True}
            out_format = "PNG"
        elif ext == ".webp":
            save_kwargs = {"quality": 100, "method": 6}
            out_format = "WEBP"
        elif ext == ".bmp":
            out_format = "BMP"
        elif ext in (".tif", ".tiff"):
            out_format = "TIFF"
        clean.save(tmp_path, format=out_format, **save_kwargs)
    except Exception as e:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass
        return False, f"Save failed: {e}"

    # Atomic replace
    try:
        os.replace(tmp_path, filepath)
    except Exception as e:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass
        return False, f"Replace failed: {e}"

    # Restore original mtime so the file keeps its real creation date
    if orig_mtime is not None:
        try:
            os.utime(filepath, (orig_atime, orig_mtime))
        except Exception:
            pass

    return True, "OK"


# =========================================================================
# FORMAT CONVERSION
# =========================================================================

CONVERTIBLE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
TARGET_FORMATS = {
    "png":  {"ext": ".png",  "pil_format": "PNG"},
    "jpeg": {"ext": ".jpg",  "pil_format": "JPEG"},
    "webp": {"ext": ".webp", "pil_format": "WEBP"},
}


def convert_image_file(
    src_path,
    dst_path,
    target_format,        # "png" | "jpeg" | "webp"
    quality=90,           # 50–100, ignored for PNG
    lossless=False,       # only meaningful for WebP
    alpha_handling="skip",  # "skip" | "white" | "black"
    strip_metadata=False, # drop EXIF/text/XMP in the output
):
    """Convert a single image file to a new format.

    Writes to `dst_path` (which may equal `src_path + new_ext`). Uses atomic
    tmp-replace so an interrupted write never leaves a half-file in place.

    For "skip" alpha handling on a JPEG target with a source that has alpha,
    returns (False, "has alpha — skipped") WITHOUT touching the src file and
    WITHOUT writing anything to dst.

    Returns (ok: bool, message: str).
    """
    if not HAS_PILLOW:
        return False, "Pillow not installed"
    if not os.path.isfile(src_path):
        return False, "Source not found"
    src_ext = Path(src_path).suffix.lower()
    if src_ext not in CONVERTIBLE_EXTS:
        return False, f"Unsupported source type ({src_ext or 'no extension'})"
    tf = TARGET_FORMATS.get(target_format)
    if not tf:
        return False, f"Unknown target format: {target_format}"

    # Reject animated source files — flattening would lose frames
    try:
        with Image.open(src_path) as probe:
            if getattr(probe, "n_frames", 1) > 1:
                return False, "Animated images are not supported"
    except Exception as e:
        return False, f"Cannot read source: {e}"

    # Read pixels, bake EXIF orientation
    try:
        with Image.open(src_path) as srcim:
            srcim = ImageOps.exif_transpose(srcim)
            pixels = srcim.copy()
    except Exception as e:
        return False, f"Cannot decode source: {e}"

    has_alpha = pixels.mode in ("RGBA", "LA") or (
        pixels.mode == "P" and "transparency" in pixels.info
    )

    # Alpha handling for JPEG target (JPEG has no alpha channel)
    if target_format == "jpeg" and has_alpha:
        if alpha_handling == "skip":
            return False, "Has transparency — skipped"
        bg_color = (255, 255, 255) if alpha_handling == "white" else (0, 0, 0)
        # Flatten onto solid bg
        if pixels.mode == "P":
            pixels = pixels.convert("RGBA")
        bg = Image.new("RGB", pixels.size, bg_color)
        if pixels.mode == "RGBA":
            bg.paste(pixels, mask=pixels.split()[3])
        elif pixels.mode == "LA":
            bg.paste(pixels.convert("RGBA"), mask=pixels.convert("RGBA").split()[3])
        else:
            bg.paste(pixels)
        pixels = bg

    # Mode conversion for lossless WebP with palette images
    if target_format == "webp" and pixels.mode == "P":
        pixels = pixels.convert("RGBA" if has_alpha else "RGB")

    # JPEG needs RGB or L
    if target_format == "jpeg" and pixels.mode not in ("RGB", "L"):
        pixels = pixels.convert("RGB")

    # Build clean pixels (no info dict) if strip_metadata requested
    if strip_metadata:
        pixels = Image.frombytes(pixels.mode, pixels.size, pixels.tobytes())

    # Build save kwargs per format
    save_kwargs = {}
    q = max(50, min(100, int(quality)))
    if target_format == "jpeg":
        save_kwargs = {"quality": q, "subsampling": 0 if q >= 95 else 2, "optimize": True}
    elif target_format == "png":
        save_kwargs = {"optimize": True}
        if strip_metadata:
            save_kwargs["pnginfo"] = PngInfo()
    elif target_format == "webp":
        if lossless:
            save_kwargs = {"lossless": True, "quality": 100, "method": 6}
        else:
            save_kwargs = {"quality": q, "method": 6}

    # Atomic write to tmp then replace
    tmp_path = dst_path + ".ticonv.tmp"
    try:
        pixels.save(tmp_path, format=tf["pil_format"], **save_kwargs)
    except Exception as e:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass
        return False, f"Save failed: {e}"

    try:
        os.replace(tmp_path, dst_path)
    except Exception as e:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass
        return False, f"Replace failed: {e}"

    return True, "OK"


# =========================================================================
# METADATA EXTRACTION
# =========================================================================

def extract_metadata(filepath):
    metadata = {}
    if not HAS_PILLOW:
        return metadata
    try:
        ext = Path(filepath).suffix.lower()
        with Image.open(filepath) as img:
            if ext == ".png" and hasattr(img, 'text'):
                pt = img.text or {}
                if "parameters" in pt:
                    metadata["raw_parameters"] = pt["parameters"]
                    metadata.update(parse_sd_parameters(pt["parameters"]))
                if "prompt" in pt:
                    try:
                        json.loads(pt["prompt"])
                        metadata["comfyui_prompt"] = True
                        metadata["raw_parameters"] = pt["prompt"][:2000]
                    except Exception:
                        metadata.setdefault("prompt", pt["prompt"][:2000])
                if "workflow" in pt:
                    metadata["comfyui_workflow"] = True
                if "Description" in pt:
                    metadata.setdefault("prompt", pt["Description"][:2000])
                if "Comment" in pt:
                    try:
                        c = json.loads(pt["Comment"])
                        if isinstance(c, dict):
                            if "uc" in c:
                                metadata["negative_prompt"] = c["uc"][:1000]
                            for k in ("steps", "sampler", "seed"):
                                if k in c:
                                    metadata[k] = c[k]
                            if "strength" in c:
                                metadata["cfg_scale"] = c["strength"]
                    except Exception:
                        pass
                for key in pt:
                    kl = key.lower()
                    if kl not in metadata and kl not in (
                        "parameters", "prompt", "workflow", "comment", "description"
                    ):
                        if isinstance(pt[key], str) and len(pt[key]) < 2000:
                            metadata[key] = pt[key]

            # Full EXIF extraction
            from PIL.ExifTags import TAGS, IFD
            exif = img.getexif() if hasattr(img, 'getexif') else None
            if exif:
                EXIF_NAMES = {
                    0x010F: "camera_make", 0x0110: "camera_model", 0x0131: "software",
                    0x0132: "date_time", 0x9003: "date_original", 0x9004: "date_digitized",
                    0x829A: "exposure_time", 0x829D: "f_number", 0x8827: "iso",
                    0x9207: "metering_mode", 0x9209: "flash", 0x920A: "focal_length",
                    0xA405: "focal_length_35mm", 0xA001: "color_space",
                    0x8822: "exposure_program", 0x9201: "shutter_speed",
                    0x9202: "aperture", 0x9204: "exposure_bias",
                    0x9206: "subject_distance", 0xA002: "pixel_x", 0xA003: "pixel_y",
                    0xA217: "sensing_method", 0xA403: "white_balance",
                    0xA406: "scene_type", 0xA431: "serial_number",
                    0xA432: "lens_info", 0xA433: "lens_make", 0xA434: "lens_model",
                    0xA300: "file_source", 0x9286: "user_comment",
                    0x0112: "orientation", 0x011A: "x_resolution", 0x011B: "y_resolution",
                    0x0128: "resolution_unit", 0xA404: "digital_zoom",
                    0x9205: "max_aperture", 0xA402: "exposure_mode",
                    0x8824: "spectral_sensitivity", 0xA407: "gain_control",
                    0xA408: "contrast", 0xA409: "saturation", 0xA40A: "sharpness",
                }
                SKIP_TAGS = {0x8769, 0x8825, 0xA005}
                for tag_id, val in exif.items():
                    if tag_id in SKIP_TAGS:
                        continue
                    if tag_id in EXIF_NAMES:
                        key = EXIF_NAMES[tag_id]
                    else:
                        key = TAGS.get(tag_id, f"tag_{tag_id}")
                    if key == "user_comment":
                        if isinstance(val, (str, bytes)):
                            if isinstance(val, bytes):
                                try:
                                    val = val.decode('utf-8', errors='ignore')
                                except Exception:
                                    val = str(val)
                            for pfx in ["ASCII\x00\x00\x00", "UNICODE\x00", 'charset="Ascii" ']:
                                if val.startswith(pfx):
                                    val = val[len(pfx):]
                            val = val.strip('\x00').strip()
                            if val and "raw_parameters" not in metadata:
                                metadata["raw_parameters"] = val[:3000]
                                metadata.update(parse_sd_parameters(val))
                        continue
                    if isinstance(val, bytes):
                        continue
                    if isinstance(val, tuple) and len(val) == 2 and all(
                        isinstance(x, (int, float)) for x in val
                    ):
                        val = f"{val[0]}/{val[1]}" if val[1] else str(val[0])
                    sval = str(val).strip()
                    if sval and len(sval) < 500 and key not in metadata:
                        metadata[key] = sval

                try:
                    exif_ifd = exif.get_ifd(IFD.Exif)
                    if exif_ifd:
                        for tag_id, val in exif_ifd.items():
                            if tag_id in EXIF_NAMES:
                                key = EXIF_NAMES[tag_id]
                            else:
                                key = TAGS.get(tag_id, f"exif_{tag_id}")
                            if key == "user_comment":
                                # UserComment in Exif sub-IFD is where Forge writes
                                # SD parameters for JPEG/WebP files
                                if isinstance(val, (str, bytes)):
                                    if isinstance(val, bytes):
                                        try:
                                            val = val.decode('utf-8', errors='ignore')
                                        except Exception:
                                            val = str(val)
                                    for pfx in ["ASCII\x00\x00\x00", "UNICODE\x00", 'charset="Ascii" ']:
                                        if val.startswith(pfx):
                                            val = val[len(pfx):]
                                    val = val.strip('\x00').strip()
                                    if val and "raw_parameters" not in metadata:
                                        metadata["raw_parameters"] = val[:3000]
                                        metadata.update(parse_sd_parameters(val))
                                continue
                            if isinstance(val, bytes):
                                continue
                            if isinstance(val, tuple) and len(val) == 2 and all(
                                isinstance(x, (int, float)) for x in val
                            ):
                                val = f"{val[0]}/{val[1]}" if val[1] else str(val[0])
                            sval = str(val).strip()
                            if sval and len(sval) < 500 and key not in metadata:
                                metadata[key] = sval
                except Exception:
                    pass

        try:
            metadata["file_size"] = os.path.getsize(filepath)
        except Exception:
            pass
    except Exception as e:
        metadata["error"] = str(e)
    try:
        metadata.setdefault("file_size", os.path.getsize(filepath))
    except Exception:
        pass
    return metadata


def parse_sd_parameters(text):
    result = {}
    if not text:
        return result
    lines = text.strip().split('\n')
    prompt_lines, negative_lines, settings_line = [], [], ""
    in_negative = False
    for line in lines:
        if line.startswith("Negative prompt:"):
            in_negative = True
            negative_lines.append(line[len("Negative prompt:"):].strip())
        elif re.match(r'^(Steps|Sampler|CFG scale|Seed|Size|Model|Model hash|Clip skip)', line):
            settings_line = line
            in_negative = False
        elif in_negative:
            negative_lines.append(line)
        else:
            m = re.search(r'(Steps:\s*\d+.*)', line)
            if m:
                settings_line = m.group(1)
                pre = line[:m.start()].strip()
                if pre:
                    (negative_lines if in_negative else prompt_lines).append(pre)
            else:
                prompt_lines.append(line)
    if prompt_lines:
        result["prompt"] = '\n'.join(prompt_lines).strip()[:2000]
    if negative_lines:
        result["negative_prompt"] = '\n'.join(negative_lines).strip()[:1000]
    if settings_line:
        for key, pat in {
            "steps": r'Steps:\s*(\d+)',
            "sampler": r'Sampler:\s*([^,]+)',
            "cfg_scale": r'CFG scale:\s*([0-9.]+)',
            "seed": r'Seed:\s*(\d+)',
            "size": r'Size:\s*(\d+x\d+)',
            "model": r'Model:\s*([^,]+)',
            "model_hash": r'Model hash:\s*([^,]+)',
            "clip_skip": r'Clip skip:\s*(\d+)',
            "denoising": r'Denoising strength:\s*([0-9.]+)',
            "hires_upscaler": r'Hires upscaler:\s*([^,]+)',
            "hires_steps": r'Hires steps:\s*(\d+)',
            "hires_upscale": r'Hires upscale:\s*([0-9.]+)',
        }.items():
            m = re.search(pat, settings_line)
            if m:
                result[key] = m.group(1).strip()
    return result


# =========================================================================
# THUMBNAILS
# =========================================================================

def generate_thumbnail_bytes(filepath, max_size=320):
    if not HAS_PILLOW:
        return None
    try:
        with Image.open(filepath) as img:
            img = ImageOps.exif_transpose(img)
            img.thumbnail((max_size, max_size), Image.LANCZOS)
            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")
            buf = BytesIO()
            img.save(buf, "WEBP", quality=75)
            buf.seek(0)
            return buf.getvalue()
    except Exception:
        return None


VIDEO_THUMB_SVG = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><rect width="200" height="200" fill="#16161c"/><polygon points="80,60 80,140 140,100" fill="#d4a017" opacity="0.7"/><rect x="40" y="155" width="120" height="20" rx="4" fill="#2a2a35"/><text x="100" y="169" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#8888a0">VIDEO</text></svg>'


def generate_video_thumbnail(filepath, max_size=320):
    for seek in ["0.5", "0", None]:
        try:
            cmd = [FFMPEG_BIN]
            if seek is not None:
                cmd += ["-ss", seek]
            cmd += [
                "-i", filepath,
                "-frames:v", "1",
                "-vf", f"scale={max_size}:{max_size}:force_original_aspect_ratio=decrease",
                "-f", "image2", "-c:v", "mjpeg", "-q:v", "5", "-y", "pipe:1",
            ]
            result = subprocess.run(cmd, capture_output=True, timeout=15)
            if result.returncode == 0 and len(result.stdout) > 100:
                return result.stdout
        except Exception:
            pass
    return None


# =========================================================================
# SCANNER
# =========================================================================

scan_progress = {"active": False, "folders": []}


def _resolve_display_folder(db, display_folder):
    folders = db.execute("SELECT path FROM scan_folders").fetchall()
    for sf in folders:
        root = sf["path"]
        root_name = Path(root).name
        if display_folder == root_name:
            return root
        prefix = root_name + os.sep
        if display_folder.startswith(prefix):
            rel = display_folder[len(prefix):]
            return os.path.join(root, rel)
    return None


def scan_all_folders():
    global scan_progress
    db = _get_db()
    folders = db.execute("SELECT id, path, label FROM scan_folders").fetchall()
    if not folders:
        db.close()
        return {"error": "No folders configured"}

    scan_progress = {"active": True, "folders": []}

    folder_counts = {}
    for sf in folders:
        root = Path(sf["path"])
        if not root.exists():
            continue
        cnt = 0
        for dirpath, dirnames, filenames in os.walk(root):
            cnt += sum(1 for fn in filenames if Path(fn).suffix.lower() in MEDIA_EXTENSIONS)
        folder_counts[sf["path"]] = cnt

    total_new, total_removed = 0, 0
    ignore_words = get_ignore_words(db)
    existing = set(
        r["filepath"] for r in db.execute("SELECT filepath FROM images").fetchall()
    )
    all_found = set()

    for fi, sf in enumerate(folders):
        root = Path(sf["path"])
        if not root.exists() or not root.is_dir():
            continue
        fname = root.name
        ftotal = folder_counts.get(sf["path"], 0)
        fprog = {"name": fname, "current": 0, "total": ftotal, "phase": "Scanning"}
        scan_progress["folders"].append(fprog)
        processed = 0

        for dirpath, dirnames, filenames in os.walk(root):
            dirnames.sort()
            rel_folder = os.path.relpath(dirpath, root)
            if rel_folder == ".":
                rel_folder = "(Root)"
            display_folder = (
                f"{root.name}\\{rel_folder}" if rel_folder != "(Root)" else root.name
            )

            for filename in sorted(filenames):
                ext = Path(filename).suffix.lower()
                if ext not in MEDIA_EXTENSIONS:
                    continue
                filepath = os.path.join(dirpath, filename)
                all_found.add(filepath)
                processed += 1
                fprog["current"] = processed
                if filepath in existing:
                    continue

                characters = parse_characters_from_filename(filename, ignore_words)
                file_date = get_file_date(filepath)
                w, h = 0, 0
                search = ""
                ch = ""
                is_video = ext in VIDEO_EXTENSIONS
                if is_video:
                    media_type = "video"
                elif ext == ".gif":
                    media_type = "gif"
                else:
                    media_type = "image"
                if HAS_PILLOW and not is_video:
                    try:
                        with Image.open(filepath) as im:
                            w, h = im.size
                    except Exception:
                        pass
                    search = extract_search_text(filepath)
                    ch = compute_content_hash(filepath)

                cur = db.execute(
                    "INSERT OR IGNORE INTO images "
                    "(filename,folder,filepath,width,height,file_date,search_text,media_type,content_hash) "
                    "VALUES (?,?,?,?,?,?,?,?,?)",
                    (filename, display_folder, filepath, w, h, file_date, search, media_type, ch),
                )
                iid = cur.lastrowid
                if iid == 0:
                    continue
                total_new += 1

                # Link orphan metadata — generation may have saved metadata by hash
                # before Gallery scanned this file. Update the image_id link.
                if ch:
                    db.execute(
                        "UPDATE image_metadata SET image_id=? WHERE content_hash=? AND image_id IS NULL",
                        (iid, ch),
                    )

                for pos, cn in enumerate(characters):
                    db.execute("INSERT OR IGNORE INTO characters (name) VALUES (?)", (cn,))
                    cr = db.execute(
                        "SELECT id FROM characters WHERE name=? COLLATE NOCASE", (cn,)
                    ).fetchone()
                    if cr:
                        db.execute(
                            "INSERT OR IGNORE INTO image_characters "
                            "(image_id,character_id,position) VALUES (?,?,?)",
                            (iid, cr["id"], pos),
                        )
        fprog["phase"] = "Done"

    # Backfill metadata — only for newly added images missing search_text
    # (Images already get search_text at insert time; this catches edge cases
    # like interrupted scans. Uses ' ' sentinel for "attempted, nothing found"
    # so we never re-attempt images that genuinely have no metadata.)
    if HAS_PILLOW and total_new > 0:
        backfill = db.execute(
            "SELECT id,filepath FROM images WHERE "
            "search_text = '' "
            "AND filepath NOT LIKE '%.mp4' AND filepath NOT LIKE '%.webm' "
            "AND filepath NOT LIKE '%.mov' AND filepath NOT LIKE '%.avi' "
            "AND filepath NOT LIKE '%.mkv'"
        ).fetchall()
        if backfill:
            bprog = {"name": "metadata", "current": 0, "total": len(backfill), "phase": "Indexing"}
            scan_progress["folders"].append(bprog)
            for i, r in enumerate(backfill):
                bprog["current"] = i + 1
                try:
                    st = extract_search_text(r["filepath"])
                    # Mark as attempted even if empty — sentinel ' ' prevents re-processing
                    db.execute(
                        "UPDATE images SET search_text=? WHERE id=?",
                        (st if st else " ", r["id"]),
                    )
                except Exception:
                    db.execute("UPDATE images SET search_text=' ' WHERE id=?", (r["id"],))
            bprog["phase"] = "Done"

    # Backfill content_hash for existing images that don't have one yet
    if HAS_PILLOW:
        ch_backfill = db.execute(
            "SELECT id,filepath FROM images WHERE "
            "(content_hash IS NULL OR content_hash = '') "
            "AND filepath NOT LIKE '%.mp4' AND filepath NOT LIKE '%.webm' "
            "AND filepath NOT LIKE '%.mov' AND filepath NOT LIKE '%.avi' "
            "AND filepath NOT LIKE '%.mkv'"
        ).fetchall()
        if ch_backfill:
            chprog = {"name": "content_hash", "current": 0, "total": len(ch_backfill), "phase": "Hashing"}
            scan_progress["folders"].append(chprog)
            for i, r in enumerate(ch_backfill):
                chprog["current"] = i + 1
                try:
                    ch = compute_content_hash(r["filepath"])
                    if ch:
                        db.execute(
                            "UPDATE images SET content_hash=? WHERE id=?",
                            (ch, r["id"]),
                        )
                        # Link orphan metadata saved before this image was scanned
                        db.execute(
                            "UPDATE image_metadata SET image_id=? "
                            "WHERE content_hash=? AND image_id IS NULL",
                            (r["id"], ch),
                        )
                except Exception:
                    pass
            chprog["phase"] = "Done"

    # Update missing file dates
    for r in db.execute(
        "SELECT id,filepath FROM images WHERE file_date IS NULL OR file_date=0"
    ).fetchall():
        fd = get_file_date(r["filepath"])
        if fd:
            db.execute("UPDATE images SET file_date=? WHERE id=?", (fd, r["id"]))

    removed = existing - all_found
    for fp in removed:
        db.execute("DELETE FROM images WHERE filepath=?", (fp,))
    db.execute(
        "DELETE FROM characters WHERE id NOT IN "
        "(SELECT DISTINCT character_id FROM image_characters)"
    )
    db.commit()
    db.close()
    scan_progress = {"active": False, "folders": []}
    return {"new": total_new, "removed": len(removed), "total": len(all_found)}


# =========================================================================
# METADATA STORAGE (callable from studio_api.py)
# =========================================================================

def _parse_meta_fields(infotext, settings=None):
    """Parse infotext + settings into a flat metadata dict."""
    meta = {}
    if settings and isinstance(settings, dict):
        meta = dict(settings)
    if infotext:
        parsed = parse_sd_parameters(infotext)
        for k, v in parsed.items():
            if k not in meta or meta[k] is None:
                meta[k] = v
        meta["raw_infotext"] = infotext
    return meta


def _meta_row_values(meta, content_hash="", image_id=None):
    """Build the VALUES tuple for image_metadata INSERT."""
    return (
        content_hash,
        image_id,
        meta.get("prompt"),
        meta.get("negative_prompt") or meta.get("Negative prompt"),
        meta.get("seed") or meta.get("Seed"),
        meta.get("steps") or meta.get("Steps"),
        meta.get("cfg") or meta.get("cfg_scale") or meta.get("CFG scale"),
        meta.get("sampler") or meta.get("sampler_name") or meta.get("Sampler"),
        meta.get("scheduler") or meta.get("Schedule type"),
        meta.get("model") or meta.get("sd_model") or meta.get("Model"),
        meta.get("model_hash") or meta.get("Model hash"),
        meta.get("denoising") or meta.get("Denoising strength"),
        meta.get("width") or (meta.get("Size", "").split("x")[0] if "x" in str(meta.get("Size", "")) else meta.get("width")),
        meta.get("height") or (meta.get("Size", "").split("x")[1] if "x" in str(meta.get("Size", "")) else meta.get("height")),
        meta.get("clip_skip") or meta.get("Clip skip"),
        meta.get("hires_upscaler") or meta.get("Hires upscaler"),
        meta.get("hires_upscale") or meta.get("Hires upscale"),
        meta.get("raw_infotext"),
        time.time(),
    )


_META_INSERT_SQL = """
    INSERT OR REPLACE INTO image_metadata (
        content_hash, image_id,
        prompt, negative_prompt, seed, steps, cfg,
        sampler, scheduler, model, model_hash, denoising,
        width, height, clip_skip, hires_upscaler, hires_upscale,
        raw_infotext, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""


def save_metadata_by_hash(content_hash, infotext, settings=None):
    """Save generation metadata keyed by content hash.

    Called from studio_api.py immediately after saving an image to disk.
    No Gallery scan required — metadata is stored by pixel-identity hash
    and linked to the Gallery image row when the scan eventually runs.

    Args:
        content_hash: SHA256 hex of decoded RGB pixel data
        infotext: A1111-format parameters string
        settings: Optional dict with structured generation params
    """
    if not content_hash:
        return
    try:
        db = _get_db()
    except Exception:
        return
    try:
        meta = _parse_meta_fields(infotext, settings)
        # Check if image already exists in Gallery (auto-sync may have caught it)
        img_row = db.execute(
            "SELECT id FROM images WHERE content_hash=?", (content_hash,)
        ).fetchone()
        image_id = img_row["id"] if img_row else None
        db.execute(_META_INSERT_SQL, _meta_row_values(meta, content_hash, image_id))
        db.commit()
    except Exception as e:
        print(f"[Gallery] Metadata save error (hash {content_hash[:12]}): {e}")
    finally:
        try:
            db.close()
        except Exception:
            pass


def save_metadata_for_image(filepath, infotext, settings=None):
    """Legacy wrapper — computes content hash from file, then saves by hash.

    Kept for backward compatibility. New code should use save_metadata_by_hash().
    """
    ch = compute_content_hash(filepath)
    if ch:
        save_metadata_by_hash(ch, infotext, settings)
    else:
        # Fallback: try old filepath-based approach (should rarely hit)
        try:
            db = _get_db()
        except Exception:
            return
        try:
            norm = os.path.normpath(filepath)
            row = db.execute("SELECT id FROM images WHERE filepath=?", (norm,)).fetchone()
            if not row:
                row = db.execute("SELECT id FROM images WHERE filepath=?", (filepath,)).fetchone()
            if not row:
                return
            meta = _parse_meta_fields(infotext, settings)
            db.execute(_META_INSERT_SQL, _meta_row_values(meta, "", row["id"]))
            db.commit()
        except Exception as e:
            print(f"[Gallery] Metadata save error for {filepath}: {e}")
        finally:
            try:
                db.close()
            except Exception:
                pass


# =========================================================================
# ROUTE SETUP
# =========================================================================

def setup_gallery_routes(app: FastAPI):
    """Register Gallery API routes on the Forge FastAPI app."""
    global _db_path

    # Determine extension root and data directory
    _here = Path(__file__).parent
    _ext_root = _here if (_here / "frontend").is_dir() else _here.parent
    _data_dir = _ext_root / "gallery_data"
    _data_dir.mkdir(exist_ok=True)
    _trash_dir = _data_dir / ".trash"
    _trash_dir.mkdir(exist_ok=True)

    _db_path = str(_data_dir / "gallery.db")
    _init_db()

    print(f"{TAG} Gallery database: {_db_path}")

    # Check ffmpeg
    try:
        subprocess.run([FFMPEG_BIN, "-version"], capture_output=True, timeout=5)
        print(f"{TAG} ffmpeg found — video thumbnails enabled")
    except Exception:
        print(f"{TAG} ffmpeg not found — video thumbnails will use placeholder")

    # ==================================================================
    # SSE + WATCHER STATUS
    # ==================================================================

    @app.get("/studio/gallery/events")
    async def gallery_events():
        """SSE endpoint — streams live change events to the frontend."""
        q = Queue(maxsize=50)
        with _sse_lock:
            _sse_clients.append(q)
        status = {"active": _watcher_running and _watcher_observer is not None}
        q.put(f"event: watcher_status\ndata: {json.dumps(status)}\n\n")

        async def stream():
            loop = asyncio.get_event_loop()
            try:
                while True:
                    try:
                        msg = await loop.run_in_executor(
                            None, lambda: q.get(timeout=30)
                        )
                        yield msg
                    except Empty:
                        yield ": keepalive\n\n"
            except asyncio.CancelledError:
                pass
            finally:
                with _sse_lock:
                    if q in _sse_clients:
                        _sse_clients.remove(q)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.get("/studio/gallery/watcher-status")
    async def gallery_watcher_status():
        return {
            "active": _watcher_running and _watcher_observer is not None,
            "has_watchdog": HAS_WATCHDOG,
        }

    @app.get("/studio/gallery/suggest")
    async def gallery_suggest(q: str = ""):
        """Return character names + metadata words matching query prefix."""
        if len(q.strip()) < 1:
            return []
        q = q.strip().lower()
        db = _get_db()
        try:
            results = {}
            for r in db.execute(
                "SELECT c.name, COUNT(ic.image_id) as cnt "
                "FROM characters c JOIN image_characters ic ON c.id=ic.character_id "
                "WHERE c.name LIKE ? COLLATE NOCASE GROUP BY c.id ORDER BY cnt DESC LIMIT 10",
                (f"%{q}%",),
            ).fetchall():
                if r["name"].lower() != "unknown":
                    results[r["name"]] = {
                        "name": r["name"], "count": r["cnt"], "type": "tag",
                    }
            word_counts = {}
            for r in db.execute(
                "SELECT search_text FROM images WHERE search_text LIKE ?",
                (f"%{q}%",),
            ).fetchall():
                for word in r["search_text"].split():
                    if q in word and len(word) >= 2:
                        word_counts[word] = word_counts.get(word, 0) + 1
            char_lower = {k.lower() for k in results}
            sorted_words = sorted(word_counts.items(), key=lambda x: -x[1])
            for word, cnt in sorted_words[:15]:
                if word.lower() not in char_lower and cnt >= 2:
                    nice = word.title()
                    if nice.lower() not in char_lower:
                        results[nice] = {"name": nice, "count": cnt, "type": "meta"}
            out = sorted(
                results.values(),
                key=lambda x: (
                    -1 if x["name"].lower().startswith(q) else 0,
                    -x["count"],
                ),
            )
            return out[:12]
        finally:
            db.close()

    # ==================================================================
    # SCAN FOLDERS
    # ==================================================================

    @app.get("/studio/gallery/scan-folders")
    async def gallery_scan_folders():
        db = _get_db()
        try:
            rows = db.execute(
                "SELECT id, path, label FROM scan_folders ORDER BY natural_key(label)"
            ).fetchall()
            return [dict(r) for r in rows]
        finally:
            db.close()

    @app.post("/studio/gallery/scan-folders")
    async def gallery_add_scan_folder(request: Request):
        data = await request.json()
        path = data.get("path", "").strip()
        if not path:
            return JSONResponse({"error": "No path provided"}, status_code=400)
        db = _get_db()
        try:
            label = Path(path).name
            db.execute(
                "INSERT OR IGNORE INTO scan_folders (path, label) VALUES (?,?)",
                (path, label),
            )
            db.commit()
            threading.Thread(target=restart_watcher, daemon=True).start()
            return {"ok": True}
        finally:
            db.close()

    @app.delete("/studio/gallery/scan-folders/{folder_id}")
    async def gallery_delete_scan_folder(folder_id: int):
        db = _get_db()
        try:
            row = db.execute("SELECT path FROM scan_folders WHERE id=?", (folder_id,)).fetchone()
            if row:
                root = row["path"]
                db.execute("DELETE FROM images WHERE filepath LIKE ?", (root + "%",))
                db.execute(
                    "DELETE FROM characters WHERE id NOT IN "
                    "(SELECT DISTINCT character_id FROM image_characters)"
                )
            db.execute("DELETE FROM scan_folders WHERE id=?", (folder_id,))
            db.commit()
            threading.Thread(target=restart_watcher, daemon=True).start()
            return {"ok": True}
        finally:
            db.close()

    @app.post("/studio/gallery/pick-folder")
    async def gallery_pick_folder():
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.wm_attributes('-topmost', 1)
            folder = filedialog.askdirectory(title="Select image folder")
            root.destroy()
            if folder:
                return {"path": folder.replace("/", os.sep)}
            return {"path": ""}
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)

    # ==================================================================
    # SCAN
    # ==================================================================

    @app.post("/studio/gallery/scan")
    async def gallery_scan():
        # Run scan in background thread to avoid blocking
        import asyncio
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, scan_all_folders)
        return result

    @app.get("/studio/gallery/scan-progress")
    async def gallery_scan_progress():
        return scan_progress

    @app.post("/studio/gallery/rescan-characters")
    async def gallery_rescan_characters():
        db = _get_db()
        try:
            ignore_words = get_ignore_words(db)
            images = db.execute("SELECT id,filename FROM images").fetchall()
            for img in images:
                chars = parse_characters_from_filename(img["filename"], ignore_words)
                db.execute("DELETE FROM image_characters WHERE image_id=?", (img["id"],))
                for pos, cn in enumerate(chars):
                    db.execute("INSERT OR IGNORE INTO characters (name) VALUES (?)", (cn,))
                    cr = db.execute(
                        "SELECT id FROM characters WHERE name=? COLLATE NOCASE", (cn,)
                    ).fetchone()
                    if cr:
                        db.execute(
                            "INSERT OR IGNORE INTO image_characters "
                            "(image_id,character_id,position) VALUES (?,?,?)",
                            (img["id"], cr["id"], pos),
                        )
            db.execute(
                "DELETE FROM characters WHERE id NOT IN "
                "(SELECT DISTINCT character_id FROM image_characters)"
            )
            db.commit()
            return {"updated": len(images)}
        finally:
            db.close()

    # ==================================================================
    # FOLDERS
    # ==================================================================

    @app.get("/studio/gallery/folders")
    async def gallery_folders():
        db = _get_db()
        try:
            rows = db.execute(
                "SELECT folder,COUNT(*) as image_count FROM images "
                "GROUP BY folder ORDER BY natural_key(folder)"
            ).fetchall()
            result = {r["folder"]: r["image_count"] for r in rows}
            scan_roots = db.execute("SELECT path FROM scan_folders").fetchall()
            for sf in scan_roots:
                root = Path(sf["path"])
                if not root.exists():
                    continue
                for dirpath, dirnames, filenames in os.walk(root):
                    dirnames.sort()
                    rel = os.path.relpath(dirpath, root)
                    display = f"{root.name}\\{rel}" if rel != "." else root.name
                    if display not in result:
                        result[display] = 0
            return [
                {"folder": k, "image_count": v}
                for k, v in sorted(result.items(), key=lambda x: _natural_sort_key(x[0]))
            ]
        finally:
            db.close()

    @app.post("/studio/gallery/create-folder")
    async def gallery_create_folder(request: Request):
        data = await request.json()
        parent = data.get("parent", "").strip()
        name = data.get("name", "").strip()
        if not name:
            return JSONResponse({"error": "No name provided"}, status_code=400)
        invalid = set('<>:"/\\|?*')
        if any(c in invalid for c in name):
            return JSONResponse({"error": "Invalid characters in name"}, status_code=400)
        db = _get_db()
        try:
            if parent:
                real_parent = _resolve_display_folder(db, parent)
                if not real_parent or not os.path.isdir(real_parent):
                    return JSONResponse({"error": "Parent folder not found"}, status_code=404)
            else:
                folders = db.execute("SELECT path FROM scan_folders").fetchall()
                if not folders:
                    return JSONResponse({"error": "No scan folders configured"}, status_code=400)
                real_parent = folders[0]["path"]
            new_path = os.path.join(real_parent, name)
            if os.path.exists(new_path):
                return JSONResponse({"error": "Folder already exists"}, status_code=409)
            os.makedirs(new_path, exist_ok=True)
            return {"ok": True, "path": new_path}
        finally:
            db.close()

    @app.post("/studio/gallery/delete-folder")
    async def gallery_delete_folder(request: Request):
        import shutil
        data = await request.json()
        folder = data.get("folder", "").strip()
        if not folder:
            return JSONResponse({"error": "No folder"}, status_code=400)
        db = _get_db()
        try:
            real_path = _resolve_display_folder(db, folder)
            if not real_path or not os.path.isdir(real_path):
                return JSONResponse({"error": "Folder not found on disk"}, status_code=404)
            roots = [r["path"] for r in db.execute("SELECT path FROM scan_folders").fetchall()]
            is_root = real_path in roots
            file_count = sum(len(fns) for _, _, fns in os.walk(real_path))
            shutil.rmtree(real_path)
            db.execute(
                "DELETE FROM images WHERE filepath LIKE ? OR filepath LIKE ?",
                (real_path + os.sep + "%", real_path + "/%"),
            )
            if is_root:
                db.execute("DELETE FROM scan_folders WHERE path=?", (real_path,))
            db.execute(
                "DELETE FROM characters WHERE id NOT IN "
                "(SELECT DISTINCT character_id FROM image_characters)"
            )
            db.commit()
            return {"ok": True, "deleted_files": file_count}
        finally:
            db.close()

    @app.post("/studio/gallery/rename-folder")
    async def gallery_rename_folder(request: Request):
        data = await request.json()
        folder = data.get("folder", "").strip()
        new_name = data.get("new_name", "").strip()
        if not folder or not new_name:
            return JSONResponse({"error": "Missing data"}, status_code=400)
        invalid = set('<>:"/\\|?*')
        if any(c in invalid for c in new_name):
            return JSONResponse({"error": "Invalid characters"}, status_code=400)
        db = _get_db()
        try:
            real_path = _resolve_display_folder(db, folder)
            if not real_path or not os.path.isdir(real_path):
                return JSONResponse({"error": "Folder not found"}, status_code=404)
            new_path = os.path.join(os.path.dirname(real_path), new_name)
            if os.path.exists(new_path) and new_path != real_path:
                return JSONResponse({"error": "A folder with that name already exists"}, status_code=409)
            roots = [r["path"] for r in db.execute("SELECT path FROM scan_folders").fetchall()]
            is_root = real_path in roots
            os.rename(real_path, new_path)
            old_prefix = real_path + os.sep
            new_prefix = new_path + os.sep
            for img in db.execute(
                "SELECT id,filepath,folder FROM images WHERE filepath LIKE ?",
                (old_prefix + "%",),
            ).fetchall():
                nfp = new_prefix + img["filepath"][len(old_prefix):]
                old_display = img["folder"]
                old_root_name = Path(real_path).name
                new_display = (
                    new_name + old_display[len(old_root_name):]
                    if old_display.startswith(old_root_name) else old_display
                )
                db.execute(
                    "UPDATE images SET filepath=?, folder=?, filename=? WHERE id=?",
                    (nfp, new_display, os.path.basename(nfp), img["id"]),
                )
            if is_root:
                db.execute(
                    "UPDATE scan_folders SET path=?, label=? WHERE path=?",
                    (new_path, new_name, real_path),
                )
            db.commit()
            if is_root:
                threading.Thread(target=restart_watcher, daemon=True).start()
            return {"ok": True}
        finally:
            db.close()

    @app.post("/studio/gallery/unlink-folder")
    async def gallery_unlink_folder(request: Request):
        data = await request.json()
        folder = data.get("folder", "").strip()
        if not folder:
            return JSONResponse({"error": "No folder"}, status_code=400)
        db = _get_db()
        try:
            real_path = _resolve_display_folder(db, folder)
            if not real_path:
                return JSONResponse({"error": "Folder not found"}, status_code=404)
            roots = [r["path"] for r in db.execute("SELECT path FROM scan_folders").fetchall()]
            unlink_root = None
            if real_path in roots:
                unlink_root = real_path
            else:
                for r in roots:
                    if real_path.startswith(r + os.sep):
                        unlink_root = r
                        break
            if not unlink_root:
                return JSONResponse({"error": "Not a linked folder"}, status_code=400)
            db.execute("DELETE FROM images WHERE filepath LIKE ?", (unlink_root + os.sep + "%",))
            db.execute("DELETE FROM images WHERE filepath LIKE ?", (unlink_root + "/%",))
            db.execute("DELETE FROM scan_folders WHERE path=?", (unlink_root,))
            db.execute(
                "DELETE FROM characters WHERE id NOT IN "
                "(SELECT DISTINCT character_id FROM image_characters)"
            )
            db.commit()
            threading.Thread(target=restart_watcher, daemon=True).start()
            return {"ok": True, "unlinked": unlink_root}
        finally:
            db.close()

    @app.post("/studio/gallery/folders/bulk-delete")
    async def gallery_folders_bulk_delete(request: Request):
        import shutil
        data = await request.json()
        folders = data.get("folders", [])
        if not folders:
            return JSONResponse({"error": "No folders"}, status_code=400)
        db = _get_db()
        try:
            deleted = []
            deleted_files = 0
            errors = []
            roots = [r["path"] for r in db.execute("SELECT path FROM scan_folders").fetchall()]
            for fp in folders:
                try:
                    real_path = _resolve_display_folder(db, fp)
                    if not real_path or not os.path.isdir(real_path):
                        errors.append(f"{fp}: not found")
                        continue
                    is_root = real_path in roots
                    file_count = sum(len(fns) for _, _, fns in os.walk(real_path))
                    # Suppress watcher for files about to be deleted
                    affected_rows = db.execute(
                        "SELECT filepath FROM images WHERE filepath LIKE ? OR filepath LIKE ?",
                        (real_path + os.sep + "%", real_path + "/%"),
                    ).fetchall()
                    for row in affected_rows:
                        suppress_path(row["filepath"])
                    shutil.rmtree(real_path)
                    db.execute(
                        "DELETE FROM images WHERE filepath LIKE ? OR filepath LIKE ?",
                        (real_path + os.sep + "%", real_path + "/%"),
                    )
                    if is_root:
                        db.execute("DELETE FROM scan_folders WHERE path=?", (real_path,))
                    deleted.append(fp)
                    deleted_files += file_count
                except Exception as e:
                    errors.append(f"{fp}: {e}")
            db.execute(
                "DELETE FROM characters WHERE id NOT IN "
                "(SELECT DISTINCT character_id FROM image_characters)"
            )
            db.commit()
            return {"ok": True, "deleted": deleted, "deleted_files": deleted_files, "errors": errors}
        finally:
            db.close()

    @app.post("/studio/gallery/folders/bulk-move")
    async def gallery_folders_bulk_move(request: Request):
        import shutil as _shutil
        data = await request.json()
        folders = data.get("folders", [])
        target = data.get("target", "").strip()
        if not folders:
            return JSONResponse({"error": "No folders"}, status_code=400)
        db = _get_db()
        try:
            target_real = _resolve_display_folder(db, target) if target else None
            if target and (not target_real or not os.path.isdir(target_real)):
                return JSONResponse({"error": "Target folder not found"}, status_code=404)
            moved = []
            errors = []
            scan_roots = db.execute("SELECT path FROM scan_folders").fetchall()
            for fp in folders:
                try:
                    src_real = _resolve_display_folder(db, fp)
                    if not src_real or not os.path.isdir(src_real):
                        errors.append(f"{fp}: not found")
                        continue
                    if target_real and os.path.normpath(target_real).startswith(os.path.normpath(src_real)):
                        errors.append(f"{fp}: cannot move into itself")
                        continue
                    folder_name = os.path.basename(src_real)
                    dst_real = os.path.join(target_real, folder_name) if target_real else None
                    if not dst_real:
                        errors.append(f"{fp}: no target")
                        continue
                    if os.path.exists(dst_real):
                        errors.append(f"{fp}: target already has a folder named '{folder_name}'")
                        continue
                    # Suppress watcher for all affected files
                    affected = db.execute(
                        "SELECT id, filepath, folder FROM images WHERE filepath LIKE ? OR filepath LIKE ?",
                        (src_real + os.sep + "%", src_real + "/%"),
                    ).fetchall()
                    for row in affected:
                        suppress_path(row["filepath"])
                    _shutil.move(src_real, dst_real)
                    # Update DB rows — rewrite filepaths and display folders
                    for row in affected:
                        old_fp = row["filepath"]
                        rel = os.path.relpath(old_fp, src_real)
                        new_fp = os.path.join(dst_real, rel)
                        new_folder = None
                        for sf in scan_roots:
                            root = sf["path"]
                            if new_fp.startswith(root + os.sep) or new_fp.startswith(root + "/"):
                                rel2 = os.path.relpath(os.path.dirname(new_fp), root)
                                new_folder = Path(root).name + ("\\" + rel2 if rel2 != "." else "")
                                break
                        if new_folder:
                            suppress_path(new_fp)
                            db.execute(
                                "UPDATE images SET filepath = ?, folder = ? WHERE id = ?",
                                (new_fp, new_folder, row["id"]),
                            )
                    moved.append(fp)
                except Exception as e:
                    errors.append(f"{fp}: {e}")
            db.commit()
            return {"ok": True, "moved": moved, "errors": errors}
        finally:
            db.close()

    # ==================================================================
    # CHARACTERS / TAGS
    # ==================================================================

    @app.get("/studio/gallery/characters")
    async def gallery_characters(folder: str = ""):
        db = _get_db()
        try:
            if folder:
                rows = db.execute("""
                    SELECT c.id, c.name, COUNT(DISTINCT ic.image_id) as image_count
                    FROM characters c
                    JOIN image_characters ic ON c.id=ic.character_id
                    JOIN images i ON ic.image_id=i.id
                    WHERE i.folder=? OR i.folder GLOB ?
                    GROUP BY c.id ORDER BY c.name COLLATE NOCASE ASC
                """, (folder, folder + "\\*")).fetchall()
            else:
                rows = db.execute("""
                    SELECT c.id, c.name, COUNT(ic.image_id) as image_count
                    FROM characters c JOIN image_characters ic ON c.id=ic.character_id
                    GROUP BY c.id ORDER BY c.name COLLATE NOCASE ASC
                """).fetchall()
            result = [dict(r) for r in rows]
            unknown = [r for r in result if r["name"].lower() == "unknown"]
            rest = [r for r in result if r["name"].lower() != "unknown"]
            return unknown + rest
        finally:
            db.close()

    # ==================================================================
    # IMAGES
    # ==================================================================

    @app.get("/studio/gallery/images")
    async def gallery_images(
        character: str = "", folder: str = "", search: str = "",
        sort: str = "filename", order: str = "asc",
        page: int = 1, per_page: int = 60,
    ):
        db = _get_db()
        try:
            offset = (page - 1) * per_page
            q = "SELECT DISTINCT i.id,i.filename,i.folder,i.filepath,i.width,i.height,i.file_date,i.media_type FROM images i"
            conds, params = [], []
            if character:
                q += " JOIN image_characters ic ON i.id=ic.image_id JOIN characters c ON ic.character_id=c.id"
                conds.append("c.name=? COLLATE NOCASE")
                params.append(character)
            if folder:
                conds.append("(i.folder=? OR i.folder GLOB ?)")
                params.extend([folder, folder + "\\*"])
            if search:
                terms = [t.strip() for t in re.split(r'[,\s]+', search) if t.strip()]
                for term in terms:
                    conds.append(
                        "(i.filename LIKE ? OR i.id IN ("
                        "SELECT ic2.image_id FROM image_characters ic2 "
                        "JOIN characters c2 ON ic2.character_id=c2.id "
                        "WHERE c2.name LIKE ? COLLATE NOCASE) OR i.search_text LIKE ?)"
                    )
                    params.extend([f"%{term}%", f"%{term}%", f"%{term.lower()}%"])
            if conds:
                q += " WHERE " + " AND ".join(conds)

            cq = q.replace(
                "SELECT DISTINCT i.id,i.filename,i.folder,i.filepath,i.width,i.height,i.file_date,i.media_type",
                "SELECT COUNT(DISTINCT i.id)",
            )
            total = db.execute(cq, params).fetchone()[0]

            od = "ASC" if order == "asc" else "DESC"
            if sort == "folder":
                q += f" ORDER BY natural_key(i.folder) {od}, natural_key(i.filename) {od}"
            elif sort == "newest":
                q += f" ORDER BY i.file_date {od}, natural_key(i.filename) DESC"
            else:
                q += f" ORDER BY natural_key(i.filename) {od}, natural_key(i.folder) {od}"
            q += " LIMIT ? OFFSET ?"
            params.extend([per_page, offset])
            rows = db.execute(q, params).fetchall()

            images = []
            for r in rows:
                chars = db.execute(
                    "SELECT c.name FROM characters c "
                    "JOIN image_characters ic ON c.id=ic.character_id "
                    "WHERE ic.image_id=? ORDER BY ic.position",
                    (r["id"],),
                ).fetchall()
                ext = Path(r["filename"]).suffix.lower()
                mt = r["media_type"] if ("media_type" in r.keys() and r["media_type"]) else (
                    "video" if ext in VIDEO_EXTENSIONS else ("gif" if ext == ".gif" else "image")
                )
                images.append({
                    "id": r["id"], "filename": r["filename"], "folder": r["folder"],
                    "width": r["width"], "height": r["height"], "file_date": r["file_date"],
                    "fphash": get_filepath_hash(r["filepath"]),
                    "is_video": mt == "video",
                    "media_type": mt,
                    "characters": [c["name"] for c in chars],
                })
            return {
                "images": images, "total": total,
                "page": page, "pages": (total + per_page - 1) // per_page,
            }
        finally:
            db.close()

    @app.get("/studio/gallery/image/{image_id}")
    async def gallery_image_detail(image_id: int):
        db = _get_db()
        try:
            row = db.execute("SELECT * FROM images WHERE id=?", (image_id,)).fetchone()
            if not row:
                return JSONResponse({"error": "Not found"}, status_code=404)
            chars = db.execute(
                "SELECT c.name FROM characters c "
                "JOIN image_characters ic ON c.id=ic.character_id "
                "WHERE ic.image_id=? ORDER BY ic.position",
                (image_id,),
            ).fetchall()
            return {
                "id": row["id"], "filename": row["filename"], "folder": row["folder"],
                "filepath": row["filepath"], "width": row["width"], "height": row["height"],
                "file_date": row["file_date"], "characters": [c["name"] for c in chars],
            }
        finally:
            db.close()

    @app.get("/studio/gallery/image/{image_id}/metadata")
    async def gallery_image_metadata(image_id: int):
        db = _get_db()
        try:
            row = db.execute("SELECT filepath, content_hash FROM images WHERE id=?", (image_id,)).fetchone()
            if not row:
                return JSONResponse({"error": "Not found"}, status_code=404)
            # Try file-embedded metadata first
            meta = extract_metadata(row["filepath"])
            if meta and (meta.get("prompt") or meta.get("raw_parameters")):
                meta["_source"] = "embedded"
                return meta
            # Fall back to DB-stored metadata (by image_id)
            db_meta = db.execute("SELECT * FROM image_metadata WHERE image_id=?", (image_id,)).fetchone()
            if not db_meta and row["content_hash"]:
                # Try by content_hash (handles renames, orphan metadata)
                db_meta = db.execute(
                    "SELECT * FROM image_metadata WHERE content_hash=?",
                    (row["content_hash"],)
                ).fetchone()
            if db_meta:
                result = {k: db_meta[k] for k in db_meta.keys()
                          if db_meta[k] is not None and k not in ("image_id", "id", "content_hash")}
                result["_source"] = "stored"
                return result
            # No metadata from either source
            meta["_source"] = "none"
            return meta
        finally:
            db.close()

    @app.post("/studio/gallery/metadata")
    async def gallery_save_metadata(request: Request):
        """Save generation metadata to Gallery DB for an image by filepath or content_hash."""
        data = await request.json()
        filepath = data.get("filepath", "").strip()
        content_hash = data.get("content_hash", "").strip()
        metadata = data.get("metadata", {})
        if (not filepath and not content_hash) or not metadata:
            return JSONResponse({"error": "filepath or content_hash, and metadata required"}, status_code=400)
        db = _get_db()
        try:
            image_id = None
            if not content_hash and filepath:
                # Compute hash from file
                content_hash = compute_content_hash(filepath)
            if filepath:
                row = db.execute("SELECT id FROM images WHERE filepath=?", (filepath,)).fetchone()
                if not row:
                    norm = os.path.normpath(filepath)
                    row = db.execute("SELECT id FROM images WHERE filepath=?", (norm,)).fetchone()
                if row:
                    image_id = row["id"]
            if not image_id and content_hash:
                row = db.execute("SELECT id FROM images WHERE content_hash=?", (content_hash,)).fetchone()
                if row:
                    image_id = row["id"]
            meta = _parse_meta_fields(metadata.get("raw_infotext", ""), metadata)
            # Override raw_infotext from metadata directly if present
            if metadata.get("raw_infotext"):
                meta["raw_infotext"] = metadata["raw_infotext"]
            db.execute(_META_INSERT_SQL, _meta_row_values(meta, content_hash or "", image_id))
            db.commit()
            return {"saved": True, "image_id": image_id, "content_hash": content_hash}
        except Exception as e:
            print(f"[Gallery] Metadata save error: {e}")
            return JSONResponse({"error": str(e)}, status_code=500)
        finally:
            db.close()

    # ==================================================================
    # TAG OPERATIONS
    # ==================================================================

    @app.post("/studio/gallery/image/{image_id}/add-tag")
    async def gallery_add_tag(image_id: int, request: Request):
        data = await request.json()
        tag = data.get("tag", "").strip().title()
        if not tag:
            return JSONResponse({"error": "No tag"}, status_code=400)
        db = _get_db()
        try:
            row = db.execute("SELECT id FROM images WHERE id=?", (image_id,)).fetchone()
            if not row:
                return JSONResponse({"error": "Not found"}, status_code=404)
            db.execute("INSERT OR IGNORE INTO characters (name) VALUES (?)", (tag,))
            cr = db.execute("SELECT id FROM characters WHERE name=? COLLATE NOCASE", (tag,)).fetchone()
            if cr:
                maxp = db.execute(
                    "SELECT MAX(position) as mp FROM image_characters WHERE image_id=?",
                    (image_id,),
                ).fetchone()
                pos = (maxp["mp"] or 0) + 1
                db.execute(
                    "INSERT OR IGNORE INTO image_characters (image_id,character_id,position) VALUES (?,?,?)",
                    (image_id, cr["id"], pos),
                )
            db.commit()
            chars = [
                c["name"] for c in db.execute(
                    "SELECT c.name FROM characters c "
                    "JOIN image_characters ic ON c.id=ic.character_id "
                    "WHERE ic.image_id=? ORDER BY ic.position",
                    (image_id,),
                ).fetchall()
            ]
            return {"ok": True, "characters": chars}
        finally:
            db.close()

    @app.post("/studio/gallery/image/{image_id}/remove-tag")
    async def gallery_remove_tag(image_id: int, request: Request):
        data = await request.json()
        tag = data.get("tag", "").strip()
        add_ignore = data.get("add_ignore", True)
        if not tag:
            return JSONResponse({"error": "No tag"}, status_code=400)
        db = _get_db()
        try:
            if add_ignore:
                db.execute("INSERT OR IGNORE INTO ignore_words (word) VALUES (?)", (tag.lower(),))
            char_row = db.execute("SELECT id FROM characters WHERE name=? COLLATE NOCASE", (tag,)).fetchone()
            affected_ids = []
            if char_row:
                if add_ignore:
                    affected = db.execute(
                        "SELECT image_id FROM image_characters WHERE character_id=?",
                        (char_row["id"],),
                    ).fetchall()
                    affected_ids = [r["image_id"] for r in affected]
                    db.execute("DELETE FROM image_characters WHERE character_id=?", (char_row["id"],))
                else:
                    db.execute(
                        "DELETE FROM image_characters WHERE image_id=? AND character_id=?",
                        (image_id, char_row["id"]),
                    )
                    affected_ids = [image_id]
                for aid in affected_ids:
                    cnt = db.execute(
                        "SELECT COUNT(*) FROM image_characters WHERE image_id=?", (aid,)
                    ).fetchone()[0]
                    if cnt == 0:
                        db.execute("INSERT OR IGNORE INTO characters (name) VALUES (?)", ("Unknown",))
                        unk = db.execute(
                            "SELECT id FROM characters WHERE name='Unknown' COLLATE NOCASE"
                        ).fetchone()
                        if unk:
                            db.execute(
                                "INSERT OR IGNORE INTO image_characters "
                                "(image_id,character_id,position) VALUES (?,?,0)",
                                (aid, unk["id"]),
                            )
            db.execute(
                "DELETE FROM characters WHERE id NOT IN "
                "(SELECT DISTINCT character_id FROM image_characters)"
            )
            db.commit()
            chars = [
                c["name"] for c in db.execute(
                    "SELECT c.name FROM characters c "
                    "JOIN image_characters ic ON c.id=ic.character_id "
                    "WHERE ic.image_id=? ORDER BY ic.position",
                    (image_id,),
                ).fetchall()
            ]
            return {
                "ok": True,
                "ignored": tag.lower() if add_ignore else None,
                "characters": chars,
                "affected": len(affected_ids),
            }
        finally:
            db.close()

    # ==================================================================
    # RENAME / MOVE / DELETE
    # ==================================================================

    @app.post("/studio/gallery/image/{image_id}/rename")
    async def gallery_rename_image(image_id: int, request: Request):
        data = await request.json()
        new_fn = data.get("filename", "").strip()
        auto_inc = data.get("auto_increment", False)
        continue_num = data.get("continue_numbering", False)
        if not new_fn:
            return JSONResponse({"error": "No filename"}, status_code=400)
        db = _get_db()
        try:
            row = db.execute("SELECT * FROM images WHERE id=?", (image_id,)).fetchone()
            if not row:
                return JSONResponse({"error": "Not found"}, status_code=404)
            old_fp = row["filepath"]
            old_dir = os.path.dirname(old_fp)
            has_ext = bool(Path(new_fn).suffix)
            if not has_ext:
                new_fn += Path(old_fp).suffix
            if continue_num:
                base = Path(new_fn).stem
                ext = Path(new_fn).suffix
                next_n = find_next_global_number(db, base, exclude_ids=[image_id])
                if next_n > 1:
                    new_fn = f"{base} ({next_n}){ext}"
            new_fp = os.path.join(old_dir, new_fn)
            if os.path.exists(new_fp) and new_fp != old_fp:
                suggestion = find_available_filename(old_dir, new_fn)
                if auto_inc:
                    new_fn = suggestion
                    new_fp = os.path.join(old_dir, new_fn)
                else:
                    return JSONResponse(
                        {"error": "File exists", "suggestion": suggestion}, status_code=409
                    )
            suppress_path(old_fp)
            suppress_path(new_fp)
            os.rename(old_fp, new_fp)
            db.execute("UPDATE images SET filename=?, filepath=? WHERE id=?", (new_fn, new_fp, image_id))
            iw = get_ignore_words(db)
            chars = parse_characters_from_filename(new_fn, iw)
            db.execute("DELETE FROM image_characters WHERE image_id=?", (image_id,))
            for pos, cn in enumerate(chars):
                db.execute("INSERT OR IGNORE INTO characters (name) VALUES (?)", (cn,))
                cr = db.execute("SELECT id FROM characters WHERE name=? COLLATE NOCASE", (cn,)).fetchone()
                if cr:
                    db.execute(
                        "INSERT OR IGNORE INTO image_characters (image_id,character_id,position) VALUES (?,?,?)",
                        (image_id, cr["id"], pos),
                    )
            db.execute(
                "DELETE FROM characters WHERE id NOT IN "
                "(SELECT DISTINCT character_id FROM image_characters)"
            )
            db.commit()
            return {"ok": True, "filename": new_fn, "characters": chars, "old_filename": row["filename"]}
        except OSError as e:
            return JSONResponse({"error": str(e)}, status_code=500)
        finally:
            db.close()

    @app.post("/studio/gallery/image/{image_id}/move")
    async def gallery_move_image(image_id: int, request: Request):
        data = await request.json()
        target_folder = data.get("folder", "").strip()
        if not target_folder:
            return JSONResponse({"error": "No target folder"}, status_code=400)
        db = _get_db()
        try:
            row = db.execute("SELECT * FROM images WHERE id=?", (image_id,)).fetchone()
            if not row:
                return JSONResponse({"error": "Not found"}, status_code=404)
            target_path = _resolve_display_folder(db, target_folder)
            if not target_path or not os.path.isdir(target_path):
                return JSONResponse({"error": "Target folder not found"}, status_code=404)
            old_fp = row["filepath"]
            new_fp = os.path.join(target_path, row["filename"])
            if os.path.exists(new_fp) and new_fp != old_fp:
                return JSONResponse({"error": "File already exists in target folder"}, status_code=409)
            suppress_path(old_fp)
            suppress_path(new_fp)
            os.rename(old_fp, new_fp)
            scan_roots = db.execute("SELECT path FROM scan_folders").fetchall()
            display = target_folder
            for sf in scan_roots:
                root = sf["path"]
                if new_fp.startswith(root + os.sep) or new_fp.startswith(root + "/"):
                    rel = os.path.relpath(os.path.dirname(new_fp), root)
                    display = Path(root).name + ("\\" + rel if rel != "." else "")
                    break
            db.execute("UPDATE images SET filepath=?, folder=? WHERE id=?", (new_fp, display, image_id))
            db.commit()
            return {"ok": True, "folder": display}
        except OSError as e:
            return JSONResponse({"error": str(e)}, status_code=500)
        finally:
            db.close()

    @app.post("/studio/gallery/image/{image_id}/delete")
    async def gallery_delete_image(image_id: int):
        db = _get_db()
        try:
            row = db.execute("SELECT * FROM images WHERE id=?", (image_id,)).fetchone()
            if not row:
                return JSONResponse({"error": "Not found"}, status_code=404)
            fp = row["filepath"]
            chars = [
                c["name"] for c in db.execute(
                    "SELECT c.name FROM characters c "
                    "JOIN image_characters ic ON c.id=ic.character_id "
                    "WHERE ic.image_id=?", (image_id,),
                ).fetchall()
            ]
            trash_name = f"{int(time.time() * 1000)}_{row['filename']}"
            trash_path = str(_trash_dir / trash_name)
            suppress_path(fp)
            try:
                if os.path.exists(fp):
                    os.rename(fp, trash_path)
                else:
                    trash_path = ""
            except OSError as e:
                return JSONResponse({"error": str(e)}, status_code=500)
            db.execute(
                "INSERT INTO trash (original_filepath,original_folder,original_filename,"
                "trash_path,width,height,file_date,search_text,characters_json,deleted_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (fp, row["folder"], row["filename"], trash_path,
                 row["width"], row["height"], row["file_date"],
                 row["search_text"] if "search_text" in row.keys() else "",
                 json.dumps(chars), time.time()),
            )
            trash_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
            db.execute("DELETE FROM images WHERE id=?", (image_id,))
            db.execute(
                "DELETE FROM characters WHERE id NOT IN "
                "(SELECT DISTINCT character_id FROM image_characters)"
            )
            db.commit()
            return {"ok": True, "trash_id": trash_id}
        finally:
            db.close()

    @app.post("/studio/gallery/restore/{trash_id}")
    async def gallery_restore(trash_id: int):
        db = _get_db()
        try:
            row = db.execute("SELECT * FROM trash WHERE id=?", (trash_id,)).fetchone()
            if not row:
                return JSONResponse({"error": "Trash entry not found"}, status_code=404)
            tp = row["trash_path"]
            ofp = row["original_filepath"]
            target_dir = os.path.dirname(ofp)
            if not os.path.isdir(target_dir):
                os.makedirs(target_dir, exist_ok=True)
            if os.path.exists(ofp):
                ofn = find_available_filename(target_dir, row["original_filename"])
                ofp = os.path.join(target_dir, ofn)
            else:
                ofn = row["original_filename"]
            if not tp or not os.path.exists(tp):
                return JSONResponse({"error": "Trash file not found on disk"}, status_code=404)
            os.rename(tp, ofp)
            _ext = Path(ofn).suffix.lower()
            _mt = "video" if _ext in VIDEO_EXTENSIONS else ("gif" if _ext == ".gif" else "image")
            _ch = compute_content_hash(ofp) if _ext not in VIDEO_EXTENSIONS else ""
            cur = db.execute(
                "INSERT INTO images (filename,folder,filepath,width,height,file_date,search_text,media_type,content_hash) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (ofn, row["original_folder"], ofp, row["width"], row["height"],
                 row["file_date"], row["search_text"], _mt, _ch),
            )
            new_id = cur.lastrowid
            if _ch:
                db.execute(
                    "UPDATE image_metadata SET image_id=? WHERE content_hash=? AND image_id IS NULL",
                    (new_id, _ch),
                )
            try:
                chars = json.loads(row["characters_json"])
            except Exception:
                chars = []
            for pos, cn in enumerate(chars):
                db.execute("INSERT OR IGNORE INTO characters (name) VALUES (?)", (cn,))
                cr = db.execute("SELECT id FROM characters WHERE name=? COLLATE NOCASE", (cn,)).fetchone()
                if cr:
                    db.execute(
                        "INSERT OR IGNORE INTO image_characters (image_id,character_id,position) VALUES (?,?,?)",
                        (new_id, cr["id"], pos),
                    )
            db.execute("DELETE FROM trash WHERE id=?", (trash_id,))
            db.commit()
            return {"ok": True, "image_id": new_id}
        except OSError as e:
            return JSONResponse({"error": str(e)}, status_code=500)
        finally:
            db.close()

    # ==================================================================
    # BULK OPERATIONS
    # ==================================================================

    @app.post("/studio/gallery/images/bulk-delete")
    async def gallery_bulk_delete(request: Request):
        data = await request.json()
        ids = data.get("ids", [])
        db = _get_db()
        try:
            deleted = 0
            trash_ids = []
            for img_id in ids:
                row = db.execute("SELECT * FROM images WHERE id=?", (img_id,)).fetchone()
                if not row:
                    continue
                fp = row["filepath"]
                chars = [
                    c["name"] for c in db.execute(
                        "SELECT c.name FROM characters c "
                        "JOIN image_characters ic ON c.id=ic.character_id "
                        "WHERE ic.image_id=?", (img_id,),
                    ).fetchall()
                ]
                trash_name = f"{int(time.time() * 1000)}_{row['filename']}"
                trash_path = str(_trash_dir / trash_name)
                suppress_path(fp)
                try:
                    if os.path.exists(fp):
                        os.rename(fp, trash_path)
                    else:
                        trash_path = ""
                except Exception:
                    trash_path = ""
                db.execute(
                    "INSERT INTO trash (original_filepath,original_folder,original_filename,"
                    "trash_path,width,height,file_date,search_text,characters_json,deleted_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (fp, row["folder"], row["filename"], trash_path,
                     row["width"], row["height"], row["file_date"],
                     row["search_text"] if "search_text" in row.keys() else "",
                     json.dumps(chars), time.time()),
                )
                tid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
                trash_ids.append(tid)
                db.execute("DELETE FROM images WHERE id=?", (img_id,))
                deleted += 1
            db.execute(
                "DELETE FROM characters WHERE id NOT IN "
                "(SELECT DISTINCT character_id FROM image_characters)"
            )
            db.commit()
            return {"ok": True, "deleted": deleted, "trash_ids": trash_ids}
        finally:
            db.close()

    @app.post("/studio/gallery/bulk-restore")
    async def gallery_bulk_restore(request: Request):
        data = await request.json()
        trash_ids = data.get("trash_ids", [])
        db = _get_db()
        try:
            restored = 0
            for tid in trash_ids:
                row = db.execute("SELECT * FROM trash WHERE id=?", (tid,)).fetchone()
                if not row:
                    continue
                tp = row["trash_path"]
                ofp = row["original_filepath"]
                target_dir = os.path.dirname(ofp)
                if not os.path.isdir(target_dir):
                    try:
                        os.makedirs(target_dir, exist_ok=True)
                    except Exception:
                        continue
                if os.path.exists(ofp):
                    ofn = find_available_filename(target_dir, row["original_filename"])
                    ofp = os.path.join(target_dir, ofn)
                else:
                    ofn = row["original_filename"]
                if not tp or not os.path.exists(tp):
                    continue
                try:
                    os.rename(tp, ofp)
                except Exception:
                    continue
                _ext = Path(ofn).suffix.lower()
                _mt = "video" if _ext in VIDEO_EXTENSIONS else ("gif" if _ext == ".gif" else "image")
                _ch = compute_content_hash(ofp) if _ext not in VIDEO_EXTENSIONS else ""
                cur = db.execute(
                    "INSERT INTO images (filename,folder,filepath,width,height,file_date,search_text,media_type,content_hash) "
                    "VALUES (?,?,?,?,?,?,?,?,?)",
                    (ofn, row["original_folder"], ofp, row["width"], row["height"],
                     row["file_date"], row["search_text"], _mt, _ch),
                )
                new_id = cur.lastrowid
                if _ch:
                    db.execute(
                        "UPDATE image_metadata SET image_id=? WHERE content_hash=? AND image_id IS NULL",
                        (new_id, _ch),
                    )
                try:
                    chars = json.loads(row["characters_json"])
                except Exception:
                    chars = []
                for pos, cn in enumerate(chars):
                    db.execute("INSERT OR IGNORE INTO characters (name) VALUES (?)", (cn,))
                    cr = db.execute("SELECT id FROM characters WHERE name=? COLLATE NOCASE", (cn,)).fetchone()
                    if cr:
                        db.execute(
                            "INSERT OR IGNORE INTO image_characters (image_id,character_id,position) VALUES (?,?,?)",
                            (new_id, cr["id"], pos),
                        )
                db.execute("DELETE FROM trash WHERE id=?", (tid,))
                restored += 1
            db.commit()
            return {"ok": True, "restored": restored}
        finally:
            db.close()

    @app.post("/studio/gallery/images/bulk-rename")
    async def gallery_bulk_rename(request: Request):
        data = await request.json()
        ids = data.get("ids", [])
        base_name = data.get("base_name", "").strip()
        continue_numbering = data.get("continue_numbering", True)
        start_number = data.get("start_number")  # explicit override — wins over continue_numbering if set
        if start_number is not None:
            try:
                start_number = int(start_number)
                if start_number < 1:
                    start_number = 1
            except (TypeError, ValueError):
                start_number = None
        if not base_name or not ids:
            return JSONResponse({"error": "Missing data"}, status_code=400)
        db = _get_db()
        try:
            iw = get_ignore_words(db)
            renamed = 0
            old_names = []

            if len(ids) == 1:
                row = db.execute("SELECT * FROM images WHERE id=?", (ids[0],)).fetchone()
                if row:
                    ext = Path(row["filepath"]).suffix
                    if start_number is not None:
                        new_fn = f"{base_name} ({start_number}){ext}" if start_number > 1 else f"{base_name}{ext}"
                    elif continue_numbering:
                        next_n = find_next_global_number(db, base_name, exclude_ids=ids)
                        new_fn = f"{base_name} ({next_n}){ext}" if next_n > 1 else f"{base_name}{ext}"
                    else:
                        new_fn = f"{base_name}{ext}"
                    old_fp = row["filepath"]
                    new_fp = os.path.join(os.path.dirname(old_fp), new_fn)
                    if os.path.exists(new_fp) and new_fp != old_fp:
                        new_fn = find_available_filename(os.path.dirname(old_fp), new_fn)
                        new_fp = os.path.join(os.path.dirname(old_fp), new_fn)
                    try:
                        suppress_path(old_fp)
                        suppress_path(new_fp)
                        os.rename(old_fp, new_fp)
                        old_names.append({"id": ids[0], "old_filename": row["filename"]})
                        db.execute("UPDATE images SET filename=?, filepath=? WHERE id=?", (new_fn, new_fp, ids[0]))
                        chars = parse_characters_from_filename(new_fn, iw)
                        db.execute("DELETE FROM image_characters WHERE image_id=?", (ids[0],))
                        for pos, cn in enumerate(chars):
                            db.execute("INSERT OR IGNORE INTO characters (name) VALUES (?)", (cn,))
                            cr = db.execute("SELECT id FROM characters WHERE name=? COLLATE NOCASE", (cn,)).fetchone()
                            if cr:
                                db.execute(
                                    "INSERT OR IGNORE INTO image_characters (image_id,character_id,position) VALUES (?,?,?)",
                                    (ids[0], cr["id"], pos),
                                )
                        renamed = 1
                    except Exception:
                        pass
            else:
                if start_number is not None:
                    start_n = start_number
                else:
                    start_n = find_next_global_number(db, base_name, exclude_ids=ids) if continue_numbering else 1
                for i, img_id in enumerate(ids):
                    row = db.execute("SELECT * FROM images WHERE id=?", (img_id,)).fetchone()
                    if not row:
                        continue
                    ext = Path(row["filepath"]).suffix
                    n = start_n + i
                    new_fn = f"{base_name} ({n}){ext}"
                    old_fp = row["filepath"]
                    new_fp = os.path.join(os.path.dirname(old_fp), new_fn)
                    if os.path.exists(new_fp) and new_fp != old_fp:
                        new_fn = find_available_filename(os.path.dirname(old_fp), new_fn)
                        new_fp = os.path.join(os.path.dirname(old_fp), new_fn)
                    try:
                        suppress_path(old_fp)
                        suppress_path(new_fp)
                        os.rename(old_fp, new_fp)
                    except Exception:
                        continue
                    old_names.append({"id": img_id, "old_filename": row["filename"]})
                    db.execute("UPDATE images SET filename=?, filepath=? WHERE id=?", (new_fn, new_fp, img_id))
                    chars = parse_characters_from_filename(new_fn, iw)
                    db.execute("DELETE FROM image_characters WHERE image_id=?", (img_id,))
                    for pos, cn in enumerate(chars):
                        db.execute("INSERT OR IGNORE INTO characters (name) VALUES (?)", (cn,))
                        cr = db.execute("SELECT id FROM characters WHERE name=? COLLATE NOCASE", (cn,)).fetchone()
                        if cr:
                            db.execute(
                                "INSERT OR IGNORE INTO image_characters (image_id,character_id,position) VALUES (?,?,?)",
                                (img_id, cr["id"], pos),
                            )
                    renamed += 1

            db.execute(
                "DELETE FROM characters WHERE id NOT IN "
                "(SELECT DISTINCT character_id FROM image_characters)"
            )
            db.commit()
            return {"ok": True, "renamed": renamed, "old_names": old_names}
        finally:
            db.close()

    @app.post("/studio/gallery/images/bulk-move")
    async def gallery_bulk_move(request: Request):
        data = await request.json()
        ids = data.get("ids", [])
        target_folder = data.get("folder", "").strip()
        if not target_folder or not ids:
            return JSONResponse({"error": "Missing data"}, status_code=400)
        db = _get_db()
        try:
            target_path = _resolve_display_folder(db, target_folder)
            if not target_path or not os.path.isdir(target_path):
                return JSONResponse({"error": "Target folder not found"}, status_code=404)
            scan_roots = db.execute("SELECT path FROM scan_folders").fetchall()
            moved = 0
            for img_id in ids:
                row = db.execute("SELECT * FROM images WHERE id=?", (img_id,)).fetchone()
                if not row:
                    continue
                old_fp = row["filepath"]
                new_fp = os.path.join(target_path, row["filename"])
                if os.path.exists(new_fp) and new_fp != old_fp:
                    continue
                try:
                    suppress_path(old_fp)
                    suppress_path(new_fp)
                    os.rename(old_fp, new_fp)
                except Exception:
                    continue
                display = target_folder
                for sf in scan_roots:
                    root = sf["path"]
                    if new_fp.startswith(root + os.sep) or new_fp.startswith(root + "/"):
                        rel = os.path.relpath(os.path.dirname(new_fp), root)
                        display = Path(root).name + ("\\" + rel if rel != "." else "")
                        break
                db.execute("UPDATE images SET filepath=?, folder=? WHERE id=?", (new_fp, display, img_id))
                moved += 1
            db.commit()
            return {"ok": True, "moved": moved}
        finally:
            db.close()

    @app.post("/studio/gallery/images/bulk-copy")
    async def gallery_bulk_copy(request: Request):
        """Copy files to a target folder — duplicates on disk, adds new DB rows,
        carries over tags from the originals."""
        data = await request.json()
        ids = data.get("ids", [])
        target_folder = data.get("folder", "").strip()
        if not target_folder or not ids:
            return JSONResponse({"error": "Missing data"}, status_code=400)
        db = _get_db()
        try:
            target_path = _resolve_display_folder(db, target_folder)
            if not target_path or not os.path.isdir(target_path):
                return JSONResponse({"error": "Target folder not found"}, status_code=404)
            scan_roots = db.execute("SELECT path FROM scan_folders").fetchall()
            copied = 0
            new_ids = []
            import shutil as _shutil
            for img_id in ids:
                row = db.execute("SELECT * FROM images WHERE id=?", (img_id,)).fetchone()
                if not row:
                    continue
                src_fp = row["filepath"]
                if not os.path.isfile(src_fp):
                    continue
                new_fn = find_available_filename(target_path, row["filename"])
                new_fp = os.path.join(target_path, new_fn)
                try:
                    suppress_path(new_fp)
                    _shutil.copy2(src_fp, new_fp)
                except Exception:
                    continue
                # Determine display folder for the new row
                display = target_folder
                for sf in scan_roots:
                    root = sf["path"]
                    if new_fp.startswith(root + os.sep) or new_fp.startswith(root + "/"):
                        rel = os.path.relpath(os.path.dirname(new_fp), root)
                        display = Path(root).name + ("\\" + rel if rel != "." else "")
                        break
                try:
                    mtime = int(os.path.getmtime(new_fp))
                except Exception:
                    mtime = row["file_date"] if "file_date" in row.keys() else 0
                # Preserve media_type, search_text, and phash from the source row
                mt = row["media_type"] if "media_type" in row.keys() and row["media_type"] else "image"
                st = row["search_text"] if "search_text" in row.keys() else ""
                ph = row["phash"] if "phash" in row.keys() else ""
                ch = row["content_hash"] if "content_hash" in row.keys() else ""
                cur = db.execute(
                    "INSERT INTO images "
                    "(filename,folder,filepath,width,height,file_date,search_text,media_type,phash,content_hash) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (new_fn, display, new_fp, row["width"], row["height"],
                     mtime, st, mt, ph, ch),
                )
                new_img_id = cur.lastrowid
                new_ids.append(new_img_id)
                # Link metadata by content_hash for the new copy
                if ch:
                    db.execute(
                        "UPDATE image_metadata SET image_id=? WHERE content_hash=? AND image_id IS NULL",
                        (new_img_id, ch),
                    )
                # Carry over tag links
                char_rows = db.execute(
                    "SELECT character_id, position FROM image_characters WHERE image_id=?",
                    (img_id,),
                ).fetchall()
                for cr in char_rows:
                    db.execute(
                        "INSERT OR IGNORE INTO image_characters "
                        "(image_id,character_id,position) VALUES (?,?,?)",
                        (new_img_id, cr["character_id"], cr["position"]),
                    )
            db.commit()
            return {"ok": True, "copied": copied + len(new_ids), "new_ids": new_ids}
        finally:
            db.close()

    @app.post("/studio/gallery/images/tag-info")
    async def gallery_tag_info(request: Request):
        """Return tag counts across a set of image ids. Each tag has a count
        of how many of the provided ids have that tag (for tri-state UI)."""
        data = await request.json()
        ids = data.get("ids", [])
        if not ids:
            return {"tags": [], "total": 0}
        db = _get_db()
        try:
            placeholders = ",".join("?" * len(ids))
            rows = db.execute(
                f"SELECT c.name AS name, COUNT(DISTINCT ic.image_id) AS cnt "
                f"FROM characters c JOIN image_characters ic ON c.id=ic.character_id "
                f"WHERE ic.image_id IN ({placeholders}) "
                f"GROUP BY c.name ORDER BY cnt DESC, c.name",
                ids,
            ).fetchall()
            return {
                "tags": [{"name": r["name"], "count": r["cnt"]} for r in rows],
                "total": len(ids),
            }
        finally:
            db.close()

    @app.post("/studio/gallery/images/bulk-add-tag")
    async def gallery_bulk_add_tag(request: Request):
        data = await request.json()
        ids = data.get("ids", [])
        tag = data.get("tag", "").strip().title()
        if not ids or not tag:
            return JSONResponse({"error": "Missing ids or tag"}, status_code=400)
        db = _get_db()
        try:
            db.execute("INSERT OR IGNORE INTO characters (name) VALUES (?)", (tag,))
            cr = db.execute(
                "SELECT id FROM characters WHERE name=? COLLATE NOCASE", (tag,)
            ).fetchone()
            if not cr:
                return JSONResponse({"error": "Tag insert failed"}, status_code=500)
            added = 0
            for img_id in ids:
                row = db.execute("SELECT id FROM images WHERE id=?", (img_id,)).fetchone()
                if not row:
                    continue
                # Skip if already tagged
                ex = db.execute(
                    "SELECT 1 FROM image_characters WHERE image_id=? AND character_id=?",
                    (img_id, cr["id"]),
                ).fetchone()
                if ex:
                    continue
                maxp = db.execute(
                    "SELECT MAX(position) AS mp FROM image_characters WHERE image_id=?",
                    (img_id,),
                ).fetchone()
                pos = (maxp["mp"] or 0) + 1
                db.execute(
                    "INSERT INTO image_characters (image_id,character_id,position) "
                    "VALUES (?,?,?)",
                    (img_id, cr["id"], pos),
                )
                added += 1
            db.commit()
            return {"ok": True, "added": added, "tag": tag}
        finally:
            db.close()

    @app.post("/studio/gallery/images/bulk-remove-tag")
    async def gallery_bulk_remove_tag(request: Request):
        data = await request.json()
        ids = data.get("ids", [])
        tag = data.get("tag", "").strip()
        if not ids or not tag:
            return JSONResponse({"error": "Missing ids or tag"}, status_code=400)
        db = _get_db()
        try:
            cr = db.execute(
                "SELECT id FROM characters WHERE name=? COLLATE NOCASE", (tag,)
            ).fetchone()
            if not cr:
                return JSONResponse({"error": "Tag not found"}, status_code=404)
            protected = 0
            removed = 0
            for img_id in ids:
                chars = db.execute(
                    "SELECT character_id FROM image_characters WHERE image_id=?",
                    (img_id,),
                ).fetchall()
                if len(chars) <= 1:
                    protected += 1
                    continue
                res = db.execute(
                    "DELETE FROM image_characters WHERE image_id=? AND character_id=?",
                    (img_id, cr["id"]),
                )
                if res.rowcount > 0:
                    removed += 1
            # Clean orphaned characters
            db.execute(
                "DELETE FROM characters WHERE id NOT IN "
                "(SELECT DISTINCT character_id FROM image_characters)"
            )
            db.commit()
            return {
                "ok": True, "removed": removed,
                "protected": protected, "tag": tag,
            }
        finally:
            db.close()

    @app.post("/studio/gallery/next-number")
    async def gallery_next_number(request: Request):
        data = await request.json()
        base_name = data.get("base_name", "").strip()
        exclude_ids = data.get("exclude_ids", [])
        if not base_name:
            return JSONResponse({"error": "No name"}, status_code=400)
        db = _get_db()
        try:
            n = find_next_global_number(db, base_name, exclude_ids=exclude_ids)
            return {"next": n, "base_name": base_name}
        finally:
            db.close()

    # ==================================================================
    # EXPLORER / FILE OPEN
    # ==================================================================

    @app.post("/studio/gallery/image/{image_id}/open-explorer")
    async def gallery_open_explorer(image_id: int):
        db = _get_db()
        try:
            row = db.execute("SELECT filepath FROM images WHERE id=?", (image_id,)).fetchone()
            if not row:
                return JSONResponse({"error": "Not found"}, status_code=404)
            fp = row["filepath"]
            if not os.path.exists(fp):
                return JSONResponse({"error": "File not found on disk"}, status_code=404)
            s = platform.system()
            if s == "Windows":
                subprocess.Popen(f'explorer /select,"{fp}"', shell=True)
            elif s == "Darwin":
                subprocess.Popen(["open", "-R", fp])
            else:
                subprocess.Popen(["xdg-open", os.path.dirname(fp)])
            return {"ok": True}
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)
        finally:
            db.close()

    @app.post("/studio/gallery/image/{image_id}/open-file")
    async def gallery_open_file(image_id: int):
        db = _get_db()
        try:
            row = db.execute("SELECT filepath FROM images WHERE id=?", (image_id,)).fetchone()
            if not row:
                return JSONResponse({"error": "Not found"}, status_code=404)
            fp = row["filepath"]
            if not os.path.exists(fp):
                return JSONResponse({"error": "File not found on disk"}, status_code=404)
            s = platform.system()
            if s == "Windows":
                os.startfile(fp)
            elif s == "Darwin":
                subprocess.Popen(["open", fp])
            else:
                subprocess.Popen(["xdg-open", fp])
            return {"ok": True}
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)
        finally:
            db.close()

    # ==================================================================
    # STATS & IGNORE WORDS
    # ==================================================================

    @app.get("/studio/gallery/stats")
    async def gallery_stats():
        db = _get_db()
        try:
            ti = db.execute("SELECT COUNT(*) FROM images").fetchone()[0]
            tc = db.execute("SELECT COUNT(*) FROM characters").fetchone()[0]
            tf = db.execute("SELECT COUNT(DISTINCT folder) FROM images").fetchone()[0]
            top_c = db.execute(
                "SELECT c.name,COUNT(ic.image_id) as count FROM characters c "
                "JOIN image_characters ic ON c.id=ic.character_id "
                "GROUP BY c.id ORDER BY count DESC LIMIT 20"
            ).fetchall()
            top_f = db.execute(
                "SELECT folder,COUNT(*) as count FROM images "
                "GROUP BY folder ORDER BY count DESC LIMIT 20"
            ).fetchall()
            cdist = db.execute(
                "SELECT char_count,COUNT(*) as image_count FROM "
                "(SELECT i.id,COUNT(ic.character_id) as char_count FROM images i "
                "LEFT JOIN image_characters ic ON i.id=ic.image_id GROUP BY i.id) "
                "GROUP BY char_count ORDER BY char_count"
            ).fetchall()
            return {
                "total_images": ti, "total_characters": tc, "total_folders": tf,
                "top_characters": [dict(r) for r in top_c],
                "top_folders": [dict(r) for r in top_f],
                "char_distribution": [dict(r) for r in cdist],
            }
        finally:
            db.close()

    @app.get("/studio/gallery/ignore-words")
    async def gallery_get_ignore_words():
        db = _get_db()
        try:
            return [r["word"] for r in db.execute("SELECT word FROM ignore_words ORDER BY word").fetchall()]
        finally:
            db.close()

    @app.post("/studio/gallery/ignore-words")
    async def gallery_add_ignore_word(request: Request):
        data = await request.json()
        w = data.get("word", "").strip()
        if not w:
            return JSONResponse({"error": "No word"}, status_code=400)
        db = _get_db()
        try:
            db.execute("INSERT OR IGNORE INTO ignore_words (word) VALUES (?)", (w.lower(),))
            db.commit()
            return {"ok": True}
        finally:
            db.close()

    @app.delete("/studio/gallery/ignore-words")
    async def gallery_delete_ignore_word(request: Request):
        data = await request.json()
        w = data.get("word", "").strip()
        if not w:
            return JSONResponse({"error": "No word"}, status_code=400)
        db = _get_db()
        try:
            db.execute("DELETE FROM ignore_words WHERE word=? COLLATE NOCASE", (w,))
            db.commit()
            return {"ok": True}
        finally:
            db.close()

    # ==================================================================
    # THUMBNAILS & FULL IMAGES
    # ==================================================================

    @app.get("/studio/gallery/thumb/{image_id}")
    async def gallery_serve_thumbnail(image_id: int, request: Request):
        db = _get_db()
        try:
            row = db.execute("SELECT filepath,filename FROM images WHERE id=?", (image_id,)).fetchone()
            if not row:
                return Response("Not found", status_code=404)
            fp = row["filepath"]
            ext = Path(row["filename"]).suffix.lower()
            try:
                mt = os.path.getmtime(fp)
                etag = hashlib.md5(f"{VERSION}:{image_id}:{fp}:{mt}".encode()).hexdigest()
            except Exception:
                etag = hashlib.md5(f"{VERSION}:{image_id}:{fp}".encode()).hexdigest()

            if request.headers.get("if-none-match") == etag:
                return Response(status_code=304)

            if ext in VIDEO_EXTENSIONS:
                tb = generate_video_thumbnail(fp)
                if tb:
                    return Response(
                        content=tb, media_type="image/jpeg",
                        headers={"Cache-Control": "public, max-age=604800, immutable", "ETag": etag},
                    )
                return Response(
                    content=VIDEO_THUMB_SVG, media_type="image/svg+xml",
                    headers={"Cache-Control": "no-cache"},
                )

            tb = generate_thumbnail_bytes(fp)
            if tb:
                return Response(
                    content=tb, media_type="image/webp",
                    headers={"Cache-Control": "public, max-age=604800, immutable", "ETag": etag},
                )
            return FileResponse(fp)
        finally:
            db.close()

    @app.get("/studio/gallery/full/{image_id}")
    async def gallery_serve_full(image_id: int):
        db = _get_db()
        try:
            row = db.execute("SELECT filepath,filename FROM images WHERE id=?", (image_id,)).fetchone()
            if not row:
                return Response("Not found", status_code=404)
            # Content-Disposition with the original filename so drag-out
            # targets name the file correctly regardless of the URL path
            # (which is just the numeric id). Uses RFC 5987 filename*=
            # encoding to handle non-ASCII names. Only filename gets
            # percent-encoded; quotes in the plain filename fall back to
            # a safe ASCII variant.
            from urllib.parse import quote
            fname = row["filename"] or f"image_{image_id}"
            ascii_safe = fname.encode("ascii", "replace").decode("ascii").replace('"', "_")
            cd = (
                f'attachment; filename="{ascii_safe}"; '
                f"filename*=UTF-8''{quote(fname, safe='')}"
            )
            return FileResponse(row["filepath"], headers={"Content-Disposition": cd})
        finally:
            db.close()

    # ==================================================================
    # METADATA STRIP
    # ==================================================================

    @app.post("/studio/gallery/image/{image_id}/remove-metadata")
    async def gallery_remove_metadata(image_id: int):
        db = _get_db()
        try:
            row = db.execute(
                "SELECT * FROM images WHERE id=?", (image_id,)
            ).fetchone()
            if not row:
                return JSONResponse({"error": "Not found"}, status_code=404)
            fp = row["filepath"]
            suppress_path(fp)
            try:
                ok, msg = strip_metadata_from_file(fp)
                if not ok:
                    return JSONResponse({"error": msg}, status_code=400)
                # Re-index search_text + phash so stale data doesn't linger.
                # IMPORTANT: we do NOT touch image_metadata — Studio's DB-stored
                # generation metadata is preserved so the detail panel still shows
                # prompt/seed/etc. via the DB fallback after stripping.
                # content_hash is recomputed for consistency but should be identical
                # (pixel data unchanged by metadata strip).
                try:
                    new_search = extract_search_text(fp)
                    new_hash = compute_phash(fp)
                    new_ch = compute_content_hash(fp)
                    db.execute(
                        "UPDATE images SET search_text=?, phash=?, content_hash=? WHERE id=?",
                        (new_search, new_hash, new_ch, image_id),
                    )
                    db.commit()
                except Exception:
                    pass
            finally:
                # Let the watcher see this path again now that we're done
                with _watcher_suppress_lock:
                    _watcher_suppress.discard(os.path.normpath(fp))
            return {"ok": True}
        finally:
            db.close()

    @app.post("/studio/gallery/images/bulk-remove-metadata")
    async def gallery_bulk_remove_metadata(request: Request):
        data = await request.json()
        ids = data.get("ids", [])
        if not ids:
            return JSONResponse({"error": "No ids"}, status_code=400)
        db = _get_db()
        try:
            stripped = 0
            skipped = 0
            errors = []
            touched_paths = []
            for img_id in ids:
                row = db.execute(
                    "SELECT * FROM images WHERE id=?", (img_id,)
                ).fetchone()
                if not row:
                    skipped += 1
                    continue
                fp = row["filepath"]
                suppress_path(fp)
                touched_paths.append(fp)
                ok, msg = strip_metadata_from_file(fp)
                if not ok:
                    skipped += 1
                    if len(errors) < 5:
                        errors.append(f"{row['filename']}: {msg}")
                    continue
                try:
                    new_search = extract_search_text(fp)
                    new_hash = compute_phash(fp)
                    new_ch = compute_content_hash(fp)
                    db.execute(
                        "UPDATE images SET search_text=?, phash=?, content_hash=? WHERE id=?",
                        (new_search, new_hash, new_ch, img_id),
                    )
                except Exception:
                    pass
                stripped += 1
            db.commit()
            # Release watcher suppression for all touched paths
            with _watcher_suppress_lock:
                for p in touched_paths:
                    _watcher_suppress.discard(os.path.normpath(p))
            return {
                "ok": True, "stripped": stripped,
                "skipped": skipped, "errors": errors,
            }
        finally:
            db.close()

    # ==================================================================
    # FORMAT CONVERSION
    # ==================================================================

    @app.post("/studio/gallery/image/{image_id}/convert")
    async def gallery_convert_single(image_id: int, request: Request):
        data = await request.json()
        data["ids"] = [image_id]
        # Reuse bulk logic
        return await _do_bulk_convert(data)

    @app.post("/studio/gallery/images/bulk-convert")
    async def gallery_bulk_convert(request: Request):
        data = await request.json()
        return await _do_bulk_convert(data)

    async def _do_bulk_convert(data):
        ids = data.get("ids", [])
        if not ids:
            return JSONResponse({"error": "No ids"}, status_code=400)
        target_format = (data.get("target_format") or "").lower().strip()
        if target_format not in TARGET_FORMATS:
            return JSONResponse({"error": "target_format must be png, jpeg, or webp"}, status_code=400)
        quality = int(data.get("quality", 90))
        lossless = bool(data.get("lossless", False))
        alpha_handling = data.get("alpha_handling", "skip")
        if alpha_handling not in ("skip", "white", "black"):
            alpha_handling = "skip"
        keep_original = bool(data.get("keep_original", False))
        strip_md = bool(data.get("strip_metadata", False))

        target_ext = TARGET_FORMATS[target_format]["ext"]
        db = _get_db()
        try:
            converted = 0
            skipped = 0
            errors = []
            new_ids = []
            touched_paths = []
            scan_roots = db.execute("SELECT path FROM scan_folders").fetchall()
            import shutil as _shutil

            for img_id in ids:
                row = db.execute("SELECT * FROM images WHERE id=?", (img_id,)).fetchone()
                if not row:
                    skipped += 1
                    continue
                src_fp = row["filepath"]
                if not os.path.isfile(src_fp):
                    skipped += 1
                    if len(errors) < 5:
                        errors.append(f"{row['filename']}: file not found")
                    continue
                src_ext = Path(src_fp).suffix.lower()

                # Skip if already in target format (unless lossless re-encode requested)
                same_format = (src_ext == target_ext) or (src_ext == ".jpeg" and target_ext == ".jpg") or (src_ext == ".jpg" and target_ext == ".jpeg")
                if same_format and not lossless:
                    skipped += 1
                    continue

                # Determine destination path
                src_dir = os.path.dirname(src_fp)
                src_base = Path(row["filename"]).stem
                if keep_original:
                    # Pick a non-colliding name in same dir with new ext
                    desired = src_base + target_ext
                    new_fn = find_available_filename(src_dir, desired)
                    dst_fp = os.path.join(src_dir, new_fn)
                else:
                    # Replace in place: write new file with new ext, delete old
                    new_fn = src_base + target_ext
                    # Avoid collision with an unrelated file that already has target ext
                    if os.path.exists(os.path.join(src_dir, new_fn)) and new_fn.lower() != row["filename"].lower():
                        new_fn = find_available_filename(src_dir, new_fn)
                    dst_fp = os.path.join(src_dir, new_fn)

                suppress_path(dst_fp)
                touched_paths.append(dst_fp)
                if not keep_original and dst_fp != src_fp:
                    suppress_path(src_fp)
                    touched_paths.append(src_fp)

                ok, msg = convert_image_file(
                    src_fp, dst_fp,
                    target_format=target_format,
                    quality=quality,
                    lossless=lossless,
                    alpha_handling=alpha_handling,
                    strip_metadata=strip_md,
                )
                if not ok:
                    skipped += 1
                    if len(errors) < 5:
                        errors.append(f"{row['filename']}: {msg}")
                    # Cleanup any partial dst if it somehow exists
                    if keep_original and os.path.exists(dst_fp):
                        try:
                            os.remove(dst_fp)
                        except Exception:
                            pass
                    continue

                # Compute display folder (same as source since we stayed in same dir)
                display_folder = row["folder"]

                try:
                    new_mtime = int(os.path.getmtime(dst_fp))
                except Exception:
                    new_mtime = row["file_date"] if "file_date" in row.keys() else 0

                if keep_original:
                    # Add a new DB row, carry tags from source
                    try:
                        new_search = extract_search_text(dst_fp)
                    except Exception:
                        new_search = ""
                    try:
                        new_hash = compute_phash(dst_fp)
                    except Exception:
                        new_hash = ""
                    try:
                        new_content_hash = compute_content_hash(dst_fp)
                    except Exception:
                        new_content_hash = ""
                    try:
                        with Image.open(dst_fp) as _im:
                            new_w, new_h = _im.size
                    except Exception:
                        new_w = row["width"]
                        new_h = row["height"]
                    cur = db.execute(
                        "INSERT INTO images "
                        "(filename,folder,filepath,width,height,file_date,search_text,media_type,phash,content_hash) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (new_fn, display_folder, dst_fp, new_w, new_h,
                         new_mtime, new_search, "image", new_hash, new_content_hash),
                    )
                    new_img_id = cur.lastrowid
                    new_ids.append(new_img_id)
                    # Link metadata by content_hash
                    if new_content_hash:
                        db.execute(
                            "UPDATE image_metadata SET image_id=? WHERE content_hash=? AND image_id IS NULL",
                            (new_img_id, new_content_hash),
                        )
                    char_rows = db.execute(
                        "SELECT character_id, position FROM image_characters WHERE image_id=?",
                        (img_id,),
                    ).fetchall()
                    for cr in char_rows:
                        db.execute(
                            "INSERT OR IGNORE INTO image_characters "
                            "(image_id,character_id,position) VALUES (?,?,?)",
                            (new_img_id, cr["character_id"], cr["position"]),
                        )
                else:
                    # Replace in place: delete original (if different path), update row
                    if dst_fp != src_fp and os.path.exists(src_fp):
                        try:
                            os.remove(src_fp)
                        except Exception as e:
                            # Can't remove original — leave new file, report
                            if len(errors) < 5:
                                errors.append(f"{row['filename']}: converted but could not remove original ({e})")
                    try:
                        new_search = extract_search_text(dst_fp)
                    except Exception:
                        new_search = ""
                    try:
                        new_hash = compute_phash(dst_fp)
                    except Exception:
                        new_hash = ""
                    try:
                        new_content_hash = compute_content_hash(dst_fp)
                    except Exception:
                        new_content_hash = ""
                    try:
                        with Image.open(dst_fp) as _im:
                            new_w, new_h = _im.size
                    except Exception:
                        new_w = row["width"]
                        new_h = row["height"]
                    db.execute(
                        "UPDATE images SET filename=?, filepath=?, width=?, height=?, "
                        "search_text=?, phash=?, content_hash=? WHERE id=?",
                        (new_fn, dst_fp, new_w, new_h, new_search, new_hash, new_content_hash, img_id),
                    )
                converted += 1

            db.commit()
            with _watcher_suppress_lock:
                for p in touched_paths:
                    _watcher_suppress.discard(os.path.normpath(p))
            return {
                "ok": True,
                "converted": converted,
                "skipped": skipped,
                "new_ids": new_ids,
                "errors": errors,
                "target_format": target_format,
            }
        finally:
            db.close()

    # ==================================================================
    # DUPLICATE DETECTION (pHash)
    # ==================================================================

    @app.get("/studio/gallery/hash-status")
    async def gallery_hash_status():
        db = _get_db()
        try:
            # Count only images, never videos — video perceptual hashing is not supported
            total = db.execute(
                "SELECT COUNT(*) FROM images WHERE media_type != 'video'"
            ).fetchone()[0]
            hashed = db.execute(
                "SELECT COUNT(*) FROM images WHERE phash IS NOT NULL AND phash != ''"
            ).fetchone()[0]
            return {
                "total": total, "hashed": hashed,
                "available": HAS_IMAGEHASH,
                "hashing": _hash_progress.get("active", False),
                "hash_current": _hash_progress.get("current", 0),
                "hash_total": _hash_progress.get("total", 0),
            }
        finally:
            db.close()

    @app.post("/studio/gallery/compute-hashes")
    async def gallery_compute_hashes():
        if not HAS_IMAGEHASH:
            return JSONResponse(
                {"error": "imagehash not installed"}, status_code=400
            )
        if _hash_progress["active"]:
            return {"ok": True, "status": "already running"}

        def do_hash():
            _hash_progress["active"] = True
            try:
                db = _get_db()
                rows = db.execute(
                    "SELECT id,filepath FROM images "
                    "WHERE (phash IS NULL OR phash='') AND media_type != 'video'"
                ).fetchall()
                _hash_progress["total"] = len(rows)
                _hash_progress["current"] = 0
                for i, r in enumerate(rows):
                    _hash_progress["current"] = i + 1
                    try:
                        ph = compute_phash(r["filepath"])
                        if ph:
                            db.execute(
                                "UPDATE images SET phash=? WHERE id=?",
                                (ph, r["id"]),
                            )
                        if (i + 1) % 50 == 0:
                            db.commit()
                    except Exception:
                        pass
                db.commit()
                db.close()
                sse_notify("hashes_updated", {"count": _hash_progress["total"]})
            except Exception as e:
                print(f"{TAG} Hashing error: {e}")
            _hash_progress["active"] = False

        threading.Thread(target=do_hash, daemon=True).start()
        return {"ok": True, "status": "started"}

    @app.get("/studio/gallery/duplicates")
    async def gallery_duplicates(threshold: int = 12, folder: str = ""):
        if not HAS_IMAGEHASH:
            return JSONResponse(
                {"error": "imagehash not installed"}, status_code=400
            )
        # Safety cap: 256-bit hash, cap at 25% (= 64 bits) — trackimage's v10.5.5 limit
        if threshold < 0:
            threshold = 0
        if threshold > 64:
            threshold = 64
        db = _get_db()
        try:
            q = (
                "SELECT id,filename,folder,filepath,phash,media_type FROM images "
                "WHERE phash IS NOT NULL AND phash != ''"
            )
            params = []
            if folder:
                q += " AND folder=?"
                params.append(folder)
            rows = db.execute(q, params).fetchall()

            items = []
            for r in rows:
                d = dict(r)
                d["fphash"] = get_filepath_hash(d["filepath"])
                items.append(d)

            # Pre-convert hex hashes to integers for fast XOR comparison
            int_hashes = []
            for item in items:
                try:
                    int_hashes.append(int(item["phash"], 16))
                except Exception:
                    int_hashes.append(None)

            n = len(items)
            used = [False] * n
            groups = []

            # Prefer int.bit_count() (Python 3.10+); fallback to bin().count
            try:
                (0).bit_count()
                def popcount(x): return x.bit_count()
            except AttributeError:
                def popcount(x): return bin(x).count('1')

            for i in range(n):
                if used[i] or int_hashes[i] is None:
                    continue
                group = [items[i]]
                used[i] = True
                hi = int_hashes[i]
                for j in range(i + 1, n):
                    if used[j] or int_hashes[j] is None:
                        continue
                    if popcount(hi ^ int_hashes[j]) <= threshold:
                        group.append(items[j])
                        used[j] = True
                if len(group) > 1:
                    groups.append(group)

            groups.sort(key=lambda g: len(g), reverse=True)

            # Strip phash from response payload — the hex strings are not useful
            # to the frontend and just inflate the payload.
            for g in groups:
                for item in g:
                    item.pop("phash", None)

            return {
                "groups": groups,
                "total_groups": len(groups),
                "total_duplicates": sum(len(g) for g in groups),
                "hashed": n,
            }
        finally:
            db.close()

    print(f"{TAG} Gallery routes registered")

    # Start filesystem watcher for auto-sync
    if HAS_WATCHDOG:
        print(f"{TAG} watchdog available — starting auto-sync watcher")
        threading.Thread(target=start_watcher, daemon=True).start()
    else:
        print(f"{TAG} watchdog not installed — auto-sync disabled (pip install watchdog)")
