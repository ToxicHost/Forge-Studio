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


def get_ad_model_mapping():
    global _ad_model_mapping
    if _ad_model_mapping is not None:
        return _ad_model_mapping
    try:
        from adetailer.common import get_models as ad_get_models
        model_dir = os.path.join(getattr(shared, 'models_path', 'models'), 'adetailer')
        os.makedirs(model_dir, exist_ok=True)
        _ad_model_mapping = ad_get_models(model_dir)
        print(f"[Studio AD] Found {len(_ad_model_mapping)} models")
        return _ad_model_mapping
    except Exception as e:
        print(f"[Studio AD] Could not load model list: {e}")
        return {}


def get_ad_models():
    mapping = get_ad_model_mapping()
    return ["None"] + list(mapping.keys())
