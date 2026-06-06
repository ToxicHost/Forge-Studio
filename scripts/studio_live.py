"""
Forge Studio — Live Painting Engine
by ToxicHost & Moritz

Completion-triggered img2img loop for interactive painting.
Adapted from Krita AI Diffusion's LiveScheduler architecture,
rebuilt for Forge Neo's process_images() pipeline.

Design:
  - LiveScheduler ports Krita's input-diff gating and adaptive grace period
  - Latest-wins queue: one running task, one pending slot
  - No mid-sampler interruption: a running frame finishes naturally before the
    newest pending frame starts (never installs p.sampler_cfg_function)
  - WebSocket broadcast for results (rides existing /studio/ws)
  - No disk writes, no scripts, no ADetailer — Live is raw img2img only
"""

import asyncio
import base64
import io
import time
import threading
import traceback
from collections import deque
from dataclasses import dataclass
from typing import Optional, Callable, Awaitable

from PIL import Image

TAG = "[Studio Live]"


# =========================================================================
# BROADCAST WIRING
# =========================================================================
# studio_api.py injects these via set_broadcast() during endpoint mounting.
# This avoids circular imports — studio_live never imports studio_api.

_broadcast_fn: Optional[Callable[[dict], Awaitable]] = None
_event_loop: Optional[asyncio.AbstractEventLoop] = None


def set_broadcast(broadcast_fn, event_loop):
    """Called by studio_api.py to wire up WebSocket broadcasting."""
    global _broadcast_fn, _event_loop
    _broadcast_fn = broadcast_fn
    _event_loop = event_loop
    print(f"{TAG} Broadcast wired (fn={broadcast_fn is not None}, loop={event_loop is not None})")


def _broadcast(data: dict):
    """Send a message to all WebSocket clients from any thread."""
    if _broadcast_fn and _event_loop and not _event_loop.is_closed():
        asyncio.run_coroutine_threadsafe(_broadcast_fn(data), _event_loop)
    else:
        print(f"{TAG} Broadcast SKIPPED: fn={'SET' if _broadcast_fn else 'NONE'}, "
              f"loop={'SET' if _event_loop else 'NONE'}, "
              f"closed={_event_loop.is_closed() if _event_loop else 'N/A'}")


# =========================================================================
# LIVE SCHEDULER — ported from Krita AI Diffusion model.py
# =========================================================================
# Krita's LiveScheduler compares full WorkflowInput objects for equality.
# Since we cross an HTTP boundary, we compare a hash of (canvas pixels +
# prompt + settings) instead. The timing logic is a faithful port.

class LiveScheduler:
    """Determines whether a new generation should start based on input changes
    and timing. Adaptive grace period delays regeneration when generation is
    slow (>1.5s avg), preventing queue buildup during rapid painting."""

    default_grace_period = 0.25   # seconds to delay after most recent change
    max_wait_time = 3.0           # max seconds to delay over total editing time
    delay_threshold = 1.5         # use grace period only if avg gen exceeds this

    def __init__(self):
        self._last_input_hash: Optional[str] = None
        self._last_change = 0.0
        self._oldest_change = 0.0
        self._has_changes = True
        self._generation_start_time = 0.0
        self._generation_times: deque[float] = deque(maxlen=10)

    def should_generate(self, input_hash: str) -> bool:
        """Check if inputs changed and enough time has passed to regenerate."""
        now = time.monotonic()
        if self._last_input_hash != input_hash:
            self._last_input_hash = input_hash
            self._last_change = now
            if not self._has_changes:
                self._oldest_change = now
            self._has_changes = True

        time_since_last_change = now - self._last_change
        time_since_oldest_change = now - self._oldest_change
        return self._has_changes and (
            time_since_last_change >= self.grace_period
            or time_since_oldest_change >= self.max_wait_time
        )

    def notify_generation_started(self):
        self._generation_start_time = time.monotonic()
        self._has_changes = False

    def notify_generation_finished(self):
        elapsed = time.monotonic() - self._generation_start_time
        self._generation_times.append(elapsed)

    @property
    def average_generation_time(self) -> float:
        if not self._generation_times:
            return 0.0
        return sum(self._generation_times) / len(self._generation_times)

    @property
    def grace_period(self) -> float:
        if self.average_generation_time > self.delay_threshold:
            return self.default_grace_period
        return 0.0

    def reset(self):
        self._last_input_hash = None
        self._last_change = 0.0
        self._oldest_change = 0.0
        self._has_changes = True
        self._generation_start_time = 0.0
        self._generation_times.clear()


# =========================================================================
# LIVE SPEC — what gets submitted for generation
# =========================================================================

