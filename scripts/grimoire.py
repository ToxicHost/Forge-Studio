# grimoire_harmonic.py — Grimoire (Harmonic Integrator)
# A barebones, extension-friendly sampler that integrates using a harmonic-mean mid-sigma.
# - Scheduler-agnostic: consumes whatever `sigmas` Forge provides (Karras, expo, custom).
# - Deterministic: no extra noise injection, no hidden normalization, no clipping.
# - Extension-safe: does not touch Script hooks; Forge runs your extensions as usual.
#
# Drop this anywhere Forge loads (e.g., extensions/Grimoire/scripts/grimoire_harmonic.py)

from __future__ import annotations
import torch
from modules import sd_samplers, sd_samplers_common
from modules.sd_samplers_kdiffusion import KDiffusionSampler

__VER__ = "2025-10-22"
print(f"[Grimoire] Harmonic Integrator v{__VER__} loaded from:", __file__)

# ----------------------- helpers -----------------------

def _safe(t: torch.Tensor) -> torch.Tensor:
    return torch.nan_to_num(t, nan=0.0, posinf=0.0, neginf=0.0)

def _to_d(x: torch.Tensor, sigma, denoised: torch.Tensor, eps: float = 1e-8) -> torch.Tensor:
    # k-diffusion ODE direction: (x - f_theta(x, sigma)) / sigma
    if not torch.is_tensor(sigma):
        sigma = torch.tensor(float(sigma), device=x.device, dtype=x.dtype)
    sigma = sigma.clamp_min(eps)
    while sigma.ndim < x.ndim:
        sigma = sigma.view(-1, *([1] * (x.ndim - 1)))
    return (x - denoised) / sigma

def _harmonic_mid(s0: torch.Tensor, s1: torch.Tensor, eps: float = 1e-12) -> torch.Tensor:
    # Harmonic mean: 2*s0*s1 / (s0 + s1)
    denom = (s0 + s1).clamp_min(eps)
    return (2.0 * s0 * s1) / denom

# ----------------------- core sampler -----------------------

@torch.no_grad()
def sample_grimoire_harmonic(model, x, *, sigmas=None, extra_args=None, callback=None, disable=False, **kwargs):
    """
    Grimoire (Harmonic) — one clean midpoint correction per step:
      1) Denoise at s0, compute d0
      2) Advance to harmonic mid sigma (sh), denoise there → dh
      3) Final update with dh across (s1 - s0)
    This provides a distinctive, smooth evolution that handles large sigma gaps gracefully.
    """
    if sigmas is None:
        sigmas = kwargs.get("sigmas") or kwargs.get("sigma_sched")
        if sigmas is None:
            raise ValueError("[Grimoire Harmonic] missing sigmas")

    steps = int(sigmas.shape[0] - 1)
    if steps <= 0:
        return x

    device, dtype = x.device, x.dtype
    ea   = extra_args or {}
    s_in = torch.ones((x.shape[0],), device=device, dtype=dtype)

    def _cb(i: int, s0, s1, denoised=None):
        if callable(callback):
            try:
                callback({"i": i, "sigma": s0, "sigma_next": s1, "x": x, "denoised": denoised})
            except Exception:
                pass  # stay quiet; extensions may still rely on callback existence

    for i in range(steps):
        s0 = sigmas[i].to(dtype)
        s1 = sigmas[i + 1].to(dtype)
        h  = (s1 - s0)

        # 1) Denoise at s0
        denoise_0 = model(x, s0 * s_in, **ea)

        # If next sigma is exactly zero, snap to denoise and finish
        if float(s1) == 0.0:
            x = _safe(denoise_0)
            _cb(i, s0, s1, denoise_0)
            break

        # Predict direction at s0
        d0 = _to_d(x, s0, denoise_0)

        # 2) Harmonic midpoint
        sh = _harmonic_mid(s0, s1)
        x_h = x + d0 * (sh - s0)  # move to harmonic mid
        denoise_h = model(x_h, sh * s_in, **ea)
        dh = _to_d(x_h, sh, denoise_h)

        # 3) Final update using mid-direction across full step
        x = x + dh * h

        x = _safe(x)
        _cb(i, s0, s1, denoise_0)

    return x

# ----------------------- registration -----------------------

def _dedupe_and_register(entries):
    samplers_to_add = []
    existing = {s.name for s in sd_samplers.all_samplers}
    existing_aliases = {a for s in sd_samplers.all_samplers for a in (getattr(s, "aliases", []) or [])}

    for label, func, aliases, options in entries:
        if label in existing or any(a in existing_aliases for a in (aliases or [])):
            continue
        ctor  = (lambda model, f=func: KDiffusionSampler(f, model))
        sdata = sd_samplers_common.SamplerData(label, ctor, aliases or [], options or {})
        samplers_to_add.append(sdata)

    if not samplers_to_add:
        print("[Grimoire] harmonic sampler already registered")
        return

    sd_samplers.all_samplers.extend(samplers_to_add)
    sd_samplers.all_samplers_map = {x.name: x for x in sd_samplers.all_samplers}
    if hasattr(sd_samplers, "set_samplers"):
        sd_samplers.set_samplers()

    print("[Grimoire] registered:", [s.name for s in samplers_to_add])

_ENTRIES = [
    (
        "Grimoire (Harmonic)",
        sample_grimoire_harmonic,
        ["grimoire-h", "grimoire harmonic", "grim-h"],
        {
            "scheduler": "auto",     # consume provided sigmas as-is
            "uses_ensd": False,
            "second_order": True     # midpoint correction
        },
    ),
]

_dedupe_and_register(_ENTRIES)
