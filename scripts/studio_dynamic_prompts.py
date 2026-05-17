"""
Forge Studio — Native Dynamic Prompt Expansion
by ToxicHost & Moritz

Studio-native expansion of dynamic prompt syntax so Studio works without
relying on the external `sd-dynamic-prompts` extension. When Forge Neo
breaks the Dynamic Prompts imports, Studio's wildcards keep working.

Supported V1 syntax:
  __foo__               wildcard file lookup (foo.txt)
  __sub/folder/foo__    nested wildcard file lookup
  {a|b|c}               inline random choice
  {2$$a|b|c}            basic multi-select (count unique options)

Anything else (full Jinja, combinatorial, magic prompt) is intentionally
out of scope for V1 and is left unchanged in the prompt text.

Design rules:
  - Deterministic for a given (prompt, seed, wildcards) input.
  - No imports from sd-dynamic-prompts.
  - Privacy: no absolute paths, no prompt text in returned warnings.
"""

import json
import os
import random
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

TAG = "[Studio DynPrompts]"

# Valid wildcard token characters: alphanumerics, underscore, dot, dash,
# forward slash, and space (Studio's wildcard browser already permits
# filenames with spaces, so we honour that here).
_WILDCARD_RE = re.compile(r"__([A-Za-z0-9_./ \-]+?)__")

# Inline brace group — non-greedy, no nested braces (we strip outer
# braces, then handle nesting via the depth loop in expand_prompt).
_BRACE_RE = re.compile(r"\{([^{}]*)\}")

# Recognised count prefix for `{N$$a|b|c}` syntax.
_MULTI_PREFIX_RE = re.compile(r"^\s*(\d+)\s*\$\$(.*)$", re.DOTALL)


# =========================================================================
# Config storage
# =========================================================================

DEFAULT_CONFIG = {
    "studio_dynamic_prompts_enabled": True,
    "wildcard_folder_mode": "default",  # "default" | "custom"
    "wildcard_folder": None,
}

_config_lock = threading.Lock()


def _config_path() -> Path:
    """Return the path to studio_dynamic_prompts.json next to user_defaults."""
    here = Path(__file__).parent
    ext_root = here if (here / "frontend").is_dir() else here.parent
    return ext_root / "studio_dynamic_prompts.json"


def load_config() -> dict:
    """Load the persisted dynamic prompts config (or defaults)."""
    path = _config_path()
    if not path.exists():
        return dict(DEFAULT_CONFIG)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        merged = dict(DEFAULT_CONFIG)
        if isinstance(data, dict):
            for k in DEFAULT_CONFIG:
                if k in data:
                    merged[k] = data[k]
        return merged
    except Exception:
        return dict(DEFAULT_CONFIG)


def save_config(cfg: dict) -> dict:
    """Validate and persist a partial dynamic prompts config update.

    Only keys present in `cfg` overwrite the existing on-disk state, so
    the frontend can update just the enabled toggle without clobbering
    the custom wildcard folder (and vice versa). Bad/extra fields are
    dropped silently. Folder paths are normalised but not validated for
    existence here — callers can call `validate_folder` separately.
    """
    sanitized = load_config()
    if isinstance(cfg, dict):
        if "studio_dynamic_prompts_enabled" in cfg:
            sanitized["studio_dynamic_prompts_enabled"] = bool(
                cfg.get("studio_dynamic_prompts_enabled")
            )
        if "wildcard_folder_mode" in cfg:
            mode = cfg.get("wildcard_folder_mode")
            if mode in ("default", "custom"):
                sanitized["wildcard_folder_mode"] = mode
        if "wildcard_folder" in cfg:
            folder = cfg.get("wildcard_folder")
            if isinstance(folder, str) and folder.strip():
                sanitized["wildcard_folder"] = folder.strip()
            else:
                sanitized["wildcard_folder"] = None
    if sanitized["wildcard_folder_mode"] == "custom" and not sanitized["wildcard_folder"]:
        # No path → fall back to default mode rather than silent custom-with-none
        sanitized["wildcard_folder_mode"] = "default"

    path = _config_path()
    with _config_lock:
        tmp = path.with_name(path.name + ".tmp")
        try:
            tmp.write_text(json.dumps(sanitized, indent=2), encoding="utf-8")
            tmp.replace(path)
        except Exception as e:
            # Privacy: don't print the path; user can find it themselves
            print(f"{TAG} Failed to write config: {e}")
    return sanitized