@dataclass
class LiveSpec:
    """Everything needed to run one live generation frame."""
    image_b64: str          # base64 init image (already downscaled by frontend)
    prompt: str
    negative_prompt: str
    seed: int
    strength: float         # default 0.3
    width: int
    height: int
    sampler_name: str       # from preset
    scheduler: str          # from preset
    cfg_scale: float        # from preset
    steps: int              # from preset
    input_hash: str         # hash of (image + prompt + settings) for diff gating

    def settings_hash(self) -> str:
        """Hash that represents this spec's identity for change detection."""
        return self.input_hash


# =========================================================================
# LATEST-WINS QUEUE
# =========================================================================

_lock = threading.Lock()
_current_thread: Optional[threading.Thread] = None
_pending_spec: Optional[LiveSpec] = None
_is_active = False
_scheduler = LiveScheduler()


def submit(spec: LiveSpec):
    """Submit a live generation request. Latest wins — if a generation is
    running, the pending slot is overwritten with the newest spec. The running
    generation is NOT interrupted; it finishes naturally and the pending spec
    starts on completion. This avoids corrupting the sampler mid-step."""
    global _pending_spec, _is_active

    if not _is_active:
        return

    with _lock:
        if _current_thread and _current_thread.is_alive():
            # Generation running — store newest as pending without interrupting.
            # Interrupting via sampler_cfg_function corrupts CFG math (NaN/black
            # output on Anima/Cosmos), so we let the active frame complete.
            _pending_spec = spec
            _broadcast({"type": "live_busy", "pending": True})
            print(f"{TAG} Generation busy — queued latest frame without interrupt")
        else:
            # No generation running — always start immediately.
            # The scheduler rate-limits during active generation (pending slot),
            # but when idle there's no reason to delay.
            _scheduler.should_generate(spec.input_hash)  # update tracking state
            _start_generation(spec)


def activate():
    """Activate the live painting loop."""
    global _is_active
    _is_active = True
    _scheduler.reset()
    print(f"{TAG} Live painting activated")
    _broadcast({"type": "live_started"})


def deactivate():
    """Deactivate the live painting loop. Clears the pending slot so no new
    frame is scheduled. A generation already in flight finishes on its own and
    won't reschedule (because _is_active is False) — we never interrupt the
    sampler, which keeps Anima/Cosmos sampling stable."""
    global _is_active, _pending_spec
    _is_active = False
    _pending_spec = None
    _scheduler.reset()
    print(f"{TAG} Live painting deactivated")
    _broadcast({"type": "live_stopped"})


def is_active() -> bool:
    return _is_active


def _start_generation(spec: LiveSpec):
    """Start a generation in a background thread."""
    global _current_thread, _pending_spec
    _pending_spec = None
    _scheduler.notify_generation_started()

    _current_thread = threading.Thread(
        target=_generation_worker,
        args=(spec,),
        daemon=True,
        name="studio-live-gen",
    )
    _current_thread.start()


def _on_generation_complete(spec: LiveSpec, result_b64: Optional[str], error: Optional[str]):
    """Called when a generation finishes. Handles the completion-triggered
    next-iteration pattern — if pending spec exists, start it immediately."""
    global _pending_spec

    _scheduler.notify_generation_finished()

    if error:
        print(f"{TAG} Generation error: {error}")
        _broadcast({"type": "live_error", "message": error})
    elif result_b64:
        _broadcast({
            "type": "live_result",
            "image": result_b64,
            "seed": spec.seed,
        })
    else:
        # Completed but produced no image — tell frontend so it doesn't stall
        print(f"{TAG} Generation produced no result")
        _broadcast({"type": "live_busy", "pending": _pending_spec is not None})

    if not _is_active:
        return

    # Completion-triggered next iteration (Krita pattern)
    with _lock:
        if _pending_spec:
            next_spec = _pending_spec
            _pending_spec = None
            _broadcast({"type": "live_busy", "pending": False})
            # The pending spec exists because input changed during generation.
            # Start it now that the sampler has finished cleanly.
            print(f"{TAG} Starting queued latest frame")
            _start_generation(next_spec)


# =========================================================================
# GENERATION WORKER — minimal img2img via process_images()
# =========================================================================

