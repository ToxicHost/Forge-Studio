# schedulers_beta.py
# Beta 57 — Beta scheduler with alpha=0.5, beta=0.7
# Packaged with Forge Studio by ToxicHost & Moritz
#
# Beta57 matches ComfyUI / RES4LYF's "beta57" preset (Beta(0.5, 0.7)) and is
# the recommended scheduler for Anima / Cosmos-Predict2 workflows. It
# registers as a new scheduler entry in Studio's scheduler dropdown without
# touching Forge's existing generic "Beta" scheduler.

import numpy as np
import torch

from modules import sd_schedulers


_BETA57_ALPHA = 0.5
_BETA57_BETA = 0.7
_BETA57_NAME = "beta57"
_BETA57_LABEL = "Beta 57"


def _sanitize(values):
    """Replace NaN/Inf entries from beta.ppf with safe endpoints in [0, 1]."""
    arr = np.asarray(values, dtype=np.float64)
    arr = np.where(np.isnan(arr), 0.0, arr)
    arr = np.where(np.isposinf(arr), 1.0, arr)
    arr = np.where(np.isneginf(arr), 0.0, arr)
    return np.clip(arr, 0.0, 1.0)


def beta57_scheduler(n, sigma_min, sigma_max, inner_model=None, device=None, sgm=False, **kwargs):
    """Beta(0.5, 0.7) scheduler. Comfy-style discrete sigma indexing when
    possible, with two progressively weaker fallbacks.

    sgm is accepted for compatibility with Forge's scheduler call signature
    but Beta57 always uses Comfy's `endpoint=False` sequence on the primary
    path.
    """
    from scipy.stats import beta as _beta

    out_device = device or "cpu"

    # Beta positions: high -> low. ComfyUI uses 1 - linspace(0, 1, n, endpoint=False)
    # so the first sample sits at 1.0 (high noise) and the last sample stays
    # strictly above 0.0 (the trailing 0.0 sigma is appended separately).
    ts = 1.0 - np.linspace(0.0, 1.0, int(n), endpoint=False)
    ts = _sanitize(_beta.ppf(ts, _BETA57_ALPHA, _BETA57_BETA))

    # === Preferred path: discrete sigma indexing from inner_model.sigmas ===
    sigmas_table = getattr(inner_model, "sigmas", None)
    if sigmas_table is not None:
        try:
            table = sigmas_table.detach().cpu().numpy() if hasattr(sigmas_table, "detach") else np.asarray(sigmas_table)
            last_idx = len(table) - 1
            if last_idx > 0:
                idxs = np.round(ts * last_idx).astype(np.int64)
                # Comfy dedupes adjacent identical indices in the same direction.
                deduped = [int(idxs[0])]
                for v in idxs[1:]:
                    if int(v) != deduped[-1]:
                        deduped.append(int(v))
                picked = [float(table[i]) for i in deduped]
                picked.append(0.0)
                return torch.FloatTensor(picked).to(out_device)
        except Exception:
            # Fall through to next strategy
            pass

    # === Fallback path: timestep conversion via sigma_to_t / t_to_sigma ===
    sigma_to_t = getattr(inner_model, "sigma_to_t", None)
    t_to_sigma = getattr(inner_model, "t_to_sigma", None)
    if callable(sigma_to_t) and callable(t_to_sigma):
        try:
            sm = torch.tensor(float(sigma_max))
            sn = torch.tensor(float(sigma_min))
            t_max = float(sigma_to_t(sm))
            t_min = float(sigma_to_t(sn))
            # ts==1 -> sigma_max -> t_max; ts==0 -> sigma_min -> t_min
            ts_t = t_min + (t_max - t_min) * ts
            sigmas = []
            for tv in ts_t:
                s = t_to_sigma(torch.tensor(float(tv)))
                sigmas.append(float(s))
            sigmas.append(0.0)
            return torch.FloatTensor(sigmas).to(out_device)
        except Exception:
            pass

    # === Last-resort: direct sigma-space interpolation ===
    # ts == 1 should land near sigma_max, ts == 0 should land near sigma_min.
    smin = float(sigma_min)
    smax = float(sigma_max)
    sigmas = (smin + (smax - smin) * ts).tolist()
    sigmas.append(0.0)
    return torch.FloatTensor(sigmas).to(out_device)


def _register():
    """Append Beta 57 to sd_schedulers.schedulers (and schedulers_map),
    deduped by both name and label."""
    try:
        from scipy.stats import beta as _beta  # noqa: F401
    except ImportError:
        print("[Beta57] skipped: scipy unavailable")
        return

    sched_list = getattr(sd_schedulers, "schedulers", None)
    if sched_list is None:
        print("[Beta57] skipped: sd_schedulers.schedulers not found")
        return

    existing_names = {getattr(s, "name", None) for s in sched_list}
    existing_labels = {getattr(s, "label", None) for s in sched_list}
    if _BETA57_NAME in existing_names or _BETA57_LABEL in existing_labels:
        return

    # Discover the Scheduler class from an existing entry so we adopt
    # whatever shape Forge Neo currently uses.
    Scheduler = type(sched_list[0]) if sched_list else None
    if Scheduler is None:
        print("[Beta57] skipped: no existing scheduler to clone class from")
        return

    try:
        entry = Scheduler(_BETA57_NAME, _BETA57_LABEL, beta57_scheduler,
                          need_inner_model=True)
    except TypeError:
        # Older Forge variants take positional-only args
        try:
            entry = Scheduler(_BETA57_NAME, _BETA57_LABEL, beta57_scheduler)
            if hasattr(entry, "need_inner_model"):
                entry.need_inner_model = True
        except Exception as e:
            print(f"[Beta57] skipped: could not construct Scheduler ({e})")
            return

    sched_list.append(entry)

    # Keep schedulers_map in sync — generation lookup uses the map, not the
    # list, so a list-only registration would show in dropdowns but not
    # actually run.
    sched_map = getattr(sd_schedulers, "schedulers_map", None)
    if isinstance(sched_map, dict):
        sched_map[_BETA57_NAME] = entry
        if _BETA57_LABEL and _BETA57_LABEL != _BETA57_NAME:
            sched_map[_BETA57_LABEL] = entry

    print(f"[Beta57] registered {_BETA57_LABEL}")


_register()
