"""
Forge Studio — Attention Couple Module v7
==========================================
Single-pass regional prompting via dual attention control:
  - Cross-attention (attn2): Pre-softmax logit bias steers text->spatial binding
  - Self-attention (attn1): Regional masking prevents feature leakage between subjects

This is the first implementation of combined cross+self attention masking for
regional prompting in the Forge/A1111 ecosystem, inspired by Bounded Attention
(Dahary et al., ECCV 2024) which proved that cross-attention bias alone cannot
prevent attribute leakage -- self-attention propagates features laterally between
spatial positions, bypassing cross-attention constraints entirely.

Architecture:
  attn2_patch:   Concatenates region conditionings into K/V before projection
  attn2_replace: Adds spatial logit bias to cross-attention (text->pixel steering)
  attn1_replace: Adds regional isolation bias to self-attention (pixel->pixel blocking)

  Self-attention masking rule:
    - Same region -> attend freely (no bias)
    - Background <-> anything -> attend freely (coherence bridge)
    - Different regions -> negative bias (block cross-region feature propagation)

  This preserves scene coherence (lighting, perspective flow through background)
  while preventing the lateral feature leak that causes heterochromia, hair color
  bleed, and other attribute mixing between characters.

v7: Adds self-attention masking via attn1_replace. Restores uncond token stripping,
    1-t^2 decay curve, and stronger bias values. Keeps v6 Gaussian feathering,
    bilinear downsampling, and implicit background bias.
"""

import json
import math
import traceback
import numpy as np

import torch
import torch.nn.functional as F
import torchvision.transforms.functional as TF
from PIL import Image

from modules import shared
from modules.script_callbacks import on_cfg_denoiser, CFGDenoiserParams
from modules.processing import process_images

TAG = "[Studio AttCouple v7]"


# =========================================================================
# TUNING CONSTANTS
# =========================================================================

# Cross-attention (attn2) bias
BASE_BIAS_STRENGTH = 8       # Positive bias for in-region tokens
NEGATIVE_BIAS_STRENGTH = -10.0   # Negative bias for out-of-region tokens
BG_BIAS_STRENGTH = 4.0          # Positive bias for base tokens in unpainted areas

# Self-attention (attn1) masking
SELF_NEGATIVE_BIAS = -8.0       # Negative bias between different-region positions
SELF_BIAS_START_FRAC = 0.2      # Begin self-attn masking after layout phase (20%)
SELF_BIAS_END_FRAC = 0.8        # End self-attn masking before refinement phase (80%)
MAX_SELF_ATTN_SPATIAL = 4096    # Skip self-attn masking above this (memory bound)
SELF_BG_THRESHOLD = 0.3         # Below this mask value = background (attends freely)


# =========================================================================
# REGION DATA PARSING
# =========================================================================

def _decode_b64_to_mask(b64_str, width, height):
    import base64, io
    if not b64_str:
        return None
    if "," in b64_str:
        b64_str = b64_str.split(",", 1)[1]
    try:
        img = Image.open(io.BytesIO(base64.b64decode(b64_str))).convert("L")
        if img.size != (width, height):
            img = img.resize((width, height), Image.NEAREST)
        return np.asarray(img, dtype=np.float32) / 255.0
    except Exception:
        return None


def parse_regions(regions_json, width, height):
    if not regions_json or regions_json.strip() in ("", "null", "[]", "{}"):
        return None
    try:
        raw = json.loads(regions_json)
    except Exception:
        return None
    regions_list = raw.get("regions", []) if isinstance(raw, dict) else (raw if isinstance(raw, list) else [])
    if not regions_list:
        return None
    parsed = []
    for r in regions_list:
        prompt = r.get("prompt", "").strip()
        if not prompt:
            continue
        mask_b64 = r.get("mask_b64", "")
        mask_np = _decode_b64_to_mask(mask_b64, width, height)
        if mask_np is None or mask_np.max() < 0.01:
            continue
        mask_np = (mask_np > 0.5).astype(np.float32)
        parsed.append({
            "prompt": prompt,
            "neg_prompt": r.get("negPrompt", "").strip(),
            "mask_np": mask_np,
            "weight": float(r.get("weight", 1.0)),
        })
    return parsed if parsed else None


def has_attention_regions(regions_json):
    if not regions_json or regions_json.strip() in ("", "null", "[]", "{}"):
        return False
    try:
        raw = json.loads(regions_json)
        regions = raw.get("regions", []) if isinstance(raw, dict) else raw
        return any(r.get("prompt", "").strip() for r in regions)
    except Exception:
        return False


# =========================================================================
# MODULE STATE
# =========================================================================

