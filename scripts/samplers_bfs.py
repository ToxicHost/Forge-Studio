# samplers_bfs.py
# BFS — Bandwise Flow Sampler v2.0 (standalone Forge/A1111 sampler)
# Packaged with Forge Studio by ToxicHost & Moritz
# v2 architecture by Claude (Anthropic)
#
# Single-step (Euler) or two-step (Heun) flow integrator where each step's
# update is decomposed into N spatial-frequency bands via a Gaussian pyramid,
# reweighted by a smooth 2D gain surface g(band, timestep), then L2-renormed
# to preserve step energy.
#
# Two knobs control the gain surface:
#   structure_weight — extra emphasis on low-frequency bands early in sampling
#   detail_weight    — extra emphasis on high-frequency bands late in sampling
#
# Registers as "BFS (Bandwise Flow)" and "BFS Heun" in the sampler dropdown.

import torch
import torch.nn.functional as F
from dataclasses import dataclass

from modules import sd_samplers, sd_samplers_common
from modules.sd_samplers_kdiffusion import KDiffusionSampler

_BFS_VERSION = "2.0"
print(f"[BFS] v{_BFS_VERSION} loaded from:", __file__)


# ========================== Gaussian Pyramid ==========================

def _gaussian_blur(x: torch.Tensor, reps: int) -> torch.Tensor:
    """Apply 3x3 Gaussian blur `reps` times. Effective radius grows with reps."""
    k = torch.tensor([1.0, 2.0, 1.0], device=x.device, dtype=x.dtype)
    k = k[:, None] @ k[None, :]
    k = k / k.sum()
    k = k[None, None].expand(x.size(1), 1, 3, 3)
    out = x
    for _ in range(reps):
        out = F.conv2d(out, k, padding=1, groups=x.size(1))
    return out


def _pyramid_split(x: torch.Tensor, n_bands: int = 4) -> list[torch.Tensor]:
    """
    Decompose x into n_bands frequency bands via Gaussian pyramid.

    Band 0 = coarsest (structure/DC). Band N-1 = finest (edges/detail).
    Reconstruction: sum(bands) == x (exact to floating-point).

    Blur repetitions double per octave: 1, 2, 4, 8, ...
    Each band is the residual between adjacent blur levels.
    """
    if n_bands < 2:
        return [x]

    # Blur levels: lightest to heaviest
    blur_reps = [1 << i for i in range(n_bands - 1)]  # [1, 2, 4, 8, ...]
    blurs = [_gaussian_blur(x, r) for r in blur_reps]

    bands = []
    # Coarsest band: the most-blurred version
    bands.append(blurs[-1])
    # Intermediate bands: residuals between adjacent blur levels (coarse to fine)
    for i in range(len(blurs) - 1, 0, -1):
        bands.append(blurs[i - 1] - blurs[i])
    # Finest band: original minus lightest blur
    bands.append(x - blurs[0])

    return bands


# ========================== Gain Surface ==========================

def _progress(sigmas: torch.Tensor, sigma: torch.Tensor) -> float:
    """
    Map current sigma to [0, 1] progress.
    0.0 = start of sampling (high sigma, noisy).
    1.0 = end of sampling (low sigma, clean).
    """
    s_max = float(sigmas.max())
    s_min = float(sigmas[sigmas > 0].min()) if (sigmas > 0).any() else 0.0
    s = float(sigma.max()) if sigma.dim() > 0 else float(sigma)
    s = max(min(s, s_max), s_min)
    rng = s_max - s_min
    if rng < 1e-12:
        return 1.0
    return (s_max - s) / rng


def _band_gains(n_bands: int, t: float, structure_w: float, detail_w: float) -> list[float]:
    """
    Compute per-band gain multipliers from the continuous gain surface.

    g(p, t) = 1.0 + structure_w * (1 - p) * (1 - t) + detail_w * p * t

    where p = band_position [0=coarsest, 1=finest], t = progress [0=early, 1=late].

    Early:  low bands boosted by structure_w, high bands ~1.0
    Late:   high bands boosted by detail_w, low bands ~1.0
    """
    gains = []
    for i in range(n_bands):
        p = i / (n_bands - 1) if n_bands > 1 else 0.5
        g = 1.0 + structure_w * (1.0 - p) * (1.0 - t) + detail_w * p * t
        gains.append(g)
    return gains


# ========================== Renormalization ==========================

def _l2_norm(t: torch.Tensor, per_channel: bool = False, eps: float = 1e-8) -> torch.Tensor:
    dims = (2, 3) if per_channel else (1, 2, 3)
    return torch.sqrt((t * t).sum(dim=dims, keepdim=True) + eps)


def _renorm(src: torch.Tensor, ref: torch.Tensor, per_channel: bool = False) -> torch.Tensor:
    """Rescale src to match the L2 norm of ref."""
    sn = _l2_norm(src, per_channel=per_channel)
    rn = _l2_norm(ref, per_channel=per_channel)
    return src * (rn / sn)


# ========================== Parameters ==========================

@dataclass
class BFSParams:
    n_bands: int = 4             # Pyramid decomposition bands (2-6 reasonable)
    structure_weight: float = 0.15  # Low-freq boost early in sampling
    detail_weight: float = 0.15    # High-freq boost late in sampling
    per_channel_norm: bool = False  # Per-channel vs global L2 renorm


