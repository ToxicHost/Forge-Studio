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

  // Read the response body once, then either surface the server's real
  // error message (the backend returns {"error": ...} on failures) or
  // parse the success payload — tolerating empty/non-JSON 200 bodies.
  _finish(method, path, r, text) {
    if (!r.ok) {
      let detail = "";
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.error) detail = String(parsed.error);
      } catch (_) {
        if (text && text.trim()) detail = text.trim().slice(0, 300);
      }
      throw new Error(`${method} ${path}: ${r.status}` + (detail ? ` — ${detail}` : ""));
    }
    if (!text || !text.trim()) return {};
    try { return JSON.parse(text); } catch (_) { return {}; }
  },

  async get(path) {
    const r = await fetch(this.base + path);
    const text = await r.text();
    return this._finish("GET", path, r, text);
  },

  async post(path, body) {
    const r = await fetch(this.base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    return this._finish("POST", path, r, text);
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
  watermarks:    ()       => API.get("/studio/watermarks"),
  openWatermarksFolder: () => API.post("/studio/watermarks/open_folder", {}),
  unloadModel:   ()       => API.post("/studio/unload_model", {}),
  modelStatus:   ()       => API.get("/studio/model_status"),
  autoUnload:    (params) => API.post("/studio/auto_unload", params),
  vram:          ()       => API.get("/studio/vram"),

  // Auto-update
  checkUpdate:   ()       => API.get("/studio/api/check-update"),
  applyUpdate:   ()       => API.post("/studio/api/update", {}),
  updateStatus:  ()       => API.get("/studio/api/update-status"),

  // Live Painting
  liveStart:     ()       => API.post("/studio/live/start", {}),
  liveStop:      ()       => API.post("/studio/live/stop", {}),
  liveSubmit:    (params) => API.post("/studio/live/submit", params),
  liveStatus:    ()       => API.get("/studio/live/status"),

  // Workflow Profiles
  workflows:       ()        => API.get("/studio/workflows"),
  workflow:        (id)      => API.get("/studio/workflows/" + encodeURIComponent(id)),
  saveWorkflow:    (payload) => API.post("/studio/workflows", payload),
  deleteWorkflow:  (id)      => fetch(API.base + "/studio/workflows/" + encodeURIComponent(id),
                                       { method: "DELETE" }).then(r => r.json()),

  // Studio-native dynamic prompts (wildcards + {a|b|c}). Folder mode/path
  // is server-side state; the per-generation enabled flag travels with
  // each /studio/generate request as `studio_dynamic_prompts_enabled`.
  dynPromptsConfig:    ()        => API.get("/studio/dynamic_prompts/config"),
  dynPromptsSetConfig: (payload) => API.post("/studio/dynamic_prompts/config", payload),
  dynPromptsSelectFolder: (folder) => API.post("/studio/dynamic_prompts/select_folder", { folder }),
  dynPromptsPickFolder: ()        => fetch(API.base + "/studio/dynamic_prompts/pick_folder",
                                            { method: "POST" }).then(r => r.json()),
  dynPromptsStatus:    ()        => API.get("/studio/dynamic_prompts/status"),
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

// Per-tab session id (WP-L2). Sent with every generation request so the
// backend can register results (and scratch previews when auto-save is
// off) under this tab's session. The session dies with the tab; the
// backend's startup sweep reaps anything a closed tab left behind.
// crypto.randomUUID is undefined outside secure contexts (Forge over a
// plain-HTTP LAN IP is common) — the fallback matches the backend's
// session-id charset gate ([a-zA-Z0-9-]).
const SESSION_ID = (typeof crypto !== "undefined" && crypto.randomUUID)
  ? crypto.randomUUID()
  : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;

const State = {
  // Generation
  generating: false,
  _pendingModelSwitch: null, // checkpoint title queued while generating
  _pendingVAESwitch: null,   // VAE name queued while generating
  lastResult: null,        // last GenerateResponse
  lastSeed: -1,            // last resolved seed (for recycle button)
  // Session history (WP-L2): one SessionEntry per result, newest first.
  // Replaces the seven parallel output arrays — see _newSessionEntry for
  // the field contract. Capped at the user-configurable session limit.
  sessionEntries: [],
  selectedOutputIdx: 0,
  embedMetadata: true,     // whether to embed generation params in saved images
  saveOutputs: true,       // auto-save generated images to disk
  saveFormat: "png",       // output format: png | jpeg | webp
  saveQuality: 80,         // JPEG/WebP quality (0-100)
  saveLossless: false,     // WebP lossless mode
  galleryFolder: "",       // optional absolute server-side folder for "Save to Gallery" (empty = output/studio/)
  saveDir: "",             // optional absolute server-side folder for auto-save on generate (empty = Forge output dir)
  highPrecision: false,    // capture float32 VAE output, save .float32.bin sidecar
  livePreview: true,       // show preview thumbnail during generation
  // Auto Watermark (composited onto the final generated image)
  watermarkEnable: false,
  watermarkName: "",
  watermarkPosition: "bottom-right",
  watermarkOpacity: 1.0,   // 0..1
  watermarkScale: 0.15,    // fraction of the shorter edge
  watermarkMargin: 16,     // px
  watermarkRotation: 0,    // degrees
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

  // Architecture string of the currently loaded checkpoint (from
  // /studio/check_model_te). Used to gate TE preservation across
  // model swaps — same arch keeps the TE, different arch resets.
  _currentModelArch: "unknown",

  // Action history
  history: [],
  historyIdx: -1,
};


// ═══════════════════════════════════════════
// SESSION ENTRIES (WP-L2)
// ═══════════════════════════════════════════
//
// SessionEntry contract:
//   sessionId     — this tab's SESSION_ID
//   entryId       — server-minted id (saved/scratch) or client "live-…" id
//   source        — "saved" | "scratch" | "live"
//   canDeleteFile — true ONLY for source:"scratch" (backend gates deletion
//                   on its own registry too; never inferred from a URL)
//   url           — displayable URL: same-origin file URL for saved/scratch,
//                   data: URL for "live"
//   thumbUrl      — /studio/session_thumb?id=… for saved/scratch; === url for "live"
//   b64           — base64 data URL, kept on the NEWEST entry of the latest
//                   batch only (canvas fast path); null on all older entries.
//                   "live" entries are exempt (their url IS the data URL).
//   infotext, filename, contentHash, floatPath, maskPath, floatStats —
//                   same semantics as the old parallel arrays
//   width/height  — from the generation response when known, else 0 (the
//                   strip fills them from naturalWidth on first load)
//   ts            — Date.now() at insertion

let _liveEntrySeq = 0;

// User-configurable session history cap (Settings → "Session history size").
function _sessionLimit() {
  const raw = parseInt(localStorage.getItem("studio-session-limit") || "", 10);
  const v = isNaN(raw) ? 50 : raw;
  return Math.max(8, Math.min(200, v));
}

// Enforce the cap on State.sessionEntries (newest first) and report the
// entries that fell off to the backend so scratch files get deleted and
// registry rows dropped. Saved files are NEVER deleted by eviction — the
// backend only unlinks source:"scratch" rows it owns.
function _applySessionLimit() {
  const limit = _sessionLimit();
  if (State.sessionEntries.length <= limit) return;
  const evicted = State.sessionEntries.slice(limit);
  State.sessionEntries = State.sessionEntries.slice(0, limit);
  if (State.selectedOutputIdx >= State.sessionEntries.length) State.selectedOutputIdx = 0;
  _reportEvictedEntries(evicted);
}

function _reportEvictedEntries(entries) {
  const ids = entries
    .filter(e => e && e.entryId && e.source !== "live")
    .map(e => e.entryId);
  if (!ids.length) return;
  fetch(API.base + "/studio/session_evict", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: SESSION_ID, entry_ids: ids }),
  }).catch(() => { /* best-effort; the startup sweep is the backstop */ });
}

// Empty the session (strip + grid) and tell the backend to drop this
// session's registry rows + scratch files. Other tabs' sessions untouched.
function _clearSession() {
  State.sessionEntries = [];
  State.selectedOutputIdx = 0;
  renderOutputGallery();
  if (State._resultPreviewActive) _hidePreview();
  fetch(API.base + "/studio/session_clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: SESSION_ID }),
  }).catch(() => { /* best-effort; the startup sweep is the backstop */ });
}

// Entry for a Live Painting result: the data URL is the image — no file,
// no backend round-trip, exempt from scratch lifecycle and b64 retention.
function _newLiveEntry(dataUrl) {
  return {
    sessionId: SESSION_ID,
    entryId: `live-${Date.now()}-${_liveEntrySeq++}`,
    source: "live",
    canDeleteFile: false,
    url: dataUrl,
    thumbUrl: dataUrl,
    b64: dataUrl,
    infotext: "", filename: "", contentHash: "",
    floatPath: "", maskPath: "", floatStats: null,
    width: 0, height: 0,
    ts: Date.now(),
  };
}

// Displayable source for entry `idx`. Prefer the file URL when one exists:
// on Firefox + calibrated wide-gamut, decoding from a data URL produces
// drifted pixel values vs decoding the same bytes fetched from disk —
// the file URL is the byte-faithful source. Fall back to the cached b64
// only when there's no URL ("live" entries' url IS their data URL).
function _pickOutputSource(idx) {
  const e = State.sessionEntries && State.sessionEntries[idx];
  if (!e) return null;
  return e.url || e.b64 || null;
}

// Backend save endpoints (/studio/save_image, /studio/export_exr) want a
// base64 data URL. When _pickOutputSource returns a /file= URL, fetch
// it fresh from disk and convert — this is the byte-faithful source,
// avoiding the cached b64 that drifts on the affected setups.
// Same-origin URL for a Studio-written file (image or .float32.bin/mask
// sidecar). Unlike Forge's /file= route this also serves user-chosen save
// folders outside the Forge output tree (path-validated server-side).
function _studioFileUrl(path) {
  return API.base + "/studio/file?path=" + encodeURIComponent(path);
}

// Explicitly trust a typed server-visible folder so Studio may save there.
// This is the user action that makes a typed (remote/VM) path usable — paths
// are never trusted just by appearing in a save/generation request. Returns
// true on success.
async function _trustSaveFolder(path) {
  const p = (path || "").trim();
  if (!p) { showToast("Type a folder path first", "info"); return false; }
  try {
    const r = await fetch(API.base + "/studio/trust-save-root", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.ok) { showToast("Folder trusted — Studio can save here", "success"); return true; }
    showToast(data.error || "Could not trust folder", "error");
    return false;
  } catch (e) {
    showToast("Could not reach server: " + e.message, "error");
    return false;
  }
}

// Render the persisted trusted-save-folder list (with Remove) in Settings.
async function _renderTrustedRoots() {
  const el = document.getElementById("trustedRootsList");
  if (!el) return;
  try {
    const r = await fetch(API.base + "/studio/trusted-save-roots");
    const data = await r.json().catch(() => ({}));
    const roots = (data && data.roots) || [];
    el.innerHTML = "";
    if (!roots.length) return;
    const title = document.createElement("div");
    title.style.cssText = "font-size:10px;color:var(--text-4);";
    title.textContent = "Trusted save folders:";
    el.appendChild(title);
    roots.forEach(p => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:6px;";
      const span = document.createElement("span");
      span.style.cssText = "flex:1 1 auto;min-width:0;font-size:10px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      span.textContent = p; span.title = p;
      const rm = document.createElement("button");
      rm.className = "defaults-btn"; rm.style.cssText = "font-size:9px;padding:1px 6px;";
      rm.textContent = "Remove";
      rm.addEventListener("click", async () => {
        try {
          await fetch(API.base + "/studio/untrust-save-root", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: p }),
          });
        } catch (_) {}
        _renderTrustedRoots();
      });
      row.appendChild(span); row.appendChild(rm);
      el.appendChild(row);
    });
  } catch (_) { /* best-effort */ }
}

async function _resolveEntryB64(entry) {
  if (!entry) return null;
  // Newest-of-batch fast path; "live" entries always land here too.
  if (entry.b64) return entry.b64;
  const src = entry.url;
  if (!src) return null;
  if (src.startsWith("data:")) return src;
  const resp = await fetch(src);
  const blob = await resp.blob();
  // Deliberately NOT cached back onto the entry — the newest-only
  // retention rule is what bounds session memory.
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

async function _resolveOutputAsB64(idx) {
  return _resolveEntryB64(State.sessionEntries && State.sessionEntries[idx]);
}


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
      // Customize mode exits cleanly before Live begins — no re-mount can
      // happen mid-session (WP-L3 generation lock).
      if (window.Customizer?.active) Customizer.exit();
      await API.liveStart();
      // Seed: generate one if not set
      if (this.seed < 0) this.seed = Math.floor(Math.random() * 2147483647);
      this.active = true;
      this.lastHash = "";
      this._disableAD();
      this._updateUI();
      window.Customizer?.updateToggleState();
      console.log("[Live] Active, seed:", this.seed);
      // Trigger an initial submit with current canvas state
      this._scheduleCanvasCheck(0);
    } catch (e) {
      console.error("[Live] Start failed:", e);
      showToast(_i18n("toast.live.failed", "Live painting failed to start"), "error");
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
    window.Customizer?.updateToggleState();
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
      if (label) label.textContent = _i18n("panels.live", "Live");
      // Prevent progress handler and _hidePreview from stomping this
      State._resultPreviewActive = true;
      State._previewShown = true;
    }

    // Also add to the session so Result → Canvas works. Live results JOIN
    // the session history (source:"live", data-URL entry) instead of
    // erasing it — intentional WP-L2 behavior change. No hash/infotext yet.
    State.sessionEntries.unshift(_newLiveEntry(data.image));
    _applySessionLimit();
    State.selectedOutputIdx = 0;
    renderOutputGallery();

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
    if (!this._lastResult) { showToast(_i18n("live.toast.noResult", "No Live result to apply"), "info"); return; }
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
      // _i18n falls back to literal English if I18N hasn't loaded yet.
      // The data-i18n / data-i18n-title attrs on the markup let
      // applyToDom() keep the labels in sync on locale switch — but
      // since we mutate the button directly here, we update them too.
      if (!this.active) {
        btn.textContent = _i18n("live.toggle.start", "▶ Live");
        btn.title = _i18n("live.toggle.start.tooltip", "Start Live Painting");
        btn.dataset.i18n = "live.toggle.start";
        btn.dataset.i18nTitle = "live.toggle.start.tooltip";
      } else if (this.generating) {
        btn.textContent = _i18n("live.toggle.generating", "◉ Live");
        btn.title = _i18n("live.toggle.generating.tooltip", "Generating...");
        btn.dataset.i18n = "live.toggle.generating";
        btn.dataset.i18nTitle = "live.toggle.generating.tooltip";
      } else {
        btn.textContent = _i18n("live.toggle.stop", "■ Live");
        btn.title = _i18n("live.toggle.stop.tooltip", "Stop Live Painting");
        btn.dataset.i18n = "live.toggle.stop";
        btn.dataset.i18nTitle = "live.toggle.stop.tooltip";
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

// Translate helper for runtime-built strings. Re-exposed locally so the
// status bar / update banner / error icons read clearly without ?: chains
// at every call site.
const _i18n = (key, fallback, params) =>
  (window.I18N && window.I18N.t) ? window.I18N.t(key, fallback, params) : fallback;

const StatusBar = {
  // Track the most recent abstract status so we can re-render after a
  // locale change without the caller having to remember.
  _lastStatus: null,
  _lastModel: null,
  _lastModelMode: null, // "name" | "unloaded"

  setStatus(status) {
    const dot = document.getElementById("statusDot");
    const text = document.getElementById("statusText");
    if (!dot || !text) return;
    this._lastStatus = status;
    dot.className = "status-dot";
    switch (status) {
      case "ready":
        dot.classList.add("status-ready");
        text.textContent = _i18n("status.ready", "Ready");
        break;
      case "generating":
        dot.classList.add("status-generating");
        text.textContent = _i18n("status.generating", "Generating...");
        break;
      case "error":
        dot.classList.add("status-error");
        text.textContent = _i18n("status.disconnected", "Disconnected");
        break;
    }
  },

  setModel(name) {
    const el = document.getElementById("statusModel");
    if (el) {
      this._lastModel = name || null;
      this._lastModelMode = "name";
      el.textContent = name || _i18n("status.noModel", "No model");
      el.classList.remove("model-unloaded");
    }
  },

  setModelUnloaded() {
    const el = document.getElementById("statusModel");
    if (el) {
      this._lastModelMode = "unloaded";
      el.textContent = _i18n("status.modelUnloaded", "Model unloaded");
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

// Re-render dynamic status-bar text on locale switch. The setStatus /
// setModel etc. methods cache their last call so we can replay them
// against the new locale without the page knowing what status it's in.
window.addEventListener("i18n:change", () => {
  if (StatusBar._lastStatus) StatusBar.setStatus(StatusBar._lastStatus);
  if (StatusBar._lastModelMode === "name") StatusBar.setModel(StatusBar._lastModel);
  else if (StatusBar._lastModelMode === "unloaded") StatusBar.setModelUnloaded();
});


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

    // i18n: pluralized banner text + button labels translate via I18N.t.
    // Plural rules differ across locales (DE/EN agree on 1 vs >1; FR
    // treats 0 as singular; etc.) \u2014 t.plural handles the lookup, with
    // English fallbacks as the second arg.
    const tp = (window.I18N && window.I18N.t && window.I18N.t.plural) ? window.I18N.t.plural : null;
    const fallback = "Update available \u2014 " + data.commits_behind +
      " new commit" + (data.commits_behind > 1 ? "s" : "");
    const bannerText = tp ? tp("update.available", data.commits_behind) : null;
    const finalText = (bannerText && bannerText !== "update.available") ? bannerText : fallback;

    const el = document.createElement("div");
    el.className = "update-banner";
    el.innerHTML = `
      <span class="update-banner-text">${finalText}</span>
      <button class="update-banner-btn update-details-btn" data-i18n="update.details">${_i18n("update.details", "Details")}</button>
      <button class="update-banner-btn update-apply-btn" data-i18n="update.apply">${_i18n("update.apply", "Update Now")}</button>
      <button class="update-banner-dismiss" data-i18n-title="update.dismiss" title="${_i18n("update.dismiss", "Dismiss")}">&times;</button>
    `;

    el.querySelector(".update-details-btn").onclick = () => this._showDetails();
    el.querySelector(".update-apply-btn").onclick = () => this._applyUpdate();
    el.querySelector(".update-banner-dismiss").onclick = () => this.hide();

    document.body.appendChild(el);
    this._el = el;

    // Re-render the pluralized banner text on locale switch. The button
    // labels are picked up automatically via data-i18n on applyToDom().
    this._localeListener = () => {
      if (!this._el || !this._data) return;
      const span = this._el.querySelector(".update-banner-text");
      if (span) {
        const tp2 = (window.I18N && window.I18N.t && window.I18N.t.plural) ? window.I18N.t.plural : null;
        const fb = "Update available \u2014 " + this._data.commits_behind +
          " new commit" + (this._data.commits_behind > 1 ? "s" : "");
        const bt = tp2 ? tp2("update.available", this._data.commits_behind) : null;
        span.textContent = (bt && bt !== "update.available") ? bt : fb;
      }
    };
    window.addEventListener("i18n:change", this._localeListener);

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
        if (!data.update_available) { showToast(I18N.t("toast.alreadyUpToDate", "Already up to date"), "success"); this.hide(); return; }
        this._data = data;
      } catch (e) { showToast(I18N.t("toast.updateCheckFailed", "Update check failed: {error}", {error: e.message}), "error"); return; }
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
    // Render an in-place progress dialog instead of the old single
    // "Updating..." toast. The backend POST /studio/api/update is
    // synchronous and can take 30–120s; while it runs, we poll
    // GET /studio/api/update-status every 500ms for the current
    // phase + percentage and keep the UI live.
    const dlg = this._showProgressDialog();

    const PHASE_LABELS = {
      idle: "Preparing",
      checking: "Checking update",
      downloading: "Downloading",
      extracting: "Extracting",
      copying: "Copying files",
      finishing: "Finishing",
      restart: "Restart required",
      error: "Update failed",
    };
    const renderPhase = (phase, pct, message) => {
      const label = PHASE_LABELS[phase] || message || "Updating";
      dlg.label.textContent = label;
      const safePct = Math.max(0, Math.min(100, Number(pct) || 0));
      dlg.bar.style.width = safePct + "%";
      dlg.pct.textContent = safePct + "%";
    };
    renderPhase("checking", 5);

    let stopPolling = false;
    const poll = async () => {
      while (!stopPolling) {
        try {
          const s = await API.updateStatus();
          if (s && s.phase) renderPhase(s.phase, s.pct, s.message);
        } catch (_) { /* transient — keep polling */ }
        await new Promise(r => setTimeout(r, 500));
      }
    };
    poll();

    try {
      const res = await API.applyUpdate();
      stopPolling = true;
      if (!res.ok) {
        renderPhase("error", 0, res.error || "Update failed");
        showToast(res.error || "Update failed", "error");
        // Leave the dialog open briefly so the user sees the failure.
        setTimeout(() => dlg.overlay.remove(), 2500);
        return;
      }
      renderPhase("restart", 100);
      // Replace dialog with a restart notice banner.
      dlg.overlay.remove();
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
      stopPolling = true;
      renderPhase("error", 0, e.message);
      showToast(I18N.t("toast.updateFailed", "Update failed: {error}", {error: e.message}), "error");
      setTimeout(() => dlg.overlay.remove(), 2500);
    }
  },

  _showProgressDialog() {
    // Minimal modal: phase label, percentage, and a progress bar.
    // No cancel button — the backend update is non-cancellable and
    // killing it mid-extract would leave a half-applied tree.
    const overlay = document.createElement("div");
    overlay.className = "update-dialog-overlay";
    overlay.innerHTML = `
      <div class="update-dialog">
        <div class="update-dialog-title">Updating Forge Studio</div>
        <div class="update-dialog-phase">Preparing</div>
        <div class="update-dialog-bar-track"><div class="update-dialog-bar-fill"></div></div>
        <div class="update-dialog-pct">0%</div>
        <div class="update-dialog-hint">Please don't close the browser. The server will need a restart when this finishes.</div>
      </div>
    `;
    document.body.appendChild(overlay);
    return {
      overlay,
      label: overlay.querySelector(".update-dialog-phase"),
      bar:   overlay.querySelector(".update-dialog-bar-fill"),
      pct:   overlay.querySelector(".update-dialog-pct"),
    };
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
        showToast(I18N.t("toast.studioUpToDate", "Forge Studio is up to date"), "success");
      }
    } catch (e) { showToast(I18N.t("toast.updateCheckFailed", "Update check failed: {error}", {error: e.message}), "error"); }
  },
};


