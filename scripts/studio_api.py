"""
Forge Studio — Standalone API
by ToxicHost & Moritz

FastAPI routes for the standalone Studio UI. All routes register onto Forge's
existing FastAPI app via the on_app_started callback — no patching of webui.py
or any Forge source files required.

Users install the extension, launch Forge normally, open localhost:7860/studio.
The Gradio UI continues to work at the default URL. Both UIs share the same backend.

Replaces the old add_studio_api() function in studio_generation.py.
"""

import asyncio
import base64
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import traceback
import urllib.error
import urllib.request
import zipfile
from datetime import date
from pathlib import Path
from threading import Thread
from typing import Optional, List

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from PIL import Image

from modules import shared, sd_models, sd_samplers, sd_schedulers

TAG = "[Studio API]"


# =========================================================================
# MODULE IMPORT HELPER
# =========================================================================
# studio_api.py may live in scripts/ or the extension root.
# Studio modules may be importable as "studio_generation" or
# "scripts.studio_generation" depending on the context.

def _import(module_name, attr):
    """Import an attribute from a studio module, handling path variations."""
    try:
        mod = __import__(module_name, fromlist=[attr])
    except ImportError:
        mod = __import__(f"scripts.{module_name}", fromlist=[attr])
    return getattr(mod, attr)


def _get_stub_module():
    """Load the gradio stub module — bundled copy first, modules/ fallback."""
    if not hasattr(_get_stub_module, '_cached'):
        try:
            import importlib.util as ilu
            stub_path = os.path.join(os.path.dirname(__file__), "studio_gradio_stub.py")
            spec = ilu.spec_from_file_location("studio_gradio_stub", stub_path)
            mod = ilu.module_from_spec(spec)
            spec.loader.exec_module(mod)
            _get_stub_module._cached = mod
        except Exception:
            import modules.gradio_stub as mod
            _get_stub_module._cached = mod
    return _get_stub_module._cached


# =========================================================================
# GIT UPDATE HELPER
# =========================================================================

# Find the Studio extension root (the dir containing frontend/) — same
# logic used throughout the codebase.
_here_dir = Path(__file__).parent
_studio_root = _here_dir if (_here_dir / "frontend").is_dir() else _here_dir.parent


def _next_forge_counter(output_dir: Path) -> int:
    """Return the next Forge-style 5-digit counter for the given folder.
    Scans existing files matching Studio-NNNNN-*.{png,jpg,webp} and returns
    max+1, or 1 if the folder is empty or has no matching files.
    """
    if not output_dir.is_dir():
        return 1
    max_n = 0
    for f in output_dir.iterdir():
        if not f.is_file():
            continue
        name = f.name
        if (
            len(name) >= 13
            and name[:7] == "Studio-"
            and name[7:12].isdigit()
            and name[12] == "-"
        ):
            n = int(name[7:12])
            if n > max_n:
                max_n = n
    return max_n + 1

# ── GitHub API update system ──────────────────────────────────────────
# No .git required. Checks the public GitHub API for new commits,
# downloads zip archives to update. Zero local metadata beyond a
# version.json with the current commit hash.
_GITHUB_OWNER = "ToxicHost"
_GITHUB_REPO = "Forge-Studio"
_GITHUB_BRANCH = "main"
_GITHUB_API = f"https://api.github.com/repos/{_GITHUB_OWNER}/{_GITHUB_REPO}"
_VERSION_FILE = _studio_root / "version.json"


def _read_version():
    """Read current commit hash from version.json, or None."""
    try:
        with open(_VERSION_FILE) as f:
            return json.load(f).get("commit")
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        return None


def _write_version(commit_sha):
    """Write commit hash to version.json."""
    with open(_VERSION_FILE, "w") as f:
        json.dump({"commit": commit_sha}, f)


def _github_get(path, timeout=15):
    """GET a GitHub API endpoint. Returns parsed JSON or None on failure."""
    url = f"{_GITHUB_API}{path}"
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "ForgeStudio-Updater",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, TimeoutError):
        return None


_current_version = _read_version()
if _current_version:
    print(f"{TAG} Version: {_current_version[:8]}")
else:
    print(f"{TAG} No version.json — update checks will treat this as a fresh install")


# =========================================================================
# REQUEST / RESPONSE MODELS
# =========================================================================

class ADSlotParams(BaseModel):
    """ADetailer slot parameters."""
    enable: bool = False
    model: str = "None"
    confidence: float = 0.3
    mask_min: float = 0.0
    mask_max: float = 1.0
    topk_filter: bool = False
    topk: int = 0
    x_offset: int = 0
    y_offset: int = 0
    erosion_dilation: int = 0
    merge_mode: str = "None"
    denoise: float = 0.4
    mask_blur: int = 4
    inpaint_pad: int = 32
    full_res: bool = True
    fill: int = 1
    sep_steps: bool = False
    steps: int = 28
    sep_cfg: bool = False
    cfg: float = 7.0
    sep_sampler: bool = False
    sampler: str = "DPM++ 2M SDE Karras"
    scheduler: str = "Use same scheduler"
    prompt: str = ""
    neg_prompt: str = ""


class GenerateRequest(BaseModel):
    """Full generation request matching run_generation() signature."""
    # Special action field: "generate" (default), "save_defaults", "load_defaults", "delete_defaults"
    action: str = "generate"
    defaults_data: Optional[dict] = None

    canvas_b64: str = ""
    mask_b64: str = ""
    fg_b64: str = "null"
    mode: str = "Create"
    inpaint_mode: str = "Inpaint"

    prompt: str = ""
    neg_prompt: str = ""
    steps: int = 30
    sampler_name: str = "DPM++ 2M SDE"
    schedule_type: str = "Karras"
    cfg_scale: float = 5.0
    denoising: float = 0.81
    width: int = 768
    height: int = 768
    seed: int = -1
    batch_count: int = 1
    batch_size: int = 1

    # Variation seed
    subseed: int = -1
    subseed_strength: float = 0
    seed_resize_from_w: int = 0
    seed_resize_from_h: int = 0

    mask_blur: int = 4
    inpainting_fill: int = 1
    inpaint_full_res: int = 0
    inpaint_pad: int = 64
    soft_inpaint_enabled: bool = False
    soft_inpaint_schedule_bias: float = 1.0
    soft_inpaint_preservation: float = 0.5
    soft_inpaint_transition_contrast: float = 4.0
    soft_inpaint_mask_influence: float = 0.0
    soft_inpaint_diff_threshold: float = 0.5
    soft_inpaint_diff_contrast: float = 2.0

    hr_enable: bool = False
    hr_upscaler: str = "Latent"
    hr_scale: float = 2.0
    hr_steps: int = 0
    hr_denoise: float = 0.3
    hr_cfg: float = 0.0
    hr_checkpoint: str = "Same"

    ad_enable: bool = False
    ad_slots: List[ADSlotParams] = Field(
        default_factory=lambda: [ADSlotParams(), ADSlotParams(), ADSlotParams()]
    )

    regions_json: str = ""
    cn_json: str = ""
    cn1_upload_b64: Optional[str] = None
    cn2_upload_b64: Optional[str] = None

    # Settings
    save_outputs: bool = True
    save_format: str = "png"         # png | jpeg | webp
    save_quality: int = 80           # JPEG/WebP quality (0-100)
    save_lossless: bool = False      # WebP lossless mode
    embed_metadata: bool = True      # whether to embed generation params in saved files
    is_txt2img: bool = False

    # Extension bridge: {arg_index: value} overrides from auto-bridged extensions
    extension_args: Optional[dict] = None
    # Extensions disabled in Studio's Settings toggle — force their enable args to False
    disabled_extensions: Optional[List[str]] = None

    # UX-018: AR Randomizer (native replacement for Moritz's AR Selector)
    ar_rand_base: bool = False
    ar_rand_ratio: bool = False
    ar_rand_orientation: bool = False
    ar_base_pool: List[int] = Field(default_factory=list)     # empty = all bases
    ar_ratio_pool: List[str] = Field(default_factory=list)    # empty = all ratios


class GenerateResponse(BaseModel):
    """Generation result."""
    images: List[str] = []
    image_paths: List[str] = []   # server-side file paths for /file= URLs
    infotexts: List[str] = []
    settings: dict = {}
    seed: int = -1
    task_id: str = ""
    error: Optional[str] = None


# =========================================================================
# HELPERS
# =========================================================================

def _flatten_ad_slot(slot: ADSlotParams) -> list:
    """Convert ADSlotParams into the flat arg list run_generation expects."""
    return [
        slot.enable, slot.model, slot.confidence, slot.mask_min, slot.mask_max,
        slot.topk_filter, slot.topk, slot.x_offset, slot.y_offset,
        slot.erosion_dilation, slot.merge_mode,
        slot.denoise, slot.mask_blur, slot.inpaint_pad, slot.full_res, slot.fill,
        slot.sep_steps, slot.steps, slot.sep_cfg, slot.cfg,
        slot.sep_sampler, slot.sampler, slot.scheduler,
        slot.prompt, slot.neg_prompt,
    ]


def _decode_b64_to_numpy(b64_str: Optional[str]):
    """Decode base64 image to numpy array for ControlNet upload."""
    if not b64_str or b64_str in ("null", ""):
        return None
    try:
        if "," in b64_str:
            b64_str = b64_str.split(",", 1)[1]
        img = Image.open(io.BytesIO(base64.b64decode(b64_str)))
        import numpy as np
        return np.array(img)
    except Exception:
        return None


