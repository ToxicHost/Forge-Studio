/**
 * Forge Studio — Video Lab Module
 * by ToxicHost & Moritz
 *
 * I2V-first video generation with DaSiWa-quality enhancements.
 * Canvas content becomes the reference frame automatically.
 *
 * Registers via StudioModules.register("video", {...})
 */
(function () {
"use strict";

const TAG = "[Video Lab]";
const API = "/studio/api/video";

let _services = null;
let _generating = false;
let _els = {};  // cached DOM refs


// ========================================================================
// MODULE REGISTRATION
// ========================================================================

StudioModules.register("video", {
    label: "Video Lab",
    icon: "🎬",

    init(container, services) {
        _services = services;
        // Self-load CSS (same pattern as gallery.js)
        if (!document.querySelector('link[href*="video-lab.css"]')) {
            const link = document.createElement("link");
            link.rel = "stylesheet";
            link.href = "/studio/static/video-lab.css";
            document.head.appendChild(link);
        }
        container.innerHTML = _buildHTML();
        _cacheElements(container);
        _loadPrefs();
        _bindEvents();
        _checkCapability();
        _populateModelDropdowns();
        _populateUpscalers();
        console.log(TAG, "Initialized");
    },

    activate(container, services) {
        _services = services;
        _checkCapability();
    },

    deactivate() {
        // Show Canvas loading indicators while the model reloads
        const btn = document.getElementById("genBtn");
        const fill = document.getElementById("progressFill");
        if (btn) { btn.textContent = "Restoring model..."; btn.classList.add("generating"); }
        if (fill) { fill.style.width = "100%"; fill.classList.add("indeterminate"); }
        if (window.StatusBar) window.StatusBar.setStatus("loading");

        fetch(API + "/deactivate", { method: "POST" })
            .then(r => r.json())
            .then(data => {
                if (data.restored && window.populateDropdowns) {
                    window.populateDropdowns();
                }
                if (data.model && window.StatusBar) {
                    window.StatusBar.setModel(data.model.split("[")[0].trim());
                }
                if (window.showToast && data.restored) {
                    window.showToast("Canvas model restored", "success");
                }
            })
            .catch(() => {})
            .finally(() => {
                if (btn) { btn.textContent = "Generate"; btn.classList.remove("generating"); }
                if (fill) { fill.style.width = "0%"; fill.classList.remove("indeterminate"); }
                if (window.StatusBar) window.StatusBar.setStatus("ready");
            });
    }
});


// ========================================================================
// HTML
// ========================================================================

function _buildHTML() {
    return `
    <div class="vl-layout">
        <div class="vl-main">

            <!-- Reference Image (full main area) -->
            <div class="vl-ref-area" id="vlRefArea">
                <div class="vl-ref-preview" id="vlRefPreview">
                    <div class="vl-ref-empty" id="vlRefEmpty">
                        <span>No reference image</span>
                        <small>Use canvas or drop an image for I2V</small>
                        <small>Leave empty for T2V</small>
                    </div>
                    <img id="vlRefImg" style="display:none;">
                    <span class="vl-ref-zoom-hint">Scroll to zoom · Drag to pan</span>
                </div>
                <div class="vl-ref-actions">
                    <button id="vlRefFromCanvas" class="vl-btn-sm" title="Capture current canvas">📋 From Canvas</button>
                    <button id="vlRefUpload" class="vl-btn-sm" title="Upload reference image">📂 Upload</button>
                    <button id="vlRefClear" class="vl-btn-sm vl-btn-dim" title="Clear (switch to T2V)">✕ Clear</button>
                    <input type="file" id="vlRefFileInput" accept="image/*" style="display:none;">
                </div>
            </div>

            <!-- Generate -->
            <div class="vl-gen-row">
                <button class="vl-gen-btn" id="vlGenBtn">
                    <span class="gen-shine"></span>Generate Video
                </button>
                <button class="vl-cancel-btn" id="vlCancelBtn" style="display:none;">Cancel</button>
            </div>
            <div class="vl-progress" id="vlProgress" style="display:none;">
                <div class="vl-progress-fill" id="vlProgressFill"></div>
                <span class="vl-progress-text" id="vlProgressText">Preparing...</span>
            </div>

            <!-- Video Output (side-by-side: reference + generated video) -->
            <div class="vl-output" id="vlOutput" style="display:none;">
                <div class="vl-output-row">
                    <div class="vl-output-ref" id="vlOutputRef" style="display:none;">
                        <img id="vlOutputRefImg">
                    </div>
                    <div class="vl-output-video">
                        <video id="vlVideoPlayer" controls loop autoplay muted></video>
                    </div>
                </div>
                <div class="vl-output-actions">
                    <button class="vl-btn vl-btn-sm" id="vlExtractLast" title="Use last frame as reference for next generation">Extract Last Frame</button>
                    <span style="margin-left:auto; display:flex; gap:4px;">
                        <button class="vl-btn-sm" id="vlOutRefFromCanvas" title="Capture current canvas">📋 Canvas</button>
                        <button class="vl-btn-sm" id="vlOutRefUpload" title="Upload new reference">📂 Upload</button>
                        <button class="vl-btn-sm vl-btn-dim" id="vlOutRefClear" title="Clear reference (T2V)">✕ Clear</button>
                    </span>
                </div>
                <div class="vl-output-info" id="vlOutputInfo"></div>
            </div>

            <!-- Status banner -->
            <div class="vl-status" id="vlStatus" style="display:none;"></div>

        </div>

        <!-- Sidebar -->
        <div class="vl-sidebar">

            <!-- Prompt (first, matching Canvas tab layout) -->
            <div class="vl-section">
                <div class="vl-section-title" style="display:flex;align-items:center;justify-content:space-between;">
                    Prompt
                    <span style="display:flex;gap:4px;">
                        <button id="vlLoraBtn" title="Insert LoRA" style="font-size:11px;padding:2px 6px;background:var(--bg-2,#2a2a2a);border:1px solid var(--border,#444);border-radius:4px;color:var(--fg-1,#ccc);cursor:pointer;">🎭 LoRA</button>
                        <button id="vlWildcardBtn" title="Insert Wildcard" style="font-size:11px;padding:2px 6px;background:var(--bg-2,#2a2a2a);border:1px solid var(--border,#444);border-radius:4px;color:var(--fg-1,#ccc);cursor:pointer;">🎲 Wildcard</button>
                    </span>
                </div>
                <textarea class="vl-prompt" id="vlPrompt" rows="3"
                    placeholder="Describe the motion / scene..."></textarea>
                <textarea class="vl-prompt vl-prompt-neg" id="vlNegPrompt" rows="2"
                    placeholder="Negative prompt...">blurry, low quality, bad anatomy, censored, watermark</textarea>
            </div>

            <!-- Model Loader -->
            <div class="vl-section">
                <div class="vl-section-title">Model</div>
                <div class="vl-param">
                    <label>High Noise Model</label>
                    <select id="vlModelSelect" class="vl-select">
                        <option value="">Loading...</option>
                    </select>
                </div>
                <div class="vl-param" style="margin-top:6px;">
                    <label>Low Noise Model</label>
                    <select id="vlRefinerSelect" class="vl-select">
                        <option value="">(none — single model)</option>
                    </select>
                </div>
                <div class="vl-param" style="margin-top:6px;">
                    <label>Text Encoder</label>
                    <select id="vlTextEncoderSelect" class="vl-select">
                        <option value="">Loading...</option>
                    </select>
                </div>
                <div class="vl-param" style="margin-top:6px;">
                    <label>VAE</label>
                    <select id="vlVaeSelect" class="vl-select">
                        <option value="">Loading...</option>
                    </select>
                </div>
                <div class="vl-model-actions" style="margin-top:8px; display:flex; gap:6px;">
                    <button id="vlLoadModelBtn" class="vl-btn-sm" style="flex:1;">Load Model</button>
                    <button id="vlRefreshModelsBtn" class="vl-btn-sm vl-btn-dim" title="Refresh lists">🔄</button>
                </div>
                <div class="vl-model-status" id="vlModelStatus" style="margin-top:6px; font:11px var(--mono); color:var(--text-3);"></div>
            </div>

            <!-- Video Params -->
            <div class="vl-section">
                <div class="vl-section-title">Video Settings</div>
                <div class="vl-param-grid">
                    <div class="vl-param">
                        <label>Seconds</label>
                        <input type="number" id="vlSeconds" class="vl-input" value="5" step="1" min="1" max="10"
                            title="Video length in seconds (auto-calculates frames)">
                    </div>
                    <div class="vl-param">
                        <label>FPS</label>
                        <select id="vlFps" class="vl-select">
                            <option value="8">8</option>
                            <option value="16" selected>16</option>
                            <option value="24">24</option>
                        </select>
                    </div>
                </div>
                <div class="vl-param-grid">
                    <div class="vl-param">
                        <label>Width</label>
                        <input type="number" id="vlWidth" class="vl-input" value="832" step="32" min="256" max="1920">
                    </div>
                    <div class="vl-param">
                        <label>Height</label>
                        <input type="number" id="vlHeight" class="vl-input" value="480" step="32" min="256" max="1920">
                    </div>
                </div>
                <div class="vl-res-presets">
                    <button class="vl-res-btn" data-w="832" data-h="480">832×480</button>
                    <button class="vl-res-btn active" data-w="832" data-h="480">16:9</button>
                    <button class="vl-res-btn" data-w="480" data-h="832">9:16</button>
                    <button class="vl-res-btn" data-w="672" data-h="672">1:1</button>
                </div>
            </div>

            <!-- Sampling -->
            <div class="vl-section">
                <div class="vl-section-title">Sampling</div>
                <div class="vl-param-grid">
                    <div class="vl-param">
                        <label>Steps</label>
                        <input type="number" id="vlSteps" class="vl-input" value="4" min="1" max="100">
                    </div>
                    <div class="vl-param">
                        <label>CFG</label>
                        <input type="number" id="vlCFG" class="vl-input" value="1.0" step="0.5" min="1" max="30"
                            title="1.0 = ignore neg prompt (use NAG instead). Higher = stronger prompt adherence.">
                    </div>
                </div>
                <div class="vl-param-grid">
                    <div class="vl-param">
                        <label>Sampler</label>
                        <select id="vlSampler" class="vl-select">
                            <option value="euler" selected>Euler</option>
                            <option value="euler_ancestral">Euler a</option>
                            <option value="dpmpp_2m">DPM++ 2M</option>
                            <option value="dpmpp_2m_sde">DPM++ 2M SDE</option>
                        </select>
                    </div>
                    <div class="vl-param">
                        <label>Scheduler</label>
                        <select id="vlScheduler" class="vl-select">
                            <option value="simple" selected>Simple</option>
                            <option value="linear_quadratic">Linear Quadratic</option>
                            <option value="normal">Normal</option>
                            <option value="karras">Karras</option>
                            <option value="beta">Beta</option>
                            <option value="sgm_uniform">SGM Uniform</option>
                        </select>
                    </div>
                </div>
                <div class="vl-param-grid">
                    <div class="vl-param vl-seed-param">
                        <label>Seed</label>
                        <input type="number" id="vlSeed" class="vl-input vl-mono" value="-1">
                        <button class="vl-seed-btn" id="vlSeedRandom" title="Random">🎲</button>
                    </div>
                </div>
            </div>

            <!-- Enhancements -->
            <div class="vl-section vl-collapse">
                <div class="vl-collapse-header" id="vlEnhToggle">
                    <span class="vl-section-title">Enhancements</span>
                    <svg class="vl-arrow open" width="10" height="10" viewBox="0 0 10 10"
                         fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M2 3.5l3 3 3-3"/>
                    </svg>
                </div>
                <div class="vl-collapse-body open" id="vlEnhBody">

                    <!-- CFGZeroStar -->
                    <div class="vl-enh-group">
                        <label class="vl-check-label">
                            <input type="checkbox" id="vlCfgZero" checked>
                            <span>CFGZero★</span>
                        </label>
                        <div class="vl-enh-detail" id="vlCfgZeroDetail">
                            <div class="vl-param-grid">
                                <div class="vl-param">
                                    <label>Zero-init %</label>
                                    <input type="number" id="vlZeroInitPct" class="vl-input" value="0.04" step="0.01" min="0" max="1">
                                </div>
                                <div class="vl-param">
                                    <label class="vl-check-label vl-check-sm">
                                        <input type="checkbox" id="vlOptScale" checked>
                                        <span>Optimized Scale</span>
                                    </label>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- NAG -->
                    <div class="vl-enh-group">
                        <label class="vl-check-label">
                            <input type="checkbox" id="vlNag">
                            <span>NAGuidance</span>
                        </label>
                        <div class="vl-enh-detail" id="vlNagDetail" style="display:none;">
                            <div class="vl-param-grid">
                                <div class="vl-param">
                                    <label>Scale</label>
                                    <input type="number" id="vlNagScale" class="vl-input" value="11.0" step="0.1">
                                </div>
                                <div class="vl-param">
                                    <label>Tau</label>
                                    <input type="number" id="vlNagTau" class="vl-input" value="2.37" step="0.05">
                                </div>
                            </div>
                            <div class="vl-param-grid">
                                <div class="vl-param">
                                    <label>Alpha</label>
                                    <input type="number" id="vlNagAlpha" class="vl-input" value="0.25" step="0.05">
                                </div>
                                <div class="vl-param">
                                    <label>Start Block</label>
                                    <input type="number" id="vlNagBlock" class="vl-input" value="0" min="0" max="40">
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Sigma Shift -->
                    <div class="vl-enh-group">
                        <label class="vl-check-label">
                            <input type="checkbox" id="vlSigmaShift" checked>
                            <span>Sigma Shift</span>
                        </label>
                        <div class="vl-enh-detail" id="vlSigmaDetail">
                            <div class="vl-param">
                                <label>Shift Value</label>
                                <input type="number" id="vlSigmaVal" class="vl-input" value="5.0" step="0.5" min="0.5" max="20">
                            </div>
                        </div>
                    </div>

                    <!-- TeaCache -->
                    <div class="vl-enh-group">
                        <label class="vl-check-label">
                            <input type="checkbox" id="vlTeaCache">
                            <span>TeaCache</span>
                        </label>
                        <div class="vl-enh-detail" id="vlTeaCacheDetail" style="display:none;">
                            <div class="vl-param">
                                <label>Threshold</label>
                                <input type="number" id="vlTeaCacheThreshold" class="vl-input" value="0.2" step="0.05" min="0" max="2"
                                    title="Lower = more quality, less speed. 0.2 recommended for WAN. Above 0.4 loses detail.">
                            </div>
                        </div>
                    </div>

                </div>
            </div>

            <!-- Post-Processing -->
            <div class="vl-section vl-collapse">
                <div class="vl-collapse-header" id="vlPostToggle">
                    <span class="vl-section-title">Post-Processing</span>
                    <svg class="vl-arrow" width="10" height="10" viewBox="0 0 10 10"
                         fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M2 3.5l3 3 3-3"/>
                    </svg>
                </div>
                <div class="vl-collapse-body" id="vlPostBody">

                    <div class="vl-enh-group">
                        <label class="vl-check-label">
                            <input type="checkbox" id="vlPostUpscale">
                            <span>Upscale Video</span>
                        </label>
                        <div class="vl-enh-detail" id="vlUpscaleDetail" style="display:none;">
                            <div class="vl-param-grid">
                                <div class="vl-param">
                                    <label>Model</label>
                                    <select id="vlUpscaleModel" class="vl-select"></select>
                                </div>
                                <div class="vl-param">
                                    <label>Scale</label>
                                    <select id="vlUpscaleFactor" class="vl-select">
                                        <option value="1.5">1.5×</option>
                                        <option value="2" selected>2×</option>
                                        <option value="3">3×</option>
                                        <option value="4">4×</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                    </div>

                </div>
            </div>

        </div>
    </div>`;
}


// ========================================================================
// DOM CACHE & EVENTS
// ========================================================================

function _cacheElements(root) {
    const $ = id => root.querySelector("#" + id);
    _els = {
        refArea: $("vlRefArea"),
        refPreview: $("vlRefPreview"),
        refEmpty: $("vlRefEmpty"),
        refImg: $("vlRefImg"),
        refFromCanvas: $("vlRefFromCanvas"),
        refUpload: $("vlRefUpload"),
        refClear: $("vlRefClear"),
        refFileInput: $("vlRefFileInput"),
        prompt: $("vlPrompt"),
        negPrompt: $("vlNegPrompt"),
        genBtn: $("vlGenBtn"),
        cancelBtn: $("vlCancelBtn"),
        progress: $("vlProgress"),
        progressFill: $("vlProgressFill"),
        progressText: $("vlProgressText"),
        output: $("vlOutput"),
        videoPlayer: $("vlVideoPlayer"),
        outputRef: $("vlOutputRef"),
        outputRefImg: $("vlOutputRefImg"),
        outputInfo: $("vlOutputInfo"),
        status: $("vlStatus"),
        seconds: $("vlSeconds"),
        fps: $("vlFps"),
        width: $("vlWidth"),
        height: $("vlHeight"),
        steps: $("vlSteps"),
        cfg: $("vlCFG"),
        sampler: $("vlSampler"),
        scheduler: $("vlScheduler"),
        seed: $("vlSeed"),
        seedRandom: $("vlSeedRandom"),
        cfgZero: $("vlCfgZero"),
        cfgZeroDetail: $("vlCfgZeroDetail"),
        zeroInitPct: $("vlZeroInitPct"),
        optScale: $("vlOptScale"),
        nag: $("vlNag"),
        nagDetail: $("vlNagDetail"),
        nagScale: $("vlNagScale"),
        nagTau: $("vlNagTau"),
        nagAlpha: $("vlNagAlpha"),
        nagBlock: $("vlNagBlock"),
        sigmaShift: $("vlSigmaShift"),
        sigmaDetail: $("vlSigmaDetail"),
        sigmaVal: $("vlSigmaVal"),
        teaCache: $("vlTeaCache"),
        teaCacheDetail: $("vlTeaCacheDetail"),
        teaCacheThreshold: $("vlTeaCacheThreshold"),
        enhToggle: $("vlEnhToggle"),
        enhBody: $("vlEnhBody"),
        modelSelect: $("vlModelSelect"),
        refinerSelect: $("vlRefinerSelect"),
        textEncoderSelect: $("vlTextEncoderSelect"),
        vaeSelect: $("vlVaeSelect"),
        loadModelBtn: $("vlLoadModelBtn"),
        refreshModelsBtn: $("vlRefreshModelsBtn"),
        modelStatus: $("vlModelStatus"),
        postToggle: $("vlPostToggle"),
        postBody: $("vlPostBody"),
        postUpscale: $("vlPostUpscale"),
        upscaleDetail: $("vlUpscaleDetail"),
        upscaleModel: $("vlUpscaleModel"),
        upscaleFactor: $("vlUpscaleFactor"),
        extractLast: $("vlExtractLast"),
    };
}

function _bindEvents() {
    // Reference image
    _els.refFromCanvas.onclick = _captureCanvasPreview;
    _els.refUpload.onclick = () => _els.refFileInput.click();
    _els.refClear.onclick = _clearReference;
    _els.refFileInput.onchange = _handleFileUpload;

    // Drag & drop on reference area
    _els.refArea.ondragover = e => { e.preventDefault(); _els.refArea.classList.add("vl-drag-over"); };
    _els.refArea.ondragleave = e => {
        if (!_els.refArea.contains(e.relatedTarget)) _els.refArea.classList.remove("vl-drag-over");
    };
    _els.refArea.ondrop = e => {
        e.preventDefault();
        _els.refArea.classList.remove("vl-drag-over");
        const file = e.dataTransfer?.files?.[0];
        if (file && file.type.startsWith("image/")) _loadImageFile(file);
    };

    // Zoom/pan for reference image preview
    _initRefZoomPan();

    // Generate / Cancel
    _els.genBtn.onclick = _generate;
    _els.cancelBtn.onclick = _cancel;

    // Seed random
    _els.seedRandom.onclick = () => { _els.seed.value = "-1"; };

    // Enhancement toggles
    _els.cfgZero.onchange = () => {
        _els.cfgZeroDetail.style.display = _els.cfgZero.checked ? "" : "none";
    };
    _els.nag.onchange = () => {
        _els.nagDetail.style.display = _els.nag.checked ? "" : "none";
    };
    _els.sigmaShift.onchange = () => {
        _els.sigmaDetail.style.display = _els.sigmaShift.checked ? "" : "none";
    };
    _els.teaCache.onchange = () => {
        _els.teaCacheDetail.style.display = _els.teaCache.checked ? "" : "none";
    };

    // Enhancement collapse
    _els.enhToggle.onclick = () => {
        const body = _els.enhBody;
        const arrow = _els.enhToggle.querySelector(".vl-arrow");
        body.classList.toggle("open");
        if (arrow) arrow.classList.toggle("open");
    };

    // Post-processing collapse
    _els.postToggle.onclick = () => {
        const body = _els.postBody;
        const arrow = _els.postToggle.querySelector(".vl-arrow");
        body.classList.toggle("open");
        if (arrow) arrow.classList.toggle("open");
    };

    // Upscale checkbox toggle
    _els.postUpscale.onchange = () => {
        _els.upscaleDetail.style.display = _els.postUpscale.checked ? "" : "none";
    };

    // Extract last frame
    _els.extractLast.onclick = _extractLastFrame;

    // Output reference controls (duplicates of main ref area buttons)
    const outRefCanvas = document.getElementById("vlOutRefFromCanvas");
    const outRefUpload = document.getElementById("vlOutRefUpload");
    const outRefClear = document.getElementById("vlOutRefClear");
    if (outRefCanvas) outRefCanvas.onclick = _captureCanvasPreview;
    if (outRefUpload) outRefUpload.onclick = () => _els.refFileInput.click();
    if (outRefClear) outRefClear.onclick = _clearReference;

    // Model loader
    _els.loadModelBtn.onclick = _loadModel;
    _els.refreshModelsBtn.onclick = _populateModelDropdowns;

    // Resolution presets
    _els.refArea?.closest(".vl-layout")?.querySelectorAll(".vl-res-btn").forEach(btn => {
        btn.onclick = () => {
            const w = btn.dataset.w, h = btn.dataset.h;
            if (w && h) {
                _els.width.value = w;
                _els.height.value = h;
            }
            btn.closest(".vl-res-presets")?.querySelectorAll(".vl-res-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
        };
    });

    // ── LoRA / Wildcard browser integration ──────────────────────
    const vlPrompt = document.getElementById("vlPrompt");
    const vlNeg = document.getElementById("vlNegPrompt");
    if (vlPrompt) vlPrompt.addEventListener("focusin", () => { window._studioLastPrompt = vlPrompt; });
    if (vlNeg) vlNeg.addEventListener("focusin", () => { window._studioLastPrompt = vlNeg; });

    const loraBtn = document.getElementById("vlLoraBtn");
    if (loraBtn) {
        loraBtn.onclick = () => {
            if (vlPrompt) { vlPrompt.focus(); window._studioLastPrompt = vlPrompt; }
            if (window.LoraBrowser) { window.LoraBrowser.open(); }
        };
    }

    const wcBtn = document.getElementById("vlWildcardBtn");
    if (wcBtn) {
        wcBtn.onclick = () => {
            if (vlPrompt) { vlPrompt.focus(); window._studioLastPrompt = vlPrompt; }
            if (window.WildcardBrowser) { window.WildcardBrowser.open(); }
        };
    }

    // ── Persist selections on any change ─────────────────────────
    const sidebar = _els.refArea?.closest(".vl-layout")?.querySelector(".vl-sidebar");
    if (sidebar) {
        sidebar.addEventListener("change", _savePrefs);
        sidebar.addEventListener("input", _savePrefs);
    }
}

let _refB64 = null;

// ========================================================================
// SELECTION PERSISTENCE (localStorage, vl- prefix)
// ========================================================================

const _PERSIST_KEY = "vl-prefs";

// Fields to persist: [els key, type]
// type: "val" = .value, "chk" = .checked
const _PERSIST_FIELDS = [
    ["seconds", "val"], ["fps", "val"], ["width", "val"], ["height", "val"],
    ["steps", "val"], ["cfg", "val"], ["sampler", "val"], ["scheduler", "val"],
    ["seed", "val"],
    ["cfgZero", "chk"], ["zeroInitPct", "val"], ["optScale", "chk"],
    ["nag", "chk"], ["nagScale", "val"], ["nagTau", "val"], ["nagAlpha", "val"], ["nagBlock", "val"],
    ["sigmaShift", "chk"], ["sigmaVal", "val"],
    ["teaCache", "chk"], ["teaCacheThreshold", "val"],
    ["postUpscale", "chk"], ["upscaleFactor", "val"],
];

// Dropdowns that need deferred restore (populated async)
const _PERSIST_SELECTS = ["modelSelect", "refinerSelect", "textEncoderSelect", "vaeSelect", "upscaleModel"];

function _savePrefs() {
    try {
        const data = {};
        for (const [key, type] of _PERSIST_FIELDS) {
            if (_els[key]) data[key] = type === "chk" ? _els[key].checked : _els[key].value;
        }
        for (const key of _PERSIST_SELECTS) {
            if (_els[key]) data[key] = _els[key].value;
        }
        localStorage.setItem(_PERSIST_KEY, JSON.stringify(data));
    } catch {}
}

function _loadPrefs() {
    try {
        const raw = localStorage.getItem(_PERSIST_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);

        // Restore simple fields immediately
        for (const [key, type] of _PERSIST_FIELDS) {
            if (_els[key] && data[key] !== undefined) {
                if (type === "chk") _els[key].checked = data[key];
                else _els[key].value = data[key];
            }
        }

        // Sync checkbox visibility
        if (_els.cfgZeroDetail) _els.cfgZeroDetail.style.display = _els.cfgZero.checked ? "" : "none";
        if (_els.nagDetail) _els.nagDetail.style.display = _els.nag.checked ? "" : "none";
        if (_els.sigmaDetail) _els.sigmaDetail.style.display = _els.sigmaShift.checked ? "" : "none";
        if (_els.teaCacheDetail) _els.teaCacheDetail.style.display = _els.teaCache.checked ? "" : "none";
        if (_els.upscaleDetail) _els.upscaleDetail.style.display = _els.postUpscale.checked ? "" : "none";

        // Stash deferred select values — restored after dropdowns populate
        _deferredSelects = {};
        for (const key of _PERSIST_SELECTS) {
            if (data[key] !== undefined) _deferredSelects[key] = data[key];
        }
    } catch {}
}

let _deferredSelects = {};

function _restoreDeferredSelect(key) {
    if (_deferredSelects[key] && _els[key]) {
        const opt = _els[key].querySelector(`option[value="${CSS.escape(_deferredSelects[key])}"]`);
        if (opt) _els[key].value = _deferredSelects[key];
        delete _deferredSelects[key];
    }
}


// ========================================================================
// REFERENCE IMAGE
// ========================================================================

function _snapRes(w, h) {
    // Round to nearest multiple of 32 (WAN latent alignment)
    w = Math.round(w / 32) * 32;
    h = Math.round(h / 32) * 32;
    // Clamp to sane range
    w = Math.max(256, Math.min(1920, w));
    h = Math.max(256, Math.min(1920, h));
    _els.width.value = w;
    _els.height.value = h;
    // Clear active state on resolution preset buttons
    _els.refArea?.closest(".vl-layout")?.querySelectorAll(".vl-res-btn").forEach(b => b.classList.remove("active"));
    console.log(TAG, `Resolution auto-set: ${w}×${h}`);
}

function _captureCanvasPreview() {
    if (!_services) return;
    const b64 = _services.getCanvasB64("image/png");
    if (!b64) {
        _showStatus("No canvas content to capture", "warn");
        return;
    }
    _refB64 = b64;
    _els.refImg.src = "data:image/png;base64," + b64;
    _els.refImg.style.display = "";
    _els.refEmpty.style.display = "none";
    _resetRefZoom();
    // Auto-detect resolution from canvas
    const core = _services.core;
    if (core?.state) {
        _snapRes(core.state.W, core.state.H);
    }
    console.log(TAG, "Canvas captured as reference");
}

function _clearReference() {
    _refB64 = null;
    _els.refImg.src = "";
    _els.refImg.style.display = "none";
    _els.refEmpty.style.display = "";
    _resetRefZoom();
}

function _handleFileUpload(e) {
    const file = e.target?.files?.[0];
    if (file) _loadImageFile(file);
    e.target.value = "";
}

function _loadImageFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
        const dataUrl = reader.result;
        _refB64 = dataUrl.split(",")[1];
        _els.refImg.src = dataUrl;
        _els.refImg.style.display = "";
        _els.refEmpty.style.display = "none";
        _resetRefZoom();
        // Auto-detect resolution from loaded image
        const tmp = new Image();
        tmp.onload = () => _snapRes(tmp.naturalWidth, tmp.naturalHeight);
        tmp.src = dataUrl;
    };
    reader.readAsDataURL(file);
}


// ========================================================================
// REFERENCE IMAGE ZOOM / PAN
// ========================================================================

const _refZoom = { scale: 1, tx: 0, ty: 0, dragging: false, sx: 0, sy: 0, stx: 0, sty: 0 };

function _resetRefZoom() {
    _refZoom.scale = 1;
    _refZoom.tx = 0;
    _refZoom.ty = 0;
    _applyRefZoom();
}

function _applyRefZoom() {
    if (_els.refImg) {
        _els.refImg.style.transform = `translate(${_refZoom.tx}px, ${_refZoom.ty}px) scale(${_refZoom.scale})`;
        _els.refImg.style.transformOrigin = "center center";
    }
}

function _initRefZoomPan() {
    const preview = _els.refPreview;
    if (!preview) return;

    // Wheel zoom (anchored to cursor)
    preview.addEventListener("wheel", e => {
        if (_els.refImg.style.display === "none") return;
        e.preventDefault();
        const rect = preview.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const cx = rect.width / 2;
        const cy = rect.height / 2;

        const oldScale = _refZoom.scale;
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        _refZoom.scale = Math.min(10, Math.max(0.5, oldScale * factor));

        // Adjust translate so zoom is anchored to cursor position
        const ratio = _refZoom.scale / oldScale;
        _refZoom.tx = mx - ratio * (mx - _refZoom.tx);
        _refZoom.ty = my - ratio * (my - _refZoom.ty);

        _applyRefZoom();
    }, { passive: false });

    // Drag pan
    preview.addEventListener("mousedown", e => {
        if (_els.refImg.style.display === "none") return;
        if (e.button !== 0) return;
        _refZoom.dragging = true;
        _refZoom.sx = e.clientX;
        _refZoom.sy = e.clientY;
        _refZoom.stx = _refZoom.tx;
        _refZoom.sty = _refZoom.ty;
    });

    window.addEventListener("mousemove", e => {
        if (!_refZoom.dragging) return;
        _refZoom.tx = _refZoom.stx + (e.clientX - _refZoom.sx);
        _refZoom.ty = _refZoom.sty + (e.clientY - _refZoom.sy);
        _applyRefZoom();
    });

    window.addEventListener("mouseup", () => { _refZoom.dragging = false; });

    // Double-click reset
    preview.addEventListener("dblclick", () => {
        if (_els.refImg.style.display === "none") return;
        _resetRefZoom();
    });
}


// ========================================================================
// GENERATION
// ========================================================================

async function _generate() {
    if (_generating) return;

    const body = {
        prompt: _els.prompt.value,
        neg_prompt: _els.negPrompt.value,
        seconds: parseFloat(_els.seconds.value),
        fps: parseInt(_els.fps.value),
        width: parseInt(_els.width.value),
        height: parseInt(_els.height.value),
        steps: parseInt(_els.steps.value),
        cfg_scale: parseFloat(_els.cfg.value),
        denoising: 1.0,
        sampler_name: _els.sampler.value,
        schedule_type: _els.scheduler.value,
        seed: parseInt(_els.seed.value),
        init_image_b64: _refB64 || null,
        refiner_checkpoint: _els.refinerSelect.value || null,
        refiner_step: 3,
        enhancements: {
            cfg_zero_star: _els.cfgZero.checked,
            zero_init_pct: parseFloat(_els.zeroInitPct.value),
            optimized_scale: _els.optScale.checked,
            nag_enabled: _els.nag.checked,
            nag_scale: parseFloat(_els.nagScale.value),
            nag_tau: parseFloat(_els.nagTau.value),
            nag_alpha: parseFloat(_els.nagAlpha.value),
            nag_start_block: parseInt(_els.nagBlock.value),
            sigma_shift: _els.sigmaShift.checked ? parseFloat(_els.sigmaVal.value) : null,
            teacache_enabled: _els.teaCache.checked,
            teacache_threshold: parseFloat(_els.teaCacheThreshold.value),
        },
        post_upscale: _els.postUpscale.checked,
        upscale_model: _els.upscaleModel.value || "",
        upscale_factor: parseFloat(_els.upscaleFactor.value),
    };

    _generating = true;
    _els.genBtn.style.display = "none";
    _els.cancelBtn.style.display = "";
    _els.progress.style.display = "";
    _els.progressFill.style.width = "0%";
    _els.progressText.textContent = _refB64 ? "Starting I2V..." : "Starting T2V...";
    _els.output.style.display = "none";
    _els.refArea.style.display = "";  // restore if collapsed by previous result
    _hideStatus();

    const t0 = Date.now();
    const timer = setInterval(() => {
        if (!_generating) return clearInterval(timer);
        const s = ((Date.now() - t0) / 1000).toFixed(0);
        _els.progressText.textContent = `Generating... ${s}s`;
        // Fake progress bar (we don't have step-level WS progress yet)
        const pct = Math.min(95, (Date.now() - t0) / (parseInt(_els.steps.value) * 2000) * 100);
        _els.progressFill.style.width = pct + "%";
    }, 500);

    try {
        const resp = await fetch(API + "/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const result = await resp.json();
        clearInterval(timer);

        if (result.error) {
            _showStatus(result.error, "error");
        } else {
            _els.progressFill.style.width = "100%";
            _displayResult(result);
        }
    } catch (e) {
        clearInterval(timer);
        _showStatus("Request failed: " + e.message, "error");
    } finally {
        _generating = false;
        _els.genBtn.style.display = "";
        _els.cancelBtn.style.display = "none";
        _els.progress.style.display = "none";
    }
}

async function _cancel() {
    try {
        await fetch(API + "/cancel", { method: "POST" });
        _showStatus("Generation cancelled", "warn");
    } catch (e) {
        console.error(TAG, "Cancel failed:", e);
    }
}


// ========================================================================
// OUTPUT
// ========================================================================

function _displayResult(result) {
    if (result.video_path) {
        // Forge serves files at /file=<path>
        const videoUrl = "/file=" + encodeURIComponent(result.video_path);
        _els.videoPlayer.src = videoUrl;
        _els.videoPlayer.load();
        _els.output.style.display = "";
        _els.outputInfo.textContent =
            `${result.frames} frames | seed: ${result.seed}`;

        if (result.seed && result.seed > 0) _els.seed.value = result.seed;
        _showStatus("Video generated", "ok");

    } else if (result.thumbnail_b64) {
        // Frames generated but no video file — FFmpeg missing
        _els.output.style.display = "";
        _els.videoPlayer.poster = "data:image/jpeg;base64," + result.thumbnail_b64;
        _els.videoPlayer.removeAttribute("src");
        _els.outputInfo.textContent =
            `${result.frames} frames | seed: ${result.seed} | ⚠ Install FFmpeg for video output`;

        if (result.seed && result.seed > 0) _els.seed.value = result.seed;
        _showStatus("Frames generated but FFmpeg not found — install FFmpeg to get video output", "warn");

    } else {
        _showStatus("Generation completed but no output. Check terminal.", "warn");
    }

    // Show reference alongside video for comparison (I2V only)
    if (_refB64 && _els.outputRef) {
        _els.outputRefImg.src = "data:image/png;base64," + _refB64;
        _els.outputRef.style.display = "";
    } else if (_els.outputRef) {
        _els.outputRef.style.display = "none";
    }

    // Collapse main reference area — output takes the stage
    if (_els.output.style.display !== "none") {
        _els.refArea.style.display = "none";
        setTimeout(() => _els.output.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
    }
}


// ========================================================================
// STATUS & CAPABILITY
// ========================================================================

function _showStatus(msg, level = "info") {
    _els.status.textContent = msg;
    _els.status.className = "vl-status vl-status-" + level;
    _els.status.style.display = "";
}

function _hideStatus() {
    _els.status.style.display = "none";
}

async function _checkCapability() {
    try {
        const r = await fetch(API + "/status");
        const data = await r.json();
        if (!data.video_capable) {
            _showStatus(
                "Video generation requires a WAN model. Current model: " +
                (data.model_name || "none"), "warn"
            );
            _els.genBtn.disabled = true;
        } else {
            _hideStatus();
            _els.genBtn.disabled = false;
        }
        _els.modelStatus.textContent = data.video_capable
            ? "✓ " + (data.model_name || "WAN loaded")
            : "No WAN model loaded";
    } catch {
        // Routes not registered yet — will check again on activate
    }
}


// ========================================================================
// MODEL LOADER
// ========================================================================

async function _populateModelDropdowns() {
    // Checkpoints (for both primary and refiner)
    try {
        const models = await fetch("/studio/models").then(r => r.json());
        const current = await fetch("/studio/current_model").then(r => r.json());

        // Primary (high noise)
        const sel = _els.modelSelect;
        sel.innerHTML = '<option value="">(select checkpoint)</option>';
        for (const m of models) {
            const opt = document.createElement("option");
            opt.value = m.title;
            opt.textContent = m.name || m.title;
            if (m.title === current.title) opt.selected = true;
            sel.appendChild(opt);
        }

        // Refiner (low noise) — same list, default to none
        const ref = _els.refinerSelect;
        ref.innerHTML = '<option value="">(none — single model)</option>';
        for (const m of models) {
            const opt = document.createElement("option");
            opt.value = m.title;
            opt.textContent = m.name || m.title;
            ref.appendChild(opt);
        }
        _restoreDeferredSelect("modelSelect");
        _restoreDeferredSelect("refinerSelect");
    } catch (e) { console.warn(TAG, "Model list error:", e); }

    // Text encoders
    try {
        const encs = await fetch(API + "/text_encoders").then(r => r.json());
        const sel = _els.textEncoderSelect;
        sel.innerHTML = '<option value="">(auto / bundled)</option>';
        for (const name of encs) {
            const opt = document.createElement("option");
            opt.value = name;
            opt.textContent = name;
            // Auto-select UMT5 if present
            if (name.toLowerCase().includes("umt5")) opt.selected = true;
            sel.appendChild(opt);
        }
        _restoreDeferredSelect("textEncoderSelect");
    } catch (e) { console.warn(TAG, "Text encoder list error:", e); }

    // VAEs
    try {
        const vaes = await fetch("/studio/vaes").then(r => r.json());
        const sel = _els.vaeSelect;
        const current = await fetch("/studio/current_vae").then(r => r.json());
        sel.innerHTML = '';
        for (const v of vaes) {
            const opt = document.createElement("option");
            opt.value = v.name;
            opt.textContent = v.name;
            if (v.name === current.name) opt.selected = true;
            sel.appendChild(opt);
        }
        _restoreDeferredSelect("vaeSelect");
    } catch (e) { console.warn(TAG, "VAE list error:", e); }
}

async function _loadModel() {
    const checkpoint = _els.modelSelect.value;
    if (!checkpoint) {
        _showStatus("Select a checkpoint first", "warn");
        return;
    }

    _els.loadModelBtn.disabled = true;
    _els.modelStatus.textContent = "Loading...";

    try {
        // Load checkpoint with text encoder and VAE as additional modules
        const vae = _els.vaeSelect.value;
        const textEncoder = _els.textEncoderSelect.value;
        const resp = await fetch(API + "/load_model", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                title: checkpoint,
                text_encoder: textEncoder || null,
                vae: vae || null,
            }),
        });
        const result = await resp.json();

        if (result.error) {
            _showStatus("Load failed: " + result.error, "error");
            _els.modelStatus.textContent = "Load failed";
        } else {
            _showStatus("Model loaded: " + (result.loaded || checkpoint), "ok");
            _els.modelStatus.textContent = "✓ " + (result.loaded || checkpoint);
            _els.genBtn.disabled = false;
            // Re-check capability
            setTimeout(_checkCapability, 1000);
        }
    } catch (e) {
        _showStatus("Load error: " + e.message, "error");
        _els.modelStatus.textContent = "Error";
    } finally {
        _els.loadModelBtn.disabled = false;
    }
}

