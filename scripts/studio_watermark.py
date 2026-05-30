"""
Forge Studio — Auto Watermark

Lets the user drop watermark images into a dedicated folder and have one
automatically composited onto generated images as the last pixel-level
post-process step. Selection happens in the Settings tab; placement
(position / opacity / scale / margin / rotation) travels with each
generation request.

Design rules:
  - Watermark files live in <ext_root>/watermarks/ (self-contained, like
    studio_dynamic_prompts.json), created on first access.
  - The frontend only ever sends a bare filename; the backend resolves it
    under the fixed folder with a traversal guard (never trust a client path).
  - Privacy: no absolute paths returned to the frontend.
"""

import os
from pathlib import Path
from typing import List, Optional

TAG = "[Studio Watermark]"

# Image extensions that carry an alpha channel well. JPEG is intentionally
# excluded from the picker — an opaque rectangle is rarely a wanted watermark.
_ALLOWED_EXTS = (".png", ".webp")


def _watermarks_dir() -> Path:
    """Return <ext_root>/watermarks/, creating it on demand.

    Resolved the same way studio_dynamic_prompts._config_path locates the
    extension root so the folder sits next to the extension's other state.
    """
    here = Path(__file__).parent
    ext_root = here if (here / "frontend").is_dir() else here.parent
    d = ext_root / "watermarks"
    try:
        d.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    return d


def watermarks_dir_display() -> str:
    """User-facing path to the watermarks folder (for an 'open folder' hint)."""
    return str(_watermarks_dir())


def list_watermarks() -> List[dict]:
    """List selectable watermark files as ``[{"name": "<file.png>"}]``.

    Names are bare filenames (the dropdown value + backend lookup key).
    """
    root = _watermarks_dir()
    out = []
    try:
        for p in sorted(root.iterdir(), key=lambda x: x.name.lower()):
            if p.is_file() and p.suffix.lower() in _ALLOWED_EXTS:
                out.append({"name": p.name})
    except Exception:
        pass
    return out


def resolve_watermark_path(name: str) -> Optional[Path]:
    """Resolve a bare filename to a path under the watermarks folder.

    Returns None if the name is empty, traverses outside the folder, has a
    disallowed extension, or doesn't exist. Mirrors the traversal guard in
    studio_dynamic_prompts._safe_wildcard_target.
    """
    if not name or not str(name).strip():
        return None
    # Reject anything with path components — selection is a flat filename.
    raw = str(name).replace("\\", "/")
    if "/" in raw or raw in ("", ".", ".."):
        return None
    root = _watermarks_dir()
    target = (root / raw).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError:
        return None
    if target.suffix.lower() not in _ALLOWED_EXTS:
        return None
    if not target.is_file():
        return None
    return target
