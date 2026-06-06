/**
 * Forge Studio — Workshop Module (Frontend)
 * by ToxicHost & Moritz
 *
 * v0.8.0 — Merge Board
 * Replaces the sequential pipeline with a row-based merge board: every row
 * is identical (Primary / Secondary / optional Tertiary / Method / Alpha /
 * method-specific params / optional per-block weights). A row may reference
 * outputs of earlier rows as inputs via stable row IDs that are mapped to
 * positional __ON__ at chain-build time. LoRA bake, VAE bake, output
 * filename, and "save fp16" remain as separate sections below the board.
 *
 * Backend chain endpoint already handles __ON__ resolution — pure frontend
 * restructure.
 *
 * Registers via StudioModules.register("workshop", {...})
 */
(function () {
"use strict";

// i18n helper — every dynamically-built string passes its English source
// through _t() so the locale-aware text shows on first paint. Elements
// also get data-i18n* attributes so applyToDom() keeps them in sync on
// locale switch.
function _t(key, fallback, params) {
  return (window.I18N && window.I18N.t) ? window.I18N.t(key, fallback, params) : fallback;
}

const TAG = "[Workshop]";
const API = "/studio/workshop";
const VERSION = "0.8.0";

// ========================================================================
// METHOD METADATA
// ========================================================================

const METHOD_INFO = {
    weighted_sum: {
        label: "Weighted Sum", needsC: false, params: [], blockWeights: true,
        showAlpha: true, alphaLabel: "Secondary Weight",
        alphaHint: "0 = 100% Primary/A, 1 = 100% Secondary/B, 0.5 = equal blend.",
        formula: "A × (1 − α) + B × α",
        desc: "The simplest merge — blends every weight between A and B by the alpha value. Good starting point for any merge. If results look washed out, try SLERP instead.",
    },
    slerp: {
        label: "SLERP", needsC: false, params: [], blockWeights: true,
        showAlpha: true, alphaLabel: "Secondary Weight",
        alphaHint: "0 = 100% Primary/A, 1 = 100% Secondary/B, 0.5 = equal blend.",
        formula: "slerp(A, B, α)",
        desc: "Spherical interpolation — preserves the magnitude of weight vectors instead of averaging them. Usually produces sharper, more vibrant results than Weighted Sum at the same alpha. Best for blending two models of similar quality.",
    },
    add_difference: {
        label: "Add Difference", needsC: true, params: [], blockWeights: true,
        showAlpha: true, alphaLabel: "Strength",
        alphaHint: "How much of B’s training to apply. 0.5 = half strength, 1.0 = full.",
        formula: "A + (B − C) × α",
        desc: "Extracts what Model B learned from Model C (its base), then applies that training to Model A. Use this to transplant a finetune’s skills (e.g. anime style, specific subject) into a different model. Requires Model C — the base model B was finetuned from.",
    },
    ties: {
        label: "TIES", needsC: false, params: ["density"], blockWeights: false,
        showAlpha: true, alphaLabel: "Lambda (λ)",
        alphaHint: "Strength of the trimmed task vector. Start at 0.5–1.0.",
        formula: "A + λ · trim(B − A, density)",
        desc: "Trim, Elect Sign & Merge — extracts B’s training over A, then trims away the weakest changes, keeping only the most significant ones. The Density parameter controls how aggressively to trim. Great for noisy finetunes where you want only the strongest signal.",
    },
    dare: {
        label: "DARE", needsC: false, params: ["drop_rate"], blockWeights: false,
        showAlpha: true, alphaLabel: "Lambda (λ)",
        alphaHint: "Strength of the sparsified task vector. Start at 0.5–1.0.",
        formula: "A + λ · dare(B − A, drop_rate)",
        desc: "Drop And REscale — randomly drops most of B’s training changes and rescales the survivors to compensate. Neural networks are redundant, so even dropping 90% of changes often preserves the effect. Produces surprisingly clean results from messy finetunes.",
    },
    dare_ties: {
        label: "DARE-TIES", needsC: false, params: ["density", "drop_rate"], blockWeights: false,
        showAlpha: true, alphaLabel: "Lambda (λ)",
        alphaHint: "Strength of the processed task vector. Start at 0.5–1.0.",
        formula: "A + λ · trim(dare(B − A, drop_rate), density)",
        desc: "Combines DARE and TIES — randomly drops changes first, then trims the survivors by magnitude. The most aggressive filtering. Best when B is a very noisy finetune and you want only the absolute strongest signal.",
    },
    cosine_adaptive: {
        label: "Cosine Adaptive", needsC: false, params: ["cosine_shift"], blockWeights: true,
        showAlpha: false, alphaLabel: null, alphaHint: null,
        formula: "A + cos_shift(A, B) · (B − A)",
        desc: "Automatically computes a unique blend ratio for every weight based on how similar A and B are at that point. Where they already agree, it keeps A. Where they diverge, it incorporates B. The Shift parameter adjusts how conservative (positive) or aggressive (negative) the blending is. No alpha needed — the math decides.",
    },
    star: {
        label: "STAR (Spectral)", needsC: false, params: ["eta"], blockWeights: true,
        showAlpha: true, alphaLabel: "Lambda (λ)",
        alphaHint: "Strength of the denoised task vector. Start at 0.5–1.0.",
        formula: "A + λ · svd_truncate(B − A, η)",
        desc: "Spectral Truncation and Rescale — decomposes B’s training via SVD and strips noisy components before merging. Produces cleaner results than element-wise methods, especially from overtrained or messy finetunes. The Eta parameter controls how aggressively noise is removed.",
    },
    svd_struct_a_mag_b: {
        label: "SVD: Structure A + Mag B", needsC: false, params: [], blockWeights: true,
        showAlpha: true, alphaLabel: "Blend Strength",
        alphaHint: "0 = pure A. 1 = full spectral swap. Start at 0.3–0.5.",
        formula: "U_A · Σ_B · V_Aᵀ · α + A · (1 − α)",
        desc: "Decomposes both models via SVD, then takes A’s feature directions (what the layer detects) and B’s magnitudes (how strongly it responds). Example: photorealism model’s composition + anime model’s vibrancy. Produces results impossible from any weight-averaging method.",
    },
    svd_struct_b_mag_a: {
        label: "SVD: Structure B + Mag A", needsC: false, params: [], blockWeights: true,
        showAlpha: true, alphaLabel: "Blend Strength",
        alphaHint: "0 = pure A. 1 = full spectral swap. Start at 0.3–0.5.",
        formula: "U_B · Σ_A · V_Bᵀ · α + A · (1 − α)",
        desc: "The inverse — takes B’s feature directions (what the layer detects) and A’s magnitudes (how strongly it responds). Same concept as Structure A + Mag B but swapped. Try both and compare — the results are surprisingly different.",
    },
    svd_blend: {
        label: "SVD: Spectral Blend", needsC: false, params: [], blockWeights: true,
        showAlpha: true, alphaLabel: "Secondary Weight",
        alphaHint: "0 = 100% Primary/A, 1 = 100% Secondary/B, 0.5 = equal blend.",
        formula: "procrustes_slerp(SVD(A), SVD(B), α)",
        desc: "Aligns both models’ spectral decompositions via Procrustes rotation, then interpolates structure and magnitude together in spectral space. Smoother than Weighted Sum because it respects the geometric relationship between feature directions rather than averaging raw weights.",
    },
    della: {
        label: "DELLA", needsC: false, params: ["drop_rate"], blockWeights: false,
        showAlpha: true, alphaLabel: "Lambda (λ)",
        alphaHint: "Strength of the sparsified task vector. Start at 0.5–1.0.",
        formula: "A + λ · della(B − A, drop_rate)",
        desc: "Like DARE but smarter about what it drops — drop probability is inversely proportional to magnitude, so large important changes survive while small noisy ones are more likely to be removed. Produces slightly more reliable results than DARE’s uniform random masking.",
    },
    della_ties: {
        label: "DELLA-TIES", needsC: false, params: ["density", "drop_rate"], blockWeights: false,
        showAlpha: true, alphaLabel: "Lambda (λ)",
        alphaHint: "Strength of the processed task vector. Start at 0.5–1.0.",
        formula: "A + λ · trim(della(B − A, drop_rate), density)",
        desc: "Combines DELLA and TIES — magnitude-weighted dropout first, then trims survivors by magnitude. Like DARE-TIES but with smarter dropout that preferentially keeps important parameters.",
    },
    breadcrumbs: {
        label: "Breadcrumbs", needsC: false, params: ["density", "drop_rate"], blockWeights: false,
        showAlpha: true, alphaLabel: "Lambda (λ)",
        alphaHint: "Strength of the trimmed task vector. Start at 0.5–1.0.",
        formula: "A + λ · trim(B − A, density, drop_rate)",
        desc: "Dual-threshold trimming — like TIES but also removes the largest outlier changes, not just the smallest. Density controls the lower cutoff (how much to keep), Drop Rate controls the upper cutoff (how many outliers to remove). Best for finetunes with both noise and overfitting artifacts.",
    },
};

const PARAM_DEFS = {
    density: { label: "Density", min: 0, max: 1, step: 0.05, default: 0.2 },
    drop_rate: { label: "Drop Rate", min: 0, max: 0.99, step: 0.05, default: 0.9 },
    cosine_shift: { label: "Cosine Shift", min: -1, max: 1, step: 0.05, default: 0.0 },
    eta: { label: "Eta (η)", min: 0, max: 0.5, step: 0.01, default: 0.1 },
};

// Workshop alpha == backend alpha == Secondary (Model B) contribution.
// 0 keeps Primary/A, 1 takes Secondary/B, 0.5 is an equal blend. Display
// and storage are the same number; the helpers stay as identities so the
// callsites are kept stable in case we ever need to introduce a flip
// again.
function _alphaForDisplay(stored, _method) { return stored; }
function _alphaFromDisplay(displayed, _method) { return displayed; }

const BLOCK_TOOLTIPS = {
    "Text Encoder": "Controls how text prompts are interpreted. Merging this changes what words mean to the model.",
    "Input Blocks": "Progressively compress the image. Early = fine details (texture, linework). Later = composition and structure.",
    "Middle": "Most compressed representation — the model’s core understanding of the image. Affects global coherence.",
    "Output Blocks": "Expand back to full resolution. Early = structure/composition. Later = fine details and rendering quality.",
    "Double Stream Blocks": "FLUX dual-stream blocks. Process image and text simultaneously with cross-attention.",
    "Single Stream Blocks": "FLUX single-stream blocks. Process merged image+text representations.",
    "Joint Blocks": "SD3 MMDiT blocks. Jointly process image and text tokens at each layer.",
    "IN00": "Full res — Surface details: skin pores, hair strands, line quality",
    "IN01": "Full res — Fine textures and micro-patterns",
    "IN02": "Full res — Local color and fine shading",
    "IN03": "Half res — Mid-level features: facial features, fabric folds",
    "IN04": "Half res — Object parts and local structure",
    "IN05": "Half → quarter res — Transition to structural features",
    "IN06": "Quarter res — Large-scale shapes and object boundaries",
    "IN07": "Quarter res — Scene layout and spatial relationships",
    "IN08": "Quarter → eighth res — High-level composition",
    "IN09": "Eighth res — Abstract composition and pose",
    "IN10": "Eighth res — Global scene structure",
    "IN11": "Eighth res — Most abstract input representation",
    "M00": "Deepest layer — The model’s core understanding of the whole image",
    "OUT00": "Eighth res — Mirrors IN11: rebuilding from abstract structure",
    "OUT01": "Eighth res — Large-scale composition decisions",
    "OUT02": "Eighth res — Spatial arrangement and layout",
    "OUT03": "Eighth → quarter res — Structure to shape transition",
    "OUT04": "Quarter res — Object shapes and boundaries",
    "OUT05": "Quarter res — Scene geometry and spatial detail",
    "OUT06": "Quarter → half res — Shape to feature transition",
    "OUT07": "Half res — Object details and mid-level features",
    "OUT08": "Half res — Fine structural details and rendering",
    "OUT09": "Half → full res — Feature to texture transition",
    "OUT10": "Full res — Surface rendering and shading style",
    "OUT11": "Full res — Final detail: texture, color, rendering quality",
    "BASE": "Text encoder weights — changes how prompts are understood",
    "VAE": "Image encoder/decoder — usually identical between models of the same architecture",
    "OTHER": "Miscellaneous keys not classified into standard blocks",
};

function _getBlockTooltip(name) { return BLOCK_TOOLTIPS[name] || null; }

// ========================================================================
// STATE
// ========================================================================

const WS = {
    models: [], loras: [], vaes: [],

    // Merge board: each row is a self-contained merge step.
    rows: [],
    activeRow: 0,

    // Block list and presets are keyed by architecture; loaded once when arch
    // changes. Each row stores its own per-block weights independently.
    blockList: [], presets: {}, arch: null,

    // Global recipe extras (applied after the board)
    recipeLoras: [],     // [{filename, strength}] — LoRA bake (global)
    recipeVae: null,     // VAE baked once into the chain's final output (global)
    outputName: "", saveFp16: true, outputDtype: "auto", saveIntermediates: false,

    // Run state
    merging: false, progress: 0, status: "idle", error: null, result: null,
    elapsed: 0, keysDone: 0, keysTotal: 0,
    chainStep: 0, chainTotal: 0,   // chain-scoped meta from backend
    memoryMergeActive: false, testMerging: false,

    // Inspector (driven by activeRow)
    inspectA: null, inspectB: null, preflight: null, cosineDiff: null,
    compatibility: null, healthScan: null, healthLoading: false, diffLoading: false,

    // Journal
    journalEntries: [], journalSearch: "", journalFilter: "all", journalExpanded: null,
};
let _els = {};

// ========================================================================
// ROW HELPERS — stable IDs, ref resolution, board mutation
// ========================================================================

function _genRowId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return "row_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    }
    return "row_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function _newRow(initial) {
    return Object.assign({
        id: _genRowId(),
        primary: null, secondary: null, tertiary: null,
        method: "weighted_sum", alpha: 0.5,
        density: 0.2, dropRate: 0.9, cosineShift: 0.0, eta: 0.1,
        useBlockWeights: false, blockWeights: null,
        // Per-row VAE bake — explicit opt-in. The global VAE (below the
        // board) handles the chain's final output by default; a row only
        // emits its own vae_bake step when bakeVae is on AND vae is set.
        bakeVae: false, vae: null,
        // Per-row output filename for the row's merge step. Only surfaced
        // in UI when "Keep intermediates" is on AND this isn't the final
        // merge-producing row (the final row uses the global Output
        // Filename). Stored regardless of UI visibility so it survives
        // toggling Keep Intermediates off and back on.
        outputName: "",
        // Transient UI: line 2 (advanced) opt-in for methods that have
        // nothing else on line 2 (e.g. weighted_sum). Not persisted.
        expanded: false,
    }, initial || {});
}

// Index of the last row that currently produces a merge step (both
// primary and secondary set). -1 if none. Used to decide which row gets
// to display its per-row output name input vs. defer to the global one.
function _finalMergeRowIdx() {
    for (let i = WS.rows.length - 1; i >= 0; i--) {
        const r = WS.rows[i];
        if (r.primary && r.secondary) return i;
    }
    return -1;
}

// A reference value stored in a row's primary/secondary/tertiary slot looks
// like "__ref:<rowId>__". This is independent of the row's current visual
// position, so deletions / reorderings cannot silently rewire references.
function _refValue(rowId) { return "__ref:" + rowId + "__"; }
function _isRefValue(v) { return typeof v === "string" && v.indexOf("__ref:") === 0 && v.endsWith("__"); }
function _refRowId(v) {
    if (!_isRefValue(v)) return null;
    return v.slice(6, -2);
}

// True if any row strictly *after* `idx` references the row at `idx` via its
// stable id. Used to block deletion.
function _isRowReferenced(idx) {
    if (idx < 0 || idx >= WS.rows.length) return false;
    const ref = _refValue(WS.rows[idx].id);
    for (let i = idx + 1; i < WS.rows.length; i++) {
        const r = WS.rows[i];
        if (r.primary === ref || r.secondary === ref || r.tertiary === ref) return true;
    }
    return false;
}

// Names of later rows that reference this one (for the deletion tooltip).
function _rowsReferencing(idx) {
    const out = [];
    if (idx < 0 || idx >= WS.rows.length) return out;
    const ref = _refValue(WS.rows[idx].id);
    for (let i = idx + 1; i < WS.rows.length; i++) {
        const r = WS.rows[i];
        if (r.primary === ref || r.secondary === ref || r.tertiary === ref) {
            out.push("Row " + (i + 1));
        }
    }
    return out;
}

function _rowIndexById(id) {
    for (let i = 0; i < WS.rows.length; i++) if (WS.rows[i].id === id) return i;
    return -1;
}

// Maps a stored row-input value to the API-ready string for a chain step.
// Concrete filename returned as-is. __ref:<rowId>__ → __O<step>__ using
// the supplied rowOutputStep map ({ rowId → step number of that row's
// last contributed step, e.g. its post-VAE step if a VAE was attached }).
function _resolveRowInput(value, rowOutputStep) {
    if (value === null || value === undefined || value === "") return null;
    if (!_isRefValue(value)) return value;
    const rowId = _refRowId(value);
    if (rowOutputStep && rowId in rowOutputStep) {
        return "__O" + rowOutputStep[rowId] + "__";
    }
    // Forward / unknown ref (shouldn't happen — UI only offers earlier
    // rows and the deletion guard prevents dangling refs).
    return null;
}

function _isConcreteModel(v) { return !!v && !_isRefValue(v); }

// ========================================================================
// API HELPERS
// ========================================================================

async function fetchJSON(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || res.statusText);
    }
    return res.json();
}

// ========================================================================
// MODEL / LORA / VAE LOADING
// ========================================================================

async function loadModels() {
    try {
        WS.models = await fetchJSON(API + "/models");
        _renderRows();
    } catch (e) {
        console.error(TAG, "Failed to load models:", e);
        if (window.showToast) window.showToast(_t("workshop.toast.failedToLoadModels", "Failed to load model list"), "error");
    }
}

async function loadLoras() {
    try { WS.loras = await fetchJSON(API + "/loras"); _renderRecipeLoras(); } catch (e) { console.error(TAG, "Failed to load LoRAs:", e); }
}

async function loadVaes() {
    try {
        WS.vaes = await fetchJSON(API + "/vaes");
        _populateGlobalVaeSelect();
        for (let i = 0; i < WS.rows.length; i++) _populateRowVae(i);
    } catch (e) { console.error(TAG, "Failed to load VAEs:", e); }
}

async function refreshAssets() {
    const btn = _els && _els.refreshAssets;
    const prevLabel = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = _t("workshop.action.scanning", "Scanning…"); }
    try {
        let summary = null;
        try { summary = await fetchJSON(API + "/refresh", { method: "POST" }); }
        catch (e) { console.error(TAG, "Refresh rescan failed:", e); }
        await Promise.all([loadModels(), loadLoras(), loadVaes()]);
        if (window.showToast) {
            if (summary && summary.ok) {
                const parts = [];
                if (typeof summary.checkpoints === "number") parts.push(summary.checkpoints + " models");
                if (typeof summary.loras === "number") parts.push(summary.loras + " LoRAs");
                if (typeof summary.vaes === "number") parts.push(summary.vaes + " VAEs");
                window.showToast("Workshop rescanned — " + (parts.join(", ") || "done"), "success");
            } else {
                window.showToast("Workshop rescanned", "success");
            }
        }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = prevLabel || "↻ Refresh"; }
    }
}

// ========================================================================
// INSPECTION & PREFLIGHT — driven by the active row
// ========================================================================

function _activeRow() { return WS.rows[WS.activeRow] || null; }

function _activeInputs() {
    const r = _activeRow();
    if (!r) return { a: null, b: null };
    return {
        a: _isConcreteModel(r.primary) ? r.primary : null,
        b: _isConcreteModel(r.secondary) ? r.secondary : null,
    };
}

async function inspectModel(filename, which) {
    if (!filename) { WS[which === "A" ? "inspectA" : "inspectB"] = null; _onActiveModelsChanged(); return; }
    try {
        const info = await fetchJSON(API + "/inspect?filename=" + encodeURIComponent(filename));
        WS[which === "A" ? "inspectA" : "inspectB"] = info;
        _onActiveModelsChanged();
    } catch (e) { console.error(TAG, "Inspect " + which + " failed:", e); }
}

async function runPreflight() {
    const { a, b } = _activeInputs();
    if (!a || !b) { WS.preflight = null; _renderInfo(); return; }
    try {
        WS.preflight = await fetchJSON(API + "/preflight?model_a=" + encodeURIComponent(a) + "&model_b=" + encodeURIComponent(b));
        _renderInfo();
    } catch (e) { console.error(TAG, "Preflight failed:", e); }
}

