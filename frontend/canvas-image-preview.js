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
//      StudioCore.exportFlattened("image/png") only when the document
//      composite version actually changes (StudioCore.getCompositeVersion).
//      Browsers render <img> elements through the same color-managed
//      path as Gallery Preview — colors match.
//   3. A separate <div> below the <img> draws a CSS-pattern checkerboard
//      so transparent areas of the document still show the familiar
//      transparency pattern (canvas-core.js skips painting checker on
//      S.ctx in this mode — that's the canvas's job in the all-canvas
//      mode, not this dual-surface mode).
//   4. The display canvas is repurposed as a transparent UI overlay above
//      both new layers. canvas-core.js composite() honors
//      S.imagePreviewActive: when true it skips the document blit, void
//      fill, and checker, so the canvas only contains cursor / mask
//      overlay / marching ants / transform handles / wet brush stroke.
//   5. exportFlattened reads from the layer canvases directly. Saved
//      files are not affected by anything in this module.
//
// Stacking (per app.css + injected styles):
//   z-index 0  →  #studio-canvas-checker-bg    (transparent-area pattern)
//   z-index 1  →  #studio-canvas-image-preview (document, color-correct)
//   z-index 2  →  #studio-canvas               (UI overlay; pointer events)
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
  var _checker = null;
  var _refreshTimer = null;
  var _hookInstalled = false;
  var _stylesInjected = false;
  var _lastPreviewVersion = -1;

  // --- persistence ------------------------------------------------------

  function _readEnabled() {
    try { return localStorage.getItem(STORAGE_KEY) === "1"; }
    catch (e) { return false; }
  }

  function _writeEnabled(on) {
    try { localStorage.setItem(STORAGE_KEY, on ? "1" : "0"); }
    catch (e) { /* ignore */ }
  }

  // --- styles + DOM -----------------------------------------------------

  function _injectStyles() {
    if (_stylesInjected) return;
    _stylesInjected = true;
    var style = document.createElement("style");
    style.id = "studio-canvas-image-preview-styles";
    // Note: #studio-canvas's own stacking (position:absolute; z-index:2)
    // is in app.css. The two elements created here are both pointer-events:
    // none so input always reaches the canvas above.
    style.textContent = [
      "#studio-canvas-image-preview {",
      "  position: absolute;",
      "  left: 0;",
      "  top: 0;",
      "  z-index: 1;",
      "  pointer-events: none;",
      "  user-select: none;",
      "  image-rendering: auto;",
      "  display: none;",
      "  background: transparent;",
      "  box-shadow: none;",
      "}",
      "#studio-canvas-checker-bg {",
      "  position: absolute;",
      "  left: 0;",
      "  top: 0;",
      "  z-index: 0;",
      "  pointer-events: none;",
      "  display: none;",
      "  background-color: #444;",
      "  background-image:",
      "    linear-gradient(45deg, #3a3a3a 25%, transparent 25%),",
      "    linear-gradient(-45deg, #3a3a3a 25%, transparent 25%),",
      "    linear-gradient(45deg, transparent 75%, #3a3a3a 75%),",
      "    linear-gradient(-45deg, transparent 75%, #3a3a3a 75%);",
      "}",
    ].join("\n");
    document.head.appendChild(style);
  }

  function _ensureLayers() {
    var vp = document.getElementById("studio-viewport");
    if (!vp) return false;
    if (!_checker) {
      _checker = document.createElement("div");
      _checker.id = "studio-canvas-checker-bg";
      _checker.setAttribute("aria-hidden", "true");
      vp.insertBefore(_checker, vp.firstChild);
    }
    if (!_img) {
      _img = document.createElement("img");
      _img.id = "studio-canvas-image-preview";
      _img.alt = "";
      _img.draggable = false;
      // Insert after the checker but still before #studio-canvas.
      if (_checker.nextSibling) vp.insertBefore(_img, _checker.nextSibling);
      else vp.appendChild(_img);
    }
    return true;
  }

  // --- positioning ------------------------------------------------------
  //
  // Both elements are positioned/sized in CSS pixels to match the
  // document area on screen, just like the canvas's zoom transform paints
  // it. Cheap to call every redraw.
  function _positionLayers() {
    var S = window.StudioCore && window.StudioCore.state;
    if (!S || !S.W || !S.H) return;
    var z = S.zoom || { scale: 1, ox: 0, oy: 0 };
    var x = (z.ox | 0);
    var y = (z.oy | 0);
    var w = ((S.W * z.scale) | 0);
    var h = ((S.H * z.scale) | 0);

    if (_img) {
      _img.style.left = x + "px";
      _img.style.top = y + "px";
      _img.style.width = w + "px";
      _img.style.height = h + "px";
    }
    if (_checker) {
      _checker.style.left = x + "px";
      _checker.style.top = y + "px";
      _checker.style.width = w + "px";
      _checker.style.height = h + "px";
      // Checker square size scales with zoom so the pattern matches what
      // the all-canvas mode draws (10 doc-px per square).
      var cs = Math.max(1, Math.round(10 * z.scale));
      _checker.style.backgroundSize = (cs * 2) + "px " + (cs * 2) + "px";
      _checker.style.backgroundPosition =
        "0 0, 0 " + cs + "px, " + cs + "px -" + cs + "px, -" + cs + "px 0";
    }
  }

  // --- src refresh ------------------------------------------------------

  function _refreshNow() {
    if (!_enabled) return;
    var Core = window.StudioCore;
    if (!Core || typeof Core.exportFlattened !== "function") return;
    var S = Core.state;
    if (!S || !S.W || !S.H) return;
    if (!_ensureLayers()) return;
    var dataUrl;
    try {
      dataUrl = Core.exportFlattened("image/png");
    } catch (e) {
      console.warn(TAG, "exportFlattened failed:", e && e.message ? e.message : e);
      return;
    }
    if (!dataUrl) return;
    _img.onload = function () {
      if (!_enabled) return;
      _positionLayers();
      _img.style.display = "block";
      if (_checker) _checker.style.display = "block";
    };
    _img.onerror = function () {
      console.warn(TAG, "preview image load failed");
    };
    _img.src = dataUrl;
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
    if (_checker) _checker.style.display = "none";
  }

  // --- redraw hook ------------------------------------------------------
  //
  // Called after every StudioUI.redraw. Always updates positions (cheap;
  // pan/zoom/resize). Only schedules a PNG re-encode when the canonical
  // composite version actually advances — cursor moves, marching ants,
  // hover state, etc. don't bump the version, so they won't thrash
  // exportFlattened.
  function _maybeRefresh() {
    if (!_enabled) return;
    _positionLayers();
    var Core = window.StudioCore;
    var v = (Core && typeof Core.getCompositeVersion === "function")
      ? Core.getCompositeVersion()
      : 0;
    if (v === _lastPreviewVersion) return;
    _lastPreviewVersion = v;
    _scheduleRefresh();
  }

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
      _maybeRefresh();
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
    var Core = window.StudioCore;
    if (Core && Core.state) Core.state.imagePreviewActive = on;
    if (!_enabled) {
      hide();
      var UI = window.StudioUI;
      if (UI && UI.redraw) UI.redraw();
    } else {
      _injectStyles();
      _ensureLayers();
      // Force regenerate on first enable, regardless of version.
      _lastPreviewVersion = -1;
      _refreshNow();
      var UI2 = window.StudioUI;
      if (UI2 && UI2.redraw) UI2.redraw();
    }
  }

  function isEnabled() { return _enabled; }

  function refresh() {
    // External callers force-refresh by invalidating the cache.
    _lastPreviewVersion = -1;
    _scheduleRefresh();
  }

  // --- init -------------------------------------------------------------

  function _init() {
    _enabled = _readEnabled();
    var Core = window.StudioCore;
    if (Core && Core.state) Core.state.imagePreviewActive = _enabled;

    _injectStyles();
    _ensureLayers();
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

    if (_enabled) {
      _lastPreviewVersion = -1;
      _refreshNow();
    }
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
