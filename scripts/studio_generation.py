"""
Forge Studio — Generation Core
by ToxicHost & Moritz

Extracted from studio.py to support reuse by Comic Lab and other consumers.
Contains: dataclasses, utilities, checkpoint swap, hires fix, processing object
construction, script runner attachment, and the batch generation loop.
"""

import gradio as gr
import modules.scripts as scripts
from modules import processing, shared, sd_samplers, sd_models, images
from modules.processing import StableDiffusionProcessingImg2Img, StableDiffusionProcessingTxt2Img, process_images, Processed
from modules.shared import opts, state
try:
    from modules.progress import create_task_id, add_task_to_queue, start_task, finish_task
except ImportError:
    def create_task_id(t): return f"task-{t}"
    def add_task_to_queue(i): pass
    def start_task(i): pass
    def finish_task(i): pass

from PIL import Image
import numpy as np
import base64, io, os, json, random, time, traceback
from dataclasses import dataclass, field
from typing import Optional, List

try:
    from scripts.studio_ar import ARConfig, randomize_dimensions
    _HAS_AR = True
except ImportError:
    _HAS_AR = False


STUDIO_VERSION = "3.2"


# =========================================================================
# PARAMETER STRUCTS — unpack Gradio's flat args into these for readability
# =========================================================================

@dataclass
class GenParams:
    """Core generation parameters."""
    prompt: str = ""
    neg_prompt: str = ""
    steps: int = 20
    sampler_name: str = "Euler a"
    schedule_type: str = "Automatic"
    cfg_scale: float = 7.0
    denoising: float = 0.75
    width: int = 512
    height: int = 512
    seed: int = -1
    batch_count: int = 1
    batch_size: int = 1
    subseed: int = -1
    subseed_strength: float = 0
    seed_resize_from_w: int = 0
    seed_resize_from_h: int = 0

@dataclass
class InpaintParams:
    """Inpainting-specific parameters."""
    mask_blur: int = 4
    inpainting_fill: int = 1
    inpaint_full_res: bool = True
    inpaint_pad: int = 64
    soft_inpaint_enabled: bool = False
    soft_inpaint_schedule_bias: float = 1.0
    soft_inpaint_preservation: float = 0.5
    soft_inpaint_transition_contrast: float = 4.0
    soft_inpaint_mask_influence: float = 0.0
    soft_inpaint_diff_threshold: float = 0.5
    soft_inpaint_diff_contrast: float = 2.0

@dataclass
class HiresParams:
    """Hires Fix parameters."""
    enable: bool = False
    upscaler: str = "Latent"
    scale: float = 2.0
    steps: int = 0
    denoise: float = 0.3
    cfg: float = 0.0
    checkpoint: str = ""


# =========================================================================
# IMPORTS — ADetailer, Regional, Attention Couple, ControlNet
# =========================================================================

try:
    from scripts.studio_adetailer import get_ad_models, get_ad_model_mapping
except ImportError:
    from studio_adetailer import get_ad_models, get_ad_model_mapping

try:
    from scripts.studio_regional import (
        run_regional, has_valid_regions,
    )
except ImportError:
    from studio_regional import (
        run_regional, has_valid_regions,
    )

_HAS_ATTN_COUPLE = False
try:
    from scripts.studio_attention_couple import (
        has_attention_regions, run_with_attention_couple,
        cleanup_attention_couple, parse_regions,
    )
    _HAS_ATTN_COUPLE = True
except ImportError:
    try:
        from studio_attention_couple import (
            has_attention_regions, run_with_attention_couple,
            cleanup_attention_couple, parse_regions,
        )
        _HAS_ATTN_COUPLE = True
    except ImportError:
        print("[Studio] Attention couple module not found — single-pass regional disabled")

try:
    from scripts.studio_controlnet import (
        is_cn_available, get_cn_models, get_cn_preprocessors,
        get_cn_control_types, get_filtered_cn, refresh_cn_models,
        build_cn_units, inject_controlnet_units, get_cn_info,
    )
except ImportError:
    try:
        from studio_controlnet import (
            is_cn_available, get_cn_models, get_cn_preprocessors,
            get_cn_control_types, get_filtered_cn, refresh_cn_models,
            build_cn_units, inject_controlnet_units, get_cn_info,
        )
    except ImportError:
        def is_cn_available(): return False
        def get_cn_models(): return ["None"]
        def get_cn_preprocessors(): return ["None"]
        def get_cn_control_types(): return ["All"]
        def get_filtered_cn(t): return ["None"], ["None"], "None", "None"
        def refresh_cn_models(): return ["None"]
        def build_cn_units(*a, **kw): return []
        def inject_controlnet_units(*a, **kw): return False
        def get_cn_info(): return {"available": False, "models": ["None"], "preprocessors": ["None"], "control_types": ["All"]}


# =========================================================================
# UTILITIES
# =========================================================================

def decode_b64(data_url):
    if not data_url or data_url in ("null", ""): return None
    if "," in data_url: data_url = data_url.split(",", 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(data_url)))

def encode_b64(img, fmt="PNG"):
    buf = io.BytesIO(); img.save(buf, format=fmt)
    return f"data:image/{fmt.lower()};base64,{base64.b64encode(buf.getvalue()).decode()}"

def to_rgb(img):
    if img.mode == "RGBA":
        bg = Image.new("RGB", img.size, (255,255,255)); bg.paste(img, mask=img.split()[3]); return bg
    return img if img.mode == "RGB" else img.convert("RGB")


# =========================================================================
# PROGRESS TASK — global task ID for JS progress polling
# =========================================================================

# NOTE: Intentionally single-user. Not thread-safe for concurrent generation.
# If concurrent support is needed, wrap in threading.Lock or use a queue.
_studio_task_id = None


def get_studio_task_id():
    """Accessor for the API endpoint."""
    return _studio_task_id


def _reset_generation_state():
    """Clear stale interrupt/progress flags and set up fresh progress tracking."""
    shared.state.interrupted = False
    shared.state.skipped = False
    if hasattr(shared.state, 'stopping_generation'):
        shared.state.stopping_generation = False

    # Reset progress tracking so live preview starts fresh after interrupt
    shared.state.job_count = -1
    shared.state.job_no = 0
    shared.state.sampling_step = 0
    shared.state.sampling_steps = 0
    shared.state.current_latent = None
    shared.state.current_image = None
    shared.state.current_image_sampling_step = 0
    shared.state.id_live_preview = 0
    shared.state.textinfo = None
    shared.state.time_start = None

    global _studio_task_id
    _studio_task_id = None
    id_task = create_task_id("studio")
    _studio_task_id = id_task
    add_task_to_queue(id_task)
    start_task(id_task)
    shared.state.time_start = time.time()
    return id_task


# =========================================================================
# CHECKPOINT SWAP & HIRES FIX
# =========================================================================

_cached_upscalers = None

def get_upscalers():
    global _cached_upscalers
    if _cached_upscalers is not None:
        return _cached_upscalers
    try:
        names = [x.name for x in shared.sd_upscalers if x.name != "None"]
        _cached_upscalers = names if names else ["Latent"]
    except Exception as e:
        print(f"[Studio] Could not list upscalers: {e}")
        _cached_upscalers = ["Latent"]
    return _cached_upscalers

def get_checkpoints():
    """Get list of available checkpoints for the hires fix swap dropdown."""
    try:
        titles = ["Same"] + sorted(sd_models.checkpoints_list.keys())
        return titles
    except Exception as e:
        print(f"[Studio] Could not list checkpoints: {e}")
        return ["Same"]


def _swap_checkpoint(checkpoint_name):
    """Swap the active checkpoint. Multi-fallback for Forge Neo / Forge / A1111 compatibility.
    Returns True on success, False on failure."""
    if not checkpoint_name:
        return False

    # Method 1: Forge Neo — modules_forge.main_entry.checkpoint_change()
    try:
        from modules_forge import main_entry
        if hasattr(main_entry, 'checkpoint_change'):
            main_entry.checkpoint_change(checkpoint_name)
            print(f"[Studio HR] Swapped via main_entry.checkpoint_change: {checkpoint_name}")
            return True
    except (ImportError, Exception) as e:
        print(f"[Studio HR] main_entry method unavailable: {e}")

    # Method 2: Forge — forge_model_reload with forge_loading_parameters
    try:
        if hasattr(sd_models, 'forge_model_reload') and hasattr(sd_models, 'model_data'):
            ci = None
            if hasattr(sd_models, 'get_closet_checkpoint_match'):
                ci = sd_models.get_closet_checkpoint_match(checkpoint_name)
            elif hasattr(sd_models, 'get_closest_checkpoint_match'):
                ci = sd_models.get_closest_checkpoint_match(checkpoint_name)
            if ci is None:
                for k, v in sd_models.checkpoints_list.items():
                    if checkpoint_name in k:
                        ci = v
                        break
            if ci:
                sd_models.model_data.forge_loading_parameters = {
                    "checkpoint_info": ci,
                    "additional_modules": [],
                }
                sd_models.forge_model_reload()
                print(f"[Studio HR] Swapped via forge_model_reload: {checkpoint_name}")
                return True
    except Exception as e:
        print(f"[Studio HR] forge_model_reload method failed: {e}")

    # Method 3: A1111 classic — reload_model_weights
    try:
        if hasattr(sd_models, 'reload_model_weights'):
            ci = None
            if hasattr(sd_models, 'get_closet_checkpoint_match'):
                ci = sd_models.get_closet_checkpoint_match(checkpoint_name)
            elif hasattr(sd_models, 'get_closest_checkpoint_match'):
                ci = sd_models.get_closest_checkpoint_match(checkpoint_name)
            if ci:
                sd_models.reload_model_weights(shared.sd_model, ci)
                print(f"[Studio HR] Swapped via reload_model_weights: {checkpoint_name}")
                return True
    except Exception as e:
        print(f"[Studio HR] reload_model_weights method failed: {e}")

    print(f"[Studio HR] All checkpoint swap methods failed for: {checkpoint_name}")
    return False


