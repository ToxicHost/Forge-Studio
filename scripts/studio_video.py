"""
Forge Studio — Video Generation Engine
by ToxicHost & Moritz

Self-contained video generation module. Drop into extensions/forge-studio/scripts/
and it auto-registers API routes on startup. No modifications to existing files needed.

Calls Forge Neo's process_images() directly (not through run_generation) to access
the video_path on the Processed result. Applies DaSiWa-inspired quality enhancements
(CFGZeroStar, NAGuidance, sigma shift) that work with any WAN model.

API Endpoints:
    POST /studio/api/video/generate  — generate video
    GET  /studio/api/video/status    — check model capabilities
    POST /studio/api/video/cancel    — interrupt generation

Test from browser console (with a WAN model loaded):

    fetch('/studio/api/video/status').then(r => r.json()).then(console.log)

    fetch('/studio/api/video/generate', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            prompt: "a cat walking through a garden, anime style",
            neg_prompt: "blurry, low quality",
            num_frames: 81,
            width: 832, height: 480,
            steps: 20, cfg_scale: 7.0, seed: -1,
            sampler_name: "euler", schedule_type: "simple",
        })
    }).then(r => r.json()).then(console.log)
"""

import asyncio
import base64
import io
import math
import os
import random
import time
import traceback

import torch
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

TAG = "[Studio Video]"

# Module-level storage for last generation's frames (for last_frame endpoint)
_last_gen_frames = {"frames": None}

# Pre-Video Lab forge_loading_parameters — restored after generation so
# switching back to Canvas doesn't reload WAN + text encoder.
_pre_video_loading_params = None


# =========================================================================
# CONFIGURATION
# =========================================================================

@dataclass
class VideoEnhanceConfig:
    """Quality enhancement parameters. All model-agnostic."""

    # CFGZeroStar — arxiv.org/abs/2503.18886
    cfg_zero_star: bool = True
    zero_init_pct: float = 0.04       # fraction of steps to zero-init
    optimized_scale: bool = True      # st* dynamic CFG scaling

    # NAGuidance — github.com/ChenDarYen/Normalized-Attention-Guidance
    nag_enabled: bool = False         # off by default (2x attention cost)
    nag_scale: float = 2.37          # extrapolation strength
    nag_tau: float = 0.25            # L1 normalization threshold
    nag_alpha: float = 0.25          # blend factor
    nag_start_block: int = 0         # first block to apply NAG

    # Sigma shift (flow matching noise schedule)
    sigma_shift: Optional[float] = 5.0    # 5.0 for I2V, 10.0 for S2V

    # TeaCache — arxiv.org/abs/2411.19108 (CVPR 2025)
    teacache_enabled: bool = False
    teacache_threshold: float = 0.2       # rel L1 threshold (lower = more quality, less speed)
    teacache_cache_device: str = "cpu"    # "cpu" saves VRAM, "cuda" is faster


@dataclass
class VideoGenConfig:
    """Video generation parameters."""
    prompt: str = ""
    neg_prompt: str = ""
    seconds: float = 5.0             # duration in seconds (converted to frames)
    fps: int = 16
    width: int = 832
    height: int = 480
    steps: int = 4                   # DaSiWa default — 4 steps with fine-tuned models
    cfg_scale: float = 1.0           # 1.0 disables neg prompt; use NAG for neg adherence
    denoising: float = 1.0
    sampler_name: str = "euler"
    schedule_type: str = "simple"
    seed: int = -1
    batch_count: int = 1

    # I2V: base64-encoded reference image (None = T2V mode)
    init_image_b64: Optional[str] = None

    # MoE expert switching (Refiner mechanism)
    refiner_checkpoint: Optional[str] = None
    refiner_switch_at: float = 0.5

    # Enhancements
    enhancements: VideoEnhanceConfig = field(default_factory=VideoEnhanceConfig)

    # Post-processing
    post_upscale: bool = False
    upscale_model: str = ""               # e.g. "4x-UltraSharp", "" = auto-pick
    upscale_factor: float = 2.0           # net output scale

    @property
    def num_frames(self) -> int:
        """Convert seconds + FPS to frame count, aligned to 4n+1 for WAN."""
        raw = int(self.seconds * self.fps)
        # Align to 4n+1: round to nearest valid count
        n = max(1, round((raw - 1) / 4))
        return n * 4 + 1

    @property
    def is_i2v(self) -> bool:
        return (self.init_image_b64 is not None
                and self.init_image_b64 not in ("", "null"))


# =========================================================================
# ENHANCEMENT PATCHES
# =========================================================================

def apply_cfg_zero_star(model, steps: int, zero_init_pct: float = 0.04,
                        use_optimized_scale: bool = True):
    """CFGZeroStar: optimized CFG for flow matching models.

    Zero-init: returns pure conditional prediction for early steps.
    Optimized scale: st* = dot(v_cond, v_uncond) / ||v_uncond||^2
    corrects velocity estimation error in the unconditional branch.

    Works with any flow matching model (WAN, Flux, SD3).
    """
    model = model.clone()
    zero_init_steps = max(1, int(math.ceil(steps * zero_init_pct)))
    # Mutable counter — increments each time CFG function is called.
    # More reliable than sigma matching since we don't depend on
    # sampling_sigmas propagation through transformer_options.
    _counter = {"step": 0}

    print(f"{TAG} CFGZeroStar: zero_init={zero_init_steps}/{steps}, "
          f"opt_scale={use_optimized_scale}")

    def cfg_fn(args):
        cond = args["cond"]
        uncond = args["uncond"]
        cfg_scale = args["cond_scale"]

        step = _counter["step"]
        _counter["step"] += 1

        # Zero-init: early steps get pure conditional
        if step < zero_init_steps:
            return cond

        # Optimized scale
        if use_optimized_scale:
            b = cond.shape[0]
            pos = cond.reshape(b, -1)
            neg = uncond.reshape(b, -1)
            dot = torch.sum(pos * neg, dim=1, keepdim=True)
            sq_norm = torch.sum(neg ** 2, dim=1, keepdim=True) + 1e-8
            st = (dot / sq_norm).reshape(b, *([1] * (len(cond.shape) - 1)))
            return uncond + cfg_scale * (cond - st * uncond)

        # Standard CFG fallback
        return uncond + cfg_scale * (cond - uncond)

    model.set_model_sampler_cfg_function(cfg_fn)
    return model


