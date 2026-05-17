"""
Forge Studio — AutoDetailer Module

Studio-controlled face/object detail pipeline. Extracted from
studio_generation.py to give AD a dedicated home so a future native
backend can be slotted in alongside the existing extension-backed path
without rewriting the generation core.

This module preserves the current behavior exactly. It still borrows
ADetailer internals (ultralytics_predict, mask helpers) when the
extension is installed — that path is the "studio_compat" backend in
the migration plan. A future PR will introduce native detection and
native mask processing while keeping the extension path as a
compatibility fallback.

Compatibility contract:
- If the ADetailer extension is missing, Studio still starts.
- If AD is disabled, no backend runs.
- Exactly one AD backend may process a given generation.
"""

import os
import platform
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
from PIL import Image

from modules import shared
from modules.processing import StableDiffusionProcessingImg2Img, process_images


# =========================================================================
# ADetailer extension detection
# =========================================================================
#
# The current "studio_compat" path borrows detection + mask helpers from
# the installed ADetailer extension. Failing to import these is non-fatal
# — Studio simply has no working AD backend in that case and skips AD.

_HAS_AD_LIBS = False
try:
    from adetailer import ultralytics_predict, get_models as ad_get_models
    from adetailer.common import PredictOutput, ensure_pil_image
    from adetailer.mask import mask_preprocess, filter_by_ratio, filter_k_by, sort_bboxes, is_all_black
    _HAS_AD_LIBS = True
except ImportError:
    ultralytics_predict = None
    ad_get_models = None
    PredictOutput = None
    ensure_pil_image = None
    mask_preprocess = None
    filter_by_ratio = None
    filter_k_by = None
    sort_bboxes = None
    is_all_black = None


# =========================================================================
# Backend selection (stubs for PR 2 — preserve current behavior for PR 1)
# =========================================================================

@dataclass
class ADetailerBackendStatus:
    """Snapshot of which AD backend is active for a given request."""
    requested: str = "auto"
    active: str = "none"
    extension_available: bool = False
    studio_native_available: bool = False
    models_found: int = 0
    warning: str = ""


def resolve_ad_backend(requested: str = "auto") -> ADetailerBackendStatus:
    """Decide which AD backend should run.

    For PR 1 this is a stub that preserves current behavior: if the
    ADetailer extension is importable, the "studio_compat" path runs
    (Studio's own loop borrowing ADetailer internals). Otherwise AD is
    skipped.

    Future PRs will branch this on requested ∈ {auto, extension,
    studio_compat, studio_native, none} and consult a real native
    backend readiness flag.
    """
    ext_avail = _HAS_AD_LIBS
    # PR 1: no real native backend exists yet.
    native_avail = False
    models_found = len(get_ad_model_mapping()) if ext_avail else 0

    if requested == "none":
        return ADetailerBackendStatus(
            requested=requested, active="none",
            extension_available=ext_avail,
            studio_native_available=native_avail,
            models_found=models_found,
        )

    # PR 1 preserves the current production path: when AD libs are
    # importable, Studio's own loop runs ("studio_compat"). Falls back
    # to "none" otherwise.
    if ext_avail:
        return ADetailerBackendStatus(
            requested=requested, active="studio_compat",
            extension_available=True,
            studio_native_available=native_avail,
            models_found=models_found,
        )

    return ADetailerBackendStatus(
        requested=requested, active="none",
        extension_available=False,
        studio_native_available=native_avail,
        models_found=0,
        warning="ADetailer extension unavailable and no native backend yet",
    )


def get_adetailer_status() -> dict:
    """Diagnostics dict suitable for a future /studio/adetailer/status
    endpoint. Returns counts and backend names — never paths.
    """
    status = resolve_ad_backend("auto")
    return {
        "extension_available": status.extension_available,
        "studio_native_available": status.studio_native_available,
        "active_backend": status.active,
        "models_found": status.models_found,
        "warning": status.warning,
    }


# =========================================================================
# Model discovery — UI dropdown
# =========================================================================
#
# Populates the ADetailer model dropdown. Scans <models>/adetailer/.
# Cached at module level after the first successful call.

_ad_ui_model_mapping: Optional[dict] = None