_pending_regions = None
_pending_width = 0
_pending_height = 0
_patched = False
_step_progress = [0.0]
_installed_state = {}
_diag_patch_calls = [0]
_diag_replace_calls = [0]
_diag_self_calls = [0]
_base_gen_done = [False]    # Set True after base gen's last step
_in_inner_pass = [False]    # Set True when AD/inner process_images starts


# =========================================================================
# ENCODING
# =========================================================================

def _encode_prompt(sd_model, prompt):
    """Encode prompt using the real sd_model available during sampling."""
    try:
        from modules.prompt_parser import SdConditioning
        texts = SdConditioning([prompt], False, 512, 512, None)
        cond = sd_model.get_learned_conditioning(texts)
        if isinstance(cond, dict) and "crossattn" in cond:
            return cond["crossattn"]
        if isinstance(cond, torch.Tensor):
            return cond
    except Exception as e:
        print(f"{TAG} get_learned_conditioning: {type(e).__name__}: {e}")

    try:
        clip = sd_model.forge_objects.clip
        tokens = clip.tokenize(prompt)
        output = clip.encode_from_tokens(tokens, return_pooled=True, return_dict=True)
        if isinstance(output, dict):
            for key in ("cond", "crossattn"):
                if key in output:
                    return output[key]
        if isinstance(output, (list, tuple)):
            return output[0]
        return output
    except Exception as e:
        print(f"{TAG} forge_objects.clip: {type(e).__name__}: {e}")

    return None


# =========================================================================
# WILDCARD RESOLUTION
# =========================================================================

def _resolve_wildcards(text):
    """Resolve __wildcard__ and {option|option} syntax via Dynamic Prompts."""
    if not text or ("__" not in text and "{" not in text):
        return text
    try:
        from dynamicprompts.generators import RandomPromptGenerator
        from dynamicprompts.wildcards.wildcard_manager import WildcardManager
        from modules.paths import script_path
        from pathlib import Path

        webui_root = Path(script_path)
        wildcards_dir = None
        try:
            try:
                from studio_lexicon import get_wildcards_root
            except ImportError:
                from scripts.studio_lexicon import get_wildcards_root
            resolved = Path(get_wildcards_root())
            if resolved.is_dir():
                wildcards_dir = resolved
        except Exception:
            for c in [webui_root / "extensions" / "sd-dynamic-prompts" / "wildcards",
                      webui_root / "extensions-builtin" / "sd-dynamic-prompts" / "wildcards",
                      webui_root / "extensions" / "sd-dynamic-prompts-fork" / "wildcards",
                      webui_root / "wildcards",
                      webui_root / "outputs" / "wildcards"]:
                if c.is_dir():
                    wildcards_dir = c
                    break

        wm = WildcardManager(wildcards_dir) if wildcards_dir else None
        gen = RandomPromptGenerator(wildcard_manager=wm) if wm else RandomPromptGenerator()
        resolved = gen.generate(text, num_images=1)
        if resolved and resolved[0]:
            return resolved[0]
    except ImportError:
        pass
    except Exception as e:
        print(f"{TAG} Wildcard error: {type(e).__name__}: {e}")
    return text


# =========================================================================
# MASK HELPERS
# =========================================================================

def _repeat_div(value, iterations):
    for _ in range(iterations):
        value = math.ceil(value / 2)
    return value


def _fill_region_gaps(region_masks):
    """
    Fill unclaimed pixels between painted regions using nearest-region assignment.

    Each unclaimed pixel (not covered by any region) gets assigned to the region
    whose painted area is closest. This is a Voronoi partition seeded by the
    painted regions — every pixel belongs to exactly one region, no blending.

    Input:  [num_regions, 1, H, W] binary masks (0.0 or 1.0)
    Output: [num_regions, 1, H, W] gap-filled masks
    """
    try:
        from scipy.ndimage import distance_transform_edt
    except ImportError:
        print(f"{TAG} scipy not available — skipping gap fill")
        return region_masks

    num_regions = region_masks.shape[0]
    if num_regions < 2:
        return region_masks

    # Work in numpy for distance transform
    masks_np = region_masks.cpu().numpy()  # [N, 1, H, W]

    # Find unclaimed pixels: not covered by ANY region
    claimed = masks_np.max(axis=0)[0]  # [H, W] — squeeze the channel dim
    unclaimed = claimed < 0.5

    unclaimed_count = unclaimed.sum()
    if unclaimed_count == 0:
        print(f"{TAG} Gap fill: no unclaimed pixels, skipping")
        return region_masks

    # Compute distance from each region's painted area
    # distance_transform_edt returns distance from nearest zero (painted) pixel
    distances = np.zeros((num_regions, masks_np.shape[2], masks_np.shape[3]),
                         dtype=np.float32)
    for i in range(num_regions):
        binary = masks_np[i, 0]  # [H, W]
        # EDT of the complement: distance from nearest painted pixel
        distances[i] = distance_transform_edt(binary < 0.5)

    # For unclaimed pixels, assign to nearest region (argmin distance)
    nearest = distances.argmin(axis=0)  # [H, W]

    # Fill: for each unclaimed pixel, set the nearest region's mask to 1.0
    result = masks_np.copy()
    for i in range(num_regions):
        fill_mask = unclaimed & (nearest == i)
        result[i, 0][fill_mask] = 1.0

    filled_count = unclaimed_count
    total = masks_np.shape[2] * masks_np.shape[3]
    print(f"{TAG} Gap fill: {filled_count}/{total} pixels assigned to nearest region "
          f"({100*filled_count/total:.1f}%)")

    return torch.from_numpy(result).to(device=region_masks.device, dtype=region_masks.dtype)