def apply_nag(model, nag_scale: float = 2.37, nag_tau: float = 0.25,
              nag_alpha: float = 0.25, start_block: int = 0):
    """NAGuidance: normalized attention guidance for negative prompting.

    Hooks into WAN self-attention. At specified blocks, extrapolates between
    normal attention and zeroed-key attention (no content baseline), then
    L1-normalizes to prevent drift.

    Compatible with RadialAttention — captures whatever attention function
    is installed at call time and wraps it.

    Works with any WAN model.
    """
    model = model.clone()

    print(f"{TAG} NAG: scale={nag_scale}, tau={nag_tau}, "
          f"alpha={nag_alpha}, start_block={start_block}")

    # Store config in transformer_options for the attention hook
    model.model_options.setdefault("transformer_options", {})
    model.model_options["transformer_options"]["nag"] = {
        "enabled": True, "scale": nag_scale, "tau": nag_tau,
        "alpha": nag_alpha, "start_block": start_block,
    }

    try:
        from backend.nn import wan
    except ImportError:
        print(f"{TAG} NAG: backend.nn.wan not available — skipping")
        return model

    def nag_wrapper(model_function, kwargs):
        c = kwargs.get("c", {})
        t_opts = c.get("transformer_options", {})
        nag_cfg = t_opts.get("nag", {})

        if not nag_cfg.get("enabled", False):
            return model_function(kwargs["input"], kwargs["timestep"], **c)

        _s = nag_cfg["scale"]
        _t = nag_cfg["tau"]
        _a = nag_cfg["alpha"]
        _sb = nag_cfg["start_block"]

        # Capture current attention (may already be patched by RadialAttn)
        _prev_attn = wan.attention

        def nag_attn(q, k, v, heads, transformer_options=None, **kw):
            if transformer_options is None:
                transformer_options = {}
            block_idx = transformer_options.get("block_index", -1)

            # Pass through below start_block
            if block_idx < _sb:
                return _prev_attn(q, k, v, heads,
                                  transformer_options=transformer_options, **kw)

            # Positive attention (normal)
            z_pos = _prev_attn(q, k, v, heads,
                               transformer_options=transformer_options, **kw)

            # Negative attention (zeroed keys/values = no-content baseline)
            z_neg = _prev_attn(q, torch.zeros_like(k), torch.zeros_like(v),
                               heads,
                               transformer_options=transformer_options, **kw)

            # Extrapolate
            z_ext = z_pos + _s * (z_pos - z_neg)

            # L1 normalize to prevent out-of-manifold drift
            n_pos = z_pos.abs().mean(dim=-1, keepdim=True).clamp(min=1e-8)
            n_ext = z_ext.abs().mean(dim=-1, keepdim=True).clamp(min=1e-8)
            z_ext = z_ext * (n_pos / n_ext).clamp(max=_t)

            # Blend
            return _a * z_ext + (1.0 - _a) * z_pos

        # Install NAG attention for this forward pass only
        wan.attention = nag_attn
        try:
            result = model_function(kwargs["input"], kwargs["timestep"], **c)
        finally:
            wan.attention = _prev_attn

        return result

    model.set_model_unet_function_wrapper(nag_wrapper)
    return model


def apply_sigma_shift(p, shift: float):
    """Apply sigma shift via the processing object.

    Forge Neo stores the shift in p.distilled_cfg_scale — this is read
    during infotext generation (processing.py line 733) and propagated
    to the model's noise schedule via use_shift.

    Higher shift = more compute on global structure vs fine detail.
    Stock WAN ~3.0, DaSiWa I2V: 5.0, DaSiWa S2V: 10.0.
    """
    p.distilled_cfg_scale = shift
    print(f"{TAG} Sigma shift: {shift} (via p.distilled_cfg_scale)")


