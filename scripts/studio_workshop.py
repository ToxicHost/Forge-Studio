"""
Forge Studio — Workshop Module (Backend)
by ToxicHost & Moritz

Model merging and compilation suite.
Phase 0: Infrastructure (weighted sum, arch detection, metadata)
Phase 1: Cosine diff view (per-block cosine similarity)
Phase 2: Block weights, presets, SLERP, Model Stock auto-alpha
Phase 3: In-memory merge — hot-swap UNet weights for rapid iteration
Phase 4: Add Difference, TIES, DARE, DARE-TIES, Cosine Adaptive
Phase 6: LoRA baking — all adapter types (LoRA, LoHa, LoKr, OFT, BOFT, GLoRA, DoRA)

Key-iterative merging via safetensors mmap, architecture detection,
metadata injection, pre-flight RAM estimation,
FastAPI routes, WebSocket progress through existing /studio/ws.

All merge arithmetic in fp32. Downcast at save time only.
VAE keys (first_stage_model.*) always stay fp32.
Cosine similarity in fp32 — dot product accumulation loses precision in fp16.
Add Difference subtraction in fp32 — catastrophic cancellation in fp16.
DARE rescaling in fp32 — division by 1/(1-p) amplifies quantization error.
"""

import asyncio
import json
import math
import os
import re
import time
import traceback
import psutil
from datetime import datetime, timezone
from pathlib import Path
from threading import Thread, Event
from typing import Optional, Dict, List, Tuple, Any

import torch
from safetensors import safe_open
from safetensors.torch import save_file
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from modules import shared, sd_models

TAG = "[Workshop]"
VERSION = "0.6.0"

_NAT_SORT_RE = re.compile(r'(\d+)')


def _natural_sort_key(text):
    """Split text into string/int segments so v3 sorts before v10."""
    return [int(c) if c.isdigit() else c for c in _NAT_SORT_RE.split(str(text).lower())]

VAE_PREFIX = "first_stage_model."

# =========================================================================
# ARCHITECTURE DETECTION
# =========================================================================

_RE_INP = re.compile(r'\.input_blocks\.(\d+)\.')
_RE_MID = re.compile(r'\.middle_block\.')
_RE_OUT = re.compile(r'\.output_blocks\.(\d+)\.')
_RE_DOUBLE = re.compile(r'double_blocks\.(\d+)\.')
_RE_SINGLE = re.compile(r'single_blocks\.(\d+)\.')
_RE_JOINT = re.compile(r'joint_blocks\.(\d+)\.')
_RE_COSMOS = re.compile(r'\.blocks\.(\d+)\.')


def detect_architecture(keys: set) -> dict:
    """Detect model architecture from state dict keys."""
    if any("double_blocks." in k for k in keys):
        double_max = single_max = -1
        for k in keys:
            m = _RE_DOUBLE.search(k)
            if m: double_max = max(double_max, int(m.group(1)))
            m = _RE_SINGLE.search(k)
            if m: single_max = max(single_max, int(m.group(1)))
        n_double = double_max + 1 if double_max >= 0 else 0
        n_single = single_max + 1 if single_max >= 0 else 0
        total = n_double + n_single
        if n_double <= 8 and n_single >= 40:
            return {"arch": "flux2", "blocks": total,
                    "details": f"FLUX.2 ({n_double} double + {n_single} single blocks)"}
        return {"arch": "flux1", "blocks": total,
                "details": f"FLUX.1 ({n_double} double + {n_single} single blocks)"}

    if any("joint_blocks." in k for k in keys):
        joint_max = -1
        for k in keys:
            m = _RE_JOINT.search(k)
            if m: joint_max = max(joint_max, int(m.group(1)))
        n_joints = joint_max + 1 if joint_max >= 0 else 0
        return {"arch": "sd3", "blocks": n_joints,
                "details": f"SD3 MMDiT ({n_joints} joint blocks)"}

    if any("input_blocks." in k for k in keys):
        inp_max = -1
        for k in keys:
            m = _RE_INP.search(k)
            if m: inp_max = max(inp_max, int(m.group(1)))
        n_inp = inp_max + 1 if inp_max >= 0 else 0
        if n_inp <= 9:
            return {"arch": "sdxl", "blocks": 20,
                    "details": "SDXL (9+1+9 blocks, dual CLIP)"}
        return {"arch": "sd15", "blocks": 26,
                "details": "SD 1.5 (12+1+12 blocks)"}

    # Cosmos-Predict2 (Anima, etc.) — adaln_modulation_cross_attn is unique
    if any("adaln_modulation_cross_attn" in k for k in keys):
        block_max = -1
        for k in keys:
            m = _RE_COSMOS.search(k)
            if m: block_max = max(block_max, int(m.group(1)))
        n_blocks = block_max + 1 if block_max >= 0 else 0
        has_te = any("cond_stage_model." in k or "conditioner." in k for k in keys)
        te_note = "bundled TE" if has_te else "external TE+VAE"
        return {"arch": "cosmos", "blocks": n_blocks,
                "details": f"Cosmos-Predict2 ({n_blocks} blocks, {te_note})"}

    return {"arch": "unknown", "blocks": 0, "details": "Unknown architecture"}


def classify_key(key: str, arch: str) -> str:
    """Classify a key into its block group for block-weight merging."""
    if arch in ("sd15", "sdxl"):
        if "cond_stage_model." in key or "conditioner." in key:
            return "BASE"
        m = _RE_INP.search(key)
        if m: return f"IN{int(m.group(1)):02d}"
        if _RE_MID.search(key): return "M00"
        m = _RE_OUT.search(key)
        if m: return f"OUT{int(m.group(1)):02d}"
    elif arch in ("flux1", "flux2"):
        m = _RE_DOUBLE.search(key)
        if m: return f"D{int(m.group(1)):02d}"
        m = _RE_SINGLE.search(key)
        if m: return f"S{int(m.group(1)):02d}"
    elif arch == "sd3":
        m = _RE_JOINT.search(key)
        if m: return f"J{int(m.group(1)):02d}"
    elif arch == "cosmos":
        m = _RE_COSMOS.search(key)
        if m: return f"B{int(m.group(1)):02d}"
    if VAE_PREFIX in key:
        return "VAE"
    return "OTHER"


def get_block_list(arch: str) -> list:
    """Return ordered list of block group names for an architecture."""
    if arch == "sd15":
        return (["BASE"] +
                [f"IN{i:02d}" for i in range(12)] +
                ["M00"] +
                [f"OUT{i:02d}" for i in range(12)])
    elif arch == "sdxl":
        return (["BASE"] +
                [f"IN{i:02d}" for i in range(9)] +
                ["M00"] +
                [f"OUT{i:02d}" for i in range(9)])
    elif arch == "sd3":
        return [f"J{i:02d}" for i in range(38)]
    elif arch == "flux1":
        return ([f"D{i:02d}" for i in range(19)] +
                [f"S{i:02d}" for i in range(38)])
    elif arch == "flux2":
        return ([f"D{i:02d}" for i in range(8)] +
                [f"S{i:02d}" for i in range(48)])
    elif arch == "cosmos":
        return [f"B{i:02d}" for i in range(28)]
    return []


# =========================================================================
# BLOCK WEIGHT PRESETS
# =========================================================================

PRESETS = {
    "sd15": {
        "ALL 0.5": None,
        "Style from A": {
            "BASE": 0.0,
            **{f"IN{i:02d}": 0.0 for i in range(5)},
            **{f"IN{i:02d}": 1.0 for i in range(5, 12)},
            "M00": 1.0,
            **{f"OUT{i:02d}": 1.0 for i in range(7)},
            **{f"OUT{i:02d}": 0.0 for i in range(7, 12)},
        },
        "Composition from A": {
            "BASE": 1.0,
            **{f"IN{i:02d}": 1.0 for i in range(5)},
            **{f"IN{i:02d}": 0.0 for i in range(5, 12)},
            "M00": 0.0,
            **{f"OUT{i:02d}": 0.0 for i in range(7)},
            **{f"OUT{i:02d}": 1.0 for i in range(7, 12)},
        },
        "EPS→V-Pred Safe": {
            "BASE": 0.0,
            **{f"IN{i:02d}": 0.5 for i in range(12)},
            "M00": 0.5,
            **{f"OUT{i:02d}": 0.5 for i in range(9)},
            **{f"OUT{i:02d}": 0.0 for i in range(9, 12)},
        },
        "UNet Only": {
            "BASE": 0.0,
        },
        "Text Encoder Only": {
            "BASE": 1.0,
            **{f"IN{i:02d}": 0.0 for i in range(12)},
            "M00": 0.0,
            **{f"OUT{i:02d}": 0.0 for i in range(12)},
        },
    },
    "sdxl": {
        "ALL 0.5": None,
        "Style from A": {
            "BASE": 0.0,
            **{f"IN{i:02d}": 0.0 for i in range(4)},
            **{f"IN{i:02d}": 1.0 for i in range(4, 9)},
            "M00": 1.0,
            **{f"OUT{i:02d}": 1.0 for i in range(5)},
            **{f"OUT{i:02d}": 0.0 for i in range(5, 9)},
        },
        "Composition from A": {
            "BASE": 1.0,
            **{f"IN{i:02d}": 1.0 for i in range(4)},
            **{f"IN{i:02d}": 0.0 for i in range(4, 9)},
            "M00": 0.0,
            **{f"OUT{i:02d}": 0.0 for i in range(5)},
            **{f"OUT{i:02d}": 1.0 for i in range(5, 9)},
        },
        "EPS→V-Pred Safe": {
            "BASE": 0.0,
            **{f"IN{i:02d}": 0.5 for i in range(9)},
            "M00": 0.5,
            **{f"OUT{i:02d}": 0.5 for i in range(6)},
            **{f"OUT{i:02d}": 0.0 for i in range(6, 9)},
        },
        "UNet Only": {
            "BASE": 0.0,
        },
        "Text Encoder Only": {
            "BASE": 1.0,
            **{f"IN{i:02d}": 0.0 for i in range(9)},
            "M00": 0.0,
            **{f"OUT{i:02d}": 0.0 for i in range(9)},
        },
    },
    "flux1": {
        "ALL 0.5": None,
        "Double Blocks Only": {
            **{f"D{i:02d}": 0.5 for i in range(19)},
            **{f"S{i:02d}": 0.0 for i in range(38)},
        },
        "Single Blocks Only": {
            **{f"D{i:02d}": 0.0 for i in range(19)},
            **{f"S{i:02d}": 0.5 for i in range(38)},
        },
    },
}


# =========================================================================
# COSINE SIMILARITY — key-iterative per-block
# =========================================================================

def compute_cosine_diff(path_a: str, path_b: str, progress_callback=None) -> dict:
    """Compute per-block cosine similarity between two models.

    Accumulates dot products and squared norms as running sums per block,
    computes similarity once at the end. No tensor held longer than one
    iteration. RAM stays flat regardless of model size.

    All math in fp32 — dot product accumulation loses precision in fp16.
    """
    block_dots = {}
    block_norm_a = {}
    block_norm_b = {}
    block_counts = {}
    nan_keys = 0

    with safe_open(path_a, framework="pt", device="cpu") as f_a, \
         safe_open(path_b, framework="pt", device="cpu") as f_b:

        keys_a = set(f_a.keys())
        keys_b = set(f_b.keys())
        shared_keys = sorted(keys_a & keys_b)
        arch_info = detect_architecture(keys_a)
        arch = arch_info["arch"]

        for i, key in enumerate(shared_keys):
            sl = f_a.get_slice(key)
            dtype_str = str(sl.get_dtype())
            if "int" in dtype_str or "bool" in dtype_str:
                continue

            t_a = f_a.get_tensor(key).float().flatten()
            t_b = f_b.get_tensor(key).float().flatten()

            if t_a.shape != t_b.shape:
                del t_a, t_b
                continue

            block = classify_key(key, arch)

            dot = torch.dot(t_a, t_b).item()
            na = torch.dot(t_a, t_a).item()
            nb = torch.dot(t_b, t_b).item()

            if not (math.isfinite(dot) and math.isfinite(na) and math.isfinite(nb)):
                nan_keys += 1
                del t_a, t_b
                continue

            block_dots[block] = block_dots.get(block, 0.0) + dot
            block_norm_a[block] = block_norm_a.get(block, 0.0) + na
            block_norm_b[block] = block_norm_b.get(block, 0.0) + nb
            block_counts[block] = block_counts.get(block, 0) + 1

            del t_a, t_b

            if progress_callback and i % 100 == 0:
                progress_callback(i / len(shared_keys))

    blocks = {}
    total_dot = 0.0
    total_na = 0.0
    total_nb = 0.0

    for block in sorted(block_dots.keys()):
        d = block_dots[block]
        na = block_norm_a[block]
        nb = block_norm_b[block]
        denom = math.sqrt(na) * math.sqrt(nb)
        sim = d / denom if denom > 1e-12 else 0.0
        blocks[block] = {
            "similarity": round(sim, 6),
            "key_count": block_counts[block],
        }
        total_dot += d
        total_na += na
        total_nb += nb

    global_denom = math.sqrt(total_na) * math.sqrt(total_nb)
    global_sim = total_dot / global_denom if global_denom > 1e-12 else 0.0

    if nan_keys:
        print(f"{TAG} Cosine diff: skipped {nan_keys} keys with NaN/Inf weights (likely unused CLIP layers)")

    return {
        "architecture": arch_info,
        "blocks": blocks,
        "global_similarity": round(global_sim, 6),
        "shared_keys": len(shared_keys),
        "nan_keys": nan_keys,
    }


# =========================================================================
# MODEL STOCK — auto-alpha via geometric analysis
# =========================================================================

def compute_model_stock_alpha(path_a: str, path_b: str) -> dict:
    """Compute suggested per-block alpha from cosine similarity.

    Simplified two-model version of Model Stock. With two models we use
    similarity to derive alphas: high similarity -> 0.5 (equal blend),
    low similarity -> favor A (lower alpha, since A is the base in our UI).
    """
    diff = compute_cosine_diff(path_a, path_b)
    block_alphas = {}

    sims = [v["similarity"] for v in diff["blocks"].values() if v["similarity"] > 0]
    if not sims:
        return {"alphas": {}, "method": "model_stock", "global_similarity": 0}

    sims_sorted = sorted(sims)
    p1 = sims_sorted[max(0, int(len(sims_sorted) * 0.01))]
    p99 = sims_sorted[min(len(sims_sorted) - 1, int(len(sims_sorted) * 0.99))]

    for block, info in diff["blocks"].items():
        sim = info["similarity"]
        if p99 - p1 > 1e-6:
            normalized = max(0.0, min(1.0, (sim - p1) / (p99 - p1)))
            alpha = 0.15 + normalized * 0.35
        else:
            alpha = 0.5
        block_alphas[block] = round(alpha, 3)

    return {
        "alphas": block_alphas,
        "method": "model_stock",
        "global_similarity": diff["global_similarity"],
        "cosine_diff": diff["blocks"],
    }


# =========================================================================
# PRE-FLIGHT RAM ESTIMATION
# =========================================================================

def estimate_merge_ram(path_a: str, path_b: str) -> dict:
    size_a = os.path.getsize(path_a) / (1024 ** 3)
    size_b = os.path.getsize(path_b) / (1024 ** 3)
    output_buffer = max(size_a, size_b)
    overhead = 2.0
    peak = output_buffer + overhead
    available = psutil.virtual_memory().available / (1024 ** 3)
    total = psutil.virtual_memory().total / (1024 ** 3)
    safe = peak < (available * 0.8)
    warning = None
    if not safe:
        warning = (f"Estimated peak RAM: {peak:.1f} GB. "
                   f"Available: {available:.1f} GB / {total:.1f} GB total. "
                   f"This merge may run out of memory.")
    return {
        "model_a_size_gb": round(size_a, 2), "model_b_size_gb": round(size_b, 2),
        "output_buffer_gb": round(output_buffer, 2), "overhead_gb": overhead,
        "peak_gb": round(peak, 2), "available_gb": round(available, 2),
        "total_gb": round(total, 2), "safe": safe, "warning": warning,
    }


# =========================================================================
# MODEL INSPECTION
# =========================================================================

def inspect_model(path: str) -> dict:
    result = {
        "filename": os.path.basename(path),
        "size_gb": round(os.path.getsize(path) / (1024 ** 3), 2),
        "key_count": 0, "architecture": None,
        "metadata": {}, "model_info": {}, "dtypes": {}, "block_groups": {},
    }
    with safe_open(path, framework="pt", device="cpu") as f:
        keys = set(f.keys())
        result["key_count"] = len(keys)
        arch_info = detect_architecture(keys)
        result["architecture"] = arch_info
        meta = f.metadata()
        if meta:
            result["metadata"] = dict(meta)
            # Extract useful fields into model_info
            mi = {}
            # Prediction type — several conventions
            for k in ("modelspec.prediction_type", "ss_v_parameterization",
                      "prediction_type", "modelspec.predict_key"):
                v = meta.get(k)
                if v:
                    if v in ("true", "True", "1"):
                        mi["prediction"] = "v-prediction"
                    elif v in ("false", "False", "0"):
                        mi["prediction"] = "eps"
                    else:
                        mi["prediction"] = v
                    break
            # Base model / merge recipe
            for k in ("modelspec.title", "ss_sd_model_name", "modelspec.base_model"):
                v = meta.get(k)
                if v:
                    mi["base_model"] = v[:100]
                    break
            # Resolution
            for k in ("modelspec.resolution", "ss_resolution"):
                v = meta.get(k)
                if v:
                    mi["resolution"] = v
                    break
            # Merge recipe (if present)
            recipe = meta.get("sd_merge_recipe") or meta.get("merge_recipe")
            if recipe:
                try:
                    mi["merge_recipe"] = json.loads(recipe) if isinstance(recipe, str) else recipe
                except (json.JSONDecodeError, TypeError):
                    mi["merge_recipe"] = str(recipe)[:200]
            result["model_info"] = mi
        dtype_counts = {}
        block_counts = {}
        for key in keys:
            t = f.get_slice(key)
            dtype_str = str(t.get_dtype())
            dtype_counts[dtype_str] = dtype_counts.get(dtype_str, 0) + 1
            group = classify_key(key, arch_info["arch"])
            block_counts[group] = block_counts.get(group, 0) + 1
        result["dtypes"] = dtype_counts
        result["block_groups"] = dict(sorted(block_counts.items()))
    return result


# =========================================================================
# COMPATIBILITY CHECK
# =========================================================================

def check_compatibility(path_a: str, path_b: str) -> dict:
    """Pre-merge compatibility analysis between two models.

    Checks architecture match, key overlap, CLIP presence, dtype alignment.
    Returns structured result with severity badges.
    """
    issues = []     # blocking problems
    warnings = []   # non-blocking concerns
    info = []       # informational notes

    with safe_open(path_a, framework="pt", device="cpu") as f_a, \
         safe_open(path_b, framework="pt", device="cpu") as f_b:

        keys_a = set(f_a.keys())
        keys_b = set(f_b.keys())
        arch_a = detect_architecture(keys_a)
        arch_b = detect_architecture(keys_b)
        meta_a = f_a.metadata() or {}
        meta_b = f_b.metadata() or {}

        # Architecture match
        if arch_a["arch"] != arch_b["arch"]:
            issues.append({
                "type": "arch_mismatch",
                "text": f"Architecture mismatch: {arch_a['details']} vs {arch_b['details']}",
                "detail": "These models cannot be merged — they have different network structures.",
            })
        else:
            info.append({
                "type": "arch_match",
                "text": f"Architecture: {arch_a['details']}",
            })

        # Key overlap
        shared = keys_a & keys_b
        only_a = keys_a - keys_b
        only_b = keys_b - keys_a
        overlap_pct = len(shared) / max(len(keys_a | keys_b), 1) * 100

        if overlap_pct < 50:
            issues.append({
                "type": "low_overlap",
                "text": f"Key overlap: {overlap_pct:.0f}% ({len(shared)} shared, {len(only_a)} only in A, {len(only_b)} only in B)",
                "detail": "Less than 50% shared keys — these models may be incompatible.",
            })
        elif overlap_pct < 90:
            warnings.append({
                "type": "partial_overlap",
                "text": f"Key overlap: {overlap_pct:.0f}% ({len(only_a)} unique to A, {len(only_b)} unique to B)",
            })
        else:
            info.append({
                "type": "good_overlap",
                "text": f"Key overlap: {overlap_pct:.0f}% ({len(shared)} shared keys)",
            })

        # CLIP encoder presence
        clip_a = any("conditioner." in k or "cond_stage_model." in k for k in keys_a)
        clip_b = any("conditioner." in k or "cond_stage_model." in k for k in keys_b)
        if clip_a != clip_b:
            warnings.append({
                "type": "clip_mismatch",
                "text": f"CLIP text encoder: {'present' if clip_a else 'absent'} in A, {'present' if clip_b else 'absent'} in B",
                "detail": "One model has a baked-in text encoder and the other doesn't. The result will inherit whichever is present.",
            })

        # VAE presence
        vae_a = any(k.startswith(VAE_PREFIX) for k in keys_a)
        vae_b = any(k.startswith(VAE_PREFIX) for k in keys_b)
        if vae_a != vae_b:
            warnings.append({
                "type": "vae_mismatch",
                "text": f"VAE: {'baked' if vae_a else 'absent'} in A, {'baked' if vae_b else 'absent'} in B",
            })
        elif vae_a and vae_b:
            info.append({"type": "vae_both", "text": "Both models have baked-in VAE"})

        # Dtype alignment check — sample shared keys
        dtype_mismatches = 0
        sample_keys = list(shared)[:200]
        for key in sample_keys:
            dt_a = str(f_a.get_slice(key).get_dtype())
            dt_b = str(f_b.get_slice(key).get_dtype())
            if dt_a != dt_b:
                dtype_mismatches += 1
        if dtype_mismatches > 0:
            pct = dtype_mismatches / max(len(sample_keys), 1) * 100
            warnings.append({
                "type": "dtype_mismatch",
                "text": f"Dtype mismatches: {pct:.0f}% of sampled keys differ (merge will upcast to fp32)",
            })

    # Overall verdict
    if issues:
        verdict = "incompatible"
    elif warnings:
        verdict = "caution"
    else:
        verdict = "compatible"

    print(f"{TAG} Compatibility: {verdict} ({len(issues)} issues, {len(warnings)} warnings, {len(info)} info)")

    return {
        "verdict": verdict,
        "issues": issues,
        "warnings": warnings,
        "info": info,
    }