async function runCompatibility() {
    const { a, b } = _activeInputs();
    if (!a || !b) { WS.compatibility = null; _renderInfo(); return; }
    try {
        WS.compatibility = await fetchJSON(API + "/compatibility?model_a=" + encodeURIComponent(a) + "&model_b=" + encodeURIComponent(b));
        _renderInfo();
    } catch (e) { console.error(TAG, "Compatibility check failed:", e); }
}

async function runHealthScan(filename) {
    if (!filename) return;
    WS.healthLoading = true; WS.healthScan = null; _renderInfo();
    try {
        WS.healthScan = await fetchJSON(API + "/health?filename=" + encodeURIComponent(filename));
    } catch (e) {
        console.error(TAG, "Health scan failed:", e);
        if (window.showToast) window.showToast(_t("workshop.toast.healthScanFailed", "Health scan failed: " + e.message, { error: e.message }), "error");
    }
    WS.healthLoading = false; _renderInfo();
}

async function loadCosineDiff() {
    const { a, b } = _activeInputs();
    if (!a || !b) { WS.cosineDiff = null; _renderInfo(); return; }
    WS.diffLoading = true; _renderInfo();
    try {
        WS.cosineDiff = await fetchJSON(API + "/cosine_diff?model_a=" + encodeURIComponent(a) + "&model_b=" + encodeURIComponent(b));
    } catch (e) {
        console.error(TAG, "Cosine diff failed:", e);
        if (window.showToast) window.showToast(_t("workshop.toast.cosineDiffFailed", "Cosine diff failed: " + e.message, { error: e.message }), "error");
    }
    WS.diffLoading = false; _renderInfo();
}

async function loadPresets(arch) {
    try {
        const data = await fetchJSON(API + "/presets?arch=" + encodeURIComponent(arch));
        WS.presets = data.presets || {}; WS.blockList = data.blocks || [];
        for (let i = 0; i < WS.rows.length; i++) {
            _populatePresetSelectForRow(i);
            _buildBlockSlidersForRow(i);
        }
    } catch (e) { console.error(TAG, "Presets failed:", e); }
}

async function loadModelStockForRow(rowIdx) {
    const r = WS.rows[rowIdx];
    if (!r) return;
    const a = _isConcreteModel(r.primary) ? r.primary : null;
    const b = _isConcreteModel(r.secondary) ? r.secondary : null;
    if (!a || !b) return;
    try {
        if (window.showToast) window.showToast(_t("workshop.toast.modelStockComputing", "Computing Model Stock auto-alpha…"), "info");
        const data = await fetchJSON(API + "/model_stock?model_a=" + encodeURIComponent(a) + "&model_b=" + encodeURIComponent(b));
        if (data.alphas && Object.keys(data.alphas).length) {
            r.blockWeights = data.alphas;
            r.useBlockWeights = true;
            _syncRowBlockUI(rowIdx);
            if (data.cosine_diff && rowIdx === WS.activeRow) {
                WS.cosineDiff = { blocks: data.cosine_diff, global_similarity: data.global_similarity, architecture: WS.inspectA?.architecture };
                _renderInfo();
            }
            if (window.showToast) window.showToast(_t("workshop.toast.modelStockApplied", "Model Stock alphas applied to Row " + (rowIdx + 1), { row: rowIdx + 1 }), "success");
        }
    } catch (e) {
        console.error(TAG, "Model Stock failed:", e);
        if (window.showToast) window.showToast(_t("workshop.toast.modelStockFailed", "Model Stock failed: " + e.message, { error: e.message }), "error");
    }
}

// ========================================================================
// RECIPE → CHAIN ASSEMBLY
// ========================================================================

// Capture the merge board state as a JSON-safe snapshot. Rides
// along on /chain POSTs and lands on the resulting journal entry
// at recipe.workshop_board. "Import Recipe" prefers this payload
// when present — it preserves row references (rowId / ref tokens
// like __R0__), the useBlockWeights flag, per-row VAE bakes, and
// every method-specific param without trying to reverse-engineer
// them out of the resolved-filename per-step recipe summary.
//
// Only persisted-friendly fields go in. Transient UI state like
// row.expanded is skipped; it has no meaning across an import.
function _buildBoardSnapshot() {
    return {
        rows: WS.rows.map(r => ({
            id: r.id,
            primary: r.primary,
            secondary: r.secondary,
            tertiary: r.tertiary,
            method: r.method,
            alpha: r.alpha,
            density: r.density,
            dropRate: r.dropRate,
            cosineShift: r.cosineShift,
            eta: r.eta,
            useBlockWeights: r.useBlockWeights,
            blockWeights: r.blockWeights,
            bakeVae: r.bakeVae,
            vae: r.vae,
            outputName: r.outputName,
        })),
        recipeLoras: WS.recipeLoras
            .filter(l => l.filename)
            .map(l => ({ filename: l.filename, strength: l.strength })),
        recipeVae: WS.recipeVae,
        outputName: WS.outputName,
        saveFp16: WS.saveFp16,
        outputDtype: WS.outputDtype,
        saveIntermediates: WS.saveIntermediates,
    };
}

function _wsOutputDtype() {
    // Resolve the output dtype to send to the backend. When reduced
    // precision is unchecked we force fp32; otherwise the dropdown value
    // (default "auto") wins. Backend maps "auto" to BF16 for Anima/Cosmos
    // and FP16 for everything else — merge math always runs in FP32.
    if (!WS.saveFp16) return "fp32";
    return WS.outputDtype || "auto";
}

function _buildRecipeChain() {
    /**
     * Walks the board into a chain of backend steps:
     *
     *   - Each row with both primary and secondary set produces a merge
     *     step. Primary-only rows are checkpoint sources for bake-only
     *     flows (LoRA / global VAE bake on a single model — see below).
     *   - If a merge row carries a per-row VAE override (bakeVae + vae),
     *     an extra vae_bake step is appended right after that row's
     *     merge, taking the merge's output as checkpoint.
     *   - Refs from later rows resolve to a row's final step number
     *     (post-bakeVae if any), so chained rows automatically consume
     *     the VAE-baked result.
     *   - LoRA bake (global) is appended after all rows.
     *   - Global VAE (WS.recipeVae) is the chain's last step when set.
     *   - Bake-only fallback: if no merge step is produced but bakes
     *     (LoRAs or global VAE) are configured, the first row whose
     *     primary is a concrete file becomes the bake checkpoint.
     */
    const steps = [];
    const rowOutputStep = {};   // rowId → last step number contributed by that row
    let stepNum = 0;

    for (let i = 0; i < WS.rows.length; i++) {
        const row = WS.rows[i];
        if (!row.primary || !row.secondary) continue;   // incomplete row skipped here

        stepNum++;
        const mergeStepNum = stepNum;
        const params = {
            model_a: _resolveRowInput(row.primary, rowOutputStep),
            model_b: _resolveRowInput(row.secondary, rowOutputStep),
            method: row.method,
            alpha: row.alpha,
            block_weights: row.useBlockWeights ? row.blockWeights : null,
            save_fp16: WS.saveFp16,
            output_dtype: _wsOutputDtype(),
        };
        const info = METHOD_INFO[row.method] || {};
        if (info.needsC && row.tertiary) params.model_c = _resolveRowInput(row.tertiary, rowOutputStep);
        if (info.params.includes("density")) params.density = row.density;
        if (info.params.includes("drop_rate")) params.drop_rate = row.dropRate;
        if (info.params.includes("cosine_shift")) params.cosine_shift = row.cosineShift;
        if (info.params.includes("eta")) params.eta = row.eta;
        // Per-row output name: only meaningful when keeping intermediates,
        // and only stored on rows that aren't the final merge row (the
        // global Output Filename overrides the last step below).
        if (WS.saveIntermediates && row.outputName) {
            params.output_name = row.outputName;
        }
        steps.push({ step: mergeStepNum, type: "merge", params });

        let rowFinalStep = mergeStepNum;

        // Per-row VAE bake — explicit opt-in. Both the checkbox AND a
        // picked filename must be set; otherwise we skip silently and
        // let the global VAE (if any) handle the chain's final output.
        if (row.bakeVae && row.vae) {
            stepNum++;
            steps.push({
                step: stepNum, type: "vae_bake",
                params: {
                    checkpoint: "__O" + mergeStepNum + "__",
                    vae: row.vae,
                    save_fp16: WS.saveFp16,
                    output_dtype: _wsOutputDtype(),
                },
            });
            rowFinalStep = stepNum;
        }

        rowOutputStep[row.id] = rowFinalStep;
    }

    const activeLoras = WS.recipeLoras.filter(l => l.filename);
    const hasGlobalVae = !!WS.recipeVae;
    const hasBakes = activeLoras.length > 0 || hasGlobalVae;

    // Determine the checkpoint for downstream bake steps. With merge
    // steps already in the chain, this is just the latest output. For a
    // bake-only flow (no merges), fall back to the first row whose
    // primary is a concrete filename — this restores the pre-merge-board
    // "single model + LoRAs / VAE" workflow.
    let bakeCheckpoint = null;
    if (steps.length > 0) {
        bakeCheckpoint = "__O" + stepNum + "__";
    } else if (hasBakes) {
        const seed = WS.rows.find(r => _isConcreteModel(r.primary));
        if (seed) bakeCheckpoint = seed.primary;
    }

    if (activeLoras.length) {
        stepNum++;
        steps.push({
            step: stepNum, type: "lora_bake",
            params: {
                checkpoint: bakeCheckpoint,
                loras: activeLoras.map(l => ({ filename: l.filename, strength: l.strength })),
                save_fp16: WS.saveFp16,
                output_dtype: _wsOutputDtype(),
            },
        });
        bakeCheckpoint = "__O" + stepNum + "__";
    }

    // Global VAE bake — final step when set
    if (hasGlobalVae) {
        stepNum++;
        steps.push({
            step: stepNum, type: "vae_bake",
            params: {
                checkpoint: bakeCheckpoint,
                vae: WS.recipeVae,
                save_fp16: WS.saveFp16,
                output_dtype: _wsOutputDtype(),
            },
        });
    }

    if (steps.length && WS.outputName) {
        steps[steps.length - 1].params.output_name = WS.outputName;
    }

    return steps;
}

function _canTestMerge() {
    // Test merge: exactly one row, two concrete-file models, a satisfied
    // tertiary slot if the method needs one, no LoRAs, and no VAE bake
    // (neither global nor per-row override).
    if (WS.rows.length !== 1) return false;
    const r = WS.rows[0];
    if (!_isConcreteModel(r.primary) || !_isConcreteModel(r.secondary)) return false;
    if (r.primary === r.secondary) return false;
    const info = METHOD_INFO[r.method] || {};
    if (info.needsC && (!_isConcreteModel(r.tertiary) || r.tertiary === r.primary || r.tertiary === r.secondary)) return false;
    if (WS.recipeLoras.filter(l => l.filename).length > 0) return false;
    if (WS.recipeVae) return false;
    if (WS.rows.some(row => row.bakeVae && row.vae)) return false;
    if (WS.merging || WS.testMerging) return false;
    return true;
}

function _getTestMergeTooltip() {
    if (WS.rows.length !== 1) return "Test merge unavailable with more than one row — use Begin Merge instead";
    const r = WS.rows[0];
    if (!_isConcreteModel(r.primary) || !_isConcreteModel(r.secondary)) return "Test merge requires two concrete files (no row references)";
    const info = METHOD_INFO[r.method] || {};
    if (info.needsC && !_isConcreteModel(r.tertiary)) return "Add Difference needs Tertiary (Model C) for test merge";
    if (WS.recipeLoras.filter(l => l.filename).length > 0) return "Test merge unavailable with LoRAs — use Begin Merge instead";
    if (WS.recipeVae || WS.rows.some(row => row.bakeVae && row.vae)) return "Test merge unavailable with VAE bake — use Begin Merge instead";
    return "Hot-swap UNet weights — no disk write, instant iteration";
}

function _buildMergeBody() {
    // Body for the in-memory single-step merge endpoint.
    const r = WS.rows[0];
    const body = {
        model_a: r.primary, model_b: r.secondary,
        alpha: r.alpha, method: r.method,
        block_weights: r.useBlockWeights ? r.blockWeights : null,
    };
    const info = METHOD_INFO[r.method] || {};
    if (info.needsC && r.tertiary) body.model_c = r.tertiary;
    if (info.params.includes("density")) body.density = r.density;
    if (info.params.includes("drop_rate")) body.drop_rate = r.dropRate;
    if (info.params.includes("cosine_shift")) body.cosine_shift = r.cosineShift;
    if (info.params.includes("eta")) body.eta = r.eta;
    return body;
}

// ========================================================================
// MERGE / TEST / CANCEL
// ========================================================================

async function startMerge() {
    if (WS.merging) return;
    const chainSteps = _buildRecipeChain();
    if (!chainSteps.length) {
        if (window.showToast) window.showToast(_t("workshop.toast.nothingToDo", "Nothing to do — fill at least one row, or add a LoRA / VAE"), "warning");
        return;
    }

    // One simple merge step → use the direct merge endpoint.
    if (chainSteps.length === 1 && chainSteps[0].type === "merge"
        && _isConcreteModel(WS.rows[0].primary) && _isConcreteModel(WS.rows[0].secondary)) {
        const body = _buildMergeBody();
        body.output_name = WS.outputName || null;
        body.save_fp16 = WS.saveFp16;
        body.output_dtype = _wsOutputDtype();
        try {
            WS.merging = true; WS.status = "running"; WS.progress = 0; WS.error = null; WS.result = null;
            _renderProgress(); _setMergeButtonState(true);
            const res = await fetchJSON(API + "/merge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            if (res.ram_estimate?.warning && window.showToast) window.showToast(res.ram_estimate.warning, "warning");
        } catch (e) {
            WS.merging = false; WS.status = "error"; WS.error = e.message; _renderProgress(); _setMergeButtonState(false);
            if (window.showToast) window.showToast(e.message, "error");
        }
        return;
    }

    // Multi-step (or any step using __ON__) — chain endpoint.
    try {
        WS.merging = true; WS.status = "running"; WS.progress = 0; WS.error = null; WS.result = null;
        _renderProgress(); _setMergeButtonState(true);
        if (window.showToast) window.showToast(_t("workshop.toast.runningRecipe", "Running " + chainSteps.length + "-step recipe…", { steps: chainSteps.length }), "info");
        // Re-read the Save Intermediates checkbox right before the
        // request goes out so a programmatic state drift (e.g. a
        // missed change event from a keyboard toggle) can't push
        // stale truthiness onto the backend. Explicit boolean so
        // the JSON body is always either true or false, never
        // undefined.
        const siChecked = !!(_els.saveIntermediates && _els.saveIntermediates.checked);
        WS.saveIntermediates = siChecked;
        // Send a snapshot of the merge board alongside the step list
        // so the journal entry can faithfully round-trip back into
        // the board via "Import Recipe". The step list alone loses
        // row references (model_a/b end up as their resolved
        // filenames after _resolve_variable), so without the
        // snapshot a multi-row chain restores as disconnected rows.
        const board = _buildBoardSnapshot();
        await fetchJSON(API + "/chain", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                steps: chainSteps,
                save_intermediates: siChecked,
                workshop_board: board,
            }),
        });
    } catch (e) {
        WS.merging = false; WS.status = "error"; WS.error = e.message; _renderProgress(); _setMergeButtonState(false);
        if (window.showToast) window.showToast(e.message, "error");
    }
}

async function testMerge() {
    if (!_canTestMerge()) return;
    const body = _buildMergeBody();
    try {
        WS.testMerging = true; _els.testMergeBtn.disabled = true; _els.testMergeBtn.textContent = _t("workshop.action.merging", "Merging…");
        if (window.showToast) window.showToast(_t("workshop.toast.computingMerge", "Computing in-memory merge…"), "info");
        const res = await fetchJSON(API + "/merge_memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        WS.memoryMergeActive = true; _renderMemoryStatus(res);
        if (res.validation?.passed) { if (window.showToast) window.showToast(_t("workshop.toast.testMergeApplied", "Test merge applied in " + res.total_time + "s — generate to preview!", { time: res.total_time }), "success"); }
        else { if (window.showToast) window.showToast(_t("workshop.toast.testMergeWarnings", "Test merge applied but validation had warnings"), "warning"); }
        if (res.non_unet_warning && window.showToast) window.showToast(res.non_unet_warning, "info");
    } catch (e) { WS.memoryMergeActive = false; if (window.showToast) window.showToast(_t("workshop.toast.testMergeFailed", "Test merge failed: " + e.message, { error: e.message }), "error"); }
    finally { WS.testMerging = false; _els.testMergeBtn.textContent = _t("workshop.action.testMerge", "Test Merge"); _updateActionButtons(); }
}

async function revertMerge() {
    try {
        _els.revertBtn.disabled = true; _els.revertBtn.textContent = _t("workshop.action.reverting", "Reverting…");
        const res = await fetchJSON(API + "/revert", { method: "POST" });
        WS.memoryMergeActive = false; _els.memoryStatus.style.display = "none"; _updateActionButtons();
        if (window.showToast) window.showToast(_t("workshop.toast.reverted", "Reverted in " + res.elapsed + "s", { elapsed: res.elapsed }), "success");
    } catch (e) { if (window.showToast) window.showToast(_t("workshop.toast.revertFailed", "Revert failed: " + e.message, { error: e.message }), "error"); }
    finally { _els.revertBtn.disabled = false; _els.revertBtn.textContent = _t("workshop.action.revert", "Revert"); }
}

async function cancelMerge() { try { await fetchJSON(API + "/cancel", { method: "POST" }); } catch (e) { console.error(TAG, "Cancel failed:", e); } }

function _renderMemoryStatus(res) {
    _els.memoryStatus.style.display = "";
    _els.memoryInfo.textContent = res ? res.keys_loaded + " keys swapped in " + res.total_time + "s" : "";
    _updateActionButtons();
}

// ========================================================================
// RECIPE — LORA LIST (global)
// ========================================================================

function _addRecipeLora() {
    WS.recipeLoras.push({ filename: null, strength: 1.0 });
    _renderRecipeLoras();
    _updateActionButtons();
}

function _removeRecipeLora(idx) {
    WS.recipeLoras.splice(idx, 1);
    _renderRecipeLoras();
    _updateActionButtons();
}

function _getLoraOpts() {
    return '<option value="">— Select LoRA —</option>' + WS.loras.map(l => '<option value="' + _esc(l.filename) + '">' + _esc(l.filename) + '</option>').join("");
}

function _renderRecipeLoras() {
    if (!_els.loraList) return;
    let html = '';
    for (let i = 0; i < WS.recipeLoras.length; i++) {
        const l = WS.recipeLoras[i];
        html += '<div class="ws-lora-row" data-idx="' + i + '">'
            + '<div class="ws-lora-row-top">'
            + '<select class="param-select ws-model-select ws-rl-lora" data-idx="' + i + '">' + _getLoraOpts() + '</select>'
            + '<button class="ws-lora-remove-btn ws-rl-remove" data-idx="' + i + '" title="Remove">×</button>'
            + '</div>'
            + '<div class="ws-lora-row-bottom">'
            + '<span class="ws-lora-strength-label">Strength</span>'
            + '<input type="range" min="-2" max="2" step="0.05" value="' + l.strength + '" class="ws-slider ws-rl-strength" data-idx="' + i + '">'
            + '<input type="number" min="-2" max="2" step="0.05" value="' + l.strength.toFixed(2) + '" class="param-val ws-alpha-input ws-rl-strength-val" data-idx="' + i + '">'
            + '</div></div>';
    }
    _els.loraList.innerHTML = html;
    _bindLoraEvents();
}

function _bindLoraEvents() {
    _els.loraList.querySelectorAll(".ws-rl-lora").forEach(sel => {
        const idx = parseInt(sel.dataset.idx);
        if (WS.recipeLoras[idx]?.filename) sel.value = WS.recipeLoras[idx].filename;
        sel.addEventListener("change", () => { WS.recipeLoras[idx].filename = sel.value || null; _updateActionButtons(); });
        if (window.StudioSearchableSelect) {
            window.StudioSearchableSelect.attach(sel, { placeholder: "— Select LoRA —", searchPlaceholder: "Filter LoRAs…" });
        }
    });
    _els.loraList.querySelectorAll(".ws-rl-strength").forEach(slider => {
        const idx = parseInt(slider.dataset.idx);
        const valEl = _els.loraList.querySelector('.ws-rl-strength-val[data-idx="' + idx + '"]');
        slider.addEventListener("input", () => { WS.recipeLoras[idx].strength = parseFloat(slider.value); if (valEl) valEl.value = parseFloat(slider.value).toFixed(2); });
        if (valEl) valEl.addEventListener("change", () => { let v = parseFloat(valEl.value); if (isNaN(v)) v = 1; v = Math.max(-2, Math.min(2, v)); WS.recipeLoras[idx].strength = v; slider.value = v; valEl.value = v.toFixed(2); });
    });
    _els.loraList.querySelectorAll(".ws-rl-remove").forEach(btn => {
        btn.addEventListener("click", () => _removeRecipeLora(parseInt(btn.dataset.idx)));
    });
}

// ========================================================================
// JOURNAL — backend writes per-step entries; renderer handles old + new
// shape (old single-merge had model_a/model_b, new chain steps have the
// same shape per step).
// ========================================================================

async function _loadJournal() {
    try {
        WS.journalEntries = await fetchJSON(API + "/journal");
        _renderJournal();
    } catch (e) { console.error(TAG, "Journal load failed:", e); }
}

async function _addManualJournalEntry() {
    const entry = {
        id: "manual_" + Date.now(),
        name: "New Entry",
        type: "note",
        recipe: {},
        date: new Date().toISOString(),
        elapsed: 0,
        rating: 0,
        notes: "",
        image: null,
    };
    try {
        await fetchJSON(API + "/journal/add", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(entry),
        });
        WS.journalEntries.unshift(entry);
        WS.journalExpanded = entry.id;
        _renderJournal();
    } catch (e) { console.error(TAG, "Add entry failed:", e); }
}