def apply_teacache(model, steps: int, threshold: float = 0.2,
                   cache_device: str = "cpu"):
    """TeaCache: Timestep Embedding Aware Cache for video diffusion.

    Caches model outputs and reuses them when consecutive denoising steps
    produce similar results. Tracks relative L1 distance between inputs;
    when accumulated distance stays below threshold, returns cached residual
    instead of running the full transformer.

    Chains correctly with NAG — captures any existing unet function wrapper
    and calls it during full computation, skips it during cached steps.

    Primarily beneficial for step counts >= 10. For 4-step DaSiWa models,
    at most 2 steps are candidates for caching (first/last always compute).

    Reference: "Timestep Embedding Tells: It's Time to Cache for Video
    Diffusion Model" — Liu et al., CVPR 2025 (arxiv.org/abs/2411.19108)
    """
    import torch

    model = model.clone()
    cache_dev = torch.device(cache_device)

    # Capture existing wrapper (e.g. NAG) to chain on top of it
    existing_wrapper = model.model_options.get("model_function_wrapper", None)

    # Mutable state for this generation run
    _state = {
        "step": 0,
        "steps": steps,
        "accumulated_distance": 0.0,
        "previous_input": None,
        "previous_residual": None,
        "skipped": 0,
        "computed": 0,
    }

    def teacache_wrapper(model_function, kwargs):
        x = kwargs["input"]
        timestep = kwargs["timestep"]
        c = kwargs.get("c", {})

        step = _state["step"]
        _state["step"] += 1

        is_first = (step == 0)
        is_last = (step >= _state["steps"] - 1)
        should_compute = is_first or is_last

        # ── Cache check ────────────────────────────────────────────
        if (not should_compute
                and _state["previous_input"] is not None
                and _state["previous_residual"] is not None):
            with torch.no_grad():
                prev = _state["previous_input"]
                if prev.device != x.device:
                    prev = prev.to(x.device)
                rel_l1 = ((x - prev).abs().mean()
                          / prev.abs().mean().clamp(min=1e-8))
                _state["accumulated_distance"] += rel_l1.item()

            if _state["accumulated_distance"] < threshold:
                # Skip: reuse cached residual
                _state["skipped"] += 1
                residual = _state["previous_residual"]
                if residual.device != x.device:
                    residual = residual.to(x.device)
                return x + residual
            # Distance exceeded threshold → compute this step
            should_compute = True

        # ── Full computation ───────────────────────────────────────
        if existing_wrapper is not None:
            output = existing_wrapper(model_function, kwargs)
        else:
            output = model_function(x, timestep, **c)

        _state["computed"] += 1

        # Cache residual (output - input) and input for next comparison
        with torch.no_grad():
            _state["previous_residual"] = (output - x).to(cache_dev)
            _state["previous_input"] = x.to(cache_dev)
            _state["accumulated_distance"] = 0.0

        return output

    model.set_model_unet_function_wrapper(teacache_wrapper)

    print(f"{TAG} TeaCache: threshold={threshold}, steps={steps}, "
          f"cache_device={cache_device}")

    return model


# =========================================================================
# POST-PROCESSING PIPELINE
# =========================================================================

def _get_upscaler(name: str = ""):
    """Find an upscaler by name. Falls back to first available ESRGAN model."""
    from modules import shared
    if not shared.sd_upscalers:
        return None

    if name:
        for u in shared.sd_upscalers:
            if u.name == name:
                return u
        # Fuzzy match
        name_lower = name.lower()
        for u in shared.sd_upscalers:
            if name_lower in u.name.lower():
                return u

    # Auto-pick: prefer common high-quality upscalers
    for preferred in ["4x-UltraSharp", "remacri_original", "ESRGAN_4x", "R-ESRGAN 4x+"]:
        for u in shared.sd_upscalers:
            if u.name == preferred:
                return u

    # Fall back to first real upscaler (skip None/Lanczos/Nearest)
    for u in shared.sd_upscalers:
        if u.name not in ("None", "Lanczos", "Nearest"):
            return u

    return None


def _upscale_frames(frames: list, upscaler_name: str, target_scale: float) -> list:
    """Upscale a list of PIL Image frames using Forge's upscaler.

    Returns list of upscaled numpy frames (H,W,3 uint8) for FFmpeg encoding.
    """
    import numpy as np
    from PIL import Image

    upscaler_data = _get_upscaler(upscaler_name)
    if upscaler_data is None:
        print(f"{TAG} No upscaler found — skipping upscale")
        return []

    # shared.sd_upscalers contains UpscalerData objects.
    # The actual Upscaler with .upscale() is on .scaler
    scaler = upscaler_data.scaler
    if scaler is None:
        print(f"{TAG} Upscaler {upscaler_data.name} has no scaler — skipping")
        return []

    print(f"{TAG} Upscaling {len(frames)} frames with {upscaler_data.name} "
          f"(target {target_scale}x)")

    upscaled = []
    first = frames[0] if isinstance(frames[0], Image.Image) else Image.fromarray(frames[0])
    w, h = first.width, first.height
    target_w = int(w * target_scale) // 8 * 8
    target_h = int(h * target_scale) // 8 * 8

    for i, frame in enumerate(frames):
        if i % 20 == 0:
            print(f"{TAG} Upscaling frame {i+1}/{len(frames)}")

        pil_img = frame if isinstance(frame, Image.Image) else Image.fromarray(frame)

        try:
            up = scaler.upscale(pil_img, scaler.scale, upscaler_data.data_path)
            if up.width != target_w or up.height != target_h:
                up = up.resize((target_w, target_h), Image.LANCZOS)
            upscaled.append(np.array(up.convert("RGB")))
        except Exception as e:
            print(f"{TAG} Upscale failed on frame {i}: {e}")
            resized = pil_img.resize((target_w, target_h), Image.LANCZOS)
            upscaled.append(np.array(resized.convert("RGB")))

    print(f"{TAG} Upscale complete: {w}x{h} → {target_w}x{target_h}")
    return upscaled


def _encode_video_ffmpeg(frames: list, fps: int, outdir: str, seed: int) -> Optional[str]:
    """Encode numpy frames to video via FFmpeg.

    Returns path to the encoded video, or None on failure.
    """
    import subprocess
    import numpy as np

    if not frames:
        return None

    h, w = frames[0].shape[:2]
    filename = f"upscaled-{seed}-{int(time.time())}.mp4"
    outpath = os.path.join(outdir, filename)

    try:
        from modules.shared import opts
        crf = int(getattr(opts, 'video_crf', 16))
        preset = str(getattr(opts, 'video_preset', 'slow'))
    except Exception:
        crf, preset = 16, "slow"

    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-hwaccel", "auto", "-y",
        "-f", "rawvideo", "-vcodec", "rawvideo",
        "-pix_fmt", "rgb24", "-s", f"{w}x{h}",
        "-r", str(fps), "-i", "-",
        "-vcodec", "h264", "-crf", str(crf),
        "-preset", preset, "-pix_fmt", "yuv420p",
        outpath,
    ]

    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        for frame in frames:
            proc.stdin.write(frame.astype(np.uint8).tobytes())
        proc.stdin.close()
        proc.wait()

        if proc.returncode == 0:
            print(f"{TAG} Encoded upscaled video: {outpath}")
            return outpath
        else:
            print(f"{TAG} FFmpeg returned code {proc.returncode}")
            return None
    except FileNotFoundError:
        print(f"{TAG} FFmpeg not found — cannot encode upscaled video")
        return None
    except Exception as e:
        print(f"{TAG} Video encoding error: {e}")
        return None