def run_hires_fix(image, upscaler_name, scale, hr_steps, hr_denoise, hr_cfg, p_orig, hr_checkpoint=""):
    """Hires fix that reuses the existing processing object to avoid model
    unload/reload cycles in lowvram mode. Saves and restores p_orig's state
    so it remains usable for ADetailer etc. afterwards."""
    if not image or scale <= 1.0:
        return image
    original_checkpoint = None

    # Save original state so we can restore after hires pass
    _saved = {
        "init_images": p_orig.init_images,
        "denoising_strength": p_orig.denoising_strength,
        "steps": p_orig.steps,
        "cfg_scale": p_orig.cfg_scale,
        "width": p_orig.width,
        "height": p_orig.height,
        "image_mask": getattr(p_orig, 'image_mask', None),
        "inpaint_full_res": getattr(p_orig, 'inpaint_full_res', False),
        # Soft Inpainting hooks check p.mask/p.nmask to decide whether to run.
        # These persist from the base generation at the wrong resolution — clearing
        # them makes processing_uses_inpainting(p) return False, so all hooks bail.
        "mask": getattr(p_orig, 'mask', None),
        "nmask": getattr(p_orig, 'nmask', None),
        # Standard inpainting composites p.overlay_images onto the result. If these
        # persist from the base gen at base resolution, the hires process_images()
        # pastes them at (0,0) onto the upscaled result — wrong size, wrong position.
        "overlay_images": getattr(p_orig, 'overlay_images', None),
    }

    try:
        w, h = image.size
        new_w = (int(w * scale) // 8) * 8
        new_h = (int(h * scale) // 8) * 8
        upscaler = None
        for u in shared.sd_upscalers:
            if u.name == upscaler_name:
                upscaler = u; break
        if upscaler and upscaler.name != "None":
            print(f"[Studio HR] Upscaling {w}x{h} -> {new_w}x{new_h} with {upscaler_name}")
            target_scale = new_w / w
            upscaled = upscaler.scaler.upscale(image, target_scale, upscaler.data_path)
            if upscaled.size != (new_w, new_h):
                upscaled = upscaled.resize((new_w, new_h), Image.LANCZOS)
        else:
            if upscaler_name and upscaler_name != "Latent":
                print(f"[Studio HR] Warning: upscaler '{upscaler_name}' not found, using LANCZOS resize")
            upscaled = image.resize((new_w, new_h), Image.LANCZOS)

        # Checkpoint swap for hires pass
        if hr_checkpoint and hr_checkpoint not in ("", "None", "Same"):
            try:
                current_info = getattr(shared.sd_model, 'sd_checkpoint_info', None)
                current_name = ""
                if current_info:
                    current_name = getattr(current_info, 'title', '') or getattr(current_info, 'name', '')
                if current_name != hr_checkpoint:
                    original_checkpoint = current_name
                    print(f"[Studio HR] Swapping checkpoint: {current_name} -> {hr_checkpoint}")
                    if not _swap_checkpoint(hr_checkpoint):
                        print(f"[Studio HR] WARNING: Checkpoint swap failed, using current model")
                        original_checkpoint = None
            except Exception as e:
                print(f"[Studio HR] Checkpoint swap failed: {e}")
                traceback.print_exc()
                original_checkpoint = None

        # Reconfigure the existing processing object for the hires pass
        use_steps = hr_steps if hr_steps > 0 else p_orig.steps
        use_cfg = hr_cfg if hr_cfg > 0 else p_orig.cfg_scale

        p_orig.init_images = [upscaled]
        p_orig.denoising_strength = hr_denoise
        p_orig.steps = use_steps
        p_orig.cfg_scale = use_cfg
        p_orig.width = new_w
        p_orig.height = new_h

        # If there's an inpaint mask, upscale it and pass it through so the
        # hires pass only denoises the masked region. Without this, hires
        # runs on the full image and alters faces/areas that were deliberately
        # left untouched by the base generation + AD filtering.
        _inpaint_mask = getattr(p_orig, '_studio_inpaint_mask', None) or _saved.get("image_mask")
        if _inpaint_mask is not None:
            hr_mask = _inpaint_mask.convert("L").resize((new_w, new_h), Image.LANCZOS)
            p_orig.image_mask = hr_mask
            p_orig.inpaint_full_res = False  # Whole picture — mask just constrains denoise
            p_orig.mask = None
            p_orig.nmask = None
            p_orig.overlay_images = None
        else:
            # No mask (txt2img hires, edit without mask) — clear inpaint state
            p_orig.image_mask = None
            p_orig.inpaint_full_res = False
            p_orig.mask = None
            p_orig.nmask = None
            p_orig.overlay_images = None

        # Disable native AD for the hires pass — AD already fired on the base
        # gen inside the first process_images() call. Without this, AD would
        # fire again on the hires denoise pass (double-processing faces).
        _saved_ad_disabled = getattr(p_orig, '_ad_disabled', False)
        p_orig._ad_disabled = True

        try:
            processed = process_images(p_orig)
            if processed and processed.images:
                print(f"[Studio HR] Hires pass complete: {new_w}x{new_h}")
                return processed.images[0]
        except Exception as e:
            print(f"[Studio HR] Second pass error: {e}")
        return upscaled
    except Exception as e:
        print(f"[Studio HR] Error: {e}")
        traceback.print_exc()
        return image
    finally:
        # Restore original state so p_orig is usable for subsequent passes
        for k, v in _saved.items():
            setattr(p_orig, k, v)
        p_orig._ad_disabled = _saved_ad_disabled
        # Always restore original checkpoint
        if original_checkpoint:
            try:
                print(f"[Studio HR] Restoring checkpoint: {original_checkpoint}")
                _swap_checkpoint(original_checkpoint)
                print(f"[Studio HR] Checkpoint restored")
            except Exception as e:
                print(f"[Studio HR] WARNING: Failed to restore checkpoint: {e}")


# =========================================================================
# INTERRUPT / SKIP
# =========================================================================

def do_interrupt():
    shared.state.interrupted = True
    if hasattr(shared.state, 'interrupt'):
        shared.state.interrupt()
    return "<p style='color:#fa0;'>Interrupting...</p>"

def do_skip():
    shared.state.skipped = True
    if hasattr(shared.state, 'skip'):
        shared.state.skip()
    return "<p style='color:#6af;'>Skipping to next...</p>"


# =========================================================================
# MAIN GENERATION — Sub-functions
# =========================================================================

def _ensure_model_loaded():
    """Load the SD model if not already in memory.

    Forge lazy-loads the model on first process_images() call. Before that,
    shared.sd_model is a FakeInitialModel placeholder with no forge_objects
    or get_learned_conditioning. This causes cold-start failures for any code
    that needs the model before process_images (e.g. attention couple encoding).

    We detect FakeInitialModel by checking for forge_objects and trigger a
    full load via forge_model_reload() which sets up the complete Forge
    pipeline including forge_objects.unet, .clip, .vae.

    Also detects model mismatch (e.g. WAN model still loaded after returning
    from Video Lab) by comparing forge_hash against forge_loading_parameters.
    """
    try:
        model = shared.sd_model
        if model is None:
            print("[Studio] No model — triggering load")
        elif not hasattr(model, 'forge_objects') or model.forge_objects is None:
            print("[Studio] FakeInitialModel detected — triggering full load")
        else:
            # Model is loaded — but is it the RIGHT model?
            # Video Lab deactivate sets forge_hash="" so we detect the mismatch.
            try:
                current_hash = str(sd_models.model_data.forge_loading_parameters)
                if sd_models.model_data.forge_hash != current_hash:
                    print("[Studio] Model mismatch detected — triggering reload")
                else:
                    return  # Model is properly loaded and matches
            except Exception:
                return  # Can't check — assume it's fine

        # Method 1: Forge-specific full reload (sets up forge_objects)
        if hasattr(sd_models, 'forge_model_reload'):
            try:
                sd_models.forge_model_reload()
                if hasattr(shared.sd_model, 'forge_objects') and shared.sd_model.forge_objects is not None:
                    print("[Studio] Model loaded via forge_model_reload")
                    return
            except Exception as e:
                print(f"[Studio] forge_model_reload failed: {e}")

        # Method 2: load_model
        try:
            sd_models.load_model()
            if hasattr(shared.sd_model, 'forge_objects') and shared.sd_model.forge_objects is not None:
                print("[Studio] Model loaded via load_model")
                return
        except (AttributeError, Exception) as e:
            print(f"[Studio] load_model failed: {e}")

        # Method 3: reload_model_weights
        try:
            sd_models.reload_model_weights()
            if hasattr(shared.sd_model, 'forge_objects') and shared.sd_model.forge_objects is not None:
                print("[Studio] Model loaded via reload_model_weights")
                return
        except (AttributeError, Exception) as e:
            print(f"[Studio] reload_model_weights failed: {e}")

        # Check final state
        if not hasattr(shared.sd_model, 'forge_objects') or shared.sd_model.forge_objects is None:
            print("[Studio] WARNING: All load methods tried, forge_objects still not available. "
                  "First generation may fall back to standard (model loads during process_images).")

    except Exception as e:
        print(f"[Studio] Model loading error: {e}")
        traceback.print_exc()


def _prepare_mask(mask_b64, w, h, inpaint_mode):
    """Decode, resize, and process the inpaint mask. Returns (mask_img, has_mask)."""
    if not mask_b64 or mask_b64 in ("null", ""):
        return None, False
    try:
        mask_img = decode_b64(mask_b64)
        if not mask_img:
            return None, False
        mask_img = mask_img.resize((w, h), Image.LANCZOS).convert("L")
        if inpaint_mode == "Inpaint Sketch":
            from PIL import ImageFilter
            short_side = min(w, h)
            dil = int(0.015 * short_side) * 2 + 1
            if dil > 1:
                mask_img = mask_img.filter(ImageFilter.MaxFilter(dil))
        has_mask = np.array(mask_img).max() >= 10
        if has_mask:
            mask_img = mask_img.point(lambda v: 255 if v > 128 else 0)
            return mask_img, True
        return None, False
    except Exception as e:
        print(f"[Studio] Mask processing error: {e}")
        traceback.print_exc()
        return None, False


def _get_output_dir(mode):
    """Get the output directory for the given mode."""
    try:
        # Use Forge's configured output directory (respects user settings)
        base_outdir = shared.opts.data.get("outdir_samples", "")
        if not base_outdir:
            base_outdir = shared.opts.data.get("outdir_img2img_samples", "")
        if not base_outdir:
            from modules.paths import data_path
            base_outdir = os.path.join(data_path, "output")
        # Go up to the output root if we're in a subfolder like img2img-images
        if os.path.basename(base_outdir) in ("txt2img-images", "img2img-images"):
            base_outdir = os.path.dirname(base_outdir)
    except Exception:
        base_outdir = os.path.abspath("output")
    mode_folder = {"Create": "create", "Edit": "edit", "img2img": "img2img"}.get(mode, "other")
    from datetime import date
    date_folder = date.today().strftime("%Y-%m-%d")
    studio_outdir = os.path.join(base_outdir, "studio", mode_folder, date_folder)
    os.makedirs(studio_outdir, exist_ok=True)
    return studio_outdir


def _build_native_ad_dicts(ad_enable, ad_raw_slots):
    """Build native ADetailer-compatible slot dicts from Studio's frontend params.

    Returns (enable_bool, list_of_slot_dicts) ready for injection into
    native AD's script_args slots.
    """
    dicts = []
    for s in ad_raw_slots:
        slot_enabled = bool(ad_enable) and bool(s.get("enable", False))
        model = s.get("model") or "None"
        dicts.append({
            "ad_model": model,
            "ad_model_classes": "",
            "ad_tab_enable": slot_enabled,
            "ad_prompt": s.get("prompt") or "",
            "ad_negative_prompt": s.get("neg_prompt") or "",
            "ad_confidence": float(s.get("confidence", 0.3)),
            "ad_mask_filter_method": "Area" if not s.get("topk_filter") else "Confidence",
            "ad_mask_k": int(s.get("topk", 0)),
            "ad_mask_min_ratio": float(s.get("mask_min_ratio", 0.0)),
            "ad_mask_max_ratio": float(s.get("mask_max_ratio", 1.0)),
            "ad_x_offset": int(s.get("mask_x_offset", 0)),
            "ad_y_offset": int(s.get("mask_y_offset", 0)),
            "ad_dilate_erode": int(s.get("mask_erosion_dilation", 4)),
            "ad_mask_merge_invert": s.get("mask_merge_mode", "None"),
            "ad_mask_blur": int(s.get("mask_blur", 4)),
            "ad_denoising_strength": float(s.get("denoise", 0.4)),
            "ad_inpaint_only_masked": bool(int(s.get("inpaint_full_res", 1))),
            "ad_inpaint_only_masked_padding": int(s.get("inpaint_pad", 32)),
            "ad_use_inpaint_width_height": bool(s.get("use_inpaint_wh", False)),
            "ad_inpaint_width": int(s.get("inpaint_width", 512)),
            "ad_inpaint_height": int(s.get("inpaint_height", 512)),
            "ad_use_steps": bool(s.get("use_sep_steps", False)),
            "ad_steps": int(s.get("ad_steps", 28)),
            "ad_use_cfg_scale": bool(s.get("use_sep_cfg", False)),
            "ad_cfg_scale": float(s.get("ad_cfg", 7.0)),
            "ad_use_checkpoint": False,
            "ad_checkpoint": None,
            "ad_use_vae": False,
            "ad_vae": None,
            "ad_use_sampler": bool(s.get("use_sep_sampler", False)),
            "ad_sampler": s.get("ad_sampler") or "DPM++ 2M Karras",
            "ad_scheduler": s.get("ad_scheduler") or "Use same scheduler",
            "ad_use_noise_multiplier": False,
            "ad_noise_multiplier": 1.0,
            "ad_use_clip_skip": False,
            "ad_clip_skip": 1,
            "ad_restore_face": False,
            "ad_controlnet_model": "None",
            "ad_controlnet_module": "None",
            "ad_controlnet_weight": 1.0,
            "ad_controlnet_guidance_start": 0.0,
            "ad_controlnet_guidance_end": 1.0,
            "is_api": True,
        })
    return bool(ad_enable), dicts


# =========================================================================
# STUDIO AD — hijacked ADetailer pipeline with centroid filtering
# =========================================================================
# Runs detection and inpainting using the installed adetailer package
# but under Studio's control. Stock AD is suppressed via p._ad_disabled.
# Key improvement: centroid-based mask filtering prevents processing
# faces outside the inpaint mask, which stock AD doesn't do.

_HAS_AD_LIBS = False
try:
    from adetailer import ultralytics_predict, get_models as ad_get_models
    from adetailer.common import PredictOutput, ensure_pil_image
    from adetailer.mask import mask_preprocess, filter_by_ratio, filter_k_by, sort_bboxes, is_all_black
    _HAS_AD_LIBS = True
except ImportError:
    pass


def _get_ad_model_mapping():
    """Get AD model name → path mapping. Cached after first call."""
    if not _HAS_AD_LIBS:
        return {}
    if not hasattr(_get_ad_model_mapping, "_cache"):
        from pathlib import Path
        from modules import paths
        ad_dir = Path(paths.models_path, "adetailer")
        extra = shared.opts.data.get("ad_extra_models_dir", "")
        _get_ad_model_mapping._cache = ad_get_models(
            ad_dir, *extra.split("|"), huggingface=True
        )
    return _get_ad_model_mapping._cache


def _get_ad_device():
    """Determine device for YOLO inference."""
    import platform
    if hasattr(shared.cmd_opts, 'use_cpu') and "adetailer" in getattr(shared.cmd_opts, 'use_cpu', []):
        return "cpu"
    if platform.system() == "Darwin":
        return ""
    for arg in ("lowvram", "medvram", "medvram_sdxl"):
        if getattr(shared.cmd_opts, arg, False):
            return "cpu"
    return ""


def _match_detection_to_region(bbox, regions, image_size):
    """Match a detection bbox to the best-overlapping Attention Couple region.

    Ported from !adetailer.py Studio fork. Each detection's bounding box
    is compared against painted region masks by overlap ratio. The region
    with the highest overlap (above 10%) wins.

    Returns (prompt, neg_prompt) or (None, None) if no match.
    """
    if not regions or not bbox:
        return None, None

    x1, y1, x2, y2 = bbox
    w, h = image_size

    bx1, by1 = max(0, int(x1)), max(0, int(y1))
    bx2, by2 = min(w, int(x2)), min(h, int(y2))
    if bx2 <= bx1 or by2 <= by1:
        return None, None

    det_mask = np.zeros((h, w), dtype=np.float32)
    det_mask[by1:by2, bx1:bx2] = 1.0
    det_area = det_mask.sum()
    if det_area < 1:
        return None, None

    best_overlap = 0.0
    best_region = None

    for r in regions:
        mask_np = r.get("mask_np")
        if mask_np is None:
            continue
        if mask_np.shape[0] != h or mask_np.shape[1] != w:
            mask_pil = Image.fromarray(
                (mask_np * 255).astype(np.uint8), mode="L"
            )
            mask_pil = mask_pil.resize((w, h), Image.NEAREST)
            mask_np = np.asarray(mask_pil, dtype=np.float32) / 255.0

        overlap = (det_mask * mask_np).sum()
        ratio = overlap / det_area
        if ratio > best_overlap:
            best_overlap = ratio
            best_region = r

    if best_region and best_overlap > 0.1:
        # Prefer ad_prompt (character-only, post-wildcard) for face inpainting.
        # Falls back to full region prompt if ad_prompt not set.
        prompt = best_region.get("ad_prompt", best_region.get("prompt", ""))
        neg = best_region.get("ad_neg_prompt", best_region.get("neg_prompt", ""))
        return prompt, neg

    return None, None


def _run_studio_ad(result_img, p, ad_slots, mask_img=None):
    """Run Studio's own ADetailer pipeline on the result image.

    Parameters
    ----------
    result_img : PIL.Image
        The generated image (post-hires if applicable).
    p : processing object
        The original processing object (for seed, prompt, settings).
    ad_slots : list[dict]
        Slot dicts from _build_native_ad_dicts.
    mask_img : PIL.Image or None
        The user's inpaint mask (for centroid filtering).

    Returns
    -------
    PIL.Image — the processed result with faces refined.
    """
    if not _HAS_AD_LIBS:
        return result_img

    model_map = _get_ad_model_mapping()
    if not model_map:
        return result_img

    device = _get_ad_device()
    image = ensure_pil_image(result_img, "RGB")
    processed_any = False

    for slot_idx, slot in enumerate(ad_slots):
        if not slot.get("ad_tab_enable"):
            continue
        model_name = slot.get("ad_model", "None")
        if model_name == "None" or model_name not in model_map:
            continue

        model_path = model_map[model_name]
        confidence = float(slot.get("ad_confidence", 0.3))

        # Detection
        try:
            pred = ultralytics_predict(
                model_path, image=image,
                confidence=confidence, device=device,
                classes=slot.get("ad_model_classes", ""),
            )
        except Exception as e:
            print(f"[Studio AD] Detection error slot {slot_idx+1}: {e}")
            continue

        if pred.preview is None or not pred.masks:
            print(f"[Studio AD] Slot {slot_idx+1} ({model_name}): nothing detected")
            continue

        # Mask preprocessing
        masks = filter_by_ratio(
            pred, low=float(slot.get("ad_mask_min_ratio", 0.0)),
            high=float(slot.get("ad_mask_max_ratio", 1.0)),
        )
        masks = filter_k_by(masks, k=int(slot.get("ad_mask_k", 0)),
                            by=slot.get("ad_mask_filter_method", "Area"))
        masks = sort_bboxes(masks)
        det_bboxes = list(masks.bboxes)  # preserve for region matching
        det_masks = mask_preprocess(
            masks.masks,
            kernel=int(slot.get("ad_dilate_erode", 4)),
            x_offset=int(slot.get("ad_x_offset", 0)),
            y_offset=int(slot.get("ad_y_offset", 0)),
            merge_invert=slot.get("ad_mask_merge_invert", "None"),
        )

        if not det_masks:
            print(f"[Studio AD] Slot {slot_idx+1}: no masks after preprocessing")
            continue

        # Bbox alignment check — mask_preprocess can merge masks,
        # breaking 1:1 correspondence with bboxes
        if len(det_bboxes) != len(det_masks):
            det_bboxes = [None] * len(det_masks)

        # ── Centroid filtering ──
        # If the user has an inpaint mask, only process detections whose
        # center of mass falls inside the mask.
        if mask_img is not None:
            mask_resized = mask_img.convert("L").resize(image.size, Image.LANCZOS)
            mask_arr = np.array(mask_resized)
            filtered = []
            filtered_bboxes = []
            for j, dm in enumerate(det_masks):
                dm_arr = np.array(ensure_pil_image(dm, "L"))
                ys, xs = np.where(dm_arr > 128)
                if len(xs) == 0:
                    continue
                cx, cy = int(np.mean(xs)), int(np.mean(ys))
                cx = max(0, min(cx, mask_arr.shape[1] - 1))
                cy = max(0, min(cy, mask_arr.shape[0] - 1))
                if mask_arr[cy, cx] > 128:
                    filtered.append(dm)
                    filtered_bboxes.append(det_bboxes[j] if j < len(det_bboxes) else None)
                    print(f"[Studio AD] Slot {slot_idx+1} det {j+1}: center ({cx},{cy}) INSIDE mask")
                else:
                    print(f"[Studio AD] Slot {slot_idx+1} det {j+1}: center ({cx},{cy}) OUTSIDE mask — skipped")
            det_masks = filtered
            det_bboxes = filtered_bboxes
            if not det_masks:
                print(f"[Studio AD] Slot {slot_idx+1}: all detections outside mask")
                continue

        # Prompt resolution
        # Use resolved prompts (post-wildcard, post-dynamic-prompts) from the
        # main generation pass. p.prompt is raw text with __wildcards__ still in it.
        # p.all_prompts[0] is what actually generated the image.
        ad_prompt = slot.get("ad_prompt", "").strip()
        ad_neg = slot.get("ad_negative_prompt", "").strip()
        resolved_prompt = p.all_prompts[0] if hasattr(p, 'all_prompts') and p.all_prompts else p.prompt
        resolved_neg = p.all_negative_prompts[0] if hasattr(p, 'all_negative_prompts') and p.all_negative_prompts else p.negative_prompt
        use_prompt = ad_prompt if ad_prompt else resolved_prompt
        use_neg = ad_neg if ad_neg else resolved_neg

        # Settings
        denoise = float(slot.get("ad_denoising_strength", 0.4))
        mask_blur = int(slot.get("ad_mask_blur", 4))
        only_masked = bool(slot.get("ad_inpaint_only_masked", True))
        padding = int(slot.get("ad_inpaint_only_masked_padding", 32))
        steps = int(slot.get("ad_steps", 28)) if slot.get("ad_use_steps") else (p.steps or 28)
        cfg = float(slot.get("ad_cfg_scale", 7.0)) if slot.get("ad_use_cfg_scale") else (p.cfg_scale or 7.0)
        sampler = p.sampler_name or "Euler a"
        if slot.get("ad_use_sampler") and slot.get("ad_sampler") != "Use same sampler":
            sampler = slot.get("ad_sampler", p.sampler_name)
        scheduler = getattr(p, 'scheduler', 'Automatic')
        if slot.get("ad_use_sampler") and slot.get("ad_scheduler") not in (None, "", "Use same scheduler"):
            scheduler = slot.get("ad_scheduler")

        w, h = image.size

        n_detections = len(det_masks)
        print(f"[Studio AD] Slot {slot_idx+1} ({model_name}): processing {n_detections} detection(s)")

        # Per-detection inpainting passes
        current_img = image
        studio_regions = getattr(p, "_studio_regions", None)

        for j, dm in enumerate(det_masks):
            if shared.state.interrupted:
                break

            # ── Per-detection region prompt matching ──
            # When Attention Couple regions are active and no explicit
            # AD slot prompt is set, match this detection to the
            # best-overlapping region and use that region's prompt.
            det_prompt = use_prompt
            det_neg = use_neg
            if (
                studio_regions
                and not ad_prompt  # no explicit slot-level prompt
                and j < len(det_bboxes)
                and det_bboxes[j] is not None
            ):
                r_prompt, r_neg = _match_detection_to_region(
                    det_bboxes[j], studio_regions, (w, h)
                )
                if r_prompt:
                    det_prompt = r_prompt
                    if r_neg:
                        det_neg = r_neg
                    print(
                        f"[Studio AD] Slot {slot_idx+1} det {j+1}: "
                        f"region match → \"{r_prompt[:60]}\""
                    )

            seed = (p.seed or 0) + j if hasattr(p, 'seed') else -1

            i2i = StableDiffusionProcessingImg2Img(
                sd_model=shared.sd_model,
                outpath_samples=p.outpath_samples,
                outpath_grids=p.outpath_grids,
                init_images=[current_img],
                resize_mode=0,
                denoising_strength=denoise,
                mask=None,
                mask_blur=mask_blur,
                inpainting_fill=1,
                inpaint_full_res=only_masked,
                inpaint_full_res_padding=padding,
                inpainting_mask_invert=0,
                prompt=det_prompt,
                negative_prompt=det_neg,
                seed=seed,
                subseed=getattr(p, 'subseed', -1),
                subseed_strength=getattr(p, 'subseed_strength', 0),
                sampler_name=sampler,
                batch_size=1, n_iter=1,
                steps=steps,
                cfg_scale=cfg,
                width=w, height=h,
                do_not_save_samples=True,
                do_not_save_grid=True,
            )

            if hasattr(i2i, 'scheduler'):
                i2i.scheduler = scheduler

            i2i.image_mask = dm
            i2i._ad_disabled = True  # Prevent recursive AD
            i2i.cached_c = [None, None]
            i2i.cached_uc = [None, None]
            i2i.scripts = None
            i2i.script_args = []

            # Force-set — constructor can lose these to None
            i2i.steps = steps
            i2i.cfg_scale = cfg
            i2i.sampler_name = sampler
            i2i.denoising_strength = denoise

            try:
                proc = process_images(i2i)
                if proc and proc.images:
                    current_img = proc.images[0]
                    processed_any = True
            except Exception as e:
                print(f"[Studio AD] Inpaint error slot {slot_idx+1} det {j+1}: {e}")
                traceback.print_exc()
            finally:
                try: i2i.close()
                except Exception: pass

        image = current_img

    if processed_any:
        print(f"[Studio AD] Pipeline complete")
    return image


def _cast_arg(val, runner, idx):
    """Cast a bridge arg value to the type expected by the script component.

    Hidden inputs and JSON transport can coerce numbers/bools to strings.
    We use the stub component's _type as a hint, but also defensively
    coerce any string that looks like a number or bool — because overlapping
    arg indices mean the component type might not match what the reading
    script actually expects.
    """
    # Already a non-string type — leave it alone
    if not isinstance(val, str):
        return val

    # Try bool first (before number, since "true"/"false" aren't numeric)
    if val.lower() in ('true', 'false'):
        return val.lower() == 'true'

    # Try number
    try:
        f = float(val)
        # Preserve int when the value has no decimal component
        if f == int(f) and '.' not in val:
            return int(f)
        return f
    except (ValueError, TypeError):
        pass

    # Genuine string — return as-is
    return val


def _force_enable_dynamic_prompts(runner, script_args):
    """Force sd-dynamic-prompts' is_enabled checkbox to True in script_args.

    DP defaults is_enabled to the result of an internal library-version
    check. When the dynamicprompts pip package is missing, version-
    mismatched, or installed against a different Python interpreter, the
    check fails, the checkbox defaults to False, and DP's process() no-
    ops — wildcards pass through the pipeline as literal text. Vanilla
    WebUI surfaces this with a red banner; Studio hides DP's UI via
    NATIVE_TITLES so users get zero signal.

    Locate the DP script in alwayson_scripts, scan its input slots for the
    is_enabled component by label (falling back to args_from), and write
    True. If DP's library is genuinely broken, DP will now raise loudly
    during process() — visible failure > silent failure.

    Returns the target index that was overridden, or None if DP wasn't
    found on the runner.
    """
    if runner is None or not hasattr(runner, 'alwayson_scripts'):
        return None
    dp_script = None
    for s in runner.alwayson_scripts:
        try:
            if s.title().strip().lower() == "dynamic prompts":
                dp_script = s
                break
        except Exception:
            continue
    if dp_script is None:
        return None
    args_from = getattr(dp_script, 'args_from', None)
    args_to = getattr(dp_script, 'args_to', None)
    if args_from is None or args_to is None:
        return None
    target = args_from
    inputs = getattr(runner, 'inputs', None)
    if inputs:
        for i in range(args_from, min(args_to, len(inputs))):
            comp = inputs[i]
            if comp is None:
                continue
            label = getattr(comp, 'label', None)
            if not isinstance(label, str):
                continue
            label_lc = label.strip().lower()
            if "dynamic prompts enabled" in label_lc or label_lc == "enabled":
                target = i
                break
    while target >= len(script_args):
        script_args.append(None)
    prev = script_args[target]
    script_args[target] = True
    if prev is not True:
        print(f"[Studio] Forced Dynamic Prompts is_enabled=True at script_args[{target}] (was {prev!r})")
    return target


def _attach_script_runner(p, has_mask=False, ip=None, cn_units=None, extension_args=None, ad_params=None):
    """Attach img2img script runner for wildcards, dynamic prompts, etc.

    extension_args: optional dict of {index: value} overrides from the
    extension bridge frontend. These are injected into script_args after
    the defaults are read from component .value attributes.
    """
    try:
        import modules.scripts as mod_scripts
        runner = mod_scripts.scripts_img2img
        if runner and hasattr(runner, 'alwayson_scripts'):
            p.scripts = runner
            n_inputs = len(runner.inputs) if hasattr(runner, 'inputs') else 0
            script_args = [None] * n_inputs
            if hasattr(runner, 'inputs') and runner.inputs:
                for i, comp in enumerate(runner.inputs):
                    if comp is not None and hasattr(comp, 'value'):
                        script_args[i] = _cast_arg(comp.value, runner, i)
            if script_args:
                script_args[0] = 0

            # Force DP enabled — see _force_enable_dynamic_prompts() docstring.
            _force_enable_dynamic_prompts(runner, script_args)

            # Inject Soft Inpainting settings if applicable
            if has_mask and ip and ip.soft_inpaint_enabled:
                for s in runner.alwayson_scripts:
                    if s.title() == "Soft Inpainting":
                        idx = s.args_from
                        if idx < len(script_args):
                            script_args[idx] = True
                            if idx + 1 < len(script_args): script_args[idx + 1] = ip.soft_inpaint_schedule_bias
                            if idx + 2 < len(script_args): script_args[idx + 2] = ip.soft_inpaint_preservation
                            if idx + 3 < len(script_args): script_args[idx + 3] = ip.soft_inpaint_transition_contrast
                            if idx + 4 < len(script_args): script_args[idx + 4] = ip.soft_inpaint_mask_influence
                            if idx + 5 < len(script_args): script_args[idx + 5] = ip.soft_inpaint_diff_threshold
                            if idx + 6 < len(script_args): script_args[idx + 6] = ip.soft_inpaint_diff_contrast
                            print(f"[Studio] Soft Inpainting enabled: bias={ip.soft_inpaint_schedule_bias}, "
                                  f"preserve={ip.soft_inpaint_preservation}, contrast={ip.soft_inpaint_transition_contrast}, "
                                  f"mask_inf={ip.soft_inpaint_mask_influence}, diff_thresh={ip.soft_inpaint_diff_threshold}, "
                                  f"diff_contrast={ip.soft_inpaint_diff_contrast}")
                        break

            # Inject ControlNet units if provided
            if cn_units:
                for s in runner.alwayson_scripts:
                    if s.title() == "ControlNet":
                        args_from = s.args_from
                        args_to = s.args_to
                        n_slots = args_to - args_from
                        while len(script_args) < args_to:
                            script_args.append(None)
                        try:
                            from lib_controlnet.external_code import ControlNetUnit as CNU
                        except ImportError:
                            from studio_controlnet import _cn_external_code
                            CNU = _cn_external_code.ControlNetUnit if _cn_external_code else None
                        if CNU:
                            for i in range(n_slots):
                                if i < len(cn_units):
                                    script_args[args_from + i] = cn_units[i]
                                else:
                                    script_args[args_from + i] = CNU(enabled=False, module="None", model="None")
                            print(f"[Studio CN] Injected {len(cn_units)} unit(s) [{args_from}:{args_to}]")
                        break

            # Inject ADetailer parameters — Studio controls AD via its own UI,
            # so we inject our slot configs into native AD's script_args slots.
            # Native AD reads: [enable_bool, skip_img2img_bool, slot1_dict, slot2_dict, ...]
            if ad_params:
                ad_enable, ad_slot_dicts = ad_params
                for s in runner.alwayson_scripts:
                    if s.title() == "ADetailer":
                        idx = s.args_from
                        n_needed = 2 + len(ad_slot_dicts)  # enable + skip + N slots
                        while len(script_args) < idx + n_needed:
                            script_args.append(None)
                        script_args[idx] = ad_enable          # InputAccordion enable
                        script_args[idx + 1] = False          # skip_img2img
                        for i, slot_dict in enumerate(ad_slot_dicts):
                            script_args[idx + 2 + i] = slot_dict
                        active = sum(1 for d in ad_slot_dicts if d.get("ad_tab_enable") and d.get("ad_model", "None") != "None")
                        # Validate dicts against ADetailerArgs to catch type mismatches early
                        for i, slot_dict in enumerate(ad_slot_dicts):
                            if slot_dict.get("ad_tab_enable") and slot_dict.get("ad_model", "None") != "None":
                                try:
                                    from adetailer.args import ADetailerArgs
                                    ADetailerArgs(**slot_dict)
                                except Exception as e:
                                    print(f"[Studio AD] WARNING: Slot {i+1} dict failed ADetailerArgs validation: {e}")
                        print(f"[Studio AD] Injected {active} active slot(s) into native ADetailer (args_from={idx})")
                        break
            else:
                # No AD params — suppress native AD to prevent it running with defaults
                for s in runner.alwayson_scripts:
                    if s.title() == "ADetailer":
                        idx = s.args_from
                        while len(script_args) < idx + 1:
                            script_args.append(None)
                        script_args[idx] = False
                        break

            # Extension bridge: override specific arg indices with values
            # from the frontend's auto-bridged extension controls.
            # Cast values to match the component type — hidden inputs and
            # JSON transport can coerce numbers/bools to strings.
            if extension_args:
                for idx_str, val in extension_args.items():
                    idx = int(idx_str)
                    if 0 <= idx < len(script_args):
                        script_args[idx] = _cast_arg(val, runner, idx)
                print(f"[Studio Bridge] Injected {len(extension_args)} extension arg(s)")

            p.script_args = tuple(script_args)
    except Exception as e:
        print(f"[Studio] Script runner attach failed: {e}")


def _build_processing_obj(canvas_img, gp, mask_img, has_mask, ip, studio_outdir, batch_seed, cn_units=None, extension_args=None, ad_params=None):
    """Build a configured StableDiffusionProcessingImg2Img.
    Always uses batch_size=1 — the outer loop handles multiple images
    so each gets fresh wildcard/dynamic prompt resolution."""
    p = StableDiffusionProcessingImg2Img(
        sd_model=shared.sd_model,
        outpath_samples=studio_outdir, outpath_grids=studio_outdir,
        prompt=gp.prompt, negative_prompt=gp.neg_prompt,
        init_images=[canvas_img], resize_mode=0,
        denoising_strength=gp.denoising,
        n_iter=1, batch_size=1,
        steps=gp.steps, cfg_scale=gp.cfg_scale,
        width=gp.width, height=gp.height,
        sampler_name=gp.sampler_name or "Euler a",
        seed=batch_seed,
        subseed=gp.subseed,
        subseed_strength=gp.subseed_strength,
        seed_resize_from_w=gp.seed_resize_from_w,
        seed_resize_from_h=gp.seed_resize_from_h,
        do_not_save_samples=True,
        do_not_save_grid=True,
    )

    if gp.schedule_type and gp.schedule_type != "Automatic" and hasattr(p, 'scheduler'):
        p.scheduler = gp.schedule_type
    p.sampler_name = gp.sampler_name or "Euler a"

    if has_mask and mask_img:
        p.image_mask = mask_img
        p.mask_blur = ip.mask_blur
        p.inpainting_fill = ip.inpainting_fill
        p.inpaint_full_res = ip.inpaint_full_res
        p.inpaint_full_res_padding = ip.inpaint_pad
        # Preserve originals for AD — process_images mutates these
        p._studio_inpaint_mask = mask_img
        p._studio_inpaint_full_res = ip.inpaint_full_res

    # Attach img2img script runner (wildcards, dynamic prompts, ControlNet, etc.)
    _attach_script_runner(p, has_mask=has_mask, ip=ip, cn_units=cn_units, extension_args=extension_args, ad_params=ad_params)

    # Re-assert after script attachment (scripts can override these)
    p.seed = batch_seed
    p.subseed = gp.subseed
    p.subseed_strength = gp.subseed_strength
    p.sampler_name = gp.sampler_name or "Euler a"
    if gp.schedule_type and gp.schedule_type != "Automatic" and hasattr(p, 'scheduler'):
        p.scheduler = gp.schedule_type
    p.steps = gp.steps
    p.cfg_scale = gp.cfg_scale

    return p


def _build_img2img_to_txt2img_remap():
    """Build index mapping from img2img script_args indices to txt2img indices.

    The extension bridge manifest is built from scripts_img2img, so all
    data-arg-index values in the frontend DOM are img2img indices. When
    generating in txt2img mode, we need to remap because built-in scripts
    have different input counts between img2img and txt2img (img2img has
    resize_mode, denoising, etc. that txt2img lacks), shifting all
    subsequent extension arg indices.
    """
    import modules.scripts as mod_scripts
    img_runner = mod_scripts.scripts_img2img
    txt_runner = mod_scripts.scripts_txt2img
    if not img_runner or not txt_runner:
        return {}

    remap = {}
    for img_script in img_runner.alwayson_scripts:
        try:
            img_title = img_script.title()
        except Exception:
            continue
        if not hasattr(img_script, 'args_from') or img_script.args_from is None:
            continue

        for txt_script in txt_runner.alwayson_scripts:
            try:
                txt_title = txt_script.title()
            except Exception:
                continue
            if txt_title != img_title:
                continue
            if not hasattr(txt_script, 'args_from') or txt_script.args_from is None:
                continue

            # Same script in both runners — map overlapping indices
            img_range = img_script.args_to - img_script.args_from
            txt_range = txt_script.args_to - txt_script.args_from
            for j in range(min(img_range, txt_range)):
                remap[img_script.args_from + j] = txt_script.args_from + j
            break

    return remap


def _attach_txt2img_script_runner(p, gp=None, cn_units=None, extension_args=None, ad_params=None):
    """Attach txt2img script runner for wildcards, dynamic prompts, ControlNet.

    extension_args: optional dict of {index: value} overrides from the
    extension bridge frontend. These arrive as img2img indices (the manifest
    is built from scripts_img2img) and must be remapped to txt2img indices.

    gp: GenParams — used to patch built-in Sampler script's width/height
    slots in script_args, since the stub defaults from boot time won't
    match the user's requested dimensions.
    """
    try:
        import modules.scripts as mod_scripts
        runner = mod_scripts.scripts_txt2img
        if runner and hasattr(runner, 'alwayson_scripts'):
            p.scripts = runner
            n_inputs = len(runner.inputs) if hasattr(runner, 'inputs') else 0
            script_args = [None] * n_inputs
            if hasattr(runner, 'inputs') and runner.inputs:
                for i, comp in enumerate(runner.inputs):
                    if comp is not None and hasattr(comp, 'value'):
                        script_args[i] = _cast_arg(comp.value, runner, i)
            if script_args:
                script_args[0] = 0

            # Force DP enabled — see _force_enable_dynamic_prompts() docstring.
            _force_enable_dynamic_prompts(runner, script_args)

            # Inject ControlNet units if provided
            if cn_units:
                for s in runner.alwayson_scripts:
                    if s.title() == "ControlNet":
                        args_from = s.args_from
                        args_to = s.args_to
                        n_slots = args_to - args_from
                        while len(script_args) < args_to:
                            script_args.append(None)
                        try:
                            from lib_controlnet.external_code import ControlNetUnit as CNU
                        except ImportError:
                            from studio_controlnet import _cn_external_code
                            CNU = _cn_external_code.ControlNetUnit if _cn_external_code else None
                        if CNU:
                            for i in range(n_slots):
                                if i < len(cn_units):
                                    script_args[args_from + i] = cn_units[i]
                                else:
                                    script_args[args_from + i] = CNU(enabled=False, module="None", model="None")
                            print(f"[Studio CN] Injected {len(cn_units)} txt2img unit(s) [{args_from}:{args_to}]")
                        break

            # Inject ADetailer parameters into native AD's script_args slots
            if ad_params:
                ad_enable, ad_slot_dicts = ad_params
                for s in runner.alwayson_scripts:
                    if s.title() == "ADetailer":
                        idx = s.args_from
                        n_needed = 2 + len(ad_slot_dicts)
                        while len(script_args) < idx + n_needed:
                            script_args.append(None)
                        script_args[idx] = ad_enable
                        script_args[idx + 1] = False
                        for i, slot_dict in enumerate(ad_slot_dicts):
                            script_args[idx + 2 + i] = slot_dict
                        active = sum(1 for d in ad_slot_dicts if d.get("ad_tab_enable") and d.get("ad_model", "None") != "None")
                        for i, slot_dict in enumerate(ad_slot_dicts):
                            if slot_dict.get("ad_tab_enable") and slot_dict.get("ad_model", "None") != "None":
                                try:
                                    from adetailer.args import ADetailerArgs
                                    ADetailerArgs(**slot_dict)
                                except Exception as e:
                                    print(f"[Studio AD] WARNING: txt2img slot {i+1} failed validation: {e}")
                        print(f"[Studio AD] Injected {active} active slot(s) into native ADetailer txt2img (args_from={idx})")
                        break
            else:
                for s in runner.alwayson_scripts:
                    if s.title() == "ADetailer":
                        idx = s.args_from
                        while len(script_args) < idx + 1:
                            script_args.append(None)
                        script_args[idx] = False
                        break

            # Extension bridge: remap img2img indices → txt2img indices
            if extension_args:
                remap = _build_img2img_to_txt2img_remap()
                injected = 0
                skipped = 0
                for idx_str, val in extension_args.items():
                    img_idx = int(idx_str)
                    txt_idx = remap.get(img_idx, -1)
                    if 0 <= txt_idx < len(script_args):
                        script_args[txt_idx] = _cast_arg(val, runner, txt_idx)
                        injected += 1
                    else:
                        skipped += 1
                print(f"[Studio Bridge] Injected {injected}/{len(extension_args)} txt2img extension arg(s) "
                      f"(remapped from img2img indices, {skipped} unmapped)")

            # Patch built-in scripts' width/height/steps/cfg slots.
            # Built-in scripts (Sampler, Seed, MaHiRo, etc.) read params from
            # script_args during process_batch() and write them to p, overriding
            # whatever we set on the processing object. The stub defaults are
            # baked at boot time and won't match the user's requested values.
            if gp:
                patched = []
                for s in runner.alwayson_scripts:
                    if not hasattr(s, 'args_from') or s.args_from is None:
                        continue
                    try:
                        title = s.title()
                    except Exception:
                        continue

                    title_lower = title.lower()

                    # Disable Moritz's AR selector — Studio has its own AR system.
                    # Without this, the AR script overrides p.width/p.height during
                    # process_batch() with stale stub defaults.
                    if "ar" in title_lower and ("moritz" in title_lower or "selector" in title_lower):
                        # First arg is typically the enable checkbox
                        if s.args_from < len(script_args):
                            script_args[s.args_from] = False
                            patched.append(f"disabled {title}@{s.args_from}")
                        continue

                    # Patch built-in scripts with .section set
                    if getattr(s, 'section', None) is None:
                        continue
                    for i in range(s.args_from, min(s.args_to, len(runner.inputs))):
                        comp = runner.inputs[i] if i < len(runner.inputs) else None
                        if comp is None:
                            continue
                        label = (getattr(comp, 'label', '') or '').lower().strip()
                        if label in ('width', 'w') and i < len(script_args):
                            script_args[i] = gp.width
                            patched.append(f"width={gp.width}@{i}({title})")
                        elif label in ('height', 'h') and i < len(script_args):
                            script_args[i] = gp.height
                            patched.append(f"height={gp.height}@{i}({title})")
                        elif label in ('steps', 'sampling steps') and i < len(script_args):
                            script_args[i] = gp.steps
                            patched.append(f"steps={gp.steps}@{i}({title})")
                        elif ('cfg' in label and 'rescale' not in label) and i < len(script_args):
                            script_args[i] = gp.cfg_scale
                            patched.append(f"cfg={gp.cfg_scale}@{i}({title})")
                if patched:
                    print(f"[Studio] Patched built-in script_args: {', '.join(patched)}")

            p.script_args = tuple(script_args)
    except Exception as e:
        print(f"[Studio] Txt2img script runner attach failed: {e}")


def _build_txt2img_obj(gp, studio_outdir, batch_seed, cn_units=None, extension_args=None, ad_params=None):
    """Build a configured StableDiffusionProcessingTxt2Img.
    No init_images, no mask, no denoising — pure text-to-image generation."""
    p = StableDiffusionProcessingTxt2Img(
        sd_model=shared.sd_model,
        outpath_samples=studio_outdir, outpath_grids=studio_outdir,
        prompt=gp.prompt, negative_prompt=gp.neg_prompt,
        n_iter=1, batch_size=1,
        steps=gp.steps, cfg_scale=gp.cfg_scale,
        width=gp.width, height=gp.height,
        sampler_name=gp.sampler_name or "Euler a",
        seed=batch_seed,
        subseed=gp.subseed,
        subseed_strength=gp.subseed_strength,
        seed_resize_from_w=gp.seed_resize_from_w,
        seed_resize_from_h=gp.seed_resize_from_h,
        do_not_save_samples=True,
        do_not_save_grid=True,
    )

    if gp.schedule_type and gp.schedule_type != "Automatic" and hasattr(p, 'scheduler'):
        p.scheduler = gp.schedule_type
    p.sampler_name = gp.sampler_name or "Euler a"

    # Attach txt2img script runner (wildcards, dynamic prompts, ControlNet)
    _attach_txt2img_script_runner(p, gp=gp, cn_units=cn_units, extension_args=extension_args, ad_params=ad_params)

    # Re-assert after script attachment
    p.seed = batch_seed
    p.subseed = gp.subseed
    p.subseed_strength = gp.subseed_strength
    p.sampler_name = gp.sampler_name or "Euler a"
    if gp.schedule_type and gp.schedule_type != "Automatic" and hasattr(p, 'scheduler'):
        p.scheduler = gp.schedule_type
    p.steps = gp.steps
    p.width = gp.width
    p.height = gp.height
    p.cfg_scale = gp.cfg_scale

    return p


# =========================================================================
# MAIN GENERATION — Coordinator
# =========================================================================

def _clip_to_mask(result, canvas_img, mask_img, ip):
    """Composite result onto original canvas using the inpaint mask.
    Clips any changes that leaked outside the masked area."""
    try:
        from PIL import ImageFilter
        orig = canvas_img.convert("RGB").resize(result.size, Image.LANCZOS)
        msk = mask_img.convert("L").resize(result.size, Image.LANCZOS)
        blur = getattr(ip, 'mask_blur', 4) if ip else 4
        if blur > 0:
            msk = msk.filter(ImageFilter.GaussianBlur(radius=blur))
        return Image.composite(result, orig, msk)
    except Exception as e:
        print(f"[Studio] Mask composite error: {e}")
        return result


def _run_attention_couple_image(
    is_txt2img, canvas_img, gp, mask_img, has_mask, ip,
    studio_outdir, batch_seed, hr, cn_units, extension_args,
    ad_params, regions_json, img_num, total_images,
):
    """Run a single attention couple generation.

    Returns (result_image, infotext) on success, or (None, None) on
    skip/error. Caller checks shared.state.interrupted after return.

    Mirrors the standard generation path exactly, with
    run_with_attention_couple() replacing process_images().
    """
    # ── Build processing object ─────────────────────────────────────
    if is_txt2img:
        p = _build_txt2img_obj(gp, studio_outdir, batch_seed, cn_units=cn_units,
                               extension_args=extension_args, ad_params=ad_params)
        # Built-in hires fix for txt2img (runs inside process_images)
        if hr.enable and hr.scale > 1.0:
            p.enable_hr = True
            p.hr_upscaler = hr.upscaler or "Latent"
            p.hr_scale = hr.scale
            p.hr_second_pass_steps = hr.steps if hr.steps > 0 else 0
            p.denoising_strength = hr.denoise
            p.hr_additional_modules = "Use same choices"
            p.hr_cfg_scale = hr.cfg if hr.cfg > 0 else gp.cfg_scale
            p.hr_cfg = hr.cfg if hr.cfg > 0 else gp.cfg_scale
            if hr.checkpoint and hr.checkpoint not in ("", "None", "Same"):
                p.hr_checkpoint_name = hr.checkpoint
            print(f"[Studio] Attention Couple txt2img with hires: {gp.width}x{gp.height} → "
                  f"{int(gp.width * hr.scale)}x{int(gp.height * hr.scale)}, "
                  f"upscaler={hr.upscaler}, denoise={hr.denoise}")
    else:
        p = _build_processing_obj(canvas_img, gp, mask_img, has_mask, ip,
                                   studio_outdir, batch_seed, cn_units=cn_units,
                                   extension_args=extension_args, ad_params=ad_params)

    print(f"[Studio] Attention Couple generating image {img_num+1}/{total_images}, "
          f"seed={batch_seed}, txt2img={is_txt2img}, enable_hr={getattr(p, 'enable_hr', False)}")

    # ── Suppress stock AD — Studio runs its own pipeline ────────────
    if _HAS_AD_LIBS and ad_params and ad_params[0]:
        p._ad_disabled = True

    # ── Attach region data for AD region-prompt matching ────────────
    if _HAS_ATTN_COUPLE:
        ac_regions = parse_regions(regions_json, gp.width, gp.height)
        if ac_regions:
            p._studio_regions = ac_regions

    # ── Generate ────────────────────────────────────────────────────
    try:
        processed = run_with_attention_couple(p, regions_json, gp.width, gp.height)
    except Exception as e:
        print(f"[Studio] Attention couple error: {e}")
        traceback.print_exc()
        if not getattr(p, '_studio_closed', False):
            p._studio_closed = True
            try: p.close()
            except Exception: pass
        return None, None

    # ── Interrupt / skip / empty ────────────────────────────────────
    if shared.state.interrupted:
        print("[Studio] Attention Couple generation interrupted")
        return None, None

    if shared.state.skipped:
        shared.state.skipped = False
        print("[Studio] Image skipped")
        return None, None

    if not processed or not processed.images:
        return None, None

    result = processed.images[0]

    # ── Post-process mask composite (img2img only) ──────────────────
    if has_mask and mask_img and canvas_img and not is_txt2img:
        result = _clip_to_mask(result, canvas_img, mask_img, ip)

    # ── Hires Fix for img2img only (txt2img uses built-in above) ────
    if not is_txt2img and hr.enable and hr.scale > 1.0:
        result = run_hires_fix(result, hr.upscaler, hr.scale,
                               hr.steps, hr.denoise, hr.cfg, p, hr.checkpoint)

    # ── Studio ADetailer ────────────────────────────────────────────
    if _HAS_AD_LIBS and ad_params and ad_params[0]:
        _ad_enable, _ad_slot_dicts = ad_params
        if _ad_enable and any(
            d.get("ad_tab_enable") and d.get("ad_model", "None") != "None"
            for d in _ad_slot_dicts
        ):
            result = _run_studio_ad(
                result, p, _ad_slot_dicts,
                mask_img=mask_img if has_mask else None,
            )
            # Post-AD mask composite
            if has_mask and mask_img and canvas_img and not is_txt2img:
                result = _clip_to_mask(result, canvas_img, mask_img, ip)

    # ── Infotext ────────────────────────────────────────────────────
    img_info = ""
    if hasattr(processed, 'infotexts') and processed.infotexts:
        img_info = processed.infotexts[0]
    elif processed.info:
        img_info = processed.info
    if not img_info:
        n_regions = len(parse_regions(regions_json, gp.width, gp.height) or [])
        img_info = f"Attention Couple ({n_regions} regions) | Seed: {batch_seed}"

    # NOTE: Do NOT call p.close() — process_images_inner() already calls it.
    return result, img_info


def run_generation(
    canvas_b64, mask_b64, fg_b64, mode, inpaint_mode, prompt, neg_prompt,
    steps, sampler_name, schedule_type, cfg_scale, denoising,
    width, height, seed, batch_count, batch_size,
    mask_blur, inpainting_fill, inpaint_full_res, inpaint_pad,
    soft_inpaint_enabled, soft_inpaint_schedule_bias, soft_inpaint_preservation,
    soft_inpaint_transition_contrast, soft_inpaint_mask_influence,
    soft_inpaint_diff_threshold, soft_inpaint_diff_contrast,
    hr_enable, hr_upscaler, hr_scale, hr_steps, hr_denoise, hr_cfg, hr_checkpoint,
    ad_enable,
    ad1_enable, ad1_model, ad1_confidence, ad1_mask_min, ad1_mask_max, ad1_topk_filter, ad1_topk,
    ad1_x_offset, ad1_y_offset, ad1_erosion_dilation, ad1_merge_mode,
    ad1_denoise, ad1_mask_blur, ad1_inpaint_pad, ad1_full_res, ad1_fill,
    ad1_sep_steps, ad1_steps, ad1_sep_cfg, ad1_cfg, ad1_sep_sampler, ad1_sampler, ad1_scheduler,
    ad1_prompt, ad1_neg_prompt,
    ad2_enable, ad2_model, ad2_confidence, ad2_mask_min, ad2_mask_max, ad2_topk_filter, ad2_topk,
    ad2_x_offset, ad2_y_offset, ad2_erosion_dilation, ad2_merge_mode,
    ad2_denoise, ad2_mask_blur, ad2_inpaint_pad, ad2_full_res, ad2_fill,
    ad2_sep_steps, ad2_steps, ad2_sep_cfg, ad2_cfg, ad2_sep_sampler, ad2_sampler, ad2_scheduler,
    ad2_prompt, ad2_neg_prompt,
    ad3_enable, ad3_model, ad3_confidence, ad3_mask_min, ad3_mask_max, ad3_topk_filter, ad3_topk,
    ad3_x_offset, ad3_y_offset, ad3_erosion_dilation, ad3_merge_mode,
    ad3_denoise, ad3_mask_blur, ad3_inpaint_pad, ad3_full_res, ad3_fill,
    ad3_sep_steps, ad3_steps, ad3_sep_cfg, ad3_cfg, ad3_sep_sampler, ad3_sampler, ad3_scheduler,
    ad3_prompt, ad3_neg_prompt,
    regions_json="",
    cn_json="",
    cn1_upload_img=None,
    cn2_upload_img=None,
    subseed=-1,
    subseed_strength=0,
    seed_resize_from_w=0,
    seed_resize_from_h=0,
    is_txt2img=False,
    extension_args=None,
    ar_config_dict=None,
):
    # === DEBUG: confirm function is being called ===
    print(f"[Studio] run_generation called: mode={repr(mode)}, inpaint_mode={repr(inpaint_mode)}, is_txt2img={is_txt2img}, regions_json_len={len(regions_json) if regions_json else 0}")
    # --- Unpack into structured params ---
    gp = GenParams(
        prompt=prompt, neg_prompt=neg_prompt, steps=int(steps),
        sampler_name=sampler_name or "Euler a", schedule_type=schedule_type or "Automatic",
        cfg_scale=float(cfg_scale), denoising=float(denoising),
        width=int(width), height=int(height), seed=int(seed),
        batch_count=max(1, int(batch_count)), batch_size=max(1, int(batch_size)),
        subseed=int(subseed), subseed_strength=float(subseed_strength),
        seed_resize_from_w=int(seed_resize_from_w), seed_resize_from_h=int(seed_resize_from_h),
    )
    ip = InpaintParams(
        mask_blur=int(mask_blur), inpainting_fill=int(inpainting_fill),
        inpaint_full_res=bool(inpaint_full_res), inpaint_pad=int(inpaint_pad),
        soft_inpaint_enabled=bool(soft_inpaint_enabled),
        soft_inpaint_schedule_bias=float(soft_inpaint_schedule_bias),
        soft_inpaint_preservation=float(soft_inpaint_preservation),
        soft_inpaint_transition_contrast=float(soft_inpaint_transition_contrast),
        soft_inpaint_mask_influence=float(soft_inpaint_mask_influence),
        soft_inpaint_diff_threshold=float(soft_inpaint_diff_threshold),
        soft_inpaint_diff_contrast=float(soft_inpaint_diff_contrast),
    )
    hr = HiresParams(
        enable=bool(hr_enable), upscaler=hr_upscaler or "Latent",
        scale=float(hr_scale), steps=int(hr_steps),
        denoise=float(hr_denoise), cfg=float(hr_cfg),
        checkpoint=hr_checkpoint or "",
    )

    # UX-018: AR Randomizer config (gated after blank canvas detection below)
    ar_config = None
    if _HAS_AR and ar_config_dict and isinstance(ar_config_dict, dict):
        ar_config = ARConfig(
            rand_base=bool(ar_config_dict.get("rand_base", False)),
            rand_ratio=bool(ar_config_dict.get("rand_ratio", False)),
            rand_orientation=bool(ar_config_dict.get("rand_orientation", False)),
            base_pool=ar_config_dict.get("base_pool", []),
            ratio_pool=ar_config_dict.get("ratio_pool", []),
        )

    # --- State reset & progress ---
    id_task = _reset_generation_state()
    _ensure_model_loaded()

    # --- Input validation ---
    canvas_img = None
    if is_txt2img:
        print("[Studio] Txt2img mode — skipping canvas decode")
    else:
        if not canvas_b64 or canvas_b64 in ("null", ""):
            finish_task(id_task)
            return [], "<p style='color:#f66;'>No canvas data.</p>", "", "", id_task

        try:
            canvas_img = to_rgb(decode_b64(canvas_b64))
        except Exception as e:
            finish_task(id_task)
            return [], f"<p>Canvas error: {e}</p>", "", "", id_task

        canvas_img = canvas_img.resize((gp.width, gp.height), Image.LANCZOS)

        # Auto-detect blank canvas → route to txt2img for Create mode.
        # This gives us Forge's built-in hires fix pipeline (base gen → upscale →
        # hires denoise → AD all inside one process_images call) instead of
        # img2img with denoise=1.0 on a white canvas, which is functionally
        # identical but misses the built-in hires + native AD timing benefits.
        # Skip if regions are active — attention couple needs the canvas img.
        _has_mask_data = mask_b64 and mask_b64 not in ("null", "")
        _has_region_data_early = regions_json and regions_json.strip() not in ("", "null", "[]")
        if mode == "Create" and not _has_mask_data and not _has_region_data_early:
            px = np.array(canvas_img)
            if px.min() > 248:
                is_txt2img = True
                canvas_img = None
                print("[Studio] Blank canvas detected in Create mode — auto-routing to txt2img")

    # Check for regions data early (before mask validation)
    _has_region_data = regions_json and regions_json.strip() not in ("", "null", "[]")

    if not is_txt2img and mode == "Edit" and (not mask_b64 or mask_b64 in ("null", "")) and not _has_region_data:
        finish_task(id_task)
        return [], "<p style='color:#fa0;'>No mask painted. Draw a mask before generating in Edit mode.</p>", "", "", id_task

    # Seed
    use_seed = gp.seed
    if use_seed == -1:
        use_seed = random.randint(0, 2**32 - 1)
        print(f"[Studio] Random seed: {use_seed}")

    # Mask — process in any mode if mask data is present
    mask_img, has_mask = (None, False)
    if mask_b64 and mask_b64 not in ("null", ""):
        mask_img, has_mask = _prepare_mask(mask_b64, gp.width, gp.height, inpaint_mode)

    # Output dir & native AD params
    studio_outdir = _get_output_dir(mode)
    ad_params = _build_native_ad_dicts(ad_enable, [
        {"enable": ad1_enable, "model": ad1_model, "confidence": ad1_confidence,
         "mask_min_ratio": ad1_mask_min, "mask_max_ratio": ad1_mask_max,
         "topk_filter": ad1_topk_filter, "topk": ad1_topk,
         "mask_x_offset": ad1_x_offset, "mask_y_offset": ad1_y_offset,
         "mask_erosion_dilation": ad1_erosion_dilation, "mask_merge_mode": ad1_merge_mode,
         "denoise": ad1_denoise, "mask_blur": ad1_mask_blur, "inpaint_pad": ad1_inpaint_pad,
         "inpaint_full_res": ad1_full_res, "inpaint_fill": ad1_fill,
         "use_sep_steps": ad1_sep_steps, "ad_steps": ad1_steps,
         "use_sep_cfg": ad1_sep_cfg, "ad_cfg": ad1_cfg,
         "use_sep_sampler": ad1_sep_sampler, "ad_sampler": ad1_sampler, "ad_scheduler": ad1_scheduler,
         "prompt": ad1_prompt, "neg_prompt": ad1_neg_prompt},
        {"enable": ad2_enable, "model": ad2_model, "confidence": ad2_confidence,
         "mask_min_ratio": ad2_mask_min, "mask_max_ratio": ad2_mask_max,
         "topk_filter": ad2_topk_filter, "topk": ad2_topk,
         "mask_x_offset": ad2_x_offset, "mask_y_offset": ad2_y_offset,
         "mask_erosion_dilation": ad2_erosion_dilation, "mask_merge_mode": ad2_merge_mode,
         "denoise": ad2_denoise, "mask_blur": ad2_mask_blur, "inpaint_pad": ad2_inpaint_pad,
         "inpaint_full_res": ad2_full_res, "inpaint_fill": ad2_fill,
         "use_sep_steps": ad2_sep_steps, "ad_steps": ad2_steps,
         "use_sep_cfg": ad2_sep_cfg, "ad_cfg": ad2_cfg,
         "use_sep_sampler": ad2_sep_sampler, "ad_sampler": ad2_sampler, "ad_scheduler": ad2_scheduler,
         "prompt": ad2_prompt, "neg_prompt": ad2_neg_prompt},
        {"enable": ad3_enable, "model": ad3_model, "confidence": ad3_confidence,
         "mask_min_ratio": ad3_mask_min, "mask_max_ratio": ad3_mask_max,
         "topk_filter": ad3_topk_filter, "topk": ad3_topk,
         "mask_x_offset": ad3_x_offset, "mask_y_offset": ad3_y_offset,
         "mask_erosion_dilation": ad3_erosion_dilation, "mask_merge_mode": ad3_merge_mode,
         "denoise": ad3_denoise, "mask_blur": ad3_mask_blur, "inpaint_pad": ad3_inpaint_pad,
         "inpaint_full_res": ad3_full_res, "inpaint_fill": ad3_fill,
         "use_sep_steps": ad3_sep_steps, "ad_steps": ad3_steps,
         "use_sep_cfg": ad3_sep_cfg, "ad_cfg": ad3_cfg,
         "use_sep_sampler": ad3_sep_sampler, "ad_sampler": ad3_sampler, "ad_scheduler": ad3_scheduler,
         "prompt": ad3_prompt, "neg_prompt": ad3_neg_prompt},
    ])

    # --- ControlNet units ---
    cn_units = []
    if cn_json and cn_json.strip() not in ("", "null", "[]"):
        try:
            cn_settings = json.loads(cn_json)
            if isinstance(cn_settings, list) and cn_settings:
                canvas_np = np.array(canvas_img)
                upload_images = {}
                if cn1_upload_img is not None:
                    upload_images[0] = cn1_upload_img
                if cn2_upload_img is not None:
                    upload_images[1] = cn2_upload_img
                cn_units = build_cn_units(cn_settings, canvas_np=canvas_np,
                                          upload_images=upload_images)
                if cn_units:
                    print(f"[Studio CN] Built {len(cn_units)} ControlNet unit(s)")
        except Exception as e:
            print(f"[Studio CN] Error parsing cn_json: {e}")

    # --- Batch loop ---
    # v3.1: Flatten batch_count × batch_size into a single loop so each image
    # gets its own process_images() call with fresh wildcard/dynamic prompt resolution.
    all_images, all_infotexts, settings_json = [], [], ""
    total_images = gp.batch_count * max(1, gp.batch_size)
    shared.state.job_count = total_images
    shared.state.job_no = 0

    # v3.1: Detect Regional mode — require BOTH region data AND Regional inpaint mode selected
    has_regions = has_valid_regions(regions_json)
    is_regional_mode = has_regions and mode == "Edit" and inpaint_mode == "Regional"
    if not has_regions and inpaint_mode == "Regional":
        print(f"[Studio] WARNING: Regional mode but no region data received!")
        is_regional_mode = False
    if has_regions and mode == "Edit" and inpaint_mode != "Regional":
        print(f"[Studio] Region data present but inpaint_mode={repr(inpaint_mode)}, ignoring regions")

    # v4: Attention Couple — single-pass regional for Create mode (and Edit without Regional inpaint)
    is_attention_couple = False
    if _HAS_ATTN_COUPLE and has_attention_regions(regions_json) and not is_regional_mode:
        is_attention_couple = True
        print(f"[Studio] Attention Couple mode — single-pass regional prompting")

    print(f"[Studio] mode={repr(mode)}, is_txt2img={is_txt2img}, "
          f"inpaint_mode={repr(inpaint_mode) if not is_txt2img else 'N/A'}, "
          f"regions={len(regions_json) if regions_json else 0}, "
          f"regional={is_regional_mode}, attn_couple={is_attention_couple}")

    # UX-018: Disable AR randomization when not txt2img or when regions are active
    if ar_config and ar_config.any_active:
        if not is_txt2img:
            print("[Studio AR] Not txt2img — disabling randomization")
            ar_config = None
        elif is_regional_mode or is_attention_couple:
            print("[Studio AR] Regions active — disabling randomization")
            ar_config = None

    # ── Suppress conflicting extensions ──────────────────────
    # The standalone AR Selector has no enable toggle — it ALWAYS overrides
    # p.width/p.height in before_process/before_process_batch.  Boolean arg
    # suppression doesn't work (it just forces a fixed ratio instead of
    # disabling).  We must temporarily remove it from the script runner.
    _removed_scripts = []
    _suppress_titles = {"moritz's ar selector"}
    try:
        import modules.scripts as _mod_scripts
        for runner in [_mod_scripts.scripts_txt2img, _mod_scripts.scripts_img2img]:
            if not runner:
                continue
            to_remove = []
            for script in runner.alwayson_scripts:
                try:
                    title = script.title().strip().lower() if callable(getattr(script, 'title', None)) else ""
                except Exception:
                    title = ""
                if title in _suppress_titles:
                    to_remove.append((runner, script))
            for r, s in to_remove:
                r.alwayson_scripts.remove(s)
                _removed_scripts.append((r, s))
                print(f"[Studio] Temporarily removed conflicting script: {s.title()}")
    except Exception as e:
        print(f"[Studio] Script removal warning: {e}")

    try:
        for img_num in range(total_images):
            shared.state.job_no = img_num
            if shared.state.interrupted:
                print("[Studio] Generation interrupted between images")
                if all_images: break
                finish_task(id_task)
                return [], "<p style='color:#fa0;'>Generation interrupted.</p>", "", "", id_task

            shared.state.skipped = False
            batch_seed = use_seed + img_num

            if is_regional_mode:
                # Regional Edit mode: multi-pass per-region inpainting
                print(f"[Studio] Regional Edit mode — running multi-pass inpainting...")
                result, region_results = run_regional(canvas_img, regions_json, gp, ip, studio_outdir)

                if shared.state.interrupted:
                    print("[Studio] Regional generation interrupted")
                    if all_images: break
                    finish_task(id_task)
                    return [], "<p style='color:#fa0;'>Generation interrupted.</p>", "", "", id_task

                if shared.state.skipped:
                    shared.state.skipped = False
                    print("[Studio] Image skipped")
                    continue

                # Native ADetailer fires inside process_images() via postprocess_image hook.
                # For regional mode, we don't call process_images() directly (run_regional
                # handles its own per-region passes), so AD won't fire automatically here.
                # This is acceptable — regional mode has its own per-region inpainting.
                all_images.append(result)
                region_info = f"Regional inpainting | Seed: {batch_seed}"
                all_infotexts.append(region_info)

            elif is_attention_couple:
                # Attention Couple: single-pass regional prompting (Create + Edit)
                result, img_info = _run_attention_couple_image(
                    is_txt2img, canvas_img, gp, mask_img, has_mask, ip,
                    studio_outdir, batch_seed, hr, cn_units, extension_args,
                    ad_params, regions_json, img_num, total_images,
                )

                if result is None:
                    if shared.state.interrupted:
                        if all_images: break
                        finish_task(id_task)
                        return [], "<p style='color:#fa0;'>Generation interrupted.</p>", "", "", id_task
                    continue

                all_images.append(result)
                all_infotexts.append(img_info)

            else:
                # Standard generation flow (Create, Inpaint, Inpaint Sketch, Txt2Img)
                # Native ADetailer fires inside process_images() via postprocess_image hook.
                if is_txt2img:
                    # UX-018: Per-image AR randomization (txt2img only, no regions)
                    if ar_config and ar_config.any_active:
                        new_w, new_h, ar_info = randomize_dimensions(
                            gp.width, gp.height, ar_config)
                        gp.width, gp.height = new_w, new_h

                    p = _build_txt2img_obj(gp, studio_outdir, batch_seed, cn_units=cn_units,
                                           extension_args=extension_args, ad_params=ad_params)

                    # Use Forge's built-in hires fix for txt2img so that:
                    # 1. Base gen → upscale → hires denoise all happen inside one process_images()
                    # 2. Native AD fires AFTER hires on the full-res result
                    if hr.enable and hr.scale > 1.0:
                        p.enable_hr = True
                        p.hr_upscaler = hr.upscaler or "Latent"
                        p.hr_scale = hr.scale
                        p.hr_second_pass_steps = hr.steps if hr.steps > 0 else 0
                        p.denoising_strength = hr.denoise
                        p.hr_additional_modules = "Use same choices"
                        p.hr_cfg_scale = hr.cfg if hr.cfg > 0 else gp.cfg_scale
                        p.hr_cfg = hr.cfg if hr.cfg > 0 else gp.cfg_scale
                        if hr.checkpoint and hr.checkpoint not in ("", "None", "Same"):
                            p.hr_checkpoint_name = hr.checkpoint
                        print(f"[Studio] Txt2img with built-in hires fix: {gp.width}x{gp.height} → "
                              f"{int(gp.width * hr.scale)}x{int(gp.height * hr.scale)}, "
                              f"upscaler={hr.upscaler}, denoise={hr.denoise}")

                    print(f"[Studio] Txt2img generating image {img_num+1}/{total_images}: "
                          f"sampler={p.sampler_name}, scheduler={getattr(p, 'scheduler', 'N/A')}, "
                          f"steps={p.steps}, cfg={p.cfg_scale}, seed={batch_seed}, enable_hr={getattr(p, 'enable_hr', False)}")
                else:
                    p = _build_processing_obj(canvas_img, gp, mask_img, has_mask, ip, studio_outdir,
                                              batch_seed, cn_units=cn_units, extension_args=extension_args,
                                              ad_params=ad_params)
                    print(f"[Studio] Generating image {img_num+1}/{total_images}: "
                          f"sampler={p.sampler_name}, scheduler={getattr(p, 'scheduler', 'N/A')}, "
                          f"steps={p.steps}, cfg={p.cfg_scale}, seed={batch_seed}")

                try:
                    # Suppress stock ADetailer — Studio runs its own AD pipeline
                    # with centroid-based mask filtering after hires fix.
                    if _HAS_AD_LIBS and ad_params and ad_params[0]:
                        p._ad_disabled = True
                    processed = process_images(p)
                except Exception as e:
                    print(f"[Studio] process_images error: {e}")
                    traceback.print_exc()
                    # p.close() may already have been called by Forge's finally block;
                    # guard with attribute to avoid double-close corrupting weakrefs.
                    if not getattr(p, '_studio_closed', False):
                        p._studio_closed = True
                        try: p.close()
                        except Exception: pass
                    continue

                if shared.state.interrupted:
                    print("[Studio] Generation interrupted")
                    if not getattr(p, '_studio_closed', False):
                        p._studio_closed = True
                        try: p.close()
                        except Exception: pass
                    if all_images: break
                    finish_task(id_task)
                    return [], "<p style='color:#fa0;'>Generation interrupted.</p>", "", "", id_task

                if shared.state.skipped:
                    shared.state.skipped = False
                    if not getattr(p, '_studio_closed', False):
                        p._studio_closed = True
                        try: p.close()
                        except Exception: pass
                    continue

                if not processed or not processed.images:
                    if not getattr(p, '_studio_closed', False):
                        p._studio_closed = True
                        try: p.close()
                        except Exception: pass
                    continue

                result = processed.images[0]

                # ── Post-process mask composite ─────────────────────────
                # Clips any changes from non-AD postprocess callbacks that
                # leaked outside the inpaint mask.
                if has_mask and mask_img and canvas_img and not is_txt2img:
                    try:
                        from PIL import ImageFilter
                        _orig = canvas_img.convert("RGB").resize(result.size, Image.LANCZOS)
                        _msk = mask_img.convert("L").resize(result.size, Image.LANCZOS)
                        _blur = getattr(ip, 'mask_blur', 4) if ip else 4
                        if _blur > 0:
                            _msk = _msk.filter(ImageFilter.GaussianBlur(radius=_blur))
                        result = Image.composite(result, _orig, _msk)
                    except Exception as _ce:
                        print(f"[Studio] Post-process mask composite error: {_ce}")

                # Hires Fix for img2img only — txt2img uses built-in enable_hr above.
                if not is_txt2img and hr.enable and hr.scale > 1.0:
                    result = run_hires_fix(result, hr.upscaler, hr.scale,
                                          hr.steps, hr.denoise, hr.cfg, p, hr.checkpoint)

                # ── Studio ADetailer ────────────────────────────────────
                # Runs AFTER hires fix so faces are refined at full
                # resolution. Uses centroid filtering to skip detections
                # outside the inpaint mask. Stock AD was suppressed above.
                if _HAS_AD_LIBS and ad_params and ad_params[0]:
                    _ad_enable, _ad_slot_dicts = ad_params
                    if _ad_enable and any(
                        d.get("ad_tab_enable") and d.get("ad_model", "None") != "None"
                        for d in _ad_slot_dicts
                    ):
                        result = _run_studio_ad(
                            result, p, _ad_slot_dicts,
                            mask_img=mask_img if has_mask else None,
                        )
                        # Final mask composite — clips any AD overshoot
                        if has_mask and mask_img and canvas_img and not is_txt2img:
                            try:
                                from PIL import ImageFilter
                                _orig2 = canvas_img.convert("RGB").resize(result.size, Image.LANCZOS)
                                _msk2 = mask_img.convert("L").resize(result.size, Image.LANCZOS)
                                _blur2 = getattr(ip, 'mask_blur', 4) if ip else 4
                                if _blur2 > 0:
                                    _msk2 = _msk2.filter(ImageFilter.GaussianBlur(radius=_blur2))
                                result = Image.composite(result, _orig2, _msk2)
                            except Exception as _ce2:
                                print(f"[Studio] Post-AD mask composite error: {_ce2}")

                all_images.append(result)

                # Collect per-image info text (resolved prompt, seed, etc.)
                img_info = ""
                if hasattr(processed, 'infotexts') and processed.infotexts:
                    img_info = processed.infotexts[0]
                elif processed.info:
                    img_info = processed.info
                if not img_info:
                    rp = p.all_prompts[0] if hasattr(p, 'all_prompts') and p.all_prompts else p.prompt
                    rn = p.all_negative_prompts[0] if hasattr(p, 'all_negative_prompts') and p.all_negative_prompts else p.negative_prompt
                    img_info = (
                        f"{rp}\n"
                        f"Negative prompt: {rn}\n"
                        f"Steps: {p.steps}, Sampler: {p.sampler_name}, "
                        f"Schedule type: {getattr(p, 'scheduler', 'N/A')}, "
                        f"CFG scale: {p.cfg_scale}, Seed: {p.seed}, "
                        f"Size: {gp.width}x{gp.height}, "
                        f"Denoising strength: {gp.denoising}"
                    )
                all_infotexts.append(img_info)

                # NOTE: Do NOT call p.close() here — Forge's process_images_inner()
                # already calls it.  Double-closing corrupts LoadedModel weakrefs in
                # memory_management, bricking generation until restart.

    except Exception as e:
        traceback.print_exc()
        finish_task(id_task)
        return [], f"<p style='color:#f66;'>Error: {e}</p>", "", "", id_task
    finally:
        # Restore any scripts we temporarily removed
        for runner, script in _removed_scripts:
            if script not in runner.alwayson_scripts:
                runner.alwayson_scripts.append(script)
        if _removed_scripts:
            print(f"[Studio] Restored {len(_removed_scripts)} suppressed script(s)")

    finish_task(id_task)

    # Build settings_json AFTER the loop so ALL per-image infotexts are included
    if all_images:
        first_seed = use_seed
        first_prompt = gp.prompt
        first_neg = gp.neg_prompt

        settings_json = json.dumps({
            "prompt": first_prompt, "neg_prompt": first_neg,
            "sampler": gp.sampler_name, "scheduler": gp.schedule_type,
            "steps": gp.steps, "cfg": gp.cfg_scale, "denoising": gp.denoising,
            "width": gp.width, "height": gp.height,
            "seed": first_seed,
            "infotexts": all_infotexts,
        })
        print(f"[Studio] Built settings_json: seed={first_seed}, {len(all_infotexts)} infotexts for {len(all_images)} images")

        display_info = all_infotexts[0] if all_infotexts else "Done."
        return (all_images,
            f"<div class='studio-info-text'><pre>{display_info}</pre></div>",
            "",  # result_b64 — unused by API endpoint, skip expensive PNG encode
            settings_json,
            id_task)
    return [], "<p>No images generated.</p>", "", "", id_task


# =========================================================================
# API ENDPOINT
# =========================================================================

# Standalone UI routes — registers all /studio/* endpoints onto Forge's FastAPI app.
# Falls back to the minimal task_id-only endpoint if studio_api.py isn't present.
try:
    try:
        from scripts.studio_api import add_studio_api
    except ImportError:
        from studio_api import add_studio_api
except ImportError:
    # studio_api.py not installed — keep the original minimal endpoint
    def add_studio_api(demo, app):
        """Fallback: just the task_id endpoint for Gradio progress polling."""
        from starlette.responses import JSONResponse

        @app.get("/studio/task_id")
        async def studio_task_id():
            return JSONResponse({"task_id": get_studio_task_id()})
