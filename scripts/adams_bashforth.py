# adams_bashforth.py — Adams-Bashforth Extrapolation Sampler
# Multi-step explicit method achieving higher-order accuracy with single eval per step.
# Uses derivative history to predict trajectory, avoiding the 2-eval cost of Heun/RK2.

from __future__ import annotations
import torch
from typing import List, Optional

from modules import sd_samplers, sd_samplers_common
from modules.sd_samplers_kdiffusion import KDiffusionSampler

__VER__ = "2025-01-01"
print(f"[Adams-Bashforth] v{__VER__} loaded from:", __file__)

# ===================== Helpers =====================

def _safe(t: torch.Tensor) -> torch.Tensor:
    """Remove NaN/Inf values."""
    return torch.nan_to_num(t, nan=0.0, posinf=0.0, neginf=0.0)

def _to_d(x: torch.Tensor, sigma, denoised: torch.Tensor, eps: float = 1e-8) -> torch.Tensor:
    """
    Convert denoised prediction to velocity (ODE direction).
    d = (x - denoised) / sigma
    """
    if not torch.is_tensor(sigma):
        sigma = torch.tensor(float(sigma), device=x.device, dtype=x.dtype)
    sigma = sigma.clamp_min(eps)
    
    # Ensure sigma has correct shape for broadcasting
    while sigma.ndim < x.ndim:
        sigma = sigma.view(-1, *([1] * (x.ndim - 1)))
    
    return (x - denoised) / sigma

# ===================== Adams-Bashforth Formulas =====================

def ab_step_2nd_order(x: torch.Tensor, h: torch.Tensor, 
                      d_history: List[torch.Tensor]) -> torch.Tensor:
    """
    2nd-order Adams-Bashforth:
    x_{i+1} = x_i + (h/2)[3d_i - d_{i-1}]
    
    Requires 1 previous derivative.
    """
    d_curr = d_history[-1]
    d_prev = d_history[-2]
    
    return x + (h / 2.0) * (3.0 * d_curr - d_prev)

def ab_step_3rd_order(x: torch.Tensor, h: torch.Tensor,
                      d_history: List[torch.Tensor]) -> torch.Tensor:
    """
    3rd-order Adams-Bashforth:
    x_{i+1} = x_i + (h/12)[23d_i - 16d_{i-1} + 5d_{i-2}]
    
    Requires 2 previous derivatives.
    """
    d_curr = d_history[-1]
    d_prev1 = d_history[-2]
    d_prev2 = d_history[-3]
    
    return x + (h / 12.0) * (23.0 * d_curr - 16.0 * d_prev1 + 5.0 * d_prev2)

def ab_step_4th_order(x: torch.Tensor, h: torch.Tensor,
                      d_history: List[torch.Tensor]) -> torch.Tensor:
    """
    4th-order Adams-Bashforth:
    x_{i+1} = x_i + (h/24)[55d_i - 59d_{i-1} + 37d_{i-2} - 9d_{i-3}]
    
    Requires 3 previous derivatives.
    """
    d_curr = d_history[-1]
    d_prev1 = d_history[-2]
    d_prev2 = d_history[-3]
    d_prev3 = d_history[-4]
    
    return x + (h / 24.0) * (
        55.0 * d_curr - 59.0 * d_prev1 + 37.0 * d_prev2 - 9.0 * d_prev3
    )

# ===================== Initialization Methods =====================

def init_step_euler(model, x: torch.Tensor, sigma, sigma_next, extra_args) -> tuple:
    """
    Euler initialization step.
    Faster but less accurate for initialization phase.
    """
    s_in = torch.ones((x.shape[0],), device=x.device, dtype=x.dtype)
    
    denoised = model(x, sigma * s_in, **extra_args)
    d = _to_d(x, sigma, denoised)
    
    h = sigma_next - sigma
    x_next = x + d * h
    
    return _safe(x_next), d