def _downsample_masks(region_masks, num_spatial, original_shape):
    """Downsample pixel-resolution masks to match attention layer spatial res.
    Uses bilinear interpolation to preserve Gaussian feathering gradients."""
    lat_h = original_shape[2]
    lat_w = original_shape[3]
    scale = math.ceil(math.log2(math.sqrt(lat_h * lat_w / num_spatial)))
    target_h = _repeat_div(lat_h, scale)
    target_w = _repeat_div(lat_w, scale)
    down = F.interpolate(region_masks, size=(target_h, target_w),
                         mode="bilinear", align_corners=False)
    return down.view(region_masks.shape[0], -1)


# =========================================================================
# STANDARD ATTENTION HELPER
# =========================================================================

def _sdp_attention(q, k, v, heads, dim_head):
    """Standard scaled dot-product attention via PyTorch."""
    bs, seq_q, _ = q.shape
    seq_k = k.shape[1]
    q = q.view(bs, seq_q, heads, dim_head).permute(0, 2, 1, 3)
    k = k.view(bs, seq_k, heads, dim_head).permute(0, 2, 1, 3)
    v = v.view(bs, seq_k, heads, dim_head).permute(0, 2, 1, 3)
    out = F.scaled_dot_product_attention(q, k, v, dropout_p=0.0, is_causal=False)
    return out.permute(0, 2, 1, 3).reshape(bs, seq_q, heads * dim_head)


# =========================================================================
# SELF-ATTENTION BIAS MATRIX BUILDER
# =========================================================================

def _build_self_attn_bias(region_masks_px, num_spatial, original_shape, device, dtype):
    """
    Build [num_spatial, num_spatial] bias matrix for self-attention masking.

    For each pair of spatial positions (i, j):
      Same region       -> 0 (attend normally)
      Either is bg      -> 0 (background is the coherence bridge)
      Different regions -> SELF_NEGATIVE_BIAS (suppress leakage)
    """
    masks_down = _downsample_masks(
        region_masks_px.to(device=device, dtype=dtype),
        num_spatial, original_shape
    )  # [num_regions, num_spatial]

    num_regions = masks_down.shape[0]
    if num_regions < 2:
        return None

    # Assign each position to a region or background (-1)
    max_vals, region_ids = masks_down.max(dim=0)
    region_ids[max_vals < SELF_BG_THRESHOLD] = -1

    non_bg = (region_ids >= 0).sum().item()
    if non_bg < 2:
        return None

    # Build the bias matrix
    is_bg = (region_ids == -1)
    ids_i = region_ids.unsqueeze(1)   # [S, 1]
    ids_j = region_ids.unsqueeze(0)   # [1, S]
    bg_i = is_bg.unsqueeze(1)         # [S, 1]
    bg_j = is_bg.unsqueeze(0)         # [1, S]

    # Suppress when: both non-background AND different regions
    suppress = (~bg_i) & (~bg_j) & (ids_i != ids_j)
    self_bias = suppress.to(dtype=dtype) * SELF_NEGATIVE_BIAS

    suppressed = suppress.sum().item()
    total = num_spatial * num_spatial
    print(f"{TAG} Self-attn bias: {num_spatial} spatial, "
          f"{suppressed}/{total} pairs suppressed ({100*suppressed/total:.1f}%)")

    return self_bias


# =========================================================================
# PATCH + REPLACE BUILDERS
# =========================================================================