def _pil_to_b64(img: Image.Image) -> str:
    """Encode a PIL image to base64 PNG data URL."""
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _pil_to_preview_b64(img: Image.Image) -> str:
    """Fast preview encoder — JPEG at q=70 balances quality and payload size.
    Used for both TAESD step previews and live preview thumbnails."""
    buf = io.BytesIO()
    if img.mode != "RGB":
        img = img.convert("RGB")
    img.save(buf, format="JPEG", quality=70)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def _studio_upscale_image(img, upscaler_name: str, scale: float):
    """Run a single ESRGAN-class upscaler pass on a PIL image.

    Extracted so both /studio/upscale and /studio/upscale_and_refine can
    reuse the ESRGAN path without round-tripping through HTTP. Synchronous
    and blocking — call via run_in_executor or asyncio.to_thread from
    async handlers.

    Returns the upscaled PIL.Image. Target dims are snapped to multiples
    of 8 so the result is a valid latent size for any downstream img2img
    pass. Falls back to LANCZOS if the requested upscaler is missing.
    """
    import gc
    import torch

    orig_w, orig_h = img.size
    scale = max(1.0, min(4.0, float(scale)))
    new_w = (int(orig_w * scale) // 8) * 8
    new_h = (int(orig_h * scale) // 8) * 8

    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        gc.collect()

    upscaler = None
    for u in shared.sd_upscalers:
        if u.name == upscaler_name:
            upscaler = u
            break

    if upscaler and upscaler.name != "None":
        target_scale = new_w / orig_w
        result = upscaler.scaler.upscale(img, target_scale, upscaler.data_path)
        if result.size != (new_w, new_h):
            result = result.resize((new_w, new_h), Image.LANCZOS)
    else:
        if upscaler_name and upscaler_name != "Latent":
            print(f"{TAG} Upscaler '{upscaler_name}' not found, using LANCZOS")
        result = img.resize((new_w, new_h), Image.LANCZOS)

    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        gc.collect()

    return result


def _build_exif_usercomment(text: str) -> Optional[bytes]:
    """Build EXIF bytes with generation params in UserComment.

    Used for JPEG and WebP metadata embedding. Tries piexif first
    (available in Forge Neo's dependency tree), falls back to
    Pillow's built-in Exif class.

    Returns EXIF bytes suitable for Pillow's save(exif=...), or None on failure.
    """
    if not text:
        return None
    try:
        import piexif
        # UserComment requires charset prefix — use ASCII for SD-standard params
        encoded = b"ASCII\x00\x00\x00" + text.encode("utf-8", errors="replace")
        exif_dict = {"Exif": {piexif.ExifIFD.UserComment: encoded}}
        return piexif.dump(exif_dict)
    except ImportError:
        pass
    try:
        # Fallback: Pillow's Exif (available since Pillow 6.0)
        exif = Image.Exif()
        # 0x9286 = UserComment tag in EXIF IFD
        exif[0x9286] = b"ASCII\x00\x00\x00" + text.encode("utf-8", errors="replace")
        return exif.tobytes()
    except Exception:
        return None


# =========================================================================
# EXTENSION BRIDGE — COMPONENT TYPE RESOLUTION
# =========================================================================
# In --nowebui mode, components are stubs with _type attributes.
# In Gradio mode (default bat), components are real Gradio widgets.
# This resolver handles both so the /extensions endpoint works
# regardless of how Forge was launched.

# Map real Gradio class names → our manifest type strings
_GRADIO_CLASS_MAP = {
    "Slider": "slider", "Checkbox": "checkbox", "Dropdown": "dropdown",
    "Radio": "radio", "Textbox": "textbox", "Number": "number",
    "Image": "image", "HTML": "html", "Markdown": "markdown",
    "Button": "button", "State": "state", "Gallery": "gallery",
    "Plot": "plot", "ColorPicker": "colorpicker", "File": "file",
    "Dataframe": "dataframe", "HighlightedText": "highlightedtext",
    "JSON": "json", "Label": "label", "Audio": "audio", "Video": "video",
}


def _resolve_component_type(comp):
    """Determine the manifest type string for a component.

    Works for both stub components (_type attribute) and real Gradio
    components (class name mapping). Falls back to value-based inference.
    """
    # Stub components have _type
    t = getattr(comp, '_type', None)
    if t and t != 'unknown':
        return t

    # Real Gradio components — walk MRO for a known class name
    for cls in type(comp).__mro__:
        mapped = _GRADIO_CLASS_MAP.get(cls.__name__)
        if mapped:
            return mapped

    # Value-based inference as last resort
    val = getattr(comp, 'value', None)
    if isinstance(val, bool):
        return "checkbox"
    if isinstance(val, (int, float)) and hasattr(comp, 'minimum'):
        return "slider"
    if hasattr(comp, 'choices') and getattr(comp, 'choices', None):
        return "dropdown"

    return "unknown"


# =========================================================================
# EXTENSION BRIDGE — LAYOUT GROUPS & DEPENDENCY PROBING
# =========================================================================
# Two-phase analysis of extension UI structure:
#
# Phase 1 (structural): Find layout containers (Column/Group) with mixed
# visibility — the Gradio pattern for toggle-able sections. These become
# DOM wrappers in the frontend.
#
# Phase 2 (behavioral): Probe .change() callbacks on dropdowns, radios,
# and checkboxes. Capture ALL effects: visibility changes on groups,
# value propagation to controls, choices updates on dropdowns. Ship as
# a unified "dependencies" list so the frontend can replicate Gradio's
# interactive behavior without running Python callbacks at runtime.

def _detect_layout_groups(controls, runner):
    """Find Column/Group siblings with mixed visibility (Phase 1).

    Returns (groups, layout_id_map) where:
    - groups: list of {id, visible, label, control_indices}
    - layout_id_map: {id(LayoutBlock): group_id} for dependency probing

    Each control dict in `controls` gets a "group" key added when it
    belongs to a visibility-controlled container.

    In Gradio mode (no stubs), components lack _parent/_children attrs —
    returns empty results gracefully. Controls still work, just without
    layout group metadata.
    """
    _stub = _get_stub_module(); LayoutBlock = _stub.LayoutBlock

    layout_id_map = {}
    if not controls:
        return [], layout_id_map

    # Build a map of control index → stub component
    comp_map = {}
    for c in controls:
        idx = c["index"]
        if idx < len(runner.inputs) and runner.inputs[idx] is not None:
            comp_map[idx] = runner.inputs[idx]

    # In Gradio mode, real components don't have _parent — bail early
    if not any(hasattr(comp, '_parent') for comp in comp_map.values()):
        return [], layout_id_map

    # Find all unique parent LayoutBlocks that contain controls from this script
    parent_set = {}
    for comp in comp_map.values():
        p = getattr(comp, '_parent', None)
        if p is not None and isinstance(p, LayoutBlock):
            parent_set[id(p)] = p

    groups = []
    checked_parents = set()

    for parent in list(parent_set.values()):
        # We want the parent OF our parent — the scope that contains the
        # sibling columns. Controls inside pane_decay have parent=pane_decay,
        # but pane_decay's parent is the Accordion — that's where we find siblings.
        scope = getattr(parent, '_parent', None)
        if scope is None or id(scope) in checked_parents:
            continue
        if not hasattr(scope, '_children'):
            continue
        checked_parents.add(id(scope))

        # Find child LayoutBlocks of the scope that are Column or Group
        child_layouts = [
            ch for ch in scope._children
            if isinstance(ch, LayoutBlock) and ch._type in ('column', 'group')
        ]

        if len(child_layouts) < 2:
            continue

        # Check for mixed visibility — the signature of toggle groups
        visibilities = [getattr(ch, 'visible', True) for ch in child_layouts]
        num_visible = sum(1 for v in visibilities if v)
        if num_visible == len(visibilities) or num_visible == 0:
            continue

        # Build groups from the sibling layout blocks
        group_base_id = len(groups)
        for gi, layout in enumerate(child_layouts):
            gid = group_base_id + gi
            layout_id_map[id(layout)] = gid

            group_indices = []
            for c in controls:
                comp = comp_map.get(c["index"])
                if comp and getattr(comp, '_parent', None) is layout:
                    c["group"] = gid
                    group_indices.append(c["index"])

            groups.append({
                "id": gid,
                "visible": getattr(layout, 'visible', True),
                "label": getattr(layout, 'label', ''),
                "control_indices": group_indices,
            })

    return groups, layout_id_map


def _probe_dependencies(controls, runner, groups, layout_id_map):
    """Probe .change() callbacks to extract the full interaction map (Phase 2).

    Handles:
    - Visibility toggling (dropdown/radio/checkbox → show/hide groups)
    - Value propagation (preset dropdown → set slider/input values)
    - Choices updates (dropdown A → change dropdown B's options)

    Returns list of dependency entries:
    [
      {
        "trigger": <control_index>,
        "effects": {
          "<value>": {
            "show_groups": [0, 1],     # group IDs to show
            "hide_groups": [2, 3],     # group IDs to hide
            "set_values": {"25": 1.35, "26": 3.0},  # arg_index → value
            "set_choices": {"45": ["a", "b", "c"]},  # arg_index → choices
            "set_visible": {"7": true, "8": false},  # arg_index → visible
          },
          ...
        }
      }
    ]
    """
    _stub = _get_stub_module(); LayoutBlock = _stub.LayoutBlock; StubComponent = _stub.StubComponent

    if not controls:
        return []

    # Reverse maps for output resolution
    comp_to_index = {}
    for i, comp in enumerate(runner.inputs):
        if comp is not None:
            comp_to_index[id(comp)] = i

    # Which control indices belong to this extension?
    ext_indices = {c["index"] for c in controls}

    dependencies = []

    for c in controls:
        comp = runner.inputs[c["index"]] if c["index"] < len(runner.inputs) else None
        if comp is None:
            continue

        handlers = getattr(comp, '_change_handlers', None)
        if not handlers:
            continue

        # Only probe controls with enumerable values
        comp_type = getattr(comp, '_type', '')
        if comp_type in ('dropdown', 'radio'):
            probe_values = list(getattr(comp, 'choices', []))
        elif comp_type == 'checkbox':
            probe_values = [True, False]
        else:
            continue

        if not probe_values:
            continue

        all_effects = {}

        for handler in handlers:
            fn = handler.get('fn')
            inputs = handler.get('inputs', [])
            outputs = handler.get('outputs', [])

            if fn is None or not outputs:
                continue

            # Only probe single-input handlers where input is this component
            if len(inputs) != 1 or inputs[0] is not comp:
                continue

            # Classify each output position
            output_targets = []
            for out in outputs:
                if isinstance(out, LayoutBlock) and id(out) in layout_id_map:
                    output_targets.append(("group", layout_id_map[id(out)]))
                elif isinstance(out, StubComponent):
                    idx = comp_to_index.get(id(out))
                    if idx is not None and idx in ext_indices:
                        output_targets.append(("control", idx))
                    else:
                        output_targets.append(("skip", None))
                else:
                    output_targets.append(("skip", None))

            # Skip handlers with no resolvable targets
            if not any(t[0] != "skip" for t in output_targets):
                continue

            # Probe each value
            try:
                for val in probe_values:
                    result = fn(val)
                    if not isinstance(result, (list, tuple)):
                        continue

                    # Use string key for JSON serialization
                    if isinstance(val, bool):
                        val_key = "true" if val else "false"
                    else:
                        val_key = str(val)

                    if val_key not in all_effects:
                        all_effects[val_key] = {}
                    effects = all_effects[val_key]

                    for i, r in enumerate(result):
                        if i >= len(output_targets):
                            break

                        target_type, target_id = output_targets[i]
                        if target_type == "skip":
                            continue

                        if not isinstance(r, dict):
                            continue

                        if target_type == "group":
                            vis = r.get("visible")
                            if vis is True:
                                effects.setdefault("show_groups", [])
                                if target_id not in effects["show_groups"]:
                                    effects["show_groups"].append(target_id)
                            elif vis is False:
                                effects.setdefault("hide_groups", [])
                                if target_id not in effects["hide_groups"]:
                                    effects["hide_groups"].append(target_id)

                        elif target_type == "control":
                            idx_str = str(target_id)

                            if "value" in r:
                                effects.setdefault("set_values", {})
                                effects["set_values"][idx_str] = r["value"]

                            if "visible" in r:
                                effects.setdefault("set_visible", {})
                                effects["set_visible"][idx_str] = r["visible"]

                            if "choices" in r:
                                effects.setdefault("set_choices", {})
                                effects["set_choices"][idx_str] = r["choices"]

            except Exception as e:
                print(f"[Studio Bridge] Dependency probe failed for "
                      f"control {c['index']} ({c.get('label', '')}): {e}")
                continue

        # Only emit if we got real effects
        if all_effects and any(bool(v) for v in all_effects.values()):
            dependencies.append({
                "trigger": c["index"],
                "effects": all_effects,
            })

    return dependencies


def _build_layout_tree(controls, runner, layout_id_map):
    """Build the full layout tree for an extension's UI (Phase 3).

    Walks the stub's parent/children structure to reconstruct the container
    hierarchy: Accordions, Rows, Columns, Groups — everything the extension
    declared in its ui() method. The frontend renders this tree faithfully
    instead of dumping controls flat.

    Returns a list of tree nodes, or None if no meaningful tree exists.
    Each node is either:
    - Control leaf: {"index": 25}
    - Container: {"type": "accordion", "label": "...", "children": [...]}
    """
    _stub = _get_stub_module(); LayoutBlock = _stub.LayoutBlock; StubComponent = _stub.StubComponent

    # Map of id(stub_component) → control index for this extension
    comp_id_to_index = {}
    for c in controls:
        idx = c["index"]
        if idx < len(runner.inputs) and runner.inputs[idx] is not None:
            comp_id_to_index[id(runner.inputs[idx])] = idx

    if not comp_id_to_index:
        return None

    # Find the root container — walk up from first control's parent chain
    # Stop before the Blocks context (that's the wrapper, not the extension's UI)
    first_comp = runner.inputs[min(c["index"] for c in controls)]
    chain = []
    p = getattr(first_comp, '_parent', None)
    while p is not None and isinstance(p, LayoutBlock):
        if p._type == 'blocks':
            break
        chain.append(p)
        p = getattr(p, '_parent', None)

    if not chain:
        return None  # No container hierarchy — frontend uses flat rendering

    root = chain[-1]  # Highest non-Blocks ancestor

    # Build a set of all layout nodes that contain (directly or nested)
    # at least one of this extension's controls. We use this to prune
    # empty branches from the tree.
    layouts_with_controls = set()
    for comp_id, idx in comp_id_to_index.items():
        comp = runner.inputs[idx]
        p = getattr(comp, '_parent', None)
        while p is not None and isinstance(p, LayoutBlock):
            if p._type == 'blocks':
                break
            layouts_with_controls.add(id(p))
            p = getattr(p, '_parent', None)

    def serialize(node):
        """Recursively serialize a LayoutBlock into a tree node."""
        if id(node) not in layouts_with_controls:
            return None  # Prune — no extension controls in this branch

        result = {"type": node._type}

        if getattr(node, 'label', ''):
            result["label"] = node.label
        if not getattr(node, 'visible', True):
            result["visible"] = False
        if node._type == 'accordion':
            result["open"] = getattr(node, 'open', False)

        # Tag with group ID if this container is a visibility-toggled group
        gid = layout_id_map.get(id(node))
        if gid is not None:
            result["group"] = gid

        # Collect all direct children (sub-layouts AND components) in creation order
        items = []
        for child in getattr(node, '_children', []):
            items.append(('layout', child._id, child))
        for comp in getattr(node, '_components', []):
            items.append(('comp', comp._id, comp))
        items.sort(key=lambda x: x[1])

        children = []
        for kind, _, item in items:
            if kind == 'layout':
                child_node = serialize(item)
                if child_node is not None:
                    children.append(child_node)
            else:
                # Component — only include if it's one of this extension's controls
                idx = comp_id_to_index.get(id(item))
                if idx is not None:
                    children.append({"index": idx})

        if not children:
            return None  # Empty after pruning

        result["children"] = children
        return result

    tree = serialize(root)
    if tree is None:
        return None

    # If root is just a wrapping Accordion (the common pattern), unwrap it.
    # The frontend already wraps each extension in a collapsible ext-group,
    # so a double-nested accordion is redundant.
    if tree.get("type") == "accordion" and "children" in tree:
        return tree["children"]

    return [tree]


# =========================================================================
# PROGRESS STREAMING
# =========================================================================

_progress_connections: list[WebSocket] = []
_uvicorn_loop = None  # Captured on first WebSocket connect


# =========================================================================
# VRAM MANAGEMENT — Auto-unload timer
# =========================================================================

import threading

_auto_unload_timer: Optional[threading.Timer] = None
_auto_unload_enabled = False
_auto_unload_minutes = 10  # default: 10 minutes
_last_generation_time = 0.0  # timestamp of last generation completion


def _cancel_auto_unload():
    """Cancel any pending auto-unload timer."""
    global _auto_unload_timer
    if _auto_unload_timer is not None:
        _auto_unload_timer.cancel()
        _auto_unload_timer = None


def _schedule_auto_unload():
    """Start (or restart) the auto-unload countdown."""
    global _auto_unload_timer
    _cancel_auto_unload()
    if not _auto_unload_enabled or _auto_unload_minutes <= 0:
        return
    _auto_unload_timer = threading.Timer(
        _auto_unload_minutes * 60,
        _do_auto_unload,
    )
    _auto_unload_timer.daemon = True
    _auto_unload_timer.start()


def _do_auto_unload():
    """Called by the timer thread when idle threshold is reached."""
    global _auto_unload_timer
    _auto_unload_timer = None
    try:
        if not hasattr(shared, 'sd_model') or shared.sd_model is None:
            return  # Already unloaded
        sd_models.unload_model_weights()
        _log_vram(f"Auto-unloaded model after {_auto_unload_minutes}min idle")
        # Broadcast unload event to connected WebSocket clients
        # Must use Uvicorn's event loop — WebSocket transports are bound to it
        if _uvicorn_loop and not _uvicorn_loop.is_closed():
            asyncio.run_coroutine_threadsafe(_broadcast_progress({
                "type": "model_unloaded",
                "reason": "idle",
                "minutes": _auto_unload_minutes,
            }), _uvicorn_loop)
    except Exception as e:
        print(f"{TAG} Auto-unload failed: {e}")


def _log_vram(context=""):
    """Log VRAM usage to the Python terminal."""
    try:
        import torch
        if not torch.cuda.is_available():
            print(f"{TAG} VRAM: CUDA not available")
            return
        allocated = torch.cuda.memory_allocated() / (1024 ** 3)
        reserved = torch.cuda.memory_reserved() / (1024 ** 3)
        total = torch.cuda.get_device_properties(0).total_memory / (1024 ** 3)
        prefix = f"{TAG} VRAM"
        if context:
            prefix += f" [{context}]"
        print(f"{prefix}: {allocated:.2f} GB allocated / {reserved:.2f} GB reserved / {total:.2f} GB total")
    except Exception as e:
        print(f"{TAG} VRAM log error: {e}")


async def _broadcast_progress(data: dict):
    """Send progress to all connected WebSocket clients."""
    dead = []
    for ws in _progress_connections:
        try:
            await ws.send_json(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        if ws in _progress_connections:
            _progress_connections.remove(ws)


def _is_live_active():
    """Check if Live Painting is active. Non-throwing."""
    try:
        import sys
        for name in ['studio_live', 'scripts.studio_live']:
            if name in sys.modules:
                return getattr(sys.modules[name], '_is_active', False)
        return False
    except Exception:
        return False


def _taesd_decode_preview(latent, max_edge=0):
    """Decode a latent tensor to a PIL Image using TAESD (~5-10ms).

    Falls back gracefully if TAESD model isn't available.
    max_edge=0 means no downscale (full generation resolution).
    """
    import torch
    from modules import sd_samplers_common

    with torch.inference_mode():
        # Handle batch dim: latent may be [B,C,H,W] or [C,H,W]
        sample = latent[0] if latent.ndim == 4 else latent
        # Force TAESD (approximation=3) — ~5-10ms vs 50-150ms full VAE
        preview_img = sd_samplers_common.single_sample_to_image(sample, approximation=3)

    if max_edge > 0:
        w, h = preview_img.size
        long_edge = max(w, h)
        if long_edge > max_edge:
            scale = max_edge / long_edge
            preview_img = preview_img.resize(
                (max(1, int(w * scale)), max(1, int(h * scale))),
                Image.BILINEAR
            )

    return preview_img


def _progress_polling_thread():
    """Background thread that polls shared.state and broadcasts progress.

    Uses TAESD for fast preview decodes (~5-10ms) instead of full VAE
    (~50-150ms). Adaptive intervals: faster during Live Painting, normal
    during standard generation. Previews are sent at higher resolution
    than the old 240px cap.

    Must be resilient to both --nowebui and Gradio launch modes.
    In Gradio mode, Forge's own progress system may read/write
    shared.state concurrently — all reads are snapshot-guarded.
    """
    _last_preview = [None]  # mutable ref — cache last known preview
    _idle_ticks = [0]  # count consecutive idle polls to debounce
    _logged_error = [False]  # only log first error to avoid spam
    _last_preview_step = [(-1, -1)]  # last (job_no, step) we decoded a preview for
    _last_preview_time = [0.0]  # timestamp of last TAESD decode
    _taesd_logged = [False]  # log TAESD availability once

    while True:
        # Adaptive poll rate: faster during Live for snappier previews
        live_mode = _is_live_active()
        time.sleep(0.2 if live_mode else 0.4)

        if not _progress_connections:
            continue

        # Wait for Uvicorn's loop to be captured
        if not _uvicorn_loop or _uvicorn_loop.is_closed():
            continue

        try:
            # Snapshot state values to avoid race conditions with
            # Gradio's progress system reading/writing simultaneously
            job_count = shared.state.job_count or 0
            job_no = shared.state.job_no or 0
            sampling_step = shared.state.sampling_step or 0
            sampling_steps = shared.state.sampling_steps or 0
            textinfo = shared.state.textinfo or ""

            # Check if generation is active — use multiple signals to avoid
            # missing progress during job transitions where job_count briefly = 0
            has_jobs = job_count > 0 or sampling_steps > 0
            has_text = bool(textinfo)
            is_active = has_jobs or has_text

            if not is_active:
                _idle_ticks[0] += 1
                if _idle_ticks[0] > 3:  # ~1.2s of idle before clearing preview
                    _last_preview[0] = None
                    _last_preview_step[0] = (-1, -1)
                continue

            _idle_ticks[0] = 0
            _logged_error[0] = False  # reset error flag when active

            progress = 0.0
            if job_count > 0:
                progress += job_no / job_count
            if sampling_steps > 0:
                progress += (1 / max(1, job_count)) * (
                    sampling_step / sampling_steps
                )

            preview_b64 = None
            # Adaptive preview settings:
            #   Live mode:   decode every 0.3s, full resolution (no downscale)
            #   Normal gen:  decode every 0.5s, cap at 480px long edge
            preview_interval = 0.3 if live_mode else 0.5
            preview_max_edge = 0 if live_mode else 480

            now = time.time()
            current_key = (job_no, sampling_step)
            step_changed = current_key != _last_preview_step[0]
            interval_ok = (now - _last_preview_time[0]) >= preview_interval
            should_decode = step_changed and interval_ok

            if should_decode:
                try:
                    # TAESD decode — fast (~5-10ms), doesn't stall the sampler.
                    # Reads current_latent directly instead of going through
                    # set_current_image() which does a full VAE decode.
                    latent = shared.state.current_latent
                    if latent is not None:
                        # Skip video latents (5D) — TAESD image decoder
                        # doesn't handle video; fall back to existing path
                        if latent.ndim == 5:
                            shared.state.set_current_image()
                            current_img = shared.state.current_image
                            if current_img:
                                preview_b64 = _pil_to_preview_b64(current_img)
                        else:
                            preview_img = _taesd_decode_preview(latent, preview_max_edge)
                            preview_b64 = _pil_to_preview_b64(preview_img)

                        if preview_b64:
                            if not _taesd_logged[0]:
                                print(f"{TAG} TAESD preview active "
                                      f"({'Live' if live_mode else 'standard'} mode, "
                                      f"interval={preview_interval}s, "
                                      f"max_edge={preview_max_edge or 'full'})")
                                _taesd_logged[0] = True
                            _last_preview[0] = preview_b64
                            _last_preview_step[0] = current_key
                            _last_preview_time[0] = now
                except Exception as e:
                    # Preview decode failed — non-fatal, use cached preview
                    if not _logged_error[0]:
                        print(f"{TAG} Preview decode error (non-fatal, using cache): {e}")
                        _logged_error[0] = True

            data = {
                "type": "progress",
                "progress": min(1.0, progress),
                "step": sampling_step,
                "total_steps": sampling_steps,
                "job": job_no,
                "job_count": job_count,
                "preview": preview_b64 or _last_preview[0],
                "textinfo": textinfo,
            }

            asyncio.run_coroutine_threadsafe(_broadcast_progress(data), _uvicorn_loop)

        except Exception as e:
            if not _logged_error[0]:
                print(f"{TAG} Progress poll error: {e}")
                _logged_error[0] = True


# =========================================================================
# ROUTE REGISTRATION
# =========================================================================

def setup_studio_routes(app: FastAPI):
    """Register all Studio routes onto Forge's FastAPI app."""

    print(f"{TAG} Registering routes...")

    # ------------------------------------------------------------------
    # Standalone mode: root redirect + file serving
    # ------------------------------------------------------------------
    # In --nowebui mode, Gradio isn't running so "/" is unhandled and
    # the /file=<path> route (used for serving output images & tag-
    # complete assets) doesn't exist. These two routes fill that gap.

    @app.get("/")
    async def root_redirect():
        return RedirectResponse(url="/studio")

    @app.get("/file={file_path:path}")
    async def serve_local_file(file_path: str):
        """Serve local files — replaces Gradio's /file= route for standalone mode.

        In normal (Gradio) mode Gradio handles this route, so this handler
        simply never matches. In --nowebui mode it's the only provider.
        """
        import urllib.parse
        file_path = urllib.parse.unquote(file_path)

        resolved = Path(file_path)
        if not resolved.is_absolute():
            resolved = Path.cwd() / resolved
        resolved = resolved.resolve()

        # Security: file must live under the Forge root OR the configured
        # output directory (which may be on a different drive/mount)
        allowed_roots = [str(Path.cwd().resolve())]
        try:
            _outdir = shared.opts.data.get("outdir_samples", "") or shared.opts.data.get("outdir_img2img_samples", "")
            if _outdir:
                allowed_roots.append(str(Path(_outdir).resolve()))
            # Also allow the parent of common output subdirs
            for _key in ("outdir_txt2img_samples", "outdir_img2img_samples", "outdir_save"):
                _d = shared.opts.data.get(_key, "")
                if _d:
                    allowed_roots.append(str(Path(_d).resolve()))
                    # Parent covers sibling folders (e.g. output/ when config says output/txt2img-images/)
                    allowed_roots.append(str(Path(_d).resolve().parent))
        except Exception:
            pass

        resolved_str = str(resolved)
        if not any(resolved_str.startswith(root) for root in allowed_roots):
            return JSONResponse({"error": "Access denied"}, status_code=403)
        if not resolved.is_file():
            return JSONResponse({"error": "Not found"}, status_code=404)

        # Guess media type from suffix
        suffix_map = {
            ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".webp": "image/webp", ".gif": "image/gif", ".txt": "text/plain",
            ".json": "application/json", ".csv": "text/csv",
            ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
        }
        media = suffix_map.get(resolved.suffix.lower())
        return FileResponse(str(resolved), media_type=media)

    # ------------------------------------------------------------------
    # Generation
    # ------------------------------------------------------------------

    @app.post("/studio/generate", response_model=GenerateResponse)
    async def generate(req: GenerateRequest):
        # --- Defaults actions (reuse working endpoint) ---
        print(f"{TAG} generate endpoint called: action={req.action!r}")
        _here = Path(__file__).parent
        _ext_root = _here if (_here / "frontend").is_dir() else _here.parent
        _defaults_file = _ext_root / "user_defaults.json"

        if req.action == "save_defaults" and req.defaults_data is not None:
            try:
                _defaults_file.write_text(json.dumps(req.defaults_data, indent=2))
                print(f"{TAG} Defaults saved to {_defaults_file} ({len(req.defaults_data)} keys)")
                return GenerateResponse(settings={"defaults_saved": True})
            except Exception as e:
                return GenerateResponse(error=f"Defaults save failed: {e}")

        if req.action == "load_defaults":
            if _defaults_file.exists():
                try:
                    data = json.loads(_defaults_file.read_text())
                    return GenerateResponse(settings=data)
                except Exception:
                    return GenerateResponse(settings={})
            return GenerateResponse(settings={})

        if req.action == "delete_defaults":
            if _defaults_file.exists():
                _defaults_file.unlink()
            return GenerateResponse(settings={"defaults_deleted": True})

        # --- Normal generation ---
        _cancel_auto_unload()
        run_generation = _import("studio_generation", "run_generation")

        ad_slots = req.ad_slots + [ADSlotParams()] * max(0, 3 - len(req.ad_slots))
        ad1_args = _flatten_ad_slot(ad_slots[0])
        ad2_args = _flatten_ad_slot(ad_slots[1])
        ad3_args = _flatten_ad_slot(ad_slots[2])

        cn1_img = _decode_b64_to_numpy(req.cn1_upload_b64)
        cn2_img = _decode_b64_to_numpy(req.cn2_upload_b64)

        # UX-015: Suppress disabled extensions by forcing their boolean args
        # (enable toggles) to False. This prevents alwayson scripts from running
        # with stale defaults when the user has toggled them off in Studio.
        ext_args = dict(req.extension_args) if req.extension_args else {}
        # Suppress extensions that the user has disabled in Studio's Settings toggle.
        if req.disabled_extensions:
            try:
                import modules.scripts as mod_scripts
                runner = mod_scripts.scripts_img2img
                if runner:
                    disabled_set = {n.lower() for n in req.disabled_extensions}
                    for script in runner.alwayson_scripts:
                        try:
                            title = script.title().strip().lower() if callable(getattr(script, 'title', None)) else ""
                        except Exception:
                            title = ""
                        if title not in disabled_set:
                            continue
                        if not hasattr(script, 'args_from') or script.args_from is None:
                            continue
                        # Force all boolean-valued args to False (catches enable toggles)
                        for i in range(script.args_from, script.args_to):
                            if i < len(runner.inputs) and runner.inputs[i] is not None:
                                val = getattr(runner.inputs[i], 'value', None)
                                if isinstance(val, bool):
                                    ext_args[str(i)] = False
                        print(f"{TAG} Suppressed disabled extension: {title}")
            except Exception as e:
                print(f"{TAG} Extension suppression error: {e}")

        try:
            result = await asyncio.to_thread(
                run_generation,
                req.canvas_b64, req.mask_b64, req.fg_b64, req.mode, req.inpaint_mode,
                req.prompt, req.neg_prompt,
                req.steps, req.sampler_name, req.schedule_type, req.cfg_scale, req.denoising,
                req.width, req.height, req.seed, req.batch_count, req.batch_size,
                req.mask_blur, req.inpainting_fill, req.inpaint_full_res, req.inpaint_pad,
                req.soft_inpaint_enabled, req.soft_inpaint_schedule_bias,
                req.soft_inpaint_preservation, req.soft_inpaint_transition_contrast,
                req.soft_inpaint_mask_influence, req.soft_inpaint_diff_threshold,
                req.soft_inpaint_diff_contrast,
                req.hr_enable, req.hr_upscaler, req.hr_scale, req.hr_steps,
                req.hr_denoise, req.hr_cfg, req.hr_checkpoint,
                req.ad_enable,
                *ad1_args, *ad2_args, *ad3_args,
                req.regions_json, req.cn_json,
                cn1_img, cn2_img,
                req.subseed, req.subseed_strength,
                req.seed_resize_from_w, req.seed_resize_from_h,
                req.is_txt2img,
                ext_args or None,
                {
                    "rand_base": req.ar_rand_base,
                    "rand_ratio": req.ar_rand_ratio,
                    "rand_orientation": req.ar_rand_orientation,
                    "base_pool": req.ar_base_pool,
                    "ratio_pool": req.ar_ratio_pool,
                } if (req.ar_rand_base or req.ar_rand_ratio or req.ar_rand_orientation) else None,
            )
        except Exception as e:
            print(f"{TAG} Generation error: {e}")
            traceback.print_exc()
            return GenerateResponse(error=str(e))

        if not result or not isinstance(result, (list, tuple)) or len(result) < 5:
            return GenerateResponse(error="Generation returned no result")

        images_list, info_html, result_b64, settings_json, task_id = result

        images_b64 = []
        image_paths = []

        # Auto-save images to output/studio/{mode}/ (unless disabled by user)
        mode_folder = {"Create": "create", "Edit": "edit", "img2img": "img2img"}.get(req.mode, "create")
        try:
            # Use the same output dir logic as the generation pipeline
            base_outdir = shared.opts.data.get("outdir_samples", "")
            if not base_outdir:
                base_outdir = shared.opts.data.get("outdir_img2img_samples", "")
            if not base_outdir:
                from modules.paths import data_path
                base_outdir = os.path.join(data_path, "output")
            if os.path.basename(base_outdir) in ("txt2img-images", "img2img-images"):
                base_outdir = os.path.dirname(base_outdir)
        except Exception:
            base_outdir = os.path.abspath("output")
        output_dir = Path(base_outdir) / "studio" / mode_folder / date.today().strftime("%Y-%m-%d")
        if req.save_outputs:
            output_dir.mkdir(parents=True, exist_ok=True)

        # Pre-parse settings_json once (was being re-parsed per image)
        _parsed_settings = None
        _parsed_infotexts = []
        if settings_json:
            try:
                _parsed_settings = json.loads(settings_json)
                _parsed_infotexts = _parsed_settings.get("infotexts", [])
            except Exception:
                pass

        try:
            _parsed_base_seed = int(_parsed_settings.get("seed", -1)) if _parsed_settings else -1
        except Exception:
            _parsed_base_seed = -1

        _base_counter = _next_forge_counter(output_dir) if req.save_outputs else 1

        for i, img in enumerate(images_list or []):
            if isinstance(img, Image.Image):
                # When saving as PNG, encode once to buffer and reuse for both
                # disk save and b64 response (avoids double PNG compression).
                if req.save_outputs and req.save_format == "png":
                    try:
                        ext = "png"
                        image_seed = (_parsed_base_seed + i) if _parsed_base_seed != -1 else 0
                        counter = _base_counter + i
                        while True:
                            fname = f"Studio-{counter:05d}-{image_seed}.{ext}"
                            fpath = output_dir / fname
                            if not fpath.exists():
                                break
                            counter += 1
                        save_kwargs = {}
                        if req.embed_metadata and _parsed_infotexts:
                            try:
                                if i < len(_parsed_infotexts) and _parsed_infotexts[i]:
                                    from PIL.PngImagePlugin import PngInfo
                                    pnginfo = PngInfo()
                                    pnginfo.add_text("parameters", _parsed_infotexts[i])
                                    save_kwargs["pnginfo"] = pnginfo
                            except Exception:
                                pass
                        # Encode to buffer once, use for both disk and b64
                        buf = io.BytesIO()
                        img.save(buf, format="PNG", **save_kwargs)
                        png_bytes = buf.getvalue()
                        # Write to disk from buffer (no re-encode)
                        with open(str(fpath), "wb") as f:
                            f.write(png_bytes)
                        image_paths.append(str(fpath))
                        # Save metadata to Gallery DB by content hash (fire-and-forget).
                        # Always saves regardless of embed_metadata toggle — the DB is
                        # the durable metadata store, embed just controls the PNG chunk.
                        try:
                            _hash_fn = _import("studio_gallery", "compute_content_hash")
                            _gallery_save = _import("studio_gallery", "save_metadata_by_hash")
                            if _hash_fn and _gallery_save and _parsed_infotexts and i < len(_parsed_infotexts) and _parsed_infotexts[i]:
                                # PNG is lossless — hash the original PIL pixels directly (faster, no re-decode)
                                _ch = _hash_fn(img)
                                if _ch:
                                    _gallery_save(_ch, _parsed_infotexts[i], _parsed_settings)
                        except Exception:
                            pass
                        # b64 from same buffer (no re-encode)
                        images_b64.append("data:image/png;base64," + base64.b64encode(png_bytes).decode())
                    except Exception as e:
                        print(f"{TAG} Auto-save error: {e}")
                        # Fallback: at least get the b64
                        images_b64.append(_pil_to_b64(img))
                else:
                    # Non-PNG save or no save: encode b64 normally
                    images_b64.append(_pil_to_b64(img))
                    # Save to disk if enabled (non-PNG formats)
                    if req.save_outputs:
                        try:
                            ext_map = {"png": "png", "jpeg": "jpg", "webp": "webp"}
                            ext = ext_map.get(req.save_format, "png")
                            image_seed = (_parsed_base_seed + i) if _parsed_base_seed != -1 else 0
                            counter = _base_counter + i
                            while True:
                                fname = f"Studio-{counter:05d}-{image_seed}.{ext}"
                                fpath = output_dir / fname
                                if not fpath.exists():
                                    break
                                counter += 1
                            save_kwargs = {}

                            if req.save_format == "jpeg":
                                img = img.convert("RGB")  # Drop alpha for JPEG
                                save_kwargs = {"quality": req.save_quality, "optimize": True}
                                if req.embed_metadata and _parsed_infotexts:
                                    try:
                                        if i < len(_parsed_infotexts) and _parsed_infotexts[i]:
                                            exif_bytes = _build_exif_usercomment(_parsed_infotexts[i])
                                            if exif_bytes:
                                                save_kwargs["exif"] = exif_bytes
                                    except Exception:
                                        pass
                            elif req.save_format == "webp":
                                if req.save_lossless:
                                    save_kwargs = {"lossless": True}
                                else:
                                    save_kwargs = {"quality": req.save_quality}
                                if req.embed_metadata and _parsed_infotexts:
                                    try:
                                        if i < len(_parsed_infotexts) and _parsed_infotexts[i]:
                                            exif_bytes = _build_exif_usercomment(_parsed_infotexts[i])
                                            if exif_bytes:
                                                save_kwargs["exif"] = exif_bytes
                                    except Exception:
                                        pass

                            img.save(str(fpath), **save_kwargs)
                            image_paths.append(str(fpath))
                            # Save metadata to Gallery DB by content hash (fire-and-forget).
                            # Always saves regardless of embed_metadata toggle.
                            # Lossy formats: must hash from file (post-encode pixels differ from original).
                            try:
                                _hash_fn = _import("studio_gallery", "compute_content_hash")
                                _gallery_save = _import("studio_gallery", "save_metadata_by_hash")
                                if _hash_fn and _gallery_save and _parsed_infotexts and i < len(_parsed_infotexts) and _parsed_infotexts[i]:
                                    _ch = _hash_fn(str(fpath))
                                    if _ch:
                                        _gallery_save(_ch, _parsed_infotexts[i], _parsed_settings)
                            except Exception:
                                pass
                        except Exception as e:
                            print(f"{TAG} Auto-save error: {e}")
            elif isinstance(img, str):
                images_b64.append(img)

        settings = {}
        infotexts = []
        seed_val = -1
        if settings_json:
            try:
                settings = json.loads(settings_json)
                infotexts = settings.get("infotexts", [])
                seed_val = settings.get("seed", -1)
            except Exception:
                pass

        error_msg = None
        if not images_b64 and info_html:
            error_msg = re.sub(r'<[^>]+>', '', info_html).strip()

        # UX-013: Reset auto-unload timer after generation
        global _last_generation_time
        _last_generation_time = time.time()
        if _auto_unload_enabled:
            _schedule_auto_unload()

        _log_vram("Generation complete")

        return GenerateResponse(
            images=images_b64,
            image_paths=image_paths,
            infotexts=infotexts,
            settings=settings,
            seed=seed_val,
            task_id=task_id or "",
            error=error_msg,
        )

    # ------------------------------------------------------------------
    # Interrupt / Skip / Task ID
    # ------------------------------------------------------------------

    @app.post("/studio/interrupt")
    async def interrupt():
        do_interrupt = _import("studio_generation", "do_interrupt")
        do_interrupt()
        return {"ok": True}

    @app.post("/studio/skip")
    async def skip():
        do_skip = _import("studio_generation", "do_skip")
        do_skip()
        return {"ok": True}

    @app.get("/studio/task_id")
    async def task_id():
        get_studio_task_id = _import("studio_generation", "get_studio_task_id")
        return {"task_id": get_studio_task_id()}

    # ------------------------------------------------------------------
    # Live Painting
    # ------------------------------------------------------------------

    def _ensure_live_broadcast():
        """Lazy-wire studio_live's broadcast to our WebSocket infrastructure.

        Forge may load the module as 'studio_live' or 'scripts.studio_live' —
        these are separate instances in sys.modules. We must wire BOTH or the
        generation worker (running in one instance) won't have broadcast refs.
        """
        import sys
        candidates = []
        for name in ['studio_live', 'scripts.studio_live']:
            if name in sys.modules:
                candidates.append(sys.modules[name])
            else:
                try:
                    candidates.append(__import__(name, fromlist=['studio_live']))
                except ImportError:
                    pass
        if not candidates:
            raise ImportError("Cannot find studio_live module")

        for mod in candidates:
            if _uvicorn_loop and not getattr(mod, '_broadcast_wired', False):
                mod.set_broadcast(_broadcast_progress, _uvicorn_loop)
                mod._broadcast_wired = True
                print(f"{TAG} Live broadcast wired on {mod.__name__}")
        return candidates[0]

    @app.post("/studio/live/start")
    async def live_start():
        live = _ensure_live_broadcast()
        return live.handle_start()

    @app.post("/studio/live/stop")
    async def live_stop():
        live = _ensure_live_broadcast()
        return live.handle_stop()

    @app.post("/studio/live/submit")
    async def live_submit(request: Request):
        live = _ensure_live_broadcast()
        data = await request.json()
        return live.handle_submit(data)

    @app.get("/studio/live/status")
    async def live_status():
        live = _ensure_live_broadcast()
        return live.get_status()

    # ------------------------------------------------------------------
    # WebSocket — progress streaming
    # ------------------------------------------------------------------

    @app.websocket("/studio/ws")
    async def progress_websocket(websocket: WebSocket):
        global _uvicorn_loop
        await websocket.accept()
        _progress_connections.append(websocket)
        # Capture Uvicorn's event loop — background threads need this to
        # safely write to WebSocket transports without assertion errors
        if _uvicorn_loop is None:
            _uvicorn_loop = asyncio.get_event_loop()
            # Wire Live Painting broadcast now that we have the event loop
            try:
                _ensure_live_broadcast()
            except Exception:
                pass  # studio_live may not be installed yet
        print(f"{TAG} WebSocket connected ({len(_progress_connections)} clients)")
        try:
            while True:
                data = await websocket.receive_text()
                if data == "ping":
                    await websocket.send_json({"type": "pong"})
        except WebSocketDisconnect:
            pass
        finally:
            if websocket in _progress_connections:
                _progress_connections.remove(websocket)
            print(f"{TAG} WebSocket disconnected ({len(_progress_connections)} clients)")

    # ------------------------------------------------------------------
    # Models / Samplers / Resources
    # ------------------------------------------------------------------

    @app.get("/studio/models")
    async def get_models():
        return [{
            "title": m.title, "name": m.model_name,
            "hash": m.shorthash, "filename": m.filename,
        } for m in sd_models.checkpoints_list.values()]

    @app.get("/studio/current_model")
    async def get_current_model():
        """Return the actually loaded model, not just the config setting."""
        try:
            # shared.sd_model has the actual loaded model
            if hasattr(shared, 'sd_model') and shared.sd_model is not None:
                ckpt_info = getattr(shared.sd_model, 'sd_checkpoint_info', None)
                if ckpt_info:
                    return {"title": ckpt_info.title, "name": ckpt_info.model_name,
                            "hash": getattr(ckpt_info, 'shorthash', '')}
            # Fallback to config
            return {"title": shared.opts.data.get("sd_model_checkpoint", ""),
                    "name": "", "hash": ""}
        except Exception:
            return {"title": "", "name": "", "hash": ""}

    @app.get("/studio/samplers")
    async def get_samplers():
        return [{"name": s.name} for s in sd_samplers.all_samplers]

    @app.get("/studio/schedulers")
    async def get_schedulers():
        return [{"name": s.name, "label": s.label} for s in sd_schedulers.schedulers]

    @app.get("/studio/upscalers")
    async def get_upscalers():
        return [{"name": u.name} for u in shared.sd_upscalers]

    # ------------------------------------------------------------------
    # Post-generation upscale — runs standalone upscaler on an image
    # Designed for low-VRAM users who can't run Hires Fix + ADetailer
    # simultaneously. Clears VRAM before running so the full 6GB is
    # available for the upscaler (~0.5-1.5GB for ESRGAN-class models).
    # ------------------------------------------------------------------

    class UpscaleRequest(BaseModel):
        image_b64: str                     # data URL or raw base64
        upscaler: str = "R-ESRGAN 4x+"    # name from /studio/upscalers
        scale: float = 2.0                 # 1.0-4.0
        save: bool = False                 # also save to outputs/
        subfolder: str = "upscaled"        # subfolder if saving

    @app.post("/studio/upscale")
    async def studio_upscale(request: Request):
        import asyncio
        import base64
        from io import BytesIO
        from PIL import Image

        try:
            data = await request.json()
            image_b64 = data.get("image_b64", "")
            upscaler_name = data.get("upscaler", "R-ESRGAN 4x+")
            scale = float(data.get("scale", 2.0))
            do_save = data.get("save", False)
            subfolder = data.get("subfolder", "upscaled")

            scale = max(1.0, min(4.0, scale))

            # Decode image
            if "," in image_b64:
                image_b64 = image_b64.split(",", 1)[1]
            img_bytes = base64.b64decode(image_b64)
            img = Image.open(BytesIO(img_bytes)).convert("RGB")
            orig_w, orig_h = img.size

            print(f"{TAG} Upscale: {orig_w}x{orig_h} with {upscaler_name} ({scale}x)")

            upscaled = await asyncio.get_event_loop().run_in_executor(
                None, _studio_upscale_image, img, upscaler_name, scale
            )
            new_w, new_h = upscaled.size

            # Encode result
            buf = BytesIO()
            upscaled.save(buf, format="PNG")
            result_b64 = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()

            result = {
                "ok": True,
                "image": result_b64,
                "width": upscaled.size[0],
                "height": upscaled.size[1],
                "original_width": orig_w,
                "original_height": orig_h,
                "upscaler": upscaler_name,
                "scale": scale,
            }

            # Optionally save to disk — uses same Studio output structure
            if do_save:
                try:
                    from datetime import date
                    # Match _get_output_dir pattern: output/studio/upscaled/YYYY-MM-DD/
                    base_outdir = shared.opts.data.get("outdir_samples", "")
                    if not base_outdir:
                        base_outdir = shared.opts.data.get("outdir_img2img_samples", "")
                    if not base_outdir:
                        from modules.paths import data_path
                        base_outdir = os.path.join(data_path, "output")
                    if os.path.basename(base_outdir) in ("txt2img-images", "img2img-images"):
                        base_outdir = os.path.dirname(base_outdir)
                    date_folder = date.today().strftime("%Y-%m-%d")
                    save_dir = os.path.join(base_outdir, "studio", "upscaled", date_folder)
                    os.makedirs(save_dir, exist_ok=True)
                    import time
                    fname = f"upscale_{int(time.time())}_{new_w}x{new_h}.png"
                    save_path = os.path.join(save_dir, fname)
                    upscaled.save(save_path)
                    result["saved_path"] = save_path
                    result["filename"] = fname
                    print(f"{TAG} Upscale saved: {save_path}")
                except Exception as e:
                    print(f"{TAG} Upscale save failed: {e}")

            print(f"{TAG} Upscale complete: {new_w}x{new_h}")
            return result

        except Exception as e:
            import traceback
            traceback.print_exc()
            return JSONResponse({"error": str(e)}, status_code=500)

    # ------------------------------------------------------------------
    # Upscale + Refine — single-call pipeline
    # Replaces the frontend's two-stage dance (POST /studio/upscale then
    # POST /studio/generate). The two-stage approach paid two full
    # process_images() setup cycles, two base64 round-trips, and on lowvram
    # it thrashed model/VAE swaps between stages. Doing everything inside
    # one handler keeps the model hot and the upscaled latent in memory.
    # ------------------------------------------------------------------

    class UpscaleRefineRequest(BaseModel):
        image_b64: str                     # data URL or raw base64

        # Upscale params
        upscaler: str = "R-ESRGAN 4x+"
        scale: float = 2.0

        # Refine (img2img) params — consulted when run_refine is True
        run_refine: bool = False
        prompt: str = ""
        neg_prompt: str = ""
        steps: int = 20
        sampler_name: str = "DPM++ 2M SDE"
        schedule_type: str = "Karras"
        cfg_scale: float = 5.0
        denoising: float = 0.3
        seed: int = -1

        # ADetailer params — consulted when run_ad is True. Independent of
        # run_refine: AD can run standalone on the ESRGAN output.
        run_ad: bool = False
        ad_slots: List[ADSlotParams] = Field(
            default_factory=lambda: [ADSlotParams(), ADSlotParams(), ADSlotParams()]
        )

        # Save params
        save_outputs: bool = True
        save_format: str = "png"
        save_quality: int = 95
        save_lossless: bool = False
        embed_metadata: bool = True

    @app.post("/studio/upscale_and_refine")
    async def studio_upscale_and_refine(req: UpscaleRefineRequest):
        """ESRGAN upscale + optional img2img refine + optional ADetailer,
        all inside a single handler so the model stays hot across stages.

        Four combinations: ESRGAN alone / ESRGAN+img2img / ESRGAN+AD /
        ESRGAN+img2img with AD firing post-refine. See _studio_hires_fix
        for the inspiration — this is the upscale-side sibling.
        """
        import random

        _cancel_auto_unload()

        # Shared imports for the worker thread
        _build_native_ad_dicts = _import("studio_generation", "_build_native_ad_dicts")
        _run_studio_ad = _import("studio_generation", "_run_studio_ad")
        _build_processing_obj = _import("studio_generation", "_build_processing_obj")
        GenParams = _import("studio_generation", "GenParams")
        InpaintParams = _import("studio_generation", "InpaintParams")
        _reset_generation_state = _import("studio_generation", "_reset_generation_state")
        _ensure_model_loaded = _import("studio_generation", "_ensure_model_loaded")
        _get_output_dir = _import("studio_generation", "_get_output_dir")

        def _worker():
            from modules.processing import (
                StableDiffusionProcessingImg2Img, process_images
            )

            # Decode image once at the top — no further base64 round-trips.
            raw = req.image_b64
            if "," in raw:
                raw = raw.split(",", 1)[1]
            try:
                src = Image.open(io.BytesIO(base64.b64decode(raw))).convert("RGB")
            except Exception as e:
                return None, None, -1, f"Invalid image_b64: {e}"

            orig_w, orig_h = src.size

            # ── Stage 1: ESRGAN ──────────────────────────────────────
            upscaled = _studio_upscale_image(src, req.upscaler, req.scale)
            new_w, new_h = upscaled.size
            print(f"{TAG} Upscale+refine: ESRGAN {orig_w}x{orig_h} -> "
                  f"{new_w}x{new_h} with {req.upscaler}")

            # Nothing more to do — return the pure ESRGAN result.
            if not req.run_refine and not req.run_ad:
                return upscaled, None, -1, None

            # Build ADetailer slot dicts once — used by both the refine
            # (native AD injection) and standalone-AD paths.
            ad_slots = list(req.ad_slots) + [ADSlotParams()] * max(0, 3 - len(req.ad_slots))
            ad_raw_slots = [{
                "enable": s.enable, "model": s.model, "confidence": s.confidence,
                "mask_min_ratio": s.mask_min, "mask_max_ratio": s.mask_max,
                "topk_filter": s.topk_filter, "topk": s.topk,
                "mask_x_offset": s.x_offset, "mask_y_offset": s.y_offset,
                "mask_erosion_dilation": s.erosion_dilation, "mask_merge_mode": s.merge_mode,
                "denoise": s.denoise, "mask_blur": s.mask_blur, "inpaint_pad": s.inpaint_pad,
                "inpaint_full_res": s.full_res, "inpaint_fill": s.fill,
                "use_sep_steps": s.sep_steps, "ad_steps": s.steps,
                "use_sep_cfg": s.sep_cfg, "ad_cfg": s.cfg,
                "use_sep_sampler": s.sep_sampler, "ad_sampler": s.sampler,
                "ad_scheduler": s.scheduler,
                "prompt": s.prompt, "neg_prompt": s.neg_prompt,
            } for s in ad_slots[:3]]
            ad_enable_flag, ad_slot_dicts = _build_native_ad_dicts(
                bool(req.run_ad), ad_raw_slots
            )
            # Only truly enabled if at least one slot has a real model
            ad_has_work = ad_enable_flag and any(
                d.get("ad_tab_enable") and d.get("ad_model", "None") != "None"
                for d in ad_slot_dicts
            )

            # Set up progress task + ensure model is loaded.
            id_task = _reset_generation_state()
            _ensure_model_loaded()

            seed = int(req.seed) if req.seed != -1 else random.randint(0, 2**32 - 1)
            infotext = None
            result = upscaled

            try:
                if req.run_refine:
                    # ── Stage 2a: img2img refine at upscaled resolution ──
                    # Build one processing object with the upscaled image
                    # as init. _build_processing_obj wires up the img2img
                    # script runner (wildcards, dynamic prompts, and AD
                    # slot injection). process_images() then runs the full
                    # img2img pass in a single call — VAE encode of the
                    # init image happens internally.
                    gp = GenParams(
                        prompt=req.prompt, neg_prompt=req.neg_prompt,
                        steps=int(req.steps),
                        sampler_name=req.sampler_name or "Euler a",
                        schedule_type=req.schedule_type or "Automatic",
                        cfg_scale=float(req.cfg_scale),
                        denoising=float(req.denoising),
                        width=new_w, height=new_h, seed=seed,
                        batch_count=1, batch_size=1,
                    )
                    ip = InpaintParams()
                    studio_outdir = _get_output_dir("img2img")

                    ad_params_for_p = (ad_enable_flag, ad_slot_dicts) if ad_has_work else None
                    p = _build_processing_obj(
                        upscaled, gp, mask_img=None, has_mask=False,
                        ip=ip, studio_outdir=studio_outdir, batch_seed=seed,
                        cn_units=None, extension_args=None,
                        ad_params=ad_params_for_p,
                    )

                    # Studio runs its own AD post-process; stock AD must bail.
                    if ad_has_work:
                        p._ad_disabled = True

                    shared.state.job_count = 1
                    shared.state.job_no = 0

                    print(f"{TAG} Upscale+refine: img2img pass at {new_w}x{new_h}, "
                          f"steps={gp.steps}, denoise={gp.denoising}, cfg={gp.cfg_scale}, "
                          f"seed={seed}, AD={'on' if ad_has_work else 'off'}")

                    processed = process_images(p)
                    if processed and processed.images:
                        result = processed.images[0]
                        if processed.infotexts:
                            infotext = processed.infotexts[0]
                        elif processed.info:
                            infotext = processed.info

                    # Post-process AD on the refined result.
                    if ad_has_work and not shared.state.interrupted:
                        result = _run_studio_ad(result, p, ad_slot_dicts, mask_img=None)

                elif req.run_ad and ad_has_work:
                    # ── Stage 2b: standalone AD on ESRGAN output ────
                    # No base img2img pass — AD operates directly on the
                    # upscaled image. _run_studio_ad still wants a p-like
                    # carrier for prompt/sampler/seed, so we build a
                    # minimal Img2Img without calling process_images().
                    studio_outdir = _get_output_dir("img2img")
                    p = StableDiffusionProcessingImg2Img(
                        sd_model=shared.sd_model,
                        outpath_samples=studio_outdir, outpath_grids=studio_outdir,
                        prompt=req.prompt, negative_prompt=req.neg_prompt,
                        init_images=[upscaled], resize_mode=0,
                        denoising_strength=float(req.denoising),
                        n_iter=1, batch_size=1,
                        steps=int(req.steps), cfg_scale=float(req.cfg_scale),
                        width=new_w, height=new_h,
                        sampler_name=req.sampler_name or "Euler a",
                        seed=seed, subseed=-1, subseed_strength=0,
                        do_not_save_samples=True, do_not_save_grid=True,
                    )
                    if req.schedule_type and req.schedule_type != "Automatic" and hasattr(p, 'scheduler'):
                        p.scheduler = req.schedule_type
                    # _run_studio_ad reads resolved prompts from these
                    p.all_prompts = [req.prompt]
                    p.all_negative_prompts = [req.neg_prompt]
                    p._ad_disabled = True

                    shared.state.job_count = 1
                    shared.state.job_no = 0

                    print(f"{TAG} Upscale+refine: standalone AD on ESRGAN at {new_w}x{new_h}")
                    result = _run_studio_ad(upscaled, p, ad_slot_dicts, mask_img=None)
            finally:
                try:
                    from modules.progress import finish_task as _ft
                    _ft(id_task)
                except Exception:
                    pass

            return result, infotext, seed, None

        try:
            result, infotext, seed_val, err = await asyncio.to_thread(_worker)
        except Exception as e:
            traceback.print_exc()
            return JSONResponse({"error": str(e)}, status_code=500)

        if err:
            return JSONResponse({"error": err}, status_code=400)
        if result is None:
            return JSONResponse({"error": "Pipeline returned no image"}, status_code=500)

        # Encode the final image once.
        result_w, result_h = result.size

        # ── Save to disk ─────────────────────────────────────────────
        # Use the same Forge-style filename helper as the regular
        # auto-save. For PNG, encode once to buffer and reuse for both
        # disk + response b64 (no double compression).
        filename = None
        saved_path = None
        png_bytes = None
        if req.save_outputs:
            try:
                base_outdir = shared.opts.data.get("outdir_samples", "")
                if not base_outdir:
                    base_outdir = shared.opts.data.get("outdir_img2img_samples", "")
                if not base_outdir:
                    from modules.paths import data_path
                    base_outdir = os.path.join(data_path, "output")
                if os.path.basename(base_outdir) in ("txt2img-images", "img2img-images"):
                    base_outdir = os.path.dirname(base_outdir)
                date_folder = date.today().strftime("%Y-%m-%d")
                output_dir = Path(base_outdir) / "studio" / "upscaled" / date_folder
                output_dir.mkdir(parents=True, exist_ok=True)

                ext_map = {"png": "png", "jpeg": "jpg", "webp": "webp"}
                ext = ext_map.get(req.save_format, "png")
                counter = _next_forge_counter(output_dir)
                seed_for_name = seed_val if seed_val != -1 else 0
                while True:
                    fname = f"Studio-{counter:05d}-{seed_for_name}.{ext}"
                    fpath = output_dir / fname
                    if not fpath.exists():
                        break
                    counter += 1

                save_kwargs = {}
                if req.save_format == "png":
                    if req.embed_metadata and infotext:
                        try:
                            from PIL.PngImagePlugin import PngInfo
                            pnginfo = PngInfo()
                            pnginfo.add_text("parameters", infotext)
                            save_kwargs["pnginfo"] = pnginfo
                        except Exception:
                            pass
                    buf = io.BytesIO()
                    result.save(buf, format="PNG", **save_kwargs)
                    png_bytes = buf.getvalue()
                    with open(str(fpath), "wb") as f:
                        f.write(png_bytes)
                elif req.save_format == "jpeg":
                    save_img = result.convert("RGB") if result.mode != "RGB" else result
                    save_kwargs = {"quality": req.save_quality, "optimize": True}
                    if req.embed_metadata and infotext:
                        exif_bytes = _build_exif_usercomment(infotext)
                        if exif_bytes:
                            save_kwargs["exif"] = exif_bytes
                    save_img.save(str(fpath), "JPEG", **save_kwargs)
                elif req.save_format == "webp":
                    if req.save_lossless:
                        save_kwargs = {"lossless": True}
                    else:
                        save_kwargs = {"quality": req.save_quality}
                    if req.embed_metadata and infotext:
                        exif_bytes = _build_exif_usercomment(infotext)
                        if exif_bytes:
                            save_kwargs["exif"] = exif_bytes
                    result.save(str(fpath), "WEBP", **save_kwargs)

                filename = fname
                saved_path = str(fpath)
                print(f"{TAG} Upscale+refine saved: {saved_path}")

                # Gallery DB metadata write — only when we have real infotext
                if infotext:
                    try:
                        _hash_fn = _import("studio_gallery", "compute_content_hash")
                        _gallery_save = _import("studio_gallery", "save_metadata_by_hash")
                        if _hash_fn and _gallery_save:
                            _ch = _hash_fn(result if req.save_format == "png" else str(fpath))
                            if _ch:
                                _gallery_save(_ch, infotext, {"infotexts": [infotext]})
                    except Exception:
                        pass
            except Exception as e:
                print(f"{TAG} Upscale+refine save failed: {e}")

        if png_bytes is not None:
            result_b64 = "data:image/png;base64," + base64.b64encode(png_bytes).decode()
        else:
            result_b64 = _pil_to_b64(result)

        # Reset auto-unload timer (mirrors /studio/generate behaviour)
        global _last_generation_time
        _last_generation_time = time.time()
        if _auto_unload_enabled:
            _schedule_auto_unload()
        _log_vram("Upscale+refine complete")

        return {
            "ok": True,
            "image": result_b64,
            "width": result_w,
            "height": result_h,
            "filename": filename,
            "saved_path": saved_path,
            "seed": seed_val,
        }

    @app.get("/studio/vaes")
    async def get_vaes():
        """List available VAE files."""
        try:
            from modules import sd_vae
            sd_vae.refresh_vae_list()
            vae_list = [{"name": "Automatic"}, {"name": "None"}]
            for name in sd_vae.vae_dict.keys():
                vae_list.append({"name": name})
            # If vae_dict is empty, try fallback scan
            if len(vae_list) <= 2:
                import glob
                vae_paths = []
                # Check standard VAE directories
                models_dir = getattr(shared, 'models_path', 'models')
                for pattern in [
                    os.path.join(models_dir, "VAE", "*.safetensors"),
                    os.path.join(models_dir, "VAE", "*.pt"),
                    os.path.join(models_dir, "VAE", "*.ckpt"),
                    os.path.join(models_dir, "vae", "*.safetensors"),
                    os.path.join(models_dir, "vae", "*.pt"),
                ]:
                    vae_paths.extend(glob.glob(pattern))
                for p in vae_paths:
                    name = os.path.basename(p)
                    if not any(v["name"] == name for v in vae_list):
                        vae_list.append({"name": name})
                if len(vae_list) > 2:
                    print(f"{TAG} VAE fallback scan found {len(vae_list) - 2} VAEs")
            return vae_list
        except Exception as e:
            print(f"{TAG} VAE list error: {e}")
            return [{"name": "Automatic"}, {"name": "None"}]

    @app.get("/studio/current_vae")
    async def get_current_vae():
        """Return the currently configured VAE."""
        try:
            vae_name = shared.opts.data.get("sd_vae", "Automatic")
            return {"name": vae_name or "Automatic"}
        except Exception:
            return {"name": "Automatic"}

    @app.post("/studio/load_vae")
    async def load_vae(body: dict):
        """Switch VAE. Values: 'Automatic', 'None', or a VAE filename."""
        vae_name = body.get("name", "Automatic")
        try:
            from modules import sd_vae

            # Update the setting and reload if a real model is loaded
            shared.opts.set("sd_vae", vae_name)
            if hasattr(shared.sd_model, 'first_stage_model'):
                vae_file = sd_vae.vae_dict.get(vae_name)
                if vae_file:
                    sd_vae.reload_vae_weights(vae_file)

            # Persist to config.json
            try:
                shared.opts.save(shared.config_filename)
            except Exception:
                pass

            print(f"{TAG} VAE changed to: {vae_name}")
            return {"ok": True, "loaded": vae_name}
        except Exception as e:
            import traceback
            traceback.print_exc()
            return JSONResponse({"error": str(e)}, status_code=500)

    # ------------------------------------------------------------------
    # Text Encoder
    # ------------------------------------------------------------------

    @app.get("/studio/text_encoders")
    async def get_text_encoders():
        """List available text encoder files from models/text_encoder/."""
        try:
            import glob
            models_dir = getattr(shared, 'models_path', 'models')
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
            print(f"{TAG} Text encoder list error: {e}")
            return JSONResponse([])

    @app.get("/studio/check_model_te")
    async def check_model_te(title: str = ""):
        """Check if a checkpoint needs external text encoder and/or VAE.

        Scans the safetensors header for text encoder keys
        (cond_stage_model.* or conditioner.*) and VAE keys
        (first_stage_model.*). If absent, the model needs
        external components (e.g. Anima, Flux).
        GGUF files can't be header-scanned — returns needs_te=True
        as a safe default (user can set to None if not needed).
        """
        if not title:
            return {"needs_te": False, "needs_vae": False, "arch": "unknown"}
        try:
            info = sd_models.get_closet_checkpoint_match(title)
            if not info:
                return {"needs_te": False, "needs_vae": False, "arch": "unknown"}

            filepath = info.filename

            # GGUF: can't scan header, assume external TE+VAE needed
            if filepath.endswith(".gguf"):
                return {"needs_te": True, "needs_vae": True, "arch": "unknown",
                        "note": "GGUF — cannot detect, assuming external TE+VAE"}

            # Safetensors: read header keys only (near-instant, no tensor data)
            from safetensors import safe_open
            with safe_open(filepath, framework="pt", device="cpu") as f:
                keys = set(f.keys())

            has_te = any(
                k.startswith("cond_stage_model.") or k.startswith("conditioner.")
                for k in keys
            )
            has_vae = any(
                k.startswith("first_stage_model.")
                for k in keys
            )

            # Also detect architecture while we have the keys
            arch = "unknown"
            try:
                _detect = _import("studio_workshop", "detect_architecture")
                arch_info = _detect(keys)
                arch = arch_info.get("arch", "unknown")
            except Exception:
                pass

            return {"needs_te": not has_te, "needs_vae": not has_vae, "arch": arch}
        except Exception as e:
            print(f"{TAG} check_model_te error: {e}")
            return {"needs_te": False, "needs_vae": False, "arch": "unknown"}

    def _find_lora_preview(filepath):
        """Find preview image for a LoRA file. Checks common naming conventions."""
        base = os.path.splitext(filepath)[0]
        for ext in ('.preview.png', '.preview.jpg', '.preview.jpeg', '.preview.webp',
                    '.png', '.jpg', '.jpeg', '.webp'):
            candidate = base + ext
            if os.path.isfile(candidate):
                return candidate
        return None

    @app.get("/studio/loras")
    async def get_loras():
        lora_dir = getattr(shared.cmd_opts, 'lora_dir', None)
        extra_dirs = list(getattr(shared.cmd_opts, 'lora_dirs', []))
        if not lora_dir:
            from modules.paths import models_path
            lora_dir = os.path.join(models_path, "Lora")

        loras = []
        all_dirs = [lora_dir] + extra_dirs

        for base_dir in all_dirs:
            if not base_dir or not os.path.isdir(base_dir):
                continue
            for root, dirs, files in os.walk(base_dir):
                dirs.sort()
                for f in sorted(files):
                    if not f.endswith(('.safetensors', '.ckpt', '.pt')):
                        continue
                    full_path = os.path.join(root, f)
                    # Use relative path from base_dir so <lora:subfolder/name:1> works
                    rel = os.path.relpath(full_path, base_dir)
                    name = os.path.splitext(rel.replace(os.sep, "/"))[0]
                    subfolder = os.path.dirname(rel).replace(os.sep, "/")

                    preview_path = _find_lora_preview(full_path)
                    preview_url = f"/file={preview_path}" if preview_path else None

                    # Read user metadata sidecar (.json next to the LoRA file)
                    # Same format Forge Neo's extra networks uses — contains
                    # "activation text" (trigger words) and "preferred weight".
                    activation_text = ""
                    preferred_weight = 0.0
                    meta_path = os.path.splitext(full_path)[0] + ".json"
                    if os.path.isfile(meta_path):
                        try:
                            with open(meta_path, "r", encoding="utf-8") as mf:
                                user_meta = json.load(mf)
                                activation_text = user_meta.get("activation text", "")
                                preferred_weight = float(user_meta.get("preferred weight", 0.0))
                        except Exception:
                            pass

                    try:
                        stat = os.stat(full_path)
                        size = stat.st_size
                        mtime = stat.st_mtime
                    except OSError:
                        size = 0
                        mtime = 0

                    loras.append({
                        "name": name,
                        "path": full_path,
                        "subfolder": subfolder,
                        "size": size,
                        "mtime": mtime,
                        "preview": preview_url,
                        "activation_text": activation_text,
                        "preferred_weight": preferred_weight,
                    })

        return loras

    @app.post("/studio/lora_preview")
    async def save_lora_preview(req: dict):
        """Save a preview image for a LoRA. Expects {name, image_b64}."""
        name = req.get("name", "")
        image_b64 = req.get("image_b64", "")
        if not name or not image_b64:
            return JSONResponse({"ok": False, "error": "Missing name or image_b64"}, status_code=400)

        # Find the LoRA file to determine where to save the preview
        lora_dir = getattr(shared.cmd_opts, 'lora_dir', None)
        extra_dirs = list(getattr(shared.cmd_opts, 'lora_dirs', []))
        if not lora_dir:
            from modules.paths import models_path
            lora_dir = os.path.join(models_path, "Lora")

        target_path = None
        for base_dir in [lora_dir] + extra_dirs:
            if not base_dir or not os.path.isdir(base_dir):
                continue
            for ext in ('.safetensors', '.ckpt', '.pt'):
                candidate = os.path.join(base_dir, name.replace("/", os.sep) + ext)
                if os.path.isfile(candidate):
                    target_path = candidate
                    break
            if target_path:
                break

        if not target_path:
            return JSONResponse({"ok": False, "error": f"LoRA not found: {name}"}, status_code=404)

        try:
            # Strip data URL prefix if present
            b64_data = image_b64
            if "," in b64_data:
                b64_data = b64_data.split(",", 1)[1]

            img_bytes = base64.b64decode(b64_data)
            preview_path = os.path.splitext(target_path)[0] + ".preview.png"

            # Save as PNG (standardized format)
            img = Image.open(io.BytesIO(img_bytes))
            # Resize to reasonable preview size (max 512px)
            max_dim = 512
            if img.width > max_dim or img.height > max_dim:
                img.thumbnail((max_dim, max_dim), Image.LANCZOS)
            img.save(preview_path, format="PNG")

            print(f"{TAG} Saved LoRA preview: {preview_path}")
            return {"ok": True, "path": preview_path}
        except Exception as e:
            import traceback
            traceback.print_exc()
            return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

    @app.delete("/studio/lora_preview")
    async def delete_lora_preview(name: str = ""):
        """Delete a preview image for a LoRA."""
        if not name:
            return JSONResponse({"ok": False, "error": "Missing name"}, status_code=400)

        lora_dir = getattr(shared.cmd_opts, 'lora_dir', None)
        extra_dirs = list(getattr(shared.cmd_opts, 'lora_dirs', []))
        if not lora_dir:
            from modules.paths import models_path
            lora_dir = os.path.join(models_path, "Lora")

        # Find and delete any preview file
        deleted = False
        for base_dir in [lora_dir] + extra_dirs:
            if not base_dir or not os.path.isdir(base_dir):
                continue
            for ext in ('.safetensors', '.ckpt', '.pt'):
                lora_path = os.path.join(base_dir, name.replace("/", os.sep) + ext)
                if not os.path.isfile(lora_path):
                    continue
                base = os.path.splitext(lora_path)[0]
                for pext in ('.preview.png', '.preview.jpg', '.preview.jpeg', '.preview.webp'):
                    preview = base + pext
                    if os.path.isfile(preview):
                        os.remove(preview)
                        print(f"{TAG} Deleted LoRA preview: {preview}")
                        deleted = True

        return {"ok": deleted}

    @app.post("/studio/open_lora_folder")
    async def open_lora_folder():
        """Open the LoRA directory in the OS file manager."""
        import subprocess, platform
        lora_dir = getattr(shared.cmd_opts, 'lora_dir', None)
        if not lora_dir:
            from modules.paths import models_path
            lora_dir = os.path.join(models_path, "Lora")

        if not os.path.isdir(lora_dir):
            return JSONResponse({"ok": False, "error": "LoRA directory not found"}, status_code=404)

        try:
            system = platform.system()
            if system == "Windows":
                os.startfile(lora_dir)
            elif system == "Darwin":
                subprocess.Popen(["open", lora_dir])
            else:
                subprocess.Popen(["xdg-open", lora_dir])
            return {"ok": True, "path": lora_dir}
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

    @app.get("/studio/embeddings")
    async def get_embeddings():
        from modules.paths import models_path
        emb_dir = getattr(shared.cmd_opts, 'embeddings_dir', None)
        if not emb_dir:
            emb_dir = os.path.join(models_path, "..", "embeddings")
        embeddings = []
        if emb_dir and os.path.isdir(emb_dir):
            for f in sorted(os.listdir(emb_dir)):
                if f.endswith(('.safetensors', '.pt', '.bin')):
                    embeddings.append({"name": os.path.splitext(f)[0], "file": f})
        return embeddings

    @app.get("/studio/wildcards")
    async def get_wildcards():
        from modules.paths import script_path
        from pathlib import Path
        webui_root = Path(script_path)
        wildcards = []
        try:
            _get_root = _import("studio_lexicon", "get_wildcards_root")
            candidates = [Path(_get_root())]
        except Exception:
            candidates = [
                webui_root / "extensions" / "sd-dynamic-prompts" / "wildcards",
                webui_root / "extensions-builtin" / "sd-dynamic-prompts" / "wildcards",
                webui_root / "extensions" / "sd-dynamic-prompts-fork" / "wildcards",
                webui_root / "wildcards",
                webui_root / "outputs" / "wildcards",
            ]
        for wc_dir in candidates:
            if wc_dir.is_dir():
                for f in sorted(wc_dir.rglob("*.txt")):
                    rel = f.relative_to(wc_dir)
                    # Convert path separators to forward slashes, strip .txt
                    name = str(rel).replace("\\", "/").replace(".txt", "")
                    wildcards.append({"name": name, "path": str(f)})
                break  # Use first found directory
        return wildcards

    @app.get("/studio/wildcard_content")
    async def get_wildcard_content(name: str = ""):
        """Return the lines of a wildcard file for preview."""
        from modules.paths import script_path
        from pathlib import Path
        if not name:
            return {"lines": [], "count": 0}
        webui_root = Path(script_path)
        try:
            _get_root = _import("studio_lexicon", "get_wildcards_root")
            candidates = [Path(_get_root())]
        except Exception:
            candidates = [
                webui_root / "extensions" / "sd-dynamic-prompts" / "wildcards",
                webui_root / "extensions-builtin" / "sd-dynamic-prompts" / "wildcards",
                webui_root / "extensions" / "sd-dynamic-prompts-fork" / "wildcards",
                webui_root / "wildcards",
                webui_root / "outputs" / "wildcards",
            ]
        for wc_dir in candidates:
            if wc_dir.is_dir():
                target = wc_dir / (name.replace("/", os.sep) + ".txt")
                if target.exists() and target.is_file():
                    try:
                        text = target.read_text(encoding="utf-8", errors="replace")
                        lines = [l.strip() for l in text.splitlines() if l.strip() and not l.strip().startswith("#")]
                        return {"lines": lines[:50], "count": len(lines), "truncated": len(lines) > 50}
                    except Exception:
                        pass
        return {"lines": [], "count": 0}

    @app.get("/studio/cn_models")
    async def get_cn_models():
        try:
            _get = _import("studio_controlnet", "get_cn_models")
            return [{"name": m} for m in _get()]
        except Exception:
            return [{"name": "None"}]

    @app.get("/studio/cn_preprocessors")
    async def get_cn_preprocessors():
        try:
            _get = _import("studio_controlnet", "get_cn_preprocessors")
            return [{"name": p} for p in _get()]
        except Exception:
            return [{"name": "None"}]

    @app.get("/studio/ad_models")
    async def get_ad_models():
        try:
            _get = _import("studio_adetailer", "get_ad_models")
            return [{"name": m} for m in _get()]
        except Exception:
            return [{"name": "None"}]

    @app.post("/studio/load_model")
    async def load_model(body: dict):
        title = body.get("title", "")
        text_encoder = body.get("text_encoder", "")
        vae = body.get("vae", "")
        if not title:
            return JSONResponse({"error": "No model title"}, status_code=400)
        try:
            info = sd_models.get_closet_checkpoint_match(title)
            if not info:
                return JSONResponse({"error": f"Not found: {title}"}, status_code=404)

            # Build additional_modules list for models that need
            # external text encoders and/or VAE (Anima/Cosmos, Flux, etc.)
            additional = []
            models_dir = getattr(shared, 'models_path', 'models')

            if text_encoder and text_encoder not in ("None", "Bundled", ""):
                te_path = os.path.join(models_dir, "text_encoder", text_encoder)
                if os.path.isfile(te_path):
                    additional.append(te_path)
                    print(f"{TAG} Text encoder: {text_encoder}")
                else:
                    print(f"{TAG} Warning: text encoder not found: {te_path}")

            # VAE as additional module (when model needs external VAE)
            if vae and vae not in ("Automatic", "None", ""):
                from modules import sd_vae
                sd_vae.refresh_vae_list()
                vae_path = sd_vae.vae_dict.get(vae)
                if vae_path and os.path.isfile(vae_path):
                    additional.append(vae_path)
                    print(f"{TAG} VAE (additional module): {vae}")

            # Forge Neo uses model_data.forge_loading_parameters to control
            # which model gets loaded. forge_model_reload() checks if the
            # parameters hash changed and only reloads if it did.
            sd_models.model_data.forge_loading_parameters = {
                "checkpoint_info": info,
                "additional_modules": additional,
                "unet_storage_dtype": None,
            }

            # Also update shared.opts so the UI stays in sync
            shared.opts.data["sd_model_checkpoint"] = info.title

            # Persist to config.json so Forge loads this model on next restart
            try:
                shared.opts.save(shared.config_filename)
            except Exception:
                pass  # Non-critical — model loads fine, just won't persist

            # Trigger the actual reload
            await asyncio.to_thread(sd_models.forge_model_reload)

            _log_vram(f"Model loaded: {info.title}"
                      f" ({len(additional)} additional module(s))")
            return {"ok": True, "loaded": info.title}
        except Exception as e:
            import traceback
            traceback.print_exc()
            return JSONResponse({"error": str(e)}, status_code=500)

    @app.post("/studio/refresh_models")
    async def refresh_models():
        sd_models.list_models()
        return {"ok": True, "count": len(sd_models.checkpoints_list)}

    # ------------------------------------------------------------------
    # VRAM Management
    # ------------------------------------------------------------------

    @app.post("/studio/unload_model")
    async def unload_model():
        """Unload the current model from VRAM."""
        _cancel_auto_unload()
        try:
            if not hasattr(shared, 'sd_model') or shared.sd_model is None:
                _log_vram("Already unloaded")
                return {"ok": True, "status": "already_unloaded"}
            await asyncio.to_thread(sd_models.unload_model_weights)
            _log_vram("Model unloaded (manual)")
            return {"ok": True, "status": "unloaded"}
        except Exception as e:
            print(f"{TAG} Unload failed: {e}")
            return JSONResponse({"error": str(e)}, status_code=500)

    @app.get("/studio/model_status")
    async def model_status():
        """Check whether a model is currently loaded in VRAM."""
        loaded = (
            hasattr(shared, 'sd_model')
            and shared.sd_model is not None
            and hasattr(shared.sd_model, 'sd_checkpoint_info')
            and shared.sd_model.sd_checkpoint_info is not None
        )
        title = ""
        if loaded:
            title = getattr(shared.sd_model.sd_checkpoint_info, 'title', '')
        return {
            "loaded": loaded,
            "title": title,
            "auto_unload_enabled": _auto_unload_enabled,
            "auto_unload_minutes": _auto_unload_minutes,
        }

    @app.post("/studio/auto_unload")
    async def set_auto_unload(body: dict):
        """Configure auto-unload settings."""
        global _auto_unload_enabled, _auto_unload_minutes
        if "enabled" in body:
            _auto_unload_enabled = bool(body["enabled"])
        if "minutes" in body:
            _auto_unload_minutes = max(5, min(30, int(body["minutes"])))
        # If enabling, start the timer from now; if disabling, cancel
        if _auto_unload_enabled:
            _schedule_auto_unload()
        else:
            _cancel_auto_unload()
        print(f"{TAG} Auto-unload: {'ON' if _auto_unload_enabled else 'OFF'}, "
              f"{_auto_unload_minutes}min")
        return {
            "ok": True,
            "enabled": _auto_unload_enabled,
            "minutes": _auto_unload_minutes,
        }

    @app.get("/studio/vram")
    async def get_vram():
        """Return GPU VRAM usage from torch.cuda."""
        try:
            import torch
            if not torch.cuda.is_available():
                return {"available": False}
            allocated = torch.cuda.memory_allocated() / (1024 ** 3)  # GB
            reserved = torch.cuda.memory_reserved() / (1024 ** 3)
            total = torch.cuda.get_device_properties(0).total_memory / (1024 ** 3)
            name = torch.cuda.get_device_properties(0).name
            # Read current reserve setting
            current_reserve = 0.0
            total_vram_mb = 0
            try:
                from backend import memory_management as mm
                current_reserve = max(mm.SETTING_RESERVED_VRAM, 0) / (1024 ** 3)
                total_vram_mb = mm.total_vram
            except Exception:
                pass
            return {
                "available": True,
                "allocated_gb": round(allocated, 2),
                "reserved_gb": round(reserved, 2),
                "total_gb": round(total, 2),
                "gpu_name": name,
                "vram_reserve_gb": round(current_reserve, 2),
                "total_vram_mb": round(total_vram_mb, 0),
            }
        except Exception as e:
            return {"available": False, "error": str(e)}

    @app.post("/studio/vram_reserve")
    async def set_vram_reserve(request: Request):
        """Set the VRAM reserve amount (GB kept free for compute).
        Calls Forge's memory_management.set_reserved_memory() which is the
        same function the GPU Weights slider in standard Forge UI uses.
        The slider takes a 0-1 value (% of VRAM for weights); we convert
        from GB reserve to that percentage."""
        try:
            data = await request.json()
            gb = float(data.get("gb", 1.5))
            reset = data.get("reset", False)
            gb = max(0.0, min(8.0, gb))

            try:
                from backend import memory_management as mm
                if reset or gb == 0:
                    # Reset to Forge default — set SETTING_RESERVED_VRAM to -1
                    # so extra_reserved_memory() falls back to EXTRA_RESERVED_VRAM
                    mm.SETTING_RESERVED_VRAM = -1
                    print(f"{TAG} VRAM reserve reset to Forge default "
                          f"(built-in reserve: {mm.EXTRA_RESERVED_VRAM / (1024*1024):.0f} MB)")
                    return {"ok": True, "reserve_gb": 0, "mode": "auto"}
                # Convert GB reserve to the 0-1 scale Forge expects
                val = 1.0 - (gb * 1024.0 / mm.total_vram) if mm.total_vram > 0 else 0.75
                val = max(0.0, min(1.0, val))
                mm.set_reserved_memory(val)
                actual_reserve_mb = mm.SETTING_RESERVED_VRAM / (1024 * 1024)
                print(f"{TAG} VRAM reserve: {gb:.1f} GB requested → "
                      f"set_reserved_memory({val:.3f}) → "
                      f"{actual_reserve_mb:.0f} MB reserved, "
                      f"{mm.total_vram - actual_reserve_mb:.0f} MB for weights")
                return {
                    "ok": True,
                    "reserve_gb": round(actual_reserve_mb / 1024, 2),
                    "weights_pct": round(val * 100, 1),
                    "total_vram_mb": round(mm.total_vram, 0),
                }
            except ImportError:
                return JSONResponse(
                    {"error": "Could not access Forge memory management module"},
                    status_code=500,
                )
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)

    # ------------------------------------------------------------------
    # Image saving
    # ------------------------------------------------------------------

    class SaveImageRequest(BaseModel):
        image_b64: str
        format: str = "png"          # png | jpeg | webp
        quality: int = 95            # for jpeg/webp
        subfolder: str = ""          # optional subfolder under output dir
        filename: Optional[str] = None  # optional custom filename (without ext)
        metadata: Optional[str] = None  # infotext to embed (PNG tEXt, JPEG/WebP EXIF UserComment)

    @app.post("/studio/save_image")
    async def save_image(req: SaveImageRequest):
        try:
            # Decode image
            b64 = req.image_b64
            if "," in b64:
                b64 = b64.split(",", 1)[1]
            img = Image.open(io.BytesIO(base64.b64decode(b64)))

            # Determine output directory — same logic as generation auto-save
            try:
                base_outdir = shared.opts.data.get("outdir_samples", "")
                if not base_outdir:
                    base_outdir = shared.opts.data.get("outdir_img2img_samples", "")
                if not base_outdir:
                    from modules.paths import data_path
                    base_outdir = os.path.join(data_path, "output")
                if os.path.basename(base_outdir) in ("txt2img-images", "img2img-images"):
                    base_outdir = os.path.dirname(base_outdir)
            except Exception:
                base_outdir = os.path.abspath("output")
            output_dir = Path(base_outdir) / "studio"
            if req.subfolder:
                # Sanitize subfolder — no path traversal
                safe_sub = req.subfolder.replace("..", "").replace("\\", "/").strip("/")
                output_dir = output_dir / safe_sub
            output_dir.mkdir(parents=True, exist_ok=True)

            # Filename
            ext_map = {"png": "png", "jpeg": "jpg", "webp": "webp"}
            ext = ext_map.get(req.format, "png")
            name = req.filename or f"studio_{int(time.time())}_{os.getpid()}"
            # Ensure unique
            path = output_dir / f"{name}.{ext}"
            counter = 1
            while path.exists():
                path = output_dir / f"{name}_{counter}.{ext}"
                counter += 1

            # Save with format conversion
            save_kwargs = {}
            if req.format == "jpeg":
                img = img.convert("RGB")  # drop alpha for JPEG
                save_kwargs = {"quality": req.quality, "optimize": True}
                if req.metadata:
                    exif_bytes = _build_exif_usercomment(req.metadata)
                    if exif_bytes:
                        save_kwargs["exif"] = exif_bytes
            elif req.format == "webp":
                save_kwargs = {"quality": req.quality}
                if req.metadata:
                    exif_bytes = _build_exif_usercomment(req.metadata)
                    if exif_bytes:
                        save_kwargs["exif"] = exif_bytes
            elif req.format == "png" and req.metadata:
                # Embed metadata as PNG tEXt chunk
                from PIL.PngImagePlugin import PngInfo
                pnginfo = PngInfo()
                pnginfo.add_text("parameters", req.metadata)
                save_kwargs["pnginfo"] = pnginfo

            img.save(str(path), **save_kwargs)
            print(f"{TAG} Saved {req.format.upper()} → {path}")

            return {"ok": True, "path": str(path), "filename": path.name}

        except Exception as e:
            print(f"{TAG} Save error: {e}")
            traceback.print_exc()
            return JSONResponse({"error": str(e)}, status_code=500)

    # ------------------------------------------------------------------
    # Blueprint Bridge — discovery
    # ------------------------------------------------------------------

    # Resolve extension root (scripts/ may be one level down)
    _here = Path(__file__).parent
    _ext_root = _here if (_here / "frontend").is_dir() else _here.parent

    # Blueprints directory — Studio-bundled layout overrides for extensions
    _bp_dir = _ext_root / "blueprints"

    def _find_blueprint(script):
        """Find a Blueprint Bridge file for an extension script.

        Discovery order:
        1. Extension's own directory: <ext_root>/blueprint.json
        2. Studio's blueprints dir: <studio_root>/blueprints/*.json

        Returns parsed blueprint dict or None.
        """
        title_lower = ""
        try:
            title_lower = script.title().strip().lower()
        except Exception:
            return None

        # 1. Author-provided: next to the script's extension root
        script_path = Path(getattr(script, 'filename', ''))
        if script_path.exists():
            ext_dir = script_path.parent
            # Scripts can be in <ext>/scripts/ or <ext>/ directly
            if ext_dir.name == "scripts":
                ext_dir = ext_dir.parent
            bp_file = ext_dir / "blueprint.json"
            if bp_file.is_file():
                try:
                    with open(bp_file, "r", encoding="utf-8") as f:
                        bp = json.load(f)
                    if bp.get("match", "").strip().lower() == title_lower:
                        print(f"[Studio Bridge] Blueprint (author): {bp.get('title', '?')} for '{title_lower}'")
                        return bp
                except Exception as e:
                    print(f"[Studio Bridge] Failed reading blueprint {bp_file}: {e}")

        # 2. Studio-bundled
        if _bp_dir.is_dir():
            for bp_file in _bp_dir.glob("*.json"):
                try:
                    with open(bp_file, "r", encoding="utf-8") as f:
                        bp = json.load(f)
                    if bp.get("match", "").strip().lower() == title_lower:
                        print(f"[Studio Bridge] Blueprint (bundled): {bp.get('title', '?')} for '{title_lower}'")
                        return bp
                except Exception:
                    continue

        return None

    # Serve blueprint hooks JS files
    if _bp_dir.is_dir():
        app.mount(
            "/studio/blueprints",
            StaticFiles(directory=str(_bp_dir)),
            name="studio-blueprints",
        )

    # ------------------------------------------------------------------
    # Extension Bridge — manifest endpoint
    # ------------------------------------------------------------------

    @app.get("/studio/extensions")
    async def get_extensions():
        """Return JSON manifest of all auto-bridgeable extensions.

        Each entry includes the extension's title, arg index range, and
        a list of controls with their type, label, default value, and
        any type-specific attributes (min/max/step/choices).

        Controls are tagged with group IDs when they were created inside
        layout containers (Column, Group) with conditional visibility.
        The response includes `groups` for DOM structure and `dependencies`
        for all interactive behavior (visibility, value propagation, choices).

        Tier 1 native modules (ControlNet, ADetailer, Soft Inpainting)
        are excluded — Studio handles those directly.
        """
        import modules.scripts as mod_scripts
        _stub = _get_stub_module(); LayoutBlock = _stub.LayoutBlock

        runner = mod_scripts.scripts_img2img
        if not runner or not hasattr(runner, 'inputs') or not runner.inputs:
            return JSONResponse([])

        # Tier 1: Studio handles these natively — don't bridge them
        # Tier 1: Studio replaces these with its own native UI — never bridge them.
        # Everything else graduates to the toggleable extension bridge.
        NATIVE_TITLES = {
            "controlnet",               # Studio ControlNet panel
            "adetailer",                # Studio ADetailer panel
            "soft inpainting",          # Studio Soft Inpaint section
            "dynamic prompts",          # Wildcard resolution — must always run
            "sampler", "seed",          # Forge built-in scripts, not user extensions
            "moritz's ar selector",     # UX-018: Ported natively into Studio AR system
        }

        # Selectable scripts share the inputs array but aren't alwayson —
        # collect their arg ranges so we can exclude overlapping controls
        selectable_ranges = set()
        for script in runner.selectable_scripts:
            if hasattr(script, 'args_from') and script.args_from is not None:
                for i in range(script.args_from, script.args_to):
                    selectable_ranges.add(i)

        extensions = []
        for script in runner.alwayson_scripts:
            try:
                title = script.title().strip() if callable(getattr(script, 'title', None)) else ""
            except Exception:
                title = getattr(script, 'filename', 'unknown')

            if title.lower() in NATIVE_TITLES or any(title.lower().startswith(n) for n in NATIVE_TITLES):
                continue
            if not hasattr(script, 'args_from') or script.args_from is None:
                continue
            if script.args_from == script.args_to:
                continue

            controls = []
            for i in range(script.args_from, script.args_to):
                if i >= len(runner.inputs):
                    break
                if i in selectable_ranges:
                    continue
                comp = runner.inputs[i]
                if comp is None:
                    continue

                ctrl = {
                    "type": _resolve_component_type(comp),
                    "label": getattr(comp, 'label', '') or '',
                    "value": getattr(comp, 'value', None),
                    "index": i,
                    "visible": getattr(comp, 'visible', True),
                }

                # Type-specific attributes
                for attr in ('minimum', 'maximum', 'step', 'choices',
                             'lines', 'placeholder'):
                    v = getattr(comp, attr, None)
                    if v is not None:
                        ctrl[attr] = v

                controls.append(ctrl)

            if not controls:
                continue

            # --- Layout analysis & dependency probing ---
            groups, layout_id_map = _detect_layout_groups(controls, runner)
            layout = _build_layout_tree(controls, runner, layout_id_map)
            dependencies = _probe_dependencies(controls, runner, groups, layout_id_map)

            ext_entry = {
                "name": getattr(script, 'name', title.lower()),
                "title": title,
                "args_from": script.args_from,
                "args_to": script.args_to,
                "controls": controls,
            }
            if groups:
                ext_entry["groups"] = groups
            if layout:
                ext_entry["layout"] = layout
            if dependencies:
                ext_entry["dependencies"] = dependencies

            # --- Blueprint Bridge: check for explicit layout override ---
            bp = _find_blueprint(script)
            if bp:
                ext_entry["blueprint"] = bp
                # Resolve hooks URL if present
                if bp.get("hooks"):
                    ext_entry["blueprint"]["hooks_url"] = f"/studio/blueprints/{bp['hooks']}"

            extensions.append(ext_entry)

        return JSONResponse(extensions)

    # ------------------------------------------------------------------
    # Auto-update: GitHub API (no git required)
    # ------------------------------------------------------------------

    @app.get("/studio/api/check-update")
    async def check_update():
        global _current_version
        _current_version = _read_version()

        # Get latest commit on the branch
        data = _github_get(f"/commits/{_GITHUB_BRANCH}")
        if data is None:
            return JSONResponse({"update_available": False, "offline": True,
                                 "error": "Cannot reach GitHub"})

        remote_sha = data.get("sha", "")
        if not remote_sha:
            return JSONResponse({"error": "Unexpected GitHub API response"})

        # No local version — stamp current remote as baseline (fresh install)
        if not _current_version:
            _write_version(remote_sha)
            _current_version = remote_sha
            return JSONResponse({"update_available": False, "current_commit": remote_sha[:8]})

        if _current_version == remote_sha:
            return JSONResponse({"update_available": False, "current_commit": _current_version[:8]})

        # Get comparison for changelog
        changelog = []
        commits_behind = 0
        compare = _github_get(f"/compare/{_current_version[:12]}...{_GITHUB_BRANCH}")
        if compare:
            commits_behind = compare.get("total_commits", 0)
            for c in compare.get("commits", [])[:20]:
                msg = c.get("commit", {}).get("message", "").split("\n")[0]
                sha = c.get("sha", "")[:8]
                changelog.append(f"{sha} {msg}")

        return JSONResponse({
            "update_available": True,
            "current_commit": _current_version[:8],
            "remote_commit": remote_sha[:8],
            "commits_behind": commits_behind or 1,
            "changelog": changelog,
        })

    @app.post("/studio/api/update")
    async def apply_update():
        zip_url = f"https://github.com/{_GITHUB_OWNER}/{_GITHUB_REPO}/archive/refs/heads/{_GITHUB_BRANCH}.zip"

        try:
            # Download zip to temp file
            req = urllib.request.Request(zip_url, headers={"User-Agent": "ForgeStudio-Updater"})
            with urllib.request.urlopen(req, timeout=120) as resp:
                zip_data = resp.read()
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            return JSONResponse({"ok": False, "error": f"Download failed: {e}"})

        try:
            with tempfile.TemporaryDirectory() as tmp:
                zip_path = Path(tmp) / "update.zip"
                zip_path.write_bytes(zip_data)

                with zipfile.ZipFile(zip_path) as zf:
                    zf.extractall(tmp)

                # GitHub zips have a top-level folder like Forge-Studio-main/
                extracted = [d for d in Path(tmp).iterdir() if d.is_dir() and d.name != "__MACOSX"]
                if len(extracted) != 1:
                    return JSONResponse({"ok": False, "error": "Unexpected zip structure"})

                src = extracted[0]

                # Copy extracted files over the extension directory
                # Skip version.json from source (we write our own)
                for item in src.rglob("*"):
                    rel = item.relative_to(src)
                    dest = _studio_root / rel
                    if item.is_dir():
                        dest.mkdir(parents=True, exist_ok=True)
                    else:
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        # Overwrite existing files
                        shutil.copy2(str(item), str(dest))

        except (zipfile.BadZipFile, OSError) as e:
            return JSONResponse({"ok": False, "error": f"Extract failed: {e}"})

        # Get the commit hash we just installed
        data = _github_get(f"/commits/{_GITHUB_BRANCH}")
        new_sha = data.get("sha", "") if data else ""
        if new_sha:
            _write_version(new_sha)
            global _current_version
            _current_version = new_sha

        print(f"{TAG} Updated to {new_sha[:8]}")
        return JSONResponse({
            "ok": True,
            "restart_required": True,
            "new_commit": new_sha[:8] or "latest",
            "message": "Updated successfully. Restart the server to apply backend changes. Refresh the browser for frontend changes.",
        })

    # ------------------------------------------------------------------
    # Frontend serving
    # ------------------------------------------------------------------

    frontend_dir = _ext_root / "frontend"

    # Serve ag-psd.js from extension's javascript/ dir (avoids duplicating into frontend/)
    _agpsd = _ext_root / "javascript" / "ag-psd.js"
    if not _agpsd.exists():
        _agpsd = _here / "javascript" / "ag-psd.js"  # scripts/javascript/ fallback
    if _agpsd.exists():
        @app.get("/studio/static/ag-psd.js")
        async def serve_agpsd():
            return FileResponse(_agpsd, media_type="application/javascript")

    if frontend_dir.is_dir():
        @app.get("/studio")
        @app.get("/studio/")
        async def studio_index():
            index = frontend_dir / "index.html"
            if index.exists():
                return FileResponse(index, headers={"Cache-Control": "no-cache"})
            return JSONResponse({"error": "Frontend not built yet"}, status_code=404)

        app.mount(
            "/studio/static",
            StaticFiles(directory=str(frontend_dir)),
            name="studio-frontend",
        )

        # Force revalidation on every static file request — browser
        # caches the file but must check ETag before using it. If the
        # file hasn't changed, server returns 304 (free). If it has,
        # browser gets the new version immediately. No stale files.
        # NOTE: add_middleware() fails in Gradio mode because the app
        # is already running. Non-critical — files just use default caching.
        try:
            from starlette.middleware.base import BaseHTTPMiddleware
            from starlette.requests import Request as StarletteRequest

            class StudioCacheControl(BaseHTTPMiddleware):
                async def dispatch(self, request: StarletteRequest, call_next):
                    response = await call_next(request)
                    path = request.url.path
                    if path.startswith("/studio/static"):
                        # Static files: cache with ETag revalidation
                        response.headers["Cache-Control"] = "no-cache"
                    elif path.startswith("/studio/") and not path.startswith("/studio/static"):
                        # API responses: never write to disk cache.
                        # Prevents Firefox/Chrome from accumulating hundreds
                        # of MB of cached base64 image JSON responses.
                        response.headers["Cache-Control"] = "no-store"
                    return response

            app.add_middleware(StudioCacheControl)
        except RuntimeError:
            pass  # app already started (Gradio mode) — skip, non-critical

        print(f"{TAG} Frontend: {frontend_dir}")
    else:
        @app.get("/studio")
        @app.get("/studio/")
        async def studio_placeholder():
            return JSONResponse({
                "status": "Studio API is running",
                "frontend": "Not installed — add files to frontend/ directory",
                "docs": "Visit /docs for full API documentation",
            })
        print(f"{TAG} No frontend dir found (checked {_here / 'frontend'} and {_here.parent / 'frontend'}) — API-only mode")

    # ------------------------------------------------------------------
    # Progress broadcast thread
    # ------------------------------------------------------------------

    Thread(target=_progress_polling_thread, daemon=True).start()

    # ------------------------------------------------------------------
    # Optional module loader — uses file path, not sys.path
    # Works regardless of how Forge is launched (--nowebui or regular)
    # ------------------------------------------------------------------

    def _load_optional_module(name, setup_func_name):
        """Load a sibling .py file by path and return its setup function, or None."""
        import importlib.util as ilu
        script_dir = os.path.dirname(os.path.abspath(__file__))
        path = os.path.join(script_dir, f"{name}.py")
        if not os.path.isfile(path):
            return None
        try:
            spec = ilu.spec_from_file_location(name, path)
            mod = ilu.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return getattr(mod, setup_func_name, None)
        except Exception as e:
            print(f"{TAG} Failed to load {name}: {e}")
            return None

    # ------------------------------------------------------------------
    # Workshop module routes
    # ------------------------------------------------------------------

    setup_workshop_routes = _load_optional_module("studio_workshop", "setup_workshop_routes")
    if setup_workshop_routes:
        setup_workshop_routes(app)
    else:
        print(f"{TAG} Workshop module not found — skipping")

    # ------------------------------------------------------------------
    # Sampler Lab module routes (Workshop sub-module)
    # ------------------------------------------------------------------

    setup_sampler_lab_routes = _load_optional_module("studio_sampler_lab", "setup_sampler_lab_routes")
    if setup_sampler_lab_routes:
        setup_sampler_lab_routes(app)
    else:
        print(f"{TAG} Sampler Lab module not found — skipping")

    # ------------------------------------------------------------------
    # Scheduler Lab module routes (Workshop sub-module, personal tool)
    # ------------------------------------------------------------------

    setup_scheduler_lab_routes = _load_optional_module("studio_scheduler_lab", "setup_scheduler_lab_routes")
    if setup_scheduler_lab_routes:
        setup_scheduler_lab_routes(app)
    else:
        print(f"{TAG} Scheduler Lab module not found — skipping")

    # ------------------------------------------------------------------
    # Lexicon module routes
    # ------------------------------------------------------------------

    setup_lexicon_routes = _load_optional_module("studio_lexicon", "setup_lexicon_routes")
    if setup_lexicon_routes:
        setup_lexicon_routes(app)
    else:
        print(f"{TAG} Lexicon module not found — skipping")

    # PromptScope integration
    setup_promptscope_routes = _load_optional_module("studio_promptscope", "setup_promptscope_routes")
    if setup_promptscope_routes:
        setup_promptscope_routes(app)
    else:
        print(f"{TAG} PromptScope module not found — skipping")

    # ------------------------------------------------------------------
    # Gallery module routes
    # ------------------------------------------------------------------

    setup_gallery_routes = _load_optional_module("studio_gallery", "setup_gallery_routes")
    if setup_gallery_routes:
        setup_gallery_routes(app)
    else:
        print(f"{TAG} Gallery module not found — skipping")

    print(f"{TAG} All routes registered — standalone UI at /studio")


# =========================================================================
# HOOK — called by on_app_started via studio.py
# =========================================================================

def add_studio_api(demo, app):
    """
    Drop-in replacement for the old add_studio_api() in studio_generation.py.

    To integrate, change studio_generation.py bottom section from:

        def add_studio_api(demo, app):
            from starlette.responses import JSONResponse
            @app.get("/studio/task_id")
            async def studio_task_id():
                return JSONResponse({"task_id": get_studio_task_id()})

    To:

        from studio_api import add_studio_api

    The on_app_started registration in studio.py stays exactly the same:
        scripts.script_callbacks.on_app_started(add_studio_api)
    """
    setup_studio_routes(app)

    # Suppress Uvicorn access log noise for /studio routes.
    # Studio prints its own tagged log lines ([Studio API], [Gallery], etc.)
    # which are more informative. The raw HTTP request/response lines
    # alarm users who don't know what 200/304 status codes mean.
    import logging

    class _SuppressStudioAccess(logging.Filter):
        def filter(self, record):
            msg = record.getMessage() if hasattr(record, 'getMessage') else str(record.msg)
            return '/studio' not in msg

    _uvicorn_access = logging.getLogger("uvicorn.access")
    _uvicorn_access.addFilter(_SuppressStudioAccess())

    # Auto-launch browser in --nowebui mode (replaces VBScript delay hack in bat file)
    if getattr(shared.cmd_opts, 'nowebui', False):
        def _wait_and_open():
            import webbrowser, urllib.request
            port = getattr(shared.cmd_opts, 'port', 7860) or 7860
            url = f"http://127.0.0.1:{port}/studio"
            for _ in range(60):  # poll for up to 30 seconds
                try:
                    urllib.request.urlopen(url, timeout=0.5)
                    webbrowser.open(url)
                    print(f"{TAG} Browser opened: {url}")
                    return
                except Exception:
                    time.sleep(0.5)
            print(f"{TAG} Auto-launch timed out — open {url} manually")
        Thread(target=_wait_and_open, daemon=True).start()
