"""
Forge Studio — ADetailer Model Listing
Minimal shim for Studio's model dropdown population.

ADetailer processing is handled by the native ADetailer extension (Studio fork).
Studio injects its UI params into native AD's script_args slots via
_build_native_ad_dicts() in studio_generation.py.
"""

import os
from modules import shared

# ---------------------------------------------------------------------------
# Forge Neo compatibility shim — cmd_opts.disable_safe_unpickle
# ---------------------------------------------------------------------------
# ADetailer's helper.disable_safe_unpickle() runs, at YOLO model-load time:
#     patch.object(cmd_opts, "disable_safe_unpickle", True)
# Forge Neo dropped that legacy A1111 command-line option, so cmd_opts has no
# such attribute and unittest.mock.patch.object (no create=True) raises
# AttributeError — which crashes AD's postprocess_image in Neo's native Gradio
# frontend (Forge swallows it as "*** Error running postprocess_image" and the
# face is left untouched). Studio's own AD path calls ultralytics_predict
# directly and bypasses this helper, which is why AD works in Studio but not in
# Neo's frontend. Upstream Bing-su/adetailer has the identical line (issue #843),
# so this affects stock ADetailer too.
#
# We make the attribute exist so patch.object can set/restore it. Actual
# unpickle behavior on Forge Neo is governed by TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD
# (also set by AD's helper), so a default of False is inert.
try:
    try:
        from modules.shared import cmd_opts as _cmd_opts
    except Exception:
        from modules.shared_cmd_options import cmd_opts as _cmd_opts
    if not hasattr(_cmd_opts, "disable_safe_unpickle"):
        _cmd_opts.disable_safe_unpickle = False
        print("[Studio AD] Added cmd_opts.disable_safe_unpickle shim (Forge Neo compat)")
except Exception as _e:
    print(f"[Studio AD] disable_safe_unpickle shim skipped: {_e}")

_ad_model_mapping = None


def _models_root():
    """Forge's models root, resolved the SAME way ADetailer resolves it.

    The extension uses ``modules.paths.models_path``; Studio previously used
    ``getattr(shared, "models_path", "models")``, which silently degrades to the
    RELATIVE string "models" on builds where ``shared`` doesn't re-export it.
    A relative path resolves against the process CWD, so the scan directory
    didn't exist and was skipped — and current ADetailer-Neo's get_models
    returns an EMPTY dict (no unconditional entries) rather than raising, which
    is why the extension reported "11 Models" while Studio's dropdown was empty
    with no error logged.

    Order: modules.paths.models_path -> shared.models_path -> absolute "models".
    """
    try:
        from modules.paths import models_path as _mp
        if _mp:
            return str(_mp)
    except Exception:
        pass
    _mp = getattr(shared, "models_path", None)
    if _mp:
        return str(_mp)
    return os.path.abspath("models")


def _ad_model_dirs():
    """Every directory ADetailer itself scans for detection models.

    Mirrors the extension's own discovery so Studio's dropdown lists exactly
    what ADetailer lists (it logs "num models: N" at startup):

        <models_path>/adetailer  +  shared.opts.ad_extra_models_dir

    ``ad_extra_models_dir`` is the extension's setting for models kept outside
    the default folder; it is a "|"-separated list of paths (same format in the
    old fork and current ADetailer-Neo). Without this Studio only saw the
    default folder, so users who store their models elsewhere got an empty
    model dropdown and could never enable a slot.

    Only the default dir is created; extra dirs are used as-is if they exist.
    Non-throwing — always returns at least the default dir.
    """
    dirs = []
    default_dir = os.path.join(_models_root(), "adetailer")
    try:
        os.makedirs(default_dir, exist_ok=True)
    except Exception:
        pass
    dirs.append(default_dir)

    try:
        extra = shared.opts.data.get("ad_extra_models_dir", "") or ""
    except Exception:
        extra = ""
    for raw in str(extra).split("|"):
        d = raw.strip()
        if not d:
            continue
        try:
            if os.path.isdir(d) and d not in dirs:
                dirs.append(d)
        except Exception:
            continue
    return dirs