def _build_patches(region_masks_px, region_conds_raw, region_weights, step_progress):
    """
    Build all three patch functions:
      attn2_patch:   Concatenate region conds into context (pre-projection)
      attn2_replace: Cross-attention with spatial logit bias
      attn1_replace: Self-attention with regional isolation masking

    Patches check the module-level _in_inner_pass flag and fall back to
    standard attention during AD face inpainting and other inner passes.
    """
    num_regions = len(region_conds_raw)
    tokens_per_region = region_conds_raw[0].shape[1]
    concat_cond_raw = torch.cat(region_conds_raw, dim=1)

    # Precompute area fractions and bias scales
    total_pixels = region_masks_px.shape[2] * region_masks_px.shape[3]
    bias_scales = []
    for i in range(num_regions):
        area = (region_masks_px[i] > 0.5).float().sum().item()
        frac = max(area / total_pixels, 0.001)
        scale = min(1.0 / math.sqrt(frac) * region_weights[i], 12.0)
        bias_scales.append(scale)
        print(f"{TAG} Region {i+1}: area={frac*100:.1f}%, "
              f"inv_sqrt={1.0/math.sqrt(frac):.2f}, "
              f"user_w={region_weights[i]:.2f}, bias_scale={scale:.2f}")

    bias_scales_t = torch.tensor(bias_scales)

    _cross_mask_cache = {}
    _self_mask_cache = {}
    _batch_info = {"bs": 1, "base_tokens": 77}

    # ===================================================================
    # ATTN2_PATCH: Concatenate region conds into context
    # ===================================================================

    @torch.inference_mode()
    def attn2_patch(q, k, v, extra_options):
        # Skip region token injection during AD/inner passes
        if _in_inner_pass[0]:
            return q, k, v

        _diag_patch_calls[0] += 1
        if _diag_patch_calls[0] <= 3:
            print(f"{TAG} attn2_patch #{_diag_patch_calls[0]}: "
                  f"q={list(q.shape)} k={list(k.shape)}")
        cond_or_unconds = extra_options.get("cond_or_uncond", [0, 1])
        num_chunks = len(cond_or_unconds)
        B = q.shape[0]
        bs = B // num_chunks
        _batch_info["bs"] = bs
        _batch_info["base_tokens"] = k.shape[1]

        region_ctx = concat_cond_raw.to(device=k.device, dtype=k.dtype)
        if region_ctx.shape[0] != bs:
            region_ctx = region_ctx.expand(bs, -1, -1)

        k_chunks = k.chunk(num_chunks, dim=0)
        v_chunks = v.chunk(num_chunks, dim=0)
        new_k_parts = []
        new_v_parts = []
        for i in range(num_chunks):
            new_k_parts.append(torch.cat([k_chunks[i], region_ctx], dim=1))
            new_v_parts.append(torch.cat([v_chunks[i], region_ctx], dim=1))

        return q, torch.cat(new_k_parts, dim=0), torch.cat(new_v_parts, dim=0)

    # ===================================================================
    # ATTN2_REPLACE: Cross-attention with spatial logit bias
    # ===================================================================

    @torch.inference_mode()
    def attn2_replace(q, k, v, extra_options):
        # Fall back to standard attention during AD/inner passes
        if _in_inner_pass[0]:
            heads = extra_options["n_heads"]
            dim_head = extra_options["dim_head"]
            return _sdp_attention(q, k, v, heads, dim_head)

        heads = extra_options["n_heads"]
        dim_head = extra_options["dim_head"]
        original_shape = extra_options["original_shape"]
        cond_or_unconds = extra_options.get("cond_or_uncond", [0, 1])

        _diag_replace_calls[0] += 1
        if _diag_replace_calls[0] <= 3:
            print(f"{TAG} attn2_replace #{_diag_replace_calls[0]}: "
                  f"q={list(q.shape)} k={list(k.shape)} "
                  f"base_tokens={_batch_info['base_tokens']} "
                  f"(uncond uses {_batch_info['base_tokens']}/{k.shape[1]} tokens)")

        B = q.shape[0]
        num_spatial = q.shape[1]
        num_chunks = len(cond_or_unconds)
        bs = B // num_chunks
        base_tokens = _batch_info["base_tokens"]
        scale = dim_head ** -0.5

        outputs = []
        for chunk_idx, cou in enumerate(cond_or_unconds):
            q_c = q[chunk_idx * bs : (chunk_idx + 1) * bs]
            k_c = k[chunk_idx * bs : (chunk_idx + 1) * bs]
            v_c = v[chunk_idx * bs : (chunk_idx + 1) * bs]

            if cou == 1:
                # UNCOND: strip region tokens. If uncond attends to region
                # content without bias, CFG cancels regional separation.
                k_base = k_c[:, :base_tokens, :]
                v_base = v_c[:, :base_tokens, :]
                outputs.append(_sdp_attention(q_c, k_base, v_base, heads, dim_head))
            else:
                outputs.append(_biased_cross_attention(
                    q_c, k_c, v_c, heads, dim_head, scale,
                    num_spatial, base_tokens, original_shape,
                    region_masks_px, bias_scales_t, num_regions,
                    tokens_per_region, step_progress, _cross_mask_cache
                ))

        return torch.cat(outputs, dim=0)

    # ===================================================================
    # ATTN1_REPLACE: Self-attention with regional isolation masking
    # ===================================================================

    @torch.inference_mode()
    def attn1_replace(q, k, v, extra_options):
        # Fall back to standard attention during AD/inner passes
        if _in_inner_pass[0]:
            heads = extra_options["n_heads"]
            dim_head = extra_options["dim_head"]
            return _sdp_attention(q, k, v, heads, dim_head)

        heads = extra_options["n_heads"]
        dim_head = extra_options["dim_head"]
        original_shape = extra_options["original_shape"]

        _diag_self_calls[0] += 1
        num_spatial = q.shape[1]
        progress = step_progress[0]

        if _diag_self_calls[0] <= 3:
            print(f"{TAG} attn1_replace #{_diag_self_calls[0]}: "
                  f"spatial={num_spatial} progress={progress:.2f} "
                  f"(window={SELF_BIAS_START_FRAC}-{SELF_BIAS_END_FRAC}, limit={MAX_SELF_ATTN_SPATIAL})")

        # Skip: outside masking window or high-res layers
        if progress < SELF_BIAS_START_FRAC or progress > SELF_BIAS_END_FRAC or num_spatial > MAX_SELF_ATTN_SPATIAL:
            return _sdp_attention(q, k, v, heads, dim_head)

        # Build or retrieve cached self-attention bias
        cache_key = num_spatial
        if cache_key not in _self_mask_cache:
            _self_mask_cache[cache_key] = _build_self_attn_bias(
                region_masks_px, num_spatial, original_shape,
                q.device, q.dtype
            )
        self_bias = _self_mask_cache[cache_key]

        if self_bias is None:
            return _sdp_attention(q, k, v, heads, dim_head)

        # Manual attention with self-bias
        bs = q.shape[0]
        scale = dim_head ** -0.5

        q_mh = q.view(bs, num_spatial, heads, dim_head).permute(0, 2, 1, 3)
        k_mh = k.view(bs, num_spatial, heads, dim_head).permute(0, 2, 1, 3)
        v_mh = v.view(bs, num_spatial, heads, dim_head).permute(0, 2, 1, 3)

        logits = torch.matmul(q_mh, k_mh.transpose(-2, -1)) * scale
        logits = logits + self_bias.unsqueeze(0).unsqueeze(0)

        attn_weights = torch.softmax(logits, dim=-1)
        out = torch.matmul(attn_weights, v_mh)
        out = out.permute(0, 2, 1, 3).reshape(bs, num_spatial, heads * dim_head)
        return out

    return attn2_patch, attn2_replace, attn1_replace


