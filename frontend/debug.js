// Studio color-pipeline diagnostic.
//
// Maintainer/dev-only — not surfaced in any UI. Open the browser dev tools and
// call:
//
//   window.StudioDebug.sampleColorPipeline(x, y, sourceUrl?)
//   window.StudioDebug.sampleColorPipelineSet(samples, sourceUrl?)
//   window.StudioDebug.sampleSavePath(x, y, format?, opts?)
//
// Both sample one document-space coordinate (or many) through the canvas →
// export pipeline at six observation points and emit an RGBA report. Used to
// pin down exactly where pixel values shift when the canvas and the saved
// export disagree (e.g. the Firefox-mode-2 calibrated-display case Moritz hit).
//
// Privacy: the report contains userAgent, dev-mode flag, canvas colorSpace,
// the sampled coordinates, RGB triples, and a "sourceKind" enum
// ("data-url" | "url" | "missing"). It does NOT log image URLs, file paths,
// prompts, filenames, model names, or any image bytes.

(function () {
  "use strict";

  // --- helpers ----------------------------------------------------------

  function _classifySource(sourceUrl) {
    if (!sourceUrl) return "missing";
    return (typeof sourceUrl === "string" && sourceUrl.startsWith("data:")) ? "data-url" : "url";
  }

  function _resolveSourceUrl(explicitSourceUrl) {
    if (explicitSourceUrl) return explicitSourceUrl;
    var State = window.State;
    if (!State) return null;
    var idx = (State.selectedOutputIdx != null) ? State.selectedOutputIdx : 0;
    return (State.outputImagesB64 && State.outputImagesB64[idx])
        || (State.outputImages && State.outputImages[idx])
        || null;
  }

  function _scratch(w, h) {
    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    var ctx = c.getContext("2d", { colorSpace: "srgb" });
    return { canvas: c, ctx: ctx };
  }

  function _toRGBA(imageData) {
    var d = imageData.data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] };
  }

  var NULL_RGBA = { r: null, g: null, b: null, a: null };

  function _safeRGBA(ctx, x, y) {
    if (!ctx) return NULL_RGBA;
    try { return _toRGBA(ctx.getImageData(x, y, 1, 1)); }
    catch (e) { return NULL_RGBA; }
  }

  async function _decodeIntoSrgb(blob, conversion) {
    var bmp = await createImageBitmap(blob, { colorSpaceConversion: conversion });
    var s = _scratch(bmp.width, bmp.height);
    s.ctx.drawImage(bmp, 0, 0);
    if (typeof bmp.close === "function") bmp.close();
    return s;
  }

  // HTMLImageElement decode path. This is the same path the result-preview
  // <img> uses, and is the visual baseline Moritz reports as "correct". If the
  // values here match the export and the createImageBitmap paths drift, the
  // split is between Firefox's <img> rendering and its ImageBitmap pipeline.
  async function _decodeViaImgIntoSrgb(sourceUrl) {
    var img = new Image();
    // Same-origin or data: URLs only — cross-origin would taint the canvas
    // and getImageData would throw. Studio's source URLs are local /file=
    // routes or data URLs, so this is fine.
    img.src = sourceUrl;
    if (typeof img.decode === "function") {
      await img.decode();
    } else {
      await new Promise(function (resolve, reject) {
        img.onload = resolve;
        img.onerror = function () { reject(new Error("img load failed")); };
      });
    }
    var s = _scratch(img.naturalWidth || img.width, img.naturalHeight || img.height);
    s.ctx.drawImage(img, 0, 0);
    return s;
  }

  // Replicates the visible-paint-layer composite that exportFlattened produces,
  // into a fresh sRGB scratch canvas. Diagnostic-grade approximation: skips
  // mask, region overlays, live preview, and adjustment layers — they don't
  // contribute to the export composite either.
  function _flattenLayers(S) {
    var s = _scratch(S.W, S.H);
    s.ctx.globalCompositeOperation = "source-over";
    s.ctx.globalAlpha = 1;
    var layers = S.layers || [];
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i];
      if (!L || !L.visible || L.type !== "paint" || !L.canvas) continue;
      s.ctx.globalAlpha = (L.opacity != null) ? L.opacity : 1;
      s.ctx.globalCompositeOperation = L.blendMode || "source-over";
      s.ctx.drawImage(L.canvas, 0, 0);
    }
    s.ctx.globalAlpha = 1;
    s.ctx.globalCompositeOperation = "source-over";
    return s;
  }

  function _blobFromDataUrl(dataUrl) {
    return fetch(dataUrl).then(function (r) { return r.blob(); });
  }

  function _meta(sourceUrl, samples) {
    var S = window.StudioCore && window.StudioCore.state;
    var canvasCS = "unknown";
    try {
      if (S && S.ctx && typeof S.ctx.getContextAttributes === "function") {
        var attrs = S.ctx.getContextAttributes();
        canvasCS = (attrs && attrs.colorSpace) || "unknown";
      }
    } catch (e) { /* ignore */ }
    return {
      userAgent: navigator.userAgent,
      developEnabled: !!(S && S.developParams && S.developParams.enabled),
      canvasColorSpace: canvasCS,
      sourceKind: _classifySource(sourceUrl),
      samples: samples,
    };
  }

  function _markdown(meta, rows) {
    var lines = [];
    lines.push("### Studio color-pipeline diagnostic");
    lines.push("");
    lines.push("**Metadata:**");
    lines.push("```json");
    lines.push(JSON.stringify(meta, null, 2));
    lines.push("```");
    lines.push("");
    lines.push("**Samples:**");
    lines.push("");
    lines.push("| Sample | Stage | R | G | B | A |");
    lines.push("|---|---|---:|---:|---:|---:|");
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      lines.push("| " + r.sample + " | " + r.stage + " | "
        + (r.r != null ? r.r : "-") + " | "
        + (r.g != null ? r.g : "-") + " | "
        + (r.b != null ? r.b : "-") + " | "
        + (r.a != null ? r.a : "-") + " |");
    }
    return lines.join("\n");
  }

  // --- core impl --------------------------------------------------------

  async function _runPipeline(samplesNorm, explicitSourceUrl) {
    var S = window.StudioCore && window.StudioCore.state;
    if (!S) throw new Error("[StudioDebug] StudioCore not loaded");

    var sourceUrl = _resolveSourceUrl(explicitSourceUrl);
    var meta = _meta(sourceUrl, samplesNorm.map(function (s) {
      return { label: s.label, x: s.x, y: s.y };
    }));

    // Decode source ONCE per path (independent of sample count). Three paths:
    //   <img>     — same as the result-preview overlay
    //   "none"    — current production decode for Send-to-Canvas
    //   "default" — alternative; was tried in PR #141 and drifted exports
    var sImg = null, sNone = null, sDef = null;
    if (sourceUrl) {
      try { sImg = await _decodeViaImgIntoSrgb(sourceUrl); } catch (e) { /* leave null */ }
      try {
        var blob = await fetch(sourceUrl).then(function (r) { return r.blob(); });
        try { sNone = await _decodeIntoSrgb(blob, "none"); } catch (e) { /* leave null */ }
        try { sDef  = await _decodeIntoSrgb(blob, "default"); } catch (e) { /* leave null */ }
      } catch (e) { /* fetch failed; sNone/sDef stay null */ }
    }

    // Build the export composite ONCE.
    var composite = _flattenLayers(S);
    var sExp = null;
    try {
      var dataUrl = composite.canvas.toDataURL("image/png");
      var expBlob = await _blobFromDataUrl(dataUrl);
      sExp = await _decodeIntoSrgb(expBlob, "none");
    } catch (e) { /* leave sExp null */ }

    // Active paint layer — the layer most-recently affected by Send-to-Canvas
    // (displayOnCanvas always sets S.activeLayerIdx to the layer it just
    // populated). Falls back to the topmost paint layer if activeLayerIdx
    // points at something else (e.g. an adjustment or mask layer). Don't
    // hardcode the name — gallery sends use "Output", manual imports use
    // "Imported", pipeline results use "Gen Result".
    var activeLayer = null;
    if (S.layers && S.layers.length) {
      var ai = (typeof S.activeLayerIdx === "number") ? S.activeLayerIdx : -1;
      if (ai >= 0 && ai < S.layers.length
          && S.layers[ai] && S.layers[ai].type === "paint" && S.layers[ai].canvas) {
        activeLayer = S.layers[ai];
      } else {
        for (var li = S.layers.length - 1; li >= 0; li--) {
          var L = S.layers[li];
          if (L && L.type === "paint" && L.canvas) { activeLayer = L; break; }
        }
      }
    }
    var activeCtx = (activeLayer && activeLayer.ctx) || null;
    var activeName = (activeLayer && activeLayer.name) || "(none)";

    // Display canvas. S.canvas is at viewport size with a zoom transform; map
    // document coords through the zoom to read the corresponding screen pixel.
    var z = S.zoom || { scale: 1, ox: 0, oy: 0 };
    var displayCanvas = S.canvas;

    var rows = [];
    for (var j = 0; j < samplesNorm.length; j++) {
      var sm = samplesNorm[j];
      var sx = Math.round(sm.x * z.scale + z.ox);
      var sy = Math.round(sm.y * z.scale + z.oy);
      var displaySample = NULL_RGBA;
      if (S.ctx && displayCanvas
          && sx >= 0 && sy >= 0
          && sx < displayCanvas.width && sy < displayCanvas.height) {
        displaySample = _safeRGBA(S.ctx, sx, sy);
      }

      rows.push(_row(sm.label, "1. source via <img> element",   sImg  ? _safeRGBA(sImg.ctx,  sm.x, sm.y) : NULL_RGBA));
      rows.push(_row(sm.label, "2. source via ImageBitmap 'none'", sNone ? _safeRGBA(sNone.ctx, sm.x, sm.y) : NULL_RGBA));
      rows.push(_row(sm.label, "3. source via ImageBitmap 'default'", sDef  ? _safeRGBA(sDef.ctx,  sm.x, sm.y) : NULL_RGBA));
      rows.push(_row(sm.label, "4. active paint layer (" + activeName + ")", _safeRGBA(activeCtx, sm.x, sm.y)));
      rows.push(_row(sm.label, "5. S.ctx display buffer",        displaySample));
      rows.push(_row(sm.label, "6. export composite (pre-toDataURL)", _safeRGBA(composite.ctx, sm.x, sm.y)));
      rows.push(_row(sm.label, "7. exported PNG re-decoded 'none'",   sExp ? _safeRGBA(sExp.ctx, sm.x, sm.y) : NULL_RGBA));
    }

    var markdown = _markdown(meta, rows);
    try { console.table(rows); } catch (e) { console.log(rows); }
    console.log(markdown);
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(markdown).catch(function () { /* clipboard denied; ignore */ });
    }

    return { meta: meta, rows: rows, markdown: markdown };
  }

  function _row(sample, stage, rgba) {
    return { sample: sample, stage: stage, r: rgba.r, g: rgba.g, b: rgba.b, a: rgba.a };
  }

  function _normalizeSamples(samples) {
    var S = window.StudioCore && window.StudioCore.state;
    var defX = S ? (S.W >> 1) : 0;
    var defY = S ? (S.H >> 1) : 0;
    if (!samples || !samples.length) {
      return [{ label: "center", x: defX, y: defY }];
    }
    return samples.map(function (s, i) {
      return {
        label: s.label || ("pt" + (i + 1)),
        x: ((s.x != null) ? s.x : defX) | 0,
        y: ((s.y != null) ? s.y : defY) | 0,
      };
    });
  }

  // --- public API -------------------------------------------------------

  function sampleColorPipeline(x, y, sourceUrl) {
    var S = window.StudioCore && window.StudioCore.state;
    var defX = S ? (S.W >> 1) : 0;
    var defY = S ? (S.H >> 1) : 0;
    var sample = {
      label: "single",
      x: ((x != null) ? x : defX) | 0,
      y: ((y != null) ? y : defY) | 0,
    };
    return _runPipeline([sample], sourceUrl);
  }

  function sampleColorPipelineSet(samples, sourceUrl) {
    return _runPipeline(_normalizeSamples(samples), sourceUrl);
  }

  // ----------------------------------------------------------------------
  // Save-path diagnostic
  //
  //   window.StudioDebug.sampleSavePath(x, y, format?, options?)
  //
  // Sends the current gallery selection's base64 to the backend's
  // /studio/api/debug/sample_save_path endpoint, which mirrors the
  // /studio/save_image PIL pipeline (Image.open → optional convert("RGB") →
  // save with icc_profile=_SRGB_ICC, no file output) and reports RGB +
  // ICC at three checkpoints. Optionally fetches the on-disk autosave
  // file to include as a "compare" baseline.
  //
  // Output: console.table + console.log markdown + clipboard copy +
  // returns { result, rows, markdown }.
  //
  // Privacy: never logs source URLs, file paths, prompts, filenames, or
  // image bytes. Only RGB triples, modes, sizes, ICC sizes, ICC profile
  // descriptions ("sRGB IEC61966-2.1", "Display P3", etc.).
  // ----------------------------------------------------------------------

  function _stagesFromResponse(r) {
    var rows = [];
    function row(stage, s) {
      if (!s) return;
      var rgba = s.rgba || [];
      var icc = s.icc || {};
      rows.push({
        stage: stage,
        x: s.x, y: s.y,
        r: rgba[0] != null ? rgba[0] : null,
        g: rgba[1] != null ? rgba[1] : null,
        b: rgba[2] != null ? rgba[2] : null,
        a: rgba[3] != null ? rgba[3] : null,
        mode: s.mode,
        size: (s.size || []).join("x"),
        icc: icc.present ? ((icc.description || "?") + " (" + icc.size + "B)") : "none",
      });
    }
    row("input (pre-save)", r.input);
    row("after save+reopen", r.after_save_reopen);
    row("compare (autosave file)", r.compare);
    return rows;
  }

  function _savePathMarkdown(r, rows) {
    var lines = [];
    lines.push("### Studio save-path diagnostic");
    lines.push("");
    lines.push("**Format:** " + r.format);
    lines.push("");
    lines.push("| Stage | x | y | R | G | B | A | Mode | Size | ICC |");
    lines.push("|---|---:|---:|---:|---:|---:|---:|---|---|---|");
    rows.forEach(function (row) {
      lines.push("| " + row.stage + " | " + row.x + " | " + row.y + " | "
        + (row.r != null ? row.r : "-") + " | "
        + (row.g != null ? row.g : "-") + " | "
        + (row.b != null ? row.b : "-") + " | "
        + (row.a != null ? row.a : "-") + " | "
        + (row.mode || "-") + " | "
        + (row.size || "-") + " | "
        + row.icc + " |");
    });
    return lines.join("\n");
  }

  async function _fetchAsDataUrl(url) {
    var resp = await fetch(url);
    var blob = await resp.blob();
    return await new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function sampleSavePath(x, y, format, opts) {
    opts = opts || {};
    format = format || "png";
    var State = window.State;
    var idx = (opts.idx != null) ? opts.idx
      : (State && State.selectedOutputIdx != null ? State.selectedOutputIdx : 0);
    var source = opts.image_b64
      || (State && State.outputImagesB64 && State.outputImagesB64[idx])
      || null;
    if (!source) throw new Error("[StudioDebug] no gallery selection (or pass opts.image_b64)");

    // Best-effort: pull the autosave file's bytes as a compare baseline.
    var compareB64 = opts.compare_b64 || null;
    if (!compareB64) {
      var fileUrl = (State && State.outputImages && State.outputImages[idx]) || null;
      if (fileUrl) {
        try { compareB64 = await _fetchAsDataUrl(fileUrl); }
        catch (e) { /* compare just won't be present */ }
      }
    }

    var apiBase = (window.API && window.API.base) || "";
    var resp = await fetch(apiBase + "/studio/api/debug/sample_save_path", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_b64: source,
        format: format,
        quality: (opts.quality != null) ? opts.quality : 95,
        x: (x != null) ? (x | 0) : null,
        y: (y != null) ? (y | 0) : null,
        compare_b64: compareB64,
      }),
    });
    var result = await resp.json();
    if (result.error) throw new Error("[StudioDebug] " + result.error);

    var rows = _stagesFromResponse(result);
    try { console.table(rows); } catch (e) { console.log(rows); }
    var markdown = _savePathMarkdown(result, rows);
    console.log(markdown);
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(markdown).catch(function () { /* clipboard denied */ });
    }
    return { result: result, rows: rows, markdown: markdown };
  }

  window.StudioDebug = window.StudioDebug || {};
  window.StudioDebug.sampleColorPipeline = sampleColorPipeline;
  window.StudioDebug.sampleColorPipelineSet = sampleColorPipelineSet;
  window.StudioDebug.sampleSavePath = sampleSavePath;
})();