async function _populateUpscalers() {
    try {
        const names = await fetch(API + "/upscalers").then(r => r.json());
        const sel = _els.upscaleModel;
        sel.innerHTML = '<option value="">(auto)</option>';
        for (const name of names) {
            const opt = document.createElement("option");
            opt.value = name;
            opt.textContent = name;
            sel.appendChild(opt);
        }
        _restoreDeferredSelect("upscaleModel");
    } catch (e) { console.warn(TAG, "Upscaler list error:", e); }
}

async function _extractLastFrame() {
    try {
        _els.extractLast.disabled = true;
        _els.extractLast.textContent = "Extracting...";

        const resp = await fetch(API + "/last_frame", { method: "POST" });
        const data = await resp.json();

        if (data.error) {
            _showStatus("No frames available", "warn");
            return;
        }

        // Set as reference image
        _refB64 = data.image_b64;
        _els.refImg.src = "data:image/png;base64," + data.image_b64;
        _els.refPreview.style.display = "";
        _els.refEmpty.style.display = "none";

        // Update dimensions to match
        if (data.width) _els.width.value = data.width;
        if (data.height) _els.height.value = data.height;

        _showStatus("Last frame set as reference", "ok");
    } catch (e) {
        _showStatus("Extract failed: " + e.message, "error");
    } finally {
        _els.extractLast.disabled = false;
        _els.extractLast.textContent = "Extract Last Frame";
    }
}


})();
