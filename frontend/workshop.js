/**
 * Forge Studio — Workshop Module (Frontend)
 * by ToxicHost & Moritz
 *
 * v0.7.0 — Recipe-based UI
 * Replaces the pipeline/chain step system with a unified recipe form:
 *   Model A → optionally merge with B → optionally fold in more models →
 *   apply LoRAs → bake VAE → save.
 *
 * Phase 0: Infrastructure — merge stack, model selection, progress
 * Phase 1: Cosine diff heatmap in inspector
 * Phase 2: Block weight sliders, presets, Model Stock auto-alpha, SLERP
 * Phase 3: In-memory merge — hot-swap UNet weights
 * Phase 4: Add Difference (Model C), TIES, DARE, DARE-TIES, Cosine Adaptive
 * Phase 4b: Educational layer — method descriptions, block tooltips, UX polish
 * Phase 5: Recipe UI — unified form, kill pipeline, chain assembled internally
 *
 * Registers via StudioModules.register("workshop", {...})
 */
(function () {
"use strict";

const TAG = "[Workshop]";
const API = "/studio/workshop";
const VERSION = "0.7.0";

// ========================================================================
// METHOD METADATA
// ========================================================================

const METHOD_INFO = {
    weighted_sum: {
        label: "Weighted Sum", needsC: false, params: [], blockWeights: true,
        showAlpha: true, alphaLabel: "Weight (A \u2190 \u2192 B)",
        alphaHint: "0 = 100% Model A. 1 = 100% Model B. 0.5 = equal blend.",
        desc: "The simplest merge \u2014 blends every weight between A and B by the alpha value. Good starting point for any merge. If results look washed out, try SLERP instead.",
    },
    slerp: {
        label: "SLERP", needsC: false, params: [], blockWeights: true,
        showAlpha: true, alphaLabel: "Weight (A \u2190 \u2192 B)",
        alphaHint: "0 = 100% Model A, 1 = 100% Model B.",
        desc: "Spherical interpolation \u2014 preserves the magnitude of weight vectors instead of averaging them. Usually produces sharper, more vibrant results than Weighted Sum at the same alpha. Best for blending two models of similar quality.",
    },
    add_difference: {
        label: "Add Difference", needsC: true, params: [], blockWeights: true,
        showAlpha: true, alphaLabel: "Strength",
        alphaHint: "How much of B\u2019s training to apply. 0.5 = half strength, 1.0 = full.",
        desc: "Extracts what Model B learned from Model C (its base), then applies that training to Model A. Use this to transplant a finetune\u2019s skills (e.g. anime style, specific subject) into a different model. Requires Model C \u2014 the base model B was finetuned from.",
    },
    ties: {
        label: "TIES", needsC: false, params: ["density"], blockWeights: false,
        showAlpha: true, alphaLabel: "Lambda (\u03bb)",
        alphaHint: "Strength of the trimmed task vector. Start at 0.5\u20131.0.",
        desc: "Trim, Elect Sign & Merge \u2014 extracts B\u2019s training over A, then trims away the weakest changes, keeping only the most significant ones. The Density parameter controls how aggressively to trim. Great for noisy finetunes where you want only the strongest signal.",
    },
    dare: {
        label: "DARE", needsC: false, params: ["drop_rate"], blockWeights: false,
        showAlpha: true, alphaLabel: "Lambda (\u03bb)",
        alphaHint: "Strength of the sparsified task vector. Start at 0.5\u20131.0.",
        desc: "Drop And REscale \u2014 randomly drops most of B\u2019s training changes and rescales the survivors to compensate. Neural networks are redundant, so even dropping 90% of changes often preserves the effect. Produces surprisingly clean results from messy finetunes.",
    },
    dare_ties: {
        label: "DARE-TIES", needsC: false, params: ["density", "drop_rate"], blockWeights: false,
        showAlpha: true, alphaLabel: "Lambda (\u03bb)",
        alphaHint: "Strength of the processed task vector. Start at 0.5\u20131.0.",
        desc: "Combines DARE and TIES \u2014 randomly drops changes first, then trims the survivors by magnitude. The most aggressive filtering. Best when B is a very noisy finetune and you want only the absolute strongest signal.",
    },
    cosine_adaptive: {
        label: "Cosine Adaptive", needsC: false, params: ["cosine_shift"], blockWeights: true,
        showAlpha: false, alphaLabel: null, alphaHint: null,
        desc: "Automatically computes a unique blend ratio for every weight based on how similar A and B are at that point. Where they already agree, it keeps A. Where they diverge, it incorporates B. The Shift parameter adjusts how conservative (positive) or aggressive (negative) the blending is. No alpha needed \u2014 the math decides.",
    },
    star: {
        label: "STAR (Spectral)", needsC: false, params: ["eta"],
        blockWeights: true,
        showAlpha: true, alphaLabel: "Lambda (\u03bb)",
        alphaHint: "Strength of the denoised task vector. Start at 0.5\u20131.0.",
        desc: "Spectral Truncation and Rescale \u2014 decomposes B\u2019s training via SVD and strips noisy components before merging. Produces cleaner results than element-wise methods, especially from overtrained or messy finetunes. The Eta parameter controls how aggressively noise is removed.",
    },
    svd_struct_a_mag_b: {
        label: "SVD: Structure A + Mag B", needsC: false, params: [],
        blockWeights: true,
        showAlpha: true, alphaLabel: "Blend Strength",
        alphaHint: "0 = pure A. 1 = full spectral swap. Start at 0.3\u20130.5.",
        desc: "Decomposes both models via SVD, then takes A\u2019s feature directions (what the layer detects) and B\u2019s magnitudes (how strongly it responds). Example: photorealism model\u2019s composition + anime model\u2019s vibrancy. Produces results impossible from any weight-averaging method.",
    },
    svd_struct_b_mag_a: {
        label: "SVD: Structure B + Mag A", needsC: false, params: [],
        blockWeights: true,
        showAlpha: true, alphaLabel: "Blend Strength",
        alphaHint: "0 = pure A. 1 = full spectral swap. Start at 0.3\u20130.5.",
        desc: "The inverse \u2014 takes B\u2019s feature directions (what the layer detects) and A\u2019s magnitudes (how strongly it responds). Same concept as Structure A + Mag B but swapped. Try both and compare \u2014 the results are surprisingly different.",
    },
    svd_blend: {
        label: "SVD: Spectral Blend", needsC: false, params: [],
        blockWeights: true,
        showAlpha: true, alphaLabel: "Weight (A \u2190 \u2192 B)",
        alphaHint: "0 = pure A, 1 = pure B. Interpolates in spectral space.",
        desc: "Aligns both models\u2019 spectral decompositions via Procrustes rotation, then interpolates structure and magnitude together in spectral space. Smoother than Weighted Sum because it respects the geometric relationship between feature directions rather than averaging raw weights.",
    },
    della: {
        label: "DELLA", needsC: false, params: ["drop_rate"], blockWeights: false,
        showAlpha: true, alphaLabel: "Lambda (\u03bb)",
        alphaHint: "Strength of the sparsified task vector. Start at 0.5\u20131.0.",
        desc: "Like DARE but smarter about what it drops \u2014 drop probability is inversely proportional to magnitude, so large important changes survive while small noisy ones are more likely to be removed. Produces slightly more reliable results than DARE\u2019s uniform random masking.",
    },
    della_ties: {
        label: "DELLA-TIES", needsC: false, params: ["density", "drop_rate"], blockWeights: false,
        showAlpha: true, alphaLabel: "Lambda (\u03bb)",
        alphaHint: "Strength of the processed task vector. Start at 0.5\u20131.0.",
        desc: "Combines DELLA and TIES \u2014 magnitude-weighted dropout first, then trims survivors by magnitude. Like DARE-TIES but with smarter dropout that preferentially keeps important parameters.",
    },
    breadcrumbs: {
        label: "Breadcrumbs", needsC: false, params: ["density", "drop_rate"], blockWeights: false,
        showAlpha: true, alphaLabel: "Lambda (\u03bb)",
        alphaHint: "Strength of the trimmed task vector. Start at 0.5\u20131.0.",
        desc: "Dual-threshold trimming \u2014 like TIES but also removes the largest outlier changes, not just the smallest. Density controls the lower cutoff (how much to keep), Drop Rate controls the upper cutoff (how many outliers to remove). Best for finetunes with both noise and overfitting artifacts.",
    },
};

const PARAM_DEFS = {
    density: { label: "Density", min: 0, max: 1, step: 0.05, default: 0.2 },
    drop_rate: { label: "Drop Rate", min: 0, max: 0.99, step: 0.05, default: 0.9 },
    cosine_shift: { label: "Cosine Shift", min: -1, max: 1, step: 0.05, default: 0.0 },
    eta: { label: "Eta (\u03b7)", min: 0, max: 0.5, step: 0.01, default: 0.1 },
};

// ========================================================================
// BLOCK DESCRIPTIONS
// ========================================================================

const BLOCK_TOOLTIPS = {
    "Text Encoder": "Controls how text prompts are interpreted. Merging this changes what words mean to the model.",
    "Input Blocks": "Progressively compress the image. Early = fine details (texture, linework). Later = composition and structure.",
    "Middle": "Most compressed representation \u2014 the model\u2019s core understanding of the image. Affects global coherence.",
    "Output Blocks": "Expand back to full resolution. Early = structure/composition. Later = fine details and rendering quality.",
    "Double Stream Blocks": "FLUX dual-stream blocks. Process image and text simultaneously with cross-attention.",
    "Single Stream Blocks": "FLUX single-stream blocks. Process merged image+text representations.",
    "Joint Blocks": "SD3 MMDiT blocks. Jointly process image and text tokens at each layer.",
    "IN00": "Full res \u2014 Surface details: skin pores, hair strands, line quality",
    "IN01": "Full res \u2014 Fine textures and micro-patterns",
    "IN02": "Full res \u2014 Local color and fine shading",
    "IN03": "Half res \u2014 Mid-level features: facial features, fabric folds",
    "IN04": "Half res \u2014 Object parts and local structure",
    "IN05": "Half \u2192 quarter res \u2014 Transition to structural features",
    "IN06": "Quarter res \u2014 Large-scale shapes and object boundaries",
    "IN07": "Quarter res \u2014 Scene layout and spatial relationships",
    "IN08": "Quarter \u2192 eighth res \u2014 High-level composition",
    "IN09": "Eighth res \u2014 Abstract composition and pose",
    "IN10": "Eighth res \u2014 Global scene structure",
    "IN11": "Eighth res \u2014 Most abstract input representation",
    "M00": "Deepest layer \u2014 The model\u2019s core understanding of the whole image",
    "OUT00": "Eighth res \u2014 Mirrors IN11: rebuilding from abstract structure",
    "OUT01": "Eighth res \u2014 Large-scale composition decisions",
    "OUT02": "Eighth res \u2014 Spatial arrangement and layout",
    "OUT03": "Eighth \u2192 quarter res \u2014 Structure to shape transition",
    "OUT04": "Quarter res \u2014 Object shapes and boundaries",
    "OUT05": "Quarter res \u2014 Scene geometry and spatial detail",
    "OUT06": "Quarter \u2192 half res \u2014 Shape to feature transition",
    "OUT07": "Half res \u2014 Object details and mid-level features",
    "OUT08": "Half res \u2014 Fine structural details and rendering",
    "OUT09": "Half \u2192 full res \u2014 Feature to texture transition",
    "OUT10": "Full res \u2014 Surface rendering and shading style",
    "OUT11": "Full res \u2014 Final detail: texture, color, rendering quality",
    "BASE": "Text encoder weights \u2014 changes how prompts are understood",
    "VAE": "Image encoder/decoder \u2014 usually identical between models of the same architecture",
    "OTHER": "Miscellaneous keys not classified into standard blocks",
};

function _getBlockTooltip(name) { return BLOCK_TOOLTIPS[name] || null; }

// Compact method list for additional fold-in merges
const FOLD_METHODS = [
    { value: "weighted_sum", label: "Weighted Sum" },
    { value: "slerp", label: "SLERP" },
    { value: "add_difference", label: "Add Difference" },
    { value: "ties", label: "TIES" },
    { value: "dare", label: "DARE" },
    { value: "dare_ties", label: "DARE-TIES" },
    { value: "cosine_adaptive", label: "Cosine Adaptive" },
    { value: "star", label: "STAR" },
];

// ========================================================================
// STATE
// ========================================================================

const WS = {
    models: [], loras: [], vaes: [],
    // Primary merge
    modelA: null, modelB: null, modelC: null,
    method: "weighted_sum", alpha: 0.5,
    blockWeights: null, blockList: [], presets: {}, useBlockWeights: false, arch: null,
    density: 0.2, dropRate: 0.9, cosineShift: 0.0, eta: 0.1,
    // Recipe: additional fold-in models (each merges into running result)
    additionalMerges: [],  // [{model, method, alpha}]
    // Recipe: LoRAs to bake (applied after all merging)
    recipeLoras: [],  // [{filename, strength}]
    // Recipe: VAE to bake (applied last)
    recipeVae: null,
    // Output
    outputName: "", saveFp16: true,
    // Merge state
    merging: false, progress: 0, status: "idle", error: null, result: null,
    elapsed: 0, keysDone: 0, keysTotal: 0,
    memoryMergeActive: false, testMerging: false,
    // Inspector
    inspectA: null, inspectB: null, preflight: null, cosineDiff: null,
    compatibility: null, healthScan: null, healthLoading: false, diffLoading: false,
    // Journal
    journalEntries: [], journalSearch: "", journalFilter: "all", journalExpanded: null,
};
let _els = {};

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
        _populateModelSelects();
    } catch (e) {
        console.error(TAG, "Failed to load models:", e);
        if (window.showToast) window.showToast("Failed to load model list", "error");
    }
}

