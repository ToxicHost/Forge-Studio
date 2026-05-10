// Optional idle <img> overlay over the canvas viewport.
//
// On Firefox + a calibrated wide-gamut display, the on-screen <canvas>
// renders chromatic pixels more saturated than the same image displayed
// via an <img> element (e.g. the result-preview overlay or a Photoshop
// view of the saved file). Exported pixels are correct (PR #151 routes
// imports through Pillow + putImageData), but the working canvas still
// looks off.
//
// This module fixes the visual mismatch WITHOUT touching pixel data:
// while the user is idle, it overlays the canvas with an <img> showing
// the same content. During interaction (pointerdown, pan, zoom, brush
// stroke) it hides so the real canvas takes over for editing. Once
// interaction settles, a debounced refresh re-snaps the overlay.
//
// Off by default. Toggle:
//   Settings → Canvas → "Match gallery preview colors"
// or programmatically:
//   window.StudioCanvasColorPreview.setEnabled(true);
//
// Public API:
//   .setEnabled(bool)       persists to localStorage
//   .isEnabled()
//   .refresh()              schedules a debounced redraw (no-op if disabled)
//   .hide()                 immediate hide (e.g. when starting a manual op)

(function () {
  "use strict";

  var STORAGE_KEY = "studio-canvas-color-preview-overlay";
  var DEBOUNCE_MS = 150;
  var TAG = "[Studio CanvasColorPreview]";

  var _enabled = false;
  var _overlay = null;
  var _refreshTimer = null;
  var _interacting = false;
  var _redrawWrapped = false;

  function _readPersisted() {
    try { return localStorage.getItem(STORAGE_KEY) === "1"; }
    catch (e) { return false; }
  }

  function _writePersisted(on) {
    try { localStorage.setItem(STORAGE_KEY, on ? "1" : "0"); }
    catch (e) { /* ignore */ }
  }

  function _ensureOverlay() {
    if (_overlay) return _overlay;
    var vp = document.getElementById("studio-viewport");
    if (!vp) return null;
    _overlay = document.createElement("img");
    _overlay.id = "canvasColorPreviewOverlay";
    _overlay.alt = "";
    _overlay.draggable = false;
    _overlay.style.cssText = [
      "position:absolute",
      "pointer-events:none",
      "user-select:none",
      "image-rendering:auto",
      "display:none",
      "z-index:1",   // sits over the canvas (which is z-default within #studio-viewport)
      "box-shadow:none",
      "background:transparent",
    ].join(";");
    vp.appendChild(_overlay);
    return _overlay;
  }

  function _positionToDocumentArea() {
    var S = window.StudioCore && window.StudioCore.state;
    if (!S || !_overlay) return;
    var z = S.zoom || { scale: 1, ox: 0, oy: 0 };
    _overlay.style.left = (z.ox | 0) + "px";
    _overlay.style.top = (z.oy | 0) + "px";
    _overlay.style.width = ((S.W * z.scale) | 0) + "px";
    _overlay.style.height = ((S.H * z.scale) | 0) + "px";
  }

  function hide() {
    if (_overlay) _overlay.style.display = "none";
  }

  function _refreshNow() {
    if (!_enabled || _interacting) return;
    var Core = window.StudioCore;
    if (!Core || typeof Core.exportFlattened !== "function") return;
    var S = Core.state;
    if (!S || !S.W || !S.H) return;

    var ov = _ensureOverlay();
    if (!ov) return;

    var dataUrl;
    try {
      dataUrl = Core.exportFlattened("image/png");
    } catch (e) {
      console.warn(TAG, "exportFlattened failed:", e && e.message ? e.message : e);
      hide();
      return;
    }
    if (!dataUrl) { hide(); return; }

    ov.onload = function () {
      // Recheck — user may have started interacting while the data URL
      // was decoding asynchronously.
      if (!_enabled || _interacting) return;
      _positionToDocumentArea();
      ov.style.display = "block";
    };
    ov.onerror = function () {
      console.warn(TAG, "overlay image load failed");
      hide();
    };
    ov.src = dataUrl;
  }

  function _scheduleRefresh() {
    if (!_enabled) return;
    if (_refreshTimer) clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(function () {
      _refreshTimer = null;
      _refreshNow();
    }, DEBOUNCE_MS);
  }

  // --- interaction handlers ---------------------------------------------

  function _beginInteraction() {
    _interacting = true;
    hide();
  }

  function _endInteraction() {
    if (!_interacting) return;
    _interacting = false;
    _scheduleRefresh();
  }

  function _onPointerDown() { _beginInteraction(); }
  function _onPointerUp()   { _endInteraction(); }
  function _onPointerCancel() { _endInteraction(); }

  function _onWheel() {
    // Zoom — treat as a transient interaction. Hide immediately so the
    // user sees the live canvas while scrolling, refresh once they stop.
    if (!_interacting) hide();
    _scheduleRefresh();
  }

  function _onResize() {
    if (_enabled) _scheduleRefresh();
  }

  // --- redraw hook ------------------------------------------------------
  //
  // Wrap StudioUI.redraw so any structural change (Send-to-Canvas, undo,
  // layer toggle, transform commit, etc.) triggers a debounced refresh.
  // The debounce makes brush-stroke spam cheap (refresh fires once after
  // the stroke settles, not per frame).
  function _hookRedraw() {
    if (_redrawWrapped) return;
    var UI = window.StudioUI;
    if (!UI || typeof UI.redraw !== "function") {
      setTimeout(_hookRedraw, 250);
      return;
    }
    var original = UI.redraw;
    UI.redraw = function () {
      var ret = original.apply(this, arguments);
      if (_enabled) _scheduleRefresh();
      return ret;
    };
    _redrawWrapped = true;
  }

  // --- public API -------------------------------------------------------

  function setEnabled(on) {
    on = !!on;
    if (on === _enabled) return;
    _enabled = on;
    _writePersisted(on);
    if (!_enabled) {
      hide();
      if (_refreshTimer) { clearTimeout(_refreshTimer); _refreshTimer = null; }
    } else {
      _scheduleRefresh();
    }
  }

  function isEnabled() { return _enabled; }

  function refresh() {
    if (_enabled) _scheduleRefresh();
  }

  // --- init -------------------------------------------------------------

  function _init() {
    _enabled = _readPersisted();

    var canvas = document.getElementById("studio-canvas");
    if (!canvas) {
      // Studio canvas isn't mounted yet — try again shortly. This module
      // is loaded as an optional script after canvas-ui.js so it usually
      // is, but Studio's panel-tab init can defer mounting.
      setTimeout(_init, 250);
      return;
    }

    canvas.addEventListener("pointerdown", _onPointerDown, true);
    document.addEventListener("pointerup", _onPointerUp, true);
    document.addEventListener("pointercancel", _onPointerCancel, true);
    canvas.addEventListener("wheel", _onWheel, { passive: true });
    window.addEventListener("resize", _onResize);

    _hookRedraw();

    // Wire the Settings → Canvas toggle if present. Re-syncs visual state
    // from persisted setting on init.
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

    if (_enabled) _scheduleRefresh();
  }

  window.StudioCanvasColorPreview = {
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
