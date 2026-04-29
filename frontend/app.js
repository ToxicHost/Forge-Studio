/**
 * Forge Studio — Standalone Frontend
 * by ToxicHost & Moritz
 *
 * Application shell: API communication, WebSocket progress,
 * UI state management, panel/tab interactions.
 *
 * The canvas engine (painting, layers, compositing) will be ported
 * from studio.js in a subsequent phase. This file is the shell it
 * plugs into.
 */

"use strict";

// ═══════════════════════════════════════════
// API CLIENT
// ═══════════════════════════════════════════

const API = {
  base: window.location.origin,

  async get(path) {
    const r = await fetch(this.base + path);
    if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
    return r.json();
  },

  async post(path, body) {
    const r = await fetch(this.base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`POST ${path}: ${r.status}`);
    return r.json();
  },

  // Resource endpoints
  models:          () => API.get("/studio/models"),
  samplers:        () => API.get("/studio/samplers"),
  schedulers:      () => API.get("/studio/schedulers"),
  upscalers:       () => API.get("/studio/upscalers"),
  loras:           () => API.get("/studio/loras"),
  cnModels:        () => API.get("/studio/cn_models"),
  cnPreprocessors: () => API.get("/studio/cn_preprocessors"),
  adModels:        () => API.get("/studio/ad_models"),

  // Actions
  generate:      (params) => API.post("/studio/generate", params),
  interrupt:     ()       => API.post("/studio/interrupt", {}),
  skip:          ()       => API.post("/studio/skip", {}),
  loadModel:     (title)  => API.post("/studio/load_model", { title }),
  refreshModels: ()       => API.post("/studio/refresh_models", {}),
  saveImage:     (params) => API.post("/studio/save_image", params),
  unloadModel:   ()       => API.post("/studio/unload_model", {}),
  modelStatus:   ()       => API.get("/studio/model_status"),
  autoUnload:    (params) => API.post("/studio/auto_unload", params),
  vram:          ()       => API.get("/studio/vram"),

  // Auto-update
  checkUpdate:   ()       => API.get("/studio/api/check-update"),
  applyUpdate:   ()       => API.post("/studio/api/update", {}),

  // Live Painting
  liveStart:     ()       => API.post("/studio/live/start", {}),
  liveStop:      ()       => API.post("/studio/live/stop", {}),
  liveSubmit:    (params) => API.post("/studio/live/submit", params),
  liveStatus:    ()       => API.get("/studio/live/status"),
};


// ═══════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════

function _escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
}

// NaN-safe numeric read: `parseFloat("0") || fallback` treats 0 as missing because 0 is falsy.
function _num(id, fallback) {
  const v = parseFloat(document.getElementById(id)?.value);
  return isNaN(v) ? fallback : v;
}

/**
 * Apply parsed A1111 infotext parameters to UI fields.
 * Best-effort: sets whatever fields match, skips the rest.
 */
function _applyInfotextToUI(infotext) {
  if (!window.PngMetadata) return;
  const p = PngMetadata.parseInfotext(infotext);
  if (!p || !p.prompt) return;

  const _set = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
  const _sel = (id, val) => {
    const el = document.getElementById(id);
    if (!el || val == null) return;
    // Try exact match first, then case-insensitive
    const opts = [...el.options];
    const exact = opts.find(o => o.value === val || o.textContent === val);
    if (exact) { el.value = exact.value; return; }
    const ci = opts.find(o => o.value.toLowerCase() === val.toLowerCase() || o.textContent.toLowerCase() === val.toLowerCase());
    if (ci) el.value = ci.value;
  };

  _set("paramPrompt", p.prompt);
  _set("paramNeg", p.negativePrompt);
  _set("paramSteps", p.steps);
  _set("paramCFG", p.cfgScale);
  _set("paramWidth", p.width);
  _set("paramHeight", p.height);
  if (p.seed > 0) _set("paramSeed", p.seed);
  if (p.clipSkip) _set("paramClipSkip", p.clipSkip);

  _sel("paramSampler", p.sampler);
  _sel("paramScheduler", p.scheduleType);

  // Hires params
  if (p.hiresUpscaler) {
    _sel("paramUpscaler", p.hiresUpscaler);
    _set("paramHiresSteps", p.hiresSteps);
    _set("paramDenoise", p.denoisingStrength);
    _set("paramHiresScale", p.hiresUpscale);
  }

  console.log("[Studio] Applied infotext params:", Object.keys(p).join(", "));
}


// ═══════════════════════════════════════════
// WEBSOCKET PROGRESS
// ═══════════════════════════════════════════

const Progress = {
  ws: null,
  listeners: [],

  connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(`${proto}//${location.host}/studio/ws`);

    this.ws.onopen = () => {
      console.log("[Studio] WebSocket connected");
      StatusBar.setStatus("ready");
    };

    this.ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "progress") {
          this._lastWsMsg = Date.now();
          this.listeners.forEach(fn => fn(data));
        } else if (data.type === "model_unloaded") {
          StatusBar.setModelUnloaded();
          showToast(`Model auto-unloaded after ${data.minutes}min idle`, "info");
          _refreshVRAM();
        } else if (data.type === "live_result") {
          console.log("[Live] Result received, image length:", data.image?.length);
          if (window.Live) Live._onResult(data);
        } else if (data.type === "live_started") {
          console.log("[Live] WS: started");
          if (window.Live) Live._onStarted();
        } else if (data.type === "live_stopped") {
          console.log("[Live] WS: stopped");
          if (window.Live) Live._onStopped();
        } else if (data.type === "live_busy") {
          console.log("[Live] WS: busy, pending:", data.pending);
          if (window.Live) Live._onBusy(data.pending);
        } else if (data.type === "live_error") {
          console.error("[Live] WS: error:", data.message);
          if (window.Live) Live._onError(data.message);
        }
      } catch (err) {
        if (e.data && !e.data.startsWith?.("{")) return; // binary frame, ignore
        console.error("[Studio] WebSocket message error:", err, e.data?.slice?.(0, 200));
      }
    };

    this.ws.onclose = () => {
      console.log("[Studio] WebSocket closed, reconnecting in 3s...");
      StatusBar.setStatus("error");
      setTimeout(() => this.connect(), 3000);
    };

    this.ws.onerror = () => {
      this.ws.close();
    };
  },

  onProgress(fn) { this.listeners.push(fn); },

  // HTTP fallback — poll /sdapi/v1/progress when WS is not delivering
  _pollTimer: null,
  _lastWsMsg: 0,

  startPolling() {
    this._pollTimer = setInterval(async () => {
      // Only poll if WS hasn't delivered in 2s and we're generating
      if (Date.now() - this._lastWsMsg < 2000) return;
      if (!window.State?.generating) return;
      try {
        const r = await fetch(`${window.location.origin}/sdapi/v1/progress?skip_current_image=true`);
        const data = await r.json();
        if (data.state) {
          this.listeners.forEach(fn => fn({
            type: "progress",
            progress: data.progress || 0,
            step: data.state.sampling_step || 0,
            total_steps: data.state.sampling_steps || 0,
            job: data.state.job_no || 0,
            job_count: data.state.job_count || 0,
            preview: data.current_image ? ("data:image/png;base64," + data.current_image) : null,
            textinfo: data.textinfo || "",
          }));
        }
      } catch (_) {}
    }, 1500);
  },

  stopPolling() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  },

  ping() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send("ping");
    }
  },
};


// ═══════════════════════════════════════════
// APP STATE
// ═══════════════════════════════════════════

const State = {
  // Generation
  generating: false,
  _pendingModelSwitch: null, // checkpoint title queued while generating
  _pendingVAESwitch: null,   // VAE name queued while generating
  lastResult: null,        // last GenerateResponse
  lastSeed: -1,            // last resolved seed (for recycle button)
  outputImages: [],        // array of image URLs (file URLs or data URLs)
  outputImagesB64: [],     // array of base64 data URLs (for canvas operations)
  outputInfotexts: [],     // array of infotext strings, parallel to outputImages
  outputFilenames: [],     // array of original filenames (without ext), parallel to outputImages
  outputContentHashes: [], // SHA256 of decoded RGB pixels, parallel to outputImages; "" when not saved
  selectedOutputIdx: 0,
  embedMetadata: true,     // whether to embed generation params in saved images
  saveOutputs: true,       // auto-save generated images to disk
  saveFormat: "png",       // output format: png | jpeg | webp
  saveQuality: 80,         // JPEG/WebP quality (0-100)
  saveLossless: false,     // WebP lossless mode
  livePreview: true,       // show preview thumbnail during generation
  baseGenW: 768,           // pre-hires base dimensions (restored after display)
  baseGenH: 768,
  _deferPreviewHide: false, // hide preview on tab-return if gen finished while hidden

  // Canvas
  mode: "Create",          // Create | Edit | img2img
  width: 768,
  height: 768,

  // Will be populated from API
  models: [],
  samplers: [],
  schedulers: [],
  upscalers: [],

  // Action history
  history: [],
  historyIdx: -1,
};


// ═══════════════════════════════════════════
// LIVE PAINTING
// ═══════════════════════════════════════════
// Completion-triggered img2img loop adapted from Krita AI Diffusion.
// Frontend responsibilities: change detection, debounce, seed management,
// preview layer updates. Backend (studio_live.py) handles queue and generation.

const Live = {
  // State
  active: false,
  generating: false,
  pending: false,
  seed: -1,
  strength: 0.3,
  lastHash: "",
  _canvasDebounce: null,
  _promptDebounce: null,
  _watchdog: null,
  _watchdogTimeout: 15000, // initial conservative timeout before first gen completes
  _avgGenTime: 0,          // rolling average of generation times
  _lastGenStart: 0,        // timestamp of last submit

  // --- Controls ---

  async toggle() {
    if (this.active) {
      await this.stop();
    } else {
      await this.start();
    }
  },

  async start() {
    try {
      console.log("[Live] Starting...");
      await API.liveStart();
      // Seed: generate one if not set
      if (this.seed < 0) this.seed = Math.floor(Math.random() * 2147483647);
      this.active = true;
      this.lastHash = "";
      this._disableAD();
      this._updateUI();
      console.log("[Live] Active, seed:", this.seed);
      // Trigger an initial submit with current canvas state
      this._scheduleCanvasCheck(0);
    } catch (e) {
      console.error("[Live] Start failed:", e);
      showToast("Live painting failed to start", "error");
    }
  },

  async stop() {
    try {
      await API.liveStop();
    } catch (e) {
      console.error("[Live] Stop failed:", e);
    }
    this.active = false;
    this.generating = false;
    this.pending = false;
    this._clearTimers();
    this._restoreAD();
    this._hidePreviewLayer();
    this._updateUI();
  },

  rerollSeed() {
    this.seed = Math.floor(Math.random() * 2147483647);
    this._updateSeedDisplay();
    if (this.active) this._submitNow();
  },

  // --- Canvas change detection ---

  onCanvasChanged() {
    // Called from canvas-core.js on pointerup
    if (!this.active) return;
    this._scheduleCanvasCheck(300); // 300ms debounce
  },

  onPromptChanged() {
    // Called from prompt input events
    if (!this.active) return;
    clearTimeout(this._promptDebounce);
    this._promptDebounce = setTimeout(() => this._submitIfChanged(), 500);
  },

  onSettingsChanged() {
    // Called when strength or other Live settings change
    if (!this.active) return;
    this._submitIfChanged();
  },

  _scheduleCanvasCheck(delay) {
    clearTimeout(this._canvasDebounce);
    this._canvasDebounce = setTimeout(() => this._submitIfChanged(), delay);
  },

  _clearTimers() {
    clearTimeout(this._canvasDebounce);
    clearTimeout(this._promptDebounce);
    clearTimeout(this._watchdog);
    this._canvasDebounce = null;
    this._promptDebounce = null;
    this._watchdog = null;
  },

  _startWatchdog() {
    clearTimeout(this._watchdog);
    this._lastGenStart = Date.now();
    // Adaptive timeout: 2x the average gen time, minimum 10s, max 30s
    const timeout = this._avgGenTime > 0
      ? Math.min(30000, Math.max(10000, this._avgGenTime * 2))
      : this._watchdogTimeout;
    this._watchdog = setTimeout(() => {
      if (!this.active || !this.generating) return;
      console.warn("[Live] Watchdog: no result after", (timeout / 1000).toFixed(1), "s — re-submitting");
      this.generating = false;
      this.lastHash = ""; // Force re-submit
      this._submitIfChanged();
    }, timeout);
  },

  // --- Submission ---

  _submitIfChanged() {
    if (!this.active) return;
    const spec = this._buildSpec();
    if (!spec) { console.warn("[Live] _buildSpec returned null"); return; }
    if (spec.input_hash === this.lastHash) return; // Nothing changed
    this.lastHash = spec.input_hash;
    this.generating = true;
    State._resultPreviewActive = false; // Allow progress previews for this generation
    this._updateUI();
    console.log("[Live] Submitting, hash:", spec.input_hash, "image size:", spec.image?.length);
    this._startWatchdog();
    API.liveSubmit(spec).catch(e => console.error("[Live] Submit error:", e));
  },

  _submitNow() {
    // Force submit regardless of hash (used by reroll)
    if (!this.active) return;
    const spec = this._buildSpec();
    if (!spec) return;
    this.lastHash = spec.input_hash + "_force_" + Date.now(); // Ensure different hash
    this.generating = true;
    this._updateUI();
    this._startWatchdog();
    API.liveSubmit(spec).catch(e => console.error("[Live] Submit error:", e));
  },

  _buildSpec() {
    // Composite visible canvas layers and build the submission spec
    if (!window.StudioCore) return null;

    const w = parseInt(document.getElementById("paramWidth")?.value) || 512;
    const h = parseInt(document.getElementById("paramHeight")?.value) || 512;
    const prompt = document.getElementById("paramPrompt")?.value || "";
    const negPrompt = document.getElementById("paramNeg")?.value || "";

    // Composite canvas to an offscreen canvas at generation resolution
    const imageB64 = StudioCore.compositeForLive(w, h);
    if (!imageB64) return null;

    // Build input hash: FNV-1a of (image + prompt + settings)
    const hashInput = imageB64.slice(-200) + "|" + prompt + "|" + negPrompt
      + "|" + this.seed + "|" + this.strength + "|" + w + "|" + h;
    const inputHash = this._fnv1a(hashInput);

    return {
      image: imageB64,
      prompt,
      negative_prompt: negPrompt,
      seed: this.seed,
      strength: this.strength,
      width: w,
      height: h,
      // Read from existing Canvas generation params
      sampler_name: document.getElementById("paramSampler")?.value || "Euler",
      scheduler: document.getElementById("paramScheduler")?.value || "Automatic",
      cfg_scale: _num("paramCFG", 7.0),
      steps: parseInt(document.getElementById("paramSteps")?.value) || 20,
      input_hash: inputHash,
    };
  },

  // --- FNV-1a hash (fast, non-crypto) ---

  _fnv1a(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(36);
  },

  // --- WebSocket event handlers ---

  _onResult(data) {
    this.generating = false;
    clearTimeout(this._watchdog);

    // Track generation time for adaptive watchdog
    if (this._lastGenStart > 0) {
      const elapsed = Date.now() - this._lastGenStart;
      this._avgGenTime = this._avgGenTime > 0
        ? this._avgGenTime * 0.7 + elapsed * 0.3  // exponential moving average
        : elapsed;
      console.log("[Live] Result received in", (elapsed / 1000).toFixed(1), "s (avg:", (this._avgGenTime / 1000).toFixed(1), "s), image length:", data.image?.length);
    } else {
      console.log("[Live] Result received, image length:", data.image?.length);
    }

    // Store result for Apply
    this._lastResult = data.image;

    // Show in viewport preview — direct DOM, bypass State preview machinery
    const wrap = document.getElementById("canvasPreviewWrap");
    const img = document.getElementById("canvasPreview");
    const closeBtn = document.getElementById("canvasPreviewClose");
    const label = document.getElementById("canvasPreviewLabel");
    if (img && wrap) {
      img.src = data.image;
      wrap.style.display = "";
      if (closeBtn) closeBtn.style.display = "";
      if (label) label.textContent = "Live";
      // Prevent progress handler and _hidePreview from stomping this
      State._resultPreviewActive = true;
      State._previewShown = true;
    }

    // Also populate output gallery so Result → Canvas works. Live preview
    // isn't saved (no hash, no DB row) and we don't have its infotext yet,
    // so all the parallel arrays get reset to length 1 with empties.
    State.outputImages = [data.image];
    State.outputImagesB64 = [data.image];
    State.outputContentHashes = [""];
    State.outputInfotexts = [""];
    State.outputFilenames = [""];
    State.selectedOutputIdx = 0;
    const outputSection = document.getElementById("outputSection");
    if (outputSection) outputSection.style.display = "";
    const outputGrid = document.getElementById("outputGrid");
    if (outputGrid) {
      outputGrid.innerHTML = `<div class="output-thumb selected" data-idx="0"><img src="${data.image}"></div>`;
    }

    this._updateUI();

    // Completion-triggered next iteration (Krita pattern):
    // If canvas changed during generation, submit again immediately
    if (this.active) {
      this._scheduleCanvasCheck(0);
    }
  },

  _onStarted() {
    this.active = true;
    this._updateUI();
  },

  _onStopped() {
    this.active = false;
    this.generating = false;
    this.pending = false;
    this._hidePreviewLayer();
    this._updateUI();
  },

  _onBusy(isPending) {
    this.generating = true;
    this.pending = isPending;
    this._updateUI();
  },

  _onError(message) {
    this.generating = false;
    clearTimeout(this._watchdog);
    console.error("[Live] Error:", message);
    showToast(`Live: ${message}`, "error");
    this._updateUI();
  },

  // --- ADetailer management ---

  _adWasEnabled: false,

  _disableAD() {
    const check = document.getElementById("checkAD");
    const warning = document.getElementById("adLiveWarning");
    if (check) {
      this._adWasEnabled = check.classList.contains("checked");
      check.classList.remove("checked");
      check.style.pointerEvents = "none";
      check.style.opacity = "0.4";
    }
    if (warning) warning.style.display = "";
  },

  _restoreAD() {
    const check = document.getElementById("checkAD");
    const warning = document.getElementById("adLiveWarning");
    if (check) {
      if (this._adWasEnabled) check.classList.add("checked");
      check.style.pointerEvents = "";
      check.style.opacity = "";
    }
    if (warning) warning.style.display = "none";
  },

  // --- Preview ---
  // Live results display in the existing viewport preview pane,
  // not as a canvas layer. These are kept as no-ops for safety.
  _lastResult: null,

  _hidePreviewLayer() {
    // Hide the viewport preview overlay
    const wrap = document.getElementById("canvasPreviewWrap");
    if (wrap) wrap.style.display = "none";
    State._resultPreviewActive = false;
    State._previewShown = false;
  },

  // --- Apply (commit preview to layer) ---

  apply() {
    if (!this._lastResult) { showToast("No Live result to apply", "info"); return; }
    console.log("[Live] Applying result to canvas");
    displayOnCanvas(this._lastResult, { newLayer: true, layerName: "[Live]", undoLabel: "Live apply" });
    // Re-roll seed after apply
    this.rerollSeed();
  },

  // --- UI ---

  _updateUI() {
    const btn = document.getElementById("liveToggleBtn");
    if (btn) {
      btn.classList.toggle("active", this.active);
      if (!this.active) {
        btn.textContent = "▶ Live";
        btn.title = "Start Live Painting";
      } else if (this.generating) {
        btn.textContent = "◉ Live";
        btn.title = "Generating...";
      } else {
        btn.textContent = "■ Live";
        btn.title = "Stop Live Painting";
      }
    }
    const applyBtn = document.getElementById("liveApplyBtn");
    if (applyBtn) applyBtn.disabled = !this.active;

    this._updateSeedDisplay();
  },

  _updateSeedDisplay() {
    const el = document.getElementById("liveSeed");
    if (el) el.textContent = this.seed >= 0 ? this.seed : "—";
  },
};

// Expose globally for WebSocket handler and canvas-core
window.Live = Live;


// ═══════════════════════════════════════════
// STATUS BAR
// ═══════════════════════════════════════════

const StatusBar = {
  setStatus(status) {
    const dot = document.getElementById("statusDot");
    const text = document.getElementById("statusText");
    if (!dot || !text) return;
    dot.className = "status-dot";
    switch (status) {
      case "ready":
        dot.classList.add("status-ready");
        text.textContent = "Ready";
        break;
      case "generating":
        dot.classList.add("status-generating");
        text.textContent = "Generating...";
        break;
      case "error":
        dot.classList.add("status-error");
        text.textContent = "Disconnected";
        break;
    }
  },

  setModel(name) {
    const el = document.getElementById("statusModel");
    if (el) {
      el.textContent = name || "No model";
      el.classList.remove("model-unloaded");
    }
  },

  setModelUnloaded() {
    const el = document.getElementById("statusModel");
    if (el) {
      el.textContent = "Model unloaded";
      el.classList.add("model-unloaded");
    }
  },

  setVRAM(allocated, total) {
    const el = document.getElementById("statusVRAM");
    if (!el) return;
    if (allocated == null || total == null) { el.textContent = ""; return; }
    el.textContent = `VRAM ${allocated.toFixed(1)} / ${total.toFixed(1)} GB`;
    // Color coding: green < 60%, amber 60-85%, red > 85%
    const pct = allocated / total;
    el.classList.remove("vram-low", "vram-mid", "vram-high");
    if (pct > 0.85) el.classList.add("vram-high");
    else if (pct > 0.6) el.classList.add("vram-mid");
    else el.classList.add("vram-low");
  },

  setDimensions(w, h) {
    const el = document.getElementById("statusDims");
    if (el) el.textContent = `${w} × ${h}`;
  },
};