def _load_params(extra_args) -> BFSParams:
    """Load parameters from extra_args overrides or defaults."""
    p = BFSParams()
    if not isinstance(extra_args, dict):
        return p
    p.n_bands = int(extra_args.get("bfs_bands", p.n_bands))
    p.structure_weight = float(extra_args.get("bfs_structure", p.structure_weight))
    p.detail_weight = float(extra_args.get("bfs_detail", p.detail_weight))
    p.per_channel_norm = bool(extra_args.get("bfs_per_channel_norm", p.per_channel_norm))
    return p


# ========================== Sampler Core ==========================

def _extract_sigmas(sigmas, kwargs):
    """Resolve sigmas from argument or kwargs."""
    if sigmas is not None:
        return sigmas
    for key in ("sigmas", "sigma_sched"):
        if key in kwargs:
            return kwargs.pop(key)
    raise ValueError("BFS requires `sigmas`")


def _apply_bands(delta: torch.Tensor, params: BFSParams, t: float) -> torch.Tensor:
    """Decompose delta into frequency bands, apply gain surface, renormalize."""
    bands = _pyramid_split(delta, params.n_bands)
    gains = _band_gains(params.n_bands, t, params.structure_weight, params.detail_weight)

    tuned = sum(g * b for g, b in zip(gains, bands))
    return _renorm(tuned, delta, per_channel=params.per_channel_norm)


@torch.no_grad()
def sample_bfs(model, x, sigmas=None, extra_args=None, callback=None, **kwargs):
    """
    Euler integrator with bandwise frequency redistribution.
    """
    sigmas = _extract_sigmas(sigmas, kwargs)
    params = _load_params(extra_args)
    s_in = torch.ones([x.shape[0]], device=x.device, dtype=x.dtype)
    steps = sigmas.shape[0] - 1

    for i in range(steps):
        sigma, sigma_next = sigmas[i], sigmas[i + 1]

        denoised = model(x, sigma * s_in, **(extra_args or {}))
        d = (x - denoised) / sigma
        delta = d * (sigma_next - sigma)

        t = _progress(sigmas, sigma)
        x = x + _apply_bands(delta, params, t)

        if callable(callback):
            callback({"i": i, "denoised": denoised})

    return x


@torch.no_grad()
def sample_bfs_heun(model, x, sigmas=None, extra_args=None, callback=None, **kwargs):
    """
    Heun (second-order) integrator with bandwise frequency redistribution.
    Two model evaluations per step for a better estimate of the update direction.
    Band decomposition is applied to the averaged Euler+Heun update.
    """
    sigmas = _extract_sigmas(sigmas, kwargs)
    params = _load_params(extra_args)
    s_in = torch.ones([x.shape[0]], device=x.device, dtype=x.dtype)
    steps = sigmas.shape[0] - 1

    for i in range(steps):
        sigma, sigma_next = sigmas[i], sigmas[i + 1]
        h = sigma_next - sigma

        # First evaluation (Euler direction)
        denoised_1 = model(x, sigma * s_in, **(extra_args or {}))
        d1 = (x - denoised_1) / sigma

        # Euler prediction
        x_euler = x + d1 * h

        # Second evaluation at predicted point (Heun correction)
        if sigma_next > 0:
            denoised_2 = model(x_euler, sigma_next * s_in, **(extra_args or {}))
            d2 = (x_euler - denoised_2) / sigma_next
            # Average the two directions
            d_avg = (d1 + d2) / 2.0
        else:
            # Last step — no second eval needed, sigma_next=0 means we're done
            d_avg = d1

        delta = d_avg * h
        t = _progress(sigmas, sigma)
        x = x + _apply_bands(delta, params, t)

        if callable(callback):
            callback({"i": i, "denoised": denoised_1})

    return x


# ========================== Registration ==========================

def _dedupe_and_register(entries):
    """Register sampler(s) with Forge/A1111, avoiding duplicates."""
    samplers_data = []
    existing_names = {s.name for s in sd_samplers.all_samplers}
    existing_aliases = {a for s in sd_samplers.all_samplers
                        for a in (getattr(s, "aliases", []) or [])}

    for label, func, aliases, options in entries:
        if label in existing_names or any(a in existing_aliases for a in (aliases or [])):
            continue

        func_name = func.__name__
        try:
            import k_diffusion.sampling as k_sampling
            setattr(k_sampling, func_name, func)
        except ImportError:
            pass

        ctor = (lambda model, fn=func_name: KDiffusionSampler(fn, model))
        sdata = sd_samplers_common.SamplerData(label, ctor, aliases or [], options or {})
        samplers_data.append(sdata)

    if not samplers_data:
        print("[BFS] nothing to register (already present)")
        return

    sd_samplers.all_samplers.extend(samplers_data)
    sd_samplers.all_samplers_map = {x.name: x for x in sd_samplers.all_samplers}
    if hasattr(sd_samplers, "set_samplers"):
        sd_samplers.set_samplers()

    print("[BFS] registered:", [s.name for s in samplers_data])


_ENTRIES = [
    ("BFS (Bandwise Flow)", sample_bfs, ["bfs"], {
        "scheduler": "karras",
        "uses_ensd": False,
        "second_order": False,
    }),
    ("BFS Heun", sample_bfs_heun, ["bfs_heun"], {
        "scheduler": "karras",
        "uses_ensd": False,
        "second_order": True,
    }),
]

_dedupe_and_register(_ENTRIES)