# =========================================================================
# BIASED CROSS-ATTENTION (attn2)
# =========================================================================

def _biased_cross_attention(q, k, v, heads, dim_head, scale,
                            num_spatial, base_tokens, original_shape,
                            region_masks_px, bias_scales_t, num_regions,
                            tokens_per_region, step_progress, mask_cache):
    """Cross-attention with spatial logit bias for regional steering."""
    bs = q.shape[0]
    device = q.device
    dtype = q.dtype
    total_k_tokens = k.shape[1]

    # 1-t^2 decay: holds near 1.0 through ~70%, drops at end
    progress = step_progress[0]
    timestep_mult = 1.0 - progress * progress

    if timestep_mult < 0.01:
        return _sdp_attention(q, k, v, heads, dim_head)

    # Downsampled masks
    cache_key = num_spatial
    if cache_key not in mask_cache:
        mask_cache[cache_key] = _downsample_masks(
            region_masks_px.to(device=device, dtype=dtype),
            num_spatial, original_shape
        )
    masks_down = mask_cache[cache_key]

    # Build bias matrix
    bias = torch.zeros(1, num_spatial, total_k_tokens, device=device, dtype=dtype)
    scales = bias_scales_t.to(device=device, dtype=dtype)

    # Implicit background: base tokens get positive bias in unpainted areas
    bg_mask = 1.0 - torch.clamp(masks_down.sum(dim=0), min=0.0, max=1.0)
    bg_bias = bg_mask * BG_BIAS_STRENGTH * timestep_mult
    bias[0, :, 0:base_tokens] += bg_bias.unsqueeze(-1)

    # Per-region positive + negative bias
    for i in range(num_regions):
        token_start = base_tokens + i * tokens_per_region
        token_end = token_start + tokens_per_region
        mask_col = masks_down[i]

        region_bias = mask_col * scales[i] * BASE_BIAS_STRENGTH * timestep_mult
        bias[0, :, token_start:token_end] += region_bias.unsqueeze(-1)

        outside_mask = 1.0 - mask_col
        neg_bias = outside_mask * NEGATIVE_BIAS_STRENGTH * timestep_mult
        bias[0, :, token_start:token_end] += neg_bias.unsqueeze(-1)

    # Manual attention with bias
    seq_k = k.shape[1]
    q_mh = q.view(bs, num_spatial, heads, dim_head).permute(0, 2, 1, 3)
    k_mh = k.view(bs, seq_k, heads, dim_head).permute(0, 2, 1, 3)
    v_mh = v.view(bs, seq_k, heads, dim_head).permute(0, 2, 1, 3)

    logits = torch.matmul(q_mh, k_mh.transpose(-2, -1)) * scale
    logits = logits + bias.unsqueeze(1)

    attn_weights = torch.softmax(logits, dim=-1)
    out = torch.matmul(attn_weights, v_mh)
    out = out.permute(0, 2, 1, 3).reshape(bs, num_spatial, heads * dim_head)
    return out


