// Display-only WebGL viewport backend.
//
// Replaces the PR #155/#157 <img> preview path. Same goal — let the on-
// screen document render via a surface that doesn't go through the
// <canvas> color pipeline that's been desaturating chromatic pixels for
// Moritz on Firefox + a calibrated wide-gamut display — but via WebGL
// instead of an <img>, so view updates (zoom, pan, resize) are GPU
// transforms instead of PNG re-encodes.
//
// Architecture (three planes in #studio-viewport):
//
//   z-index 0   #studio-canvas-webgl-preview   void + checker + document
//                                              GPU-rendered each frame
//   z-index 2   #studio-canvas                 transparent UI overlay;
//                                              cursor, wet stroke,
//                                              selections, masks, regions,
//                                              transform handles
//   offscreen   layer canvases                 canonical pixels (export,
//                                              undo, getFlattenedImageData)
//
// Export remains unchanged. exportFlattened reads layer canvases via
// StudioCore._renderFlattenedToContext; saved files are byte-faithful as
// before. The WebGL preview is never used as a save source.
//
// View-only operations (zoom, pan, viewport resize) re-render WebGL
// immediately. Pixel-changing operations (stroke commit, layer
// add/delete, transform, paste, fill, Develop change, etc.) bump
// StudioCore._compositeVersion which we track to know when to re-upload
// the document texture.
//
// Public API:
//   window.StudioCanvasWebGLPreview.setEnabled(bool)
//   window.StudioCanvasWebGLPreview.isEnabled()
//   window.StudioCanvasWebGLPreview.renderNow()
//   window.StudioCanvasWebGLPreview.markViewDirty()
//   window.StudioCanvasWebGLPreview.markPixelsDirty()
//   window.StudioCanvasWebGLPreview.beginLiveCanvasFallback(reason?)
//   window.StudioCanvasWebGLPreview.endLiveCanvasFallback(reason?)
//   window.StudioCanvasWebGLPreview.isLiveCanvasFallbackActive()
//   window.StudioCanvasWebGLPreview.dispose()
//
// On by default for fresh installs; explicit user opt-out is respected.
// Toggle: Settings → Canvas → "GPU canvas preview" (same toggle id from
// PR #155).

