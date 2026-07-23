"""
Forge Studio — Standalone API
by ToxicHost & Moritz

FastAPI routes for the standalone Studio UI. All routes register onto Forge's
existing FastAPI app via the on_app_started callback — no patching of webui.py
or any Forge source files required.

Users install the extension, launch Forge normally, open localhost:7860/studio.
The Gradio UI continues to work at the default URL. Both UIs share the same backend.

Replaces the old add_studio_api() function in studio_generation.py.
"""

import asyncio
import base64
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import traceback
import urllib.error
import urllib.request
import uuid
import zipfile

# Enable OpenCV's optional OpenEXR codec — used by /studio/export/exr.
# Must be set before cv2 is imported anywhere in the process.
os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")

from datetime import date, datetime
from pathlib import Path
from threading import Thread, RLock
from typing import Optional, List

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from PIL import Image

from modules import shared, sd_models, sd_samplers, sd_schedulers

TAG = "[Studio API]"
PERF = "[Studio Perf]"  # performance telemetry prefix (grep-friendly)

def _walk_follow(root):
    """Scanner walk that follows symlinked directories (see studio_walk)."""
    try:
        try:
            from studio_walk import walk_follow
        except ImportError:
            from scripts.studio_walk import walk_follow
    except Exception:
        return os.walk(root)
    return walk_follow(root)



# sRGB ICC profile bytes — built once at import. Passed to every PIL save
# (PNG / JPEG / WebP) so output files are explicitly tagged as sRGB instead
# of untagged, and served at /studio/srgb-icc for the PSD exporter.
#
# Built deterministically as a canonical "sRGB IEC61966-2.1" ICC v2.1
# profile rather than LCMS's runtime profile: cmsCreate_sRGBProfile()
# stamps whatever spec version the installed lcms2 implements (4.4 on
# recent builds) and uses v4-only tag types ('mluc' text, 'para' curves),
# which strict/legacy ICC parsers — certain Photoshop versions and asset
# tools — reject as a broken profile. A Pillow upgrade silently changed
# every output's embedded profile. The v2 build uses only the universally
# parsed v2 types (desc/text/XYZ /curv), the exact tag layout of the
# classic HP/IEC sRGB profile, and the same fixed-point colorimetry LCMS
# uses, so conversions against any engine's built-in sRGB are identity
# (verified: zero max channel delta in both directions).


def _build_srgb_v2_profile() -> bytes:
    import struct

    def s15f16(v):
        return int(round(v * 65536.0))

    def xyz_tag(x, y, z):
        return struct.pack(">4s4x3i", b"XYZ ", s15f16(x), s15f16(y), s15f16(z))

    def desc_tag(text):
        # textDescriptionType: ASCII + empty Unicode + empty ScriptCode
        ascii_bytes = text.encode("ascii") + b"\x00"
        return (struct.pack(">4s4xI", b"desc", len(ascii_bytes)) + ascii_bytes
                + struct.pack(">II", 0, 0)   # Unicode language code + count
                + struct.pack(">H", 0)       # ScriptCode code
                + b"\x00" * 68)              # ScriptCode count + 67-byte name

    def text_tag(text):
        return struct.pack(">4s4x", b"text") + text.encode("ascii") + b"\x00"

    def curv_tag(n=1024):
        # sRGB EOTF (IEC 61966-2-1 piecewise) as a u16 LUT — 'curv' is the
        # only curve type v2 parsers understand ('para' is v4-only).
        pts = []
        for i in range(n):
            x = i / (n - 1)
            y = x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4
            pts.append(min(65535, max(0, round(y * 65535.0))))
        return struct.pack(">4s4xI%dH" % n, b"curv", n, *pts)

    # D50-adapted (Bradford) sRGB primaries — the same fixed-point values
    # LCMS's built-in sRGB carries, so the swap changes no pixel anywhere.
    r = xyz_tag(0.436035, 0.222488, 0.013916)
    g = xyz_tag(0.385117, 0.716904, 0.097061)
    b = xyz_tag(0.143051, 0.060608, 0.713913)
    wtpt = xyz_tag(0.950455, 1.0, 1.089050)  # D65 media white (HP/IEC layout)
    desc = desc_tag("sRGB IEC61966-2.1")
    cprt = text_tag("Public domain, no copyright")
    trc = curv_tag()

    # rTRC/gTRC/bTRC share one curve blob (same offset), like the HP profile.
    tags = [(b"desc", desc), (b"cprt", cprt), (b"wtpt", wtpt),
            (b"rXYZ", r), (b"gXYZ", g), (b"bXYZ", b),
            (b"rTRC", trc), (b"gTRC", trc), (b"bTRC", trc)]

    offset = 128 + 4 + 12 * len(tags)
    placed = {}  # id(data) -> (offset, size)
    blobs = []
    entries = []
    for sig, data in tags:
        if id(data) not in placed:
            pad = (4 - offset % 4) % 4
            offset += pad
            blobs.append(b"\x00" * pad + data)
            placed[id(data)] = (offset, len(data))
            offset += len(data)
        o, s = placed[id(data)]
        entries.append(struct.pack(">4sII", sig, o, s))

    body = struct.pack(">I", len(tags)) + b"".join(entries) + b"".join(blobs)
    header = struct.pack(
        ">I4sI4s4s4s6H4s4sIIIQI3i I44x",
        128 + len(body),       # profile size
        b"\x00" * 4,           # preferred CMM (none)
        0x02100000,            # ICC version 2.1.0
        b"mntr",               # display device profile
        b"RGB ",               # data color space
        b"XYZ ",               # PCS
        2026, 1, 1, 0, 0, 0,   # creation date (fixed: deterministic bytes)
        b"acsp",               # magic
        b"\x00" * 4,           # platform (undefined)
        0, 0, 0, 0,            # flags, manufacturer, model, attributes
        0,                     # rendering intent: perceptual
        s15f16(0.9642), s15f16(1.0), s15f16(0.8249),  # PCS illuminant (D50)
        0,                     # creator
    )
    return header + body


try:
    _SRGB_ICC = _build_srgb_v2_profile()
    # Self-check: the profile must parse; otherwise fall back to LCMS.
    from PIL import ImageCms as _icc_check
    _icc_check.ImageCmsProfile(io.BytesIO(_SRGB_ICC))
except Exception as _icc_err:
    print(f"{TAG} v2 sRGB profile build failed ({_icc_err}); falling back to LCMS profile")
    try:
        from PIL.ImageCms import ImageCmsProfile, createProfile
        _SRGB_ICC = ImageCmsProfile(createProfile("sRGB")).tobytes()
    except Exception as _icc_err2:
        print(f"{TAG} sRGB ICC profile unavailable, saves will be untagged: {_icc_err2}")
        _SRGB_ICC = None


_NAT_SORT_RE = re.compile(r'(\d+)')


def _natural_sort_key(text):
    """Split text into string/int segments so v3 sorts before v10."""
    return [int(c) if c.isdigit() else c for c in _NAT_SORT_RE.split(str(text).lower())]


def _is_path_within_roots(resolved, allowed_roots) -> bool:
    """True if `resolved` lives under any allowed root.

    Uses Path.is_relative_to (Py3.9+; Forge Neo requires >=3.10) instead of a
    string startswith check, so a root of /forge does not also approve a
    sibling directory like /forge-evil.
    """
    try:
        resolved_path = Path(resolved).resolve()
    except Exception:
        return False
    for root in allowed_roots:
        try:
            if resolved_path.is_relative_to(Path(root).resolve()):
                return True
        except Exception:
            continue
    return False


# =========================================================================
# MODULE IMPORT HELPER
# =========================================================================
# studio_api.py may live in scripts/ or the extension root.
# Studio modules may be importable as "studio_generation" or
# "scripts.studio_generation" depending on the context.

def _import(module_name, attr):
    """Import an attribute from a studio module, handling path variations."""
    try:
        mod = __import__(module_name, fromlist=[attr])
    except ImportError:
        mod = __import__(f"scripts.{module_name}", fromlist=[attr])
    return getattr(mod, attr)


def _get_stub_module():
    """Load the gradio stub module — bundled copy first, modules/ fallback."""
    if not hasattr(_get_stub_module, '_cached'):
        try:
            import importlib.util as ilu
            stub_path = os.path.join(os.path.dirname(__file__), "studio_gradio_stub.py")
            spec = ilu.spec_from_file_location("studio_gradio_stub", stub_path)
            mod = ilu.module_from_spec(spec)
            spec.loader.exec_module(mod)
            _get_stub_module._cached = mod
        except Exception:
            import modules.gradio_stub as mod
            _get_stub_module._cached = mod
    return _get_stub_module._cached


# =========================================================================
# GIT UPDATE HELPER
# =========================================================================

# Find the Studio extension root (the dir containing frontend/) — same
# logic used throughout the codebase.
_here_dir = Path(__file__).parent
_studio_root = _here_dir if (_here_dir / "frontend").is_dir() else _here_dir.parent


# =========================================================================
# LOGGING + SUPPORTABILITY HELPERS
# =========================================================================
#
# Rotating file logger at <studio_root>/logs/studio.log so users can attach
# a log when reporting bugs. Privacy rule: log messages MUST NOT include
# prompts, request payloads, full local paths, model/LoRA names, base64,
# or any user-identifying content. Generic messages only — the traceback
# in log.exception() carries enough context for the maintainer.
#
# Existing print(f"{TAG} ...") statements are out of scope (stdout, not
# this log file) but new code in this module should not introduce new
# print() of private content alongside log calls.

import logging
import sys
from logging.handlers import RotatingFileHandler

_log_dir = _studio_root / "logs"
try:
    _log_dir.mkdir(exist_ok=True)
except Exception as _log_dir_err:
    print(f"{TAG} Could not create log directory: {_log_dir_err}")