# =========================================================================
# BLOCK ENUMERATION
# =========================================================================

def _enumerate_unet_blocks(sd_model):
    """Find all (block_name, number) pairs with SpatialTransformer blocks."""
    blocks = []
    try:
        unet_model = sd_model.forge_objects.unet.model.diffusion_model
    except Exception:
        print(f"{TAG} Could not walk UNet -- using SDXL default layout")
        return _sdxl_default_blocks()

    for i, block in enumerate(unet_model.input_blocks):
        for layer in block:
            if type(layer).__name__ == "SpatialTransformer":
                blocks.append(("input", i))
                break

    for layer in unet_model.middle_block:
        if type(layer).__name__ == "SpatialTransformer":
            blocks.append(("middle", 0))
            break

    for i, block in enumerate(unet_model.output_blocks):
        for layer in block:
            if type(layer).__name__ == "SpatialTransformer":
                blocks.append(("output", i))
                break

    print(f"{TAG} Found {len(blocks)} transformer blocks: {blocks}")
    return blocks


def _sdxl_default_blocks():
    blocks = []
    for i in [4, 5, 7, 8]:
        blocks.append(("input", i))
    blocks.append(("middle", 0))
    for i in [0, 1, 2, 3, 4, 5]:
        blocks.append(("output", i))
    return blocks


# =========================================================================
# PATCH INSTALLATION
# =========================================================================

def _install_patches(sd_model, regions, width, height):
    """Encode region prompts, build masks, install all patches (attn1 + attn2)."""
    global _patched

    device = torch.device('cuda') if torch.cuda.is_available() else torch.device('cpu')
    dtype = torch.float16

    region_conds = []
    mask_tensors = []
    region_weights = []
    for r in regions:
        cond = _encode_prompt(sd_model, r["prompt"])
        if cond is None or not isinstance(cond, torch.Tensor):
            print(f"{TAG} FAILED to encode \"{r['prompt'][:40]}\"")
            continue

        region_conds.append(cond.to(device=device, dtype=dtype))
        mask_t = torch.from_numpy(r["mask_np"]).unsqueeze(0).unsqueeze(0)
        mask_tensors.append(mask_t)
        region_weights.append(r.get("weight", 1.0))
        print(f"{TAG} Encoded \"{r['prompt'][:50]}\" -> {cond.shape}")

    if not region_conds:
        print(f"{TAG} No regions encoded -- skipping")
        return

    region_masks = torch.cat(mask_tensors, dim=0).to(device=device, dtype=dtype)

    # NOTE: Unpainted gaps between regions are intentional — they serve as the
    # "coherence bridge" for self-attention masking. Background pixels attend
    # freely to all regions, allowing lighting, perspective, and style to flow
    # between characters. Filling the gap eliminates this bridge and worsens
    # attribute mixing. Users should paint regions roughly where characters go;
    # the gap between them is where the scene blends naturally.

    # Gaussian feathering
    k_size = int(min(width, height) * 0.05)
    if k_size % 2 == 0:
        k_size += 1
    k_size = max(3, k_size)
    sigma = float(k_size) / 3.0
    region_masks = TF.gaussian_blur(region_masks, kernel_size=[k_size, k_size],
                                     sigma=[sigma, sigma])
    print(f"{TAG} Gaussian feathering: kernel={k_size}, sigma={sigma:.1f}")

    _step_progress[0] = 0.0

    attn2_patch_fn, attn2_replace_fn, attn1_replace_fn = _build_patches(
        region_masks, region_conds, region_weights, _step_progress
    )

    try:
        unet = sd_model.forge_objects.unet
        blocks = _enumerate_unet_blocks(sd_model)

        # Cross-attention
        unet.set_model_attn2_patch(attn2_patch_fn)
        for block_name, number in blocks:
            unet.set_model_attn2_replace(attn2_replace_fn, block_name, number)

        # Self-attention (function self-limits by resolution + step)
        for block_name, number in blocks:
            unet.set_model_attn1_replace(attn1_replace_fn, block_name, number)

        _installed_state["patch_fn"] = attn2_patch_fn
        _installed_state["replace_fn"] = attn2_replace_fn
        _installed_state["self_replace_fn"] = attn1_replace_fn
        _installed_state["blocks"] = list(blocks)

        _patched = True

        to = unet.model_options.get("transformer_options", {})
        n_p = len(to.get("patches", {}).get("attn2_patch", []))
        n_r2 = len(to.get("patches_replace", {}).get("attn2", {}))
        n_r1 = len(to.get("patches_replace", {}).get("attn1", {}))
        print(f"{TAG} Installed: {n_p} attn2_patch, {n_r2} attn2_replace, "
              f"{n_r1} attn1_replace ({len(region_conds)} regions) "
              f"[unet id={id(unet):#x}]")

    except Exception as e:
        print(f"{TAG} Failed to install patches: {type(e).__name__}: {e}")
        traceback.print_exc()


