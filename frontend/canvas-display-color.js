// Display-only color compensation for the on-screen canvas.
//
// Background: on Firefox + a calibrated wide-gamut display, the canvas
// renders chromatic pixels (especially reds/oranges) more saturated than
// the same image displayed via an <img> element (gallery preview, the
// saved file viewed in another app). Exported pixels are byte-correct
// (PR #151); the discrepancy is purely in how Firefox draws <canvas>.
//
// This module applies an SVG feColorMatrix as a CSS filter to the
// display canvas only. It does not touch any pixel buffer; the matrix
// runs at composite time. Exports continue to use the unfiltered layer
// canvases via StudioCore.exportFlattened, so the saved file is
// unaffected.
//
// The matrix is a per-channel scale + offset (linear regression fit per
// channel, no cross-channel terms — keeps the behavior predictable and
// the persisted state tiny). To populate it, the user runs
// `window.StudioCanvasDisplayColor.calibrate()` (or the alias
// `window.StudioDebug.calibrateCanvasDisplayColor()`) while a
// representative file-backed image is on the canvas. The calibrator
// uses StudioDebug.sampleColorPipelineGrid as its sampler:
//
//   Stage 0 (backend/Pillow disk read) → "source" pixels
//   Stage 1 (HTMLImageElement decode)  → "target" pixels (what the
//                                         user perceives as correct)
//
// Off by default. Toggle in Settings → Canvas → "Match gallery preview
// colors" or programmatically:
//   window.StudioCanvasDisplayColor.setEnabled(true)
//
// Public API:
//   .setEnabled(bool)            persists, applies/removes the filter
//   .isEnabled()                 → bool
//   .calibrate()                 runs sampler, fits matrix, applies, persists
//   .reset()                     identity matrix (no compensation)
//   .getMatrix()                 → { aR, bR, aG, bG, aB, bB }  (b in 0..255)
//   .applyMatrix({...})          set + persist + apply a custom matrix