# =========================================================================
# HEALTH SCAN — post-merge tensor audit
# =========================================================================

def scan_health(path: str, progress_callback=None) -> dict:
    """Scan a model for NaN tensors, all-zero blocks, and collapsed variance.

    Returns per-block health status for display in the Inspector.
    """
    block_stats = {}  # block -> {keys, nan_keys, zero_keys, collapsed_keys}

    with safe_open(path, framework="pt", device="cpu") as f:
        keys = sorted(f.keys())
        arch_info = detect_architecture(set(keys))
        arch = arch_info["arch"]

        for i, key in enumerate(keys):
            sl = f.get_slice(key)
            dtype_str = str(sl.get_dtype())
            if "int" in dtype_str or "bool" in dtype_str:
                continue

            block = classify_key(key, arch)
            if block not in block_stats:
                block_stats[block] = {"keys": 0, "nan_keys": 0, "zero_keys": 0, "collapsed_keys": 0, "details": []}

            bs = block_stats[block]
            bs["keys"] += 1

            t = f.get_tensor(key).float()

            # NaN check
            if torch.isnan(t).any():
                nan_count = torch.isnan(t).sum().item()
                bs["nan_keys"] += 1
                bs["details"].append({"key": key, "issue": "nan", "detail": f"{nan_count} NaN values"})
                del t
                continue

            # Inf check
            if torch.isinf(t).any():
                inf_count = torch.isinf(t).sum().item()
                bs["nan_keys"] += 1
                bs["details"].append({"key": key, "issue": "inf", "detail": f"{inf_count} Inf values"})
                del t
                continue

            # All-zero check
            if t.numel() > 1 and t.abs().max().item() == 0:
                bs["zero_keys"] += 1
                bs["details"].append({"key": key, "issue": "zero", "detail": "All zeros"})
                del t
                continue

            # Collapsed variance (all values within epsilon)
            if t.numel() > 16:
                std = t.std().item()
                if std < 1e-8:
                    bs["collapsed_keys"] += 1
                    mean_val = t.mean().item()
                    bs["details"].append({"key": key, "issue": "collapsed", "detail": f"Constant ~{mean_val:.6f}"})

            del t

            if progress_callback and i % 200 == 0:
                progress_callback(i / len(keys))

    # Build summary
    total_keys = sum(s["keys"] for s in block_stats.values())
    total_nan = sum(s["nan_keys"] for s in block_stats.values())
    total_zero = sum(s["zero_keys"] for s in block_stats.values())
    total_collapsed = sum(s["collapsed_keys"] for s in block_stats.values())
    total_issues = total_nan + total_zero + total_collapsed

    # Check if NaN keys are all in CLIP/BASE blocks (known structural artifact)
    clip_blocks = {"BASE", "CLIP", "OTHER"}
    nan_only_in_clip = total_nan > 0 and all(
        s["nan_keys"] == 0 for name, s in block_stats.items()
        if name not in clip_blocks
    )

    if total_nan > 0 and not nan_only_in_clip:
        verdict = "critical"
    elif total_nan > 0 and nan_only_in_clip and total_nan <= 10:
        verdict = "healthy"  # known artifact, not a problem
    elif total_zero > total_keys * 0.05 or total_collapsed > total_keys * 0.05:
        verdict = "warning"
    elif total_issues > 0:
        verdict = "minor"
    else:
        verdict = "healthy"

    # Trim per-block details to top 5 per block
    for bs in block_stats.values():
        bs["details"] = bs["details"][:5]

    print(f"{TAG} Health scan: {total_keys} keys, {total_nan} NaN, {total_zero} zero, "
          f"{total_collapsed} collapsed → {verdict}"
          f"{' (NaN in CLIP only — known artifact)' if nan_only_in_clip and total_nan > 0 else ''}")

    return {
        "verdict": verdict,
        "architecture": arch_info,
        "total_keys": total_keys,
        "total_nan": total_nan,
        "total_zero": total_zero,
        "total_collapsed": total_collapsed,
        "nan_clip_only": nan_only_in_clip,
        "blocks": {k: v for k, v in sorted(block_stats.items())},
    }


# =========================================================================
# MERGE MATH — Phase 4 tensor operations
# =========================================================================

def _ties_trim_tensor(task_vector: torch.Tensor, density: float) -> torch.Tensor:
    """TIES trim: zero out entries below top-density% by magnitude.

    Per-tensor density trimming — practical for key-iterative processing.
    density=0.2 keeps top 20%, density=1.0 keeps everything.
    All math in fp32.
    """
    if density >= 1.0:
        return task_vector
    if density <= 0.0:
        return torch.zeros_like(task_vector)

    flat = task_vector.flatten().float()
    abs_flat = flat.abs()

    # Only consider nonzero entries for threshold
    nonzero_mask = abs_flat > 0
    if not nonzero_mask.any():
        return task_vector

    nonzero_abs = abs_flat[nonzero_mask]
    # Threshold: keep top density fraction
    threshold = torch.quantile(nonzero_abs, 1.0 - density).item()

    # Zero out entries below threshold
    mask = abs_flat >= threshold
    result = flat * mask.float()
    return result.view_as(task_vector)


def _dare_mask_tensor(task_vector: torch.Tensor, drop_rate: float,
                      seed: Optional[int] = None) -> torch.Tensor:
    """DARE: Bernoulli mask with rescaling to preserve expected value.

    drop_rate=0.9 drops 90% of parameters, rescale factor = 10×.
    All math in fp32 — rescaling amplifies quantization error.
    """
    if drop_rate <= 0.0:
        return task_vector
    if drop_rate >= 1.0:
        return torch.zeros_like(task_vector)

    flat = task_vector.flatten().float()

    gen = torch.Generator()
    if seed is not None:
        gen.manual_seed(seed)
    else:
        gen.manual_seed(torch.randint(0, 2**31, (1,)).item())

    # Bernoulli: 1 with probability (1 - drop_rate), 0 with probability drop_rate
    mask = torch.bernoulli(torch.full_like(flat, 1.0 - drop_rate), generator=gen)

    # Rescale to preserve expected value
    rescale = 1.0 / (1.0 - drop_rate)
    result = flat * mask * rescale
    return result.view_as(task_vector)


def _dare_ties_tensor(task_vector: torch.Tensor, density: float,
                      drop_rate: float, seed: Optional[int] = None) -> torch.Tensor:
    """DARE-TIES combined: DARE mask+rescale first, then TIES trim.

    Pipeline: task_vector → DARE (sparsify + rescale) → TIES (trim low magnitude)
    """
    # Step 1: DARE — random sparsification with rescale
    dared = _dare_mask_tensor(task_vector, drop_rate, seed)
    # Step 2: TIES — trim low magnitude entries
    trimmed = _ties_trim_tensor(dared, density)
    return trimmed


def _della_mask_tensor(task_vector: torch.Tensor, drop_rate: float,
                       seed: Optional[int] = None) -> torch.Tensor:
    """DELLA: Magnitude-weighted dropout with rescaling.

    Like DARE but drop probability is inversely proportional to magnitude.
    Large-magnitude parameters are more likely to survive; small ones are
    more likely to be dropped. Preserves important training signal better
    than uniform Bernoulli masking.

    drop_rate controls the *average* fraction dropped. Individual element
    drop probability varies by magnitude.
    """
    if drop_rate <= 0.0:
        return task_vector
    if drop_rate >= 1.0:
        return torch.zeros_like(task_vector)

    flat = task_vector.flatten().float()
    abs_flat = flat.abs()

    # Normalize magnitudes to [0, 1] range
    max_mag = abs_flat.max().item()
    if max_mag == 0.0:
        return task_vector

    # Keep probability proportional to magnitude: big = likely kept
    # Scale so the average keep rate matches (1 - drop_rate)
    norm_mag = abs_flat / max_mag  # 0..1
    # Raw keep probability: proportional to magnitude
    # Rescale so mean(keep_prob) ≈ (1 - drop_rate)
    target_keep = 1.0 - drop_rate
    mean_mag = norm_mag.mean().item()
    if mean_mag > 0.0:
        keep_prob = (norm_mag * (target_keep / mean_mag)).clamp(0.0, 1.0)
    else:
        keep_prob = torch.full_like(flat, target_keep)

    gen = torch.Generator()
    if seed is not None:
        gen.manual_seed(seed)
    else:
        gen.manual_seed(torch.randint(0, 2**31, (1,)).item())

    mask = torch.bernoulli(keep_prob, generator=gen)

    # Rescale: per-element to preserve expected value
    # E[mask_i * rescale_i * x_i] = keep_prob_i * (1/keep_prob_i) * x_i = x_i
    safe_keep = keep_prob.clamp(min=0.01)  # Avoid div-by-zero
    rescale = 1.0 / safe_keep
    result = flat * mask * rescale
    return result.view_as(task_vector)


def _della_ties_tensor(task_vector: torch.Tensor, density: float,
                       drop_rate: float, seed: Optional[int] = None) -> torch.Tensor:
    """DELLA-TIES: DELLA mask first, then TIES trim.

    Pipeline: task_vector → DELLA (magnitude-weighted sparsify) → TIES (trim low magnitude)
    """
    della_masked = _della_mask_tensor(task_vector, drop_rate, seed)
    trimmed = _ties_trim_tensor(della_masked, density)
    return trimmed


def _breadcrumbs_trim_tensor(task_vector: torch.Tensor, density: float,
                             drop_rate: float) -> torch.Tensor:
    """Model Breadcrumbs: Dual-threshold trimming.

    Like TIES but also removes outlier high-magnitude changes. The idea is
    that extremely large parameter changes are likely overfitting artifacts,
    not just small ones. drop_rate here controls the upper outlier threshold
    — fraction of top-magnitude values to also remove.

    Keeps values between the lower threshold (from density) and the upper
    threshold (from 1.0 - drop_rate of magnitude).
    """
    if density >= 1.0 and drop_rate <= 0.0:
        return task_vector

    flat = task_vector.flatten().float()
    abs_flat = flat.abs()

    nonzero_mask = abs_flat > 0
    if not nonzero_mask.any():
        return task_vector

    nonzero_abs = abs_flat[nonzero_mask]

    # Lower threshold: same as TIES — keep top density fraction
    if density < 1.0:
        lower_thresh = torch.quantile(nonzero_abs, 1.0 - density).item()
    else:
        lower_thresh = 0.0

    # Upper threshold: remove top drop_rate fraction (outliers)
    if drop_rate > 0.0:
        upper_thresh = torch.quantile(nonzero_abs, 1.0 - drop_rate).item()
    else:
        upper_thresh = float('inf')

    # Keep values between lower and upper thresholds
    mask = (abs_flat >= lower_thresh) & (abs_flat <= upper_thresh)
    result = flat * mask.float()
    return result.view_as(task_vector)


def _star_denoise_tensor(task_vector: torch.Tensor, eta: float) -> torch.Tensor:
    """STAR: Spectral Truncation and Rescale.

    Decomposes task vector via SVD, truncates noisy singular values below
    eta * sigma_max, rescales to preserve nuclear norm, reconstructs.
    Returns denoised task vector in fp32.
    """
    shape = task_vector.shape

    # 1D or tiny — skip SVD, return as-is
    if task_vector.ndim < 2 or min(shape) < 2:
        return task_vector

    # Reshape to 2D if needed (conv weights: [out, in, kH, kW] → [out, in*kH*kW])
    if task_vector.ndim > 2:
        mat = task_vector.reshape(shape[0], -1).float()
    else:
        mat = task_vector.float()

    # SVD
    try:
        U, S, Vh = torch.linalg.svd(mat, full_matrices=False)
    except Exception:
        # Degenerate matrix — fall back to identity (no denoising)
        return task_vector

    # Check for NaN/Inf in SVD output
    if not (torch.isfinite(U).all() and torch.isfinite(S).all() and torch.isfinite(Vh).all()):
        return task_vector

    # Original nuclear norm
    norm_orig = S.sum().item()
    if norm_orig == 0.0:
        return task_vector

    # Truncate: zero singular values below eta * sigma_max
    threshold = eta * S[0].item()
    mask = S >= threshold

    # Safety: keep at least the top singular value
    if not mask.any():
        mask[0] = True

    S_new = S * mask.float()

    # Rescale to preserve nuclear norm
    norm_new = S_new.sum().item()
    if norm_new > 0.0:
        S_new *= (norm_orig / norm_new)

    # Reconstruct
    result = U @ torch.diag(S_new) @ Vh

    # Reshape back
    if task_vector.ndim > 2:
        result = result.reshape(shape)

    return result


def _svd_split_tensor(w_a: torch.Tensor, w_b: torch.Tensor,
                      mode: str, alpha: float) -> torch.Tensor:
    """SVD Structure/Magnitude Split.

    Decomposes both weight matrices via SVD, then recombines structure (U, V)
    from one model with magnitude (Σ) from the other.

    Modes:
      svd_struct_a_mag_b: U_A @ diag(Σ_B) @ Vh_A — A's features, B's intensity
      svd_struct_b_mag_a: U_B @ diag(Σ_A) @ Vh_B — B's features, A's intensity
      svd_blend: Procrustes-aligned interpolation in spectral space

    Alpha controls blend strength: 0 = pure A, 1 = full effect.
    """
    shape = w_a.shape

    # 1D or tiny — fall back to lerp
    if w_a.ndim < 2 or min(shape) < 2:
        return torch.lerp(w_a, w_b, alpha).clone()

    # Reshape to 2D if needed (conv weights: [out, in, kH, kW] → [out, in*kH*kW])
    if w_a.ndim > 2:
        mat_a = w_a.reshape(shape[0], -1).float()
        mat_b = w_b.reshape(shape[0], -1).float()
    else:
        mat_a = w_a.float()
        mat_b = w_b.float()

    # SVD both matrices
    try:
        U_A, S_A, Vh_A = torch.linalg.svd(mat_a, full_matrices=False)
        U_B, S_B, Vh_B = torch.linalg.svd(mat_b, full_matrices=False)
    except Exception:
        return torch.lerp(w_a, w_b, alpha).clone()

    # NaN/Inf check on all SVD outputs
    for t in (U_A, S_A, Vh_A, U_B, S_B, Vh_B):
        if not torch.isfinite(t).all():
            return torch.lerp(w_a, w_b, alpha).clone()

    if mode == "svd_struct_a_mag_b":
        # A's feature directions, B's response magnitudes
        swapped = U_A @ torch.diag(S_B) @ Vh_A
        result = (1.0 - alpha) * mat_a + alpha * swapped

    elif mode == "svd_struct_b_mag_a":
        # B's feature directions, A's response magnitudes
        swapped = U_B @ torch.diag(S_A) @ Vh_B
        result = (1.0 - alpha) * mat_a + alpha * swapped

    elif mode == "svd_blend":
        # Procrustes alignment: rotate B's singular vectors to match A's frame
        # Align U: find R_U = argmin ||U_A - U_B @ R_U||
        M_U = U_A.T @ U_B
        P_U, _, Qt_U = torch.linalg.svd(M_U, full_matrices=False)
        R_U = P_U @ Qt_U
        U_aligned = U_B @ R_U

        # Align Vh: find R_V such that Vh_A ≈ R_V @ Vh_B
        M_V = Vh_A @ Vh_B.T
        P_V, _, Qt_V = torch.linalg.svd(M_V, full_matrices=False)
        R_V = P_V @ Qt_V
        Vh_aligned = R_V @ Vh_B

        # Interpolate all components
        U_blend = (1.0 - alpha) * U_A + alpha * U_aligned
        S_blend = (1.0 - alpha) * S_A + alpha * S_B
        Vh_blend = (1.0 - alpha) * Vh_A + alpha * Vh_aligned

        result = U_blend @ torch.diag(S_blend) @ Vh_blend

    else:
        return torch.lerp(w_a, w_b, alpha).clone()

    # Reshape back
    if w_a.ndim > 2:
        result = result.reshape(shape)

    return result.clone()


def _compute_per_key_cosine(path_a: str, path_b: str, key_filter=None) -> dict:
    """Compute per-key cosine similarity. Returns {key: similarity}.

    Used by Cosine Adaptive merge to get per-tensor adaptive alphas.
    key_filter: optional callable(key) -> bool to limit which keys are computed.
    """
    similarities = {}

    with safe_open(path_a, framework="pt", device="cpu") as f_a, \
         safe_open(path_b, framework="pt", device="cpu") as f_b:
        keys_a = set(f_a.keys())
        keys_b = set(f_b.keys())
        shared_keys = sorted(keys_a & keys_b)

        for key in shared_keys:
            if key_filter and not key_filter(key):
                continue

            sl = f_a.get_slice(key)
            dtype_str = str(sl.get_dtype())
            if "int" in dtype_str or "bool" in dtype_str:
                continue

            t_a = f_a.get_tensor(key).float().flatten()
            t_b = f_b.get_tensor(key).float().flatten()

            if t_a.shape != t_b.shape:
                del t_a, t_b
                continue

            dot = torch.dot(t_a, t_b).item()
            na = torch.dot(t_a, t_a).item()
            nb = torch.dot(t_b, t_b).item()

            del t_a, t_b

            if not (math.isfinite(dot) and math.isfinite(na) and math.isfinite(nb)):
                continue

            denom = math.sqrt(na) * math.sqrt(nb)
            sim = dot / denom if denom > 1e-12 else 0.0
            similarities[key] = sim

    return similarities


def _cosine_adaptive_alphas(similarities: dict, shift: float = 0.0) -> dict:
    """Convert per-key cosine similarities to per-key merge alphas.

    High similarity → preserve more of A (lower alpha).
    Low similarity → incorporate more of B (higher alpha).

    shift > 0: shifts toward keeping A (more conservative)
    shift < 0: shifts toward incorporating B (more aggressive)
    """
    if not similarities:
        return {}

    sims = list(similarities.values())
    sims_sorted = sorted(sims)
    # Use 1st and 99th percentile to avoid outlier distortion
    p1 = sims_sorted[max(0, int(len(sims_sorted) * 0.01))]
    p99 = sims_sorted[min(len(sims_sorted) - 1, int(len(sims_sorted) * 0.99))]

    alphas = {}
    for key, sim in similarities.items():
        if p99 - p1 > 1e-6:
            # Normalize to [0, 1] where 0 = most similar, 1 = most divergent
            normalized = max(0.0, min(1.0, (sim - p1) / (p99 - p1)))
        else:
            normalized = 0.5

        # High similarity (normalized~1) → low alpha (keep A)
        # Low similarity (normalized~0) → high alpha (incorporate B)
        # Apply shift: positive shift → keep more of A
        k_weight = max(0.0, min(1.0, normalized - shift))
        # Invert: cosineA formula — high sim = keep A = low alpha
        alpha = 1.0 - k_weight
        alphas[key] = alpha

    return alphas


# =========================================================================
# MERGE ENGINE
# =========================================================================

_merge_state = {
    "active": False, "progress": 0.0, "current_key": "",
    "keys_done": 0, "keys_total": 0,
    "status": "idle", "error": None, "result": None,
    "started": None, "elapsed": 0,
    # Chain-scoped meta. 0/0 means "not running a chain"; the merge-board
    # frontend uses these to show "Step N/M" and to compute monotonic
    # overall progress across step transitions.
    "chain_step": 0, "chain_total": 0,
}
_cancel_event = Event()

# Methods that require Model C
METHODS_NEEDING_C = {"add_difference"}
# Methods that use task vectors (B - A or B - C)
TASK_VECTOR_METHODS = {"ties", "dare", "dare_ties"}
# All valid methods
ALL_METHODS = {"weighted_sum", "slerp", "add_difference", "ties", "dare", "dare_ties", "cosine_adaptive", "star", "svd_struct_a_mag_b", "svd_struct_b_mag_a", "svd_blend", "della", "della_ties", "breadcrumbs"}


def _get_models_dir() -> str:
    try:
        from modules.paths import models_path
        sd_dir = os.path.join(models_path, "Stable-diffusion")
        if os.path.isdir(sd_dir): return sd_dir
    except Exception: pass
    models_dir = getattr(shared, 'models_path', 'models')
    return os.path.join(models_dir, "Stable-diffusion")


def _resolve_model_path(filename: str) -> str:
    if os.path.isabs(filename) and os.path.isfile(filename):
        return filename
    models_dir = _get_models_dir()
    full = os.path.join(models_dir, filename)
    if os.path.isfile(full): return full
    for info in sd_models.checkpoints_list.values():
        if info.model_name == filename or info.title == filename or os.path.basename(info.filename) == filename:
            return info.filename
    raise FileNotFoundError(f"Model not found: {filename}")


def _broadcast_workshop_progress():
    try:
        from studio_api import _progress_connections, _broadcast_progress
    except ImportError:
        try:
            from scripts.studio_api import _progress_connections, _broadcast_progress
        except ImportError: return
    if not _progress_connections: return
    data = {
        "type": "workshop_progress",
        "progress": _merge_state["progress"],
        "current_key": _merge_state["current_key"],
        "keys_done": _merge_state["keys_done"],
        "keys_total": _merge_state["keys_total"],
        "status": _merge_state["status"],
        "error": _merge_state["error"],
        "elapsed": _merge_state["elapsed"],
        "chain_step": _merge_state.get("chain_step", 0),
        "chain_total": _merge_state.get("chain_total", 0),
    }
    loop = asyncio.new_event_loop()
    try: loop.run_until_complete(_broadcast_progress(data))
    finally: loop.close()


