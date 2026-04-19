"""
Forge Studio — Live Painting Engine
by ToxicHost & Moritz

Completion-triggered img2img loop for interactive painting.
Adapted from Krita AI Diffusion's LiveScheduler architecture,
rebuilt for Forge Neo's process_images() pipeline.

Design:
  - LiveScheduler ports Krita's input-diff gating and adaptive grace period
  - Latest-wins queue: one running task, one pending slot
  - Own interrupt flag checked every sampler step (bypasses unreliable shared.state)
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
# INTERRUPT FLAG — own flag, bypasses unreliable shared.state
# =========================================================================

_live_interrupt = threading.Event()


def request_interrupt():
    """Set the interrupt flag. Checked every sampler step."""
    _live_interrupt.set()


def clear_interrupt():
    """Clear the interrupt flag before starting a new generation."""
    _live_interrupt.clear()


def is_interrupted() -> bool:
    return _live_interrupt.is_set()


# =========================================================================
# SAMPLER CALLBACK — injects interrupt check into every sampling step
# =========================================================================

def install_interrupt_callback(p):
    """Install a sampler_cfg_function that checks our interrupt flag every step.

    This runs inside the denoiser loop and can halt sampling faster than
    shared.state.interrupted, which Forge checks infrequently.

    Must be called BEFORE process_images() triggers the model clone.
    """
    from modules import shared

    def _live_cfg_denoiser(params):
        if _live_interrupt.is_set():
            # Signal Forge's own interrupt so process_images() exits cleanly
            shared.state.interrupted = True
        return params.x  # pass-through, don't modify the denoised output

    # sampler_cfg_function is singleton (last write wins) — this is fine
    # for Live because we own the entire generation, no other scripts running
    p.sampler_cfg_function = _live_cfg_denoiser


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
    running, the pending slot is overwritten and the current gen is interrupted."""
    global _pending_spec, _is_active

    if not _is_active:
        return

    with _lock:
        if _current_thread and _current_thread.is_alive():
            # Generation running — store as pending, interrupt current
            _pending_spec = spec
            request_interrupt()
            _broadcast({"type": "live_busy", "pending": True})
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
    clear_interrupt()
    print(f"{TAG} Live painting activated")
    _broadcast({"type": "live_started"})


def deactivate():
    """Deactivate the live painting loop. Interrupts any running generation."""
    global _is_active, _pending_spec
    _is_active = False
    _pending_spec = None
    request_interrupt()
    _scheduler.reset()
    print(f"{TAG} Live painting deactivated")
    _broadcast({"type": "live_stopped"})


def is_active() -> bool:
    return _is_active


def _start_generation(spec: LiveSpec):
    """Start a generation in a background thread."""
    global _current_thread, _pending_spec
    _pending_spec = None
    clear_interrupt()
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
        # Interrupted with no result — tell frontend so it doesn't stall
        print(f"{TAG} Generation interrupted (no result)")
        _broadcast({"type": "live_busy", "pending": _pending_spec is not None})

    if not _is_active:
        return

    # Completion-triggered next iteration (Krita pattern)
    with _lock:
        if _pending_spec:
            next_spec = _pending_spec
            _pending_spec = None
            _broadcast({"type": "live_busy", "pending": False})
            # Always start — the pending spec exists because the user changed
            # something during generation. No reason to delay.
            _start_generation(next_spec)


# =========================================================================
# GENERATION WORKER — minimal img2img via process_images()
# =========================================================================

def _generation_worker(spec: LiveSpec):
    """Run a single live generation frame. Stripped down: no scripts, no AD,
    no hires fix, no disk writes. Just img2img → result."""
    result_b64 = None
    error = None

    try:
        from modules import shared, sd_models
        from modules.processing import (
            StableDiffusionProcessingImg2Img,
            process_images,
        )

        print(f"{TAG} Generation starting: {spec.width}x{spec.height}, "
              f"strength={spec.strength}, steps={spec.steps}, seed={spec.seed}")

        # Ensure model is loaded
        if not hasattr(shared.sd_model, 'forge_objects') or shared.sd_model.forge_objects is None:
            try:
                if hasattr(sd_models, 'forge_model_reload'):
                    sd_models.forge_model_reload()
            except Exception as e:
                error = f"Model not loaded: {e}"
                _on_generation_complete(spec, None, error)
                return

        # Clear stale state
        shared.state.interrupted = False
        shared.state.skipped = False
        shared.state.job_count = 1
        shared.state.job_no = 0
        shared.state.sampling_step = 0
        shared.state.sampling_steps = 0
        shared.state.current_latent = None
        shared.state.current_image = None
        shared.state.time_start = time.time()

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

        # Build minimal img2img processing object
        p = StableDiffusionProcessingImg2Img(
            sd_model=shared.sd_model,
            outpath_samples="",
            outpath_grids="",
            prompt=spec.prompt,
            negative_prompt=spec.negative_prompt,
            init_images=[init_img],
            resize_mode=0,
            denoising_strength=spec.strength,
            n_iter=1,
            batch_size=1,
            steps=spec.steps,
            cfg_scale=spec.cfg_scale,
            width=spec.width,
            height=spec.height,
            sampler_name=spec.sampler_name,
            seed=spec.seed,
            do_not_save_samples=True,
            do_not_save_grid=True,
        )

        # Set scheduler
        if hasattr(p, 'scheduler'):
            p.scheduler = spec.scheduler

        # Attach script runner — required for wildcards/dynamic prompts.
        # Without this, process_images() won't resolve __wildcards__ or
        # {dynamic|prompts}. We attach the full img2img runner with defaults
        # and force-disable AD in the script_args (same as unchecking it).
        # ControlNet with no units = no-op. Everything else is lightweight.
        try:
            import modules.scripts as mod_scripts
            runner = mod_scripts.scripts_img2img
            if runner and hasattr(runner, 'alwayson_scripts'):
                p.scripts = runner
                n_inputs = len(runner.inputs) if hasattr(runner, 'inputs') else 0
                script_args = [None] * n_inputs
                if hasattr(runner, 'inputs') and runner.inputs:
                    for i, comp in enumerate(runner.inputs):
                        if comp is not None and hasattr(comp, 'value'):
                            script_args[i] = comp.value
                if script_args:
                    script_args[0] = 0

                # Force-disable ADetailer in script_args
                for s in runner.alwayson_scripts:
                    try:
                        title = s.title().strip() if callable(getattr(s, 'title', None)) else ""
                    except Exception:
                        title = ""
                    if title == "ADetailer":
                        idx = s.args_from
                        if idx < len(script_args):
                            script_args[idx] = False
                        break

                p.script_args = script_args
                print(f"{TAG} Script runner attached ({len(runner.alwayson_scripts)} alwayson, AD off)")
        except Exception as e:
            print(f"{TAG} Warning: script runner failed ({e}) — wildcards won't resolve")

        # Install our interrupt callback
        install_interrupt_callback(p)

        # Check interrupt before starting (may have been set while we were setting up)
        if is_interrupted():
            _on_generation_complete(spec, None, None)
            return

        # Run generation
        t0 = time.time()
        processed = process_images(p)
        elapsed = time.time() - t0
        print(f"{TAG} Generation completed in {elapsed:.2f}s")

        # Clear our interrupt flag — generation is done either way
        clear_interrupt()

        # Encode result — if process_images produced images, USE THEM,
        # even if the interrupt flag was set. The generation completed;
        # the watchdog or a new submit may have set the flag mid-gen,
        # but the result is still valid.
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
