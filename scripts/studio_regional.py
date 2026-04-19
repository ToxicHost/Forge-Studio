"""
Forge Studio — Regional Prompting & Inpainting Module
=====================================================
Multi-pass per-region inpainting for Edit mode.

Architecture:
  - MULTI-PASS REGIONAL (Edit mode): Each region runs its own independent
    img2img pass from the same base image, then results are composited.
    Each region gets its own prompt, denoising strength, and mask. The global
    prompt from the main prompt box is prepended to every region's prompt as
    a style/scene foundation.

  - PER-REGION ADETAILER: After generation, runs ADetailer once per region
    using that region's prompt so face/hand fixes match character descriptions.

Inspired by sd-webui-regional-prompter's latent compositing approach,
adapted for Forge Neo's API and Studio's painted region masks.
"""

import json
import math
import traceback
import numpy as np
from PIL import Image

from modules import shared
from modules.processing import StableDiffusionProcessingImg2Img, process_images


# =========================================================================
# LOGGING
# =========================================================================

TAG = "[Studio Regional]"

def _log(msg):
    print(f"{TAG} {msg}")

def _warn(msg):
    print(f"{TAG} WARNING: {msg}")


# =========================================================================
# HELPERS
# =========================================================================

def _decode_b64(b64_str):
    """Decode a base64 PNG/JPEG string to PIL Image."""
    import base64, io
    if not b64_str:
        return None
    if "," in b64_str:
        b64_str = b64_str.split(",", 1)[1]
    try:
        return Image.open(io.BytesIO(base64.b64decode(b64_str)))
    except Exception:
        return None


def _attach_script_runner(p, has_mask=False, ip=None):
    """Attach img2img script runner for wildcards, dynamic prompts, etc."""
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
                        script_args[i] = comp.value
            if script_args:
                script_args[0] = 0

            if has_mask and ip and hasattr(ip, 'soft_inpaint_enabled') and ip.soft_inpaint_enabled:
                for s in runner.alwayson_scripts:
                    if s.title() == "Soft Inpainting":
                        idx = s.args_from
                        if idx < len(script_args):
                            script_args[idx] = True
                            if idx + 1 < len(script_args): script_args[idx + 1] = ip.soft_inpaint_power
                            if idx + 2 < len(script_args): script_args[idx + 2] = ip.soft_inpaint_scale
                            if idx + 3 < len(script_args): script_args[idx + 3] = ip.soft_inpaint_detail
                        break

            p.script_args = tuple(script_args)
    except Exception as e:
        _warn(f"Script runner attach failed: {e}")


def _parse_regions_json(regions_json):
    """Parse region data from JSON. Supports both old (list) and new (dict) formats.
    Returns (regions_list, shared_context_str) or (None, None) on failure."""
    try:
        raw = json.loads(regions_json)
    except Exception:
        return None, None

    if isinstance(raw, list):
        return raw, ""
    elif isinstance(raw, dict):
        return raw.get("regions", []), raw.get("sharedContext", "").strip()
    return None, None


def has_valid_regions(regions_json):
    """Check if regions_json contains at least one region with data."""
    if not regions_json or regions_json.strip() in ("", "null", "[]", "{}"):
        return False
    regions, _ = _parse_regions_json(regions_json)
    return regions is not None and len(regions) > 0


# =========================================================================
# MULTI-PASS REGIONAL (Edit mode)
# =========================================================================# =========================================================================
# MULTI-PASS REGIONAL (Edit mode)
# =========================================================================

def run_regional(canvas_img, regions_json, gp, ip, studio_outdir):
    """
    Multi-pass per-region inpainting (Edit mode). Each region runs from the
    SAME base image independently, then results are composited.

    The global prompt (main prompt box) is automatically prepended to each
    region's prompt as scene/style context, separated by a comma. Regions
    only need character- or area-specific content.

    Returns (final_image, region_results) for per-region ADetailer.
    """
    regions, shared_context = _parse_regions_json(regions_json)
    if not regions:
        return canvas_img, []

    base_img = canvas_img.copy()
    img_w, img_h = base_img.size
    region_results = []

    for idx, region in enumerate(regions):
        region_prompt = region.get("prompt", "").strip()
        if not region_prompt:
            continue

        # Prepend global prompt as scene/style context
        global_prompt = gp.prompt.strip() if gp.prompt else ""
        if global_prompt:
            # Ensure comma separator between global and region prompts
            sep = ", " if not global_prompt.endswith(",") else " "
            region_prompt = global_prompt + sep + region_prompt

        mask_b64 = region.get("mask_b64", "")
        if not mask_b64:
            continue

        try:
            mask_img = _decode_b64(mask_b64)
            if not mask_img:
                continue
            mask_img = mask_img.resize((img_w, img_h), Image.LANCZOS).convert("L")
            mask_arr = np.array(mask_img)
            if mask_arr.max() < 10:
                continue
            mask_img = mask_img.point(lambda v: 255 if v > 128 else 0)
        except Exception as e:
            _warn(f"Region {idx+1} mask error: {e}")
            continue

        region_neg = region.get("negPrompt", "").strip() or gp.neg_prompt
        region_denoise = region.get("denoising", None)
        if region_denoise is None or not isinstance(region_denoise, (int, float)):
            region_denoise = gp.denoising
        region_denoise = max(0.05, min(1.0, float(region_denoise)))

        try:
            p_region = StableDiffusionProcessingImg2Img(
                sd_model=shared.sd_model,
                outpath_samples=studio_outdir, outpath_grids=studio_outdir,
                prompt=region_prompt, negative_prompt=region_neg,
                init_images=[base_img], resize_mode=0,
                denoising_strength=region_denoise,
                n_iter=1, batch_size=1,
                steps=gp.steps, cfg_scale=gp.cfg_scale,
                width=img_w, height=img_h,
                sampler_name=gp.sampler_name or "Euler a",
                seed=gp.seed if hasattr(gp, 'seed') else -1,
            )
            p_region.do_not_save_grid = True
            p_region.image_mask = mask_img
            p_region.mask_blur = ip.mask_blur
            p_region.inpainting_fill = 1
            p_region.inpaint_full_res = True
            p_region.inpaint_full_res_padding = ip.inpaint_pad
            if gp.schedule_type and gp.schedule_type != "Automatic" and hasattr(p_region, 'scheduler'):
                p_region.scheduler = gp.schedule_type

            _attach_script_runner(p_region, has_mask=True, ip=ip)

            _log(f'Region {idx+1} "{region.get("name","")[:20]}": '
                 f'"{region_prompt[:60]}" (denoise={region_denoise:.2f})')
            processed = process_images(p_region)
            if processed and processed.images:
                region_results.append({
                    "prompt": region_prompt,
                    "neg_prompt": region_neg,
                    "mask": mask_img,
                    "result": processed.images[0],
                    "name": region.get("name", f"Region {idx+1}"),
                })
                _log(f"Region {idx+1} done")
        except Exception as e:
            _warn(f"Region {idx+1} error: {e}")
            traceback.print_exc()
        finally:
            try: p_region.close()
            except Exception: pass

    if not region_results:
        _log("No regions produced output")
        return canvas_img, []

    final = base_img.copy()
    for rr in region_results:
        final.paste(rr["result"], (0, 0), rr["mask"])
    _log(f"Composited {len(region_results)} regions onto base")

    return final, region_results
