/**
 * Forge Studio — Shared Generation State Snapshot
 * by ToxicHost & Moritz
 *
 * Single source of truth for "the user's current Generate-panel setup":
 *   - StudioDocs uses this for per-tab snapshot/restore.
 *   - StudioWorkflows uses this for save/apply of named profiles.
 *
 * Stable schema keys are used for storage so a future rename of a DOM id
 * does not invalidate saved profiles.
 *
 * Loaded BEFORE studio-docs.js. Depends only on basic DOM and the optional
 * StudioSearchableSelect + ExtensionBridge globals (gracefully degrades
 * when those aren't present).
 *
 * Apply intentionally never triggers an immediate model/VAE/TE load. The
 * change-listeners at app.js:2898 (paramModel), :2979 (paramVAE), and
 * :3011 (paramTextEncoder) only fire on `change` events — we set `.value`
 * directly and refresh the searchable-select label so the dropdown reads
 * correctly without kicking off an async load. The model loads naturally
 * on the next Generate.
 */
(function () {
"use strict";

var SCHEMA_VERSION = 1;

// Type semantics for FIELD_MAP entries:
//   "value"          — <input>/<select>, set via .value
//   "textarea"       — <textarea>, set via .value
//   "number"         — numeric .value, JSON-stored as a float
//   "int"            — numeric .value, JSON-stored as an integer
//   "collapseCheck"  — div.collapse-check: .classList toggles "checked"
//   "onClass"        — div.toggle-track:   .classList toggles "on"
//   "checkbox"       — real <input type=checkbox>: .checked property
//   "hidden"         — hidden <input>: .value (e.g. AR pool JSON strings)
//
// Optional flags:
//   dimension: true  — entry is skipped when applyDimensions === false
//   model:     true  — apply uses .value-only path (NO change dispatch),
//                      so paramModel / paramVAE / paramTextEncoder do not
//                      trigger an auto-reload.
//   prompt:    true  — entry is the positive prompt textarea
//   negPrompt: true  — entry is the negative prompt textarea

var FIELD_MAP = {
  // Prompts ----------------------------------------------------------------
  prompt:          { id: "paramPrompt",   type: "textarea", prompt: true },
  negative_prompt: { id: "paramNeg",      type: "textarea", negPrompt: true },

  // Model / VAE / TE -------------------------------------------------------
  model:           { id: "paramModel",       type: "value", model: true },
  vae:             { id: "paramVAE",         type: "value", model: true },
  text_encoder:    { id: "paramTextEncoder", type: "value", model: true },

  // Sampling ---------------------------------------------------------------
  sampler:    { id: "paramSampler",   type: "value" },
  scheduler:  { id: "paramScheduler", type: "value" },
  steps:      { id: "paramSteps",     type: "int" },
  cfg:        { id: "paramCFG",       type: "number" },
  denoise:    { id: "paramDenoise",   type: "number" },

  // Dimensions -------------------------------------------------------------
  width:      { id: "paramWidth",  type: "int", dimension: true },
  height:     { id: "paramHeight", type: "int", dimension: true },

  // Seed / batch -----------------------------------------------------------
  seed:                    { id: "paramSeed",            type: "int" },
  batch_count:             { id: "paramBatch",           type: "int" },
  batch_size:              { id: "paramBatchSize",       type: "int" },
  variation_seed:          { id: "paramVarSeed",         type: "int" },
  variation_strength:      { id: "paramVarStrength",     type: "number" },
  variation_strength_val:  { id: "paramVarStrengthVal",  type: "number" },
  resize_seed_w:           { id: "paramResizeSeedW",     type: "int" },

  // Hires ------------------------------------------------------------------
  hires_enabled:    { id: "checkHires",        type: "collapseCheck" },
  hires_upscaler:   { id: "paramHrUpscaler",   type: "value" },
  hires_scale:      { id: "paramHrScale",      type: "number" },
  hires_steps:      { id: "paramHrSteps",      type: "int" },
  hires_denoise:    { id: "paramHrDenoise",    type: "number" },
  hires_cfg:        { id: "paramHrCFG",        type: "number" },
  hires_checkpoint: { id: "paramHrCheckpoint", type: "value" },

  // ADetailer master + 3 slots --------------------------------------------
  ad_enabled:        { id: "checkAD",         type: "collapseCheck" },
  ad1_enabled:       { id: "checkAD1",        type: "collapseCheck" },
  ad1_model:         { id: "paramAD1Model",   type: "value" },
  ad1_conf:          { id: "paramAD1Conf",    type: "number" },
  ad1_denoise:       { id: "paramAD1Denoise", type: "number" },
  ad1_blur:          { id: "paramAD1Blur",    type: "number" },
  ad1_prompt:        { id: "paramAD1Prompt",  type: "textarea" },
  ad2_enabled:       { id: "checkAD2",        type: "collapseCheck" },
  ad2_model:         { id: "paramAD2Model",   type: "value" },
  ad2_conf:          { id: "paramAD2Conf",    type: "number" },
  ad2_denoise:       { id: "paramAD2Denoise", type: "number" },
  ad2_blur:          { id: "paramAD2Blur",    type: "number" },
  ad2_prompt:        { id: "paramAD2Prompt",  type: "textarea" },
  ad3_enabled:       { id: "checkAD3",        type: "collapseCheck" },
  ad3_model:         { id: "paramAD3Model",   type: "value" },
  ad3_conf:          { id: "paramAD3Conf",    type: "number" },
  ad3_denoise:       { id: "paramAD3Denoise", type: "number" },
  ad3_blur:          { id: "paramAD3Blur",    type: "number" },
  ad3_prompt:        { id: "paramAD3Prompt",  type: "textarea" },

  // ControlNet master + 2 units (image bytes intentionally omitted) -------
  cn_enabled:        { id: "checkCN",         type: "collapseCheck" },
  cn1_enabled:       { id: "checkCN1",        type: "collapseCheck" },
  cn1_module:        { id: "paramCN1Module",  type: "value" },
  cn1_model:         { id: "paramCN1Model",   type: "value" },
  cn1_source:        { id: "paramCN1Source",  type: "value" },
  cn1_weight:        { id: "paramCN1Weight",  type: "number" },
  cn1_start:         { id: "paramCN1Start",   type: "number" },
  cn1_end:           { id: "paramCN1End",     type: "number" },
  cn1_mode:          { id: "paramCN1Mode",    type: "value" },
  cn2_enabled:       { id: "checkCN2",        type: "collapseCheck" },
  cn2_module:        { id: "paramCN2Module",  type: "value" },
  cn2_model:         { id: "paramCN2Model",   type: "value" },
  cn2_source:        { id: "paramCN2Source",  type: "value" },
  cn2_weight:        { id: "paramCN2Weight",  type: "number" },
  cn2_start:         { id: "paramCN2Start",   type: "number" },
  cn2_end:           { id: "paramCN2End",     type: "number" },
  cn2_mode:          { id: "paramCN2Mode",    type: "value" },

  // Inpaint ----------------------------------------------------------------
  inpaint_area:      { id: "paramInpaintArea", type: "value" },
  inpaint_fill:      { id: "paramFill",        type: "value" },
  mask_blur:         { id: "paramMaskBlur",    type: "int" },
  inpaint_padding:   { id: "paramPadding",     type: "int" },

  // Soft inpaint -----------------------------------------------------------
  soft_inpaint_enabled: { id: "checkSoftInpaint",      type: "collapseCheck" },
  soft_bias:            { id: "paramSoftBias",         type: "number" },
  soft_preserve:        { id: "paramSoftPreserve",     type: "number" },
  soft_contrast:        { id: "paramSoftContrast",     type: "number" },
  soft_mask_inf:        { id: "paramSoftMaskInf",      type: "number" },
  soft_diff_thresh:     { id: "paramSoftDiffThresh",   type: "number" },
  soft_diff_contrast:   { id: "paramSoftDiffContrast", type: "number" },

  // AR randomizer (hidden state) ------------------------------------------
  ar_rand_base:        { id: "arRandBase",        type: "checkbox" },
  ar_rand_ratio:       { id: "arRandRatio",       type: "checkbox" },
  ar_rand_orientation: { id: "arRandOrientation", type: "checkbox" },
  ar_base_pool:        { id: "arBasePoolData",    type: "hidden" },
  ar_ratio_pool:       { id: "arRatioPoolData",   type: "hidden" },

  // Output settings (live in Settings panel but rebuilt per workflow) -----
  save_outputs:    { id: "toggleSaveOutputs",   type: "onClass" },
  high_precision:  { id: "toggleHighPrecision", type: "onClass" },
  live_preview:    { id: "toggleLivePreview",   type: "onClass" },
  embed_metadata:  { id: "toggleMetadata",      type: "onClass" },
  save_format:     { id: "settingSaveFormat",   type: "value" },
  jpeg_quality:    { id: "settingJpegQuality",  type: "int" },
  webp_quality:    { id: "settingWebpQuality",  type: "int" },
  webp_lossless:   { id: "toggleWebpLossless",  type: "onClass" },

  // Extra-args expand toggle (real checkbox) ------------------------------
  extra_open:      { id: "checkExtra",          type: "checkbox" },
};

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

function _readField(spec) {
  var el = document.getElementById(spec.id);
  if (!el) return undefined;
  switch (spec.type) {
    case "value":
    case "hidden":
    case "textarea":
      return el.value;
    case "number": {
      var n = parseFloat(el.value);
      return Number.isFinite(n) ? n : el.value;
    }
    case "int": {
      var i = parseInt(el.value, 10);
      return Number.isFinite(i) ? i : el.value;
    }
    case "collapseCheck":
      return el.classList.contains("checked");
    case "onClass":
      return el.classList.contains("on");
    case "checkbox":
      return !!el.checked;
  }
  return undefined;
}

function captureWorkflowState(options) {
  options = options || {};
  var includePrompt = options.includePrompt !== false;
  var includeNegativePrompt = options.includeNegativePrompt !== false;
  var includeDimensions = options.includeDimensions !== false;

  var settings = {};
  for (var key in FIELD_MAP) {
    if (!Object.prototype.hasOwnProperty.call(FIELD_MAP, key)) continue;
    var spec = FIELD_MAP[key];
    if (spec.prompt && !includePrompt) continue;
    if (spec.negPrompt && !includeNegativePrompt) continue;
    if (spec.dimension && !includeDimensions) continue;
    var v = _readField(spec);
    if (v !== undefined) settings[key] = v;
  }

  var dynamic = {};
  try {
    var EB = window.ExtensionBridge;
    if (EB && typeof EB.collectArgs === "function") {
      dynamic.extension_args = EB.collectArgs() || {};
    }
  } catch (e) { /* ignore */ }

  return {
    version: SCHEMA_VERSION,
    settings: settings,
    dynamic: dynamic,
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function _normalize(workflowOrSnapshot) {
  if (!workflowOrSnapshot || typeof workflowOrSnapshot !== "object") return null;
  // Workflow shape: { settings: {...} }
  if (workflowOrSnapshot.settings && typeof workflowOrSnapshot.settings === "object") {
    return {
      settings: workflowOrSnapshot.settings,
      dynamic: workflowOrSnapshot.dynamic || {},
    };
  }
  // Bare snapshot from older StudioDocs payloads: flat { paramSteps: 20, ... }
  // Convert by reverse-lookup: any key matching a known DOM id maps to that
  // field's schema name.
  var idToKey = {};
  for (var key in FIELD_MAP) {
    if (!Object.prototype.hasOwnProperty.call(FIELD_MAP, key)) continue;
    idToKey[FIELD_MAP[key].id] = key;
  }
  var converted = {};
  for (var k in workflowOrSnapshot) {
    if (!Object.prototype.hasOwnProperty.call(workflowOrSnapshot, k)) continue;
    if (idToKey[k]) converted[idToKey[k]] = workflowOrSnapshot[k];
  }
  return { settings: converted, dynamic: {} };
}

function _refreshSearchable(el) {
  try {
    var SS = window.StudioSearchableSelect;
    if (SS && typeof SS.attach === "function") {
      var handle = SS.attach(el);
      if (handle && typeof handle.refresh === "function") handle.refresh();
    }
  } catch (e) { /* ignore */ }
}

function _writeField(spec, value) {
  var el = document.getElementById(spec.id);
  if (!el) return { skipped: true };
  switch (spec.type) {
    case "value": {
      el.value = value;
      if (spec.model) {
        // Critical: never dispatch `change` here — listeners at
        // app.js:2898/2979/3011 trigger async reloads on change.
        _refreshSearchable(el);
      } else {
        if (el.tagName === "SELECT") {
          _refreshSearchable(el);
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      return { applied: true };
    }
    case "hidden":
      el.value = value;
      return { applied: true };
    case "textarea":
      el.value = value == null ? "" : String(value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return { applied: true };
    case "number":
    case "int":
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { applied: true };
    case "collapseCheck":
      el.classList.toggle("checked", !!value);
      return { applied: true };
    case "onClass":
      el.classList.toggle("on", !!value);
      return { applied: true };
    case "checkbox":
      el.checked = !!value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { applied: true };
  }
  return { skipped: true };
}

function _syncStateFlags() {
  var S = window.StudioCore && window.StudioCore.state;
  if (!S) return;
  var saveOutputs   = document.getElementById("toggleSaveOutputs");
  var highPrec      = document.getElementById("toggleHighPrecision");
  var livePreview   = document.getElementById("toggleLivePreview");
  var embedMeta     = document.getElementById("toggleMetadata");
  if (saveOutputs) S.saveOutputs   = saveOutputs.classList.contains("on");
  if (highPrec)    S.highPrecision = highPrec.classList.contains("on");
  if (livePreview) S.livePreview   = livePreview.classList.contains("on");
  if (embedMeta)   S.embedMetadata = embedMeta.classList.contains("on");
}

function _maybeResizeCanvas(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;
  if (window.StudioCore && typeof window.StudioCore.resizeCanvas === "function") {
    try { window.StudioCore.resizeCanvas(width, height); return; } catch (e) { /* fall through */ }
  }
  var UI = window.StudioUI;
  if (UI && typeof UI.syncCanvasToViewport === "function") {
    var S = window.StudioCore && window.StudioCore.state;
    if (S) { S.W = width; S.H = height; }
    try { UI.syncCanvasToViewport(); } catch (e) { /* ignore */ }
  }
}

function applyWorkflowState(workflowOrSnapshot, options) {
  options = options || {};
  var silent = options.silent === true;
  var applyDimensions = options.applyDimensions !== false;

  var norm = _normalize(workflowOrSnapshot);
  if (!norm) return { applied: 0, skipped: 0 };

  var applied = 0;
  var skipped = 0;
  var dimensionsApplied = false;

  for (var key in norm.settings) {
    if (!Object.prototype.hasOwnProperty.call(norm.settings, key)) continue;
    var spec = FIELD_MAP[key];
    if (!spec) continue; // unknown schema key — ignore
    if (spec.dimension && !applyDimensions) continue;
    var res = _writeField(spec, norm.settings[key]);
    if (res && res.applied) {
      applied++;
      if (spec.dimension) dimensionsApplied = true;
    } else {
      skipped++;
    }
  }

  // Side-effect tail: mirror what _applyDefaults does after writing fields.
  _syncStateFlags();
  if (dimensionsApplied) {
    var w = parseInt(norm.settings.width, 10);
    var h = parseInt(norm.settings.height, 10);
    if (Number.isFinite(w) && Number.isFinite(h)) _maybeResizeCanvas(w, h);
  }

  if (!silent && typeof window.showToast === "function") {
    if (skipped > 0) {
      window.showToast("Workflow applied with " + skipped + " unavailable settings", "info");
    } else {
      window.showToast("Workflow applied", "success");
    }
  }

  return { applied: applied, skipped: skipped };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCurrentDimensions() {
  var w = parseInt((document.getElementById("paramWidth") || {}).value, 10);
  var h = parseInt((document.getElementById("paramHeight") || {}).value, 10);
  return {
    width:  Number.isFinite(w) ? w : null,
    height: Number.isFinite(h) ? h : null,
  };
}

function workflowHasDimensions(wf) {
  var norm = _normalize(wf);
  if (!norm) return false;
  var s = norm.settings || {};
  return s.width != null && s.height != null;
}

window.StudioWorkflowState = {
  captureWorkflowState: captureWorkflowState,
  applyWorkflowState: applyWorkflowState,
  getCurrentDimensions: getCurrentDimensions,
  workflowHasDimensions: workflowHasDimensions,
  _FIELD_MAP: FIELD_MAP, // exposed for diagnostics; do not rely on shape
};

})();