def _generation_worker(spec: LiveSpec):
    """Run a single live generation frame. Uses the standard Studio
    generation builder (_build_processing_obj) so Anima/WAN/flow-matching
    models get the same parameter setup as regular img2img."""
    result_b64 = None
    error = None

    try:
        from modules import shared
        from modules.processing import process_images

        # Import the standard generation infrastructure
        try:
            from studio_generation import (
                GenParams, InpaintParams, _build_processing_obj,
                _reset_generation_state, _ensure_model_loaded,
            )
        except ImportError:
            from scripts.studio_generation import (
                GenParams, InpaintParams, _build_processing_obj,
                _reset_generation_state, _ensure_model_loaded,
            )

        print(f"{TAG} Generation starting: {spec.width}x{spec.height}, "
              f"strength={spec.strength}, steps={spec.steps}, seed={spec.seed}")

        # Use the same preflight as regular generation
        _reset_generation_state()
        _ensure_model_loaded()

        # Decode init image
        image_data = spec.image_b64
        if "," in image_data:
            image_data = image_data.split(",", 1)[1]
        init_img = Image.open(io.BytesIO(base64.b64decode(image_data)))
        if init_img.mode == "RGBA":
            bg = Image.new("RGB", init_img.size, (255, 255, 255))
            bg.paste(init_img, mask=init_img.split()[3])
            init_img = bg
        elif init_img.mode != "RGB":
            init_img = init_img.convert("RGB")

        # Build processing object through the standard path — same as
        # regular Create-mode img2img. This ensures built-in script arg
        # patching, parameter re-assertion, and proper model state setup
        # that flow-matching models (Anima/Cosmos) require.
        gp = GenParams(
            prompt=spec.prompt,
            neg_prompt=spec.negative_prompt,
            steps=spec.steps,
            sampler_name=spec.sampler_name,
            schedule_type=spec.scheduler,
            cfg_scale=spec.cfg_scale,
            denoising=spec.strength,
            width=spec.width,
            height=spec.height,
            seed=spec.seed,
        )

        p = _build_processing_obj(
            canvas_img=init_img,
            gp=gp,
            mask_img=None,
            has_mask=False,
            ip=InpaintParams(),
            studio_outdir="",
            batch_seed=spec.seed,
        )

        # Live overrides: no disk writes
        p.do_not_save_samples = True
        p.do_not_save_grid = True

        # Run generation
        t0 = time.time()
        processed = process_images(p)
        elapsed = time.time() - t0
        print(f"{TAG} Generation completed in {elapsed:.2f}s")

        # ── Lightweight NaN check (remove once confirmed fixed) ──
        import torch as _torch
        if hasattr(p, 'latents_after_sampling') and p.latents_after_sampling:
            _lat = p.latents_after_sampling[0]
            _nan = _torch.isnan(_lat).sum().item()
            if _nan:
                print(f"{TAG} DIAG samples_ddim: BAD nan={_nan}/{_lat.numel()}")
            else:
                print(f"{TAG} DIAG samples_ddim: FINITE {_lat.numel()} elements")
        # ─────────────────────────────────────────────────────────

        # Encode result — if process_images produced images, use them.
        if processed and processed.images:
            result_img = processed.images[0]
            buf = io.BytesIO()
            result_img.save(buf, format="PNG")
            result_b64 = f"data:image/png;base64,{base64.b64encode(buf.getvalue()).decode()}"
            print(f"{TAG} Result encoded: {len(result_b64)} chars")
        else:
            print(f"{TAG} WARNING: process_images returned no images")

        # Broadcast result
        print(f"{TAG} Broadcasting result (broadcast_fn={'SET' if _broadcast_fn else 'NONE'}, "
              f"event_loop={'SET' if _event_loop else 'NONE'})")
        _on_generation_complete(spec, result_b64, None)

    except Exception as e:
        error = str(e)
        print(f"{TAG} Generation worker error: {e}")
        traceback.print_exc()
        _on_generation_complete(spec, None, error)


# =========================================================================
# ENDPOINT HANDLERS — called from studio_api.py
# =========================================================================

def handle_submit(data: dict) -> dict:
    """Handle POST /studio/live/submit. Returns immediately."""
    if not _is_active:
        return {"error": "Live painting not active"}

    try:
        spec = LiveSpec(
            image_b64=data.get("image", ""),
            prompt=data.get("prompt", ""),
            negative_prompt=data.get("negative_prompt", ""),
            seed=int(data.get("seed", -1)),
            strength=float(data.get("strength", 0.3)),
            width=int(data.get("width", 512)),
            height=int(data.get("height", 512)),
            sampler_name=data.get("sampler_name", "Euler"),
            scheduler=data.get("scheduler", "sgm_uniform"),
            cfg_scale=float(data.get("cfg_scale", 3.5)),
            steps=int(data.get("steps", 8)),
            input_hash=data.get("input_hash", ""),
        )
    except (ValueError, TypeError) as e:
        return {"error": f"Invalid parameters: {e}"}

    submit(spec)
    return {"status": "submitted"}


def handle_stop() -> dict:
    """Handle POST /studio/live/stop."""
    deactivate()
    return {"status": "stopped"}


def handle_start() -> dict:
    """Handle POST /studio/live/start."""
    activate()
    return {"status": "started"}


def get_status() -> dict:
    """Handle GET /studio/live/status."""
    return {
        "active": _is_active,
        "generating": _current_thread is not None and _current_thread.is_alive(),
        "pending": _pending_spec is not None,
        "avg_gen_time": round(_scheduler.average_generation_time, 3),
        "grace_period": round(_scheduler.grace_period, 3),
    }