// ═══════════════════════════════════════════
// TEXT ENCODER MEMORY HELPERS
// ═══════════════════════════════════════════
//
// Studio remembers the user's last external Text Encoder pick per
// model title AND per architecture. Architecture-level memory lets us
// restore an Anima/Cosmos TE when the user returns to an Anima/Cosmos
// model after a detour through SDXL/Flux/etc., without ever carrying
// a Cosmos TE into an arch that didn't ask for it.
//
// Persisted shape:
//   {
//     by_model: { "<title>": "<te_filename>" },
//     by_arch:  { "<arch>":  "<te_filename>" }
//   }
//
// Older builds wrote a flat `{ title: te }` object; _normalizeTeMemory
// migrates that on read.

function _readTeMemory() {
  try {
    return _normalizeTeMemory(JSON.parse(localStorage.getItem("studio_te_memory") || "{}"));
  } catch (_) {
    return { by_model: {}, by_arch: {} };
  }
}

function _writeTeMemory(mem) {
  try {
    localStorage.setItem("studio_te_memory", JSON.stringify(mem || { by_model: {}, by_arch: {} }));
  } catch (_) {}
}

function _optionExists(select, value) {
  return !!(select && value && [...select.options].some(o => o.value === value));
}

function _teArchKey(arch) {
  return arch || "unknown";
}

function _normalizeTeMemory(raw) {
  if (!raw || typeof raw !== "object") return { by_model: {}, by_arch: {} };
  if (raw.by_model || raw.by_arch) {
    return {
      by_model: raw.by_model || {},
      by_arch: raw.by_arch || {},
    };
  }
  // Legacy flat shape: title -> te filename
  return { by_model: raw, by_arch: {} };
}

async function checkModelTE(title) {
  if (!title) return { needs_te: false, needs_vae: false, arch: "unknown" };
  try {
    return await fetch(
      API.base + "/studio/check_model_te?title=" + encodeURIComponent(title)
    ).then(r => r.json());
  } catch (_) {
    return { needs_te: false, needs_vae: false, arch: "unknown" };
  }
}

function rememberExternalTE(modelTitle, arch, teName) {
  if (!modelTitle || !teName || teName === "None") return;
  const mem = _readTeMemory();
  mem.by_model[modelTitle] = teName;
  if (arch) mem.by_arch[_teArchKey(arch)] = teName;
  _writeTeMemory(mem);
}

// Restore the TE dropdown for the given model with architecture-aware
// rules. Returns the /check_model_te payload so callers can update
// State._currentModelArch.
//
// reason:
//   "model-change" / "post-generation" — normal restore from memory
//   "te-change"      — user just picked a TE explicitly; keep teSelect.value
//                      if it's a valid option, else fall back to "None"
//   "workflow-apply" — workflow already wrote a value; same as te-change
//
// opts.previousArch — arch of the previously loaded model. If different
//   from the target arch, opts.preferredTE and the current teSelect.value
//   are ignored (only mem.by_model and mem.by_arch are consulted) so we
//   never carry e.g. a Cosmos TE across into Flux.
// opts.preferredTE  — caller-suggested TE name (e.g. the value captured
//   before populateDropdowns rebuilt the options).
async function restoreTextEncoderForModel(modelTitle, reason = "model-change", opts = {}) {
  const teRow = document.getElementById("textEncoderRow");
  const teSelect = document.getElementById("paramTextEncoder");
  if (!modelTitle || !teSelect) {
    return { needs_te: false, needs_vae: false, arch: "unknown" };
  }

  const check = await checkModelTE(modelTitle);
  const needsTE = !!check.needs_te;
  const arch = check.arch || "unknown";

  if (!needsTE) {
    if (teRow) teRow.style.display = "none";
    teSelect.value = "None";
    return check;
  }

  if (teRow) teRow.style.display = "";

  // For explicit user/workflow/session/preflight-driven values, keep what's
  // already set (it may match a value that was just programmatically
  // restored from the workflow or session) and only fall back to "None" if
  // it no longer exists. Architecture memory must NOT clobber an explicitly
  // chosen TE.
  if (reason === "workflow-apply" || reason === "session-restore"
      || reason === "generation-preflight" || reason === "te-change") {
    if (!_optionExists(teSelect, teSelect.value)) {
      // A saved TE whose file was removed since save shouldn't break
      // generation — warn and drop to bundled instead of leaving a
      // phantom selection that doesn't actually load.
      if ((reason === "session-restore" || reason === "generation-preflight")
          && teSelect.value && teSelect.value !== "None") {
        showToast(
          _i18n("toast.te.savedMissing", "Saved text encoder not found; using None"),
          "info",
        );
      }
      teSelect.value = "None";
    }
    return check;
  }

  const mem = _readTeMemory();
  const previousArch = opts.previousArch || null;
  const sameArch = !previousArch || previousArch === arch;

  const candidates = [];
  // Exact model memory is always safest.
  candidates.push(mem.by_model?.[modelTitle]);
  // Same architecture can reuse the currently selected/preferred TE.
  if (sameArch) {
    candidates.push(opts.preferredTE);
    if (teSelect.value !== "None") candidates.push(teSelect.value);
  }
  // Architecture-level memory is allowed for the target arch.
  candidates.push(mem.by_arch?.[_teArchKey(arch)]);

  const restored = candidates.find(v => v && v !== "None" && _optionExists(teSelect, v));

  if (restored) {
    teSelect.value = restored;
  } else {
    teSelect.value = "None";
    if ((State._textEncoderList || []).length > 0) {
      showToast("This model needs a text encoder — select one above", "info");
    }
  }

  return check;
}


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

    // Defaults / session-restore stashes the intended value in
    // dataset.pendingValue when the dropdown's options haven't been
    // populated yet. We honor that BEFORE the live .value when re-
    // populating, otherwise the rebuilt <option selected> for the HTML
    // default wins and the user's saved choice is silently discarded.
    const _pickPrev = (el) => el.dataset.pendingValue || el.value;

    // Model selector in settings.
    //
    // The native option's `value` keeps Forge's full title (with the
    // trailing [hash] suffix Forge expects when matching the
    // checkpoint). The visible label drops the hash — long titles
    // were both crowding the trigger and making model rows hard to
    // scan in the dropdown. The hash is still available in the
    // PNG/JPEG metadata that Forge writes alongside the image.
    const _stripModelHash = (s) => String(s || "").replace(/\s*\[[0-9a-fA-F]{8,16}\]\s*$/, "");
    const modelSelect = document.getElementById("paramModel");
    if (modelSelect) {
      const prev = _pickPrev(modelSelect);
      modelSelect.innerHTML = models.map(m =>
        `<option value="${m.title}">${_stripModelHash(m.title)}</option>`
      ).join("");
      restoreSelection(modelSelect, prev);
      delete modelSelect.dataset.pendingValue;
      // attach is idempotent — second call returns existing handle.
      window.StudioSearchableSelect?.attach(modelSelect, {
        placeholder: "— Select model —",
        searchPlaceholder: "Filter models…",
      });
    }

    // Sampler dropdown
    const samplerSelect = document.getElementById("paramSampler");
    if (samplerSelect) {
      const prev = _pickPrev(samplerSelect);
      samplerSelect.innerHTML = samplers.map(s =>
        `<option value="${s.name}" ${s.name === "DPM++ 2M SDE" ? "selected" : ""}>${s.name}</option>`
      ).join("");
      restoreSelection(samplerSelect, prev);
      delete samplerSelect.dataset.pendingValue;
      window.StudioSearchableSelect?.attach(samplerSelect, {
        placeholder: "— Select sampler —",
        searchPlaceholder: "Filter samplers…",
      });
    }

    // Scheduler dropdown
    const schedSelect = document.getElementById("paramScheduler");
    if (schedSelect) {
      const prev = _pickPrev(schedSelect);
      schedSelect.innerHTML = schedulers.map(s =>
        `<option value="${s.label}" ${s.label === "Karras" ? "selected" : ""}>${s.label}</option>`
      ).join("");
      restoreSelection(schedSelect, prev);
      delete schedSelect.dataset.pendingValue;
    }

    // Hires Fix upscaler dropdown
    const hrUpscaler = document.getElementById("paramHrUpscaler");
    if (hrUpscaler && upscalers.length) {
      const prev = _pickPrev(hrUpscaler);
      hrUpscaler.innerHTML =
        '<option value="Latent">Latent</option>' +
        upscalers.map(u =>
          `<option value="${u.name}">${u.name}</option>`
        ).join("");
      restoreSelection(hrUpscaler, prev);
      delete hrUpscaler.dataset.pendingValue;
    }

    // Standalone upscale dropdown (no Latent option — always real upscaler)
    const upscaleModel = document.getElementById("paramUpscaleModel");
    if (upscaleModel && upscalers.length) {
      const prev = _pickPrev(upscaleModel);
      upscaleModel.innerHTML = upscalers.map(u =>
        `<option value="${u.name}" ${u.name === "R-ESRGAN 4x+" ? "selected" : ""}>${u.name}</option>`
      ).join("");
      restoreSelection(upscaleModel, prev);
      delete upscaleModel.dataset.pendingValue;
    }

    // Hires Fix checkpoint dropdown — same hash-stripping treatment
    // as the main model selector. Value retains Forge's full title.
    const hrCheckpoint = document.getElementById("paramHrCheckpoint");
    if (hrCheckpoint) {
      const prev = _pickPrev(hrCheckpoint);
      hrCheckpoint.innerHTML =
        '<option value="Same">Same</option>' +
        models.map(m =>
          `<option value="${m.title}">${_stripModelHash(m.title)}</option>`
        ).join("");
      restoreSelection(hrCheckpoint, prev);
      delete hrCheckpoint.dataset.pendingValue;
    }

    // Sync the searchable-select trigger label after a programmatic
    // value-set. The MutationObserver inside the searchable-select only
    // catches HTML attribute changes; setting select.value is a property
    // change so the trigger displays a stale label otherwise.
    const _syncSearchable = (sel) => {
      // Refresh an already-wrapped searchable select's trigger label after a
      // programmatic .value set. Guarded on the existing wrapper handle so
      // this never *attaches* a plain select as a side effect — VAE/TE stay
      // native unless the defaults/session restore path wrapped them.
      try { sel?._studioSSelHandle?.refresh?.(); } catch (_) {}
    };

    // Status bar — fetch actual loaded model. At Studio boot Forge may
    // not have finished loading the actual model yet (FakeInitialModel
    // placeholder), so /studio/current_model returns an empty title.
    // We do a fast first attempt + a few delayed retries; whichever
    // attempt first sees a real title wins, and only updates the
    // dropdown if the user hasn't manually changed it in between.
    const _initialModelValue = modelSelect ? modelSelect.value : "";
    const _applyCurrentModel = (currentTitle) => {
      if (!currentTitle) return false;
      StatusBar.setModel(currentTitle.split("[")[0].trim());
      if (modelSelect && modelSelect.value !== currentTitle
          && [...modelSelect.options].some(o => o.value === currentTitle)) {
        // Only override the dropdown if the user hasn't changed it
        // since boot. Comparing against _initialModelValue guards
        // against clobbering a manual selection during a slow retry.
        if (modelSelect.value === _initialModelValue) {
          modelSelect.value = currentTitle;
          _syncSearchable(modelSelect);
        }
      } else if (modelSelect && modelSelect.value === currentTitle) {
        _syncSearchable(modelSelect);  // value already right, just refresh label
      }
      return true;
    };
    let _gotCurrentModel = false;
    try {
      const current = await fetch(API.base + "/studio/current_model").then(r => r.json());
      _gotCurrentModel = _applyCurrentModel(current.title || "");
      if (!_gotCurrentModel && models.length) {
        StatusBar.setModel(models[0].title.split("[")[0].trim());
      }
    } catch (_) {
      // Fallback to sdapi options
      try {
        const opts = await fetch(API.base + "/sdapi/v1/options").then(r => r.json());
        _gotCurrentModel = _applyCurrentModel(opts.sd_model_checkpoint || "");
      } catch (__) {
        if (models.length) StatusBar.setModel(models[0].title.split("[")[0].trim());
      }
    }
    // Retry loop for boot-time race: Forge finishes loading the model
    // after Studio's initial fetch. Up to ~12s of polling at 1s intervals.
    if (!_gotCurrentModel && modelSelect) {
      let _attempts = 0;
      const _tick = () => {
        if (++_attempts > 12) return;
        // Stop retrying if the user has manually picked a model.
        if (modelSelect.value !== _initialModelValue) return;
        fetch(API.base + "/studio/current_model")
          .then(r => r.json())
          .then(c => {
            if (!_applyCurrentModel(c.title || "")) {
              setTimeout(_tick, 1000);
            }
          })
          .catch(() => setTimeout(_tick, 1000));
      };
      setTimeout(_tick, 1000);
    }

    console.log(`[Studio] Loaded ${models.length} models, ${samplers.length} samplers, ${upscalers.length} upscalers`);

    // Snapshot model+TE BEFORE the async TE rebuild can clobber the
    // dropdown. We use these both as a preservation hint for
    // restoreTextEncoderForModel() and to persist the user's current
    // pick into TE memory so refresh cycles never lose it.
    const modelBeforePopulate = document.getElementById("paramModel")?.value || "";
    const teBeforePopulate = document.getElementById("paramTextEncoder")?.value || "None";
    const previousArchForRestore = State._currentModelArch || null;
    if (modelBeforePopulate && teBeforePopulate !== "None") {
      // Fire-and-forget; rememberExternalTE is a no-op if arch is unknown.
      checkModelTE(modelBeforePopulate).then(c => {
        rememberExternalTE(modelBeforePopulate, c.arch, teBeforePopulate);
      });
    }

    // VAE dropdown (async, non-blocking).
    //
    // Restore priority: a session/defaults-stashed value (pendingValue) or
    // the value already selected wins over /studio/current_vae. current_vae
    // reflects what Forge has loaded *right now*, which at boot is the
    // default — letting it speak first would silently stomp the user's
    // saved VAE before the post-restore sync can re-apply it.
    fetch(API.base + "/studio/vaes").then(r => r.json()).then(vaes => {
      const vaeSelect = document.getElementById("paramVAE");
      if (!vaeSelect) return;
      const pendingVAE = vaeSelect.dataset.pendingValue || "";
      const prev = pendingVAE || vaeSelect.value;
      vaeSelect.innerHTML = vaes.map(v =>
        `<option value="${v.name}">${v.name}</option>`
      ).join("");

      // Priority 1/2: honor the saved (pending) value, or a meaningful
      // existing selection, if it still exists. "Automatic" is the
      // placeholder for "no explicit VAE" — when it's merely the current
      // dropdown state (not an explicitly saved choice) we let current_vae
      // speak so a fresh boot still reflects Forge's actual loaded VAE.
      if (prev && _optionExists(vaeSelect, prev) && (pendingVAE || prev !== "Automatic")) {
        vaeSelect.value = prev;
        delete vaeSelect.dataset.pendingValue;
        _syncSearchable(vaeSelect);
        return;
      }

      // A saved VAE that no longer exists shouldn't block generation —
      // warn and fall through to current/default.
      if (pendingVAE) {
        showToast(
          _i18n("toast.vae.savedMissing", "Saved VAE not found; using current/default VAE"),
          "info",
        );
      }
      delete vaeSelect.dataset.pendingValue;

      // Priority 3: fall back to whatever Forge actually has loaded.
      fetch(API.base + "/studio/current_vae").then(r => r.json()).then(current => {
        if (current.name && _optionExists(vaeSelect, current.name)) {
          vaeSelect.value = current.name;
          _syncSearchable(vaeSelect);
        }
      }).catch(() => {});
    }).catch(() => {});

    // Text Encoder dropdown (async, non-blocking). The restore call MUST
    // come after innerHTML rebuild — otherwise replacing the <option>s
    // wipes whatever value was just selected.
    fetch(API.base + "/studio/text_encoders").then(r => r.json()).then(async teList => {
      const teSelect = document.getElementById("paramTextEncoder");
      // A session/defaults-stashed TE (pendingValue) is an explicit user
      // choice and must not be clobbered by per-model/arch memory. When
      // present we restore it verbatim via "session-restore"; otherwise we
      // fall back to the normal memory-driven "model-change" path.
      const pendingTE = teSelect?.dataset.pendingValue || "";
      const savedTE = pendingTE || teBeforePopulate || "None";
      if (teSelect) {
        teSelect.innerHTML = '<option value="None">None (bundled)</option>' +
          teList.map(name =>
            `<option value="${name}">${name}</option>`
          ).join("");
      }
      // Cache the list so model-change handler can check if any TEs exist
      State._textEncoderList = teList;

      const currentModel = document.getElementById("paramModel")?.value || modelBeforePopulate;
      if (currentModel && teSelect) {
        const reason = pendingTE ? "session-restore" : "model-change";
        // Seed the value first so the session-restore branch of
        // restoreTextEncoderForModel keeps it (it only downgrades to
        // "None" if the saved option no longer exists).
        if (reason === "session-restore") teSelect.value = savedTE;
        const check = await restoreTextEncoderForModel(currentModel, reason, {
          preferredTE: savedTE,
          previousArch: previousArchForRestore,
        });
        State._currentModelArch = check.arch || "unknown";
        delete teSelect.dataset.pendingValue;
        _syncSearchable(teSelect);
      } else if (teSelect) {
        delete teSelect.dataset.pendingValue;
      }
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
    showToast(I18N.t("toast.connectionFailed", "Failed to connect to Forge backend"), "error");
  }
}


// ═══════════════════════════════════════════
// GENERATION
// ═══════════════════════════════════════════

// Generation preflight: reconcile Forge's actually-loaded components with
// the UI selection before generating. Dropdowns can be restored from
// session/defaults/workflow while Forge still holds stale (or no) external
// TE/VAE — generating then silently uses the wrong components. We compare
// /studio/model_status against the selected model/VAE/TE and only reload on
// a real mismatch (so the common already-matching case costs one GET).
// Returns true when it's safe to generate, false if a required load failed.
async function ensureSelectedComponentsLoadedForGenerate() {
  const title = document.getElementById("paramModel")?.value || "";
  if (!title) return true;  // nothing selected — let generation proceed/fail as before

  const teVal = document.getElementById("paramTextEncoder")?.value || "None";
  const vaeVal = document.getElementById("paramVAE")?.value || "";

  const _norm = (s) => String(s == null ? "" : s).trim();
  const _teIsNone = (v) => { const n = _norm(v); return !n || n === "None" || n === "Bundled"; };
  const _vaeIsAuto = (v) => { const n = _norm(v); return !n || n === "Automatic" || n === "None"; };

  let status = null;
  try {
    status = await fetch(API.base + "/studio/model_status").then(r => r.json());
  } catch (_) {
    status = null;  // status unavailable — fall through to a best-effort load
  }

  let mismatch = false;
  if (!status || !status.loaded) {
    mismatch = true;
  } else {
    if (_norm(status.title) !== _norm(title)) mismatch = true;

    // external_text_encoder / external_vae are display names (or null).
    const backendTE = status.external_text_encoder;
    if (_teIsNone(teVal)) {
      if (backendTE) mismatch = true;            // backend holds a TE we don't want
    } else if (_norm(backendTE) !== _norm(teVal)) {
      mismatch = true;
    }

    const backendVAE = status.external_vae;
    if (_vaeIsAuto(vaeVal)) {
      if (backendVAE) mismatch = true;           // backend holds a VAE we don't want
    } else if (_norm(backendVAE) !== _norm(vaeVal)) {
      mismatch = true;
    }
  }

  if (!mismatch) return true;

  console.log("[Studio] Generation preflight: backend components differ from UI — syncing");
  if (typeof window.loadSelectedModelComponents !== "function") return true;
  const ok = await window.loadSelectedModelComponents("generation-preflight");
  return ok !== false;
}

