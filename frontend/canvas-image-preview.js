// Dual-surface canvas display.
//
// On Firefox + a calibrated wide-gamut display, drawing the document on
// <canvas> renders chromatic pixels (especially reds/oranges) more
// saturated than the same image rendered through an <img> element
// (Gallery Preview, Photoshop, the saved file opened directly). PR #151
// made the underlying pixels byte-correct; this module fixes the visual
// path WITHOUT touching pixel data:
//
//   1. The canonical compositor (canvas-core.js _compBuffer + the layer
//      canvases that feed it) is unchanged. It produces the document
//      content the way it always did.
//   2. A new visible <img> sits under the existing display canvas inside
//      #studio-viewport. Its src is regenerated from
//      StudioCore.exportFlattened("image/png") on each redraw (debounced).
//      Browsers render <img> elements through the same color-managed
//      path as Gallery Preview — colors match.
//   3. The display canvas is repurposed as a transparent UI overlay above
//      the <img>. canvas-core.js composite() honors S.imagePreviewActive:
//      when true it skips the document blit, void fill, and checker, so
//      the canvas only contains cursor / mask overlay / marching ants /
//      transform handles / wet brush stroke. The cursor stays visible
//      (PR #152's failure mode is gone).
//   4. exportFlattened reads from the layer canvases directly. Saved
//      files are not affected by anything in this module.
//
// Off by default. Toggle: Settings → Canvas → "Match gallery preview
// colors" or window.StudioCanvasImagePreview.setEnabled(true).

(function () {
  "use strict";

  var STORAGE_KEY = "studio-canvas-image-preview-enabled";
  var DEBOUNCE_MS = 50;
  var TAG = "[Studio CanvasImagePreview]";

  var _enabled = false;
  var _img = null;
  var _refreshTimer = null;
  var _hookInstalled = false;

  // --- persistence ------------------------------------------------------

  function _readEnabled() {
    try { return localStorage.getItem(STORAGE_KEY) === "1"; }
    catch (e) { return false; }
  }

  function _writeEnabled(on) {
    try { localStorage.setItem(STORAGE_KEY, on ? "1" : "0"); }
    catch (e) { /* ignore */ }
  }

  // --- DOM --------------------------------------------------------------

  function _ensureImg() {
    if (_img) return _img;
    var vp = document.getElementById("studio-viewport");
    if (!vp) return null;
    _img = document.createElement("img");
    _img.id = "studio-canvas-image-preview";
    _img.alt = "";
    _img.draggable = false;
    _img.style.cssText = [
      "position:absolute",
      "pointer-events:none",
      "user-select:none",
      "image-rendering:auto",
      "display:none",
      "left:0",
      "top:0",
      "z-index:0",  // below the display canvas's UI overlay
      "background:transparent",
      "box-shadow:none",
    ].join(";");
    // Insert as the first child of #studio-viewport so it sits below
    // #studio-canvas in document order. The display canvas above is the
    // UI overlay; pointer events go to it (default), this <img> has
    // pointer-events:none so clicks pass through anyway.
    if (vp.firstChild) vp.insertBefore(_img, vp.firstChild);
    else vp.appendChild(_img);
    return _img;
  }

  function _positionImg() {
    if (!_img) return;
    var S = window.StudioCore && window.StudioCore.state;
    if (!S || !S.W || !S.H) return;
    var z = S.zoom || { scale: 1, ox: 0, oy: 0 };
    _img.style.left = (z.ox | 0) + "px";
    _img.style.top = (z.oy | 0) + "px";
    _img.style.width = ((S.W * z.scale) | 0) + "px";
    _img.style.height = ((S.H * z.scale) | 0) + "px";
  }

  // --- src refresh ------------------------------------------------------

  function _refreshNow() {
    if (!_enabled) return;
    var Core = window.StudioCore;
    if (!Core || typeof Core.exportFlattened !== "function") return;
    var S = Core.state;
    if (!S || !S.W || !S.H) return;
    var img = _ensureImg();
    if (!img) return;
    var dataUrl;
    try {
      dataUrl = Core.exportFlattened("image/png");
    } catch (e) {
      console.warn(TAG, "exportFlattened failed:", e && e.message ? e.message : e);
      return;
    }
    if (!dataUrl) return;
    img.onload = function () {
      if (!_enabled) return;
      _positionImg();
      img.style.display = "block";
    };
    img.onerror = function () {
      console.warn(TAG, "preview image load failed");
    };
    img.src = dataUrl;
  }

  function _scheduleRefresh() {
    if (!_enabled) return;
    if (_refreshTimer) clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(function () {
      _refreshTimer = null;
      _refreshNow();
    }, DEBOUNCE_MS);
  }

  function hide() {
    if (_img) _img.style.display = "none";
  }

  // --- redraw hook ------------------------------------------------------
  //
  // Wraps StudioUI.redraw so any composite-affecting change schedules an
  // <img> refresh. Position is updated synchronously each redraw (cheap)
  // so pan/zoom track the document area without waiting for the debounced
  // src regenerate.
  function _hookRedraw() {
    if (_hookInstalled) return;
    var UI = window.StudioUI;
    if (!UI || typeof UI.redraw !== "function") {
      setTimeout(_hookRedraw, 250);
      return;
    }
    var orig = UI.redraw;
    UI.redraw = function () {
      var ret = orig.apply(this, arguments);
      if (_enabled) {
        _positionImg();
        _scheduleRefresh();
      }
      return ret;
    };
    _hookInstalled = true;
  }

  // --- public API -------------------------------------------------------

  function setEnabled(on) {
    on = !!on;
    if (on === _enabled) return;
    _enabled = on;
    _writeEnabled(on);
    // Drive the canvas-core.js gate. composite() reads this on its next
    // call to decide whether to draw the document on S.ctx.
    var Core = window.StudioCore;
    if (Core && Core.state) Core.state.imagePreviewActive = on;
    if (!_enabled) {
      hide();
      // Force the display canvas back to a normal full composite (void +
      // checker + document) immediately, otherwise the canvas would stay
      // transparent until the next user-triggered redraw.
      var UI = window.StudioUI;
      if (UI && UI.redraw) UI.redraw();
    } else {
      _ensureImg();
      // Refresh immediately on first enable so the user doesn't see a
      // blank canvas during the debounce window.
      _refreshNow();
      var UI2 = window.StudioUI;
      if (UI2 && UI2.redraw) UI2.redraw();
    }
  }

  function isEnabled() { return _enabled; }

  function refresh() { _scheduleRefresh(); }

  // --- init -------------------------------------------------------------

  function _init() {
    _enabled = _readEnabled();
    var Core = window.StudioCore;
    if (Core && Core.state) Core.state.imagePreviewActive = _enabled;

    _ensureImg();
    _hookRedraw();

    var toggle = document.getElementById("toggleCanvasColorPreview");
    if (toggle) {
      if (_enabled) toggle.classList.add("on");
      else toggle.classList.remove("on");
      toggle.addEventListener("click", function () {
        var nowOn = !_enabled;
        setEnabled(nowOn);
        toggle.classList.toggle("on", nowOn);
      });
    }

    if (_enabled) _refreshNow();
  }

  window.StudioCanvasImagePreview = {
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    refresh: refresh,
    hide: hide,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _init);
  } else {
    _init();
  }
})();
