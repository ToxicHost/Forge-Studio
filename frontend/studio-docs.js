/**
 * Forge Studio — Document System (StudioDocs)
 * by ToxicHost & Moritz
 *
 * Multi-file tabs for the canvas workspace. Each document has its own
 * layers, mask, regions, undo stack, and zoom state. Uses a multi-page
 * pattern: working state is a window into the active document.
 *
 * Loaded after canvas-core.js, canvas-ui.js, app.js, and module-system.js.
 *
 * API:
 *   StudioDocs.newDoc(name?)       — create a new document
 *   StudioDocs.switchDoc(idx)      — switch to document at index
 *   StudioDocs.closeDoc(idx)       — close document (guarded against last)
 *   StudioDocs.renameDoc(idx,name) — rename
 *   StudioDocs.activeIdx           — current document index
 *   StudioDocs.count               — number of open documents
 */
(function () {
"use strict";

var TAG = "[Docs]";
var _docs = [];
var _activeIdx = 0;
var _nextDocId = 1;
var _stripEl = null;

// ========================================================================
// GENERATION PANEL — per-document prompt & settings
// ========================================================================

// Element IDs to save/restore, grouped by type
var _GEN_VALUES = [
  "paramSteps", "paramCFG", "paramDenoise", "paramSeed",
  "paramBatch", "paramBatchSize",
  "paramHrScale", "paramHrSteps", "paramHrDenoise", "paramHrCFG",
  "paramAD1Conf", "paramAD1Denoise", "paramAD1Blur", "paramAD1Prompt",
  "paramAD2Conf", "paramAD2Denoise", "paramAD2Blur", "paramAD2Prompt",
  "paramAD3Conf", "paramAD3Denoise", "paramAD3Blur", "paramAD3Prompt",
  "paramVarSeed", "paramVarStrength", "paramVarStrengthVal",
  "paramResizeSeedW",
  "paramMaskBlur", "paramPadding",
  "paramSoftBias", "paramSoftPreserve", "paramSoftContrast",
  "paramSoftMaskInf", "paramSoftDiffThresh", "paramSoftDiffContrast"
];
var _GEN_SELECTS = [
  "paramSampler", "paramScheduler", "paramHrUpscaler", "paramHrCheckpoint",
  "paramAD1Model", "paramAD2Model", "paramAD3Model",
  "paramInpaintArea", "paramFill"
];
var _GEN_TEXTAREAS = ["paramPrompt", "paramNeg"];
var _GEN_CHECKS = ["checkHires", "checkAD", "checkAD1", "checkAD2", "checkAD3",
  "checkSoftInpaint", "checkExtra"];

function _saveGenPanel() {
  var gen = {};
  _GEN_VALUES.forEach(function (id) {
    var el = document.getElementById(id);
    if (el) gen[id] = el.value;
  });
  _GEN_SELECTS.forEach(function (id) {
    var el = document.getElementById(id);
    if (el) gen[id] = el.value;
  });
  _GEN_TEXTAREAS.forEach(function (id) {
    var el = document.getElementById(id);
    if (el) gen[id] = el.value;
  });
  _GEN_CHECKS.forEach(function (id) {
    var el = document.getElementById(id);
    if (el) gen[id] = el.classList.contains("checked");
  });
  return gen;
}

function _loadGenPanel(gen) {
  if (!gen) return;
  _GEN_VALUES.forEach(function (id) {
    var el = document.getElementById(id);
    if (el && gen[id] !== undefined) el.value = gen[id];
  });
  _GEN_SELECTS.forEach(function (id) {
    var el = document.getElementById(id);
    if (el && gen[id] !== undefined) el.value = gen[id];
  });
  _GEN_TEXTAREAS.forEach(function (id) {
    var el = document.getElementById(id);
    if (el && gen[id] !== undefined) el.value = gen[id];
  });
  _GEN_CHECKS.forEach(function (id) {
    var el = document.getElementById(id);
    if (el && gen[id] !== undefined) {
      el.classList.toggle("checked", gen[id]);
    }
  });
}

// ========================================================================
// DOCUMENT SNAPSHOT FORMAT
// ========================================================================

function _saveDoc(idx) {
  var S = window.StudioCore.state;
  if (idx === undefined) idx = _activeIdx;
  var doc = _docs[idx];
  if (!doc) return;

  // Generation panel
  doc.genPanel = _saveGenPanel();

  // Layer pixel data
  doc.W = S.W;
  doc.H = S.H;
  doc.layers = S.layers.map(function (L) {
    if (L.type === "adjustment") {
      return {
        id: L.id, name: L.name, type: L.type,
        adjustType: L.adjustType,
        adjustParams: JSON.parse(JSON.stringify(L.adjustParams || {})),
        visible: L.visible, opacity: L.opacity,
        blendMode: L.blendMode, locked: L.locked,
        imageData: null
      };
    }
    return {
      id: L.id, name: L.name, type: L.type,
      visible: L.visible, opacity: L.opacity,
      blendMode: L.blendMode, locked: L.locked,
      imageData: L.ctx.getImageData(0, 0, S.W, S.H)
    };
  });
  doc.activeLayerIdx = S.activeLayerIdx;
  doc.nextLayerId = S.nextLayerId;

  // Mask
  doc.maskData = S.mask.ctx.getImageData(0, 0, S.W, S.H);
  doc.maskVisible = S.mask.visible;
  doc.maskOpacity = S.mask.opacity;

  // Regions
  doc.regions = S.regions.map(function (r) {
    return {
      id: r.id, color: r.color,
      prompt: r.prompt || "", negPrompt: r.negPrompt || "",
      weight: r.weight, denoise: r.denoise,
      imageData: r.ctx.getImageData(0, 0, S.W, S.H)
    };
  });
  doc.activeRegionId = S.activeRegionId;
  doc.regionMode = S.regionMode;
  doc._nextRegionId = S._nextRegionId;

  // Canvas state
  doc.editingMask = S.editingMask;
  doc._userMaskMode = S._userMaskMode;
  doc._canvasDirty = S._canvasDirty;

  // Zoom/pan
  doc.zoom = { scale: S.zoom.scale, ox: S.zoom.ox, oy: S.zoom.oy };

  // Undo/redo — swap wholesale (entries contain self-contained ImageData)
  doc.undoStack = S.undoStack;
  doc.redoStack = S.redoStack;

  // Develop (global non-destructive post-processing) — see develop.js
  if (S.developParams) {
    doc.developParams = JSON.parse(JSON.stringify(S.developParams));
  }
}

function _loadDoc(idx) {
  var S = window.StudioCore.state;
  var C = window.StudioCore;
  var doc = _docs[idx];
  if (!doc) return;

  // Clear selection
  C.selectionClear();

  // Dimensions
  S.W = doc.W;
  S.H = doc.H;

  // Stroke buffer — resize to match doc
  S.stroke.canvas.width = S.W;
  S.stroke.canvas.height = S.H;
  S.stroke.ctx = S.stroke.canvas.getContext("2d");

  // Layers
  S.layers = doc.layers.map(function (saved) {
    if (saved.type === "adjustment") {
      var migrated = (C._migrateAdjustParams
        ? C._migrateAdjustParams(saved.adjustType, saved.adjustParams)
        : JSON.parse(JSON.stringify(saved.adjustParams || {})));
      return {
        id: saved.id, name: saved.name, type: saved.type,
        adjustType: saved.adjustType,
        adjustParams: migrated,
        visible: saved.visible, opacity: saved.opacity,
        blendMode: saved.blendMode, locked: saved.locked,
        canvas: null, ctx: null,
        _lutCache: null
      };
    }
    var c = C.createLayerCanvas();
    var ctx = c.getContext("2d");
    if (saved.type === "reference") {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, S.W, S.H);
    }
    if (saved.imageData) ctx.putImageData(saved.imageData, 0, 0);
    return {
      id: saved.id, name: saved.name, type: saved.type,
      visible: saved.visible, opacity: saved.opacity,
      blendMode: saved.blendMode, locked: saved.locked,
      canvas: c, ctx: ctx
    };
  });
  S.activeLayerIdx = doc.activeLayerIdx;
  S.nextLayerId = doc.nextLayerId;

  // Mask
  S.mask.canvas.width = S.W;
  S.mask.canvas.height = S.H;
  S.mask.ctx = S.mask.canvas.getContext("2d");
  if (doc.maskData) S.mask.ctx.putImageData(doc.maskData, 0, 0);
  S.mask.visible = doc.maskVisible !== undefined ? doc.maskVisible : true;
  S.mask.opacity = doc.maskOpacity !== undefined ? doc.maskOpacity : 0.5;

  // Regions
  S.regions = doc.regions.map(function (saved) {
    var c = C.createLayerCanvas();
    var ctx = c.getContext("2d");
    if (saved.imageData) ctx.putImageData(saved.imageData, 0, 0);
    return {
      id: saved.id, color: saved.color, canvas: c, ctx: ctx,
      prompt: saved.prompt || "", negPrompt: saved.negPrompt || "",
      weight: saved.weight, denoise: saved.denoise
    };
  });
  S.activeRegionId = doc.activeRegionId;
  S.regionMode = doc.regionMode || false;
  S._nextRegionId = doc._nextRegionId || 1;

  // Canvas state
  S.editingMask = doc.editingMask || false;
  S._userMaskMode = doc._userMaskMode || false;
  S._canvasDirty = doc._canvasDirty || false;

  // Zoom/pan
  if (doc.zoom) {
    S.zoom.scale = doc.zoom.scale;
    S.zoom.ox = doc.zoom.ox;
    S.zoom.oy = doc.zoom.oy;
  }

  // Undo/redo
  S.undoStack = doc.undoStack || [];
  S.redoStack = doc.redoStack || [];

  // Develop (global non-destructive post-processing). Older docs predate
  // this field — fall back to identity defaults so they composite unchanged.
  if (doc.developParams) {
    S.developParams = JSON.parse(JSON.stringify(doc.developParams));
  } else if (window.StudioDevelop && window.StudioDevelop.defaultParams) {
    S.developParams = window.StudioDevelop.defaultParams();
  } else {
    S.developParams = { _version: 1, enabled: false };
  }
  // Caches are document-scoped — invalidate on tab switch
  S._developLutCache = null;
  S._developBlurCache = null;
  S._developGrainCache = null;
  S._developBeforeBuf = null;

  // Generation panel
  _loadGenPanel(doc.genPanel);

  // Sync Develop panel UI if the module is open
  if (window.StudioDevelop && window.StudioDevelop.syncPanel) {
    try { window.StudioDevelop.syncPanel(); } catch (e) {}
  }
}

// ========================================================================
// UI REFRESH — sync all panels after document switch
// ========================================================================

function _refreshUI() {
  var S = window.StudioCore.state;
  var UI = window.StudioUI;
  if (!UI) return;

  // Sync dimension inputs
  var wEl = document.getElementById("paramWidth");
  var hEl = document.getElementById("paramHeight");
  if (wEl) wEl.value = S.W;
  if (hEl) hEl.value = S.H;
  if (window.StatusBar) window.StatusBar.setDimensions(S.W, S.H);

  // Resize canvas element and sync viewport
  UI.syncCanvasToViewport();

  // Re-render all panels
  UI.renderLayerPanel();
  UI.renderHistoryPanel();
  UI.renderRegionPanel();

  // Redraw composite
  UI.redraw();
}

// ========================================================================
// DOCUMENT OPERATIONS
// ========================================================================

function _createBlankDoc(name) {
  var S = window.StudioCore.state;
  return {
    id: _nextDocId++,
    name: name || "Untitled",
    W: S.W, H: S.H,
    layers: [
      {
        id: 0, name: "Background", type: "reference",
        visible: true, opacity: 1, blendMode: "source-over", locked: false,
        imageData: null // will be filled white on restore
      },
      {
        id: 1, name: "Layer 1", type: "paint",
        visible: true, opacity: 1, blendMode: "source-over", locked: false,
        imageData: null
      }
    ],
    activeLayerIdx: 1,
    nextLayerId: 2,
    maskData: null, maskVisible: true, maskOpacity: 0.5,
    regions: [], activeRegionId: null, regionMode: false, _nextRegionId: 1,
    editingMask: false, _userMaskMode: false, _canvasDirty: false,
    zoom: { scale: 1, ox: 0, oy: 0 },
    undoStack: [], redoStack: [],
    developParams: (window.StudioDevelop && window.StudioDevelop.defaultParams)
      ? window.StudioDevelop.defaultParams()
      : { _version: 1, enabled: false },
    genPanel: (function () {
      var gen = _saveGenPanel();
      // Clear content-specific fields — keep settings (sampler, steps, CFG, etc.)
      gen.paramPrompt = "";
      gen.paramNeg = "";
      gen.paramSeed = "-1";
      gen.paramAD1Prompt = "";
      gen.paramAD2Prompt = "";
      gen.paramAD3Prompt = "";
      return gen;
    })()
  };
}

function newDoc(name) {
  // Save current
  _saveDoc(_activeIdx);

  var doc = _createBlankDoc(name || ("Untitled " + _nextDocId));
  _docs.push(doc);
  var newIdx = _docs.length - 1;

  // Switch to new
  _activeIdx = newIdx;
  _loadDoc(newIdx);

  // Apply user defaults to the new document. _createBlankDoc deliberately
  // clears prompt / negPrompt / seed, and inherits other settings from
  // the current doc; defaults override that with the user's saved
  // workflow. Synchronous: reads from the cached defaults populated at
  // app init by _studioLoadDefaults. _applyDefaults handles canvas
  // resizing + viewport sync internally.
  if (typeof window._studioReapplyDefaults === "function") {
    window._studioReapplyDefaults();
  }

  window.StudioCore.zoomFit();
  _refreshUI();
  _renderStrip();

  console.log(TAG, "New document:", doc.name);
  return newIdx;
}

function switchDoc(idx) {
  if (idx === _activeIdx) return;
  if (idx < 0 || idx >= _docs.length) return;

  // Save current
  _saveDoc(_activeIdx);

  // Load target
  _activeIdx = idx;
  _loadDoc(idx);
  _refreshUI();
  _renderStrip();

  console.log(TAG, "Switched to:", _docs[idx].name);
}

function closeDoc(idx) {
  if (_docs.length <= 1) {
    if (window.showToast) window.showToast("Can\u2019t close the last document", "info");
    return;
  }

  // Confirm if doc has content
  if (_docs[idx]._canvasDirty) {
    if (!confirm("Close \"" + _docs[idx].name + "\"? Unsaved changes will be lost.")) return;
  }

  _docs.splice(idx, 1);

  // Adjust active index
  if (_activeIdx >= _docs.length) _activeIdx = _docs.length - 1;
  else if (_activeIdx > idx) _activeIdx--;
  else if (_activeIdx === idx) {
    _activeIdx = Math.min(idx, _docs.length - 1);
    _loadDoc(_activeIdx);
    _refreshUI();
  }

  _renderStrip();
  console.log(TAG, "Closed document at index", idx);
}

function renameDoc(idx, name) {
  if (!_docs[idx]) return;
  _docs[idx].name = name;
  _renderStrip();
}

// ========================================================================
// TAB STRIP UI
// ========================================================================

function _buildStrip() {
  var canvasArea = document.getElementById("canvasArea");
  if (!canvasArea || document.getElementById("docStrip")) return;

  var strip = document.createElement("div");
  strip.className = "doc-strip";
  strip.id = "docStrip";
  canvasArea.insertBefore(strip, canvasArea.firstChild);
  canvasArea.classList.add("has-docs");
  _stripEl = strip;

  // Delegated events
  strip.addEventListener("click", function (e) {
    var tab = e.target.closest(".doc-tab");
    var close = e.target.closest(".doc-tab-close");
    var add = e.target.closest(".doc-add");

    if (close && tab) {
      e.stopPropagation();
      var ci = parseInt(tab.dataset.idx);
      if (!isNaN(ci)) closeDoc(ci);
      return;
    }
    if (tab) {
      var ti = parseInt(tab.dataset.idx);
      if (!isNaN(ti)) switchDoc(ti);
      return;
    }
    if (add) {
      newDoc();
      return;
    }
  });

  // Double-click to rename
  strip.addEventListener("dblclick", function (e) {
    var tab = e.target.closest(".doc-tab");
    if (!tab || e.target.closest(".doc-tab-close")) return;
    var idx = parseInt(tab.dataset.idx);
    if (isNaN(idx) || !_docs[idx]) return;

    var label = tab.querySelector(".doc-tab-name");
    if (!label) return;
    var input = document.createElement("input");
    input.className = "doc-tab-rename";
    input.value = _docs[idx].name;
    input.style.width = Math.max(60, label.offsetWidth + 10) + "px";
    label.replaceWith(input);
    input.focus();
    input.select();

    var commit = function () {
      var val = input.value.trim();
      if (val) renameDoc(idx, val);
      _renderStrip();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
      if (ev.key === "Escape") { ev.preventDefault(); _renderStrip(); }
    });
  });

  _renderStrip();

  // Re-sync viewport to account for the 26px strip height
  setTimeout(function () {
    if (window.StudioUI) {
      window.StudioUI.syncCanvasToViewport();
      window.StudioCore.zoomFit();
      window.StudioUI.redraw();
    }
  }, 50);
}