// Pretty type label for cards / overlay header.
const _TYPE_LABEL = {
    merge: "Merge", chain: "Chain",
    lora_bake: "LoRA Bake", vae_bake: "VAE Bake",
    note: "Note",
};

// Build the at-a-glance recipe summary shown on the card thumb.
function _cardRecipeSummary(e) {
    const recipe = e.recipe || {};
    if (e.type === "chain" || recipe.type === "chain") {
        const steps = recipe.steps || [];
        const methods = steps.map(s => s.method).filter(Boolean);
        const head = methods.slice(0, 3).join(" → ");
        const tail = methods.length > 3 ? " (+" + (methods.length - 3) + " more)" : "";
        return '<div class="ws-history-card-recipe">'
            + '<div class="ws-history-card-recipe-line"><strong>' + steps.length + ' steps</strong></div>'
            + (methods.length ? '<div class="ws-history-card-method">' + _esc(head + tail) + '</div>' : '')
            + '</div>';
    }
    if (e.type === "merge" || recipe.method) {
        const a = recipe.model_a || "—";
        const b = recipe.model_b || "—";
        const method = recipe.method ? _esc(recipe.method) : "";
        const alpha = recipe.alpha !== undefined ? Number(recipe.alpha).toFixed(2) : null;
        return '<div class="ws-history-card-recipe">'
            + '<div class="ws-history-card-recipe-line">' + _esc(a) + '</div>'
            + '<div class="ws-history-card-arrow">↓</div>'
            + '<div class="ws-history-card-recipe-line">' + _esc(b) + '</div>'
            + (method ? '<div class="ws-history-card-method">' + method + (alpha ? " @ " + alpha : "") + '</div>' : '')
            + '</div>';
    }
    if (e.type === "lora_bake") {
        const ckpt = recipe.checkpoint || "—";
        const n = (recipe.loras || []).length;
        return '<div class="ws-history-card-recipe">'
            + '<div class="ws-history-card-recipe-line">' + _esc(ckpt) + '</div>'
            + '<div class="ws-history-card-method">+ ' + n + ' LoRA' + (n === 1 ? "" : "s") + '</div>'
            + '</div>';
    }
    if (e.type === "vae_bake") {
        const ckpt = recipe.checkpoint || "—";
        const v = recipe.vae || "—";
        return '<div class="ws-history-card-recipe">'
            + '<div class="ws-history-card-recipe-line">' + _esc(ckpt) + '</div>'
            + '<div class="ws-history-card-method">+ VAE: ' + _esc(v) + '</div>'
            + '</div>';
    }
    if (e.type === "note") {
        const preview = (e.notes || "").slice(0, 80);
        return '<div class="ws-history-card-recipe"><div class="ws-history-card-method ws-history-card-note-preview">'
            + (preview ? _esc(preview) + (e.notes.length > 80 ? "…" : "") : "<em>No notes yet</em>")
            + '</div></div>';
    }
    return '<div class="ws-history-card-recipe"></div>';
}

// Return the saved-on-disk model filename a journal entry points at,
// or null if there's nothing importable. Importable means: the
// filename exists in the current WS.models list (i.e. the file is
// still on disk and the user's model browser can see it).
//
// For normal merge / lora_bake / vae_bake entries, that's just
// entry.name. For chain entries (save_intermediates=off), entry.name
// is the final output the chain landed on; the intermediate step
// filenames live in entry.recipe.steps and intentionally don't get
// surfaced for import because the files behind them are deleted.
// For everything else (note entries, unknown types, missing name)
// the helper returns null so the import UI can hide itself.
// True when a journal entry carries enough recipe data to restore
// something meaningful onto the merge board. Drives whether the
// "Import Recipe" action appears on the card and detail surfaces.
function _journalEntryIsImportable(entry) {
    if (!entry) return false;
    if (entry.type === "note") return false;
    const r = entry.recipe || {};
    // Preferred shape — the chain pipeline now stores a faithful
    // board snapshot alongside the per-step summary.
    if (r.workshop_board && Array.isArray(r.workshop_board.rows)) return true;
    // Older chain entries still carry a per-step summary we can
    // partially reconstruct from.
    if ((r.type === "chain" || entry.type === "chain") && Array.isArray(r.steps) && r.steps.length) return true;
    // Single bake entries.
    if (r.operation === "lora_bake" || r.operation === "vae_bake") return true;
    // Single merge — at minimum a method + the two source models.
    if (r.method && r.model_a && r.model_b) return true;
    return false;
}

// Render the single "Import Recipe" action for an importable
// journal entry. Used on both card and detail surfaces; size is
// driven by a CSS variant class so the two layouts stay distinct
// without separate templates. Returns "" when the entry has no
// importable recipe data so the import row collapses cleanly.
function _importActionsHtml(entry, where) {
    if (!_journalEntryIsImportable(entry)) return "";
    const id = _esc(entry.id);
    const wherePart = where === "card" ? " ws-je-import-card" : " ws-je-import-detail";
    return '<div class="ws-je-section ws-je-import' + wherePart + '">'
        + '<div class="ws-je-import-row">'
        + '<button class="ws-je-import-btn ws-je-import-primary" data-action="importRecipe" data-id="' + id + '">Import Recipe</button>'
        + '</div>'
        + '</div>';
}

// ---- Recipe importer -------------------------------------------------
//
// Replace the current merge board with the recipe a journal entry
// represents. The handoff specifies "replaces the current board"; we
// don't attempt to merge into the existing rows, and we don't run the
// recipe automatically.
//
// Restore order of preference:
//   1. recipe.workshop_board — full-fidelity snapshot the frontend
//      now ships with /chain calls.
//   2. recipe.type === "chain" (or entry.type === "chain") — older
//      chains: reconstruct from the per-step summary. Refs are lost
//      so multi-row chains restore as a sequence of disconnected
//      rows but Method / alpha / block weights survive.
//   3. recipe.operation === "lora_bake" / "vae_bake" — single bake
//      entry. Becomes a one-row bake-only board.
//   4. recipe.method / model_a / model_b — single /merge entry.
//      Becomes one merge row.
//
// Missing assets (model / LoRA / VAE filenames not present in
// WS.models / WS.loras / WS.vaes after one refresh) are blanked out
// of the imported state instead of blocking the import. A summary
// toast tells the user how many references couldn't be matched.

async function _importJournalRecipe(entry) {
    if (!entry || !_journalEntryIsImportable(entry)) return;

    // Refresh the asset lists once before deciding something is
    // missing. Covers the common case of an entry referencing a
    // freshly-merged file that hasn't been picked up by the disk
    // scanner yet.
    try {
        await Promise.all([loadModels(), loadLoras(), loadVaes()]);
    } catch (_) { /* fall through — caller's compare handles gaps */ }

    const r = entry.recipe || {};
    let restored;
    if (r.workshop_board && Array.isArray(r.workshop_board.rows)) {
        restored = _restoreFromBoardSnapshot(r.workshop_board);
    } else if (r.type === "chain" || entry.type === "chain") {
        restored = _restoreFromChainSteps(r.steps || []);
    } else if (r.operation === "lora_bake") {
        restored = _restoreFromLoraBake(r);
    } else if (r.operation === "vae_bake") {
        restored = _restoreFromVaeBake(r);
    } else if (r.method && r.model_a && r.model_b) {
        restored = _restoreFromSingleMerge(r);
    } else {
        return;
    }
    if (!restored || !restored.rows || !restored.rows.length) return;

    // Apply to WS state. We replace the row stack outright; the
    // board-replace behavior is the chosen UX per the handoff.
    WS.rows = restored.rows;
    WS.activeRow = 0;
    WS.recipeLoras = restored.recipeLoras.length
        ? restored.recipeLoras
        : [{ filename: null, strength: 1.0 }];   // keep one empty row visible
    WS.recipeVae = restored.recipeVae || null;
    WS.outputName = restored.outputName || "";
    WS.saveFp16 = restored.saveFp16 !== undefined ? !!restored.saveFp16 : true;
    WS.outputDtype = restored.outputDtype || "auto";
    WS.saveIntermediates = !!restored.saveIntermediates;
    WS.compatibility = null;
    WS.healthScan = null;

    // Sync the global control DOM that lives outside _renderRows().
    if (_els.outputName) _els.outputName.value = WS.outputName;
    if (_els.fp16) _els.fp16.checked = WS.saveFp16;
    if (_els.outputDtype) _els.outputDtype.value = WS.outputDtype;
    if (_els.saveIntermediates) _els.saveIntermediates.checked = WS.saveIntermediates;

    _renderRows();
    _renderRecipeLoras();
    _populateGlobalVaeSelect();
    _setActiveRow(0);

    const firstRow = WS.rows[0];
    if (firstRow) {
        inspectModel(_isConcreteModel(firstRow.primary) ? firstRow.primary : null, "A");
        inspectModel(_isConcreteModel(firstRow.secondary) ? firstRow.secondary : null, "B");
    }
    runPreflight();
    runCompatibility();
    _updateActionButtons();
    _recomputeFinalRowOutputName();

    // Surface a summary. The recipe restoration helpers track how
    // many referenced files couldn't be matched against the current
    // asset lists; report that count so the user knows why fields
    // are blank.
    const missing = restored.missingCount | 0;
    if (window.showToast) {
        const msg = missing
            ? "Recipe imported with " + missing + " missing asset" + (missing === 1 ? "" : "s")
            : "Recipe imported";
        window.showToast(msg, missing ? "warning" : "success");
    }

    // Move the user to the Recipe tab so the imported state is
    // immediately visible. _els.tabs is a NodeList (querySelectorAll)
    // so spread into an array before .find — NodeList.find isn't
    // available everywhere. Falls back gracefully if the tab DOM
    // shape changes.
    const tabs = _els.tabs ? Array.from(_els.tabs) : [];
    const recipeTab = tabs.find(t => t.dataset && t.dataset.tab === "recipe");
    if (recipeTab) recipeTab.click();

    _closeHistoryDetail();
}

// ---- Recipe restoration helpers --------------------------------------
//
// Each helper returns
//   { rows, recipeLoras, recipeVae, outputName, saveFp16,
//     saveIntermediates, missingCount }
// where rows is a fresh _newRow()-shaped array. The caller swaps
// these onto WS verbatim.

function _isKnownModel(filename) {
    return !!(filename && WS.models.some(m => m.filename === filename));
}
function _isKnownLora(filename) {
    return !!(filename && WS.loras.some(l => l.filename === filename));
}
function _isKnownVae(filename) {
    return !!(filename && WS.vaes.some(v => v.filename === filename));
}

function _resolveModelOrNull(filename, missing) {
    if (!filename) return null;
    if (_isKnownModel(filename)) return filename;
    missing.count += 1;
    return null;
}
function _resolveLoraEntries(loras, missing) {
    if (!Array.isArray(loras)) return [];
    const out = [];
    for (const l of loras) {
        if (!l || !l.filename) continue;
        if (_isKnownLora(l.filename)) {
            out.push({ filename: l.filename, strength: typeof l.strength === "number" ? l.strength : 1.0 });
        } else {
            missing.count += 1;
        }
    }
    return out;
}
function _resolveVaeOrNull(filename, missing) {
    if (!filename) return null;
    if (_isKnownVae(filename)) return filename;
    missing.count += 1;
    return null;
}

function _restoreFromBoardSnapshot(board) {
    const missing = { count: 0 };
    const rows = (board.rows || []).map(snap => {
        const row = _newRow();
        row.primary   = _resolveModelOrNull(snap.primary, missing);
        row.secondary = _resolveModelOrNull(snap.secondary, missing);
        row.tertiary  = _resolveModelOrNull(snap.tertiary, missing);
        if (snap.method) row.method = snap.method;
        if (typeof snap.alpha === "number") row.alpha = snap.alpha;
        if (typeof snap.density === "number") row.density = snap.density;
        if (typeof snap.dropRate === "number") row.dropRate = snap.dropRate;
        if (typeof snap.cosineShift === "number") row.cosineShift = snap.cosineShift;
        if (typeof snap.eta === "number") row.eta = snap.eta;
        row.useBlockWeights = !!snap.useBlockWeights;
        row.blockWeights = snap.blockWeights || null;
        row.bakeVae = !!snap.bakeVae;
        row.vae = snap.bakeVae ? _resolveVaeOrNull(snap.vae, missing) : (snap.vae || null);
        if (!row.vae && snap.bakeVae && snap.vae) row.bakeVae = false;
        row.outputName = snap.outputName || "";
        return row;
    });
    return {
        rows: rows.length ? rows : [_newRow()],
        recipeLoras: _resolveLoraEntries(board.recipeLoras, missing),
        recipeVae: _resolveVaeOrNull(board.recipeVae, missing),
        outputName: board.outputName || "",
        saveFp16: board.saveFp16 !== undefined ? !!board.saveFp16 : true,
        outputDtype: board.outputDtype || "auto",
        saveIntermediates: !!board.saveIntermediates,
        missingCount: missing.count,
    };
}

function _restoreFromSingleMerge(recipe) {
    const missing = { count: 0 };
    const row = _newRow();
    row.primary   = _resolveModelOrNull(recipe.model_a, missing);
    row.secondary = _resolveModelOrNull(recipe.model_b, missing);
    if (recipe.model_c) row.tertiary = _resolveModelOrNull(recipe.model_c, missing);
    if (recipe.method) row.method = recipe.method;
    if (typeof recipe.alpha === "number") row.alpha = recipe.alpha;
    if (typeof recipe.density === "number") row.density = recipe.density;
    if (typeof recipe.drop_rate === "number") row.dropRate = recipe.drop_rate;
    if (typeof recipe.cosine_shift === "number") row.cosineShift = recipe.cosine_shift;
    if (typeof recipe.eta === "number") row.eta = recipe.eta;
    row.blockWeights = recipe.block_weights || null;
    row.useBlockWeights = !!recipe.block_weights;
    return {
        rows: [row],
        recipeLoras: [],
        recipeVae: null,
        outputName: "",
        saveFp16: recipe.fp16 !== undefined ? !!recipe.fp16 : true,
        outputDtype: recipe.output_dtype_requested || recipe.output_dtype || "auto",
        saveIntermediates: false,
        missingCount: missing.count,
    };
}

function _restoreFromLoraBake(recipe) {
    const missing = { count: 0 };
    const row = _newRow();
    row.primary = _resolveModelOrNull(recipe.checkpoint, missing);
    return {
        rows: [row],
        recipeLoras: _resolveLoraEntries(recipe.loras, missing),
        recipeVae: null,
        outputName: "",
        saveFp16: recipe.fp16 !== undefined ? !!recipe.fp16 : true,
        outputDtype: recipe.output_dtype_requested || recipe.output_dtype || "auto",
        saveIntermediates: false,
        missingCount: missing.count,
    };
}

function _restoreFromVaeBake(recipe) {
    const missing = { count: 0 };
    const row = _newRow();
    row.primary = _resolveModelOrNull(recipe.checkpoint, missing);
    return {
        rows: [row],
        recipeLoras: [],
        recipeVae: _resolveVaeOrNull(recipe.vae, missing),
        outputName: "",
        saveFp16: recipe.fp16 !== undefined ? !!recipe.fp16 : true,
        outputDtype: recipe.output_dtype_requested || recipe.output_dtype || "auto",
        saveIntermediates: false,
        missingCount: missing.count,
    };
}

// Fallback path for chain entries that pre-date workshop_board.
// Walks the per-step summary in best-effort order: merge steps
// become rows, a vae_bake step that immediately follows a merge
// becomes that row's per-row bake, lora_bake / vae_bake landing at
// the end of the chain restore as the global recipeLoras /
// recipeVae. Row references (model_a/b stored as resolved
// filenames) are lost — there's no way to tell whether a step's
// model_a was originally __O1__ vs the literal merged file. We
// leave those as the resolved filename and the user can re-wire
// from the dropdowns if they care.
function _restoreFromChainSteps(steps) {
    const missing = { count: 0 };
    const rows = [];
    const recipeLoras = [];
    let recipeVae = null;
    let outputName = "";
    let saveFp16 = true;
    let outputDtype = "auto";
    const stepsLen = steps.length;

    // First pass: build a quick index of step → step type so we can
    // decide whether a vae_bake belongs to the row above it or to
    // the global recipe (when it's the last step).
    for (let i = 0; i < stepsLen; i++) {
        const s = steps[i];
        if (!s) continue;
        if (s.fp16 !== undefined) saveFp16 = !!s.fp16;
        if (s.output_dtype_requested) outputDtype = s.output_dtype_requested;
        else if (s.output_dtype) outputDtype = s.output_dtype;
        if (s.type === "merge") {
            const row = _newRow();
            row.primary   = _resolveModelOrNull(s.model_a, missing);
            row.secondary = _resolveModelOrNull(s.model_b, missing);
            if (s.model_c) row.tertiary = _resolveModelOrNull(s.model_c, missing);
            if (s.method) row.method = s.method;
            if (typeof s.alpha === "number") row.alpha = s.alpha;
            if (typeof s.density === "number") row.density = s.density;
            if (typeof s.drop_rate === "number") row.dropRate = s.drop_rate;
            if (typeof s.cosine_shift === "number") row.cosineShift = s.cosine_shift;
            if (typeof s.eta === "number") row.eta = s.eta;
            row.blockWeights = s.block_weights || null;
            row.useBlockWeights = !!s.block_weights;
            // Step-level output_name lives on the row when keep-
            // intermediates was on at chain time. The flag itself
            // isn't preserved in the step summary; the caller
            // restores it as false (safest default).
            if (s.output_name) row.outputName = s.output_name;
            rows.push(row);
        } else if (s.type === "vae_bake") {
            // Attach to the immediately preceding merge row when one
            // exists AND this isn't the chain's final step. The
            // final step's vae_bake is the global recipeVae.
            const isFinal = i === stepsLen - 1;
            const prevWasMerge = i > 0 && steps[i - 1] && steps[i - 1].type === "merge";
            if (!isFinal && prevWasMerge && rows.length) {
                const row = rows[rows.length - 1];
                row.bakeVae = true;
                row.vae = _resolveVaeOrNull(s.vae, missing);
                if (!row.vae) row.bakeVae = false;
            } else {
                recipeVae = _resolveVaeOrNull(s.vae, missing);
            }
        } else if (s.type === "lora_bake") {
            const isFinal = i === stepsLen - 1
                || (i === stepsLen - 2 && steps[stepsLen - 1] && steps[stepsLen - 1].type === "vae_bake");
            if (isFinal) {
                for (const item of _resolveLoraEntries(s.loras, missing)) {
                    recipeLoras.push(item);
                }
            } else {
                // Mid-chain lora_bake — we can't represent that on
                // the board's global recipe surface today. Count
                // each LoRA as a missing reference so the user is
                // told their bake step couldn't be restored.
                missing.count += Array.isArray(s.loras) ? s.loras.length : 1;
            }
        }
        // Unknown step types fall through; the per-step summary will
        // still be visible in the detail panel even if we can't
        // restore them.

        // Carry forward an output_name on the chain's final step as
        // the global output name (matches how _buildRecipeChain
        // assigns it).
        if (i === stepsLen - 1 && s.output_name) outputName = s.output_name;
    }

    return {
        rows: rows.length ? rows : [_newRow()],
        recipeLoras,
        recipeVae,
        outputName,
        saveFp16,
        outputDtype,
        saveIntermediates: false,
        missingCount: missing.count,
    };
}

