# parasite.py
# Parasite - Vortex Integrator
# Standalone spiral integrator with sign-corrected steps, coherence gating, and edge protection.

import math
import torch
import torch.nn.functional as F

from modules import sd_samplers, sd_samplers_common
from modules.sd_samplers_kdiffusion import KDiffusionSampler

__VER__ = "1.0.0"
print(f"[Parasite] v{__VER__} loaded from:", __file__)

# ----------------------- helpers -----------------------

def _rms(t, eps=1e-8):
    return torch.sqrt((t.float()**2).mean()) + eps

def _normalize(v, eps=1e-8):
    n = v.flatten(1).norm(dim=1).clamp_min(eps).view(-1,1,1,1)
    return v / n

def _blur3(x):
    k = torch.tensor([[1.,2.,1.],
                      [2.,4.,2.],
                      [1.,2.,1.]], device=x.device, dtype=x.dtype)
    k = (k / k.sum()).view(1,1,3,3)
    w = k.expand(x.shape[1],1,3,3)
    return F.conv2d(x, w, padding=1, groups=x.shape[1])

def _blur5(x):
    return _blur3(_blur3(x))

def _dog_hp(x, a=1.0, b=0.90):
    lo1 = _blur3(x)
    lo2 = _blur5(x)
    return a*(x - lo1) + b*(lo1 - lo2)

def _laplace(x):
    k = torch.tensor([[0.,-1.,0.],
                      [-1.,4.,-1.],
                      [0.,-1.,0.]], device=x.device, dtype=x.dtype).view(1,1,3,3)
    w = k.expand(x.shape[1],1,3,3)
    return F.conv2d(x, w, padding=1, groups=x.shape[1])

def _lum(x):
    return x.mean(dim=1, keepdim=True)

def _edge_strength(y):
    gx = F.pad(y, (0,1,0,0))[:, :, :, 1:] - F.pad(y, (1,0,0,0))[:, :, :, :-1]
    gy = F.pad(y, (0,0,0,1))[:, :, 1:, :] - F.pad(y, (0,0,1,0))[:, :, :-1, :]
    g = torch.sqrt(gx*gx + gy*gy)
    g = g / (g.amax(dim=(2,3), keepdim=True).clamp_min(1e-6))
    return g

def _cos_sim(a, b, eps=1e-8):
    ab = (a*b).flatten(1).sum(dim=1)
    na = a.flatten(1).norm(dim=1).clamp_min(eps)
    nb = b.flatten(1).norm(dim=1).clamp_min(eps)
    return (ab / (na*nb + eps)).view(-1,1,1,1)

def _safe(t):
    return torch.nan_to_num(t, nan=0.0, posinf=0.0, neginf=0.0)

def _to_d(x, sigma, denoised, eps=1e-5):
    if not torch.is_tensor(sigma):
        sigma = torch.tensor(float(sigma), device=x.device, dtype=x.dtype)
    sigma = torch.clamp(sigma, min=eps)
    return (x - denoised) / sigma

# ----------------------- core implementation -----------------------