function _renderStrip() {
  if (!_stripEl) return;

  var html = "";
  for (var i = 0; i < _docs.length; i++) {
    var active = (i === _activeIdx) ? " active" : "";
    var dirty = _docs[i]._canvasDirty ? " \u2022" : "";
    html += '<div class="doc-tab' + active + '" data-idx="' + i + '">'
      + '<span class="doc-tab-name">' + _esc(_docs[i].name) + dirty + '</span>'
      + (_docs.length > 1 ? '<span class="doc-tab-close" title="Close">\u00d7</span>' : '')
      + '</div>';
  }
  html += '<button class="doc-add" title="New document">+</button>';
  _stripEl.innerHTML = html;
}

function _esc(s) {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ========================================================================
// KEYBOARD SHORTCUTS
// ========================================================================

function _onKeyDown(e) {
  // Don't fire while a different module (Gallery, Workshop, etc.) is active
  if (window.StudioModules && window.StudioModules.activeId !== null) return;

  // Don't fire while the user is typing in an input, textarea, or contenteditable
  var t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

  // Ctrl+] / Ctrl+[ to cycle documents
  // (Ctrl+Tab is reserved by the browser and can't be intercepted reliably)
  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    if (e.key === "]") {
      e.preventDefault();
      if (_docs.length <= 1) return;
      switchDoc(_activeIdx < _docs.length - 1 ? _activeIdx + 1 : 0);
      return;
    }
    if (e.key === "[") {
      e.preventDefault();
      if (_docs.length <= 1) return;
      switchDoc(_activeIdx > 0 ? _activeIdx - 1 : _docs.length - 1);
      return;
    }
  }
}

// ========================================================================
// INIT
// ========================================================================

function _init() {
  if (!window.StudioCore || !window.StudioCore.state) {
    console.warn(TAG, "StudioCore not available, deferring init");
    setTimeout(_init, 500);
    return;
  }

  // Create initial document from current canvas state
  var initial = _createBlankDoc("Untitled");
  _docs.push(initial);
  _activeIdx = 0;
  // Immediately snapshot current state into doc 0
  _saveDoc(0);

  _buildStrip();
  document.addEventListener("keydown", _onKeyDown);

  console.log(TAG, "Document system initialized");
}

// ========================================================================
// PUBLIC API
// ========================================================================

window.StudioDocs = {
  newDoc: newDoc,
  switchDoc: switchDoc,
  closeDoc: closeDoc,
  renameDoc: renameDoc,
  get activeIdx() { return _activeIdx; },
  get count() { return _docs.length; },
  get activeDoc() { return _docs[_activeIdx]; },
  get docs() { return _docs; },
};

// Boot after DOM and canvas are ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", function () { setTimeout(_init, 300); });
} else {
  setTimeout(_init, 300);
}

})();