// ═══════════════════════════════════════════
// TOAST NOTIFICATIONS
// ═══════════════════════════════════════════

function showToast(msg, type = "info") {
  // Remove any existing toasts
  document.querySelectorAll(".toast").forEach(t => t.remove());
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}


// ═══════════════════════════════════════════
// AUTO-UPDATE NOTIFICATION
// ═══════════════════════════════════════════

const UpdateBanner = {
  _el: null,
  _data: null,

  show(data) {
    this._data = data;
    if (this._el) this._el.remove();

    const el = document.createElement("div");
    el.className = "update-banner";
    el.innerHTML = `
      <span class="update-banner-text">
        Update available \u2014 ${data.commits_behind} new commit${data.commits_behind > 1 ? "s" : ""}
      </span>
      <button class="update-banner-btn update-details-btn">Details</button>
      <button class="update-banner-btn update-apply-btn">Update Now</button>
      <button class="update-banner-dismiss" title="Dismiss">&times;</button>
    `;

    el.querySelector(".update-details-btn").onclick = () => this._showDetails();
    el.querySelector(".update-apply-btn").onclick = () => this._applyUpdate();
    el.querySelector(".update-banner-dismiss").onclick = () => this.hide();

    document.body.appendChild(el);
    this._el = el;

    // Also light up status bar indicator
    const ind = document.getElementById("statusUpdate");
    if (ind) { ind.style.display = ""; ind.onclick = () => this._showDetails(); }
  },

  hide() {
    if (this._el) { this._el.remove(); this._el = null; }
  },

  async _showDetails() {
    // Fetch fresh data if we don't have changelog
    let data = this._data;
    if (!data || !data.changelog) {
      try {
        data = await API.checkUpdate();
        if (data.error) { showToast(data.error, "error"); return; }
        if (!data.update_available) { showToast("Already up to date", "success"); this.hide(); return; }
        this._data = data;
      } catch (e) { showToast("Update check failed: " + e.message, "error"); return; }
    }

    // Build overlay
    const overlay = document.createElement("div");
    overlay.className = "update-overlay";
    overlay.innerHTML = `
      <div class="update-overlay-content">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
          <strong style="color:var(--text-1);font-size:13px;">Update Available</strong>
          <button class="update-banner-dismiss" title="Close">&times;</button>
        </div>
        <div style="font-size:11px;color:var(--text-3);margin-bottom:8px;">
          ${data.current_commit} &rarr; ${data.remote_commit} &mdash; ${data.commits_behind} commit${data.commits_behind > 1 ? "s" : ""} behind
        </div>
        <div style="font-size:11px;color:var(--text-4);margin-bottom:4px;">Changelog:</div>
        <div style="max-height:200px;overflow-y:auto;font-family:var(--mono);font-size:10px;color:var(--text-3);background:var(--bg-inset);border-radius:var(--radius);padding:8px;">
          ${(data.changelog || []).map(l => `<div style="padding:1px 0;">${_escapeHtml(l)}</div>`).join("") || "<em>No changelog available</em>"}
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end;">
          <button class="update-banner-btn update-close-btn">Close</button>
          <button class="update-banner-btn update-confirm-btn">Update Now</button>
        </div>
      </div>
    `;

    overlay.querySelector(".update-banner-dismiss").onclick = () => overlay.remove();
    overlay.querySelector(".update-close-btn").onclick = () => overlay.remove();
    overlay.querySelector(".update-confirm-btn").onclick = () => { overlay.remove(); this._applyUpdate(); };
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

    document.body.appendChild(overlay);
  },

  async _applyUpdate() {
    showToast("Updating...", "info");
    try {
      const res = await API.applyUpdate();
      if (!res.ok) {
        showToast(res.error || "Update failed", "error");
        return;
      }
      // Replace banner with restart notice
      this.hide();
      const banner = document.createElement("div");
      banner.className = "update-banner update-restart-banner";
      banner.innerHTML = `
        <span class="update-banner-text">
          Updated to ${res.new_commit}. Restart the server to apply backend changes. Refresh browser for frontend changes.
        </span>
        <button class="update-banner-dismiss" title="Dismiss">&times;</button>
      `;
      banner.querySelector(".update-banner-dismiss").onclick = () => banner.remove();
      document.body.appendChild(banner);
      this._el = banner;
    } catch (e) {
      showToast("Update failed: " + e.message, "error");
    }
  },

  async check() {
    try {
      const data = await API.checkUpdate();
      if (data.error && !data.offline) { showToast(data.error, "error"); return; }
      if (data.update_available) {
        this.show(data);
      }
    } catch (_) { /* silently ignore network errors */ }
  },

  async manualCheck() {
    try {
      const data = await API.checkUpdate();
      if (data.error) { showToast(data.offline ? "Offline \u2014 cannot check for updates" : data.error, "error"); return; }
      if (data.update_available) {
        this.show(data);
      } else {
        showToast("Forge Studio is up to date", "success");
      }
    } catch (e) { showToast("Update check failed: " + e.message, "error"); }
  },
};


// ═══════════════════════════════════════════
// POPULATE DROPDOWNS FROM API
// ═══════════════════════════════════════════

async function populateDropdowns() {
  try {
    const [models, samplers, schedulers, upscalers] = await Promise.all([
      API.models(),
      API.samplers(),
      API.schedulers(),
      API.upscalers().catch(() => []),
    ]);

    State.models = models;
    State.samplers = samplers;
    State.schedulers = schedulers;
    State.upscalers = upscalers;

    // Preserve current selection across rebuild if the value still exists.
    const restoreSelection = (el, prev) => {
      if (prev && [...el.options].some(o => o.value === prev)) {
        el.value = prev;
      }
    };

    // Model selector in settings
    const modelSelect = document.getElementById("paramModel");
    if (modelSelect) {
      const prev = modelSelect.value;
      modelSelect.innerHTML = models.map(m =>
        `<option value="${m.title}">${m.title}</option>`
      ).join("");
      restoreSelection(modelSelect, prev);
      // attach is idempotent — second call returns existing handle.
      window.StudioSearchableSelect?.attach(modelSelect, {
        placeholder: "— Select model —",
        searchPlaceholder: "Filter models…",
      });
    }

    // Sampler dropdown
    const samplerSelect = document.getElementById("paramSampler");
    if (samplerSelect) {
      const prev = samplerSelect.value;
      samplerSelect.innerHTML = samplers.map(s =>
        `<option value="${s.name}" ${s.name === "DPM++ 2M SDE" ? "selected" : ""}>${s.name}</option>`
      ).join("");
      restoreSelection(samplerSelect, prev);
      window.StudioSearchableSelect?.attach(samplerSelect, {
        placeholder: "— Select sampler —",
        searchPlaceholder: "Filter samplers…",
      });
    }

    // Scheduler dropdown
    const schedSelect = document.getElementById("paramScheduler");
    if (schedSelect) {
      const prev = schedSelect.value;
      schedSelect.innerHTML = schedulers.map(s =>
        `<option value="${s.label}" ${s.label === "Karras" ? "selected" : ""}>${s.label}</option>`
      ).join("");
      restoreSelection(schedSelect, prev);
    }

    // Hires Fix upscaler dropdown
    const hrUpscaler = document.getElementById("paramHrUpscaler");
    if (hrUpscaler && upscalers.length) {
      const prev = hrUpscaler.value;
      hrUpscaler.innerHTML =
        '<option value="Latent">Latent</option>' +
        upscalers.map(u =>
          `<option value="${u.name}">${u.name}</option>`
        ).join("");
      restoreSelection(hrUpscaler, prev);
    }

    // Standalone upscale dropdown (no Latent option — always real upscaler)
    const upscaleModel = document.getElementById("paramUpscaleModel");
    if (upscaleModel && upscalers.length) {
      const prev = upscaleModel.value;
      upscaleModel.innerHTML = upscalers.map(u =>
        `<option value="${u.name}" ${u.name === "R-ESRGAN 4x+" ? "selected" : ""}>${u.name}</option>`
      ).join("");
      restoreSelection(upscaleModel, prev);
    }

    // Hires Fix checkpoint dropdown
    const hrCheckpoint = document.getElementById("paramHrCheckpoint");
    if (hrCheckpoint) {
      const prev = hrCheckpoint.value;
      hrCheckpoint.innerHTML =
        '<option value="Same">Same</option>' +
        models.map(m =>
          `<option value="${m.title}">${m.title}</option>`
        ).join("");
      restoreSelection(hrCheckpoint, prev);
    }

    // Status bar — fetch actual loaded model
    try {
      const current = await fetch(API.base + "/studio/current_model").then(r => r.json());
      const currentTitle = current.title || "";
      if (currentTitle) {
        StatusBar.setModel(currentTitle.split("[")[0].trim());
        if (modelSelect) modelSelect.value = currentTitle;
      } else if (models.length) {
        StatusBar.setModel(models[0].title.split("[")[0].trim());
      }
    } catch (_) {
      // Fallback to sdapi options
      try {
        const opts = await fetch(API.base + "/sdapi/v1/options").then(r => r.json());
        const currentTitle = opts.sd_model_checkpoint || "";
        if (currentTitle) {
          StatusBar.setModel(currentTitle.split("[")[0].trim());
          if (modelSelect) modelSelect.value = currentTitle;
        }
      } catch (__) {
        if (models.length) StatusBar.setModel(models[0].title.split("[")[0].trim());
      }
    }

    console.log(`[Studio] Loaded ${models.length} models, ${samplers.length} samplers, ${upscalers.length} upscalers`);

    // Check if currently loaded model needs external text encoder (async, non-blocking)
    const currentModel = document.getElementById("paramModel")?.value;
    if (currentModel) {
      fetch(API.base + "/studio/check_model_te?title=" + encodeURIComponent(currentModel))
        .then(r => r.json()).then(teCheck => {
          const teRow = document.getElementById("textEncoderRow");
          const teSelect = document.getElementById("paramTextEncoder");
          if (teCheck.needs_te) {
            if (teRow) teRow.style.display = "";
            // Restore per-model TE memory
            const teMemory = JSON.parse(localStorage.getItem("studio_te_memory") || "{}");
            if (teMemory[currentModel] && teSelect) {
              if ([...teSelect.options].some(o => o.value === teMemory[currentModel])) {
                teSelect.value = teMemory[currentModel];
              }
            }
          } else {
            if (teRow) teRow.style.display = "none";
          }
        }).catch(() => {});
    }

    // VAE dropdown (async, non-blocking)
    fetch(API.base + "/studio/vaes").then(r => r.json()).then(vaes => {
      const vaeSelect = document.getElementById("paramVAE");
      if (vaeSelect) {
        vaeSelect.innerHTML = vaes.map(v =>
          `<option value="${v.name}">${v.name}</option>`
        ).join("");
        // Set current VAE
        fetch(API.base + "/studio/current_vae").then(r => r.json()).then(current => {
          if (current.name && vaeSelect) vaeSelect.value = current.name;
        }).catch(() => {});
      }
    }).catch(() => {});

    // Text Encoder dropdown (async, non-blocking)
    fetch(API.base + "/studio/text_encoders").then(r => r.json()).then(teList => {
      const teSelect = document.getElementById("paramTextEncoder");
      if (teSelect) {
        teSelect.innerHTML = '<option value="None">None (bundled)</option>' +
          teList.map(name =>
            `<option value="${name}">${name}</option>`
          ).join("");
      }
      // Cache the list so model-change handler can check if any TEs exist
      State._textEncoderList = teList;
    }).catch(() => { State._textEncoderList = []; });

    // ADetailer model dropdowns (async, non-blocking)
    API.adModels().then(adModels => {
      [1, 2, 3].forEach(n => {
        const sel = document.getElementById(`paramAD${n}Model`);
        if (sel) {
          // Restore session-saved value (stashed in data-pending-value by _applyDefaults)
          const savedVal = sel.dataset.pendingValue || sel.value;
          sel.innerHTML = adModels.map(m =>
            `<option value="${m.name}">${m.name}</option>`
          ).join("");
          // Restore saved value if it exists in the new options, otherwise
          // default slot 1 to face_yolo (slots 2/3 stay at first option)
          if (savedVal && [...sel.options].some(o => o.value === savedVal)) {
            sel.value = savedVal;
          } else if (n === 1) {
            const faceOpt = [...sel.options].find(o => o.value.includes("face_yolo"));
            if (faceOpt) sel.value = faceOpt.value;
          }
        }
      });
    }).catch(() => {});

    // ControlNet model + preprocessor dropdowns (async, non-blocking)
    Promise.all([
      API.cnModels().catch(() => [{ name: "None" }]),
      API.cnPreprocessors().catch(() => [{ name: "None" }]),
    ]).then(([cnModels, cnProcs]) => {
      [1, 2].forEach(n => {
        const modelSel = document.getElementById(`paramCN${n}Model`);
        if (modelSel) {
          modelSel.innerHTML = cnModels.map(m =>
            `<option value="${m.name}">${m.name}</option>`
          ).join("");
          window.StudioSearchableSelect?.attach(modelSel, {
            placeholder: "— Select ControlNet model —",
            searchPlaceholder: "Filter models…",
          });
        }
        const procSel = document.getElementById(`paramCN${n}Module`);
        if (procSel) {
          procSel.innerHTML = cnProcs.map(p =>
            `<option value="${p.name}">${p.name}</option>`
          ).join("");
          window.StudioSearchableSelect?.attach(procSel, {
            placeholder: "— Select preprocessor —",
            searchPlaceholder: "Filter preprocessors…",
          });
        }
      });
    }).catch(() => {});
  } catch (e) {
    console.error("[Studio] Failed to load resources:", e);
    showToast("Failed to connect to Forge backend", "error");
  }
}


// ═══════════════════════════════════════════
// GENERATION
// ═══════════════════════════════════════════

async function doGenerate() {
  if (State.generating) return;
  State.generating = true;

  // B-002 fix: Re-read live preview toggle state on each gen start to prevent
  // stale State.livePreview from permanently suppressing the preview.
  // Also reset the deferred-hide flag so previous gen's cleanup doesn't interfere.
  State.livePreview = document.getElementById("toggleLivePreview")?.classList.contains("on") ?? true;
  State._deferPreviewHide = false;
  State._previewShown = false;       // reset sticky preview flag
  State._resultPreviewActive = false; // dismiss result preview for new gen
  State._peakProgress = 0;           // reset progress high-water mark
  State._lastTotalSteps = 0;         // reset pass detection
  State._lastProgressTime = 0;       // reset gap detection
  State._previewSuppressLogged = false; // reset diagnostic flag

  // Capture base dimensions before generation — hires fix output is larger,
  // but paramWidth/Height must stay at the original base size for the next gen
  State.baseGenW = parseInt(document.getElementById("paramWidth")?.value) || 768;
  State.baseGenH = parseInt(document.getElementById("paramHeight")?.value) || 768;

  const btn = document.getElementById("genBtn");
  const fill = document.getElementById("progressFill");
  if (btn) { btn.textContent = "Generating..."; btn.classList.add("generating"); }
  if (fill) fill.style.width = "0%";
  StatusBar.setStatus("generating");
  Progress.startPolling();

  // Generation timer
  State._genStartTime = Date.now();
  State._genTimerInterval = setInterval(() => {
    const elapsed = ((Date.now() - State._genStartTime) / 1000).toFixed(1);
    // During inter-pass gaps (no progress for >2s), show elapsed time
    // instead of stale step counts from the previous pass
    if (State._lastProgressTime && Date.now() - State._lastProgressTime > 2000) {
      if (btn) btn.textContent = `Generating... ${elapsed}s`;
    } else if (!State._lastProgressTime) {
      // No progress received yet — show elapsed time
      if (btn) btn.textContent = `Generating... ${elapsed}s`;
    }
  }, 200);

  // Collect params from UI
  const w = parseInt(document.getElementById("paramWidth")?.value) || 768;
  const h = parseInt(document.getElementById("paramHeight")?.value) || 768;

  // Get canvas data from the engine if available
  let canvasB64 = "";
  let maskB64 = "";
  let regionsJson = "";
  let isTxt2img = false;
  if (window.StudioCore) {
    const eng = window.StudioCore;
    console.log("[Studio] Engine found. S.W=%d S.H=%d, layers=%d, gen dims=%dx%d",
      eng.state.W, eng.state.H, eng.state.layers.length, w, h);
    if (eng.state.W !== w || eng.state.H !== h) {
      eng.resizeCanvas(w, h);
    }
    canvasB64 = eng.exportCanvas();
    maskB64 = (eng.state._userMaskMode) ? eng.exportMask() : "";
    regionsJson = eng.serializeRegions();
    // txt2img routing: if the composited canvas is all white, route to txt2img.
    // Otherwise img2img. Simple — the pixels are the source of truth.
    const isBlank = eng.isCanvasBlank();
    if (isBlank) {
      isTxt2img = true;
      console.log("[Studio] Blank canvas — routing to txt2img");
    } else {
      console.log("[Studio] Canvas has content — img2img");
    }
    console.log("[Studio] exportCanvas length=%d, mask=%s, regions=%s, txt2img=%s",
      canvasB64?.length || 0, maskB64?.substring(0, 30) || "null", regionsJson || "empty", isTxt2img);
  } else {
    console.log("[Studio] No engine — using blank white canvas");
    const tmp = document.createElement("canvas");
    tmp.width = w; tmp.height = h;
    const ctx = tmp.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    canvasB64 = tmp.toDataURL("image/png");
    isTxt2img = true;
  }

  const params = {
    canvas_b64: canvasB64,
    mask_b64: maskB64,
    fg_b64: "null",
    mode: (window.StudioCore?.state?.editingMask || window.StudioCore?.state?._userMaskMode || maskB64) ? "Edit" : "Create",
    inpaint_mode: "Inpaint",

    prompt:        document.getElementById("paramPrompt")?.value || "",
    neg_prompt:    document.getElementById("paramNeg")?.value || "",
    steps:         parseInt(document.getElementById("paramSteps")?.value) || 30,
    sampler_name:  document.getElementById("paramSampler")?.value || "DPM++ 2M SDE",
    schedule_type: document.getElementById("paramScheduler")?.value || "Karras",
    cfg_scale:     _num("paramCFG", 5.0),
    denoising:     _num("paramDenoise", 0.81),
    width:         parseInt(document.getElementById("paramWidth")?.value) || 768,
    height:        parseInt(document.getElementById("paramHeight")?.value) || 768,
    seed:          parseInt(document.getElementById("paramSeed")?.value) || -1,
    batch_count:   parseInt(document.getElementById("paramBatch")?.value) || 1,
    batch_size:    parseInt(document.getElementById("paramBatchSize")?.value) || 1,

    // Variation seed
    subseed:              document.getElementById("checkExtra")?.checked ? parseInt(document.getElementById("paramVarSeed")?.value) || -1 : -1,
    subseed_strength:     document.getElementById("checkExtra")?.checked ? _num("paramVarStrengthVal", 0) : 0,
    seed_resize_from_w:   document.getElementById("checkExtra")?.checked ? parseInt(document.getElementById("paramResizeSeedW")?.value) || 0 : 0,
    seed_resize_from_h:   document.getElementById("checkExtra")?.checked ? parseInt(document.getElementById("paramResizeSeedH")?.value) || 0 : 0,

    // Inpaint
    mask_blur:     parseInt(document.getElementById("paramMaskBlur")?.value) || 4,
    inpainting_fill: parseInt(document.getElementById("paramFill")?.value ?? "1"),
    inpaint_full_res: parseInt(document.getElementById("paramInpaintArea")?.value ?? "0"),
    inpaint_pad:   parseInt(document.getElementById("paramPadding")?.value) || 64,

    // Soft Inpainting
    soft_inpaint_enabled: document.getElementById("checkSoftInpaint")?.classList.contains("checked") || false,
    soft_inpaint_schedule_bias:       _num("paramSoftBias", 1.0),
    soft_inpaint_preservation:        _num("paramSoftPreserve", 0.5),
    soft_inpaint_transition_contrast: _num("paramSoftContrast", 4.0),
    soft_inpaint_mask_influence:      _num("paramSoftMaskInf", 0.0),
    soft_inpaint_diff_threshold:      _num("paramSoftDiffThresh", 0.5),
    soft_inpaint_diff_contrast:       _num("paramSoftDiffContrast", 2.0),

    // Hires Fix
    hr_enable:     document.getElementById("checkHires")?.classList.contains("checked") || false,
    hr_upscaler:   document.getElementById("paramHrUpscaler")?.value || "Latent",
    hr_scale:      _num("paramHrScale", 2.0),
    hr_steps:      parseInt(document.getElementById("paramHrSteps")?.value) || 0,
    hr_denoise:    _num("paramHrDenoise", 0.3),
    hr_cfg:        _num("paramHrCFG", 0),
    hr_checkpoint: document.getElementById("paramHrCheckpoint")?.value || "Same",

    // ADetailer
    ad_enable:     document.getElementById("checkAD")?.classList.contains("checked") || false,
    ad_slots:      [1, 2, 3].map(n => ({
      enable:     document.getElementById(`checkAD${n}`)?.classList.contains("checked") || false,
      model:      document.getElementById(`paramAD${n}Model`)?.value || "None",
      confidence: _num(`paramAD${n}Conf`, 0.3),
      denoise:    _num(`paramAD${n}Denoise`, 0.4),
      mask_blur:  parseInt(document.getElementById(`paramAD${n}Blur`)?.value) || 4,
      prompt:     document.getElementById(`paramAD${n}Prompt`)?.value || "",
      neg_prompt: "",
    })),

    // Regional / ControlNet
    regions_json:  regionsJson,
    cn_json:       buildCNJson(),
    cn1_upload_b64: window._cnUploadData?.[1] || null,
    cn2_upload_b64: window._cnUploadData?.[2] || null,

    // Settings
    save_outputs: State.saveOutputs,
    save_format: State.saveFormat || "png",
    save_quality: State.saveQuality || 80,
    save_lossless: State.saveLossless || false,
    embed_metadata: State.embedMetadata ?? true,
    is_txt2img: isTxt2img,

    // Extension bridge args
    extension_args: ExtensionBridge.collectArgs(),
    // UX-015: Tell backend which extensions are disabled so it can suppress their scripts
    disabled_extensions: [...ExtensionBridge._disabled],

    // UX-018: AR Randomizer
    ...(window.getARConfig?.() || {}),
  };

  // Update status bar
  StatusBar.setDimensions(params.width, params.height);

  try {
    const result = await API.generate(params);
    State.lastResult = result;

    if (result.error) {
      showToast(result.error, "error");
    } else if (result.images && result.images.length) {
      // FR-009: Prepend new results to gallery history (max 8 images)
      const MAX_GALLERY = 8;
      let newFileUrls;
      if (result.image_paths && result.image_paths.length === result.images.length) {
        newFileUrls = result.image_paths.map(p => `${API.base}/file=${p}`);
      } else {
        newFileUrls = result.images;
      }
      const newB64 = result.images;
      const newInfotexts = result.infotexts || [];
      const newContentHashes = result.content_hashes || [];
      // Extract original filenames (without extension) from server paths
      const newFilenames = (result.image_paths || []).map(p => {
        const base = p.replace(/\\/g, "/").split("/").pop() || "";
        return base.replace(/\.[^.]+$/, ""); // strip extension
      });
      // Pad to match image count
      while (newFilenames.length < newB64.length) newFilenames.push("");
      // Pad infotexts to match image count
      while (newInfotexts.length < newB64.length) newInfotexts.push("");
      while (newContentHashes.length < newB64.length) newContentHashes.push("");

      State.outputImages = [...newFileUrls, ...State.outputImages].slice(0, MAX_GALLERY);
      State.outputImagesB64 = [...newB64, ...State.outputImagesB64].slice(0, MAX_GALLERY);
      State.outputInfotexts = [...newInfotexts, ...State.outputInfotexts].slice(0, MAX_GALLERY);
      State.outputFilenames = [...newFilenames, ...State.outputFilenames].slice(0, MAX_GALLERY);
      State.outputContentHashes = [...newContentHashes, ...State.outputContentHashes].slice(0, MAX_GALLERY);
      State.selectedOutputIdx = 0;
      renderOutputGallery();
      addHistoryEntry(`Generate (seed ${result.seed})`);
      const _genElapsed = ((Date.now() - State._genStartTime) / 1000).toFixed(1);
      showToast(`Generated ${result.images.length} image${result.images.length > 1 ? "s" : ""} in ${_genElapsed}s`, "success");
      _notifyTab(`Done — ${_genElapsed}s`);

      // Show result in viewport preview (replaces live preview)
      _showResultPreview(0);

      // Store last result on engine state for Send to Lab etc (use data URL version)
      if (window.StudioCore) window.StudioCore.state.lastResult = (State.outputImagesB64 || State.outputImages)[0];

      // Store resolved seed for recycle button (don't auto-fill — default is random)
      if (result.seed > 0) {
        State.lastSeed = result.seed;
      }

      // UX-013: If model was unloaded, generation reloaded it — refresh status bar
      const statusModel = document.getElementById("statusModel");
      if (statusModel?.classList.contains("model-unloaded")) {
        API.modelStatus().then(s => {
          if (s.loaded && s.title) StatusBar.setModel(s.title.split("[")[0].trim());
        }).catch(() => {});
      }
    } else {
      showToast("No images generated", "error");
    }
  } catch (e) {
    console.error("[Studio] Generation failed:", e);
    showToast("Generation failed: " + e.message, "error");
  }

  State.generating = false;
  clearInterval(State._genTimerInterval);
  Progress.stopPolling();
  if (btn) { btn.innerHTML = '<span class="gen-shine"></span>Generate'; btn.classList.remove("generating"); }
  if (fill) fill.style.width = "0%";
  StatusBar.setStatus("ready");

  // Apply any model/VAE switch the user queued while this generation was
  // running. forge_model_reload() destroys shared.sd_model, which would
  // corrupt Forge's weakref tracking if it fired during process_images();
  // we defer the switch to here where the pipeline is idle. Model first,
  // then VAE — the VAE handler resolves against the currently loaded
  // checkpoint, so the model needs to settle first.
  if (State._pendingModelSwitch) {
    const title = State._pendingModelSwitch;
    State._pendingModelSwitch = null;
    const modelSelect = document.getElementById("paramModel");
    if (modelSelect) {
      modelSelect.value = title;
      modelSelect.dispatchEvent(new Event("change"));
    }
  }
  if (State._pendingVAESwitch) {
    const name = State._pendingVAESwitch;
    State._pendingVAESwitch = null;
    const vaeSelect = document.getElementById("paramVAE");
    if (vaeSelect) {
      vaeSelect.value = name;
      vaeSelect.dispatchEvent(new Event("change"));
    }
  }

  // UX-013: Refresh VRAM readout after generation
  _refreshVRAM();

  // Hide live preview thumbnail (deferred if tab is in background)
  // Skip if result preview is now active (gen succeeded and preview is showing results)
  if (!State._resultPreviewActive) _hidePreview();
}