class _PrivacyFormatter(logging.Formatter):
    """Logging Formatter that scrubs known sensitive path prefixes from
    the formatted output, *including the traceback*.

    Tracebacks include absolute file paths that on Windows always start
    with `C:\\Users\\<username>\\...` — that's a username leak even when
    the log message itself is a generic static string. This formatter
    replaces:
        - the studio extension root → <STUDIO>
        - the active Python install (sys.prefix) → <PYTHON>
        - the user's home directory → <USER>

    Order matters: longest / most specific prefix first, otherwise
    `<USER>` would replace the studio root's leading segment and the
    rest wouldn't match.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        candidates = []
        try:
            candidates.append((str(_studio_root), "<STUDIO>"))
        except Exception:
            pass
        try:
            candidates.append((sys.prefix, "<PYTHON>"))
        except Exception:
            pass
        try:
            candidates.append((str(Path.home()), "<USER>"))
        except Exception:
            pass
        # Deduplicate, then sort by source-string length descending so a
        # path that's a prefix of another doesn't shadow it.
        seen = set()
        self._replacements = []
        for src, dst in candidates:
            if src and src not in seen:
                seen.add(src)
                self._replacements.append((src, dst))
        self._replacements.sort(key=lambda r: len(r[0]), reverse=True)

    def _scrub(self, text):
        if not text:
            return text
        for src, dst in self._replacements:
            if src in text:
                text = text.replace(src, dst)
        return text

    def format(self, record):
        # Format normally (which appends any traceback for log.exception),
        # then scrub the entire result.
        return self._scrub(super().format(record))


log = logging.getLogger("forge-studio")
log.setLevel(logging.INFO)
# Guard against duplicate handlers when this module is reloaded by Forge
# (extension reload, settings change). Without the guard, every reload
# would attach another RotatingFileHandler and each event would be
# written N times.
if not any(isinstance(h, RotatingFileHandler) for h in log.handlers):
    try:
        _handler = RotatingFileHandler(
            _log_dir / "studio.log",
            maxBytes=5 * 1024 * 1024,   # 5 MB per file
            backupCount=3,               # → ~20 MB ceiling
            encoding="utf-8",
        )
        _handler.setFormatter(_PrivacyFormatter(
            "%(asctime)s [%(levelname)s] %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        ))
        log.addHandler(_handler)
        log.info("Forge Studio API logger initialized")
    except Exception as _log_init_err:
        print(f"{TAG} Logger init failed, falling back to stdout: {_log_init_err}")


def _atomic_write_json(path: Path, data) -> None:
    """Write `data` as JSON to `path` atomically: write to a sibling .tmp
    file, then rename over the target. `Path.replace()` is atomic on POSIX
    and on Windows ≥ Vista, so a crash mid-write leaves either the old
    file intact or the new one — never a half-written file.
    """
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(path)


# ---------------------------------------------------------------------------
# User preferences — server-backed application settings
# ---------------------------------------------------------------------------
# Stored in <_studio_root>/user_prefs.json so preferences survive browser
# site-storage clears. Deliberately separate from user_defaults.json (client
# workflow defaults) and trusted_save_roots.json (security state): a folder
# string stored here is an inert preference and never becomes a trusted
# save root by virtue of being persisted.
#
# _PREFS_LOCK covers the complete read/merge/write transaction of every
# endpoint — atomic replace alone would not prevent lost updates when two
# tabs post different keys concurrently.

_PREFS_FILE = _studio_root / "user_prefs.json"
_PREFS_LOCK = RLock()
_PREFS_MAX_BYTES = 256 * 1024
_PREFS_ALLOWED_KEYS = {
    "component_memory", "shortcuts", "layout_preset", "session_limit",
    "gallery_folder", "save_dir", "save_tree", "vram_weights", "auto_unload",
    "remember_session", "gal_send_prompt_version", "panel_ui", "education",
}


def _read_user_prefs_unlocked():
    """Read user_prefs.json. Call only while _PREFS_LOCK is held."""
    if not _PREFS_FILE.is_file():
        return {}
    try:
        data = json.loads(_PREFS_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("preferences root is not an object")
        return data
    except Exception:
        log.exception("Corrupt user_prefs.json; returning empty preferences")
        return {}


# ---------------------------------------------------------------------------
# Workflow Profiles — local JSON storage
# ---------------------------------------------------------------------------
# Each workflow is a single JSON file under <_studio_root>/workflows/. IDs
# are timestamp-backed (wf_<ms>_<6-hex>) so we never collide on rename, and
# names can change without touching the on-disk file. ID validation rejects
# anything that could escape the workflow directory (slashes, dot-dot,
# absolute paths, empty strings, over-length names).

_WORKFLOW_NAME_RE = re.compile(r"[^a-zA-Z0-9_.-]+")
_WORKFLOW_ID_RE = re.compile(r"^[a-zA-Z0-9_.-]{1,128}$")


def _workflow_dir() -> Path:
    d = _studio_root / "workflows"
    d.mkdir(exist_ok=True)
    return d


def _workflow_path(workflow_id: str) -> Path:
    if not workflow_id or not _WORKFLOW_ID_RE.match(workflow_id):
        raise ValueError("Invalid workflow id")
    safe = _WORKFLOW_NAME_RE.sub("-", workflow_id).strip(".-")
    if not safe:
        raise ValueError("Invalid workflow id")
    return _workflow_dir() / f"{safe}.json"


def _new_workflow_id() -> str:
    import secrets
    return f"wf_{int(time.time() * 1000)}_{secrets.token_hex(3)}"


def _now_iso() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _workflow_metadata(wf: dict) -> dict:
    """Return just the metadata fields (no settings/dynamic payload)."""
    return {
        "id":          wf.get("id"),
        "name":        wf.get("name") or "",
        "description": wf.get("description") or "",
        "family":      wf.get("family") or "any",
        "created_at":  wf.get("created_at"),
        "updated_at":  wf.get("updated_at"),
        "options":     wf.get("options") or {},
    }


# ---------------------------------------------------------------------------
# Session registry (WP-L2)
# ---------------------------------------------------------------------------
# In-memory, module-level. Tracks every generated image of every live browser
# tab session so the frontend can request thumbnails by entry id and report
# evictions. Sessions die with the server process by design — the startup
# sweep below removes the whole scratch root and resets these structures.
#
# INVARIANT: a saved user output is NEVER deleted by any session operation.
# File deletion is gated on the registry's own source == "scratch" — never
# inferred from a URL or path supplied by a client.

_SESSION_REGISTRY = {}       # session_id -> entry_id -> {"path": str, "source": "saved"|"scratch"}
_SESSION_ENTRY_INDEX = {}    # entry_id -> (session_id, path) — O(1) thumb lookup
_SESSION_ALLOWED_FILES = set()  # resolved absolute paths of registered SCRATCH files
# Client session ids are crypto.randomUUID() strings; the gate also keeps
# them safe to use as a scratch directory name (no separators/dots).
_SESSION_ID_RE = re.compile(r"^[a-zA-Z0-9-]{8,64}$")


def _session_scratch_root() -> Path:
    return _studio_root / "session_scratch"


def _register_session_entry(session_id: str, path, source: str, entry_id: str = "") -> str:
    """Register one generated image under a session; returns the entry id.
    Scratch entries pass their pre-minted id (the scratch filename stem)."""
    eid = entry_id or uuid.uuid4().hex
    rp = _resolved(path)
    p = str(rp) if rp is not None else str(path)
    _SESSION_REGISTRY.setdefault(session_id, {})[eid] = {"path": p, "source": source}
    _SESSION_ENTRY_INDEX[eid] = (session_id, p)
    if source == "scratch":
        _SESSION_ALLOWED_FILES.add(p)
    return eid


def _remove_session_entry(session_id: str, entry_id: str) -> None:
    """Drop one entry of `session_id`. Deletes the file ONLY for scratch
    entries (see invariant above); saved entries lose their registry row
    and nothing else."""
    sess = _SESSION_REGISTRY.get(session_id)
    if not sess:
        return
    meta = sess.pop(entry_id, None)
    if meta is None:
        return
    _SESSION_ENTRY_INDEX.pop(entry_id, None)
    if meta.get("source") == "scratch":
        p = meta.get("path") or ""
        _SESSION_ALLOWED_FILES.discard(p)
        try:
            Path(p).unlink(missing_ok=True)
        except Exception:
            log.exception("Failed to delete session scratch file")
    if not sess:
        _SESSION_REGISTRY.pop(session_id, None)
        # Best-effort: drop the now-empty per-session scratch dir.
        try:
            sdir = _session_scratch_root() / session_id
            if sdir.is_dir():
                sdir.rmdir()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Layout files (WP-L3)
# ---------------------------------------------------------------------------
# Named layout maps live as JSON files under <extension_root>/studio_layouts/.
# The files ARE the import/export format — dropping a shared file into the
# folder makes it appear in the UI's Load list. Hardening: slug-only names,
# fixed parent dir, size-capped payloads, shape validation, atomic writes.

_LAYOUT_NAME_RE = re.compile(r"^[a-z0-9_-]{1,64}$")
_LAYOUT_MAX_BYTES = 64 * 1024
_LAYOUT_MAX_BLOCK_IDS = 200


def _layout_dir() -> Path:
    d = _studio_root / "studio_layouts"
    d.mkdir(exist_ok=True)
    return d


def _layout_path(name: str):
    """Validated (slug, path) for a layout name, or (None, None). The path
    is always built from the validated slug — never raw input — and the
    resolved parent is verified to be the layout dir itself."""
    slug = str(name or "").strip().lower()
    if not _LAYOUT_NAME_RE.match(slug):
        return None, None
    p = _layout_dir() / f"{slug}.json"
    try:
        if p.resolve().parent != _layout_dir().resolve():
            return None, None
    except Exception:
        return None, None
    return slug, p


def _validate_layout_map(m) -> Optional[str]:
    """Shape-check a layout map. Returns an error string or None. Unknown
    top-level keys are allowed (forward-compat); known keys must be typed
    correctly. Booleans are explicitly rejected where ints are expected
    (bool is an int subclass in Python)."""
    if not isinstance(m, dict):
        return "map must be an object"
    schema = m.get("schema", 1)
    if isinstance(schema, bool) or not isinstance(schema, int):
        return "schema must be an integer"
    n_ids = 0
    zones = m.get("zones", {})
    if not isinstance(zones, dict):
        return "zones must be an object"
    for zname, blocks in zones.items():
        if not isinstance(zname, str) or not isinstance(blocks, list):
            return "zones must map names to lists"
        for b in blocks:
            if not isinstance(b, str) or not _LAYOUT_NAME_RE.match(b):
                return "invalid block id in zones"
            n_ids += 1
    hidden = m.get("hidden", [])
    if not isinstance(hidden, list):
        return "hidden must be a list"
    for b in hidden:
        if not isinstance(b, str) or not _LAYOUT_NAME_RE.match(b):
            return "invalid block id in hidden"
        n_ids += 1
    if n_ids > _LAYOUT_MAX_BLOCK_IDS:
        return "too many block ids"
    pw = m.get("panelWidth", 0)
    if isinstance(pw, bool) or not isinstance(pw, int) or (pw != 0 and not (420 <= pw <= 900)):
        return "panelWidth must be 0 or 420-900"
    strip = m.get("strip", {})
    if not isinstance(strip, dict) or any(not isinstance(v, bool) for v in strip.values()):
        return "strip must be an object of booleans"
    if not isinstance(m.get("module", "canvas"), str) or not isinstance(m.get("base", "classic"), str):
        return "module/base must be strings"
    return None


def _write_session_scratch(session_id: str, img, entry_id: str) -> str:
    """Write one UNSAVED result as `<scratch>/<session_id>/<entry_id>.png`.
    Temporary preview/history asset only — deleted on eviction, clear-
    session, and the startup sweep; never written for saved outputs.
    Returns the resolved path, or "" on failure (caller emits source
    "none" and the frontend keeps the data URL instead)."""
    try:
        sdir = _session_scratch_root() / session_id
        sdir.mkdir(parents=True, exist_ok=True)
        fpath = sdir / f"{entry_id}.png"
        if isinstance(img, Image.Image):
            img.save(str(fpath), format="PNG", icc_profile=_SRGB_ICC)
        elif isinstance(img, str) and img.startswith("data:image"):
            # Pipeline already returned encoded bytes — write them as-is.
            # PIL (thumbnails) and browsers sniff content, so a non-PNG
            # payload behind a .png name still displays correctly.
            raw = base64.b64decode(img.partition(",")[2])
            fpath.write_bytes(raw)
        else:
            return ""
        # /studio/file serves exact registered paths in both Gradio and
        # standalone mode — this is the scratch entry's display route.
        _register_served_file(str(fpath))
        rp = _resolved(fpath)
        return str(rp) if rp is not None else str(fpath)
    except Exception:
        log.exception("Session scratch write failed")
        return ""


def _cleanup_stale_tmp_files() -> None:
    """Sweep stale `.json.tmp` files left behind by killed processes.
    Only scans directories where `_atomic_write_json` actually writes —
    globbing `_studio_root` alone would miss tmps next to JSON files
    that live in subdirectories (presets, etc.).
    """
    # Known JSON-write directories: the studio root (version.json,
    # user_defaults.json) plus the develop presets directory.
    dirs = {_studio_root, _studio_root / "presets" / "develop"}
    for d in dirs:
        if not d.is_dir():
            continue
        for tmp in d.glob("*.json.tmp"):
            try:
                tmp.unlink()
            except Exception:
                log.exception("Failed to clean stale tmp file")
    # Session scratch files are per-tab preview assets; every session is
    # dead by definition at process start, so remove the entire root.
    # Saved outputs never live under this root, so this cannot touch them.
    try:
        scratch = _session_scratch_root()
        if scratch.is_dir():
            shutil.rmtree(scratch, ignore_errors=True)
    except Exception:
        log.exception("Failed to sweep session scratch root")
    _SESSION_REGISTRY.clear()
    _SESSION_ENTRY_INDEX.clear()
    _SESSION_ALLOWED_FILES.clear()


_cleanup_stale_tmp_files()


def _ensure_disk_space(target_dir: Path, needed_bytes: int = 100 * 1024 * 1024) -> None:
    """Raise RuntimeError if `target_dir`'s filesystem has less than
    `needed_bytes` free. 100 MB default leaves headroom for a large PNG
    plus the float32 sidecar. Caller should ensure target_dir exists.

    Privacy: the error message intentionally omits the path — the user
    knows which output directory they configured.
    """
    try:
        free = shutil.disk_usage(target_dir).free
    except Exception:
        # If we can't read disk usage (permissions, removed mount), let
        # the actual write surface its own error rather than block here.
        return
    if free < needed_bytes:
        raise RuntimeError(
            f"Output directory has only {free // (1024 * 1024)} MB free; "
            f"need at least {needed_bytes // (1024 * 1024)} MB"
        )


def _next_forge_counter(output_dir: Path) -> int:
    """Return the next Forge-style 5-digit counter for the given folder.
    Scans existing files matching Studio-NNNNN-*.{png,jpg,webp} and returns
    max+1, or 1 if the folder is empty or has no matching files.
    """
    if not output_dir.is_dir():
        return 1
    max_n = 0
    for f in output_dir.iterdir():
        if not f.is_file():
            continue
        name = f.name
        if (
            len(name) >= 13
            and name[:7] == "Studio-"
            and name[7:12].isdigit()
            and name[12] == "-"
        ):
            n = int(name[7:12])
            if n > max_n:
                max_n = n
    return max_n + 1

# ── GitHub API update system ──────────────────────────────────────────
# No .git required. Checks the public GitHub API for new commits,
# downloads zip archives to update. Zero local metadata beyond a
# version.json with the current commit hash.
_GITHUB_OWNER = "ToxicHost"
_GITHUB_REPO = "Forge-Studio"
_GITHUB_BRANCH = "main"
_GITHUB_API = f"https://api.github.com/repos/{_GITHUB_OWNER}/{_GITHUB_REPO}"
_VERSION_FILE = _studio_root / "version.json"


# ── /studio/file serving + path-write safety ────────────────────────────
# Security model (hardened): /studio/file serves ONLY files Studio itself
# wrote/returned this session (exact resolved-path allowlist) plus media/
# sidecar files under Forge's own output tree. Clients can NOT register new
# readable roots, and writes are confined to "safe roots" (output tree +
# folders the user picked via the server-side dialog + operator-configured
# STUDIO_SAVE_ROOTS). "Save As" is browser-side only — the backend never
# writes to a client-chosen arbitrary path.

# Exact resolved file paths Studio wrote this session and may serve.
_SERVED_FILES = set()
# Persisted trusted *write* roots. A path becomes trusted only through an
# explicit local-user action (server-side Browse, or typed-then-"Trust" in the
# UI) — never just by appearing in a generation/save request. Stored separately
# from client-writable defaults so the save_defaults endpoint can't inject one.
_TRUSTED_ROOTS_FILE = _studio_root / "trusted_save_roots.json"

# Only these media/sidecar suffixes may be served by /studio/file. Note the
# compound suffixes — plain .json/.bin/.txt/.py/.db are deliberately NOT here.
_FILE_EXT_ALLOW = (
    ".png", ".jpg", ".jpeg", ".webp", ".gif",
    ".mp4", ".webm", ".mov",
    ".float32.bin", ".float32.json",  # .blend_mask.png covered by .png
)


def _forge_output_root():
    try:
        base = shared.opts.data.get("outdir_samples", "") or shared.opts.data.get("outdir_img2img_samples", "")
        if not base:
            from modules.paths import data_path
            base = os.path.join(data_path, "output")
        if os.path.basename(base) in ("txt2img-images", "img2img-images"):
            base = os.path.dirname(base)
        return str(Path(base).expanduser().resolve())
    except Exception:
        return str(Path("output").resolve())


def _resolved(p):
    try:
        return Path(p).expanduser().resolve()
    except Exception:
        return None


def _register_served_file(p):
    """Record an exact file Studio wrote so /studio/file may serve it."""
    rp = _resolved(p)
    if rp is not None:
        _SERVED_FILES.add(str(rp))


def _load_trusted_roots():
    try:
        with open(_TRUSTED_ROOTS_FILE) as f:
            data = json.load(f)
        items = data.get("trusted_save_roots", []) if isinstance(data, dict) else []
        out = set()
        for r in items:
            rp = _resolved(r)
            if rp is not None:
                out.add(str(rp))
        return out
    except Exception:
        return set()


def _save_trusted_roots(roots):
    try:
        _atomic_write_json(_TRUSTED_ROOTS_FILE, {"trusted_save_roots": sorted(roots)})
    except Exception:
        pass


def _is_dangerous_root(rp):
    """Reject overly-broad / sensitive directories as trusted save roots."""
    try:
        rp = Path(rp).expanduser().resolve()
    except Exception:
        return True
    # Filesystem / drive root ("/", "C:\\").
    if rp == rp.parent:
        return True
    try:
        if rp == Path.home().resolve():  # the home ROOT (subfolders are fine)
            return True
    except Exception:
        pass
    sys_dirs = ["/etc", "/bin", "/sbin", "/boot", "/sys", "/proc", "/dev",
                "/lib", "/lib64", "/usr", "/var", "/root", "/System", "/Library"]
    for env in ("SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"):
        v = os.environ.get(env)
        if v:
            sys_dirs.append(v)
    # System dirs: reject the directory AND anything under it.
    for d in sys_dirs:
        dp = _resolved(d)
        if dp is not None and (rp == dp or _is_under(rp, dp)):
            return True
    # Install roots (Forge data dir + Studio extension): reject the root itself
    # or any ancestor of it (which would expose models/config). Dedicated
    # SUBfolders under them are allowed (e.g. an outputs subfolder).
    install_roots = [str(_studio_root)]
    try:
        from modules.paths import data_path
        install_roots.append(str(data_path))
    except Exception:
        pass
    for d in install_roots:
        dp = _resolved(d)
        if dp is not None and (rp == dp or _is_under(dp, rp)):
            return True
    return False


def _probe_writable_path(rp):
    try:
        rp.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=str(rp), prefix=".swprobe_", delete=True):
            pass
        return True
    except Exception:
        return False


def _add_trusted_root(p):
    """Validate and persist a trusted write root. Returns (ok, message). Used
    by the server-side picker and the explicit 'Trust folder' UI action."""
    rp = _resolved(p)
    if rp is None:
        return False, "Path could not be resolved."
    if _is_dangerous_root(rp):
        return False, "That folder is too broad or system-level to trust. Pick a dedicated output subfolder."
    if not _probe_writable_path(rp):
        return False, "Folder does not exist / could not be created, or isn't writable by Forge Studio."
    roots = _load_trusted_roots()
    roots.add(str(rp))
    _save_trusted_roots(roots)
    return True, str(rp)


def _ext_allowed(name):
    n = str(name).lower()
    return any(n.endswith(s) for s in _FILE_EXT_ALLOW)


def _is_under(child, root):
    try:
        child.relative_to(root)
        return True
    except Exception:
        return False


def _is_served_file(path):
    """True only for an allowed media/sidecar file that Studio wrote this
    session OR that lives under Forge's own output tree. No client-registered
    roots; resolve()+exact-match defeats traversal and symlink escape."""
    rp = _resolved(path)
    if rp is None or not _ext_allowed(rp.name):
        return False
    if str(rp) in _SERVED_FILES:
        return True
    # Fixed fallback root: Forge's output tree (needed so float/mask sidecars
    # from earlier sessions still load via the Gallery). Extension-gated above.
    return _is_under(rp, Path(_forge_output_root()))


def _safe_write_roots():
    roots = {_forge_output_root()}
    # Forge root itself (cwd) — keep.
    cwd = _resolved(Path.cwd())
    if cwd is not None:
        roots.add(str(cwd))
    # Forge-configured output dirs + each one's parent. The parent entries
    # cover sibling folders (e.g. output/ when config names
    # output/txt2img-images/). These are config-sourced, not request-sourced,
    # so they are trusted by definition — restoring the pre-WP6 accept set.
    try:
        for _key in ("outdir_samples", "outdir_txt2img_samples",
                     "outdir_img2img_samples", "outdir_save"):
            _d = shared.opts.data.get(_key, "")
            if _d:
                rp = _resolved(_d)
                if rp is not None:
                    roots.add(str(rp))
                    roots.add(str(rp.parent))
    except Exception:
        log.exception("Failed reading Forge outdir opts for safe-write roots")
    # Gallery-linked/watched folders — explicit, user-configured off-tree save
    # targets. Read fresh per call (no cache) so linking a new folder works
    # without a restart. Use the Gallery's own accessor, not a config re-parse.
    try:
        _scan_folders = _import("studio_gallery", "get_scan_folders")()
        for _f in (_scan_folders or []):
            rp = _resolved(_f)
            if rp is not None:
                roots.add(str(rp))
    except Exception:
        # Gallery module/table may be absent on a fresh install — non-fatal.
        pass
    # Persisted, explicitly-trusted roots (Browse-picked or typed-then-Trusted).
    roots.update(_load_trusted_roots())
    # Operator-configured extra roots (env is trusted) for remote/VM setups.
    extra = os.environ.get("STUDIO_SAVE_ROOTS", "")
    for chunk in extra.split(os.pathsep):
        rp = _resolved(chunk.strip())
        if rp is not None:
            roots.add(str(rp))
    return roots


def _safe_write_root(path):
    """True when `path` is inside a safe write root: Forge's output tree, a
    dialog-picked folder, or an operator-configured STUDIO_SAVE_ROOTS entry.
    Blocks a random API client from writing to arbitrary absolute paths."""
    rp = _resolved(path)
    if rp is None:
        return False
    return any(_is_under(rp, Path(r)) for r in _safe_write_roots())


# Save As tokens removed: server-side "Save As" is gone (browser-side only),
# so there is no token mint/consume path and no arbitrary backend file write.


def _check_same_origin(request):
    """Reject cross-site browser requests (CSRF) to path-writing endpoints.
    Same-origin UI and non-browser clients (no Origin header) pass; a browser
    request whose Origin host differs from the Host header is rejected. (Direct
    non-browser LAN clients are additionally constrained by _safe_write_root.)"""
    try:
        origin = request.headers.get("origin")
        if not origin:
            sfs = request.headers.get("sec-fetch-site")
            if sfs and sfs not in ("same-origin", "same-site", "none"):
                return False
            return True
        from urllib.parse import urlparse
        return urlparse(origin).netloc == (request.headers.get("host") or "")
    except Exception:
        return True


def _read_version():
    """Read current commit hash from version.json, or None."""
    try:
        with open(_VERSION_FILE) as f:
            return json.load(f).get("commit")
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        return None


def _write_version(commit_sha):
    """Write commit hash to version.json (atomic)."""
    _atomic_write_json(_VERSION_FILE, {"commit": commit_sha})


def _github_get(path, timeout=15):
    """GET a GitHub API endpoint. Returns parsed JSON or None on failure."""
    url = f"{_GITHUB_API}{path}"
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "ForgeStudio-Updater",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, TimeoutError):
        return None


_current_version = _read_version()
if _current_version:
    print(f"{TAG} Version: {_current_version[:8]}")
else:
    print(f"{TAG} No version.json — update checks will treat this as a fresh install")


# =========================================================================
# REQUEST / RESPONSE MODELS
# =========================================================================

class ADSlotParams(BaseModel):
    """ADetailer slot parameters."""
    enable: bool = False
    model: str = "None"
    confidence: float = 0.3
    mask_min: float = 0.0
    mask_max: float = 1.0
    topk_filter: bool = False
    topk: int = 0
    x_offset: int = 0
    y_offset: int = 0
    erosion_dilation: int = 0
    merge_mode: str = "None"
    denoise: float = 0.4
    mask_blur: int = 4
    inpaint_pad: int = 32
    full_res: bool = True
    fill: int = 1
    sep_steps: bool = False
    steps: int = 28
    sep_cfg: bool = False
    cfg: float = 7.0
    sep_sampler: bool = False
    sampler: str = "DPM++ 2M SDE Karras"
    scheduler: str = "Use same scheduler"
    prompt: str = ""
    neg_prompt: str = ""


class GenerateRequest(BaseModel):
    """Full generation request matching run_generation() signature."""
    # Special action field: "generate" (default), "save_defaults", "load_defaults", "delete_defaults"
    action: str = "generate"
    defaults_data: Optional[dict] = None

    canvas_b64: str = ""
    mask_b64: str = ""
    fg_b64: str = "null"
    mode: str = "Create"
    inpaint_mode: str = "Inpaint"

    prompt: str = ""
    neg_prompt: str = ""
    steps: int = 30
    sampler_name: str = "DPM++ 2M SDE"
    schedule_type: str = "Karras"
    cfg_scale: float = 5.0
    denoising: float = 0.81
    width: int = 768
    height: int = 768
    seed: int = -1
    batch_count: int = 1
    batch_size: int = 1

    # Variation seed
    subseed: int = -1
    subseed_strength: float = 0
    seed_resize_from_w: int = 0
    seed_resize_from_h: int = 0

    mask_blur: int = 4
    inpainting_fill: int = 1
    inpaint_full_res: int = 0
    inpaint_pad: int = 64
    soft_inpaint_enabled: bool = False
    soft_inpaint_schedule_bias: float = 1.0
    soft_inpaint_preservation: float = 0.5
    soft_inpaint_transition_contrast: float = 4.0
    soft_inpaint_mask_influence: float = 0.0
    soft_inpaint_diff_threshold: float = 0.5
    soft_inpaint_diff_contrast: float = 2.0

    hr_enable: bool = False
    hr_upscaler: str = "Latent"
    hr_scale: float = 2.0
    hr_steps: int = 0
    hr_denoise: float = 0.3
    hr_cfg: float = 0.0
    hr_checkpoint: str = "Same"

    ad_enable: bool = False
    ad_slots: List[ADSlotParams] = Field(
        default_factory=lambda: [ADSlotParams(), ADSlotParams(), ADSlotParams()]
    )

    regions_json: str = ""
    cn_json: str = ""
    cn1_upload_b64: Optional[str] = None
    cn2_upload_b64: Optional[str] = None

    # Settings
    # Per-tab session id (WP-L2) — results are registered under it so the
    # session_thumb/evict/clear endpoints can resolve them. Optional; an
    # invalid/missing id just skips registration (no thumbs, no scratch).
    session_id: str = ""
    save_outputs: bool = True
    save_format: str = "png"         # png | jpeg | webp
    save_quality: int = Field(default=80, ge=1, le=100)  # JPEG/WebP quality
    save_lossless: bool = False      # WebP lossless mode
    embed_metadata: bool = True      # whether to embed generation params in saved files
    save_dir: str = ""               # optional auto-save folder override (empty = Forge output dir)
    save_tree: str = "studio"        # "studio" (output/studio/{mode}/{date}) | "neo" (Neo's own per-mode outdirs)
    is_txt2img: bool = False

    # Extension bridge: {arg_index: value} overrides from auto-bridged extensions
    extension_args: Optional[dict] = None
    # Extensions disabled in Studio's Settings toggle — force their enable args to False
    disabled_extensions: Optional[List[str]] = None

    # UX-018: AR Randomizer (native replacement for Moritz's AR Selector)
    ar_rand_base: bool = False
    ar_rand_ratio: bool = False
    ar_rand_orientation: bool = False
    ar_base_pool: List[int] = Field(default_factory=list)     # empty = all bases
    ar_ratio_pool: List[str] = Field(default_factory=list)    # empty = all ratios

    # High Precision Mode: capture pre-clamp float32 VAE output and save a
    # .float32.bin sidecar next to each PNG for the Develop module + EXR export.
    high_precision: bool = False

    # Studio-native dynamic prompt expansion (V1: __wildcards__, {a|b|c},
    # {N$$a|b|c}). When enabled, the backend resolves these in-process and
    # suppresses sd-dynamic-prompts for this request to avoid double-
    # processing. Default True so Studio's wildcards work even when the
    # external DP extension is missing or broken by Forge Neo changes.
    studio_dynamic_prompts_enabled: bool = True

    # Auto Watermark: composite a user-selected image (from the extension's
    # watermarks/ folder) onto the final generated image as the last
    # post-process step. watermark_name is a bare filename; the backend
    # resolves it under the fixed folder with a traversal guard.
    watermark_enable: bool = False
    watermark_name: str = ""                  # filename under <ext>/watermarks/
    watermark_position: str = "bottom-right"  # 9 anchors (see studio_generation._WM_POSITIONS)
    watermark_opacity: float = 1.0            # 0..1
    watermark_scale: float = 0.15             # fraction of the shorter edge
    watermark_margin: int = 16                # px from the chosen edge(s)
    watermark_rotation: float = 0.0           # degrees


class GenerateResponse(BaseModel):
    """Generation result."""
    images: List[str] = []
    image_paths: List[str] = []   # server-side file paths for /file= URLs
    # High Precision sidecar paths, parallel to image_paths; "" when capture
    # was disabled, skipped, or failed for that image.
    float_paths: List[str] = []
    # AD/brush blend mask sidecar paths (V2), parallel to float_paths;
    # "" when no post-processing modified pixels (no AD/no brush composite).
    mask_paths: List[str] = []
    # Privacy-safe High Precision source stats, parallel to images: range,
    # clamp/headroom flags, finite counts. No paths/prompts/pixels. None when
    # HP was off or N/A for that image.
    float_stats: List[Optional[dict]] = []
    content_hashes: List[str] = []  # SHA256 of decoded RGB pixels, "" if not saved
    infotexts: List[str] = []
    # WP-L2: one {entry_id, source, path} per image (parallel to `images`).
    # source is "saved" | "scratch" | "none" ("none" = no file exists for
    # this image — registration skipped or scratch write failed).
    session_entries: List[dict] = []
    settings: dict = {}
    seed: int = -1
    task_id: str = ""
    error: Optional[str] = None
    # Non-fatal user-facing notice (e.g. a configured save folder was ignored
    # because it isn't a trusted root). The UI shows it as an info toast.
    notice: Optional[str] = None


class ExrExportRequest(BaseModel):
    """Request body for /studio/export/exr."""
    # Path to the .float32.bin sidecar (preferred — gives true float data).
    # If empty or missing on disk, falls back to image_b64.
    float_path: str = ""
    # Float sidecar dimensions (required when float_path is provided).
    width: int = 0
    height: int = 0
    # Fallback path: a base64 data URL (uint8) — produces an EXR for
    # pipeline compatibility but no precision gain over the source PNG.
    image_b64: str = ""
    # Optional V2 blend mask path (.blend_mask.png). When provided, the
    # endpoint composites canvas-uint8 over the float buffer using this
    # mask before writing the EXR — same composite the Develop module
    # does at load time. Image_b64 must also be provided as the canvas
    # source for the masked regions.
    mask_path: str = ""
    # Optional file naming. Subfolder lives under the studio output root,
    # mirroring the regular save-image endpoint's contract.
    subfolder: str = "downloads"
    filename: Optional[str] = None


class SessionEvictRequest(BaseModel):
    """Body for /studio/session_evict — entries that fell off the client's
    session history cap."""
    session_id: str = ""
    entry_ids: List[str] = []


class SessionClearRequest(BaseModel):
    """Body for /studio/session_clear — drop every entry of one session."""
    session_id: str = ""


class LayoutSaveRequest(BaseModel):
    """Body for POST /studio/layouts — a named layout map (WP-L3)."""
    name: str = ""
    map: dict = Field(default_factory=dict)


# =========================================================================
# HELPERS
# =========================================================================

def _flatten_ad_slot(slot: ADSlotParams) -> list:
    """Convert ADSlotParams into the flat arg list run_generation expects."""
    return [
        slot.enable, slot.model, slot.confidence, slot.mask_min, slot.mask_max,
        slot.topk_filter, slot.topk, slot.x_offset, slot.y_offset,
        slot.erosion_dilation, slot.merge_mode,
        slot.denoise, slot.mask_blur, slot.inpaint_pad, slot.full_res, slot.fill,
        slot.sep_steps, slot.steps, slot.sep_cfg, slot.cfg,
        slot.sep_sampler, slot.sampler, slot.scheduler,
        slot.prompt, slot.neg_prompt,
    ]


def _decode_b64_to_numpy(b64_str: Optional[str]):
    """Decode base64 image to numpy array for ControlNet upload."""
    if not b64_str or b64_str in ("null", ""):
        return None
    try:
        if "," in b64_str:
            b64_str = b64_str.split(",", 1)[1]
        img = Image.open(io.BytesIO(base64.b64decode(b64_str)))
        import numpy as np
        return np.array(img)
    except Exception:
        return None


def _write_exr_minimal(path: str, rgb) -> None:
    """Write an uncompressed scanline single-part OpenEXR with float32 RGB.

    Used as a fallback when OpenCV's OPENCV_IO_ENABLE_OPENEXR codec
    isn't compiled in. `rgb` is an HxWx3 float32 numpy array; channels
    are stored as B, G, R (alphabetical, per EXR convention) and the
    file is uncompressed (compression=0) so there are no codec deps.

    Format reference: openexr.com/en/latest/OpenEXRFileLayout.html
    """
    import struct
    import numpy as np
    if rgb.ndim != 3 or rgb.shape[2] < 3:
        raise ValueError("rgb must be HxWx3")
    if rgb.dtype != np.float32:
        rgb = np.ascontiguousarray(rgb, dtype=np.float32)
    h, w = rgb.shape[0], rgb.shape[1]
    R = np.ascontiguousarray(rgb[:, :, 0], dtype=np.float32)
    G = np.ascontiguousarray(rgb[:, :, 1], dtype=np.float32)
    B = np.ascontiguousarray(rgb[:, :, 2], dtype=np.float32)

    out = bytearray()
    out += b"\x76\x2f\x31\x01"          # magic
    out += struct.pack("<I", 2)         # version=2, all flags zero (single-part scanline)

    def _attr(name: str, atype: str, payload: bytes) -> bytes:
        return (name.encode("ascii") + b"\x00"
                + atype.encode("ascii") + b"\x00"
                + struct.pack("<I", len(payload))
                + payload)

    # channels: B, G, R in alphabetical order, FLOAT pixelType.
    chlist = bytearray()
    for cn in ("B", "G", "R"):
        chlist += cn.encode("ascii") + b"\x00"
        chlist += struct.pack("<i", 2)      # pixelType: 2 = FLOAT
        chlist += struct.pack("<I", 0)      # pLinear (1 byte) + 3 reserved bytes
        chlist += struct.pack("<i", 1)      # xSampling
        chlist += struct.pack("<i", 1)      # ySampling
    chlist += b"\x00"
    out += _attr("channels", "chlist", bytes(chlist))
    out += _attr("compression", "compression", b"\x00")  # NO_COMPRESSION
    box = struct.pack("<iiii", 0, 0, w - 1, h - 1)
    out += _attr("dataWindow", "box2i", box)
    out += _attr("displayWindow", "box2i", box)
    out += _attr("lineOrder", "lineOrder", b"\x00")      # INCREASING_Y
    out += _attr("pixelAspectRatio", "float", struct.pack("<f", 1.0))
    out += _attr("screenWindowCenter", "v2f", struct.pack("<ff", 0.0, 0.0))
    out += _attr("screenWindowWidth", "float", struct.pack("<f", 1.0))
    out += b"\x00"  # end-of-header

    # Per-scanline payload: y(int32) + pixelDataSize(uint32) + B + G + R bytes.
    pixel_data_size = 3 * w * 4
    line_size = 4 + 4 + pixel_data_size
    first_offset = len(out) + h * 8  # 8-byte offset per scanline
    for i in range(h):
        out += struct.pack("<Q", first_offset + i * line_size)
    for y in range(h):
        out += struct.pack("<i", y)
        out += struct.pack("<I", pixel_data_size)
        out += B[y].tobytes()
        out += G[y].tobytes()
        out += R[y].tobytes()

    with open(path, "wb") as f:
        f.write(bytes(out))


def _write_float_metadata(bin_path: Path, float_arr, stats) -> None:
    """Write the companion {stem}.float32.json describing the raw .bin sidecar.

    Best-effort: a failure here never affects the .bin or the saved image. The
    .bin format is unchanged; this JSON just lets Develop/Gallery/export
    understand the sidecar after a reload (range, capture provenance, dims).
    Atomic write; no absolute paths or other sensitive data recorded.
    """
    try:
        import numpy as np
        a = np.asarray(float_arr)
        h = int(a.shape[0]); w = int(a.shape[1])
        ch = int(a.shape[2]) if a.ndim == 3 else 1
        st = stats if isinstance(stats, dict) else {}
        meta = {
            "version": 1,
            "kind": "forge-studio-high-precision",
            "pixel": {
                "file": bin_path.name,
                "width": w,
                "height": h,
                "channels": ch,
                "dtype": "float32",
                "layout": "HWC",
                "interleaved": True,
                "color": {
                    "primaries": "sRGB/Rec.709",
                    "transfer": "sRGB",
                    "linearized": False,
                },
            },
            "capture": {
                "source_stage": st.get("source_stage"),
                "fallback": bool(st.get("fallback", False)),
                "fallback_reason": st.get("fallback_reason"),
                "transform": st.get("transform", "(x + 1) / 2"),
                "range": st.get("range", "unknown"),
                "headroom": bool(st.get("has_headroom", False)),
                "clamped_like": bool(st.get("clamped_like", False)),
                "matched_final_dimensions": st.get("matched_final_dimensions"),
                "below0_pct": st.get("below0_pct"),
                "above1_pct": st.get("above1_pct"),
                "boundary0_pct": st.get("boundary0_pct"),
                "boundary1_pct": st.get("boundary1_pct"),
                "min_rgb": st.get("min_rgb"),
                "max_rgb": st.get("max_rgb"),
            },
        }
        json_path = bin_path.with_suffix(".json")
        _atomic_write_json(json_path, meta)
        _register_served_file(str(json_path))
    except Exception as e:
        print(f"{TAG} High Precision: metadata sidecar write failed: {e}")


def _save_float_sidecar(fpath: Path, float_arr, stats=None) -> str:
    """Write a {stem}.float32.bin sidecar next to the saved image, plus a
    companion {stem}.float32.json describing it.

    `float_arr` is an HxWx3 float32 numpy array (the VAE output after
    (x+1)/2, in [0, 1] with possible out-of-range headroom). Returns the
    .bin path on success, "" on any failure (so the regular save is
    unaffected). The .json is best-effort and never blocks the .bin.
    """
    if float_arr is None:
        return ""
    try:
        import numpy as np
    except Exception:
        return ""
    try:
        sidecar = fpath.with_name(fpath.stem + ".float32.bin")
        # Tobytes() with a contiguous float32 array gives the layout
        # the JS reader expects: row-major, RGB-interleaved, no header.
        data = np.ascontiguousarray(float_arr, dtype=np.float32).tobytes()
        with open(str(sidecar), "wb") as f:
            f.write(data)
        _register_served_file(str(sidecar))
        _write_float_metadata(sidecar, float_arr, stats)
        return str(sidecar)
    except Exception as e:
        print(f"{TAG} High Precision: sidecar write failed for {fpath.name}: {e}")
        return ""


def _save_mask_sidecar(fpath: Path, mask_arr) -> str:
    """Write a {stem}.blend_mask.png sidecar describing AD/brush coverage.

    `mask_arr` is a float32 HxW array in [0, 1] where 1.0 means "use
    canvas uint8 here at Develop load time" and 0.0 means "use the
    pre-modification float buffer here". Saved as 8-bit grayscale PNG —
    ~50 KB at 1024² vs ~4 MB raw, debuggable in any image viewer, and
    the 256-level quantization is invisible in a feathered alpha mask.
    """
    if mask_arr is None:
        return ""
    try:
        import numpy as np
    except Exception:
        return ""
    try:
        sidecar = fpath.with_name(fpath.stem + ".blend_mask.png")
        u8 = (np.clip(mask_arr, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
        Image.fromarray(u8, mode="L").save(str(sidecar), format="PNG", optimize=True)
        _register_served_file(str(sidecar))
        return str(sidecar)
    except Exception as e:
        print(f"{TAG} High Precision: blend-mask sidecar write failed for {fpath.name}: {e}")
        return ""


def _pil_to_b64(img: Image.Image) -> str:
    """Encode a PIL image to base64 PNG data URL."""
    buf = io.BytesIO()
    img.save(buf, format="PNG", icc_profile=_SRGB_ICC)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _pil_to_preview_b64(img: Image.Image) -> str:
    """Fast preview encoder — JPEG at q=70 balances quality and payload size.
    Used for both TAESD step previews and live preview thumbnails.

    This is a TRANSIENT UI image, not a final artifact: it keeps 4:2:0
    subsampling for speed/size and must NOT adopt the final-output 4:4:4
    policy (_final_jpeg_save_kwargs)."""
    buf = io.BytesIO()
    if img.mode != "RGB":
        img = img.convert("RGB")
    img.save(buf, format="JPEG", quality=70, subsampling=2, optimize=False, icc_profile=_SRGB_ICC)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def _normalize_jpeg_quality(value, fallback: int = 80) -> int:
    """Clamp a JPEG quality value to the supported 1–100 range."""
    try:
        quality = int(value)
    except (TypeError, ValueError):
        quality = fallback
    return max(1, min(100, quality))


def _final_jpeg_save_kwargs(quality, *, exif_bytes=None) -> dict:
    """Canonical Pillow save kwargs for every USER-VISIBLE final JPEG.

    Forces JPEG 4:4:4 chroma (subsampling=0) so saturated edges and line
    art keep full color resolution — Pillow/libjpeg otherwise default to
    4:2:0, which bleeds color. Callers still pass icc_profile=_SRGB_ICC at
    save time. Not for the transient step preview (_pil_to_preview_b64)."""
    kwargs = {
        "quality": _normalize_jpeg_quality(quality),
        "subsampling": 0,   # JPEG 4:4:4 — retain full chroma resolution
        "optimize": True,
    }
    if exif_bytes:
        kwargs["exif"] = exif_bytes
    return kwargs


def _studio_upscale_image(img, upscaler_name: str, scale: float):
    """Run a single ESRGAN-class upscaler pass on a PIL image.

    Extracted so both /studio/upscale and /studio/upscale_and_refine can
    reuse the ESRGAN path without round-tripping through HTTP. Synchronous
    and blocking — call via run_in_executor or asyncio.to_thread from
    async handlers.

    Returns the upscaled PIL.Image. Target dims are snapped to multiples
    of 8 so the result is a valid latent size for any downstream img2img
    pass. Falls back to LANCZOS if the requested upscaler is missing.
    """
    import torch

    orig_w, orig_h = img.size
    scale = max(1.0, min(4.0, float(scale)))
    new_w = (int(orig_w * scale) // 8) * 8
    new_h = (int(orig_h * scale) // 8) * 8

    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    upscaler = None
    for u in shared.sd_upscalers:
        if u.name == upscaler_name:
            upscaler = u
            break

    if upscaler and upscaler.name != "None":
        target_scale = new_w / orig_w
        result = upscaler.scaler.upscale(img, target_scale, upscaler.data_path)
        if result.size != (new_w, new_h):
            result = result.resize((new_w, new_h), Image.LANCZOS)
    else:
        if upscaler_name and upscaler_name != "Latent":
            print(f"{TAG} Upscaler '{upscaler_name}' not found, using LANCZOS")
        result = img.resize((new_w, new_h), Image.LANCZOS)

    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    return result


def _build_exif_usercomment(text: str) -> Optional[bytes]:
    """Build EXIF bytes with generation params in UserComment.

    Used for JPEG and WebP metadata embedding. Tries piexif first
    (available in Forge Neo's dependency tree), falls back to
    Pillow's built-in Exif class.

    Returns EXIF bytes suitable for Pillow's save(exif=...), or None on failure.
    """
    if not text:
        return None
    try:
        import piexif
        # UserComment requires charset prefix — use ASCII for SD-standard params
        encoded = b"ASCII\x00\x00\x00" + text.encode("utf-8", errors="replace")
        exif_dict = {"Exif": {piexif.ExifIFD.UserComment: encoded}}
        return piexif.dump(exif_dict)
    except ImportError:
        pass
    try:
        # Fallback: Pillow's Exif (available since Pillow 6.0)
        exif = Image.Exif()
        # 0x9286 = UserComment tag in EXIF IFD
        exif[0x9286] = b"ASCII\x00\x00\x00" + text.encode("utf-8", errors="replace")
        return exif.tobytes()
    except Exception:
        return None


# =========================================================================
# EXTENSION BRIDGE — COMPONENT TYPE RESOLUTION
# =========================================================================
# In --nowebui mode, components are stubs with _type attributes.
# In Gradio mode (default bat), components are real Gradio widgets.
# This resolver handles both so the /extensions endpoint works
# regardless of how Forge was launched.

# Map real Gradio class names → our manifest type strings
_GRADIO_CLASS_MAP = {
    "Slider": "slider", "Checkbox": "checkbox", "Dropdown": "dropdown",
    "Radio": "radio", "Textbox": "textbox", "Number": "number",
    "Image": "image", "HTML": "html", "Markdown": "markdown",
    "Button": "button", "State": "state", "Gallery": "gallery",
    "Plot": "plot", "ColorPicker": "colorpicker", "File": "file",
    "Dataframe": "dataframe", "HighlightedText": "highlightedtext",
    "JSON": "json", "Label": "label", "Audio": "audio", "Video": "video",
}


def _resolve_component_type(comp):
    """Determine the manifest type string for a component.

    Works for both stub components (_type attribute) and real Gradio
    components (class name mapping). Falls back to value-based inference.
    """
    # Stub components have _type
    t = getattr(comp, '_type', None)
    if t and t != 'unknown':
        return t

    # Real Gradio components — walk MRO for a known class name
    for cls in type(comp).__mro__:
        mapped = _GRADIO_CLASS_MAP.get(cls.__name__)
        if mapped:
            return mapped

    # Value-based inference as last resort
    val = getattr(comp, 'value', None)
    if isinstance(val, bool):
        return "checkbox"
    if isinstance(val, (int, float)) and hasattr(comp, 'minimum'):
        return "slider"
    if hasattr(comp, 'choices') and getattr(comp, 'choices', None):
        return "dropdown"

    return "unknown"


# =========================================================================
# EXTENSION BRIDGE — LAYOUT GROUPS & DEPENDENCY PROBING
# =========================================================================
# Two-phase analysis of extension UI structure:
#
# Phase 1 (structural): Find layout containers (Column/Group) with mixed
# visibility — the Gradio pattern for toggle-able sections. These become
# DOM wrappers in the frontend.
#
# Phase 2 (behavioral): Probe .change() callbacks on dropdowns, radios,
# and checkboxes. Capture ALL effects: visibility changes on groups,
# value propagation to controls, choices updates on dropdowns. Ship as
# a unified "dependencies" list so the frontend can replicate Gradio's
# interactive behavior without running Python callbacks at runtime.

def _detect_layout_groups(controls, runner):
    """Find Column/Group siblings with mixed visibility (Phase 1).

    Returns (groups, layout_id_map) where:
    - groups: list of {id, visible, label, control_indices}
    - layout_id_map: {id(LayoutBlock): group_id} for dependency probing

    Each control dict in `controls` gets a "group" key added when it
    belongs to a visibility-controlled container.

    In Gradio mode (no stubs), components lack _parent/_children attrs —
    returns empty results gracefully. Controls still work, just without
    layout group metadata.
    """
    _stub = _get_stub_module(); LayoutBlock = _stub.LayoutBlock

    layout_id_map = {}
    if not controls:
        return [], layout_id_map

    # Build a map of control index → stub component
    comp_map = {}
    for c in controls:
        idx = c["index"]
        if idx < len(runner.inputs) and runner.inputs[idx] is not None:
            comp_map[idx] = runner.inputs[idx]

    # In Gradio mode, real components don't have _parent — bail early
    if not any(hasattr(comp, '_parent') for comp in comp_map.values()):
        return [], layout_id_map

    # Find all unique parent LayoutBlocks that contain controls from this script
    parent_set = {}
    for comp in comp_map.values():
        p = getattr(comp, '_parent', None)
        if p is not None and isinstance(p, LayoutBlock):
            parent_set[id(p)] = p

    groups = []
    checked_parents = set()

    for parent in list(parent_set.values()):
        # We want the parent OF our parent — the scope that contains the
        # sibling columns. Controls inside pane_decay have parent=pane_decay,
        # but pane_decay's parent is the Accordion — that's where we find siblings.
        scope = getattr(parent, '_parent', None)
        if scope is None or id(scope) in checked_parents:
            continue
        if not hasattr(scope, '_children'):
            continue
        checked_parents.add(id(scope))

        # Find child LayoutBlocks of the scope that are Column or Group
        child_layouts = [
            ch for ch in scope._children
            if isinstance(ch, LayoutBlock) and ch._type in ('column', 'group')
        ]

        if len(child_layouts) < 2:
            continue

        # Check for mixed visibility — the signature of toggle groups
        visibilities = [getattr(ch, 'visible', True) for ch in child_layouts]
        num_visible = sum(1 for v in visibilities if v)
        if num_visible == len(visibilities) or num_visible == 0:
            continue

        # Build groups from the sibling layout blocks
        group_base_id = len(groups)
        for gi, layout in enumerate(child_layouts):
            gid = group_base_id + gi
            layout_id_map[id(layout)] = gid

            group_indices = []
            for c in controls:
                comp = comp_map.get(c["index"])
                if comp and getattr(comp, '_parent', None) is layout:
                    c["group"] = gid
                    group_indices.append(c["index"])

            groups.append({
                "id": gid,
                "visible": getattr(layout, 'visible', True),
                "label": getattr(layout, 'label', ''),
                "control_indices": group_indices,
            })

    return groups, layout_id_map


def _probe_dependencies(controls, runner, groups, layout_id_map):
    """Probe .change() callbacks to extract the full interaction map (Phase 2).

    Handles:
    - Visibility toggling (dropdown/radio/checkbox → show/hide groups)
    - Value propagation (preset dropdown → set slider/input values)
    - Choices updates (dropdown A → change dropdown B's options)

    Returns list of dependency entries:
    [
      {
        "trigger": <control_index>,
        "effects": {
          "<value>": {
            "show_groups": [0, 1],     # group IDs to show
            "hide_groups": [2, 3],     # group IDs to hide
            "set_values": {"25": 1.35, "26": 3.0},  # arg_index → value
            "set_choices": {"45": ["a", "b", "c"]},  # arg_index → choices
            "set_visible": {"7": true, "8": false},  # arg_index → visible
          },
          ...
        }
      }
    ]
    """
    _stub = _get_stub_module(); LayoutBlock = _stub.LayoutBlock; StubComponent = _stub.StubComponent

    if not controls:
        return []

    # Reverse maps for output resolution
    comp_to_index = {}
    for i, comp in enumerate(runner.inputs):
        if comp is not None:
            comp_to_index[id(comp)] = i

    # Which control indices belong to this extension?
    ext_indices = {c["index"] for c in controls}

    dependencies = []

    for c in controls:
        comp = runner.inputs[c["index"]] if c["index"] < len(runner.inputs) else None
        if comp is None:
            continue

        handlers = getattr(comp, '_change_handlers', None)
        if not handlers:
            continue

        # Only probe controls with enumerable values
        comp_type = getattr(comp, '_type', '')
        if comp_type in ('dropdown', 'radio'):
            probe_values = list(getattr(comp, 'choices', []))
        elif comp_type == 'checkbox':
            probe_values = [True, False]
        else:
            continue

        if not probe_values:
            continue

        all_effects = {}

        for handler in handlers:
            fn = handler.get('fn')
            inputs = handler.get('inputs', [])
            outputs = handler.get('outputs', [])

            if fn is None or not outputs:
                continue

            # Only probe single-input handlers where input is this component
            if len(inputs) != 1 or inputs[0] is not comp:
                continue

            # Classify each output position
            output_targets = []
            for out in outputs:
                if isinstance(out, LayoutBlock) and id(out) in layout_id_map:
                    output_targets.append(("group", layout_id_map[id(out)]))
                elif isinstance(out, StubComponent):
                    idx = comp_to_index.get(id(out))
                    if idx is not None and idx in ext_indices:
                        output_targets.append(("control", idx))
                    else:
                        output_targets.append(("skip", None))
                else:
                    output_targets.append(("skip", None))

            # Skip handlers with no resolvable targets
            if not any(t[0] != "skip" for t in output_targets):
                continue

            # Probe each value
            try:
                for val in probe_values:
                    result = fn(val)
                    if not isinstance(result, (list, tuple)):
                        continue

                    # Use string key for JSON serialization
                    if isinstance(val, bool):
                        val_key = "true" if val else "false"
                    else:
                        val_key = str(val)

                    if val_key not in all_effects:
                        all_effects[val_key] = {}
                    effects = all_effects[val_key]

                    for i, r in enumerate(result):
                        if i >= len(output_targets):
                            break

                        target_type, target_id = output_targets[i]
                        if target_type == "skip":
                            continue

                        if not isinstance(r, dict):
                            continue

                        if target_type == "group":
                            vis = r.get("visible")
                            if vis is True:
                                effects.setdefault("show_groups", [])
                                if target_id not in effects["show_groups"]:
                                    effects["show_groups"].append(target_id)
                            elif vis is False:
                                effects.setdefault("hide_groups", [])
                                if target_id not in effects["hide_groups"]:
                                    effects["hide_groups"].append(target_id)

                        elif target_type == "control":
                            idx_str = str(target_id)

                            if "value" in r:
                                effects.setdefault("set_values", {})
                                effects["set_values"][idx_str] = r["value"]

                            if "visible" in r:
                                effects.setdefault("set_visible", {})
                                effects["set_visible"][idx_str] = r["visible"]

                            if "choices" in r:
                                effects.setdefault("set_choices", {})
                                effects["set_choices"][idx_str] = r["choices"]

            except Exception as e:
                print(f"[Studio Bridge] Dependency probe failed for "
                      f"control {c['index']} ({c.get('label', '')}): {e}")
                continue

        # Only emit if we got real effects
        if all_effects and any(bool(v) for v in all_effects.values()):
            dependencies.append({
                "trigger": c["index"],
                "effects": all_effects,
            })

    return dependencies


def _build_layout_tree(controls, runner, layout_id_map):
    """Build the full layout tree for an extension's UI (Phase 3).

    Walks the stub's parent/children structure to reconstruct the container
    hierarchy: Accordions, Rows, Columns, Groups — everything the extension
    declared in its ui() method. The frontend renders this tree faithfully
    instead of dumping controls flat.

    Returns a list of tree nodes, or None if no meaningful tree exists.
    Each node is either:
    - Control leaf: {"index": 25}
    - Container: {"type": "accordion", "label": "...", "children": [...]}
    """
    _stub = _get_stub_module(); LayoutBlock = _stub.LayoutBlock; StubComponent = _stub.StubComponent

    # Map of id(stub_component) → control index for this extension
    comp_id_to_index = {}
    for c in controls:
        idx = c["index"]
        if idx < len(runner.inputs) and runner.inputs[idx] is not None:
            comp_id_to_index[id(runner.inputs[idx])] = idx

    if not comp_id_to_index:
        return None

    # Find the root container — walk up from first control's parent chain
    # Stop before the Blocks context (that's the wrapper, not the extension's UI)
    first_comp = runner.inputs[min(c["index"] for c in controls)]
    chain = []
    p = getattr(first_comp, '_parent', None)
    while p is not None and isinstance(p, LayoutBlock):
        if p._type == 'blocks':
            break
        chain.append(p)
        p = getattr(p, '_parent', None)

    if not chain:
        return None  # No container hierarchy — frontend uses flat rendering

    root = chain[-1]  # Highest non-Blocks ancestor

    # Build a set of all layout nodes that contain (directly or nested)
    # at least one of this extension's controls. We use this to prune
    # empty branches from the tree.
    layouts_with_controls = set()
    for comp_id, idx in comp_id_to_index.items():
        comp = runner.inputs[idx]
        p = getattr(comp, '_parent', None)
        while p is not None and isinstance(p, LayoutBlock):
            if p._type == 'blocks':
                break
            layouts_with_controls.add(id(p))
            p = getattr(p, '_parent', None)

    def serialize(node):
        """Recursively serialize a LayoutBlock into a tree node."""
        if id(node) not in layouts_with_controls:
            return None  # Prune — no extension controls in this branch

        result = {"type": node._type}

        if getattr(node, 'label', ''):
            result["label"] = node.label
        if not getattr(node, 'visible', True):
            result["visible"] = False
        if node._type == 'accordion':
            result["open"] = getattr(node, 'open', False)

        # Tag with group ID if this container is a visibility-toggled group
        gid = layout_id_map.get(id(node))
        if gid is not None:
            result["group"] = gid

        # Collect all direct children (sub-layouts AND components) in creation order
        items = []
        for child in getattr(node, '_children', []):
            items.append(('layout', child._id, child))
        for comp in getattr(node, '_components', []):
            items.append(('comp', comp._id, comp))
        items.sort(key=lambda x: x[1])

        children = []
        for kind, _, item in items:
            if kind == 'layout':
                child_node = serialize(item)
                if child_node is not None:
                    children.append(child_node)
            else:
                # Component — only include if it's one of this extension's controls
                idx = comp_id_to_index.get(id(item))
                if idx is not None:
                    children.append({"index": idx})

        if not children:
            return None  # Empty after pruning

        result["children"] = children
        return result

    tree = serialize(root)
    if tree is None:
        return None

    # If root is just a wrapping Accordion (the common pattern), unwrap it.
    # The frontend already wraps each extension in a collapsible ext-group,
    # so a double-nested accordion is redundant.
    if tree.get("type") == "accordion" and "children" in tree:
        return tree["children"]

    return [tree]


# =========================================================================
# PROGRESS STREAMING
# =========================================================================

_progress_connections: list[WebSocket] = []
_uvicorn_loop = None  # Captured on first WebSocket connect

# ── Preview demand-gating ─────────────────────────────────────────────────
# Per-client preview configuration, keyed by the WebSocket object. A client
# declares whether it currently wants previews (toggle on) AND whether its tab
# is visible; the polling thread skips the expensive TAESD decode entirely when
# no client wants one (or Live Painting is active, which always forces it). A
# freshly connected client defaults to enabled+visible so behavior is unchanged
# until it sends its real state — the gate engages the moment it does.
_preview_client_configs: dict = {}
_PREVIEW_CONFIG_DEFAULT = {"enabled": True, "visible": True, "max_edge": 480}

# Cadence bounds for normal-generation previews (Live mode uses its own faster
# gate). Together they cap how often the TAESD decode can run so it never
# contends with a fast-stepping sampler.
_MIN_PREVIEW_WALL = 1.0        # seconds between decodes (floor)
_MIN_PREVIEW_STEP_DELTA = 4    # sampling-steps between decodes (floor)


def _preview_requested() -> bool:
    """True if any connected client currently wants live previews.

    Live Painting always forces previews on regardless of client config. For a
    normal generation, at least one client must have the preview toggle on AND
    a visible tab. Non-throwing.
    """
    try:
        if _is_live_active():
            return True
        for cfg in _preview_client_configs.values():
            if cfg.get("enabled") and cfg.get("visible"):
                return True
    except Exception:
        return True  # on any error, fail open (show previews)
    return False


def _preview_requested_max_edge(default: int = 480) -> int:
    """Largest max_edge any active (enabled + visible) client asked for.

    Broadcast sends one preview to all clients, so use the max so every viewer
    gets at least its requested resolution. Falls back to ``default``.
    """
    best = 0
    try:
        for cfg in _preview_client_configs.values():
            if cfg.get("enabled") and cfg.get("visible"):
                me = int(cfg.get("max_edge") or 0)
                if me > best:
                    best = me
    except Exception:
        return default
    return best if best > 0 else default

# Preview delta protocol: the full ~100KB base64 preview is sent ONLY on the
# tick it was freshly decoded; intervening ticks send preview=None. These hold
# the last decoded preview so a client connecting mid-generation can be caught
# up immediately. preview_id is monotonic per fresh decode, reset on idle-clear.
_last_preview_b64 = None
_last_preview_id = 0

# Preview-decode telemetry ([Studio Perf]). Monotonic counters incremented by
# the polling thread on each fresh TAESD decode; the generate handler samples
# the delta across one generation to report preview cost. Never reset.
_preview_decode_count = 0
_preview_decode_time_total = 0.0


# =========================================================================
# VRAM MANAGEMENT — Auto-unload timer
# =========================================================================

import threading

_auto_unload_timer: Optional[threading.Timer] = None
_auto_unload_enabled = False
_auto_unload_minutes = 10  # default: 10 minutes
_last_generation_time = 0.0  # timestamp of last generation completion


def _cancel_auto_unload():
    """Cancel any pending auto-unload timer."""
    global _auto_unload_timer
    if _auto_unload_timer is not None:
        _auto_unload_timer.cancel()
        _auto_unload_timer = None


def _schedule_auto_unload():
    """Start (or restart) the auto-unload countdown."""
    global _auto_unload_timer
    _cancel_auto_unload()
    if not _auto_unload_enabled or _auto_unload_minutes <= 0:
        return
    _auto_unload_timer = threading.Timer(
        _auto_unload_minutes * 60,
        _do_auto_unload,
    )
    _auto_unload_timer.daemon = True
    _auto_unload_timer.start()


def _do_auto_unload():
    """Called by the timer thread when idle threshold is reached."""
    global _auto_unload_timer
    _auto_unload_timer = None
    try:
        if not hasattr(shared, 'sd_model') or shared.sd_model is None:
            return  # Already unloaded
        sd_models.unload_model_weights()
        _log_vram(f"Auto-unloaded model after {_auto_unload_minutes}min idle")
        # Broadcast unload event to connected WebSocket clients
        # Must use Uvicorn's event loop — WebSocket transports are bound to it
        if _uvicorn_loop and not _uvicorn_loop.is_closed():
            asyncio.run_coroutine_threadsafe(_broadcast_progress({
                "type": "model_unloaded",
                "reason": "idle",
                "minutes": _auto_unload_minutes,
            }), _uvicorn_loop)
    except Exception as e:
        print(f"{TAG} Auto-unload failed: {e}")


def _log_vram(context=""):
    """Log VRAM usage to the Python terminal."""
    try:
        import torch
        if not torch.cuda.is_available():
            print(f"{TAG} VRAM: CUDA not available")
            return
        allocated = torch.cuda.memory_allocated() / (1024 ** 3)
        reserved = torch.cuda.memory_reserved() / (1024 ** 3)
        total = torch.cuda.get_device_properties(0).total_memory / (1024 ** 3)
        prefix = f"{TAG} VRAM"
        if context:
            prefix += f" [{context}]"
        print(f"{prefix}: {allocated:.2f} GB allocated / {reserved:.2f} GB reserved / {total:.2f} GB total")
    except Exception as e:
        print(f"{TAG} VRAM log error: {e}")


_perf_env_logged = False


def _log_perf_environment():
    """Log GPU / launch-flag / attention environment ONCE for perf triage.

    Emitted on the first generation so a captured log identifies the exact
    hardware and launch configuration the timing numbers were produced on.
    Non-throwing; best-effort for every field.
    """
    global _perf_env_logged
    if _perf_env_logged:
        return
    _perf_env_logged = True
    try:
        import torch
        parts = []
        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            parts.append(f"gpu={props.name!r}")
            parts.append(f"vram={props.total_memory / (1024 ** 3):.1f}GB")
            parts.append(f"torch={torch.__version__}")
            parts.append(f"cuda={getattr(torch.version, 'cuda', '?')}")
        else:
            parts.append("gpu=none(cpu)")
        # Launch flags that affect VAE/preview/attention behavior.
        flags = []
        for name in ("opt_sdp_attention", "opt_sdp_no_mem_attention",
                     "xformers", "opt_split_attention", "medvram",
                     "medvram_sdxl", "lowvram", "always_gpu"):
            try:
                if getattr(shared.cmd_opts, name, False):
                    flags.append(name)
            except Exception:
                pass
        parts.append("flags=" + (",".join(flags) if flags else "none"))
        # Neo vae_stream presence (informational — Studio no longer borrows it,
        # but its presence signals Neo's launch-flag VAE-stream path is active).
        try:
            has_vae_stream = getattr(shared.state, "vae_stream", None) is not None
            parts.append(f"neo_vae_stream={'yes' if has_vae_stream else 'no'}")
        except Exception:
            pass
        # Studio preview stream priority (0 = normal band; see _get_preview_stream).
        parts.append("studio_preview_stream_priority=0")
        print(f"{PERF} env: " + " ".join(parts))
    except Exception as e:
        print(f"{PERF} env log error: {e}")


async def _broadcast_progress(data: dict):
    """Send progress to all connected WebSocket clients."""
    dead = []
    for ws in _progress_connections:
        try:
            await ws.send_json(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        if ws in _progress_connections:
            _progress_connections.remove(ws)


def _is_live_active():
    """Check if Live Painting is active. Non-throwing."""
    try:
        import sys
        for name in ['studio_live', 'scripts.studio_live']:
            if name in sys.modules:
                return getattr(sys.modules[name], '_is_active', False)
        return False
    except Exception:
        return False


# Studio-owned preview side stream — created lazily and used for every preview
# decode (we no longer borrow Neo's shared.state.vae_stream; see
# _taesd_decode_preview). Normal priority. Reused across decodes; never recreated.
_studio_preview_stream = None
_studio_preview_stream_failed = False

# Reports which stream / downscale branch the LAST preview decode actually took,
# so the polling thread can emit a truthful status line (F3.1). A silent
# fallback must never again masquerade as a deployed fix.
_preview_path_info = {"stream": "default", "downscale": "n/a"}


def _get_preview_stream():
    """Lazily create one normal-priority CUDA side stream for preview decodes.

    Raw torch only (no Neo imports). Returns None on CPU-only builds or if
    stream creation fails.

    Priority note: in PyTorch, a *lower* priority number means *higher*
    scheduling priority. The old value ``priority=-1`` (mislabeled "low") gave
    the preview stream HIGHER priority than the sampler's default-stream work,
    letting cosmetic TAESD decodes preempt the actual generation. We use
    ``priority=0`` (the default/normal band) so previews overlap the sampler
    without ever contending ahead of it.
    """
    global _studio_preview_stream, _studio_preview_stream_failed
    if _studio_preview_stream_failed:
        return None
    if _studio_preview_stream is None:
        try:
            import torch
            if torch.cuda.is_available():
                _studio_preview_stream = torch.cuda.Stream(priority=0)  # normal priority
            else:
                _studio_preview_stream_failed = True
                return None
        except Exception:
            _studio_preview_stream_failed = True
            return None
    return _studio_preview_stream


def _resize_latent_for_preview(sample, max_edge, decoder_scale=8):
    """Downscale a single latent tensor so its TAESD decode lands near max_edge.

    ``sample`` is a 3-D latent ``[C, H, W]`` (already indexed out of the batch)
    or a 4-D ``[1, C, H, W]``. The TAESD/VAE decoder upsamples by
    ``decoder_scale`` (8 for every SD/SDXL VAE), so decoding the full latent
    yields an ``H*8 x W*8`` image. We interpolate the latent down so the DECODED
    long edge is ~``max_edge`` — moving the downscale AHEAD of the expensive
    decode + CPU transfer instead of after it. At hires this cuts the TAESD
    pixel work from ~15.7M px to ~0.4M px.

    Returns the resized latent (same rank as input), or the original if it is
    already small enough, ``max_edge <= 0``, or anything unexpected. Never
    raises — a resize failure falls back to a full-size decode.
    """
    import torch
    if max_edge <= 0 or sample is None:
        return sample
    try:
        if sample.ndim == 3:
            _, h, w = sample.shape
            batched = sample.unsqueeze(0)
            squeeze = True
        elif sample.ndim == 4:
            _, _, h, w = sample.shape
            batched = sample
            squeeze = False
        else:
            return sample  # unexpected rank — let the decoder handle it
        img_long = max(h, w) * decoder_scale
        if img_long <= max_edge:
            return sample  # decoded image already within budget
        scale = max_edge / img_long
        target_h = max(1, int(round(h * scale)))
        target_w = max(1, int(round(w * scale)))
        resized = torch.nn.functional.interpolate(
            batched, size=(target_h, target_w),
            mode="bilinear", align_corners=False)
        return resized[0] if squeeze else resized
    except Exception:
        return sample  # any failure → decode at full latent size


def _taesd_decode_preview(latent, max_edge=0):
    """Decode a latent tensor to a PIL Image using TAESD.

    Fast (~5-10ms) at 512-class latents, but at hires resolutions the cost is
    dominated by the full-resolution ``.cpu()`` transfer (a 2048x2560x3 float
    tensor is ~63MB) and the uint8 pixel pass over ~15.7M pixels under the GIL.
    Neo's ``single_sample_to_image`` hardcodes that full-res transfer, so when a
    downscale is requested (``max_edge > 0``) we replicate its TAESD decode
    inline and interpolate on-GPU BEFORE the transfer — shrinking the transfer
    to ~1MB and the CPU pixel pass to ~0.4M pixels.

    The decode runs on a side CUDA stream so it overlaps the sampler on the
    default stream instead of serializing with it. Stream preference order:
    Studio's own lazily-created normal-priority side stream → the default
    stream. We deliberately do NOT borrow ``shared.state.vae_stream`` merely
    because it exists — its priority is set by Neo (often the launch-flag
    high-priority path) and it is the same stream Neo uses for its own full VAE
    decode of the final image, so borrowing it can serialize a cosmetic preview
    behind (or ahead of) real work. A Studio-owned normal-priority stream has
    predictable scheduling. The chosen branch is recorded in
    ``_preview_path_info`` for the status line.

    Falls back gracefully if TAESD model isn't available.
    max_edge=0 means no downscale (full generation resolution).
    """
    import numpy as np
    import torch
    from modules import sd_samplers_common

    # ── Stream selection (Studio-owned side stream → default) ──
    side_stream = None
    stream_label = "default"
    s = _get_preview_stream()
    if s is not None:
        side_stream = s
        stream_label = "studio"

    downscale_label = "latent-first" if max_edge > 0 else "full-res"

    def _decode_and_downscale(sample):
        if max_edge > 0:
            # ── Latent-first downscale ──
            # Shrink the LATENT before TAESD so the decoder itself processes
            # far fewer pixels, then do the (now tiny) CPU transfer. This cuts
            # the dominant cost — the decode + transfer — not just the transfer.
            sample = _resize_latent_for_preview(sample, max_edge)
            t = sd_samplers_common.samples_to_images_tensor(
                sample.unsqueeze(0), approximation=3)  # TAESD, on GPU, [-1,1]
            t = t * 0.5 + 0.5
            # Safety net: if decoder_scale differed from 8 and the decoded image
            # still overshoots max_edge, do a final cheap pixel-space resize.
            _, _, h, w = t.shape
            long_edge = max(w, h)
            if long_edge > max_edge:
                scale = max_edge / long_edge
                target_h = max(1, int(round(h * scale)))
                target_w = max(1, int(round(w * scale)))
                t = torch.nn.functional.interpolate(
                    t, size=(target_h, target_w),
                    mode="bilinear", align_corners=False)
            # Blocking transfer = the synchronization point that ends the side
            # stream's work for this decode (no CUDA events needed).
            x = t[0].to("cpu", non_blocking=False)  # tiny transfer
            x = (x.clamp(0, 1) * 255.0).round().to(torch.uint8)
            return Image.fromarray(np.moveaxis(x.numpy(), 0, 2))
        # Full-resolution path (Live mode): keep Neo's decoder.
        return sd_samplers_common.single_sample_to_image(sample, approximation=3)

    with torch.inference_mode():
        if side_stream is not None:
            try:
                # Clone decouples from the sampler's live latent buffer so the
                # sampler can overwrite it while the side stream reads our copy
                # (cheap at latent size, a few MB).
                lat = latent.detach().clone()
                side_stream.wait_stream(torch.cuda.current_stream())
                with torch.cuda.stream(side_stream):
                    sample = lat[0] if lat.ndim == 4 else lat
                    preview_img = _decode_and_downscale(sample)
                _preview_path_info["stream"] = stream_label
                _preview_path_info["downscale"] = downscale_label
                return preview_img
            except Exception:
                # Side-stream path failed — fall through to the default stream.
                pass
        sample = latent[0] if latent.ndim == 4 else latent
        preview_img = _decode_and_downscale(sample)
    _preview_path_info["stream"] = "default"
    _preview_path_info["downscale"] = downscale_label
    return preview_img


def _progress_polling_thread():
    """Background thread that polls shared.state and broadcasts progress.

    Uses TAESD for fast preview decodes (~5-10ms) instead of full VAE
    (~50-150ms). Adaptive intervals: faster during Live Painting, normal
    during standard generation. Previews are sent at higher resolution
    than the old 240px cap.

    Must be resilient to both --nowebui and Gradio launch modes.
    In Gradio mode, Forge's own progress system may read/write
    shared.state concurrently — all reads are snapshot-guarded.
    """
    global _last_preview_b64, _last_preview_id
    global _preview_decode_count, _preview_decode_time_total
    _idle_ticks = [0]  # count consecutive idle polls to debounce
    _logged_error = [False]  # only log first error to avoid spam
    _last_preview_step = [(-1, -1)]  # last (job_no, step) we decoded a preview for
    _last_preview_time = [0.0]  # timestamp of last TAESD decode
    _last_status_key = [None]  # last preview-path status line emitted (re-log on change)
    # Step-duration tracking — used to scale preview_interval so previews fire
    # at most every other step regardless of resolution (hires steps are slow).
    _last_step_seen = [(-1, -1)]  # last (job_no, step) observed (decoded or not)
    _last_step_change_time = [0.0]  # timestamp of last observed step change
    _measured_step_dur = [0.0]  # EMA of seconds-per-step

    while True:
        # Adaptive poll rate: faster during Live for snappier previews
        live_mode = _is_live_active()
        time.sleep(0.2 if live_mode else 0.4)

        if not _progress_connections:
            continue

        # Wait for Uvicorn's loop to be captured
        if not _uvicorn_loop or _uvicorn_loop.is_closed():
            continue

        try:
            # Snapshot state values to avoid race conditions with
            # Gradio's progress system reading/writing simultaneously
            job_count = shared.state.job_count or 0
            job_no = shared.state.job_no or 0
            sampling_step = shared.state.sampling_step or 0
            sampling_steps = shared.state.sampling_steps or 0
            textinfo = shared.state.textinfo or ""

            # Check if generation is active — use multiple signals to avoid
            # missing progress during job transitions where job_count briefly = 0
            has_jobs = job_count > 0 or sampling_steps > 0
            has_text = bool(textinfo)
            is_active = has_jobs or has_text

            if not is_active:
                _idle_ticks[0] += 1
                if _idle_ticks[0] > 3:  # ~1.2s of idle before clearing preview
                    _last_preview_b64 = None
                    _last_preview_id = 0
                    _last_preview_step[0] = (-1, -1)
                    # Reset step-duration tracking so the next generation starts
                    # at the floor interval until it has measured its own steps.
                    _last_step_seen[0] = (-1, -1)
                    _last_step_change_time[0] = 0.0
                    _measured_step_dur[0] = 0.0
                    _last_status_key[0] = None  # re-emit status line next gen
                continue

            _idle_ticks[0] = 0
            _logged_error[0] = False  # reset error flag when active

            progress = 0.0
            if job_count > 0:
                progress += job_no / job_count
            if sampling_steps > 0:
                progress += (1 / max(1, job_count)) * (
                    sampling_step / sampling_steps
                )

            now = time.time()

            # Measure seconds-per-step from observed sampling_step advances
            # (independent of whether we decode a preview this tick). Only count
            # forward progress within the same job; a job boundary resets step
            # to 0 and must not be measured as a duration.
            cur_step_key = (job_no, sampling_step)
            prev_job, prev_step = _last_step_seen[0]
            if cur_step_key != (prev_job, prev_step):
                if (job_no == prev_job and sampling_step > prev_step
                        and _last_step_change_time[0] > 0):
                    delta_steps = sampling_step - prev_step
                    dur = (now - _last_step_change_time[0]) / max(1, delta_steps)
                    if dur > 0:
                        if _measured_step_dur[0] <= 0:
                            _measured_step_dur[0] = dur
                        else:  # light EMA to smooth poll-rate quantization
                            _measured_step_dur[0] = (
                                0.5 * _measured_step_dur[0] + 0.5 * dur)
                _last_step_seen[0] = cur_step_key
                _last_step_change_time[0] = now

            preview_b64 = None
            # Demand gate: skip the expensive TAESD decode entirely when no
            # client wants a preview (toggle off or tab hidden) and Live Painting
            # is inactive. Progress (step/percent/textinfo) still broadcasts
            # below — only the decode is gated. This is the single biggest win
            # for the Preview-off case.
            preview_wanted = live_mode or _preview_requested()

            # Adaptive preview settings:
            #   Live mode:   decode every 0.3s, full resolution (no downscale)
            #   Normal gen:  scale the gate with measured step duration so
            #                previews fire at most every other step (hires steps
            #                run ~1.7-2.0s each). Two bounds cap the cadence:
            #                  • min wall-clock 1.0s between decodes
            #                  • min 4 sampling-steps between decodes
            #                so fast base-pass steps can't trigger a decode every
            #                tick and contend with the sampler.
            if live_mode:
                preview_interval = 0.3
            else:
                preview_interval = max(_MIN_PREVIEW_WALL, 2.0 * _measured_step_dur[0])
            preview_max_edge = 0 if live_mode else _preview_requested_max_edge(480)

            current_key = (job_no, sampling_step)
            step_changed = current_key != _last_preview_step[0]
            interval_ok = (now - _last_preview_time[0]) >= preview_interval
            # Step-delta bound (normal gen only): require a minimum number of
            # sampling steps since the last decoded preview, EXCEPT always allow:
            #   • a new job (batch image boundary),
            #   • a within-job step RESET — the base→hires (or base→refiner)
            #     transition restarts sampling_step at 0 under the SAME job_no,
            #     so sampling_step < last_pv_step signals a new pass whose
            #     previews must resume immediately (otherwise the whole hires
            #     pass shows a frozen base image until its final step), and
            #   • the final step (so short/low-step generations still preview).
            last_pv_job, last_pv_step = _last_preview_step[0]
            is_last_step = sampling_steps > 0 and sampling_step >= sampling_steps - 1
            if live_mode:
                step_delta_ok = True
            else:
                step_delta_ok = (
                    job_no != last_pv_job
                    or sampling_step < last_pv_step
                    or (sampling_step - last_pv_step) >= _MIN_PREVIEW_STEP_DELTA
                    or is_last_step
                )
            should_decode = (
                preview_wanted and step_changed and interval_ok and step_delta_ok
            )

            if should_decode:
                _pv_decode_t0 = time.time()
                try:
                    # TAESD decode — fast (~5-10ms), doesn't stall the sampler.
                    # Reads current_latent directly instead of going through
                    # set_current_image() which does a full VAE decode.
                    latent = shared.state.current_latent
                    if latent is not None:
                        # Skip video latents (5D) — TAESD image decoder
                        # doesn't handle video; fall back to existing path
                        if latent.ndim == 5:
                            shared.state.set_current_image()
                            current_img = shared.state.current_image
                            if current_img:
                                preview_b64 = _pil_to_preview_b64(current_img)
                        else:
                            preview_img = _taesd_decode_preview(latent, preview_max_edge)
                            preview_b64 = _pil_to_preview_b64(preview_img)

                        if preview_b64:
                            # Mandatory status line (F3.1): report the ACTUAL
                            # stream / interval / downscale this decode used, so
                            # no change can silently no-op. Re-emit whenever the
                            # path changes (e.g. base → hires raises the scaled
                            # interval), so each phase is visible exactly once.
                            if latent is not None and latent.ndim != 5:
                                _scaled = (not live_mode) and (
                                    2.0 * _measured_step_dur[0] > _MIN_PREVIEW_WALL)
                                _kind = "scaled" if _scaled else "fixed"
                                _skey = (_preview_path_info["stream"],
                                         round(preview_interval, 1), _kind,
                                         _preview_path_info["downscale"],
                                         preview_max_edge)
                                if _skey != _last_status_key[0]:
                                    _last_status_key[0] = _skey
                                    print(f"{TAG} Preview path: "
                                          f"stream={_preview_path_info['stream']} "
                                          f"interval={preview_interval:.2f}s ({_kind}) "
                                          f"downscale={_preview_path_info['downscale']} "
                                          f"max_edge={preview_max_edge}")
                            # Fresh decode: cache it + bump the monotonic id.
                            # This tick carries the image; later ticks send
                            # preview=None until the next fresh decode.
                            _last_preview_b64 = preview_b64
                            _last_preview_id += 1
                            _last_preview_step[0] = current_key
                            _last_preview_time[0] = now
                            # Telemetry: count this fresh decode + its wall time
                            # so the generate handler can report preview cost.
                            _preview_decode_count += 1
                            _preview_decode_time_total += time.time() - _pv_decode_t0
                except Exception:
                    # Preview decode failed — non-fatal, cached preview is used below.
                    # Common during model reloads where shared.sd_model briefly lacks
                    # model_config; not actionable, so don't log.
                    pass

            data = {
                "type": "progress",
                "progress": min(1.0, progress),
                "step": sampling_step,
                "total_steps": sampling_steps,
                "job": job_no,
                "job_count": job_count,
                # Delta protocol: carry the image ONLY on the fresh-decode tick
                # (preview_b64 is None otherwise). preview_id lets the client
                # skip duplicate paints and detect a missed image.
                "preview": preview_b64,
                "preview_id": _last_preview_id,
                "textinfo": textinfo,
            }

            asyncio.run_coroutine_threadsafe(_broadcast_progress(data), _uvicorn_loop)

        except Exception as e:
            if not _logged_error[0]:
                print(f"{TAG} Progress poll error: {e}")
                _logged_error[0] = True


# =========================================================================
# ROUTE REGISTRATION
# =========================================================================

def setup_studio_routes(app: FastAPI):
    """Register all Studio routes onto Forge's FastAPI app."""

    print(f"{TAG} Registering routes...")

    # Civitai metadata enricher — set later if the optional module loads.
    # Captured by the get_loras closure so the response is decorated with
    # cached metadata when available. Defined here so the closure can see it.
    _civitai_enrich = None
    # Civitai Helper sidecar reader (<stem>.civitai.info) — same lifecycle.
    _civitai_read_ch = None
    # Arch strings keyed by checkpoint filename, filled as a side effect of
    # check_model_te header inspections. The checkpoint browser reads this
    # cache only — it never bulk-scans headers at browse time.
    _model_arch_cache = {}

    # ------------------------------------------------------------------
    # Standalone mode: root redirect + file serving
    # ------------------------------------------------------------------
    # In --nowebui mode, Gradio isn't running so "/" is unhandled and
    # the /file=<path> route (used for serving output images & tag-
    # complete assets) doesn't exist. These two routes fill that gap.

    @app.get("/")
    async def root_redirect():
        return RedirectResponse(url="/studio")

    @app.get("/file={file_path:path}")
    async def serve_local_file(file_path: str):
        """Serve local files — replaces Gradio's /file= route for standalone mode.

        In normal (Gradio) mode Gradio handles this route, so this handler
        simply never matches. In --nowebui mode it's the only provider.
        """
        import urllib.parse
        file_path = urllib.parse.unquote(file_path)

        resolved = Path(file_path)
        if not resolved.is_absolute():
            resolved = Path.cwd() / resolved
        resolved = resolved.resolve()

        # Security: file must live under the Forge root OR the configured
        # output directory (which may be on a different drive/mount)
        allowed_roots = [str(Path.cwd().resolve())]
        try:
            _outdir = shared.opts.data.get("outdir_samples", "") or shared.opts.data.get("outdir_img2img_samples", "")
            if _outdir:
                allowed_roots.append(str(Path(_outdir).resolve()))
            # Also allow the parent of common output subdirs
            for _key in ("outdir_txt2img_samples", "outdir_img2img_samples", "outdir_save"):
                _d = shared.opts.data.get(_key, "")
                if _d:
                    allowed_roots.append(str(Path(_d).resolve()))
                    # Parent covers sibling folders (e.g. output/ when config says output/txt2img-images/)
                    allowed_roots.append(str(Path(_d).resolve().parent))
        except Exception:
            log.exception("Failed to read output config for allowed-roots check")

        # WP-L2: registered session scratch files live under the extension
        # root (outside the output roots above) — allow exact matches only.
        # Everything else about this route's validation is untouched (F1).
        if not _is_path_within_roots(resolved, allowed_roots) \
                and str(resolved) not in _SESSION_ALLOWED_FILES:
            return JSONResponse({"error": "Access denied"}, status_code=403)
        if not resolved.is_file():
            return JSONResponse({"error": "Not found"}, status_code=404)

        # Guess media type from suffix
        suffix_map = {
            ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".webp": "image/webp", ".gif": "image/gif", ".txt": "text/plain",
            ".json": "application/json", ".csv": "text/csv",
            ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
        }
        media = suffix_map.get(resolved.suffix.lower())
        return FileResponse(str(resolved), media_type=media)

    # ------------------------------------------------------------------
    # Generation
    # ------------------------------------------------------------------

    @app.post("/studio/generate", response_model=GenerateResponse)
    async def generate(req: GenerateRequest):
        # --- Defaults actions (reuse working endpoint) ---
        print(f"{TAG} generate endpoint called: action={req.action!r}")
        _here = Path(__file__).parent
        _ext_root = _here if (_here / "frontend").is_dir() else _here.parent
        _defaults_file = _ext_root / "user_defaults.json"

        if req.action == "save_defaults" and req.defaults_data is not None:
            try:
                _atomic_write_json(_defaults_file, req.defaults_data)
                print(f"{TAG} Defaults saved ({len(req.defaults_data)} keys)")
                return GenerateResponse(settings={"defaults_saved": True})
            except Exception as e:
                log.exception("Failed to write user defaults")
                return GenerateResponse(error=f"Defaults save failed: {e}")

        if req.action == "load_defaults":
            if _defaults_file.exists():
                try:
                    data = json.loads(_defaults_file.read_text())
                    return GenerateResponse(settings=data)
                except Exception:
                    log.exception("Corrupted user_defaults.json, returning empty settings")
                    return GenerateResponse(settings={})
            return GenerateResponse(settings={})

        if req.action == "delete_defaults":
            if _defaults_file.exists():
                _defaults_file.unlink()
            return GenerateResponse(settings={"defaults_deleted": True})

        # --- Normal generation ---
        _cancel_auto_unload()
        # [Studio Perf] telemetry — env logged once; per-gen timing bracketed
        # around the compute call and the save loop below.
        _log_perf_environment()
        _perf_handler_t0 = time.time()
        _perf_pv_count0 = _preview_decode_count
        _perf_pv_time0 = _preview_decode_time_total
        _perf_compute = 0.0
        run_generation = _import("studio_generation", "run_generation")

        # Diagnostic: log the AR randomization flags exactly as the request
        # carried them, so logs distinguish "requested" (this line) from
        # "fired" (studio_generation's "[Studio AR] Randomized" line). If this
        # logs all-False yet a Randomized line still appears, the bug is
        # backend-side, not frontend toggle state.
        if req.ar_rand_base or req.ar_rand_ratio or req.ar_rand_orientation:
            print(f"{TAG} AR randomize requested by client: "
                  f"base={req.ar_rand_base} ratio={req.ar_rand_ratio} "
                  f"orientation={req.ar_rand_orientation}")

        ad_slots = req.ad_slots + [ADSlotParams()] * max(0, 3 - len(req.ad_slots))
        ad1_args = _flatten_ad_slot(ad_slots[0])
        ad2_args = _flatten_ad_slot(ad_slots[1])
        ad3_args = _flatten_ad_slot(ad_slots[2])

        cn1_img = _decode_b64_to_numpy(req.cn1_upload_b64)
        cn2_img = _decode_b64_to_numpy(req.cn2_upload_b64)

        # UX-015: Suppress disabled extensions by forcing their boolean args
        # (enable toggles) to False. This prevents alwayson scripts from running
        # with stale defaults when the user has toggled them off in Studio.
        ext_args = dict(req.extension_args) if req.extension_args else {}
        # Suppress extensions that the user has disabled in Studio's Settings toggle.
        if req.disabled_extensions:
            try:
                import modules.scripts as mod_scripts
                runner = mod_scripts.scripts_img2img
                if runner:
                    disabled_set = {n.lower() for n in req.disabled_extensions}
                    for script in runner.alwayson_scripts:
                        try:
                            title = script.title().strip().lower() if callable(getattr(script, 'title', None)) else ""
                        except Exception:
                            title = ""
                        if title not in disabled_set:
                            continue
                        if not hasattr(script, 'args_from') or script.args_from is None:
                            continue
                        # Force all boolean-valued args to False (catches enable toggles)
                        for i in range(script.args_from, script.args_to):
                            if i < len(runner.inputs) and runner.inputs[i] is not None:
                                val = getattr(runner.inputs[i], 'value', None)
                                if isinstance(val, bool):
                                    ext_args[str(i)] = False
                        print(f"{TAG} Suppressed disabled extension: {title}")
            except Exception:
                log.exception("Extension suppression failed")

        _perf_compute_t0 = time.time()
        try:
            result = await asyncio.to_thread(
                run_generation,
                req.canvas_b64, req.mask_b64, req.fg_b64, req.mode, req.inpaint_mode,
                req.prompt, req.neg_prompt,
                req.steps, req.sampler_name, req.schedule_type, req.cfg_scale, req.denoising,
                req.width, req.height, req.seed, req.batch_count, req.batch_size,
                req.mask_blur, req.inpainting_fill, req.inpaint_full_res, req.inpaint_pad,
                req.soft_inpaint_enabled, req.soft_inpaint_schedule_bias,
                req.soft_inpaint_preservation, req.soft_inpaint_transition_contrast,
                req.soft_inpaint_mask_influence, req.soft_inpaint_diff_threshold,
                req.soft_inpaint_diff_contrast,
                req.hr_enable, req.hr_upscaler, req.hr_scale, req.hr_steps,
                req.hr_denoise, req.hr_cfg, req.hr_checkpoint,
                req.ad_enable,
                *ad1_args, *ad2_args, *ad3_args,
                req.regions_json, req.cn_json,
                cn1_img, cn2_img,
                req.subseed, req.subseed_strength,
                req.seed_resize_from_w, req.seed_resize_from_h,
                req.is_txt2img,
                ext_args or None,
                {
                    "rand_base": req.ar_rand_base,
                    "rand_ratio": req.ar_rand_ratio,
                    "rand_orientation": req.ar_rand_orientation,
                    "base_pool": req.ar_base_pool,
                    "ratio_pool": req.ar_ratio_pool,
                } if (req.ar_rand_base or req.ar_rand_ratio or req.ar_rand_orientation) else None,
                # High Precision: only worth the extra VAE decode when
                # we'll actually save the resulting sidecar to disk.
                bool(req.high_precision and req.save_outputs),
                bool(req.studio_dynamic_prompts_enabled),
                watermark=(
                    {
                        "enable": True,
                        "name": req.watermark_name,
                        "position": req.watermark_position,
                        "opacity": req.watermark_opacity,
                        "scale": req.watermark_scale,
                        "margin": req.watermark_margin,
                        "rotation": req.watermark_rotation,
                    }
                    if (req.watermark_enable and req.watermark_name.strip())
                    else None
                ),
            )
        except Exception as e:
            log.exception("Generation handler failed")
            return GenerateResponse(error=str(e))
        _perf_compute = time.time() - _perf_compute_t0

        if not result or not isinstance(result, (list, tuple)) or len(result) < 5:
            return GenerateResponse(error="Generation returned no result")

        # run_generation returns a 7-tuple (V2: float arrays + blend masks).
        # Tolerate the V1 6-tuple and the pre-HP 5-tuple if an older
        # module is in the import cache.
        images_list = result[0]
        info_html = result[1]
        result_b64 = result[2]
        settings_json = result[3]
        task_id = result[4]
        float_arrays = list(result[5]) if len(result) >= 6 else []
        blend_masks = list(result[6]) if len(result) >= 7 else []
        # Privacy-safe HP capture stats, parallel to float_arrays (8th item;
        # absent on older cached modules → empty list).
        float_stats = list(result[7]) if len(result) >= 8 else []

        _perf_save_t0 = time.time()  # save loop + postprocess begins here
        images_b64 = []
        image_paths = []
        float_paths = []  # parallel to images_b64; "" when no sidecar saved
        mask_paths = []   # parallel to images_b64; "" when no blend-mask sidecar
        content_hashes = []  # parallel to images_b64; "" when not saved/hashed
        session_entries = []  # parallel to images_b64; {entry_id, source, path} (WP-L2)
        _sid = (req.session_id or "").strip()
        _sid_ok = bool(_SESSION_ID_RE.match(_sid))

        # Auto-save images to output/studio/{mode}/ (unless disabled by user)
        mode_folder = {"Create": "create", "Edit": "edit", "img2img": "img2img"}.get(req.mode, "create")
        # User-chosen save folder (Settings → Save folder / first-run setup).
        # When set we use it as the base and keep the {mode}/{date} substructure
        # for organization; when blank we fall back to Forge's output dir.
        _save_override = (req.save_dir or "").strip()
        _save_dir_notice = None
        # Security: only honor a custom save_dir that resolves inside a safe
        # write root (Forge output tree, a trusted folder, or a STUDIO_SAVE_ROOTS
        # entry). A random/cross-site client cannot redirect writes to an
        # arbitrary path. Surface a non-fatal notice so the user knows their
        # configured folder was skipped rather than silently losing it.
        if _save_override and not _safe_write_root(_save_override):
            # Permanent diagnostic: a rejection must always say WHY. Log the
            # raw + resolved candidate and the full resolved trusted-roots set
            # so a "rejected" line is self-explanatory (F1). _safe_write_root
            # itself was NOT changed by the WP6 is_relative_to swap (that only
            # touched /studio/file); this line localizes the real cause.
            try:
                _cand_resolved = _resolved(_save_override)
                _cand_resolved = str(_cand_resolved) if _cand_resolved else None
            except Exception:
                _cand_resolved = None
            try:
                _roots_dump = sorted(_safe_write_roots())
            except Exception as _re:
                _roots_dump = [f"<roots unavailable: {_re}>"]
            log.warning(
                "save_dir rejected (not a trusted root) — using default output dir. "
                "candidate=%r resolved=%r trusted_roots=%r",
                _save_override, _cand_resolved, _roots_dump,
            )
            _save_dir_notice = ("Your custom save folder isn't trusted yet, so images were saved to the "
                                "default output folder. Open Settings → Save folder and click “Trust folder”.")
            _save_override = ""
        _neo_scan_register = None  # Neo scan-folder to register after mkdir
        if _save_override:
            try:
                base_outdir = str(Path(_save_override).expanduser())
                output_dir = Path(base_outdir) / mode_folder / date.today().strftime("%Y-%m-%d")
            except Exception:
                log.exception("Invalid save_dir override — falling back to default")
                _save_override = ""
        if not _save_override and (req.save_tree or "").strip().lower() == "neo":
            # Settings → Save tree = Neo: save into Neo's own per-mode output
            # dirs, exactly where its stock UI would. Scope limit (stated in
            # the settings copy): Studio keeps its own filenames and metadata
            # embedding; Neo's filename_pattern is not honored. getattr on
            # shared.opts resolves Neo's defaults for options the user never
            # customized (opts.data only holds overrides).
            try:
                from modules.paths import data_path
            except Exception:
                data_path = os.path.abspath(".")
            _leaf = "txt2img-images" if req.is_txt2img else "img2img-images"
            _mode_key = "outdir_txt2img_samples" if req.is_txt2img else "outdir_img2img_samples"
            try:
                neo_outdir = (
                    getattr(shared.opts, "outdir_samples", "")  # "save all images to same dir" override
                    or getattr(shared.opts, _mode_key, "")
                    or os.path.join("outputs", _leaf)
                )
            except Exception:
                neo_outdir = os.path.join("outputs", _leaf)
            if not os.path.isabs(neo_outdir):
                neo_outdir = os.path.join(data_path, neo_outdir)
            output_dir = Path(neo_outdir)
            # Honor Neo's date-subfolder convention ([date] is its default
            # directories pattern) when save_to_dirs is set
            try:
                if bool(getattr(shared.opts, "save_to_dirs", False)):
                    output_dir = output_dir / date.today().strftime("%Y-%m-%d")
            except Exception:
                pass
            # Graceful switch: register the Neo dir in the Gallery scan set
            # so old (Studio-tree) and new images coexist; no files move,
            # and Studio's own root stays linked. Content-hash identity in
            # the gallery DB makes the union safe. Deferred until after the
            # mkdir below so the dir exists before any watcher inspects it.
            _neo_scan_register = str(Path(neo_outdir))
        elif not _save_override:
            try:
                # Use the same output dir logic as the generation pipeline
                base_outdir = shared.opts.data.get("outdir_samples", "")
                if not base_outdir:
                    base_outdir = shared.opts.data.get("outdir_img2img_samples", "")
                if not base_outdir:
                    from modules.paths import data_path
                    base_outdir = os.path.join(data_path, "output")
                if os.path.basename(base_outdir) in ("txt2img-images", "img2img-images"):
                    base_outdir = os.path.dirname(base_outdir)
            except Exception:
                base_outdir = os.path.abspath("output")
            output_dir = Path(base_outdir) / "studio" / mode_folder / date.today().strftime("%Y-%m-%d")
        if req.save_outputs:
            output_dir.mkdir(parents=True, exist_ok=True)
        # Register the Neo output dir in the Gallery scan set now that it
        # exists on disk (see the save_tree=neo branch above).
        if _neo_scan_register:
            try:
                _import("studio_gallery", "ensure_scan_folder")(_neo_scan_register)
            except Exception:
                log.debug("could not register Neo outdir as gallery scan folder", exc_info=True)

        # Pre-parse settings_json once (was being re-parsed per image)
        _parsed_settings = None
        _parsed_infotexts = []
        if settings_json:
            try:
                _parsed_settings = json.loads(settings_json)
                _parsed_infotexts = _parsed_settings.get("infotexts", [])
            except Exception:
                log.exception("Settings JSON parse failed in generation handler")

        # Preserve raw wildcard template in embedded metadata — Forge's infotext
        # only contains the resolved prompt, so we append the un-resolved source.
        if _parsed_settings and _parsed_infotexts:
            _raw_prompt = _parsed_settings.get("prompt", "")
            if _raw_prompt:
                for idx in range(len(_parsed_infotexts)):
                    if _parsed_infotexts[idx] and "Template:" not in _parsed_infotexts[idx]:
                        first_line = _parsed_infotexts[idx].split("\n")[0].strip()
                        if first_line != _raw_prompt.strip():
                            _parsed_infotexts[idx] += f"\nTemplate: {_raw_prompt}"

            # Tag images generated with Studio-native expansion so the
            # source ("default" vs "custom" wildcard folder mode) is
            # recoverable from embedded metadata. Privacy: only the
            # mode label is stored — never the absolute folder path.
            if _parsed_settings.get("studio_dynamic_prompts_active"):
                source_label = _parsed_settings.get("studio_dynamic_prompts_source", "default")
                for idx in range(len(_parsed_infotexts)):
                    if _parsed_infotexts[idx] and "Studio dynamic prompts:" not in _parsed_infotexts[idx]:
                        _parsed_infotexts[idx] += f"\nStudio dynamic prompts: {source_label}"

        try:
            _parsed_base_seed = int(_parsed_settings.get("seed", -1)) if _parsed_settings else -1
        except Exception:
            _parsed_base_seed = -1

        _base_counter = _next_forge_counter(output_dir) if req.save_outputs else 1

        for i, img in enumerate(images_list or []):
            _per_image_hash = ""
            _per_image_float_path = ""
            _per_image_mask_path = ""
            _img_float = float_arrays[i] if i < len(float_arrays) else None
            _img_mask = blend_masks[i] if i < len(blend_masks) else None
            _img_stats = float_stats[i] if i < len(float_stats) else None
            # Detect whether THIS image gets saved below (the save branches
            # append to image_paths only on success).
            _n_paths_before = len(image_paths)
            if isinstance(img, Image.Image):
                # When saving as PNG, encode once to buffer and reuse for both
                # disk save and b64 response (avoids double PNG compression).
                if req.save_outputs and req.save_format == "png":
                    try:
                        ext = "png"
                        image_seed = (_parsed_base_seed + i) if _parsed_base_seed != -1 else 0
                        counter = _base_counter + i
                        while True:
                            fname = f"Studio-{counter:05d}-{image_seed}.{ext}"
                            fpath = output_dir / fname
                            if not fpath.exists():
                                break
                            counter += 1
                        save_kwargs = {}
                        if req.embed_metadata and _parsed_infotexts:
                            try:
                                if i < len(_parsed_infotexts) and _parsed_infotexts[i]:
                                    from PIL.PngImagePlugin import PngInfo
                                    pnginfo = PngInfo()
                                    pnginfo.add_text("parameters", _parsed_infotexts[i])
                                    save_kwargs["pnginfo"] = pnginfo
                            except Exception:
                                log.exception("Failed to embed PNG metadata")
                        # Encode to buffer once, use for both disk and b64
                        buf = io.BytesIO()
                        img.save(buf, format="PNG", icc_profile=_SRGB_ICC, **save_kwargs)
                        png_bytes = buf.getvalue()
                        # Write to disk from buffer (no re-encode). Disk-space
                        # preflight catches "no space left" before a half-
                        # written PNG hits disk.
                        _ensure_disk_space(fpath.parent)
                        with open(str(fpath), "wb") as f:
                            f.write(png_bytes)
                        image_paths.append(str(fpath))
                        _register_served_file(str(fpath))
                        # High Precision: write the float32 sidecar next
                        # to the PNG. Best-effort; failure here doesn't
                        # affect the saved image.
                        if _img_float is not None:
                            _per_image_float_path = _save_float_sidecar(fpath, _img_float, _img_stats)
                            # V2: AD/brush blend-mask sidecar. Only meaningful
                            # when there's a float to composite over, so it's
                            # gated on float having been saved.
                            if _img_mask is not None:
                                _per_image_mask_path = _save_mask_sidecar(fpath, _img_mask)
                        # Hash the saved image so the frontend can look it up in
                        # Gallery (Canvas → Gallery detail view bridge).
                        try:
                            _hash_fn = _import("studio_gallery", "compute_content_hash")
                            _gallery_save = _import("studio_gallery", "save_metadata_by_hash")
                            if _hash_fn:
                                # PNG is lossless — hash the original PIL pixels directly (faster, no re-decode)
                                _per_image_hash = _hash_fn(img) or ""
                                if _per_image_hash and _gallery_save and _parsed_infotexts and i < len(_parsed_infotexts) and _parsed_infotexts[i]:
                                    _gallery_save(_per_image_hash, _parsed_infotexts[i], _parsed_settings,
                                                  filepath=str(fpath),
                                                  float_path=_per_image_float_path,
                                                  blend_mask_path=_per_image_mask_path)
                        except Exception:
                            log.exception("Gallery metadata save failed (PNG path)")
                        # b64 from same buffer (no re-encode)
                        images_b64.append("data:image/png;base64," + base64.b64encode(png_bytes).decode())
                    except Exception:
                        log.exception("Auto-save failed (PNG path)")
                        # Fallback: at least get the b64
                        images_b64.append(_pil_to_b64(img))
                elif req.save_outputs and req.save_format in ("jpeg", "webp"):
                    # Lossy save: encode once to a buffer in the target
                    # format, write that buffer to disk AND base64-encode
                    # it for the response. This makes the Canvas preview
                    # reflect the actual saved bytes (compression artifacts
                    # included) instead of the lossless PNG of the source
                    # PIL image.
                    try:
                        ext = "jpg" if req.save_format == "jpeg" else "webp"
                        pil_format = "JPEG" if req.save_format == "jpeg" else "WEBP"
                        mime = "image/jpeg" if req.save_format == "jpeg" else "image/webp"
                        image_seed = (_parsed_base_seed + i) if _parsed_base_seed != -1 else 0
                        counter = _base_counter + i
                        while True:
                            fname = f"Studio-{counter:05d}-{image_seed}.{ext}"
                            fpath = output_dir / fname
                            if not fpath.exists():
                                break
                            counter += 1
                        save_kwargs = {}

                        if req.save_format == "jpeg":
                            img = img.convert("RGB")  # Drop alpha for JPEG
                            save_kwargs = _final_jpeg_save_kwargs(req.save_quality)  # 4:4:4
                        else:  # webp
                            if req.save_lossless:
                                save_kwargs = {"lossless": True}
                            else:
                                save_kwargs = {"quality": req.save_quality}
                        if req.embed_metadata and _parsed_infotexts:
                            try:
                                if i < len(_parsed_infotexts) and _parsed_infotexts[i]:
                                    exif_bytes = _build_exif_usercomment(_parsed_infotexts[i])
                                    if exif_bytes:
                                        save_kwargs["exif"] = exif_bytes
                            except Exception:
                                log.exception("Failed to embed EXIF metadata")

                        # Encode once, reuse for disk and b64 (no double-encode).
                        buf = io.BytesIO()
                        img.save(buf, format=pil_format, icc_profile=_SRGB_ICC, **save_kwargs)
                        file_bytes = buf.getvalue()
                        _ensure_disk_space(fpath.parent)
                        with open(str(fpath), "wb") as f:
                            f.write(file_bytes)
                        image_paths.append(str(fpath))
                        _register_served_file(str(fpath))
                        images_b64.append(f"data:{mime};base64," + base64.b64encode(file_bytes).decode())
                        # High Precision: write float32 sidecar next to
                        # the lossy file. The sidecar holds the true
                        # pre-encode pixels regardless of compression.
                        if _img_float is not None:
                            _per_image_float_path = _save_float_sidecar(fpath, _img_float, _img_stats)
                            if _img_mask is not None:
                                _per_image_mask_path = _save_mask_sidecar(fpath, _img_mask)
                        # Hash the saved image so the frontend can look it up in
                        # Gallery (Canvas → Gallery detail view bridge).
                        # Lossy formats: must hash from file (post-encode pixels differ from original).
                        try:
                            _hash_fn = _import("studio_gallery", "compute_content_hash")
                            _gallery_save = _import("studio_gallery", "save_metadata_by_hash")
                            if _hash_fn:
                                _per_image_hash = _hash_fn(str(fpath)) or ""
                                if _per_image_hash and _gallery_save and _parsed_infotexts and i < len(_parsed_infotexts) and _parsed_infotexts[i]:
                                    _gallery_save(_per_image_hash, _parsed_infotexts[i], _parsed_settings,
                                                  filepath=str(fpath),
                                                  float_path=_per_image_float_path,
                                                  blend_mask_path=_per_image_mask_path)
                        except Exception:
                            log.exception("Gallery metadata save failed (lossy path)")
                    except Exception:
                        log.exception("Auto-save failed (lossy path)")
                        # Fallback: at least get a (PNG) b64 so the client has something to show.
                        images_b64.append(_pil_to_b64(img))
                else:
                    # No save (or unrecognised format): keep the original
                    # pixels as PNG b64 — that's the most accurate
                    # representation of the in-memory image.
                    images_b64.append(_pil_to_b64(img))
            elif isinstance(img, str):
                images_b64.append(img)
            content_hashes.append(_per_image_hash)
            float_paths.append(_per_image_float_path)
            mask_paths.append(_per_image_mask_path)
            # WP-L2: register this image with the tab's session. Saved files
            # get a registry row only (never deletable by session ops);
            # unsaved images are written to per-session scratch so history
            # can display them without the client retaining base64.
            _entry = {"entry_id": "", "source": "none", "path": ""}
            if _sid_ok:
                _saved_path = image_paths[-1] if len(image_paths) > _n_paths_before else ""
                if _saved_path:
                    _entry = {
                        "entry_id": _register_session_entry(_sid, _saved_path, "saved"),
                        "source": "saved",
                        "path": _saved_path,
                    }
                else:
                    _scratch_eid = uuid.uuid4().hex
                    _scratch_path = _write_session_scratch(_sid, img, _scratch_eid)
                    if _scratch_path:
                        _entry = {
                            "entry_id": _register_session_entry(_sid, _scratch_path, "scratch", entry_id=_scratch_eid),
                            "source": "scratch",
                            "path": _scratch_path,
                        }
            session_entries.append(_entry)

        # Align HP stats to the emitted images and flag sidecars that were
        # captured but failed to write (stats valid, no path). No paths added.
        while len(float_stats) < len(images_b64):
            float_stats.append(None)
        float_stats = float_stats[:len(images_b64)]
        for i in range(len(images_b64)):
            fp = float_paths[i] if i < len(float_paths) else ""
            fa_present = i < len(float_arrays) and float_arrays[i] is not None
            if isinstance(float_stats[i], dict) and fa_present and not fp:
                float_stats[i] = {**float_stats[i], "saved": False}

        settings = {}
        infotexts = []
        seed_val = -1
        if settings_json:
            try:
                settings = json.loads(settings_json)
                infotexts = settings.get("infotexts", [])
                seed_val = settings.get("seed", -1)
            except Exception:
                log.exception("Settings JSON parse failed (fallback path)")

        error_msg = None
        if not images_b64 and info_html:
            error_msg = re.sub(r'<[^>]+>', '', info_html).strip()

        # UX-013: Reset auto-unload timer after generation
        global _last_generation_time
        _last_generation_time = time.time()
        if _auto_unload_enabled:
            _schedule_auto_unload()

        _log_vram("Generation complete")

        # [Studio Perf] per-generation summary: compute vs. save vs. total,
        # plus how much preview decoding cost during this run and which stream /
        # downscale path it took. Guarded so telemetry can never break a gen.
        try:
            _perf_save = time.time() - _perf_save_t0
            _perf_total = time.time() - _perf_handler_t0
            _perf_pv_decodes = _preview_decode_count - _perf_pv_count0
            _perf_pv_time = _preview_decode_time_total - _perf_pv_time0
            _perf_pv_avg_ms = (
                _perf_pv_time / _perf_pv_decodes * 1000.0) if _perf_pv_decodes else 0.0
            print(f"{PERF} gen: compute={_perf_compute:.2f}s "
                  f"save={_perf_save:.2f}s total={_perf_total:.2f}s | "
                  f"previews={_perf_pv_decodes} "
                  f"decode_total={_perf_pv_time * 1000.0:.0f}ms "
                  f"avg={_perf_pv_avg_ms:.1f}ms "
                  f"stream={_preview_path_info.get('stream')} "
                  f"downscale={_preview_path_info.get('downscale')} "
                  f"task={task_id or '?'}")
        except Exception as _pe:
            print(f"{PERF} gen summary error: {_pe}")

        return GenerateResponse(
            images=images_b64,
            image_paths=image_paths,
            float_paths=float_paths,
            mask_paths=mask_paths,
            float_stats=float_stats,
            content_hashes=content_hashes,
            infotexts=infotexts,
            session_entries=session_entries,
            settings=settings,
            seed=seed_val,
            task_id=task_id or "",
            error=error_msg,
            notice=_save_dir_notice,
        )

    # ------------------------------------------------------------------
    # Session history (WP-L2)
    # ------------------------------------------------------------------

    @app.get("/studio/session_thumb")
    async def session_thumb(id: str = "", size: int = 256):
        """Thumbnail for a registered session entry — ID-based only, no
        path parameter. 404 for unregistered ids."""
        hit = _SESSION_ENTRY_INDEX.get((id or "").strip())
        if not hit:
            return JSONResponse({"error": "not found"}, status_code=404)
        _sid, path = hit
        try:
            size = max(64, min(640, int(size)))
        except Exception:
            size = 256
        headers = {"Cache-Control": "max-age=3600"}
        gen_thumb = _import("studio_gallery", "generate_thumbnail_bytes")
        data = gen_thumb(path, max_size=size) if gen_thumb else None
        if data is not None:
            return Response(content=data, media_type="image/webp", headers=headers)
        # Pillow missing or decode failed — serve the original file (it's a
        # registered path, same trust level as the thumbnail would be).
        if Path(path).is_file():
            return FileResponse(path, headers=headers)
        return JSONResponse({"error": "not found"}, status_code=404)

    @app.post("/studio/session_evict")
    async def session_evict(req: SessionEvictRequest):
        """Drop entries that fell off the client's history cap. Scratch
        files are deleted; saved entries lose their registry row only —
        a saved output file is never touched. Scoped strictly to the
        supplied session_id."""
        sid = (req.session_id or "").strip()
        if not sid:
            return {"ok": False}
        for eid in (req.entry_ids or []):
            _remove_session_entry(sid, str(eid))
        return {"ok": True}

    @app.post("/studio/session_clear")
    async def session_clear(req: SessionClearRequest):
        """Drop every entry of one session (same per-entry semantics as
        evict). Other sessions — other tabs — are untouched."""
        sid = (req.session_id or "").strip()
        if not sid:
            return {"ok": False}
        sess = _SESSION_REGISTRY.get(sid) or {}
        for eid in list(sess.keys()):
            _remove_session_entry(sid, eid)
        return {"ok": True}

    # ------------------------------------------------------------------
    # Layout files (WP-L3)
    # ------------------------------------------------------------------

    @app.get("/studio/layouts")
    async def list_layouts():
        items = []
        for f in sorted(_layout_dir().glob("*.json")):
            if not _LAYOUT_NAME_RE.match(f.stem):
                continue
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                items.append({
                    "name": f.stem,
                    "module": data.get("module", "canvas"),
                    "base": data.get("base", "classic"),
                    "mtime": int(f.stat().st_mtime),
                })
            except Exception:
                continue  # unreadable file — skip, never fail the list
        return {"layouts": items}

    @app.get("/studio/layouts/{name}")
    async def get_layout(name: str):
        slug, p = _layout_path(name)
        if p is None:
            return JSONResponse({"error": "invalid layout name"}, status_code=400)
        if not p.is_file():
            return JSONResponse({"error": "not found"}, status_code=404)
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return JSONResponse({"error": "unreadable layout file"}, status_code=500)

    @app.post("/studio/layouts")
    async def save_layout(req: LayoutSaveRequest):
        slug, p = _layout_path(req.name)
        if p is None:
            return JSONResponse({"error": "invalid layout name"}, status_code=400)
        try:
            payload_size = len(json.dumps(req.map))
        except Exception:
            return JSONResponse({"error": "map is not JSON-serializable"}, status_code=400)
        if payload_size > _LAYOUT_MAX_BYTES:
            return JSONResponse({"error": "layout too large"}, status_code=413)
        err = _validate_layout_map(req.map)
        if err:
            return JSONResponse({"error": err}, status_code=400)
        data = dict(req.map)
        data["name"] = slug
        try:
            _atomic_write_json(p, data)
        except Exception:
            log.exception("Layout write failed")
            return JSONResponse({"error": "write failed"}, status_code=500)
        return {"ok": True, "name": slug}

    @app.delete("/studio/layouts/{name}")
    async def delete_layout(name: str):
        slug, p = _layout_path(name)
        if p is None:
            return JSONResponse({"error": "invalid layout name"}, status_code=400)
        if not p.is_file():
            return JSONResponse({"error": "not found"}, status_code=404)
        try:
            p.unlink()
        except Exception:
            log.exception("Layout delete failed")
            return JSONResponse({"error": "delete failed"}, status_code=500)
        return {"ok": True}

    # ------------------------------------------------------------------
    # User preferences (server-backed, survive browser-storage clears)
    # ------------------------------------------------------------------

    @app.get("/studio/prefs")
    async def get_prefs():
        with _PREFS_LOCK:
            return _read_user_prefs_unlocked()

    @app.post("/studio/prefs")
    async def save_prefs(request: Request):
        # Raw-Request parsing on purpose: a Pydantic/dict parameter would
        # turn malformed JSON into HTTP 422; the contract is 400.
        if not _check_same_origin(request):
            return JSONResponse({"error": "forbidden"}, status_code=403)
        body = await request.body()
        if len(body) > _PREFS_MAX_BYTES:
            return JSONResponse({"error": "preferences too large"}, status_code=413)
        try:
            posted = json.loads(body)
        except Exception:
            return JSONResponse({"error": "malformed JSON"}, status_code=400)
        if not isinstance(posted, dict):
            return JSONResponse({"error": "preferences must be an object"}, status_code=400)
        unknown = set(posted) - _PREFS_ALLOWED_KEYS
        if unknown:
            return JSONResponse(
                {"error": f"unknown preference keys: {', '.join(sorted(unknown))}"},
                status_code=400)
        with _PREFS_LOCK:
            prefs = _read_user_prefs_unlocked()
            # Shallow merge by top-level key: a posted key replaces that key
            # entirely (the frontend owns complete objects like
            # component_memory and shortcuts); unposted keys remain.
            prefs.update(posted)
            try:
                _atomic_write_json(_PREFS_FILE, prefs)
            except Exception:
                log.exception("Preferences write failed")
                return JSONResponse({"error": "write failed"}, status_code=500)
            return prefs

    @app.delete("/studio/prefs")
    async def delete_prefs(request: Request):
        # Emergency reset (?reset): removes all preferences. Defaults,
        # layouts, and trusted roots live in separate files and are kept.
        if not _check_same_origin(request):
            return JSONResponse({"error": "forbidden"}, status_code=403)
        with _PREFS_LOCK:
            try:
                if _PREFS_FILE.is_file():
                    _PREFS_FILE.unlink()
            except Exception:
                log.exception("Preferences delete failed")
                return JSONResponse({"error": "delete failed"}, status_code=500)
        return {"ok": True}

    # ------------------------------------------------------------------
    # Interrupt / Skip / Task ID
    # ------------------------------------------------------------------

    @app.post("/studio/interrupt")
    async def interrupt():
        do_interrupt = _import("studio_generation", "do_interrupt")
        do_interrupt()
        return {"ok": True}

    @app.post("/studio/skip")
    async def skip():
        do_skip = _import("studio_generation", "do_skip")
        do_skip()
        return {"ok": True}

    @app.get("/studio/task_id")
    async def task_id():
        get_studio_task_id = _import("studio_generation", "get_studio_task_id")
        return {"task_id": get_studio_task_id()}

    @app.get("/studio/srgb-icc")
    async def srgb_icc():
        """Serve the sRGB ICC profile bytes so the JS PSD writer (ag-psd)
        can embed the same profile in exported PSDs that the Python save
        path embeds in PNG / JPEG / WebP outputs."""
        if _SRGB_ICC is None:
            return JSONResponse({"error": "sRGB profile unavailable"}, status_code=503)
        return Response(content=_SRGB_ICC, media_type="application/vnd.iccprofile")

    # ------------------------------------------------------------------
    # High Precision — OpenEXR export
    # ------------------------------------------------------------------

    @app.post("/studio/export/exr")
    async def export_exr(req: ExrExportRequest):
        """Export a float32 OpenEXR file.

        Two source paths:
        - float_path: a .float32.bin sidecar from a High Precision
          generation (preferred — true float pixels with headroom).
        - image_b64: fallback for images without a sidecar (still useful
          for pipeline compatibility, but no precision gain over the PNG).
        """
        try:
            import numpy as np
        except Exception as e:
            return {"ok": False, "error": f"numpy unavailable: {e}"}

        # Resolve float_data (HxWx3 float32) from whichever source applies.
        float_data = None
        canvas_uint8 = None  # for V2 mask composite, when both sources present
        try:
            if req.float_path and os.path.isfile(req.float_path) and req.width > 0 and req.height > 0:
                raw = np.fromfile(req.float_path, dtype=np.float32)
                expected = req.height * req.width * 3
                if raw.size != expected:
                    return {"ok": False,
                            "error": f"sidecar size mismatch: got {raw.size} floats, expected {expected}"}
                float_data = raw.reshape((req.height, req.width, 3))
                # Optional V2 composite: if a blend mask sidecar AND a
                # canvas image_b64 were both provided, composite them
                # before writing the EXR — matches Develop's load-time
                # composite, so the EXR mirrors what the user sees.
                if req.mask_path and os.path.isfile(req.mask_path) and req.image_b64:
                    try:
                        mask_pil = Image.open(req.mask_path).convert("L")
                        if mask_pil.size != (req.width, req.height):
                            mask_pil = mask_pil.resize((req.width, req.height), Image.LANCZOS)
                        m = (np.asarray(mask_pil, dtype=np.float32) / 255.0)[..., None]  # HxWx1
                        cu8 = _decode_b64_to_numpy(req.image_b64)
                        if cu8 is not None:
                            cu8 = np.asarray(cu8)
                            if cu8.ndim == 2:
                                cu8 = np.stack([cu8, cu8, cu8], axis=-1)
                            if cu8.ndim == 3 and cu8.shape[2] >= 3:
                                cu8 = cu8[:, :, :3]
                            cu8f = cu8.astype(np.float32) / 255.0
                            if cu8f.shape[:2] != float_data.shape[:2]:
                                # Resample canvas to float dims via PIL.
                                pil_c = Image.fromarray(cu8, mode="RGB")
                                pil_c = pil_c.resize((req.width, req.height), Image.LANCZOS)
                                cu8f = np.asarray(pil_c, dtype=np.float32) / 255.0
                            # Blend in sRGB-encoded space (both inputs
                            # are sRGB-encoded — matches AD's composite).
                            float_data = float_data * (1.0 - m) + cu8f * m
                    except Exception as _me:
                        # Composite is a best-effort enhancement; if it
                        # fails, fall back to the raw float buffer.
                        print(f"{TAG} EXR mask composite failed — falling back to raw float: {_me}")
            elif req.image_b64:
                arr = _decode_b64_to_numpy(req.image_b64)
                if arr is None:
                    return {"ok": False, "error": "could not decode image_b64"}
                # _decode_b64_to_numpy returns a uint8 HxWx3 (or HxWx4) ndarray
                arr = np.asarray(arr)
                if arr.ndim == 2:
                    # Greyscale → broadcast to RGB
                    arr = np.stack([arr, arr, arr], axis=-1)
                if arr.ndim == 3 and arr.shape[2] >= 3:
                    arr = arr[:, :, :3]
                float_data = (arr.astype(np.float32) / 255.0)
            else:
                return {"ok": False, "error": "neither float_path nor image_b64 provided"}
        except Exception as e:
            log.exception("EXR export input decode failed")
            return {"ok": False, "error": f"input decode failed: {e}"}

        # Build output path under the same studio output root the regular
        # save endpoint uses, so EXR exports land alongside other downloads.
        try:
            base_outdir = shared.opts.data.get("outdir_samples", "")
            if not base_outdir:
                base_outdir = shared.opts.data.get("outdir_img2img_samples", "")
            if not base_outdir:
                from modules.paths import data_path
                base_outdir = os.path.join(data_path, "output")
            if os.path.basename(base_outdir) in ("txt2img-images", "img2img-images"):
                base_outdir = os.path.dirname(base_outdir)
        except Exception:
            base_outdir = os.path.abspath("output")
        sub = (req.subfolder or "downloads").strip().strip("/\\")
        out_dir = Path(base_outdir) / "studio" / sub
        try:
            out_dir.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            return {"ok": False, "error": f"could not create output dir: {e}"}

        # Filename: prefer client-supplied stem, else timestamped fallback.
        stem = (req.filename or "").strip()
        if stem:
            stem = re.sub(r"[^\w.\-]+", "_", Path(stem).stem) or "export"
        else:
            stem = f"Studio-{int(time.time())}"
        exr_path = out_dir / f"{stem}.exr"
        # Avoid overwrite — append a counter if the file already exists.
        n = 1
        while exr_path.exists():
            exr_path = out_dir / f"{stem}-{n}.exr"
            n += 1

        # Try OpenCV first (already a Forge dependency). Falls back to a
        # minimal pure-Python writer if OpenCV's EXR codec isn't compiled in.
        success = False
        cv2_err = None
        try:
            import cv2
            bgr = np.ascontiguousarray(float_data[:, :, ::-1], dtype=np.float32)
            success = bool(cv2.imwrite(
                str(exr_path), bgr,
                [int(cv2.IMWRITE_EXR_TYPE), int(cv2.IMWRITE_EXR_TYPE_FLOAT)]
            ))
        except Exception as e:
            cv2_err = e

        if not success:
            try:
                _write_exr_minimal(str(exr_path), np.ascontiguousarray(float_data, dtype=np.float32))
                success = True
            except Exception as e:
                detail = f"cv2: {cv2_err}; fallback: {e}" if cv2_err else f"fallback: {e}"
                return {"ok": False, "error": f"EXR write failed ({detail})"}

        return {"ok": True, "path": str(exr_path), "filename": exr_path.name}

    # ------------------------------------------------------------------
    # Live Painting
    # ------------------------------------------------------------------

    def _ensure_live_broadcast():
        """Lazy-wire studio_live's broadcast to our WebSocket infrastructure.

        Forge may load the module as 'studio_live' or 'scripts.studio_live' —
        these are separate instances in sys.modules. We must wire BOTH or the
        generation worker (running in one instance) won't have broadcast refs.
        """
        import sys
        candidates = []
        for name in ['studio_live', 'scripts.studio_live']:
            if name in sys.modules:
                candidates.append(sys.modules[name])
            else:
                try:
                    candidates.append(__import__(name, fromlist=['studio_live']))
                except ImportError:
                    pass
        if not candidates:
            raise ImportError("Cannot find studio_live module")

        for mod in candidates:
            if _uvicorn_loop and not getattr(mod, '_broadcast_wired', False):
                mod.set_broadcast(_broadcast_progress, _uvicorn_loop)
                mod._broadcast_wired = True
                print(f"{TAG} Live broadcast wired on {mod.__name__}")
        return candidates[0]

    @app.post("/studio/live/start")
    async def live_start():
        live = _ensure_live_broadcast()
        return live.handle_start()

    @app.post("/studio/live/stop")
    async def live_stop():
        live = _ensure_live_broadcast()
        return live.handle_stop()

    @app.post("/studio/live/submit")
    async def live_submit(request: Request):
        live = _ensure_live_broadcast()
        data = await request.json()
        return live.handle_submit(data)

    @app.get("/studio/live/status")
    async def live_status():
        live = _ensure_live_broadcast()
        return live.get_status()

    # ------------------------------------------------------------------
    # WebSocket — progress streaming
    # ------------------------------------------------------------------

    @app.websocket("/studio/ws")
    async def progress_websocket(websocket: WebSocket):
        global _uvicorn_loop
        await websocket.accept()
        _progress_connections.append(websocket)
        # Register this client's preview demand with a permissive default
        # (enabled + visible) so previews behave exactly as before until the
        # client sends its real state; the demand gate then engages.
        _preview_client_configs[websocket] = dict(_PREVIEW_CONFIG_DEFAULT)
        # Capture Uvicorn's event loop — background threads need this to
        # safely write to WebSocket transports without assertion errors
        if _uvicorn_loop is None:
            _uvicorn_loop = asyncio.get_event_loop()
            # Wire Live Painting broadcast now that we have the event loop
            try:
                _ensure_live_broadcast()
            except Exception:
                pass  # studio_live may not be installed yet
        print(f"{TAG} WebSocket connected ({len(_progress_connections)} clients)")
        # Catch-up: under the delta protocol, normal ticks carry preview=None,
        # so a tab opened/reopened mid-generation would stay blank until the
        # next fresh decode. Push the cached preview once on connect.
        if _last_preview_b64:
            try:
                await websocket.send_json({
                    "type": "progress",
                    "preview": _last_preview_b64,
                    "preview_id": _last_preview_id,
                })
            except Exception:
                pass
        try:
            while True:
                data = await websocket.receive_text()
                if data == "ping":
                    await websocket.send_json({"type": "pong"})
                    continue
                # Preview demand-gating: the client declares whether it wants
                # previews (toggle) and whether its tab is visible. Anything
                # unparseable is ignored (forward-compat).
                try:
                    msg = json.loads(data)
                except (ValueError, TypeError):
                    continue
                if isinstance(msg, dict) and msg.get("type") == "preview_config":
                    cfg = _preview_client_configs.get(websocket)
                    if cfg is None:
                        cfg = dict(_PREVIEW_CONFIG_DEFAULT)
                        _preview_client_configs[websocket] = cfg
                    if "enabled" in msg:
                        cfg["enabled"] = bool(msg["enabled"])
                    if "visible" in msg:
                        cfg["visible"] = bool(msg["visible"])
                    if "max_edge" in msg:
                        try:
                            me = int(msg["max_edge"])
                            # Clamp to a sane preview range; 0/negative → default.
                            cfg["max_edge"] = min(2048, me) if me > 0 else _PREVIEW_CONFIG_DEFAULT["max_edge"]
                        except (ValueError, TypeError):
                            pass
        except WebSocketDisconnect:
            pass
        finally:
            if websocket in _progress_connections:
                _progress_connections.remove(websocket)
            _preview_client_configs.pop(websocket, None)
            print(f"{TAG} WebSocket disconnected ({len(_progress_connections)} clients)")

    # ------------------------------------------------------------------
    # Models / Samplers / Resources
    # ------------------------------------------------------------------

    @app.get("/studio/models")
    async def get_models():
        return sorted([{
            "title": m.title, "name": m.model_name,
            "hash": m.shorthash, "filename": m.filename,
        } for m in sd_models.checkpoints_list.values()],
        key=lambda x: _natural_sort_key(x["title"]))

    @app.get("/studio/current_model")
    async def get_current_model():
        """Return the actually loaded model, not just the config setting."""
        try:
            # shared.sd_model has the actual loaded model
            if hasattr(shared, 'sd_model') and shared.sd_model is not None:
                ckpt_info = getattr(shared.sd_model, 'sd_checkpoint_info', None)
                if ckpt_info:
                    return {"title": ckpt_info.title, "name": ckpt_info.model_name,
                            "hash": getattr(ckpt_info, 'shorthash', '')}
            # Fallback to config
            return {"title": shared.opts.data.get("sd_model_checkpoint", ""),
                    "name": "", "hash": ""}
        except Exception:
            return {"title": "", "name": "", "hash": ""}

    @app.get("/studio/samplers")
    async def get_samplers():
        return [{"name": s.name} for s in sd_samplers.all_samplers]

    @app.get("/studio/schedulers")
    async def get_schedulers():
        return [{"name": s.name, "label": s.label} for s in sd_schedulers.schedulers]

    @app.get("/studio/upscalers")
    async def get_upscalers():
        return [{"name": u.name} for u in shared.sd_upscalers]

    # ------------------------------------------------------------------
    # Workflow Profiles — saved generation setups
    # One JSON file per workflow, stored under <studio_root>/workflows/.
    # The list endpoint returns only metadata so the dropdown stays small;
    # the per-id endpoint returns the full payload. Corrupted files are
    # skipped from the list rather than failing the whole call.

    @app.get("/studio/workflows")
    async def list_workflows():
        items = []
        try:
            for path in sorted(_workflow_dir().glob("*.json")):
                try:
                    wf = json.loads(path.read_text(encoding="utf-8"))
                except Exception:
                    log.exception("Skipping corrupted workflow file")
                    continue
                if not isinstance(wf, dict):
                    continue
                items.append(_workflow_metadata(wf))
        except Exception:
            log.exception("Failed to enumerate workflows")
            return JSONResponse({"error": "Failed to list workflows"}, status_code=500)
        return items

    @app.get("/studio/workflows/{workflow_id}")
    async def get_workflow(workflow_id: str):
        try:
            path = _workflow_path(workflow_id)
        except ValueError:
            return JSONResponse({"error": "Invalid workflow id"}, status_code=400)
        if not path.exists():
            return JSONResponse({"error": "Not found"}, status_code=404)
        try:
            wf = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            log.exception("Failed to read workflow")
            return JSONResponse({"error": "Workflow read failed"}, status_code=500)
        if not isinstance(wf, dict):
            return JSONResponse({"error": "Malformed workflow"}, status_code=500)
        return wf

    @app.post("/studio/workflows")
    async def save_workflow(req: dict):
        if not isinstance(req, dict):
            return JSONResponse({"error": "Invalid payload"}, status_code=400)
        settings = req.get("settings")
        if not isinstance(settings, dict):
            return JSONResponse({"error": "settings must be an object"}, status_code=400)
        dynamic = req.get("dynamic")
        if dynamic is not None and not isinstance(dynamic, dict):
            return JSONResponse({"error": "dynamic must be an object"}, status_code=400)
        options = req.get("options")
        if options is not None and not isinstance(options, dict):
            return JSONResponse({"error": "options must be an object"}, status_code=400)

        wf_id = req.get("id") or _new_workflow_id()
        try:
            path = _workflow_path(wf_id)
        except ValueError:
            return JSONResponse({"error": "Invalid workflow id"}, status_code=400)

        now = _now_iso()
        existing_created = None
        if path.exists():
            try:
                existing = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(existing, dict):
                    existing_created = existing.get("created_at")
            except Exception:
                existing_created = None

        wf = {
            "version":     int(req.get("version") or 1),
            "id":          wf_id,
            "name":        str(req.get("name") or "")[:200],
            "description": str(req.get("description") or "")[:1000],
            "family":      str(req.get("family") or "any")[:32],
            "created_at":  existing_created or now,
            "updated_at":  now,
            "options":     options or {},
            "settings":    settings,
            "dynamic":     dynamic or {},
        }

        try:
            _atomic_write_json(path, wf)
        except Exception:
            log.exception("Failed to save workflow")
            return JSONResponse({"error": "Workflow save failed"}, status_code=500)

        print(f"{TAG} Workflow saved")
        return {"ok": True, "id": wf_id, "metadata": _workflow_metadata(wf)}

    @app.delete("/studio/workflows/{workflow_id}")
    async def delete_workflow(workflow_id: str):
        try:
            path = _workflow_path(workflow_id)
        except ValueError:
            return JSONResponse({"error": "Invalid workflow id"}, status_code=400)
        try:
            path.unlink(missing_ok=True)
        except Exception:
            log.exception("Failed to delete workflow")
            return JSONResponse({"error": "Workflow delete failed"}, status_code=500)
        return {"ok": True}

    # ------------------------------------------------------------------
    # Post-generation upscale — runs standalone upscaler on an image
    # Designed for low-VRAM users who can't run Hires Fix + ADetailer
    # simultaneously. Clears VRAM before running so the full 6GB is
    # available for the upscaler (~0.5-1.5GB for ESRGAN-class models).
    # ------------------------------------------------------------------

    class UpscaleRequest(BaseModel):
        image_b64: str                     # data URL or raw base64
        upscaler: str = "R-ESRGAN 4x+"    # name from /studio/upscalers
        scale: float = 2.0                 # 1.0-4.0
        save: bool = False                 # also save to outputs/
        subfolder: str = "upscaled"        # subfolder if saving

    @app.post("/studio/upscale")
    async def studio_upscale(request: Request):
        import asyncio
        import base64
        from io import BytesIO
        from PIL import Image

        try:
            data = await request.json()
            image_b64 = data.get("image_b64", "")
            upscaler_name = data.get("upscaler", "R-ESRGAN 4x+")
            scale = float(data.get("scale", 2.0))
            do_save = data.get("save", False)
            subfolder = data.get("subfolder", "upscaled")

            scale = max(1.0, min(4.0, scale))

            # Decode image
            if "," in image_b64:
                image_b64 = image_b64.split(",", 1)[1]
            img_bytes = base64.b64decode(image_b64)
            img = Image.open(BytesIO(img_bytes)).convert("RGB")
            orig_w, orig_h = img.size

            print(f"{TAG} Upscale: {orig_w}x{orig_h} with {upscaler_name} ({scale}x)")

            upscaled = await asyncio.get_event_loop().run_in_executor(
                None, _studio_upscale_image, img, upscaler_name, scale
            )
            new_w, new_h = upscaled.size

            # Encode result
            buf = BytesIO()
            upscaled.save(buf, format="PNG", icc_profile=_SRGB_ICC)
            result_b64 = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()

            result = {
                "ok": True,
                "image": result_b64,
                "width": upscaled.size[0],
                "height": upscaled.size[1],
                "original_width": orig_w,
                "original_height": orig_h,
                "upscaler": upscaler_name,
                "scale": scale,
            }

            # Optionally save to disk — uses same Studio output structure
            if do_save:
                try:
                    from datetime import date
                    # Match _get_output_dir pattern: output/studio/upscaled/YYYY-MM-DD/
                    base_outdir = shared.opts.data.get("outdir_samples", "")
                    if not base_outdir:
                        base_outdir = shared.opts.data.get("outdir_img2img_samples", "")
                    if not base_outdir:
                        from modules.paths import data_path
                        base_outdir = os.path.join(data_path, "output")
                    if os.path.basename(base_outdir) in ("txt2img-images", "img2img-images"):
                        base_outdir = os.path.dirname(base_outdir)
                    date_folder = date.today().strftime("%Y-%m-%d")
                    save_dir = os.path.join(base_outdir, "studio", "upscaled", date_folder)
                    os.makedirs(save_dir, exist_ok=True)
                    import time
                    fname = f"upscale_{int(time.time())}_{new_w}x{new_h}.png"
                    save_path = os.path.join(save_dir, fname)
                    upscaled.save(save_path, icc_profile=_SRGB_ICC)
                    result["saved_path"] = save_path
                    result["filename"] = fname
                    print(f"{TAG} Upscale saved: {save_path}")
                except Exception as e:
                    print(f"{TAG} Upscale save failed: {e}")

            print(f"{TAG} Upscale complete: {new_w}x{new_h}")
            return result

        except Exception as e:
            log.exception("Upscale handler failed")
            return JSONResponse({"error": str(e)}, status_code=500)

    # ------------------------------------------------------------------
    # Upscale + Refine — single-call pipeline
    # Replaces the frontend's two-stage dance (POST /studio/upscale then
    # POST /studio/generate). The two-stage approach paid two full
    # process_images() setup cycles, two base64 round-trips, and on lowvram
    # it thrashed model/VAE swaps between stages. Doing everything inside
    # one handler keeps the model hot and the upscaled latent in memory.
    # ------------------------------------------------------------------

    class UpscaleRefineRequest(BaseModel):
        image_b64: str                     # data URL or raw base64

        # Upscale params
        upscaler: str = "R-ESRGAN 4x+"
        scale: float = 2.0

        # Refine (img2img) params — consulted when run_refine is True
        run_refine: bool = False
        prompt: str = ""
        neg_prompt: str = ""
        steps: int = 20
        sampler_name: str = "DPM++ 2M SDE"
        schedule_type: str = "Karras"
        cfg_scale: float = 5.0
        denoising: float = 0.3
        seed: int = -1

        # ADetailer params — consulted when run_ad is True. Independent of
        # run_refine: AD can run standalone on the ESRGAN output.
        run_ad: bool = False
        ad_slots: List[ADSlotParams] = Field(
            default_factory=lambda: [ADSlotParams(), ADSlotParams(), ADSlotParams()]
        )

        # Save params
        save_outputs: bool = True
        save_format: str = "png"
        save_quality: int = Field(default=80, ge=1, le=100)  # aligned with GenerateRequest
        save_lossless: bool = False
        embed_metadata: bool = True

    @app.post("/studio/upscale_and_refine")
    async def studio_upscale_and_refine(req: UpscaleRefineRequest):
        """ESRGAN upscale + optional HiRes refine + optional ADetailer,
        all inside a single handler using Forge's own HiRes Fix pipeline.

        Architecture: when any diffusion is requested (refine OR AD), we
        build a txt2img processing object with `enable_hr=True` and
        `firstpass_image=<source>`. Forge's HiRes Fix machinery sees
        firstpass_image and skips sampling the base gen — using our
        pixels AS the base output — then runs the upscaler + hires
        denoise inside one process_images() call. Model weights stay on
        GPU, VAE encodes happen with Forge's memory manager active, and
        no manual torch.cuda.empty_cache() cycle fights the pipeline.
        This matches what Forge Neo's upscale button does and should
        give the same performance profile on low-VRAM cards.

        The ESRGAN-only fast path (neither refine nor AD) still uses
        the standalone _studio_upscale_image helper — no diffusion, no
        need for the full pipeline.
        """
        import random

        _cancel_auto_unload()

        # Shared imports for the worker thread
        _build_native_ad_dicts = _import("studio_generation", "_build_native_ad_dicts")
        _run_studio_ad = _import("studio_generation", "_run_studio_ad")
        _build_txt2img_obj = _import("studio_generation", "_build_txt2img_obj")
        GenParams = _import("studio_generation", "GenParams")
        _reset_generation_state = _import("studio_generation", "_reset_generation_state")
        _ensure_model_loaded = _import("studio_generation", "_ensure_model_loaded")
        _get_output_dir = _import("studio_generation", "_get_output_dir")

        def _worker():
            from modules.processing import process_images

            # Decode image once at the top — no further base64 round-trips.
            raw = req.image_b64
            if "," in raw:
                raw = raw.split(",", 1)[1]
            try:
                src = Image.open(io.BytesIO(base64.b64decode(raw))).convert("RGB")
            except Exception as e:
                return None, None, -1, f"Invalid image_b64: {e}"

            orig_w, orig_h = src.size

            # Build ADetailer slot dicts (shared by refine + standalone AD paths).
            ad_slots = list(req.ad_slots) + [ADSlotParams()] * max(0, 3 - len(req.ad_slots))
            ad_raw_slots = [{
                "enable": s.enable, "model": s.model, "confidence": s.confidence,
                "mask_min_ratio": s.mask_min, "mask_max_ratio": s.mask_max,
                "topk_filter": s.topk_filter, "topk": s.topk,
                "mask_x_offset": s.x_offset, "mask_y_offset": s.y_offset,
                "mask_erosion_dilation": s.erosion_dilation, "mask_merge_mode": s.merge_mode,
                "denoise": s.denoise, "mask_blur": s.mask_blur, "inpaint_pad": s.inpaint_pad,
                "inpaint_full_res": s.full_res, "inpaint_fill": s.fill,
                "use_sep_steps": s.sep_steps, "ad_steps": s.steps,
                "use_sep_cfg": s.sep_cfg, "ad_cfg": s.cfg,
                "use_sep_sampler": s.sep_sampler, "ad_sampler": s.sampler,
                "ad_scheduler": s.scheduler,
                "prompt": s.prompt, "neg_prompt": s.neg_prompt,
            } for s in ad_slots[:3]]
            ad_enable_flag, ad_slot_dicts = _build_native_ad_dicts(
                bool(req.run_ad), ad_raw_slots
            )
            ad_has_work = ad_enable_flag and any(
                d.get("ad_tab_enable") and d.get("ad_model", "None") != "None"
                for d in ad_slot_dicts
            )

            # ── ESRGAN-only fast path ────────────────────────────────
            # No refine, no AD → use the standalone upscaler helper.
            # Preserves the "pure ESRGAN" use case without paying any
            # diffusion setup cost.
            if not req.run_refine and not ad_has_work:
                upscaled = _studio_upscale_image(src, req.upscaler, req.scale)
                return upscaled, None, -1, None

            # Set up progress task + ensure model is loaded.
            id_task = _reset_generation_state()
            _ensure_model_loaded()

            seed = int(req.seed) if req.seed != -1 else random.randint(0, 2**32 - 1)
            infotext = None
            result = None

            # ── Refine path: Forge's HiRes Fix pipeline ─────────────
            # txt2img + enable_hr + firstpass_image is exactly what
            # Forge Neo's upscale button uses. The pipeline skips base
            # gen sampling (our input is already the "base output"),
            # runs the upscaler + hires denoise inside one call, and
            # keeps the model hot the whole way through.
            #
            # Reuses _build_txt2img_obj so script attachment matches the
            # main generate path byte-for-byte: proper type coercion via
            # _cast_arg, DP force-enable, AR-selector suppression,
            # Sampler/Seed script slot patching. Rolling our own
            # script_args (even with comp.value) misses these and leaves
            # alwayson scripts in an inconsistent state.
            studio_outdir = _get_output_dir("txt2img")

            try:
                gp = GenParams(
                    prompt=req.prompt or "",
                    neg_prompt=req.neg_prompt or "",
                    steps=int(req.steps),
                    sampler_name=req.sampler_name or "Euler a",
                    schedule_type=req.schedule_type or "Automatic",
                    cfg_scale=float(req.cfg_scale),
                    denoising=float(req.denoising),
                    # Base dims = ORIGINAL source image. HiRes scales up
                    # from here via hr_scale.
                    width=orig_w, height=orig_h, seed=seed,
                    batch_count=1, batch_size=1,
                )

                # No native AD — Studio runs its own AD post-hires.
                # Passing None makes _build_txt2img_obj force native AD's
                # enable bool to False in script_args.
                p = _build_txt2img_obj(
                    gp, studio_outdir, seed,
                    cn_units=None, extension_args=None, ad_params=None,
                )

                # ── HiRes Fix configuration ─────────────────────────
                # Matches the main generate path's txt2img+hires block.
                # hr_additional_modules MUST be a string (not None) —
                # Forge does `"Use same choices" not in self.hr_additional_modules`
                # which raises TypeError if the attr is None.
                p.enable_hr = True
                p.hr_upscaler = req.upscaler or "Latent"
                p.hr_scale = float(req.scale)
                p.hr_second_pass_steps = int(req.steps) if int(req.steps) > 0 else 0
                p.denoising_strength = float(req.denoising)
                p.hr_additional_modules = "Use same choices"
                p.hr_cfg_scale = float(req.cfg_scale)
                p.hr_cfg = float(req.cfg_scale)
                p.hr_sampler_name = None  # use same sampler
                p.hr_scheduler = None     # use same scheduler

                # The crucial attribute — tells Forge to use our pixels
                # as the "base gen" output and skip sampling it entirely.
                p.firstpass_image = src

                # Internal Forge flag: signals this is a re-upscale of an
                # existing image, not a fresh gen. Affects some cleanup/
                # logging paths. Safe to set.
                p.txt2img_upscale = True

                # Suppress pre-hires intermediate save (we want the final
                # result only; disk save happens in the outer handler).
                p.override_settings = dict(getattr(p, 'override_settings', {}) or {})
                p.override_settings["save_images_before_highres_fix"] = False

                # Studio runs its own AD post-process; stock AD must bail
                # even if a script happens to re-enable it somewhere.
                if ad_has_work:
                    p._ad_disabled = True

                runner = p.scripts  # set by _build_txt2img_obj

                shared.state.job_count = 1
                shared.state.job_no = 0

                target_w = int(orig_w * float(req.scale))
                target_h = int(orig_h * float(req.scale))
                print(f"{TAG} Upscale+refine: txt2img+hires firstpass_image, "
                      f"{orig_w}x{orig_h} -> {target_w}x{target_h}, "
                      f"upscaler={req.upscaler}, denoise={req.denoising}, "
                      f"seed={seed}, AD={'on' if ad_has_work else 'off'}")

                # Physically remove scripts that unconditionally overwrite
                # p.width / p.height during before_process — notably the
                # standalone AR Selector, which has no enable toggle and
                # forces a fixed ratio no matter what script_args say.
                # Same treatment run_generation() applies. Without this
                # the HR target dims become (orig_w × hr_scale, ar_h ×
                # hr_scale) instead of (orig_w × hr_scale, orig_h × hr_scale).
                import modules.scripts as _mod_scripts
                _removed_scripts = []
                _suppress_titles = {"moritz's ar selector"}
                try:
                    for _r in [_mod_scripts.scripts_txt2img, _mod_scripts.scripts_img2img]:
                        if not _r:
                            continue
                        _to_remove = []
                        for _s in _r.alwayson_scripts:
                            try:
                                _title = _s.title().strip().lower() if callable(getattr(_s, 'title', None)) else ""
                            except Exception:
                                _title = ""
                            if _title in _suppress_titles:
                                _to_remove.append((_r, _s))
                        for _rr, _ss in _to_remove:
                            _rr.alwayson_scripts.remove(_ss)
                            _removed_scripts.append((_rr, _ss))
                            print(f"{TAG} Temporarily removed conflicting script: {_ss.title()}")
                except Exception as _se:
                    print(f"{TAG} Script suppression warning: {_se}")

                try:
                    # Let scripts intercept first (matches Forge's pattern),
                    # fall through to process_images if no script handles it.
                    processed = None
                    if runner:
                        try:
                            processed = runner.run(p, *p.script_args)
                        except Exception as _re:
                            print(f"{TAG} scripts_txt2img.run raised, falling back to process_images: {_re}")
                            processed = None
                    if processed is None:
                        processed = process_images(p)
                finally:
                    # Restore any scripts we temporarily removed so they're
                    # available for the next generation.
                    for _rr, _ss in _removed_scripts:
                        if _ss not in _rr.alwayson_scripts:
                            _rr.alwayson_scripts.append(_ss)
                    if _removed_scripts:
                        print(f"{TAG} Restored {len(_removed_scripts)} suppressed script(s)")

                if processed and processed.images:
                    result = processed.images[0]
                    if processed.infotexts:
                        infotext = processed.infotexts[0]
                    elif processed.info:
                        infotext = processed.info
                else:
                    return None, None, seed, "process_images returned no images"

                # Post-process AD on the hires output.
                if ad_has_work and not shared.state.interrupted:
                    result = _run_studio_ad(result, p, ad_slot_dicts, mask_img=None)

            finally:
                try:
                    from modules.progress import finish_task as _ft
                    _ft(id_task)
                except Exception:
                    log.exception("Task finish cleanup failed")

            return result, infotext, seed, None

        try:
            result, infotext, seed_val, err = await asyncio.to_thread(_worker)
        except Exception as e:
            log.exception("Upscale+refine handler failed")
            return JSONResponse({"error": str(e)}, status_code=500)

        if err:
            return JSONResponse({"error": err}, status_code=400)
        if result is None:
            return JSONResponse({"error": "Pipeline returned no image"}, status_code=500)

        # Encode the final image once.
        result_w, result_h = result.size

        # ── Save to disk ─────────────────────────────────────────────
        # Use the same Forge-style filename helper as the regular
        # auto-save. For PNG, encode once to buffer and reuse for both
        # disk + response b64 (no double compression).
        filename = None
        saved_path = None
        png_bytes = None
        if req.save_outputs:
            try:
                base_outdir = shared.opts.data.get("outdir_samples", "")
                if not base_outdir:
                    base_outdir = shared.opts.data.get("outdir_img2img_samples", "")
                if not base_outdir:
                    from modules.paths import data_path
                    base_outdir = os.path.join(data_path, "output")
                if os.path.basename(base_outdir) in ("txt2img-images", "img2img-images"):
                    base_outdir = os.path.dirname(base_outdir)
                date_folder = date.today().strftime("%Y-%m-%d")
                output_dir = Path(base_outdir) / "studio" / "upscaled" / date_folder
                output_dir.mkdir(parents=True, exist_ok=True)

                ext_map = {"png": "png", "jpeg": "jpg", "webp": "webp"}
                ext = ext_map.get(req.save_format, "png")
                counter = _next_forge_counter(output_dir)
                seed_for_name = seed_val if seed_val != -1 else 0
                while True:
                    fname = f"Studio-{counter:05d}-{seed_for_name}.{ext}"
                    fpath = output_dir / fname
                    if not fpath.exists():
                        break
                    counter += 1

                save_kwargs = {}
                # One disk-space preflight covers all three branches below.
                _ensure_disk_space(fpath.parent)
                if req.save_format == "png":
                    if req.embed_metadata and infotext:
                        try:
                            from PIL.PngImagePlugin import PngInfo
                            pnginfo = PngInfo()
                            pnginfo.add_text("parameters", infotext)
                            save_kwargs["pnginfo"] = pnginfo
                        except Exception:
                            log.exception("Failed to embed PNG metadata (upscale)")
                    buf = io.BytesIO()
                    result.save(buf, format="PNG", icc_profile=_SRGB_ICC, **save_kwargs)
                    png_bytes = buf.getvalue()
                    with open(str(fpath), "wb") as f:
                        f.write(png_bytes)
                elif req.save_format == "jpeg":
                    save_img = result.convert("RGB") if result.mode != "RGB" else result
                    save_kwargs = _final_jpeg_save_kwargs(req.save_quality)  # 4:4:4
                    if req.embed_metadata and infotext:
                        exif_bytes = _build_exif_usercomment(infotext)
                        if exif_bytes:
                            save_kwargs["exif"] = exif_bytes
                    save_img.save(str(fpath), "JPEG", icc_profile=_SRGB_ICC, **save_kwargs)
                elif req.save_format == "webp":
                    if req.save_lossless:
                        save_kwargs = {"lossless": True}
                    else:
                        save_kwargs = {"quality": req.save_quality}
                    if req.embed_metadata and infotext:
                        exif_bytes = _build_exif_usercomment(infotext)
                        if exif_bytes:
                            save_kwargs["exif"] = exif_bytes
                    result.save(str(fpath), "WEBP", icc_profile=_SRGB_ICC, **save_kwargs)

                filename = fname
                saved_path = str(fpath)
                print(f"{TAG} Upscale+refine saved: {saved_path}")

                # Gallery DB metadata write — only when we have real infotext
                if infotext:
                    try:
                        _hash_fn = _import("studio_gallery", "compute_content_hash")
                        _gallery_save = _import("studio_gallery", "save_metadata_by_hash")
                        if _hash_fn and _gallery_save:
                            _ch = _hash_fn(result if req.save_format == "png" else str(fpath))
                            if _ch:
                                _gallery_save(_ch, infotext, {"infotexts": [infotext]}, filepath=str(fpath))
                    except Exception:
                        log.exception("Gallery metadata save failed (upscale path)")
            except Exception as e:
                print(f"{TAG} Upscale+refine save failed: {e}")

        if png_bytes is not None:
            result_b64 = "data:image/png;base64," + base64.b64encode(png_bytes).decode()
        else:
            result_b64 = _pil_to_b64(result)

        # Reset auto-unload timer (mirrors /studio/generate behaviour)
        global _last_generation_time
        _last_generation_time = time.time()
        if _auto_unload_enabled:
            _schedule_auto_unload()
        _log_vram("Upscale+refine complete")

        return {
            "ok": True,
            "image": result_b64,
            "width": result_w,
            "height": result_h,
            "filename": filename,
            "saved_path": saved_path,
            "seed": seed_val,
        }

    @app.get("/studio/vaes")
    async def get_vaes():
        """List available VAE files."""
        try:
            from modules import sd_vae
            sd_vae.refresh_vae_list()
            vae_list = [{"name": "Automatic"}, {"name": "None"}]
            for name in sd_vae.vae_dict.keys():
                vae_list.append({"name": name})
            # If vae_dict is empty, try fallback scan
            if len(vae_list) <= 2:
                import glob
                vae_paths = []
                # Check standard VAE directories
                models_dir = getattr(shared, 'models_path', 'models')
                for pattern in [
                    os.path.join(models_dir, "VAE", "*.safetensors"),
                    os.path.join(models_dir, "VAE", "*.pt"),
                    os.path.join(models_dir, "VAE", "*.ckpt"),
                    os.path.join(models_dir, "vae", "*.safetensors"),
                    os.path.join(models_dir, "vae", "*.pt"),
                ]:
                    vae_paths.extend(glob.glob(pattern))
                for p in vae_paths:
                    name = os.path.basename(p)
                    if not any(v["name"] == name for v in vae_list):
                        vae_list.append({"name": name})
                if len(vae_list) > 2:
                    print(f"{TAG} VAE fallback scan found {len(vae_list) - 2} VAEs")
            # Keep Automatic/None pinned at the top, alphabetize the rest.
            pinned = vae_list[:2]
            rest = sorted(vae_list[2:], key=lambda x: _natural_sort_key(x["name"]))
            return pinned + rest
        except Exception as e:
            print(f"{TAG} VAE list error: {e}")
            return [{"name": "Automatic"}, {"name": "None"}]

    @app.get("/studio/current_vae")
    async def get_current_vae():
        """Return the currently configured VAE."""
        try:
            vae_name = shared.opts.data.get("sd_vae", "Automatic")
            return {"name": vae_name or "Automatic"}
        except Exception:
            return {"name": "Automatic"}

    @app.post("/studio/load_vae")
    async def load_vae(body: dict):
        """Switch VAE. Values: 'Automatic', 'None', or a VAE filename.

        Forge Neo removed sd_vae.reload_vae_weights(). Swap goes through
        forge_loading_parameters + forge_model_reload() instead — same path
        load_model uses. We preserve any non-VAE additional modules
        (text encoders, etc.) and only replace the VAE entry.
        """
        vae_name = body.get("name", "Automatic")
        try:
            from modules import sd_vae
            sd_vae.refresh_vae_list()

            # Persist the opts setting regardless of whether a model is loaded
            shared.opts.set("sd_vae", vae_name)
            try:
                shared.opts.save(shared.config_filename)
            except Exception:
                log.exception("Failed to persist VAE setting to Forge config")

            # If no real model is loaded yet, the setting is enough — Forge will
            # pick up the VAE via additional_modules on first load.
            if not hasattr(shared.sd_model, 'first_stage_model'):
                print(f"{TAG} VAE preference set to: {vae_name} (no model loaded)")
                return {"ok": True, "loaded": vae_name}

            # Resolve the checkpoint currently in use for the reload
            ci = getattr(shared.sd_model, 'sd_checkpoint_info', None)
            existing_params = {}
            try:
                existing_params = dict(sd_models.model_data.forge_loading_parameters or {})
            except Exception:
                existing_params = {}
            if ci is None:
                ci = existing_params.get("checkpoint_info")
            if ci is None:
                print(f"{TAG} Cannot resolve current checkpoint for VAE swap")
                return JSONResponse(
                    {"error": "No active checkpoint to reload"}, status_code=400
                )

            # Preserve existing additional modules except any current VAE
            # (we're replacing it). Known VAE paths come from sd_vae.vae_dict.
            known_vae_paths = {
                os.path.normcase(os.path.abspath(p))
                for p in sd_vae.vae_dict.values()
                if p
            }
            prior_additional = existing_params.get("additional_modules") or []
            preserved = []
            for mod in prior_additional:
                if not mod:
                    continue
                try:
                    norm = os.path.normcase(os.path.abspath(mod))
                except Exception:
                    norm = mod
                if norm in known_vae_paths:
                    continue  # drop old VAE, we're swapping it
                preserved.append(mod)

            # Append the newly selected VAE (if a concrete one was chosen)
            if vae_name and vae_name not in ("Automatic", "None", ""):
                vae_path = sd_vae.vae_dict.get(vae_name)
                if vae_path and os.path.isfile(vae_path):
                    preserved.append(vae_path)
                    print(f"{TAG} VAE (additional module): {vae_name}")
                else:
                    print(f"{TAG} Warning: VAE not found in vae_dict: {vae_name}")

            new_params = dict(existing_params)
            new_params["checkpoint_info"] = ci
            new_params["additional_modules"] = preserved
            new_params.setdefault("unet_storage_dtype", None)
            sd_models.model_data.forge_loading_parameters = new_params

            await asyncio.to_thread(sd_models.forge_model_reload)

            print(f"{TAG} VAE changed to: {vae_name}")
            return {"ok": True, "loaded": vae_name}
        except Exception as e:
            log.exception("VAE load failed")
            return JSONResponse({"error": str(e)}, status_code=500)

    # ------------------------------------------------------------------
    # Text Encoder
    # ------------------------------------------------------------------

    @app.get("/studio/text_encoders")
    async def get_text_encoders():
        """List available text encoder files from models/text_encoder/."""
        try:
            import glob
            models_dir = getattr(shared, 'models_path', 'models')
            te_dir = os.path.join(models_dir, "text_encoder")
            results = []
            if os.path.isdir(te_dir):
                for ext in ("*.safetensors", "*.gguf", "*.pt", "*.bin"):
                    for p in glob.glob(os.path.join(te_dir, "**", ext), recursive=True):
                        name = os.path.relpath(p, te_dir).replace("\\", "/")
                        if name not in results:
                            results.append(name)
            results.sort(key=_natural_sort_key)
            return JSONResponse(results)
        except Exception as e:
            print(f"{TAG} Text encoder list error: {e}")
            return JSONResponse([])

    @app.get("/studio/check_model_te")
    async def check_model_te(title: str = ""):
        """Check if a checkpoint needs external text encoder and/or VAE.

        Scans the safetensors header for text encoder keys
        (cond_stage_model.* or conditioner.*) and VAE keys
        (first_stage_model.*). If absent, the model needs
        external components (e.g. Anima, Flux).
        GGUF files can't be header-scanned — returns needs_te=True
        as a safe default (user can set to None if not needed).
        """
        if not title:
            return {"needs_te": False, "needs_vae": False, "arch": "unknown"}
        try:
            info = sd_models.get_closet_checkpoint_match(title)
            if not info:
                return {"needs_te": False, "needs_vae": False, "arch": "unknown"}

            filepath = info.filename

            # GGUF: can't scan header, assume external TE+VAE needed
            if filepath.endswith(".gguf"):
                return {"needs_te": True, "needs_vae": True, "arch": "unknown",
                        "note": "GGUF — cannot detect, assuming external TE+VAE"}

            # Safetensors: read header keys only (near-instant, no tensor data)
            from safetensors import safe_open
            with safe_open(filepath, framework="pt", device="cpu") as f:
                keys = set(f.keys())

            has_te = any(
                k.startswith("cond_stage_model.") or k.startswith("conditioner.")
                for k in keys
            )
            has_vae = any(
                k.startswith("first_stage_model.")
                for k in keys
            )

            # Also detect architecture while we have the keys
            arch = "unknown"
            try:
                _detect = _import("studio_workshop", "detect_architecture")
                arch_info = _detect(keys)
                arch = arch_info.get("arch", "unknown")
            except Exception:
                log.exception("Architecture detection failed")

            if arch and arch != "unknown":
                _model_arch_cache[filepath] = arch
            return {"needs_te": not has_te, "needs_vae": not has_vae, "arch": arch}
        except Exception as e:
            print(f"{TAG} check_model_te error: {e}")
            return {"needs_te": False, "needs_vae": False, "arch": "unknown"}

    def _find_lora_preview(filepath):
        """Find preview image for a LoRA file. Checks common naming conventions."""
        base = os.path.splitext(filepath)[0]
        for ext in ('.preview.png', '.preview.jpg', '.preview.jpeg', '.preview.webp',
                    '.png', '.jpg', '.jpeg', '.webp'):
            candidate = base + ext
            if os.path.isfile(candidate):
                return candidate
        return None

    def _resolve_lora_dirs():
        """Return (primary_lora_dir, extra_dirs_list). Same logic the LoRA
        listing has always used; extracted so the Civitai module can
        share it. Returns (None, []) when no dir is configured."""
        primary = getattr(shared.cmd_opts, 'lora_dir', None)
        extras = list(getattr(shared.cmd_opts, 'lora_dirs', []))
        if not primary:
            try:
                from modules.paths import models_path
                primary = os.path.join(models_path, "Lora")
            except Exception:
                primary = None
        return primary, extras

    @app.get("/studio/loras")
    async def get_loras():
        lora_dir, extra_dirs = _resolve_lora_dirs()
        if not lora_dir:
            return []

        loras = []
        all_dirs = [lora_dir] + extra_dirs

        for base_dir in all_dirs:
            if not base_dir or not os.path.isdir(base_dir):
                continue
            for root, dirs, files in _walk_follow(base_dir):
                dirs.sort(key=_natural_sort_key)
                for f in sorted(files, key=_natural_sort_key):
                    if not f.endswith(('.safetensors', '.ckpt', '.pt')):
                        continue
                    full_path = os.path.join(root, f)
                    # Use relative path from base_dir so <lora:subfolder/name:1> works
                    rel = os.path.relpath(full_path, base_dir)
                    name = os.path.splitext(rel.replace(os.sep, "/"))[0]
                    subfolder = os.path.dirname(rel).replace(os.sep, "/")

                    preview_path = _find_lora_preview(full_path)
                    preview_url = f"/file={preview_path}" if preview_path else None

                    # Read user metadata sidecar (.json next to the LoRA file)
                    # Same format Forge Neo's extra networks uses — contains
                    # "activation text" (trigger words) and "preferred weight".
                    activation_text = ""
                    preferred_weight = 0.0
                    user_base_model = ""
                    meta_path = os.path.splitext(full_path)[0] + ".json"
                    if os.path.isfile(meta_path):
                        try:
                            with open(meta_path, "r", encoding="utf-8") as mf:
                                user_meta = json.load(mf)
                                activation_text = user_meta.get("activation text", "")
                                try:
                                    preferred_weight = float(user_meta.get("preferred weight", 0.0) or 0.0)
                                except (TypeError, ValueError):
                                    preferred_weight = 0.0
                                # Model family the user set in-app (a1111's
                                # "sd version" key, so other tools read it too).
                                user_base_model = str(user_meta.get("sd version") or "").strip()
                        except Exception:
                            log.exception("Failed to read embedding user-metadata file")

                    # Civitai Helper sidecar (<stem>.civitai.info). Merge
                    # precedence per field: user sidecar (intent) → CH info →
                    # Studio's own Civitai cache (enrichment below) → network.
                    base_model = user_base_model
                    if _civitai_read_ch is not None:
                        ch_info = _civitai_read_ch(full_path)
                        if ch_info:
                            if not base_model:
                                base_model = ch_info.get("base_model") or ""
                            if not activation_text and ch_info.get("trigger_words"):
                                activation_text = ", ".join(ch_info["trigger_words"])

                    try:
                        stat = os.stat(full_path)
                        size = stat.st_size
                        mtime = stat.st_mtime
                    except OSError:
                        size = 0
                        mtime = 0

                    loras.append({
                        "name": name,
                        "path": full_path,
                        "subfolder": subfolder,
                        "size": size,
                        "mtime": mtime,
                        "preview": preview_url,
                        "activation_text": activation_text,
                        "preferred_weight": preferred_weight,
                        "base_model": base_model,
                    })

        loras.sort(key=lambda x: _natural_sort_key(x["name"]))

        # Merge in any cached Civitai metadata (never fetches; never
        # overwrites user's local preview / sidecar trigger words).
        if _civitai_enrich is not None:
            try:
                _civitai_enrich(loras, all_dirs)
            except Exception:
                log.exception("Civitai enrichment failed")

        return loras

    @app.post("/studio/lora_preview")
    async def save_lora_preview(req: dict):
        """Save a preview image for a LoRA. Expects {name, image_b64}."""
        name = req.get("name", "")
        image_b64 = req.get("image_b64", "")
        if not name or not image_b64:
            return JSONResponse({"ok": False, "error": "Missing name or image_b64"}, status_code=400)

        # Find the LoRA file to determine where to save the preview
        lora_dir = getattr(shared.cmd_opts, 'lora_dir', None)
        extra_dirs = list(getattr(shared.cmd_opts, 'lora_dirs', []))
        if not lora_dir:
            from modules.paths import models_path
            lora_dir = os.path.join(models_path, "Lora")

        target_path = None
        for base_dir in [lora_dir] + extra_dirs:
            if not base_dir or not os.path.isdir(base_dir):
                continue
            for ext in ('.safetensors', '.ckpt', '.pt'):
                candidate = os.path.join(base_dir, name.replace("/", os.sep) + ext)
                if os.path.isfile(candidate):
                    target_path = candidate
                    break
            if target_path:
                break

        if not target_path:
            return JSONResponse({"ok": False, "error": f"LoRA not found: {name}"}, status_code=404)

        try:
            # Strip data URL prefix if present
            b64_data = image_b64
            if "," in b64_data:
                b64_data = b64_data.split(",", 1)[1]

            img_bytes = base64.b64decode(b64_data)
            preview_path = os.path.splitext(target_path)[0] + ".preview.png"

            # Save as PNG (standardized format)
            img = Image.open(io.BytesIO(img_bytes))
            # Resize to reasonable preview size (max 512px)
            max_dim = 512
            if img.width > max_dim or img.height > max_dim:
                img.thumbnail((max_dim, max_dim), Image.LANCZOS)
            img.save(preview_path, format="PNG", icc_profile=_SRGB_ICC)

            print(f"{TAG} Saved LoRA preview: {preview_path}")
            return {"ok": True, "path": preview_path}
        except Exception as e:
            log.exception("LoRA preview save failed")
            return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

    @app.delete("/studio/lora_preview")
    async def delete_lora_preview(name: str = ""):
        """Delete a preview image for a LoRA."""
        if not name:
            return JSONResponse({"ok": False, "error": "Missing name"}, status_code=400)

        lora_dir = getattr(shared.cmd_opts, 'lora_dir', None)
        extra_dirs = list(getattr(shared.cmd_opts, 'lora_dirs', []))
        if not lora_dir:
            from modules.paths import models_path
            lora_dir = os.path.join(models_path, "Lora")

        # Find and delete any preview file
        deleted = False
        for base_dir in [lora_dir] + extra_dirs:
            if not base_dir or not os.path.isdir(base_dir):
                continue
            for ext in ('.safetensors', '.ckpt', '.pt'):
                lora_path = os.path.join(base_dir, name.replace("/", os.sep) + ext)
                if not os.path.isfile(lora_path):
                    continue
                base = os.path.splitext(lora_path)[0]
                for pext in ('.preview.png', '.preview.jpg', '.preview.jpeg', '.preview.webp'):
                    preview = base + pext
                    if os.path.isfile(preview):
                        os.remove(preview)
                        print(f"{TAG} Deleted LoRA preview: {preview}")
                        deleted = True

        return {"ok": deleted}

    def _resolve_lora_by_stem(name):
        """Resolve a browser name ("subfolder/file", no extension) to a real
        LoRA file. The user string is only ever joined under configured LoRA
        roots with a whitelisted extension, must hit an existing file, and
        the result must resolve inside a root (realpath containment) — so a
        sidecar write can only touch <stem>.json beside an actual LoRA."""
        if not name:
            return None
        primary, extras = _resolve_lora_dirs()
        roots = [d for d in ([primary] + list(extras)) if d]
        for base_dir in roots:
            if not base_dir or not os.path.isdir(base_dir):
                continue
            for ext in ('.safetensors', '.ckpt', '.pt'):
                candidate = os.path.join(base_dir, name.replace("/", os.sep) + ext)
                if os.path.isfile(candidate) and _is_path_within_roots(candidate, roots):
                    return candidate
        return None

    @app.post("/studio/lora_metadata")
    async def save_lora_metadata(req: dict):
        """Save user-editable metadata for a LoRA into its a1111 sidecar
        (<stem>.json) — the highest-precedence layer the listing reads.

        Body: {name, activation_text?, base_model?, preferred_weight?}. Only
        provided keys are written; existing keys (description, notes, …) are
        preserved. activation_text -> "activation text" (trigger words),
        base_model -> "sd version" (model family, a1111-compatible so other
        tools see it), preferred_weight -> "preferred weight". An empty
        string clears that field; omitting a key leaves it untouched.
        """
        name = str(req.get("name") or "")
        if not name:
            return JSONResponse({"ok": False, "error": "Missing name"}, status_code=400)
        target_path = _resolve_lora_by_stem(name)
        if not target_path:
            return JSONResponse({"ok": False, "error": f"LoRA not found: {name}"}, status_code=404)
        meta_path = os.path.splitext(target_path)[0] + ".json"
        try:
            meta = {}
            if os.path.isfile(meta_path):
                try:
                    with open(meta_path, "r", encoding="utf-8") as mf:
                        loaded = json.load(mf)
                        if isinstance(loaded, dict):
                            meta = loaded
                except Exception:
                    log.warning("existing LoRA sidecar unreadable, rewriting: %s", meta_path)
            if "activation_text" in req:
                meta["activation text"] = str(req.get("activation_text") or "")
            if "base_model" in req:
                meta["sd version"] = str(req.get("base_model") or "")
            if "preferred_weight" in req:
                try:
                    meta["preferred weight"] = float(req.get("preferred_weight") or 0.0)
                except (TypeError, ValueError):
                    meta["preferred weight"] = 0.0
            _atomic_write_json(Path(meta_path), meta)
            print(f"{TAG} Saved LoRA metadata: {meta_path}")
            return {"ok": True, "path": meta_path}
        except Exception as e:
            log.exception("LoRA metadata save failed")
            return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

    # ------------------------------------------------------------------
    # Checkpoint browser: rich listing + user-selectable previews
    # ------------------------------------------------------------------

    _CKPT_EXTS = ('.safetensors', '.ckpt', '.gguf', '.pt')

    def _resolve_ckpt_dirs():
        """Checkpoint roots: --ckpt-dir when set, plus models/Stable-diffusion."""
        dirs = []
        ckpt_dir = getattr(shared.cmd_opts, 'ckpt_dir', None)
        if ckpt_dir:
            dirs.append(ckpt_dir)
        try:
            from modules.paths import models_path
            dirs.append(os.path.join(models_path, "Stable-diffusion"))
        except Exception:
            pass
        out, seen = [], set()
        for d in dirs:
            if d and d not in seen:
                seen.add(d)
                out.append(d)
        return out

    def _resolve_ckpt_by_stem(name):
        """Resolve a browser stem ("subfolder/name", no extension) to a real
        checkpoint file. The user string is only ever joined under the
        configured checkpoint roots with a whitelisted model extension, must
        hit an existing file, and the result must resolve inside a root
        (realpath containment) — so preview writes/deletes can only touch
        fixed-suffix siblings of actual checkpoints."""
        if not name:
            return None
        roots = _resolve_ckpt_dirs()
        for base_dir in roots:
            if not base_dir or not os.path.isdir(base_dir):
                continue
            for ext in _CKPT_EXTS:
                candidate = os.path.join(base_dir, name.replace("/", os.sep) + ext)
                if os.path.isfile(candidate) and _is_path_within_roots(candidate, roots):
                    return candidate
        return None

    @app.get("/studio/checkpoints")
    async def get_checkpoints():
        """Rich checkpoint listing for the checkpoint browser.

        Rides Neo's in-memory registry — the same set the model dropdown
        shows, so every card is guaranteed loadable — and enriches from
        local data only: the <stem>.preview.png-first ladder, the Civitai
        Helper .civitai.info base model, and the arch cache filled by
        check_model_te for models that were actually inspected. Never
        header-scans the collection at browse time.
        """
        roots = _resolve_ckpt_dirs()
        out = []
        try:
            checkpoints = list(sd_models.checkpoints_list.values())
        except Exception:
            checkpoints = []
        for m in checkpoints:
            filename = getattr(m, "filename", "") or ""
            stem_rel = ""
            subfolder = ""
            for r in roots:
                try:
                    rel = os.path.relpath(filename, r)
                except ValueError:
                    continue
                if not rel.startswith(".."):
                    stem_rel = os.path.splitext(rel)[0].replace(os.sep, "/")
                    subfolder = os.path.dirname(rel).replace(os.sep, "/")
                    break
            preview_path = _find_lora_preview(filename) if filename else None
            try:
                stat = os.stat(filename)
                size, mtime = stat.st_size, stat.st_mtime
            except OSError:
                size, mtime = 0, 0
            base_model = ""
            if _civitai_read_ch is not None and filename:
                ch_info = _civitai_read_ch(filename)
                if ch_info:
                    base_model = ch_info.get("base_model") or ""
            out.append({
                "title": getattr(m, "title", "") or "",
                "name": getattr(m, "model_name", "") or "",
                "hash": getattr(m, "shorthash", None),
                "filename": filename,
                "stem": stem_rel,
                "subfolder": subfolder,
                "size": size,
                "mtime": mtime,
                "preview": f"/file={preview_path}" if preview_path else None,
                "base_model": base_model,
                "arch": _model_arch_cache.get(filename, ""),
            })
        out.sort(key=lambda x: _natural_sort_key(x["title"]))
        return out

    @app.post("/studio/checkpoint_preview")
    async def save_checkpoint_preview(req: dict):
        """Save a preview image beside a checkpoint (<stem>.preview.png).
        Same contract as /studio/lora_preview, restricted to checkpoint
        dirs; the sidecar PNG survives Studio and is visible to other
        tools. Expects {name, image_b64} with name = listing stem."""
        name = req.get("name", "")
        image_b64 = req.get("image_b64", "")
        if not name or not image_b64:
            return JSONResponse({"ok": False, "error": "Missing name or image_b64"}, status_code=400)
        target_path = _resolve_ckpt_by_stem(name)
        if not target_path:
            return JSONResponse({"ok": False, "error": f"Checkpoint not found: {name}"}, status_code=404)
        try:
            b64_data = image_b64
            if "," in b64_data:
                b64_data = b64_data.split(",", 1)[1]
            img_bytes = base64.b64decode(b64_data)
            preview_path = os.path.splitext(target_path)[0] + ".preview.png"
            img = Image.open(io.BytesIO(img_bytes))
            max_dim = 512
            if img.width > max_dim or img.height > max_dim:
                img.thumbnail((max_dim, max_dim), Image.LANCZOS)
            img.save(preview_path, format="PNG", icc_profile=_SRGB_ICC)
            print(f"{TAG} Saved checkpoint preview: {preview_path}")
            return {"ok": True, "path": preview_path}
        except Exception as e:
            log.exception("Checkpoint preview save failed")
            return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

    @app.delete("/studio/checkpoint_preview")
    async def delete_checkpoint_preview(name: str = ""):
        """Delete a checkpoint's preview sidecar(s)."""
        if not name:
            return JSONResponse({"ok": False, "error": "Missing name"}, status_code=400)
        target_path = _resolve_ckpt_by_stem(name)
        if not target_path:
            return JSONResponse({"ok": False, "error": f"Checkpoint not found: {name}"}, status_code=404)
        deleted = False
        base = os.path.splitext(target_path)[0]
        for pext in ('.preview.png', '.preview.jpg', '.preview.jpeg', '.preview.webp'):
            preview = base + pext
            if os.path.isfile(preview):
                os.remove(preview)
                print(f"{TAG} Deleted checkpoint preview: {preview}")
                deleted = True
        return {"ok": deleted}

    @app.post("/studio/open_lora_folder")
    async def open_lora_folder():
        """Open the LoRA directory in the OS file manager."""
        import subprocess, platform
        lora_dir = getattr(shared.cmd_opts, 'lora_dir', None)
        if not lora_dir:
            from modules.paths import models_path
            lora_dir = os.path.join(models_path, "Lora")

        if not os.path.isdir(lora_dir):
            return JSONResponse({"ok": False, "error": "LoRA directory not found"}, status_code=404)

        try:
            system = platform.system()
            if system == "Windows":
                os.startfile(lora_dir)
            elif system == "Darwin":
                subprocess.Popen(["open", lora_dir])
            else:
                subprocess.Popen(["xdg-open", lora_dir])
            return {"ok": True, "path": lora_dir}
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

    class OpenFolderRequest(BaseModel):
        path: str

    @app.post("/studio/open_folder")
    async def open_folder(req: OpenFolderRequest, request: Request):
        """Open a folder in the OS file manager on the Forge/Studio server
        machine. Opens on the server, not the browser client. CSRF-guarded:
        a cross-site browser request cannot trigger it."""
        if not _check_same_origin(request):
            return JSONResponse({"ok": False, "error": "forbidden"}, status_code=403)
        import subprocess, platform
        target = (req.path or "").strip()
        if not target:
            return JSONResponse({"ok": False, "error": "No folder specified"}, status_code=400)
        if not os.path.isdir(target):
            return JSONResponse({"ok": False, "error": "Folder not found on the server"}, status_code=404)
        try:
            system = platform.system()
            if system == "Windows":
                os.startfile(target)
            elif system == "Darwin":
                subprocess.Popen(["open", target])
            else:
                subprocess.Popen(["xdg-open", target])
            return {"ok": True, "path": target}
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

    # ── Trusted save roots (explicit, persisted; enables typed remote/VM paths)
    class TrustRootRequest(BaseModel):
        path: str = ""

    @app.post("/studio/trust-save-root")
    async def trust_save_root(req: TrustRootRequest, request: Request):
        """Validate a typed server-visible folder and persist it as a trusted
        write root. This is the explicit user action that makes a typed path
        usable for save_dir/dest_dir — a path is NEVER trusted just by appearing
        in a generation/save request. CSRF-guarded."""
        if not _check_same_origin(request):
            return JSONResponse({"ok": False, "error": "forbidden"}, status_code=403)
        raw = (req.path or "").strip()
        if not raw:
            return {"ok": False, "error": "No path provided."}
        ok, msg = _add_trusted_root(raw)
        if ok:
            return {"ok": True, "path": msg}
        return JSONResponse({"ok": False, "error": msg}, status_code=400)

    @app.get("/studio/trusted-save-roots")
    async def get_trusted_save_roots():
        return {"roots": sorted(_load_trusted_roots())}

    @app.post("/studio/untrust-save-root")
    async def untrust_save_root(req: TrustRootRequest, request: Request):
        if not _check_same_origin(request):
            return JSONResponse({"ok": False, "error": "forbidden"}, status_code=403)
        rp = _resolved((req.path or "").strip())
        roots = _load_trusted_roots()
        if rp is not None:
            roots.discard(str(rp))
        _save_trusted_roots(roots)
        return {"ok": True}

    @app.get("/studio/file")
    async def studio_file(path: str = ""):
        """Serve a generated media/sidecar file. Hardened: only files Studio
        wrote this session (exact resolved-path allowlist) or media/sidecar
        files under Forge's own output tree, and only allowed extensions.
        Clients cannot register readable roots; resolve()+exact-match defeats
        traversal/symlink escape."""
        if not path or not _is_served_file(path):
            return JSONResponse({"error": "forbidden"}, status_code=403)
        rp = _resolved(path)
        if rp is None:
            return JSONResponse({"error": "bad path"}, status_code=400)
        if not rp.is_file():
            return JSONResponse({"error": "not found"}, status_code=404)
        return FileResponse(str(rp))

    @app.get("/studio/embeddings")
    async def get_embeddings():
        from modules.paths import models_path
        emb_dir = getattr(shared.cmd_opts, 'embeddings_dir', None)
        if not emb_dir:
            emb_dir = os.path.join(models_path, "..", "embeddings")
        embeddings = []
        if emb_dir and os.path.isdir(emb_dir):
            for f in sorted(os.listdir(emb_dir), key=_natural_sort_key):
                if f.endswith(('.safetensors', '.pt', '.bin')):
                    embeddings.append({"name": os.path.splitext(f)[0], "file": f})
        return embeddings

    @app.get("/studio/wildcards")
    async def get_wildcards():
        # Routed through the Studio-native resolver so autocomplete sees
        # exactly the wildcards generation will expand — including the
        # user's custom wildcard folder when configured. The legacy
        # `path` field is preserved as an empty string for compatibility
        # with older frontend code; real local paths are never returned.
        try:
            _list = _import("studio_dynamic_prompts", "list_wildcards")
            items = _list() or []
        except Exception:
            log.exception("Failed to list wildcards")
            return []
        items.sort(key=lambda w: _natural_sort_key(w.get("name", "")))
        return [{"name": w["name"], "path": ""} for w in items]

    @app.get("/studio/wildcard_content")
    async def get_wildcard_content(name: str = ""):
        """Return the lines of a wildcard file for preview, using the
        same resolver as generation so preview matches expansion."""
        if not name:
            return {"lines": [], "count": 0, "truncated": False}
        try:
            _get_lines = _import("studio_dynamic_prompts", "get_wildcard_lines")
            return _get_lines(name)
        except Exception:
            log.exception("Failed to read wildcard file")
            return {"lines": [], "count": 0, "truncated": False}

    # =========================================================================
    # STUDIO-NATIVE DYNAMIC PROMPTS — config & folder management
    # =========================================================================
    # Frontend pushes `studio_dynamic_prompts_enabled` as a per-generation
    # field but the wildcard folder (default vs custom path) is kept
    # server-side via these endpoints. That way Studio's generation code
    # doesn't have to trust arbitrary frontend-supplied paths on every
    # request — the folder is set once through the config endpoint and
    # validated when it changes.

    def _short_display_path(folder: str) -> str:
        """Build a short, privacy-friendly preview of a folder path.

        Returns the last two path components prefixed with `...` so the
        UI can show "...My Wildcards/anime" instead of the full
        `/home/...` or `C:\\Users\\Name\\...` path. The setting panel is
        cramped, and the full path is still available if the user wants
        it via the config endpoint.
        """
        if not folder:
            return ""
        try:
            parts = Path(folder).parts
            if len(parts) <= 2:
                return folder
            tail = Path(*parts[-2:])
            return f"...{os.sep}{tail}"
        except Exception:
            return folder

    @app.get("/studio/dynamic_prompts/config")
    async def dynamic_prompts_get_config():
        try:
            _load = _import("studio_dynamic_prompts", "load_config")
            cfg = _load()
            display = _short_display_path(cfg.get("wildcard_folder") or "")
            return {
                "studio_dynamic_prompts_enabled": bool(cfg.get("studio_dynamic_prompts_enabled", True)),
                "wildcard_folder_mode": cfg.get("wildcard_folder_mode", "default"),
                "wildcard_folder": cfg.get("wildcard_folder"),
                "wildcard_folder_display": display,
            }
        except Exception:
            log.exception("dynamic_prompts config load failed")
            return JSONResponse({"error": "load_failed"}, status_code=500)

    @app.post("/studio/dynamic_prompts/config")
    async def dynamic_prompts_set_config(body: dict):
        try:
            _save = _import("studio_dynamic_prompts", "save_config")
            _validate = _import("studio_dynamic_prompts", "validate_folder")
            cfg = _save(body or {})
            warning = None
            if cfg.get("wildcard_folder_mode") == "custom" and cfg.get("wildcard_folder"):
                info = _validate(cfg["wildcard_folder"])
                if not info.get("exists"):
                    warning = "Folder does not exist."
                elif not info.get("has_txt"):
                    warning = "No wildcard .txt files found in selected folder."
            return {
                "ok": True,
                "studio_dynamic_prompts_enabled": bool(cfg.get("studio_dynamic_prompts_enabled", True)),
                "wildcard_folder_mode": cfg.get("wildcard_folder_mode", "default"),
                "wildcard_folder": cfg.get("wildcard_folder"),
                "wildcard_folder_display": _short_display_path(cfg.get("wildcard_folder") or ""),
                "warning": warning,
            }
        except Exception:
            log.exception("dynamic_prompts config save failed")
            return JSONResponse({"error": "save_failed"}, status_code=500)

    @app.post("/studio/dynamic_prompts/select_folder")
    async def dynamic_prompts_select_folder(body: dict):
        """Validate a candidate folder and persist it as the custom
        wildcard root. The frontend supplies the path (no server-side
        native folder picker is available in this remote-API context);
        this endpoint exists so the path-validation/persistence logic
        lives next to the rest of the config and can be reused if a
        native picker is added later.
        """
        try:
            _save = _import("studio_dynamic_prompts", "save_config")
            _validate = _import("studio_dynamic_prompts", "validate_folder")
            _load = _import("studio_dynamic_prompts", "load_config")
            folder = (body or {}).get("folder")
            if folder is None or (isinstance(folder, str) and not folder.strip()):
                # Treat empty path as a reset to default mode.
                cfg = _save({"wildcard_folder_mode": "default", "wildcard_folder": None,
                             "studio_dynamic_prompts_enabled":
                             _load().get("studio_dynamic_prompts_enabled", True)})
                return {
                    "ok": True,
                    "wildcard_folder_mode": cfg.get("wildcard_folder_mode"),
                    "wildcard_folder": cfg.get("wildcard_folder"),
                    "wildcard_folder_display": "",
                    "warning": None,
                }
            existing = _load()
            cfg = _save({
                "studio_dynamic_prompts_enabled":
                    existing.get("studio_dynamic_prompts_enabled", True),
                "wildcard_folder_mode": "custom",
                "wildcard_folder": folder,
            })
            info = _validate(cfg.get("wildcard_folder") or "")
            warning = None
            if not info.get("exists"):
                warning = "Folder does not exist."
            elif not info.get("has_txt"):
                warning = "No wildcard .txt files found in selected folder."
            return {
                "ok": True,
                "wildcard_folder_mode": cfg.get("wildcard_folder_mode"),
                "wildcard_folder": cfg.get("wildcard_folder"),
                "wildcard_folder_display": _short_display_path(cfg.get("wildcard_folder") or ""),
                "warning": warning,
            }
        except Exception:
            log.exception("dynamic_prompts folder select failed")
            return JSONResponse({"error": "select_failed"}, status_code=500)

    @app.post("/studio/dynamic_prompts/pick_folder")
    async def dynamic_prompts_pick_folder():
        """Open a native folder-picker dialog and return the chosen
        path WITHOUT persisting it. Frontend follows up with
        select_folder to validate + save.

        Mirrors the gallery's pick-folder endpoint (same Tk pattern).
        Only works when Studio is running on the user's machine — fine
        for the standard local-host case; in a headless server context
        this raises and the frontend falls back to the manual path
        field.
        """
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.wm_attributes('-topmost', 1)
            folder = filedialog.askdirectory(title="Select wildcards folder")
            root.destroy()
            if folder:
                return {"path": folder.replace("/", os.sep)}
            return {"path": ""}
        except Exception as e:
            # Tk unavailable (headless host, missing display) — let the
            # frontend know so it can show the manual fallback.
            return JSONResponse({"error": str(e), "unavailable": True}, status_code=500)

    @app.get("/studio/dynamic_prompts/status")
    async def dynamic_prompts_status():
        """Report whether the external Dynamic Prompts script is loaded
        so the frontend can show its compatibility note.
        """
        dp_present = False
        try:
            import modules.scripts as mod_scripts
            for runner in [mod_scripts.scripts_txt2img, mod_scripts.scripts_img2img]:
                if not runner:
                    continue
                for s in getattr(runner, "alwayson_scripts", []):
                    try:
                        if s.title().strip().lower() == "dynamic prompts":
                            dp_present = True
                            break
                    except Exception:
                        continue
                if dp_present:
                    break
        except Exception:
            log.exception("dynamic_prompts status probe failed")
        return {"dp_extension_present": dp_present}

    @app.get("/studio/watermarks")
    async def get_watermarks():
        """List selectable watermark files for the Settings dropdown.

        Same shape as /studio/loras. The folder is fixed (<ext>/watermarks/);
        only the selection varies, so this is a list-files endpoint rather
        than a folder-path picker.
        """
        try:
            _list = _import("studio_watermark", "list_watermarks")
            return _list()
        except Exception:
            log.exception("watermark list failed")
            return []

    @app.post("/studio/export_watermark")
    async def export_watermark(req: dict):
        """Stamp a flattened export image with the configured watermark.

        Single-implementation rule: compositing is studio_generation's
        apply_watermark — the exact code the legacy generation-time mode
        uses. The canvas Save/Export flow round-trips its flattened PNG
        through here only when export-time stamping is on, then embeds
        infotext downstream so the shipped file carries both.
        Expects {image_b64, name, position, opacity, scale, margin,
        rotation}; returns {ok, changed, image_b64} (PNG data URL).
        """
        image_b64 = req.get("image_b64") or ""
        name = str(req.get("name") or "").strip()
        if not image_b64:
            return JSONResponse({"ok": False, "error": "Missing image_b64"}, status_code=400)
        if not name:
            return JSONResponse({"ok": False, "error": "No watermark configured"}, status_code=400)

        def _num(key, default, cast):
            try:
                v = req.get(key)
                return default if v is None else cast(v)
            except (TypeError, ValueError):
                return default

        try:
            b64_data = image_b64.split(",", 1)[1] if "," in image_b64 else image_b64
            img = Image.open(io.BytesIO(base64.b64decode(b64_data)))
            # A canvas export can be RGBA (PNG preserves transparency).
            # apply_watermark composites correctly but flattens to RGB, which
            # would turn transparent pixels opaque black. Capture the original
            # alpha so we can re-attach it to the stamped result, keeping the
            # export transparent where the source was.
            orig_alpha = None
            if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
                orig_alpha = img.convert("RGBA").getchannel("A")
            wm_cfg = {
                "enable": True,
                "name": name,
                "position": str(req.get("position") or "bottom-right"),
                "opacity": _num("opacity", 1.0, float),
                "scale": _num("scale", 0.15, float),
                "margin": _num("margin", 16, int),
                "rotation": _num("rotation", 0.0, float),
            }
            _apply = _import("studio_generation", "apply_watermark")
            stamped, changed = _apply(img, wm_cfg)
            if changed and orig_alpha is not None:
                stamped = stamped.convert("RGBA")
                stamped.putalpha(orig_alpha)
            buf = io.BytesIO()
            stamped.save(buf, format="PNG")
            return {
                "ok": True,
                "changed": bool(changed),
                "image_b64": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii"),
            }
        except Exception as e:
            log.exception("Export watermark failed")
            return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

    @app.post("/studio/watermarks/open_folder")
    async def open_watermarks_folder():
        """Open the watermarks folder in the OS file manager so the user can
        drop images in. Best-effort: returns {"unavailable": True} on headless
        hosts (no display), surfacing the path so the UI can show it instead.
        """
        try:
            _dir = _import("studio_watermark", "watermarks_dir_display")
            folder = _dir()
        except Exception:
            log.exception("watermark folder resolve failed")
            return JSONResponse({"error": "resolve_failed"}, status_code=500)
        try:
            if sys.platform.startswith("win"):
                os.startfile(folder)  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.Popen(["open", folder])
            else:
                subprocess.Popen(["xdg-open", folder])
            return {"ok": True, "path": folder}
        except Exception as e:
            # No file manager / headless — let the UI show the path.
            return {"ok": False, "unavailable": True, "path": folder, "error": str(e)}

    @app.get("/studio/cn_models")
    async def get_cn_models():
        try:
            _get = _import("studio_controlnet", "get_cn_models")
            return [{"name": m} for m in _get()]
        except Exception:
            return [{"name": "None"}]

    @app.get("/studio/cn_preprocessors")
    async def get_cn_preprocessors():
        try:
            _get = _import("studio_controlnet", "get_cn_preprocessors")
            return [{"name": p} for p in _get()]
        except Exception:
            return [{"name": "None"}]

    @app.get("/studio/ad_models")
    async def get_ad_models():
        try:
            _get = _import("studio_adetailer", "get_ad_models")
            return [{"name": m} for m in _get()]
        except Exception:
            return [{"name": "None"}]

    @app.post("/studio/load_model")
    async def load_model(body: dict):
        title = body.get("title", "")
        text_encoder = body.get("text_encoder", "")
        vae = body.get("vae", "")
        if not title:
            return JSONResponse({"error": "No model title"}, status_code=400)
        try:
            info = sd_models.get_closet_checkpoint_match(title)
            if not info:
                return JSONResponse({"error": f"Not found: {title}"}, status_code=404)

            # Build additional_modules fresh on every call. The previous
            # forge_loading_parameters["additional_modules"] is NOT preserved
            # — that's the whole point. A frontend switch from a model that
            # needs an external TE (Anima/Cosmos) to one that bundles its
            # own (SDXL) must drop the old TE entry. Any of "None",
            # "Bundled", "", or a missing text_encoder field all mean
            # "no external TE for this load".
            additional = []
            models_dir = getattr(shared, 'models_path', 'models')

            _no_te = text_encoder is None or text_encoder in ("None", "Bundled", "")
            if not _no_te:
                te_path = os.path.join(models_dir, "text_encoder", text_encoder)
                if os.path.isfile(te_path):
                    additional.append(te_path)
                    print(f"{TAG} Text encoder: {text_encoder}")
                else:
                    print(f"{TAG} Warning: text encoder not found: {te_path}")
            else:
                # Logged so the bug we just fixed stays diagnosable.
                print(f"{TAG} No external text encoder for this load")

            # VAE as additional module (when model needs external VAE)
            if vae and vae not in ("Automatic", "None", ""):
                from modules import sd_vae
                sd_vae.refresh_vae_list()
                vae_path = sd_vae.vae_dict.get(vae)
                if vae_path and os.path.isfile(vae_path):
                    additional.append(vae_path)
                    print(f"{TAG} VAE (additional module): {vae}")

            # Forge Neo uses model_data.forge_loading_parameters to control
            # which model gets loaded. forge_model_reload() checks if the
            # parameters hash changed and only reloads if it did.
            sd_models.model_data.forge_loading_parameters = {
                "checkpoint_info": info,
                "additional_modules": additional,
                "unet_storage_dtype": None,
            }

            # Also update shared.opts so the UI stays in sync
            shared.opts.data["sd_model_checkpoint"] = info.title

            # Persist to config.json so Forge loads this model on next restart
            try:
                shared.opts.save(shared.config_filename)
            except Exception:
                pass  # Non-critical — model loads fine, just won't persist

            # Trigger the actual reload
            await asyncio.to_thread(sd_models.forge_model_reload)

            _log_vram(f"Model loaded: {info.title}"
                      f" ({len(additional)} additional module(s))")
            return {"ok": True, "loaded": info.title}
        except Exception as e:
            log.exception("Model load failed")
            return JSONResponse({"error": str(e)}, status_code=500)

    @app.post("/studio/refresh_models")
    async def refresh_models():
        sd_models.list_models()
        return {"ok": True, "count": len(sd_models.checkpoints_list)}

    # ------------------------------------------------------------------
    # VRAM Management
    # ------------------------------------------------------------------

    @app.post("/studio/unload_model")
    async def unload_model():
        """Unload the current model from VRAM."""
        _cancel_auto_unload()
        try:
            if not hasattr(shared, 'sd_model') or shared.sd_model is None:
                _log_vram("Already unloaded")
                return {"ok": True, "status": "already_unloaded"}
            await asyncio.to_thread(sd_models.unload_model_weights)
            _log_vram("Model unloaded (manual)")
            return {"ok": True, "status": "unloaded"}
        except Exception as e:
            print(f"{TAG} Unload failed: {e}")
            return JSONResponse({"error": str(e)}, status_code=500)

    @app.get("/studio/model_status")
    async def model_status():
        """Check whether a model is currently loaded in VRAM.

        Also reports privacy-safe details about the current
        additional_modules list so the stale-TE class of bug can be
        diagnosed — and the generation preflight can compare backend
        against UI — without leaking user-local file paths. We return the
        same display names the dropdowns use (VAE dict key, text-encoder
        path relative to models/text_encoder/), never the absolute path.
        """
        loaded = (
            hasattr(shared, 'sd_model')
            and shared.sd_model is not None
            and hasattr(shared.sd_model, 'sd_checkpoint_info')
            and shared.sd_model.sd_checkpoint_info is not None
        )
        title = ""
        if loaded:
            title = getattr(shared.sd_model.sd_checkpoint_info, 'title', '')

        additional_count = 0
        has_external_te = False
        has_external_vae = False
        external_te_name = None
        external_vae_name = None
        try:
            params = sd_models.model_data.forge_loading_parameters or {}
            mods = params.get("additional_modules") or []
            additional_count = len(mods)
            # Classify by directory bucket. Report display names only.
            from modules import sd_vae
            try:
                sd_vae.refresh_vae_list()
            except Exception:
                pass
            # Reverse map normalized path -> dict key so we can surface the
            # same name the VAE dropdown shows (not the absolute path).
            vae_by_path = {}
            for vname, p in (sd_vae.vae_dict or {}).items():
                if not p:
                    continue
                try:
                    vae_by_path[os.path.normcase(os.path.abspath(p))] = vname
                except Exception:
                    pass
            models_dir = getattr(shared, 'models_path', 'models')
            te_dir = os.path.join(models_dir, "text_encoder")
            for m in mods:
                if not m:
                    continue
                try:
                    norm = os.path.normcase(os.path.abspath(m))
                except Exception:
                    norm = m
                if norm in vae_by_path:
                    has_external_vae = True
                    external_vae_name = vae_by_path[norm]
                    continue
                # Anything else under text_encoder/ counts as a TE entry.
                if (os.sep + "text_encoder" + os.sep) in norm:
                    has_external_te = True
                    try:
                        external_te_name = os.path.relpath(m, te_dir).replace("\\", "/")
                    except Exception:
                        external_te_name = os.path.basename(m)
                else:
                    # Unclassified — assume TE-like for safety so the
                    # status surfaces a non-VAE module to investigate.
                    has_external_te = True
                    external_te_name = os.path.basename(m)
        except Exception:
            log.exception("model_status component classification failed")

        return {
            "loaded": loaded,
            "title": title,
            "additional_modules_count": additional_count,
            "has_external_text_encoder": has_external_te,
            "has_external_vae": has_external_vae,
            # Display names (null when none) for the generation preflight to
            # compare against the UI selection. No absolute paths.
            "external_text_encoder": external_te_name,
            "external_vae": external_vae_name,
            "auto_unload_enabled": _auto_unload_enabled,
            "auto_unload_minutes": _auto_unload_minutes,
        }

    @app.post("/studio/auto_unload")
    async def set_auto_unload(body: dict):
        """Configure auto-unload settings."""
        global _auto_unload_enabled, _auto_unload_minutes
        if "enabled" in body:
            _auto_unload_enabled = bool(body["enabled"])
        if "minutes" in body:
            _auto_unload_minutes = max(5, min(30, int(body["minutes"])))
        # If enabling, start the timer from now; if disabling, cancel
        if _auto_unload_enabled:
            _schedule_auto_unload()
        else:
            _cancel_auto_unload()
        print(f"{TAG} Auto-unload: {'ON' if _auto_unload_enabled else 'OFF'}, "
              f"{_auto_unload_minutes}min")
        return {
            "ok": True,
            "enabled": _auto_unload_enabled,
            "minutes": _auto_unload_minutes,
        }

    @app.get("/studio/vram")
    async def get_vram():
        """Return GPU VRAM usage from torch.cuda."""
        try:
            import torch
            if not torch.cuda.is_available():
                return {"available": False}
            allocated = torch.cuda.memory_allocated() / (1024 ** 3)  # GB
            reserved = torch.cuda.memory_reserved() / (1024 ** 3)
            total = torch.cuda.get_device_properties(0).total_memory / (1024 ** 3)
            name = torch.cuda.get_device_properties(0).name
            # Read current reserve setting
            current_reserve = 0.0
            total_vram_mb = 0
            try:
                from backend import memory_management as mm
                current_reserve = max(mm.SETTING_RESERVED_VRAM, 0) / (1024 ** 3)
                total_vram_mb = mm.total_vram
            except Exception:
                log.exception("Failed to read VRAM reserve setting")
            return {
                "available": True,
                "allocated_gb": round(allocated, 2),
                "reserved_gb": round(reserved, 2),
                "total_gb": round(total, 2),
                "gpu_name": name,
                "vram_reserve_gb": round(current_reserve, 2),
                "total_vram_mb": round(total_vram_mb, 0),
            }
        except Exception as e:
            return {"available": False, "error": str(e)}

    @app.post("/studio/vram_reserve")
    async def set_vram_reserve(request: Request):
        """Set the VRAM reserve amount (GB kept free for compute).
        Calls Forge's memory_management.set_reserved_memory() which is the
        same function the GPU Weights slider in standard Forge UI uses.
        The slider takes a 0-1 value (% of VRAM for weights); we convert
        from GB reserve to that percentage."""
        try:
            data = await request.json()
            gb = float(data.get("gb", 1.5))
            reset = data.get("reset", False)
            # Cap at actual VRAM minus a small safety margin (1 GB for compute headroom)
            try:
                from backend import memory_management as mm
                max_gb = max(0.0, (mm.total_vram / 1024.0) - 1.0)
            except Exception:
                max_gb = 8.0  # fallback if memory_management isn't available yet
            gb = max(0.0, min(max_gb, gb))

            try:
                from backend import memory_management as mm
                if reset or gb == 0:
                    # Reset to Forge default — set SETTING_RESERVED_VRAM to -1
                    # so extra_reserved_memory() falls back to EXTRA_RESERVED_VRAM
                    mm.SETTING_RESERVED_VRAM = -1
                    print(f"{TAG} VRAM reserve reset to Forge default "
                          f"(built-in reserve: {mm.EXTRA_RESERVED_VRAM / (1024*1024):.0f} MB)")
                    return {"ok": True, "reserve_gb": 0, "mode": "auto"}
                # Convert GB reserve to the 0-1 scale Forge expects
                val = 1.0 - (gb * 1024.0 / mm.total_vram) if mm.total_vram > 0 else 0.75
                val = max(0.0, min(1.0, val))
                mm.set_reserved_memory(val)
                actual_reserve_mb = mm.SETTING_RESERVED_VRAM / (1024 * 1024)
                print(f"{TAG} VRAM reserve: {gb:.1f} GB requested → "
                      f"set_reserved_memory({val:.3f}) → "
                      f"{actual_reserve_mb:.0f} MB reserved, "
                      f"{mm.total_vram - actual_reserve_mb:.0f} MB for weights")
                return {
                    "ok": True,
                    "reserve_gb": round(actual_reserve_mb / 1024, 2),
                    "weights_pct": round(val * 100, 1),
                    "total_vram_mb": round(mm.total_vram, 0),
                }
            except ImportError:
                return JSONResponse(
                    {"error": "Could not access Forge memory management module"},
                    status_code=500,
                )
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)

    # ------------------------------------------------------------------
    # Develop presets — JSON files under presets/develop/<name>.json
    # Used by the Develop module (frontend/develop.js) for save/restore of
    # user post-processing presets.
    # ------------------------------------------------------------------

    class DevelopPresetSaveRequest(BaseModel):
        name: str
        params: dict

    def _develop_presets_dir() -> Path:
        _here = Path(__file__).parent
        _ext_root = _here if (_here / "frontend").is_dir() else _here.parent
        d = _ext_root / "presets" / "develop"
        d.mkdir(parents=True, exist_ok=True)
        return d

    _DEV_NAME_RE = re.compile(r"^[A-Za-z0-9 _-]{1,64}$")

    @app.get("/studio/develop/presets")
    async def develop_presets_list():
        try:
            base = _develop_presets_dir()
            out = []
            for f in sorted(base.glob("*.json")):
                try:
                    data = json.loads(f.read_text(encoding="utf-8"))
                    if not isinstance(data, dict):
                        continue
                    out.append({"name": f.stem, "params": data})
                except Exception:
                    continue
            return {"presets": out}
        except Exception as e:
            return JSONResponse({"presets": [], "error": str(e)}, status_code=500)

    @app.post("/studio/develop/presets")
    async def develop_preset_save(req: DevelopPresetSaveRequest):
        try:
            name = (req.name or "").strip()
            if not _DEV_NAME_RE.match(name):
                return JSONResponse(
                    {"ok": False, "error": "Invalid name (1-64 chars: letters, digits, space, _ -)"},
                    status_code=400,
                )
            params = req.params or {}
            if not isinstance(params, dict) or "_version" not in params:
                return JSONResponse(
                    {"ok": False, "error": "Missing _version in params"},
                    status_code=400,
                )
            base = _develop_presets_dir()
            target = (base / (name + ".json")).resolve()
            base_resolved = base.resolve()
            # Path traversal guard
            try:
                target.relative_to(base_resolved)
            except ValueError:
                return JSONResponse({"ok": False, "error": "Invalid path"}, status_code=400)
            _atomic_write_json(target, params)
            return {"ok": True, "name": name}
        except Exception as e:
            log.exception("Develop preset save failed")
            return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

    # ------------------------------------------------------------------
    # Image saving
    # ------------------------------------------------------------------

    class SaveImageRequest(BaseModel):
        image_b64: str
        format: str = "png"          # png | jpeg | webp
        quality: int = Field(default=80, ge=1, le=100)  # for jpeg/webp
        subfolder: str = ""          # optional subfolder under output dir
        dest_dir: Optional[str] = None  # optional absolute folder (configurable "Save to Gallery folder"); confined to safe write roots
        filename: Optional[str] = None  # optional custom filename (without ext)
        save_token: Optional[str] = None  # DEPRECATED — server-side Save As removed; rejected if set
        full_path: Optional[str] = None   # DEPRECATED — server-side Save As removed; rejected if set
        metadata: Optional[str] = None  # infotext to embed (PNG tEXt, JPEG/WebP EXIF UserComment)

    @app.post("/studio/save_image")
    async def save_image(req: SaveImageRequest, request: Request):
        # CSRF: reject cross-site browser requests to this path-writing endpoint.
        if not _check_same_origin(request):
            return JSONResponse({"ok": False, "error": "forbidden"}, status_code=403)
        try:
            # Decode image — surface a clear message rather than a raw
            # binascii/PIL error. validate=True catches malformed base64;
            # img.load() forces any lazy decode error to happen here.
            try:
                b64 = req.image_b64
                if "," in b64:
                    b64 = b64.split(",", 1)[1]
                img = Image.open(io.BytesIO(base64.b64decode(b64, validate=True)))
                img.load()
            except Exception as de:
                raise ValueError(f"Invalid image data: {de}")

            # Server-side "Save As" (a client-supplied token or absolute path the
            # backend would write to) has been REMOVED. Normal "Save As" is now
            # browser-side only, so the backend never writes to a client-chosen
            # arbitrary path — that eliminates the arbitrary file-write primitive.
            # The fields remain on the request model so a stale frontend gets a
            # clear error instead of a silently misdirected save. Writes below are
            # confined to Studio's output root / trusted Gallery folders only.
            if req.save_token or (req.full_path or "").strip():
                return JSONResponse(
                    {"ok": False, "error": "Server-side Save As has been disabled. "
                     "Use browser Save As / Download instead."},
                    status_code=400)

            # Determine output directory — same logic as generation auto-save
            try:
                base_outdir = shared.opts.data.get("outdir_samples", "")
                if not base_outdir:
                    base_outdir = shared.opts.data.get("outdir_img2img_samples", "")
                if not base_outdir:
                    from modules.paths import data_path
                    base_outdir = os.path.join(data_path, "output")
                if os.path.basename(base_outdir) in ("txt2img-images", "img2img-images"):
                    base_outdir = os.path.dirname(base_outdir)
            except Exception:
                base_outdir = os.path.abspath("output")

            safe_sub = ""
            if req.subfolder:
                # Sanitize subfolder — no path traversal
                safe_sub = req.subfolder.replace("..", "").replace("\\", "/").strip("/")

            def _probe_writable(d: Path) -> bool:
                """Real write probe — os.access() is unreliable on Windows."""
                try:
                    d.mkdir(parents=True, exist_ok=True)
                    with tempfile.NamedTemporaryFile(dir=str(d), prefix=".wmprobe_", delete=True):
                        pass
                    return True
                except Exception:
                    return False

            used_fallback = False

            # Explicit destination folder (configurable "Save to Gallery
            # folder") takes precedence — a server-side absolute path the user
            # chose. No silent fallback here: an unwritable configured folder
            # must surface a clear error rather than quietly landing somewhere
            # unexpected.
            dest_dir = (req.dest_dir or "").strip()
            if dest_dir and not _safe_write_root(dest_dir):
                # Confine to safe write roots — a random/cross-site client must
                # not be able to write to an arbitrary absolute path.
                return JSONResponse(
                    {"ok": False, "error": "Save folder is outside an allowed location. "
                     "Pick it via Browse, or set STUDIO_SAVE_ROOTS on the server."},
                    status_code=403)
            if dest_dir:
                output_dir = Path(dest_dir).expanduser()
                if not _probe_writable(output_dir):
                    raise RuntimeError(
                        "The configured Save to Gallery folder could not be "
                        "written to. Check that the path exists on the Forge/"
                        "Studio server and is writable."
                    )
            else:
                # Primary location; fall back to an extension-local folder if
                # the configured output dir isn't writable (the most common
                # cause of the historical "Save failed: 500"). User-facing
                # notice avoids leaking absolute paths.
                primary = Path(base_outdir) / "studio"
                if safe_sub:
                    primary = primary / safe_sub
                if _probe_writable(primary):
                    output_dir = primary
                else:
                    here = Path(__file__).parent
                    ext_root = here if (here / "frontend").is_dir() else here.parent
                    fallback = ext_root / "output" / "studio"
                    if safe_sub:
                        fallback = fallback / safe_sub
                    if not _probe_writable(fallback):
                        raise RuntimeError(
                            "Could not write to the output folder or the Studio "
                            "fallback folder. Check folder permissions."
                        )
                    output_dir = fallback
                    used_fallback = True
                    log.warning("save_image: primary outdir not writable (%s); using fallback %s",
                                primary, fallback)

            # Filename
            ext_map = {"png": "png", "jpeg": "jpg", "webp": "webp"}
            ext = ext_map.get(req.format, "png")
            # Sanitize the user-supplied filename: strip path separators,
            # trim, and collapse anything that isn't a safe filename
            # character. Empty result falls back to studio_<ts>_<pid>.
            raw = (req.filename or "").strip()
            if raw:
                # Drop directory components in case a path slipped through
                raw = os.path.basename(raw)
                # Strip any extension the caller appended; we add ours below
                stem = os.path.splitext(raw)[0]
                # Replace control / separator chars; keep alnum, space,
                # dash, underscore, dot, parentheses
                safe = re.sub(r"[^\w\-. ()]", "_", stem).strip(" .")
                name = safe[:120] if safe else ""
            else:
                name = ""
            if not name:
                name = f"studio_{int(time.time())}_{os.getpid()}"
            # Ensure unique
            path = output_dir / f"{name}.{ext}"
            counter = 1
            while path.exists():
                path = output_dir / f"{name}_{counter}.{ext}"
                counter += 1

            # Save with format conversion
            save_kwargs = {}
            if req.format == "jpeg":
                img = img.convert("RGB")  # drop alpha for JPEG
                save_kwargs = _final_jpeg_save_kwargs(req.quality)  # 4:4:4
                if req.metadata:
                    exif_bytes = _build_exif_usercomment(req.metadata)
                    if exif_bytes:
                        save_kwargs["exif"] = exif_bytes
            elif req.format == "webp":
                save_kwargs = {"quality": req.quality}
                if req.metadata:
                    exif_bytes = _build_exif_usercomment(req.metadata)
                    if exif_bytes:
                        save_kwargs["exif"] = exif_bytes
            elif req.format == "png" and req.metadata:
                # Embed metadata as PNG tEXt chunk
                from PIL.PngImagePlugin import PngInfo
                pnginfo = PngInfo()
                pnginfo.add_text("parameters", req.metadata)
                save_kwargs["pnginfo"] = pnginfo

            img.save(str(path), icc_profile=_SRGB_ICC, **save_kwargs)
            print(f"{TAG} Saved {req.format.upper()} → {path}")

            resp = {"ok": True, "path": str(path), "filename": path.name}
            if used_fallback:
                resp["notice"] = ("Primary output folder is not writable; "
                                  "saved to the Studio fallback output folder.")
            return resp

        except Exception as e:
            log.exception("Save handler failed")
            return JSONResponse({"error": str(e)}, status_code=500)

    # ------------------------------------------------------------------
    # Color diagnostic — Pillow-decoded pixel sampling
    # ------------------------------------------------------------------
    # Maintainer-only diagnostic. Resolves a /file= URL or absolute path
    # to a local image, opens it with Pillow, optionally converts to
    # sRGB (if the file carries a non-sRGB ICC), and returns RGB(A)
    # samples at the requested document-space coordinates. This is the
    # ground-truth comparison point against the various browser-side
    # decode paths that the StudioDebug.sampleColorPipelineSet diagnostic
    # already covers.
    #
    # Privacy: never returns or logs paths, prompts, filenames, or image
    # bytes. Errors are reported with generic strings only.

    class _PixelSample(BaseModel):
        label: str = ""
        x: int
        y: int

    class SampleImagePixelsRequest(BaseModel):
        source: str
        samples: List[_PixelSample] = []

    def _resolve_diagnostic_source_path(source: str):
        """Same security model as serve_local_file: parse the path out of
        a /file= URL, resolve absolute, and require it to live under one
        of the allowed output roots. Returns None if invalid/disallowed."""
        if not source:
            return None
        raw = source
        # Pull out the path portion after /file=
        if "/file=" in raw:
            raw = raw.split("/file=", 1)[1]
        try:
            from urllib.parse import unquote
            raw = unquote(raw)
        except Exception:
            pass
        for sep in ("?", "#"):
            if sep in raw:
                raw = raw.split(sep, 1)[0]
        try:
            resolved = Path(raw)
            if not resolved.is_absolute():
                resolved = Path.cwd() / resolved
            resolved = resolved.resolve()
        except Exception:
            return None
        allowed_roots = [str(Path.cwd().resolve())]
        try:
            _outdir = shared.opts.data.get("outdir_samples", "") or shared.opts.data.get("outdir_img2img_samples", "")
            if _outdir:
                allowed_roots.append(str(Path(_outdir).resolve()))
            for _key in ("outdir_txt2img_samples", "outdir_img2img_samples", "outdir_save"):
                _d = shared.opts.data.get(_key, "")
                if _d:
                    allowed_roots.append(str(Path(_d).resolve()))
                    allowed_roots.append(str(Path(_d).resolve().parent))
        except Exception:
            pass
        if not _is_path_within_roots(resolved, allowed_roots):
            return None
        if not resolved.is_file():
            return None
        return resolved

    @app.post("/studio/sample_image_pixels")
    def sample_image_pixels(req: SampleImagePixelsRequest):
        path = _resolve_diagnostic_source_path(req.source)
        if path is None:
            return JSONResponse({"ok": False, "error": "source not accessible"}, status_code=400)
        try:
            img = Image.open(str(path))
            img.load()
        except Exception:
            print(f"{TAG} Failed backend color sample (open)")
            return JSONResponse({"ok": False, "error": "open failed"}, status_code=500)

        # ICC handling: if the file carries a non-sRGB profile, convert to
        # sRGB for sampling so the returned values are in the same space
        # as the rest of the diagnostic stages. If no ICC, treat as sRGB.
        icc_bytes = img.info.get("icc_profile")
        icc_present = bool(icc_bytes)
        icc_desc = None
        converted_to_srgb = False
        if icc_bytes:
            try:
                from PIL import ImageCms
                src_profile = ImageCms.ImageCmsProfile(io.BytesIO(icc_bytes))
                icc_desc = (ImageCms.getProfileDescription(src_profile) or "").strip() or None
                # Heuristic: only convert when the description doesn't
                # mention sRGB. This avoids a no-op roundtrip on already-
                # sRGB tagged files (the common case for autosaves).
                if icc_desc and "sRGB" not in icc_desc and "srgb" not in icc_desc.lower():
                    try:
                        srgb_profile = ImageCms.ImageCmsProfile(io.BytesIO(_SRGB_ICC))
                        target_mode = "RGBA" if img.mode in ("RGBA", "LA", "PA") else "RGB"
                        img = ImageCms.profileToProfile(img, src_profile, srgb_profile, outputMode=target_mode)
                        converted_to_srgb = True
                    except Exception:
                        print(f"{TAG} Failed ICC conversion during color sample")
            except Exception:
                pass

        # Convert to RGBA for consistent sampling (4-tuple always).
        try:
            img_rgba = img.convert("RGBA")
        except Exception:
            print(f"{TAG} Failed backend color sample (convert)")
            return JSONResponse({"ok": False, "error": "convert failed"}, status_code=500)

        w, h = img_rgba.size
        sample_results = []
        for s in (req.samples or []):
            try:
                cx = max(0, min(int(s.x), w - 1))
                cy = max(0, min(int(s.y), h - 1))
                px = img_rgba.getpixel((cx, cy))
                if isinstance(px, int):
                    px = (px, px, px, 255)
                while len(px) < 4:
                    px = (*px, 255)
                sample_results.append({
                    "label": s.label or f"pt({cx},{cy})",
                    "x": cx, "y": cy,
                    "r": px[0], "g": px[1], "b": px[2], "a": px[3],
                })
            except Exception:
                sample_results.append({
                    "label": s.label,
                    "x": s.x, "y": s.y,
                    "error": "sample failed",
                })

        return {
            "ok": True,
            "width": w,
            "height": h,
            "mode": img.mode,
            "icc": {
                "present": icc_present,
                "description": icc_desc,
                "converted_to_srgb": converted_to_srgb,
            },
            "samples": sample_results,
        }

    # ------------------------------------------------------------------
    # Raw-pixel canvas import
    # ------------------------------------------------------------------
    # POST /studio/image_pixels resolves a same-origin /file= URL to a
    # trusted Studio output, decodes with Pillow, ICC-converts to sRGB if
    # needed, and returns raw RGBA bytes via application/octet-stream
    # with X-Width / X-Height / X-Color-Profile headers. The frontend
    # builds an ImageData from the bytes and putImageData onto the layer
    # canvas — this bypasses the browser's image decode path entirely,
    # so Firefox's display-ICC bake (the source of the chromatic
    # desaturation Moritz hit) doesn't get a chance to mutate pixels
    # before they land on the canvas.
    #
    # Privacy: never returns or logs paths/prompts/filenames/image bytes.

    def _pil_to_srgb_rgba(img):
        """Convert an opened PIL image to RGBA in sRGB. Honors an embedded
        ICC profile (converted via ImageCms); untagged images are treated
        as sRGB. Returns (rgba_image, profile_state) with profile_state in
        "srgb" | "converted" | "unknown" | "missing"."""
        icc = img.info.get("icc_profile")
        if not icc:
            return img.convert("RGBA"), "missing"
        try:
            from PIL import ImageCms
            src_profile = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            desc = (ImageCms.getProfileDescription(src_profile) or "").strip()
            if desc and ("sRGB" in desc or "srgb" in desc.lower()):
                return img.convert("RGBA"), "srgb"
            try:
                dst_profile = ImageCms.ImageCmsProfile(io.BytesIO(_SRGB_ICC))
                converted = ImageCms.profileToProfile(
                    img, src_profile, dst_profile, outputMode="RGBA"
                )
                return converted, "converted"
            except Exception:
                print(f"{TAG} Failed ICC conversion during pixel import")
                return img.convert("RGBA"), "unknown"
        except Exception:
            # ICC bytes present but unparseable; treat as sRGB to keep
            # the import alive rather than failing the whole call.
            return img.convert("RGBA"), "unknown"

    def _raw_rgba_response(img, profile_state):
        try:
            raw = img.tobytes()
        except Exception:
            print(f"{TAG} Failed pixel import (tobytes)")
            return JSONResponse({"error": "encode failed"}, status_code=500)
        return Response(
            content=raw,
            media_type="application/octet-stream",
            headers={
                "X-Width": str(img.width),
                "X-Height": str(img.height),
                "X-Color-Profile": profile_state,
            },
        )

    class ImagePixelsRequest(BaseModel):
        source: str

    @app.post("/studio/image_pixels")
    def studio_image_pixels(req: ImagePixelsRequest):
        path = _resolve_diagnostic_source_path(req.source)
        if path is None:
            print(f"{TAG} Rejected untrusted pixel import source")
            return JSONResponse({"error": "source not accessible"}, status_code=400)
        try:
            img = Image.open(str(path))
            img.load()
        except Exception:
            print(f"{TAG} Failed pixel import (open)")
            return JSONResponse({"error": "open failed"}, status_code=500)

        img, profile_state = _pil_to_srgb_rgba(img)
        return _raw_rgba_response(img, profile_state)

    # POST /studio/import_pixels — same contract as /studio/image_pixels,
    # but for image files that exist only in the browser (Load Image
    # button, canvas drag-drop, data-URL results). The client uploads the
    # original encoded bytes; Pillow decodes + ICC-converts to sRGB and
    # returns raw RGBA, so the browser's image decode — which bakes the
    # display ICC into pixels on calibrated Firefox setups and dulls every
    # re-imported image — never touches them.
    #
    # Privacy: decoded in memory only; nothing is written or logged.

    class ImportPixelsRequest(BaseModel):
        image_b64: str = ""

    @app.post("/studio/import_pixels")
    def studio_import_pixels(req: ImportPixelsRequest):
        b64 = req.image_b64 or ""
        if b64.startswith("data:"):
            b64 = b64.partition(",")[2]
        try:
            raw_bytes = base64.b64decode(b64)
        except Exception:
            return JSONResponse({"error": "bad image data"}, status_code=400)
        if not raw_bytes or len(raw_bytes) > 128 * 1024 * 1024:
            return JSONResponse({"error": "bad image size"}, status_code=400)
        try:
            img = Image.open(io.BytesIO(raw_bytes))
            img.load()
        except Exception:
            # Includes PIL's decompression-bomb guard.
            return JSONResponse({"error": "decode failed"}, status_code=400)

        img, profile_state = _pil_to_srgb_rgba(img)
        return _raw_rgba_response(img, profile_state)

    # ------------------------------------------------------------------
    # Blueprint Bridge — discovery
    # ------------------------------------------------------------------

    # Resolve extension root (scripts/ may be one level down)
    _here = Path(__file__).parent
    _ext_root = _here if (_here / "frontend").is_dir() else _here.parent

    # Blueprints directory — Studio-bundled layout overrides for extensions
    _bp_dir = _ext_root / "blueprints"

    def _find_blueprint(script):
        """Find a Blueprint Bridge file for an extension script.

        Discovery order:
        1. Extension's own directory: <ext_root>/blueprint.json
        2. Studio's blueprints dir: <studio_root>/blueprints/*.json

        Returns parsed blueprint dict or None.
        """
        title_lower = ""
        try:
            title_lower = script.title().strip().lower()
        except Exception:
            return None

        # 1. Author-provided: next to the script's extension root
        script_path = Path(getattr(script, 'filename', ''))
        if script_path.exists():
            ext_dir = script_path.parent
            # Scripts can be in <ext>/scripts/ or <ext>/ directly
            if ext_dir.name == "scripts":
                ext_dir = ext_dir.parent
            bp_file = ext_dir / "blueprint.json"
            if bp_file.is_file():
                try:
                    with open(bp_file, "r", encoding="utf-8") as f:
                        bp = json.load(f)
                    if bp.get("match", "").strip().lower() == title_lower:
                        print(f"[Studio Bridge] Blueprint (author): {bp.get('title', '?')} for '{title_lower}'")
                        return bp
                except Exception as e:
                    print(f"[Studio Bridge] Failed reading blueprint {bp_file}: {e}")

        # 2. Studio-bundled
        if _bp_dir.is_dir():
            for bp_file in _bp_dir.glob("*.json"):
                try:
                    with open(bp_file, "r", encoding="utf-8") as f:
                        bp = json.load(f)
                    if bp.get("match", "").strip().lower() == title_lower:
                        print(f"[Studio Bridge] Blueprint (bundled): {bp.get('title', '?')} for '{title_lower}'")
                        return bp
                except Exception:
                    continue

        return None

    # Serve blueprint hooks JS files
    if _bp_dir.is_dir():
        app.mount(
            "/studio/blueprints",
            StaticFiles(directory=str(_bp_dir)),
            name="studio-blueprints",
        )

    # ------------------------------------------------------------------
    # Extension Bridge — manifest endpoint
    # ------------------------------------------------------------------

    @app.get("/studio/extensions")
    async def get_extensions():
        """Return JSON manifest of all auto-bridgeable extensions.

        Each entry includes the extension's title, arg index range, and
        a list of controls with their type, label, default value, and
        any type-specific attributes (min/max/step/choices).

        Controls are tagged with group IDs when they were created inside
        layout containers (Column, Group) with conditional visibility.
        The response includes `groups` for DOM structure and `dependencies`
        for all interactive behavior (visibility, value propagation, choices).

        Tier 1 native modules (ControlNet, ADetailer, Soft Inpainting)
        are excluded — Studio handles those directly.
        """
        import modules.scripts as mod_scripts
        _stub = _get_stub_module(); LayoutBlock = _stub.LayoutBlock

        runner = mod_scripts.scripts_img2img
        if not runner or not hasattr(runner, 'inputs') or not runner.inputs:
            return JSONResponse([])

        # Tier 1: Studio handles these natively — don't bridge them
        # Tier 1: Studio replaces these with its own native UI — never bridge them.
        # Everything else graduates to the toggleable extension bridge.
        NATIVE_TITLES = {
            "controlnet",               # Studio ControlNet panel
            "adetailer",                # Studio ADetailer panel
            "soft inpainting",          # Studio Soft Inpaint section
            "dynamic prompts",          # Wildcard resolution — must always run
            "sampler", "seed",          # Forge built-in scripts, not user extensions
            "moritz's ar selector",     # UX-018: Ported natively into Studio AR system
        }

        # Selectable scripts share the inputs array but aren't alwayson —
        # collect their arg ranges so we can exclude overlapping controls
        selectable_ranges = set()
        for script in runner.selectable_scripts:
            if hasattr(script, 'args_from') and script.args_from is not None:
                for i in range(script.args_from, script.args_to):
                    selectable_ranges.add(i)

        extensions = []
        for script in runner.alwayson_scripts:
            try:
                title = script.title().strip() if callable(getattr(script, 'title', None)) else ""
            except Exception:
                title = getattr(script, 'filename', 'unknown')

            if title.lower() in NATIVE_TITLES or any(title.lower().startswith(n) for n in NATIVE_TITLES):
                continue
            if not hasattr(script, 'args_from') or script.args_from is None:
                continue
            if script.args_from == script.args_to:
                continue

            controls = []
            for i in range(script.args_from, script.args_to):
                if i >= len(runner.inputs):
                    break
                if i in selectable_ranges:
                    continue
                comp = runner.inputs[i]
                if comp is None:
                    continue

                ctrl = {
                    "type": _resolve_component_type(comp),
                    "label": getattr(comp, 'label', '') or '',
                    "value": getattr(comp, 'value', None),
                    "index": i,
                    "visible": getattr(comp, 'visible', True),
                }

                # Type-specific attributes
                for attr in ('minimum', 'maximum', 'step', 'choices',
                             'lines', 'placeholder'):
                    v = getattr(comp, attr, None)
                    if v is not None:
                        ctrl[attr] = v

                controls.append(ctrl)

            if not controls:
                continue

            # --- Layout analysis & dependency probing ---
            groups, layout_id_map = _detect_layout_groups(controls, runner)
            layout = _build_layout_tree(controls, runner, layout_id_map)
            dependencies = _probe_dependencies(controls, runner, groups, layout_id_map)

            ext_entry = {
                "name": getattr(script, 'name', title.lower()),
                "title": title,
                "args_from": script.args_from,
                "args_to": script.args_to,
                "controls": controls,
            }
            if groups:
                ext_entry["groups"] = groups
            if layout:
                ext_entry["layout"] = layout
            if dependencies:
                ext_entry["dependencies"] = dependencies

            # --- Blueprint Bridge: check for explicit layout override ---
            bp = _find_blueprint(script)
            if bp:
                ext_entry["blueprint"] = bp
                # Resolve hooks URL if present
                if bp.get("hooks"):
                    ext_entry["blueprint"]["hooks_url"] = f"/studio/blueprints/{bp['hooks']}"

            extensions.append(ext_entry)

        return JSONResponse(extensions)

    # ------------------------------------------------------------------
    # Auto-update: GitHub API (no git required)
    # ------------------------------------------------------------------

    # Sync handler — _github_get blocks on urllib.request.urlopen. Declaring as
    # async would put that blocking I/O on the FastAPI event loop and stall the
    # whole server. FastAPI runs sync `def` handlers in a threadpool, which is
    # the correct place for blocking work.
    @app.get("/studio/api/check-update")
    def check_update():
        global _current_version
        _current_version = _read_version()

        # Get latest commit on the branch
        data = _github_get(f"/commits/{_GITHUB_BRANCH}")
        if data is None:
            return JSONResponse({"update_available": False, "offline": True,
                                 "error": "Cannot reach GitHub"})

        remote_sha = data.get("sha", "")
        if not remote_sha:
            return JSONResponse({"error": "Unexpected GitHub API response"})

        # No local version — stamp current remote as baseline (fresh install)
        if not _current_version:
            _write_version(remote_sha)
            _current_version = remote_sha
            return JSONResponse({"update_available": False, "current_commit": remote_sha[:8]})

        if _current_version == remote_sha:
            return JSONResponse({"update_available": False, "current_commit": _current_version[:8]})

        # Get comparison for changelog
        changelog = []
        commits_behind = 0
        compare = _github_get(f"/compare/{_current_version[:12]}...{_GITHUB_BRANCH}")
        if compare:
            commits_behind = compare.get("total_commits", 0)
            for c in compare.get("commits", [])[:20]:
                msg = c.get("commit", {}).get("message", "").split("\n")[0]
                sha = c.get("sha", "")[:8]
                changelog.append(f"{sha} {msg}")

        return JSONResponse({
            "update_available": True,
            "current_commit": _current_version[:8],
            "remote_commit": remote_sha[:8],
            "commits_behind": commits_behind or 1,
            "changelog": changelog,
        })

    # Phase progress state for the polling endpoint below. Single
    # global because only one update can be in flight at a time —
    # apply_update is gated by FastAPI's per-route concurrency in
    # practice (one user, one click), and a second call while busy
    # would just overwrite the dict.
    #
    # Phases / pct correspond to the update-dialog states the
    # frontend renders:
    #   idle / 0       — no update in flight
    #   checking / 5   — pre-flight (currently brief)
    #   downloading / 10 → 35
    #   extracting / 35 → 60
    #   copying / 60 → 85
    #   finishing / 85 → 95
    #   restart / 100  — done, restart required
    #   error / 0      — failed
    _update_progress = {"phase": "idle", "pct": 0, "message": ""}

    def _set_update_phase(phase: str, pct: int, message: str = ""):
        _update_progress["phase"] = phase
        _update_progress["pct"] = pct
        _update_progress["message"] = message

    @app.get("/studio/api/update-status")
    def update_status():
        # Snapshot copy — the dict is mutated from the threadpool
        # worker during apply_update.
        return JSONResponse(dict(_update_progress))

    # Sync handler — see check_update note. urllib.request.urlopen, zipfile
    # extraction, and shutil.copy2 all block. As `async def` they would freeze
    # the event loop for the full duration of the update (download + extract +
    # copy can take 30–120s), which on the user-facing side looks like the
    # "Updating..." toast hanging forever because no other request can be
    # processed in the meantime. Plain `def` runs in FastAPI's threadpool.
    @app.post("/studio/api/update")
    def apply_update():
        print(f"{TAG} Update requested")
        _set_update_phase("checking", 5, "Checking update")

        zip_url = f"https://github.com/{_GITHUB_OWNER}/{_GITHUB_REPO}/archive/refs/heads/{_GITHUB_BRANCH}.zip"

        try:
            # Download zip to temp file
            print(f"{TAG} Downloading {zip_url}")
            _set_update_phase("downloading", 10, "Downloading")
            req = urllib.request.Request(zip_url, headers={"User-Agent": "ForgeStudio-Updater"})
            with urllib.request.urlopen(req, timeout=120) as resp:
                zip_data = resp.read()
            print(f"{TAG} Downloaded {len(zip_data)} bytes")
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            _set_update_phase("error", 0, f"Download failed")
            return JSONResponse({"ok": False, "error": f"Download failed: {e}"})

        try:
            _set_update_phase("extracting", 35, "Extracting")
            with tempfile.TemporaryDirectory() as tmp:
                zip_path = Path(tmp) / "update.zip"
                zip_path.write_bytes(zip_data)

                with zipfile.ZipFile(zip_path) as zf:
                    zf.extractall(tmp)

                # GitHub zips have a top-level folder like Forge-Studio-main/
                extracted = [d for d in Path(tmp).iterdir() if d.is_dir() and d.name != "__MACOSX"]
                if len(extracted) != 1:
                    _set_update_phase("error", 0, "Unexpected zip structure")
                    return JSONResponse({"ok": False, "error": "Unexpected zip structure"})

                src = extracted[0]

                _set_update_phase("copying", 60, "Copying files")
                # Copy extracted files over the extension directory
                # Skip version.json from source (we write our own)
                for item in src.rglob("*"):
                    rel = item.relative_to(src)
                    dest = _studio_root / rel
                    if item.is_dir():
                        dest.mkdir(parents=True, exist_ok=True)
                    else:
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        # Overwrite existing files
                        shutil.copy2(str(item), str(dest))

        except (zipfile.BadZipFile, OSError) as e:
            _set_update_phase("error", 0, "Extract failed")
            return JSONResponse({"ok": False, "error": f"Extract failed: {e}"})

        _set_update_phase("finishing", 95, "Finishing")
        # Get the commit hash we just installed
        data = _github_get(f"/commits/{_GITHUB_BRANCH}")
        new_sha = data.get("sha", "") if data else ""
        if new_sha:
            _write_version(new_sha)
            global _current_version
            _current_version = new_sha

        _set_update_phase("restart", 100, "Restart required")
        print(f"{TAG} Updated to {new_sha[:8]}")
        return JSONResponse({
            "ok": True,
            "restart_required": True,
            "new_commit": new_sha[:8] or "latest",
            "message": "Updated successfully. Restart the server to apply backend changes. Refresh the browser for frontend changes.",
        })

    # ------------------------------------------------------------------
    # Frontend serving
    # ------------------------------------------------------------------

    frontend_dir = _ext_root / "frontend"

    # Serve ag-psd.js from extension's javascript/ dir (avoids duplicating into frontend/)
    _agpsd = _ext_root / "javascript" / "ag-psd.js"
    if not _agpsd.exists():
        _agpsd = _here / "javascript" / "ag-psd.js"  # scripts/javascript/ fallback
    if _agpsd.exists():
        @app.get("/studio/static/ag-psd.js")
        async def serve_agpsd():
            return FileResponse(_agpsd, media_type="application/javascript")

    if frontend_dir.is_dir():
        @app.get("/studio")
        @app.get("/studio/")
        async def studio_index():
            index = frontend_dir / "index.html"
            if index.exists():
                return FileResponse(index, headers={"Cache-Control": "no-cache"})
            return JSONResponse({"error": "Frontend not built yet"}, status_code=404)

        app.mount(
            "/studio/static",
            StaticFiles(directory=str(frontend_dir)),
            name="studio-frontend",
        )

        # Force revalidation on every static file request — browser
        # caches the file but must check ETag before using it. If the
        # file hasn't changed, server returns 304 (free). If it has,
        # browser gets the new version immediately. No stale files.
        # NOTE: add_middleware() fails in Gradio mode because the app
        # is already running. Non-critical — files just use default caching.
        try:
            from starlette.middleware.base import BaseHTTPMiddleware
            from starlette.requests import Request as StarletteRequest

            class StudioCacheControl(BaseHTTPMiddleware):
                async def dispatch(self, request: StarletteRequest, call_next):
                    response = await call_next(request)
                    path = request.url.path
                    if path.startswith("/studio/static"):
                        # Static files: cache with ETag revalidation
                        response.headers["Cache-Control"] = "no-cache"
                    elif path.startswith("/studio/") and not path.startswith("/studio/static"):
                        # API responses: never write to disk cache.
                        # Prevents Firefox/Chrome from accumulating hundreds
                        # of MB of cached base64 image JSON responses.
                        response.headers["Cache-Control"] = "no-store"
                    return response

            app.add_middleware(StudioCacheControl)
        except RuntimeError:
            pass  # app already started (Gradio mode) — skip, non-critical

        print(f"{TAG} Frontend: {frontend_dir}")
    else:
        @app.get("/studio")
        @app.get("/studio/")
        async def studio_placeholder():
            return JSONResponse({
                "status": "Studio API is running",
                "frontend": "Not installed — add files to frontend/ directory",
                "docs": "Visit /docs for full API documentation",
            })
        print(f"{TAG} No frontend dir found (checked {_here / 'frontend'} and {_here.parent / 'frontend'}) — API-only mode")

    # ------------------------------------------------------------------
    # Progress broadcast thread
    # ------------------------------------------------------------------

    Thread(target=_progress_polling_thread, daemon=True).start()

    # ------------------------------------------------------------------
    # Optional module loader — uses file path, not sys.path
    # Works regardless of how Forge is launched (--nowebui or regular)
    # ------------------------------------------------------------------

    def _load_optional_module(name, setup_func_name):
        """Load a sibling .py file by path and return its setup function, or None."""
        import importlib.util as ilu
        script_dir = os.path.dirname(os.path.abspath(__file__))
        path = os.path.join(script_dir, f"{name}.py")
        if not os.path.isfile(path):
            return None
        try:
            spec = ilu.spec_from_file_location(name, path)
            mod = ilu.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return getattr(mod, setup_func_name, None)
        except Exception as e:
            print(f"{TAG} Failed to load {name}: {e}")
            return None

    # ------------------------------------------------------------------
    # Workshop module routes
    # ------------------------------------------------------------------

    setup_workshop_routes = _load_optional_module("studio_workshop", "setup_workshop_routes")
    if setup_workshop_routes:
        setup_workshop_routes(app)
    else:
        print(f"{TAG} Workshop module not found — skipping")

    # ------------------------------------------------------------------
    # Sampler Lab module routes (Workshop sub-module)
    # ------------------------------------------------------------------

    setup_sampler_lab_routes = _load_optional_module("studio_sampler_lab", "setup_sampler_lab_routes")
    if setup_sampler_lab_routes:
        setup_sampler_lab_routes(app)
    else:
        print(f"{TAG} Sampler Lab module not found — skipping")

    # ------------------------------------------------------------------
    # Scheduler Lab module routes (Workshop sub-module, personal tool)
    # ------------------------------------------------------------------

    setup_scheduler_lab_routes = _load_optional_module("studio_scheduler_lab", "setup_scheduler_lab_routes")
    if setup_scheduler_lab_routes:
        setup_scheduler_lab_routes(app)
    else:
        print(f"{TAG} Scheduler Lab module not found — skipping")

    # ------------------------------------------------------------------
    # Lexicon module routes
    # ------------------------------------------------------------------

    setup_lexicon_routes = _load_optional_module("studio_lexicon", "setup_lexicon_routes")
    if setup_lexicon_routes:
        setup_lexicon_routes(app)
    else:
        print(f"{TAG} Lexicon module not found — skipping")

    # Token counter (standalone)
    setup_token_routes = _load_optional_module("studio_tokens", "setup_token_routes")
    if setup_token_routes:
        setup_token_routes(app)
    else:
        print(f"{TAG} Token counter module not found — skipping")

    # ------------------------------------------------------------------
    # Gallery module routes
    # ------------------------------------------------------------------

    setup_gallery_routes = _load_optional_module("studio_gallery", "setup_gallery_routes")
    if setup_gallery_routes:
        setup_gallery_routes(app)
    else:
        print(f"{TAG} Gallery module not found — skipping")

    # ------------------------------------------------------------------
    # Civitai metadata module (opt-in, hash-based; see studio_civitai.py)
    # ------------------------------------------------------------------

    setup_civitai_routes = _load_optional_module("studio_civitai", "setup_civitai_routes")
    if setup_civitai_routes:
        try:
            setup_civitai_routes(app, _resolve_lora_dirs)
            # Pull the enrich helper into the get_loras closure so it can
            # decorate the response with cached metadata.
            _enrich = _load_optional_module("studio_civitai", "enrich_lora_entries")
            if _enrich:
                _civitai_enrich = _enrich
            _read_ch = _load_optional_module("studio_civitai", "read_ch_info")
            if _read_ch:
                _civitai_read_ch = _read_ch
        except Exception:
            print(f"{TAG} Civitai module setup failed")
    else:
        print(f"{TAG} Civitai module not found — skipping")

    print(f"{TAG} All routes registered — standalone UI at /studio")


# =========================================================================
# HOOK — called by on_app_started via studio.py
# =========================================================================

def add_studio_api(demo, app):
    """
    Drop-in replacement for the old add_studio_api() in studio_generation.py.

    To integrate, change studio_generation.py bottom section from:

        def add_studio_api(demo, app):
            from starlette.responses import JSONResponse
            @app.get("/studio/task_id")
            async def studio_task_id():
                return JSONResponse({"task_id": get_studio_task_id()})

    To:

        from studio_api import add_studio_api

    The on_app_started registration in studio.py stays exactly the same:
        scripts.script_callbacks.on_app_started(add_studio_api)
    """
    setup_studio_routes(app)

    # Suppress Uvicorn access log noise for /studio routes.
    # Studio prints its own tagged log lines ([Studio API], [Gallery], etc.)
    # which are more informative. The raw HTTP request/response lines
    # alarm users who don't know what 200/304 status codes mean.
    import logging

    class _SuppressStudioAccess(logging.Filter):
        def filter(self, record):
            msg = record.getMessage() if hasattr(record, 'getMessage') else str(record.msg)
            return '/studio' not in msg

    _uvicorn_access = logging.getLogger("uvicorn.access")
    _uvicorn_access.addFilter(_SuppressStudioAccess())

    # Auto-launch browser in --nowebui mode (replaces VBScript delay hack in bat file)
    if getattr(shared.cmd_opts, 'nowebui', False):
        def _wait_and_open():
            import webbrowser, urllib.request
            port = getattr(shared.cmd_opts, 'port', 7860) or 7860
            url = f"http://127.0.0.1:{port}/studio"
            for _ in range(60):  # poll for up to 30 seconds
                try:
                    urllib.request.urlopen(url, timeout=0.5)
                    webbrowser.open(url)
                    print(f"{TAG} Browser opened: {url}")
                    return
                except Exception:
                    time.sleep(0.5)
            print(f"{TAG} Auto-launch timed out — open {url} manually")
        Thread(target=_wait_and_open, daemon=True).start()