def _slerp_tensor(t_a: torch.Tensor, t_b: torch.Tensor, t: float) -> torch.Tensor:
    """Spherical linear interpolation. Degenerates to LERP when |dot| > 0.9995."""
    a_flat = t_a.flatten().float()
    b_flat = t_b.flatten().float()
    a_norm = torch.nn.functional.normalize(a_flat, dim=0)
    b_norm = torch.nn.functional.normalize(b_flat, dim=0)
    dot = torch.clamp(torch.dot(a_norm, b_norm), -1.0, 1.0).item()

    if abs(dot) > 0.9995:
        return torch.lerp(t_a, t_b, t)

    theta = math.acos(dot)
    sin_theta = math.sin(theta)
    s0 = math.sin((1.0 - t) * theta) / sin_theta
    s1 = math.sin(t * theta) / sin_theta
    return s0 * t_a + s1 * t_b


def _merge_tensor_pair(t_a: torch.Tensor, t_b: torch.Tensor, key_alpha: float,
                       method: str, key: str,
                       density: float = 0.2, drop_rate: float = 0.9,
                       cosine_alpha: Optional[float] = None,
                       eta: float = 0.1,
                       stats: Optional[dict] = None) -> torch.Tensor:
    """Merge two tensors using the specified method. All math in fp32.

    For task-vector methods (ties, dare, dare_ties): A is base, B is finetune.
    key_alpha is λ (scaling factor for the task vector).
    For cosine_adaptive: cosine_alpha overrides key_alpha with per-key adaptive value.
    """
    if method == "weighted_sum":
        return torch.lerp(t_a, t_b, key_alpha)

    elif method == "slerp":
        a_flat = t_a.flatten().float()
        b_flat = t_b.flatten().float()
        a_n = torch.nn.functional.normalize(a_flat, dim=0)
        b_n = torch.nn.functional.normalize(b_flat, dim=0)
        dot = torch.clamp(torch.dot(a_n, b_n), -1.0, 1.0).item()
        del a_flat, b_flat, a_n, b_n
        if abs(dot) > 0.9995:
            if stats is not None:
                stats["lerp_fallback"] = stats.get("lerp_fallback", 0) + 1
            return torch.lerp(t_a, t_b, key_alpha)
        theta = math.acos(dot)
        sin_theta = math.sin(theta)
        s0 = math.sin((1.0 - key_alpha) * theta) / sin_theta
        s1 = math.sin(key_alpha * theta) / sin_theta
        if stats is not None:
            stats["slerp_count"] = stats.get("slerp_count", 0) + 1
        return s0 * t_a + s1 * t_b

    elif method == "ties":
        # Task vector: finetune - base
        task_vec = (t_b - t_a).float()
        trimmed = _ties_trim_tensor(task_vec, density)
        return t_a + key_alpha * trimmed

    elif method == "dare":
        task_vec = (t_b - t_a).float()
        # Use key hash as seed for reproducibility across runs
        seed = hash(key) & 0x7FFFFFFF
        dared = _dare_mask_tensor(task_vec, drop_rate, seed=seed)
        return t_a + key_alpha * dared

    elif method == "dare_ties":
        task_vec = (t_b - t_a).float()
        seed = hash(key) & 0x7FFFFFFF
        processed = _dare_ties_tensor(task_vec, density, drop_rate, seed=seed)
        return t_a + key_alpha * processed

    elif method == "della":
        task_vec = (t_b - t_a).float()
        seed = hash(key) & 0x7FFFFFFF
        masked = _della_mask_tensor(task_vec, drop_rate, seed=seed)
        return t_a + key_alpha * masked

    elif method == "della_ties":
        task_vec = (t_b - t_a).float()
        seed = hash(key) & 0x7FFFFFFF
        processed = _della_ties_tensor(task_vec, density, drop_rate, seed=seed)
        return t_a + key_alpha * processed

    elif method == "breadcrumbs":
        task_vec = (t_b - t_a).float()
        processed = _breadcrumbs_trim_tensor(task_vec, density, drop_rate)
        return t_a + key_alpha * processed

    elif method == "cosine_adaptive":
        # Use per-key cosine alpha if available, otherwise fall back to global
        alpha = cosine_alpha if cosine_alpha is not None else key_alpha
        return torch.lerp(t_a, t_b, alpha)

    elif method == "star":
        task_vec = (t_b - t_a).float()
        denoised = _star_denoise_tensor(task_vec, eta)
        return t_a + key_alpha * denoised

    elif method in ("svd_struct_a_mag_b", "svd_struct_b_mag_a", "svd_blend"):
        return _svd_split_tensor(t_a.float(), t_b.float(), method, key_alpha)

    else:
        # Fallback — should never reach here if validation is correct
        return torch.lerp(t_a, t_b, key_alpha)


def merge_models(
    path_a: str, path_b: str, output_path: str,
    method: str = "weighted_sum", alpha: float = 0.5,
    block_weights: dict = None, save_fp16: bool = True,
    path_c: str = None,
    density: float = 0.2, drop_rate: float = 0.9,
    cosine_shift: float = 0.0, eta: float = 0.1,
):
    """Key-iterative model merge with optional per-block weights.

    Supports: weighted_sum, slerp, add_difference, ties, dare, dare_ties,
              cosine_adaptive, star, svd_struct_a_mag_b, svd_struct_b_mag_a, svd_blend.
    block_weights: { block_group: alpha_override } or None for global alpha.
    path_c: required for add_difference only.
    density: TIES/DARE-TIES — fraction of task vector to keep (0.0-1.0).
    drop_rate: DARE/DARE-TIES — fraction of task vector to randomly drop (0.0-1.0).
    cosine_shift: Cosine Adaptive — shift toward A (positive) or B (negative).
    eta: STAR — truncation threshold for singular values (0.0-1.0).
    """
    global _merge_state
    _cancel_event.clear()
    start = time.time()

    # --- Merge banner ---
    bw_count = len(block_weights) if block_weights else 0
    bw_summary = ""
    if block_weights:
        unique_vals = set(block_weights.values())
        if len(unique_vals) == 1:
            bw_summary = f" (all blocks → {list(unique_vals)[0]})"
        else:
            bw_summary = f" ({bw_count} blocks, range {min(block_weights.values()):.2f}–{max(block_weights.values()):.2f})"

    print(f"{TAG} ╔══════════════════════════════════════════════")
    print(f"{TAG} ║ Starting merge")
    print(f"{TAG} ║  Method:  {method.upper()}")
    print(f"{TAG} ║  Alpha:   {alpha}")
    print(f"{TAG} ║  Model A: {os.path.basename(path_a)}")
    print(f"{TAG} ║  Model B: {os.path.basename(path_b)}")
    if path_c:
        print(f"{TAG} ║  Model C: {os.path.basename(path_c)}")
    print(f"{TAG} ║  Output:  {os.path.basename(output_path)}")
    print(f"{TAG} ║  fp16:    {save_fp16}")
    if block_weights:
        print(f"{TAG} ║  Block weights: YES{bw_summary}")
    else:
        print(f"{TAG} ║  Block weights: NO (global alpha)")
    if method in ("ties", "dare_ties", "della_ties", "breadcrumbs"):
        print(f"{TAG} ║  Density: {density}")
    if method in ("dare", "dare_ties", "della", "della_ties", "breadcrumbs"):
        print(f"{TAG} ║  Drop rate: {drop_rate}")
    if method == "cosine_adaptive":
        print(f"{TAG} ║  Cosine shift: {cosine_shift}")
    if method == "star":
        print(f"{TAG} ║  Eta (η): {eta}")
    print(f"{TAG} ╚══════════════════════════════════════════════")

    _merge_state.update({
        "active": True, "progress": 0.0, "current_key": "",
        "keys_done": 0, "keys_total": 0, "status": "running",
        "error": None, "result": None,
        "started": datetime.now(timezone.utc).isoformat(), "elapsed": 0,
        "chain_step": 0, "chain_total": 0,
    })

    try:
        output_dict = {}
        dtype_warning_logged = False
        nan_logged = 0
        block_alpha_used = {}
        stats = {}  # method-specific stats

        # --- Cosine Adaptive: pre-compute per-key similarities ---
        cosine_alphas = {}
        if method == "cosine_adaptive":
            print(f"{TAG} Cosine Adaptive: computing per-key similarities (pass 1)...")
            _merge_state["current_key"] = "(computing cosine similarities...)"
            _broadcast_workshop_progress()
            sims = _compute_per_key_cosine(path_a, path_b)
            cosine_alphas = _cosine_adaptive_alphas(sims, shift=cosine_shift)
            print(f"{TAG} Cosine Adaptive: {len(cosine_alphas)} per-key alphas computed")
            if cosine_alphas:
                alpha_vals = list(cosine_alphas.values())
                print(f"{TAG} Cosine Adaptive: alpha range {min(alpha_vals):.4f} – {max(alpha_vals):.4f}, "
                      f"mean {sum(alpha_vals)/len(alpha_vals):.4f}")

        # --- Open model files ---
        # Use ExitStack pattern for optional Model C
        import contextlib
        with contextlib.ExitStack() as stack:
            f_a = stack.enter_context(safe_open(path_a, framework="pt", device="cpu"))
            f_b = stack.enter_context(safe_open(path_b, framework="pt", device="cpu"))
            f_c = None
            if path_c and method == "add_difference":
                f_c = stack.enter_context(safe_open(path_c, framework="pt", device="cpu"))

            keys_a = set(f_a.keys())
            keys_b = set(f_b.keys())
            keys_c = set(f_c.keys()) if f_c else set()
            all_keys = sorted(keys_a | keys_b | keys_c)
            _merge_state["keys_total"] = len(all_keys)
            arch_info = detect_architecture(keys_a)
            arch = arch_info["arch"]

            key_info = f"{len(all_keys)} total ({len(keys_a & keys_b)} shared"
            if keys_c:
                key_info += f", {len(keys_a & keys_b & keys_c)} tri-shared"
            key_info += f", {len(keys_a - keys_b)} A-only, {len(keys_b - keys_a)} B-only"
            if keys_c:
                key_info += f", {len(keys_c - keys_a - keys_b)} C-only"
            key_info += ")"
            print(f"{TAG} Architecture: {arch_info['details']}")
            print(f"{TAG} Keys: {key_info}")

            for i, key in enumerate(all_keys):
                if _cancel_event.is_set():
                    _merge_state.update({"status": "cancelled", "active": False})
                    _broadcast_workshop_progress()
                    return

                _merge_state["current_key"] = key
                _merge_state["keys_done"] = i

                # --- Add Difference: 3-model merge ---
                if method == "add_difference" and f_c is not None:
                    if key in keys_a and key in keys_b and key in keys_c:
                        t_a = f_a.get_tensor(key).float()
                        t_b = f_b.get_tensor(key).float()
                        t_c = f_c.get_tensor(key).float()

                        if not dtype_warning_logged:
                            raw_a = str(f_a.get_slice(key).get_dtype())
                            raw_b = str(f_b.get_slice(key).get_dtype())
                            raw_c = str(f_c.get_slice(key).get_dtype())
                            if raw_a != raw_b or raw_a != raw_c:
                                print(f"{TAG} Warning: input dtype mismatch — A={raw_a}, B={raw_b}, C={raw_c}. Upcasting to fp32.")
                                dtype_warning_logged = True

                        if t_a.shape != t_b.shape or t_a.shape != t_c.shape:
                            print(f"{TAG} Shape mismatch on '{key}' — keeping Model A")
                            t_out = t_a
                        elif not (torch.isfinite(t_a).all() and torch.isfinite(t_b).all() and torch.isfinite(t_c).all()):
                            t_out = t_a  # Fall back to A on NaN
                            nan_logged += 1
                            if nan_logged <= 3:
                                print(f"{TAG} NaN detected in '{key}' — keeping A")
                                if nan_logged == 3:
                                    print(f"{TAG} (suppressing further NaN warnings)")
                        else:
                            block = classify_key(key, arch)
                            key_alpha = alpha
                            if block_weights and block in block_weights:
                                key_alpha = block_weights[block]
                            if block not in block_alpha_used:
                                block_alpha_used[block] = key_alpha

                            # Add Difference: θ_A + α·(θ_B − θ_C)
                            # Subtraction MUST be fp32 (catastrophic cancellation)
                            diff = (t_b - t_c).float()
                            t_out = t_a + key_alpha * diff

                        del t_a, t_b, t_c
                    elif key in keys_a:
                        t_out = f_a.get_tensor(key)
                    elif key in keys_b:
                        t_out = f_b.get_tensor(key)
                    else:
                        t_out = f_c.get_tensor(key)

                # --- 2-model methods ---
                elif key in keys_a and key in keys_b:
                    t_a = f_a.get_tensor(key).float()
                    t_b = f_b.get_tensor(key).float()

                    if not dtype_warning_logged:
                        raw_a = f_a.get_slice(key).get_dtype()
                        raw_b = f_b.get_slice(key).get_dtype()
                        if str(raw_a) != str(raw_b):
                            print(f"{TAG} Warning: input dtype mismatch — A={raw_a}, B={raw_b}. Upcasting to fp32.")
                            dtype_warning_logged = True

                    if t_a.shape != t_b.shape:
                        print(f"{TAG} Shape mismatch on '{key}': {t_a.shape} vs {t_b.shape} — keeping Model A")
                        t_out = t_a
                    elif not torch.isfinite(t_a).all() or not torch.isfinite(t_b).all():
                        a_bad = not torch.isfinite(t_a).all()
                        b_bad = not torch.isfinite(t_b).all()
                        if a_bad and b_bad:
                            t_out = t_a
                            if nan_logged < 3:
                                print(f"{TAG} NaN in both A and B for '{key}' — keeping A (both corrupted)")
                        elif b_bad:
                            t_out = t_a
                            if nan_logged < 3:
                                print(f"{TAG} NaN in B for '{key}' — keeping A")
                        else:
                            t_out = t_b
                            if nan_logged < 3:
                                print(f"{TAG} NaN in A for '{key}' — keeping B")
                        nan_logged += 1
                        if nan_logged == 3:
                            print(f"{TAG} (suppressing further NaN warnings)")
                    else:
                        block = classify_key(key, arch)
                        key_alpha = alpha
                        if block_weights and block in block_weights:
                            key_alpha = block_weights[block]
                        if block not in block_alpha_used:
                            block_alpha_used[block] = key_alpha

                        # Get per-key cosine alpha if applicable
                        c_alpha = cosine_alphas.get(key) if method == "cosine_adaptive" else None

                        t_out = _merge_tensor_pair(
                            t_a, t_b, key_alpha, method, key,
                            density=density, drop_rate=drop_rate,
                            cosine_alpha=c_alpha, eta=eta, stats=stats,
                        )

                    del t_a, t_b
                elif key in keys_a:
                    t_out = f_a.get_tensor(key)
                else:
                    t_out = f_b.get_tensor(key)

                # Downcast — never VAE keys
                if save_fp16 and t_out.dtype == torch.float32:
                    if VAE_PREFIX not in key:
                        t_out = t_out.half()

                output_dict[key] = t_out

                if i % 50 == 0:
                    _merge_state["progress"] = i / len(all_keys)
                    _merge_state["elapsed"] = round(time.time() - start, 1)
                    _broadcast_workshop_progress()

                if i % 500 == 0 and i > 0:
                    elapsed_so_far = round(time.time() - start, 1)
                    pct = round(i / len(all_keys) * 100)
                    print(f"{TAG} Progress: {pct}% ({i}/{len(all_keys)} keys, {elapsed_so_far}s)")

        # --- Summary ---
        merge_time = round(time.time() - start, 1)
        print(f"{TAG} Merge math complete in {merge_time}s")

        if method == "slerp":
            print(f"{TAG} SLERP: {stats.get('slerp_count', 0)} spherical, "
                  f"{stats.get('lerp_fallback', 0)} LERP fallback")
        if nan_logged:
            print(f"{TAG} NaN guard: {nan_logged} keys had corrupted weights")
        if block_weights:
            non_default = [(b, a) for b, a in block_alpha_used.items() if abs(a - alpha) > 0.001]
            if non_default:
                print(f"{TAG} Block weight overrides: {len(non_default)} blocks differ from global alpha {alpha}")
                for b, a in sorted(non_default)[:10]:
                    print(f"{TAG}   {b}: {a}")
                if len(non_default) > 10:
                    print(f"{TAG}   ... and {len(non_default) - 10} more")

        # Metadata
        recipe = {
            "method": method,
            "model_a": os.path.basename(path_a),
            "model_b": os.path.basename(path_b),
            "alpha": alpha, "block_weights": block_weights,
            "fp16": save_fp16, "architecture": arch_info["arch"],
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "workshop_version": VERSION,
        }
        if path_c:
            recipe["model_c"] = os.path.basename(path_c)
        if method in ("ties", "dare_ties", "della_ties", "breadcrumbs"):
            recipe["density"] = density
        if method in ("dare", "dare_ties", "della", "della_ties", "breadcrumbs"):
            recipe["drop_rate"] = drop_rate
        if method == "cosine_adaptive":
            recipe["cosine_shift"] = cosine_shift
        if method == "star":
            recipe["eta"] = eta

        metadata = {"studio_workshop_recipe": json.dumps(recipe)}

        _merge_state.update({"current_key": "(saving...)", "progress": 0.95})
        _broadcast_workshop_progress()

        output_size = sum(t.nelement() * t.element_size() for t in output_dict.values()) / (1024**3)
        print(f"{TAG} Saving {len(output_dict)} keys ({output_size:.2f} GB) to {os.path.basename(output_path)}...")

        save_file(output_dict, output_path, metadata=metadata)
        del output_dict

        actual_size = os.path.getsize(output_path) / (1024**3)
        elapsed = round(time.time() - start, 1)
        save_time = round(elapsed - merge_time, 1)
        _merge_state.update({
            "active": False, "progress": 1.0, "status": "complete",
            "current_key": "", "keys_done": _merge_state["keys_total"],
            "elapsed": elapsed,
            "result": {
                "output": output_path,
                "filename": os.path.basename(output_path),
                "elapsed": elapsed, "recipe": recipe,
            },
        })
        _broadcast_workshop_progress()
        print(f"{TAG} ✓ Merge complete: {os.path.basename(output_path)} ({actual_size:.2f} GB)")
        print(f"{TAG}   Math: {merge_time}s | Save: {save_time}s | Total: {elapsed}s")
        _journal_add_from_merge_state()

    except Exception as e:
        _merge_state.update({
            "active": False, "status": "error",
            "error": str(e), "elapsed": round(time.time() - start, 1),
        })
        _broadcast_workshop_progress()
        print(f"{TAG} Merge error: {e}")
        traceback.print_exc()


# =========================================================================
# IN-MEMORY MERGE — Phase 3 + Phase 4 extensions
# =========================================================================

UNET_PREFIX = "model.diffusion_model."

_memory_merge = {
    "active": False,
    "backup": None,
    "recipe": None,
    "validation": None,
}


def _get_diffusion_model():
    """Get the active diffusion model nn.Module."""
    sd_model = getattr(shared, 'sd_model', None)
    if sd_model is None:
        raise RuntimeError("No model loaded")

    forge_objects = getattr(sd_model, 'forge_objects', None)
    if forge_objects is None:
        raise RuntimeError("Model has no forge_objects — is it fully loaded?")

    unet_patcher = forge_objects.unet
    if unet_patcher is None:
        raise RuntimeError("No UNet patcher found")

    diffusion_model = unet_patcher.model.diffusion_model
    if diffusion_model is None:
        raise RuntimeError("No diffusion_model found on UNet patcher")

    return diffusion_model, unet_patcher


def compute_merge_dict(
    path_a: str, path_b: str,
    method: str = "weighted_sum", alpha: float = 0.5,
    block_weights: dict = None,
    path_c: str = None,
    density: float = 0.2, drop_rate: float = 0.9,
    cosine_shift: float = 0.0, eta: float = 0.1,
) -> Tuple[dict, dict]:
    """Compute merged state dict in memory. Returns (dict, arch_info).

    Same math as merge_models() but returns the dict instead of writing to disk.
    Only computes UNet keys (model.diffusion_model.*) for in-memory swap.
    """
    output_dict = {}

    # --- Cosine Adaptive: pre-compute per-key similarities ---
    cosine_alphas = {}
    if method == "cosine_adaptive":
        print(f"{TAG} In-memory Cosine Adaptive: computing per-key similarities...")
        sims = _compute_per_key_cosine(
            path_a, path_b,
            key_filter=lambda k: k.startswith(UNET_PREFIX)
        )
        cosine_alphas = _cosine_adaptive_alphas(sims, shift=cosine_shift)
        print(f"{TAG} Cosine Adaptive: {len(cosine_alphas)} per-key alphas computed")

    import contextlib
    with contextlib.ExitStack() as stack:
        f_a = stack.enter_context(safe_open(path_a, framework="pt", device="cpu"))
        f_b = stack.enter_context(safe_open(path_b, framework="pt", device="cpu"))
        f_c = None
        if path_c and method == "add_difference":
            f_c = stack.enter_context(safe_open(path_c, framework="pt", device="cpu"))

        keys_a = set(f_a.keys())
        keys_b = set(f_b.keys())
        keys_c = set(f_c.keys()) if f_c else set()

        # Only UNet keys for in-memory merge
        all_unet = set()
        for k in (keys_a | keys_b | keys_c):
            if k.startswith(UNET_PREFIX):
                all_unet.add(k)
        unet_keys = sorted(all_unet)

        arch_info = detect_architecture(keys_a)
        arch = arch_info["arch"]

        print(f"{TAG} In-memory merge: computing {len(unet_keys)} UNet keys ({method.upper()})...")

        stats = {}

        for i, key in enumerate(unet_keys):
            # --- Add Difference: 3-model ---
            if method == "add_difference" and f_c is not None:
                if key in keys_a and key in keys_b and key in keys_c:
                    t_a = f_a.get_tensor(key).float()
                    t_b = f_b.get_tensor(key).float()
                    t_c = f_c.get_tensor(key).float()

                    if t_a.shape != t_b.shape or t_a.shape != t_c.shape:
                        output_dict[key] = t_a
                    elif not (torch.isfinite(t_a).all() and torch.isfinite(t_b).all() and torch.isfinite(t_c).all()):
                        output_dict[key] = t_a
                    else:
                        block = classify_key(key, arch)
                        key_alpha = alpha
                        if block_weights and block in block_weights:
                            key_alpha = block_weights[block]
                        diff = (t_b - t_c).float()
                        output_dict[key] = t_a + key_alpha * diff

                    del t_a, t_b, t_c
                elif key in keys_a:
                    output_dict[key] = f_a.get_tensor(key)
                elif key in keys_b:
                    output_dict[key] = f_b.get_tensor(key)
                else:
                    output_dict[key] = f_c.get_tensor(key)

            # --- 2-model methods ---
            elif key in keys_a and key in keys_b:
                t_a = f_a.get_tensor(key).float()
                t_b = f_b.get_tensor(key).float()

                if t_a.shape != t_b.shape:
                    output_dict[key] = t_a
                elif not torch.isfinite(t_a).all() or not torch.isfinite(t_b).all():
                    if not torch.isfinite(t_b).all():
                        output_dict[key] = t_a
                    else:
                        output_dict[key] = t_b
                else:
                    block = classify_key(key, arch)
                    key_alpha = alpha
                    if block_weights and block in block_weights:
                        key_alpha = block_weights[block]

                    c_alpha = cosine_alphas.get(key) if method == "cosine_adaptive" else None

                    output_dict[key] = _merge_tensor_pair(
                        t_a, t_b, key_alpha, method, key,
                        density=density, drop_rate=drop_rate,
                        cosine_alpha=c_alpha, eta=eta, stats=stats,
                    )

                del t_a, t_b
            elif key in keys_a:
                output_dict[key] = f_a.get_tensor(key)
            elif key in keys_b:
                output_dict[key] = f_b.get_tensor(key)
            elif f_c and key in keys_c:
                output_dict[key] = f_c.get_tensor(key)

    return output_dict, arch_info