(function () {
  "use strict";

  var FILTER_ID = "studioCanvasDisplayColorMatrix";
  var FILTER_VALUES_ID = "studioCanvasDisplayColorMatrixValues";
  var STORAGE_ENABLED = "studio-canvas-display-color-enabled";
  var STORAGE_MATRIX = "studio-canvas-display-color-matrix";
  var TAG = "[Studio CanvasDisplayColor]";

  var IDENTITY = { aR: 1, bR: 0, aG: 1, bG: 0, aB: 1, bB: 0 };

  var _enabled = false;
  var _matrix = Object.assign({}, IDENTITY);

  // --- persistence ------------------------------------------------------

  function _readEnabled() {
    try { return localStorage.getItem(STORAGE_ENABLED) === "1"; }
    catch (e) { return false; }
  }

  function _writeEnabled(on) {
    try { localStorage.setItem(STORAGE_ENABLED, on ? "1" : "0"); }
    catch (e) { /* ignore */ }
  }

  function _readMatrix() {
    try {
      var raw = localStorage.getItem(STORAGE_MATRIX);
      if (!raw) return Object.assign({}, IDENTITY);
      var m = JSON.parse(raw);
      // Defensive: clamp + finite-check + fall back to identity on missing fields.
      var out = Object.assign({}, IDENTITY);
      ["aR", "aG", "aB"].forEach(function (k) {
        if (Number.isFinite(m[k])) out[k] = Math.max(0, Math.min(8, m[k]));
      });
      ["bR", "bG", "bB"].forEach(function (k) {
        if (Number.isFinite(m[k])) out[k] = Math.max(-255, Math.min(255, m[k]));
      });
      return out;
    } catch (e) { return Object.assign({}, IDENTITY); }
  }

  function _writeMatrix(m) {
    try { localStorage.setItem(STORAGE_MATRIX, JSON.stringify(m)); }
    catch (e) { /* ignore */ }
  }

  // --- SVG filter element -----------------------------------------------

  function _ensureFilterElement() {
    if (document.getElementById(FILTER_VALUES_ID)) return;
    var svgNs = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
    var defs = document.createElementNS(svgNs, "defs");
    var filter = document.createElementNS(svgNs, "filter");
    filter.setAttribute("id", FILTER_ID);
    filter.setAttribute("color-interpolation-filters", "sRGB");
    var fe = document.createElementNS(svgNs, "feColorMatrix");
    fe.setAttribute("id", FILTER_VALUES_ID);
    fe.setAttribute("type", "matrix");
    fe.setAttribute("values", "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0");
    filter.appendChild(fe);
    defs.appendChild(filter);
    svg.appendChild(defs);
    document.body.appendChild(svg);
  }

  function _matrixToValues(m) {
    // SVG feColorMatrix: 4 rows × 5 cols, normalized 0..1. Channel offsets
    // (column 4) divide by 255 to convert from our 0..255 fit space.
    var oR = (m.bR / 255).toFixed(6);
    var oG = (m.bG / 255).toFixed(6);
    var oB = (m.bB / 255).toFixed(6);
    return [
      m.aR.toFixed(6), 0, 0, 0, oR,
      0, m.aG.toFixed(6), 0, 0, oG,
      0, 0, m.aB.toFixed(6), 0, oB,
      0, 0, 0, 1, 0,
    ].join(" ");
  }

  function _applyMatrixToFilter(m) {
    _ensureFilterElement();
    var fe = document.getElementById(FILTER_VALUES_ID);
    if (fe) fe.setAttribute("values", _matrixToValues(m));
  }

  function _applyEnabledToCanvas() {
    var S = window.StudioCore && window.StudioCore.state;
    if (!S || !S.canvas) return;
    if (_enabled) {
      _ensureFilterElement();
      S.canvas.style.filter = "url(#" + FILTER_ID + ")";
    } else {
      // Don't blanket-clear the filter property in case something else
      // ever sets it; clear only when it matches our URL.
      var f = S.canvas.style.filter || "";
      if (f.indexOf(FILTER_ID) !== -1) S.canvas.style.filter = "";
    }
  }

  // --- calibration: per-channel scale + offset --------------------------

  function _fitLinear(xs, ys) {
    var n = xs.length;
    if (n < 2) return { a: 1, b: 0 };
    var sumX = 0, sumY = 0;
    for (var i = 0; i < n; i++) { sumX += xs[i]; sumY += ys[i]; }
    var mx = sumX / n, my = sumY / n;
    var num = 0, den = 0;
    for (var j = 0; j < n; j++) {
      var dx = xs[j] - mx;
      num += dx * (ys[j] - my);
      den += dx * dx;
    }
    if (den < 1e-9) return { a: 1, b: my - mx };
    var a = num / den;
    var b = my - a * mx;
    return { a: a, b: b };
  }

  function _extractChannelPairs(rows) {
    // Group rows by sample label, then for each label extract Stage 0
    // (source) and Stage 1 (target). Skip incomplete pairs.
    var bySample = {};
    rows.forEach(function (r) {
      if (!r || !r.stage) return;
      if (!bySample[r.sample]) bySample[r.sample] = {};
      if (r.stage.indexOf("0. backend") === 0) bySample[r.sample].src = r;
      else if (r.stage.indexOf("1. source via <img>") === 0) bySample[r.sample].tgt = r;
    });
    var pairs = [];
    Object.keys(bySample).forEach(function (k) {
      var p = bySample[k];
      if (!p.src || !p.tgt) return;
      if (p.src.r == null || p.tgt.r == null) return;
      pairs.push(p);
    });
    return pairs;
  }

  async function calibrate() {
    var SD = window.StudioDebug;
    if (!SD || typeof SD.sampleColorPipelineGrid !== "function") {
      throw new Error(TAG + " StudioDebug.sampleColorPipelineGrid not available");
    }
    var report = await SD.sampleColorPipelineGrid(3);
    var pairs = _extractChannelPairs(report.rows || []);
    if (pairs.length < 3) {
      throw new Error(TAG + " calibrate needs at least 3 valid samples (got " + pairs.length + ")");
    }
    var fitR = _fitLinear(pairs.map(function (p) { return p.src.r; }), pairs.map(function (p) { return p.tgt.r; }));
    var fitG = _fitLinear(pairs.map(function (p) { return p.src.g; }), pairs.map(function (p) { return p.tgt.g; }));
    var fitB = _fitLinear(pairs.map(function (p) { return p.src.b; }), pairs.map(function (p) { return p.tgt.b; }));
    var m = {
      aR: fitR.a, bR: fitR.b,
      aG: fitG.a, bG: fitG.b,
      aB: fitB.a, bB: fitB.b,
    };
    applyMatrix(m);
    console.info(TAG, "calibrated from " + pairs.length + " samples:", m);
    return m;
  }

  // --- public API -------------------------------------------------------

  function setEnabled(on) {
    on = !!on;
    if (on === _enabled) return;
    _enabled = on;
    _writeEnabled(on);
    _applyEnabledToCanvas();
  }

  function isEnabled() { return _enabled; }

  function applyMatrix(m) {
    _matrix = {
      aR: Number.isFinite(m.aR) ? m.aR : 1,
      bR: Number.isFinite(m.bR) ? m.bR : 0,
      aG: Number.isFinite(m.aG) ? m.aG : 1,
      bG: Number.isFinite(m.bG) ? m.bG : 0,
      aB: Number.isFinite(m.aB) ? m.aB : 1,
      bB: Number.isFinite(m.bB) ? m.bB : 0,
    };
    _writeMatrix(_matrix);
    _applyMatrixToFilter(_matrix);
  }

  function reset() {
    applyMatrix(IDENTITY);
  }

  function getMatrix() { return Object.assign({}, _matrix); }

  // --- init -------------------------------------------------------------

  function _init() {
    _enabled = _readEnabled();
    _matrix = _readMatrix();
    _ensureFilterElement();
    _applyMatrixToFilter(_matrix);
    _applyEnabledToCanvas();

    // Wire the existing Settings → Canvas toggle (kept from PR #152's
    // overlay; the toggle now drives this filter instead).
    var toggle = document.getElementById("toggleCanvasColorPreview");
    if (toggle) {
      if (_enabled) toggle.classList.add("on");
      else toggle.classList.remove("on");
      toggle.addEventListener("click", function () {
        var nowOn = !_enabled;
        setEnabled(nowOn);
        toggle.classList.toggle("on", nowOn);
        // If we're enabling for the first time and the matrix is still
        // identity, hint at calibration.
        if (nowOn && _matrix.aR === 1 && _matrix.aG === 1 && _matrix.aB === 1
                  && _matrix.bR === 0 && _matrix.bG === 0 && _matrix.bB === 0) {
          console.info(TAG, "enabled with identity matrix — run "
            + "window.StudioCanvasDisplayColor.calibrate() while a "
            + "file-backed image is on the canvas to fit the matrix.");
        }
      });
    }
  }

  window.StudioCanvasDisplayColor = {
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    calibrate: calibrate,
    reset: reset,
    getMatrix: getMatrix,
    applyMatrix: applyMatrix,
  };

  // Alias on StudioDebug per the handoff spec, so calibration is reachable
  // from the same namespace as the diagnostic helpers it depends on.
  window.StudioDebug = window.StudioDebug || {};
  if (typeof window.StudioDebug.calibrateCanvasDisplayColor !== "function") {
    window.StudioDebug.calibrateCanvasDisplayColor = calibrate;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _init);
  } else {
    _init();
  }
})();