def init_step_heun(model, x: torch.Tensor, sigma, sigma_next, extra_args) -> tuple:
    """
    Heun initialization step (2nd-order Runge-Kutta).
    More accurate but requires 2 model evals per step.
    Returns (x_next, d_effective) where d_effective is the averaged direction
    actually used for the step — this is what AB needs in its history.
    """
    s_in = torch.ones((x.shape[0],), device=x.device, dtype=x.dtype)
    h = sigma_next - sigma
    
    # First evaluation
    denoised = model(x, sigma * s_in, **extra_args)
    d = _to_d(x, sigma, denoised)
    
    # Euler predictor
    x_euler = x + d * h
    
    # Second evaluation at predicted point
    if sigma_next > 0:
        denoised_next = model(x_euler, sigma_next * s_in, **extra_args)
        d_next = _to_d(x_euler, sigma_next, denoised_next)
        
        # Heun corrector (average of slopes)
        d_avg = (d + d_next) / 2.0
        x_next = x + d_avg * h
        return _safe(x_next), d_avg
    else:
        x_next = x_euler
        return _safe(x_next), d

# ===================== Core Sampler =====================

@torch.no_grad()
def sample_adams_bashforth(model, x, sigmas=None, extra_args=None, 
                           callback=None, disable=False, 
                           ab_order: int = 4, ab_init_method: str = 'heun',
                           **kwargs):
    """
    Adams-Bashforth explicit multi-step sampler.
    
    Achieves higher-order accuracy (2nd/3rd/4th) with only one model evaluation
    per step after initialization, by using history of past derivatives.
    
    Args:
        model: The CFG-wrapped denoiser
        x: Initial latent [B, C, H, W]
        sigmas: Noise schedule [steps+1]
        extra_args: Extra arguments for model (contains cond_scale, etc)
        callback: Optional callback for progress
        ab_order: Order of Adams-Bashforth method (2, 3, or 4)
        ab_init_method: Initialization method ('heun' or 'euler')
    
    Returns:
        Denoised latent
    """
    if sigmas is None:
        sigmas = kwargs.get("sigmas") or kwargs.get("sigma_sched")
        if sigmas is None:
            raise ValueError("[Adams-Bashforth] missing sigmas")
    
    # Validate order
    if ab_order not in [2, 3, 4]:
        print(f"[Adams-Bashforth] Invalid order {ab_order}, defaulting to 4")
        ab_order = 4
    
    # Validate init method
    if ab_init_method not in ['heun', 'euler']:
        print(f"[Adams-Bashforth] Invalid init method '{ab_init_method}', defaulting to 'heun'")
        ab_init_method = 'heun'
    
    steps = int(sigmas.shape[0] - 1)
    if steps <= 0:
        return x
    
    device, dtype = x.device, x.dtype
    ea = extra_args or {}
    
    # Choose initialization function
    init_fn = init_step_heun if ab_init_method == 'heun' else init_step_euler
    
    # Choose AB stepping function based on order
    ab_step_fn = {
        2: ab_step_2nd_order,
        3: ab_step_3rd_order,
        4: ab_step_4th_order,
    }[ab_order]
    
    # History storage for derivatives
    # Need (order - 1) previous derivatives
    history_size = ab_order
    d_history: List[torch.Tensor] = []
    
    def _cb(i: int, s0, s1, denoised=None):
        """Callback wrapper."""
        if callable(callback):
            try:
                callback({
                    "i": i, 
                    "sigma": s0, 
                    "sigma_next": s1, 
                    "x": x, 
                    "denoised": denoised
                })
            except Exception:
                pass
    
    # ===== PHASE 1: INITIALIZATION =====
    # Compute first (order - 1) steps using init_method to build derivative history
    
    init_steps = ab_order - 1
    init_method_name = "Heun" if ab_init_method == 'heun' else "Euler"
    
    print(f"[Adams-Bashforth] Order {ab_order}, init with {init_method_name} "
          f"for first {init_steps} steps")
    
    for i in range(init_steps):
        s0 = sigmas[i].to(dtype)
        s1 = sigmas[i + 1].to(dtype)
        
        # Use initialization method
        x, d = init_fn(model, x, s0, s1, ea)
        
        # Store derivative
        d_history.append(d.detach().clone())
        
        # Trim history if needed (maintain max size)
        if len(d_history) > history_size:
            d_history.pop(0)
        
        _cb(i, s0, s1, None)
    
    # ===== PHASE 2: ADAMS-BASHFORTH INTEGRATION =====
    # Use multi-step formula for remaining steps
    
    s_in = torch.ones((x.shape[0],), device=device, dtype=dtype)
    
    for i in range(init_steps, steps):
        s0 = sigmas[i].to(dtype)
        s1 = sigmas[i + 1].to(dtype)
        h = s1 - s0
        
        # Denoise at current point
        denoised = model(x, s0 * s_in, **ea)
        
        # Handle final step (sigma_next = 0)
        if float(s1) == 0.0:
            x = _safe(denoised)
            _cb(i, s0, s1, denoised)
            break
        
        # Compute current derivative
        d_curr = _to_d(x, s0, denoised)
        
        # Add to history
        d_history.append(d_curr)
        if len(d_history) > history_size:
            d_history.pop(0)
        
        # Ensure we have enough history for AB step
        if len(d_history) < ab_order:
            # Shouldn't happen if initialization worked, but fallback to Euler
            print(f"[Adams-Bashforth] Warning: insufficient history at step {i}, "
                  f"using Euler")
            x = x + d_curr * h
        else:
            # Apply Adams-Bashforth step
            x = ab_step_fn(x, h, d_history)
        
        x = _safe(x)
        _cb(i, s0, s1, denoised)
    
    return x

