"""
Forge Studio — writable data locations

Single source of truth for WHERE Studio keeps mutable user state (defaults,
presets, gallery index, dynamic-prompts config).

By default that is the extension folder, exactly as before. Setting the
``STUDIO_DATA_DIR`` environment variable relocates all of it to one directory
instead. That matters when the extension folder is not writable or is replaced
wholesale on update — a container image, a read-only mount, or the common
"delete the folder and drop in the new release" upgrade, all of which otherwise
destroy user settings.

Deliberately stdlib-only and free of Forge/Studio imports so every module —
including ``studio_dynamic_prompts``, which is written to work in isolation —
can import it without creating a cycle.
"""

import os
import shutil
from pathlib import Path

TAG = "[Studio Paths]"

_ENV_VAR = "STUDIO_DATA_DIR"
_logged = False


def extension_root() -> Path:
    """The Forge-Studio extension folder (where this file's package lives)."""
    here = Path(__file__).resolve().parent
    return here if (here / "frontend").is_dir() else here.parent


def data_dir() -> Path:
    """Root for Studio's mutable state.

    ``STUDIO_DATA_DIR`` when set (created if needed), else the extension root —
    which preserves today's behavior exactly for every existing install.
    Falls back to the extension root if the configured dir can't be created,
    so a bad value degrades instead of breaking startup.
    """
    global _logged
    raw = (os.environ.get(_ENV_VAR) or "").strip()
    if not raw:
        return extension_root()
    try:
        p = Path(raw).expanduser()
        p.mkdir(parents=True, exist_ok=True)
        if not _logged:
            _logged = True
            print(f"{TAG} Using {_ENV_VAR}={p}")
        return p
    except Exception as e:
        if not _logged:
            _logged = True
            print(f"{TAG} {_ENV_VAR}={raw!r} unusable ({e}) — falling back to the extension folder")
        return extension_root()


def data_path(*parts) -> Path:
    """A path inside the data dir, migrating any legacy copy on first use.

    When STUDIO_DATA_DIR is set and the target doesn't exist yet but the old
    in-extension copy does, the old one is moved across. That way enabling the
    variable (or a first container start bind-mounting an existing install)
    keeps the user's settings instead of silently starting empty.
    Best-effort: a failed migration leaves the original untouched.
    """
    root = data_dir()
    target = root.joinpath(*parts)
    try:
        ext = extension_root()
        if root != ext:
            legacy = ext.joinpath(*parts)
            if legacy.exists() and not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(legacy), str(target))
                print(f"{TAG} Migrated {'/'.join(str(p) for p in parts)} -> {target}")
    except Exception as e:
        print(f"{TAG} Migration skipped for {'/'.join(str(p) for p in parts)}: {e}")
    return target