def _ad_mapping_from_extension():
    """The model mapping ADetailer's own script already built at import time.

    Both forks compute a module-level ``model_mapping`` in their main script and
    log it at startup ("N Models"). Reading that is immune to any difference in
    how we resolve directories, so it is the reliable fallback when our own scan
    comes up empty. The script module name differs per fork
    (``!adetailer`` old, ``adetailer`` new), so scan sys.modules rather than
    guessing. Non-throwing; returns {} when unavailable.
    """
    try:
        import sys
        for name, mod in list(sys.modules.items()):
            if mod is None:
                continue
            base = name.rsplit(".", 1)[-1]
            if base not in ("!adetailer", "adetailer"):
                continue
            mapping = getattr(mod, "model_mapping", None)
            if isinstance(mapping, dict) and mapping:
                return dict(mapping)
    except Exception:
        pass
    return {}


def get_ad_model_mapping(force: bool = False):
    global _ad_model_mapping
    # Only a NON-EMPTY result is cached. An empty mapping means the scan found
    # nothing (wrong dir, extension not loaded yet, models added later) — caching
    # that pinned the dropdown empty for the whole session, so even after fixing
    # the cause the user had to fully restart Forge to see models.
    if _ad_model_mapping and not force:
        return _ad_model_mapping
    try:
        try:
            from adetailer.common import get_models as ad_get_models
        except ImportError:
            # Current ADetailer-Neo renamed its package adetailer -> lib_adetailer
            # AND moved get_models to lib_adetailer/detection/common.py. Import it
            # from the package root, which re-exports it (see its __init__.py) —
            # lib_adetailer.common does not exist.
            from lib_adetailer import get_models as ad_get_models
        dirs = _ad_model_dirs()
        # Honor the extension's own --ad-no-huggingface opt-out so Studio
        # doesn't pull models the user deliberately disabled.
        try:
            from modules.shared import cmd_opts as _co
            no_hf = getattr(_co, "ad_no_huggingface", False)
        except Exception:
            no_hf = False
        try:
            _ad_model_mapping = ad_get_models(*dirs, huggingface=not no_hf)
        except TypeError:
            # Older/newer signature without the huggingface kwarg.
            _ad_model_mapping = ad_get_models(*dirs)
        # A zero result is NOT an error on current ADetailer-Neo (its get_models
        # returns only files it actually finds), so name the scanned dirs —
        # otherwise "empty dropdown" is indistinguishable from "scanned the
        # wrong folder", which is exactly how this bug hid.
        if not _ad_model_mapping:
            # Last resort: reuse the mapping the extension's own script already
            # built at import time (the "N Models" it logs at startup). It is
            # the authoritative list and is immune to any path/scan difference
            # on our side, so a user whose extension clearly found models never
            # ends up with an empty dropdown.
            borrowed = _ad_mapping_from_extension()
            if borrowed:
                _ad_model_mapping = borrowed
                print(f"[Studio AD] Own scan found 0 (scanned: {dirs}); "
                      f"using the extension's own list ({len(borrowed)} models)")
            else:
                print(f"[Studio AD] Found 0 models. Scanned: {dirs} — "
                      f"if ADetailer itself reports models, they live elsewhere; "
                      f"set Settings > ADetailer > ad_extra_models_dir.")
        elif len(dirs) > 1:
            print(f"[Studio AD] Found {len(_ad_model_mapping)} models "
                  f"across {len(dirs)} dirs (incl. ad_extra_models_dir)")
        else:
            print(f"[Studio AD] Found {len(_ad_model_mapping)} models")
        return _ad_model_mapping
    except Exception as e:
        print(f"[Studio AD] Could not load model list: {e}")
        return {}


def refresh_ad_models():
    """Drop the cached mapping and rescan (picks up newly added models or an
    ad_extra_models_dir the user just set, without a Forge restart)."""
    global _ad_model_mapping
    _ad_model_mapping = None
    return get_ad_model_mapping(force=True)


def get_ad_models():
    mapping = get_ad_model_mapping()
    return ["None"] + list(mapping.keys())