async function doGenerate() {
  if (State.generating || State._preflighting) return;

  // Make Forge's loaded components match the UI before committing. Run with
  // State.generating still false so loadSelectedModelComponents performs the
  // load instead of queueing it; _preflighting guards against a second click
  // during the (possibly multi-second) load.
  State._preflighting = true;
  let ready;
  try {
    ready = await ensureSelectedComponentsLoadedForGenerate();
  } finally {
    State._preflighting = false;
  }
  if (!ready) {
    showToast(
      _i18n("toast.preflight.failed", "Could not load the selected model — generation cancelled"),
      "error",
    );
    return;
  }
  // The preflight awaited; bail if a generation started in the meantime.
  if (State.generating) return;

  // Customize mode exits cleanly before a run starts — no re-mount can
  // happen mid-generation (WP-L3 generation lock).
  if (Customizer.active) Customizer.exit();
  State.generating = true;
  Customizer.updateToggleState();

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
  if (btn) {
    btn.textContent = (window.I18N && window.I18N.t) ? window.I18N.t("status.generating", "Generating...") : "Generating...";
    btn.classList.add("generating");
  }
  if (fill) fill.style.width = "0%";
  StatusBar.setStatus("generating");
  Progress.startPolling();

  // Generation timer
  State._genStartTime = Date.now();
  State._genTimerInterval = setInterval(() => {
    const elapsed = ((Date.now() - State._genStartTime) / 1000).toFixed(1);
    // During inter-pass gaps (no progress for >2s), show elapsed time
    // instead of stale step counts from the previous pass
    // Build "Generating... 3.5s" — the localized verb + suffix. The
    // numeric elapsed time and "s" unit are locale-neutral.
    const genTxt = (window.I18N && window.I18N.t) ? window.I18N.t("status.generating", "Generating...") : "Generating...";
    if (State._lastProgressTime && Date.now() - State._lastProgressTime > 2000) {
      if (btn) btn.textContent = `${genTxt} ${elapsed}s`;
    } else if (!State._lastProgressTime) {
      // No progress received yet — show elapsed time
      if (btn) btn.textContent = `${genTxt} ${elapsed}s`;
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
    const ctx = tmp.getContext("2d", { colorSpace: "srgb" });
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

    prompt:        (window.LoraStack?.compilePrompt
                     ? window.LoraStack.compilePrompt(document.getElementById("paramPrompt")?.value || "")
                     : (document.getElementById("paramPrompt")?.value || "")),
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
    inpaint_full_res: parseInt(document.getElementById("paramInpaintArea")?.value ?? "1"),
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
    session_id: SESSION_ID,
    save_outputs: State.saveOutputs,
    save_format: State.saveFormat || "png",
    save_quality: State.saveQuality || 80,
    save_lossless: State.saveLossless || false,
    embed_metadata: State.embedMetadata ?? true,
    save_dir: State.saveDir || "",
    high_precision: !!State.highPrecision,
    is_txt2img: isTxt2img,

    // Auto Watermark — composited onto the final image server-side.
    watermark_enable: !!State.watermarkEnable,
    watermark_name: State.watermarkName || "",
    watermark_position: State.watermarkPosition || "bottom-right",
    watermark_opacity: State.watermarkOpacity ?? 1.0,
    watermark_scale: State.watermarkScale ?? 0.15,
    watermark_margin: State.watermarkMargin ?? 16,
    watermark_rotation: State.watermarkRotation ?? 0,

    // Extension bridge args
    extension_args: ExtensionBridge.collectArgs(),
    // UX-015: Tell backend which extensions are disabled so it can suppress their scripts
    disabled_extensions: [...ExtensionBridge._disabled],

    // Studio-native dynamic prompt expansion (wildcards + {a|b|c}).
    // Backend reads its own stored config for the wildcard folder; only
    // the on/off flag is request-scoped.
    studio_dynamic_prompts_enabled:
      document.getElementById("toggleStudioDynPrompts")?.classList.contains("on") ?? true,

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
      // Surface Studio-native dynamic prompt warnings (missing/empty
      // wildcards, max-depth recursion) as a single combined toast so
      // the user knows their prompt didn't expand cleanly.
      const _dpWarnings = result?.settings?.studio_dynamic_prompts_warnings;
      if (Array.isArray(_dpWarnings) && _dpWarnings.length) {
        const _label = _dpWarnings.length === 1
          ? _dpWarnings[0]
          : `${_dpWarnings.length} wildcard warnings — see console`;
        showToast(_label, "info");
        console.warn("[Studio] Dynamic prompts:", _dpWarnings);
      }
      // FR-009 / WP-L2: zip the parallel response arrays into SessionEntry
      // objects and prepend to the session (newest first, capped at the
      // user-configured limit).
      const _customSaveDir = (State.saveDir || "").trim();
      const _srvEntries = result.session_entries || [];
      // image_paths only appends on save SUCCESS, so it's parallel to
      // images only when every save succeeded — the per-image truth is
      // session_entries[i].path; this is just the fallback's guard.
      const _pathsAligned = !!(result.image_paths && result.image_paths.length === result.images.length);
      const _batchTs = Date.now();
      const newEntries = result.images.map((b64, i) => {
        const srv = _srvEntries[i] || {};
        const savedPath = (srv.source === "saved" && srv.path)
          ? srv.path
          : (_pathsAligned ? result.image_paths[i] : "");
        // Extract original filename (without extension) from the server path
        const _base = (savedPath || srv.path || "").replace(/\\/g, "/").split("/").pop() || "";
        const filename = _base.replace(/\.[^.]+$/, ""); // strip extension
        let source, url, canDeleteFile = false;
        if (srv.source === "scratch" && srv.path) {
          // Unsaved result the backend wrote to session scratch. Served by
          // /studio/file (exact registered path) — works in both Gradio and
          // standalone mode, unlike /file= which Gradio handles itself.
          source = "scratch";
          canDeleteFile = true;
          url = _studioFileUrl(srv.path);
        } else if (savedPath) {
          source = "saved";
          // Forge's /file= route only serves its own output tree. When the
          // user points auto-save at a custom folder, route through
          // /studio/file instead — it allowlists the exact files Studio
          // wrote, so custom-folder saves display without retaining base64.
          url = _customSaveDir ? _studioFileUrl(savedPath) : `${API.base}/file=${savedPath}`;
        } else {
          // No file anywhere (save skipped AND scratch write failed):
          // keep the data URL, same lifecycle as a Live entry.
          source = "live";
          url = b64;
        }
        const _srvId = srv.entry_id || "";
        const entryId = _srvId || `live-${_batchTs}-${_liveEntrySeq++}`;
        return {
          sessionId: SESSION_ID,
          entryId,
          source,
          canDeleteFile,
          url,
          // session_thumb only resolves server-minted ids; entries without
          // one (live fallback, or saved without registration) show full-res.
          thumbUrl: _srvId
            ? `${API.base}/studio/session_thumb?id=${encodeURIComponent(_srvId)}&size=256`
            : url,
          // b64 retention: only the newest entry of this batch keeps the
          // base64 (canvas fast path); everything else resolves on demand.
          b64: (i === 0 || source === "live") ? b64 : null,
          infotext: (result.infotexts || [])[i] || "",
          filename,
          contentHash: (result.content_hashes || [])[i] || "",
          floatPath: (result.float_paths || [])[i] || "",
          maskPath: (result.mask_paths || [])[i] || "",
          floatStats: (result.float_stats || [])[i] || null,
          width: result.settings?.width || 0,
          height: result.settings?.height || 0,
          ts: _batchTs,
        };
      });
      // Drop cached base64 from all previous entries ("live" exempt — the
      // data URL is the image itself).
      for (const e of State.sessionEntries) {
        if (e.source !== "live") e.b64 = null;
      }
      State.sessionEntries = [...newEntries, ...State.sessionEntries];
      _applySessionLimit();
      State.selectedOutputIdx = 0;
      renderOutputGallery();
      addHistoryEntry(`Generate (seed ${result.seed})`);
      const _genElapsed = ((Date.now() - State._genStartTime) / 1000).toFixed(1);
      showToast(`Generated ${result.images.length} image${result.images.length > 1 ? "s" : ""} in ${_genElapsed}s`, "success");
      // Non-fatal server notice (e.g. an untrusted custom save folder was skipped).
      if (result.notice) showToast(result.notice, "info");
      _notifyTab(`Done — ${_genElapsed}s`);

      // Show result in viewport preview (replaces live preview)
      _showResultPreview(0);

      // Store last result on engine state for Send to Lab etc (use data URL version)
      if (window.StudioCore) window.StudioCore.state.lastResult = _pickOutputSource(0);

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
      showToast(_i18n("toast.gen.noImages", "No images generated"), "error");
    }
  } catch (e) {
    console.error("[Studio] Generation failed:", e);
    showToast(_i18n("toast.gen.failed", "Generation failed: " + e.message, { error: e.message }), "error");
  }

  State.generating = false;
  Customizer.updateToggleState();
  clearInterval(State._genTimerInterval);
  Progress.stopPolling();
  if (btn) {
    // Reset to translated "Generate" while preserving the gen-shine
    // span structure AND the data-i18n attribute so applyToDom() can
    // re-translate this button on later locale switches.
    const lbl = (window.I18N && window.I18N.t) ? window.I18N.t("actions.generate", "Generate") : "Generate";
    btn.innerHTML = '<span class="gen-shine"></span><span data-i18n="actions.generate">' + lbl + '</span>';
    btn.classList.remove("generating");
  }
  if (fill) fill.style.width = "0%";
  StatusBar.setStatus("ready");

  // Apply any model/VAE switch the user queued while this generation was
  // running. forge_model_reload() destroys shared.sd_model, which would
  // corrupt Forge's weakref tracking if it fired during process_images();
  // we defer the switch to here where the pipeline is idle. Model first,
  // then VAE — the VAE handler resolves against the currently loaded
  // checkpoint, so the model needs to settle first. The model path goes
  // through loadSelectedModelComponents so TE/VAE/row state stays in
  // sync (e.g. no leftover Anima TE after switching to SDXL).
  if (State._pendingModelSwitch) {
    const title = State._pendingModelSwitch;
    State._pendingModelSwitch = null;
    const modelSelect = document.getElementById("paramModel");
    if (modelSelect) {
      modelSelect.value = title;
      if (typeof window.loadSelectedModelComponents === "function") {
        await window.loadSelectedModelComponents("post-generation");
      } else {
        modelSelect.dispatchEvent(new Event("change"));
      }
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
  if (label) label.textContent = _i18n("panels.preview", "Preview");
}

/** Show the viewport preview with a generated result image. */
function _showResultPreview(idx) {
  const wrap = document.getElementById("canvasPreviewWrap");
  const img = document.getElementById("canvasPreview");
  const closeBtn = document.getElementById("canvasPreviewClose");
  const label = document.getElementById("canvasPreviewLabel");
  if (!wrap || !img) return;

  const imgSrc = _pickOutputSource(idx);
  if (!imgSrc) return;

  img.src = imgSrc;
  wrap.style.display = "";
  State._resultPreviewActive = true;
  State._previewShown = true;
  if (closeBtn) closeBtn.style.display = "";
  if (label) label.textContent = _i18n("panels.result", "Result");
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
    icon.dataset.i18nTitle = "tooltip.bigOutputWarning";
    icon.title = (window.I18N && window.I18N.t)
        ? window.I18N.t("tooltip.bigOutputWarning",
            "Output will exceed 2000px on one or both sides. This may cause significant VRAM usage and slow generation on most hardware.")
        : "Output will exceed 2000px on one or both sides. This may cause significant VRAM usage and slow generation on most hardware.";
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
  // Delta protocol: data.preview is non-null ONLY on a fresh decode; most
  // ticks send preview=null and we keep the current image (never clear it).
  // preview_id skips a redundant repaint — e.g. the connect catch-up
  // re-delivering an image we already painted.
  if (data.preview && State.livePreview && !liveGuard) {
    if (preview && data.preview_id !== State._lastPreviewId) {
      State._lastPreviewId = data.preview_id;
      preview.src = data.preview;
      if (wrap) wrap.style.display = "";
      State._previewShown = true;
    } else if (wrap && State._previewShown) {
      wrap.style.display = "";
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

// Same-origin /file= URL — eligible for the raw-pixel import path that
// bypasses browser image decode entirely.
function _isStudioFileSource(src) {
  return typeof src === "string" && src.indexOf("/file=") !== -1;
}

// Fetches raw RGBA bytes from /studio/image_pixels (Pillow-decoded,
// ICC-converted to sRGB on the backend). Returns { width, height,
// imageData, profile }. Throws on any failure so the caller falls back
// to <img> + drawImage.
async function _loadServerImagePixels(src) {
  const resp = await fetch(API.base + "/studio/image_pixels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: src }),
  });
  if (!resp.ok) throw new Error("pixel import failed: " + resp.status);
  const w = parseInt(resp.headers.get("X-Width"), 10);
  const h = parseInt(resp.headers.get("X-Height"), 10);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error("pixel import missing dimensions");
  }
  const buf = await resp.arrayBuffer();
  const bytes = new Uint8ClampedArray(buf);
  if (bytes.length !== w * h * 4) {
    throw new Error("pixel import byte length mismatch (expected "
      + (w * h * 4) + ", got " + bytes.length + ")");
  }
  return {
    width: w,
    height: h,
    imageData: new ImageData(bytes, w, h),
    profile: resp.headers.get("X-Color-Profile") || "unknown",
  };
}

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
    if (_lb) _lb.textContent = _i18n("panels.preview", "Preview");
  }

  // Auto-disable Hires Fix — the image is already at final resolution,
  // doubling it again would be unexpected and VRAM-expensive.
  _disableHiresFix();

  if (!window.StudioCore) return;

  // For saved Studio outputs, use backend raw RGBA + putImageData so the
  // canvas receives the same pixels Pillow reads from the autosave file.
  // Browser image decode paths (<img> / ImageBitmap "default") apply
  // Firefox's display ICC during decode on calibrated mode-2 setups, which
  // chromatically desaturates pixels before they ever reach drawImage —
  // confirmed via window.StudioDebug.sampleColorPipelineGrid as the source
  // of Moritz's canvas/export desaturation.
  //
  // Falls back to <img> + drawImage for sources that aren't file-backed
  // (Live Painting results, unsaved data URLs, drag/drop external images)
  // or when /studio/image_pixels is unreachable.
  (async () => {
    let decoded = null;
    let imgEl = null;

    if (_isStudioFileSource(imgSrc)) {
      try {
        decoded = await _loadServerImagePixels(imgSrc);
      } catch (e) {
        console.warn("[Studio] Raw pixel import failed, falling back to image import:", e.message || e);
        decoded = null;
      }
    }

    if (!decoded) {
      imgEl = new Image();
      imgEl.src = imgSrc;
      try {
        if (typeof imgEl.decode === "function") {
          await imgEl.decode();
        } else {
          await new Promise((resolve, reject) => {
            imgEl.onload = resolve;
            imgEl.onerror = () => reject(new Error("image load failed"));
          });
        }
      } catch (e) {
        console.error("[Studio] displayOnCanvas: failed to load image", e);
        return;
      }
    }

    try {
    const Core = window.StudioCore;
    const S = Core.state;
    S.lastResult = imgSrc;

    // Resize canvas to match the output image (handles hires fix). Raw
    // path uses the backend's reported dims; <img> path uses the decoded
    // image's natural dims.
    const outW = decoded ? decoded.width  : (imgEl.naturalWidth  || imgEl.width);
    const outH = decoded ? decoded.height : (imgEl.naturalHeight || imgEl.height);

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

    // Unified writer — raw path uses putImageData (1:1, no scaling, no
    // browser color management); fallback uses drawImage as before.
    const writePixels = (ctx) => {
      if (decoded) ctx.putImageData(decoded.imageData, 0, 0);
      else ctx.drawImage(imgEl, 0, 0, S.W, S.H);
    };

    if (S.layers.length > 0) {
      if (opts.newLayer) {
        // User-initiated send: always create a new layer on top
        const layerName = opts.layerName || "Imported";
        const newL = Core.makeLayer(layerName, "paint");
        writePixels(newL.ctx);
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
          writePixels(genLayer.ctx);
          genLayer.visible = true;
          S.activeLayerIdx = S.layers.length - 1;
        } else {
          // Create new Gen Result layer at the top of the stack
          genLayer = Core.makeLayer("Gen Result", "paint");
          writePixels(genLayer.ctx);
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

    // High Precision: bind/unbind the Develop module's float source to
    // match what we just put on the canvas. Sender passes opts.floatPath
    // when the image came from a generation with a sidecar; opts.maskPath
    // is the optional V2 blend-mask sidecar (AD/brush composite). The
    // third arg (imgSrc — the saved image's data URL or /file= URL) is
    // what Develop reads as the canvas pixels for the AD-mask composite.
    // We deliberately pass the source URL instead of letting Develop
    // read from S.canvas, because Studio's redraw is rAF-deferred and
    // the visible canvas isn't guaranteed to contain the new image yet
    // when this fires — that timing race produced the "black square at
    // AD region" bug from V2's first ship.
    try {
      const SD = window.StudioDevelop;
      if (SD && typeof SD.setFloatSource === "function") {
        if (opts.floatPath) {
          // Route sidecars through /studio/file (not Forge's /file=) so they
          // load even when auto-save points at a custom folder outside the
          // Forge output tree. /studio/file serves the default tree too.
          const mUrl = opts.maskPath ? _studioFileUrl(opts.maskPath) : null;
          SD.setFloatSource(_studioFileUrl(opts.floatPath), mUrl, imgSrc, outW, outH, opts.floatStats || null);
        } else {
          SD.setFloatSource(null);
        }
      }
    } catch (e) { /* Develop not loaded yet; ignore */ }
    } catch (e) {
      console.error("[Studio] displayOnCanvas: render error", e);
    }
  })();
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
  if (section) section.style.display = State.sessionEntries.length ? "" : "none";

  // Thumbs use thumbUrl (server-side 256px thumbnails for saved/scratch;
  // the data URL itself for "live") — full-res never loads in the grid.
  grid.innerHTML = State.sessionEntries.map((e, i) =>
    `<div class="output-thumb ${i === State.selectedOutputIdx ? 'selected' : ''}" data-idx="${i}">
      <img loading="lazy" src="${e.thumbUrl || e.url}" alt="Output ${i + 1}">
    </div>`
  ).join("");

  // Show infotext for selected image
  _updateOutputInfo();

  // Deck layout: the session strip is a second view of the same arrays
  // (no-op under Classic).
  SessionStrip.render();
}

/** Update the infotext display for the currently selected output image. */
function _updateOutputInfo() {
  const info = document.getElementById("outputInfo");
  if (!info) return;

  const infotext = State.sessionEntries[State.selectedOutputIdx]?.infotext || "";
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

    info.innerHTML = `<div class="infotext-summary">${summary || _i18n("infotext.noInfo", "No info")}</div>`
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
      showToast(I18N.t("toast.maskCleared", "Mask cleared"), "info");
    }
  });

  // Generate
  document.getElementById("genBtn")?.addEventListener("click", doGenerate);
  document.getElementById("interruptBtn")?.addEventListener("click", () => {
    if (!State.generating) return;
    API.interrupt();
    const btn = document.getElementById("genBtn");
    if (btn) btn.textContent = "Interrupting...";
    showToast(I18N.t("toast.interrupting", "Interrupting..."), "info");
  });
  document.getElementById("skipBtn")?.addEventListener("click", () => {
    if (!State.generating) return;
    API.skip();
    showToast(I18N.t("toast.skipping", "Skipping to next image..."), "info");
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
    if (!window.StudioCore) { showToast(I18N.t("toast.canvasNotReady", "Canvas not ready"), "error"); return; }
    const Core = window.StudioCore;
    const S = Core.state;

    const upscaler = document.getElementById("paramUpscaleModel")?.value || "R-ESRGAN 4x+";
    const scale = _num("paramUpscaleScale", 2.0);
    const runRefine = document.getElementById("checkUpscaleRefine")?.classList.contains("checked") || false;
    const runAD     = document.getElementById("checkUpscaleAD")?.classList.contains("checked") || false;

    // Get canvas composite as data URL
    const tmp = document.createElement("canvas");
    tmp.width = S.W; tmp.height = S.H;
    const ctx = tmp.getContext("2d", { colorSpace: "srgb" });
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

  // Live token counter
  document.getElementById("paramPrompt")?.addEventListener("input", () => TokenCounter.scheduleTokenCount());
  TokenCounter.scheduleTokenCount();

  // Output gallery actions
  document.getElementById("outputToCanvas")?.addEventListener("click", () => {
    // Prefer the same-origin /file= URL when present — autosave is the source
    // of truth on disk; the cached base64 has been observed to drift on Firefox
    // + calibrated wide-gamut. Same-origin file URLs draw to canvas fine (no
    // CORS issue) since they're served by Forge's own /file= route.
    const img = _pickOutputSource(State.selectedOutputIdx);
    const _entry = State.sessionEntries[State.selectedOutputIdx] || {};
    const fpath = _entry.floatPath || "";
    const mpath = _entry.maskPath || "";
    const fstats = _entry.floatStats || null;
    if (img) displayOnCanvas(img, { newLayer: true, layerName: "Output", undoLabel: "Send to canvas", floatPath: fpath, maskPath: mpath, floatStats: fstats });
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
      SessionStrip.render();
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

      const _ctxEntry = State.sessionEntries[idx] || {};
      const infotext = _ctxEntry.infotext || "";
      const seedMatch = infotext.match(/Seed:\s*(\d+)/);
      const seed = seedMatch ? seedMatch[1] : null;

      const menu = document.createElement("div");
      menu.className = "gallery-ctx-menu";
      const _hasFloatCtx = !!_ctxEntry.floatPath;
      const _exrCtxLabel = _hasFloatCtx ? "Export EXR (High Precision)" : "Export EXR (Standard)";
      menu.innerHTML = [
        { label: "Send to Canvas", action: "canvas" },
        seed ? { label: `Copy Seed (${seed})`, action: "seed" } : null,
        null, // separator
        { label: "Save As…", action: "save-as" },
        { label: _exrCtxLabel, action: "save-exr" },
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
        const imgSrc = _pickOutputSource(idx);
        const fpath = _ctxEntry.floatPath || "";
        const mpath = _ctxEntry.maskPath || "";
        if (action === "canvas" && imgSrc) {
          displayOnCanvas(imgSrc, { newLayer: true, layerName: "Output", undoLabel: "Send to canvas", floatPath: fpath, maskPath: mpath, floatStats: _ctxEntry.floatStats || null });
        } else if (action === "seed" && seed) {
          navigator.clipboard.writeText(seed).then(() => showToast(`Seed ${seed} copied`, "success"));
        } else if (action === "save-exr") {
          await _exportEXR(idx, false);
        } else if (action === "save-as") {
          await _saveAsNative(idx);
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

  // Session strip (deck layout) — same selection semantics as #outputGrid.
  // renderOutputGallery() syncs the grid selection + infotext and re-renders
  // the strip, so both views stay in lockstep.
  const _stripScroll = document.getElementById("sessionStripScroll");
  if (_stripScroll) {
    _stripScroll.addEventListener("click", (e) => {
      const thumb = e.target.closest(".session-thumb");
      if (!thumb) return;
      State.selectedOutputIdx = parseInt(thumb.dataset.idx);
      _showResultPreview(State.selectedOutputIdx);
      renderOutputGallery();
    });
    _stripScroll.addEventListener("dblclick", (e) => {
      const thumb = e.target.closest(".session-thumb");
      if (!thumb) return;
      _openCanvasOutput(parseInt(thumb.dataset.idx));
    });
  }

  /** Build a navContext from the current Canvas batch. Each slot carries
   * everything Gallery needs for ephemeral fallback (b64Url, filename,
   * infotext) plus the hash for the saved-image lookup path. */
  function _buildCanvasNavContext() {
    return State.sessionEntries.map((e) => ({
      hash: e.contentHash || "",
      // Gallery's ephemeral view tolerates a same-origin file URL here
      // (it feeds <img src>, fetch(), displayOnCanvas, and a download
      // anchor — all URL-capable), so older entries don't need base64.
      b64Url: e.b64 || e.url,
      filename: e.filename || "",
      infotext: e.infotext || "",
      // High Precision sidecar — Gallery threads this through to Develop
      // via setFloatSource when the detail view opens.
      floatPath: e.floatPath || "",
      // V2: blend-mask sidecar (AD/brush composite). When present,
      // Develop will composite canvas-uint8 over the float buffer.
      maskPath: e.maskPath || "",
      // Privacy-safe HP source stats for the Develop quality badge.
      floatStats: e.floatStats || null,
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
      const img = _pickOutputSource(idx);
      const _dragEntry = State.sessionEntries[idx] || {};
      if (img) displayOnCanvas(img, { newLayer: true, layerName: "Output", undoLabel: "Drag to canvas", floatPath: _dragEntry.floatPath || "", maskPath: _dragEntry.maskPath || "", floatStats: _dragEntry.floatStats || null });
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
  // High Precision: post the selected output to the EXR exporter. Uses
  // the .float32.bin sidecar when available (true float pixels). Falls
  // back to the 8-bit image_b64 otherwise — still emits a valid EXR for
  // pipeline compatibility, just without precision gain.
  async function _exportEXR(idx, toGallery) {
    if (idx == null || idx < 0) return;
    const _exrEntry = State.sessionEntries[idx] || {};
    const floatPath = _exrEntry.floatPath || "";
    const maskPath  = _exrEntry.maskPath  || "";
    // Backend wants image_b64. Pull from the saved /file= URL when one
    // exists (byte-faithful to disk); fall back to the cached base64 only
    // for unsaved outputs.
    const imgSrc = await _resolveOutputAsB64(idx);
    if (!floatPath && !imgSrc) return;
    // Float sidecar requires accurate dims so the backend can reshape it.
    // Probe the corresponding image (any of the parallel sources) for its
    // natural dimensions — the active canvas size may differ if the user
    // resized after generation.
    let w = 0, h = 0;
    if (floatPath && imgSrc) {
      try {
        await new Promise((resolve) => {
          const probe = new Image();
          probe.onload = () => { w = probe.naturalWidth; h = probe.naturalHeight; resolve(); };
          probe.onerror = () => resolve();
          probe.src = imgSrc;
        });
      } catch (e) { /* fall through with w=h=0 */ }
    }
    const subfolder = toGallery ? "" : "downloads";
    const stem = (_exrEntry.filename || "").trim();
    const body = {
      float_path: floatPath,
      // V2: when a mask sidecar exists, also send image_b64 so the
      // backend can composite canvas-uint8 over the float buffer in
      // AD/brush regions before writing the EXR.
      mask_path: (floatPath && maskPath) ? maskPath : "",
      image_b64: (floatPath && maskPath) ? (imgSrc || "") : (floatPath ? "" : (imgSrc || "")),
      width:  floatPath ? w : 0,
      height: floatPath ? h : 0,
      subfolder: subfolder,
      filename: stem || null,
    };
    try {
      const r = await fetch(API.base + "/studio/export/exr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (data.ok) {
        showToast("Exported " + data.filename, "success");
      } else {
        showToast(data.error || "EXR export failed", "error");
      }
    } catch (e) {
      console.error("[Studio] EXR export failed:", e);
      showToast("EXR export failed: " + e.message, "error");
    }
  }

  // Re-encode a resolved output (base64/data-URL or same-origin /file= URL)
  // into a Blob of the requested format via an offscreen canvas. Used by the
  // native "Save As…" file-picker path, which writes bytes client-side and
  // therefore can't lean on the backend encoder. Note: canvas re-encode
  // drops embedded metadata — the backend menu items keep metadata.
  function _encodeOutputBlob(src, fmt) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          const ctx = c.getContext("2d");
          if (fmt === "jpeg") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); }
          ctx.drawImage(img, 0, 0);
          const mime = fmt === "jpeg" ? "image/jpeg" : (fmt === "webp" ? "image/webp" : "image/png");
          const q = (fmt === "jpeg" || fmt === "webp") ? ((State.saveQuality || 90) / 100) : undefined;
          c.toBlob((b) => resolve(b), mime, q);
        } catch (e) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  // Native "Save As…" via the File System Access API (Chromium). Returns
  // true when handled (including user-cancel), false when unsupported or
  // failed so the caller can fall back to the backend/download flow.
  const _extForFmt = (f) => (f === "jpeg" ? "jpg" : f);
  const _mimeForFmt = (f) => (f === "jpeg" ? "image/jpeg" : (f === "webp" ? "image/webp" : "image/png"));
  const _fmtFromName = (name) => {
    const ext = (String(name).split(".").pop() || "").toLowerCase();
    if (ext === "jpg" || ext === "jpeg") return "jpeg";
    if (ext === "webp") return "webp";
    return "png";
  };
  // Decode a same-format data URL straight to a Blob — no canvas re-encode,
  // so embedded metadata (prompt/seed/settings) is preserved. Used when the
  // chosen Save As format matches the source format.
  function _dataUrlToBlob(dataUrl) {
    try {
      const [head, b64] = dataUrl.split(",");
      const mime = (head.match(/data:([^;]+)/) || [])[1] || "application/octet-stream";
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: mime });
    } catch { return null; }
  }

  // Save As… — open the OS native save dialog so the user chooses the name,
  // location, AND format, exactly like any desktop app. Falls back to a
  // browser download (with a suggested filename) where the File System Access
  // API isn't available (Firefox/Safari) — there the browser's own "ask where
  // to save" setting governs the location prompt.
  async function _saveAsNative(idx = State.selectedOutputIdx) {
    const imgSrc = await _resolveOutputAsB64(idx);
    if (!imgSrc) { showToast("No image to save", "info"); return; }
    const srcMime = (imgSrc.match(/^data:([^;]+)/) || [])[1] || "image/png";
    const srcFmt = srcMime === "image/jpeg" ? "jpeg" : (srcMime === "image/webp" ? "webp" : "png");
    const defFmt = State.saveFormat || srcFmt || "png";
    const _saveEntry = State.sessionEntries[idx] || {};
    const stem = (_saveEntry.filename || `studio_${Date.now()}`).replace(/\.[^.]+$/, "");
    const infotext = State.embedMetadata ? (_saveEntry.infotext || "") : "";

    // 1) Server-side native "Save As…" dialog. This is the reliable path for a
    //    local Forge install: it pops a real OS dialog regardless of browser
    //    (the File System Access API needs Chromium + a secure context, so it
    //    isn't available over a LAN IP or in Firefox), and the backend write
    //    preserves embedded metadata. A 500/network error means the server has
    //    no GUI (headless/remote) — fall through to the browser paths.
    try {
      const r = await fetch(API.base + "/studio/gallery/pick-save-file", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suggested: stem + "." + _extForFmt(defFmt), format: defFmt }),
      });
      const data = await r.json();
      if (r.ok && !data.error) {
        if (!data.path) return;                       // user cancelled the dialog
        // Only do the server-side write when the dialog minted a token. If we
        // got a path but no token (server couldn't mint), don't send a save
        // that would land in the default folder — fall through to the browser
        // save path instead so the file goes where intended.
        if (data.token) {
          const res = await API.saveImage({
            image_b64: imgSrc,
            format: _fmtFromName(data.path),
            quality: State.saveQuality || 95,
            metadata: infotext || null,
            save_token: data.token,   // server resolves it; never a raw client path
          });
          if (res.ok) showToast("Saved " + res.filename, "success");
          else showToast(res.error || "Save failed", "error");
          return;
        }
      }
      // data.error present (server dialog unavailable) or no token → fall through.
    } catch (_) { /* headless/remote server — fall through to browser paths */ }

    // Reuse the source bytes (keeps embedded metadata) when no format change
    // is needed; otherwise re-encode via an offscreen canvas.
    const _bytesFor = async (fmt) =>
      (fmt === srcFmt) ? _dataUrlToBlob(imgSrc) : await _encodeOutputBlob(imgSrc, fmt);

    // 2) Browser File System Access API (Chromium + secure context).
    if (typeof window.showSaveFilePicker === "function") {
      const order = [defFmt, ...["png", "jpeg", "webp"].filter(f => f !== defFmt)];
      const types = order.map(f => ({
        description: f.toUpperCase() + " image",
        accept: { [_mimeForFmt(f)]: ["." + _extForFmt(f)] },
      }));
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: stem + "." + _extForFmt(defFmt), types });
        const fmt = _fmtFromName(handle.name);
        const blob = await _bytesFor(fmt);
        if (!blob) { showToast("Could not encode image", "error"); return; }
        const w = await handle.createWritable();
        await w.write(blob);
        await w.close();
        showToast("Saved " + handle.name, "success");
      } catch (err) {
        if (err && err.name === "AbortError") return; // user cancelled — no toast
        console.warn("[Studio] Save As (native) failed:", err);
        showToast("Save As failed: " + (err?.message || err), "error");
      }
      return;
    }

    // 3) Last resort — browser download with a suggested name (the browser's
    //    own "ask where to save" setting governs any location prompt).
    const blob = await _bytesFor(defFmt);
    if (!blob) { showToast("Could not encode image", "error"); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = stem + "." + _extForFmt(defFmt);
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    showToast("Saved to your browser downloads", "info");
  }

  // Gallery save — anchor a floating popover off the icon button so we
  // can offer "Save to Gallery" (drops in the watched outputs root) in
  // addition to the format-specific download targets.
  async function _saveSelectedOutput(fmt, toGallery) {
    // Saved /file= URL takes precedence over the cached base64 — see
    // _pickOutputSource. /studio/save_image needs a base64 string, so
    // resolve via _resolveOutputAsB64 which fetches the file fresh when
    // the source is a URL.
    const imgSrc = await _resolveOutputAsB64(State.selectedOutputIdx);
    if (!imgSrc) return;
    const _selEntry = State.sessionEntries[State.selectedOutputIdx] || {};
    const infotext = State.embedMetadata
      ? (_selEntry.infotext || "")
      : "";
    // toGallery + a configured "Save to Gallery folder" (server-side absolute
    // path) routes the write there. Without a configured folder we preserve
    // the legacy behavior: gallery → output/studio/ (the watched root),
    // downloads → output/studio/downloads/. Hoisted so the catch can tell a
    // Gallery-destination failure apart from a plain save failure.
    const galleryDir = toGallery ? (State.galleryFolder || "").trim() : "";
    try {
      const origName = _selEntry.filename || null;
      const result = await API.saveImage({
        image_b64: imgSrc,
        format: fmt,
        quality: 95,
        metadata: infotext || null,
        subfolder: toGallery ? "" : "downloads",
        dest_dir: galleryDir || null,
        filename: origName,
      });
      if (result.ok) {
        const base = toGallery
          ? `Saved to Gallery → ${result.filename}`
          : `Saved ${result.filename}`;
        showToast(result.notice ? `${base} (${result.notice})` : base, "success");
      } else {
        showToast(result.error || "Save failed", "error");
      }
    } catch (e) {
      console.error("[Studio] Save failed:", e);
      // A misconfigured "Save to Gallery folder" must surface a clear error,
      // not silently divert to the browser's Downloads — that would defeat
      // the user's chosen destination. Show the backend message instead.
      if (galleryDir) {
        showToast("Save to Gallery failed: " + e.message, "error");
        return;
      }
      // Otherwise (default save) fall back to a client-side download so the
      // user doesn't lose the image (parity with the canvas save path).
      try {
        const a = document.createElement("a");
        a.href = imgSrc;
        a.download = (_selEntry.filename || `studio_${Date.now()}`)
          .replace(/\.[^.]+$/, "") + "." + (fmt === "jpeg" ? "jpg" : fmt);
        document.body.appendChild(a); a.click();
        setTimeout(() => document.body.removeChild(a), 100);
        showToast("Saved locally (server save failed: " + e.message + ")", "info");
      } catch (_) {
        showToast("Save failed: " + e.message, "error");
      }
    }
  }

  // Secondary "▾" menu beside Save As… — the destinations that aren't a
  // plain file (Gallery is an internal target; EXR is a niche float export).
  // Save As… itself opens the OS save dialog directly; it isn't in here.
  function _showOutputSaveMenu(anchor) {
    const existing = document.getElementById("outputSaveMenu");
    if (existing) { existing.remove(); return; }

    // EXR label tracks whether the selected slot has a float sidecar — so
    // users know whether they're getting true HDR data or a uint8 → EXR
    // conversion.
    const _idx = State.selectedOutputIdx;
    const _hasFloat = !!State.sessionEntries[_idx]?.floatPath;
    const _exrLabel = _hasFloat ? "Export EXR (High Precision)" : "Export EXR (Standard)";
    const _fmt = State.saveFormat || "png";

    const items = [
      { label: "Save to Gallery", fn: () => _saveSelectedOutput(_fmt, true) },
      { label: _exrLabel,         fn: () => _exportEXR(_idx, false) },
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

  // Save — one click, no prompt. Uses the default output format + folder
  // from Settings (respects State.saveFormat). Save As… covers everything
  // else (format / location / Gallery).
  document.getElementById("outputSave")?.addEventListener("click", () => {
    _saveSelectedOutput(State.saveFormat || "png", false);
  });

  // Save As… — open the OS native save dialog (name / location / format),
  // just like any desktop app.
  document.getElementById("outputSaveAs")?.addEventListener("click", () => {
    _saveAsNative();
  });

  // ▾ — secondary destinations (Save to Gallery, Export EXR).
  document.getElementById("outputSaveMore")?.addEventListener("click", (e) => {
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

  // ─── Shared model-component load helper ───────────────────────────────
  // Single source of truth for switching the loaded checkpoint + its
  // companion components (VAE, external Text Encoder). All entry points
  // (paramModel change, paramTextEncoder change, pending-switch flush
  // after generation, workflow apply) funnel through here so the UI
  // dropdowns and Forge's loading state can never desync.
  //
  // The TE row visibility and value are driven entirely from the current
  // model's `check_model_te` result. When the model doesn't need an
  // external TE, the row is hidden and paramTextEncoder is forced to
  // "None" — that ensures the next POST /studio/load_model rebuilds
  // additional_modules without any leftover Anima/Cosmos TE entry.
  //
  // `reason` controls per-model TE memory behavior:
  //   "model-change"     — user picked a new checkpoint; restore from
  //                        per-model TE memory if available.
  //   "te-change"        — user picked a TE explicitly; keep it as-is
  //                        and persist it to per-model memory.
  //   "workflow-apply"   — workflow already wrote paramTextEncoder; keep
  //                        the workflow's value, do NOT restore from
  //                        memory (memory would clobber the workflow).
  //   "session-restore"  — defaults/session already wrote paramTextEncoder;
  //                        keep the saved value, do NOT restore from memory
  //                        (same as workflow-apply, used by the boot sync).
  //   "generation-preflight" — Generate detected the backend didn't match
  //                        the UI selection; load the UI's components as-is
  //                        before generating. Keeps the explicit value.
  //   "post-generation"  — pending switch flushed after a generation;
  //                        same restore semantics as "model-change".
  // Returns true when the backend reports a successful load, false on any
  // failure or when the switch was deferred. Most callers ignore the
  // result; the generation preflight relies on it to abort cleanly.
  async function loadSelectedModelComponents(reason = "model-change") {
    const modelSelect = document.getElementById("paramModel");
    const title = modelSelect?.value;
    if (!title) return false;

    // Queue when generation is in flight — forge_model_reload() would
    // destroy shared.sd_model out from under process_images(). The
    // post-generation flush re-enters this helper with reason
    // "post-generation".
    if (State.generating && reason !== "post-generation") {
      State._pendingModelSwitch = title;
      showToast(
        I18N.t("toast.modelSwitchPending", "Model will switch after generation completes"),
        "info",
      );
      return false;
    }

    const teSelect = document.getElementById("paramTextEncoder");
    const vaeVal = document.getElementById("paramVAE")?.value;

    // Resolve TE through the shared architecture-aware helper. It
    // handles row visibility, memory restore, and the no-external-TE
    // bundled case (forces value to "None" so additional_modules
    // doesn't leak the prior arch's TE into load_model).
    const previousArch = State._currentModelArch || null;
    const teBeforeRestore = teSelect?.value || "None";
    const check = await restoreTextEncoderForModel(title, reason, {
      preferredTE: teBeforeRestore,
      previousArch,
    });
    State._currentModelArch = check.arch || "unknown";

    const textEncoder = teSelect?.value || "None";

    // Persist per-model TE memory when the user explicitly picked one.
    if (reason === "te-change" && textEncoder !== "None") {
      rememberExternalTE(title, State._currentModelArch, textEncoder);
    }

    // Build the load body. Send text_encoder explicitly even when "None"
    // so the backend knows to drop any prior external TE.
    const loadBody = { title, text_encoder: textEncoder };
    if (vaeVal && vaeVal !== "Automatic" && vaeVal !== "None") {
      loadBody.vae = vaeVal;
    }

    const btn = document.getElementById("genBtn");
    const fill = document.getElementById("progressFill");
    if (btn) {
      btn.textContent = _i18n("toast.model.loading", "Loading model...");
      btn.classList.add("generating");
    }
    if (fill) { fill.style.width = "100%"; fill.classList.add("indeterminate"); }
    StatusBar.setStatus("loading");

    let loadedOk = false;
    try {
      const r = await fetch(API.base + "/studio/load_model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loadBody),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        loadedOk = true;
        StatusBar.setModel(data.loaded.split("[")[0].trim());
        showToast(
          _i18n("toast.model.loaded", "Model loaded: " + data.loaded, { name: data.loaded }),
          "success",
        );
      } else {
        console.error("[Studio] Model load failed:", data);
        showToast(
          _i18n(
            "toast.model.loadFailed",
            "Model load failed: " + (data.error || r.status),
            { error: data.error || r.status },
          ),
          "error",
        );
      }
    } catch (err) {
      console.error("[Studio] Model load error:", err);
      showToast(
        _i18n("toast.model.loadError", "Model load error: " + err.message, { error: err.message }),
        "error",
      );
    }

    if (btn) {
      btn.textContent = (window.I18N && window.I18N.t)
        ? window.I18N.t("actions.generate", "Generate")
        : "Generate";
      btn.classList.remove("generating");
    }
    if (fill) { fill.style.width = "0%"; fill.classList.remove("indeterminate"); }
    StatusBar.setStatus("ready");
    return loadedOk;
  }
  window.loadSelectedModelComponents = loadSelectedModelComponents;

  // Model change in settings
  document.getElementById("paramModel")?.addEventListener("change", async () => {
    await loadSelectedModelComponents("model-change");
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
      showToast(I18N.t("toast.vaeSwitchPending", "VAE will switch after generation completes"), "info");
      return;
    }
    showToast(I18N.t("toast.switchingVae", "Switching VAE..."), "info");
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
        showToast(_i18n("toast.vae.loadFailed", "VAE load failed: " + (data.error || r.status), { error: data.error || r.status }), "error");
      }
    } catch (err) {
      console.error("[Studio] VAE load error:", err);
      showToast(_i18n("toast.vae.loadError", "VAE load error: " + err.message, { error: err.message }), "error");
    }
  });

  // Text Encoder change — reload the current model with the chosen TE.
  // Setting TE to "None" still triggers a reload so the backend rebuilds
  // additional_modules without any stale external TE entry. Per-model
  // memory is persisted inside loadSelectedModelComponents("te-change").
  document.getElementById("paramTextEncoder")?.addEventListener("change", async () => {
    const title = document.getElementById("paramModel")?.value;
    if (!title) return;
    await loadSelectedModelComponents("te-change");
  });

  // Toggle tracks — generic CSS toggle
  document.querySelectorAll(".toggle-track").forEach(t => {
    t.addEventListener("click", () => t.classList.toggle("on"));
  });

  // ===== REFRESH BUTTONS =====
  document.getElementById("refreshModelsBtn")?.addEventListener("click", async () => {
    showToast(I18N.t("toast.refreshingModels", "Refreshing models..."), "info");
    // Stash the current model+TE into TE memory before the rebuild so
    // populateDropdowns can restore it (populateDropdowns also stashes,
    // but doing it here too ensures the model selection survives even
    // if populateDropdowns runs in parallel with the TE list fetch).
    const _curModel = document.getElementById("paramModel")?.value || "";
    const _curTE = document.getElementById("paramTextEncoder")?.value || "None";
    if (_curModel && _curTE !== "None") {
      try {
        const c = await checkModelTE(_curModel);
        rememberExternalTE(_curModel, c.arch, _curTE);
      } catch (_) { /* ignore */ }
    }
    try {
      await API.refreshModels();
      await populateDropdowns();
      showToast(I18N.t("toast.modelsRefreshed", "Models refreshed"), "success");
    } catch (e) {
      showToast(I18N.t("toast.refreshFailed", "Refresh failed: {error}", {error: e.message}), "error");
    }
  });

  document.getElementById("refreshVAEBtn")?.addEventListener("click", async () => {
    showToast(I18N.t("toast.refreshingVaes", "Refreshing VAEs..."), "info");
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
      showToast(I18N.t("toast.vaeRefreshFailed", "VAE refresh failed: {error}", {error: e.message}), "error");
    }
  });

  document.getElementById("refreshTEBtn")?.addEventListener("click", async () => {
    showToast(_i18n("toast.te.refreshing", "Refreshing text encoders..."), "info");
    try {
      const teList = await fetch(API.base + "/studio/text_encoders").then(r => r.json());
      const teSelect = document.getElementById("paramTextEncoder");
      const current = teSelect?.value || "None";
      if (teSelect) {
        teSelect.innerHTML = '<option value="None">None (bundled)</option>' +
          teList.map(name =>
            `<option value="${name}">${name}</option>`
          ).join("");
      }
      State._textEncoderList = teList;
      // Funnel restore through the arch-aware helper so a missing TE
      // falls back to "None" (with toast) instead of staying selected
      // as a now-invalid option.
      const currentModel = document.getElementById("paramModel")?.value || "";
      if (currentModel) {
        const check = await restoreTextEncoderForModel(currentModel, "model-change", {
          preferredTE: current,
          previousArch: State._currentModelArch || null,
        });
        State._currentModelArch = check.arch || "unknown";
      } else if (teSelect && _optionExists(teSelect, current)) {
        teSelect.value = current;
      }
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

  // Session history size (WP-L2) — clamped 8–200, persisted, applied
  // immediately (lowering the limit evicts the overflow right away).
  {
    const limitInput = document.getElementById("settingSessionLimit");
    if (limitInput) {
      limitInput.value = _sessionLimit();
      limitInput.addEventListener("change", () => {
        const v = Math.max(8, Math.min(200, parseInt(limitInput.value, 10) || 50));
        limitInput.value = v;
        localStorage.setItem("studio-session-limit", String(v));
        _applySessionLimit();
        renderOutputGallery();
      });
    }
  }
  // Clear session — Settings button + session strip header button (deck)
  document.getElementById("clearSessionBtn")?.addEventListener("click", _clearSession);
  document.getElementById("sessionStripClear")?.addEventListener("click", _clearSession);

  // High Precision: capture float32 VAE output and save .float32.bin sidecar
  document.getElementById("toggleHighPrecision")?.addEventListener("click", () => {
    State.highPrecision = document.getElementById("toggleHighPrecision")?.classList.contains("on") ?? false;
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

  // ===== Studio-native dynamic prompt expansion =====
  // The toggle's enabled state is sent per-generation. The wildcard
  // folder mode/path is server-side state we sync on startup and on
  // explicit Set/Reset clicks. We never POST the folder text on every
  // keystroke — only on Set, to avoid round-tripping arbitrary input.
  const _dynPromptsToggle = document.getElementById("toggleStudioDynPrompts");
  const _dynFolderInput = document.getElementById("dynPromptsFolderInput");
  const _dynFolderDisplay = document.getElementById("dynPromptsFolderDisplay");
  const _dynFolderBrowse = document.getElementById("dynPromptsFolderBrowse");
  const _dynFolderSet = document.getElementById("dynPromptsFolderSet");
  const _dynFolderReset = document.getElementById("dynPromptsFolderReset");
  const _dynFolderManualRow = document.getElementById("dynPromptsFolderManualRow");
  const _dynDpNote = document.getElementById("dynPromptsDpNote");

  function _renderDynPromptsConfig(cfg) {
    if (!cfg) return;
    if (_dynFolderDisplay) {
      if (cfg.wildcard_folder_mode === "custom" && cfg.wildcard_folder_display) {
        _dynFolderDisplay.textContent = `custom: ${cfg.wildcard_folder_display}`;
        _dynFolderDisplay.title = cfg.wildcard_folder || "";
      } else {
        _dynFolderDisplay.textContent = "Default folders";
        _dynFolderDisplay.title = "";
      }
    }
    if (_dynFolderInput) {
      _dynFolderInput.value = cfg.wildcard_folder || "";
    }
    if (typeof cfg.studio_dynamic_prompts_enabled === "boolean" && _dynPromptsToggle) {
      // Only adjust if the server has a different stored state — preserves
      // the user's most-recent click after a defaults restore.
      _dynPromptsToggle.classList.toggle("on", cfg.studio_dynamic_prompts_enabled);
    }
  }

  function _loadDynPromptsConfig() {
    return API.dynPromptsConfig().then(cfg => {
      _renderDynPromptsConfig(cfg);
      return cfg;
    }).catch(() => null);
  }

  function _showDpNote(present) {
    if (_dynDpNote) _dynDpNote.style.display = present ? "" : "none";
  }

  // Sync toggle state to server config so it persists across reloads
  // and is independent of workflow-defaults state (which would let one
  // saved workflow accidentally re-enable native expansion for users
  // who turned it off globally).
  _dynPromptsToggle?.addEventListener("click", () => {
    const on = _dynPromptsToggle.classList.contains("on");
    API.dynPromptsSetConfig({ studio_dynamic_prompts_enabled: on })
      .catch(() => {/* silent — toggle still works locally for this session */});
  });

  // Notify other modules that the active wildcard root changed so their
  // cached lists/trees match what generation will resolve. Best-effort:
  // each hook is optional and failures are non-fatal.
  function _onWildcardFolderChanged() {
    try { window.TagComplete?.refreshWildcards?.(); } catch (_) {}
    try { window.WildcardBrowser?.refresh?.(); } catch (_) {}
    try { window.LexiconAPI?.refresh?.(); } catch (_) {}
  }

  function _applyPickedFolder(folder) {
    if (!folder) return;  // user cancelled
    return API.dynPromptsSelectFolder(folder).then(resp => {
      _renderDynPromptsConfig(resp);
      _onWildcardFolderChanged();
      if (resp.warning) {
        showToast(resp.warning, "info");
      } else {
        showToast("Wildcard folder saved.", "info");
      }
    }).catch(() => showToast("Failed to save wildcard folder.", "error"));
  }

  _dynFolderBrowse?.addEventListener("click", () => {
    API.dynPromptsPickFolder().then(resp => {
      if (resp?.unavailable) {
        // Headless host or no display server — reveal the manual-path
        // row so the user can still set a folder by pasting.
        if (_dynFolderManualRow) _dynFolderManualRow.style.display = "";
        if (_dynFolderBrowse) _dynFolderBrowse.style.display = "none";
        showToast("Folder picker unavailable on this server — enter path manually.", "info");
        return;
      }
      _applyPickedFolder(resp?.path || "");
    }).catch(() => {
      // Likely 500 from the Tk fallback path; surface the manual entry.
      if (_dynFolderManualRow) _dynFolderManualRow.style.display = "";
      if (_dynFolderBrowse) _dynFolderBrowse.style.display = "none";
      showToast("Folder picker unavailable — enter path manually.", "info");
    });
  });

  _dynFolderSet?.addEventListener("click", () => {
    const folder = (_dynFolderInput?.value || "").trim();
    if (!folder) {
      showToast("Enter a folder path or click Reset.", "info");
      return;
    }
    _applyPickedFolder(folder);
  });

  _dynFolderReset?.addEventListener("click", () => {
    API.dynPromptsSelectFolder("").then(resp => {
      _renderDynPromptsConfig(resp);
      _onWildcardFolderChanged();
      showToast("Wildcard folder reset to default.", "info");
    }).catch(() => showToast("Failed to reset wildcard folder.", "error"));
  });

  // Initial sync — non-blocking; if the API isn't ready yet the UI just
  // shows its defaults until the user interacts.
  _loadDynPromptsConfig();
  API.dynPromptsStatus().then(s => _showDpNote(!!s?.dp_extension_present)).catch(() => {});

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

  // ===== Save to Gallery folder =====
  // Folder paths are machine config, not per-image workflow params, so they
  // persist immediately to localStorage (no need to click "Save Defaults").
  // _restoreFolderSettings() re-applies them on boot, after defaults load.
  const _galFolderInput = document.getElementById("settingGalleryFolder");
  const _syncGalFolder = () => {
    State.galleryFolder = (_galFolderInput?.value || "").trim();
    try { localStorage.setItem("studio-gallery-folder", State.galleryFolder); } catch (_) {}
  };
  _galFolderInput?.addEventListener("input", _syncGalFolder);
  _galFolderInput?.addEventListener("change", _syncGalFolder);
  // Browse — native folder picker on the Forge/Studio server machine.
  // Reuses the Gallery's existing server-side picker. Manual entry above is
  // always available (and is the only option for headless/remote servers).
  document.getElementById("galleryFolderBrowse")?.addEventListener("click", async () => {
    try {
      const r = await fetch(API.base + "/studio/gallery/pick-folder", { method: "POST" });
      const data = await r.json();
      if (data.error) { showToast("Folder picker unavailable: " + data.error, "info"); return; }
      if (data.path && _galFolderInput) {
        _galFolderInput.value = data.path;
        _syncGalFolder();
        // Picking a save destination is an explicit write intent → trust it.
        if (await _trustSaveFolder(data.path)) _renderTrustedRoots();
      }
    } catch (e) {
      showToast("Folder picker unavailable on this server — type the path manually", "info");
    }
  });
  // Open — reveal the configured folder on the server machine.
  document.getElementById("galleryFolderOpen")?.addEventListener("click", async () => {
    const dir = (_galFolderInput?.value || "").trim();
    if (!dir) { showToast("No Gallery folder set", "info"); return; }
    try {
      const r = await fetch(API.base + "/studio/open_folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: dir }),
      });
      const data = await r.json();
      if (data.ok) showToast("Opened Gallery folder", "success");
      else showToast(data.error || "Could not open folder", "error");
    } catch (e) {
      showToast("Could not open folder: " + e.message, "error");
    }
  });

  // ===== Auto-save folder (where generated images are written) =====
  const _saveDirInput = document.getElementById("settingSaveDir");
  const _syncSaveDir = () => {
    State.saveDir = (_saveDirInput?.value || "").trim();
    try { localStorage.setItem("studio-save-dir", State.saveDir); } catch (_) {}
  };
  _saveDirInput?.addEventListener("input", _syncSaveDir);
  _saveDirInput?.addEventListener("change", _syncSaveDir);
  document.getElementById("saveDirBrowse")?.addEventListener("click", async () => {
    try {
      const r = await fetch(API.base + "/studio/gallery/pick-folder", { method: "POST" });
      const data = await r.json();
      if (data.error) { showToast("Folder picker unavailable: " + data.error, "info"); return; }
      if (data.path && _saveDirInput) {
        _saveDirInput.value = data.path;
        _syncSaveDir();
        // Picking a save destination is an explicit write intent → trust it.
        if (await _trustSaveFolder(data.path)) _renderTrustedRoots();
      }
    } catch (e) {
      showToast("Folder picker unavailable on this server — type the path manually", "info");
    }
  });
  document.getElementById("saveDirOpen")?.addEventListener("click", async () => {
    const dir = (_saveDirInput?.value || "").trim();
    if (!dir) { showToast("No save folder set", "info"); return; }
    try {
      const r = await fetch(API.base + "/studio/open_folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: dir }),
      });
      const data = await r.json();
      if (data.ok) showToast("Opened save folder", "success");
      else showToast(data.error || "Could not open folder", "error");
    } catch (e) {
      showToast("Could not open folder: " + e.message, "error");
    }
  });
  document.getElementById("saveDirTrust")?.addEventListener("click", async () => {
    if (await _trustSaveFolder((_saveDirInput?.value || "").trim())) _renderTrustedRoots();
  });
  document.getElementById("galleryFolderTrust")?.addEventListener("click", async () => {
    if (await _trustSaveFolder((_galFolderInput?.value || "").trim())) _renderTrustedRoots();
  });
  _renderTrustedRoots();

  // ===== Auto Watermark =====
  const _wmToggle = document.getElementById("toggleWatermark");
  const _wmSelect = document.getElementById("settingWatermark");
  const _wmOpts = document.getElementById("watermarkOpts");
  const _wmPos = document.getElementById("settingWatermarkPosition");
  const _wmOpacity = document.getElementById("settingWatermarkOpacity");
  const _wmScale = document.getElementById("settingWatermarkScale");
  const _wmMargin = document.getElementById("settingWatermarkMargin");
  const _wmRotation = document.getElementById("settingWatermarkRotation");

  // Populate the watermark dropdown from <ext>/watermarks/, preserving the
  // current selection across refreshes (same pattern as the model select).
  function _loadWatermarks() {
    if (!_wmSelect) return Promise.resolve();
    const prev = State.watermarkName || _wmSelect.value || "";
    return API.watermarks().then(list => {
      const items = Array.isArray(list) ? list : [];
      _wmSelect.innerHTML = `<option value="">— None —</option>` +
        items.map(w => `<option value="${w.name}">${w.name}</option>`).join("");
      if (prev && items.some(w => w.name === prev)) _wmSelect.value = prev;
      try { window.StudioSearchableSelect?.attach(_wmSelect, { placeholder: "— Select watermark —", searchPlaceholder: "Filter…" }); } catch (_) {}
    }).catch(() => {});
  }

  _wmToggle?.addEventListener("click", () => {
    State.watermarkEnable = _wmToggle.classList.contains("on");
    if (_wmOpts) _wmOpts.style.display = State.watermarkEnable ? "" : "none";
    if (State.watermarkEnable) _loadWatermarks();
  });
  _wmSelect?.addEventListener("change", () => { State.watermarkName = _wmSelect.value || ""; });
  _wmPos?.addEventListener("change", () => { State.watermarkPosition = _wmPos.value || "bottom-right"; });
  _wmOpacity?.addEventListener("input", () => {
    const v = parseInt(_wmOpacity.value);
    const lbl = document.getElementById("settingWatermarkOpacityVal");
    if (lbl) lbl.textContent = v + "%";
    State.watermarkOpacity = v / 100;
  });
  _wmScale?.addEventListener("input", () => {
    const v = parseInt(_wmScale.value);
    const lbl = document.getElementById("settingWatermarkScaleVal");
    if (lbl) lbl.textContent = v + "%";
    State.watermarkScale = v / 100;
  });
  _wmMargin?.addEventListener("input", () => {
    const v = parseInt(_wmMargin.value);
    const lbl = document.getElementById("settingWatermarkMarginVal");
    if (lbl) lbl.textContent = v + "px";
    State.watermarkMargin = v;
  });
  _wmRotation?.addEventListener("input", () => {
    const v = parseInt(_wmRotation.value);
    const lbl = document.getElementById("settingWatermarkRotationVal");
    if (lbl) lbl.textContent = v + "°";
    State.watermarkRotation = v;
  });
  document.getElementById("watermarkRefresh")?.addEventListener("click", () => {
    _loadWatermarks().then(() => showToast("Watermark list refreshed", "info"));
  });
  document.getElementById("watermarkOpenFolder")?.addEventListener("click", () => {
    API.openWatermarksFolder().then(resp => {
      const hint = document.getElementById("watermarkFolderHint");
      if (resp && resp.unavailable && resp.path) {
        if (hint) { hint.textContent = "Drop watermark files here: " + resp.path; hint.style.display = ""; }
        showToast("Folder picker unavailable — path shown below.", "info");
      } else if (resp && resp.ok) {
        showToast("Opened watermarks folder", "success");
      }
    }).catch(() => {});
  });
  // Populate on init so the dropdown is ready when the group is opened.
  _loadWatermarks();

  // ===== UX-013: VRAM MANAGEMENT =====

  // Manual unload button
  document.getElementById("unloadModelBtn")?.addEventListener("click", async () => {
    showToast(_i18n("toast.model.unloading", "Unloading model..."), "info");
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
          showToast(_i18n("toast.model.alreadyUnloaded", "Model already unloaded"), "info");
        } else {
          showToast(_i18n("toast.model.unloadedVRAM", "Model unloaded from VRAM"), "success");
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
          showToast(_i18n("toast.gpuWeights.reset", "GPU weights reset to Forge default"), "success");
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
          showToast(_i18n("toast.gpuWeights.failed", "Failed to set GPU weights"), "error");
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
      ["paramLoraStack", "val"],
    ],
    gen: [
      ["paramModel", "val"],
      ["paramVAE", "val"],
      ["paramTextEncoder", "val"],
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
      ["toggleSaveOutputs", "on"], ["toggleHighPrecision", "on"], ["toggleLivePreview", "on"],
      ["toggleMetadata", "on"],
      // Panel collapse state (Generate tab sections)
      ["panelSampling", "open"], ["panelCanvas", "open"], ["panelSeedBatch", "open"],
      ["panelSoftInpaint", "open"], ["panelHires", "open"],
      ["panelAD", "open"], ["panelUpscale", "open"], ["panelCN", "open"],
    ],
    format: [
      ["settingSaveFormat", "val"], ["settingJpegQuality", "val"], ["settingWebpQuality", "val"],
      ["toggleWebpLossless", "on"], ["settingGalleryFolder", "val"],
      ["settingSaveDir", "val"],
    ],
    // Watermark settings persist regardless of the enable toggle, so a user's
    // configured mark/position/sliders survive disabling + reload.
    watermark: [
      ["toggleWatermark", "on"], ["settingWatermark", "val"],
      ["settingWatermarkPosition", "val"], ["settingWatermarkOpacity", "val"],
      ["settingWatermarkScale", "val"], ["settingWatermarkMargin", "val"],
      ["settingWatermarkRotation", "val"],
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
  // Exposed so the first-run flow can persist its choices without going
  // through the Settings button (which fires its own toast).
  window._studioSaveDefaults = saveDefaults;

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
        // Collapse panel state — sync both body and its sibling arrow.
        // Inline max-height: "none" when opening (so dynamic content
        // can grow freely) and "" when closing (lets the closed-state
        // base rule take over). Without this, panels restored as open
        // would inherit the CSS fallback and fail to size to actual
        // content; closed ones could get stuck at the fallback height.
        if (data[id]) {
          el.classList.add("open");
          el.style.maxHeight = "none";
        } else {
          el.classList.remove("open");
          el.style.maxHeight = "";
        }
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
        if (el.tagName === 'SELECT') {
          if (el.value !== String(data[id])) {
            console.warn(`[Studio Defaults] "${id}": saved value "${data[id]}" not in dropdown — option may not exist`);
          }
          // Refresh searchable-select trigger label. Setting select.value
          // is a property write, which the wrapper's MutationObserver
          // doesn't catch (it only sees attribute mutations) — so without
          // this the trigger keeps displaying whichever option's HTML
          // `selected` attribute lit it up (e.g. paramSampler always
          // showing "DPM++ 2M SDE" even when the underlying value is
          // correctly the user's saved choice).
          try { window.StudioSearchableSelect?.attach(el)?.refresh?.(); } catch (_) {}
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
    State.highPrecision = document.getElementById("toggleHighPrecision")?.classList.contains("on") ?? false;
    State.livePreview = document.getElementById("toggleLivePreview")?.classList.contains("on") ?? true;
    State.embedMetadata = document.getElementById("toggleMetadata")?.classList.contains("on") ?? true;
    // Sync output format state
    State.galleryFolder = document.getElementById("settingGalleryFolder")?.value?.trim() || "";
    State.saveDir = document.getElementById("settingSaveDir")?.value?.trim() || "";
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

    // Sync watermark state + labels from restored DOM (.value sets don't fire events)
    State.watermarkEnable = document.getElementById("toggleWatermark")?.classList.contains("on") ?? false;
    State.watermarkName = document.getElementById("settingWatermark")?.value || "";
    State.watermarkPosition = document.getElementById("settingWatermarkPosition")?.value || "bottom-right";
    const wmOp = parseInt(document.getElementById("settingWatermarkOpacity")?.value);
    const wmSc = parseInt(document.getElementById("settingWatermarkScale")?.value);
    const wmMg = parseInt(document.getElementById("settingWatermarkMargin")?.value);
    const wmRo = parseInt(document.getElementById("settingWatermarkRotation")?.value);
    State.watermarkOpacity = Number.isFinite(wmOp) ? wmOp / 100 : 1.0;
    State.watermarkScale = Number.isFinite(wmSc) ? wmSc / 100 : 0.15;
    State.watermarkMargin = Number.isFinite(wmMg) ? wmMg : 16;
    State.watermarkRotation = Number.isFinite(wmRo) ? wmRo : 0;
    const _wmOpL = document.getElementById("settingWatermarkOpacityVal");
    if (_wmOpL && Number.isFinite(wmOp)) _wmOpL.textContent = wmOp + "%";
    const _wmScL = document.getElementById("settingWatermarkScaleVal");
    if (_wmScL && Number.isFinite(wmSc)) _wmScL.textContent = wmSc + "%";
    const _wmMgL = document.getElementById("settingWatermarkMarginVal");
    if (_wmMgL && Number.isFinite(wmMg)) _wmMgL.textContent = wmMg + "px";
    const _wmRoL = document.getElementById("settingWatermarkRotationVal");
    if (_wmRoL && Number.isFinite(wmRo)) _wmRoL.textContent = wmRo + "°";
    const _wmOptsEl = document.getElementById("watermarkOpts");
    if (_wmOptsEl) _wmOptsEl.style.display = State.watermarkEnable ? "" : "none";
    if (State.watermarkEnable) { try { _loadWatermarks(); } catch (_) {} }

    // Restore AR pools from hidden inputs
    _syncPoolsFromDOM();

    // Re-render LoRA stack from restored hidden input value
    window.LoraStack?.reload();

    // Restore brush size to canvas state
    const restoredBrush = parseInt(document.getElementById("paramBrushSize")?.value);
    if (window.StudioCore && restoredBrush >= 1 && restoredBrush <= 100) {
      window.StudioCore.state.brushSize = restoredBrush;
      if (window.StudioUI?.syncCtxBar) window.StudioUI.syncCtxBar();
    }
  }

  // UX-014/016: Session memory — save/restore with category filtering.
  // Save is wired to four triggers (debounced autosave on param change +
  // visibilitychange-hidden + pagehide + beforeunload). The unload-family
  // events are individually unreliable — beforeunload doesn't fire on
  // mobile background, tab kill by Chrome's memory manager, bfcache
  // navigation, browser crash, or OS-level process termination — so the
  // debounced autosave acts as the safety net that catches everything
  // the unload events miss.
  let _quotaWarningShown = false;
  let _sessionSaveTimer = null;

  function _saveSession() {
    const on = document.getElementById("toggleRememberSession")?.classList.contains("on") ?? false;
    if (!on) return;
    const params = _getSessionParams(); // Only save enabled categories
    const data = _readParamsFromDOM(params);
    try {
      localStorage.setItem("studio-session-data", JSON.stringify(data));
    } catch (e) {
      console.warn("[Studio] Session save failed:", e);
      // QuotaExceededError surfaces with different DOMException names
      // across browsers ('QuotaExceededError' in Chrome/Safari,
      // 'NS_ERROR_DOM_QUOTA_REACHED' in Firefox). One-shot toast — the
      // autosave fires often enough that we'd spam without the guard.
      if (!_quotaWarningShown && e?.name && /quota/i.test(e.name)) {
        _quotaWarningShown = true;
        try {
          showToast(
            _i18n(
              "toast.session.quota",
              "Session memory full — last session not saved. Clear browser storage to keep using Remember Last Session.",
            ),
            "error",
          );
        } catch (_) {}
      }
    }
  }

  // Debounced autosave: 2s of idle is short enough that a crash loses
  // little, long enough that typing in the prompt box doesn't hammer
  // localStorage on every keystroke.
  function _scheduleSessionSave() {
    if (_sessionSaveTimer) clearTimeout(_sessionSaveTimer);
    _sessionSaveTimer = setTimeout(_saveSession, 2000);
  }

  function _loadSession() {
    const on = document.getElementById("toggleRememberSession")?.classList.contains("on") ?? false;
    if (!on) return false;
    try {
      const raw = localStorage.getItem("studio-session-data");
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (data && Object.keys(data).length > 0) {
        // Merge session over whatever Defaults previously loaded so new
        // Canvas tabs (via _studioReapplyDefaults) see the combined state:
        // Defaults for unchecked categories + Session for checked. Without
        // the merge, switching tabs would surface only the session-tracked
        // params and silently revert the rest to factory.
        _resolvedDefaults = { ...(_resolvedDefaults || {}), ...data };
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
  // the user's defaults apply to fresh documents.
  // Returns true if defaults were applied, false if nothing cached yet.
  window._studioReapplyDefaults = function () {
    if (!_resolvedDefaults || !Object.keys(_resolvedDefaults).length) return false;
    _applyDefaults(_resolvedDefaults);
    return true;
  };

  // Auto-save session on page unload. Three event handlers, not one —
  // each event misses in different scenarios:
  //   beforeunload   — desktop browser close / navigation; suppressed on
  //                    mobile background, tab kill, bfcache, crashes
  //   pagehide       — fires reliably across bfcache + most close paths
  //   visibilitychange to hidden — fires when tab is backgrounded,
  //                    catches mobile and Chrome memory-manager kills
  // The save is idempotent so multiple events firing in sequence is fine.
  window.addEventListener("beforeunload", _saveSession);
  window.addEventListener("pagehide", _saveSession);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") _saveSession();
  });

  // Debounced autosave on param change. The unload handlers above are the
  // happy-path persistence; this is the safety net that catches outright
  // crashes and OS-level kills. Each tracked element fires the same
  // debounced save, so 2s after the user stops editing the session is
  // written regardless of how the page ultimately closes.
  for (const [id, type] of DEFAULTS_PARAMS) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (type === "check" || type === "on" || type === "active" || type === "open") {
      // Class-toggle controls fire click in their own handlers; we listen
      // on the same event so we run after the toggle has flipped.
      el.addEventListener("click", _scheduleSessionSave);
    } else if (type === "checkbox") {
      el.addEventListener("change", _scheduleSessionSave);
    } else {
      // Text inputs / selects: input covers typing, change covers select
      // and lost-focus commit. Both are needed; input alone misses select
      // dropdowns that don't fire input.
      el.addEventListener("input", _scheduleSessionSave);
      el.addEventListener("change", _scheduleSessionSave);
    }
  }

  document.getElementById("checkUpdateBtn")?.addEventListener("click", async () => {
    const btn = document.getElementById("checkUpdateBtn");
    const status = document.getElementById("updateCheckStatus");
    if (btn) btn.disabled = true;
    if (status) status.textContent = "Checking...";
    try {
      const data = await API.checkUpdate();
      if (data.error) { showToast(data.offline ? "Offline — cannot check for updates" : data.error, "error"); if (status) status.textContent = ""; }
      else if (data.update_available) { UpdateBanner.show(data); if (status) status.textContent = ""; }
      else { showToast(I18N.t("toast.studioUpToDate", "Forge Studio is up to date"), "success"); if (status) status.textContent = I18N.t("status.upToDate", "Up to date"); }
    } catch (e) { showToast(I18N.t("toast.updateCheckFailed", "Update check failed: {error}", {error: e.message}), "error"); if (status) status.textContent = ""; }
    if (btn) btn.disabled = false;
  });
  document.getElementById("saveDefaults")?.addEventListener("click", () => {
    saveDefaults();
    showToast(_i18n("toast.defaults.saved", "Workflow defaults saved"), "success");
  });
  document.getElementById("resetDefaults")?.addEventListener("click", () => {
    API.generate({ action: "delete_defaults" }).catch(() => {});
    showToast(_i18n("toast.defaults.cleared", "Defaults cleared — reload for factory settings"), "info");
  });

  // After defaults/session restore the dropdowns hold the saved model/VAE/
  // TE, but Forge itself may have booted with only the bare checkpoint (the
  // external VAE/TE aren't persisted in config.json). One deferred sync
  // re-issues /studio/load_model so the actually-loaded components match
  // the restored UI. Debounced via setTimeout so the async VAE/TE dropdown
  // fetches have a chance to populate first, and coalesced so defaults +
  // session can't trigger two competing loads.
  let _componentRestoreTimer = null;

  function _scheduleRestoredComponentSync(reason = "session-restore") {
    if (_componentRestoreTimer) clearTimeout(_componentRestoreTimer);
    _componentRestoreTimer = setTimeout(async () => {
      _componentRestoreTimer = null;
      if (State.generating) return;
      if (typeof window.loadSelectedModelComponents !== "function") return;
      const model = document.getElementById("paramModel")?.value;
      if (!model) return;
      console.log("[Studio] Component restore queued:", reason);
      await window.loadSelectedModelComponents(reason);
      // Drop async-dropdown restore hints so a later refresh can't
      // resurrect a since-changed VAE/TE from a stale pending value.
      ["paramVAE", "paramTextEncoder"].forEach(id => {
        const el = document.getElementById(id);
        if (el) delete el.dataset.pendingValue;
      });
    }, 250);
  }

  // Expose for init() — priority documented in codex.js: Defaults loads
  // first as the baseline, Session overlays on top for whichever
  // categories the user opted in. Categories the user unchecked in
  // Session correctly inherit from Defaults this way; the previous
  // early-return form skipped Defaults entirely whenever a Session
  // existed, so unchecking a category dropped to factory instead.
  window._studioLoadDefaults = async function() {
    const hadDefaults = await loadDefaults();   // baseline (server-side, sets _resolvedDefaults)
    const hadSession = _loadSession();           // overlay (browser-side, merges into _resolvedDefaults)
    // Only sync when something was actually restored — otherwise we'd issue
    // a needless model reload (and "Loading model…" flash) on every cold
    // boot. Session wins over defaults, so a single sync after both run is
    // enough; tab switches never reach here (they use _studioReapplyDefaults).
    if (hadDefaults || hadSession) {
      console.log("[Studio] Restoring AI components from session/defaults");
      _scheduleRestoredComponentSync("session-restore");
    }
    // Reported back to init() for first-run detection: a fresh install has
    // neither server defaults nor a saved session.
    return hadDefaults || hadSession;
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

  // Width/height swap — flips the two dimensions in place. Independent of
  // the aspect-ratio presets, works for any custom size, and never triggers
  // generation. e.g. 832×1216 → 1216×832.
  document.getElementById("swapWH")?.addEventListener("click", () => {
    if (State.generating) return;
    const wEl = document.getElementById("paramWidth");
    const hEl = document.getElementById("paramHeight");
    if (!wEl || !hEl) return;
    const w = parseInt(wEl.value) || 0;
    const h = parseInt(hEl.value) || 0;
    if (!w || !h || w === h) return;
    wEl.value = h;
    hEl.value = w;
    // Reuse the existing change pipeline (canvas resize + status); the
    // listener reads both inputs, so one dispatch is enough.
    wEl.dispatchEvent(new Event("change"));
    // Keep the AR orientation buttons in step with the flipped orientation.
    if (window._syncARToSize) window._syncARToSize(h, w);
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

  // Reset canvas — rebuild engine state to a clean baseline. Prior
  // behavior just clear-rect'd the existing layer canvases, which left
  // the layer stack, undo/redo stacks, regions, masks, transform, and
  // selection lying around. Now the single Core.resetCanvasState helper
  // rebuilds everything; the button only orchestrates dimensions and
  // post-reset UI refresh.
  //
  // Dimension priority per handoff: Saved Defaults > Last Session
  // baseline > factory 768. Both saved-defaults and session-restore
  // populate _resolvedDefaults at boot, so reading paramWidth/Height
  // off that cached object covers the first two cases. _resolvedDefaults
  // is undefined on a totally fresh install with no session toggle, in
  // which case we fall through to the factory size.
  document.getElementById("clearCanvas")?.addEventListener("click", () => {
    if (State.generating) return;
    const Core = window.StudioCore;
    if (!Core) return;

    let targetW = 768, targetH = 768;
    if (_resolvedDefaults && _resolvedDefaults.paramWidth && _resolvedDefaults.paramHeight) {
      targetW = parseInt(_resolvedDefaults.paramWidth) || 768;
      targetH = parseInt(_resolvedDefaults.paramHeight) || 768;
    } else {
      // No saved baseline at all — fall back to the current paramWidth/
      // Height inputs (the user's working session) so a Reset on a
      // 1024-wide doc doesn't surprise-shrink to 768.
      const wEl = document.getElementById("paramWidth");
      const hEl = document.getElementById("paramHeight");
      if (wEl && hEl) {
        targetW = parseInt(wEl.value) || 768;
        targetH = parseInt(hEl.value) || 768;
      }
    }

    Core.resetCanvasState({ width: targetW, height: targetH });

    // Sync the param inputs back to the dimensions we just locked in
    // (resetCanvasState may have triggered a resizeCanvas).
    const wEl = document.getElementById("paramWidth");
    const hEl = document.getElementById("paramHeight");
    if (wEl) wEl.value = targetW;
    if (hEl) hEl.value = targetH;

    // UI refresh: layer panel, history panel, region panel.
    const UI = window.StudioUI;
    if (UI) {
      UI.renderLayerPanel?.();
      UI.renderHistoryPanel?.();
      UI.renderRegionPanel?.();
      UI.syncCanvasToViewport?.();
    }

    // WebGL preview re-upload after the layer stack rebuild. The
    // version bump in resetCanvasState already invalidates its
    // cache, but call markPixelsDirty explicitly so the texture
    // refresh kicks off on the next frame instead of waiting for
    // the next user input.
    const WGL = window.StudioCanvasWebGLPreview;
    if (WGL && typeof WGL.markPixelsDirty === "function") WGL.markPixelsDirty();

    Core.zoomFit?.();
    Core.composite();
    if (UI && UI.redraw) UI.redraw();

    // Persist the cleared canvas into the active StudioDocs tab so
    // switching tabs doesn't resurrect the pre-reset pixels.
    window.StudioDocs?.saveActiveDoc?.();

    showToast(I18N.t("toast.canvasCleared", "Canvas cleared"), "info");
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
      if (uploadBtn) uploadBtn.textContent = _i18n("actions.chooseImage", "Choose Image...");
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
      if (loading) loading.textContent = _i18n("toast.extensions.loadFailed", "Could not load extensions");
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

      // WP-L3: extension panels are layout blocks. Re-registration with
      // the freshly rendered element replaces the previous one, so a
      // re-render can't leave a duplicate of a block that was moved to a
      // zone or hidden.
      LayoutBlocks.register("ext-" + LayoutManager.slugify(ext.name), group, {
        label: ext.title || ext.name,
        canHide: true,
        home: "ext",
      });

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

    // WP-L3: relocate re-rendered extension blocks per the active layout
    // map (no-op before the layout system finishes booting).
    if (window.LayoutManager?._ready) {
      LayoutManager.reapply({ lift: Customizer.active });
      if (Customizer.active) Customizer.refreshChrome();
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


// ═══════════════════════════════════════════
// LAYOUT PRESETS (WP-L1) + BLOCK/ZONE REGISTRY (WP-L3)
// ═══════════════════════════════════════════

// Block registry + marker-based re-mount mechanism. Each [data-block]
// element gets a hidden marker recording its factory DOM position so a
// factory restore is always exact. Nodes are MOVED (appendChild /
// insertBefore), never cloned — IDs, state, and listeners survive.
// Markers are only created when a layout first deviates from factory, so
// a session that never customizes gets zero DOM changes.
//
// Zones: "panel" (#page-generate) and "deck" (#deckZone). The session
// strip is its own grid column — registered for hide/restore only, never
// part of a zone and never drag-targetable (v1).
const LayoutBlocks = {
  _order: ["prompt", "lora", "negative", "generate"], // factory deck-zone blocks
  registry: new Map(), // id -> {id, el, label, canHide, home: "panel"|"ext"|"strip"}
  _factoryPanelIds: [],
  _lastStructured: false, // last applyMap restructured the DOM (custom/lift)

  _STATIC_BLOCKS: [
    { id: "prompt",     label: "Prompt",        canHide: false },
    { id: "lora",       label: "LoRAs",         canHide: true  },
    { id: "negative",   label: "Negative",      canHide: true  },
    { id: "generate",   label: "Generate",      canHide: false },
    { id: "output",     label: "Output gallery", canHide: true },
    { id: "layers",     label: "Layers",        canHide: true  },
    { id: "history",    label: "History",       canHide: true  },
    { id: "regions",    label: "Regions",       canHide: true  },
    { id: "model",      label: "Model & VAE",   canHide: true  },
    { id: "sampling",   label: "Sampling",      canHide: true  },
    { id: "frame",      label: "Canvas",        canHide: true  },
    { id: "seedbatch",  label: "Seed & Batch",  canHide: true  },
    { id: "hires",      label: "Hires Fix",     canHide: true  },
    { id: "adetailer",  label: "ADetailer",     canHide: true  },
    { id: "upscale",    label: "Upscale",       canHide: true  },
    { id: "controlnet", label: "ControlNet",    canHide: true  },
  ],

  registerStatic() {
    if (this._factoryPanelIds.length) return; // once
    const byId = Object.fromEntries(this._STATIC_BLOCKS.map(b => [b.id, b]));
    // Factory panel order = document order at boot (factory DOM).
    document.querySelectorAll('#page-generate [data-block]').forEach(el => {
      const def = byId[el.dataset.block];
      if (!def) return;
      this.register(def.id, el, { label: def.label, canHide: def.canHide, home: "panel" });
      this._factoryPanelIds.push(def.id);
    });
    const strip = document.getElementById("sessionStrip");
    if (strip) this.register("strip", strip, { label: "Session strip", canHide: true, home: "strip" });
  },

  // Dynamic registration (extension-injected panels). Re-registration with
  // a new element replaces the old one — the stale node is removed so a
  // re-rendered extension can't end up duplicated in a zone.
  register(id, el, opts = {}) {
    const prev = this.registry.get(id);
    if (prev && prev.el !== el && prev.el?.isConnected) prev.el.remove();
    el.dataset.block = id;
    el.dataset.blockLabel = opts.label || id;
    this.registry.set(id, {
      id, el,
      label: opts.label || id,
      canHide: opts.canHide !== false,
      home: opts.home || "panel",
    });
  },

  _ensureMarkers() {
    for (const { el, id } of this.registry.values()) {
      if (id === "strip") continue; // never re-mounted
      if (!el.isConnected) continue;
      const m = document.querySelector(`.layout-home[data-home-for="${id}"]`);
      if (m) continue;
      const marker = document.createElement("span");
      marker.className = "layout-home";
      marker.dataset.homeFor = id;
      marker.hidden = true;
      el.parentElement.insertBefore(marker, el);
    }
  },

  _restoreAll() {
    for (const { el, id } of this.registry.values()) {
      if (id === "strip") continue;
      const marker = document.querySelector(`.layout-home[data-home-for="${id}"]`);
      if (!el || !marker) continue;
      if (el.previousElementSibling !== marker) {
        marker.parentElement.insertBefore(el, marker.nextSibling);
      }
    }
  },

  factoryMap(base) {
    base = base === "deck" ? "deck" : "classic";
    const panel = [...this._factoryPanelIds];
    const zones = base === "deck"
      ? { panel: panel.filter(id => !this._order.includes(id)), deck: [...this._order] }
      : { panel, deck: [] };
    return {
      schema: 1, module: "canvas", name: "", base,
      panelWidth: 0, // 0 = unmanaged (leave the panel width alone)
      zones, hidden: [],
      strip: { collapsed: SessionStrip.isCollapsed(), visible: true },
    };
  },

  // Structural comparison only — strip state and panel width don't make a
  // layout "custom" (they apply without restructuring the DOM).
  isFactory(map) {
    const fac = this.factoryMap(map.base);
    const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    return eq(map.zones.panel, fac.zones.panel)
        && eq(map.zones.deck, fac.zones.deck)
        && map.hidden.length === 0;
  },

  // Merge rules (schema resilience), applied on every load:
  //  - unknown block ids dropped silently
  //  - registered blocks missing from the map appended to their factory
  //    zone in factory order (ext-home blocks just stay at their marker)
  //  - unknown top-level keys preserved for round-trip
  //  - schema mismatch -> factory fallback for `base` + toast (the file
  //    itself is never touched)
  normalizeMap(raw) {
    const base = raw?.base === "deck" ? "deck" : "classic";
    const fac = this.factoryMap(base);
    if (!raw || typeof raw !== "object") return fac;
    if (raw.schema !== undefined && raw.schema !== 1) {
      showToast(_i18n("toast.layout.schema", "Layout file uses an unsupported schema — using the factory layout"), "info");
      return fac;
    }
    const known = id => {
      const r = this.registry.get(id);
      return !!r && r.home !== "strip";
    };
    const out = { ...raw, schema: 1, module: "canvas", base };
    const seen = new Set();
    const clean = list => (Array.isArray(list) ? list : [])
      .filter(id => typeof id === "string" && known(id) && !seen.has(id) && (seen.add(id), true));
    const zones = raw.zones || {};
    out.zones = { panel: clean(zones.panel), deck: clean(zones.deck) };
    out.hidden = (Array.isArray(raw.hidden) ? raw.hidden : [])
      .filter(id => typeof id === "string" && known(id)
        && this.registry.get(id).canHide && !seen.has(id) && (seen.add(id), true));
    for (const id of fac.zones.panel) if (!seen.has(id)) { out.zones.panel.push(id); seen.add(id); }
    for (const id of fac.zones.deck) if (!seen.has(id)) { out.zones.deck.push(id); seen.add(id); }
    let pw = Number.isInteger(raw.panelWidth) ? raw.panelWidth : 0;
    if (pw !== 0) pw = Math.max(420, Math.min(900, pw));
    out.panelWidth = pw;
    out.strip = {
      collapsed: !!raw.strip?.collapsed,
      visible: raw.strip?.visible !== false,
    };
    out.name = typeof raw.name === "string" ? raw.name : "";
    return out;
  },

  // Apply a layout map. Idempotent: factory restore first, then the
  // custom structure (if any). opts.lift forces the explicit zone-child
  // structure even for factory-equivalent maps — Customize mode uses it
  // so dragging and DOM-order sync are uniform.
  applyMap(map, opts = {}) {
    map = this.normalizeMap(map);
    const structured = !this.isFactory(map) || !!opts.lift;
    if (structured || this._lastStructured || map.base === "deck") this._ensureMarkers();
    this._restoreAll();
    const panel = document.querySelector('[data-zone="panel"]');
    const deck = document.getElementById("deckZone");
    if (structured) {
      // Lift the panel blocks to direct zone children, in map order, above
      // the remaining (non-block) panel content.
      const anchor = panel ? panel.firstElementChild : null;
      for (const id of map.zones.panel) {
        const r = this.registry.get(id);
        if (r?.el && panel) panel.insertBefore(r.el, anchor);
      }
      for (const id of map.zones.deck) {
        const r = this.registry.get(id);
        if (r?.el && deck) deck.appendChild(r.el);
      }
      for (const id of map.hidden) this.registry.get(id)?.el?.remove();
      document.documentElement.setAttribute("data-layout-custom", "");
    } else {
      if (map.base === "deck" && deck) {
        for (const id of map.zones.deck) {
          const r = this.registry.get(id);
          if (r?.el && r.el.parentElement !== deck) deck.appendChild(r.el);
        }
      }
      document.documentElement.removeAttribute("data-layout-custom");
    }
    this._lastStructured = structured;
    SessionStrip.applyState(map.strip);
    const panelRight = document.getElementById("panelRight");
    if (panelRight && map.panelWidth >= 420) {
      panelRight.style.width = map.panelWidth + "px";
      document.documentElement.style.setProperty("--studio-panel-width", map.panelWidth + "px");
    }
    // Trip the same path a window resize takes so canvas zoom/fit math
    // recomputes for the new canvas-area size.
    window.dispatchEvent(new Event("resize"));
  },

  // Back-compat wrappers (WP-L1 API)
  mountDeck() { this.applyMap(this.factoryMap("deck")); },
  mountClassic() { this.applyMap(this.factoryMap("classic")); },
};

// Vertical rail between canvas and params panel mirroring the output
// gallery. Pure view over the existing State.output* arrays — WP-L2
// replaces the data layer underneath without touching this.
const SessionStrip = {
  render() {
    // The strip column is active under the deck preset or Classic with
    // the "Session strip in Classic" setting — both set data-strip-col.
    if (!document.documentElement.hasAttribute("data-strip-col")) return;
    const scroll = document.getElementById("sessionStripScroll");
    if (!scroll) return;
    // thumbUrl only — the strip never loads full-res images. Entries that
    // know their dimensions get the aspect-ratio inline up front.
    scroll.innerHTML = State.sessionEntries.map((e, i) =>
      `<div class="session-thumb ${i === State.selectedOutputIdx ? "selected" : ""}" data-idx="${i}"${
        (e.width && e.height) ? ` style="aspect-ratio:${e.width} / ${e.height}"` : ""}>
        <img loading="lazy" src="${e.thumbUrl || e.url}" alt="">
      </div>`
    ).join("");
    // Fallback for entries without known dimensions: set aspect-ratio from
    // the thumb's natural dimensions once loaded (auto until then).
    scroll.querySelectorAll(".session-thumb:not([style]) img").forEach(img => {
      const apply = () => {
        if (img.naturalWidth && img.naturalHeight) {
          img.parentElement.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
        }
      };
      if (img.complete) apply();
      else img.addEventListener("load", apply, { once: true });
    });
    const count = document.getElementById("sessionStripCount");
    if (count) count.textContent = State.sessionEntries.length ? String(State.sessionEntries.length) : "";
  },

  isCollapsed() {
    const strip = document.getElementById("sessionStrip");
    if (strip) return strip.classList.contains("collapsed");
    return localStorage.getItem("studio-strip-collapsed") === "true";
  },

  // "Session strip in Classic" — user opt-in; the strip column itself is
  // gated by the data-strip-col root attribute in CSS.
  classicEnabled() {
    return localStorage.getItem("studio-classic-strip") === "true";
  },

  syncStripCol() {
    const on = LayoutSwitcher.current === "deck" || this.classicEnabled();
    document.documentElement.toggleAttribute("data-strip-col", on);
  },

  initClassicToggle() {
    const t = document.getElementById("toggleClassicStrip");
    if (!t) return;
    t.classList.toggle("on", this.classicEnabled());
    t.addEventListener("click", () => {
      const on = t.classList.toggle("on");
      localStorage.setItem("studio-classic-strip", String(on));
      this.syncStripCol();
      this.render();
      window.dispatchEvent(new Event("resize"));
    });
  },

  // Strip state lives in the layout map (WP-L3). Visible:false collapses
  // the grid column entirely; the hidden tray offers restore.
  applyState(strip) {
    const el = document.getElementById("sessionStrip");
    if (!el || !strip) return;
    el.classList.toggle("collapsed", !!strip.collapsed);
    el.classList.toggle("strip-hidden", strip.visible === false);
  },

  initCollapse() {
    const strip = document.getElementById("sessionStrip");
    const toggle = document.getElementById("sessionStripToggle");
    if (!strip || !toggle) return;
    // WP-L1 fallback key — read once for migration; the layout map owns
    // the state from here on (no further writes to the old key).
    if (localStorage.getItem("studio-strip-collapsed") === "true") {
      strip.classList.add("collapsed");
    }
    toggle.addEventListener("click", () => {
      const collapsed = strip.classList.toggle("collapsed");
      LayoutManager.setStripState({ collapsed });
      // Canvas-area width changed — recompute zoom/fit
      window.dispatchEvent(new Event("resize"));
    });
    // Collapsed rail: clicking anywhere on it expands (the slim rail's
    // dedicated button is easy to miss). Buttons keep their own handlers;
    // the toggle's click above already flips the class before this runs.
    strip.addEventListener("click", e => {
      if (!strip.classList.contains("collapsed")) return;
      if (e.target.closest("button")) return;
      strip.classList.remove("collapsed");
      LayoutManager.setStripState({ collapsed: false });
      window.dispatchEvent(new Event("resize"));
    });
  },
};

const LayoutSwitcher = {
  current: "classic",

  init() {
    LayoutManager.init();
    SessionStrip.initCollapse();
    SessionStrip.initClassicToggle();
    Customizer.init();
    const saved = localStorage.getItem("studio-layout-preset") || "classic";
    this.apply(saved, /*boot*/ true);
    // localStorage wiped but a named layout was active: restore it from
    // the server file (best-effort, async).
    if (!LayoutManager.working && LayoutManager.activeName) {
      LayoutManager.loadByName(LayoutManager.activeName, { silent: true });
    }

    document.getElementById("layoutSelector")?.addEventListener("click", async e => {
      const btn = e.target.closest(".layout-btn");
      if (!btn) return;
      const preset = btn.dataset.layoutPreset === "deck" ? "deck" : "classic";
      // Preset over a custom layout: confirm (window.confirm is the
      // repo's confirm pattern; the 3-way Save/Apply/Cancel becomes two
      // chained confirms).
      if (LayoutManager.isCustomActive()) {
        if (window.confirm(_i18n("layout.confirm.savefirst",
            "Applying a preset will replace your current layout. Save it first?"))) {
          const ok = await LayoutManager.save();
          if (!ok) return; // save cancelled/failed -> abort the preset switch
        } else if (!window.confirm(_i18n("layout.confirm.discard",
            "Apply the preset without saving? Your current layout will be lost."))) {
          return; // Cancel
        }
      }
      if (Customizer.active) Customizer.exit({ skipSave: true });
      LayoutManager.activeName = "";
      this.apply(preset);
    });
  },

  // Set the base preset attribute/state without applying a map (used by
  // layout-file loads, whose map is applied separately).
  setBase(base) {
    base = base === "deck" ? "deck" : "classic";
    if (base === "deck") document.documentElement.setAttribute("data-layout", "deck");
    else document.documentElement.removeAttribute("data-layout");
    this.current = base;
    localStorage.setItem("studio-layout-preset", base);
    this._updateButtons(base);
    SessionStrip.syncStripCol();
  },

  apply(preset, boot = false) {
    preset = preset === "deck" ? "deck" : "classic";
    const cached = boot ? LayoutManager.loadCached() : null;
    if (boot && cached && !LayoutBlocks.isFactory(cached)) {
      // Custom layout boot — restore the saved structure.
      this.setBase(cached.base);
      LayoutManager.setWorking(cached, LayoutManager.activeName);
      LayoutBlocks.applyMap(cached);
      SessionStrip.render();
      if (cached.base === "deck") this._discloseSections();
      return;
    }
    if (boot && preset === "classic") {
      // Classic at boot is the factory DOM — touch nothing structural
      // (no markers, no storage write, no resize dispatch) so a session
      // that never customizes stays byte-identical to pre-WP behavior.
      // (Classic + "Session strip in Classic" is an explicit opt-in.)
      this.current = "classic";
      this._updateButtons("classic");
      SessionStrip.syncStripCol();
      if (SessionStrip.classicEnabled()) SessionStrip.render();
      if (cached) {
        // Factory-equivalent map may still carry strip state / width.
        LayoutManager.setWorking(cached, LayoutManager.activeName);
        SessionStrip.applyState(cached.strip);
        const panelRight = document.getElementById("panelRight");
        if (panelRight && cached.panelWidth >= 420) {
          panelRight.style.width = cached.panelWidth + "px";
        }
      }
      return;
    }
    this.setBase(preset);
    const map = (boot && cached && cached.base === preset)
      ? cached
      : LayoutBlocks.factoryMap(preset);
    LayoutManager.setWorking(map, boot ? LayoutManager.activeName : "");
    LayoutBlocks.applyMap(map); // dispatches the resize event itself
    SessionStrip.render();
    if (preset === "deck") this._discloseSections();
  },

  // Disclose all feature sections on entering deck. Sets the accordion's
  // own steady open state (open class + max-height:none + arrow class —
  // exactly what _toggleCollapseBody reaches after its transition) instead
  // of header.click(): the click path measures scrollHeight, which is 0
  // while the Generate page is hidden (e.g. switching presets from the
  // Settings tab) and would latch sections shut. Users can still collapse
  // them afterwards.
  _discloseSections() {
    document.querySelectorAll("#page-generate .collapse-section").forEach(sec => {
      const header = sec.querySelector(".collapse-header");
      const body = sec.querySelector(".collapse-body");
      if (!header || !body || body.classList.contains("open")) return;
      body.classList.add("open");
      body.style.maxHeight = "none";
      header.querySelector(".collapse-arrow")?.classList.add("open");
    });
    document.querySelectorAll("#page-extensions .ext-group:not(.open)").forEach(g => {
      g.classList.add("open");
    });
  },

  _updateButtons(active) {
    document.querySelectorAll("#layoutSelector .layout-btn").forEach(btn => {
      btn.classList.toggle("active", (btn.dataset.layoutPreset || "classic") === active);
    });
  },
};


// ═══════════════════════════════════════════
// LAYOUT MANAGER (WP-L3) — working map + layout files
// ═══════════════════════════════════════════

const LayoutManager = {
  working: null,     // the active (normalized) layout map
  activeName: "",    // slug of the loaded named layout, "" when unsaved
  _ready: false,

  init() {
    LayoutBlocks.registerStatic();
    this.activeName = localStorage.getItem("studio-layout-name") || "";
    this._bindUI();
    this._updateNameDisplay();
    this.refreshList();
    this._ready = true;
  },

  loadCached() {
    try {
      const raw = localStorage.getItem("studio-layout-map");
      return raw ? LayoutBlocks.normalizeMap(JSON.parse(raw)) : null;
    } catch (_) { return null; }
  },

  setWorking(map, name = "") {
    this.working = LayoutBlocks.normalizeMap(map);
    this.activeName = name || "";
    this.persistLocal();
    this._updateNameDisplay();
  },

  ensureWorking() {
    if (!this.working) this.working = LayoutBlocks.factoryMap(LayoutSwitcher.current);
    return this.working;
  },

  isCustomActive() {
    return !!this.working && !LayoutBlocks.isFactory(this.working);
  },

  persistLocal() {
    try {
      if (this.working) localStorage.setItem("studio-layout-map", JSON.stringify(this.working));
      localStorage.setItem("studio-layout-name", this.activeName);
    } catch (_) {}
  },

  reapply(opts) {
    if (this._ready && this.working) LayoutBlocks.applyMap(this.working, opts);
  },

  setStripState(patch) {
    Object.assign(this.ensureWorking().strip, patch);
    this.persistLocal();
  },

  setPanelWidth(w) {
    this.ensureWorking().panelWidth = w;
    this.persistLocal();
  },

  // Read zone order back from the DOM. Only meaningful while Customize
  // mode has the blocks lifted to direct zone children.
  syncFromDOM() {
    const map = this.ensureWorking();
    const ids = zone => zone
      ? [...zone.querySelectorAll(":scope > [data-block]")]
          .map(b => b.dataset.block)
          .filter(id => !map.hidden.includes(id))
      : [];
    map.zones.panel = ids(document.querySelector('[data-zone="panel"]'));
    map.zones.deck = ids(document.getElementById("deckZone"));
    this.persistLocal();
  },

  slugify(name) {
    return String(name || "").toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
  },

  _updateNameDisplay() {
    const el = document.getElementById("layoutCurrentName");
    if (el) el.textContent = this.activeName || "—";
  },

  async refreshList() {
    try {
      const r = await fetch(API.base + "/studio/layouts");
      if (!r.ok) return;
      const data = await r.json();
      const sel = document.getElementById("layoutLoadSelect");
      if (!sel) return;
      const ph = sel.querySelector('option[value=""]')?.outerHTML
        || '<option value="">Load layout…</option>';
      sel.innerHTML = ph + (data.layouts || []).map(l =>
        `<option value="${l.name}">${l.name} (${l.base})</option>`).join("");
      sel.value = "";
    } catch (_) { /* best-effort; the list refreshes on next save/load */ }
  },

  async save(opts = {}) {
    if (!this.activeName) return this.saveAs(opts);
    return this._post(this.activeName, opts);
  },

  async saveAs(opts = {}) {
    const name = window.prompt(_i18n("layout.prompt.name", "Layout name:"), this.activeName || "my-layout");
    if (name == null) return false; // cancelled
    const slug = this.slugify(name);
    if (!slug) {
      showToast(_i18n("toast.layout.badName", "Invalid layout name"), "error");
      return false;
    }
    return this._post(slug, opts);
  },

  async _post(slug, opts = {}) {
    const map = { ...this.ensureWorking(), name: slug };
    try {
      const r = await fetch(API.base + "/studio/layouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: slug, map }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.error) {
        if (!opts.silent) showToast(data.error || _i18n("toast.layout.saveFailed", "Layout save failed"), "error");
        return false;
      }
      this.activeName = slug;
      this.working.name = slug;
      this.persistLocal();
      this._updateNameDisplay();
      this.refreshList();
      if (!opts.silent) showToast(_i18n("toast.layout.saved", "Layout saved"), "success");
      return true;
    } catch (e) {
      if (!opts.silent) showToast("Layout save failed: " + e.message, "error");
      return false;
    }
  },

  // Exit-customize hook: always cache locally; update the named file
  // silently when one is loaded.
  saveOnExit() {
    this.persistLocal();
    if (this.activeName) this._post(this.activeName, { silent: true });
  },

  async loadByName(name, opts = {}) {
    const slug = this.slugify(name);
    if (!slug) return false;
    try {
      const r = await fetch(API.base + "/studio/layouts/" + encodeURIComponent(slug));
      if (!r.ok) {
        if (!opts.silent) showToast(_i18n("toast.layout.notFound", "Layout not found"), "error");
        return false;
      }
      const raw = await r.json();
      this.applyLoaded(raw, slug);
      if (!opts.silent) showToast(_i18n("toast.layout.loaded", "Layout loaded"), "success");
      return true;
    } catch (e) {
      if (!opts.silent) showToast("Layout load failed: " + e.message, "error");
      return false;
    }
  },

  applyLoaded(raw, name) {
    const map = LayoutBlocks.normalizeMap(raw); // merge rules / schema fallback
    LayoutSwitcher.setBase(map.base);
    this.setWorking(map, name);
    LayoutBlocks.applyMap(map, { lift: Customizer.active });
    SessionStrip.render();
    if (map.base === "deck") LayoutSwitcher._discloseSections();
    if (Customizer.active) Customizer.refreshChrome();
    else Customizer._renderTray();
  },

  async deleteActive() {
    const slug = this.activeName;
    if (!slug) {
      showToast(_i18n("toast.layout.noneActive", "No named layout is active"), "info");
      return;
    }
    if (!window.confirm(_i18n("layout.confirm.delete", "Delete this layout file?"))) return;
    try {
      const r = await fetch(API.base + "/studio/layouts/" + encodeURIComponent(slug), { method: "DELETE" });
      if (!r.ok) {
        showToast(_i18n("toast.layout.deleteFailed", "Layout delete failed"), "error");
        return;
      }
      this.activeName = "";
      this.persistLocal();
      this._updateNameDisplay();
      this.refreshList();
      showToast(_i18n("toast.layout.deleted", "Layout deleted"), "success");
    } catch (e) {
      showToast("Layout delete failed: " + e.message, "error");
    }
  },

  _bindUI() {
    document.getElementById("layoutSaveBtn")?.addEventListener("click", () => {
      if (Customizer.active) this.syncFromDOM();
      this.save();
    });
    document.getElementById("layoutSaveAsBtn")?.addEventListener("click", () => {
      if (Customizer.active) this.syncFromDOM();
      this.saveAs();
    });
    document.getElementById("layoutDeleteBtn")?.addEventListener("click", () => this.deleteActive());
    document.getElementById("layoutLoadSelect")?.addEventListener("change", e => {
      const name = e.target.value;
      e.target.value = "";
      if (name) this.loadByName(name);
    });
  },
};


// ═══════════════════════════════════════════
// CUSTOMIZE MODE (WP-L3)
// ═══════════════════════════════════════════
// Explicit edit mode: registered blocks become draggable between zones,
// hideable (tray restores), and the params panel is resizable. ALL chrome
// is gated on body.customizing — a user who never customizes sees none
// of it. The canvas/viewport are never blocks and never move.

const Customizer = {
  active: false,
  _drag: null,
  _ghost: null,
  _indicator: null,

  init() {
    document.getElementById("toggleCustomize")?.addEventListener("click", () => this.toggle());
    document.getElementById("sessionStripHide")?.addEventListener("click", () => this.hideStrip());
    document.getElementById("hiddenTrayChips")?.addEventListener("click", e => {
      const chip = e.target.closest("[data-restore]");
      if (chip) this.restoreBlock(chip.dataset.restore);
    });
    document.addEventListener("click", e => {
      const btn = e.target.closest(".blk-hide");
      if (btn && this.active) this.hideBlock(btn.dataset.blockHide);
    });
    this._bindDrag();
    this._bindDivider();
    window.addEventListener("resize", () => this.updateToggleState());
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && this._drag) this._cancelDrag();
    });
    this.updateToggleState();
    this._renderTray();
  },

  // Generation lock + viewport gate. Checked at entry AND reflected on
  // the Settings toggle (disabled look + tooltip).
  blocked() {
    if (State.generating) return _i18n("layout.customize.blocked.generating", "Not available while generating");
    if (typeof Live !== "undefined" && Live.active) return _i18n("layout.customize.blocked.live", "Not available during Live Painting");
    if (window.innerWidth < 1600) return _i18n("layout.customize.blocked.narrow", "Needs a window at least 1600px wide");
    return "";
  },

  updateToggleState() {
    const t = document.getElementById("toggleCustomize");
    if (!t) return;
    const reason = this.active ? "" : this.blocked();
    t.classList.toggle("disabled", !!reason);
    t.title = reason;
    t.classList.toggle("on", this.active);
  },

  toggle() {
    if (this.active) this.exit();
    else this.enter();
  },

  enter() {
    const reason = this.blocked();
    if (reason) { showToast(reason, "info"); return; }
    if (this.active) return;
    LayoutManager.ensureWorking();
    this.active = true;
    document.body.classList.add("customizing");
    // Normalize: lift the panel blocks to explicit zone children so drag
    // targets and DOM-order sync are uniform. Exit re-applies without the
    // lift, restoring factory nesting when the map is factory-equivalent.
    LayoutManager.reapply({ lift: true });
    this.refreshChrome();
    this.updateToggleState();
  },

  exit(opts = {}) {
    if (!this.active) return;
    this.active = false;
    this._cancelDrag();
    document.body.classList.remove("customizing");
    this._removeHideButtons();
    LayoutManager.syncFromDOM();
    LayoutManager.reapply();
    this._renderTray();
    this.updateToggleState();
    if (!opts.skipSave) LayoutManager.saveOnExit();
  },

  refreshChrome() {
    this._removeHideButtons();
    this._injectHideButtons();
    this._renderTray();
  },

  _injectHideButtons() {
    if (!this.active) return;
    for (const r of LayoutBlocks.registry.values()) {
      // canHide:false blocks (prompt, generate) get no hide control; the
      // strip has its own × in its header.
      if (!r.canHide || r.id === "strip" || !r.el.isConnected) continue;
      if (r.el.querySelector(":scope > .blk-hide")) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "blk-hide";
      b.dataset.blockHide = r.id;
      b.title = _i18n("layout.hide.tooltip", "Hide block");
      b.textContent = "✕";
      r.el.appendChild(b);
    }
  },

  _removeHideButtons() {
    document.querySelectorAll(".blk-hide").forEach(b => b.remove());
  },

  hideBlock(id) {
    const r = LayoutBlocks.registry.get(id);
    const map = LayoutManager.ensureWorking();
    if (!r || !r.canHide || map.hidden.includes(id)) return;
    map.hidden.push(id);
    r.el.remove(); // detached — the registry keeps the element alive
    LayoutManager.syncFromDOM();
    this._renderTray();
  },

  hideStrip() {
    if (!this.active) return;
    LayoutManager.setStripState({ visible: false });
    SessionStrip.applyState(LayoutManager.working.strip);
    this._renderTray();
    window.dispatchEvent(new Event("resize"));
  },

  restoreBlock(id) {
    const map = LayoutManager.ensureWorking();
    if (id === "strip") {
      LayoutManager.setStripState({ visible: true });
      SessionStrip.applyState(map.strip);
      this._renderTray();
      window.dispatchEvent(new Event("resize"));
      return;
    }
    const r = LayoutBlocks.registry.get(id);
    if (!r) return;
    map.hidden = map.hidden.filter(h => h !== id);
    if (this.active) {
      // Blocks are lifted — re-append to the end of the panel zone, above
      // the pinned tray, and read the order back from the DOM.
      const panel = document.querySelector('[data-zone="panel"]');
      const tray = document.getElementById("hiddenTray");
      if (panel) {
        panel.insertBefore(r.el, (tray && tray.parentElement === panel) ? tray : null);
      }
      LayoutManager.syncFromDOM();
      this._injectHideButtons();
    } else {
      // Tray used outside Customize mode (it stays visible while blocks
      // are hidden). The DOM isn't lifted here, so syncFromDOM would
      // corrupt the zone lists — append to the map instead and re-apply.
      if (!map.zones.panel.includes(id) && !map.zones.deck.includes(id)) {
        map.zones.panel.push(id);
      }
      LayoutManager.persistLocal();
      LayoutManager.reapply();
    }
    this._renderTray();
    window.dispatchEvent(new Event("resize"));
  },

  _renderTray() {
    const tray = document.getElementById("hiddenTray");
    const chips = document.getElementById("hiddenTrayChips");
    if (!tray || !chips) return;
    const map = LayoutManager.working;
    const items = [];
    if (map) {
      for (const id of map.hidden) {
        items.push({ id, label: LayoutBlocks.registry.get(id)?.label || id });
      }
      if (map.strip.visible === false) {
        items.push({ id: "strip", label: LayoutBlocks.registry.get("strip")?.label || "Session strip" });
      }
    }
    chips.innerHTML = items.map(it =>
      `<button type="button" class="hidden-chip" data-restore="${it.id}">${it.label}</button>`
    ).join("");
    tray.classList.toggle("has-items", items.length > 0);
  },

  // ── Drag & drop (pointer events) ──
  _bindDrag() {
    document.addEventListener("pointerdown", e => {
      if (!this.active || e.button !== 0) return;
      if (e.target.closest(".blk-hide") || e.target.closest(".customize-divider")) return;
      const blk = e.target.closest("[data-block]");
      // The strip is a grid column, not a zone child — not draggable (v1).
      if (!blk || blk.dataset.block === "strip") return;
      e.preventDefault();
      this._drag = { el: blk, id: blk.dataset.block, started: false, x: e.clientX, y: e.clientY };
    });

    document.addEventListener("pointermove", e => {
      const d = this._drag;
      if (!d) return;
      if (!d.started) {
        // 5px threshold so a stray click doesn't ghost
        if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 5) return;
        d.started = true;
        d.el.classList.add("dragging");
        this._ghost = document.createElement("div");
        this._ghost.className = "drag-ghost";
        this._ghost.textContent = LayoutBlocks.registry.get(d.id)?.label || d.id;
        document.body.appendChild(this._ghost);
        if (!this._indicator) {
          this._indicator = document.createElement("div");
          this._indicator.className = "drop-indicator";
        }
      }
      this._ghost.style.left = (e.clientX + 12) + "px";
      this._ghost.style.top = (e.clientY + 12) + "px";
      // Hit-test beneath the dragged block (spec mechanism: hide → probe →
      // restore; the ghost and indicator are pointer-events:none).
      const prevDisplay = d.el.style.display;
      d.el.style.display = "none";
      const under = document.elementFromPoint(e.clientX, e.clientY);
      d.el.style.display = prevDisplay;
      const zone = under?.closest?.("[data-zone]");
      // Deck zone is only a drop target while the deck preset is active —
      // under Classic it isn't rendered (v1 scope).
      if (!zone || (zone.dataset.zone === "deck" && LayoutSwitcher.current !== "deck")) {
        this._indicator.remove();
        return;
      }
      // Forgiving targeting: anywhere inside a zone snaps to the NEAREST
      // block (by center distance), before/after by its midpoint on the
      // zone's flow axis. The pointer never has to sit exactly on a block.
      const horizontal = zone.dataset.zone === "deck";
      let best = null, bestDist = Infinity;
      for (const b of zone.querySelectorAll(":scope > [data-block]")) {
        if (b === d.el) continue;
        const r = b.getBoundingClientRect();
        if (!r.width && !r.height) continue; // display:none block (e.g. Regions)
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) { bestDist = dist; best = b; }
      }
      if (best) {
        const r = best.getBoundingClientRect();
        const before = horizontal
          ? e.clientX < r.left + r.width / 2   // horizontal midpoint in deck
          : e.clientY < r.top + r.height / 2;  // vertical midpoint in panel
        zone.insertBefore(this._indicator, before ? best : best.nextSibling);
      } else {
        // Empty zone → indicator at zone end (panel keeps the hidden tray
        // pinned last).
        const tail = zone.dataset.zone === "panel" ? document.getElementById("hiddenTray") : null;
        zone.insertBefore(this._indicator, (tail && tail.parentElement === zone) ? tail : null);
      }
    });

    document.addEventListener("pointerup", () => {
      const d = this._drag;
      if (!d) return;
      if (d.started && this._indicator?.isConnected) {
        this._indicator.parentElement.insertBefore(d.el, this._indicator);
        LayoutManager.syncFromDOM();
      }
      this._cancelDrag();
    });
  },

  _cancelDrag() {
    if (this._drag?.el) this._drag.el.classList.remove("dragging");
    this._ghost?.remove();
    this._ghost = null;
    this._indicator?.remove();
    this._drag = null;
  },

  // ── Panel resize hit-strip (clamped 420–900) ──
  _bindDivider() {
    const div = document.getElementById("customizeDivider");
    const panel = document.getElementById("panelRight");
    if (!div || !panel) return;
    div.addEventListener("pointerdown", e => {
      if (!this.active || e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startW = panel.getBoundingClientRect().width;
      const move = ev => {
        const w = Math.max(420, Math.min(900, Math.round(startW + (startX - ev.clientX))));
        panel.style.width = w + "px";
        document.documentElement.style.setProperty("--studio-panel-width", w + "px");
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        LayoutManager.setPanelWidth(Math.round(panel.getBoundingClientRect().width));
        window.dispatchEvent(new Event("resize"));
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    });
  },
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
  let _hadStoredConfig = false;
  if (typeof window._studioLoadDefaults === "function") {
    _hadStoredConfig = await window._studioLoadDefaults();
  } else {
    // No defaults — set initial status from input values
    const w = parseInt(document.getElementById("paramWidth")?.value) || 768;
    const h = parseInt(document.getElementById("paramHeight")?.value) || 768;
    StatusBar.setDimensions(w, h);
  }

  // Folder paths persist immediately via localStorage (machine config, not
  // per-image workflow). Re-apply after defaults load so the most recent
  // user choice wins regardless of whether "Save Defaults" was clicked.
  try {
    const _sd = localStorage.getItem("studio-save-dir");
    if (_sd != null) {
      const el = document.getElementById("settingSaveDir");
      if (el) el.value = _sd;
      State.saveDir = _sd.trim();
    }
    const _gf = localStorage.getItem("studio-gallery-folder");
    if (_gf != null) {
      const el = document.getElementById("settingGalleryFolder");
      if (el) el.value = _gf;
      State.galleryFolder = _gf.trim();
    }
  } catch (_) {}

  // Load extension bridge manifest and render controls
  await ExtensionBridge.load();

  // Initialize theme switcher
  ThemeSwitcher.init();

  // Initialize layout preset switcher (WP-L1) — must run after bindUI so
  // the accordion handlers and output-gallery bindings already exist.
  LayoutSwitcher.init();

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

  // Interface language (Phase 0 — picker is wired but no strings are
  // instrumented yet, so switching only flips the stored locale and
  // fires the i18n:change event. Phase 1 fills in translations.)
  {
    const localeSel = document.getElementById("settingLocale");
    if (localeSel && window.I18N) {
      // Reflect the current locale once i18n boot has finished honoring
      // URL ?locale → localStorage → navigator detection. Until then
      // the dropdown shows its HTML default (English).
      Promise.resolve(window.I18N.ready).then(() => {
        localeSel.value = window.I18N.getLocale();
      });
      localeSel.addEventListener("change", () => {
        window.I18N.setLocale(localeSel.value);
      });
    }
  }

  // Prompt autocomplete: enable toggle + tag source picker. Persisted via
  // localStorage; the TagComplete module reads the same keys at boot for
  // first-paint correctness, then app.js drives runtime changes.
  //
  // The .toggle-track class has a global click handler (see top of this
  // module) that flips its "on" class — read state AFTER it runs rather
  // than predicting and re-toggling, otherwise the two handlers cancel.
  {
    const tacToggle = document.getElementById("toggleTagAutocomplete");
    const tacSource = document.getElementById("settingTagSource");
    if (tacToggle) {
      const enabled = localStorage.getItem("studio-tac-enabled") !== "0";
      tacToggle.classList.toggle("on", enabled);
      tacToggle.addEventListener("click", () => {
        const on = tacToggle.classList.contains("on");
        localStorage.setItem("studio-tac-enabled", on ? "1" : "0");
        if (window.TagComplete) window.TagComplete.setEnabled(on);
        if (typeof showToast === "function") {
          showToast(on
            ? I18N.t("toast.tagAutocomplete.enabled", "Tag autocomplete enabled")
            : I18N.t("toast.tagAutocomplete.disabled", "Tag autocomplete disabled"),
            "info");
        }
      });
    }
    if (tacSource) {
      const saved = localStorage.getItem("studio-tac-source");
      if (saved) tacSource.value = saved;
      tacSource.addEventListener("change", async () => {
        const choice = tacSource.value;
        localStorage.setItem("studio-tac-source", choice);
        if (!window.TagComplete) return;
        const labels = {
          danbooru: "Danbooru", e621: "e621",
          danbooru_e621_merged: "Danbooru + e621", derpibooru: "Derpibooru",
        };
        const result = await window.TagComplete.setSource(choice);
        if (typeof showToast !== "function") return;
        if (result && result.count > 0) {
          showToast(
            I18N.t("toast.tagSource.loaded", "Loaded {count} tags from {source}")
              .replace("{count}", result.count.toLocaleString())
              .replace("{source}", labels[result.source] || result.source),
            "success");
        } else {
          showToast(
            I18N.t("toast.tagSource.failed", "Could not load {source} — is the CSV bundled?")
              .replace("{source}", labels[choice] || choice),
            "error");
        }
      });
    }
  }

  // Civitai metadata lookup — default OFF. The browser uses
  // window.StudioCivitai.enabled() to gate fetch buttons / disclosure.
  {
    const civToggle = document.getElementById("toggleCivitaiLookup");
    const _isOn = () => localStorage.getItem("studio-civitai-enabled") === "1";
    if (civToggle) {
      civToggle.classList.toggle("on", _isOn());
      civToggle.addEventListener("click", () => {
        const on = civToggle.classList.contains("on");
        localStorage.setItem("studio-civitai-enabled", on ? "1" : "0");
        if (typeof showToast === "function") {
          showToast(on
            ? I18N.t("toast.civitai.enabled", "Civitai lookup enabled")
            : I18N.t("toast.civitai.disabled", "Civitai lookup disabled"),
            "info");
        }
        // Notify the LoRA browser so it can show/hide fetch controls.
        window.dispatchEvent(new CustomEvent("studio-civitai-toggle", { detail: { enabled: on } }));
      });
    }
    window.StudioCivitai = {
      enabled: _isOn,
    };
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

  // Resizable right panel divider
  {
    const divider = document.getElementById("panelDivider");
    const panel = document.getElementById("panelRight");
    if (divider && panel) {
      const MIN_W = 320;
      const SMALL_SCREEN = 900;
      const _maxW = () => Math.min(720, Math.floor(window.innerWidth * 0.5));
      const _isSmall = () => window.innerWidth < SMALL_SCREEN;
      const _isCollapsed = () => panel.classList.contains("collapsed");
      const _clearWidth = () => { panel.style.width = ""; };
      const _applyWidth = (w) => {
        // While collapsed, inline width would shadow the CSS rule
        // `.panel-right.collapsed { width: 0 }` and the panel would stay
        // open. Leave it cleared and re-apply on expand.
        if (_isCollapsed()) return;
        if (_isSmall()) { _clearWidth(); return; }
        const clamped = Math.max(MIN_W, Math.min(_maxW(), w));
        panel.style.width = clamped + "px";
      };
      // Restore saved width (no-op while collapsed)
      const _restoreSaved = () => {
        if (_isCollapsed()) { _clearWidth(); return; }
        const saved = parseFloat(localStorage.getItem("studio-panel-right-width") || "");
        if (!isNaN(saved) && saved > 0) _applyWidth(saved);
        else _clearWidth();
      };
      _restoreSaved();
      // Re-clamp on viewport resize
      window.addEventListener("resize", () => {
        if (_isCollapsed()) return;
        if (_isSmall()) { _clearWidth(); return; }
        const saved = parseFloat(localStorage.getItem("studio-panel-right-width") || "");
        if (!isNaN(saved) && saved > 0) _applyWidth(saved);
      });
      // Drag to resize
      divider.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        if (_isCollapsed()) return;
        if (_isSmall()) return;
        e.preventDefault();
        const startX = e.clientX;
        const startW = panel.getBoundingClientRect().width;
        divider.classList.add("dragging");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        // Suppress panel width transition during drag for snappiness
        const prevTransition = panel.style.transition;
        panel.style.transition = "none";
        const onMove = (ev) => {
          // Divider is to the LEFT of the panel, so dragging right shrinks the panel
          const newW = startW - (ev.clientX - startX);
          _applyWidth(newW);
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          divider.classList.remove("dragging");
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          panel.style.transition = prevTransition;
          const finalW = panel.getBoundingClientRect().width;
          localStorage.setItem("studio-panel-right-width", String(Math.round(finalW)));
          window.dispatchEvent(new Event("resize"));
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
      // Double-click to reset
      divider.addEventListener("dblclick", () => {
        if (_isCollapsed()) return;
        localStorage.removeItem("studio-panel-right-width");
        _clearWidth();
        window.dispatchEvent(new Event("resize"));
      });
      // Sync divider visibility AND inline width to the collapsed class.
      // The collapse button (above) only toggles the class; without
      // clearing inline width here, a dragged/restored width would shadow
      // `.panel-right.collapsed { width: 0 }` and the panel wouldn't
      // actually collapse. MutationObserver callbacks run as microtasks
      // before the next layout, so there's no visible flicker.
      let _wasCollapsed = _isCollapsed();
      const _syncCollapseState = () => {
        const collapsed = _isCollapsed();
        divider.classList.toggle("hidden", collapsed);
        if (collapsed === _wasCollapsed) return;
        _wasCollapsed = collapsed;
        if (collapsed) _clearWidth();
        else _restoreSaved();
      };
      _syncCollapseState();
      new MutationObserver(_syncCollapseState).observe(panel, {
        attributes: true, attributeFilter: ["class"],
      });
    }
  }

  // UX-013: Initial VRAM readout + slow poll (every 30s)
  _refreshVRAM();
  setInterval(_refreshVRAM, 30000);

  // FR-001: Credits accordion
  // ---- Add contributors here ----
  const CREDITS = [
    { name: "SnekySnek", role: "VRAM Unloading, Civitai Metadata Lookup" },
    { name: "Railer", role: "Session Save, LoRA Stack, Resizable Side Panel, UI Polish" },
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

  // First-run preferences — only for genuinely fresh installs (no server
  // defaults, no saved session, and never onboarded/skipped before). Existing
  // users are never interrupted.
  _maybeShowFirstRun(_hadStoredConfig);

  console.log("[Studio] Ready");
}

// ═══════════════════════════════════════════
// FIRST-RUN PREFERENCES (PR 4)
// ═══════════════════════════════════════════
// A lightweight onboarding card shown once on a fresh install. It only
// configures settings that already exist and persists them through the
// normal defaults system (no second preference store). Everything here is
// changeable later under Settings.
const _ONBOARD_KEY = "studio-onboarded";

function _maybeShowFirstRun(hadStoredConfig) {
  try {
    if (hadStoredConfig) return;                              // existing user
    if (localStorage.getItem(_ONBOARD_KEY)) return;           // already chosen/skipped
  } catch (_) { return; }
  // Defer a tick so the rest of init settles (dropdowns, theme) first.
  setTimeout(_showFirstRunModal, 200);
}

// Flip a Studio on/off toggle to a desired boolean by reusing its own click
// handler — that keeps the associated State.* field in sync, unlike poking
// the class directly.
function _setToggleState(id, want) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.classList.contains("on") !== !!want) el.click();
}

function _showFirstRunModal() {
  if (document.getElementById("firstRunOverlay")) return;
  const _tt = (k, f) => (window.I18N && window.I18N.t) ? window.I18N.t(k, f) : f;
  let _customPath = "";   // server-side folder picked for auto-save (empty = Forge default)

  const ov = document.createElement("div");
  ov.id = "firstRunOverlay";
  ov.className = "first-run-overlay";
  ov.innerHTML =
    '<div class="first-run-card" role="dialog" aria-modal="true" aria-labelledby="firstRunTitle">' +
      '<div class="first-run-head">' +
        '<h2 id="firstRunTitle">' + _tt("firstRun.title", "Welcome to Forge Studio") + '</h2>' +
        '<p>' + _tt("firstRun.subtitle", "A couple of quick preferences — you can change all of these later in Settings.") + '</p>' +
      '</div>' +
      '<div class="first-run-group">' +
        '<div class="first-run-label">' + _tt("firstRun.format.label", "Default image format") + '</div>' +
        '<div class="first-run-choices" data-fr="format">' +
          '<button class="first-run-choice active" data-val="png">PNG</button>' +
          '<button class="first-run-choice" data-val="jpeg">JPEG</button>' +
          '<button class="first-run-choice" data-val="webp">WebP</button>' +
        '</div>' +
        '<div class="first-run-hint">' + _tt("firstRun.format.hint", "PNG is lossless; JPEG/WebP are smaller.") + '</div>' +
      '</div>' +
      '<div class="first-run-group">' +
        '<div class="first-run-label">' + _tt("firstRun.saveLoc.label", "Where should images save?") + '</div>' +
        '<div class="first-run-choices" data-fr="saveloc">' +
          '<button class="first-run-choice active" data-val="default">' + _tt("firstRun.saveLoc.default", "Forge default folder") + '</button>' +
          '<button class="first-run-choice" data-val="custom">' + _tt("firstRun.saveLoc.custom", "Choose a folder…") + '</button>' +
        '</div>' +
        '<div class="first-run-browse" id="firstRunBrowseRow" style="display:none;">' +
          '<input type="text" class="first-run-path-input" id="firstRunPath" autocomplete="off" spellcheck="false" ' +
            'placeholder="' + _tt("firstRun.saveLoc.placeholder", "Type a folder path on the Forge server…") + '">' +
          '<button class="first-run-browse-btn" id="firstRunBrowse">' + _tt("firstRun.saveLoc.browse", "Browse…") + '</button>' +
        '</div>' +
        '<div class="first-run-hint">' + _tt("firstRun.saveLoc.hint", "This folder lives on the machine running Forge/Studio. Type the path directly (best for remote/VM), or Browse if the dialog opens on that machine. Leave on default to use Forge’s output folder.") + '</div>' +
      '</div>' +
      '<div class="first-run-group">' +
        '<div class="first-run-label">' + _tt("firstRun.meta.label", "Embed metadata into image files") + '</div>' +
        '<div class="first-run-choices" data-fr="meta">' +
          '<button class="first-run-choice active" data-val="on">' + _tt("firstRun.meta.on", "Yes") + '</button>' +
          '<button class="first-run-choice" data-val="off">' + _tt("firstRun.meta.off", "No") + '</button>' +
        '</div>' +
        '<div class="first-run-hint">' + _tt("firstRun.meta.hint", "Writes prompt/seed/settings into each saved image so they can be recalled later. (The Gallery indexes this either way.)") + '</div>' +
      '</div>' +
      '<div class="first-run-group">' +
        '<div class="first-run-label">' + _tt("firstRun.monitor.label", "Monitor this folder in the Gallery") + '</div>' +
        '<div class="first-run-choices" data-fr="monitor">' +
          '<button class="first-run-choice active" data-val="on">' + _tt("firstRun.monitor.on", "Yes") + '</button>' +
          '<button class="first-run-choice" data-val="off">' + _tt("firstRun.monitor.off", "No") + '</button>' +
        '</div>' +
        '<div class="first-run-hint">' + _tt("firstRun.monitor.hint", "Adds a chosen folder to the Gallery for live auto-sync. The default output folder is already watched.") + '</div>' +
      '</div>' +
      '<div class="first-run-foot">' +
        '<button class="first-run-skip" id="firstRunSkip">' + _tt("firstRun.skip", "Skip") + '</button>' +
        '<button class="first-run-go" id="firstRunGo">' + _tt("firstRun.go", "Get started") + '</button>' +
      '</div>' +
      '<div class="first-run-note">' + _tt("firstRun.note", "Tip: change any of this anytime in Settings.") + '</div>' +
    '</div>';
  document.body.appendChild(ov);

  const _browseRow = ov.querySelector("#firstRunBrowseRow");
  const _pathEl = ov.querySelector("#firstRunPath");

  // Typing the path directly is the reliable route for remote/VM/headless
  // setups, where the server-side Browse dialog opens on the Forge machine
  // (not the user's browser). Keep _customPath in sync as they type.
  _pathEl?.addEventListener("input", () => { _customPath = (_pathEl.value || "").trim(); });

  // Single-select chip groups; the save-location group also toggles the
  // Browse row so the path field only appears when "custom" is chosen.
  ov.querySelectorAll(".first-run-choices").forEach(grp => {
    grp.addEventListener("click", e => {
      const btn = e.target.closest(".first-run-choice");
      if (!btn) return;
      grp.querySelectorAll(".first-run-choice").forEach(b => b.classList.toggle("active", b === btn));
      if (grp.dataset.fr === "saveloc" && _browseRow) {
        const custom = btn.dataset.val === "custom";
        _browseRow.style.display = custom ? "" : "none";
        if (custom && _pathEl) _pathEl.focus();
      }
    });
  });

  // Folder picker — reuses the Gallery's server-side native dialog. Opens on
  // the Forge machine; the text field above is the fallback for remote/VM.
  ov.querySelector("#firstRunBrowse")?.addEventListener("click", async () => {
    try {
      const r = await fetch(API.base + "/studio/gallery/pick-folder", { method: "POST" });
      const data = await r.json();
      if (data.error) { showToast("Folder picker unavailable: " + data.error, "info"); return; }
      if (data.path) { _customPath = data.path.trim(); if (_pathEl) _pathEl.value = _customPath; }
    } catch (_) {
      showToast("Folder dialog opens on the Forge server — type the path in the field instead", "info");
    }
  });

  const _pick = (group) => ov.querySelector('[data-fr="' + group + '"] .first-run-choice.active')?.dataset.val;
  const _close = () => { ov.remove(); try { localStorage.setItem(_ONBOARD_KEY, "1"); } catch (_) {} };

  document.getElementById("firstRunSkip")?.addEventListener("click", _close);

  document.getElementById("firstRunGo")?.addEventListener("click", async () => {
    // Apply through the real controls so State + Settings UI stay in sync.
    const fmt = _pick("format") || "png";
    const fmtSel = document.getElementById("settingSaveFormat");
    if (fmtSel) { fmtSel.value = fmt; fmtSel.dispatchEvent(new Event("change")); }

    // Save location → settingSaveDir (only when a custom folder was chosen).
    // A custom folder must be explicitly trusted before Studio will write to
    // it; if trust fails (bad/too-broad path), keep the card open so the user
    // can fix it rather than silently falling back to the default.
    const useCustom = _pick("saveloc") === "custom" && _customPath;
    if (useCustom && !(await _trustSaveFolder(_customPath))) return;
    const saveInput = document.getElementById("settingSaveDir");
    if (saveInput) { saveInput.value = useCustom ? _customPath : ""; saveInput.dispatchEvent(new Event("change")); }
    State.saveDir = useCustom ? _customPath : "";

    _setToggleState("toggleMetadata", _pick("meta") === "on");

    // Gallery monitoring — register the chosen folder with the watcher.
    // Only actionable when a custom path exists (the default output folder is
    // already watched, and its absolute path isn't known to the browser).
    if (_pick("monitor") === "on" && useCustom) {
      try {
        await fetch(API.base + "/studio/gallery/scan-folders", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: _customPath }),
        });
        fetch(API.base + "/studio/gallery/scan", { method: "POST" }).catch(() => {});
      } catch (_) { /* non-fatal — folder can be added later in the Gallery */ }
    }

    // Persist via the normal defaults system (also marks the install as
    // configured, so this never reappears).
    if (typeof window._studioSaveDefaults === "function") window._studioSaveDefaults();
    _close();
    if (typeof showToast === "function") showToast(_tt("firstRun.done", "Preferences saved — welcome aboard!"), "success");
  });
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
// TOKEN COUNTER — live token + BREAK chunk display
// ═══════════════════════════════════════════

const TokenCounter = {
  _tokenTimer: null,

  /** Debounced count — fires 300ms after typing stops */
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
      const r = await fetch(API.base + "/studio/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      if (!r.ok) return;
      const data = await r.json();
      const chunks = data.chunks || 1;

      // No model loaded — show chunk count only (honest "tokens unknown" state)
      if (data.tokens_l === null && data.tokens_g === null) {
        el.textContent = chunks > 1 ? `${chunks} chunks` : "";
        el.className = "token-count";
        return;
      }

      // CLIP-L only (SD1.5) or CLIP-L+G (SDXL) — use whichever is larger
      const tL = data.tokens_l ?? 0;
      const tG = data.tokens_g ?? 0;
      const count = Math.max(tL, tG);

      let label = `${count} tok`;
      if (chunks > 1) label += ` · ${chunks} chunks`;

      el.textContent = label;
      const perChunk = count / chunks;
      el.className = "token-count" + (perChunk > 150 ? " over" : perChunk > 70 ? " warn" : "");
    } catch (_) {
      // Endpoint not available — fail silently
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
window.LayoutSwitcher = LayoutSwitcher;
window.LayoutBlocks = LayoutBlocks;
window.SessionStrip = SessionStrip;
window.LayoutManager = LayoutManager;
window.Customizer = Customizer;

// Go
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