def validate_folder(folder: str) -> dict:
    """Inspect a candidate custom wildcard folder.

    Returns {"exists": bool, "has_txt": bool}. Does not raise — invalid
    paths just produce {"exists": False, "has_txt": False}.
    """
    out = {"exists": False, "has_txt": False}
    if not folder or not isinstance(folder, str):
        return out
    try:
        p = Path(folder).expanduser()
        if not p.is_dir():
            return out
        out["exists"] = True
        for _ in p.rglob("*.txt"):
            out["has_txt"] = True
            break
    except Exception:
        pass
    return out


# =========================================================================
# Wildcard directory discovery
# =========================================================================

def _default_wildcard_dirs() -> List[Path]:
    """Return the deterministic search order Studio uses when the user
    hasn't picked a custom folder. Existing dirs are kept; missing ones
    are dropped.
    """
    dirs: List[Path] = []

    # 1. Studio's lexicon root (single source of truth used by the
    #    wildcard browser/editor). Lazy import so the helper module
    #    works in isolation if lexicon ever goes away.
    try:
        from scripts.studio_lexicon import get_wildcards_root  # type: ignore
        root = Path(get_wildcards_root())
        if root.is_dir():
            dirs.append(root)
    except Exception:
        try:
            from studio_lexicon import get_wildcards_root  # type: ignore
            root = Path(get_wildcards_root())
            if root.is_dir():
                dirs.append(root)
        except Exception:
            pass

    # 2. Forge Neo conventional locations
    try:
        from modules.paths import script_path  # type: ignore
        webui_root = Path(script_path)
        for c in (
            webui_root / "wildcards",
            webui_root / "extensions" / "sd-dynamic-prompts" / "wildcards",
            webui_root / "extensions-builtin" / "sd-dynamic-prompts" / "wildcards",
            webui_root / "extensions" / "sd-dynamic-prompts-fork" / "wildcards",
            webui_root / "outputs" / "wildcards",
        ):
            if c.is_dir() and c not in dirs:
                dirs.append(c)
    except Exception:
        pass

    return dirs


def resolve_wildcard_dirs(cfg: Optional[dict] = None) -> List[Path]:
    """Resolve the active wildcard directories for the current config.

    Custom mode returns just the custom folder (if it exists); default
    mode returns Studio's standard search order.
    """
    if cfg is None:
        cfg = load_config()
    mode = cfg.get("wildcard_folder_mode", "default")
    custom = cfg.get("wildcard_folder")
    if mode == "custom" and custom:
        try:
            p = Path(custom).expanduser()
            if p.is_dir():
                return [p]
        except Exception:
            pass
        # Custom mode but folder missing — return empty so expansion
        # warns rather than silently falling back to default folders.
        return []
    return _default_wildcard_dirs()


# =========================================================================
# Expansion
# =========================================================================

@dataclass
class DynamicPromptExpansionResult:
    original: str
    expanded: str
    used: List[dict] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


def _read_wildcard_lines(wildcard: str, wildcard_dirs: List[Path]) -> Optional[List[str]]:
    """Resolve `__foo__` or `__sub/foo__` to a list of non-comment lines.

    Returns None if no matching file exists, [] if the file exists but
    is empty/all-comment. The caller decides whether either case is a
    warning.
    """
    if not wildcard:
        return None
    # Normalise separators and reject path-traversal attempts. We don't
    # want a wildcard token to escape the configured wildcards root.
    parts = [p for p in wildcard.replace("\\", "/").split("/") if p]
    if not parts or any(p in ("", "..", ".") for p in parts):
        return None
    rel = os.path.join(*parts) + ".txt"

    for base in wildcard_dirs:
        try:
            candidate = (base / rel).resolve()
            base_resolved = base.resolve()
            # Reject paths that resolve outside the base via symlinks
            # or component tricks.
            try:
                candidate.relative_to(base_resolved)
            except ValueError:
                continue
            if not candidate.is_file():
                continue
            text = candidate.read_text(encoding="utf-8", errors="replace")
            lines = []
            for raw in text.splitlines():
                s = raw.strip()
                if not s or s.startswith("#"):
                    continue
                lines.append(s)
            return lines
        except Exception:
            continue
    return None