function _renderJournal() {
    let entries = WS.journalEntries;
    const search = WS.journalSearch.toLowerCase();
    const filter = WS.journalFilter;

    if (search) {
        entries = entries.filter(e =>
            (e.name || "").toLowerCase().includes(search) ||
            (e.notes || "").toLowerCase().includes(search) ||
            (e.type || "").toLowerCase().includes(search) ||
            JSON.stringify(e.recipe || {}).toLowerCase().includes(search)
        );
    }
    if (filter && filter !== "all") {
        entries = entries.filter(e => e.type === filter);
    }

    if (!entries.length) {
        _els.journalList.innerHTML = '<div class="ws-info-placeholder" style="padding:32px 0;">'
            + (WS.journalEntries.length ? 'No matches for current filter' : 'No history yet — completed merges and bakes will appear here automatically')
            + '</div>';
        _renderHistoryDetail();
        return;
    }

    let html = '<div class="ws-history-grid">';
    for (const e of entries.slice(0, 200)) {
        const typeKey = e.type || "unknown";
        const typeLabel = _TYPE_LABEL[typeKey] || typeKey;
        const date = e.date ? new Date(e.date).toLocaleDateString() : "";
        const elapsed = e.elapsed ? e.elapsed + "s" : "";

        let starsHtml = '';
        for (let s = 1; s <= 5; s++) {
            const filled = s <= (e.rating || 0);
            starsHtml += '<span class="ws-journal-star' + (filled ? ' ws-star-filled' : '') + '" data-id="' + _esc(e.id) + '" data-rating="' + s + '">★</span>';
        }

        // When the entry carries an attached sample image, show the
        // image as the thumbnail body. Otherwise fall back to the
        // text-based recipe summary.
        const thumbBody = e.image
            ? '<img src="' + API + '/journal/image/' + _esc(e.image) + '" loading="lazy" class="ws-history-card-image" alt="">'
            : _cardRecipeSummary(e);

        html += '<div class="ws-history-card' + (e.image ? ' ws-history-card-has-image' : '') + '" data-id="' + _esc(e.id) + '">'
            + '<div class="ws-history-card-thumb">'
            + '<div class="ws-history-card-top">'
            + '<span class="ws-journal-type-badge ws-jt-' + _esc(typeKey) + '">' + _esc(typeLabel) + '</span>'
            + '<span class="ws-history-card-stars">' + starsHtml + '</span>'
            + '</div>'
            + thumbBody
            + '</div>'
            + '<div class="ws-history-card-info">'
            + '<div class="ws-history-card-filename" title="' + _esc(e.name || "") + '">' + _esc(e.name || "Untitled") + '</div>'
            + '<div class="ws-history-card-date">' + _esc(date) + (elapsed ? ' · ' + _esc(elapsed) : '') + '</div>'
            + _importActionsHtml(e, "card")
            + '</div>'
            + '</div>';
    }
    html += '</div>';

    _els.journalList.innerHTML = html;
    _renderHistoryDetail();
    _bindJournalEvents();
}

function _recipeRowsHtml(recipe, elapsed) {
    let html = '';
    if (recipe.method) html += '<div class="ws-je-recipe-row"><span>Method</span><span>' + _esc(recipe.method) + '</span></div>';
    if (recipe.alpha !== undefined) html += '<div class="ws-je-recipe-row"><span>Alpha</span><span>' + recipe.alpha + '</span></div>';
    if (recipe.model_a) html += '<div class="ws-je-recipe-row"><span>Model A</span><span>' + _esc(recipe.model_a) + '</span></div>';
    if (recipe.model_b) html += '<div class="ws-je-recipe-row"><span>Model B</span><span>' + _esc(recipe.model_b) + '</span></div>';
    if (recipe.model_c) html += '<div class="ws-je-recipe-row"><span>Model C</span><span>' + _esc(recipe.model_c) + '</span></div>';
    if (recipe.checkpoint) html += '<div class="ws-je-recipe-row"><span>Checkpoint</span><span>' + _esc(recipe.checkpoint) + '</span></div>';
    if (recipe.loras) { for (const l of recipe.loras) { html += '<div class="ws-je-recipe-row"><span>LoRA</span><span>' + _esc(l.filename) + ' @ ' + l.strength + '</span></div>'; } }
    if (recipe.vae) html += '<div class="ws-je-recipe-row"><span>VAE</span><span>' + _esc(recipe.vae) + '</span></div>';
    if (recipe.output_dtype) html += '<div class="ws-je-recipe-row"><span>Output dtype</span><span>' + String(recipe.output_dtype).toUpperCase() + '</span></div>';
    else if (recipe.fp16 !== undefined) html += '<div class="ws-je-recipe-row"><span>fp16</span><span>' + (recipe.fp16 ? "Yes" : "No") + '</span></div>';
    if (elapsed) html += '<div class="ws-je-recipe-row"><span>Time</span><span>' + elapsed + '</span></div>';
    return html;
}

// Render the detail overlay for the currently expanded entry, or
// remove it if nothing is expanded. Mounted as a sibling of
// journalList so the overlay can sit fixed over the whole viewport.
function _renderHistoryDetail() {
    const host = _els.journalList?.parentElement;
    if (!host) return;
    let overlay = host.querySelector(".ws-history-detail");
    const id = WS.journalExpanded;
    if (!id) {
        if (overlay) overlay.remove();
        return;
    }
    const e = WS.journalEntries.find(en => en.id === id);
    if (!e) {
        if (overlay) overlay.remove();
        WS.journalExpanded = null;
        return;
    }
    if (!overlay) {
        overlay = document.createElement("div");
        overlay.className = "ws-history-detail";
        host.appendChild(overlay);
    }

    const typeKey = e.type || "unknown";
    const typeLabel = _TYPE_LABEL[typeKey] || typeKey;
    const elapsed = e.elapsed ? e.elapsed + "s" : "";

    let recipeHtml = '';
    const recipe = e.recipe || {};
    if (e.type === "chain" || recipe.type === "chain") {
        const steps = recipe.steps || [];
        recipeHtml += '<div class="ws-je-section"><div class="ws-je-section-label">Chain (' + steps.length + ' step' + (steps.length === 1 ? '' : 's') + ')</div>';
        for (let i = 0; i < steps.length; i++) {
            const s = steps[i];
            const sLabel = _TYPE_LABEL[s.type] || s.type || "step";
            recipeHtml += '<div class="ws-je-step">'
                + '<div class="ws-je-step-header">Step ' + (s.step || (i + 1)) + ' · ' + _esc(sLabel) + '</div>'
                + '<div class="ws-je-recipe">' + _recipeRowsHtml(s, null) + '</div>'
                + '</div>';
        }
        recipeHtml += '</div>';
    } else if (Object.keys(recipe).length > 0) {
        recipeHtml = '<div class="ws-je-section"><div class="ws-je-section-label">Recipe</div>'
            + '<div class="ws-je-recipe">' + _recipeRowsHtml(recipe, elapsed) + '</div></div>';
    }

    let starsHtml = '';
    for (let s = 1; s <= 5; s++) {
        const filled = s <= (e.rating || 0);
        starsHtml += '<span class="ws-journal-star ws-history-detail-star' + (filled ? ' ws-star-filled' : '') + '" data-id="' + _esc(e.id) + '" data-rating="' + s + '">★</span>';
    }

    let imageHtml = '';
    if (e.image) {
        imageHtml = '<img src="' + API + '/journal/image/' + _esc(e.image) + '" class="ws-je-image">'
            + '<button class="ws-je-image-remove" data-id="' + _esc(e.id) + '">Remove</button>';
    } else {
        imageHtml = '<div class="ws-je-image-drop" data-id="' + _esc(e.id) + '">Drop image here or <label class="ws-je-image-browse">browse<input type="file" accept="image/*" class="ws-je-image-input" data-id="' + _esc(e.id) + '" style="display:none;"></label></div>';
    }

    overlay.innerHTML = '<div class="ws-history-detail-panel" data-id="' + _esc(e.id) + '">'
        + '<div class="ws-history-detail-header">'
        + '<span class="ws-journal-type-badge ws-jt-' + _esc(typeKey) + '">' + _esc(typeLabel) + '</span>'
        + '<input type="text" class="ws-je-name-input ws-history-detail-name" data-id="' + _esc(e.id) + '" value="' + _esc(e.name || '') + '" placeholder="Entry name">'
        + '<button class="ws-history-detail-close" title="Close">×</button>'
        + '</div>'
        + '<div class="ws-history-detail-body">'
        + '<div class="ws-je-section ws-history-detail-meta">'
        + '<span class="ws-history-detail-stars">' + starsHtml + '</span>'
        + (e.date ? '<span class="ws-history-detail-date">' + _esc(new Date(e.date).toLocaleString()) + '</span>' : '')
        + (elapsed ? '<span class="ws-history-detail-elapsed">' + _esc(elapsed) + '</span>' : '')
        + '</div>'
        + recipeHtml
        + '<div class="ws-je-section"><div class="ws-je-section-label">Notes</div>'
        + '<textarea class="ws-je-notes" data-id="' + _esc(e.id) + '" rows="4" placeholder="Add notes, observations, tested prompts...">' + _esc(e.notes || '') + '</textarea>'
        + '</div>'
        + '<div class="ws-je-section"><div class="ws-je-section-label">Sample Image</div>'
        + '<div class="ws-je-image-area" data-id="' + _esc(e.id) + '">' + imageHtml + '</div>'
        + '</div>'
        + _importActionsHtml(e, "detail")
        + '<div class="ws-je-actions">'
        + '<button class="ws-je-action-btn ws-je-delete" data-id="' + _esc(e.id) + '">Delete</button>'
        + '</div>'
        + '</div>'
        + '</div>';

    _bindHistoryDetailEvents();
}

function _closeHistoryDetail() {
    if (WS.journalExpanded === null) return;
    WS.journalExpanded = null;
    _renderHistoryDetail();
}