# =========================================================================
# VIDEO GENERATION
# =========================================================================

def run_video_generation(config: VideoGenConfig):
    """Generate video through Forge Neo's WAN pipeline.

    Calls process_images() directly to get Processed.video_path.
    Applies enhancement patches before sampling, restores after.

    Returns:
        dict with video_path, thumbnail_b64, seed, infotext, frames, error
    """
    from modules import shared
    from modules.processing import (
        StableDiffusionProcessingTxt2Img,
        StableDiffusionProcessingImg2Img,
        process_images,
    )
    from modules.shared import state

    global _pre_video_loading_params

    # ── Validate ────────────────────────────────────────────────────
    if not getattr(shared.sd_model, "is_wan", False):
        return {"error": "Current model is not a WAN model. "
                         "Load a WAN checkpoint first."}

    try:
        from backend import args as backend_args
        if not backend_args.dynamic_args.get("wan", False):
            return {"error": "WAN mode not active for current model."}
    except ImportError:
        pass  # Backend not available — proceed anyway

    # ── Reset state ─────────────────────────────────────────────────
    id_task = f"video-{int(time.time())}"
    try:
        _reset = _import("studio_generation", "_reset_generation_state")
        id_task = _reset()
        # NOTE: Do NOT call _ensure_model_loaded() here — it triggers
        # Canvas model reloads via forge_hash mismatch detection.
    except Exception as e:
        print(f"{TAG} State setup warning (non-fatal): {e}")

    # ── Freeze forge_hash to prevent mid-generation model reloads ────
    # After deactivate, forge_hash="" while forge_loading_parameters
    # points to Canvas. Forge's refiner mechanism calls forge_model_reload()
    # at the refiner step — if it sees a hash mismatch, it loads the Canvas
    # model mid-generation, catastrophically corrupting the WAN pipeline.
    # We freeze the hash so forge_model_reload() sees a match and skips.
    _saved_forge_hash = None
    try:
        from modules import sd_models as _sd_models
        _saved_forge_hash = _sd_models.model_data.forge_hash
        _sd_models.model_data.forge_hash = str(_sd_models.model_data.forge_loading_parameters)
        print(f"{TAG} Froze forge_hash for generation (was {_saved_forge_hash!r})")
    except Exception:
        pass

    # ── Seed ────────────────────────────────────────────────────────
    seed = config.seed
    if seed == -1:
        seed = random.randint(0, 2**32 - 1)

    print(f"{TAG} {'I2V' if config.is_i2v else 'T2V'}: "
          f"{config.seconds}s → {config.num_frames}f @ {config.width}x{config.height}, "
          f"steps={config.steps}, cfg={config.cfg_scale}, seed={seed}")

    # ── Wildcard / dynamic prompt resolution ───────────────────────
    try:
        _resolve = _import("studio_lexicon", "_resolve_text")
        resolved_prompt = _resolve(config.prompt)
        resolved_neg = _resolve(config.neg_prompt)
        if resolved_prompt != config.prompt:
            print(f"{TAG} Wildcards resolved: {config.prompt!r} → {resolved_prompt!r}")
        config.prompt = resolved_prompt
        config.neg_prompt = resolved_neg
    except Exception as e:
        print(f"{TAG} Wildcard resolution skipped: {e}")

    # ── Output dir ──────────────────────────────────────────────────
    try:
        _outdir_fn = _import("studio_generation", "_get_output_dir")
        outdir = _outdir_fn("Create")
    except Exception:
        outdir = os.path.join(os.path.abspath("output"), "studio", "video")
    Path(outdir).mkdir(parents=True, exist_ok=True)

    # ── Build processing object ─────────────────────────────────────
    # batch_size = num_frames is how Forge Neo triggers video mode.
    # Forge's process_images_inner detects WAN + batch_size > 1 and
    # creates a 3D latent (channels, time, h, w) instead of 2D.

    common_args = dict(
        sd_model=shared.sd_model,
        outpath_samples=outdir,
        outpath_grids=outdir,
        prompt=config.prompt,
        negative_prompt=config.neg_prompt,
        n_iter=1,
        batch_size=config.num_frames,
        steps=config.steps,
        cfg_scale=config.cfg_scale,
        width=config.width,
        height=config.height,
        sampler_name=config.sampler_name,
        seed=seed,
        do_not_save_samples=True,
        do_not_save_grid=True,
    )

    if config.is_i2v:
        from PIL import Image
        try:
            img_data = base64.b64decode(config.init_image_b64)
            init_img = Image.open(io.BytesIO(img_data)).convert("RGB")
            init_img = init_img.resize(
                (config.width, config.height), Image.LANCZOS)
        except Exception as e:
            return {"error": f"Reference image decode failed: {e}"}

        p = StableDiffusionProcessingImg2Img(
            init_images=[init_img],
            resize_mode=0,
            denoising_strength=config.denoising,
            **common_args,
        )
    else:
        p = StableDiffusionProcessingTxt2Img(**common_args)

    # Scheduler
    if (config.schedule_type
            and config.schedule_type != "Automatic"
            and hasattr(p, 'scheduler')):
        p.scheduler = config.schedule_type

    # MoE expert switching via Refiner mechanism
    if config.refiner_checkpoint:
        p.refiner_checkpoint = config.refiner_checkpoint
        p.refiner_switch_at = config.refiner_switch_at
        print(f"{TAG} Refiner (low-noise expert): {config.refiner_checkpoint}, "
              f"switch at {config.refiner_switch_at:.0%}")

    # ── Cancel auto-unload during generation ───────────────────────
    try:
        _cancel = _import("studio_api", "_cancel_auto_unload")
        _cancel()
    except Exception:
        pass

    # Note: We do NOT manually load the VAE to GPU here. Forge's
    # process_images_inner() handles model loading via memory_management
    # internally. Manual .to() or load_model_gpu() calls from outside
    # the pipeline cause hangs or tensor tracking errors.

    # Note: We intentionally do NOT attach the script runner here.
    # Alwayson scripts (ControlNet, ADetailer, etc.) expect properly
    # typed args in their slots — filling with None causes assertion
    # errors. Video generation doesn't need these scripts.
    # If RadialAttention is desired, apply it via the unet patcher
    # (same pattern as NAG/CFGZeroStar above).

    # ── Apply enhancements ──────────────────────────────────────────
    original_unet = None
    enh = config.enhancements

    try:
        original_unet = shared.sd_model.forge_objects.unet
        unet = original_unet

        if enh.sigma_shift is not None:
            apply_sigma_shift(p, enh.sigma_shift)

        if enh.cfg_zero_star:
            unet = apply_cfg_zero_star(
                unet, steps=config.steps,
                zero_init_pct=enh.zero_init_pct,
                use_optimized_scale=enh.optimized_scale,
            )

        if enh.nag_enabled:
            unet = apply_nag(
                unet, nag_scale=enh.nag_scale, nag_tau=enh.nag_tau,
                nag_alpha=enh.nag_alpha, start_block=enh.nag_start_block,
            )

        # TeaCache MUST be applied AFTER NAG — it wraps NAG's wrapper
        # and calls it during full computation, skips during cached steps.
        if enh.teacache_enabled:
            unet = apply_teacache(
                unet, steps=config.steps,
                threshold=enh.teacache_threshold,
                cache_device=enh.teacache_cache_device,
            )

        shared.sd_model.forge_objects.unet = unet
        print(f"{TAG} Enhancements applied")
    except Exception as e:
        print(f"{TAG} Enhancement error (non-fatal): {e}")
        traceback.print_exc()

    # ── Generate ────────────────────────────────────────────────────
    # Forge's process_images_inner calls images.save_video() which
    # requires FFmpeg. If FFmpeg isn't installed, this crashes the
    # entire generation even though frames were produced successfully.
    # We monkey-patch save_video to:
    #   1. Capture the frames for our own use
    #   2. Try the original FFmpeg encoding
    #   3. Fall back gracefully if FFmpeg is missing
    from modules import images as _images
    _orig_save_video = getattr(_images, 'save_video', None)
    _captured = {"frames": None, "video_path": None}

    def _safe_save_video(p_obj, frame_list, fps=16, **kwargs):
        _captured["frames"] = list(frame_list)
        # Inject the user's FPS setting — Forge calls save_video without
        # specifying fps, so it defaults to 16. We override with config.fps.
        actual_fps = config.fps
        if _orig_save_video:
            try:
                path = _orig_save_video(p_obj, frame_list, fps=actual_fps, **kwargs)
                _captured["video_path"] = path
                return path
            except Exception as e:
                print(f"{TAG} FFmpeg video save failed (non-fatal): {e}")
                print(f"{TAG} Frames captured successfully — video encoding skipped.")
                print(f"{TAG} Install FFmpeg to enable video output.")
                return None
        return None

    _images.save_video = _safe_save_video

    # ── Dual-expert via fast state_dict swap ──────────────────────
    # Forge has two refiner paths:
    #   refiner_fast_sd=False (default) → full forge_model_reload() mid-sampling → OOMs on 16GB
    #   refiner_fast_sd=True → in-place load_state_dict() swap → same model shell, no VRAM spike
    # We temporarily force the fast path for dual-expert video generation.
    _saved_opts = {}

    if config.refiner_checkpoint:
        from modules.shared import opts as _opts
        _saved_opts["refiner_fast_sd"] = getattr(_opts, "refiner_fast_sd", False)
        _saved_opts["refiner_use_steps"] = getattr(_opts, "refiner_use_steps", False)
        _opts.data["refiner_fast_sd"] = True
        _opts.data["refiner_use_steps"] = True
        print(f"{TAG} Dual-expert: fast state_dict swap enabled, step-based switching")

    result = {
        "video_path": None,
        "thumbnail_b64": None,
        "seed": seed,
        "infotext": "",
        "frames": 0,
        "error": None,
        "task_id": id_task,
    }

    try:
        t0 = time.time()
        processed = process_images(p)
        elapsed = time.time() - t0
        print(f"{TAG} Done in {elapsed:.1f}s")

        if processed:
            result["video_path"] = getattr(processed, "video_path", None)
            result["frames"] = len(processed.images) if processed.images else 0
            result["seed"] = getattr(processed, "seed", seed)

            if hasattr(processed, "infotexts") and processed.infotexts:
                result["infotext"] = processed.infotexts[0]

            # Thumbnail: first frame as JPEG base64
            if processed.images:
                try:
                    buf = io.BytesIO()
                    processed.images[0].save(buf, format="JPEG", quality=85)
                    result["thumbnail_b64"] = base64.b64encode(
                        buf.getvalue()).decode()
                except Exception as e:
                    print(f"{TAG} Thumbnail error: {e}")

            if not result["video_path"]:
                print(f"{TAG} Warning: no video_path returned. "
                      f"Verify FFmpeg is installed and num_frames > 1.")

    except Exception as e:
        print(f"{TAG} Generation error: {e}")
        traceback.print_exc()
        result["error"] = str(e)

    finally:
        # Restore original save_video
        if _orig_save_video:
            _images.save_video = _orig_save_video

        # Restore refiner opts
        if _saved_opts:
            from modules.shared import opts as _opts
            for k, v in _saved_opts.items():
                _opts.data[k] = v

        # Restore forge_hash (unfreeeze after generation)
        if _saved_forge_hash is not None:
            try:
                from modules import sd_models as _sd_models
                _sd_models.model_data.forge_hash = _saved_forge_hash
            except Exception:
                pass

        # ── Reverse-swap: restore original (high-noise) weights ──────
        # The fast refiner did an in-place load_state_dict during sampling
        # (inside inference_mode). We mirror it in reverse to restore the
        # original weights. Must also be in inference_mode or PyTorch
        # raises "cannot modify tensors with requires_grad outside..."
        if config.refiner_checkpoint:
            try:
                from modules import sd_samplers_common
                original_file = sd_samplers_common.ORIGINAL_CHECKPOINT

                if original_file and os.path.isfile(original_file):
                    with torch.inference_mode():
                        import huggingface_guess
                        from backend.loader import preprocess_state_dict
                        from backend.state_dict import load_state_dict as _load_sd
                        from backend.state_dict import try_filter_state_dict
                        from backend.utils import load_torch_file

                        model = shared.sd_model.forge_objects.unet.model.diffusion_model
                        sd = load_torch_file(original_file)
                        sd = preprocess_state_dict(sd)
                        guess = huggingface_guess.guess(sd)
                        sd = try_filter_state_dict(sd, guess.unet_key_prefix)
                        _load_sd(model, sd)

                        # Re-bake GGUF if the original model is GGUF
                        if original_file.lower().endswith(".gguf"):
                            try:
                                from backend.memory_management import bake_gguf_model
                                shared.sd_model.forge_objects.unet.model.gguf_baked = False
                                shared.sd_model.forge_objects.unet.model = bake_gguf_model(
                                    shared.sd_model.forge_objects.unet.model)
                            except Exception as e:
                                print(f"{TAG} GGUF re-bake warning: {e}")

                        # Reset LoRA hashes so they re-apply on next generation
                        shared.sd_model.current_lora_hash = str([])
                        shared.sd_model.forge_objects.unet.lora_loader.loaded_hash = str([])

                    print(f"{TAG} Original model weights restored via state_dict swap")
                else:
                    print(f"{TAG} Original checkpoint not found — hash invalidated for next reload")

                sd_samplers_common.ORIGINAL_CHECKPOINT = None
            except Exception as e:
                print(f"{TAG} Weight restore failed (will recover on next model load): {e}")
                traceback.print_exc()
                # Fallback: invalidate hash so next forge_model_reload catches it
                try:
                    from modules import sd_samplers_common, sd_models
                    sd_samplers_common.ORIGINAL_CHECKPOINT = None
                    sd_models.model_data.forge_hash = ""
                except Exception:
                    pass

        # Restore pre-Video Lab forge_loading_parameters so the next
        # forge_model_reload() (e.g. from Canvas generate) loads the
        # Canvas model instead of reloading WAN + text encoder.
        if _pre_video_loading_params is not None:
            try:
                from modules import sd_models
                sd_models.model_data.forge_loading_parameters = _pre_video_loading_params
                _pre_video_loading_params = None  # reset for next Video Lab session
                print(f"{TAG} Restored pre-Video Lab loading parameters")
            except Exception:
                pass

        # Always restore original unet
        if original_unet is not None:
            try:
                shared.sd_model.forge_objects.unet = original_unet
            except Exception:
                pass

        # ── VRAM cleanup (cache only — no gc.collect while model is live) ─
        # gc.collect() here can destroy mmap handles that Forge's memory
        # manager still references (text encoder safetensors), causing
        # "corrupt or invalid" errors on the next forge_model_reload().
        # Only flush the CUDA allocator cache; full gc runs after return.
        try:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

        # Re-schedule auto-unload
        try:
            _schedule = _import("studio_api", "_schedule_auto_unload")
            _schedule()
        except Exception:
            pass

        # Finish task
        try:
            from modules.progress import finish_task
            finish_task(id_task)
        except Exception:
            pass

    # Use captured video path if process_images didn't set it
    if not result["video_path"] and _captured.get("video_path"):
        result["video_path"] = _captured["video_path"]

    # ── Post-processing pipeline ───────────────────────────────────
    if config.post_upscale and _captured.get("frames") and not result.get("error"):
        try:
            print(f"{TAG} Starting post-processing: upscale {config.upscale_factor}x")
            t_up = time.time()

            upscaled_frames = _upscale_frames(
                _captured["frames"],
                config.upscale_model,
                config.upscale_factor,
            )

            if upscaled_frames and len(upscaled_frames) == len(_captured["frames"]):
                up_path = _encode_video_ffmpeg(
                    upscaled_frames, config.fps, outdir, seed)
                if up_path:
                    result["video_path"] = up_path
                    result["upscaled"] = True
                    print(f"{TAG} Post-processing done in {time.time() - t_up:.1f}s")
                else:
                    print(f"{TAG} Upscale encoding failed — keeping original video")
            else:
                print(f"{TAG} Upscale frame count mismatch — keeping original")
        except Exception as e:
            print(f"{TAG} Post-processing error (non-fatal): {e}")
            traceback.print_exc()

    # Store frames for last_frame extraction endpoint
    if _captured.get("frames"):
        _last_gen_frames["frames"] = _captured["frames"]

    # If we have captured frames but no video, encode thumbnail from them
    if not result["thumbnail_b64"] and _captured.get("frames"):
        try:
            buf = io.BytesIO()
            _captured["frames"][0].save(buf, format="JPEG", quality=85)
            result["thumbnail_b64"] = base64.b64encode(buf.getvalue()).decode()
            result["frames"] = len(_captured["frames"])
        except Exception:
            pass

    # ── Final VRAM cleanup (post-processing may have used GPU) ───
    # NOTE: No gc.collect() anywhere — shared.sd_model is a global that
    # persists across generations with mmap'd safetensors handles.
    # gc.collect() can destroy intermediate references that keep those
    # mmaps alive, causing "corrupt or invalid" on next forge_model_reload().
    # torch.cuda.empty_cache() is always safe — it only affects the CUDA
    # allocator's free list, not Python object lifecycle.
    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass

    return result