def _sample_parasite_core(model, x, *, sigmas, preset, extra_args=None, callback=None):
    steps = int(sigmas.shape[0] - 1)
    dev, dtype = x.device, x.dtype
    ea = extra_args or {}
    s_in = torch.ones((x.shape[0],), device=dev, dtype=dtype)

    theta_max_deg   = float(preset["theta_max_deg"])
    theta_pow       = float(preset["theta_pow"])
    start_swirl_t   = float(preset["start_swirl_t"])
    end_swirl_t     = float(preset["end_swirl_t"])
    omega_cycles    = float(preset["omega_cycles"])
    edge_guard      = float(preset["edge_guard"])
    edge_thresh     = float(preset["edge_thresh"])
    tex_bias_gain   = float(preset["tex_bias_gain"])
    ema_tangential  = float(preset["ema_tangential"])
    trust_tau       = float(preset["trust_tau"])
    cohere_floor    = float(preset["cohere_floor"])
    cohere_ema      = float(preset["cohere_ema"])
    anti_ring_beta  = float(preset["anti_ring_beta"])
    use_lap_blend   = bool(preset.get("use_lap_blend", False))
    lap_blend_ratio = float(preset.get("lap_blend_ratio", 0.3))
    sigma_damp      = bool(preset.get("sigma_damp", False))
    sigma_damp_pow  = float(preset.get("sigma_damp_pow", 0.6))

    theta_max = math.radians(theta_max_deg)

    v_ema = None
    tangential_ema = None

    for i in range(steps):
        t   = i / max(1, (steps - 1))
        s0  = sigmas[i].to(dtype)
        s1  = sigmas[i+1].to(dtype)
        h   = (s1 - s0)
        sign_h = -1.0 if float(h) < 0.0 else (1.0 if float(h) > 0.0 else 0.0)

        x0 = model(x, s0 * s_in, **ea)

        if float(s1) == 0.0:
            x = _safe(x0)
            if callable(callback):
                try: callback({"i": i, "denoised": None})
                except Exception: pass
            break

        d = _safe(_to_d(x, s0, x0))
        d_mag = _rms(d)
        u = _normalize(d)

        euler_delta = d * h
        euler_rms = _rms(euler_delta)

        lo   = _blur3(x0)
        hp   = _dog_hp(x0)
        if use_lap_blend:
            lap  = _laplace(x0 - lo)
            tex  = _safe(((1.0 - lap_blend_ratio) * hp + lap_blend_ratio * lap) * tex_bias_gain)
        else:
            tex  = _safe(hp * tex_bias_gain)

        t_hat = _normalize(tex)
        dot = (t_hat * u).flatten(1).sum(dim=1).view(-1,1,1,1)
        v_orth = _normalize(_safe(t_hat - dot * u))

        if v_ema is None:
            v_ema = v_orth
            coherence = torch.zeros_like(_lum(x0))
        else:
            coherence = _cos_sim(v_orth, v_ema).abs().clamp(0, 1)
            v_ema = _normalize(_safe((1.0 - cohere_ema) * v_ema + cohere_ema * v_orth))

        if t <= start_swirl_t or t >= end_swirl_t:
            swirl_scale = 0.0
        else:
            u_t = (t - start_swirl_t) / max(1e-6, (end_swirl_t - start_swirl_t))
            swirl_scale = 1.0 - (u_t ** theta_pow)

        theta = theta_max * swirl_scale

        v_mix = v_orth
        if omega_cycles and swirl_scale > 0.0:
            phase = 2.0 * math.pi * omega_cycles * t
            tex2  = _normalize(_safe(_laplace(lo - _blur3(lo))))
            tex2  = _safe(tex2 - (tex2 * u).flatten(1).sum(dim=1).view(-1,1,1,1) * u)
            tex2  = _safe(tex2 - (tex2 * v_orth).flatten(1).sum(dim=1).view(-1,1,1,1) * v_orth)
            tex2  = _normalize(_safe(tex2))
            v_mix = _normalize(_safe(math.cos(phase) * v_orth + math.sin(phase) * tex2))

        E = _edge_strength(_lum(x0))
        edge_soft = (E - edge_thresh).clamp(min=0) / max(1e-6, 1.0 - edge_thresh)
        edge_soft = edge_soft.clamp(0, 1)

        sin_gate = 1.0 - edge_guard * edge_soft
        coh_gate = ((coherence - cohere_floor) / max(1e-6, (1.0 - cohere_floor))).clamp(0.0, 1.0)

        cos_th = math.cos(theta); sin_th = math.sin(theta)
        if sigma_damp:
            sigma_rel = float(s0 / (sigmas[0] + 1e-8))
            swirl_sigma_damp = sigma_rel ** sigma_damp_pow
        else:
            swirl_sigma_damp = 1.0

        v_term = v_mix * (sin_th * swirl_sigma_damp)
        if ema_tangential > 0.0:
            tangential_ema = v_term if tangential_ema is None else (
                (1.0 - ema_tangential) * tangential_ema + ema_tangential * v_term
            )
            v_term = tangential_ema
        v_term = v_term * sin_gate * coh_gate

        dir_combo = _safe(cos_th * u + v_term)

        beta = (edge_soft ** 1.5) * anti_ring_beta
        dir_combo = _normalize(_safe((1.0 - beta) * dir_combo + beta * u))

        target_mag = abs(float(h)) * float(d_mag)
        combo_rms  = _rms(dir_combo)
        if float(combo_rms) > 0.0:
            dir_combo = dir_combo * (target_mag / float(combo_rms))

        add_rms = _rms(dir_combo)
        if float(add_rms) > 0.0:
            cap = (trust_tau * float(euler_rms)) / float(add_rms)
            cap = max(0.0, min(1.0, cap))
            dir_combo = dir_combo * cap

        dir_combo = dir_combo * float(sign_h)

        x = _safe(x + dir_combo)

        if callable(callback):
            try: callback({"i": i, "denoised": x0})
            except Exception: pass

    return x

# ----------------------- preset -----------------------

_PARASITE_PRESET = dict(
    theta_max_deg = 38.0,
    theta_pow     = 2.1,
    start_swirl_t = 0.22,
    end_swirl_t   = 0.76,
    omega_cycles  = 0.0,
    edge_guard    = 0.72,
    edge_thresh   = 0.11,
    tex_bias_gain = 0.59,
    ema_tangential= 0.00,
    trust_tau     = 1.03,
    cohere_floor  = 0.35,
    cohere_ema    = 0.30,
    anti_ring_beta= 0.62,
    use_lap_blend = True,
    lap_blend_ratio = 0.15,
    sigma_damp    = True,
    sigma_damp_pow= 0.6,
)

@torch.no_grad()
def sample_parasite(model, x, *, sigmas=None, extra_args=None, callback=None, disable=False, **kwargs):
    if sigmas is None:
        sigmas = kwargs.get("sigmas") or kwargs.get("sigma_sched")
        if sigmas is None:
            raise ValueError("Parasite requires `sigmas`")
    return _sample_parasite_core(model, x, sigmas=sigmas, preset=_PARASITE_PRESET,
                                 extra_args=extra_args, callback=callback)

# ----------------------- registration -----------------------

def _dedupe_and_register(entries):
    samplers_data = []
    existing_names   = {s.name for s in sd_samplers.all_samplers}
    existing_aliases = {a for s in sd_samplers.all_samplers for a in (getattr(s, "aliases", []) or [])}

    for label, func, aliases, options in entries:
        if label in existing_names or any(a in existing_aliases for a in (aliases or [])):
            continue
        ctor = (lambda model, f=func: KDiffusionSampler(f, model))
        sdata = sd_samplers_common.SamplerData(label, ctor, aliases or [], options or {})
        samplers_data.append(sdata)

    if not samplers_data:
        print("[Parasite] nothing to register (already present)")
        return

    sd_samplers.all_samplers.extend(samplers_data)
    sd_samplers.all_samplers_map = {x.name: x for x in sd_samplers.all_samplers}
    if hasattr(sd_samplers, "set_samplers"):
        sd_samplers.set_samplers()

    print("[Parasite] registered:", [s.name for s in samplers_data])

_ENTRIES = [
    ("Parasite", sample_parasite, ["parasite", "vortex"], {
        "scheduler": "karras", "uses_ensd": False, "second_order": False
    }),
]

_dedupe_and_register(_ENTRIES)