function _bindJournalEvents() {
    const host = _els.journalList?.parentElement;

    // Card click → open detail overlay (ignore clicks on stars and
    // the import-action pill row — those have their own handlers
    // below and shouldn't also pop the overlay open underneath).
    _els.journalList.querySelectorAll(".ws-history-card").forEach(card => {
        card.addEventListener("click", (ev) => {
            if (ev.target.classList.contains("ws-journal-star")) return;
            if (ev.target.closest(".ws-je-import")) return;
            const id = card.dataset.id;
            WS.journalExpanded = id;
            _renderHistoryDetail();
        });
    });

    // Star clicks on cards (set rating without opening overlay)
    _els.journalList.querySelectorAll(".ws-journal-star").forEach(el => {
        el.addEventListener("click", async (ev) => {
            ev.stopPropagation();
            const id = el.dataset.id;
            const rating = parseInt(el.dataset.rating);
            const entry = WS.journalEntries.find(e => e.id === id);
            if (!entry) return;
            const newRating = entry.rating === rating ? rating - 1 : rating;
            try {
                await fetchJSON(API + "/journal/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, rating: newRating }) });
                entry.rating = newRating;
                _renderJournal();
            } catch (e) { console.error(TAG, "Rating update failed:", e); }
        });
    });

    // Import Recipe button — lives on both the card and the detail
    // surface. Stop propagation so clicking the card-mounted button
    // doesn't also pop the detail overlay open under it. The detail-
    // overlay binding wires its own copy with an extra
    // _closeHistoryDetail() so the user sees the row populate.
    _els.journalList.querySelectorAll(".ws-je-import-btn").forEach(btn => {
        btn.addEventListener("click", async (ev) => {
            ev.stopPropagation();
            if (btn.dataset.action !== "importRecipe") return;
            const id = btn.dataset.id;
            const entry = WS.journalEntries.find(e => e.id === id);
            if (!entry) return;
            await _importJournalRecipe(entry);
        });
    });
}

// Bind events inside the detail overlay (re-bound on every render
// because the overlay innerHTML is replaced).
function _bindHistoryDetailEvents() {
    const host = _els.journalList?.parentElement;
    if (!host) return;
    const overlay = host.querySelector(".ws-history-detail");
    if (!overlay) return;

    // Backdrop click closes (panel itself stops propagation)
    overlay.addEventListener("click", (ev) => {
        if (ev.target === overlay) _closeHistoryDetail();
    });
    const panel = overlay.querySelector(".ws-history-detail-panel");
    if (panel) panel.addEventListener("click", (ev) => ev.stopPropagation());

    const closeBtn = overlay.querySelector(".ws-history-detail-close");
    if (closeBtn) closeBtn.addEventListener("click", _closeHistoryDetail);

    // Star clicks inside the overlay
    overlay.querySelectorAll(".ws-journal-star").forEach(el => {
        el.addEventListener("click", async (ev) => {
            ev.stopPropagation();
            const id = el.dataset.id;
            const rating = parseInt(el.dataset.rating);
            const entry = WS.journalEntries.find(e => e.id === id);
            if (!entry) return;
            const newRating = entry.rating === rating ? rating - 1 : rating;
            try {
                await fetchJSON(API + "/journal/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, rating: newRating }) });
                entry.rating = newRating;
                _renderJournal();
            } catch (e) { console.error(TAG, "Rating update failed:", e); }
        });
    });

    // Name input save on blur
    const nameInput = overlay.querySelector(".ws-je-name-input");
    if (nameInput) {
        nameInput.addEventListener("blur", async () => {
            const id = nameInput.dataset.id;
            const name = nameInput.value.trim();
            const entry = WS.journalEntries.find(e => e.id === id);
            if (!entry || entry.name === name) return;
            try {
                await fetchJSON(API + "/journal/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, name }) });
                entry.name = name;
                _renderJournal();
            } catch (e) { console.error(TAG, "Name save failed:", e); }
        });
    }

    // Notes save on blur
    const notes = overlay.querySelector(".ws-je-notes");
    if (notes) {
        notes.addEventListener("blur", async () => {
            const id = notes.dataset.id;
            const value = notes.value;
            const entry = WS.journalEntries.find(e => e.id === id);
            if (!entry || entry.notes === value) return;
            try {
                await fetchJSON(API + "/journal/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, notes: value }) });
                entry.notes = value;
            } catch (e) { console.error(TAG, "Notes save failed:", e); }
        });
    }

    // Image: file input
    const imageInput = overlay.querySelector(".ws-je-image-input");
    if (imageInput) {
        imageInput.addEventListener("change", (ev) => {
            const file = ev.target.files[0];
            if (!file || !file.type.startsWith("image/")) return;
            const id = imageInput.dataset.id;
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    await fetchJSON(API + "/journal/image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, image: e.target.result }) });
                    await _loadJournal();
                } catch (e) { console.error(TAG, "Image upload failed:", e); }
            };
            reader.readAsDataURL(file);
        });
    }

    // Image: drag/drop
    const drop = overlay.querySelector(".ws-je-image-drop");
    if (drop) {
        drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("ws-je-drag-over"); });
        drop.addEventListener("dragleave", () => drop.classList.remove("ws-je-drag-over"));
        drop.addEventListener("drop", (ev) => {
            ev.preventDefault();
            drop.classList.remove("ws-je-drag-over");
            const file = ev.dataTransfer.files[0];
            if (!file || !file.type.startsWith("image/")) return;
            const id = drop.dataset.id;
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    await fetchJSON(API + "/journal/image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, image: e.target.result }) });
                    await _loadJournal();
                } catch (e) { console.error(TAG, "Image drop failed:", e); }
            };
            reader.readAsDataURL(file);
        });
    }

    // Image: remove
    const removeBtn = overlay.querySelector(".ws-je-image-remove");
    if (removeBtn) {
        removeBtn.addEventListener("click", async () => {
            const id = removeBtn.dataset.id;
            try {
                await fetchJSON(API + "/journal/image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, image: null }) });
                await _loadJournal();
            } catch (e) { console.error(TAG, "Image remove failed:", e); }
        });
    }

    // Delete entry
    const deleteBtn = overlay.querySelector(".ws-je-delete");
    if (deleteBtn) {
        deleteBtn.addEventListener("click", async () => {
            if (!confirm("Delete this entry?")) return;
            const id = deleteBtn.dataset.id;
            try {
                await fetchJSON(API + "/journal/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
                WS.journalEntries = WS.journalEntries.filter(e => e.id !== id);
                WS.journalExpanded = null;
                _renderJournal();
            } catch (e) { console.error(TAG, "Delete failed:", e); }
        });
    }

    // Import Recipe button inside the detail overlay. Same shape as
    // the card-surface wiring in _bindJournalEvents; _importJournal-
    // Recipe itself calls _closeHistoryDetail when it's done so the
    // user lands back on the Recipe tab with the imported board.
    overlay.querySelectorAll(".ws-je-import-btn").forEach(btn => {
        btn.addEventListener("click", async (ev) => {
            ev.stopPropagation();
            if (btn.dataset.action !== "importRecipe") return;
            const id = btn.dataset.id;
            const entry = WS.journalEntries.find(e => e.id === id);
            if (!entry) return;
            await _importJournalRecipe(entry);
        });
    });
}

// ========================================================================
// WEBSOCKET
// ========================================================================

function _handleWsMessage(data) {
    if (data.type !== "workshop_progress") return;
    const rawProgress = data.progress || 0;
    WS.chainStep = data.chain_step || 0;
    WS.chainTotal = data.chain_total || 0;
    // Map per-step progress to monotonic chain-wide progress so the bar
    // doesn't rewind every time a step transitions and the merge func
    // overwrites _merge_state["progress"] with its own per-key 0→1.
    WS.progress = (WS.chainTotal > 1 && WS.chainStep > 0)
        ? ((WS.chainStep - 1) + rawProgress) / WS.chainTotal
        : rawProgress;
    WS.status = data.status || "idle"; WS.error = data.error || null;
    WS.elapsed = data.elapsed || 0; WS.keysDone = data.keys_done || 0; WS.keysTotal = data.keys_total || 0;
    if (data.status === "complete" || data.status === "error" || data.status === "cancelled") {
        WS.merging = false; _setMergeButtonState(false);
        if (data.status === "complete") { if (window.showToast) window.showToast(_t("workshop.toast.complete", "Complete!"), "success"); loadModels(); _loadJournal(); fetch(API + "/refresh_checkpoints", { method: "POST" }).catch(() => {}); }
        else if (data.status === "error") { if (window.showToast) window.showToast("Failed: " + data.error, "error"); }
        else if (data.status === "cancelled") { if (window.showToast) window.showToast(_t("workshop.toast.cancelled", "Cancelled"), "warning"); }
    }
    _renderProgress();
}

function _hookWebSocket() {
    function tryHook() {
        if (window._studioWs) { window._studioWs.addEventListener("message", (e) => { try { _handleWsMessage(JSON.parse(e.data)); } catch {} }); console.log(TAG, "Hooked into existing Studio WebSocket"); return true; }
        return false;
    }
    if (!tryHook()) {
        const interval = setInterval(() => { if (tryHook()) clearInterval(interval); }, 500);
        const OrigWS = window.WebSocket;
        window.WebSocket = function (url, protocols) {
            const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
            if (url.includes("/studio/ws")) { window._studioWs = ws; ws.addEventListener("message", (e) => { try { _handleWsMessage(JSON.parse(e.data)); } catch {} }); console.log(TAG, "Captured Studio WebSocket via constructor patch"); clearInterval(interval); }
            return ws;
        };
        window.WebSocket.prototype = OrigWS.prototype;
        window.WebSocket.CONNECTING = OrigWS.CONNECTING; window.WebSocket.OPEN = OrigWS.OPEN;
        window.WebSocket.CLOSING = OrigWS.CLOSING; window.WebSocket.CLOSED = OrigWS.CLOSED;
    }
    setInterval(async () => { if (!WS.merging) return; try { const st = await fetchJSON(API + "/status"); _handleWsMessage({ type: "workshop_progress", ...st }); } catch {} }, 2000);
}

// ========================================================================
// UI BUILDER — top-level scaffold (rows are rendered into #wsRowList)
// ========================================================================

function _buildUI(container) {
    container.innerHTML = '<div class="ws-layout"><div class="ws-center">'
    + '<div class="ws-header"><span class="ws-title" data-i18n="workshop.title">' + _t("workshop.title", "Workshop") + '</span><span class="ws-subtitle">v' + VERSION + '</span></div>'
    + '<div class="ws-tabs"><button class="ws-tab ws-tab-active" data-tab="recipe" data-i18n="workshop.tab.recipe">' + _t("workshop.tab.recipe", "Recipe") + '</button><button class="ws-tab" data-tab="history" data-i18n="workshop.tab.history">' + _t("workshop.tab.history", "History") + '</button></div>'

    // ── Recipe tab ──
    + '<div id="wsTabRecipe" class="ws-tab-content">'
    + '<div class="ws-stack">'

    // Board header (refresh button lives here, replaces the old Models card header)
    + '<div class="ws-board-header">'
    + '<span class="ws-board-title" data-i18n="workshop.mergeBoard">' + _t("workshop.mergeBoard", "Merge Board") + '</span>'
    + '<button id="wsRefreshAssets" class="ws-small-btn ws-refresh-btn" data-i18n="workshop.refresh" data-i18n-title="workshop.refresh.tooltip" title="' + _t("workshop.refresh.tooltip", "Rescan every model, LoRA and VAE directory") + '">' + _t("workshop.refresh", "↻ Refresh") + '</button>'
    + '</div>'

    // The row container
    + '<div id="wsRowList" class="ws-board"></div>'

    // Chain tools — equalize alphas + final-composition preview
    + '<div class="ws-chain-tools">'
    + '<div class="ws-chain-tools-header">'
    + '<span class="ws-chain-tools-label" data-i18n="workshop.chainTools.label">' + _t("workshop.chainTools.label", "Chain Analysis") + '</span>'
    + '<button id="wsEqualizeChain" class="ws-small-btn ws-equalize-btn" disabled data-i18n="workshop.chainTools.equalize" data-i18n-title="workshop.chainTools.equalize.tooltip" title="' + _t("workshop.chainTools.equalize.tooltip", "Set every row's alpha so each source contributes equally to the final output.") + '">' + _t("workshop.chainTools.equalize", "Equalize Chain") + '</button>'
    + '</div>'
    + '<div id="wsChainContrib" class="ws-chain-contrib"></div>'
    + '</div>'

    // Add Row button
    + '<button id="wsRowAdd" class="ws-row-add-btn" data-i18n="workshop.addRow">' + _t("workshop.addRow", "+ Add Row") + '</button>'

    // ── LoRAs (global — applied to the final output) ──
    + '<div class="ws-recipe-section">'
    + '<div class="ws-recipe-section-header"><span class="ws-recipe-section-label" data-i18n="workshop.loras">' + _t("workshop.loras", "LoRAs") + '</span><button id="wsLoraAdd" class="ws-bake-add-btn ws-bake-add-btn-inline" data-i18n="workshop.addLora">' + _t("workshop.addLora", "+ Add LoRA") + '</button></div>'
    + '<div id="wsLoraList" class="ws-lora-list"></div>'
    + '</div>'

    // ── VAE (global — applied once at the end of the chain) ──
    + '<div class="ws-recipe-section">'
    + '<div class="ws-recipe-section-header"><span class="ws-recipe-section-label" data-i18n="workshop.vae">' + _t("workshop.vae", "VAE") + '</span></div>'
    + '<select id="wsRecipeVae" class="param-select ws-model-select"><option value="" data-i18n="workshop.vae.none">' + _t("workshop.vae.none", "— None —") + '</option></select>'
    + '<div class="ws-recipe-section-hint" data-i18n="workshop.vae.hint">' + _t("workshop.vae.hint", "Baked into the chain's final output. Override per-row from a row's ⚙ menu if you need a different VAE on an intermediate result.") + '</div>'
    + '</div>'

    // ── Output ──
    + '<div class="ws-output-section"><div class="ws-param"><label data-i18n="workshop.outputFilename">' + _t("workshop.outputFilename", "Output Filename") + '</label><input type="text" id="wsOutputName" class="param-val ws-output-input" data-i18n-placeholder="workshop.outputFilename.placeholder" placeholder="' + _t("workshop.outputFilename.placeholder", "auto-generated if empty") + '" style="text-align:left;"></div><div class="ws-output-opts"><label class="ws-checkbox-label" data-i18n-title="workshop.reducedPrecision.tooltip" title="' + _t("workshop.reducedPrecision.tooltip", "Auto saves Anima/Cosmos as BF16 and other models as FP16. Merge math always runs in FP32.") + '"><input type="checkbox" id="wsFp16" checked><span data-i18n="workshop.reducedPrecision">' + _t("workshop.reducedPrecision", "Reduced precision") + '</span></label><label class="ws-output-dtype-label" data-i18n-title="workshop.outputDtype.tooltip" title="' + _t("workshop.outputDtype.tooltip", "Auto saves Anima/Cosmos as BF16 and other models as FP16. Merge math always runs in FP32.") + '"><span data-i18n="workshop.outputDtype">' + _t("workshop.outputDtype", "Output dtype") + '</span><select id="wsOutputDtype" class="param-val ws-output-dtype-select"><option value="auto">' + _t("workshop.outputDtype.auto", "Auto") + '</option><option value="fp16">FP16</option><option value="bf16">BF16</option><option value="fp32">FP32</option></select></label><label class="ws-checkbox-label" data-i18n-title="workshop.keepIntermediates.tooltip" title="' + _t("workshop.keepIntermediates.tooltip", "Keep each row's output as its own .safetensors file (useful for multi-row boards)") + '"><input type="checkbox" id="wsSaveIntermediates"><span data-i18n="workshop.keepIntermediates">' + _t("workshop.keepIntermediates", "Keep intermediates") + '</span></label></div></div>'

    // Memory status
    + '<div id="wsMemoryStatus" class="ws-memory-status" style="display:none;"><span class="ws-memory-badge" data-i18n="workshop.testMergeActive">' + _t("workshop.testMergeActive", "Test merge active") + '</span><span id="wsMemoryInfo" class="ws-memory-info"></span><button id="wsRevertBtn" class="ws-revert-btn" data-i18n="workshop.action.revert">' + _t("workshop.action.revert", "Revert") + '</button></div>'

    // Actions
    + '<div class="ws-action-row"><button id="wsTestMergeBtn" class="ws-test-merge-btn" disabled data-i18n="workshop.action.testMerge" data-i18n-title="workshop.testMergeBtn.tooltip" title="' + _t("workshop.testMergeBtn.tooltip", "Hot-swap UNet weights — no disk write, instant iteration") + '">' + _t("workshop.action.testMerge", "Test Merge") + '</button><button id="wsMergeBtn" class="ws-merge-btn" disabled data-i18n="workshop.action.beginMerge">' + _t("workshop.action.beginMerge", "Begin Merge") + '</button><button id="wsCancelBtn" class="ws-cancel-btn" style="display:none;" data-i18n="workshop.action.cancel">' + _t("workshop.action.cancel", "Cancel") + '</button></div>'

    // Progress
    + '<div id="wsProgressSection" class="ws-progress-section" style="display:none;"><div class="ws-progress-bar-bg"><div id="wsProgressFill" class="ws-progress-bar-fill"></div></div><div class="ws-progress-info"><span id="wsProgressText">0%</span><span id="wsProgressKeys"></span><span id="wsProgressTime"></span></div><div id="wsProgressStatus" class="ws-progress-status"></div></div>'

    + '</div>'  // close ws-stack
    + '</div>'  // close wsTabRecipe

    // ── History tab ──
    + '<div id="wsTabHistory" class="ws-tab-content" style="display:none;">'
    + '<div class="ws-journal-toolbar">'
    + '<div class="ws-journal-toolbar-top">'
    + '<input type="text" id="wsJournalSearch" class="param-val ws-journal-search-input" data-i18n-placeholder="workshop.search.placeholder" placeholder="Search merges, notes, recipes...">'
    + '<button id="wsJournalAddEntry" class="ws-journal-add-btn">+ New Entry</button>'
    + '</div>'
    + '<div class="ws-journal-filters">'
    + '<button class="ws-journal-filter-btn ws-jf-active" data-filter="all">All</button>'
    + '<button class="ws-journal-filter-btn" data-filter="merge">Merges</button>'
    + '<button class="ws-journal-filter-btn" data-filter="chain">Chain</button>'
    + '<button class="ws-journal-filter-btn" data-filter="lora_bake">LoRA</button>'
    + '<button class="ws-journal-filter-btn" data-filter="vae_bake">VAE</button>'
    + '</div></div>'
    + '<div id="wsJournalList" class="ws-journal-list"></div>'
    + '</div>'

    + '</div>'
    // Inspector
    + '<div class="ws-inspector" id="wsInspector"><div class="ws-inspector-header"><span data-i18n="workshop.inspector.title">' + _t("workshop.inspector.title", "Inspector") + '</span><button id="wsInspectorToggle" class="ws-inspector-toggle" data-i18n-title="workshop.inspector.toggle.tooltip" title="' + _t("workshop.inspector.toggle.tooltip", "Toggle inspector") + '">◀</button></div><div class="ws-inspector-body" id="wsInspectorBody"><div id="wsInfoContent" class="ws-info-content"><div class="ws-info-placeholder">' + _t("workshop.inspector.placeholder", "Select models to inspect") + '</div></div></div></div>'
    + '</div>';

    // Cache element refs
    _els = {
        rowList: container.querySelector("#wsRowList"),
        rowAdd: container.querySelector("#wsRowAdd"),
        equalizeBtn: container.querySelector("#wsEqualizeChain"),
        chainContrib: container.querySelector("#wsChainContrib"),
        outputName: container.querySelector("#wsOutputName"), fp16: container.querySelector("#wsFp16"),
        outputDtype: container.querySelector("#wsOutputDtype"),
        saveIntermediates: container.querySelector("#wsSaveIntermediates"),
        mergeBtn: container.querySelector("#wsMergeBtn"), cancelBtn: container.querySelector("#wsCancelBtn"),
        progressSection: container.querySelector("#wsProgressSection"), progressFill: container.querySelector("#wsProgressFill"),
        progressText: container.querySelector("#wsProgressText"), progressKeys: container.querySelector("#wsProgressKeys"),
        progressTime: container.querySelector("#wsProgressTime"), progressStatus: container.querySelector("#wsProgressStatus"),
        infoContent: container.querySelector("#wsInfoContent"),
        inspector: container.querySelector("#wsInspector"), inspectorToggle: container.querySelector("#wsInspectorToggle"),
        inspectorBody: container.querySelector("#wsInspectorBody"),
        testMergeBtn: container.querySelector("#wsTestMergeBtn"), revertBtn: container.querySelector("#wsRevertBtn"),
        memoryStatus: container.querySelector("#wsMemoryStatus"), memoryInfo: container.querySelector("#wsMemoryInfo"),
        loraList: container.querySelector("#wsLoraList"),
        loraAdd: container.querySelector("#wsLoraAdd"),
        recipeVae: container.querySelector("#wsRecipeVae"),
        refreshAssets: container.querySelector("#wsRefreshAssets"),
        tabRecipe: container.querySelector("#wsTabRecipe"),
        tabHistory: container.querySelector("#wsTabHistory"),
        tabs: container.querySelectorAll(".ws-tab"),
        journalSearch: container.querySelector("#wsJournalSearch"),
        journalList: container.querySelector("#wsJournalList"),
        journalFilters: container.querySelectorAll(".ws-journal-filter-btn"),
        journalAddEntry: container.querySelector("#wsJournalAddEntry"),
    };

    // Seed one row, render, bind global events.
    if (!WS.rows.length) WS.rows.push(_newRow());
    _renderRows();
    _renderRecipeLoras();
    _bindGlobalEvents();
}

// ========================================================================
// ROW RENDERING — every row is rendered identically
// ========================================================================

function _modelOptionsForRow(rowIdx, currentValue, includeNoneLabel) {
    let html = '<option value="">' + (includeNoneLabel || "— Select —") + '</option>';
    if (rowIdx > 0) {
        html += '<optgroup label="Previous outputs">';
        for (let i = 0; i < rowIdx; i++) {
            const r = WS.rows[i];
            const ref = _refValue(r.id);
            const sel = currentValue === ref ? ' selected' : '';
            html += '<option value="' + _esc(ref) + '"' + sel + '>Output of Row ' + (i + 1) + '</option>';
        }
        html += '</optgroup>';
    }
    html += '<optgroup label="Models on disk">';
    for (const m of WS.models) {
        const sel = currentValue === m.filename ? ' selected' : '';
        html += '<option value="' + _esc(m.filename) + '"' + sel + ' title="' + m.size_gb + ' GB">' + _esc(m.filename) + ' (' + m.size_gb + ' GB)</option>';
    }
    html += '</optgroup>';
    return html;
}

function _methodOptions(current) {
    return Object.entries(METHOD_INFO).map(([val, info]) => '<option value="' + val + '"' + (val === current ? ' selected' : '') + '>' + info.label + '</option>').join("");
}

function _renderRows() {
    if (!_els.rowList) return;
    if (WS.activeRow >= WS.rows.length) WS.activeRow = Math.max(0, WS.rows.length - 1);
    let html = '';
    for (let i = 0; i < WS.rows.length; i++) html += _rowHtml(i);
    _els.rowList.innerHTML = html;
    for (let i = 0; i < WS.rows.length; i++) {
        _bindRowEvents(i);
        _populatePresetSelectForRow(i);
        _populateRowVae(i);
        _buildBlockSlidersForRow(i);
        _applyRowMethodVisibility(i);
    }
    _recomputeFinalRowOutputName();
    _renderInfo();
    _refreshActiveRowInspector();
    _updateActionButtons();
    _renderChainContrib();
}

function _rowHtml(rowIdx) {
    const row = WS.rows[rowIdx];
    const info = METHOD_INFO[row.method] || {};
    const isActive = rowIdx === WS.activeRow;
    const referenced = _isRowReferenced(rowIdx);
    const refList = referenced ? _rowsReferencing(rowIdx).join(", ") : "";
    const deleteTitle = referenced
        ? "Cannot delete — referenced by " + refList
        : "Delete row";

    // Line 2 visible if anything inside it has content:
    //   - method has params (density / drop_rate / eta / cosine_shift)
    //   - block weights enabled
    //   - row.bakeVae toggled on
    //   - user clicked the ⚙ to manually expand
    //   (Tertiary lives on line 1 so it never forces line 2.)
    const expanded = !!row.expanded;
    const showTertiary = !!info.needsC;
    const showParams = info.params.length > 0;
    const showBlockToggle = !!info.blockWeights && (expanded || row.useBlockWeights);
    const showVaeOnLine2 = !!row.bakeVae;
    const line2Visible = showParams || showBlockToggle || showVaeOnLine2 || expanded;
    // ⚙ is always visible — every row can opt into VAE / blocks / expand
    const expandBtnVisible = true;

    let html = '<div class="ws-row' + (isActive ? ' ws-row-active' : '') + '" data-row="' + rowIdx + '">';

    // ── Line 1: compact horizontal strip ──
    html += '<div class="ws-row-line ws-row-line1">';
    html += '<span class="ws-row-num" title="Row ' + (rowIdx + 1) + '">' + (rowIdx + 1) + '</span>';
    html += '<select class="param-select ws-model-select ws-row-primary ws-row-cell-grow" data-row="' + rowIdx + '" title="Primary (base)">'
        + _modelOptionsForRow(rowIdx, row.primary, "— Primary —")
        + '</select>';
    html += '<select class="param-select ws-model-select ws-row-secondary ws-row-cell-grow" data-row="' + rowIdx + '" title="Secondary (merge target)">'
        + _modelOptionsForRow(rowIdx, row.secondary, "— Secondary —")
        + '</select>';
    // Tertiary lives on line 1, hidden unless method.needsC
    html += '<select class="param-select ws-model-select ws-row-tertiary ws-row-cell-grow" data-row="' + rowIdx + '" title="Tertiary (Model C — base of Secondary)"' + (showTertiary ? '' : ' style="display:none;"') + '>'
        + _modelOptionsForRow(rowIdx, row.tertiary, "— Tertiary —")
        + '</select>';
    html += '<select class="param-select ws-row-method ws-row-cell-method" data-row="' + rowIdx + '" title="Merge method">'
        + _methodOptions(row.method)
        + '</select>';
    // Alpha cell — slider + value, hidden for methods without alpha (cosine_adaptive)
    var displayedAlpha = _alphaForDisplay(row.alpha, row.method);
    html += '<div class="ws-row-alpha-cell" data-row="' + rowIdx + '"' + (info.showAlpha ? '' : ' style="visibility:hidden;"') + '>'
        + '<input type="range" min="0" max="1" step="0.01" value="' + displayedAlpha + '" class="ws-slider ws-row-alpha-slider" data-row="' + rowIdx + '" title="' + _esc(info.alphaLabel || "Weight") + '">'
        + '<input type="number" min="0" max="1" step="0.01" value="' + displayedAlpha.toFixed(2) + '" class="param-val ws-row-alpha-val" data-row="' + rowIdx + '">'
        + '</div>';
    // Expand button (⚙) — only shown when there is something hidden behind it
    html += '<button class="ws-row-expand' + (expanded || row.useBlockWeights ? ' ws-row-expanded' : '') + '" data-row="' + rowIdx + '" title="Per-block weights / advanced"' + (expandBtnVisible ? '' : ' style="visibility:hidden;"') + '>⚙</button>';
    // Delete button
    html += '<button class="ws-row-delete' + (referenced ? ' ws-row-delete-blocked' : '') + '" data-row="' + rowIdx + '"'
        + (referenced ? ' disabled' : '')
        + ' title="' + _esc(deleteTitle) + '">×</button>';
    html += '</div>';

    // ── Line 2: conditional — params + block-weights toggle row ──
    html += '<div class="ws-row-line ws-row-line2"' + (line2Visible ? '' : ' style="display:none;"') + '>';
    // Param sliders
    html += _paramCellHtml(rowIdx, "density", row.density, info.params.includes("density"), "Density");
    html += _paramCellHtml(rowIdx, "drop_rate", row.dropRate, info.params.includes("drop_rate"), "Drop");
    html += _paramCellHtml(rowIdx, "cosine_shift", row.cosineShift, info.params.includes("cosine_shift"), "Shift");
    html += _paramCellHtml(rowIdx, "eta", row.eta, info.params.includes("eta"), "η");
    // Block weights toggle + preset/auto/diff
    if (info.blockWeights) {
        html += '<div class="ws-row-blocks-toggle"' + (showBlockToggle ? '' : ' style="display:none;"') + '>'
            + '<label class="ws-checkbox-label ws-row-blocks-label"><input type="checkbox" class="ws-row-block-toggle" data-row="' + rowIdx + '"' + (row.useBlockWeights ? ' checked' : '') + '><span>Blocks</span></label>'
            + '<select class="param-select ws-row-preset" data-row="' + rowIdx + '" disabled><option value="">— Preset —</option></select>'
            + '<button class="ws-small-btn ws-row-auto" data-row="' + rowIdx + '" disabled title="Auto-alpha via Model Stock">Auto</button>'
            + '<button class="ws-small-btn ws-row-diff" data-row="' + rowIdx + '" disabled title="Compute cosine similarity">Diff</button>'
            + '</div>';
    }
    // Per-row VAE bake (off by default — global VAE handles the final
    // output). Checkbox toggles whether this row emits its own vae_bake
    // step right after its merge; the dropdown is only revealed once
    // the checkbox is on so an unconfigured row is unambiguous.
    html += '<div class="ws-row-vae-cell">'
        + '<label class="ws-checkbox-label ws-row-blocks-label" title="Bake a VAE into this row’s output (extra chain step)">'
        + '<input type="checkbox" class="ws-row-bake-vae" data-row="' + rowIdx + '"' + (row.bakeVae ? ' checked' : '') + '>'
        + '<span>Bake VAE</span>'
        + '</label>'
        + '<select class="param-select ws-row-vae" data-row="' + rowIdx + '"' + (row.bakeVae ? '' : ' style="display:none;"') + '>'
        + '<option value="">— Pick VAE —</option>'
        + '</select>'
        + '</div>';
    // Per-row output filename for intermediates. Hidden when "Keep
    // intermediates" is off OR this is the final merge-producing row.
    // Visibility is finalized by _recomputeFinalRowOutputName after the
    // row is in the DOM.
    html += '<div class="ws-row-out-name-cell" data-row="' + rowIdx + '" style="display:none;">'
        + '<span class="ws-row-out-name-label">Out name</span>'
        + '<input type="text" class="param-val ws-row-out-name" data-row="' + rowIdx + '" placeholder="row-' + (rowIdx + 1) + '" value="' + _esc(row.outputName || '') + '">'
        + '</div>';
    html += '</div>';

    // ── Line 3: block sliders (only when row.useBlockWeights) ──
    html += '<div class="ws-row-line ws-row-line3 ws-block-sliders ws-row-block-sliders" data-row="' + rowIdx + '"' + (row.useBlockWeights ? '' : ' style="display:none;"') + '></div>';

    html += '</div>';
    return html;
}

function _paramCellHtml(rowIdx, paramKey, value, visible, shortLabel) {
    const def = PARAM_DEFS[paramKey];
    if (!def) return "";
    return '<div class="ws-row-param-cell" data-row="' + rowIdx + '" data-param="' + paramKey + '"' + (visible ? '' : ' style="display:none;"')
        + ' title="' + _esc(def.label) + '">'
        + '<span class="ws-row-param-label">' + _esc(shortLabel) + '</span>'
        + '<input type="range" min="' + def.min + '" max="' + def.max + '" step="' + def.step + '" value="' + value + '" class="ws-slider ws-row-param-slider" data-row="' + rowIdx + '" data-param="' + paramKey + '">'
        + '<input type="number" min="' + def.min + '" max="' + def.max + '" step="' + def.step + '" value="' + Number(value).toFixed(2) + '" class="param-val ws-row-param-val" data-row="' + rowIdx + '" data-param="' + paramKey + '">'
        + '</div>';
}

function _populatePresetSelectForRow(rowIdx) {
    const sel = _els.rowList?.querySelector('.ws-row-preset[data-row="' + rowIdx + '"]');
    if (!sel) return;
    let html = '<option value="">— Preset —</option>';
    for (const name of Object.keys(WS.presets)) html += '<option value="' + _esc(name) + '">' + _esc(name) + '</option>';
    sel.innerHTML = html;
    sel.disabled = !WS.rows[rowIdx]?.useBlockWeights;
}

function _populateGlobalVaeSelect() {
    if (!_els.recipeVae) return;
    let html = '<option value="">— None —</option>';
    for (const v of WS.vaes) {
        const sel = WS.recipeVae === v.filename ? ' selected' : '';
        html += '<option value="' + _esc(v.filename) + '"' + sel + '>' + _esc(v.filename) + ' (' + v.size_mb + ' MB)</option>';
    }
    _els.recipeVae.innerHTML = html;
    if (WS.vaes.length >= 10 && window.StudioSearchableSelect) {
        window.StudioSearchableSelect.attach(_els.recipeVae, { placeholder: "— None —", searchPlaceholder: "Filter VAEs…" });
    }
}

function _populateRowVae(rowIdx) {
    const sel = _els.rowList?.querySelector('.ws-row-vae[data-row="' + rowIdx + '"]');
    if (!sel) return;
    const r = WS.rows[rowIdx];
    // null → use global; a filename → per-row override
    let html = '<option value="">— Use global —</option>';
    for (const v of WS.vaes) {
        const selected = r && r.vae === v.filename ? ' selected' : '';
        html += '<option value="' + _esc(v.filename) + '"' + selected + '>' + _esc(v.filename) + ' (' + v.size_mb + ' MB)</option>';
    }
    sel.innerHTML = html;
    if (WS.vaes.length >= 10 && window.StudioSearchableSelect) {
        window.StudioSearchableSelect.attach(sel, { placeholder: "— Use global —", searchPlaceholder: "Filter VAEs…" });
    }
}

// ========================================================================
// PER-ROW EVENT BINDING
// ========================================================================

function _bindRowEvents(rowIdx) {
    const rowEl = _els.rowList.querySelector('.ws-row[data-row="' + rowIdx + '"]');
    if (!rowEl) return;
    const row = WS.rows[rowIdx];

    // Row body click → set active row (ignore clicks on form controls)
    rowEl.addEventListener("click", (ev) => {
        const t = ev.target;
        if (t.closest("select, input, button, label.ws-checkbox-label")) return;
        _setActiveRow(rowIdx);
    });

    // Delete
    const delBtn = rowEl.querySelector(".ws-row-delete");
    if (delBtn && !delBtn.disabled) {
        delBtn.addEventListener("click", (ev) => { ev.stopPropagation(); _removeRow(rowIdx); });
    }

    // Primary / secondary / tertiary
    const primarySel = rowEl.querySelector(".ws-row-primary");
    primarySel.addEventListener("change", () => {
        row.primary = primarySel.value || null;
        _highlightRefSource(_refTargetIdxFromValue(row.primary));
        _setActiveRow(rowIdx);
        if (rowIdx === WS.activeRow) {
            WS.compatibility = null; WS.healthScan = null;
            inspectModel(_isConcreteModel(row.primary) ? row.primary : null, "A");
            runPreflight(); runCompatibility();
        }
        _renderRows();   // reflect new ref label availability (also re-runs _recomputeFinalRowOutputName)
    });

    const secSel = rowEl.querySelector(".ws-row-secondary");
    secSel.addEventListener("change", () => {
        row.secondary = secSel.value || null;
        _highlightRefSource(_refTargetIdxFromValue(row.secondary));
        _setActiveRow(rowIdx);
        if (rowIdx === WS.activeRow) {
            WS.compatibility = null; WS.healthScan = null;
            inspectModel(_isConcreteModel(row.secondary) ? row.secondary : null, "B");
            runPreflight(); runCompatibility();
        }
        _updateActionButtons();
        _updateRowAutoDiffButtons(rowIdx);
        _recomputeFinalRowOutputName();
    });

    const terSel = rowEl.querySelector(".ws-row-tertiary");
    if (terSel) {
        terSel.addEventListener("change", () => {
            row.tertiary = terSel.value || null;
            _highlightRefSource(_refTargetIdxFromValue(row.tertiary));
            _updateActionButtons();
        });
    }

    // Highlight referenced row on dropdown focus/blur for primary, secondary, tertiary
    [primarySel, secSel, terSel].forEach(sel => {
        if (!sel) return;
        sel.addEventListener("focus", () => _highlightRefSource(_refTargetIdxFromValue(sel.value)));
        sel.addEventListener("blur", () => _highlightRefSource(null));
    });

    // Wrap the model selects in the searchable-select widget. attach()
    // is idempotent — re-renders of the row safely re-attach to the
    // same handle. The wrapper dispatches focus/blur on the native
    // select on panel open/close, so the ref-source highlight wiring
    // above keeps working untouched.
    if (window.StudioSearchableSelect) {
        if (primarySel) window.StudioSearchableSelect.attach(primarySel, { placeholder: "— Primary —", searchPlaceholder: "Filter models…" });
        if (secSel) window.StudioSearchableSelect.attach(secSel, { placeholder: "— Secondary —", searchPlaceholder: "Filter models…" });
        if (terSel) window.StudioSearchableSelect.attach(terSel, { placeholder: "— Tertiary —", searchPlaceholder: "Filter models…" });
    }

    // Method
    const methodSel = rowEl.querySelector(".ws-row-method");
    methodSel.addEventListener("change", () => {
        row.method = methodSel.value;
        _onRowMethodChanged(rowIdx);
    });

    // Alpha — slider/number store the Secondary-weight value verbatim,
    // which is exactly what the backend lerp expects.
    const alphaSlider = rowEl.querySelector(".ws-row-alpha-slider");
    const alphaVal = rowEl.querySelector(".ws-row-alpha-val");
    alphaSlider.addEventListener("input", () => {
        const displayed = parseFloat(alphaSlider.value);
        row.alpha = _alphaFromDisplay(displayed, row.method);
        alphaVal.value = displayed.toFixed(2);
        _renderChainContrib();
    });
    alphaVal.addEventListener("change", () => {
        let v = parseFloat(alphaVal.value); if (isNaN(v)) v = 0.5;
        v = Math.max(0, Math.min(1, v));
        row.alpha = _alphaFromDisplay(v, row.method);
        alphaSlider.value = v; alphaVal.value = v.toFixed(2);
        _renderChainContrib();
    });

    // Method-specific param sliders
    rowEl.querySelectorAll(".ws-row-param-slider").forEach(slider => {
        const param = slider.dataset.param;
        const valEl = rowEl.querySelector('.ws-row-param-val[data-param="' + param + '"]');
        slider.addEventListener("input", () => {
            const v = parseFloat(slider.value);
            valEl.value = v.toFixed(2);
            _setRowParam(rowIdx, param, v);
        });
        valEl.addEventListener("change", () => {
            let v = parseFloat(valEl.value);
            if (isNaN(v)) v = parseFloat(slider.value);
            v = Math.max(parseFloat(slider.min), Math.min(parseFloat(slider.max), v));
            slider.value = v; valEl.value = v.toFixed(2);
            _setRowParam(rowIdx, param, v);
        });
    });

    // Expand toggle (⚙) — opts the row into the line-2 advanced row when
    // there's no other reason to show line 2.
    const expandBtn = rowEl.querySelector(".ws-row-expand");
    if (expandBtn) {
        expandBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            row.expanded = !row.expanded;
            _applyRowMethodVisibility(rowIdx);
        });
    }

    // Block weights toggle / preset / auto / diff
    const blockToggle = rowEl.querySelector(".ws-row-block-toggle");
    if (blockToggle) {
        blockToggle.addEventListener("change", () => {
            row.useBlockWeights = blockToggle.checked;
            const sliders = rowEl.querySelector(".ws-row-block-sliders");
            sliders.style.display = row.useBlockWeights ? "" : "none";
            const preset = rowEl.querySelector(".ws-row-preset");
            if (preset) preset.disabled = !row.useBlockWeights;
            _updateRowAutoDiffButtons(rowIdx);
            if (row.useBlockWeights && !row.blockWeights) _initRowBlockWeights(rowIdx, row.alpha);
            _applyRowMethodVisibility(rowIdx);
            _renderChainContrib();
        });
    }

    const presetSel = rowEl.querySelector(".ws-row-preset");
    if (presetSel) {
        presetSel.addEventListener("change", () => {
            const name = presetSel.value; if (!name) return;
            const weights = WS.presets[name];
            if (weights === null || weights === undefined) {
                _initRowBlockWeights(rowIdx, row.alpha);
            } else {
                row.blockWeights = {};
                for (const b of WS.blockList) row.blockWeights[b] = (b in weights) ? weights[b] : row.alpha;
            }
            _syncRowBlockUI(rowIdx);
        });
    }

    const bakeVaeChk = rowEl.querySelector(".ws-row-bake-vae");
    const vaeSel = rowEl.querySelector(".ws-row-vae");
    if (bakeVaeChk) {
        bakeVaeChk.addEventListener("change", () => {
            row.bakeVae = bakeVaeChk.checked;
            if (vaeSel) vaeSel.style.display = row.bakeVae ? "" : "none";
            _applyRowMethodVisibility(rowIdx);
            _updateActionButtons();
        });
    }
    if (vaeSel) {
        vaeSel.addEventListener("change", () => {
            row.vae = vaeSel.value || null;
            _updateActionButtons();
        });
    }

    const autoBtn = rowEl.querySelector(".ws-row-auto");
    if (autoBtn) autoBtn.addEventListener("click", () => loadModelStockForRow(rowIdx));

    const diffBtn = rowEl.querySelector(".ws-row-diff");
    if (diffBtn) diffBtn.addEventListener("click", () => {
        _setActiveRow(rowIdx);
        loadCosineDiff();
    });

    const outNameInput = rowEl.querySelector(".ws-row-out-name");
    if (outNameInput) {
        outNameInput.addEventListener("input", () => { row.outputName = outNameInput.value.trim(); });
    }

    _updateRowAutoDiffButtons(rowIdx);
}