def swap_unet_weights(merged_dict: dict) -> dict:
    """Hot-swap UNet weights from merged state dict into the active model.

    Uses .data.copy_() to bypass InferenceMode tensor locks.
    """
    diffusion_model, unet_patcher = _get_diffusion_model()

    # Backup current weights to CPU
    print(f"{TAG} Backing up current UNet weights to CPU...")
    backup_start = time.time()
    backup = {k: v.cpu().clone() for k, v in diffusion_model.state_dict().items()}
    print(f"{TAG} Backup complete ({len(backup)} keys, {time.time() - backup_start:.1f}s)")
    _memory_merge["backup"] = backup

    # Strip UNET_PREFIX from merged keys
    stripped = {}
    for k, v in merged_dict.items():
        if k.startswith(UNET_PREFIX):
            stripped[k[len(UNET_PREFIX):]] = v
        else:
            stripped[k] = v

    # Determine target device and dtype
    target_device = unet_patcher.load_device
    model_dtype = diffusion_model.dtype if hasattr(diffusion_model, 'dtype') else None
    if model_dtype is None:
        try:
            model_dtype = next(diffusion_model.parameters()).dtype
        except StopIteration:
            model_dtype = torch.float16

    print(f"{TAG} Loading merged weights (device={target_device}, dtype={model_dtype})...")
    load_start = time.time()

    # Copy weights via .data.copy_() — bypasses InferenceMode
    current_sd = dict(diffusion_model.named_parameters())
    current_buffers = dict(diffusion_model.named_buffers())
    current_sd.update(current_buffers)

    loaded = 0
    missing = []
    unexpected = []
    for k, v in stripped.items():
        if k in current_sd:
            param = current_sd[k]
            merged_tensor = v.to(dtype=param.data.dtype, device=param.data.device)
            param.data.copy_(merged_tensor)
            loaded += 1
        else:
            unexpected.append(k)

    for k in current_sd:
        if k not in stripped:
            missing.append(k)

    load_time = time.time() - load_start
    print(f"{TAG} Weight swap complete ({loaded} keys copied, {load_time:.1f}s)")

    if missing:
        print(f"{TAG} Note: {len(missing)} model keys not in merge (kept original)")
    if unexpected:
        print(f"{TAG} Warning: {len(unexpected)} merged keys not found in model")
        if len(unexpected) <= 5:
            for k in unexpected:
                print(f"{TAG}   unexpected: {k}")

    # Post-swap validation
    validation = _validate_swap(diffusion_model, stripped)

    return {
        "load_time": round(load_time, 1),
        "keys_loaded": loaded,
        "missing": len(missing),
        "unexpected": len(unexpected),
        "validation": validation,
    }


def _validate_swap(diffusion_model, expected_keys: dict) -> dict:
    """Post-swap validation: sample keys for isfinite and shape match."""
    import random

    current_sd = diffusion_model.state_dict()
    sample_keys = list(expected_keys.keys())
    if len(sample_keys) > 20:
        sample_keys = random.sample(sample_keys, 20)

    nan_count = 0
    shape_mismatch = 0
    checked = 0

    for k in sample_keys:
        if k not in current_sd:
            continue
        checked += 1
        tensor = current_sd[k]
        if not torch.isfinite(tensor).all():
            nan_count += 1
        if k in expected_keys and tensor.shape != expected_keys[k].shape:
            shape_mismatch += 1

    result = {
        "checked": checked,
        "nan_count": nan_count,
        "shape_mismatch": shape_mismatch,
        "passed": nan_count == 0 and shape_mismatch == 0,
    }

    if result["passed"]:
        print(f"{TAG} Post-swap validation: PASSED ({checked} keys sampled, all finite, shapes match)")
    else:
        print(f"{TAG} Post-swap validation: FAILED — {nan_count} NaN keys, {shape_mismatch} shape mismatches")

    _memory_merge["validation"] = result
    return result


def revert_unet_weights() -> dict:
    """Restore UNet weights from backup."""
    if not _memory_merge["backup"]:
        raise RuntimeError("No backup to restore from")

    diffusion_model, unet_patcher = _get_diffusion_model()

    print(f"{TAG} Reverting UNet to pre-merge state...")
    start = time.time()

    current_params = dict(diffusion_model.named_parameters())
    current_buffers = dict(diffusion_model.named_buffers())
    current_params.update(current_buffers)

    restored = 0
    for k, v in _memory_merge["backup"].items():
        if k in current_params:
            current_params[k].data.copy_(v.to(device=current_params[k].data.device, dtype=current_params[k].data.dtype))
            restored += 1

    elapsed = time.time() - start

    _memory_merge["active"] = False
    _memory_merge["backup"] = None
    _memory_merge["recipe"] = None
    _memory_merge["validation"] = None

    print(f"{TAG} Revert complete ({restored} keys restored, {elapsed:.1f}s)")
    return {"reverted": True, "elapsed": round(elapsed, 1)}


# =========================================================================
# LORA BAKING — Phase 6
# =========================================================================

# Known LoRA suffixes for grouping keys by base name
_LORA_SUFFIXES = [
    ".lora_up.weight", ".lora_down.weight", ".lora_mid.weight",
    "_lora.up.weight", "_lora.down.weight",
    ".lora_A.weight", ".lora_B.weight",
    ".lora.up.weight", ".lora.down.weight",
    ".lora_A", ".lora_B",
    ".lora_linear_layer.up.weight", ".lora_linear_layer.down.weight",
    ".lora_A.default.weight", ".lora_B.default.weight",
    ".hada_w1_a", ".hada_w1_b", ".hada_w2_a", ".hada_w2_b",
    ".hada_t1", ".hada_t2",
    ".lokr_w1", ".lokr_w2", ".lokr_w1_a", ".lokr_w1_b",
    ".lokr_w2_a", ".lokr_w2_b", ".lokr_t2",
    ".oft_blocks", ".rescale",
    ".a1.weight", ".a2.weight", ".b1.weight", ".b2.weight",
    ".alpha", ".dora_scale",
    ".reshape_weight", ".w_norm", ".b_norm",
    ".diff", ".diff_b", ".set_weight",
]

# Checkpoint key prefixes for key mapping
_CKPT_PREFIXES = {
    "unet_sd15": "model.diffusion_model.",
    "te_sd15": "cond_stage_model.model.transformer.text_model.",
    "te_sd15_alt": "cond_stage_model.transformer.text_model.",
    "te1_sdxl": "conditioner.embedders.0.transformer.",
    "te2_sdxl": "conditioner.embedders.1.model.transformer.",
    "vae": "first_stage_model.",
}

# LoRA key prefixes
_LORA_PREFIXES = {
    "lora_unet_": ["unet_sd15"],
    "lora_te_": ["te_sd15", "te_sd15_alt"],
    "lora_te1_": ["te1_sdxl"],
    "lora_te2_": ["te2_sdxl"],
}


def _get_lora_dir() -> str:
    """Get the primary LoRA directory path."""
    try:
        from modules.paths import models_path
        lora_dir = os.path.join(models_path, "Lora")
        if os.path.isdir(lora_dir):
            return lora_dir
    except Exception:
        pass
    models_dir = getattr(shared, 'models_path', 'models')
    return os.path.join(models_dir, "Lora")


def _lora_dir_candidates() -> list:
    """All configured LoRA directories, primary first, deduped.

    Combines the default models/Lora folder with any --lora-dir /
    --lora-dirs CLI paths Forge was launched with, so workshop sees
    everything Canvas can see.
    """
    candidates = []
    primary = _get_lora_dir()
    if primary:
        candidates.append(primary)
    cli_dir = getattr(shared.cmd_opts, 'lora_dir', None) if hasattr(shared, 'cmd_opts') else None
    if cli_dir and cli_dir not in candidates:
        candidates.append(cli_dir)
    for d in (getattr(shared.cmd_opts, 'lora_dirs', None) or []) if hasattr(shared, 'cmd_opts') else []:
        if d and d not in candidates:
            candidates.append(d)
    return candidates


def _resolve_lora_path(filename: str) -> str:
    """Resolve a LoRA filename to full path across every configured dir."""
    if os.path.isabs(filename) and os.path.isfile(filename):
        return filename
    candidates = _lora_dir_candidates()
    for base in candidates:
        if not base:
            continue
        full = os.path.join(base, filename)
        if os.path.isfile(full):
            return full
    # Basename fallback: scan each candidate dir recursively for a match
    basename = os.path.basename(filename)
    if basename:
        for base in candidates:
            if not base or not os.path.isdir(base):
                continue
            for root, dirs, files in os.walk(base):
                for f in files:
                    if f == basename:
                        return os.path.join(root, f)
    raise FileNotFoundError(f"LoRA not found: {filename}")


def _detect_adapter_type(lora_keys: set, base_name: str) -> str:
    """Detect adapter type from the keys present for a given base name."""
    has = lambda suffix: f"{base_name}{suffix}" in lora_keys

    # Check in order of specificity
    if has(".hada_w1_a"):
        return "loha"
    if has(".lokr_w1") or has(".lokr_w1_a"):
        return "lokr"
    if has(".oft_blocks"):
        return "oft"  # BOFT detected by ndim later
    if has(".a1.weight"):
        return "glora"
    if has(".lora_up.weight") or has("_lora.up.weight") or has(".lora_B.weight") \
            or has(".lora.up.weight") or has(".lora_B") or has(".lora_B.default.weight") \
            or has(".lora_linear_layer.up.weight"):
        return "lora"
    if has(".diff"):
        return "diff"
    if has(".set_weight"):
        return "set"
    if has(".w_norm"):
        return "norm"
    return "unknown"


# =========================================================================
# DIFFUSERS ↔ COMPVIS BLOCK MAPPING (SDXL)
# =========================================================================
# LoRAs trained with diffusers/PEFT use a different block naming convention
# than the CompVis format used in A1111/Forge checkpoint files.
# This table maps CompVis block prefixes → diffusers equivalents so we can
# match diffusers-format LoRA keys against CompVis checkpoint keys.

_SDXL_COMPVIS_TO_DIFFUSERS = {
    # conv_in
    "input_blocks.0.0": "conv_in",
    # down_blocks.0 — DownBlock2D (resnets only, no attention)
    "input_blocks.1.0": "down_blocks.0.resnets.0",
    "input_blocks.2.0": "down_blocks.0.resnets.1",
    "input_blocks.3.0.op": "down_blocks.0.downsamplers.0.conv",
    # down_blocks.1 — CrossAttnDownBlock2D
    "input_blocks.4.0": "down_blocks.1.resnets.0",
    "input_blocks.4.1": "down_blocks.1.attentions.0",
    "input_blocks.5.0": "down_blocks.1.resnets.1",
    "input_blocks.5.1": "down_blocks.1.attentions.1",
    "input_blocks.6.0.op": "down_blocks.1.downsamplers.0.conv",
    # down_blocks.2 — CrossAttnDownBlock2D (no downsampler)
    "input_blocks.7.0": "down_blocks.2.resnets.0",
    "input_blocks.7.1": "down_blocks.2.attentions.0",
    "input_blocks.8.0": "down_blocks.2.resnets.1",
    "input_blocks.8.1": "down_blocks.2.attentions.1",
    # mid_block
    "middle_block.0": "mid_block.resnets.0",
    "middle_block.1": "mid_block.attentions.0",
    "middle_block.2": "mid_block.resnets.1",
    # up_blocks.0 — CrossAttnUpBlock2D
    "output_blocks.0.0": "up_blocks.0.resnets.0",
    "output_blocks.0.1": "up_blocks.0.attentions.0",
    "output_blocks.1.0": "up_blocks.0.resnets.1",
    "output_blocks.1.1": "up_blocks.0.attentions.1",
    "output_blocks.2.0": "up_blocks.0.resnets.2",
    "output_blocks.2.1": "up_blocks.0.attentions.2",
    "output_blocks.2.2": "up_blocks.0.upsamplers.0",
    # up_blocks.1 — CrossAttnUpBlock2D
    "output_blocks.3.0": "up_blocks.1.resnets.0",
    "output_blocks.3.1": "up_blocks.1.attentions.0",
    "output_blocks.4.0": "up_blocks.1.resnets.1",
    "output_blocks.4.1": "up_blocks.1.attentions.1",
    "output_blocks.5.0": "up_blocks.1.resnets.2",
    "output_blocks.5.1": "up_blocks.1.attentions.2",
    "output_blocks.5.2": "up_blocks.1.upsamplers.0",
    # up_blocks.2 — UpBlock2D (resnets only, no attention)
    "output_blocks.6.0": "up_blocks.2.resnets.0",
    "output_blocks.7.0": "up_blocks.2.resnets.1",
    "output_blocks.8.0": "up_blocks.2.resnets.2",
    # output
    "out.0": "conv_norm_out",
    "out.2": "conv_out",
    # embeddings
    "time_embed.0": "time_embedding.linear_1",
    "time_embed.2": "time_embedding.linear_2",
    "label_emb.0.0": "add_embedding.linear_1",
    "label_emb.0.2": "add_embedding.linear_2",
}

# Pre-sort by longest prefix first for greedy matching
_SDXL_CV_PREFIXES_SORTED = sorted(
    _SDXL_COMPVIS_TO_DIFFUSERS.keys(), key=len, reverse=True
)


def _build_key_map(ckpt_keys: set, lora_keys: set, arch: str) -> dict:
    """Build mapping from LoRA base names to checkpoint keys.

    Returns: { lora_base_name: checkpoint_key }

    Strategy: for each checkpoint key ending in .weight, generate all possible
    LoRA base names using known prefix/suffix conventions, check if any exist
    in the LoRA key set. This avoids the ambiguous underscore-to-dot problem.
    """
    key_map = {}
    lora_bases = set()

    # First, collect all LoRA base names by stripping known suffixes
    for lk in lora_keys:
        for suffix in _LORA_SUFFIXES:
            if lk.endswith(suffix):
                base = lk[:-len(suffix)]
                lora_bases.add(base)
                break

    # === Standard A1111/Kohya format: lora_unet_*, lora_te_*, lora_te1_*, lora_te2_* ===
    for ckpt_key in ckpt_keys:
        if not ckpt_key.endswith(".weight"):
            continue

        for lora_prefix, ckpt_prefix_names in _LORA_PREFIXES.items():
            for prefix_name in ckpt_prefix_names:
                ckpt_prefix = _CKPT_PREFIXES[prefix_name]
                if ckpt_key.startswith(ckpt_prefix):
                    # Strip prefix and .weight, replace . with _
                    inner = ckpt_key[len(ckpt_prefix):-len(".weight")]
                    lora_base = lora_prefix + inner.replace(".", "_")
                    if lora_base in lora_bases:
                        key_map[lora_base] = ckpt_key
                        break
            if any(lb in key_map for lb in lora_bases if lb.startswith(lora_prefix)):
                continue

    # === FLUX/SD3 direct format: keys match with diffusion_model. prefix ===
    if arch in ("flux1", "flux2", "sd3"):
        for ckpt_key in ckpt_keys:
            if not ckpt_key.endswith(".weight"):
                continue
            if ckpt_key.startswith("model.diffusion_model."):
                inner = ckpt_key[len("model.diffusion_model."):-len(".weight")]
                # Direct match
                if inner in lora_bases:
                    key_map[inner] = ckpt_key
                # diffusers format: transformer.X
                if f"transformer.{inner}" in lora_bases:
                    key_map[f"transformer.{inner}"] = ckpt_key
                # lycoris format
                lycoris_key = f"lycoris_{inner.replace('.', '_')}"
                if lycoris_key in lora_bases:
                    key_map[lycoris_key] = ckpt_key

    # === Generic: try direct base_name → base_name.weight match ===
    for base in lora_bases:
        if base in key_map:
            continue
        # Try direct: base.weight exists in checkpoint
        candidate = f"{base}.weight"
        if candidate in ckpt_keys:
            key_map[base] = candidate
        # Try with model.diffusion_model. prefix
        candidate = f"model.diffusion_model.{base}.weight"
        if candidate in ckpt_keys:
            key_map[base] = candidate
        # Try text_encoders. prefix (generic ComfyUI format)
        if base.startswith("text_encoders."):
            # text_encoders.clip_l.transformer... → try various ckpt prefixes
            inner = base[len("text_encoders."):]
            candidate = f"{inner}.weight"
            if candidate in ckpt_keys:
                key_map[base] = candidate

    # === Diffusers-format LoRA keys (SDXL) ===
    # LoRAs trained with diffusers/PEFT use different block naming:
    #   lora_unet_down_blocks_1_attentions_0_transformer_blocks_0_attn1_to_k
    # vs CompVis checkpoint keys:
    #   model.diffusion_model.input_blocks.4.1.transformer_blocks.0.attn1.to_k.weight
    # Convert CompVis checkpoint keys → diffusers-format LoRA base names.
    if arch == "sdxl" and lora_bases - set(key_map.keys()):
        unet_prefix = "model.diffusion_model."
        for ckpt_key in ckpt_keys:
            if not ckpt_key.startswith(unet_prefix) or not ckpt_key.endswith(".weight"):
                continue
            inner = ckpt_key[len(unet_prefix):-len(".weight")]
            # Find the longest matching CompVis prefix
            for cv_prefix in _SDXL_CV_PREFIXES_SORTED:
                if inner == cv_prefix or inner.startswith(cv_prefix + "."):
                    diff_prefix = _SDXL_COMPVIS_TO_DIFFUSERS[cv_prefix]
                    if inner == cv_prefix:
                        diff_inner = diff_prefix
                    else:
                        diff_inner = diff_prefix + inner[len(cv_prefix):]
                    lora_base = "lora_unet_" + diff_inner.replace(".", "_")
                    if lora_base in lora_bases and lora_base not in key_map:
                        key_map[lora_base] = ckpt_key
                    break

    return key_map