// ═══════════════════════════════════════════
// PREVIEW HELPER
// ═══════════════════════════════════════════

// Hides the live preview thumbnail. If the tab is hidden when gen finishes,
// defer the hide until the user returns (so it doesn't vanish mid-generation
// from their perspective when they switch back).
function _hidePreview() {
  if (document.hidden && State.generating === false) {
    State._deferPreviewHide = true;
    return;
  }
  // Diagnostic: log unexpected hides during generation
  if (State.generating) {
    console.warn("[Studio] _hidePreview called DURING generation — stack:", new Error().stack?.split("\n").slice(1, 4).join(" <- "));
  }
  const wrap = document.getElementById("canvasPreviewWrap");
  if (wrap) wrap.style.display = "none";
  State._deferPreviewHide = false;
  State._previewShown = false;
  State._resultPreviewActive = false;
  // Reset close button and label
  const closeBtn = document.getElementById("canvasPreviewClose");
  if (closeBtn) closeBtn.style.display = "none";
  const label = document.getElementById("canvasPreviewLabel");
  if (label) label.textContent = "Preview";
}

/** Show the viewport preview with a generated result image. */
function _showResultPreview(idx) {
  const wrap = document.getElementById("canvasPreviewWrap");
  const img = document.getElementById("canvasPreview");
  const closeBtn = document.getElementById("canvasPreviewClose");
  const label = document.getElementById("canvasPreviewLabel");
  if (!wrap || !img) return;

  const imgSrc = State.outputImages[idx];
  if (!imgSrc) return;

  img.src = imgSrc;
  wrap.style.display = "";
  State._resultPreviewActive = true;
  State._previewShown = true;
  if (closeBtn) closeBtn.style.display = "";
  if (label) label.textContent = "Result";
}


// ═══════════════════════════════════════════
// HIRES FIX AUTO-DISABLE + WARNING
// ═══════════════════════════════════════════

/** Disable Hires Fix checkbox and update warning state. */
function _disableHiresFix() {
  const check = document.getElementById("checkHires");
  if (check) check.classList.remove("checked");
  _updateHiresWarning();
}

/** Show/hide hires warning icon based on dimensions and enabled state. */
function _updateHiresWarning() {
  var icon = document.getElementById("hiresWarnIcon");
  if (!icon) {
    // Inject warning icon next to "Hires Fix" header on first call
    var header = document.getElementById("checkHires")?.closest(".collapse-header");
    if (!header) return;
    icon = document.createElement("span");
    icon.id = "hiresWarnIcon";
    icon.innerHTML = "&#x26A0;";
    icon.title = "Output will exceed 2000px on one or both sides. This may cause significant VRAM usage and slow generation on most hardware.";
    icon.style.cssText = "display:none;color:var(--accent);font-size:12px;margin-left:6px;cursor:help;";
    // Insert after the title text
    var title = header.querySelector(".collapse-title");
    if (title) title.after(icon);
    else header.appendChild(icon);
  }
  var hiresEnabled = document.getElementById("checkHires")?.classList.contains("checked");
  if (!hiresEnabled) { icon.style.display = "none"; return; }
  var w = parseInt(document.getElementById("paramWidth")?.value) || 768;
  var h = parseInt(document.getElementById("paramHeight")?.value) || 768;
  var scale = _num("paramHrScale", 2.0);
  var outW = Math.round(w * scale), outH = Math.round(h * scale);
  icon.style.display = (outW > 2000 || outH > 2000) ? "inline" : "none";
  icon.title = "Output will be " + outW + "\u00d7" + outH + ". This may cause significant VRAM usage and slow generation on most hardware.";
}


// ═══════════════════════════════════════════
// TAB NOTIFICATION
// ═══════════════════════════════════════════

const _originalTitle = document.title;
let _titleFlashInterval = null;

function _notifyTab(msg) {
  if (!document.hidden) return; // tab is visible, no need
  // Flash title
  let on = true;
  clearInterval(_titleFlashInterval);
  _titleFlashInterval = setInterval(() => {
    document.title = on ? `✓ ${msg} — Forge Studio` : _originalTitle;
    on = !on;
  }, 800);
  // Stop flashing when tab becomes visible
  const _restore = () => {
    if (!document.hidden) {
      clearInterval(_titleFlashInterval);
      document.title = _originalTitle;
      document.removeEventListener("visibilitychange", _restore);
    }
  };
  document.addEventListener("visibilitychange", _restore);
}


// ═══════════════════════════════════════════
// PROGRESS HANDLER
// ═══════════════════════════════════════════

function handleProgress(data) {
  if (!State.generating && !(window.Live && Live.generating)) return;

  // Track last progress message time for inter-pass gap detection
  State._lastProgressTime = Date.now();

  const fill = document.getElementById("progressFill");
  if (fill) {
    var pct = data.progress * 100;
    // Multi-pass guard: don't let the bar shrink unless a new pass starts.
    // A new pass is detected by total_steps changing (e.g. 30→15 for hires).
    if (data.total_steps > 0 && data.total_steps !== State._lastTotalSteps) {
      // New pass started — allow reset
      State._lastTotalSteps = data.total_steps;
      State._peakProgress = 0;
    }
    if (pct >= (State._peakProgress || 0)) {
      State._peakProgress = pct;
      fill.style.width = pct + "%";
    }
  }

  var btn = document.getElementById("genBtn");
  if (btn && data.total_steps > 0) {
    btn.textContent = data.step + " / " + data.total_steps;
  }

  // Live preview — show on overlay during generation.
  // Once shown, keep it visible until generation completes (even between passes).
  // During active Live Painting, don't overwrite a finished result with
  // a progress thumbnail. During normal T2I, always allow progress updates.
  var preview = document.getElementById("canvasPreview");
  var wrap = document.getElementById("canvasPreviewWrap");
  var liveGuard = window.Live && Live.active && State._resultPreviewActive;
  if (data.preview && State.livePreview && !liveGuard) {
    if (preview) {
      preview.src = data.preview;
      if (wrap) wrap.style.display = "";
      State._previewShown = true;
    }
  } else if (State._previewShown && wrap) {
    // Keep wrap visible between passes — don't hide it just because
    // this progress message has no preview data
    wrap.style.display = "";
  }

  // Diagnostic: log when preview should show but doesn't
  if (data.preview && !State.livePreview) {
    if (!State._previewSuppressLogged) {
      console.warn("[Studio] Preview suppressed — livePreview:", State.livePreview,
        "toggle:", document.getElementById("toggleLivePreview")?.classList.contains("on"),
        "wrap:", wrap?.style.display, "inDOM:", !!wrap);
      State._previewSuppressLogged = true;
    }
  }
}


// ═══════════════════════════════════════════
// CONTROLNET DATA
// ═══════════════════════════════════════════

function buildCNJson() {
  const units = [1, 2].map(n => {
    const enabled = document.getElementById(`checkCN${n}`)?.classList.contains("checked") || false;
    if (!enabled) return null;
    return {
      enabled: true,
      module: document.getElementById(`paramCN${n}Module`)?.value || "None",
      model: document.getElementById(`paramCN${n}Model`)?.value || "None",
      source: document.getElementById(`paramCN${n}Source`)?.value || "Canvas",
      weight: _num(`paramCN${n}Weight`, 1.0),
      guidance_start: _num(`paramCN${n}Start`, 0.0),
      guidance_end: _num(`paramCN${n}End`, 1.0),
      control_mode: document.getElementById(`paramCN${n}Mode`)?.value || "Balanced",
      pixel_perfect: true,
    };
  }).filter(Boolean);
  return units.length ? JSON.stringify(units) : "";
}


// ═══════════════════════════════════════════
// CANVAS DISPLAY
// ═══════════════════════════════════════════

function displayOnCanvas(imgSrc, opts) {
  opts = opts || {};
  // Hide any stale preview thumbnail
  const previewWrap = document.getElementById("canvasPreviewWrap");
  if (previewWrap) {
    if (State.generating) console.warn("[Studio] displayOnCanvas hiding preview DURING generation");
    previewWrap.style.display = "none";
    State._resultPreviewActive = false;
    const _cb = document.getElementById("canvasPreviewClose");
    if (_cb) _cb.style.display = "none";
    const _lb = document.getElementById("canvasPreviewLabel");
    if (_lb) _lb.textContent = "Preview";
  }

  // Auto-disable Hires Fix — the image is already at final resolution,
  // doubling it again would be unexpected and VRAM-expensive.
  _disableHiresFix();

  if (!window.StudioCore) return;

  const img = new Image();
  img.onload = () => {
    const Core = window.StudioCore;
    const S = Core.state;
    S.lastResult = imgSrc;

    // Resize canvas to match the output image (handles hires fix)
    const outW = img.naturalWidth;
    const outH = img.naturalHeight;

    // Save undo BEFORE resize so the snapshot captures pre-resize state
    // at the correct dimensions. _restoreStructural already handles
    // dimension changes via canvasW/canvasH in the snapshot.
    if (S.layers.length > 0) {
      Core.saveStructuralUndo(opts.undoLabel || "Generation result");
    }

    if (S.W !== outW || S.H !== outH) {
      Core.resizeCanvas(outW, outH);
    }

    // Width/Height fields follow the canvas. The previous logic clamped
    // to State.baseGenW/H so the next gen wouldn't double up on hires
    // output, but it left the UI mismatched: the canvas showed the
    // upscaled size while the fields showed the base. Mirror the actual
    // canvas dims and let the user adjust down explicitly.
    const paramW = outW;
    const paramH = outH;
    const wEl = document.getElementById("paramWidth");
    const hEl = document.getElementById("paramHeight");
    if (wEl) wEl.value = paramW;
    if (hEl) hEl.value = paramH;
    StatusBar.setDimensions(paramW, paramH);
    if (window._syncARToSize) window._syncARToSize(paramW, paramH);

    if (S.layers.length > 0) {
      if (opts.newLayer) {
        // User-initiated send: always create a new layer on top
        const layerName = opts.layerName || "Imported";
        const newL = Core.makeLayer(layerName, "paint");
        newL.ctx.drawImage(img, 0, 0, S.W, S.H);
        S.layers.push(newL);
        S.activeLayerIdx = S.layers.length - 1;
      } else {
        // Pipeline result (upscale, AD): reuse existing "Gen Result" layer or create one
        let genLayer = S.layers.find(l => l.name === "Gen Result");
        if (genLayer) {
          // Move to top if not already there
          const idx = S.layers.indexOf(genLayer);
          if (idx !== S.layers.length - 1) {
            S.layers.splice(idx, 1);
            S.layers.push(genLayer);
          }
          genLayer.ctx.clearRect(0, 0, S.W, S.H);
          genLayer.ctx.drawImage(img, 0, 0, S.W, S.H);
          genLayer.visible = true;
          S.activeLayerIdx = S.layers.length - 1;
        } else {
          // Create new Gen Result layer at the top of the stack
          genLayer = Core.makeLayer("Gen Result", "paint");
          genLayer.ctx.drawImage(img, 0, 0, S.W, S.H);
          S.layers.push(genLayer);
          S.activeLayerIdx = S.layers.length - 1;
        }
      }
    }
    if (window.StudioUI) {
      window.StudioUI.renderLayerPanel();
      window.StudioUI.renderHistoryPanel();
      if (window.StudioUI.syncCanvasToViewport) window.StudioUI.syncCanvasToViewport();
      Core.zoomFit();
      window.StudioUI.redraw();
    } else {
      Core.composite();
    }
  };
  img.src = imgSrc;
}


// ═══════════════════════════════════════════
// OUTPUT GALLERY
// ═══════════════════════════════════════════

function renderOutputGallery() {
  const section = document.getElementById("outputSection");
  const grid = document.getElementById("outputGrid");
  const info = document.getElementById("outputInfo");
  if (!grid) return;

  // Show the output section
  if (section) section.style.display = State.outputImages.length ? "" : "none";

  grid.innerHTML = State.outputImages.map((img, i) =>
    `<div class="output-thumb ${i === State.selectedOutputIdx ? 'selected' : ''}" data-idx="${i}">
      <img src="${img}" alt="Output ${i + 1}">
    </div>`
  ).join("");

  // Show infotext for selected image
  _updateOutputInfo();
}

/** Update the infotext display for the currently selected output image. */
function _updateOutputInfo() {
  const info = document.getElementById("outputInfo");
  if (!info) return;

  const infotext = State.outputInfotexts[State.selectedOutputIdx] || "";
  if (infotext) {
    const seedMatch = infotext.match(/Seed:\s*(\d+)/);
    const stepsMatch = infotext.match(/Steps:\s*(\d+)/);
    const samplerMatch = infotext.match(/Sampler:\s*([^,]+)/);
    const modelMatch = infotext.match(/Model:\s*([^,]+)/);

    const summary = [
      seedMatch ? `Seed: ${seedMatch[1]}` : null,
      stepsMatch ? `${stepsMatch[1]}st` : null,
      samplerMatch ? samplerMatch[1].trim() : null,
      modelMatch ? modelMatch[1].trim() : null,
    ].filter(Boolean).join(" · ");

    info.innerHTML = `<div class="infotext-summary">${summary || "No info"}</div>`
      + `<div class="infotext-full" style="display:none;">${_escapeHtml(infotext)}</div>`;
    info.classList.add("has-info");
    info.onclick = (e) => {
      if (e.target.closest(".infotext-full")) return;
      const full = info.querySelector(".infotext-full");
      if (full) full.style.display = full.style.display === "none" ? "" : "none";
    };
  } else if (State.lastResult?.seed > 0) {
    info.textContent = `Seed: ${State.lastResult.seed}`;
    info.classList.remove("has-info");
    info.onclick = null;
  } else {
    info.textContent = "";
    info.classList.remove("has-info");
    info.onclick = null;
  }
}


// ═══════════════════════════════════════════
// ACTION HISTORY
// ═══════════════════════════════════════════

function addHistoryEntry(label) {
  const entry = { label, time: new Date() };
  // Trim future entries if we've rewound
  if (State.historyIdx >= 0 && State.historyIdx < State.history.length - 1) {
    State.history = State.history.slice(State.historyIdx);
  }
  State.history.unshift(entry);
  State.historyIdx = 0;
  renderHistory();
}

function renderHistory() {
  const list = document.getElementById("historyList");
  if (!list) return;

  list.innerHTML = State.history.map((entry, i) => {
    const age = formatTimeAgo(entry.time);
    const isCurrent = i === State.historyIdx;
    const isFuture = i < State.historyIdx;
    return `<div class="history-item ${isCurrent ? 'current' : ''}" data-idx="${i}"
                 style="${isFuture ? 'opacity:0.35' : ''}">
      <span class="h-icon">${isCurrent ? '&#x25cf;' : '&#x25cb;'}</span>
      <span class="h-label">${entry.label}</span>
      <span class="h-time">${age}</span>
    </div>`;
  }).join("");

  // Click to rewind
  list.querySelectorAll(".history-item").forEach(item => {
    item.addEventListener("click", () => {
      State.historyIdx = parseInt(item.dataset.idx);
      renderHistory();
      // TODO: actual undo/redo when canvas engine is ported
    });
  });
}