async function loadLoras() {
    try { WS.loras = await fetchJSON(API + "/loras"); } catch (e) { console.error(TAG, "Failed to load LoRAs:", e); }
}

async function loadVaes() {
    try { WS.vaes = await fetchJSON(API + "/vaes"); } catch (e) { console.error(TAG, "Failed to load VAEs:", e); }
}

async function refreshAssets() {
    // Ask the backend to rescan every configured asset directory, then
    // repopulate the Workshop dropdowns. Useful after moving files into
    // an external --ckpt-dir/--lora-dir or saving a new merge.
    const btn = _els && _els.refreshAssets;
    const prevLabel = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = "Scanning…"; }
    try {
        let summary = null;
        try { summary = await fetchJSON(API + "/refresh", { method: "POST" }); }
        catch (e) { console.error(TAG, "Refresh rescan failed:", e); }
        await Promise.all([loadModels(), loadLoras(), loadVaes()]);
        _populateVaeSelect();
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
// INSPECTION & PREFLIGHT
// ========================================================================

async function inspectModel(filename, which) {
    if (!filename) { WS[which === "A" ? "inspectA" : "inspectB"] = null; _onModelsChanged(); return; }
    try {
        const info = await fetchJSON(API + "/inspect?filename=" + encodeURIComponent(filename));
        WS[which === "A" ? "inspectA" : "inspectB"] = info;
        _onModelsChanged();
    } catch (e) { console.error(TAG, "Inspect " + which + " failed:", e); }
}

async function runPreflight() {
    if (!WS.modelA || !WS.modelB) { WS.preflight = null; _renderInfo(); return; }
    try {
        WS.preflight = await fetchJSON(API + "/preflight?model_a=" + encodeURIComponent(WS.modelA) + "&model_b=" + encodeURIComponent(WS.modelB));
        _renderInfo();
    } catch (e) { console.error(TAG, "Preflight failed:", e); }
}

async function runCompatibility() {
    if (!WS.modelA || !WS.modelB) { WS.compatibility = null; _renderInfo(); return; }
    try {
        WS.compatibility = await fetchJSON(API + "/compatibility?model_a=" + encodeURIComponent(WS.modelA) + "&model_b=" + encodeURIComponent(WS.modelB));
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
        if (window.showToast) window.showToast("Health scan failed: " + e.message, "error");
    }
    WS.healthLoading = false; _renderInfo();
}

async function loadCosineDiff() {
    if (!WS.modelA || !WS.modelB) { WS.cosineDiff = null; _renderInfo(); return; }
    WS.diffLoading = true; _renderInfo();
    try {
        WS.cosineDiff = await fetchJSON(API + "/cosine_diff?model_a=" + encodeURIComponent(WS.modelA) + "&model_b=" + encodeURIComponent(WS.modelB));
    } catch (e) {
        console.error(TAG, "Cosine diff failed:", e);
        if (window.showToast) window.showToast("Cosine diff failed: " + e.message, "error");
    }
    WS.diffLoading = false; _renderInfo();
}

async function loadPresets(arch) {
    try {
        const data = await fetchJSON(API + "/presets?arch=" + encodeURIComponent(arch));
        WS.presets = data.presets || {}; WS.blockList = data.blocks || [];
        _populatePresetSelect(); _buildBlockSliders();
    } catch (e) { console.error(TAG, "Presets failed:", e); }
}

async function loadModelStock() {
    if (!WS.modelA || !WS.modelB) return;
    try {
        if (window.showToast) window.showToast("Computing Model Stock auto-alpha...", "info");
        const data = await fetchJSON(API + "/model_stock?model_a=" + encodeURIComponent(WS.modelA) + "&model_b=" + encodeURIComponent(WS.modelB));
        if (data.alphas && Object.keys(data.alphas).length) {
            WS.blockWeights = data.alphas; WS.useBlockWeights = true; _els.blockToggle.checked = true;
            _syncBlockSlidersFromState(); _renderInfo();
            if (data.cosine_diff) {
                WS.cosineDiff = { blocks: data.cosine_diff, global_similarity: data.global_similarity, architecture: WS.inspectA?.architecture };
                _renderInfo();
            }
            if (window.showToast) window.showToast("Model Stock alphas applied", "success");
        }
    } catch (e) {
        console.error(TAG, "Model Stock failed:", e);
        if (window.showToast) window.showToast("Model Stock failed: " + e.message, "error");
    }
}

// ========================================================================
// RECIPE → CHAIN ASSEMBLY
// ========================================================================

function _buildRecipeChain() {
    /**
     * Converts the recipe form state into a chain of steps for the backend.
     *
     * Possible flows:
     *   Single model + LoRAs/VAE:
     *     step 1: lora_bake(modelA), step 2: vae_bake(__O1__)
     *   Two models + LoRAs/VAE:
     *     step 1: merge(A, B), step 2: lora_bake(__O1__), step 3: vae_bake(__O2__)
     *   Multi-model fold + LoRAs/VAE:
     *     step 1: merge(A, B), step 2: merge(__O1__, C), ..., step N: lora_bake, step N+1: vae_bake
     *
     * The output_name always goes on the LAST step.
     */
    const steps = [];
    let stepNum = 0;
    const isMerging = !!WS.modelB;

    // --- Primary merge ---
    if (isMerging) {
        stepNum++;
        const mergeParams = {
            model_a: WS.modelA, model_b: WS.modelB,
            method: WS.method, alpha: WS.alpha,
            block_weights: WS.useBlockWeights ? WS.blockWeights : null,
            save_fp16: WS.saveFp16,
        };
        const info = METHOD_INFO[WS.method] || {};
        if (info.needsC && WS.modelC) mergeParams.model_c = WS.modelC;
        if (info.params.includes("density")) mergeParams.density = WS.density;
        if (info.params.includes("drop_rate")) mergeParams.drop_rate = WS.dropRate;
        if (info.params.includes("cosine_shift")) mergeParams.cosine_shift = WS.cosineShift;
        if (info.params.includes("eta")) mergeParams.eta = WS.eta;
        steps.push({ step: stepNum, type: "merge", params: mergeParams });
    }

    // --- Additional fold-in merges ---
    for (const fold of WS.additionalMerges) {
        if (!fold.model) continue;
        stepNum++;
        const prevRef = stepNum === 1 ? WS.modelA : "__O" + (stepNum - 1) + "__";
        steps.push({
            step: stepNum, type: "merge",
            params: {
                model_a: prevRef, model_b: fold.model,
                method: fold.method || "weighted_sum",
                alpha: fold.alpha ?? 0.5,
                save_fp16: WS.saveFp16,
            },
        });
    }

    // --- LoRA bake ---
    const activeLoras = WS.recipeLoras.filter(l => l.filename);
    if (activeLoras.length) {
        stepNum++;
        const checkpoint = stepNum === 1 ? WS.modelA : "__O" + (stepNum - 1) + "__";
        steps.push({
            step: stepNum, type: "lora_bake",
            params: {
                checkpoint: checkpoint,
                loras: activeLoras.map(l => ({ filename: l.filename, strength: l.strength })),
                save_fp16: WS.saveFp16,
            },
        });
    }

    // --- VAE bake ---
    if (WS.recipeVae) {
        stepNum++;
        const checkpoint = stepNum === 1 ? WS.modelA : "__O" + (stepNum - 1) + "__";
        steps.push({
            step: stepNum, type: "vae_bake",
            params: {
                checkpoint: checkpoint,
                vae: WS.recipeVae,
                save_fp16: WS.saveFp16,
            },
        });
    }

    // --- Apply output_name to last step ---
    if (steps.length && WS.outputName) {
        steps[steps.length - 1].params.output_name = WS.outputName;
    }

    return steps;
}

function _canTestMerge() {
    // Test merge only works for simple 2-model merge with no post-processing
    return WS.modelA && WS.modelB
        && WS.additionalMerges.filter(m => m.model).length === 0
        && WS.recipeLoras.filter(l => l.filename).length === 0
        && !WS.recipeVae
        && !WS.merging && !WS.testMerging;
}

function _getTestMergeTooltip() {
    if (!WS.modelA || !WS.modelB) return "Select two models to test merge";
    if (WS.additionalMerges.filter(m => m.model).length > 0) return "Test merge unavailable with additional fold-in models";
    if (WS.recipeLoras.filter(l => l.filename).length > 0) return "Test merge unavailable with LoRAs \u2014 save to disk instead";
    if (WS.recipeVae) return "Test merge unavailable with VAE bake \u2014 save to disk instead";
    return "Hot-swap UNet weights \u2014 no disk write, instant iteration";
}

// ========================================================================
// MERGE / TEST / CANCEL
// ========================================================================

function _buildMergeBody() {
    // For test merge (simple 2-model only)
    const body = { model_a: WS.modelA, model_b: WS.modelB, alpha: WS.alpha, method: WS.method, block_weights: WS.useBlockWeights ? WS.blockWeights : null };
    const info = METHOD_INFO[WS.method] || {};
    if (info.needsC && WS.modelC) body.model_c = WS.modelC;
    if (info.params.includes("density")) body.density = WS.density;
    if (info.params.includes("drop_rate")) body.drop_rate = WS.dropRate;
    if (info.params.includes("cosine_shift")) body.cosine_shift = WS.cosineShift;
    if (info.params.includes("eta")) body.eta = WS.eta;
    return body;
}

async function startMerge() {
    if (WS.merging) return;
    const chainSteps = _buildRecipeChain();
    if (!chainSteps.length) {
        if (window.showToast) window.showToast("Nothing to do \u2014 add a merge, LoRA, or VAE first", "warning");
        return;
    }

    // Single merge with no post-processing? Use direct merge endpoint for simplicity
    if (chainSteps.length === 1 && chainSteps[0].type === "merge") {
        const body = _buildMergeBody();
        body.output_name = WS.outputName || null;
        body.save_fp16 = WS.saveFp16;
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

    // Multi-step: use chain endpoint
    try {
        WS.merging = true; WS.status = "running"; WS.progress = 0; WS.error = null; WS.result = null;
        _renderProgress(); _setMergeButtonState(true);
        if (window.showToast) window.showToast("Running " + chainSteps.length + "-step recipe\u2026", "info");
        await fetchJSON(API + "/chain", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ steps: chainSteps, save_intermediates: false }),
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
        WS.testMerging = true; _els.testMergeBtn.disabled = true; _els.testMergeBtn.textContent = "Merging\u2026";
        if (window.showToast) window.showToast("Computing in-memory merge\u2026", "info");
        const res = await fetchJSON(API + "/merge_memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        WS.memoryMergeActive = true; _renderMemoryStatus(res);
        if (res.validation?.passed) { if (window.showToast) window.showToast("Test merge applied in " + res.total_time + "s \u2014 generate to preview!", "success"); }
        else { if (window.showToast) window.showToast("Test merge applied but validation had warnings", "warning"); }
        if (res.non_unet_warning && window.showToast) window.showToast(res.non_unet_warning, "info");
    } catch (e) { WS.memoryMergeActive = false; if (window.showToast) window.showToast("Test merge failed: " + e.message, "error"); }
    finally { WS.testMerging = false; _els.testMergeBtn.textContent = "Test Merge"; _updateActionButtons(); }
}

async function revertMerge() {
    try {
        _els.revertBtn.disabled = true; _els.revertBtn.textContent = "Reverting\u2026";
        const res = await fetchJSON(API + "/revert", { method: "POST" });
        WS.memoryMergeActive = false; _els.memoryStatus.style.display = "none"; _updateActionButtons();
        if (window.showToast) window.showToast("Reverted in " + res.elapsed + "s", "success");
    } catch (e) { if (window.showToast) window.showToast("Revert failed: " + e.message, "error"); }
    finally { _els.revertBtn.disabled = false; _els.revertBtn.textContent = "Revert"; }
}

async function cancelMerge() { try { await fetchJSON(API + "/cancel", { method: "POST" }); } catch (e) { console.error(TAG, "Cancel failed:", e); } }

function _renderMemoryStatus(res) {
    _els.memoryStatus.style.display = "";
    _els.memoryInfo.textContent = res ? res.keys_loaded + " keys swapped in " + res.total_time + "s" : "";
    _updateActionButtons();
}

// ========================================================================
// RECIPE — LORA LIST
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
    return '<option value="">\u2014 Select LoRA \u2014</option>' + WS.loras.map(l => '<option value="' + _esc(l.filename) + '">' + _esc(l.filename) + '</option>').join("");
}

function _renderRecipeLoras() {
    if (!_els.loraList) return;
    let html = '';
    for (let i = 0; i < WS.recipeLoras.length; i++) {
        const l = WS.recipeLoras[i];
        html += '<div class="ws-lora-row" data-idx="' + i + '">'
            + '<div class="ws-lora-row-top">'
            + '<select class="param-select ws-model-select ws-rl-lora" data-idx="' + i + '">' + _getLoraOpts() + '</select>'
            + '<button class="ws-lora-remove-btn ws-rl-remove" data-idx="' + i + '" title="Remove">\u00d7</button>'
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
// RECIPE — ADDITIONAL FOLD-IN MERGES
// ========================================================================

function _addFoldMerge() {
    if (WS.additionalMerges.length >= 6) {
        if (window.showToast) window.showToast("Maximum 8 models total (A + B + 6 additional)", "warning");
        return;
    }
    WS.additionalMerges.push({ model: null, method: "weighted_sum", alpha: 0.5 });
    _renderFoldMerges();
    _updateActionButtons();
}

function _removeFoldMerge(idx) {
    WS.additionalMerges.splice(idx, 1);
    _renderFoldMerges();
    _updateActionButtons();
}

function _getModelOpts() {
    return '<option value="">\u2014 Select Model \u2014</option>' + WS.models.map(m => '<option value="' + _esc(m.filename) + '" title="' + m.size_gb + ' GB">' + _esc(m.filename) + ' (' + m.size_gb + ' GB)</option>').join("");
}

function _renderFoldMerges() {
    if (!_els.foldList) return;
    let html = '';
    for (let i = 0; i < WS.additionalMerges.length; i++) {
        const f = WS.additionalMerges[i];
        const methodOpts = FOLD_METHODS.map(m => '<option value="' + m.value + '"' + (m.value === f.method ? ' selected' : '') + '>' + m.label + '</option>').join("");
        html += '<div class="ws-fold-row" data-idx="' + i + '">'
            + '<div class="ws-fold-row-top">'
            + '<span class="ws-fold-label">\u2192</span>'
            + '<select class="param-select ws-model-select ws-fold-model" data-idx="' + i + '">' + _getModelOpts() + '</select>'
            + '<button class="ws-lora-remove-btn ws-fold-remove" data-idx="' + i + '" title="Remove">\u00d7</button>'
            + '</div>'
            + '<div class="ws-fold-row-bottom">'
            + '<select class="param-select ws-fold-method" data-idx="' + i + '" style="max-width:160px;">' + methodOpts + '</select>'
            + '<input type="range" min="0" max="1" step="0.01" value="' + f.alpha + '" class="ws-slider ws-fold-alpha" data-idx="' + i + '">'
            + '<span class="ws-fold-alpha-val" data-idx="' + i + '">' + f.alpha.toFixed(2) + '</span>'
            + '</div></div>';
    }
    _els.foldList.innerHTML = html;
    _bindFoldEvents();
}

function _bindFoldEvents() {
    _els.foldList.querySelectorAll(".ws-fold-model").forEach(sel => {
        const idx = parseInt(sel.dataset.idx);
        if (WS.additionalMerges[idx]?.model) sel.value = WS.additionalMerges[idx].model;
        sel.addEventListener("change", () => { WS.additionalMerges[idx].model = sel.value || null; _updateActionButtons(); });
    });
    _els.foldList.querySelectorAll(".ws-fold-method").forEach(sel => {
        const idx = parseInt(sel.dataset.idx);
        sel.addEventListener("change", () => { WS.additionalMerges[idx].method = sel.value; });
    });
    _els.foldList.querySelectorAll(".ws-fold-alpha").forEach(slider => {
        const idx = parseInt(slider.dataset.idx);
        const valEl = _els.foldList.querySelector('.ws-fold-alpha-val[data-idx="' + idx + '"]');
        slider.addEventListener("input", () => { WS.additionalMerges[idx].alpha = parseFloat(slider.value); if (valEl) valEl.textContent = parseFloat(slider.value).toFixed(2); });
    });
    _els.foldList.querySelectorAll(".ws-fold-remove").forEach(btn => {
        btn.addEventListener("click", () => _removeFoldMerge(parseInt(btn.dataset.idx)));
    });
}

// ========================================================================
// JOURNAL
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
        tags: [],
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

function _renderJournal() {
    let entries = WS.journalEntries;
    const search = WS.journalSearch.toLowerCase();
    const filter = WS.journalFilter;

    if (search) {
        entries = entries.filter(e =>
            (e.name || "").toLowerCase().includes(search) ||
            (e.notes || "").toLowerCase().includes(search) ||
            (e.tags || []).some(t => t.includes(search)) ||
            (e.type || "").includes(search) ||
            JSON.stringify(e.recipe || {}).toLowerCase().includes(search)
        );
    }
    if (filter && filter !== "all") {
        entries = entries.filter(e => e.type === filter);
    }

    if (!entries.length) {
        _els.journalList.innerHTML = '<div class="ws-info-placeholder" style="padding:32px 0;">'
            + (WS.journalEntries.length ? 'No matches for current filter' : 'No history yet \u2014 completed merges and bakes will appear here automatically')
            + '</div>';
        return;
    }

    let html = '';
    for (const e of entries.slice(0, 100)) {
        const isExpanded = WS.journalExpanded === e.id;
        const typeBadge = e.type === "merge" ? "Merge" : e.type === "lora_bake" ? "LoRA Bake" : e.type === "vae_bake" ? "VAE Bake" : e.type === "note" ? "Note" : e.type || "?";
        const date = e.date ? new Date(e.date).toLocaleDateString() : "";
        const elapsed = e.elapsed ? e.elapsed + "s" : "";
        const tags = (e.tags || []).map(t => '<span class="ws-journal-tag">' + _esc(t) + '</span>').join("");

        let starsHtml = '';
        for (let s = 1; s <= 5; s++) {
            const filled = s <= (e.rating || 0);
            starsHtml += '<span class="ws-journal-star' + (filled ? ' ws-star-filled' : '') + '" data-id="' + _esc(e.id) + '" data-rating="' + s + '">\u2605</span>';
        }

        html += '<div class="ws-journal-entry' + (isExpanded ? ' ws-je-expanded' : '') + '" data-id="' + _esc(e.id) + '">';
        html += '<div class="ws-journal-entry-header ws-je-toggle" data-id="' + _esc(e.id) + '">'
            + '<span class="ws-journal-type-badge ws-jt-' + (e.type || "unknown") + '">' + typeBadge + '</span>'
            + '<span class="ws-journal-name">' + _esc(e.name || "Untitled") + '</span>'
            + '<span class="ws-journal-stars-row">' + starsHtml + '</span>'
            + '<span class="ws-journal-date">' + date + '</span>'
            + '<span class="ws-je-chevron">' + (isExpanded ? '\u25b4' : '\u25be') + '</span>'
            + '</div>';

        if (isExpanded) {
            const recipe = e.recipe || {};
            html += '<div class="ws-je-body">';
            html += '<div class="ws-je-section"><div class="ws-je-section-label">Name</div>'
                + '<input type="text" class="ws-je-name-input" data-id="' + _esc(e.id) + '" value="' + _esc(e.name || '') + '" placeholder="Entry name">'
                + '</div>';
            if (Object.keys(recipe).length > 0) {
                html += '<div class="ws-je-section"><div class="ws-je-section-label">Recipe</div><div class="ws-je-recipe">';
                if (recipe.method) html += '<div class="ws-je-recipe-row"><span>Method</span><span>' + _esc(recipe.method) + '</span></div>';
                if (recipe.alpha !== undefined) html += '<div class="ws-je-recipe-row"><span>Alpha</span><span>' + recipe.alpha + '</span></div>';
                if (recipe.model_a) html += '<div class="ws-je-recipe-row"><span>Model A</span><span>' + _esc(recipe.model_a) + '</span></div>';
                if (recipe.model_b) html += '<div class="ws-je-recipe-row"><span>Model B</span><span>' + _esc(recipe.model_b) + '</span></div>';
                if (recipe.checkpoint) html += '<div class="ws-je-recipe-row"><span>Checkpoint</span><span>' + _esc(recipe.checkpoint) + '</span></div>';
                if (recipe.loras) { for (const l of recipe.loras) { html += '<div class="ws-je-recipe-row"><span>LoRA</span><span>' + _esc(l.filename) + ' @ ' + l.strength + '</span></div>'; } }
                if (recipe.vae) html += '<div class="ws-je-recipe-row"><span>VAE</span><span>' + _esc(recipe.vae) + '</span></div>';
                if (recipe.fp16 !== undefined) html += '<div class="ws-je-recipe-row"><span>fp16</span><span>' + (recipe.fp16 ? "Yes" : "No") + '</span></div>';
                if (elapsed) html += '<div class="ws-je-recipe-row"><span>Time</span><span>' + elapsed + '</span></div>';
                html += '</div></div>';
            }
            html += '<div class="ws-je-section"><div class="ws-je-section-label">Tags</div>'
                + '<div class="ws-je-tags">' + tags
                + '<input type="text" class="ws-je-tag-input" data-id="' + _esc(e.id) + '" placeholder="+ add tag" size="8">'
                + '</div></div>';
            html += '<div class="ws-je-section"><div class="ws-je-section-label">Notes</div>'
                + '<textarea class="ws-je-notes" data-id="' + _esc(e.id) + '" rows="3" placeholder="Add notes, observations, tested prompts...">' + _esc(e.notes || '') + '</textarea>'
                + '</div>';
            html += '<div class="ws-je-section"><div class="ws-je-section-label">Sample Image</div>'
                + '<div class="ws-je-image-area" data-id="' + _esc(e.id) + '">';
            if (e.image) {
                html += '<img src="' + API + '/journal/image/' + _esc(e.image) + '" class="ws-je-image">';
                html += '<button class="ws-je-image-remove" data-id="' + _esc(e.id) + '">Remove</button>';
            } else {
                html += '<div class="ws-je-image-drop" data-id="' + _esc(e.id) + '">Drop image here or <label class="ws-je-image-browse">browse<input type="file" accept="image/*" class="ws-je-image-input" data-id="' + _esc(e.id) + '" style="display:none;"></label></div>';
            }
            html += '</div></div>';
            html += '<div class="ws-je-actions">'
                + '<button class="ws-je-action-btn ws-je-delete" data-id="' + _esc(e.id) + '">Delete</button>'
                + '</div>';
            html += '</div>';
        }
        html += '</div>';
    }
    _els.journalList.innerHTML = html;
    _bindJournalEvents();
}

function _bindJournalEvents() {
    _els.journalList.querySelectorAll(".ws-je-toggle").forEach(el => {
        el.addEventListener("click", (ev) => {
            if (ev.target.classList.contains("ws-journal-star")) return;
            const id = el.dataset.id;
            WS.journalExpanded = WS.journalExpanded === id ? null : id;
            _renderJournal();
        });
    });
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
    _els.journalList.querySelectorAll(".ws-je-tag-input").forEach(input => {
        input.addEventListener("keydown", async (ev) => {
            if (ev.key !== "Enter") return;
            const id = input.dataset.id;
            const tag = input.value.trim().toLowerCase();
            if (!tag) return;
            const entry = WS.journalEntries.find(e => e.id === id);
            if (!entry) return;
            const tags = [...(entry.tags || [])];
            if (!tags.includes(tag)) tags.push(tag);
            try {
                await fetchJSON(API + "/journal/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, tags }) });
                entry.tags = tags;
                _renderJournal();
            } catch (e) { console.error(TAG, "Tag add failed:", e); }
        });
    });
    _els.journalList.querySelectorAll(".ws-journal-tag").forEach(el => {
        el.addEventListener("click", async () => {
            const entry_el = el.closest(".ws-journal-entry");
            const id = entry_el?.dataset.id;
            const tag = el.textContent.trim();
            const entry = WS.journalEntries.find(e => e.id === id);
            if (!entry) return;
            const tags = (entry.tags || []).filter(t => t !== tag);
            try {
                await fetchJSON(API + "/journal/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, tags }) });
                entry.tags = tags;
                _renderJournal();
            } catch (e) { console.error(TAG, "Tag remove failed:", e); }
        });
    });
    _els.journalList.querySelectorAll(".ws-je-notes").forEach(textarea => {
        textarea.addEventListener("blur", async () => {
            const id = textarea.dataset.id;
            const notes = textarea.value;
            const entry = WS.journalEntries.find(e => e.id === id);
            if (!entry || entry.notes === notes) return;
            try {
                await fetchJSON(API + "/journal/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, notes }) });
                entry.notes = notes;
            } catch (e) { console.error(TAG, "Notes save failed:", e); }
        });
    });
    _els.journalList.querySelectorAll(".ws-je-name-input").forEach(input => {
        input.addEventListener("blur", async () => {
            const id = input.dataset.id;
            const name = input.value.trim();
            const entry = WS.journalEntries.find(e => e.id === id);
            if (!entry || entry.name === name) return;
            try {
                await fetchJSON(API + "/journal/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, name }) });
                entry.name = name;
            } catch (e) { console.error(TAG, "Name save failed:", e); }
        });
    });
    _els.journalList.querySelectorAll(".ws-je-image-input").forEach(input => {
        input.addEventListener("change", (ev) => {
            const file = ev.target.files[0];
            if (!file || !file.type.startsWith("image/")) return;
            const id = input.dataset.id;
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    await fetchJSON(API + "/journal/image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, image: e.target.result }) });
                    await _loadJournal();
                } catch (e) { console.error(TAG, "Image upload failed:", e); }
            };
            reader.readAsDataURL(file);
        });
    });
    _els.journalList.querySelectorAll(".ws-je-image-drop").forEach(drop => {
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
    });
    _els.journalList.querySelectorAll(".ws-je-image-remove").forEach(btn => {
        btn.addEventListener("click", async () => {
            const id = btn.dataset.id;
            try {
                await fetchJSON(API + "/journal/image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, image: null }) });
                await _loadJournal();
            } catch (e) { console.error(TAG, "Image remove failed:", e); }
        });
    });
    _els.journalList.querySelectorAll(".ws-je-delete").forEach(btn => {
        btn.addEventListener("click", async () => {
            if (!confirm("Delete this entry?")) return;
            const id = btn.dataset.id;
            try {
                await fetchJSON(API + "/journal/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
                WS.journalEntries = WS.journalEntries.filter(e => e.id !== id);
                WS.journalExpanded = null;
                _renderJournal();
            } catch (e) { console.error(TAG, "Delete failed:", e); }
        });
    });
}

// ========================================================================
// CHANGE HANDLERS
// ========================================================================

function _onModelsChanged() {
    const arch = WS.inspectA?.architecture?.arch || WS.inspectB?.architecture?.arch || null;
    if (arch && arch !== WS.arch) { WS.arch = arch; loadPresets(arch); }
    WS.cosineDiff = null; _renderInfo();
}

function _onMethodChanged() {
    const info = METHOD_INFO[WS.method] || {};
    _els.modelCCard.style.display = info.needsC ? "" : "none";
    _els.alphaRow.style.display = info.showAlpha ? "" : "none";
    if (info.showAlpha) {
        _els.alphaLabel.textContent = info.alphaLabel || "Weight";
        _els.alphaHint.textContent = info.alphaHint || "";
        _els.alphaHint.style.display = info.alphaHint ? "" : "none";
    }
    const hasParams = info.params.length > 0;
    _els.methodParams.style.display = hasParams ? "" : "none";
    _els.densityRow.style.display = info.params.includes("density") ? "" : "none";
    _els.dropRateRow.style.display = info.params.includes("drop_rate") ? "" : "none";
    _els.cosineShiftRow.style.display = info.params.includes("cosine_shift") ? "" : "none";
    _els.etaRow.style.display = info.params.includes("eta") ? "" : "none";
    _els.blockSection.style.display = info.blockWeights ? "" : "none";
    if (!info.blockWeights && WS.useBlockWeights) {
        WS.useBlockWeights = false;
        _els.blockToggle.checked = false;
        _els.blockSliders.style.display = "none";
    }
    _renderMethodDesc();
    _updateActionButtons();
}

function _onModelBChanged() {
    // Show/hide merge controls based on whether Model B is selected
    const hasMerge = !!WS.modelB;
    _els.mergeControls.style.display = hasMerge ? "" : "none";
    _els.foldSection.style.display = hasMerge ? "" : "none";
    if (!hasMerge) {
        // Clear additional merges when disabling merge mode
        WS.additionalMerges = [];
        _renderFoldMerges();
    }
}

function _renderMethodDesc() {
    const info = METHOD_INFO[WS.method] || {};
    if (!info.desc) return;
    const infoEl = _els.inspectorBody.querySelector("#wsInfoContent");
    if (infoEl) {
        let html = '<div class="ws-info-block">'
            + '<div class="ws-info-label">' + (info.label || WS.method) + '</div>'
            + '<div class="ws-method-help-text">' + _esc(info.desc) + '</div>'
            + '</div>';
        const existing = infoEl.innerHTML;
        if (!existing.includes("ws-method-help-text")) {
            infoEl.innerHTML = html + existing.replace(/<div class="ws-info-placeholder">.*?<\/div>/s, '');
        } else {
            infoEl.innerHTML = html + existing.replace(/<div class="ws-info-block">.*?ws-method-help-text.*?<\/div><\/div>/s, '');
        }
    }
}

// ========================================================================
// WEBSOCKET
// ========================================================================

function _handleWsMessage(data) {
    if (data.type !== "workshop_progress") return;
    WS.progress = data.progress || 0; WS.status = data.status || "idle"; WS.error = data.error || null;
    WS.elapsed = data.elapsed || 0; WS.keysDone = data.keys_done || 0; WS.keysTotal = data.keys_total || 0;
    if (data.status === "complete" || data.status === "error" || data.status === "cancelled") {
        WS.merging = false; _setMergeButtonState(false);
        if (data.status === "complete") { if (window.showToast) window.showToast("Complete!", "success"); loadModels(); _loadJournal(); fetch(API + "/refresh_checkpoints", { method: "POST" }).catch(() => {}); }
        else if (data.status === "error") { if (window.showToast) window.showToast("Failed: " + data.error, "error"); }
        else if (data.status === "cancelled") { if (window.showToast) window.showToast("Cancelled", "warning"); }
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
// UI BUILDER
// ========================================================================

function _buildUI(container) {
    const methodOpts = Object.entries(METHOD_INFO).map(([val, info]) => '<option value="' + val + '">' + info.label + '</option>').join("");
    const vaeOpts = '<option value="">\u2014 None \u2014</option>';

    container.innerHTML = '<div class="ws-layout"><div class="ws-center">'
    + '<div class="ws-header"><span class="ws-title">Workshop</span><span class="ws-subtitle">v' + VERSION + '</span></div>'
    // Tab bar
    + '<div class="ws-tabs"><button class="ws-tab ws-tab-active" data-tab="recipe">Recipe</button><button class="ws-tab" data-tab="history">History</button></div>'

    // ── Recipe tab ──
    + '<div id="wsTabRecipe" class="ws-tab-content">'
    + '<div class="ws-stack">'
    + '<div class="ws-merge-panel">'

    // ── Models ──
    + '<div class="ws-merge-section ws-merge-models">'
    + '<div class="ws-merge-models-header"><span class="ws-merge-models-title">Models</span><button id="wsRefreshAssets" class="ws-small-btn ws-refresh-btn" title="Rescan every model, LoRA and VAE directory">↻ Refresh</button></div>'
    + '<div class="ws-merge-model-row"><label class="ws-merge-model-label">Model A <span class="ws-card-hint">(base)</span></label><select id="wsModelA" class="param-select ws-model-select"></select><div id="wsArchA" class="ws-arch-badge"></div></div>'
    + '<div class="ws-merge-model-row"><label class="ws-merge-model-label">Model B <span class="ws-card-hint">(merge with \u2014 leave empty for bake-only)</span></label><select id="wsModelB" class="param-select ws-model-select"></select><div id="wsArchB" class="ws-arch-badge"></div></div>'
    + '</div>'

    // ── Merge controls (hidden unless Model B selected) ──
    + '<div id="wsMergeControls" class="ws-merge-controls" style="display:none;">'
    + '<div class="ws-merge-section">'
    + '<div class="ws-merge-row"><div class="ws-merge-field ws-merge-method"><label>Method <button id="wsMethodHelp" class="ws-method-help-btn" title="About this method">?</button></label><select id="wsMethod" class="param-select">' + methodOpts + '</select></div></div>'
    + '<div class="ws-param ws-param-alpha" id="wsAlphaRow"><label id="wsAlphaLabel">Weight (A \u2190 \u2192 B)</label><div class="ws-alpha-row"><input type="range" id="wsAlphaSlider" min="0" max="1" step="0.01" value="0.5" class="ws-slider"><input type="number" id="wsAlphaVal" min="0" max="1" step="0.01" value="0.5" class="param-val ws-alpha-input"></div><div id="wsAlphaHint" class="ws-param-context-hint">0 = 100% Model A, 1 = 100% Model B. 0.5 = equal blend.</div></div>'
    + '</div>'
    // Model C (for Add Difference)
    + '<div id="wsModelCCard" class="ws-merge-section ws-merge-model-c" style="display:none;"><div class="ws-merge-model-row"><label class="ws-merge-model-label">Model C <span class="ws-card-hint">(base of B \u2014 for difference)</span></label><select id="wsModelC" class="param-select ws-model-select"></select><div class="ws-card-hint ws-c-hint">\u03b8_A + \u03b1\u00b7(\u03b8_B \u2212 \u03b8_C)</div></div></div>'
    // Method-specific params
    + '<div id="wsMethodParams" class="ws-merge-section ws-merge-method-params" style="display:none;">'
    + '<div id="wsDensityRow" class="ws-method-param-row" style="display:none;"><div class="ws-param"><label>Density <span class="ws-param-hint">(fraction to keep)</span></label><div class="ws-alpha-row"><input type="range" id="wsDensitySlider" min="0" max="1" step="0.05" value="0.2" class="ws-slider"><input type="number" id="wsDensityVal" min="0" max="1" step="0.05" value="0.2" class="param-val ws-alpha-input"></div><div class="ws-param-context-hint">Keeps the top N% of weight changes by magnitude. 0.2 = top 20%. Lower = cleaner but weaker effect.</div></div></div>'
    + '<div id="wsDropRateRow" class="ws-method-param-row" style="display:none;"><div class="ws-param"><label>Drop Rate <span class="ws-param-hint">(fraction to randomly drop)</span></label><div class="ws-alpha-row"><input type="range" id="wsDropRateSlider" min="0" max="0.99" step="0.05" value="0.9" class="ws-slider"><input type="number" id="wsDropRateVal" min="0" max="0.99" step="0.05" value="0.9" class="param-val ws-alpha-input"></div><div class="ws-param-context-hint">Randomly zeroes out this fraction of changes, rescales survivors. 0.9 = drop 90%, rescale 10\u00d7.</div></div></div>'
    + '<div id="wsCosineShiftRow" class="ws-method-param-row" style="display:none;"><div class="ws-param"><label>Cosine Shift <span class="ws-param-hint">(+ keep A, \u2212 take B)</span></label><div class="ws-alpha-row"><input type="range" id="wsCosineShiftSlider" min="-1" max="1" step="0.05" value="0" class="ws-slider"><input type="number" id="wsCosineShiftVal" min="-1" max="1" step="0.05" value="0" class="param-val ws-alpha-input"></div><div class="ws-param-context-hint">Biases the automatic blending. 0 = neutral. Positive = conservative (more A). Negative = aggressive (more B).</div></div></div>'
    + '<div id="wsEtaRow" class="ws-method-param-row" style="display:none;"><div class="ws-param"><label>Eta (\u03b7) <span class="ws-param-hint">(truncation threshold)</span></label><div class="ws-alpha-row"><input type="range" id="wsEtaSlider" min="0" max="0.5" step="0.01" value="0.1" class="ws-slider"><input type="number" id="wsEtaVal" min="0" max="0.5" step="0.01" value="0.1" class="param-val ws-alpha-input"></div><div class="ws-param-context-hint">Removes singular values below this fraction of the largest. 0 = keep everything (weighted sum). 0.1 = strip bottom 10%. Higher = more denoising.</div></div></div>'
    + '</div>'
    // Block weights
    + '<div class="ws-merge-section ws-merge-block-footer" id="wsBlockSection"><div class="ws-block-header"><label class="ws-checkbox-label"><input type="checkbox" id="wsBlockToggle"><span>Per-Block Weights</span></label><div class="ws-block-actions"><select id="wsPresetSelect" class="param-select ws-preset-select" disabled><option value="">\u2014 Preset \u2014</option></select><button id="wsModelStockBtn" class="ws-small-btn" disabled title="Auto-alpha via Model Stock">Auto</button><button id="wsDiffBtn" class="ws-small-btn" disabled title="Compute cosine similarity">Diff</button></div></div><div id="wsBlockSliders" class="ws-block-sliders" style="display:none;"></div></div>'
    + '</div>' // close merge controls

    // ── Additional fold-in models (shown when merging) ──
    + '<div id="wsFoldSection" class="ws-recipe-section" style="display:none;">'
    + '<div class="ws-recipe-section-header"><span class="ws-recipe-section-label">Additional Models</span><button id="wsFoldAdd" class="ws-bake-add-btn">+ Merge with another model</button></div>'
    + '<div id="wsFoldList" class="ws-fold-list"></div>'
    + '</div>'

    // ── LoRAs ──
    + '<div class="ws-recipe-section">'
    + '<div class="ws-recipe-section-header"><span class="ws-recipe-section-label">LoRAs</span><button id="wsLoraAdd" class="ws-bake-add-btn">+ Add LoRA</button></div>'
    + '<div id="wsLoraList" class="ws-lora-list"></div>'
    + '</div>'

    // ── VAE ──
    + '<div class="ws-recipe-section">'
    + '<div class="ws-recipe-section-header"><span class="ws-recipe-section-label">VAE</span></div>'
    + '<select id="wsRecipeVae" class="param-select ws-model-select">' + vaeOpts + '</select>'
    + '</div>'

    + '</div>' // close ws-merge-panel

    // ── Output ──
    + '<div class="ws-output-section"><div class="ws-param"><label>Output Filename</label><input type="text" id="wsOutputName" class="param-val ws-output-input" placeholder="auto-generated if empty" style="text-align:left;"></div><div class="ws-output-opts"><label class="ws-checkbox-label"><input type="checkbox" id="wsFp16" checked><span>Save as fp16</span></label></div></div>'

    // Memory status
    + '<div id="wsMemoryStatus" class="ws-memory-status" style="display:none;"><span class="ws-memory-badge">Test merge active</span><span id="wsMemoryInfo" class="ws-memory-info"></span><button id="wsRevertBtn" class="ws-revert-btn">Revert</button></div>'

    // Actions
    + '<div class="ws-action-row"><button id="wsTestMergeBtn" class="ws-test-merge-btn" disabled title="Hot-swap UNet weights \u2014 no disk write, instant iteration">Test Merge</button><button id="wsMergeBtn" class="ws-merge-btn" disabled>Save to Disk</button><button id="wsCancelBtn" class="ws-cancel-btn" style="display:none;">Cancel</button></div>'

    // Progress
    + '<div id="wsProgressSection" class="ws-progress-section" style="display:none;"><div class="ws-progress-bar-bg"><div id="wsProgressFill" class="ws-progress-bar-fill"></div></div><div class="ws-progress-info"><span id="wsProgressText">0%</span><span id="wsProgressKeys"></span><span id="wsProgressTime"></span></div><div id="wsProgressStatus" class="ws-progress-status"></div></div>'

    + '</div>'  // close ws-stack
    + '</div>'  // close wsTabRecipe

    // ── History tab ──
    + '<div id="wsTabHistory" class="ws-tab-content" style="display:none;">'
    + '<div class="ws-journal-toolbar">'
    + '<div class="ws-journal-toolbar-top">'
    + '<input type="text" id="wsJournalSearch" class="param-val ws-journal-search-input" placeholder="Search merges, LoRAs, tags...">'
    + '<button id="wsJournalAddEntry" class="ws-journal-add-btn">+ New Entry</button>'
    + '</div>'
    + '<div class="ws-journal-filters">'
    + '<button class="ws-journal-filter-btn ws-jf-active" data-filter="all">All</button>'
    + '<button class="ws-journal-filter-btn" data-filter="merge">Merges</button>'
    + '<button class="ws-journal-filter-btn" data-filter="lora_bake">LoRA</button>'
    + '<button class="ws-journal-filter-btn" data-filter="vae_bake">VAE</button>'
    + '</div></div>'
    + '<div id="wsJournalList" class="ws-journal-list"></div>'
    + '</div>'

    + '</div>'
    // Inspector
    + '<div class="ws-inspector" id="wsInspector"><div class="ws-inspector-header"><span>Inspector</span><button id="wsInspectorToggle" class="ws-inspector-toggle" title="Toggle inspector">\u25c0</button></div><div class="ws-inspector-body" id="wsInspectorBody"><div id="wsInfoContent" class="ws-info-content"><div class="ws-info-placeholder">Select models to inspect</div></div></div></div>'
    + '</div>';

    // ── Cache element refs ──
    _els = {
        modelA: container.querySelector("#wsModelA"), modelB: container.querySelector("#wsModelB"),
        modelC: container.querySelector("#wsModelC"), modelCCard: container.querySelector("#wsModelCCard"),
        mergeControls: container.querySelector("#wsMergeControls"),
        method: container.querySelector("#wsMethod"),
        alphaRow: container.querySelector("#wsAlphaRow"), alphaSlider: container.querySelector("#wsAlphaSlider"),
        alphaVal: container.querySelector("#wsAlphaVal"), alphaLabel: container.querySelector("#wsAlphaLabel"),
        alphaHint: container.querySelector("#wsAlphaHint"),
        outputName: container.querySelector("#wsOutputName"), fp16: container.querySelector("#wsFp16"),
        mergeBtn: container.querySelector("#wsMergeBtn"), cancelBtn: container.querySelector("#wsCancelBtn"),
        progressSection: container.querySelector("#wsProgressSection"), progressFill: container.querySelector("#wsProgressFill"),
        progressText: container.querySelector("#wsProgressText"), progressKeys: container.querySelector("#wsProgressKeys"),
        progressTime: container.querySelector("#wsProgressTime"), progressStatus: container.querySelector("#wsProgressStatus"),
        archA: container.querySelector("#wsArchA"), archB: container.querySelector("#wsArchB"),
        infoContent: container.querySelector("#wsInfoContent"),
        inspector: container.querySelector("#wsInspector"), inspectorToggle: container.querySelector("#wsInspectorToggle"),
        inspectorBody: container.querySelector("#wsInspectorBody"),
        blockSection: container.querySelector("#wsBlockSection"),
        blockToggle: container.querySelector("#wsBlockToggle"), blockSliders: container.querySelector("#wsBlockSliders"),
        presetSelect: container.querySelector("#wsPresetSelect"), modelStockBtn: container.querySelector("#wsModelStockBtn"),
        diffBtn: container.querySelector("#wsDiffBtn"),
        testMergeBtn: container.querySelector("#wsTestMergeBtn"), revertBtn: container.querySelector("#wsRevertBtn"),
        memoryStatus: container.querySelector("#wsMemoryStatus"), memoryInfo: container.querySelector("#wsMemoryInfo"),
        methodParams: container.querySelector("#wsMethodParams"),
        densityRow: container.querySelector("#wsDensityRow"), dropRateRow: container.querySelector("#wsDropRateRow"),
        cosineShiftRow: container.querySelector("#wsCosineShiftRow"), etaRow: container.querySelector("#wsEtaRow"),
        densitySlider: container.querySelector("#wsDensitySlider"), densityVal: container.querySelector("#wsDensityVal"),
        dropRateSlider: container.querySelector("#wsDropRateSlider"), dropRateVal: container.querySelector("#wsDropRateVal"),
        cosineShiftSlider: container.querySelector("#wsCosineShiftSlider"), cosineShiftVal: container.querySelector("#wsCosineShiftVal"),
        etaSlider: container.querySelector("#wsEtaSlider"), etaVal: container.querySelector("#wsEtaVal"),
        methodHelp: container.querySelector("#wsMethodHelp"),
        // Recipe sections
        foldSection: container.querySelector("#wsFoldSection"),
        foldList: container.querySelector("#wsFoldList"),
        foldAdd: container.querySelector("#wsFoldAdd"),
        loraList: container.querySelector("#wsLoraList"),
        loraAdd: container.querySelector("#wsLoraAdd"),
        recipeVae: container.querySelector("#wsRecipeVae"),
        refreshAssets: container.querySelector("#wsRefreshAssets"),
        // Tabs
        tabRecipe: container.querySelector("#wsTabRecipe"),
        tabHistory: container.querySelector("#wsTabHistory"),
        tabs: container.querySelectorAll(".ws-tab"),
        // Journal
        journalSearch: container.querySelector("#wsJournalSearch"),
        journalList: container.querySelector("#wsJournalList"),
        journalFilters: container.querySelectorAll(".ws-journal-filter-btn"),
        journalAddEntry: container.querySelector("#wsJournalAddEntry"),
    };
    _bindEvents();
    _renderMethodDesc();
}

// ========================================================================
// EVENT BINDING
// ========================================================================

function _bindEvents() {
    _els.modelA.addEventListener("change", () => {
        WS.modelA = _els.modelA.value || null;
        WS.compatibility = null; WS.healthScan = null;
        inspectModel(WS.modelA, "A"); runPreflight(); runCompatibility();
        _updateActionButtons();
    });
    _els.modelB.addEventListener("change", () => {
        WS.modelB = _els.modelB.value || null;
        WS.compatibility = null; WS.healthScan = null;
        inspectModel(WS.modelB, "B"); runPreflight(); runCompatibility();
        _onModelBChanged();
        _updateActionButtons();
    });
    _els.modelC.addEventListener("change", () => { WS.modelC = _els.modelC.value || null; _updateActionButtons(); });
    _els.alphaSlider.addEventListener("input", () => { WS.alpha = parseFloat(_els.alphaSlider.value); _els.alphaVal.value = WS.alpha.toFixed(2); });
    _els.alphaVal.addEventListener("change", () => { let v = parseFloat(_els.alphaVal.value); if (isNaN(v)) v = 0.5; v = Math.max(0, Math.min(1, v)); WS.alpha = v; _els.alphaSlider.value = v; _els.alphaVal.value = v.toFixed(2); });
    _els.method.addEventListener("change", () => { WS.method = _els.method.value; _onMethodChanged(); });
    _els.outputName.addEventListener("input", () => { WS.outputName = _els.outputName.value.trim(); });
    _els.fp16.addEventListener("change", () => { WS.saveFp16 = _els.fp16.checked; });
    _els.fp16.checked = WS.saveFp16;
    _els.mergeBtn.addEventListener("click", startMerge);
    _els.cancelBtn.addEventListener("click", cancelMerge);
    _els.inspectorToggle.addEventListener("click", () => { _els.inspector.classList.toggle("collapsed"); _els.inspectorToggle.textContent = _els.inspector.classList.contains("collapsed") ? "\u25b6" : "\u25c0"; });
    _els.blockToggle.addEventListener("change", () => {
        WS.useBlockWeights = _els.blockToggle.checked;
        _els.blockSliders.style.display = WS.useBlockWeights ? "" : "none";
        _els.presetSelect.disabled = !WS.useBlockWeights;
        _els.modelStockBtn.disabled = !WS.useBlockWeights || !WS.modelA || !WS.modelB;
        if (WS.useBlockWeights && !WS.blockWeights) _initBlockWeights(WS.alpha);
    });
    _els.presetSelect.addEventListener("change", () => {
        const name = _els.presetSelect.value; if (!name) return;
        const weights = WS.presets[name];
        if (weights === null || weights === undefined) { _initBlockWeights(WS.alpha); }
        else { WS.blockWeights = {}; for (const b of WS.blockList) WS.blockWeights[b] = (b in weights) ? weights[b] : WS.alpha; }
        _syncBlockSlidersFromState();
    });
    _els.modelStockBtn.addEventListener("click", loadModelStock);
    _els.diffBtn.addEventListener("click", loadCosineDiff);
    _els.testMergeBtn.addEventListener("click", testMerge);
    _els.revertBtn.addEventListener("click", revertMerge);
    _bindParamSlider(_els.densitySlider, _els.densityVal, (v) => { WS.density = v; });
    _bindParamSlider(_els.dropRateSlider, _els.dropRateVal, (v) => { WS.dropRate = v; });
    _bindParamSlider(_els.cosineShiftSlider, _els.cosineShiftVal, (v) => { WS.cosineShift = v; });
    _bindParamSlider(_els.etaSlider, _els.etaVal, (v) => { WS.eta = v; });
    _els.methodHelp.addEventListener("click", (e) => { e.preventDefault(); _renderMethodDesc(); });

    // Recipe events
    _els.loraAdd.addEventListener("click", _addRecipeLora);
    _els.foldAdd.addEventListener("click", _addFoldMerge);
    _els.recipeVae.addEventListener("change", () => { WS.recipeVae = _els.recipeVae.value || null; _updateActionButtons(); });

    // Rescan asset directories (checkpoints, LoRAs, VAEs) on demand
    if (_els.refreshAssets) _els.refreshAssets.addEventListener("click", refreshAssets);

    // Tab switching
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

    // Journal events
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

    _loadJournal();
}

function _bindParamSlider(slider, numInput, setter) {
    slider.addEventListener("input", () => { const v = parseFloat(slider.value); numInput.value = v.toFixed(2); setter(v); });
    numInput.addEventListener("change", () => { let v = parseFloat(numInput.value); if (isNaN(v)) v = parseFloat(slider.value); v = Math.max(parseFloat(slider.min), Math.min(parseFloat(slider.max), v)); slider.value = v; numInput.value = v.toFixed(2); setter(v); });
}

// ========================================================================
// BLOCK WEIGHT SLIDERS
// ========================================================================

function _initBlockWeights(alpha) { WS.blockWeights = {}; for (const b of WS.blockList) WS.blockWeights[b] = alpha; _syncBlockSlidersFromState(); }

function _buildBlockSliders() {
    if (!WS.blockList.length) { _els.blockSliders.innerHTML = '<div class="ws-info-placeholder">No blocks detected</div>'; return; }
    const groups = _groupBlocks(WS.blockList);
    let html = '';
    for (const group of groups) {
        if (group.label) {
            const tip = _getBlockTooltip(group.label);
            html += '<div class="ws-block-group-label ws-has-tip"' + (tip ? ' data-tip="' + _esc(tip) + '"' : '') + '>' + _esc(group.label) + (tip ? ' <span class="ws-tooltip-icon">?</span>' : '') + '</div>';
        }
        for (const block of group.blocks) {
            const val = WS.blockWeights?.[block] ?? WS.alpha;
            const tip = _getBlockTooltip(block);
            html += '<div class="ws-block-row" data-block="' + block + '">'
                + '<span class="ws-block-name ws-has-tip"' + (tip ? ' data-tip="' + _esc(tip) + '"' : '') + '>' + block + (tip ? ' <span class="ws-tooltip-icon">?</span>' : '') + '</span>'
                + '<input type="range" min="0" max="1" step="0.01" value="' + val + '" class="ws-block-slider" data-block="' + block + '">'
                + '<span class="ws-block-val" data-block="' + block + '">' + val.toFixed(2) + '</span></div>';
        }
    }
    _els.blockSliders.innerHTML = html;
    _els.blockSliders.querySelectorAll(".ws-block-slider").forEach(slider => {
        slider.addEventListener("input", (e) => {
            const block = e.target.dataset.block; const val = parseFloat(e.target.value);
            if (!WS.blockWeights) WS.blockWeights = {};
            WS.blockWeights[block] = val;
            const valSpan = _els.blockSliders.querySelector('.ws-block-val[data-block="' + block + '"]');
            if (valSpan) valSpan.textContent = val.toFixed(2);
        });
    });
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

function _syncBlockSlidersFromState() {
    if (!WS.blockWeights) return;
    _els.blockSliders.querySelectorAll(".ws-block-slider").forEach(slider => {
        const block = slider.dataset.block;
        if (block in WS.blockWeights) {
            slider.value = WS.blockWeights[block];
            const valSpan = _els.blockSliders.querySelector('.ws-block-val[data-block="' + block + '"]');
            if (valSpan) valSpan.textContent = WS.blockWeights[block].toFixed(2);
        }
    });
}

// ========================================================================
// UI UPDATES
// ========================================================================

function _populateModelSelects() {
    const opts = '<option value="">\u2014 Select Model \u2014</option>' + WS.models.map(m => '<option value="' + _esc(m.filename) + '" title="' + m.size_gb + ' GB">' + _esc(m.filename) + ' (' + m.size_gb + ' GB)</option>').join("");
    _els.modelA.innerHTML = opts; _els.modelB.innerHTML = opts; _els.modelC.innerHTML = opts;
    if (WS.modelA && WS.models.some(m => m.filename === WS.modelA)) _els.modelA.value = WS.modelA;
    if (WS.modelB && WS.models.some(m => m.filename === WS.modelB)) _els.modelB.value = WS.modelB;
    if (WS.modelC && WS.models.some(m => m.filename === WS.modelC)) _els.modelC.value = WS.modelC;
    // Also refresh fold merge dropdowns and VAE
    _renderFoldMerges();
    _populateVaeSelect();
}

function _populateVaeSelect() {
    if (!_els.recipeVae) return;
    const opts = '<option value="">\u2014 None \u2014</option>' + WS.vaes.map(v => '<option value="' + _esc(v.filename) + '">' + _esc(v.filename) + ' (' + v.size_mb + ' MB)</option>').join("");
    _els.recipeVae.innerHTML = opts;
    if (WS.recipeVae) _els.recipeVae.value = WS.recipeVae;
}

function _populatePresetSelect() {
    let html = '<option value="">\u2014 Preset \u2014</option>';
    for (const name of Object.keys(WS.presets)) html += '<option value="' + _esc(name) + '">' + _esc(name) + '</option>';
    _els.presetSelect.innerHTML = html;
}

function _updateActionButtons() {
    const info = METHOD_INFO[WS.method] || {};
    const hasC = !info.needsC || (WS.modelC && WS.modelC !== WS.modelA && WS.modelC !== WS.modelB);

    // Save button: needs Model A + at least one operation
    const hasLoras = WS.recipeLoras.some(l => l.filename);
    const hasVae = !!WS.recipeVae;
    const hasMerge = !!WS.modelB;
    const hasFolds = WS.additionalMerges.some(m => m.model);
    const hasOperation = hasMerge || hasLoras || hasVae;
    const mergeValid = !hasMerge || (WS.modelA !== WS.modelB && hasC);
    const saveReady = WS.modelA && hasOperation && mergeValid && !WS.merging && !WS.testMerging;
    _els.mergeBtn.disabled = !saveReady;

    // Test merge button
    const testReady = _canTestMerge() && hasC;
    _els.testMergeBtn.disabled = !testReady;
    _els.testMergeBtn.title = _getTestMergeTooltip();

    // Inspector buttons
    _els.diffBtn.disabled = !WS.modelA || !WS.modelB;
    _els.modelStockBtn.disabled = !WS.useBlockWeights || !WS.modelA || !WS.modelB;

    // Update save button label
    const chainSteps = _buildRecipeChain();
    if (chainSteps.length > 1) {
        _els.mergeBtn.textContent = "Save to Disk (" + chainSteps.length + " steps)";
    } else {
        _els.mergeBtn.textContent = "Save to Disk";
    }
}

function _setMergeButtonState(merging) {
    _els.mergeBtn.style.display = merging ? "none" : ""; _els.cancelBtn.style.display = merging ? "" : "none";
    _els.progressSection.style.display = merging || WS.status === "complete" || WS.status === "error" || WS.status === "cancelled" ? "" : "none";
    _updateActionButtons();
}

function _renderProgress() {
    const pct = Math.round(WS.progress * 100);
    _els.progressFill.style.width = pct + "%"; _els.progressText.textContent = pct + "%";
    _els.progressKeys.textContent = WS.keysTotal ? WS.keysDone + " / " + WS.keysTotal + " keys" : "";
    _els.progressTime.textContent = WS.elapsed ? WS.elapsed + "s" : "";
    _els.progressSection.style.display = "";
    const s = _els.progressStatus;
    if (WS.status === "complete") { s.textContent = "\u2713 Complete"; s.className = "ws-progress-status ws-status-ok"; _els.progressFill.className = "ws-progress-bar-fill ws-fill-ok"; }
    else if (WS.status === "error") { s.textContent = "\u2717 " + (WS.error || "Unknown error"); s.className = "ws-progress-status ws-status-err"; _els.progressFill.className = "ws-progress-bar-fill ws-fill-err"; }
    else if (WS.status === "cancelled") { s.textContent = "\u2014 Cancelled"; s.className = "ws-progress-status ws-status-warn"; _els.progressFill.className = "ws-progress-bar-fill ws-fill-warn"; }
    else { s.textContent = ""; s.className = "ws-progress-status"; _els.progressFill.className = "ws-progress-bar-fill"; }
}

// ========================================================================
// INSPECTOR
// ========================================================================

function _renderInfo() {
    const parts = [];
    if (WS.inspectA) { parts.push(_renderModelInfo("Model A", WS.inspectA)); _els.archA.textContent = WS.inspectA.architecture?.details || ""; _els.archA.className = "ws-arch-badge ws-arch-" + (WS.inspectA.architecture?.arch || "unknown"); }
    else { _els.archA.textContent = ""; _els.archA.className = "ws-arch-badge"; }
    if (WS.inspectB) { parts.push(_renderModelInfo("Model B", WS.inspectB)); _els.archB.textContent = WS.inspectB.architecture?.details || ""; _els.archB.className = "ws-arch-badge ws-arch-" + (WS.inspectB.architecture?.arch || "unknown"); }
    else { _els.archB.textContent = ""; _els.archB.className = "ws-arch-badge"; }
    if (WS.compatibility) parts.push(_renderCompatibility(WS.compatibility));
    else if (WS.inspectA && WS.inspectB && WS.inspectA.architecture?.arch !== WS.inspectB.architecture?.arch) parts.push('<div class="ws-info-warning">\u26a0 Architecture mismatch \u2014 merge is not possible</div>');
    if (WS.preflight) parts.push(_renderPreflight(WS.preflight));
    if (WS.diffLoading) parts.push('<div class="ws-info-block"><div class="ws-info-label">Block Divergence</div><div class="ws-diff-loading">Computing diff\u2026</div></div>');
    else if (WS.cosineDiff) parts.push(_renderCosineDiff(WS.cosineDiff));
    if (WS.healthLoading) parts.push('<div class="ws-info-block"><div class="ws-info-label">Health Scan</div><div class="ws-diff-loading">Scanning tensors\u2026</div></div>');
    else if (WS.healthScan) parts.push(_renderHealth(WS.healthScan));
    if ((WS.inspectA || WS.inspectB) && !WS.healthLoading && !WS.healthScan) {
        parts.push('<div class="ws-info-block"><button class="ws-small-btn" id="wsHealthScanBtn" style="width:100%;">Scan Health</button></div>');
    }
    _els.infoContent.innerHTML = parts.length ? parts.join("") : '<div class="ws-info-placeholder">Select models to inspect</div>';
    const hBtn = _els.infoContent.querySelector("#wsHealthScanBtn");
    if (hBtn) hBtn.addEventListener("click", () => { runHealthScan(WS.modelA || WS.modelB); });
}

function _renderModelInfo(label, info) {
    const dtypes = Object.entries(info.dtypes || {}).map(([k, v]) => k + ": " + v).join(", ");
    let html = '<div class="ws-info-block"><div class="ws-info-label">' + label + '</div>'
        + '<div class="ws-info-row"><span>Architecture</span><span>' + (info.architecture?.details || "Unknown") + '</span></div>'
        + '<div class="ws-info-row"><span>Keys</span><span>' + info.key_count.toLocaleString() + '</span></div>'
        + '<div class="ws-info-row"><span>Size</span><span>' + info.size_gb + ' GB</span></div>'
        + '<div class="ws-info-row"><span>Dtypes</span><span>' + dtypes + '</span></div>';
    const mi = info.model_info || {};
    if (mi.prediction) html += '<div class="ws-info-row"><span>Prediction</span><span>' + _esc(mi.prediction) + '</span></div>';
    if (mi.base_model) html += '<div class="ws-info-row"><span>Base</span><span>' + _esc(mi.base_model) + '</span></div>';
    if (mi.resolution) html += '<div class="ws-info-row"><span>Resolution</span><span>' + _esc(mi.resolution) + '</span></div>';
    return html + '</div>';
}

function _renderPreflight(pf) {
    return '<div class="' + (pf.safe ? "ws-info-block" : "ws-info-block ws-info-warning-block") + '">'
        + '<div class="ws-info-label">RAM Estimate</div>'
        + '<div class="ws-info-row"><span>Output buffer</span><span>' + pf.output_buffer_gb + ' GB</span></div>'
        + '<div class="ws-info-row"><span>Overhead</span><span>~' + pf.overhead_gb + ' GB</span></div>'
        + '<div class="ws-info-row ws-info-row-highlight"><span>Peak estimate</span><span>' + pf.peak_gb + ' GB</span></div>'
        + '<div class="ws-info-row"><span>Available</span><span>' + pf.available_gb + ' / ' + pf.total_gb + ' GB</span></div>'
        + (pf.warning ? '<div class="ws-ram-warning">\u26a0 ' + _esc(pf.warning) + '</div>' : '') + '</div>';
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
    const nanWarn = diff.nan_keys ? '<div class="ws-diff-nan-warn">\u26a0 ' + diff.nan_keys + ' keys skipped (NaN weights \u2014 likely unused CLIP layers)</div>' : "";
    const globalDiv = ((1 - (diff.global_similarity || 0)) * 100).toFixed(2);

    return '<div class="ws-info-block ws-diff-block">'
        + '<div class="ws-info-label">Block Divergence <span class="ws-diff-global">(global: ' + globalDiv + '% different)</span></div>'
        + '<div class="ws-diff-legend"><span style="color:var(--green);">\u25fc Similar</span><span style="color:var(--amber);">\u25fc Moderate</span><span style="color:var(--red);">\u25fc Divergent</span></div>'
        + '<div class="ws-diff-hint">Higher % = more different between the models. These are the blocks worth adjusting.</div>'
        + nanWarn + unetHtml + specialHtml + '</div>';
}

function _divColor(div, min, max) {
    const range = max - min || 1;
    const t = Math.max(0, Math.min(1, (div - min) / range));
    const style = getComputedStyle(document.documentElement);
    const green = style.getPropertyValue("--green").trim() || "#5dca85";
    const amber = style.getPropertyValue("--amber").trim() || "#efaa27";
    const red = style.getPropertyValue("--red").trim() || "#e24b4a";
    const parseHex = (h) => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
    const lerp = (a, b, t) => [Math.round(a[0]+(b[0]-a[0])*t), Math.round(a[1]+(b[1]-a[1])*t), Math.round(a[2]+(b[2]-a[2])*t)];
    const g = parseHex(green), a = parseHex(amber), r = parseHex(red);
    const c = t < 0.4 ? lerp(g, a, t / 0.4) : lerp(a, r, (t - 0.4) / 0.6);
    return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
}

function _renderMetadata(label, meta) {
    const entries = Object.entries(meta).slice(0, 20);
    const rows = entries.map(([k, v]) => {
        let display = v; try { display = JSON.stringify(JSON.parse(v), null, 2); } catch {}
        if (typeof display === "string" && display.length > 200) display = display.slice(0, 200) + "\u2026";
        return '<div class="ws-meta-row"><span class="ws-meta-key">' + _esc(k) + '</span><pre class="ws-meta-val">' + _esc(display) + '</pre></div>';
    }).join("");
    return '<div class="ws-info-block"><div class="ws-info-label">' + label + '</div>' + rows + '</div>';
}

function _renderCompatibility(compat) {
    const icons = { incompatible: "\u274c", caution: "\u26a0", compatible: "\u2714" };
    const colors = { incompatible: "var(--red)", caution: "var(--amber)", compatible: "var(--green)" };
    const labels = { incompatible: "Incompatible", caution: "Caution", compatible: "Compatible" };
    const v = compat.verdict;
    let html = '<div class="ws-info-block"><div class="ws-info-label">Compatibility <span style="color:' + colors[v] + ';font-weight:600;font-size:10px;text-transform:none;letter-spacing:0;">' + icons[v] + ' ' + labels[v] + '</span></div>';
    for (const issue of (compat.issues || [])) {
        html += '<div class="ws-compat-item ws-compat-issue"><span style="color:var(--red);">\u2716</span> ' + _esc(issue.text) + '</div>';
        if (issue.detail) html += '<div class="ws-compat-detail">' + _esc(issue.detail) + '</div>';
    }
    for (const warn of (compat.warnings || [])) {
        html += '<div class="ws-compat-item ws-compat-warn"><span style="color:var(--amber);">\u26a0</span> ' + _esc(warn.text) + '</div>';
        if (warn.detail) html += '<div class="ws-compat-detail">' + _esc(warn.detail) + '</div>';
    }
    for (const note of (compat.info || [])) {
        html += '<div class="ws-compat-item ws-compat-ok"><span style="color:var(--green);">\u2714</span> ' + _esc(note.text) + '</div>';
    }
    return html + '</div>';
}

function _renderHealth(scan) {
    const icons = { healthy: "\u2714", minor: "\u26a0", warning: "\u26a0", critical: "\u274c" };
    const colors = { healthy: "var(--green)", minor: "var(--text-3)", warning: "var(--amber)", critical: "var(--red)" };
    const labels = { healthy: "Healthy", minor: "Minor Issues", warning: "Warning", critical: "Critical" };
    const v = scan.verdict;
    let html = '<div class="ws-info-block"><div class="ws-info-label">Health Scan <span style="color:' + colors[v] + ';font-weight:600;font-size:10px;text-transform:none;letter-spacing:0;">' + icons[v] + ' ' + labels[v] + '</span></div>';
    html += '<div class="ws-info-row"><span>Total keys</span><span>' + scan.total_keys.toLocaleString() + '</span></div>';
    if (scan.total_nan > 0 && scan.nan_clip_only) {
        html += '<div class="ws-info-row" style="color:var(--text-3);"><span>NaN keys (CLIP)</span><span>' + scan.total_nan + '</span></div>';
        html += '<div style="color:var(--text-4);font-size:9px;padding:2px 0;font-style:italic;">Known artifact \u2014 unused CLIP encoder layers. Not a merge issue.</div>';
    } else if (scan.total_nan > 0) {
        html += '<div class="ws-info-row" style="color:var(--red);"><span>NaN/Inf keys</span><span>' + scan.total_nan + '</span></div>';
    }
    if (scan.total_zero > 0) html += '<div class="ws-info-row" style="color:var(--amber);"><span>All-zero keys</span><span>' + scan.total_zero + '</span></div>';
    if (scan.total_collapsed > 0) html += '<div class="ws-info-row" style="color:var(--amber);"><span>Collapsed variance</span><span>' + scan.total_collapsed + '</span></div>';
    if (scan.verdict === "healthy" && scan.total_nan === 0) {
        html += '<div style="color:var(--green);font-size:10px;padding:4px 0;">No issues detected \u2014 all tensors look clean.</div>';
    } else if (scan.verdict === "healthy" && scan.nan_clip_only) {
        html += '<div style="color:var(--green);font-size:10px;padding:4px 0;">Model is healthy. NaN keys are expected CLIP artifacts.</div>';
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
        label: "Workshop", icon: "\u2692",
        init(container, services) {
            console.log(TAG, "Initializing Workshop module v" + VERSION);
            if (!document.querySelector('link[href*="workshop.css"]')) { const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/studio/static/workshop.css?v=" + VERSION; document.head.appendChild(link); }
            _buildUI(container); _hookWebSocket(); loadModels(); loadLoras(); loadVaes();
        },
        activate(container, services) {
            loadModels(); loadLoras(); loadVaes();
            fetchJSON(API + "/memory_status").then(status => { WS.memoryMergeActive = status.active; if (status.active) { _els.memoryStatus.style.display = ""; _els.memoryInfo.textContent = "In-memory merge active"; } else { _els.memoryStatus.style.display = "none"; } }).catch(() => {});
        },
        deactivate() {},
    });
} else { console.warn(TAG, "StudioModules not available \u2014 Workshop cannot register"); }

})();