def _compute_lora_delta(
    weight: torch.Tensor, base_name: str, adapter_type: str,
    lora: dict, strength: float = 1.0,
) -> Optional[torch.Tensor]:
    """Compute the weight delta from a LoRA adapter. All math in fp32.

    Returns the modified weight, or None if computation fails.
    """
    def get(suffix):
        return lora.get(f"{base_name}{suffix}")

    # Get alpha
    alpha_tensor = get(".alpha")
    alpha = alpha_tensor.item() if alpha_tensor is not None else None

    # Get dora_scale
    dora_scale = get(".dora_scale")

    try:
        if adapter_type == "lora":
            # Find up/down keys (multiple naming conventions)
            up = down = mid = None
            for up_s, down_s in [
                (".lora_up.weight", ".lora_down.weight"),
                ("_lora.up.weight", "_lora.down.weight"),
                (".lora_B.weight", ".lora_A.weight"),
                (".lora.up.weight", ".lora.down.weight"),
                (".lora_B", ".lora_A"),
                (".lora_B.default.weight", ".lora_A.default.weight"),
                (".lora_linear_layer.up.weight", ".lora_linear_layer.down.weight"),
            ]:
                up = get(up_s)
                down = get(down_s)
                if up is not None and down is not None:
                    break

            if up is None or down is None:
                return None

            up = up.float()
            down = down.float()

            mid = get(".lora_mid.weight")
            if mid is not None:
                mid = mid.float()

            rank = down.shape[0]
            scale = (alpha / rank) if alpha is not None else 1.0

            if mid is not None:
                # Tucker decomposition (LoCon)
                final_shape = [down.shape[1], down.shape[0], mid.shape[2], mid.shape[3]]
                down = torch.mm(
                    down.transpose(0, 1).flatten(start_dim=1),
                    mid.transpose(0, 1).flatten(start_dim=1),
                ).reshape(final_shape).transpose(0, 1)

            lora_diff = torch.mm(up.flatten(start_dim=1), down.flatten(start_dim=1))
            lora_diff = lora_diff.reshape(weight.shape) * scale

        elif adapter_type == "loha":
            w1a = get(".hada_w1_a")
            w1b = get(".hada_w1_b")
            w2a = get(".hada_w2_a")
            w2b = get(".hada_w2_b")
            if any(x is None for x in [w1a, w1b, w2a, w2b]):
                return None

            w1a, w1b = w1a.float(), w1b.float()
            w2a, w2b = w2a.float(), w2b.float()

            rank = w1b.shape[0]
            scale = (alpha / rank) if alpha is not None else 1.0

            t1, t2 = get(".hada_t1"), get(".hada_t2")
            if t1 is not None and t2 is not None:
                t1, t2 = t1.float(), t2.float()
                m1 = torch.einsum("i j k l, j r, i p -> p r k l", t1, w1b, w1a)
                m2 = torch.einsum("i j k l, j r, i p -> p r k l", t2, w2b, w2a)
            else:
                m1 = torch.mm(w1a, w1b)
                m2 = torch.mm(w2a, w2b)

            lora_diff = (m1 * m2).reshape(weight.shape) * scale

        elif adapter_type == "lokr":
            w1 = get(".lokr_w1")
            w2 = get(".lokr_w2")
            w1_a = get(".lokr_w1_a")
            w1_b = get(".lokr_w1_b")
            w2_a = get(".lokr_w2_a")
            w2_b = get(".lokr_w2_b")
            t2 = get(".lokr_t2")
            dim = None

            if w1 is None and w1_a is not None and w1_b is not None:
                dim = w1_b.shape[0]
                w1 = torch.mm(w1_a.float(), w1_b.float())
            elif w1 is not None:
                w1 = w1.float()

            if w2 is None and w2_a is not None and w2_b is not None:
                dim = w2_b.shape[0]
                if t2 is not None:
                    t2 = t2.float()
                    w2 = torch.einsum("i j k l, j r, i p -> p r k l",
                                      t2, w2_b.float(), w2_a.float())
                else:
                    w2 = torch.mm(w2_a.float(), w2_b.float())
            elif w2 is not None:
                w2 = w2.float()

            if w1 is None or w2 is None:
                return None

            scale = (alpha / dim) if (alpha is not None and dim is not None) else 1.0

            if len(w2.shape) == 4:
                w1 = w1.unsqueeze(2).unsqueeze(2)

            lora_diff = torch.kron(w1, w2).reshape(weight.shape) * scale

        elif adapter_type == "oft":
            blocks = get(".oft_blocks")
            if blocks is None:
                return None
            blocks = blocks.float()
            rescale = get(".rescale")

            is_boft = blocks.ndim == 4

            if is_boft:
                # BOFT: butterfly orthogonal
                boft_m, block_num, boft_b, _ = blocks.shape
                I = torch.eye(boft_b, device=blocks.device, dtype=blocks.dtype)
                q = blocks - blocks.transpose(-1, -2)
                normed_q = q
                if alpha is not None and alpha > 0:
                    q_norm = torch.norm(q) + 1e-8
                    if q_norm > alpha:
                        normed_q = q * alpha / q_norm
                r = (I + normed_q) @ (I - normed_q).float().inverse()

                inp = weight.float()
                r_b = boft_b // 2
                for i in range(boft_m):
                    bi = r[i]
                    g = 2
                    k = 2**i * r_b
                    inp = (inp.unflatten(0, (-1, g, k))
                           .transpose(1, 2).flatten(0, 2)
                           .unflatten(0, (-1, boft_b)))
                    inp = torch.einsum("b i j, b j ...-> b i ...", bi, inp)
                    inp = (inp.flatten(0, 1)
                           .unflatten(0, (-1, k, g))
                           .transpose(1, 2).flatten(0, 2))

                if rescale is not None:
                    inp = inp * rescale.float()

                lora_diff = inp - weight.float()
            else:
                # Standard OFT
                block_num, block_size, _ = blocks.shape
                I = torch.eye(block_size, device=blocks.device, dtype=blocks.dtype)
                q = blocks - blocks.transpose(1, 2)
                normed_q = q
                if alpha is not None and alpha > 0:
                    q_norm = torch.norm(q) + 1e-8
                    if q_norm > alpha:
                        normed_q = q * alpha / q_norm
                r = (I + normed_q) @ (I - normed_q).float().inverse()

                _, *shape = weight.shape
                w_blocked = weight.float().view(block_num, block_size, *shape)
                rotated = torch.einsum("k n m, k n ... -> k m ...", r, w_blocked)
                rotated = rotated.flatten(0, 1)

                if rescale is not None:
                    rotated = rotated * rescale.float()

                lora_diff = rotated - weight.float()

        elif adapter_type == "glora":
            a1 = get(".a1.weight")
            a2 = get(".a2.weight")
            b1 = get(".b1.weight")
            b2 = get(".b2.weight")
            if any(x is None for x in [a1, a2, b1, b2]):
                return None

            a1, a2 = a1.float().flatten(start_dim=1), a2.float().flatten(start_dim=1)
            b1, b2 = b1.float().flatten(start_dim=1), b2.float().flatten(start_dim=1)

            # Detect old vs new format
            old_glora = (b2.shape[1] == b1.shape[0] == a1.shape[0] == a2.shape[1])
            rank = a1.shape[0] if old_glora else a2.shape[0]
            scale = (alpha / rank) if alpha is not None else 1.0

            if old_glora:
                lora_diff = (torch.mm(b2, b1) +
                             torch.mm(torch.mm(weight.float().flatten(start_dim=1), a2), a1))
            else:
                w_flat = weight.float().flatten(start_dim=1)
                lora_diff = torch.mm(torch.mm(w_flat, a1), a2) + torch.mm(b1, b2)

            lora_diff = lora_diff.reshape(weight.shape) * scale

        elif adapter_type == "diff":
            diff_w = get(".diff")
            if diff_w is None:
                return None
            lora_diff = diff_w.float()
            if lora_diff.shape != weight.shape:
                print(f"{TAG} LoRA diff shape mismatch for {base_name}: {lora_diff.shape} vs {weight.shape}")
                return None

        elif adapter_type == "set":
            set_w = get(".set_weight")
            if set_w is None:
                return None
            # "set" replaces entirely — return directly, not as delta
            return set_w.float().to(dtype=weight.dtype)

        elif adapter_type == "norm":
            w_norm = get(".w_norm")
            if w_norm is None:
                return None
            lora_diff = w_norm.float()
            if lora_diff.shape != weight.shape:
                return None

        else:
            return None

        # Apply DoRA weight decomposition if present
        if dora_scale is not None and adapter_type not in ("diff", "set", "norm"):
            dora_scale_f = dora_scale.float().to(device=weight.device)
            lora_diff_scaled = lora_diff * 1.0  # already includes adapter scale
            weight_calc = weight.float() + lora_diff_scaled

            wd_on_output = dora_scale_f.shape[0] == weight_calc.shape[0]
            if wd_on_output:
                weight_norm = (weight.float().reshape(weight.shape[0], -1)
                               .norm(dim=1, keepdim=True)
                               .reshape(weight.shape[0], *[1] * (weight.dim() - 1)))
            else:
                weight_norm = (weight_calc.transpose(0, 1)
                               .reshape(weight_calc.shape[1], -1)
                               .norm(dim=1, keepdim=True)
                               .reshape(weight_calc.shape[1], *[1] * (weight_calc.dim() - 1))
                               .transpose(0, 1))
            weight_norm = weight_norm + torch.finfo(weight.dtype).eps
            weight_calc *= dora_scale_f / weight_norm

            if strength != 1.0:
                result = weight.float() + strength * (weight_calc - weight.float())
            else:
                result = weight_calc
            return result.to(dtype=weight.dtype)

        # Standard application: weight + strength * delta
        result = weight.float() + strength * lora_diff
        return result.to(dtype=weight.dtype)

    except Exception as e:
        print(f"{TAG} LoRA compute error for {base_name} ({adapter_type}): {e}")
        import traceback as tb
        tb.print_exc()
        return None


def inspect_lora(path: str) -> dict:
    """Inspect a LoRA file: detect format, count keys, list adapter types."""
    from safetensors import safe_open

    result = {
        "filename": os.path.basename(path),
        "size_mb": round(os.path.getsize(path) / (1024 ** 2), 2),
        "key_count": 0,
        "adapter_types": {},
        "has_te_keys": False,
        "has_unet_keys": False,
        "metadata": {},
    }

    with safe_open(path, framework="pt", device="cpu") as f:
        keys = set(f.keys())
        result["key_count"] = len(keys)
        meta = f.metadata()
        if meta:
            result["metadata"] = dict(meta)

    # Group keys and detect types
    bases = set()
    for k in keys:
        for suffix in _LORA_SUFFIXES:
            if k.endswith(suffix):
                bases.add(k[:-len(suffix)])
                break

    type_counts = {}
    for base in bases:
        atype = _detect_adapter_type(keys, base)
        type_counts[atype] = type_counts.get(atype, 0) + 1

        if any(base.startswith(p) for p in ("lora_te", "text_encoder")):
            result["has_te_keys"] = True
        if any(base.startswith(p) for p in ("lora_unet", "diffusion_model", "transformer")):
            result["has_unet_keys"] = True

    result["adapter_types"] = type_counts
    result["adapter_count"] = len(bases)

    # Detect primary format
    if "lora" in type_counts:
        result["primary_format"] = "LoRA"
    elif "loha" in type_counts:
        result["primary_format"] = "LoHa (LyCORIS)"
    elif "lokr" in type_counts:
        result["primary_format"] = "LoKr (LyCORIS)"
    elif "oft" in type_counts:
        result["primary_format"] = "OFT"
    elif "glora" in type_counts:
        result["primary_format"] = "GLoRA"
    else:
        result["primary_format"] = "Unknown"

    return result


def bake_lora(
    ckpt_path: str, lora_list: List[Tuple[str, float]], output_path: str,
    save_fp16: bool = True,
):
    """Bake one or more LoRAs into a checkpoint. Applied sequentially.

    lora_list: [(lora_path, strength), ...]
    Supports: LoRA, LoHa, LoKr, OFT, BOFT, GLoRA, DoRA, diff, set.
    All math in fp32. Downcast at save time only.
    VAE keys always stay fp32.
    """
    global _merge_state
    _cancel_event.clear()
    start = time.time()

    lora_names = [os.path.basename(p) for p, s in lora_list]
    print(f"{TAG} ╔══════════════════════════════════════════════")
    print(f"{TAG} ║ LoRA BAKE ({len(lora_list)} LoRA{'s' if len(lora_list) > 1 else ''})")
    print(f"{TAG} ║  Checkpoint: {os.path.basename(ckpt_path)}")
    for p, s in lora_list:
        print(f"{TAG} ║  LoRA: {os.path.basename(p)} @ {s}")
    print(f"{TAG} ║  Output:  {os.path.basename(output_path)}")
    print(f"{TAG} ║  fp16:    {save_fp16}")
    print(f"{TAG} ╚══════════════════════════════════════════════")

    _merge_state.update({
        "active": True, "progress": 0.0, "current_key": "",
        "keys_done": 0, "keys_total": 0, "status": "running",
        "error": None, "result": None,
        "started": datetime.now(timezone.utc).isoformat(), "elapsed": 0,
        "chain_step": 0, "chain_total": 0,
    })

    try:
        from safetensors.torch import load_file as load_safetensors

        # Pre-load all LoRAs and build key maps
        all_lora_data = []  # [(lora_dict, key_map, lora_keys, strength)]

        with safe_open(ckpt_path, framework="pt", device="cpu") as f:
            ckpt_keys = set(f.keys())
            arch_info = detect_architecture(ckpt_keys)

        for lora_path, strength in lora_list:
            lora_dict = load_safetensors(lora_path, device="cpu")
            lora_keys = set(lora_dict.keys())
            key_map = _build_key_map(ckpt_keys, lora_keys, arch_info["arch"])
            print(f"{TAG} {os.path.basename(lora_path)}: {len(key_map)} matched keys, strength={strength}")

            if not key_map:
                print(f"{TAG} WARNING: No matching keys for {os.path.basename(lora_path)} — skipping")
                # Diagnostic: show sample LoRA keys so we can debug the mapping
                sample_keys = sorted(lora_keys)[:10]
                print(f"{TAG}   LoRA has {len(lora_keys)} keys. Samples:")
                for sk in sample_keys:
                    print(f"{TAG}     {sk}")
                sample_ckpt = sorted(k for k in ckpt_keys if k.endswith(".weight"))[:5]
                print(f"{TAG}   Checkpoint has {len(ckpt_keys)} keys. Samples:")
                for sk in sample_ckpt:
                    print(f"{TAG}     {sk}")
                del lora_dict
                continue

            # Build reverse map
            ckpt_to_lora = {}
            for lora_base, ckpt_key in key_map.items():
                ckpt_to_lora[ckpt_key] = lora_base

            all_lora_data.append((lora_dict, ckpt_to_lora, lora_keys, strength))

        if not all_lora_data:
            _merge_state.update({"active": False, "status": "error",
                                 "error": "No matching keys found for any LoRA"})
            _broadcast_workshop_progress()
            return

        # Bake: key-iterative, apply all LoRAs per key
        output_dict = {}
        applied = 0
        errors = 0

        with safe_open(ckpt_path, framework="pt", device="cpu") as f:
            all_keys = sorted(f.keys())
            _merge_state["keys_total"] = len(all_keys)

            for i, key in enumerate(all_keys):
                if _cancel_event.is_set():
                    _merge_state.update({"status": "cancelled", "active": False})
                    _broadcast_workshop_progress()
                    for ld, _, _, _ in all_lora_data: del ld
                    return

                _merge_state["current_key"] = key
                _merge_state["keys_done"] = i

                weight = f.get_tensor(key)

                # Apply each LoRA sequentially
                for lora_dict, ckpt_to_lora, lora_keys, strength in all_lora_data:
                    if key in ckpt_to_lora:
                        base_name = ckpt_to_lora[key]
                        atype = _detect_adapter_type(lora_keys, base_name)

                        result = _compute_lora_delta(
                            weight, base_name, atype, lora_dict, strength
                        )
                        if result is not None:
                            weight = result
                            applied += 1
                        else:
                            errors += 1
                            if errors <= 5:
                                print(f"{TAG} Failed to apply {atype}: {base_name}")

                # Downcast — never VAE keys
                if save_fp16 and weight.dtype == torch.float32:
                    if VAE_PREFIX not in key:
                        weight = weight.half()

                output_dict[key] = weight

                if i % 50 == 0:
                    _merge_state["progress"] = i / len(all_keys)
                    _merge_state["elapsed"] = round(time.time() - start, 1)
                    _broadcast_workshop_progress()

                if i % 500 == 0 and i > 0:
                    pct = round(i / len(all_keys) * 100)
                    print(f"{TAG} Progress: {pct}% ({i}/{len(all_keys)} keys)")

        # Free LoRA dicts
        for ld, _, _, _ in all_lora_data: del ld

        bake_time = round(time.time() - start, 1)
        print(f"{TAG} Bake math complete in {bake_time}s ({applied} adapters applied, {errors} errors)")

        # Metadata
        recipe = {
            "operation": "lora_bake",
            "checkpoint": os.path.basename(ckpt_path),
            "loras": [{"filename": os.path.basename(p), "strength": s} for p, s in lora_list],
            "adapters_applied": applied,
            "fp16": save_fp16,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "workshop_version": VERSION,
        }
        metadata = {"studio_workshop_recipe": json.dumps(recipe)}

        _merge_state.update({"current_key": "(saving...)", "progress": 0.95})
        _broadcast_workshop_progress()

        save_file(output_dict, output_path, metadata=metadata)
        del output_dict

        actual_size = os.path.getsize(output_path) / (1024**3)
        elapsed = round(time.time() - start, 1)
        save_time = round(elapsed - bake_time, 1)

        _merge_state.update({
            "active": False, "progress": 1.0, "status": "complete",
            "current_key": "", "keys_done": _merge_state["keys_total"],
            "elapsed": elapsed,
            "result": {
                "output": output_path,
                "filename": os.path.basename(output_path),
                "elapsed": elapsed, "recipe": recipe,
            },
        })
        _broadcast_workshop_progress()
        print(f"{TAG} ✓ Bake complete: {os.path.basename(output_path)} ({actual_size:.2f} GB)")
        print(f"{TAG}   Applied: {applied} | Errors: {errors} | Math: {bake_time}s | Save: {save_time}s | Total: {elapsed}s")
        _journal_add_from_merge_state()

    except Exception as e:
        _merge_state.update({
            "active": False, "status": "error",
            "error": str(e), "elapsed": round(time.time() - start, 1),
        })
        _broadcast_workshop_progress()
        print(f"{TAG} Bake error: {e}")
        traceback.print_exc()


# =========================================================================
# VAE BAKING — Phase 7
# =========================================================================

def _get_vae_dir() -> str:
    """Get the VAE directory path."""
    try:
        from modules.paths import models_path
        vae_dir = os.path.join(models_path, "VAE")
        if os.path.isdir(vae_dir): return vae_dir
    except Exception: pass
    models_dir = getattr(shared, 'models_path', 'models')
    return os.path.join(models_dir, "VAE")


def _resolve_vae_path(filename: str) -> str:
    """Resolve a VAE filename to full path.

    Checks the primary VAE directory first, then falls back to
    sd_vae.vae_dict so checkpoint-sibling VAEs and any registered
    external VAE files still resolve.
    """
    if os.path.isabs(filename) and os.path.isfile(filename):
        return filename
    vae_dir = _get_vae_dir()
    if vae_dir:
        full = os.path.join(vae_dir, filename)
        if os.path.isfile(full):
            return full
    try:
        from modules import sd_vae
        try:
            sd_vae.refresh_vae_list()
        except Exception:
            pass
        direct = sd_vae.vae_dict.get(filename)
        if direct and os.path.isfile(direct):
            return direct
        basename = os.path.basename(filename)
        for name, path in sd_vae.vae_dict.items():
            if not path:
                continue
            if name == filename or os.path.basename(path) == basename:
                if os.path.isfile(path):
                    return path
    except Exception:
        pass
    raise FileNotFoundError(f"VAE not found: {filename}")


def bake_vae(
    ckpt_path: str, vae_path: str, output_path: str,
    save_fp16: bool = True,
):
    """Bake a VAE into a checkpoint. Key-iterative.

    VAE keys ALWAYS stay fp32 — fp16 VAE decoding produces NaN.
    All other checkpoint keys follow save_fp16 setting.
    """
    global _merge_state
    _cancel_event.clear()
    start = time.time()

    print(f"{TAG} ╔══════════════════════════════════════════════")
    print(f"{TAG} ║ VAE BAKE")
    print(f"{TAG} ║  Checkpoint: {os.path.basename(ckpt_path)}")
    print(f"{TAG} ║  VAE:        {os.path.basename(vae_path)}")
    print(f"{TAG} ║  Output:     {os.path.basename(output_path)}")
    print(f"{TAG} ╚══════════════════════════════════════════════")

    _merge_state.update({
        "active": True, "progress": 0.0, "current_key": "",
        "keys_done": 0, "keys_total": 0, "status": "running",
        "error": None, "result": None,
        "started": datetime.now(timezone.utc).isoformat(), "elapsed": 0,
        "chain_step": 0, "chain_total": 0,
    })

    try:
        # Load VAE state dict
        from safetensors.torch import load_file as load_safetensors
        vae_dict = load_safetensors(vae_path, device="cpu")
        vae_keys = set(vae_dict.keys())

        # VAE keys may or may not have the first_stage_model. prefix
        # Normalize: build map from checkpoint VAE keys to vae_dict keys
        vae_map = {}
        for vk in vae_keys:
            # Try direct: checkpoint uses first_stage_model.X, vae has X
            ckpt_key = VAE_PREFIX + vk
            vae_map[ckpt_key] = vk
            # Also try if vae already has the prefix
            if vk.startswith(VAE_PREFIX):
                vae_map[vk] = vk

        print(f"{TAG} VAE loaded: {len(vae_keys)} keys")

        output_dict = {}
        replaced = 0

        with safe_open(ckpt_path, framework="pt", device="cpu") as f:
            all_keys = sorted(f.keys())
            _merge_state["keys_total"] = len(all_keys)

            for i, key in enumerate(all_keys):
                if _cancel_event.is_set():
                    _merge_state.update({"status": "cancelled", "active": False})
                    _broadcast_workshop_progress()
                    return

                _merge_state["current_key"] = key
                _merge_state["keys_done"] = i

                if key in vae_map:
                    # Replace with VAE tensor — always fp32
                    vae_key = vae_map[key]
                    weight = vae_dict[vae_key].float()
                    replaced += 1
                else:
                    weight = f.get_tensor(key)
                    # Downcast non-VAE keys
                    if save_fp16 and weight.dtype == torch.float32:
                        if VAE_PREFIX not in key:
                            weight = weight.half()

                output_dict[key] = weight

                if i % 50 == 0:
                    _merge_state["progress"] = i / len(all_keys)
                    _merge_state["elapsed"] = round(time.time() - start, 1)
                    _broadcast_workshop_progress()

        del vae_dict

        bake_time = round(time.time() - start, 1)
        print(f"{TAG} VAE bake complete: {replaced} keys replaced in {bake_time}s")

        recipe = {
            "operation": "vae_bake",
            "checkpoint": os.path.basename(ckpt_path),
            "vae": os.path.basename(vae_path),
            "keys_replaced": replaced,
            "fp16": save_fp16,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "workshop_version": VERSION,
        }
        metadata = {"studio_workshop_recipe": json.dumps(recipe)}

        _merge_state.update({"current_key": "(saving...)", "progress": 0.95})
        _broadcast_workshop_progress()

        save_file(output_dict, output_path, metadata=metadata)
        del output_dict

        actual_size = os.path.getsize(output_path) / (1024**3)
        elapsed = round(time.time() - start, 1)

        _merge_state.update({
            "active": False, "progress": 1.0, "status": "complete",
            "current_key": "", "keys_done": _merge_state["keys_total"],
            "elapsed": elapsed,
            "result": {"output": output_path, "filename": os.path.basename(output_path),
                       "elapsed": elapsed, "recipe": recipe},
        })
        _broadcast_workshop_progress()
        print(f"{TAG} ✓ VAE bake: {os.path.basename(output_path)} ({actual_size:.2f} GB, {replaced} VAE keys)")
        _journal_add_from_merge_state()

    except Exception as e:
        _merge_state.update({
            "active": False, "status": "error",
            "error": str(e), "elapsed": round(time.time() - start, 1),
        })
        _broadcast_workshop_progress()
        print(f"{TAG} VAE bake error: {e}")
        traceback.print_exc()


# =========================================================================
# MERGE CHAIN — MergeBoard-style multi-step operations
# =========================================================================

_VARIABLE_RE = re.compile(r'^__O(\d+)__$')

def _resolve_variable(value: str, outputs: dict) -> Optional[str]:
    """Resolve __O1__, __O2__ etc. to actual file paths from previous steps."""
    m = _VARIABLE_RE.match(value)
    if not m:
        return value  # Not a variable, return as-is
    step_num = int(m.group(1))
    if step_num not in outputs:
        return None  # Referenced step hasn't completed
    return outputs[step_num]


