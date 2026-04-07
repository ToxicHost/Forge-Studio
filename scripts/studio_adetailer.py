"""
Forge Studio — ADetailer Model Listing
Minimal shim for Studio's model dropdown population.

ADetailer processing is handled by the native ADetailer extension (Studio fork).
Studio injects its UI params into native AD's script_args slots via
_build_native_ad_dicts() in studio_generation.py.
"""

import os
from modules import shared

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