# =========================================================================
# API ROUTES
# =========================================================================

def register_video_routes(app):
    """Register video generation endpoints onto Forge's FastAPI app."""
    from fastapi.responses import JSONResponse

    print(f"{TAG} Registering API routes")

    @app.post("/studio/api/video/generate")
    async def video_generate(request: dict):
        """Generate video. Returns {video_path, thumbnail_b64, seed, ...}"""
        try:
            enh_data = request.pop("enhancements", {})
            enh = VideoEnhanceConfig(
                **{k: v for k, v in enh_data.items()
                   if hasattr(VideoEnhanceConfig, k)})

            config = VideoGenConfig(
                prompt=request.get("prompt", ""),
                neg_prompt=request.get("neg_prompt", ""),
                seconds=request.get("seconds", 5.0),
                fps=request.get("fps", 16),
                width=request.get("width", 832),
                height=request.get("height", 480),
                steps=request.get("steps", 4),
                cfg_scale=request.get("cfg_scale", 1.0),
                denoising=request.get("denoising", 1.0),
                sampler_name=request.get("sampler_name", "euler"),
                schedule_type=request.get("schedule_type", "simple"),
                seed=request.get("seed", -1),
                batch_count=request.get("batch_count", 1),
                init_image_b64=request.get("init_image_b64"),
                refiner_checkpoint=request.get("refiner_checkpoint"),
                refiner_switch_at=request.get("refiner_switch_at", 0.5),
                enhancements=enh,
                post_upscale=request.get("post_upscale", False),
                upscale_model=request.get("upscale_model", ""),
                upscale_factor=request.get("upscale_factor", 2.0),
            )

            result = await asyncio.to_thread(run_video_generation, config)
            return JSONResponse(result)

        except Exception as e:
            traceback.print_exc()
            return JSONResponse({"error": str(e)}, status_code=500)

    @app.get("/studio/api/video/status")
    async def video_status():
        """Check if current model supports video generation."""
        return JSONResponse(get_video_status())

    @app.post("/studio/api/video/cancel")
    async def video_cancel():
        """Interrupt video generation in progress."""
        try:
            from modules.shared import state
            state.interrupt()
            return JSONResponse({"interrupted": True})
        except Exception as e:
            return JSONResponse({"error": str(e)})

    @app.post("/studio/api/video/deactivate")
    async def video_deactivate():
        """Restore pre-Video Lab loading parameters and reload Canvas model.

        Called from the JS module's deactivate() hook when the user
        switches away from Video Lab. Restores the Canvas model's
        loading parameters and immediately reloads so the UI reflects
        the correct model/VAE without waiting for the next generate.
        """
        global _pre_video_loading_params
        if _pre_video_loading_params is not None:
            try:
                import asyncio
                from modules import sd_models
                sd_models.model_data.forge_loading_parameters = _pre_video_loading_params
                sd_models.model_data.forge_hash = ""
                _pre_video_loading_params = None
                print(f"{TAG} Restored Canvas loading params — reloading model")
                await asyncio.to_thread(sd_models.forge_model_reload)
                model_name = ""
                try:
                    model_name = shared.sd_model.sd_checkpoint_info.title
                except Exception:
                    pass
                print(f"{TAG} Canvas model reloaded: {model_name}")
                return JSONResponse({"ok": True, "restored": True, "model": model_name})
            except Exception as e:
                import traceback
                traceback.print_exc()
                print(f"{TAG} Deactivate restore failed: {e}")
                return JSONResponse({"error": str(e)})
        return JSONResponse({"ok": True, "restored": False})

    @app.get("/studio/api/video/text_encoders")
    async def video_text_encoders():
        """List available text encoder files from models/text_encoder/."""
        try:
            from modules import shared as _shared
            import glob

            models_dir = getattr(_shared, 'models_path', 'models')
            te_dir = os.path.join(models_dir, "text_encoder")
            results = []

            if os.path.isdir(te_dir):
                for ext in ("*.safetensors", "*.gguf", "*.pt", "*.bin"):
                    for p in glob.glob(os.path.join(te_dir, "**", ext), recursive=True):
                        name = os.path.relpath(p, te_dir).replace("\\", "/")
                        if name not in results:
                            results.append(name)

            results.sort()
            return JSONResponse(results)
        except Exception as e:
            return JSONResponse([], status_code=200)

    @app.post("/studio/api/video/load_model")
    async def video_load_model(body: dict):
        """Load a WAN checkpoint with optional text encoder and VAE.

        The text encoder and VAE paths are passed as additional_modules
        to forge_loading_parameters, which merges them into the main
        state dict during model loading.
        """
        title = body.get("title", "")
        text_encoder = body.get("text_encoder", "")
        vae = body.get("vae", "")

        if not title:
            return JSONResponse({"error": "No checkpoint selected"}, status_code=400)

        try:
            from modules import sd_models, shared as _shared

            info = sd_models.get_closet_checkpoint_match(title)
            if not info:
                return JSONResponse({"error": f"Checkpoint not found: {title}"}, status_code=404)

            # Build additional_modules list
            additional = []
            models_dir = getattr(_shared, 'models_path', 'models')

            if text_encoder:
                te_path = os.path.join(models_dir, "text_encoder", text_encoder)
                if os.path.isfile(te_path):
                    additional.append(te_path)
                    print(f"{TAG} Text encoder: {text_encoder}")
                else:
                    print(f"{TAG} Warning: text encoder not found: {te_path}")

            # VAE as additional module (if not Automatic/None)
            if vae and vae not in ("Automatic", "None", ""):
                from modules import sd_vae
                sd_vae.refresh_vae_list()
                vae_path = sd_vae.vae_dict.get(vae)
                if vae_path and os.path.isfile(vae_path):
                    additional.append(vae_path)
                    print(f"{TAG} VAE: {vae}")

            # Save pre-Video Lab loading params so we can restore after
            # generation. Without this, switching to Canvas and generating
            # reloads WAN + text encoder instead of the Canvas model.
            # Only save on FIRST Video Lab load — subsequent loads within
            # the same session shouldn't overwrite the Canvas params.
            global _pre_video_loading_params
            current = getattr(sd_models.model_data, 'forge_loading_parameters', None)
            if _pre_video_loading_params is None and current is not None:
                _pre_video_loading_params = current

            sd_models.model_data.forge_loading_parameters = {
                "checkpoint_info": info,
                "additional_modules": additional,
                "unet_storage_dtype": None,
            }

            # GGUF models can't re-quantize LoRA weights back to their
            # native format. Force fp16 LoRA mode for GGUF checkpoints.
            from modules.shared import opts as _opts
            if info.filename.endswith(".gguf"):
                _opts.data["forge_unet_storage_dtype"] = "Automatic (fp16 LoRA)"
                print(f"{TAG} GGUF detected — forcing fp16 LoRA mode")

            # DO NOT save to config.json or update shared.opts.
            # Video Lab model loading is ephemeral — it must not
            # contaminate the main Studio config. When the user
            # switches back to a non-WAN model via Studio's main
            # model dropdown, it calls /studio/load_model which
            # sets additional_modules=[] and clears the WAN modules.

            await asyncio.to_thread(sd_models.forge_model_reload)

            print(f"{TAG} Model loaded: {info.title} "
                  f"({len(additional)} additional module(s))")
            return JSONResponse({"ok": True, "loaded": info.title})

        except Exception as e:
            traceback.print_exc()
            return JSONResponse({"error": str(e)}, status_code=500)

    @app.get("/studio/api/video/upscalers")
    async def video_upscalers():
        """List available upscaler models."""
        try:
            from modules import shared
            names = [u.name for u in shared.sd_upscalers
                     if u.name not in ("None", "Lanczos", "Nearest")]
            return JSONResponse(names)
        except Exception:
            return JSONResponse([])

    @app.post("/studio/api/video/last_frame")
    async def video_last_frame():
        """Extract the last frame from the most recent generation as base64 PNG."""
        try:
            frames = _last_gen_frames.get("frames")
            if not frames:
                return JSONResponse({"error": "No frames available"}, status_code=404)

            from PIL import Image
            last = frames[-1]
            if not isinstance(last, Image.Image):
                last = Image.fromarray(last)

            buf = io.BytesIO()
            last.save(buf, format="PNG")
            b64 = base64.b64encode(buf.getvalue()).decode()
            return JSONResponse({
                "image_b64": b64,
                "width": last.width,
                "height": last.height,
            })
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)