def run_chain(steps: list, save_intermediates: bool = False):
    """Execute a multi-step merge chain.

    Each step is a dict with:
        - step: int (1-based)
        - type: "merge" | "lora_bake" | "vae_bake"
        - params: dict (type-specific parameters)

    Variables: __O1__, __O2__, etc. reference previous step outputs.
    Intermediates are auto-deleted unless save_intermediates is True.
    """
    global _merge_state
    _cancel_event.clear()
    start = time.time()

    total_steps = len(steps)
    outputs = {}  # step_num -> output_path
    intermediates = []  # paths to auto-delete if not saving
    results = []  # per-step results for journal
    models_dir = _get_models_dir()

    print(f"{TAG} ╔══════════════════════════════════════════════")
    print(f"{TAG} ║ MERGE CHAIN ({total_steps} steps)")
    for s in steps:
        print(f"{TAG} ║  Step {s['step']}: {s['type'].upper()}")
    print(f"{TAG} ╚══════════════════════════════════════════════")

    _merge_state.update({
        "active": True, "progress": 0.0, "current_key": "",
        "keys_done": 0, "keys_total": total_steps,
        "status": "running", "error": None, "result": None,
        "started": datetime.now(timezone.utc).isoformat(), "elapsed": 0,
        "chain_step": 0, "chain_total": total_steps,
    })

    try:
        for idx, step in enumerate(steps):
            if _cancel_event.is_set():
                _merge_state.update({"status": "cancelled", "active": False})
                _broadcast_workshop_progress()
                return

            step_num = step["step"]
            step_type = step["type"]
            params = step.get("params", {})

            print(f"{TAG} ── Step {step_num}/{total_steps}: {step_type.upper()} ──")

            _merge_state.update({
                "current_key": f"Step {step_num}/{total_steps}: {step_type}",
                "keys_done": idx,
                "progress": idx / total_steps,
                "elapsed": round(time.time() - start, 1),
                "chain_step": step_num, "chain_total": total_steps,
            })
            _broadcast_workshop_progress()

            try:
                if step_type == "merge":
                    result = _chain_step_merge(step_num, params, outputs, models_dir)
                elif step_type == "lora_bake":
                    result = _chain_step_lora_bake(step_num, params, outputs, models_dir)
                elif step_type == "vae_bake":
                    result = _chain_step_vae_bake(step_num, params, outputs, models_dir)
                else:
                    raise ValueError(f"Unknown step type: {step_type}")

                outputs[step_num] = result["output_path"]
                results.append({"step": step_num, "type": step_type, **result})

                # Track intermediate for potential cleanup
                is_final = idx == len(steps) - 1
                is_referenced_later = any(
                    _is_step_referenced(step_num, s.get("params", {}))
                    for s in steps[idx + 1:]
                )
                if not is_final and not save_intermediates:
                    intermediates.append(result["output_path"])

                print(f"{TAG} ✓ Step {step_num} complete: {result.get('filename', '?')}")

            except Exception as e:
                print(f"{TAG} ✗ Step {step_num} failed: {e}")
                traceback.print_exc()

                # Fail dependent steps
                _merge_state.update({
                    "active": False, "status": "error",
                    "error": f"Step {step_num} ({step_type}) failed: {e}",
                    "elapsed": round(time.time() - start, 1),
                })
                _broadcast_workshop_progress()
                return

        # Chain complete — clean up intermediates
        if not save_intermediates and intermediates:
            for path in intermediates:
                # Only delete if it's not the final output
                if path != outputs.get(len(steps)):
                    try:
                        if os.path.exists(path):
                            os.remove(path)
                            print(f"{TAG} Cleaned intermediate: {os.path.basename(path)}")
                    except Exception:
                        pass

        elapsed = round(time.time() - start, 1)
        final_output = outputs.get(len(steps), outputs.get(max(outputs.keys()) if outputs else 0))

        _merge_state.update({
            "active": False, "progress": 1.0, "status": "complete",
            "current_key": "", "keys_done": total_steps,
            "elapsed": elapsed,
            "result": {
                "steps_completed": len(results),
                "total_steps": total_steps,
                "elapsed": elapsed,
                "outputs": {k: os.path.basename(v) for k, v in outputs.items()},
                "final_output": os.path.basename(final_output) if final_output else None,
            },
        })
        _broadcast_workshop_progress()
        print(f"{TAG} ✓ Chain complete: {len(results)}/{total_steps} steps in {elapsed}s")

        # Auto-journal the chain
        _journal_add_chain(results, elapsed)

    except Exception as e:
        _merge_state.update({
            "active": False, "status": "error",
            "error": str(e), "elapsed": round(time.time() - start, 1),
        })
        _broadcast_workshop_progress()
        print(f"{TAG} Chain error: {e}")
        traceback.print_exc()


def _is_step_referenced(step_num: int, params: dict) -> bool:
    """Check if any param value references __ON__."""
    var = f"__O{step_num}__"
    for v in params.values():
        if isinstance(v, str) and var in v:
            return True
        if isinstance(v, list):
            for item in v:
                if isinstance(item, dict):
                    for dv in item.values():
                        if isinstance(dv, str) and var in dv:
                            return True
    return False


def _chain_step_merge(step_num, params, outputs, models_dir):
    """Execute a merge step within a chain."""
    model_a = _resolve_variable(params["model_a"], outputs)
    model_b = _resolve_variable(params["model_b"], outputs)
    if not model_a or not model_b:
        raise ValueError(f"Unresolved variable reference in step {step_num}")

    path_a = _resolve_model_path(model_a)
    path_b = _resolve_model_path(model_b)

    path_c = None
    if params.get("model_c"):
        mc = _resolve_variable(params["model_c"], outputs)
        if mc:
            path_c = _resolve_model_path(mc)

    out_name = params.get("output_name") or f"chain_step{step_num}_{int(time.time())}.safetensors"
    if not out_name.endswith(".safetensors"):
        out_name += ".safetensors"
    output_path = os.path.join(models_dir, out_name)

    method = params.get("method", "weighted_sum")
    alpha = params.get("alpha", 0.5)
    block_weights = params.get("block_weights")
    save_fp16 = params.get("save_fp16", True)
    density = params.get("density", 0.2)
    drop_rate = params.get("drop_rate", 0.9)
    cosine_shift = params.get("cosine_shift", 0.0)
    eta = params.get("eta", 0.1)

    # Use the existing merge_models but synchronously (we're already in a thread)
    merge_models(
        path_a, path_b, output_path, method, alpha,
        block_weights, save_fp16,
        path_c=path_c, density=density, drop_rate=drop_rate,
        cosine_shift=cosine_shift, eta=eta,
    )

    if not os.path.isfile(output_path):
        raise RuntimeError(f"Merge did not produce output: {out_name}")

    return {
        "output_path": output_path,
        "filename": out_name,
        "recipe": {
            "type": "merge", "method": method, "alpha": alpha,
            "model_a": os.path.basename(path_a),
            "model_b": os.path.basename(path_b),
        },
    }


def _chain_step_lora_bake(step_num, params, outputs, models_dir):
    """Execute a LoRA bake step within a chain."""
    checkpoint = _resolve_variable(params["checkpoint"], outputs)
    if not checkpoint:
        raise ValueError(f"Unresolved checkpoint reference in step {step_num}")

    ckpt_path = _resolve_model_path(checkpoint)

    lora_list = []
    for entry in params.get("loras", []):
        lora_path = _resolve_lora_path(entry["filename"])
        lora_list.append((lora_path, entry.get("strength", 1.0)))

    if not lora_list:
        raise ValueError(f"No LoRAs specified in step {step_num}")

    out_name = params.get("output_name") or f"chain_step{step_num}_{int(time.time())}.safetensors"
    if not out_name.endswith(".safetensors"):
        out_name += ".safetensors"
    output_path = os.path.join(models_dir, out_name)

    save_fp16 = params.get("save_fp16", True)

    bake_lora(ckpt_path, lora_list, output_path, save_fp16)

    if not os.path.isfile(output_path):
        raise RuntimeError(f"LoRA bake did not produce output: {out_name} "
                          f"(check key matching — LoRA may not match checkpoint architecture)")

    return {
        "output_path": output_path,
        "filename": out_name,
        "recipe": {
            "type": "lora_bake",
            "checkpoint": os.path.basename(ckpt_path),
            "loras": [{"filename": os.path.basename(p), "strength": s} for p, s in lora_list],
        },
    }


def _chain_step_vae_bake(step_num, params, outputs, models_dir):
    """Execute a VAE bake step within a chain."""
    checkpoint = _resolve_variable(params["checkpoint"], outputs)
    if not checkpoint:
        raise ValueError(f"Unresolved checkpoint reference in step {step_num}")

    ckpt_path = _resolve_model_path(checkpoint)
    vae_path = _resolve_vae_path(params["vae"])

    out_name = params.get("output_name") or f"chain_step{step_num}_{int(time.time())}.safetensors"
    if not out_name.endswith(".safetensors"):
        out_name += ".safetensors"
    output_path = os.path.join(models_dir, out_name)

    save_fp16 = params.get("save_fp16", True)

    bake_vae(ckpt_path, vae_path, output_path, save_fp16)

    if not os.path.isfile(output_path):
        raise RuntimeError(f"VAE bake did not produce output: {out_name}")

    return {
        "output_path": output_path,
        "filename": out_name,
        "recipe": {
            "type": "vae_bake",
            "checkpoint": os.path.basename(ckpt_path),
            "vae": os.path.basename(vae_path),
        },
    }


# =========================================================================
# MERGE JOURNAL
# =========================================================================

_JOURNAL_DIR = None
_JOURNAL_FILE = None
_JOURNAL_IMAGES = None


def _get_journal_paths():
    """Get journal file and image directory paths."""
    global _JOURNAL_DIR, _JOURNAL_FILE, _JOURNAL_IMAGES
    if _JOURNAL_FILE is not None:
        return _JOURNAL_FILE, _JOURNAL_IMAGES

    try:
        from modules.paths import data_path
        _JOURNAL_DIR = os.path.join(data_path, "workshop")
    except Exception:
        _JOURNAL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "workshop")

    os.makedirs(_JOURNAL_DIR, exist_ok=True)
    _JOURNAL_FILE = os.path.join(_JOURNAL_DIR, "workshop_journal.json")
    _JOURNAL_IMAGES = os.path.join(_JOURNAL_DIR, "journal_images")
    os.makedirs(_JOURNAL_IMAGES, exist_ok=True)
    return _JOURNAL_FILE, _JOURNAL_IMAGES