def _expand_wildcards_once(
    text: str,
    rng: random.Random,
    wildcard_dirs: List[Path],
    used: List[dict],
    warnings: List[str],
    missing: set,
) -> str:
    """One pass of wildcard expansion. `missing` is populated with names
    that couldn't be resolved so the next pass doesn't re-try them.
    """
    def _sub(match: re.Match) -> str:
        name = match.group(1).strip()
        token = match.group(0)
        if not name or name in missing:
            return token
        lines = _read_wildcard_lines(name, wildcard_dirs)
        if lines is None:
            missing.add(name)
            warnings.append(f"Missing wildcard: {name}")
            return token
        if not lines:
            missing.add(name)
            warnings.append(f"Empty wildcard: {name}")
            return token
        idx = rng.randrange(len(lines))
        used.append({
            "kind": "wildcard",
            "token": token,
            "wildcard": name,
            "choice_index": idx,
        })
        return lines[idx]

    return _WILDCARD_RE.sub(_sub, text)


def _expand_braces_once(
    text: str,
    rng: random.Random,
    used: List[dict],
    warnings: List[str],
) -> str:
    """One pass of `{a|b|c}` / `{N$$a|b|c}` expansion (innermost first).

    Returns the text with one level of brace groups replaced. Multiple
    passes are needed for nested braces; expand_prompt loops over this.
    """
    def _sub(match: re.Match) -> str:
        inner = match.group(1)
        token = match.group(0)
        m = _MULTI_PREFIX_RE.match(inner)
        if m:
            try:
                count = int(m.group(1))
            except Exception:
                warnings.append("Invalid multi-select count")
                return token
            body = m.group(2)
            if "$$" in body:
                # V1 doesn't support custom separators / ranges like
                # `{2$$ and $$a|b|c}` — leave them unchanged so we don't
                # mangle prompts that use full Dynamic Prompts syntax.
                return token
            options = [o.strip() for o in body.split("|")]
            options = [o for o in options if o]
            if not options:
                warnings.append("Empty multi-select")
                return token
            if count <= 0:
                warnings.append("Invalid multi-select count")
                return token
            pick_count = min(count, len(options))
            indices = list(range(len(options)))
            rng.shuffle(indices)
            chosen_idx = sorted(indices[:pick_count])
            chosen = [options[i] for i in chosen_idx]
            used.append({
                "kind": "multi_choice",
                "token": token,
                "choice_indices": chosen_idx,
            })
            return ", ".join(chosen)

        # Plain `{a|b|c}` — must contain at least one `|` to be a valid
        # choice; otherwise it might be Jinja or A1111 attention syntax,
        # leave it alone.
        if "|" not in inner:
            return token
        options = [o.strip() for o in inner.split("|")]
        options = [o for o in options if o]
        if not options:
            warnings.append("Empty inline choice")
            return token
        idx = rng.randrange(len(options))
        used.append({
            "kind": "choice",
            "token": token,
            "choice_index": idx,
        })
        return options[idx]

    return _BRACE_RE.sub(_sub, text)