# =========================================================================
# CFG DENOISER CALLBACK
# =========================================================================

def _on_cfg_denoiser(params: CFGDenoiserParams):
    global _pending_regions

    if _pending_regions is None:
        return

    # Detect inner passes (ADetailer, etc.) vs hires denoise.
    # After the base gen completes its last step, a new sampling loop
    # (step 0 again) could be either:
    #   - Hires denoise: same processing object, is_hr_pass=True
    #     → attention couple MUST stay active (otherwise features bleed)
    #   - AD inner pass: new processing object with _ad_inner=True
    #     → attention couple must be disabled (single-face inpaint)
    if params.sampling_step == 0 and _base_gen_done[0]:
        _p = getattr(params.denoiser, 'p', None) if params.denoiser else None
        _is_hr = getattr(_p, 'is_hr_pass', False) if _p else False

        if _is_hr:
            # Hires denoise — NOT an inner pass. Keep attention couple active
            # so regional prompting survives into the high-res refinement.
            print(f"{TAG} Hires pass detected — keeping attention couple active")
        elif not _in_inner_pass[0]:
            _in_inner_pass[0] = True
            print(f"{TAG} Inner pass detected (step 0 after base gen complete) — "
                  f"patches will bypass region bias")

    if params.total_sampling_steps > 0:
        # Only track progress for the base generation, not inner passes
        if not _in_inner_pass[0]:
            _step_progress[0] = params.sampling_step / params.total_sampling_steps

    # Mark base gen as done when we hit the last step
    if (not _base_gen_done[0] and not _in_inner_pass[0] and
            params.sampling_step >= params.total_sampling_steps - 1):
        _base_gen_done[0] = True
        print(f"{TAG} Base generation complete (step {params.sampling_step}/"
              f"{params.total_sampling_steps})")

    if params.sampling_step == 0 and not _in_inner_pass[0]:
        try:
            unet = shared.sd_model.forge_objects.unet
            to = unet.model_options.get("transformer_options", {})
            n_p = len(to.get("patches", {}).get("attn2_patch", []))
            n_r2 = len(to.get("patches_replace", {}).get("attn2", {}))
            n_r1 = len(to.get("patches_replace", {}).get("attn1", {}))
            print(f"{TAG} cfg_denoiser step=0: unet id={id(unet):#x}, "
                  f"attn2_patch={n_p}, attn2_replace={n_r2}, attn1_replace={n_r1}")
            if n_r2 == 0:
                print(f"{TAG} WARNING: attn2 patches gone at step 0!")
            if n_r1 == 0:
                print(f"{TAG} WARNING: attn1 patches gone at step 0!")
        except Exception as e:
            print(f"{TAG} cfg_denoiser diagnostic error: {e}")


import modules.script_callbacks as _scb
if not getattr(_scb, '_studio_attcouple_registered', False):
    on_cfg_denoiser(_on_cfg_denoiser)
    _scb._studio_attcouple_registered = True
    print(f"{TAG} Registered on_cfg_denoiser callback")


# =========================================================================
# PUBLIC API
# =========================================================================