function _setRowParam(rowIdx, param, v) {
    const r = WS.rows[rowIdx];
    if (param === "density") r.density = v;
    else if (param === "drop_rate") r.dropRate = v;
    else if (param === "cosine_shift") r.cosineShift = v;
    else if (param === "eta") r.eta = v;
}

function _updateRowAutoDiffButtons(rowIdx) {
    const r = WS.rows[rowIdx];
    if (!r) return;
    const rowEl = _els.rowList.querySelector('.ws-row[data-row="' + rowIdx + '"]');
    if (!rowEl) return;
    const a = _isConcreteModel(r.primary), b = _isConcreteModel(r.secondary);
    const auto = rowEl.querySelector(".ws-row-auto");
    const diff = rowEl.querySelector(".ws-row-diff");
    if (auto) auto.disabled = !(a && b && r.useBlockWeights);
    if (diff) diff.disabled = !(a && b);
}

// ========================================================================
// PER-ROW METHOD CHANGE — visibility of Model C, params, block-weights
// ========================================================================

function _onRowMethodChanged(rowIdx) {
    _applyRowMethodVisibility(rowIdx);
    _updateActionButtons();
    if (rowIdx === WS.activeRow) _renderInfo();
}

function _applyRowMethodVisibility(rowIdx) {
    const r = WS.rows[rowIdx];
    const info = METHOD_INFO[r.method] || {};
    const rowEl = _els.rowList.querySelector('.ws-row[data-row="' + rowIdx + '"]');
    if (!rowEl) return;

    // Line 1 — alpha cell hidden (but keep slot) when method has no alpha
    const alphaCell = rowEl.querySelector(".ws-row-alpha-cell");
    if (alphaCell) alphaCell.style.visibility = info.showAlpha ? "" : "hidden";
    const alphaSlider = rowEl.querySelector(".ws-row-alpha-slider");
    if (alphaSlider) alphaSlider.title = info.alphaLabel || "Weight";
    const alphaValEl = rowEl.querySelector(".ws-row-alpha-val");
    if (alphaSlider && alphaValEl) {
        const disp = _alphaForDisplay(r.alpha, r.method);
        alphaSlider.value = disp;
        alphaValEl.value = disp.toFixed(2);
    }
    // Block sliders also need a repaint if open — they read r.method too.
    if (r.useBlockWeights) _buildBlockSlidersForRow(rowIdx);

    // Tertiary (lives on line 1)
    const tertiary = rowEl.querySelector(".ws-row-tertiary");
    if (tertiary) tertiary.style.display = info.needsC ? "" : "none";

    // Method-specific param cells (line 2)
    rowEl.querySelectorAll(".ws-row-param-cell").forEach(el => {
        const p = el.dataset.param;
        el.style.display = info.params.includes(p) ? "" : "none";
    });

    // Block-weights toggle (line 2) — visible only when method supports
    // blocks AND (row was expanded OR block weights are already on)
    if (!info.blockWeights && r.useBlockWeights) {
        r.useBlockWeights = false;
    }
    const blocksToggleRow = rowEl.querySelector(".ws-row-blocks-toggle");
    const showBlockToggle = !!info.blockWeights && (!!r.expanded || !!r.useBlockWeights);
    if (blocksToggleRow) blocksToggleRow.style.display = showBlockToggle ? "" : "none";

    // Expand button — always visible since every row can opt into VAE
    // (and blocks, when supported). Highlighted when line 2 is forced open.
    const expandBtn = rowEl.querySelector(".ws-row-expand");
    if (expandBtn) {
        expandBtn.style.visibility = "";
        expandBtn.classList.toggle("ws-row-expanded",
            !!r.expanded || !!r.useBlockWeights || !!r.bakeVae);
    }

    // Line 2 visibility — params, blocks toggle, bake-VAE on, the
    // per-row out-name input being visible, or user-expanded. Tertiary
    // is on line 1.
    const outNameCell = rowEl.querySelector(".ws-row-out-name-cell");
    const outNameVisible = outNameCell && outNameCell.style.display !== "none";
    const line2Visible = info.params.length > 0 || showBlockToggle || !!r.bakeVae || !!r.expanded || outNameVisible;
    const line2 = rowEl.querySelector(".ws-row-line2");
    if (line2) line2.style.display = line2Visible ? "" : "none";

    // Line 3 (block sliders)
    const blockSliders = rowEl.querySelector(".ws-row-block-sliders");
    if (blockSliders) blockSliders.style.display = r.useBlockWeights ? "" : "none";
}

// ========================================================================
// ROW ADDITION / REMOVAL
// ========================================================================

function _addRow() {
    const newRow = _newRow();
    if (WS.rows.length > 0) {
        // default the new row's primary to the previous row's output ref —
        // matches the natural "chain to the last result" expectation
        newRow.primary = _refValue(WS.rows[WS.rows.length - 1].id);
    }
    WS.rows.push(newRow);
    WS.activeRow = WS.rows.length - 1;
    _renderRows();
}

function _removeRow(rowIdx) {
    if (rowIdx < 0 || rowIdx >= WS.rows.length) return;
    if (_isRowReferenced(rowIdx)) {
        if (window.showToast) window.showToast("Row " + (rowIdx + 1) + " is referenced by " + _rowsReferencing(rowIdx).join(", ") + " — cannot delete", "warning");
        return;
    }
    WS.rows.splice(rowIdx, 1);
    if (WS.rows.length === 0) WS.rows.push(_newRow());
    if (WS.activeRow >= WS.rows.length) WS.activeRow = WS.rows.length - 1;
    _renderRows();
}

// Apply / clear the per-row "Out name" input visibility on every row in
// place — without re-rendering the row HTML — so users typing in one
// row's output name don't lose focus when another row's
// primary/secondary changes the "final merge row" calculation.
function _recomputeFinalRowOutputName() {
    if (!_els.rowList) return;
    const finalIdx = _finalMergeRowIdx();
    const keep = !!WS.saveIntermediates;
    for (let i = 0; i < WS.rows.length; i++) {
        const cell = _els.rowList.querySelector('.ws-row-out-name-cell[data-row="' + i + '"]');
        if (!cell) continue;
        const r = WS.rows[i];
        const producesMerge = !!(r.primary && r.secondary);
        // Show input when intermediates are kept AND this row produces a
        // merge AND it isn't the final merge-producing row.
        const visible = keep && producesMerge && i !== finalIdx;
        cell.style.display = visible ? "" : "none";
    }
    // Also re-evaluate line 2 visibility — adding/removing the out-name
    // cell may flip a row's line 2 from empty → non-empty or vice-versa.
    for (let i = 0; i < WS.rows.length; i++) _applyRowMethodVisibility(i);
}

function _highlightRefSource(targetRowIdx) {
    if (!_els.rowList) return;
    _els.rowList.querySelectorAll(".ws-row-ref-source").forEach(el => el.classList.remove("ws-row-ref-source"));
    if (targetRowIdx === null || targetRowIdx === undefined || targetRowIdx < 0) return;
    const target = _els.rowList.querySelector('.ws-row[data-row="' + targetRowIdx + '"]');
    if (target) target.classList.add("ws-row-ref-source");
}

function _refTargetIdxFromValue(value) {
    if (!_isRefValue(value)) return -1;
    return _rowIndexById(_refRowId(value));
}

function _setActiveRow(rowIdx) {
    if (rowIdx < 0 || rowIdx >= WS.rows.length || rowIdx === WS.activeRow) return;
    WS.activeRow = rowIdx;
    _els.rowList.querySelectorAll(".ws-row").forEach(el => {
        el.classList.toggle("ws-row-active", parseInt(el.dataset.row) === rowIdx);
    });
    _refreshActiveRowInspector();
}

function _refreshActiveRowInspector() {
    const r = _activeRow();
    if (!r) {
        WS.inspectA = null; WS.inspectB = null; WS.preflight = null;
        WS.compatibility = null; WS.cosineDiff = null;
        _renderInfo();
        return;
    }
    const a = _isConcreteModel(r.primary) ? r.primary : null;
    const b = _isConcreteModel(r.secondary) ? r.secondary : null;
    WS.preflight = null; WS.compatibility = null; WS.cosineDiff = null;
    _renderInfo();
    inspectModel(a, "A");
    inspectModel(b, "B");
    if (a && b) { runPreflight(); runCompatibility(); }
}

// ========================================================================
// GLOBAL EVENT BINDING (non-row controls)
// ========================================================================