def expand_prompt(
    prompt: str,
    *,
    seed: int,
    wildcard_dirs: Optional[List[Path]] = None,
    max_depth: int = 10,
) -> DynamicPromptExpansionResult:
    """Expand wildcards and inline choices in `prompt`.

    The expansion is deterministic for a given (prompt, seed, wildcard
    files) triple — same inputs always produce the same output.
    Unrecognised advanced syntax is left as-is rather than failing.

    `wildcard_dirs` defaults to Studio's auto-discovered folder list
    when not provided.
    """
    if prompt is None:
        prompt = ""
    if wildcard_dirs is None:
        wildcard_dirs = _default_wildcard_dirs()

    used: List[dict] = []
    warnings: List[str] = []

    # Empty / non-templated input — fast path
    if not prompt or ("__" not in prompt and "{" not in prompt):
        return DynamicPromptExpansionResult(original=prompt, expanded=prompt,
                                            used=used, warnings=warnings)

    rng = random.Random(int(seed) & 0xFFFFFFFF)
    text = prompt
    missing: set = set()

    for depth in range(max_depth):
        prev = text
        # Inner braces first (they may live inside wildcard contents
        # too, so we run braces after wildcards on the same pass).
        text = _expand_wildcards_once(text, rng, wildcard_dirs, used, warnings, missing)
        text = _expand_braces_once(text, rng, used, warnings)
        if text == prev:
            break
    else:
        # Loop completed all iterations without converging — likely a
        # recursive wildcard. Leave whatever remains as literal text.
        if _WILDCARD_RE.search(text) or _BRACE_RE.search(text):
            warnings.append("Dynamic prompt expansion reached max depth")

    return DynamicPromptExpansionResult(
        original=prompt, expanded=text, used=used, warnings=warnings,
    )


# =========================================================================
# Convenience for callers
# =========================================================================

def is_enabled(cfg: Optional[dict] = None) -> bool:
    if cfg is None:
        cfg = load_config()
    return bool(cfg.get("studio_dynamic_prompts_enabled", True))


def source_label(cfg: Optional[dict] = None) -> str:
    """Return "custom" or "default" for metadata tagging."""
    if cfg is None:
        cfg = load_config()
    return "custom" if cfg.get("wildcard_folder_mode") == "custom" else "default"


# =========================================================================
# Public wildcard listing — shared by autocomplete + browser
# =========================================================================

def list_wildcards(cfg: Optional[dict] = None) -> List[dict]:
    """Return wildcard names visible to Studio native dynamic prompts.

    Walks every directory returned by `resolve_wildcard_dirs(cfg)` and
    collects nested `.txt` files. The first directory in resolver order
    wins for any given name — matches generation-time lookup behaviour.

    Privacy: returns names only (forward-slash-joined, no `.txt`), never
    absolute paths.
    """
    dirs = resolve_wildcard_dirs(cfg)
    seen: set = set()
    out: List[dict] = []
    for base in dirs:
        try:
            base_resolved = base.resolve()
        except Exception:
            continue
        try:
            files = list(base.rglob("*.txt"))
        except Exception:
            continue
        files.sort(key=lambda p: str(p).lower())
        for f in files:
            try:
                # Reject anything that escapes the base (e.g. via symlinks).
                f_resolved = f.resolve()
                try:
                    rel = f_resolved.relative_to(base_resolved)
                except ValueError:
                    continue
                if not f.is_file():
                    continue
                name = str(rel).replace("\\", "/")
                if name.lower().endswith(".txt"):
                    name = name[:-4]
                if not name or name in seen:
                    continue
                seen.add(name)
                out.append({"name": name})
            except Exception:
                continue
    return out


def get_wildcard_lines(
    name: str,
    cfg: Optional[dict] = None,
    limit: int = 50,
) -> dict:
    """Return preview lines for a wildcard using the same resolver as
    generation. Mirrors `_read_wildcard_lines` so autocomplete previews
    show exactly what generation will pick from.

    Returns ``{"lines": [...], "count": int, "truncated": bool}``. No
    absolute paths are included.
    """
    if not name:
        return {"lines": [], "count": 0, "truncated": False}
    dirs = resolve_wildcard_dirs(cfg)
    lines = _read_wildcard_lines(name, dirs)
    if not lines:
        return {"lines": [], "count": 0, "truncated": False}
    if limit is None or limit < 0:
        return {"lines": list(lines), "count": len(lines), "truncated": False}
    return {
        "lines": lines[:limit],
        "count": len(lines),
        "truncated": len(lines) > limit,
    }


