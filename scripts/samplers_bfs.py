# samplers_bfs.py
# BFS — Bandwise Flow Sampler (standalone Forge/A1111 sampler)
# Packaged with Forge Studio by ToxicHost & Moritz
#
# Euler-like single-step integrator where each step's update is split into
# low/mid/high spatial-frequency bands via a Laplacian pyramid, reweighted
# (low emphasis early, high emphasis late), then L2-renormalized to preserve
# step energy. No CFG/schedule patching, no temporal memory.
#
# Registers as "BFS (Bandwise Flow)" in the sampler dropdown.

import torch
from dataclasses import dataclass
import torch.nn.functional as F

from modules import sd_samplers, sd_samplers_common
from modules.sd_samplers_kdiffusion import KDiffusionSampler

_BFS_VERSION = "2.0"
print(f"[BFS] v{_BFS_VERSION} loaded from:", __file__)


# ===================== helpers =====================

def _laplacian_pyr_split(x: torch.Tensor):
    """Split tensor into low/mid/high frequency bands via 3x3 blur pyramid."""
    k = torch.tensor([1., 2., 1.], device=x.device, dtype=x.dtype)
    k = (k[:, None] @ k[None, :]); k = k / k.sum()
    k = k[None, None, :, :]

    def blur(img, reps=1):
        out = img
        for _ in range(reps):
            out = F.conv2d(out, k.expand(img.size(1), 1, 3, 3),
                           padding=1, groups=img.size(1))
        return out

    low = blur(x, reps=2)
    mid_approx = blur(x, reps=1)
    high = x - mid_approx
    mid = mid_approx - low
    return low, mid, high


def _l2_norm(t: torch.Tensor, per_channel=False, eps=1e-8):
    if per_channel:
        return torch.sqrt((t * t).sum(dim=(2, 3), keepdim=True) + eps)
    return torch.sqrt((t * t).sum(dim=(1, 2, 3), keepdim=True) + eps)


def _renorm(src: torch.Tensor, ref: torch.Tensor, per_channel=False):
    """Rescale src to have the same L2 norm as ref."""
    try:
        sn = _l2_norm(src, per_channel=per_channel)
        rn = _l2_norm(ref, per_channel=per_channel)
        return src * (rn / (sn + 1e-8))
    except Exception:
        return src


def _sigma_01(sigmas: torch.Tensor, sigma_val) -> float:
    """Map current sigma to [0..1] progress: 0 = early/noisy, 1 = late/clean."""
    try:
        smax = float(sigmas.max())
        smin = float(sigmas.min())
    except Exception:
        smax, smin = 1.0, 0.0
    s = sigma_val
    if isinstance(s, (list, tuple)):
        s = s[0]
    if torch.is_tensor(s):
        s = float(s.max().detach().cpu())
    s = max(min(s, smax), smin)
    return (s - smin) / (smax - smin + 1e-12) if smax != smin else 1.0


# ===================== parameters =====================

@dataclass
class BFSParams:
    low_gain_base: float = 1.10     # Low-freq gain (structure)
    mid_gain_base: float = 1.00     # Mid-freq gain (features)
    high_gain_base: float = 0.95    # High-freq gain (detail/edges)
    late_high_boost: float = 0.10   # Extra high-freq boost in later steps
    alpha: float = 0.5              # Low emphasis exponent (early/noisy)
    beta: float = 1.0               # High emphasis exponent (late/clean)
    per_channel_norm: bool = False   # Per-channel vs global L2 renorm


def _load_params(extra_args) -> BFSParams:
    """Load parameters from extra_args overrides or defaults."""
    params = BFSParams()
    if isinstance(extra_args, dict):
        params.low_gain_base = float(extra_args.get("bfs_low_gain", params.low_gain_base))
        params.mid_gain_base = float(extra_args.get("bfs_mid_gain", params.mid_gain_base))
        params.high_gain_base = float(extra_args.get("bfs_high_gain", params.high_gain_base))
        params.late_high_boost = float(extra_args.get("bfs_late_high", params.late_high_boost))
        params.alpha = float(extra_args.get("bfs_alpha", params.alpha))
        params.beta = float(extra_args.get("bfs_beta", params.beta))
        params.per_channel_norm = bool(extra_args.get("bfs_per_channel_norm", params.per_channel_norm))
    return params


# ===================== sampler core =====================

@torch.no_grad()
def sample_bfs(model, x, sigmas=None, extra_args=None, callback=None, **kwargs):
    """
    Euler-like single-step integrator with bandwise frequency redistribution.
    model(x, sigma) is the CFG-wrapped denoiser provided by Forge/A1111.
    """
    if sigmas is None:
        if kwargs.get("sigmas") is not None:
            sigmas = kwargs.pop("sigmas")
        elif kwargs.get("sigma_sched") is not None:
            sigmas = kwargs.pop("sigma_sched")
        else:
            raise ValueError("BFS requires `sigmas`")

    params = _load_params(extra_args)
    device, dtype = x.device, x.dtype
    s_in = torch.ones([x.shape[0]], device=device, dtype=dtype)

    steps = int(sigmas.shape[0] - 1)
    for i in range(steps):
        sigma = sigmas[i]
        sigma_next = sigmas[i + 1]

        denoised = model(x, sigma * s_in, **(extra_args or {}))
        d = (x - denoised) / (sigma + 1e-8)            # Euler direction
        h = sigma_next - sigma                           # negative step
        delta = d * h                                    # vanilla Euler update

        # Progress 0..1: 0 = early/noisy, 1 = late/clean
        s01 = _sigma_01(sigmas, sigma)
        g_low = params.low_gain_base * ((1.0 - s01) ** params.alpha)
        g_mid = params.mid_gain_base
        g_high = params.high_gain_base + params.late_high_boost * (s01 ** params.beta)

        # Split into frequency bands, reweight, renormalize
        d_low, d_mid, d_high = _laplacian_pyr_split(delta)
        delta_tuned = g_low * d_low + g_mid * d_mid + g_high * d_high
        delta_tuned = _renorm(delta_tuned, delta, per_channel=params.per_channel_norm)

        x = x + delta_tuned

        if callable(callback):
            try:
                callback({"i": i, "denoised": None})
            except Exception:
                pass

    return x


# ===================== registration =====================

def _dedupe_and_register(entries):
    """Register sampler(s) with Forge/A1111, avoiding duplicates."""
    samplers_data = []
    existing_names = {s.name for s in sd_samplers.all_samplers}
    existing_aliases = {a for s in sd_samplers.all_samplers
                        for a in (getattr(s, "aliases", []) or [])}

    for label, func, aliases, options in entries:
        if label in existing_names or any(a in existing_aliases for a in (aliases or [])):
            continue

        # Patch the function onto k_diffusion.sampling so KDiffusionSampler
        # can find it by name (it uses getattr internally)
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
]

_dedupe_and_register(_ENTRIES)
