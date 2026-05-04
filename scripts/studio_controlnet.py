"""
Forge Studio — ControlNet Integration Module v2
================================================
Full-featured ControlNet integration for Forge Studio.

Discovers models/preprocessors from Forge's built-in sd_forge_controlnet
extension, creates ControlNetUnit objects, and injects them into the
processing pipeline via script_args.

Features:
    - Auto-discovery of models and preprocessors
    - Control type filtering (links preprocessors + models)
    - Image upload support (for OpenPose, depth from photos, etc.)
    - Processor resolution and threshold controls
    - Canvas / Active Layer / Upload image source selection
"""

import traceback

import numpy as np

from modules import shared

# =========================================================================
# EXTENSION DISCOVERY
# =========================================================================

_cn_external_code = None
_cn_global_state = None
_cn_available = None  # None = not yet checked


def _try_import_cn():
    """Try to import ControlNet extension modules. Cached after first call."""
    global _cn_external_code, _cn_global_state, _cn_available
    if _cn_available is not None:
        return _cn_available

    try:
        from lib_controlnet import external_code as ec
        _cn_external_code = ec
    except ImportError:
        try:
            import importlib
            _cn_external_code = importlib.import_module(
                'extensions-builtin.sd_forge_controlnet.lib_controlnet.external_code'
            )
        except Exception:
            _cn_available = False
            print("[Studio CN] ControlNet extension not found — integration disabled")
            return False

    try:
        from lib_controlnet import global_state as gs
        _cn_global_state = gs
    except ImportError:
        try:
            import importlib
            _cn_global_state = importlib.import_module(
                'extensions-builtin.sd_forge_controlnet.lib_controlnet.global_state'
            )
        except Exception:
            _cn_global_state = None

    _cn_available = True
    print("[Studio CN] ControlNet extension found — integration available")
    return True


def is_cn_available():
    """Check if ControlNet extension is available."""
    return _try_import_cn()


# =========================================================================
# MODEL & PREPROCESSOR DISCOVERY
# =========================================================================

def get_cn_models():
    """Get list of available ControlNet model names (includes 'None')."""
    if not _try_import_cn() or not _cn_global_state:
        return ["None"]
    try:
        return list(_cn_global_state.get_all_controlnet_names())
    except Exception as e:
        print(f"[Studio CN] Error getting models: {e}")
        return ["None"]


def get_cn_preprocessors():
    """Get list of available preprocessor names (includes 'None')."""
    if not _try_import_cn() or not _cn_global_state:
        return ["None"]
    try:
        return list(_cn_global_state.get_all_preprocessor_names())
    except Exception as e:
        print(f"[Studio CN] Error getting preprocessors: {e}")
        return ["None"]


def get_cn_control_types():
    """Get list of control type tags (e.g. 'All', 'Canny', 'Depth', 'Lineart', 'OpenPose')."""
    if not _try_import_cn() or not _cn_global_state:
        return ["All"]
    try:
        return list(_cn_global_state.get_all_preprocessor_tags())
    except Exception as e:
        print(f"[Studio CN] Error getting control types: {e}")
        return ["All"]


def get_filtered_cn(control_type):
    """
    Get filtered preprocessors and models for a given control type.
    Returns (preprocessor_names, model_names, default_preprocessor, default_model).
    """
    if not _try_import_cn() or not _cn_global_state:
        return ["None"], ["None"], "None", "None"
    try:
        return _cn_global_state.select_control_type(control_type)
    except Exception as e:
        print(f"[Studio CN] Error filtering by type '{control_type}': {e}")
        return ["None"], ["None"], "None", "None"


def refresh_cn_models():
    """Refresh the model list (call after downloading new models)."""
    if not _try_import_cn() or not _cn_global_state:
        return ["None"]
    try:
        _cn_global_state.update_controlnet_filenames()
        return list(_cn_global_state.get_all_controlnet_names())
    except Exception as e:
        print(f"[Studio CN] Error refreshing models: {e}")
        return ["None"]


# =========================================================================
# UNIT BUILDING
# =========================================================================