def _load_journal() -> list:
    """Load journal entries from disk."""
    jfile, _ = _get_journal_paths()
    if os.path.exists(jfile):
        try:
            with open(jfile, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return []
    return []


def _save_journal(entries: list):
    """Save journal entries to disk."""
    jfile, _ = _get_journal_paths()
    with open(jfile, "w", encoding="utf-8") as f:
        json.dump(entries, f, indent=2, ensure_ascii=False)


def _journal_add_entry(entry: dict):
    """Add a single entry to the journal."""
    entries = _load_journal()
    entries.insert(0, entry)  # newest first
    _save_journal(entries)
    print(f"{TAG} Journal: added entry '{entry.get('name', entry.get('id', '?'))}'")


def _journal_add_chain(results: list, elapsed: float):
    """Auto-add journal entries for a completed chain."""
    for r in results:
        entry = {
            "id": f"chain_{int(time.time())}_{r['step']}",
            "name": r.get("filename", ""),
            "type": r.get("type", "unknown"),
            "recipe": r.get("recipe", {}),
            "date": datetime.now(timezone.utc).isoformat(),
            "elapsed": elapsed,
            "rating": 0,
            "tags": ["chain"],
            "notes": "",
            "image": None,
        }
        _journal_add_entry(entry)


def _journal_add_from_merge_state():
    """Auto-add a journal entry from the current merge state result."""
    result = _merge_state.get("result")
    if not result:
        return
    recipe = result.get("recipe", {})
    entry = {
        "id": f"merge_{int(time.time())}",
        "name": result.get("filename", ""),
        "type": recipe.get("operation", recipe.get("method", "merge")),
        "recipe": recipe,
        "date": datetime.now(timezone.utc).isoformat(),
        "elapsed": result.get("elapsed", 0),
        "rating": 0,
        "tags": [],
        "notes": "",
        "image": None,
    }
    _journal_add_entry(entry)


# =========================================================================
# FASTAPI ROUTES
# =========================================================================

class MergeRequest(BaseModel):
    model_a: str
    model_b: str
    alpha: float = Field(0.5, ge=0.0, le=1.0)
    method: str = "weighted_sum"
    output_name: Optional[str] = None
    save_fp16: bool = True
    block_weights: Optional[Dict[str, float]] = None
    # Phase 4 additions
    model_c: Optional[str] = None
    density: float = Field(0.2, ge=0.0, le=1.0)
    drop_rate: float = Field(0.9, ge=0.0, le=1.0)
    cosine_shift: float = Field(0.0, ge=-1.0, le=1.0)
    eta: float = Field(0.1, ge=0.0, le=1.0)


class MemoryMergeRequest(BaseModel):
    model_a: str
    model_b: str
    alpha: float = Field(0.5, ge=0.0, le=1.0)
    method: str = "weighted_sum"
    block_weights: Optional[Dict[str, float]] = None
    # Phase 4 additions
    model_c: Optional[str] = None
    density: float = Field(0.2, ge=0.0, le=1.0)
    drop_rate: float = Field(0.9, ge=0.0, le=1.0)
    cosine_shift: float = Field(0.0, ge=-1.0, le=1.0)
    eta: float = Field(0.1, ge=0.0, le=1.0)


def setup_workshop_routes(app: FastAPI):
    """Register Workshop API routes."""

    @app.get("/studio/workshop/models")
    async def workshop_models():
        # Iterate Forge's registry so every configured checkpoint directory is
        # visible (--ckpt-dir, extra paths from settings) — not just the Neo
        # install's models/Stable-diffusion/. Matches what Canvas sees.
        primary_dir = _get_models_dir()
        primary_abs = None
        if primary_dir and os.path.isdir(primary_dir):
            try:
                primary_abs = os.path.realpath(primary_dir)
            except Exception:
                primary_abs = None
        models = []
        seen_paths = set()
        for info in sd_models.checkpoints_list.values():
            full = getattr(info, "filename", None)
            if not full or not os.path.isfile(full):
                continue
            try:
                real = os.path.realpath(full)
            except Exception:
                real = full
            if real in seen_paths:
                continue
            seen_paths.add(real)
            # Prefer a path relative to the primary models dir for display
            # continuity with older saved recipes; outside that tree, fall
            # back to model_name or basename.
            display = None
            if primary_abs:
                try:
                    if real == primary_abs or real.startswith(primary_abs + os.sep):
                        display = os.path.relpath(real, primary_abs).replace("\\", "/")
                except Exception:
                    display = None
            if not display:
                display = getattr(info, "model_name", None) or os.path.basename(full)
            try:
                size_gb = os.path.getsize(full) / (1024 ** 3)
            except OSError:
                size_gb = 0
            models.append({
                "filename": display,
                "basename": os.path.basename(full),
                "size_gb": round(size_gb, 2),
                "path": full,
            })
        models.sort(key=lambda m: _natural_sort_key(m["filename"]))
        return models

    @app.get("/studio/workshop/inspect")
    async def workshop_inspect(filename: str):
        try:
            return inspect_model(_resolve_model_path(filename))
        except FileNotFoundError as e:
            return JSONResponse({"error": str(e)}, status_code=404)
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)

    @app.get("/studio/workshop/preflight")
    async def workshop_preflight(model_a: str, model_b: str):
        try:
            return estimate_merge_ram(_resolve_model_path(model_a), _resolve_model_path(model_b))
        except FileNotFoundError as e:
            return JSONResponse({"error": str(e)}, status_code=404)
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)

    # ------------------------------------------------------------------
    # Compatibility check
    # ------------------------------------------------------------------

    @app.get("/studio/workshop/compatibility")
    async def workshop_compatibility(model_a: str, model_b: str):
        try:
            pa = _resolve_model_path(model_a)
            pb = _resolve_model_path(model_b)
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                result = await asyncio.get_event_loop().run_in_executor(
                    pool, check_compatibility, pa, pb)
            return result
        except FileNotFoundError as e:
            return JSONResponse({"error": str(e)}, status_code=404)
        except Exception as e:
            traceback.print_exc()
            return JSONResponse({"error": str(e)}, status_code=500)

    # ------------------------------------------------------------------
    # Health scan — post-merge tensor audit
    # ------------------------------------------------------------------

    @app.get("/studio/workshop/health")
    async def workshop_health(filename: str):
        try:
            path = _resolve_model_path(filename)
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                result = await asyncio.get_event_loop().run_in_executor(
                    pool, scan_health, path)
            return result
        except FileNotFoundError as e:
            return JSONResponse({"error": str(e)}, status_code=404)
        except Exception as e:
            traceback.print_exc()
            return JSONResponse({"error": str(e)}, status_code=500)

    # ------------------------------------------------------------------
    # Cosine similarity diff (Phase 1)
    # ------------------------------------------------------------------

    @app.get("/studio/workshop/cosine_diff")
    async def workshop_cosine_diff(model_a: str, model_b: str):
        try:
            pa = _resolve_model_path(model_a)
            pb = _resolve_model_path(model_b)
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                result = await asyncio.get_event_loop().run_in_executor(
                    pool, compute_cosine_diff, pa, pb)
            return result
        except FileNotFoundError as e:
            return JSONResponse({"error": str(e)}, status_code=404)
        except Exception as e:
            traceback.print_exc()
            return JSONResponse({"error": str(e)}, status_code=500)

    # ------------------------------------------------------------------
    # Model Stock auto-alpha (Phase 2)
    # ------------------------------------------------------------------

    @app.get("/studio/workshop/model_stock")
    async def workshop_model_stock(model_a: str, model_b: str):
        try:
            pa = _resolve_model_path(model_a)
            pb = _resolve_model_path(model_b)
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                result = await asyncio.get_event_loop().run_in_executor(
                    pool, compute_model_stock_alpha, pa, pb)
            return result
        except FileNotFoundError as e:
            return JSONResponse({"error": str(e)}, status_code=404)
        except Exception as e:
            traceback.print_exc()
            return JSONResponse({"error": str(e)}, status_code=500)

    # ------------------------------------------------------------------
    # Block weight presets (Phase 2)
    # ------------------------------------------------------------------

    @app.get("/studio/workshop/presets")
    async def workshop_presets(arch: str = "sdxl"):
        arch_presets = PRESETS.get(arch, PRESETS.get("sdxl", {}))
        return {
            "arch": arch,
            "presets": {name: weights for name, weights in arch_presets.items()},
            "blocks": get_block_list(arch),
        }

    # ------------------------------------------------------------------
    # Merge (disk)
    # ------------------------------------------------------------------

    @app.post("/studio/workshop/merge")
    async def workshop_merge(req: MergeRequest):
        if _merge_state["active"]:
            return JSONResponse({"error": "A merge is already in progress"}, status_code=409)

        try:
            path_a = _resolve_model_path(req.model_a)
            path_b = _resolve_model_path(req.model_b)
        except FileNotFoundError as e:
            return JSONResponse({"error": str(e)}, status_code=404)

        # Resolve Model C if needed
        path_c = None
        if req.model_c and req.method in METHODS_NEEDING_C:
            try:
                path_c = _resolve_model_path(req.model_c)
            except FileNotFoundError as e:
                return JSONResponse({"error": f"Model C: {e}"}, status_code=404)
        elif req.method in METHODS_NEEDING_C and not req.model_c:
            return JSONResponse(
                {"error": f"{req.method} requires Model C (base model for difference)"},
                status_code=400)

        # Architecture validation
        try:
            with safe_open(path_a, framework="pt", device="cpu") as f_a:
                arch_a = detect_architecture(set(f_a.keys()))
            with safe_open(path_b, framework="pt", device="cpu") as f_b:
                arch_b = detect_architecture(set(f_b.keys()))
            if arch_a["arch"] != arch_b["arch"]:
                return JSONResponse({
                    "error": f"Cross-architecture merge is impossible: "
                             f"{arch_a['details']} ↔ {arch_b['details']}"},
                    status_code=400)
            if path_c:
                with safe_open(path_c, framework="pt", device="cpu") as f_c:
                    arch_c = detect_architecture(set(f_c.keys()))
                if arch_a["arch"] != arch_c["arch"]:
                    return JSONResponse({
                        "error": f"Model C architecture mismatch: "
                                 f"{arch_a['details']} ↔ {arch_c['details']}"},
                        status_code=400)
        except Exception as e:
            return JSONResponse({"error": f"Architecture detection failed: {e}"}, status_code=500)

        if req.method not in ALL_METHODS:
            return JSONResponse(
                {"error": f"Method '{req.method}' not implemented. Available: {', '.join(sorted(ALL_METHODS))}"},
                status_code=400)

        models_dir = _get_models_dir()
        if req.output_name:
            out_name = req.output_name
            if not out_name.endswith(".safetensors"):
                out_name += ".safetensors"
        else:
            ts = int(time.time())
            out_name = f"workshop_merge_{ts}.safetensors"
        output_path = os.path.join(models_dir, out_name)

        if os.path.exists(output_path):
            return JSONResponse({"error": f"Output file already exists: {out_name}"}, status_code=409)

        ram = estimate_merge_ram(path_a, path_b)

        thread = Thread(
            target=merge_models,
            args=(path_a, path_b, output_path, req.method, req.alpha,
                  req.block_weights, req.save_fp16),
            kwargs={
                "path_c": path_c,
                "density": req.density,
                "drop_rate": req.drop_rate,
                "cosine_shift": req.cosine_shift,
                "eta": req.eta,
            },
            daemon=True)
        thread.start()

        return {
            "started": True, "output": out_name,
            "method": req.method, "alpha": req.alpha,
            "block_weights": req.block_weights,
            "ram_estimate": ram, "architecture": arch_a,
        }

    # ------------------------------------------------------------------
    # In-Memory Merge — Phase 3 + Phase 4
    # ------------------------------------------------------------------

    @app.post("/studio/workshop/merge_memory")
    async def workshop_merge_memory(req: MemoryMergeRequest):
        """In-memory UNet merge — compute merged weights, hot-swap into active model."""
        if _merge_state["active"]:
            return JSONResponse({"error": "A disk merge is in progress"}, status_code=409)

        try:
            path_a = _resolve_model_path(req.model_a)
            path_b = _resolve_model_path(req.model_b)
        except FileNotFoundError as e:
            return JSONResponse({"error": str(e)}, status_code=404)

        # Resolve Model C if needed
        path_c = None
        if req.model_c and req.method in METHODS_NEEDING_C:
            try:
                path_c = _resolve_model_path(req.model_c)
            except FileNotFoundError as e:
                return JSONResponse({"error": f"Model C: {e}"}, status_code=404)
        elif req.method in METHODS_NEEDING_C and not req.model_c:
            return JSONResponse(
                {"error": f"{req.method} requires Model C"},
                status_code=400)

        # Cross-architecture check
        try:
            with safe_open(path_a, framework="pt", device="cpu") as f_a:
                arch_a = detect_architecture(set(f_a.keys()))
            with safe_open(path_b, framework="pt", device="cpu") as f_b:
                arch_b = detect_architecture(set(f_b.keys()))
            if arch_a["arch"] != arch_b["arch"]:
                return JSONResponse({
                    "error": f"Cross-architecture merge is impossible: "
                             f"{arch_a['details']} ↔ {arch_b['details']}"},
                    status_code=400)
            if path_c:
                with safe_open(path_c, framework="pt", device="cpu") as f_c:
                    arch_c = detect_architecture(set(f_c.keys()))
                if arch_a["arch"] != arch_c["arch"]:
                    return JSONResponse({
                        "error": f"Model C architecture mismatch"},
                        status_code=400)
        except Exception as e:
            return JSONResponse({"error": f"Architecture detection failed: {e}"}, status_code=500)

        if req.method not in ALL_METHODS:
            return JSONResponse(
                {"error": f"Method '{req.method}' not implemented. Available: {', '.join(sorted(ALL_METHODS))}"},
                status_code=400)

        # Verify a model is loaded
        try:
            _get_diffusion_model()
        except RuntimeError as e:
            return JSONResponse({"error": str(e)}, status_code=500)

        # Log the merge
        bw_count = len(req.block_weights) if req.block_weights else 0
        print(f"{TAG} ╔══════════════════════════════════════════════")
        print(f"{TAG} ║ IN-MEMORY MERGE (no disk write)")
        print(f"{TAG} ║  Method:  {req.method.upper()}")
        print(f"{TAG} ║  Alpha:   {req.alpha}")
        print(f"{TAG} ║  Model A: {os.path.basename(path_a)}")
        print(f"{TAG} ║  Model B: {os.path.basename(path_b)}")
        if path_c:
            print(f"{TAG} ║  Model C: {os.path.basename(path_c)}")
        print(f"{TAG} ║  Block weights: {'YES (' + str(bw_count) + ' blocks)' if req.block_weights else 'NO'}")
        if req.method in ("ties", "dare_ties", "della_ties", "breadcrumbs"):
            print(f"{TAG} ║  Density: {req.density}")
        if req.method in ("dare", "dare_ties", "della", "della_ties", "breadcrumbs"):
            print(f"{TAG} ║  Drop rate: {req.drop_rate}")
        if req.method == "cosine_adaptive":
            print(f"{TAG} ║  Cosine shift: {req.cosine_shift}")
        if req.method == "star":
            print(f"{TAG} ║  Eta (η): {req.eta}")
        print(f"{TAG} ╚══════════════════════════════════════════════")

        try:
            start = time.time()

            merged_dict, arch_info = compute_merge_dict(
                path_a, path_b, req.method, req.alpha, req.block_weights,
                path_c=path_c,
                density=req.density,
                drop_rate=req.drop_rate,
                cosine_shift=req.cosine_shift,
                eta=req.eta,
            )
            compute_time = round(time.time() - start, 1)
            print(f"{TAG} Merge computation: {compute_time}s ({len(merged_dict)} UNet keys)")

            swap_result = swap_unet_weights(merged_dict)
            del merged_dict

            total_time = round(time.time() - start, 1)

            _memory_merge["active"] = True
            _memory_merge["recipe"] = {
                "method": req.method,
                "model_a": os.path.basename(path_a),
                "model_b": os.path.basename(path_b),
                "alpha": req.alpha,
                "block_weights": req.block_weights,
            }
            if path_c:
                _memory_merge["recipe"]["model_c"] = os.path.basename(path_c)
            if req.method in ("ties", "dare_ties", "della_ties", "breadcrumbs"):
                _memory_merge["recipe"]["density"] = req.density
            if req.method in ("dare", "dare_ties", "della", "della_ties", "breadcrumbs"):
                _memory_merge["recipe"]["drop_rate"] = req.drop_rate
            if req.method == "cosine_adaptive":
                _memory_merge["recipe"]["cosine_shift"] = req.cosine_shift
            if req.method == "star":
                _memory_merge["recipe"]["eta"] = req.eta

            print(f"{TAG} ✓ In-memory merge complete: {total_time}s (compute: {compute_time}s, swap: {swap_result['load_time']}s)")

            # Non-UNet warning
            non_unet_warning = None
            with safe_open(path_a, framework="pt", device="cpu") as f_a, \
                 safe_open(path_b, framework="pt", device="cpu") as f_b:
                keys_a = set(f_a.keys())
                keys_b = set(f_b.keys())
                te_keys = [k for k in (keys_a & keys_b) if "conditioner" in k or "cond_stage_model" in k]
                vae_keys = [k for k in (keys_a & keys_b) if VAE_PREFIX in k]
                if te_keys or vae_keys:
                    non_unet_warning = (
                        f"In-memory merge only swaps UNet weights. "
                        f"TEXT encoder ({len(te_keys)} keys) and VAE ({len(vae_keys)} keys) "
                        f"are unchanged. Use 'Save to Disk' for a full merge."
                    )
                    print(f"{TAG} Note: {non_unet_warning}")

            return {
                "success": True,
                "compute_time": compute_time,
                "swap_time": swap_result["load_time"],
                "total_time": total_time,
                "keys_loaded": swap_result["keys_loaded"],
                "validation": swap_result["validation"],
                "non_unet_warning": non_unet_warning,
                "architecture": arch_info,
            }

        except Exception as e:
            traceback.print_exc()
            if _memory_merge["backup"]:
                try:
                    revert_unet_weights()
                    print(f"{TAG} Auto-reverted after merge failure")
                except Exception:
                    pass
            return JSONResponse({"error": f"In-memory merge failed: {e}"}, status_code=500)

    @app.post("/studio/workshop/revert")
    async def workshop_revert():
        if not _memory_merge["active"]:
            return JSONResponse({"error": "No in-memory merge to revert"}, status_code=400)
        try:
            result = revert_unet_weights()
            return result
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)

    @app.get("/studio/workshop/memory_status")
    async def workshop_memory_status():
        return {
            "active": _memory_merge["active"],
            "recipe": _memory_merge["recipe"],
            "validation": _memory_merge["validation"],
            "has_backup": _memory_merge["backup"] is not None,
        }

    # ------------------------------------------------------------------
    # Merge status / cancel / refresh
    # ------------------------------------------------------------------

    @app.get("/studio/workshop/status")
    async def workshop_status():
        return {
            "active": _merge_state["active"],
            "progress": _merge_state["progress"],
            "keys_done": _merge_state["keys_done"],
            "keys_total": _merge_state["keys_total"],
            "status": _merge_state["status"],
            "error": _merge_state["error"],
            "elapsed": _merge_state["elapsed"],
            "result": _merge_state["result"],
        }

    @app.post("/studio/workshop/cancel")
    async def workshop_cancel():
        if not _merge_state["active"]:
            return {"cancelled": False, "reason": "No active merge"}
        _cancel_event.set()
        return {"cancelled": True}

    @app.post("/studio/workshop/refresh_checkpoints")
    async def workshop_refresh():
        sd_models.list_models()
        return {"ok": True, "count": len(sd_models.checkpoints_list)}

    @app.post("/studio/workshop/refresh")
    async def workshop_refresh_all():
        """Rescan every asset directory Workshop reads from.

        Triggers Forge's built-in list_models() and sd_vae.refresh_vae_list()
        so newly-added checkpoints and VAEs in any configured path show up,
        including external directories from --ckpt-dir / --lora-dir. LoRAs
        are scanned on-demand at listing time, so no cache to invalidate.
        """
        result = {"ok": True}
        try:
            sd_models.list_models()
            result["checkpoints"] = len(sd_models.checkpoints_list)
        except Exception as e:
            result["checkpoints_error"] = str(e)
        try:
            from modules import sd_vae
            sd_vae.refresh_vae_list()
            result["vaes"] = len(sd_vae.vae_dict)
        except Exception as e:
            result["vaes_error"] = str(e)
        try:
            # LoRA count for the toast — walk only top-level configured dirs
            lora_count = 0
            seen = set()
            for base in _lora_dir_candidates():
                if not base or not os.path.isdir(base):
                    continue
                for root, _dirs, files in os.walk(base):
                    for f in files:
                        if f.endswith(".safetensors"):
                            try:
                                real = os.path.realpath(os.path.join(root, f))
                            except Exception:
                                real = os.path.join(root, f)
                            if real not in seen:
                                seen.add(real)
                                lora_count += 1
            result["loras"] = lora_count
        except Exception as e:
            result["loras_error"] = str(e)
        return result

    # ------------------------------------------------------------------
    # LoRA Baking — Phase 6
    # ------------------------------------------------------------------

    @app.get("/studio/workshop/loras")
    async def workshop_loras():
        """List LoRA files across every configured LoRA directory.

        Honors Forge's --lora-dir / --lora-dirs in addition to the default
        models/Lora/ folder so external directories show up here just like
        they do in Canvas.
        """
        loras = []
        seen_paths = set()
        for base_dir in _lora_dir_candidates():
            if not base_dir or not os.path.isdir(base_dir):
                continue
            for root, dirs, files in os.walk(base_dir):
                dirs.sort(key=_natural_sort_key)
                for f in sorted(files, key=_natural_sort_key):
                    if not f.endswith(".safetensors"):
                        continue
                    full = os.path.join(root, f)
                    try:
                        real = os.path.realpath(full)
                    except Exception:
                        real = full
                    if real in seen_paths:
                        continue
                    seen_paths.add(real)
                    rel = os.path.relpath(full, base_dir).replace("\\", "/")
                    try:
                        size_mb = os.path.getsize(full) / (1024 ** 2)
                    except OSError:
                        size_mb = 0
                    loras.append({
                        "filename": rel, "basename": f,
                        "size_mb": round(size_mb, 2),
                    })
        loras.sort(key=lambda m: _natural_sort_key(m["filename"]))
        return loras

    @app.get("/studio/workshop/inspect_lora")
    async def workshop_inspect_lora(filename: str):
        """Inspect a LoRA file."""
        try:
            return inspect_lora(_resolve_lora_path(filename))
        except FileNotFoundError as e:
            return JSONResponse({"error": str(e)}, status_code=404)
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)

    @app.get("/studio/workshop/bake_preflight")
    async def workshop_bake_preflight(checkpoint: str, lora: str):
        """Pre-flight check for LoRA bake: key mapping, shape validation."""
        try:
            ckpt_path = _resolve_model_path(checkpoint)
            lora_path = _resolve_lora_path(lora)
        except FileNotFoundError as e:
            return JSONResponse({"error": str(e)}, status_code=404)

        try:
            from safetensors.torch import load_file as load_safetensors
            lora_dict = load_safetensors(lora_path, device="cpu")
            lora_keys = set(lora_dict.keys())

            with safe_open(ckpt_path, framework="pt", device="cpu") as f:
                ckpt_keys = set(f.keys())
                arch_info = detect_architecture(ckpt_keys)

            key_map = _build_key_map(ckpt_keys, lora_keys, arch_info["arch"])

            # Detect types
            type_counts = {}
            for base_name in key_map:
                atype = _detect_adapter_type(lora_keys, base_name)
                type_counts[atype] = type_counts.get(atype, 0) + 1

            # Shape validation: check a sample of mappings
            shape_errors = []
            with safe_open(ckpt_path, framework="pt", device="cpu") as f:
                sample = list(key_map.items())[:20]
                for lora_base, ckpt_key in sample:
                    atype = _detect_adapter_type(lora_keys, lora_base)
                    if atype == "lora":
                        # Check up/down shapes are compatible
                        for up_s, down_s in [
                            (".lora_up.weight", ".lora_down.weight"),
                            (".lora_B.weight", ".lora_A.weight"),
                        ]:
                            up = lora_dict.get(f"{lora_base}{up_s}")
                            down = lora_dict.get(f"{lora_base}{down_s}")
                            if up is not None and down is not None:
                                ckpt_shape = f.get_slice(ckpt_key).get_shape()
                                expected = up.shape[0] * down.shape[1]
                                actual = 1
                                for d in ckpt_shape:
                                    actual *= d
                                # Allow for conv kernels
                                if up.shape[0] != ckpt_shape[0]:
                                    shape_errors.append(f"{ckpt_key}: up.out={up.shape[0]} vs ckpt.out={ckpt_shape[0]}")
                                break

            del lora_dict

            return {
                "compatible": len(key_map) > 0,
                "matched_keys": len(key_map),
                "total_lora_adapters": len(set(
                    k[:-len(s)] for k in lora_keys for s in _LORA_SUFFIXES if k.endswith(s)
                )),
                "adapter_types": type_counts,
                "architecture": arch_info,
                "shape_errors": shape_errors[:5],
            }
        except Exception as e:
            traceback.print_exc()
            return JSONResponse({"error": str(e)}, status_code=500)

    class LoraEntry(BaseModel):
        filename: str
        strength: float = Field(1.0, ge=-2.0, le=2.0)

    class BakeRequest(BaseModel):
        checkpoint: str
        loras: List[LoraEntry]
        output_name: Optional[str] = None
        save_fp16: bool = True

    @app.post("/studio/workshop/bake")
    async def workshop_bake(req: BakeRequest):
        """Bake one or more LoRAs into a checkpoint."""
        if _merge_state["active"]:
            return JSONResponse({"error": "A merge/bake is already in progress"}, status_code=409)

        try:
            ckpt_path = _resolve_model_path(req.checkpoint)
        except FileNotFoundError as e:
            return JSONResponse({"error": str(e)}, status_code=404)

        # Resolve all LoRA paths
        lora_list = []
        for entry in req.loras:
            try:
                lora_path = _resolve_lora_path(entry.filename)
                lora_list.append((lora_path, entry.strength))
            except FileNotFoundError as e:
                return JSONResponse({"error": f"LoRA: {e}"}, status_code=404)

        if not lora_list:
            return JSONResponse({"error": "No LoRAs specified"}, status_code=400)

        models_dir = _get_models_dir()
        if req.output_name:
            out_name = req.output_name
            if not out_name.endswith(".safetensors"):
                out_name += ".safetensors"
        else:
            base = os.path.splitext(os.path.basename(ckpt_path))[0]
            if len(lora_list) == 1:
                lora_base = os.path.splitext(os.path.basename(lora_list[0][0]))[0]
                out_name = f"{base}_{lora_base}_baked.safetensors"
            else:
                out_name = f"{base}_{len(lora_list)}loras_baked.safetensors"
        output_path = os.path.join(models_dir, out_name)

        if os.path.exists(output_path):
            return JSONResponse({"error": f"Output file already exists: {out_name}"}, status_code=409)

        thread = Thread(
            target=bake_lora,
            args=(ckpt_path, lora_list, output_path, req.save_fp16),
            daemon=True,
        )
        thread.start()

        return {
            "started": True,
            "output": out_name,
            "checkpoint": os.path.basename(ckpt_path),
            "lora_count": len(lora_list),
        }

    # ------------------------------------------------------------------
    # VAE Baking — Phase 7
    # ------------------------------------------------------------------

    @app.get("/studio/workshop/vaes")
    async def workshop_vaes():
        """List VAE files via Forge's registry.

        sd_vae.vae_dict aggregates every VAE Forge knows about (the VAE
        folder plus any checkpoint-sibling .vae.* files). This is wider
        than a single-directory walk and matches the Canvas VAE dropdown.
        """
        from modules import sd_vae
        try:
            sd_vae.refresh_vae_list()
        except Exception:
            pass
        vae_dir = _get_vae_dir()
        vae_abs = None
        if vae_dir and os.path.isdir(vae_dir):
            try:
                vae_abs = os.path.realpath(vae_dir)
            except Exception:
                vae_abs = None
        vaes = []
        seen_paths = set()
        for name, full in sd_vae.vae_dict.items():
            if not full or not os.path.isfile(full):
                continue
            try:
                real = os.path.realpath(full)
            except Exception:
                real = full
            if real in seen_paths:
                continue
            seen_paths.add(real)
            display = None
            if vae_abs:
                try:
                    if real == vae_abs or real.startswith(vae_abs + os.sep):
                        display = os.path.relpath(real, vae_abs).replace("\\", "/")
                except Exception:
                    display = None
            if not display:
                display = name
            try:
                size_mb = os.path.getsize(full) / (1024 ** 2)
            except OSError:
                size_mb = 0
            vaes.append({
                "filename": display,
                "basename": os.path.basename(full),
                "size_mb": round(size_mb, 2),
            })
        vaes.sort(key=lambda m: _natural_sort_key(m["filename"]))
        return vaes

    class VaeBakeRequest(BaseModel):
        checkpoint: str
        vae: str
        output_name: Optional[str] = None
        save_fp16: bool = True

    @app.post("/studio/workshop/bake_vae")
    async def workshop_bake_vae(req: VaeBakeRequest):
        """Bake a VAE into a checkpoint."""
        if _merge_state["active"]:
            return JSONResponse({"error": "A merge/bake is already in progress"}, status_code=409)

        try:
            ckpt_path = _resolve_model_path(req.checkpoint)
            vae_path = _resolve_vae_path(req.vae)
        except FileNotFoundError as e:
            return JSONResponse({"error": str(e)}, status_code=404)

        models_dir = _get_models_dir()
        if req.output_name:
            out_name = req.output_name
            if not out_name.endswith(".safetensors"):
                out_name += ".safetensors"
        else:
            base = os.path.splitext(os.path.basename(ckpt_path))[0]
            vae_base = os.path.splitext(os.path.basename(vae_path))[0]
            out_name = f"{base}_{vae_base}_vae.safetensors"
        output_path = os.path.join(models_dir, out_name)

        if os.path.exists(output_path):
            return JSONResponse({"error": f"Output file already exists: {out_name}"}, status_code=409)

        thread = Thread(
            target=bake_vae,
            args=(ckpt_path, vae_path, output_path, req.save_fp16),
            daemon=True,
        )
        thread.start()

        return {
            "started": True,
            "output": out_name,
            "checkpoint": os.path.basename(ckpt_path),
            "vae": os.path.basename(vae_path),
        }

    # ------------------------------------------------------------------
    # Merge Chain
    # ------------------------------------------------------------------

    class ChainStep(BaseModel):
        step: int
        type: str  # "merge" | "lora_bake" | "vae_bake"
        params: Dict[str, Any]

    class ChainRequest(BaseModel):
        steps: List[ChainStep]
        save_intermediates: bool = False

    @app.post("/studio/workshop/chain")
    async def workshop_chain(req: ChainRequest):
        """Execute a multi-step merge chain."""
        if _merge_state["active"]:
            return JSONResponse({"error": "An operation is already in progress"}, status_code=409)

        if not req.steps:
            return JSONResponse({"error": "No steps provided"}, status_code=400)

        # Validate step numbers are sequential
        for i, step in enumerate(req.steps):
            if step.step != i + 1:
                return JSONResponse({"error": f"Step numbers must be sequential (expected {i+1}, got {step.step})"}, status_code=400)
            if step.type not in ("merge", "lora_bake", "vae_bake"):
                return JSONResponse({"error": f"Invalid step type: {step.type}"}, status_code=400)

        steps_data = [{"step": s.step, "type": s.type, "params": s.params} for s in req.steps]

        thread = Thread(
            target=run_chain,
            args=(steps_data, req.save_intermediates),
            daemon=True,
        )
        thread.start()

        return {"started": True, "total_steps": len(req.steps)}

    # ------------------------------------------------------------------
    # Merge Journal
    # ------------------------------------------------------------------

    @app.get("/studio/workshop/journal")
    async def workshop_journal(search: str = "", tag: str = "", limit: int = 50):
        """Get journal entries with optional search/filter."""
        entries = _load_journal()

        if search:
            search_lower = search.lower()
            entries = [e for e in entries if
                       search_lower in e.get("name", "").lower() or
                       search_lower in e.get("notes", "").lower() or
                       search_lower in json.dumps(e.get("recipe", {})).lower()]

        if tag:
            entries = [e for e in entries if tag in e.get("tags", [])]

        return entries[:limit]

    class JournalUpdate(BaseModel):
        id: str
        rating: Optional[int] = None
        tags: Optional[List[str]] = None
        notes: Optional[str] = None
        name: Optional[str] = None

    @app.post("/studio/workshop/journal/update")
    async def workshop_journal_update(req: JournalUpdate):
        """Update a journal entry (rating, tags, notes)."""
        entries = _load_journal()
        for entry in entries:
            if entry["id"] == req.id:
                if req.rating is not None:
                    entry["rating"] = max(0, min(5, req.rating))
                if req.tags is not None:
                    entry["tags"] = req.tags
                if req.notes is not None:
                    entry["notes"] = req.notes
                if req.name is not None:
                    entry["name"] = req.name
                _save_journal(entries)
                return {"ok": True}
        return JSONResponse({"error": "Entry not found"}, status_code=404)

    @app.post("/studio/workshop/journal/add")
    async def workshop_journal_add(req: dict):
        """Add a manual journal entry (model notes, tracking, etc.)."""
        entry = {
            "id": req.get("id", f"manual_{int(time.time())}"),
            "name": req.get("name", "New Entry"),
            "type": req.get("type", "note"),
            "recipe": req.get("recipe", {}),
            "date": datetime.now(timezone.utc).isoformat(),
            "elapsed": 0,
            "rating": 0,
            "tags": req.get("tags", []),
            "notes": req.get("notes", ""),
            "image": None,
        }
        _journal_add_entry(entry)
        return {"ok": True, "id": entry["id"]}

    @app.post("/studio/workshop/journal/delete")
    async def workshop_journal_delete(req: dict):
        """Delete a journal entry."""
        entry_id = req.get("id")
        if not entry_id:
            return JSONResponse({"error": "No id provided"}, status_code=400)
        entries = _load_journal()
        before = len(entries)
        entries = [e for e in entries if e["id"] != entry_id]
        if len(entries) == before:
            return JSONResponse({"error": "Entry not found"}, status_code=404)
        _save_journal(entries)
        # Delete associated image if any
        _, img_dir = _get_journal_paths()
        for ext in ("png", "jpg", "webp"):
            img_path = os.path.join(img_dir, f"{entry_id}.{ext}")
            if os.path.exists(img_path):
                os.remove(img_path)
        return {"ok": True}

    @app.post("/studio/workshop/journal/image")
    async def workshop_journal_image(req: dict):
        """Attach a sample image to a journal entry (base64)."""
        entry_id = req.get("id")
        image_data = req.get("image")  # base64 data URL
        if not entry_id:
            return JSONResponse({"error": "No id"}, status_code=400)

        entries = _load_journal()
        entry = next((e for e in entries if e["id"] == entry_id), None)
        if not entry:
            return JSONResponse({"error": "Entry not found"}, status_code=404)

        _, img_dir = _get_journal_paths()
        if image_data and image_data.startswith("data:image"):
            import base64 as b64
            header, b64data = image_data.split(",", 1)
            ext = "png"
            if "jpeg" in header or "jpg" in header: ext = "jpg"
            elif "webp" in header: ext = "webp"
            filename = f"{entry_id}.{ext}"
            filepath = os.path.join(img_dir, filename)
            with open(filepath, "wb") as f:
                f.write(b64.b64decode(b64data))
            entry["image"] = filename
        else:
            # Remove image
            entry["image"] = None
            for ext in ("png", "jpg", "webp"):
                p = os.path.join(img_dir, f"{entry_id}.{ext}")
                if os.path.exists(p): os.remove(p)

        _save_journal(entries)
        return {"ok": True}

    @app.get("/studio/workshop/journal/image/{filename}")
    async def workshop_journal_get_image(filename: str):
        """Serve a journal image."""
        _, img_dir = _get_journal_paths()
        filepath = os.path.join(img_dir, filename)
        if not os.path.exists(filepath) or not os.path.abspath(filepath).startswith(os.path.abspath(img_dir)):
            return JSONResponse({"error": "Not found"}, status_code=404)
        from fastapi.responses import FileResponse
        return FileResponse(filepath)

    # ------------------------------------------------------------------
    # Recipe Save/Load
    # ------------------------------------------------------------------

    @app.post("/studio/workshop/recipe/save")
    async def workshop_recipe_save(req: dict):
        """Save a merge recipe (chain configuration) as JSON."""
        name = req.get("name", "untitled")
        steps = req.get("steps", [])
        recipe_dir = os.path.join(_get_journal_paths()[0].replace("workshop_journal.json", ""), "recipes")
        os.makedirs(recipe_dir, exist_ok=True)
        safe_name = re.sub(r'[^\w\-.]', '_', name)
        filepath = os.path.join(recipe_dir, f"{safe_name}.json")
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump({"name": name, "steps": steps, "saved": datetime.now(timezone.utc).isoformat()}, f, indent=2)
        return {"ok": True, "filename": f"{safe_name}.json"}

    @app.get("/studio/workshop/recipes")
    async def workshop_recipes():
        """List saved recipes."""
        recipe_dir = os.path.join(_get_journal_paths()[0].replace("workshop_journal.json", ""), "recipes")
        if not os.path.isdir(recipe_dir):
            return []
        recipes = []
        for f in sorted(os.listdir(recipe_dir)):
            if f.endswith(".json"):
                try:
                    with open(os.path.join(recipe_dir, f), "r", encoding="utf-8") as fp:
                        data = json.load(fp)
                    recipes.append({
                        "filename": f,
                        "name": data.get("name", f),
                        "steps": len(data.get("steps", [])),
                        "saved": data.get("saved", ""),
                    })
                except Exception:
                    pass
        return recipes

    @app.get("/studio/workshop/recipe/load")
    async def workshop_recipe_load(filename: str):
        """Load a saved recipe."""
        recipe_dir = os.path.join(_get_journal_paths()[0].replace("workshop_journal.json", ""), "recipes")
        filepath = os.path.join(recipe_dir, filename)
        if not os.path.exists(filepath):
            return JSONResponse({"error": "Recipe not found"}, status_code=404)
        with open(filepath, "r", encoding="utf-8") as f:
            return json.load(f)

    # ------------------------------------------------------------------
    # Concept Erasure
    # ------------------------------------------------------------------

    class ConceptErasurePreviewRequest(BaseModel):
        concepts: List[str]

    class ConceptErasureApplyRequest(BaseModel):
        checkpoint: str
        concepts: List[str]
        output_name: Optional[str] = None
        save_fp16: bool = True
        strength: float = Field(1.0, ge=0.0, le=1.0)

    def _get_clip_engines():
        """Get CLIP text processing engines from loaded model."""
        sd_model = getattr(shared, 'sd_model', None)
        if sd_model is None:
            raise RuntimeError("No model loaded")
        engine_l = getattr(sd_model, 'text_processing_engine_l', None)
        engine_g = getattr(sd_model, 'text_processing_engine_g', None)
        if engine_l is None and engine_g is None:
            raise RuntimeError("No CLIP text encoders found on loaded model")
        return engine_l, engine_g

    def _encode_concept_embedding(text: str, engine_l, engine_g) -> torch.Tensor:
        """Encode a concept through dual CLIP and return normalized embedding.

        Returns a vector in the cross-attention context space:
        - SDXL: 2048-dim (768 CLIP-L + 1280 CLIP-G concatenated)
        - SD 1.5: 768-dim (CLIP-L only)
        """
        text_clean = text.strip().replace("_", " ")
        parts = []

        with torch.no_grad():
            for engine in (engine_l, engine_g):
                if engine is None:
                    continue
                tokenizer = getattr(engine, 'tokenizer', None)
                if tokenizer is None or not callable(tokenizer):
                    continue

                eos_id = getattr(engine, 'id_end', 49407)
                bos_id = getattr(engine, 'id_start', 49406)
                pad_id = getattr(engine, 'id_pad', 0)
                special = {pad_id, bos_id, eos_id}

                encoded = tokenizer(
                    text_clean, padding="max_length", max_length=77,
                    truncation=True, return_tensors="pt"
                )
                tokens = encoded.input_ids
                ids = tokens[0].tolist()
                n_content = sum(1 for t in ids if t not in special)

                emb = engine.encode_with_transformers(tokens)  # [1, 77, dim]
                if emb.dim() == 3:
                    emb = emb.squeeze(0)  # [77, dim]

                # Mean-pool content tokens (skip BOS at position 0)
                n = max(1, min(n_content, emb.shape[0] - 1))
                content_emb = emb[1:1 + n]  # [n, dim]
                pooled = content_emb.mean(dim=0)  # [dim]
                parts.append(pooled.float().cpu())

        if not parts:
            raise RuntimeError(f"Failed to encode concept: '{text}'")

        # Concatenate CLIP-L + CLIP-G embeddings
        combined = torch.cat(parts, dim=0)  # 768+1280=2048 for SDXL, 768 for SD1.5

        # Normalize to unit vector
        norm = combined.norm()
        if norm > 0:
            combined = combined / norm

        return combined

    def _find_cross_attn_kv_keys(keys):
        """Find all cross-attention to_K and to_V weight keys in a checkpoint.

        Cross-attention (attn2) is where text conditioning enters the UNet.
        to_K determines what the model 'looks for' in the text.
        to_V determines what information it retrieves.
        """
        kv_keys = []
        for key in keys:
            if "attn2" in key and ("to_k" in key or "to_v" in key) and "weight" in key:
                kv_keys.append(key)
        return sorted(kv_keys)

    # Reference tags for blast radius preview — common concepts spanning multiple categories
    _BLAST_RADIUS_TAGS = [
        # People / gender
        "girl", "boy", "woman", "man", "female", "male", "child", "person",
        "mother", "father", "sister", "brother", "lady", "gentleman",
        # Appearance
        "long hair", "short hair", "blonde hair", "black hair", "blue eyes",
        "dress", "skirt", "pants", "shirt", "suit", "armor",
        "breasts", "muscular", "slim", "tall", "short",
        # Expressions
        "smile", "crying", "angry", "happy", "sad", "blush",
        # Actions / poses
        "sitting", "standing", "running", "fighting", "sleeping",
        "hug", "kiss", "holding hands",
        # Settings
        "school", "city", "forest", "beach", "bedroom", "castle",
        # Style
        "anime", "realistic", "chibi", "sketch", "watercolor",
        # Objects
        "sword", "flower", "cat", "dog", "food", "book",
        # Quality
        "masterpiece", "best quality", "detailed", "beautiful",
    ]

    @app.get("/studio/workshop/concept_erasure/diagnose")
    async def concept_erasure_diagnose():
        """Diagnostic: dump CLIP encoder access paths to console."""
        sd = getattr(shared, 'sd_model', None)
        info = {"model_loaded": sd is not None}
        if sd is None:
            print(f"{TAG} CLIP Diagnose: No model loaded")
            return info

        info["model_type"] = type(sd).__name__
        print(f"{TAG} CLIP Diagnose: model type = {type(sd).__name__}")

        # Check direct attributes
        text_attrs = [a for a in dir(sd) if 'clip' in a.lower() or 'text' in a.lower() or 'cond' in a.lower() or 'encode' in a.lower()]
        info["text_attrs"] = text_attrs
        print(f"{TAG} CLIP Diagnose: text/clip/cond attrs = {text_attrs}")

        # Check text_processing_engine_l/g (PromptScope pattern)
        engine_l = getattr(sd, 'text_processing_engine_l', None)
        engine_g = getattr(sd, 'text_processing_engine_g', None)
        info["engine_l"] = str(type(engine_l)) if engine_l else None
        info["engine_g"] = str(type(engine_g)) if engine_g else None
        print(f"{TAG} CLIP Diagnose: engine_l = {type(engine_l)}, engine_g = {type(engine_g)}")

        # Check forge_objects
        fo = getattr(sd, 'forge_objects', None)
        if fo:
            fo_attrs = [a for a in dir(fo) if not a.startswith('_')]
            info["forge_objects_attrs"] = fo_attrs
            print(f"{TAG} CLIP Diagnose: forge_objects attrs = {fo_attrs}")

            clip = getattr(fo, 'clip', None)
            if clip:
                clip_attrs = [a for a in dir(clip) if not a.startswith('_')]
                info["clip_type"] = type(clip).__name__
                info["clip_attrs"] = clip_attrs
                print(f"{TAG} CLIP Diagnose: clip type = {type(clip).__name__}")
                print(f"{TAG} CLIP Diagnose: clip attrs = {clip_attrs}")

                # Check for tokenizer container
                tok = getattr(clip, 'tokenizer', None)
                if tok:
                    tok_attrs = [a for a in dir(tok) if not a.startswith('_')]
                    info["tokenizer_type"] = type(tok).__name__
                    info["tokenizer_attrs"] = tok_attrs
                    print(f"{TAG} CLIP Diagnose: tokenizer type = {type(tok).__name__}")
                    print(f"{TAG} CLIP Diagnose: tokenizer attrs = {tok_attrs}")

                # Check for cond_stage_model
                cond = getattr(clip, 'cond_stage_model', None)
                if cond:
                    cond_attrs = [a for a in dir(cond) if not a.startswith('_')]
                    info["cond_stage_type"] = type(cond).__name__
                    info["cond_stage_attrs"] = cond_attrs
                    print(f"{TAG} CLIP Diagnose: cond_stage_model type = {type(cond).__name__}")
                    print(f"{TAG} CLIP Diagnose: cond_stage_model attrs = {cond_attrs}")

                # Check for encode method
                encode = getattr(clip, 'encode', None)
                if encode:
                    info["clip_has_encode"] = True
                    print(f"{TAG} CLIP Diagnose: clip has encode()")
        else:
            info["forge_objects"] = None
            print(f"{TAG} CLIP Diagnose: no forge_objects")

        # Check cond_stage_model directly on sd_model
        csm = getattr(sd, 'cond_stage_model', None)
        if csm:
            csm_attrs = [a for a in dir(csm) if not a.startswith('_')]
            info["sd_cond_stage_type"] = type(csm).__name__
            info["sd_cond_stage_attrs"] = csm_attrs
            print(f"{TAG} CLIP Diagnose: sd.cond_stage_model type = {type(csm).__name__}")
            print(f"{TAG} CLIP Diagnose: sd.cond_stage_model attrs = {csm_attrs}")

        return info

    @app.post("/studio/workshop/concept_erasure/preview")
    async def concept_erasure_preview(req: ConceptErasurePreviewRequest):
        """Encode concepts and compute blast radius against reference tags."""
        if not req.concepts or all(not c.strip() for c in req.concepts):
            return JSONResponse({"error": "No concepts provided"}, status_code=400)

        try:
            engine_l, engine_g = _get_clip_engines()
        except RuntimeError as e:
            return JSONResponse({"error": str(e)}, status_code=500)

        concepts = [c.strip() for c in req.concepts if c.strip()]
        print(f"{TAG} Concept Erasure preview: encoding {len(concepts)} concept(s)...")

        try:
            # Encode target concepts
            concept_embeddings = []
            for concept in concepts:
                emb = _encode_concept_embedding(concept, engine_l, engine_g)
                concept_embeddings.append(emb)
                print(f"{TAG}   Encoded '{concept}' → {emb.shape[0]}-dim")

            # Encode reference tags
            ref_results = []
            for tag in _BLAST_RADIUS_TAGS:
                try:
                    tag_emb = _encode_concept_embedding(tag, engine_l, engine_g)
                    # Compute max cosine similarity against any target concept
                    max_sim = 0.0
                    closest_concept = concepts[0]
                    for i, c_emb in enumerate(concept_embeddings):
                        sim = torch.dot(c_emb, tag_emb).item()
                        if sim > max_sim:
                            max_sim = sim
                            closest_concept = concepts[i]
                    ref_results.append({
                        "tag": tag, "similarity": round(max_sim, 4),
                        "closest_concept": closest_concept,
                    })
                except Exception:
                    continue

            # Sort by similarity descending
            ref_results.sort(key=lambda x: -x["similarity"])

            # Categorize — CLIP embedding space has high baseline similarity (~0.6-0.7)
            # between most concepts, so meaningful thresholds are compressed at the top
            high_risk = [r for r in ref_results if r["similarity"] >= 0.85]
            medium_risk = [r for r in ref_results if 0.75 <= r["similarity"] < 0.85]
            low_risk = [r for r in ref_results if r["similarity"] < 0.75]

            print(f"{TAG} Blast radius: {len(high_risk)} high, "
                  f"{len(medium_risk)} medium, {len(low_risk)} low")

            return {
                "concepts": concepts,
                "embedding_dim": concept_embeddings[0].shape[0],
                "high_risk": high_risk,
                "medium_risk": medium_risk,
                "low_risk": low_risk[:10],  # Only top 10 low-risk
                "total_tags_checked": len(ref_results),
            }

        except Exception as e:
            import traceback
            traceback.print_exc()
            return JSONResponse({"error": str(e)}, status_code=500)

    @app.post("/studio/workshop/concept_erasure/apply")
    async def concept_erasure_apply(req: ConceptErasureApplyRequest):
        """Apply concept erasure to a checkpoint and save."""
        if not req.concepts or all(not c.strip() for c in req.concepts):
            return JSONResponse({"error": "No concepts provided"}, status_code=400)

        try:
            checkpoint_path = _resolve_model_path(req.checkpoint)
        except FileNotFoundError as e:
            return JSONResponse({"error": str(e)}, status_code=404)

        try:
            engine_l, engine_g = _get_clip_engines()
        except RuntimeError as e:
            return JSONResponse({"error": str(e)}, status_code=500)

        concepts = [c.strip() for c in req.concepts if c.strip()]

        # Output path
        models_dir = _get_models_dir()
        if req.output_name:
            out_name = req.output_name
            if not out_name.endswith(".safetensors"):
                out_name += ".safetensors"
        else:
            base = os.path.splitext(os.path.basename(checkpoint_path))[0]
            erased = "_".join(c.replace(" ", "") for c in concepts[:3])
            out_name = f"{base}_erased_{erased}.safetensors"
        output_path = os.path.join(models_dir, out_name)

        if os.path.exists(output_path):
            return JSONResponse({"error": f"Output already exists: {out_name}"}, status_code=409)

        print(f"{TAG} ╔══════════════════════════════════════════════")
        print(f"{TAG} ║ CONCEPT ERASURE")
        print(f"{TAG} ║  Concepts: {', '.join(concepts)}")
        print(f"{TAG} ║  Strength: {req.strength}")
        print(f"{TAG} ║  Source:   {os.path.basename(checkpoint_path)}")
        print(f"{TAG} ║  Output:   {out_name}")
        print(f"{TAG} ║  fp16:     {req.save_fp16}")
        print(f"{TAG} ╚══════════════════════════════════════════════")

        def _do_erasure():
            start = time.time()
            strength = req.strength

            # Encode concepts
            concept_embeddings = []
            for concept in concepts:
                emb = _encode_concept_embedding(concept, engine_l, engine_g)
                concept_embeddings.append(emb)
                print(f"{TAG} Encoded '{concept}' → {emb.shape[0]}-dim")

            # Build unified subspace projection matrix via SVD
            # Stack all concept embeddings into matrix C [dim, k]
            # SVD gives orthonormal basis Q for the joint concept subspace
            # P = I - Q @ Q^T projects out the entire subspace at once
            # This avoids the sequential projection trap where correlated
            # concepts re-inject components of each other
            dim = concept_embeddings[0].shape[0]
            C = torch.stack(concept_embeddings, dim=1)  # [dim, k]
            U, S, Vh = torch.linalg.svd(C, full_matrices=False)
            # Keep columns with non-negligible singular values
            rank_mask = S > 1e-6
            Q = U[:, rank_mask]  # Orthonormal basis for concept subspace
            QQt = Q @ Q.T  # [dim, dim] — projection onto concept subspace
            print(f"{TAG} Concept subspace: {Q.shape[1]} orthogonal directions "
                  f"from {len(concepts)} concepts (strength={strength})")

            # Load checkpoint, modify, save
            output_dict = {}
            kv_modified = 0

            with safe_open(checkpoint_path, framework="pt", device="cpu") as f:
                all_keys = list(f.keys())
                kv_keys = set(_find_cross_attn_kv_keys(all_keys))
                print(f"{TAG} Found {len(kv_keys)} cross-attention K/V keys to modify")

                for i, key in enumerate(all_keys):
                    tensor = f.get_tensor(key)

                    if key in kv_keys:
                        # Apply concept erasure: W_new = W - λ * W @ (Q @ Q^T)
                        w = tensor.float()
                        # W has shape [inner_dim, context_dim]
                        # QQt has shape [context_dim, context_dim]
                        if w.shape[-1] == dim:
                            w_erased = w - strength * (w @ QQt)
                            kv_modified += 1

                            # Check for NaN
                            if not torch.isfinite(w_erased).all():
                                print(f"{TAG} Warning: NaN after erasure in '{key}', keeping original")
                                w_erased = w
                            w = w_erased
                        else:
                            # Dimension mismatch — skip (might be SD1.5 vs SDXL mismatch)
                            if kv_modified == 0:
                                print(f"{TAG} Warning: context dim mismatch "
                                      f"(embedding={dim}, weight={w.shape[-1]}), skipping K/V")

                    # Downcast
                    out = w if key in kv_keys else tensor
                    if req.save_fp16 and out.dtype == torch.float32:
                        if VAE_PREFIX not in key:
                            out = out.half()
                    output_dict[key] = out

                    if i % 200 == 0 and i > 0:
                        pct = round(i / len(all_keys) * 100)
                        print(f"{TAG} Progress: {pct}% ({i}/{len(all_keys)} keys)")

            # Metadata
            recipe = {
                "operation": "concept_erasure",
                "concepts": concepts,
                "strength": strength,
                "source": os.path.basename(checkpoint_path),
                "keys_modified": kv_modified,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "workshop_version": VERSION,
            }
            metadata = {"studio_workshop_recipe": json.dumps(recipe)}

            print(f"{TAG} Saving {len(output_dict)} keys to {out_name}...")
            save_file(output_dict, output_path, metadata=metadata)
            del output_dict

            elapsed = round(time.time() - start, 1)
            print(f"{TAG} ✓ Concept erasure complete: {elapsed}s, "
                  f"{kv_modified} K/V matrices modified")
            return {
                "output": out_name, "elapsed": elapsed,
                "keys_modified": kv_modified, "concepts": concepts,
            }

        try:
            # Run in thread to avoid blocking
            result = await asyncio.get_event_loop().run_in_executor(None, _do_erasure)

            # Journal entry
            try:
                _journal_add_entry({
                    "id": f"erasure_{int(time.time())}",
                    "name": out_name,
                    "type": "concept_erasure",
                    "recipe": {
                        "operation": "concept_erasure",
                        "concepts": concepts,
                        "source": os.path.basename(checkpoint_path),
                        "keys_modified": result["keys_modified"],
                    },
                    "date": datetime.now(timezone.utc).isoformat(),
                    "elapsed": result["elapsed"],
                    "rating": 0,
                    "tags": ["concept_erasure"],
                    "notes": f"Erased: {', '.join(concepts)}",
                    "image": None,
                })
            except Exception:
                pass

            return result

        except Exception as e:
            import traceback
            traceback.print_exc()
            return JSONResponse({"error": str(e)}, status_code=500)

    print(f"{TAG} Routes registered (v{VERSION})")