(function () {
  "use strict";

  // Reuse the existing toggle's storage key so users who had image-
  // preview enabled get WebGL preview automatically after update.
  var STORAGE_KEY = "studio-canvas-image-preview-enabled";
  var TAG = "[Studio CanvasWebGLPreview]";

  var _enabled = false;
  var _initFailed = false;

  // Temporary fallback mode for continuous heavy tools (smudge, blur,
  // pixelate, dodge, liquify, clone). Independent of the user toggle —
  // when these tools start dragging, canvas-ui calls
  // beginLiveCanvasFallback() to route the document display back through
  // Canvas 2D so the user sees per-frame edits without waiting for the
  // full WebGL texture re-upload. On pointer-up the fallback ends, we
  // refresh the texture once, and WebGL takes over again at rest.
  // Never persisted. Never flips the user toggle.
  var _liveFallback = false;

  var _glCanvas = null;
  var _gl = null;
  var _isGL2 = false;

  var _docProgram = null;
  var _docUniforms = null;
  var _checkerProgram = null;
  var _checkerUniforms = null;
  var _quadBuffer = null;

  var _docTexture = null;
  var _texW = 0, _texH = 0;
  var _texMagFilter = 0; // last-applied TEXTURE_MAG_FILTER (NEAREST or LINEAR)
  var _texMinFilter = 0; // last-applied TEXTURE_MIN_FILTER

  var _viewDirty = true;
  var _pixelsDirty = true;
  var _rafId = 0;

  var _redrawHookInstalled = false;
  var _commitHookInstalled = false;
  var _lastRenderedVersion = -1;
  var _voidColor = [0.118, 0.129, 0.188, 1.0]; // approximate --bg-void #1e2130

  // --- persistence ------------------------------------------------------

  function _readEnabled() {
    // Default-on for fresh installs (no saved value). Respect explicit
    // user opt-out / opt-in if present. Anything other than "0" is
    // treated as on so the WebGL backend is the default display path.
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw === "0") return false;
      if (raw === "1") return true;
      return true;
    } catch (e) {
      return true;
    }
  }
  function _writeEnabled(on) {
    try { localStorage.setItem(STORAGE_KEY, on ? "1" : "0"); }
    catch (e) { /* ignore */ }
  }

  // --- void color from CSS variable -------------------------------------
  // Read the same --bg-void the Canvas 2D mode uses so themes apply.

  function _refreshVoidColor() {
    try {
      var hex = getComputedStyle(document.documentElement)
        .getPropertyValue("--bg-void").trim();
      if (!hex) return;
      var rgb = _hexToRgb01(hex);
      if (rgb) _voidColor = [rgb[0], rgb[1], rgb[2], 1.0];
    } catch (e) { /* ignore */ }
  }
  function _hexToRgb01(s) {
    s = s.replace("#", "");
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (s.length !== 6) return null;
    var n = parseInt(s, 16);
    if (isNaN(n)) return null;
    return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
  }

  // --- shaders ----------------------------------------------------------
  //
  // One vertex shader for both passes: takes a unit-quad attribute (0..1)
  // in document UV space, transforms via uDocSize/uOffset/uScale/uViewSize
  // to clip space. DPR doesn't appear here because the GL viewport itself
  // is set to backing pixels — the canvas style is CSS pixels, and the
  // shader's uViewSize is CSS pixels too.

  var VERT_SRC = [
    "attribute vec2 aPos;",
    "uniform vec2 uDocSize;",
    "uniform vec2 uOffset;",  // CSS px
    "uniform float uScale;",
    "uniform vec2 uViewSize;", // CSS px (viewport)
    "varying vec2 vUV;",
    "varying vec2 vDocPos;",
    "void main() {",
    "  vDocPos = aPos * uDocSize;",
    "  vec2 cssPx = vDocPos * uScale + uOffset;",
    "  vec2 clip = vec2(",
    "    2.0 * cssPx.x / uViewSize.x - 1.0,",
    "    1.0 - 2.0 * cssPx.y / uViewSize.y",
    "  );",
    "  gl_Position = vec4(clip, 0.0, 1.0);",
    "  vUV = aPos;",
    "}",
  ].join("\n");

  // Checker fragment: solid 10-doc-pixel squares, alternating shades.
  // Matches the existing Canvas 2D checker (#3a3a3a / #444).
  var FRAG_CHECKER_SRC = [
    "precision mediump float;",
    "varying vec2 vDocPos;",
    "void main() {",
    "  vec2 cell = floor(vDocPos / 10.0);",
    "  float odd = mod(cell.x + cell.y, 2.0);",
    "  vec3 c = mix(vec3(0.267), vec3(0.227), odd);",
    "  gl_FragColor = vec4(c, 1.0);",
    "}",
  ].join("\n");

  // Document fragment: straight sample from the flattened texture. Alpha
  // preserved; blending against the checker pass happens in the
  // framebuffer via gl.blendFunc.
  var FRAG_DOC_SRC = [
    "precision mediump float;",
    "uniform sampler2D uTex;",
    "varying vec2 vUV;",
    "void main() {",
    "  gl_FragColor = texture2D(uTex, vUV);",
    "}",
  ].join("\n");

  // --- WebGL boilerplate -----------------------------------------------

  function _compileShader(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var info = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error("shader compile failed: " + info);
    }
    return sh;
  }
  function _linkProgram(gl, vsSrc, fsSrc) {
    var vs = _compileShader(gl, gl.VERTEX_SHADER, vsSrc);
    var fs = _compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    var p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      var info = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error("program link failed: " + info);
    }
    return p;
  }
  function _uniformLocs(gl, program, names) {
    var out = {};
    for (var i = 0; i < names.length; i++) out[names[i]] = gl.getUniformLocation(program, names[i]);
    return out;
  }

  // --- init / teardown --------------------------------------------------

  function _ensureCanvas() {
    if (_glCanvas) return _glCanvas;
    var vp = document.getElementById("studio-viewport");
    if (!vp) return null;
    _glCanvas = document.createElement("canvas");
    _glCanvas.id = "studio-canvas-webgl-preview";
    _glCanvas.setAttribute("aria-hidden", "true");
    // Insert at the start so DOM order matches z-index (the #studio-canvas
    // overlay above us comes later in the viewport).
    if (vp.firstChild) vp.insertBefore(_glCanvas, vp.firstChild);
    else vp.appendChild(_glCanvas);
    return _glCanvas;
  }

  function _initGL() {
    if (_gl) return true;
    if (_initFailed) return false;
    var cv = _ensureCanvas();
    if (!cv) return false;
    var opts = { alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false, antialias: false };
    var gl = cv.getContext("webgl2", opts);
    _isGL2 = !!gl;
    if (!gl) gl = cv.getContext("webgl", opts);
    if (!gl) {
      _initFailed = true;
      console.warn(TAG, "WebGL unavailable");
      return false;
    }
    try { if ("drawingBufferColorSpace" in gl) gl.drawingBufferColorSpace = "srgb"; } catch (e) { /* unsupported */ }
    try { if ("unpackColorSpace" in gl) gl.unpackColorSpace = "srgb"; } catch (e) { /* unsupported */ }

    try {
      _docProgram = _linkProgram(gl, VERT_SRC, FRAG_DOC_SRC);
      _checkerProgram = _linkProgram(gl, VERT_SRC, FRAG_CHECKER_SRC);
    } catch (e) {
      _initFailed = true;
      console.warn(TAG, "shader compile/link failed:", e.message || e);
      return false;
    }

    _docUniforms = _uniformLocs(gl, _docProgram,
      ["uDocSize", "uOffset", "uScale", "uViewSize", "uTex"]);
    _checkerUniforms = _uniformLocs(gl, _checkerProgram,
      ["uDocSize", "uOffset", "uScale", "uViewSize"]);

    // Unit quad: two triangles covering (0,0)-(1,1) in UV space.
    var quadVerts = new Float32Array([0, 0,  1, 0,  0, 1,  0, 1,  1, 0,  1, 1]);
    _quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, _quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

    _docTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, _docTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Filters get reassigned dynamically per frame in renderNow() based on
    // S.zoom.scale: NEAREST when zoomed in so pixels stay crisp, LINEAR
    // when zoomed out so downscaled previews stay smooth. Seed with
    // NEAREST mag (the visible-pixel case) and LINEAR min as a sensible
    // starting state before the first render.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    _texMinFilter = gl.LINEAR;
    _texMagFilter = gl.NEAREST;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    _gl = gl;
    _refreshVoidColor();
    return true;
  }

  function _disposeGL() {
    if (!_gl) return;
    try { _gl.deleteProgram(_docProgram); } catch (e) {}
    try { _gl.deleteProgram(_checkerProgram); } catch (e) {}
    try { _gl.deleteBuffer(_quadBuffer); } catch (e) {}
    try { _gl.deleteTexture(_docTexture); } catch (e) {}
    _docProgram = _checkerProgram = _quadBuffer = _docTexture = null;
    _docUniforms = _checkerUniforms = null;
    _gl = null;
    _isGL2 = false;
    _texW = _texH = 0;
    _lastRenderedVersion = -1;
  }

  // --- texture upload ---------------------------------------------------

  function _uploadTexture() {
    if (!_gl) return;
    var Core = window.StudioCore;
    if (!Core || typeof Core.getFlattenedImageData !== "function") return;
    var S = Core.state;
    if (!S || !S.W || !S.H) return;
    var imgData;
    try { imgData = Core.getFlattenedImageData(); }
    catch (e) {
      console.warn(TAG, "getFlattenedImageData failed:", e && e.message ? e.message : e);
      return;
    }
    if (!imgData || !imgData.data) return;

    _gl.bindTexture(_gl.TEXTURE_2D, _docTexture);
    if (_texW !== S.W || _texH !== S.H) {
      _gl.texImage2D(_gl.TEXTURE_2D, 0, _gl.RGBA, S.W, S.H, 0,
        _gl.RGBA, _gl.UNSIGNED_BYTE, imgData.data);
      _texW = S.W; _texH = S.H;
    } else {
      _gl.texSubImage2D(_gl.TEXTURE_2D, 0, 0, 0, S.W, S.H,
        _gl.RGBA, _gl.UNSIGNED_BYTE, imgData.data);
    }
  }

  // --- canvas sizing ----------------------------------------------------

  function _syncCanvasSize() {
    if (!_glCanvas) return;
    var S = window.StudioCore && window.StudioCore.state;
    if (!S) return;
    var cssW = S.viewportCssW || _glCanvas.clientWidth || 0;
    var cssH = S.viewportCssH || _glCanvas.clientHeight || 0;
    var dpr = S.displayDpr || 1;
    var bufW = Math.max(1, Math.round(cssW * dpr));
    var bufH = Math.max(1, Math.round(cssH * dpr));
    if (_glCanvas.width !== bufW || _glCanvas.height !== bufH) {
      _glCanvas.width = bufW;
      _glCanvas.height = bufH;
    }
    if (_glCanvas.style.width !== cssW + "px") _glCanvas.style.width = cssW + "px";
    if (_glCanvas.style.height !== cssH + "px") _glCanvas.style.height = cssH + "px";
  }

  // --- render -----------------------------------------------------------

  function _drawQuad(program, uniforms, S, z, dpr, viewCssW, viewCssH) {
    var gl = _gl;
    gl.useProgram(program);
    var aPosLoc = gl.getAttribLocation(program, "aPos");
    gl.bindBuffer(gl.ARRAY_BUFFER, _quadBuffer);
    gl.enableVertexAttribArray(aPosLoc);
    gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);

    // Canvas 2D's applyDisplayTransform multiplies offset by DPR and the
    // browser rounds the resulting device-pixel translate. Match that here
    // so toggling WebGL on/off at high zoom doesn't shift the document by
    // a subpixel — round to the device-pixel grid in CSS space.
    var snappedOx = Math.round(z.ox * dpr) / dpr;
    var snappedOy = Math.round(z.oy * dpr) / dpr;

    gl.uniform2f(uniforms.uDocSize, S.W, S.H);
    gl.uniform2f(uniforms.uOffset, snappedOx, snappedOy);
    gl.uniform1f(uniforms.uScale, z.scale);
    gl.uniform2f(uniforms.uViewSize, viewCssW, viewCssH);
    if (uniforms.uTex) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, _docTexture);
      gl.uniform1i(uniforms.uTex, 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  function renderNow() {
    if (!_enabled || !_gl) return;
    // Live-fallback mode: Canvas 2D is responsible for the document
    // display right now. Don't touch the texture or the GL surface.
    if (_liveFallback) return;
    var Core = window.StudioCore;
    var S = Core && Core.state;
    if (!S || !S.W || !S.H) return;

    _syncCanvasSize();

    if (_pixelsDirty || _texW === 0) {
      _uploadTexture();
      _pixelsDirty = false;
      if (typeof Core.getCompositeVersion === "function") {
        _lastRenderedVersion = Core.getCompositeVersion();
      }
    }

    var gl = _gl;
    var z = S.zoom || { scale: 1, ox: 0, oy: 0 };
    var dpr = S.displayDpr || 1;
    var viewCssW = S.viewportCssW || _glCanvas.clientWidth || 0;
    var viewCssH = S.viewportCssH || _glCanvas.clientHeight || 0;

    // Pick texture filters based on display scale. At >= 1x we want crisp
    // pixel edges (zoomed in), below 1x we want smooth downscale. This is
    // display-only — source/layer pixels and export are untouched.
    var wantMag = (z.scale >= 1) ? gl.NEAREST : gl.LINEAR;
    var wantMin = (z.scale >= 1) ? gl.NEAREST : gl.LINEAR;
    if (wantMag !== _texMagFilter || wantMin !== _texMinFilter) {
      gl.bindTexture(gl.TEXTURE_2D, _docTexture);
      if (wantMag !== _texMagFilter) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, wantMag);
        _texMagFilter = wantMag;
      }
      if (wantMin !== _texMinFilter) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, wantMin);
        _texMinFilter = wantMin;
      }
    }

    gl.viewport(0, 0, _glCanvas.width, _glCanvas.height);
    gl.disable(gl.BLEND);
    gl.clearColor(_voidColor[0], _voidColor[1], _voidColor[2], _voidColor[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Checker fills the document rectangle (vertex shader maps the unit
    // quad to (ox, oy)..(ox + S.W*scale, oy + S.H*scale) in CSS px).
    _drawQuad(_checkerProgram, _checkerUniforms, S, z, dpr, viewCssW, viewCssH);

    // Document over checker with straight alpha. Texture preserves
    // transparency so the checker shows through where layers are.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    _drawQuad(_docProgram, _docUniforms, S, z, dpr, viewCssW, viewCssH);

    _viewDirty = false;
  }

  function _scheduleRender() {
    if (_rafId) return;
    _rafId = requestAnimationFrame(function () {
      _rafId = 0;
      try { renderNow(); }
      catch (e) { console.warn(TAG, "render error:", e && e.message ? e.message : e); }
    });
  }

  function markViewDirty() {
    if (!_enabled) return;
    _viewDirty = true;
    _scheduleRender();
  }

  function markPixelsDirty() {
    if (!_enabled) return;
    _pixelsDirty = true;
    _viewDirty = true;
    _scheduleRender();
  }

  // --- live-canvas fallback --------------------------------------------
  //
  // Temporary display routing for continuous heavy tools (smudge/blur/
  // pixelate/dodge/liquify/clone) that mutate layer pixels every frame.
  // Re-uploading the whole flattened document texture at 60 fps is too
  // slow for those, so canvas-ui calls beginLiveCanvasFallback() at
  // drag-start and endLiveCanvasFallback() at drag-stop. While active,
  // the WebGL surface hides and S.imagePreviewActive is false so
  // canvas-core.js composite() draws the document onto S.ctx normally.
  // On end, the texture refreshes once and WebGL takes over again.
  //
  // The user's "GPU canvas preview" toggle is untouched —
  // _enabled, the storage key, and the visual toggle state all stay
  // exactly where they were. This is purely a render routing detour.

  function beginLiveCanvasFallback(reason) {
    if (!_enabled || _liveFallback) return;
    _liveFallback = true;
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
    var Core = window.StudioCore;
    if (Core && Core.state) Core.state.imagePreviewActive = false;
    _hideCanvas();
    var UI = window.StudioUI;
    if (UI && UI.redraw) UI.redraw();
  }

  function endLiveCanvasFallback(reason) {
    if (!_liveFallback) return;
    _liveFallback = false;
    if (!_enabled) return;
    var Core = window.StudioCore;
    if (Core && Core.state) Core.state.imagePreviewActive = true;
    _showCanvas();
    // The just-committed layer pixels need to land in the WebGL texture
    // before we hand display back from Canvas 2D. Force an immediate
    // upload + render so there's no visual gap.
    _pixelsDirty = true;
    _viewDirty = true;
    try { renderNow(); }
    catch (e) { console.warn(TAG, "post-fallback render failed:", e && e.message ? e.message : e); }
    // Trigger a Canvas 2D redraw so the overlay's document blit (drawn
    // while fallback was active) gets cleared — composite() respects the
    // imagePreviewActive flag we just re-set to true.
    var UI = window.StudioUI;
    if (UI && UI.redraw) UI.redraw();
  }

  function isLiveCanvasFallbackActive() { return _liveFallback; }

  // --- redraw hook ------------------------------------------------------
  //
  // StudioUI.onAfterRedraw fires for every internal _redraw() call (wheel
  // zoom, pan, hover, stroke frame) AND every external StudioUI.redraw
  // call. Version-gate the texture re-upload; always re-render for view
  // updates.

  function _onAfterRedraw() {
    if (!_enabled) return;
    // While Canvas 2D is taking over (live-fallback for heavy tools),
    // canvas-core.js is drawing the document on S.ctx each frame and
    // bumping _compositeVersion. Skip both texture upload and GL render
    // so we don't queue work that endLiveCanvasFallback will redo.
    if (_liveFallback) return;
    var Core = window.StudioCore;
    var v = (Core && typeof Core.getCompositeVersion === "function")
      ? Core.getCompositeVersion() : 0;
    if (v !== _lastRenderedVersion) {
      _pixelsDirty = true;
    }
    markViewDirty();
  }

  function _installRedrawHook() {
    if (_redrawHookInstalled) return;
    var UI = window.StudioUI;
    if (!UI || typeof UI.onAfterRedraw !== "function") {
      setTimeout(_installRedrawHook, 250);
      return;
    }
    UI.onAfterRedraw(_onAfterRedraw);
    _redrawHookInstalled = true;
  }

  // commitStroke doesn't bump _compositeVersion — it modifies the layer
  // canvas in place. Wrap it so brush/eraser release forces a texture
  // re-upload before the next frame.
  function _installCommitHook() {
    if (_commitHookInstalled) return;
    var Core = window.StudioCore;
    if (!Core || typeof Core.commitStroke !== "function") {
      setTimeout(_installCommitHook, 250);
      return;
    }
    if (Core._webglCommitHooked) { _commitHookInstalled = true; return; }
    Core._webglCommitHooked = true;
    var orig = Core.commitStroke;
    Core.commitStroke = function () {
      var ret = orig.apply(this, arguments);
      if (_enabled) {
        _pixelsDirty = true;
        renderNow();
      }
      return ret;
    };
    _commitHookInstalled = true;
  }

  // --- enable/disable ---------------------------------------------------

  function _showCanvas() {
    if (_glCanvas) _glCanvas.style.display = "block";
  }
  function _hideCanvas() {
    if (_glCanvas) _glCanvas.style.display = "none";
  }

  function setEnabled(on, opts) {
    on = !!on;
    var silent = !!(opts && opts.silent);
    if (on === _enabled) return;

    if (on) {
      if (!_initGL()) {
        // Single toast only when the user explicitly toggles on and it
        // fails — boot-time auto-enable on a WebGL-less device stays
        // silent so users aren't nagged every reload.
        if (!silent && typeof window.showToast === "function") {
          window.showToast("WebGL preview unavailable — using standard canvas", "warning");
        }
        return;
      }
      _enabled = true;
      _writeEnabled(true);
      var Core = window.StudioCore;
      if (Core && Core.state) Core.state.imagePreviewActive = true;
      _showCanvas();
      _pixelsDirty = true;
      _viewDirty = true;
      renderNow();
      // Force a Canvas 2D redraw so the overlay clears its document
      // pixels and the WebGL preview takes over visually.
      var UI = window.StudioUI;
      if (UI && UI.redraw) UI.redraw();
    } else {
      _enabled = false;
      _writeEnabled(false);
      var Core2 = window.StudioCore;
      if (Core2 && Core2.state) Core2.state.imagePreviewActive = false;
      _hideCanvas();
      var UI2 = window.StudioUI;
      if (UI2 && UI2.redraw) UI2.redraw();
    }
  }

  function isEnabled() { return _enabled; }

  function dispose() {
    setEnabled(false);
    _disposeGL();
    if (_glCanvas && _glCanvas.parentNode) {
      try { _glCanvas.parentNode.removeChild(_glCanvas); } catch (e) { /* ignore */ }
    }
    _glCanvas = null;
  }

  // --- init -------------------------------------------------------------

  function _init() {
    _ensureCanvas();
    _installRedrawHook();
    _installCommitHook();

    // Listen for viewport resizes so the GL backing buffer follows. The
    // existing window.resize handler in canvas-ui.js calls
    // syncCanvasToViewport which updates S.viewportCssW/H — the redraw
    // hook fires next and picks up the new size via _syncCanvasSize.
    window.addEventListener("resize", function () { if (_enabled) markViewDirty(); });

    var toggle = document.getElementById("toggleCanvasColorPreview");
    if (toggle) {
      if (_readEnabled()) toggle.classList.add("on");
      else toggle.classList.remove("on");
      toggle.addEventListener("click", function () {
        var nowOn = !_enabled;
        setEnabled(nowOn);
        toggle.classList.toggle("on", _enabled);
      });
    }

    if (_readEnabled()) {
      // Default-on for fresh installs or restore explicit opt-in. Pass
      // silent so a WebGL-less device doesn't toast on every boot; the
      // app falls back to Canvas 2D and the toggle visually reflects
      // whatever _enabled ends up being.
      setEnabled(true, { silent: true });
      if (toggle) toggle.classList.toggle("on", _enabled);
    }
  }

  window.StudioCanvasWebGLPreview = {
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    renderNow: renderNow,
    markViewDirty: markViewDirty,
    markPixelsDirty: markPixelsDirty,
    beginLiveCanvasFallback: beginLiveCanvasFallback,
    endLiveCanvasFallback: endLiveCanvasFallback,
    isLiveCanvasFallbackActive: isLiveCanvasFallbackActive,
    dispose: dispose,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _init);
  } else {
    _init();
  }
})();