def build_cn_units(cn_settings, canvas_np=None, active_layer_np=None, upload_images=None):
    """
    Build ControlNetUnit objects from Studio UI settings.

    Args:
        cn_settings: list of dicts from the JS UI, each with:
            enabled, model, module, weight, guidance_start, guidance_end,
            control_mode, pixel_perfect, resize_mode, image_source,
            processor_res, threshold_a, threshold_b
        canvas_np: numpy array of composited canvas (HWC, uint8)
        active_layer_np: numpy array of active layer (HWC, uint8)
        upload_images: dict mapping unit index (0-based) to numpy arrays
                       from Gradio Image components

    Returns:
        List of ControlNetUnit objects (only enabled ones with valid models).
    """
    if not _try_import_cn() or not cn_settings:
        return []
    if upload_images is None:
        upload_images = {}

    ControlNetUnit = _cn_external_code.ControlNetUnit
    units = []

    for i, slot in enumerate(cn_settings):
        if not slot.get('enabled', False):
            continue

        model = slot.get('model', 'None')
        if model == 'None' or not model:
            continue

        # Determine input image
        image_source = slot.get('image_source', 'canvas')
        input_image = None

        if image_source == 'upload':
            # Gradio Image components pass numpy arrays directly
            if i in upload_images and upload_images[i] is not None:
                input_image = upload_images[i]
                if hasattr(input_image, 'copy'):
                    input_image = input_image.copy()
                print(f"[Studio CN] Unit {i+1}: Using uploaded image")

            if input_image is None:
                print(f"[Studio CN] Unit {i+1}: Upload selected but no image — falling back to canvas")
                image_source = 'canvas'

        if input_image is None:
            if image_source == 'active_layer' and active_layer_np is not None:
                input_image = active_layer_np.copy()
            elif canvas_np is not None:
                input_image = canvas_np.copy()
            else:
                print(f"[Studio CN] Unit {i+1}: No input image available — skipping")
                continue

        # Ensure HWC RGB uint8
        if input_image.dtype != np.uint8:
            input_image = (np.clip(input_image, 0, 1) * 255).astype(np.uint8)
        if input_image.ndim == 2:
            input_image = np.stack([input_image] * 3, axis=-1)
        elif input_image.shape[2] == 4:
            alpha = input_image[:, :, 3:4].astype(np.float32) / 255.0
            rgb = input_image[:, :, :3].astype(np.float32)
            white = np.ones_like(rgb) * 255.0
            input_image = (rgb * alpha + white * (1 - alpha)).astype(np.uint8)

        control_mode = slot.get('control_mode', 'Balanced')

        unit = ControlNetUnit(
            enabled=True,
            image=input_image,
            module=slot.get('module', 'None'),
            model=model,
            weight=float(slot.get('weight', 1.0)),
            guidance_start=float(slot.get('guidance_start', 0.0)),
            guidance_end=float(slot.get('guidance_end', 1.0)),
            control_mode=control_mode,
            pixel_perfect=bool(slot.get('pixel_perfect', True)),
            resize_mode=slot.get('resize_mode', 'Crop and Resize'),
            processor_res=int(slot.get('processor_res', -1)),
            threshold_a=float(slot.get('threshold_a', -1)),
            threshold_b=float(slot.get('threshold_b', -1)),
        )

        units.append(unit)
        print(f"[Studio CN] Unit {i+1}: model={model}, module={slot.get('module', 'None')}, "
              f"weight={unit.weight}, source={image_source}, "
              f"img_shape={input_image.shape}")

    return units


# =========================================================================
# INJECTION INTO PROCESSING PIPELINE
# =========================================================================

def inject_controlnet_units(p, units):
    """
    Inject ControlNetUnit objects into a processing object's script_args.
    Finds the ControlNet AlwaysOn script and places units in its arg slots.
    """
    if not units:
        return True
    if not _try_import_cn():
        return False
    if not hasattr(p, 'scripts') or p.scripts is None:
        print("[Studio CN] Cannot inject — no script runner on processing object")
        return False

    try:
        cn_script = None
        for s in p.scripts.alwayson_scripts:
            if s.title() == "ControlNet":
                cn_script = s
                break

        if cn_script is None:
            print("[Studio CN] ControlNet script not found in alwayson_scripts")
            return False

        args_from = cn_script.args_from
        args_to = cn_script.args_to
        n_slots = args_to - args_from

        script_args = list(p.script_args)
        while len(script_args) < args_to:
            script_args.append(None)

        ControlNetUnit = _cn_external_code.ControlNetUnit
        for i in range(n_slots):
            if i < len(units):
                script_args[args_from + i] = units[i]
            else:
                script_args[args_from + i] = ControlNetUnit(
                    enabled=False, module="None", model="None"
                )

        p.script_args = tuple(script_args)
        print(f"[Studio CN] Injected {len(units)} unit(s) into script_args "
              f"[{args_from}:{args_to}]")
        return True

    except Exception as e:
        print(f"[Studio CN] Injection failed: {e}")
        traceback.print_exc()
        return False


# =========================================================================
# GRADIO CALLBACKS
# =========================================================================

def get_cn_info():
    """Return CN info dict for initial UI population."""
    return {
        "available": is_cn_available(),
        "models": get_cn_models(),
        "preprocessors": get_cn_preprocessors(),
        "control_types": get_cn_control_types(),
    }