# =========================================================================
# UTILITY
# =========================================================================

def _import(module_name, attr):
    """Import helper — tries both bare and scripts-prefixed paths."""
    try:
        mod = __import__(module_name, fromlist=[attr])
    except ImportError:
        mod = __import__(f"scripts.{module_name}", fromlist=[attr])
    return getattr(mod, attr)


def get_video_status():
    """Check current model's video generation capability."""
    try:
        from modules import shared
        from backend import args

        is_wan = getattr(shared.sd_model, "is_wan", False)
        wan_active = args.dynamic_args.get("wan", False)
        info = getattr(shared.sd_model, "sd_checkpoint_info", None)
        name = info.name if info else "unknown"

        return {
            "video_capable": is_wan and wan_active,
            "is_wan": is_wan,
            "wan_active": wan_active,
            "model_name": name,
        }
    except Exception as e:
        return {"video_capable": False, "error": str(e)}


# =========================================================================
# AUTO-REGISTRATION
# =========================================================================
# Forge loads all .py files in scripts/ — this block runs at import time
# and registers the on_app_started callback so routes are available
# as soon as the server starts. Zero-touch: just drop the file in.

def _on_app_started(demo, app):
    try:
        register_video_routes(app)
    except Exception as e:
        print(f"{TAG} Route registration failed: {e}")
        traceback.print_exc()

try:
    from modules import scripts
    scripts.script_callbacks.on_app_started(_on_app_started)
    print(f"{TAG} Registered — routes activate on server start")
except Exception:
    pass  # Outside Forge context (direct import, testing, etc.)