def get_ad_models_for_ui_mapping() -> dict:
    """Model name → path mapping for the dropdown. Cached.

    Uses shared.models_path/adetailer/ only. Returns {} if the ADetailer
    extension is missing or the helper fails — the UI then shows just
    "None".
    """
    global _ad_ui_model_mapping
    if _ad_ui_model_mapping is not None:
        return _ad_ui_model_mapping
    try:
        if ad_get_models is None:
            _ad_ui_model_mapping = {}
            return _ad_ui_model_mapping
        model_dir = os.path.join(getattr(shared, 'models_path', 'models'), 'adetailer')
        os.makedirs(model_dir, exist_ok=True)
        _ad_ui_model_mapping = ad_get_models(model_dir)
        print(f"[Studio AD] Found {len(_ad_ui_model_mapping)} models")
        return _ad_ui_model_mapping
    except Exception as e:
        print(f"[Studio AD] Could not load model list: {e}")
        return {}


def get_ad_models() -> list:
    """List of model names for the UI dropdown, prefixed with 'None'."""
    mapping = get_ad_models_for_ui_mapping()
    return ["None"] + list(mapping.keys())


# =========================================================================
# Model discovery — runtime detection
# =========================================================================
#
# Used during generation to map slot's model name to a path that
# ultralytics_predict can load. Richer than the UI mapping: respects
# ad_extra_models_dir option and asks ADetailer to include HuggingFace
# entries. Cached.

_ad_runtime_model_mapping: Optional[dict] = None


def get_ad_model_mapping() -> dict:
    """Get AD model name → path mapping for runtime detection. Cached.

    Honors `ad_extra_models_dir` and includes HuggingFace models when
    the ADetailer extension supports them. Returns {} when AD libs are
    missing.
    """
    global _ad_runtime_model_mapping
    if not _HAS_AD_LIBS:
        return {}
    if _ad_runtime_model_mapping is not None:
        return _ad_runtime_model_mapping
    try:
        from modules import paths
        ad_dir = Path(paths.models_path, "adetailer")
        extra = shared.opts.data.get("ad_extra_models_dir", "")
        _ad_runtime_model_mapping = ad_get_models(
            ad_dir, *extra.split("|"), huggingface=True
        )
        return _ad_runtime_model_mapping
    except Exception as e:
        print(f"[Studio AD] Runtime model mapping error: {e}")
        return {}


def _get_ad_device() -> str:
    """Determine device for YOLO inference.

    CPU when:
        - user passed --use-cpu adetailer
        - Forge is in lowvram / medvram modes (we don't want to compete
          for VRAM with the diffusion model)
    Default device otherwise. macOS returns "" (let ultralytics choose).
    """
    if hasattr(shared.cmd_opts, 'use_cpu') and "adetailer" in getattr(shared.cmd_opts, 'use_cpu', []):
        return "cpu"
    if platform.system() == "Darwin":
        return ""
    for arg in ("lowvram", "medvram", "medvram_sdxl"):
        if getattr(shared.cmd_opts, arg, False):
            return "cpu"
    return ""


# =========================================================================
# Slot dict builder
# =========================================================================

def build_ad_slot_dicts(ad_enable, ad_raw_slots):
    """Build native ADetailer-compatible slot dicts from Studio's
    frontend params.

    Returns ``(enable_bool, list_of_slot_dicts)`` ready for injection
    into native AD's script_args slots or for consumption by
    ``run_studio_autodetailer``.
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
# Region matching — Attention Couple integration
# =========================================================================

def _match_detection_to_region(bbox, regions, image_size):
    """Match a detection bbox to the best-overlapping Attention Couple
    region.

    Each detection's bounding box is compared against painted region
    masks by overlap ratio. The region with the highest overlap (above
    10%) wins.

    Returns ``(prompt, neg_prompt)`` or ``(None, None)`` if no match.
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
        # Prefer ad_prompt (character-only, post-wildcard) for face
        # inpainting. Falls back to full region prompt if ad_prompt
        # not set.
        prompt = best_region.get("ad_prompt", best_region.get("prompt", ""))
        neg = best_region.get("ad_neg_prompt", best_region.get("neg_prompt", ""))
        return prompt, neg

    return None, None