function _bindGlobalEvents() {
    _els.rowAdd.addEventListener("click", _addRow);
    if (_els.equalizeBtn) _els.equalizeBtn.addEventListener("click", _equalizeChain);

    _els.outputName.addEventListener("input", () => { WS.outputName = _els.outputName.value.trim(); });
    // "Reduced precision" checkbox and the Output dtype dropdown stay in
    // sync: unchecking forces FP32, re-checking restores Auto. The dropdown
    // is the full-fidelity control (auto/fp16/bf16/fp32).
    _els.fp16.addEventListener("change", () => {
        WS.saveFp16 = _els.fp16.checked;
        if (!WS.saveFp16) {
            WS.outputDtype = "fp32";
        } else if (WS.outputDtype === "fp32") {
            WS.outputDtype = "auto";
        }
        if (_els.outputDtype) _els.outputDtype.value = WS.outputDtype;
    });
    _els.fp16.checked = WS.saveFp16;
    if (_els.outputDtype) {
        _els.outputDtype.addEventListener("change", () => {
            WS.outputDtype = _els.outputDtype.value || "auto";
            WS.saveFp16 = WS.outputDtype !== "fp32";
            _els.fp16.checked = WS.saveFp16;
        });
        _els.outputDtype.value = WS.outputDtype;
    }
    _els.saveIntermediates.addEventListener("change", () => {
        WS.saveIntermediates = _els.saveIntermediates.checked;
        _recomputeFinalRowOutputName();
    });
    _els.saveIntermediates.checked = WS.saveIntermediates;

    _els.mergeBtn.addEventListener("click", startMerge);
    _els.cancelBtn.addEventListener("click", cancelMerge);
    _els.testMergeBtn.addEventListener("click", testMerge);
    _els.revertBtn.addEventListener("click", revertMerge);

    _els.inspectorToggle.addEventListener("click", () => {
        _els.inspector.classList.toggle("collapsed");
        _els.inspectorToggle.textContent = _els.inspector.classList.contains("collapsed") ? "▶" : "◀";
    });

    _els.loraAdd.addEventListener("click", _addRecipeLora);
    _els.recipeVae.addEventListener("change", () => {
        WS.recipeVae = _els.recipeVae.value || null;
        _updateActionButtons();
    });

    if (_els.refreshAssets) _els.refreshAssets.addEventListener("click", refreshAssets);

    _els.tabs.forEach(tab => {
        tab.addEventListener("click", () => {
            _els.tabs.forEach(t => t.classList.remove("ws-tab-active"));
            tab.classList.add("ws-tab-active");
            const target = tab.dataset.tab;
            _els.tabRecipe.style.display = target === "recipe" ? "" : "none";
            _els.tabHistory.style.display = target === "history" ? "" : "none";
            if (target === "history") _loadJournal();
        });
    });

    _els.journalSearch.addEventListener("input", () => { WS.journalSearch = _els.journalSearch.value; _renderJournal(); });
    _els.journalAddEntry.addEventListener("click", _addManualJournalEntry);
    _els.journalFilters.forEach(btn => {
        btn.addEventListener("click", () => {
            _els.journalFilters.forEach(b => b.classList.remove("ws-jf-active"));
            btn.classList.add("ws-jf-active");
            WS.journalFilter = btn.dataset.filter;
            _renderJournal();
        });
    });

    document.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape" && WS.journalExpanded) _closeHistoryDetail();
    });

    _loadJournal();
}

// ========================================================================
// BLOCK WEIGHT SLIDERS — per row
// ========================================================================

function _initRowBlockWeights(rowIdx, alpha) {
    const r = WS.rows[rowIdx];
    r.blockWeights = {};
    for (const b of WS.blockList) r.blockWeights[b] = alpha;
    _syncRowBlockUI(rowIdx);
}

function _buildBlockSlidersForRow(rowIdx) {
    const r = WS.rows[rowIdx];
    const container = _els.rowList?.querySelector('.ws-row-block-sliders[data-row="' + rowIdx + '"]');
    if (!container) return;
    if (!WS.blockList.length) {
        container.innerHTML = '<div class="ws-info-placeholder">No blocks detected — pick two models so the architecture can be inferred</div>';
        return;
    }
    const groups = _groupBlocks(WS.blockList);
    let html = '';
    for (const group of groups) {
        if (group.label) {
            const tip = _getBlockTooltip(group.label);
            html += '<div class="ws-block-group-label ws-has-tip"' + (tip ? ' data-tip="' + _esc(tip) + '"' : '') + '>' + _esc(group.label) + (tip ? ' <span class="ws-tooltip-icon">?</span>' : '') + '</div>';
        }
        for (const block of group.blocks) {
            const stored = r.blockWeights?.[block] ?? r.alpha;
            const disp = _alphaForDisplay(stored, r.method);
            const tip = _getBlockTooltip(block);
            const color = _heatColor(disp);
            const widthPct = (disp * 100).toFixed(1);
            html += '<div class="ws-block-row ws-block-heat" data-block="' + block + '">'
                + '<span class="ws-block-name ws-has-tip"' + (tip ? ' data-tip="' + _esc(tip) + '"' : '') + '>' + block + (tip ? ' <span class="ws-tooltip-icon">?</span>' : '') + '</span>'
                + '<div class="ws-block-heat-track" data-block="' + block + '">'
                + '<div class="ws-block-heat-fill" data-block="' + block + '" style="width:' + widthPct + '%;background:' + color + ';"></div>'
                + '<input type="range" min="0" max="1" step="0.01" value="' + disp + '" class="ws-block-slider" data-row="' + rowIdx + '" data-block="' + block + '">'
                + '</div>'
                + '<span class="ws-block-val" data-row="' + rowIdx + '" data-block="' + block + '">' + disp.toFixed(2) + '</span></div>';
        }
    }
    container.innerHTML = html;
    container.querySelectorAll(".ws-block-slider").forEach(slider => {
        slider.addEventListener("input", (e) => {
            const block = e.target.dataset.block;
            const disp = parseFloat(e.target.value);
            if (!r.blockWeights) r.blockWeights = {};
            r.blockWeights[block] = _alphaFromDisplay(disp, r.method);
            const valSpan = container.querySelector('.ws-block-val[data-block="' + block + '"]');
            if (valSpan) valSpan.textContent = disp.toFixed(2);
            const fill = container.querySelector('.ws-block-heat-fill[data-block="' + block + '"]');
            if (fill) {
                fill.style.width = (disp * 100).toFixed(1) + "%";
                fill.style.background = _heatColor(disp);
            }
        });
    });
}

function _syncRowBlockUI(rowIdx) {
    const r = WS.rows[rowIdx];
    const rowEl = _els.rowList.querySelector('.ws-row[data-row="' + rowIdx + '"]');
    if (!rowEl) return;
    const toggle = rowEl.querySelector(".ws-row-block-toggle");
    if (toggle) toggle.checked = !!r.useBlockWeights;
    const sliders = rowEl.querySelector(".ws-row-block-sliders");
    if (sliders) sliders.style.display = r.useBlockWeights ? "" : "none";
    const preset = rowEl.querySelector(".ws-row-preset");
    if (preset) preset.disabled = !r.useBlockWeights;
    _buildBlockSlidersForRow(rowIdx);
}

function _groupBlocks(blocks) {
    const groups = []; let current = null;
    for (const b of blocks) {
        let label = null;
        if (b === "BASE") label = "Text Encoder";
        else if (b.startsWith("IN") && (!current || !current.label?.includes("Input"))) label = "Input Blocks";
        else if (b === "M00") label = "Middle";
        else if (b.startsWith("OUT") && (!current || !current.label?.includes("Output"))) label = "Output Blocks";
        else if (b.startsWith("D") && (!current || !current.label?.includes("Double"))) label = "Double Stream Blocks";
        else if (b.startsWith("S") && (!current || !current.label?.includes("Single"))) label = "Single Stream Blocks";
        else if (b.startsWith("J") && (!current || !current.label?.includes("Joint"))) label = "Joint Blocks";
        if (label) { current = { label, blocks: [b] }; groups.push(current); }
        else if (current) { current.blocks.push(b); }
        else { current = { label: null, blocks: [b] }; groups.push(current); }
    }
    return groups;
}

// ========================================================================
// CHANGE HANDLERS — active models / arch detection
// ========================================================================

function _onActiveModelsChanged() {
    const arch = WS.inspectA?.architecture?.arch || WS.inspectB?.architecture?.arch || null;
    if (arch && arch !== WS.arch) { WS.arch = arch; loadPresets(arch); }
    WS.cosineDiff = null;
    _renderInfo();
    _renderActiveArchBadges();
}

function _renderActiveArchBadges() {
    const rowIdx = WS.activeRow;
    const rowEl = _els.rowList?.querySelector('.ws-row[data-row="' + rowIdx + '"]');
    if (!rowEl) return;
    const a = rowEl.querySelector('.ws-row-arch-primary');
    const b = rowEl.querySelector('.ws-row-arch-secondary');
    // clear all rows' badges first
    _els.rowList.querySelectorAll(".ws-row-arch-primary, .ws-row-arch-secondary").forEach(el => {
        el.textContent = ""; el.className = el.className.replace(/\bws-arch-\w+\b/g, "").trim();
        if (el.classList.contains("ws-row-arch-primary")) el.classList.add("ws-arch-badge", "ws-row-arch-primary");
        else el.classList.add("ws-arch-badge", "ws-row-arch-secondary");
    });
    if (a && WS.inspectA) { a.textContent = WS.inspectA.architecture?.details || ""; a.classList.add("ws-arch-" + (WS.inspectA.architecture?.arch || "unknown")); }
    if (b && WS.inspectB) { b.textContent = WS.inspectB.architecture?.details || ""; b.classList.add("ws-arch-" + (WS.inspectB.architecture?.arch || "unknown")); }
}

// ========================================================================
// CHAIN ANALYSIS — equalize alphas and preview final contributions
// ========================================================================

// Methods we treat as `(1 - α)·A + α·B` for the contribution math. Exact
// for weighted_sum / slerp / svd_blend; the task-vector and SVD-split
// methods land here as a reasonable first-order approximation (their
// per-key processing alters the magnitude of B's task vector but the
// global "how much A vs B is in the result" still reads as α). cosine_-
// adaptive picks α per key, so it has no global value to surface, and
// add_difference subtracts a third tensor — both stay out of the linear
// model and short-circuit the preview.
const _LINEAR_CONTRIB_METHODS = new Set([
    "weighted_sum", "slerp", "svd_blend",
    "ties", "dare", "dare_ties", "della", "della_ties", "breadcrumbs",
    "star", "svd_struct_a_mag_b", "svd_struct_b_mag_a",
]);

// { rowIdx → { filename: weight } | null }, where null means the row's
// output cannot be expressed as a linear mix of concrete files.
function _rowOutputContrib(rowIdx, cache) {
    if (rowIdx in cache) return cache[rowIdx];
    const r = WS.rows[rowIdx];
    if (!r) { cache[rowIdx] = null; return null; }

    function slotContrib(slotValue) {
        if (!slotValue) return null;
        if (_isRefValue(slotValue)) {
            const refIdx = _rowIndexById(_refRowId(slotValue));
            return refIdx >= 0 ? _rowOutputContrib(refIdx, cache) : null;
        }
        return { [slotValue]: 1.0 };
    }

    if (!r.primary || !r.secondary) {
        cache[rowIdx] = slotContrib(r.primary);
        return cache[rowIdx];
    }

    if (!_LINEAR_CONTRIB_METHODS.has(r.method)) {
        cache[rowIdx] = null;
        return null;
    }

    const primaryC = slotContrib(r.primary);
    const secondaryC = slotContrib(r.secondary);
    if (!primaryC || !secondaryC) { cache[rowIdx] = null; return null; }

    const alpha = Math.max(0, Math.min(1, Number(r.alpha) || 0));
    const out = {};
    for (const k of Object.keys(primaryC)) out[k] = (out[k] || 0) + (1 - alpha) * primaryC[k];
    for (const k of Object.keys(secondaryC)) out[k] = (out[k] || 0) + alpha * secondaryC[k];
    cache[rowIdx] = out;
    return out;
}

// True if every merge row in the board uses a method we model linearly.
function _chainIsLinearModel() {
    for (const r of WS.rows) {
        if (!r.primary || !r.secondary) continue;
        if (!_LINEAR_CONTRIB_METHODS.has(r.method)) return false;
    }
    return true;
}

// Compute the final-output composition (or null if the chain has no
// merge rows or contains a non-linear method that breaks the math).
function _finalContributions() {
    const finalIdx = _finalMergeRowIdx();
    if (finalIdx < 0) return null;
    return _rowOutputContrib(finalIdx, {});
}

// Shape: { ok: true, chain: [rowIdx,…], headFile } when the board is a
// linear accumulator (Row k's primary = Row k-1's output; Row k's
// secondary = a concrete file). { ok: false, reason } otherwise.
function _detectAccumulatorChain() {
    const finalIdx = _finalMergeRowIdx();
    if (finalIdx < 0) return { ok: false, reason: "No merge rows on the board" };
    const chain = [];
    let idx = finalIdx;
    while (idx >= 0) {
        const r = WS.rows[idx];
        if (!r || !r.primary || !r.secondary) {
            return { ok: false, reason: "Row " + (idx + 1) + " is not a complete merge" };
        }
        if (r.method !== "weighted_sum" && r.method !== "slerp") {
            return { ok: false, reason: "Row " + (idx + 1) + " uses " + r.method + " — equalize only supports weighted_sum and slerp" };
        }
        if (!_isConcreteModel(r.secondary)) {
            return { ok: false, reason: "Row " + (idx + 1) + ": Secondary must be a concrete model" };
        }
        chain.unshift(idx);
        if (_isConcreteModel(r.primary)) {
            return { ok: true, chain, headFile: r.primary };
        }
        if (!_isRefValue(r.primary)) {
            return { ok: false, reason: "Row " + (idx + 1) + ": Primary must be a model or the previous row's output" };
        }
        const prevIdx = _rowIndexById(_refRowId(r.primary));
        if (prevIdx !== idx - 1) {
            return { ok: false, reason: "Row " + (idx + 1) + " does not reference the row above it" };
        }
        idx = prevIdx;
    }
    return { ok: false, reason: "Chain head not reached" };
}

function _equalizeChain() {
    const det = _detectAccumulatorChain();
    if (!det.ok) {
        if (window.showToast) window.showToast("Cannot equalize: " + det.reason, "warning");
        return;
    }
    // For an n-row accumulator chain there are n+1 sources. Equal weight
    // per source means α for the kth row (1-indexed) is 1/(k+1):
    //   Row 1 α = 1/2   Row 2 α = 1/3   …   Row n α = 1/(n+1)
    for (let k = 0; k < det.chain.length; k++) {
        const r = WS.rows[det.chain[k]];
        const alpha = 1 / (k + 2);
        r.alpha = alpha;
        // Per-block weights are intentionally left alone — they're
        // user customization, not part of the equalization story. If
        // they wanted equal contribution per block they'd flip blocks
        // off first.
    }
    _renderRows();
    if (window.showToast) {
        const pct = (100 / (det.chain.length + 1)).toFixed(2);
        window.showToast("Equalized " + det.chain.length + " row" + (det.chain.length === 1 ? "" : "s") + " — each source contributes " + pct + "%", "success");
    }
}

function _renderChainContrib() {
    if (!_els.chainContrib) return;
    const finalIdx = _finalMergeRowIdx();
    if (finalIdx < 0) {
        _els.chainContrib.innerHTML = '<span class="ws-chain-contrib-empty">Add a complete merge row to see the final composition.</span>';
        if (_els.equalizeBtn) _els.equalizeBtn.disabled = true;
        return;
    }
    if (!_chainIsLinearModel()) {
        _els.chainContrib.innerHTML = '<span class="ws-chain-contrib-empty">Composition preview unavailable — chain uses Cosine Adaptive or Add Difference.</span>';
        const det = _detectAccumulatorChain();
        if (_els.equalizeBtn) _els.equalizeBtn.disabled = !det.ok;
        return;
    }
    const contrib = _finalContributions();
    if (!contrib || !Object.keys(contrib).length) {
        _els.chainContrib.innerHTML = '<span class="ws-chain-contrib-empty">Add a complete merge row to see the final composition.</span>';
        if (_els.equalizeBtn) _els.equalizeBtn.disabled = true;
        return;
    }

    // Show concrete files only — anything left as null upstream gets
    // rolled into "Unknown source". Sort largest contribution first.
    const entries = Object.entries(contrib)
        .map(([k, v]) => [k, +v])
        .filter(([, v]) => v > 0.0005)
        .sort((a, b) => b[1] - a[1]);

    const total = entries.reduce((s, [, v]) => s + v, 0);
    let html = '<div class="ws-chain-contrib-title">Final composition</div>';
    html += '<div class="ws-chain-contrib-list">';
    for (const [name, weight] of entries) {
        const pct = (weight * 100).toFixed(2);
        const barPct = Math.max(2, weight * 100).toFixed(2);
        html += '<div class="ws-chain-contrib-row" title="' + _esc(name) + '">'
            + '<span class="ws-chain-contrib-name">' + _esc(name) + '</span>'
            + '<div class="ws-chain-contrib-bar"><div class="ws-chain-contrib-bar-fill" style="width:' + barPct + '%;"></div></div>'
            + '<span class="ws-chain-contrib-pct">' + pct + '%</span>'
            + '</div>';
    }
    if (Math.abs(total - 1.0) > 0.001) {
        html += '<div class="ws-chain-contrib-note">Weights sum to ' + (total * 100).toFixed(2) + '% (chain has incomplete rows).</div>';
    }
    // Approximation note for non-exact methods.
    const usesApprox = WS.rows.some(r => r.primary && r.secondary
        && _LINEAR_CONTRIB_METHODS.has(r.method)
        && r.method !== "weighted_sum" && r.method !== "slerp" && r.method !== "svd_blend");
    if (usesApprox) {
        html += '<div class="ws-chain-contrib-note">Approximate — task-vector / SVD-split methods filter B before adding.</div>';
    }
    // Per-block weights override the global alpha per-block; the preview
    // shows the global mix only.
    const usesBlocks = WS.rows.some(r => r.primary && r.secondary && r.useBlockWeights);
    if (usesBlocks) {
        html += '<div class="ws-chain-contrib-note">Per-block weights override the global alpha — actual contribution varies by block.</div>';
    }
    html += '</div>';
    _els.chainContrib.innerHTML = html;

    const det = _detectAccumulatorChain();
    if (_els.equalizeBtn) _els.equalizeBtn.disabled = !det.ok;
    if (_els.equalizeBtn) _els.equalizeBtn.title = det.ok
        ? "Set every row's alpha so each source contributes equally to the final output."
        : det.reason;
}

// ========================================================================
// ACTION-BUTTON & PROGRESS UPDATES
// ========================================================================

function _validateRows() {
    // Returns null when the board can be assembled into a chain. Empty
    // rows are silently ignored (the user adds blanks then fills them
    // in). A row with only Primary is allowed — it acts as a checkpoint
    // source for LoRA / VAE bake-only flows.
    if (WS.rows.length === 0) return "No rows on the board";
    for (let i = 0; i < WS.rows.length; i++) {
        const r = WS.rows[i];
        const hasA = !!r.primary, hasB = !!r.secondary;
        if (!hasA && !hasB) continue;                       // empty row
        if (!hasA && hasB) return "Row " + (i + 1) + ": Secondary set without Primary";
        if (hasA && !hasB) continue;                        // primary-only — bake source
        // Full merge row
        if (r.primary === r.secondary) return "Row " + (i + 1) + ": Primary and Secondary must differ";
        const info = METHOD_INFO[r.method] || {};
        if (info.needsC) {
            if (!r.tertiary) return "Row " + (i + 1) + " (Add Difference): Tertiary required";
            if (r.tertiary === r.primary || r.tertiary === r.secondary) return "Row " + (i + 1) + ": Tertiary must differ from Primary and Secondary";
        }
        // Refs must point at earlier rows (UI never offers later ones, but
        // verify just in case state was edited externally).
        for (const slot of ["primary", "secondary", "tertiary"]) {
            const v = r[slot];
            if (_isRefValue(v)) {
                const refIdx = _rowIndexById(_refRowId(v));
                if (refIdx < 0) return "Row " + (i + 1) + " " + slot + ": referenced row missing";
                if (refIdx >= i) return "Row " + (i + 1) + " " + slot + ": cannot reference itself or a later row";
            }
        }
    }
    return null;
}

function _updateActionButtons() {
    const hasLoras = WS.recipeLoras.some(l => l.filename);
    // Per-row VAE bake only fires for full merge rows; count it that way.
    const hasPerRowVae = WS.rows.some(r => r.primary && r.secondary && r.bakeVae && r.vae);
    const hasVae = !!WS.recipeVae || hasPerRowVae;
    const validationError = _validateRows();
    const hasMergeRow = WS.rows.some(r => r.primary && r.secondary);
    const hasAnyPrimary = WS.rows.some(r => _isConcreteModel(r.primary));
    const hasBakes = hasLoras || hasVae;
    // Save is enabled when we'd produce at least one chain step:
    //   - a full merge row, or
    //   - a bake (LoRA / global VAE) plus at least one primary checkpoint.
    const hasOperation = hasMergeRow || (hasBakes && hasAnyPrimary);
    const saveReady = hasOperation && !validationError && !WS.merging && !WS.testMerging;
    if (_els.mergeBtn) _els.mergeBtn.disabled = !saveReady;

    if (_els.testMergeBtn) {
        _els.testMergeBtn.disabled = !_canTestMerge();
        _els.testMergeBtn.title = _getTestMergeTooltip();
    }

    for (let i = 0; i < WS.rows.length; i++) _updateRowAutoDiffButtons(i);

    if (_els.mergeBtn) {
        const chainSteps = _buildRecipeChain();
        _els.mergeBtn.textContent = chainSteps.length > 1
            ? "Begin Merge (" + chainSteps.length + " steps)"
            : "Begin Merge";
    }

    _renderChainContrib();
}