def _default_write_root() -> Optional[Path]:
    """Return Studio's auto-detected writable wildcard root, used when
    no custom folder is configured. Defers to `studio_lexicon` so the
    detection lives in one place; falls back to the first resolver dir
    if that import fails.
    """
    try:
        from scripts.studio_lexicon import get_wildcards_root  # type: ignore
        p = Path(get_wildcards_root())
        if p.is_dir():
            return p
    except Exception:
        try:
            from studio_lexicon import get_wildcards_root  # type: ignore
            p = Path(get_wildcards_root())
            if p.is_dir():
                return p
        except Exception:
            pass
    # Last resort: first existing default resolver dir
    for d in _default_wildcard_dirs():
        return d
    return None


def get_wildcard_write_root(cfg: Optional[dict] = None) -> Optional[Path]:
    """Return the folder where the Wildcards editor should create,
    rename and delete files.

    - custom mode: the user's custom folder (created on demand if its
      parent exists, so the editor can populate an empty target).
    - default mode: Studio's own writable lexicon root.

    Returns None only when no usable folder exists at all (e.g. custom
    mode with an unreachable parent and no fallback).
    """
    if cfg is None:
        cfg = load_config()
    if cfg.get("wildcard_folder_mode") == "custom" and cfg.get("wildcard_folder"):
        try:
            p = Path(str(cfg["wildcard_folder"])).expanduser()
            if p.is_dir():
                return p
            # Try to create the directory if its parent exists — lets
            # the user pick an empty target folder and start editing.
            if p.parent.is_dir():
                try:
                    p.mkdir(parents=True, exist_ok=True)
                    return p
                except Exception:
                    pass
        except Exception:
            pass
        # Custom mode but folder unreachable — no fallback, mirrors the
        # read-side behaviour of returning [] from resolve_wildcard_dirs.
        return None
    return _default_write_root()


def _safe_wildcard_target(name: str, root: Path) -> Path:
    """Resolve `name` to `<root>/<name>.txt`, rejecting traversal."""
    parts = [p for p in str(name).replace("\\", "/").split("/") if p]
    if not parts or any(p in ("", "..", ".") for p in parts):
        raise ValueError("Invalid wildcard name")
    target = (root / (os.path.join(*parts) + ".txt")).resolve()
    root_resolved = root.resolve()
    try:
        target.relative_to(root_resolved)
    except ValueError as e:
        raise ValueError("Path outside wildcard root") from e
    return target


def write_wildcard(
    name: str,
    lines,
    cfg: Optional[dict] = None,
) -> dict:
    """Write a wildcard file under the active write root.

    `lines` may be a list of strings or a single string with embedded
    newlines. Parent folders are created on demand. Returns
    ``{"ok": True, "name": ..., "lines": N}`` on success or
    ``{"ok": False, "error": ...}`` on failure (no absolute paths).
    """
    root = get_wildcard_write_root(cfg)
    if root is None:
        return {"ok": False, "error": "no_write_root"}
    try:
        target = _safe_wildcard_target(name, root)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    if isinstance(lines, str):
        body = lines
    else:
        body = "\n".join(str(x).rstrip() for x in (lines or []))
    if body and not body.endswith("\n"):
        body += "\n"
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body, encoding="utf-8")
    except Exception as e:
        return {"ok": False, "error": f"write_failed: {e.__class__.__name__}"}
    return {"ok": True, "name": str(name), "lines": body.count("\n")}


def delete_wildcard(name: str, cfg: Optional[dict] = None) -> dict:
    """Delete a wildcard file under the active write root. Returns
    ``{"ok": True, "deleted": bool}``; never raises for normal misses.
    """
    root = get_wildcard_write_root(cfg)
    if root is None:
        return {"ok": False, "error": "no_write_root"}
    try:
        target = _safe_wildcard_target(name, root)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    if not target.is_file():
        return {"ok": True, "deleted": False}
    try:
        target.unlink()
    except Exception as e:
        return {"ok": False, "error": f"delete_failed: {e.__class__.__name__}"}
    return {"ok": True, "deleted": True}


__all__ = [
    "DynamicPromptExpansionResult",
    "DEFAULT_CONFIG",
    "load_config",
    "save_config",
    "validate_folder",
    "resolve_wildcard_dirs",
    "expand_prompt",
    "is_enabled",
    "source_label",
    "list_wildcards",
    "get_wildcard_lines",
    "get_wildcard_write_root",
    "write_wildcard",
    "delete_wildcard",
]
