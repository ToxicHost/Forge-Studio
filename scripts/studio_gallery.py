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
                    is_video = ext in VIDEO_EXTENSIONS
                    if HAS_PILLOW and not is_video:
                        try:
                            with Image.open(filepath) as im:
                                w, h = im.size
                        except Exception:
                            pass
                        search = extract_search_text(filepath)
                    cur = db.execute(
                        "INSERT OR IGNORE INTO images "
                        "(filename,folder,filepath,width,height,file_date,search_text) "
                        "VALUES (?,?,?,?,?,?,?)",
                        (filename, display_folder, filepath, w, h, file_date, search),
                    )
                    iid = cur.lastrowid
                    if iid == 0:
                        continue
                    new_count += 1
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

# =========================================================================
# DATABASE
# =========================================================================

_db_path = None  # set in setup_gallery_routes


def _get_db():
    """Get a thread-local-ish connection. Fine for sync route handlers."""
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
                is_video = ext in VIDEO_EXTENSIONS
                if HAS_PILLOW and not is_video:
                    try:
                        with Image.open(filepath) as im:
                            w, h = im.size
                    except Exception:
                        pass
                    search = extract_search_text(filepath)

                cur = db.execute(
                    "INSERT OR IGNORE INTO images "
                    "(filename,folder,filepath,width,height,file_date,search_text) "
                    "VALUES (?,?,?,?,?,?,?)",
                    (filename, display_folder, filepath, w, h, file_date, search),
                )
                iid = cur.lastrowid
                if iid == 0:
                    continue
                total_new += 1
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
                    WHERE i.folder=? OR i.folder LIKE ?
                    GROUP BY c.id ORDER BY c.name COLLATE NOCASE ASC
                """, (folder, folder + "\\%")).fetchall()
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
            q = "SELECT DISTINCT i.id,i.filename,i.folder,i.filepath,i.width,i.height,i.file_date FROM images i"
            conds, params = [], []
            if character:
                q += " JOIN image_characters ic ON i.id=ic.image_id JOIN characters c ON ic.character_id=c.id"
                conds.append("c.name=? COLLATE NOCASE")
                params.append(character)
            if folder:
                conds.append("(i.folder=? OR i.folder LIKE ?)")
                params.extend([folder, folder + "\\%"])
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
                "SELECT DISTINCT i.id,i.filename,i.folder,i.filepath,i.width,i.height,i.file_date",
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
                images.append({
                    "id": r["id"], "filename": r["filename"], "folder": r["folder"],
                    "width": r["width"], "height": r["height"], "file_date": r["file_date"],
                    "fphash": get_filepath_hash(r["filepath"]),
                    "is_video": ext in VIDEO_EXTENSIONS,
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
            row = db.execute("SELECT filepath FROM images WHERE id=?", (image_id,)).fetchone()
            if not row:
                return JSONResponse({"error": "Not found"}, status_code=404)
            return extract_metadata(row["filepath"])
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
            cur = db.execute(
                "INSERT INTO images (filename,folder,filepath,width,height,file_date,search_text) "
                "VALUES (?,?,?,?,?,?,?)",
                (ofn, row["original_folder"], ofp, row["width"], row["height"],
                 row["file_date"], row["search_text"]),
            )
            new_id = cur.lastrowid
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
                cur = db.execute(
                    "INSERT INTO images (filename,folder,filepath,width,height,file_date,search_text) "
                    "VALUES (?,?,?,?,?,?,?)",
                    (ofn, row["original_folder"], ofp, row["width"], row["height"],
                     row["file_date"], row["search_text"]),
                )
                new_id = cur.lastrowid
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
                    if continue_numbering:
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
            row = db.execute("SELECT filepath FROM images WHERE id=?", (image_id,)).fetchone()
            if not row:
                return Response("Not found", status_code=404)
            return FileResponse(row["filepath"])
        finally:
            db.close()

    print(f"{TAG} Gallery routes registered")

    # Start filesystem watcher for auto-sync
    if HAS_WATCHDOG:
        print(f"{TAG} watchdog available — starting auto-sync watcher")
        threading.Thread(target=start_watcher, daemon=True).start()
    else:
        print(f"{TAG} watchdog not installed — auto-sync disabled (pip install watchdog)")