function _setMergeButtonState(merging) {
    if (!_els.mergeBtn) return;
    _els.mergeBtn.style.display = merging ? "none" : "";
    _els.cancelBtn.style.display = merging ? "" : "none";
    _els.progressSection.style.display = merging || WS.status === "complete" || WS.status === "error" || WS.status === "cancelled" ? "" : "none";
    _updateActionButtons();
}

function _renderProgress() {
    const pct = Math.round(WS.progress * 100);
    _els.progressFill.style.width = pct + "%";
    _els.progressText.textContent = (WS.chainTotal > 1 && WS.chainStep > 0)
        ? "Step " + WS.chainStep + "/" + WS.chainTotal + " — " + pct + "%"
        : pct + "%";
    _els.progressKeys.textContent = WS.keysTotal ? WS.keysDone + " / " + WS.keysTotal + " keys" : "";
    _els.progressTime.textContent = WS.elapsed ? WS.elapsed + "s" : "";
    _els.progressSection.style.display = "";
    const s = _els.progressStatus;
    if (WS.status === "complete") { s.textContent = _t("workshop.status.complete", "✓ Complete"); s.className = "ws-progress-status ws-status-ok"; _els.progressFill.className = "ws-progress-bar-fill ws-fill-ok"; }
    else if (WS.status === "error") {
        var errMsg = WS.error || _t("workshop.status.unknownError", "Unknown error");
        s.textContent = _t("workshop.status.error", "✗ " + errMsg, { error: errMsg });
        s.className = "ws-progress-status ws-status-err"; _els.progressFill.className = "ws-progress-bar-fill ws-fill-err";
    }
    else if (WS.status === "cancelled") { s.textContent = _t("workshop.status.cancelled", "— Cancelled"); s.className = "ws-progress-status ws-status-warn"; _els.progressFill.className = "ws-progress-bar-fill ws-fill-warn"; }
    else { s.textContent = ""; s.className = "ws-progress-status"; _els.progressFill.className = "ws-progress-bar-fill"; }
}

// ========================================================================
// INSPECTOR
// ========================================================================

function _renderInfo() {
    const r = _activeRow();
    const parts = [];

    if (r) {
        const rowLabel = _t("workshop.inspector.row", "Row " + (WS.activeRow + 1), { n: WS.activeRow + 1 });
        const activeLabel = _t("workshop.inspector.active", "Active: " + rowLabel, { label: rowLabel });
        const info = METHOD_INFO[r.method] || {};
        // Method label + formula stay verbatim (they're math/feature names);
        // the long description paragraph translates via workshop.method.<id>.desc,
        // falling back to the English string baked into METHOD_INFO.
        const desc = info.desc ? _t("workshop.method." + r.method + ".desc", info.desc) : "";
        parts.push('<div class="ws-info-block"><div class="ws-info-label">' + _esc(activeLabel) + '</div>'
            + '<div class="ws-info-row"><span>' + _t("workshop.inspector.method", "Method") + '</span><span>' + _esc(info.label || r.method) + '</span></div>'
            + (info.formula ? '<div class="ws-method-formula" title="' + _esc(info.formula) + '">' + _esc(info.formula) + '</div>' : '')
            + (desc ? '<div class="ws-method-help-text">' + _esc(desc) + '</div>' : '')
            + '</div>');
    }

    // Reference inputs that aren't files cannot be inspected.
    if (r && _isRefValue(r.primary)) {
        const refIdx = _rowIndexById(_refRowId(r.primary));
        parts.push('<div class="ws-info-block"><div class="ws-info-label">' + _t("workshop.inspector.primary", "Primary") + '</div><div class="ws-info-row"><span>Ref</span><span>' + _t("workshop.inspector.refOf", "Output of Row " + (refIdx + 1), { n: refIdx + 1 }) + '</span></div><div class="ws-card-hint">' + _t("workshop.inspector.resolvedAtMerge", "Resolved at merge time") + '</div></div>');
    }
    if (r && _isRefValue(r.secondary)) {
        const refIdx = _rowIndexById(_refRowId(r.secondary));
        parts.push('<div class="ws-info-block"><div class="ws-info-label">' + _t("workshop.inspector.secondary", "Secondary") + '</div><div class="ws-info-row"><span>Ref</span><span>' + _t("workshop.inspector.refOf", "Output of Row " + (refIdx + 1), { n: refIdx + 1 }) + '</span></div><div class="ws-card-hint">' + _t("workshop.inspector.resolvedAtMerge", "Resolved at merge time") + '</div></div>');
    }

    if (WS.inspectA) parts.push(_renderModelInfo(_t("workshop.inspector.primary", "Primary"), WS.inspectA));
    if (WS.inspectB) parts.push(_renderModelInfo(_t("workshop.inspector.secondary", "Secondary"), WS.inspectB));

    if (WS.compatibility) parts.push(_renderCompatibility(WS.compatibility));
    else if (WS.inspectA && WS.inspectB && WS.inspectA.architecture?.arch !== WS.inspectB.architecture?.arch) parts.push('<div class="ws-info-warning">' + _t("workshop.inspector.archMismatch", "⚠ Architecture mismatch — merge is not possible") + '</div>');

    if (WS.preflight) parts.push(_renderPreflight(WS.preflight));

    if (WS.diffLoading) parts.push('<div class="ws-info-block"><div class="ws-info-label">' + _t("workshop.label.blockDivergence", "Block Divergence") + '</div><div class="ws-diff-loading">' + _t("workshop.label.computingDiff", "Computing diff…") + '</div></div>');
    else if (WS.cosineDiff) parts.push(_renderCosineDiff(WS.cosineDiff));

    if (WS.healthLoading) parts.push('<div class="ws-info-block"><div class="ws-info-label">' + _t("workshop.label.healthScan", "Health Scan") + '</div><div class="ws-diff-loading">' + _t("workshop.label.scanningTensors", "Scanning tensors…") + '</div></div>');
    else if (WS.healthScan) parts.push(_renderHealth(WS.healthScan));

    if ((WS.inspectA || WS.inspectB) && !WS.healthLoading && !WS.healthScan) {
        parts.push('<div class="ws-info-block"><button class="ws-small-btn" id="wsHealthScanBtn" style="width:100%;">Scan Health</button></div>');
    }

    _els.infoContent.innerHTML = parts.length ? parts.join("") : '<div class="ws-info-placeholder">' + _t("workshop.inspector.placeholder", "Select models to inspect") + '</div>';
    const hBtn = _els.infoContent.querySelector("#wsHealthScanBtn");
    if (hBtn) hBtn.addEventListener("click", () => {
        const { a, b } = _activeInputs();
        runHealthScan(a || b);
    });

    _renderActiveArchBadges();
}

function _renderModelInfo(label, info) {
    const dtypes = Object.entries(info.dtypes || {}).map(([k, v]) => k + ": " + v).join(", ");
    let html = '<div class="ws-info-block"><div class="ws-info-label">' + label + '</div>'
        + '<div class="ws-info-row"><span>' + _t("workshop.inspector.architecture", "Architecture") + '</span><span>' + (info.architecture?.details || _t("workshop.inspector.unknown", "Unknown")) + '</span></div>'
        + '<div class="ws-info-row"><span>' + _t("workshop.inspector.keys", "Keys") + '</span><span>' + info.key_count.toLocaleString() + '</span></div>'
        + '<div class="ws-info-row"><span>' + _t("workshop.inspector.size", "Size") + '</span><span>' + info.size_gb + ' GB</span></div>'
        + '<div class="ws-info-row"><span>' + _t("workshop.inspector.dtypes", "Dtypes") + '</span><span>' + dtypes + '</span></div>';

    // Package breakdown — tells the user where the GB live (core / TE / VAE
    // / adapter / other), so an oversized merge is self-diagnosing.
    if (info.packages) {
        const pkgLabels = {
            core: _t("workshop.inspector.package.core", "Core"),
            text_encoder: _t("workshop.inspector.package.textEncoder", "Text Encoder"),
            vae: _t("workshop.inspector.package.vae", "VAE"),
            llm_adapter: _t("workshop.inspector.package.llmAdapter", "LLM Adapter"),
            other: _t("workshop.inspector.package.other", "Other"),
        };
        const pkgRows = [];
        for (const name of ["core", "text_encoder", "vae", "llm_adapter", "other"]) {
            const p = info.packages[name];
            if (!p || !p.keys) continue;
            const gb = (p.gb !== undefined ? p.gb : (p.bytes || 0) / (1024 ** 3)).toFixed(2);
            pkgRows.push('<div class="ws-info-row"><span>' + pkgLabels[name]
                + '</span><span>' + p.keys.toLocaleString() + ' keys / ' + gb + ' GB</span></div>');
        }
        if (pkgRows.length) {
            html += '<div class="ws-info-row ws-info-row-section"><span>'
                + _t("workshop.inspector.packages", "Packages")
                + '</span><span></span></div>' + pkgRows.join("");
        }
    }

    const mi = info.model_info || {};
    if (mi.prediction) html += '<div class="ws-info-row"><span>Prediction</span><span>' + _esc(mi.prediction) + '</span></div>';
    if (mi.base_model) html += '<div class="ws-info-row"><span>Base</span><span>' + _esc(mi.base_model) + '</span></div>';
    if (mi.resolution) html += '<div class="ws-info-row"><span>Resolution</span><span>' + _esc(mi.resolution) + '</span></div>';
    return html + '</div>';
}

function _renderPreflight(pf) {
    return '<div class="' + (pf.safe ? "ws-info-block" : "ws-info-block ws-info-warning-block") + '">'
        + '<div class="ws-info-label">' + _t("workshop.label.ramEstimate", "RAM Estimate") + '</div>'
        + '<div class="ws-info-row"><span>Output buffer</span><span>' + pf.output_buffer_gb + ' GB</span></div>'
        + '<div class="ws-info-row"><span>Overhead</span><span>~' + pf.overhead_gb + ' GB</span></div>'
        + '<div class="ws-info-row ws-info-row-highlight"><span>Peak estimate</span><span>' + pf.peak_gb + ' GB</span></div>'
        + '<div class="ws-info-row"><span>Available</span><span>' + pf.available_gb + ' / ' + pf.total_gb + ' GB</span></div>'
        + (pf.warning ? '<div class="ws-ram-warning">⚠ ' + _esc(pf.warning) + '</div>' : '') + '</div>';
}

function _renderCosineDiff(diff) {
    const blocks = diff.blocks || {}; const entries = Object.entries(blocks);
    if (!entries.length) return "";
    const specialBlocks = new Set(["BASE", "VAE", "OTHER"]);
    const unetEntries = entries.filter(([name]) => !specialBlocks.has(name));
    const specialEntries = entries.filter(([name]) => specialBlocks.has(name));
    const unetDivs = unetEntries.map(([, v]) => (1 - v.similarity) * 100);
    const minDiv = unetDivs.length ? Math.min(...unetDivs) : 0;
    const maxDiv = unetDivs.length ? Math.max(...unetDivs) : 1;

    function buildRows(rowEntries, rMin, rMax) {
        let html = "";
        for (const [name, info] of rowEntries) {
            const divPct = (1 - info.similarity) * 100;
            const color = _divColor(divPct, rMin, rMax);
            const barPct = rMax - rMin > 1e-9 ? ((divPct - rMin) / (rMax - rMin) * 100).toFixed(0) : "50";
            const tip = _getBlockTooltip(name);
            html += '<div class="ws-diff-row"><span class="ws-diff-name ws-has-tip"' + (tip ? ' data-tip="' + _esc(tip) + '"' : '') + '>' + name + '</span>'
                + '<div class="ws-diff-bar-bg"><div class="ws-diff-bar" style="width:' + Math.max(3, barPct) + '%;background:' + color + ';"></div></div>'
                + '<span class="ws-diff-val">' + divPct.toFixed(2) + '%</span></div>';
        }
        return html;
    }

    let unetHtml = buildRows(unetEntries, minDiv, maxDiv);
    let specialHtml = "";
    if (specialEntries.length) {
        const sDivs = specialEntries.map(([, v]) => (1 - v.similarity) * 100);
        specialHtml = '<div class="ws-diff-separator">Non-UNet</div>' + buildRows(specialEntries, Math.min(...sDivs), Math.max(...sDivs));
    }
    const nanWarn = diff.nan_keys ? '<div class="ws-diff-nan-warn">⚠ ' + diff.nan_keys + ' keys skipped (NaN weights — likely unused CLIP layers)</div>' : "";
    const globalDiv = ((1 - (diff.global_similarity || 0)) * 100).toFixed(2);

    return '<div class="ws-info-block ws-diff-block">'
        + '<div class="ws-info-label">' + _t("workshop.label.blockDivergence", "Block Divergence") + ' <span class="ws-diff-global">(global: ' + globalDiv + '% different)</span></div>'
        + '<div class="ws-diff-legend"><span style="color:var(--green);">◼ Similar</span><span style="color:var(--amber);">◼ Moderate</span><span style="color:var(--red);">◼ Divergent</span></div>'
        + '<div class="ws-diff-hint">Higher % = more different between the models. These are the blocks worth adjusting.</div>'
        + nanWarn + unetHtml + specialHtml + '</div>';
}

function _heatColor(t) {
    t = Math.max(0, Math.min(1, t));
    const style = getComputedStyle(document.documentElement);
    const green = style.getPropertyValue("--green").trim() || "#5dca85";
    const amber = style.getPropertyValue("--amber").trim() || "#efaa27";
    const red = style.getPropertyValue("--red").trim() || "#e24b4a";
    const parseHex = (h) => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
    const lerp = (a, b, k) => [Math.round(a[0]+(b[0]-a[0])*k), Math.round(a[1]+(b[1]-a[1])*k), Math.round(a[2]+(b[2]-a[2])*k)];
    const g = parseHex(green), a = parseHex(amber), r = parseHex(red);
    const c = t < 0.4 ? lerp(g, a, t / 0.4) : lerp(a, r, (t - 0.4) / 0.6);
    return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
}

function _divColor(div, min, max) {
    const range = max - min || 1;
    return _heatColor((div - min) / range);
}

function _renderCompatibility(compat) {
    const icons = { incompatible: "❌", caution: "⚠", compatible: "✔" };
    const colors = { incompatible: "var(--red)", caution: "var(--amber)", compatible: "var(--green)" };
    const labels = { incompatible: "Incompatible", caution: "Caution", compatible: "Compatible" };
    const v = compat.verdict;
    let html = '<div class="ws-info-block"><div class="ws-info-label">' + _t("workshop.label.compatibility", "Compatibility") + ' <span style="color:' + colors[v] + ';font-weight:600;font-size:10px;text-transform:none;letter-spacing:0;">' + icons[v] + ' ' + labels[v] + '</span></div>';
    for (const issue of (compat.issues || [])) {
        html += '<div class="ws-compat-item ws-compat-issue"><span style="color:var(--red);">✖</span> ' + _esc(issue.text) + '</div>';
        if (issue.detail) html += '<div class="ws-compat-detail">' + _esc(issue.detail) + '</div>';
    }
    for (const warn of (compat.warnings || [])) {
        html += '<div class="ws-compat-item ws-compat-warn"><span style="color:var(--amber);">⚠</span> ' + _esc(warn.text) + '</div>';
        if (warn.detail) html += '<div class="ws-compat-detail">' + _esc(warn.detail) + '</div>';
    }
    for (const note of (compat.info || [])) {
        html += '<div class="ws-compat-item ws-compat-ok"><span style="color:var(--green);">✔</span> ' + _esc(note.text) + '</div>';
    }
    return html + '</div>';
}

function _renderHealth(scan) {
    const icons = { healthy: "✔", minor: "⚠", warning: "⚠", critical: "❌" };
    const colors = { healthy: "var(--green)", minor: "var(--text-3)", warning: "var(--amber)", critical: "var(--red)" };
    const labels = {
        healthy:  _t("workshop.health.healthy",  "Healthy"),
        minor:    _t("workshop.health.minor",    "Minor Issues"),
        warning:  _t("workshop.health.warning",  "Warning"),
        critical: _t("workshop.health.critical", "Critical"),
    };
    const v = scan.verdict;
    let html = '<div class="ws-info-block"><div class="ws-info-label">' + _t("workshop.label.healthScan", "Health Scan") + ' <span style="color:' + colors[v] + ';font-weight:600;font-size:10px;text-transform:none;letter-spacing:0;">' + icons[v] + ' ' + labels[v] + '</span></div>';
    html += '<div class="ws-info-row"><span>' + _t("workshop.label.totalKeys", "Total keys") + '</span><span>' + scan.total_keys.toLocaleString() + '</span></div>';
    if (scan.total_nan > 0 && scan.nan_clip_only) {
        html += '<div class="ws-info-row" style="color:var(--text-3);"><span>' + _t("workshop.health.nanKeysClip", "NaN keys (CLIP)") + '</span><span>' + scan.total_nan + '</span></div>';
        html += '<div style="color:var(--text-4);font-size:9px;padding:2px 0;font-style:italic;">' + _t("workshop.health.knownArtifact", "Known artifact — unused CLIP encoder layers. Not a merge issue.") + '</div>';
    } else if (scan.total_nan > 0) {
        html += '<div class="ws-info-row" style="color:var(--red);"><span>' + _t("workshop.health.nanInfKeys", "NaN/Inf keys") + '</span><span>' + scan.total_nan + '</span></div>';
    }
    if (scan.total_zero > 0) html += '<div class="ws-info-row" style="color:var(--amber);"><span>' + _t("workshop.health.allZero", "All-zero keys") + '</span><span>' + scan.total_zero + '</span></div>';
    if (scan.total_collapsed > 0) html += '<div class="ws-info-row" style="color:var(--amber);"><span>' + _t("workshop.health.collapsed", "Collapsed variance") + '</span><span>' + scan.total_collapsed + '</span></div>';
    if (scan.verdict === "healthy" && scan.total_nan === 0) {
        html += '<div style="color:var(--green);font-size:10px;padding:4px 0;">' + _t("workshop.health.allClean", "No issues detected — all tensors look clean.") + '</div>';
    } else if (scan.verdict === "healthy" && scan.nan_clip_only) {
        html += '<div style="color:var(--green);font-size:10px;padding:4px 0;">' + _t("workshop.health.healthyClipArtifacts", "Model is healthy. NaN keys are expected CLIP artifacts.") + '</div>';
    }
    const problemBlocks = Object.entries(scan.blocks || {}).filter(([name, s]) => {
        if (scan.nan_clip_only && (name === "BASE" || name === "CLIP" || name === "OTHER") && s.nan_keys > 0 && s.zero_keys === 0 && s.collapsed_keys === 0) return false;
        return s.nan_keys > 0 || s.zero_keys > 0 || s.collapsed_keys > 0;
    });
    if (problemBlocks.length) {
        html += '<div style="margin-top:8px;border-top:1px solid var(--border-subtle);padding-top:8px;">';
        for (const [block, stats] of problemBlocks) {
            const issues = [];
            if (stats.nan_keys) issues.push('<span style="color:var(--red);">' + stats.nan_keys + ' NaN</span>');
            if (stats.zero_keys) issues.push('<span style="color:var(--amber);">' + stats.zero_keys + ' zero</span>');
            if (stats.collapsed_keys) issues.push('<span style="color:var(--amber);">' + stats.collapsed_keys + ' collapsed</span>');
            html += '<div class="ws-info-row"><span>' + block + '</span><span>' + issues.join(', ') + '</span></div>';
        }
        html += '</div>';
    }
    return html + '</div>';
}

// ========================================================================
// UTIL
// ========================================================================

function _esc(s) { if (!s) return ""; const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

// ========================================================================
// MODULE REGISTRATION
// ========================================================================

if (window.StudioModules) {
    StudioModules.register("workshop", {
        label: "Workshop", icon: "⚒",
        init(container, services) {
            console.log(TAG, "Initializing Workshop module v" + VERSION);
            if (!document.querySelector('link[href*="workshop.css"]')) {
                const link = document.createElement("link");
                link.rel = "stylesheet";
                link.href = "/studio/static/workshop.css?v=" + VERSION;
                document.head.appendChild(link);
            }
            _buildUI(container);
            _hookWebSocket();
            loadModels(); loadLoras(); loadVaes();
        },
        activate(container, services) {
            loadModels(); loadLoras(); loadVaes();
            fetchJSON(API + "/memory_status").then(status => {
                WS.memoryMergeActive = status.active;
                if (status.active) { _els.memoryStatus.style.display = ""; _els.memoryInfo.textContent = _t("workshop.status.inMemoryMerge", "In-memory merge active"); }
                else { _els.memoryStatus.style.display = "none"; }
            }).catch(() => {});
        },
        deactivate() {},
    });
} else { console.warn(TAG, "StudioModules not available — Workshop cannot register"); }

})();