function formatTimeAgo(date) {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(m / 60)}h`;
}


// ═══════════════════════════════════════════
// UI INTERACTIONS
// ═══════════════════════════════════════════

function bindUI() {
  // App tabs
  document.getElementById("appTabs")?.addEventListener("click", e => {
    if (e.target.tagName !== "BUTTON") return;
    document.querySelectorAll("#appTabs button").forEach(b => b.classList.remove("active"));
    e.target.classList.add("active");
    document.querySelectorAll(".app-page").forEach(p => p.classList.remove("active"));
    document.getElementById("app-" + e.target.dataset.app)?.classList.add("active");

    // Re-sync canvas viewport when switching back to Studio —
    // getBoundingClientRect returns 0 while the page is hidden,
    // so any resize events that fired while on another tab left
    // the display canvas at 100×100.
    if (e.target.dataset.app === "studio" && window.StudioUI) {
      requestAnimationFrame(() => {
        window.StudioUI.syncCanvasToViewport();
        if (window.StudioCore) window.StudioCore.zoomFit();
        window.StudioUI.redraw();
      });
    }
  });

  // Toolstrip
  document.getElementById("toolstrip")?.addEventListener("click", e => {
    const btn = e.target.closest(".tool-btn");
    if (!btn || !btn.dataset.tool) return;
    document.querySelectorAll(".tool-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    if (window.StudioCore) {
      window.StudioCore.state.tool = btn.dataset.tool;
    }
  });

  // Mode is always Create — auto-detected by backend from canvas state
  State.mode = "Create";

  // Brush presets
  document.getElementById("brushPresets")?.addEventListener("click", e => {
    const btn = e.target.closest(".brush-preset-btn");
    if (!btn) return;
    document.querySelectorAll(".brush-preset-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
  });

  // Panel tabs
  document.getElementById("panelTabs")?.addEventListener("click", e => {
    if (!e.target.classList.contains("panel-tab")) return;
    document.querySelectorAll(".panel-tab").forEach(t => t.classList.remove("active"));
    e.target.classList.add("active");
    document.querySelectorAll(".panel-page").forEach(p => p.classList.remove("active"));
    document.getElementById("page-" + e.target.dataset.panel)?.classList.add("active");
  });

  // Collapsible sections (Hires Fix, ADetailer, ControlNet, etc).
  // max-height is driven by scrollHeight per toggle so easing matches
  // actual content height. A flag on the element tracks an in-flight
  // transition listener so rapid re-clicks don't stack listeners or
  // leave max-height in a stale state.
  function _toggleCollapseBody(body) {
    if (!body) return;
    const expand = !body.classList.contains("open");
    // Remove any pending listener from a previous in-flight toggle.
    if (body._collapseEndHandler) {
      body.removeEventListener("transitionend", body._collapseEndHandler);
      body._collapseEndHandler = null;
    }
    if (expand) {
      // If we were in the "fully open" state (max-height: none), drop
      // back to a numeric height so the next change can transition.
      if (body.style.maxHeight === "none" || body.style.maxHeight === "") {
        body.style.maxHeight = "0px";
        body.offsetHeight; // reflow
      }
      body.style.maxHeight = body.scrollHeight + "px";
      body.classList.add("open");
      const onEnd = (e) => {
        if (e.propertyName !== "max-height") return;
        // Only release to "none" if we're still open (race-safe).
        if (body.classList.contains("open")) body.style.maxHeight = "none";
        body.removeEventListener("transitionend", onEnd);
        body._collapseEndHandler = null;
      };
      body._collapseEndHandler = onEnd;
      body.addEventListener("transitionend", onEnd);
    } else {
      // Anchor the current scrollHeight as an explicit pixel value so
      // the next assignment to 0 transitions instead of snapping.
      body.style.maxHeight = body.scrollHeight + "px";
      body.offsetHeight; // reflow
      body.style.maxHeight = "0px";
      body.classList.remove("open");
    }
  }

  // Sections that ship with the .open class need an inline max-height
  // on first paint, otherwise the base rule (max-height: 0) hides
  // their content immediately. Run once at init.
  document.querySelectorAll(".collapse-body.open").forEach(el => {
    el.style.maxHeight = "none";
  });

  document.querySelectorAll(".collapse-header").forEach(header => {
    header.addEventListener("click", e => {
      const check = header.querySelector(".collapse-check");
      if (check && (e.target === check || check.contains(e.target))) {
        check.classList.toggle("checked");
        // Update hires warning when Hires Fix checkbox changes
        if (check.id === "checkHires") _updateHiresWarning();
        e.stopPropagation();
        return;
      }
      const body = header.nextElementSibling;
      const arrow = header.querySelector(".collapse-arrow");
      _toggleCollapseBody(body);
      if (arrow) arrow.classList.toggle("open");
    });
  });

  // UX-011: Collapsible section headers (Layers, History, etc.)
  document.querySelectorAll(".section-header[data-collapse]").forEach(header => {
    header.addEventListener("click", e => {
      // Don't collapse if clicking action buttons
      if (e.target.closest(".section-actions")) return;
      const targetId = header.dataset.collapse;
      const body = document.getElementById(targetId);
      const arrow = header.querySelector(".section-arrow");
      if (body) body.classList.toggle("collapsed");
      if (arrow) header.classList.toggle("collapsed");
    });
  });

  // UX-012: Clear mask button
  document.getElementById("clearMaskBtn")?.addEventListener("click", () => {
    if (!window.StudioCore) return;
    const S = window.StudioCore.state;
    if (S.mask?.ctx) {
      S.mask.ctx.clearRect(0, 0, S.W, S.H);
      window.StudioCore.composite();
      showToast("Mask cleared", "info");
    }
  });

  // Generate
  document.getElementById("genBtn")?.addEventListener("click", doGenerate);
  document.getElementById("interruptBtn")?.addEventListener("click", () => {
    if (!State.generating) return;
    API.interrupt();
    const btn = document.getElementById("genBtn");
    if (btn) btn.textContent = "Interrupting...";
    showToast("Interrupting...", "info");
  });
  document.getElementById("skipBtn")?.addEventListener("click", () => {
    if (!State.generating) return;
    API.skip();
    showToast("Skipping to next image...", "info");
  });

  // Live Painting
  document.getElementById("liveToggleBtn")?.addEventListener("click", () => Live.toggle());
  document.getElementById("liveRerollBtn")?.addEventListener("click", () => Live.rerollSeed());
  document.getElementById("liveApplyBtn")?.addEventListener("click", () => Live.apply());

  const liveStrength = document.getElementById("liveStrength");
  if (liveStrength) {
    liveStrength.addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      Live.strength = v;
      const display = document.getElementById("liveStrengthVal");
      if (display) display.textContent = v.toFixed(2);
    });
    liveStrength.addEventListener("change", () => Live.onSettingsChanged());
  }

  // Show/hide Live panel when Live toggles
  const origLiveUpdateUI = Live._updateUI.bind(Live);
  Live._updateUI = function () {
    origLiveUpdateUI();
    const panel = document.getElementById("livePanel");
    if (panel) panel.style.display = this.active ? "block" : "none";
    // Disable Generate button during Live
    const genBtn = document.getElementById("genBtn");
    if (genBtn) {
      genBtn.disabled = this.active;
      genBtn.style.opacity = this.active ? "0.4" : "";
    }
  };

  // Wire prompt changes to Live
  document.getElementById("paramPrompt")?.addEventListener("input", () => Live.onPromptChanged());
  document.getElementById("paramNeg")?.addEventListener("input", () => Live.onPromptChanged());

  // Standalone upscale — v6.10: single-call pipeline. One backend
  // request runs ESRGAN + optional img2img refine + optional ADetailer.
  // Replaces the old two-stage flow that paid two full process_images()
  // setups and two base64 round-trips of the upscaled PNG. Refine and
  // AD checkboxes are truly independent — AD can run standalone on the
  // ESRGAN output.
  document.getElementById("upscaleBtn")?.addEventListener("click", async () => {
    if (!window.StudioCore) { showToast("Canvas not ready", "error"); return; }
    const Core = window.StudioCore;
    const S = Core.state;

    const upscaler = document.getElementById("paramUpscaleModel")?.value || "R-ESRGAN 4x+";
    const scale = _num("paramUpscaleScale", 2.0);
    const runRefine = document.getElementById("checkUpscaleRefine")?.classList.contains("checked") || false;
    const runAD     = document.getElementById("checkUpscaleAD")?.classList.contains("checked") || false;

    // Get canvas composite as data URL
    const tmp = document.createElement("canvas");
    tmp.width = S.W; tmp.height = S.H;
    const ctx = tmp.getContext("2d");
    for (const L of S.layers) {
      if (!L.visible || L.type === "adjustment") continue;
      ctx.globalAlpha = L.opacity;
      ctx.globalCompositeOperation = L.blendMode || "source-over";
      ctx.drawImage(L.canvas, 0, 0);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    const imageB64 = tmp.toDataURL("image/png");

    const newW = (Math.round(S.W * scale) >> 3) << 3;
    const newH = (Math.round(S.H * scale) >> 3) << 3;

    const btn = document.getElementById("upscaleBtn");
    const fill = document.getElementById("progressFill");
    if (btn) { btn.textContent = `Upscaling ${S.W}\u00d7${S.H} \u2192 ${newW}\u00d7${newH}...`; btn.disabled = true; }
    if (fill) { fill.style.width = "100%"; fill.classList.add("indeterminate"); }
    StatusBar.setStatus("loading");

    // Fast VRAM polling during the pipeline
    const _vramPoll = setInterval(() => _refreshVRAM(), 2000);
    await _refreshVRAM();

    const userSteps   = parseInt(document.getElementById("paramUpscaleSteps")?.value) || 20;
    const userDenoise = _num("paramUpscaleDenoise", 0.3);

    // Progress streaming: the new backend endpoint pushes sampling_step /
    // job_count over the WebSocket during process_images() and
    // _run_studio_ad(), so a single poller drives the status bar across
    // the whole pipeline.
    const needsProgress = runRefine || runAD;
    if (needsProgress) { StatusBar.setStatus("generating"); Progress.startPolling(); }
    console.log(`[Upscale] Pipeline: ESRGAN${runRefine ? " + refine" : ""}${runAD ? " + AD" : ""}`);

    try {
      const body = {
        image_b64: imageB64,
        upscaler, scale,
        run_refine:    runRefine,
        run_ad:        runAD,
        prompt:        document.getElementById("paramPrompt")?.value || "",
        neg_prompt:    document.getElementById("paramNeg")?.value || "",
        steps:         userSteps,
        sampler_name:  document.getElementById("paramSampler")?.value || "DPM++ 2M SDE",
        schedule_type: document.getElementById("paramScheduler")?.value || "Karras",
        cfg_scale:     _num("paramCFG", 5.0),
        denoising:     userDenoise,
        seed:          -1,
        ad_slots:      [1, 2, 3].map(n => ({
          enable:     document.getElementById(`checkAD${n}`)?.classList.contains("checked") || false,
          model:      document.getElementById(`paramAD${n}Model`)?.value || "None",
          confidence: _num(`paramAD${n}Conf`, 0.3),
          denoise:    _num(`paramAD${n}Denoise`, 0.4),
          mask_blur:  parseInt(document.getElementById(`paramAD${n}Blur`)?.value) || 4,
          prompt:     document.getElementById(`paramAD${n}Prompt`)?.value || "",
          neg_prompt: "",
        })),
        save_outputs:   State.saveOutputs,
        save_format:    State.saveFormat || "png",
        save_quality:   State.saveQuality || 95,
        save_lossless:  State.saveLossless || false,
        embed_metadata: State.embedMetadata ?? true,
      };

      const r = await fetch(API.base + "/studio/upscale_and_refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        displayOnCanvas(data.image);
        let msg;
        if (runRefine && runAD)  msg = `Upscale + refine + AD complete (${data.width}\u00d7${data.height})`;
        else if (runRefine)      msg = `Upscale + refine complete (${data.width}\u00d7${data.height})`;
        else if (runAD)          msg = `Upscale + AD complete (${data.width}\u00d7${data.height})`;
        else                     msg = `Upscaled to ${data.width}\u00d7${data.height} with ${upscaler}`;
        if (data.filename) msg += ` \u2014 saved ${data.filename}`;
        showToast(msg, "success");
        console.log("[Upscale] Pipeline complete");
      } else {
        showToast("Upscale failed: " + (data.error || "unknown error"), "error");
      }
    } catch (err) {
      showToast("Upscale error: " + err.message, "error");
      console.error("[Upscale] Pipeline error:", err);
    }

    if (needsProgress) Progress.stopPolling();
    clearInterval(_vramPoll);
    if (btn) { btn.textContent = "UPSCALE CANVAS"; btn.disabled = false; }
    if (fill) { fill.style.width = "0%"; fill.classList.remove("indeterminate"); }
    StatusBar.setStatus("ready");
    _refreshVRAM();
  });

  // PromptScope: live token counter
  document.getElementById("paramPrompt")?.addEventListener("input", () => PromptScope.scheduleTokenCount());
  PromptScope.scheduleTokenCount();

  // Output gallery actions
  document.getElementById("outputToCanvas")?.addEventListener("click", () => {
    // Use data URL version for canvas drawing (file URLs can't be drawn to canvas due to CORS)
    const img = (State.outputImagesB64 || State.outputImages)[State.selectedOutputIdx];
    if (img) displayOnCanvas(img, { newLayer: true, layerName: "Output", undoLabel: "Send to canvas" });
  });

  // Gallery click = select, double-click = lightbox (event delegation, bound once)
  const _grid = document.getElementById("outputGrid");
  if (_grid) {
    _grid.addEventListener("click", (e) => {
      const thumb = e.target.closest(".output-thumb");
      if (!thumb) return;
      State.selectedOutputIdx = parseInt(thumb.dataset.idx);
      _grid.querySelectorAll(".output-thumb").forEach(t => t.classList.remove("selected"));
      thumb.classList.add("selected");
      _showResultPreview(State.selectedOutputIdx);
      _updateOutputInfo();
    });
    _grid.addEventListener("dblclick", (e) => {
      const thumb = e.target.closest(".output-thumb");
      if (!thumb) return;
      const idx = parseInt(thumb.dataset.idx);
      _openCanvasOutput(idx);
    });

    // Preview click → Gallery detail (saved or ephemeral)
    const _vpPreview = document.getElementById("canvasPreviewWrap");
    if (_vpPreview) {
      _vpPreview.addEventListener("click", (e) => {
        // Close button click
        if (e.target.id === "canvasPreviewClose") {
          _vpPreview.style.display = "none";
          State._resultPreviewActive = false;
          return;
        }
        _openCanvasOutput(State.selectedOutputIdx);
      });
    }

    // Gallery drag → canvas: mousedown on thumb sets pending, mouseup over canvas applies
    _grid.addEventListener("mousedown", (e) => {
      const thumb = e.target.closest(".output-thumb");
      if (!thumb || e.button !== 0) return;
      e.preventDefault(); // Prevent native image drag
      State._galleryDragIdx = parseInt(thumb.dataset.idx);
    });

    // Gallery right-click context menu
    _grid.addEventListener("contextmenu", (e) => {
      const thumb = e.target.closest(".output-thumb");
      if (!thumb) return;
      e.preventDefault();
      const idx = parseInt(thumb.dataset.idx);
      // Remove existing menu
      document.querySelector(".gallery-ctx-menu")?.remove();

      const infotext = State.outputInfotexts[idx] || "";
      const seedMatch = infotext.match(/Seed:\s*(\d+)/);
      const seed = seedMatch ? seedMatch[1] : null;

      const menu = document.createElement("div");
      menu.className = "gallery-ctx-menu";
      menu.innerHTML = [
        { label: "Send to Canvas", action: "canvas" },
        seed ? { label: `Copy Seed (${seed})`, action: "seed" } : null,
        null, // separator
        { label: "Save as PNG", action: "save-png" },
        { label: "Save as JPEG", action: "save-jpeg" },
        { label: "Save as WebP", action: "save-webp" },
      ].filter(Boolean).map(item =>
        item.label ? `<div class="gallery-ctx-item" data-action="${item.action}">${item.label}</div>`
                   : '<div class="gallery-ctx-sep"></div>'
      ).join("");
      menu.style.left = e.clientX + "px";
      menu.style.top = e.clientY + "px";
      document.body.appendChild(menu);

      menu.addEventListener("click", async (me) => {
        const action = me.target.dataset?.action;
        if (!action) return;
        menu.remove();
        const imgSrc = (State.outputImagesB64 || State.outputImages)[idx];
        if (action === "canvas" && imgSrc) {
          displayOnCanvas(imgSrc, { newLayer: true, layerName: "Output", undoLabel: "Send to canvas" });
        } else if (action === "seed" && seed) {
          navigator.clipboard.writeText(seed).then(() => showToast(`Seed ${seed} copied`, "success"));
        } else if (action.startsWith("save-")) {
          const fmt = action.replace("save-", "");
          const metadata = State.embedMetadata ? (infotext || "") : "";
          const origName = State.outputFilenames[idx] || null;
          try {
            const result = await API.saveImage({ image_b64: imgSrc, format: fmt, quality: 95, metadata: metadata || null, subfolder: "downloads", filename: origName });
            if (result.ok) showToast(`Saved ${result.filename}`, "success");
            else showToast(result.error || "Save failed", "error");
          } catch (err) { showToast("Save failed: " + err.message, "error"); }
        }
      });

      // Close on click outside
      setTimeout(() => {
        document.addEventListener("click", function _close() {
          menu.remove();
          document.removeEventListener("click", _close);
        }, { once: true });
      }, 0);
    });
  }

  /** Build a navContext from the current Canvas batch. Each slot carries
   * everything Gallery needs for ephemeral fallback (b64Url, filename,
   * infotext) plus the hash for the saved-image lookup path. */
  function _buildCanvasNavContext() {
    return State.outputImages.map((url, i) => ({
      hash: State.outputContentHashes[i] || "",
      b64Url: State.outputImagesB64[i] || url,
      filename: State.outputFilenames[i] || "",
      infotext: State.outputInfotexts[i] || "",
    }));
  }

  /** Open Canvas output `idx` in Gallery's detail view. Always opens
   * ephemeral immediately so the user sees the image + prompt without
   * waiting for any DB round-trip. If the slot has a hash, kick off a
   * background upgrade that swaps the overlay to DB-backed mode the
   * moment the row resolves (gaining rename / Browse / tags etc.).
   * Returns true if Gallery is loaded; false if the IIFE hasn't booted. */
  function _openCanvasOutput(idx) {
    if (!window.StudioGallery) return false;
    const ctx = _buildCanvasNavContext();
    const slot = ctx[idx];
    if (!slot) return false;
    window.StudioGallery.openEphemeral(slot, ctx);
    if (slot.hash && State.saveOutputs && window.StudioGallery.upgradeByHash) {
      // Fire-and-forget. upgradeByHash runs identity checks before
      // mutating state, so a stale promise won't clobber a user's
      // subsequent navigation.
      window.StudioGallery.upgradeByHash(slot.hash);
    }
    return true;
  }

  // Gallery drag release — check if over canvas area
  document.addEventListener("mouseup", e => {
    if (State._galleryDragIdx == null) return;
    const idx = State._galleryDragIdx;
    State._galleryDragIdx = null;
    // Check if released over canvas area
    const canvasArea = document.getElementById("canvasArea");
    if (canvasArea && canvasArea.contains(e.target)) {
      const img = (State.outputImagesB64 || State.outputImages)[idx];
      if (img) displayOnCanvas(img, { newLayer: true, layerName: "Output", undoLabel: "Drag to canvas" });
    }
  });

  // External file drop on canvas
  const _canvasArea = document.querySelector(".canvas-area");
  if (_canvasArea) {
    _canvasArea.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    _canvasArea.addEventListener("drop", e => {
      e.preventDefault();
      // External file drop
      const file = e.dataTransfer.files?.[0];
      if (file && file.type.startsWith("image/") && window.StudioCore) {
        const Core = window.StudioCore;
        const metaPromise = (file.type === "image/png" && window.PngMetadata)
          ? PngMetadata.read(file).catch(() => ({}))
          : Promise.resolve({});
        const r = new FileReader();
        r.onload = ev => {
          const img = new Image();
          img.onload = async () => {
            const newW = img.naturalWidth, newH = img.naturalHeight;
            Core.saveStructuralUndo("Drop image");
            Core.resizeCanvas(newW, newH);
            const wInput = document.getElementById("paramWidth");
            const hInput = document.getElementById("paramHeight");
            if (wInput) wInput.value = newW;
            if (hInput) hInput.value = newH;
            StatusBar.setDimensions(newW, newH);
            if (window._syncARToSize) window._syncARToSize(newW, newH);
            const S = Core.state;
            const newL = Core.makeLayer("Dropped", "paint");
            newL.ctx.drawImage(img, 0, 0, newW, newH);
            S.layers.splice(S.activeLayerIdx + 1, 0, newL);
            S.activeLayerIdx++;
            if (window.StudioUI) {
              window.StudioUI.renderLayerPanel();
              window.StudioUI.syncCanvasToViewport();
              Core.zoomFit();
              window.StudioUI.updateStatus();
              window.StudioUI.redraw();
            }
            Core.composite();
            const meta = await metaPromise;
            if (meta.parameters) {
              _applyInfotextToUI(meta.parameters);
              showToast(`Dropped ${newW}\u00d7${newH} (params imported)`, "success");
            } else {
              showToast(`Dropped ${newW}\u00d7${newH}`, "success");
            }
            // Auto-disable Hires Fix for dropped images
            _disableHiresFix();
          };
          img.src = ev.target.result;
        };
        r.readAsDataURL(file);
      }
    });
  }
  // Gallery save — anchor a floating popover off the icon button so we
  // can offer "Save to Gallery" (drops in the watched outputs root) in
  // addition to the format-specific download targets.
  async function _saveSelectedOutput(fmt, toGallery) {
    const imgSrc = (State.outputImagesB64 || State.outputImages)[State.selectedOutputIdx];
    if (!imgSrc) return;
    const infotext = State.embedMetadata
      ? (State.outputInfotexts[State.selectedOutputIdx] || "")
      : "";
    try {
      const origName = State.outputFilenames[State.selectedOutputIdx] || null;
      const result = await API.saveImage({
        image_b64: imgSrc,
        format: fmt,
        quality: 95,
        metadata: infotext || null,
        // toGallery=true drops the file in output/studio/ (the
        // gallery-watched root). Anything else lands in
        // output/studio/downloads/ to keep manual downloads grouped.
        subfolder: toGallery ? "" : "downloads",
        filename: origName,
      });
      if (result.ok) {
        showToast(toGallery
          ? `Saved to Gallery → ${result.filename}`
          : `Saved ${result.filename}`, "success");
      } else {
        showToast(result.error || "Save failed", "error");
      }
    } catch (e) {
      console.error("[Studio] Save failed:", e);
      showToast("Save failed: " + e.message, "error");
    }
  }

  function _showOutputSaveMenu(anchor) {
    const existing = document.getElementById("outputSaveMenu");
    if (existing) { existing.remove(); return; }

    const items = [
      { label: "Save as PNG",  fn: () => _saveSelectedOutput("png",  false) },
      { label: "Save as JPEG", fn: () => _saveSelectedOutput("jpeg", false) },
      { label: "Save as WebP", fn: () => _saveSelectedOutput("webp", false) },
      { label: "Save to Gallery", fn: () => _saveSelectedOutput("png", true) },
    ];

    const menu = document.createElement("div");
    menu.id = "outputSaveMenu";
    menu.className = "output-save-menu";
    for (const it of items) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "output-save-menu-item";
      row.textContent = it.label;
      row.addEventListener("click", () => { menu.remove(); it.fn(); });
      menu.appendChild(row);
    }
    document.body.appendChild(menu);

    // Anchor below the icon, right-aligned so the popover doesn't
    // shoot off-screen on a narrow sidebar.
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth;
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    const top = r.bottom + 4;
    menu.style.left = left + "px";
    menu.style.top = top + "px";

    const dismiss = (ev) => {
      if (ev.type === "keydown" && ev.key !== "Escape") return;
      if (ev.type === "click" && (menu.contains(ev.target) || anchor.contains(ev.target))) return;
      menu.remove();
      document.removeEventListener("click", dismiss, true);
      document.removeEventListener("keydown", dismiss, true);
    };
    setTimeout(() => {
      document.addEventListener("click", dismiss, true);
      document.addEventListener("keydown", dismiss, true);
    }, 0);
  }

  document.getElementById("outputSave")?.addEventListener("click", (e) => {
    _showOutputSaveMenu(e.currentTarget);
  });

  // Seed buttons
  document.getElementById("seedRandom")?.addEventListener("click", () => {
    document.getElementById("paramSeed").value = "-1";
  });
  document.getElementById("seedRecycle")?.addEventListener("click", () => {
    if (State.lastSeed > 0) {
      document.getElementById("paramSeed").value = State.lastSeed;
    } else if (State.lastResult?.seed > 0) {
      document.getElementById("paramSeed").value = State.lastResult.seed;
    }
  });

  // Extra seed (variation) toggle
  document.getElementById("checkExtra")?.addEventListener("change", (e) => {
    const section = document.getElementById("extraSeedSection");
    if (section) section.style.display = e.target.checked ? "" : "none";
  });
  document.getElementById("varSeedRandom")?.addEventListener("click", () => {
    document.getElementById("paramVarSeed").value = "-1";
  });
  document.getElementById("varSeedRecycle")?.addEventListener("click", () => {
    if (State.lastResult?.seed > 0) {
      document.getElementById("paramVarSeed").value = State.lastResult.seed;
    }
  });
  // Variation strength slider ↔ number input sync
  document.getElementById("paramVarStrength")?.addEventListener("input", (e) => {
    const valEl = document.getElementById("paramVarStrengthVal");
    if (valEl) valEl.value = e.target.value;
  });
  document.getElementById("paramVarStrengthVal")?.addEventListener("change", (e) => {
    const slider = document.getElementById("paramVarStrength");
    if (slider) slider.value = Math.max(0, Math.min(1, parseFloat(e.target.value) || 0));
    e.target.value = slider?.value || "0";
  });

  // Model change in settings
  document.getElementById("paramModel")?.addEventListener("change", async (e) => {
    const title = e.target.value;
    if (!title) return;
    // If a generation is in flight, queue the switch and apply after it
    // completes. forge_model_reload() mid-pipeline would destroy
    // shared.sd_model out from under process_images().
    if (State.generating) {
      State._pendingModelSwitch = title;
      showToast("Model will switch after generation completes", "info");
      return;
    }
    // FR-002: Show progress bar during model load
    const btn = document.getElementById("genBtn");
    const fill = document.getElementById("progressFill");
    if (btn) { btn.textContent = "Loading model..."; btn.classList.add("generating"); }
    if (fill) { fill.style.width = "100%"; fill.classList.add("indeterminate"); }
    StatusBar.setStatus("loading");
    try {
      // Check if model needs external text encoder (near-instant header scan)
      let textEncoder = "None";
      try {
        const teCheck = await fetch(API.base + "/studio/check_model_te?title=" + encodeURIComponent(title)).then(r => r.json());
        const teRow = document.getElementById("textEncoderRow");
        const teSelect = document.getElementById("paramTextEncoder");
        if (teCheck.needs_te) {
          // Show TE row — model needs external text encoder
          if (teRow) teRow.style.display = "";
          // Restore per-model TE memory from localStorage
          const teMemory = JSON.parse(localStorage.getItem("studio_te_memory") || "{}");
          if (teMemory[title] && teSelect) {
            // Check if the remembered TE still exists in the dropdown
            if ([...teSelect.options].some(o => o.value === teMemory[title])) {
              teSelect.value = teMemory[title];
            }
          }
          textEncoder = teSelect?.value || "None";
          if (textEncoder === "None" && (State._textEncoderList || []).length > 0) {
            showToast("This model needs a text encoder — select one above", "warn");
          }
        } else {
          // Hide TE row — model bundles its own text encoder
          if (teRow) teRow.style.display = "none";
          if (teSelect) teSelect.value = "None";
        }
      } catch (teErr) {
        console.warn("[Studio] TE check failed:", teErr);
      }

      // Always send the user's explicit VAE — needs_vae can't distinguish a good baked VAE from garbage merged weights.
      const loadBody = { title, text_encoder: textEncoder };
      const vaeVal = document.getElementById("paramVAE")?.value;
      if (vaeVal && vaeVal !== "Automatic" && vaeVal !== "None") {
        loadBody.vae = vaeVal;
      }

      const r = await fetch(API.base + "/studio/load_model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loadBody),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        StatusBar.setModel(data.loaded.split("[")[0].trim());
        showToast("Model loaded: " + data.loaded, "success");
      } else {
        console.error("[Studio] Model load failed:", data);
        showToast("Model load failed: " + (data.error || r.status), "error");
      }
    } catch (err) {
      console.error("[Studio] Model load error:", err);
      showToast("Model load error: " + err.message, "error");
    }
    if (btn) { btn.textContent = "Generate"; btn.classList.remove("generating"); }
    if (fill) { fill.style.width = "0%"; fill.classList.remove("indeterminate"); }
    StatusBar.setStatus("ready");
  });

  // VAE change in settings
  document.getElementById("paramVAE")?.addEventListener("change", async (e) => {
    const name = e.target.value;
    if (!name) return;
    // If a generation is in flight, queue the switch and apply after it
    // completes. forge_model_reload() mid-pipeline would destroy
    // shared.sd_model out from under process_images().
    if (State.generating) {
      State._pendingVAESwitch = name;
      showToast("VAE will switch after generation completes", "info");
      return;
    }
    showToast("Switching VAE...", "info");
    try {
      const r = await fetch(API.base + "/studio/load_vae", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        showToast("VAE: " + data.loaded, "success");
      } else {
        console.error("[Studio] VAE load failed:", data);
        showToast("VAE load failed: " + (data.error || r.status), "error");
      }
    } catch (err) {
      console.error("[Studio] VAE load error:", err);
      showToast("VAE load error: " + err.message, "error");
    }
  });

  // Text Encoder change — save per-model memory and reload model with new TE
  document.getElementById("paramTextEncoder")?.addEventListener("change", async (e) => {
    const te = e.target.value;
    const modelSelect = document.getElementById("paramModel");
    const title = modelSelect?.value;
    if (!title) return;

    // Save per-model TE choice to localStorage
    const teMemory = JSON.parse(localStorage.getItem("studio_te_memory") || "{}");
    teMemory[title] = te;
    localStorage.setItem("studio_te_memory", JSON.stringify(teMemory));

    if (te === "None") return; // No reload needed — clearing TE
    showToast("Loading with text encoder...", "info");
    const btn = document.getElementById("genBtn");
    const fill = document.getElementById("progressFill");
    if (btn) { btn.textContent = "Loading model..."; btn.classList.add("generating"); }
    if (fill) { fill.style.width = "100%"; fill.classList.add("indeterminate"); }
    StatusBar.setStatus("loading");
    try {
      // Include VAE as additional module — if TE row is visible,
      // model likely needs external VAE too
      const loadBody = { title, text_encoder: te };
      const vaeVal = document.getElementById("paramVAE")?.value;
      if (vaeVal && vaeVal !== "Automatic" && vaeVal !== "None") {
        loadBody.vae = vaeVal;
      }
      const r = await fetch(API.base + "/studio/load_model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loadBody),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        showToast("Model loaded with " + te, "success");
      } else {
        showToast("Load failed: " + (data.error || r.status), "error");
      }
    } catch (err) {
      showToast("Load error: " + err.message, "error");
    }
    if (btn) { btn.textContent = "Generate"; btn.classList.remove("generating"); }
    if (fill) { fill.style.width = "0%"; fill.classList.remove("indeterminate"); }
    StatusBar.setStatus("ready");
  });

  // Toggle tracks — generic CSS toggle
  document.querySelectorAll(".toggle-track").forEach(t => {
    t.addEventListener("click", () => t.classList.toggle("on"));
  });

  // ===== REFRESH BUTTONS =====
  document.getElementById("refreshModelsBtn")?.addEventListener("click", async () => {
    showToast("Refreshing models...", "info");
    try {
      await API.refreshModels();
      await populateDropdowns();
      showToast("Models refreshed", "success");
    } catch (e) {
      showToast("Refresh failed: " + e.message, "error");
    }
  });

  document.getElementById("refreshVAEBtn")?.addEventListener("click", async () => {
    showToast("Refreshing VAEs...", "info");
    try {
      const vaes = await fetch(API.base + "/studio/vaes").then(r => r.json());
      const vaeSelect = document.getElementById("paramVAE");
      if (vaeSelect) {
        const current = vaeSelect.value;
        vaeSelect.innerHTML = vaes.map(v =>
          `<option value="${v.name}">${v.name}</option>`
        ).join("");
        vaeSelect.value = current;
      }
      showToast(`VAEs refreshed (${vaes.length} found)`, "success");
    } catch (e) {
      showToast("VAE refresh failed: " + e.message, "error");
    }
  });

  document.getElementById("refreshTEBtn")?.addEventListener("click", async () => {
    showToast("Refreshing text encoders...", "info");
    try {
      const teList = await fetch(API.base + "/studio/text_encoders").then(r => r.json());
      const teSelect = document.getElementById("paramTextEncoder");
      if (teSelect) {
        const current = teSelect.value;
        teSelect.innerHTML = '<option value="None">None (bundled)</option>' +
          teList.map(name =>
            `<option value="${name}">${name}</option>`
          ).join("");
        if ([...teSelect.options].some(o => o.value === current)) teSelect.value = current;
      }
      State._textEncoderList = teList;
      showToast(`Text encoders refreshed (${teList.length} found)`, "success");
    } catch (e) {
      showToast("TE refresh failed: " + e.message, "error");
    }
  });

  // ===== SETTINGS TOGGLE WIRING =====

  // Show grid → toggle canvas-drawn grid overlay
  document.getElementById("toggleGrid")?.addEventListener("click", () => {
    const on = document.getElementById("toggleGrid")?.classList.contains("on") ?? true;
    if (window.StudioCore) {
      window.StudioCore.state.showGrid = on;
      if (window.StudioUI) window.StudioUI.redraw();
    }
  });

  // Pen pressure — context bar button with Size/Opacity sub-toggles
  const _pressureBtn = document.getElementById("pressureBtn");
  const _pressureSizeBtn = document.getElementById("pressureSizeBtn");
  const _pressureOpacityBtn = document.getElementById("pressureOpacityBtn");

  function _syncPressureState() {
    const on = _pressureBtn?.classList.contains("active") ?? false;
    const sizeOn = _pressureSizeBtn?.classList.contains("active") ?? false;
    const opacityOn = _pressureOpacityBtn?.classList.contains("active") ?? false;
    if (window.StudioCore) {
      window.StudioCore.state.pressureSensitivity = on;
      if (!on) {
        window.StudioCore.state.pressureAffects = "none";
      } else if (sizeOn && opacityOn) {
        window.StudioCore.state.pressureAffects = "both";
      } else if (sizeOn) {
        window.StudioCore.state.pressureAffects = "size";
      } else if (opacityOn) {
        window.StudioCore.state.pressureAffects = "opacity";
      } else {
        window.StudioCore.state.pressureAffects = "none";
      }
    }
    // Show/hide sub-buttons
    if (_pressureSizeBtn) _pressureSizeBtn.style.display = on ? "" : "none";
    if (_pressureOpacityBtn) _pressureOpacityBtn.style.display = on ? "" : "none";
  }

  _pressureBtn?.addEventListener("click", () => {
    _pressureBtn.classList.toggle("active");
    // If turning on and neither sub is active, default to both
    if (_pressureBtn.classList.contains("active")) {
      if (!_pressureSizeBtn?.classList.contains("active") && !_pressureOpacityBtn?.classList.contains("active")) {
        _pressureSizeBtn?.classList.add("active");
        _pressureOpacityBtn?.classList.add("active");
      }
    }
    _syncPressureState();
  });
  _pressureSizeBtn?.addEventListener("click", () => {
    _pressureSizeBtn.classList.toggle("active");
    _syncPressureState();
  });
  _pressureOpacityBtn?.addEventListener("click", () => {
    _pressureOpacityBtn.classList.toggle("active");
    _syncPressureState();
  });

  // Save outputs → gate auto-save in generation flow
  document.getElementById("toggleSaveOutputs")?.addEventListener("click", () => {
    State.saveOutputs = document.getElementById("toggleSaveOutputs")?.classList.contains("on") ?? true;
  });

  // Live preview → gate preview thumbnail during generation
  document.getElementById("toggleLivePreview")?.addEventListener("click", () => {
    State.livePreview = document.getElementById("toggleLivePreview")?.classList.contains("on") ?? true;
    if (!State.livePreview) {
      const wrap = document.getElementById("canvasPreviewWrap");
      if (wrap) wrap.style.display = "none";
    }
  });

  // Embed metadata in PNG
  document.getElementById("toggleMetadata")?.addEventListener("click", () => {
    const el = document.getElementById("toggleMetadata");
    State.embedMetadata = el?.classList.contains("on") ?? true;
  });

  // ===== UX-009: OUTPUT FORMAT SETTINGS =====

  const _fmtSelect = document.getElementById("settingSaveFormat");
  const _fmtJpeg = document.getElementById("fmtJpegOpts");
  const _fmtWebp = document.getElementById("fmtWebpOpts");

  function _syncFormatUI() {
    const fmt = _fmtSelect?.value || "png";
    State.saveFormat = fmt;
    if (_fmtJpeg) _fmtJpeg.style.display = fmt === "jpeg" ? "" : "none";
    if (_fmtWebp) _fmtWebp.style.display = fmt === "webp" ? "" : "none";
    // Sync quality to the active format's slider
    if (fmt === "jpeg") State.saveQuality = parseInt(_jpegSlider?.value) || 80;
    else if (fmt === "webp") State.saveQuality = parseInt(_webpSlider?.value) || 75;
  }

  _fmtSelect?.addEventListener("change", _syncFormatUI);

  // JPEG quality slider
  const _jpegSlider = document.getElementById("settingJpegQuality");
  const _jpegVal = document.getElementById("settingJpegQualityVal");
  _jpegSlider?.addEventListener("input", () => {
    if (_jpegVal) _jpegVal.textContent = _jpegSlider.value + "%";
    State.saveQuality = parseInt(_jpegSlider.value);
  });

  // WebP quality slider
  const _webpSlider = document.getElementById("settingWebpQuality");
  const _webpVal = document.getElementById("settingWebpQualityVal");
  _webpSlider?.addEventListener("input", () => {
    if (_webpVal) _webpVal.textContent = _webpSlider.value + "%";
    State.saveQuality = parseInt(_webpSlider.value);
  });

  // WebP lossless toggle
  const _webpLossless = document.getElementById("toggleWebpLossless");
  _webpLossless?.addEventListener("click", () => {
    const on = _webpLossless.classList.contains("on");
    State.saveLossless = on;
    const qRow = document.getElementById("webpQualityRow");
    if (qRow) qRow.style.display = on ? "none" : "";
  });

  // ===== UX-013: VRAM MANAGEMENT =====

  // Manual unload button
  document.getElementById("unloadModelBtn")?.addEventListener("click", async () => {
    showToast("Unloading model...", "info");
    try {
      const r = await API.unloadModel();
      if (r.ok) {
        StatusBar.setModelUnloaded();
        // Fetch VRAM separately — inline response from unload was unreliable
        const v = await API.vram().catch(() => null);
        if (v?.available) {
          StatusBar.setVRAM(v.allocated_gb, v.total_gb);
          showToast(`Model unloaded — VRAM: ${v.allocated_gb} / ${v.total_gb} GB`, "success");
        } else if (r.status === "already_unloaded") {
          showToast("Model already unloaded", "info");
        } else {
          showToast("Model unloaded from VRAM", "success");
        }
      } else {
        showToast("Unload failed", "error");
      }
    } catch (e) {
      showToast("Unload failed: " + e.message, "error");
    }
  });

  // GPU Weights slider — the displayed/saved value is GB for model weights.
  // Backend still expects "GB to reserve", so we invert at send time:
  //   reserveGB = totalGB - weightsGB
  // At weightsGB === 0 the slider shows "Auto" and we send a reset.
  const _vramSlider = document.getElementById("vramReserveSlider");
  const _vramSliderVal = document.getElementById("vramReserveVal");
  const _vramLabel = (v) => parseFloat(v) === 0 ? "Auto" : parseFloat(v).toFixed(1) + " GB";
  const _vramSendWeights = async (weightsGB) => {
    if (weightsGB === 0) {
      return fetch(API.base + "/studio/vram_reserve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gb: 0, reset: true }),
      }).then(res => res.json());
    }
    const totalGB = parseFloat(_vramSlider.dataset.totalGb || _vramSlider.max) || 0;
    const reserveGB = Math.max(0, totalGB - weightsGB);
    return fetch(API.base + "/studio/vram_reserve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gb: reserveGB }),
    }).then(res => res.json());
  };
  if (_vramSlider) {
    // New storage key — old "studio-vram-reserve" values meant the opposite
    // semantic, so ignore them and start at Auto until the user adjusts.
    const saved = localStorage.getItem("studio-vram-weights");
    if (saved) {
      _vramSlider.value = saved;
      if (_vramSliderVal) _vramSliderVal.textContent = _vramLabel(saved);
    }
    _vramSlider.addEventListener("input", () => {
      if (_vramSliderVal) _vramSliderVal.textContent = _vramLabel(_vramSlider.value);
    });
    _vramSlider.addEventListener("change", async () => {
      const gb = parseFloat(_vramSlider.value);
      localStorage.setItem("studio-vram-weights", String(gb));
      if (gb === 0) {
        try {
          await _vramSendWeights(0);
          showToast("GPU weights reset to Forge default", "success");
          _refreshVRAM();
        } catch (e) { showToast("GPU weights error: " + e.message, "error"); }
        return;
      }
      try {
        const r = await _vramSendWeights(gb);
        if (r.ok) {
          showToast(`GPU weights set to ${gb.toFixed(1)} GB`, "success");
          _refreshVRAM();
        } else {
          showToast("Failed to set GPU weights: " + (r.error || ""), "error");
        }
      } catch (e) {
        showToast("GPU weights error: " + e.message, "error");
      }
    });
    // Set slider max to actual VRAM (leave 0.5 GB headroom for safety) and
    // re-apply saved weights on boot once we know the total.
    API.vram().then(v => {
      if (v.available && v.total_gb > 0) {
        _vramSlider.dataset.totalGb = String(v.total_gb);
        const maxWeights = Math.max(1, Math.floor((v.total_gb - 0.5) * 4) / 4);
        _vramSlider.max = maxWeights;
        if (saved && parseFloat(saved) > 0) {
          _vramSendWeights(parseFloat(saved)).catch(() => {});
        }
      }
    }).catch(() => {});
  }

  // Auto-unload toggle
  const _autoUnloadToggle = document.getElementById("toggleAutoUnload");
  const _autoUnloadRow = document.getElementById("autoUnloadMinutesRow");
  const _autoUnloadSlider = document.getElementById("autoUnloadMinutes");
  const _autoUnloadVal = document.getElementById("autoUnloadMinutesVal");

  // Restore auto-unload settings from localStorage
  const _savedAutoUnload = localStorage.getItem("studio-auto-unload");
  if (_savedAutoUnload) {
    try {
      const au = JSON.parse(_savedAutoUnload);
      if (au.enabled) _autoUnloadToggle?.classList.add("on");
      if (_autoUnloadSlider && au.minutes) _autoUnloadSlider.value = au.minutes;
      if (_autoUnloadVal && au.minutes) _autoUnloadVal.textContent = au.minutes + " min";
      if (au.enabled && _autoUnloadRow) _autoUnloadRow.style.display = "";
      // Sync to server
      API.autoUnload({ enabled: !!au.enabled, minutes: au.minutes || 10 }).catch(() => {});
    } catch (_) {}
  }

  _autoUnloadToggle?.addEventListener("click", () => {
    const on = _autoUnloadToggle.classList.contains("on");
    if (_autoUnloadRow) _autoUnloadRow.style.display = on ? "" : "none";
    const minutes = parseInt(_autoUnloadSlider?.value) || 10;
    API.autoUnload({ enabled: on, minutes }).catch(() => {});
    localStorage.setItem("studio-auto-unload", JSON.stringify({ enabled: on, minutes }));
  });

  _autoUnloadSlider?.addEventListener("input", () => {
    const v = _autoUnloadSlider.value;
    if (_autoUnloadVal) _autoUnloadVal.textContent = v + " min";
  });
  _autoUnloadSlider?.addEventListener("change", () => {
    const minutes = parseInt(_autoUnloadSlider.value) || 10;
    const on = _autoUnloadToggle?.classList.contains("on") ?? false;
    API.autoUnload({ enabled: on, minutes }).catch(() => {});
    localStorage.setItem("studio-auto-unload", JSON.stringify({ enabled: on, minutes }));
  });

  // ===== UX-014: REMEMBER LAST SESSION =====

  // Restore toggle state from localStorage (this toggle is self-referential —
  // it must persist independently of the session data it controls)
  const _rememberToggle = document.getElementById("toggleRememberSession");
  if (localStorage.getItem("studio-remember-session") === "true") {
    _rememberToggle?.classList.add("on");
  }
  _rememberToggle?.addEventListener("click", () => {
    const on = _rememberToggle?.classList.contains("on") ?? false;
    localStorage.setItem("studio-remember-session", on ? "true" : "false");
    if (!on) {
      // User turned it off — clear saved session data
      localStorage.removeItem("studio-session-data");
    }
  });

  // ===== WORKFLOW DEFAULTS =====
  // Param IDs to save/restore, organized by category for UX-016.
  // type: "val" = .value, "check" = .classList.contains("checked"), "checkbox" = .checked, "on"/"active"/"open" = classList
  const DEFAULTS_CATEGORIES = {
    prompts: [
      ["paramPrompt", "val"], ["paramNeg", "val"],
    ],
    gen: [
      ["paramSampler", "val"], ["paramScheduler", "val"],
      ["paramSteps", "val"], ["paramCFG", "val"], ["paramDenoise", "val"],
      ["paramWidth", "val"], ["paramHeight", "val"],
      ["paramBatch", "val"], ["paramBatchSize", "val"],
      ["arRandBase", "checkbox"], ["arRandRatio", "checkbox"], ["arRandOrientation", "checkbox"],
      ["arBasePoolData", "val"], ["arRatioPoolData", "val"],
    ],
    hires: [
      ["checkHires", "check"], ["paramHrUpscaler", "val"], ["paramHrScale", "val"],
      ["paramHrSteps", "val"], ["paramHrDenoise", "val"], ["paramHrCFG", "val"],
      ["paramHrCheckpoint", "val"],
    ],
    ad: [
      ["checkAD", "check"],
      ["checkAD1", "check"], ["paramAD1Model", "val"],
      ["paramAD1Conf", "val"], ["paramAD1Denoise", "val"],
      ["paramAD1Blur", "val"], ["paramAD1Prompt", "val"],
      ["checkAD2", "check"], ["paramAD2Model", "val"],
      ["paramAD2Conf", "val"], ["paramAD2Denoise", "val"],
      ["paramAD2Blur", "val"], ["paramAD2Prompt", "val"],
      ["checkAD3", "check"], ["paramAD3Model", "val"],
      ["paramAD3Conf", "val"], ["paramAD3Denoise", "val"],
      ["paramAD3Blur", "val"], ["paramAD3Prompt", "val"],
    ],
    upscale: [
      ["paramUpscaleModel", "val"], ["paramUpscaleScale", "val"],
      ["checkUpscaleRefine", "check"],
      ["checkUpscaleAD", "check"],
    ],
    canvas: [
      ["toggleGrid", "on"],
      ["pressureBtn", "active"], ["pressureSizeBtn", "active"], ["pressureOpacityBtn", "active"],
      ["toggleSaveOutputs", "on"], ["toggleLivePreview", "on"],
      ["toggleMetadata", "on"],
      // Panel collapse state (Generate tab sections)
      ["panelSampling", "open"], ["panelCanvas", "open"], ["panelSeedBatch", "open"],
      ["panelSoftInpaint", "open"], ["panelHires", "open"],
      ["panelAD", "open"], ["panelUpscale", "open"], ["panelCN", "open"],
    ],
    format: [
      ["settingSaveFormat", "val"], ["settingJpegQuality", "val"], ["settingWebpQuality", "val"],
      ["toggleWebpLossless", "on"],
    ],
    brush: [
      ["paramBrushSize", "val"],
    ],
    inpaint: [
      ["paramInpaintArea", "val"], ["paramFill", "val"],
      ["paramMaskBlur", "val"], ["paramPadding", "val"],
    ],
  };

  // Flat array of all params (used by server defaults which always save everything)
  const DEFAULTS_PARAMS = Object.values(DEFAULTS_CATEGORIES).flat();

  // UX-016: Get enabled session categories from checkboxes
  function _getSessionCategories() {
    const cats = {};
    document.querySelectorAll(".session-cat").forEach(cb => {
      cats[cb.dataset.cat] = cb.checked;
    });
    return cats;
  }

  // UX-016: Get the filtered param list based on enabled categories
  function _getSessionParams() {
    const cats = _getSessionCategories();
    const params = [];
    for (const [cat, entries] of Object.entries(DEFAULTS_CATEGORIES)) {
      if (cats[cat] !== false) params.push(...entries); // default to included if checkbox not found
    }
    return params;
  }

  // UX-016: Show/hide category checkboxes + persist state
  const _sessionCatsDiv = document.getElementById("sessionCategories");

  function _syncSessionCatsVisibility() {
    const on = document.getElementById("toggleRememberSession")?.classList.contains("on") ?? false;
    if (_sessionCatsDiv) _sessionCatsDiv.style.display = on ? "" : "none";
  }

  // Restore category selections from localStorage
  try {
    const savedCats = JSON.parse(localStorage.getItem("studio-session-cats") || "{}");
    document.querySelectorAll(".session-cat").forEach(cb => {
      if (cb.dataset.cat in savedCats) cb.checked = savedCats[cb.dataset.cat];
    });
  } catch (_) {}

  // Persist category changes
  document.querySelectorAll(".session-cat").forEach(cb => {
    cb.addEventListener("change", () => {
      const cats = _getSessionCategories();
      localStorage.setItem("studio-session-cats", JSON.stringify(cats));
    });
  });

  // Show categories when master toggle is on
  _syncSessionCatsVisibility();
  document.getElementById("toggleRememberSession")?.addEventListener("click", _syncSessionCatsVisibility);

  // Session accordion toggle
  document.getElementById("sessionAccordionHeader")?.addEventListener("click", () => {
    const body = document.getElementById("sessionAccordionBody");
    const arrow = document.getElementById("sessionAccordionArrow");
    if (!body) return;
    const open = body.style.display === "none";
    body.style.display = open ? "" : "none";
    arrow?.classList.toggle("open", open);
  });

  // Helper: read params from DOM (shared by saveDefaults and session save)
  // paramList defaults to DEFAULTS_PARAMS (all params) for server defaults
  function _readParamsFromDOM(paramList) {
    const list = paramList || DEFAULTS_PARAMS;
    const data = {};
    for (const [id, type] of list) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (type === "check") data[id] = el.classList.contains("checked");
      else if (type === "on") data[id] = el.classList.contains("on");
      else if (type === "active") data[id] = el.classList.contains("active");
      else if (type === "open") data[id] = el.classList.contains("open");
      else if (type === "checkbox") data[id] = el.checked;
      else data[id] = el.value;
    }
    return data;
  }

  function saveDefaults() {
    const data = _readParamsFromDOM(); // All params for server defaults
    API.generate({ action: "save_defaults", defaults_data: data })
      .then(() => console.log("[Studio] Saved defaults:", Object.keys(data).length, "params"))
      .catch(e => console.warn("[Studio] Server defaults save failed:", e));
  }

  // Cached copy of the most recently resolved defaults (server or session).
  // Used by _studioReapplyDefaults so new Canvas tabs can pick up the
  // user's saved defaults without a network round-trip on every tab.
  let _resolvedDefaults = null;

  function loadDefaults() {
    return API.generate({ action: "load_defaults" }).then(resp => {
      const data = resp?.settings;
      if (data && Object.keys(data).length > 0 && !data.defaults_saved && !data.defaults_deleted) {
        _resolvedDefaults = data;
        _applyDefaults(data);
        console.log("[Studio] Loaded defaults from server:", Object.keys(data).length, "params");
        return true;
      }
      return false;
    }).catch(() => false);
  }

  function _applyDefaults(data) {
    for (const [id, type] of DEFAULTS_PARAMS) {
      if (!(id in data)) continue;
      const el = document.getElementById(id);
      if (!el) continue;
      if (type === "check") {
        if (data[id]) el.classList.add("checked");
        else el.classList.remove("checked");
      } else if (type === "on") {
        if (data[id]) el.classList.add("on");
        else el.classList.remove("on");
      } else if (type === "active") {
        if (data[id]) el.classList.add("active");
        else el.classList.remove("active");
      } else if (type === "open") {
        // Collapse panel state — sync both body and its sibling arrow
        if (data[id]) el.classList.add("open");
        else el.classList.remove("open");
        const arrow = el.previousElementSibling?.querySelector(".collapse-arrow");
        if (arrow) {
          if (data[id]) arrow.classList.add("open");
          else arrow.classList.remove("open");
        }
      } else if (type === "checkbox") {
        el.checked = data[id];
        el.dispatchEvent(new Event("change"));
      } else {
        el.value = data[id];
        // Stash intended value for async-populated dropdowns (AD models, etc.)
        el.dataset.pendingValue = data[id];
        if (el.tagName === 'SELECT' && el.value !== String(data[id])) {
          console.warn(`[Studio Defaults] "${id}": saved value "${data[id]}" not in dropdown — option may not exist`);
        }
      }
    }

    // Sync canvas size to restored width/height
    const w = parseInt(document.getElementById("paramWidth")?.value) || 768;
    const h = parseInt(document.getElementById("paramHeight")?.value) || 768;
    if (window.StudioCore) {
      window.StudioCore.resizeCanvas(w, h);
      if (window.StudioUI) {
        window.StudioUI.syncCanvasToViewport();
        window.StudioCore.zoomFit();
        window.StudioUI.redraw();
      }
    }
    StatusBar.setDimensions(w, h);

    // Sync toggle side-effects to restored state
    const gridOn = document.getElementById("toggleGrid")?.classList.contains("on") ?? true;
    if (window.StudioCore) window.StudioCore.state.showGrid = gridOn;
    _syncPressureState();
    State.saveOutputs = document.getElementById("toggleSaveOutputs")?.classList.contains("on") ?? true;
    State.livePreview = document.getElementById("toggleLivePreview")?.classList.contains("on") ?? true;
    State.embedMetadata = document.getElementById("toggleMetadata")?.classList.contains("on") ?? true;
    // Sync output format state
    _syncFormatUI();
    const jq = parseInt(document.getElementById("settingJpegQuality")?.value) || 80;
    const wq = parseInt(document.getElementById("settingWebpQuality")?.value) || 75;
    State.saveQuality = (State.saveFormat === "jpeg") ? jq : wq;
    // Sync slider labels to restored values (they don't fire input events on .value set)
    const jqLabel = document.getElementById("settingJpegQualityVal");
    if (jqLabel) jqLabel.textContent = jq + "%";
    const wqLabel = document.getElementById("settingWebpQualityVal");
    if (wqLabel) wqLabel.textContent = wq + "%";
    State.saveLossless = document.getElementById("toggleWebpLossless")?.classList.contains("on") ?? false;
    // Hide WebP quality row if lossless
    const wqRow = document.getElementById("webpQualityRow");
    if (wqRow) wqRow.style.display = State.saveLossless ? "none" : "";

    // Restore AR pools from hidden inputs
    _syncPoolsFromDOM();

    // Restore brush size to canvas state
    const restoredBrush = parseInt(document.getElementById("paramBrushSize")?.value);
    if (window.StudioCore && restoredBrush >= 1 && restoredBrush <= 100) {
      window.StudioCore.state.brushSize = restoredBrush;
      if (window.StudioUI?.syncCtxBar) window.StudioUI.syncCtxBar();
    }
  }

  // UX-014/016: Session memory — save/restore with category filtering
  function _saveSession() {
    const on = document.getElementById("toggleRememberSession")?.classList.contains("on") ?? false;
    if (!on) return;
    const params = _getSessionParams(); // Only save enabled categories
    const data = _readParamsFromDOM(params);
    try {
      localStorage.setItem("studio-session-data", JSON.stringify(data));
    } catch (e) {
      console.warn("[Studio] Session save failed:", e);
    }
  }

  function _loadSession() {
    const on = document.getElementById("toggleRememberSession")?.classList.contains("on") ?? false;
    if (!on) return false;
    try {
      const raw = localStorage.getItem("studio-session-data");
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (data && Object.keys(data).length > 0) {
        _resolvedDefaults = data;
        _applyDefaults(data);
        console.log("[Studio] Restored session:", Object.keys(data).length, "params");
        return true;
      }
    } catch (e) {
      console.warn("[Studio] Session load failed:", e);
    }
    return false;
  }

  // Re-apply the most recently resolved defaults to the current DOM.
  // No network — used by studio-docs.js when opening a new Canvas tab so
  // the user's defaults apply to fresh documents (Lars-reported bug).
  // Returns true if defaults were applied, false if nothing cached yet.
  window._studioReapplyDefaults = function () {
    if (!_resolvedDefaults || !Object.keys(_resolvedDefaults).length) return false;
    _applyDefaults(_resolvedDefaults);
    return true;
  };

  // Auto-save session on page unload
  window.addEventListener("beforeunload", _saveSession);

  document.getElementById("checkUpdateBtn")?.addEventListener("click", async () => {
    const btn = document.getElementById("checkUpdateBtn");
    const status = document.getElementById("updateCheckStatus");
    if (btn) btn.disabled = true;
    if (status) status.textContent = "Checking...";
    try {
      const data = await API.checkUpdate();
      if (data.error) { showToast(data.offline ? "Offline — cannot check for updates" : data.error, "error"); if (status) status.textContent = ""; }
      else if (data.update_available) { UpdateBanner.show(data); if (status) status.textContent = ""; }
      else { showToast("Forge Studio is up to date", "success"); if (status) status.textContent = "Up to date"; }
    } catch (e) { showToast("Update check failed: " + e.message, "error"); if (status) status.textContent = ""; }
    if (btn) btn.disabled = false;
  });
  document.getElementById("saveDefaults")?.addEventListener("click", () => {
    saveDefaults();
    showToast("Workflow defaults saved", "success");
  });
  document.getElementById("resetDefaults")?.addEventListener("click", () => {
    API.generate({ action: "delete_defaults" }).catch(() => {});
    showToast("Defaults cleared — reload for factory settings", "info");
  });

  // Expose for init() — priority: session memory → server defaults → factory
  window._studioLoadDefaults = async function() {
    // Try session memory first (if toggle is on)
    if (_loadSession()) return;
    // Fall back to server-saved defaults
    await loadDefaults();
  };

  // AD slot checkboxes
  document.querySelectorAll(".ad-slot-check").forEach(check => {
    check.addEventListener("click", (e) => {
      e.stopPropagation();
      check.classList.toggle("checked");
    });
  });

  // Upscale refine checkbox — gates the img2img refine pass
  document.getElementById("checkUpscaleRefine")?.addEventListener("click", (e) => {
    e.stopPropagation();
    e.currentTarget.classList.toggle("checked");
    _syncUpscaleADState();
  });

  // Upscale AD checkbox — gates AD during the refine pass
  document.getElementById("checkUpscaleAD")?.addEventListener("click", (e) => {
    e.stopPropagation();
    e.currentTarget.classList.toggle("checked");
  });

  _syncUpscaleADState();

  // CN unit checkboxes
  document.querySelectorAll(".cn-unit-check").forEach(check => {
    check.addEventListener("click", (e) => {
      e.stopPropagation();
      check.classList.toggle("checked");
    });
  });

  // Context bar — now handled by ctx-scrub system in canvas-ui.js

  // Layer selection
  document.getElementById("layersList")?.addEventListener("click", e => {
    const item = e.target.closest(".layer-item");
    if (!item) return;
    document.querySelectorAll(".layer-item").forEach(l => l.classList.remove("selected"));
    item.classList.add("selected");
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", e => {
    // Ctrl+Enter or Shift+Enter = Generate
    if ((e.ctrlKey || e.shiftKey) && e.key === "Enter") { e.preventDefault(); doGenerate(); }
    // Escape = Interrupt
    if (e.key === "Escape" && State.generating) { API.interrupt(); }
    // Ctrl+Z / Ctrl+Shift+Z handled by canvas-ui.js — not duplicated here
    // Ctrl+S = Export/Save canvas
    if (e.ctrlKey && e.key === "s") { e.preventDefault(); document.getElementById("layerSave")?.click(); }
  });

  // Update dimensions + resize canvas engine when width/height change
  ["paramWidth", "paramHeight"].forEach(id => {
    document.getElementById(id)?.addEventListener("change", () => {
      const w = parseInt(document.getElementById("paramWidth")?.value) || 768;
      const h = parseInt(document.getElementById("paramHeight")?.value) || 768;
      StatusBar.setDimensions(w, h);
      if (window.StudioCore) {
        window.StudioCore.resizeCanvas(w, h);
        // Trigger immediate visual update
        if (window.StudioUI) {
          window.StudioUI.syncCanvasToViewport();
          window.StudioCore.zoomFit();
          window.StudioUI.updateStatus();
          window.StudioUI.redraw();
        }
      }
      // Update canvas status display
      const cs = document.getElementById("canvasStatus");
      if (cs) cs.innerHTML = `${w} &times; ${h} &ensp; ${Math.round((window.StudioCore?.state?.zoom?.scale || 1) * 100)}%`;
    });
  });

  // ---- AR System: base size + ratio + orientation ----

  // Current AR state
  let arBase = 768;
  let arRatioW = 1, arRatioH = 1;

  function applyAR() {
    if (State.generating) return; // Block AR changes during generation
    // arBase is the short side. Compute long side from ratio.
    const ratioMax = Math.max(arRatioW, arRatioH);
    const ratioMin = Math.min(arRatioW, arRatioH);
    let shortSide = arBase;
    let longSide = Math.round(arBase * ratioMax / ratioMin);
    // Determine orientation from current width/height
    const curW = parseInt(document.getElementById("paramWidth")?.value) || 768;
    const curH = parseInt(document.getElementById("paramHeight")?.value) || 768;
    const isPortrait = curH > curW;
    let w, h;
    if (arRatioW === arRatioH) {
      w = shortSide; h = shortSide;
    } else if (isPortrait) {
      w = shortSide; h = longSide;
    } else {
      w = longSide; h = shortSide;
    }
    // Round to nearest 8
    w = Math.round(w / 8) * 8;
    h = Math.round(h / 8) * 8;
    document.getElementById("paramWidth").value = w;
    document.getElementById("paramHeight").value = h;
    StatusBar.setDimensions(w, h);
    if (window.StudioCore) {
      window.StudioCore.saveStructuralUndo("Aspect ratio");
      window.StudioCore.resizeCanvas(w, h);
      if (window.StudioUI) {
        window.StudioUI.syncCanvasToViewport();
        window.StudioCore.zoomFit();
        window.StudioUI.updateStatus();
        window.StudioUI.redraw();
      }
    }
    _updateHiresWarning();
  }

  /** Sync AR base and ratio button highlights to match given dimensions. */
  function _syncARToSize(w, h) {
    var shortSide = Math.min(w, h);
    var bases = [512, 640, 768, 896, 1024];
    var bestBase = bases.reduce(function(best, b) { return Math.abs(b - shortSide) < Math.abs(best - shortSide) ? b : best; });
    arBase = bestBase;
    document.querySelectorAll("#arBaseButtons [data-base]").forEach(function(b) {
      b.classList.toggle("active", parseInt(b.dataset.base) === bestBase);
    });
    var longSide = Math.max(w, h);
    var actualRatio = longSide / shortSide;
    var ratios = [
      { label: "1:1", val: 1 }, { label: "5:4", val: 5/4 }, { label: "4:3", val: 4/3 },
      { label: "3:2", val: 3/2 }, { label: "16:9", val: 16/9 }, { label: "2:1", val: 2 },
      { label: "2.39:1", val: 2.39 }
    ];
    var bestRatio = ratios.reduce(function(best, r) { return Math.abs(r.val - actualRatio) < Math.abs(best.val - actualRatio) ? r : best; });
    var parts = bestRatio.label.split(":").map(Number);
    arRatioW = parts[0]; arRatioH = parts[1];
    document.querySelectorAll("#arButtons [data-ar]").forEach(function(b) {
      b.classList.toggle("active", b.dataset.ar === bestRatio.label);
    });
  }
  // Expose for displayOnCanvas and load handlers
  window._syncARToSize = _syncARToSize;

  // ---- AR Randomize (backend-driven, per-image) ----
  // Pool state: which bases/ratios are eligible for randomization
  // Default: only the currently active selection is in the pool
  let arBasePool = new Set([512, 640, 768, 896, 1024]);
  let arRatioPool = new Set(["1:1", "5:4", "4:3", "3:2", "16:9", "2:1", "2.39:1"]);

  // Sync Sets → hidden inputs (for session save)
  function _syncPoolsToDOM() {
    const bp = document.getElementById("arBasePoolData");
    const rp = document.getElementById("arRatioPoolData");
    if (bp) bp.value = JSON.stringify([...arBasePool]);
    if (rp) rp.value = JSON.stringify([...arRatioPool]);
  }

  // Sync hidden inputs → Sets (for session restore)
  function _syncPoolsFromDOM() {
    try {
      const bp = document.getElementById("arBasePoolData");
      if (bp && bp.value) {
        const arr = JSON.parse(bp.value);
        if (Array.isArray(arr) && arr.length > 0) {
          arBasePool = new Set(arr.map(Number));
        }
      }
      const rp = document.getElementById("arRatioPoolData");
      if (rp && rp.value) {
        const arr = JSON.parse(rp.value);
        if (Array.isArray(arr) && arr.length > 0) {
          arRatioPool = new Set(arr);
        }
      }
    } catch(e) {
      console.warn("[Studio] Pool restore failed:", e);
    }
    _syncPoolVisuals();
  }

  function _isRandMode(type) {
    if (type === "base") return document.getElementById("arRandBase")?.checked;
    if (type === "ratio") return document.getElementById("arRandRatio")?.checked;
    return false;
  }

  function _syncPoolVisuals() {
    // Base buttons: multi-select pool indicators when randomize is on
    const randBase = _isRandMode("base");
    document.querySelectorAll("#arBaseButtons [data-base]").forEach(b => {
      const val = parseInt(b.dataset.base);
      if (randBase) {
        const inPool = arBasePool.has(val);
        b.classList.toggle("in-pool", inPool);
        b.classList.toggle("dimmed", !inPool);  // B-001
        b.classList.remove("active");
      } else {
        b.classList.remove("in-pool", "dimmed");
        b.classList.toggle("active", val === arBase);
      }
    });

    // Ratio buttons: multi-select pool indicators when randomize is on
    const randRatio = _isRandMode("ratio");
    const randOrient = document.getElementById("arRandOrientation")?.checked;
    document.querySelectorAll("#arButtons [data-ar]").forEach(b => {
      const ar = b.dataset.ar;
      if (randRatio) {
        const inPool = arRatioPool.has(ar);
        b.classList.toggle("in-pool", inPool);
        b.classList.toggle("dimmed", !inPool);  // B-002
        b.classList.remove("active");
      } else {
        b.classList.remove("in-pool", "dimmed");
        const parts = ar.split(":").map(Number);
        b.classList.toggle("active", parts[0] === arRatioW && parts[1] === arRatioH);
      }
      // Orientation randomize: replace colon with ↔ to indicate either orientation
      if (randOrient && ar !== "1:1") {
        const base = b.textContent.replace(" \u21c4", "").replace("\u21c4", ":");
        b.textContent = base.replace(":", "\u21c4");
      } else if (b.textContent.includes("\u21c4")) {
        b.textContent = b.textContent.replace("\u21c4", ":");
      }
    });

    // Toggle randomize row styling
    const anyRand = _isRandMode("base") || _isRandMode("ratio") ||
                    document.getElementById("arRandOrientation")?.checked;
    document.getElementById("arRandomizeRow")?.classList.toggle("ar-rand-active", anyRand);

    // Keep hidden inputs in sync for session save
    _syncPoolsToDOM();
  }

  // Randomize checkbox change handlers — switch button mode
  ["arRandBase", "arRandRatio", "arRandOrientation"].forEach(id => {
    document.getElementById(id)?.addEventListener("change", () => {
      _syncPoolVisuals();
    });
  });

  // Override base button behavior: single-select (normal) vs multi-select (pool)
  document.getElementById("arBaseButtons")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-base]");
    if (!btn) return;
    const val = parseInt(btn.dataset.base);
    if (_isRandMode("base")) {
      // Pool toggle mode
      if (arBasePool.has(val)) {
        if (arBasePool.size > 1) arBasePool.delete(val);  // keep at least one
      } else {
        arBasePool.add(val);
      }
      _syncPoolVisuals();
    } else {
      // Normal single-select
      arBase = val;
      document.querySelectorAll("#arBaseButtons [data-base]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      applyAR();
    }
  });

  // Override ratio button behavior: single-select vs multi-select
  document.getElementById("arButtons")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-ar]");
    if (!btn) return;
    const ar = btn.dataset.ar;
    if (_isRandMode("ratio")) {
      // Pool toggle mode
      if (arRatioPool.has(ar)) {
        if (arRatioPool.size > 1) arRatioPool.delete(ar);
      } else {
        arRatioPool.add(ar);
      }
      _syncPoolVisuals();
    } else {
      // Normal single-select
      const parts = ar.split(":").map(Number);
      // FR-004: Re-clicking the active ratio swaps portrait/landscape
      if (parts[0] === arRatioW && parts[1] === arRatioH && arRatioW !== arRatioH) {
        // Trigger swap
        const wEl = document.getElementById("paramWidth");
        const hEl = document.getElementById("paramHeight");
        if (wEl && hEl) {
          const tmp = wEl.value; wEl.value = hEl.value; hEl.value = tmp;
          const w = parseInt(wEl.value), h = parseInt(hEl.value);
          StatusBar.setDimensions(w, h);
          // Label reflects resulting orientation
          const sep = document.getElementById("arRandOrientation")?.checked ? "\u21c4" : ":";
          btn.textContent = (h > w) ? parts[1] + sep + parts[0] : parts[0] + sep + parts[1];
          if (window.StudioCore) {
            window.StudioCore.saveStructuralUndo("Aspect ratio");
            window.StudioCore.resizeCanvas(w, h);
            if (window.StudioUI) {
              window.StudioUI.syncCanvasToViewport();
              window.StudioCore.zoomFit();
              window.StudioUI.updateStatus();
              window.StudioUI.redraw();
            }
          }
        }
        return;
      }
      arRatioW = parts[0];
      arRatioH = parts[1];
      document.querySelectorAll("#arButtons [data-ar]").forEach(b => {
        b.classList.remove("active");
      });
      btn.textContent = ar; // Reset this button to canonical on fresh select
      btn.classList.add("active");
      applyAR();
    }
  });

  // Build AR config for generation request
  function getARConfig() {
    const randBase = document.getElementById("arRandBase")?.checked || false;
    const randRatio = document.getElementById("arRandRatio")?.checked || false;
    const randOrient = document.getElementById("arRandOrientation")?.checked || false;
    if (!randBase && !randRatio && !randOrient) return null;
    return {
      ar_rand_base: randBase,
      ar_rand_ratio: randRatio,
      ar_rand_orientation: randOrient,
      ar_base_pool: randBase ? [...arBasePool] : [],
      ar_ratio_pool: randRatio ? [...arRatioPool] : [],
    };
  }
  window.getARConfig = getARConfig;

  // HiRes warning: update when dimensions or scale change
  ["paramWidth", "paramHeight", "paramHrScale"].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("change", _updateHiresWarning);
  });

  // Clear canvas
  document.getElementById("clearCanvas")?.addEventListener("click", () => {
    if (State.generating) return;
    if (!window.StudioCore) return;
    const S = window.StudioCore.state;
    // Clear all paint layers
    for (const L of S.layers) {
      if (L.type === "paint") {
        L.ctx.clearRect(0, 0, S.W, S.H);
      }
      if (L.type === "reference") {
        L.ctx.fillStyle = "#ffffff";
        L.ctx.fillRect(0, 0, S.W, S.H);
      }
    }
    // Clear mask
    if (S.mask?.ctx) S.mask.ctx.clearRect(0, 0, S.W, S.H);
    window.StudioCore.composite();
    showToast("Canvas cleared", "info");
  });

  // --- Load Image button ---
  document.getElementById("loadImageBtn")?.addEventListener("click", () => {
    document.getElementById("loadImageInput")?.click();
  });
  document.getElementById("loadImageInput")?.addEventListener("change", e => {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith("image/") || !window.StudioCore) return;
    const Core = window.StudioCore;

    // Read PNG metadata in parallel with image decode
    const metaPromise = (file.type === "image/png" && window.PngMetadata)
      ? PngMetadata.read(file).catch(() => ({}))
      : Promise.resolve({});

    const r = new FileReader();
    r.onload = ev => {
      const img = new Image();
      img.onload = async () => {
        const newW = img.naturalWidth;
        const newH = img.naturalHeight;
        Core.saveStructuralUndo("Load image");
        Core.resizeCanvas(newW, newH);
        const wInput = document.getElementById("paramWidth");
        const hInput = document.getElementById("paramHeight");
        if (wInput) wInput.value = newW;
        if (hInput) hInput.value = newH;
        if (window._syncARToSize) window._syncARToSize(newW, newH);

        const S = Core.state;
        const newL = Core.makeLayer("Loaded", "paint");
        newL.ctx.drawImage(img, 0, 0, newW, newH);
        S.layers.splice(S.activeLayerIdx + 1, 0, newL);
        S.activeLayerIdx++;
        if (window.StudioUI) {
          window.StudioUI.renderLayerPanel();
          window.StudioUI.syncCanvasToViewport();
          Core.zoomFit();
        }
        Core.composite();

        // Apply metadata to UI fields if present
        const meta = await metaPromise;
        if (meta.parameters) {
          _applyInfotextToUI(meta.parameters);
          showToast(`Loaded ${newW}\u00d7${newH} (params imported)`, "success");
        } else {
          showToast(`Loaded ${newW}\u00d7${newH}`, "success");
        }

        // Auto-disable Hires Fix — loaded images are already at native
        // resolution, so hires would double their size unexpectedly.
        _disableHiresFix();
      };
      img.src = ev.target.result;
    };
    r.readAsDataURL(file);
    e.target.value = "";
  });

  // --- Smoothing slider — now handled by ctx-scrub in canvas-ui.js ---

  // --- ControlNet upload ---
  // State: store base64 data for each CN unit upload
  window._cnUploadData = { 1: null, 2: null };

  [1, 2].forEach(n => {
    const sourceSelect = document.getElementById(`paramCN${n}Source`);
    const uploadRow = document.getElementById(`cnUpload${n}`);
    const uploadBtn = document.getElementById(`cnUploadBtn${n}`);
    const uploadInput = document.getElementById(`cnUploadInput${n}`);
    const uploadThumb = document.getElementById(`cnUploadThumb${n}`);
    const uploadClear = document.getElementById(`cnUploadClear${n}`);

    // Show/hide upload row when source changes
    sourceSelect?.addEventListener("change", () => {
      if (uploadRow) uploadRow.style.display = sourceSelect.value === "Upload" ? "flex" : "none";
    });

    // Click "Choose Image" button
    uploadBtn?.addEventListener("click", () => uploadInput?.click());

    // File selected
    uploadInput?.addEventListener("change", e => {
      const file = e.target.files?.[0];
      if (!file || !file.type.startsWith("image/")) return;
      const r = new FileReader();
      r.onload = ev => {
        const b64 = ev.target.result;
        window._cnUploadData[n] = b64.split(",")[1]; // strip data:image/...;base64, prefix
        if (uploadThumb) { uploadThumb.src = b64; uploadThumb.style.display = "block"; }
        if (uploadClear) uploadClear.style.display = "inline-block";
        if (uploadBtn) uploadBtn.textContent = file.name.length > 20 ? file.name.slice(0, 17) + "..." : file.name;
      };
      r.readAsDataURL(file);
      e.target.value = "";
    });

    // Clear upload
    uploadClear?.addEventListener("click", () => {
      window._cnUploadData[n] = null;
      if (uploadThumb) { uploadThumb.src = ""; uploadThumb.style.display = "none"; }
      if (uploadClear) uploadClear.style.display = "none";
      if (uploadBtn) uploadBtn.textContent = "Choose Image...";
    });
  });
}


// ═══════════════════════════════════════════
// EXTENSION BRIDGE — Frontend
// ═══════════════════════════════════════════

const ExtensionBridge = {
  manifest: [],
  _disabled: new Set(),

  async load() {
    const container = document.getElementById("extensionsContent");
    const loading = document.getElementById("extLoading");

    // Restore disabled state
    try {
      const saved = JSON.parse(localStorage.getItem("studio-ext-disabled") || "[]");
      saved.forEach(n => this._disabled.add(n));
    } catch(e) {}

    try {
      const resp = await fetch(API.base + "/studio/extensions");
      this.manifest = await resp.json();
    } catch (e) {
      console.warn("[Studio] Extension manifest fetch failed:", e);
      if (loading) loading.textContent = "Could not load extensions";
      return;
    }

    this._renderExtensionsTab();
    this._renderSettingsToggles();
    console.log(`[Studio] Extension bridge: ${this.manifest.length} extensions, ${this._disabled.size} disabled`);
  },

  _renderExtensionsTab() {
    const container = document.getElementById("extensionsContent");
    const enabled = this.manifest.filter(ext => !this._disabled.has(ext.name));

    if (!enabled.length) {
      container.innerHTML = this.manifest.length
        ? '<div class="ext-empty">All extensions disabled — enable them in Settings</div>'
        : '<div class="ext-empty">No bridgeable extensions found</div>';
      return;
    }

    container.innerHTML = "";
    for (const ext of enabled) {
      const group = document.createElement("div");
      group.className = "ext-group";
      group.dataset.extName = ext.name;
      const titleDisplay = ext.blueprint?.icon
        ? `${ext.blueprint.icon} ${ext.blueprint.title || ext.title}`
        : ext.title;
      group.innerHTML = `
        <div class="ext-group-header">
          <span>${titleDisplay}</span>
          <span class="ext-chevron">&#9654;</span>
        </div>
        <div class="ext-group-body">${this._renderControls(ext)}</div>
      `;
      group.querySelector(".ext-group-header").addEventListener("click", () => {
        group.classList.toggle("open");
      });
      container.appendChild(group);

      // Blueprint path vs AutoBridge path
      if (ext.blueprint) {
        this._wireBlueprintDependencies(group, ext);
        this._initHooks(ext, group); // async, fire-and-forget
      } else {
        this._wireDependencies(group, ext);
      }

      // Bind accordion toggles inside the extension
      group.querySelectorAll(".ext-accordion-header").forEach(hdr => {
        hdr.addEventListener("click", () => {
          hdr.parentElement.classList.toggle("open");
        });
      });
    }
  },

  _renderSettingsToggles() {
    const container = document.getElementById("extToggles");
    if (!container || !this.manifest.length) {
      if (container) container.innerHTML = '<span class="setting-label">No extensions available</span>';
      return;
    }

    container.innerHTML = "";
    for (const ext of this.manifest) {
      const isOn = !this._disabled.has(ext.name);
      const row = document.createElement("div");
      row.className = "setting-row";
      row.innerHTML = `
        <span class="setting-label">${ext.title}</span>
        <div class="toggle-track ${isOn ? "on" : ""}" data-ext-name="${ext.name}">
          <div class="toggle-knob"></div>
        </div>
      `;
      row.querySelector(".toggle-track").addEventListener("click", (e) => {
        const track = e.currentTarget;
        const name = track.dataset.extName;
        if (this._disabled.has(name)) {
          this._disabled.delete(name);
          track.classList.add("on");
        } else {
          this._disabled.add(name);
          track.classList.remove("on");
        }
        localStorage.setItem("studio-ext-disabled", JSON.stringify([...this._disabled]));
        this._renderExtensionsTab();
      });
      container.appendChild(row);
    }
  },

  _renderControls(ext) {
    // Blueprint Bridge — explicit layout takes priority over everything
    if (ext.blueprint?.layout) {
      return this._renderBlueprintLayout(ext.blueprint.layout, ext);
    }

    // If we have an inferred layout tree, render it. Otherwise fall back to flat.
    if (ext.layout) {
      const treeHtml = this._renderTree(ext.layout, ext);
      // Emit hidden inputs for any controls NOT in the tree
      // (invisible sync inputs like preview_steps)
      const treeIndices = new Set();
      this._collectTreeIndices(ext.layout, treeIndices);
      let hiddenHtml = "";
      for (const c of (ext.controls || [])) {
        if (!treeIndices.has(c.index)) {
          hiddenHtml += `<input type="hidden" data-arg-index="${c.index}" value="${c.value ?? ""}">`;
        }
      }
      return treeHtml + hiddenHtml;
    }

    // Flat fallback — group containers for visibility-toggled controls
    const controls = ext.controls || [];
    const groups = ext.groups || [];
    let html = "";
    let openGroupId = null;

    for (const c of controls) {
      const gid = c.group;
      if (openGroupId !== null && openGroupId !== undefined && gid !== openGroupId) {
        html += "</div>";
        openGroupId = null;
      }
      if (gid != null && gid !== openGroupId) {
        const grp = groups.find(g => g.id === gid);
        const vis = grp ? grp.visible : true;
        html += `<div class="ext-vis-group" data-group-id="${gid}"${vis ? "" : ' style="display:none"'}>`;
        openGroupId = gid;
      }
      html += this._renderControlHTML(c);
    }
    if (openGroupId !== null && openGroupId !== undefined) {
      html += "</div>";
    }
    return html;
  },

  /** Collect all control indices present in a layout tree. */
  _collectTreeIndices(nodes, set) {
    for (const node of nodes) {
      if (node.index != null) {
        set.add(node.index);
      } else if (node.children) {
        this._collectTreeIndices(node.children, set);
      }
    }
  },

  /** Recursively render a layout tree into HTML. */
  _renderTree(nodes, ext) {
    return nodes.map(node => {
      // Leaf node — render the control
      if (node.index != null) {
        const c = (ext.controls || []).find(ctrl => ctrl.index === node.index);
        return c ? this._renderControlHTML(c) : "";
      }

      // Container node — render children recursively
      const inner = node.children ? this._renderTree(node.children, ext) : "";
      if (!inner) return "";

      switch (node.type) {
        case "accordion":
          return `<div class="ext-accordion${node.open ? " open" : ""}">
            <div class="ext-accordion-header">
              <span>${node.label || ""}</span>
              <span class="ext-accordion-chevron">&#9654;</span>
            </div>
            <div class="ext-accordion-body">${inner}</div>
          </div>`;

        case "row":
          return `<div class="ext-row">${inner}</div>`;

        case "column":
        case "group":
          // Visibility-toggled group
          if (node.group != null) {
            const vis = node.visible !== false;
            return `<div class="ext-vis-group" data-group-id="${node.group}"${vis ? "" : ' style="display:none"'}>${inner}</div>`;
          }
          // Labeled section
          if (node.label) {
            return `<div class="ext-section">
              <div class="ext-section-label">${node.label}</div>
              ${inner}
            </div>`;
          }
          // Unlabeled — pass through
          return inner;

        default:
          return inner;
      }
    }).join("");
  },

  /** Render a single control as HTML. */
  _renderControlHTML(c) {
    // Non-renderable types
    if (c.type === "state" || c.type === "html" || c.type === "markdown" ||
        c.type === "button" || c.type === "gallery" || c.type === "plot" ||
        c.type === "unknown") return "";

    // Invisible controls — hidden input for value collection
    if (!c.visible) {
      return `<input type="hidden" data-arg-index="${c.index}" value="${c.value ?? ""}">`;
    }

    const label = c.label || "";
    const idx = c.index;

    switch (c.type) {
      case "slider":
        return `<div class="ext-control">
          <div class="ext-control-label">${label}</div>
          <div class="ext-slider-row">
            <input type="range" data-arg-index="${idx}"
              min="${c.minimum ?? 0}" max="${c.maximum ?? 100}"
              step="${c.step ?? 1}" value="${c.value ?? 0}"
              oninput="this.nextElementSibling.textContent=this.value">
            <span class="ext-slider-val">${c.value ?? 0}</span>
          </div>
        </div>`;

      case "checkbox":
        return `<div class="ext-control">
          <div class="ext-control-checkbox">
            <input type="checkbox" id="ext_${idx}" data-arg-index="${idx}"
              ${c.value ? "checked" : ""}>
            <label for="ext_${idx}">${label}</label>
          </div>
        </div>`;

      case "dropdown": {
        const opts = (c.choices || []).map(ch => {
          const val = Array.isArray(ch) ? ch[0] : ch;
          const display = Array.isArray(ch) ? ch[1] : ch;
          const curVal = Array.isArray(c.value) ? c.value[0] : c.value;
          return `<option value="${val}" ${val === curVal ? "selected" : ""}>${display}</option>`;
        }).join("");
        return `<div class="ext-control">
          <div class="ext-control-label">${label}</div>
          <select data-arg-index="${idx}">${opts}</select>
        </div>`;
      }

      case "radio": {
        const radios = (c.choices || []).map((ch, i) => {
          const val = Array.isArray(ch) ? ch[0] : ch;
          const display = Array.isArray(ch) ? ch[1] : ch;
          const curVal = Array.isArray(c.value) ? c.value[0] : c.value;
          return `<label style="display:flex;align-items:center;gap:6px;padding:2px 0;cursor:pointer;font-size:11px;color:var(--text-2);">
            <input type="radio" name="ext_radio_${idx}" value="${val}"
              data-arg-index="${idx}" ${val === curVal ? "checked" : ""}
              style="accent-color:var(--accent);cursor:pointer;">
            ${display}
          </label>`;
        }).join("");
        return `<div class="ext-control">
          <div class="ext-control-label">${label}</div>
          ${radios}
        </div>`;
      }

      case "number":
        return `<div class="ext-control">
          <div class="ext-control-label">${label}</div>
          <input type="number" data-arg-index="${idx}"
            value="${c.value ?? 0}"
            ${c.minimum != null ? `min="${c.minimum}"` : ""}
            ${c.maximum != null ? `max="${c.maximum}"` : ""}
            ${c.step != null ? `step="${c.step}"` : ""}>
        </div>`;

      case "textbox":
        return `<div class="ext-control">
          <div class="ext-control-label">${label}</div>
          <input type="text" data-arg-index="${idx}"
            value="${c.value ?? ""}"
            ${c.placeholder ? `placeholder="${c.placeholder}"` : ""}>
        </div>`;

      default:
        return "";
    }
  },

  // ═══════════════════════════════════════════
  // BLUEPRINT BRIDGE — Layout, Dependencies, Hooks
  // ═══════════════════════════════════════════

  /** Render controls from a blueprint layout tree. */
  _renderBlueprintLayout(layout, ext) {
    let html = layout.map(node => this._renderBlueprintNode(node, ext)).join("");

    // Hidden inputs for args not explicitly in the layout
    const inLayout = new Set();
    this._collectBlueprintArgs(layout, inLayout);
    for (const c of (ext.controls || [])) {
      const rel = c.index - ext.args_from;
      if (!inLayout.has(rel)) {
        html += `<input type="hidden" data-arg-index="${c.index}" value="${c.value ?? ""}">`;
      }
    }

    // Hook target placeholder
    if (ext.blueprint?.hooks) {
      html += `<div class="ext-hook-target" data-ext-name="${ext.name}"></div>`;
    }
    return html;
  },

  /** Render a single blueprint layout node (recursive). */
  _renderBlueprintNode(node, ext) {
    // Control leaf — arg index is relative to extension
    if (node.arg != null) {
      const absIdx = ext.args_from + node.arg;
      const c = (ext.controls || []).find(ctrl => ctrl.index === absIdx);
      if (!c) return "";
      // Blueprint overrides probed values
      const merged = { ...c };
      if (node.label) merged.label = node.label;
      if (node.type && node.type !== "html") merged.type = node.type;
      if (node.min != null) merged.minimum = node.min;
      if (node.max != null) merged.maximum = node.max;
      if (node.step != null) merged.step = node.step;
      if (node.choices) merged.choices = node.choices;
      return this._renderControlHTML(merged);
    }

    // Container node
    const inner = (node.children || []).map(ch => this._renderBlueprintNode(ch, ext)).join("");

    switch (node.type) {
      case "section":
        return `<div class="ext-section"><div class="ext-section-label">${node.label || ""}</div>${inner}</div>`;
      case "row":
        return `<div class="ext-row">${inner}</div>`;
      case "accordion":
        return `<div class="ext-accordion${node.open ? " open" : ""}">
          <div class="ext-accordion-header"><span>${node.label || ""}</span><span class="ext-accordion-chevron">&#9654;</span></div>
          <div class="ext-accordion-body">${inner}</div>
        </div>`;
      case "group": {
        const vis = node.visible !== false;
        return `<div class="ext-vis-group" data-group-id="${node.id || ""}"${vis ? "" : ' style="display:none"'}>${inner}</div>`;
      }
      case "html":
        return `<div class="ext-control">${node.html || ""}</div>`;
      default:
        return inner;
    }
  },

  /** Collect all relative arg indices present in a blueprint layout tree. */
  _collectBlueprintArgs(nodes, set) {
    for (const node of nodes) {
      if (node.arg != null) set.add(node.arg);
      if (node.children) this._collectBlueprintArgs(node.children, set);
    }
  },

  /** Wire blueprint dependencies (relative arg indices, named group IDs). */
  _wireBlueprintDependencies(extElement, ext) {
    const deps = ext.blueprint?.dependencies;
    if (!deps?.length) return;

    for (const dep of deps) {
      const absIdx = ext.args_from + dep.trigger;
      const triggerEl = extElement.querySelector(`[data-arg-index="${absIdx}"]`);
      if (!triggerEl) continue;

      const applyEffects = () => {
        const val = triggerEl.type === "checkbox"
          ? (triggerEl.checked ? "true" : "false")
          : triggerEl.value;
        const fx = dep.effects?.[val];
        if (!fx) return;

        if (fx.show_groups) {
          for (const gid of fx.show_groups) {
            const g = extElement.querySelector(`[data-group-id="${gid}"]`);
            if (g) g.style.display = "";
          }
        }
        if (fx.hide_groups) {
          for (const gid of fx.hide_groups) {
            const g = extElement.querySelector(`[data-group-id="${gid}"]`);
            if (g) g.style.display = "none";
          }
        }
      };

      triggerEl.addEventListener("change", applyEffects);
      applyEffects(); // apply initial state
    }
  },

  /** Load and initialize hooks module for a blueprinted extension. */
  async _initHooks(ext, groupElement) {
    const hooksUrl = ext.blueprint?.hooks_url;
    if (!hooksUrl) return;

    try {
      const module = await import(hooksUrl);
      const hooks = module.default;
      if (!hooks) return;

      // Build control map: relative arg index → DOM element
      const controlMap = {};
      for (const c of (ext.controls || [])) {
        const rel = c.index - ext.args_from;
        const el = groupElement.querySelector(`[data-arg-index="${c.index}"]`);
        if (el) controlMap[rel] = el;
      }

      // Find hook target (or fall back to the group body)
      const target = groupElement.querySelector(`.ext-hook-target[data-ext-name="${ext.name}"]`)
        || groupElement.querySelector(".ext-group-body");

      // onRender
      if (hooks.onRender) {
        hooks.onRender(target, controlMap, ext);
      }

      // Wire onChange to all controls in this extension
      if (hooks.onChange) {
        for (const [relIdx, el] of Object.entries(controlMap)) {
          const handler = () => {
            hooks.onChange(parseInt(relIdx), el.type === "checkbox" ? el.checked : el.value, controlMap, target);
          };
          el.addEventListener("input", handler);
          el.addEventListener("change", handler);
        }
      }

      // Store hooks ref for potential future use (onCollect, etc.)
      ext._hooks = hooks;
      console.log(`[Studio Bridge] Hooks loaded for ${ext.blueprint?.title || ext.title}`);
    } catch (e) {
      console.warn(`[Studio Bridge] Hooks failed for ${ext.title}:`, e);
    }
  },

  /** Wire all dependencies — visibility, value propagation, choices updates. */
  _wireDependencies(extElement, ext) {
    if (!ext.dependencies?.length) return;

    for (const dep of ext.dependencies) {
      const triggerCtrl = ext.controls.find(c => c.index === dep.trigger);
      if (!triggerCtrl) continue;

      const applyEffects = () => {
        let val = null;

        if (triggerCtrl.type === "dropdown") {
          const sel = extElement.querySelector(`select[data-arg-index="${dep.trigger}"]`);
          if (sel) val = sel.value;
        } else if (triggerCtrl.type === "radio") {
          extElement.querySelectorAll(`input[name="ext_radio_${dep.trigger}"]`)
            .forEach(r => { if (r.checked) val = r.value; });
        } else if (triggerCtrl.type === "checkbox") {
          const cb = extElement.querySelector(`input[data-arg-index="${dep.trigger}"]`);
          if (cb) val = cb.checked ? "true" : "false";
        }

        if (val == null || !dep.effects[val]) return;
        const fx = dep.effects[val];

        // Group visibility
        if (fx.show_groups) {
          for (const gid of fx.show_groups) {
            const el = extElement.querySelector(`[data-group-id="${gid}"]`);
            if (el) el.style.display = "";
          }
        }
        if (fx.hide_groups) {
          for (const gid of fx.hide_groups) {
            const el = extElement.querySelector(`[data-group-id="${gid}"]`);
            if (el) el.style.display = "none";
          }
        }

        // Value propagation — set control values
        if (fx.set_values) {
          for (const [idx, newVal] of Object.entries(fx.set_values)) {
            const el = extElement.querySelector(`[data-arg-index="${idx}"]`);
            if (!el) continue;

            if (el.type === "checkbox") {
              el.checked = !!newVal;
            } else if (el.type === "range") {
              el.value = newVal;
              // Update the display span
              const span = el.nextElementSibling;
              if (span?.classList.contains("ext-slider-val")) {
                span.textContent = newVal;
              }
            } else if (el.type === "radio") {
              // For radio groups, find the matching one
              extElement.querySelectorAll(`input[name="${el.name}"]`)
                .forEach(r => { r.checked = (r.value === String(newVal)); });
            } else {
              el.value = newVal;
            }
          }
        }

        // Choices updates — swap dropdown options
        if (fx.set_choices) {
          for (const [idx, choices] of Object.entries(fx.set_choices)) {
            const sel = extElement.querySelector(`select[data-arg-index="${idx}"]`);
            if (!sel || !Array.isArray(choices)) continue;
            const currentVal = sel.value;
            sel.innerHTML = choices.map(ch =>
              `<option value="${ch}" ${ch === currentVal ? "selected" : ""}>${ch}</option>`
            ).join("");
          }
        }

        // Individual control visibility
        if (fx.set_visible) {
          for (const [idx, vis] of Object.entries(fx.set_visible)) {
            const el = extElement.querySelector(`[data-arg-index="${idx}"]`);
            if (!el) continue;
            const wrapper = el.closest(".ext-control");
            if (wrapper) wrapper.style.display = vis ? "" : "none";
          }
        }
      };

      // Bind to the trigger control
      if (triggerCtrl.type === "dropdown") {
        const sel = extElement.querySelector(`select[data-arg-index="${dep.trigger}"]`);
        if (sel) sel.addEventListener("change", applyEffects);
      } else if (triggerCtrl.type === "radio") {
        extElement.querySelectorAll(`input[name="ext_radio_${dep.trigger}"]`)
          .forEach(r => r.addEventListener("change", applyEffects));
      } else if (triggerCtrl.type === "checkbox") {
        const cb = extElement.querySelector(`input[data-arg-index="${dep.trigger}"]`);
        if (cb) cb.addEventListener("change", applyEffects);
      }
    }
  },

  collectArgs() {
    // Build set of arg indices belonging to disabled extensions
    const disabledIndices = new Set();
    for (const ext of this.manifest) {
      if (this._disabled.has(ext.name)) {
        for (let i = ext.args_from; i < ext.args_to; i++) disabledIndices.add(String(i));
      }
    }

    const args = {};
    document.querySelectorAll("[data-arg-index]").forEach(el => {
      const idx = el.dataset.argIndex;
      if (disabledIndices.has(idx)) return; // Skip disabled extensions
      if (el.type === "checkbox") {
        args[idx] = el.checked;
      } else if (el.type === "radio") {
        if (el.checked) args[idx] = el.value;
      } else if (el.type === "range" || el.type === "number") {
        const v = parseFloat(el.value);
        const step = parseFloat(el.step);
        args[idx] = (step && step % 1 === 0) ? parseInt(el.value) : v;
      } else {
        args[idx] = el.value;
      }
    });
    return Object.keys(args).length ? args : null;
  }
};


// ═══════════════════════════════════════════
// THEME SWITCHER
// ═══════════════════════════════════════════

const ThemeSwitcher = {
  init() {
    // Restore saved theme
    const saved = localStorage.getItem("studio-theme") || "";
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    this._updateButtons(saved);

    // Bind clicks
    document.getElementById("themeSelector")?.addEventListener("click", e => {
      const btn = e.target.closest(".theme-btn");
      if (!btn) return;
      const theme = btn.dataset.theme;
      if (theme) {
        document.documentElement.setAttribute("data-theme", theme);
      } else {
        document.documentElement.removeAttribute("data-theme");
      }
      localStorage.setItem("studio-theme", theme);
      this._updateButtons(theme);
      // Invalidate canvas background cache so it picks up the new --bg-void
      if (window.StudioCore?.state) {
        window.StudioCore.state._voidColor = null;
        // Force immediate redraw
        if (typeof window.StudioCore.composite === "function") window.StudioCore.composite();
      }
    });
  },

  _updateButtons(active) {
    document.querySelectorAll(".theme-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.theme === active);
    });
  }
};


// v6.10: Refine and AD are now truly independent — AD can run standalone
// on the ESRGAN output without a base img2img pass. Keep the function as
// a no-op so existing callers don't break, and leave the row always live.
function _syncUpscaleADState() {
  const row = document.getElementById("upscaleADRow");
  if (row) row.classList.remove("disabled");
}


// ═══════════════════════════════════════════
// VRAM MONITORING
// ═══════════════════════════════════════════

async function _refreshVRAM() {
  try {
    const v = await API.vram();
    if (v.available) {
      StatusBar.setVRAM(v.allocated_gb, v.total_gb);
      console.log(`[Studio VRAM] ${v.allocated_gb} GB allocated / ${v.reserved_gb} GB reserved / ${v.total_gb} GB total` +
        (v.vram_reserve_gb > 0 ? ` (${v.vram_reserve_gb} GB set aside for compute)` : "") +
        (v.gpu_name ? ` (${v.gpu_name})` : ""));
    }
  } catch (_) {}
}


// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

// ── Param scrub: hold & drag on number inputs to change values ──
function _initParamScrub() {
  const scrubDefs = [
    { id: "paramSteps",    min: 1,   max: 150,  step: 1   },
    { id: "paramCFG",      min: 1,   max: 30,   step: 0.5 },
    { id: "paramDenoise",  min: 0,   max: 1,    step: 0.01 },
    { id: "paramWidth",    min: 64,  max: 2048, step: 64  },
    { id: "paramHeight",   min: 64,  max: 2048, step: 64  },
    { id: "paramBatch",    min: 1,   max: 16,   step: 1   },
  ];
  for (const def of scrubDefs) {
    const el = document.getElementById(def.id);
    if (!el) continue;
    let dragStartX = 0, dragStartVal = 0, dragged = false, pointerId = null;

    el.addEventListener("pointerdown", e => {
      if (document.activeElement === el) return; // already editing, don't scrub
      e.preventDefault();
      dragStartX = e.clientX;
      dragStartVal = parseFloat(el.value) || 0;
      dragged = false;
      pointerId = e.pointerId;
      el.setPointerCapture(e.pointerId);
      el.classList.add("scrubbing");
    });

    el.addEventListener("pointermove", e => {
      if (!el.classList.contains("scrubbing")) return;
      const dx = e.clientX - dragStartX;
      if (Math.abs(dx) < 3 && !dragged) return;
      dragged = true;
      // Sensitivity: ~250px drag covers the full range for any parameter
      const sensitivity = (def.max - def.min) / 250;
      let v = dragStartVal + Math.round(dx * sensitivity / def.step) * def.step;
      v = Math.max(def.min, Math.min(def.max, v));
      // Round to avoid floating point noise
      if (def.step < 1) v = Math.round(v / def.step) * def.step;
      el.value = def.step >= 1 ? v : v.toFixed(String(def.step).split(".")[1]?.length || 2);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });

    el.addEventListener("pointerup", e => {
      if (!el.classList.contains("scrubbing")) return;
      el.classList.remove("scrubbing");
      if (pointerId !== null) { try { el.releasePointerCapture(pointerId); } catch {} pointerId = null; }
      if (!dragged) {
        // Click — focus the input for manual typing
        el.focus();
        el.select();
      } else {
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
  }
}

async function init() {
  console.log("[Studio] Standalone UI initializing...");

  bindUI();
  _initParamScrub();

  // Add initial history entry
  addHistoryEntry("Session started");

  // Connect WebSocket for progress
  Progress.connect();
  Progress.onProgress(handleProgress);

  // If gen finished while tab was hidden, hide preview when user returns
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && State._deferPreviewHide) _hidePreview();
  });

  // Populate dropdowns from API
  await populateDropdowns();

  // Load saved workflow defaults (must run AFTER dropdowns are populated)
  // _applyDefaults handles canvas resize and status bar updates
  if (typeof window._studioLoadDefaults === "function") {
    await window._studioLoadDefaults();
  } else {
    // No defaults — set initial status from input values
    const w = parseInt(document.getElementById("paramWidth")?.value) || 768;
    const h = parseInt(document.getElementById("paramHeight")?.value) || 768;
    StatusBar.setDimensions(w, h);
  }

  // Load extension bridge manifest and render controls
  await ExtensionBridge.load();

  // Initialize theme switcher
  ThemeSwitcher.init();

  // Update check is manual — use the "Check for Updates" button in Settings.

  // Colorblind mode
  {
    const cbSel = document.getElementById("settingColorblind");
    if (cbSel) {
      const saved = localStorage.getItem("studio-colorblind") || "";
      if (saved) {
        document.documentElement.setAttribute("data-cb", saved);
        cbSel.value = saved;
      }
      cbSel.addEventListener("change", () => {
        const val = cbSel.value;
        if (val) {
          document.documentElement.setAttribute("data-cb", val);
        } else {
          document.documentElement.removeAttribute("data-cb");
        }
        localStorage.setItem("studio-colorblind", val);
      });
    }
  }

  // Reduced motion
  {
    const motionSel = document.getElementById("settingMotion");
    if (motionSel) {
      const saved = localStorage.getItem("studio-motion") || "";
      if (saved) {
        document.documentElement.setAttribute("data-motion", saved);
        motionSel.value = saved;
      }
      motionSel.addEventListener("change", () => {
        const val = motionSel.value;
        if (val) {
          document.documentElement.setAttribute("data-motion", val);
        } else {
          document.documentElement.removeAttribute("data-motion");
        }
        localStorage.setItem("studio-motion", val);
      });
    }
  }

  // Panel collapse toggle
  {
    const btn = document.getElementById("panelCollapseBtn");
    const panel = document.getElementById("panelRight");
    if (btn && panel) {
      const _applyCollapse = (collapsed) => {
        panel.classList.toggle("collapsed", collapsed);
        btn.classList.toggle("collapsed", collapsed);
        localStorage.setItem("studio-panel-collapsed", collapsed ? "1" : "");
      };
      // Restore saved state
      if (localStorage.getItem("studio-panel-collapsed") === "1") _applyCollapse(true);
      // Notify canvas after transition
      panel.addEventListener("transitionend", () => {
        window.dispatchEvent(new Event("resize"));
      });
      btn.addEventListener("click", () => {
        _applyCollapse(!panel.classList.contains("collapsed"));
      });
      // Keyboard shortcut: backslash
      document.addEventListener("keydown", (e) => {
        if (e.key === "\\" && !e.ctrlKey && !e.altKey && !e.metaKey &&
            !["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) {
          e.preventDefault();
          _applyCollapse(!panel.classList.contains("collapsed"));
        }
      });
    }
  }

  // UX-013: Initial VRAM readout + slow poll (every 30s)
  _refreshVRAM();
  setInterval(_refreshVRAM, 30000);

  // FR-001: Credits accordion
  // ---- Add contributors here ----
  const CREDITS = [
    { name: "SnekySnek", role: "VRAM Unloading" },
    { name: "Railer", role: "Session Save" },
    { name: "LeFrenchy", role: "Beta Testing" },
  ];
  // --------------------------------
  const creditsList = document.getElementById("creditsList");
  if (creditsList) {
    creditsList.innerHTML = CREDITS.map(c =>
      `<div><strong style="color:var(--text-2);">${c.name}</strong> <span style="color:var(--text-4);">&mdash; ${c.role}</span></div>`
    ).join("");
  }
  document.getElementById("creditsToggle")?.addEventListener("click", () => {
    const body = document.getElementById("creditsBody");
    const arrow = document.querySelector("#creditsToggle .collapse-arrow");
    if (body) body.style.display = body.style.display === "none" ? "" : "none";
    if (arrow) arrow.classList.toggle("open");
  });

  // Post-init canvas health check — fix corrupted state from bad session data
  if (window.StudioCore) {
    const S = window.StudioCore.state;
    if (S.activeLayerIdx == null || S.activeLayerIdx < 0 || S.activeLayerIdx >= S.layers.length) {
      const fixed = Math.max(0, S.layers.findIndex(l => l.type === "paint"));
      console.warn(`[Studio] Canvas health check: activeLayerIdx was ${S.activeLayerIdx}, reset to ${fixed}`);
      S.activeLayerIdx = fixed;
    }
    if (!S.layers.length) {
      console.error("[Studio] Canvas health check: no layers exist — reinitializing");
      const ref = StudioCore.makeLayer("Background", "reference");
      ref.ctx.fillStyle = "#fff"; ref.ctx.fillRect(0, 0, S.W, S.H);
      S.layers.push(ref);
      S.layers.push(StudioCore.makeLayer("Layer 1", "paint"));
      S.activeLayerIdx = 1;
      StudioCore.composite();
    }
  }

  console.log("[Studio] Ready");
}

// ═══════════════════════════════════════════
// EMERGENCY RESET — ?reset in URL nukes corrupted state
// ═══════════════════════════════════════════

if (new URLSearchParams(window.location.search).has("reset")) {
  const keys = Object.keys(localStorage).filter(k => k.startsWith("studio"));
  keys.forEach(k => localStorage.removeItem(k));
  console.warn(`[Studio] Emergency reset: cleared ${keys.length} localStorage keys`);
  // Strip ?reset from URL so it doesn't fire on every reload
  const url = new URL(window.location);
  url.searchParams.delete("reset");
  window.history.replaceState({}, "", url);
}

// ═══════════════════════════════════════════
// PROMPTSCOPE — TOKEN COUNTER
// ═══════════════════════════════════════════

const PromptScope = {
  _tokenTimer: null,

  /** Debounced token count — fires 300ms after typing stops */
  scheduleTokenCount() {
    clearTimeout(this._tokenTimer);
    this._tokenTimer = setTimeout(() => this.updateTokenCount(), 300);
  },

  async updateTokenCount() {
    const prompt = document.getElementById("paramPrompt")?.value || "";
    const el = document.getElementById("tokenCount");
    if (!el) return;

    if (!prompt.trim()) {
      el.textContent = "";
      el.className = "token-count";
      return;
    }

    try {
      const r = await fetch(API.base + "/studio/promptscope/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      if (!r.ok) return;
      const data = await r.json();
      const count = Math.max(data.tokens_l, data.tokens_g);
      const chunks = data.chunks || 1;
      const offline = data.offline ? "~" : "";

      let label = `${offline}${count} tok`;
      if (chunks > 1) label += ` · ${chunks} chunks`;

      el.textContent = label;
      const perChunk = count / chunks;
      el.className = "token-count" + (perChunk > 150 ? " over" : perChunk > 70 ? " warn" : "");
    } catch (_) {
      // PromptScope not available — fail silently
    }
  },
};

// Expose shared objects for modules (Workshop, etc.)
window.API = API;
window.State = State;
window.StatusBar = StatusBar;
window.populateDropdowns = populateDropdowns;
window.Progress = Progress;
window.showToast = showToast;
window.ExtensionBridge = ExtensionBridge;
window.UpdateBanner = UpdateBanner;

// Go
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
