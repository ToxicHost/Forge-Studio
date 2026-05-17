"""
Forge Studio — ADetailer Model Listing (compatibility shim)

This module previously owned the AD model dropdown lookup. AD logic
now lives in ``studio_autodetailer``; this shim re-exports the model
listing helpers so existing imports keep working without an API change.
"""

try:
    from scripts.studio_autodetailer import (
        get_ad_models,
        get_ad_models_for_ui_mapping as get_ad_model_mapping,
    )
except ImportError:
    from studio_autodetailer import (
        get_ad_models,
        get_ad_models_for_ui_mapping as get_ad_model_mapping,
    )

__all__ = ["get_ad_models", "get_ad_model_mapping"]