# ===================== Registration =====================

def _make_ab_variant(order: int, init_method: str):
    """
    Factory function that properly captures parameters without breaking sigmas.
    """
    def wrapped(model, x, sigmas=None, extra_args=None, callback=None, disable=False, **kwargs):
        return sample_adams_bashforth(
            model, x,
            sigmas=sigmas,
            extra_args=extra_args,
            callback=callback,
            disable=disable,
            ab_order=order,
            ab_init_method=init_method,
            **kwargs
        )
    return wrapped

def _dedupe_and_register(entries):
    """Register samplers avoiding duplicates."""
    samplers_data = []
    existing_names = {s.name for s in sd_samplers.all_samplers}
    existing_aliases = {a for s in sd_samplers.all_samplers 
                       for a in (getattr(s, "aliases", []) or [])}
    
    for label, func, aliases, options in entries:
        if label in existing_names or any(a in existing_aliases for a in (aliases or [])):
            continue
        
        ctor = (lambda model, f=func: KDiffusionSampler(f, model))
        sdata = sd_samplers_common.SamplerData(label, ctor, aliases or [], options or {})
        samplers_data.append(sdata)
    
    if not samplers_data:
        print("[Adams-Bashforth] samplers already registered")
        return
    
    sd_samplers.all_samplers.extend(samplers_data)
    sd_samplers.all_samplers_map = {x.name: x for x in sd_samplers.all_samplers}
    if hasattr(sd_samplers, "set_samplers"):
        sd_samplers.set_samplers()
    
    print("[Adams-Bashforth] registered:", [s.name for s in samplers_data])

# Define sampler variants
_ENTRIES = [
    (
        "Adams-Bashforth 4th",
        _make_ab_variant(4, 'heun'),
        ["ab4", "adams-bashforth-4", "ab-4"],
        {
            "scheduler": "auto",
            "uses_ensd": False,
            "second_order": False,
        },
    ),
    (
        "Adams-Bashforth 3rd",
        _make_ab_variant(3, 'heun'),
        ["ab3", "adams-bashforth-3", "ab-3"],
        {
            "scheduler": "auto",
            "uses_ensd": False,
            "second_order": False,
        },
    ),
    (
        "Adams-Bashforth 2nd",
        _make_ab_variant(2, 'euler'),
        ["ab2", "adams-bashforth-2", "ab-2"],
        {
            "scheduler": "auto",
            "uses_ensd": False,
            "second_order": True,
        },
    ),
]

_dedupe_and_register(_ENTRIES)