# =========================================================================
# Studio AD pipeline
# =========================================================================

def run_studio_autodetailer(result_img, p, ad_slots, mask_img=None, capture_blend_mask=False):
    """Run Studio's own ADetailer pipeline on the result image.

    Parameters
    ----------
    result_img : PIL.Image
        The generated image (post-hires if applicable).
    p : processing object
        The original processing object (for seed, prompt, settings).
    ad_slots : list[dict]
        Slot dicts from ``build_ad_slot_dicts``.
    mask_img : PIL.Image or None
        The user's inpaint mask (for centroid filtering).
    capture_blend_mask : bool
        When True, accumulate a per-pixel blend mask describing which
        pixels AD actually painted (post-feather). Used by High
        Precision to composite the AD result over the pre-AD float
        buffer at Develop load time. White = AD touched (use canvas),
        black = untouched (use float). Returns
        ``(image, blend_mask_or_None)``. When False, returns ``image``
        only — backward-compat for older callers.

    Returns
    -------
    PIL.Image, or (PIL.Image, np.ndarray|None) when ``capture_blend_mask``
    is True.
    """
    if not _HAS_AD_LIBS:
        return (result_img, None) if capture_blend_mask else result_img

    model_map = get_ad_model_mapping()
    if not model_map:
        return (result_img, None) if capture_blend_mask else result_img

    device = _get_ad_device()
    image = ensure_pil_image(result_img, "RGB")
    processed_any = False

    # High Precision: accumulator at the AD input resolution. Each
    # detection's blurred mask is OR'd in (np.maximum) so overlapping
    # detections don't over-count. Lazily initialized — None if no
    # detection ever fires, in which case there's no point in a sidecar.
    blend_acc = None
    if capture_blend_mask:
        _w0, _h0 = image.size
        blend_acc = np.zeros((_h0, _w0), dtype=np.float32)

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
        # Use resolved prompts (post-wildcard, post-dynamic-prompts)
        # from the main generation pass. p.prompt is raw text with
        # __wildcards__ still in it. p.all_prompts[0] is what actually
        # generated the image.
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
                    # High Precision: contribute this detection's
                    # blurred mask to the global blend accumulator. The
                    # Gaussian blur radius matches the slot's mask_blur
                    # so the captured mask describes the same soft alpha
                    # that Forge's inpainting actually painted with.
                    if blend_acc is not None:
                        try:
                            from PIL import ImageFilter
                            dm_pil = ensure_pil_image(dm, "L")
                            if dm_pil.size != (blend_acc.shape[1], blend_acc.shape[0]):
                                dm_pil = dm_pil.resize(
                                    (blend_acc.shape[1], blend_acc.shape[0]),
                                    Image.LANCZOS,
                                )
                            if mask_blur > 0:
                                dm_pil = dm_pil.filter(ImageFilter.GaussianBlur(radius=mask_blur))
                            dm_arr = np.asarray(dm_pil, dtype=np.float32) / 255.0
                            np.maximum(blend_acc, dm_arr, out=blend_acc)
                        except Exception as _me:
                            print(f"[Studio AD] Mask accumulation error slot {slot_idx+1} det {j+1}: {_me}")
            except Exception as e:
                print(f"[Studio AD] Inpaint error slot {slot_idx+1} det {j+1}: {e}")
                traceback.print_exc()
            finally:
                try: i2i.close()
                except Exception: pass

        image = current_img

    if processed_any:
        print(f"[Studio AD] Pipeline complete")
    if capture_blend_mask:
        # If nothing was actually processed, no mask is meaningful — let
        # caller treat this as a regular HP capture (no sidecar).
        return image, (blend_acc if processed_any else None)
    return image


# =========================================================================
# Backwards-compatible aliases
# =========================================================================
#
# Older studio_generation.py / studio_api.py call sites refer to the
# private underscore-prefixed names. Keep them callable to avoid a
# refactor cascade in PR 1.

_build_native_ad_dicts = build_ad_slot_dicts
_run_studio_ad = run_studio_autodetailer
_get_ad_model_mapping = get_ad_model_mapping