def run_with_attention_couple(p, regions_json, width, height):
    """Encode regions, install patches, then run process_images."""
    global _pending_regions, _pending_width, _pending_height, _patched

    regions = parse_regions(regions_json, width, height)
    if not regions:
        print(f"{TAG} No valid regions -- standard generation")
        return process_images(p)

    for r in regions:
        original = r["prompt"]
        r["prompt"] = _resolve_wildcards(original)
        if r["prompt"] != original:
            print(f"{TAG} Wildcard: \"{original[:50]}\" -> \"{r['prompt'][:50]}\"")
        if r.get("neg_prompt"):
            r["neg_prompt"] = _resolve_wildcards(r["neg_prompt"])

    # Save the character-only prompt BEFORE prepending the global scene context.
    # AD inpaints a single cropped face — it doesn't need "2boys, fighting stance"
    # and that context actively confuses it (model tries to paint two characters'
    # attributes onto one face). AD gets the clean character description only.
    for r in regions:
        r["ad_prompt"] = r["prompt"]
        r["ad_neg_prompt"] = r.get("neg_prompt", "")

    global_prompt = _resolve_wildcards((p.prompt or "").strip())
    if global_prompt:
        p.prompt = global_prompt
        for r in regions:
            sep = ", " if not global_prompt.endswith(",") else " "
            r["prompt"] = global_prompt + sep + r["prompt"]
    for r in regions:
        print(f"{TAG} Region: \"{r['prompt'][:80]}\"")

    # Update the processing object's region data with resolved prompts.
    # AD will use r["ad_prompt"] (character-only) for face inpainting,
    # falling back to r["prompt"] (full) if ad_prompt isn't present.
    p._studio_regions = regions

    _pending_regions = regions
    _pending_width = width
    _pending_height = height
    _patched = False
    _installed_state.clear()
    _diag_patch_calls[0] = 0
    _diag_replace_calls[0] = 0
    _diag_self_calls[0] = 0
    _step_progress[0] = 0.0
    _base_gen_done[0] = False
    _in_inner_pass[0] = False

    # Model check — _ensure_model_loaded() in studio_generation.py handles
    # FakeInitialModel detection and triggers forge_model_reload() before we
    # get here. If forge_objects is still missing, fall back to standard gen
    # (which will trigger model load; next generation will work with patches).
    sd_model = shared.sd_model
    if not hasattr(sd_model, 'forge_objects') or sd_model.forge_objects is None:
        print(f"{TAG} Model not ready (no forge_objects) — falling back to standard generation")
        print(f"{TAG} Model type: {type(sd_model).__name__} — next generation should work")
        _pending_regions = None
        return process_images(p)

    _install_patches(sd_model, regions, width, height)

    if not _patched:
        print(f"{TAG} Patch install failed -- falling back to standard generation")
        _pending_regions = None
        return process_images(p)

    unet = sd_model.forge_objects.unet
    to = unet.model_options.get("transformer_options", {})
    print(f"{TAG} Pre-process_images: unet id={id(unet):#x}, "
          f"attn2_patch={len(to.get('patches', {}).get('attn2_patch', []))}, "
          f"attn2_replace={len(to.get('patches_replace', {}).get('attn2', {}))}, "
          f"attn1_replace={len(to.get('patches_replace', {}).get('attn1', {}))}")

    try:
        return process_images(p)
    except Exception as e:
        print(f"{TAG} Error: {e}")
        traceback.print_exc()
        return None
    finally:
        print(f"{TAG} Generation complete: attn2_patch={_diag_patch_calls[0]}x, "
              f"attn2_replace={_diag_replace_calls[0]}x, "
              f"attn1_replace={_diag_self_calls[0]}x")
        if _diag_replace_calls[0] == 0 and _diag_patch_calls[0] > 0:
            print(f"{TAG} WARNING: attn2_patch fired but attn2_replace never fired")
        if _diag_self_calls[0] == 0:
            print(f"{TAG} NOTE: attn1_replace never fired (all layers above "
                  f"spatial threshold or outside step window {SELF_BIAS_START_FRAC}-{SELF_BIAS_END_FRAC})")
        _remove_patches()
        _pending_regions = None
        _patched = False
        _base_gen_done[0] = False
        _in_inner_pass[0] = False


def _remove_patches():
    """Remove all patches from UNet in-place."""
    global _patched
    if not _installed_state:
        return
    try:
        unet = shared.sd_model.forge_objects.unet
        to = unet.model_options.get("transformer_options", {})

        patch_fn = _installed_state.get("patch_fn")
        if patch_fn:
            patches = to.get("patches", {}).get("attn2_patch", [])
            if patch_fn in patches:
                patches.remove(patch_fn)

        blocks = _installed_state.get("blocks", [])

        attn2_dict = to.get("patches_replace", {}).get("attn2", {})
        for block_name, number in blocks:
            key = (block_name, number)
            if key in attn2_dict:
                del attn2_dict[key]

        attn1_dict = to.get("patches_replace", {}).get("attn1", {})
        for block_name, number in blocks:
            key = (block_name, number)
            if key in attn1_dict:
                del attn1_dict[key]

        _patched = False
        _installed_state.clear()
        print(f"{TAG} Removed all patches (attn1 + attn2)")
    except Exception as e:
        print(f"{TAG} Cleanup error: {e}")


def cleanup_attention_couple():
    global _pending_regions, _patched
    _remove_patches()
    _pending_regions = None
    _patched = False
