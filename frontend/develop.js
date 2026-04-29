/**
 * Forge Studio — Develop Module
 * by ToxicHost & Moritz
 *
 * Lightroom-style global non-destructive post-processing pass.
 *
 * Architecture:
 *   - All state lives on S.developParams (per-document, saved by studio-docs.js).
 *   - The compositor (canvas-core.js#_applyDevelop) calls
 *     window.StudioDevelop.applyToContext(ctx, w, h, params) at the end of
 *     every composite, after all layers, before UI overlays.
 *   - Develop is NOT a layer, NOT maskable, ALWAYS runs last.
 *
 * Pipeline stages (see _applyDevelopFull below):
 *   A. Per-channel Float32 LUT: linearize → WB scale → exposure
 *   B. Highlights/shadows: luminance blur + smoothstep masks
 *   C. Whites/blacks → contrast → re-encode to sRGB Uint8
 *   D. Vibrance (cross-channel) → saturation (HSL)
 *   E. Spatial: texture USM, clarity USM (mid-tone weighted), sharpening
 *   F. Vignette + grain
 *
 * Process versioning (params._version):
 *   V1 = initial release. If algorithms ever change, bump to V2 and keep
 *   V1 path. Documents always render with the version they were saved at.
 *
 * Loaded as an optional script after canvas-core, canvas-ui, app, module-system,
 * studio-docs.
 */
(function () {
"use strict";

var TAG = "[Develop]";
var VERSION = "1.0.0";

// ========================================================================
// CSS injection (matches lexicon.js#1228 pattern)
// ========================================================================
if (!document.querySelector('link[href*="develop.css"]')) {
    var _link = document.createElement("link");
    _link.rel = "stylesheet";
    _link.href = "/studio/static/develop.css?v=" + VERSION;
    document.head.appendChild(_link);
}

// ========================================================================
// DEFAULT PARAMS — matches the spec's S.developParams shape exactly
// ========================================================================
function defaultParams() {
    return {
        _version: 1,
        enabled: false,

        // White Balance
        temperature: 0,
        tint: 0,

        // Tone
        exposure: 0,
        contrast: 0,
        highlights: 0,
        shadows: 0,
        whites: 0,
        blacks: 0,

        // Presence
        texture: 0,
        clarity: 0,
        vibrance: 0,
        saturation: 0,

        // Detail
        sharpenAmount: 0,
        sharpenRadius: 1.0,

        // Effects
        vignetteAmount: 0,
        grainAmount: 0,
        grainSize: 25,
    };
}

// ========================================================================
// SLIDER DEFINITIONS — drives the UI section layout
// Each row: { key, label, min, max, step, def }
// ========================================================================
var SECTIONS = [
    {
        id: "basic", label: "Basic", open: true,
        rows: [
            { key: "temperature", label: "Temperature", min: -100, max: 100, step: 1,   def: 0 },
            { key: "tint",        label: "Tint",        min: -100, max: 100, step: 1,   def: 0 },
            { divider: true },
            { key: "exposure",    label: "Exposure",    min: -100, max: 100, step: 1,   def: 0 },
            { key: "contrast",    label: "Contrast",    min: -100, max: 100, step: 1,   def: 0 },
            { key: "highlights",  label: "Highlights",  min: -100, max: 100, step: 1,   def: 0 },
            { key: "shadows",     label: "Shadows",     min: -100, max: 100, step: 1,   def: 0 },
            { key: "whites",      label: "Whites",      min: -100, max: 100, step: 1,   def: 0 },
            { key: "blacks",      label: "Blacks",      min: -100, max: 100, step: 1,   def: 0 },
        ]
    },
    {
        id: "presence", label: "Presence", open: true,
        rows: [
            { key: "texture",    label: "Texture",    min: -100, max: 100, step: 1, def: 0 },
            { key: "clarity",    label: "Clarity",    min: -100, max: 100, step: 1, def: 0 },
            { key: "vibrance",   label: "Vibrance",   min: -100, max: 100, step: 1, def: 0 },
            { key: "saturation", label: "Saturation", min: -100, max: 100, step: 1, def: 0 },
        ]
    },
    {
        id: "detail", label: "Detail", open: false,
        rows: [
            { key: "sharpenAmount", label: "Sharpen Amt", min: 0,   max: 150, step: 1,   def: 0   },
            { key: "sharpenRadius", label: "Sharpen Rad", min: 0.5, max: 3.0, step: 0.1, def: 1.0 },
        ]
    },
    {
        id: "effects", label: "Effects", open: false,
        rows: [
            { key: "vignetteAmount", label: "Vignette",    min: -100, max: 100, step: 1, def: 0  },
            { key: "grainAmount",    label: "Grain Amount", min: 0,    max: 100, step: 1, def: 0  },
            { key: "grainSize",      label: "Grain Size",   min: 10,   max: 100, step: 1, def: 25 },
        ]
    },
];

// ========================================================================
// IDENTITY CHECK — early-out before any getImageData
// All sliders that contribute when their amount is non-zero are listed.
// sharpenRadius / grainSize have non-zero defaults but contribute nothing
// when sharpenAmount / grainAmount are zero, so they're not checked.
// ========================================================================
function _isIdentity(p) {
    if (!p) return true;
    if (!p.enabled) return true;
    return ((p.temperature | 0) === 0)
        && ((p.tint | 0) === 0)
        && ((p.exposure | 0) === 0)
        && ((p.contrast | 0) === 0)
        && ((p.highlights | 0) === 0)
        && ((p.shadows | 0) === 0)
        && ((p.whites | 0) === 0)
        && ((p.blacks | 0) === 0)
        && ((p.texture | 0) === 0)
        && ((p.clarity | 0) === 0)
        && ((p.vibrance | 0) === 0)
        && ((p.saturation | 0) === 0)
        && ((p.sharpenAmount | 0) === 0)
        && ((p.vignetteAmount | 0) === 0)
        && ((p.grainAmount | 0) === 0);
}

// ========================================================================
// MATH HELPERS
// ========================================================================
function _clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function _clampU8(v) { v = (v + 0.5) | 0; return v < 0 ? 0 : (v > 255 ? 255 : v); }
function _smoothstep(edge0, edge1, x) {
    var t = (x - edge0) / (edge1 - edge0);
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return t * t * (3 - 2 * t);
}

// sRGB ↔ linear (Rec.709 piecewise gamma)
var _SRGB_TO_LIN = (function () {
    var lut = new Float32Array(256);
    for (var i = 0; i < 256; i++) {
        var v = i / 255;
        lut[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
    return lut;
})();

function _linearToSrgb01(v) {
    if (v <= 0) return 0;
    if (v >= 1) return 1;
    return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

// Linear-Float → sRGB-U8 LUT. Spans input range 0..2 in 4096 steps so
// exposure-boosted floats above 1.0 map through a soft filmic shoulder
// instead of hard-clipping to 255. Without this, an exposure boost that
// pushes any pixel past linear 1.0 immediately blows it to pure white;
// the shoulder lets HDR-ish values asymptote toward sRGB 1.0 smoothly.
//
// Curve: identity below 0.85 linear, then a Reinhard-style asymptote
// shoulder + (1 - shoulder) * t / (t + tightness)  with t = (v - shoulder).
// At v=2 the output sits at ~0.99 in linear, encoded to ~253 sRGB.
//
// Collapses ~6 Math.pow calls per pixel in Phase C into 6 array lookups.
var _LIN_TO_SRGB_U8 = (function () {
    var lut = new Uint8Array(4097);
    var shoulder = 0.85;
    var tightness = 0.6;
    for (var i = 0; i <= 4096; i++) {
        var v = i / 2048; // 0..2
        if (v < 0) v = 0;
        var lin;
        if (v <= shoulder) {
            lin = v;
        } else {
            var t = v - shoulder;
            lin = shoulder + (1 - shoulder) * t / (t + tightness);
        }
        lut[i] = (_linearToSrgb01(lin) * 255 + 0.5) | 0;
    }
    return lut;
})();
function _lin2u8(v) {
    if (v <= 0) return 0;
    if (v >= 2) return 255;
    return _LIN_TO_SRGB_U8[(v * 2048) | 0];
}

// xorshift32 — deterministic per-document grain seed
function _xs32(state) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; }

// ========================================================================
// STATE access — lazily resolved (StudioCore boots before us)
// ========================================================================
function _S() { return window.StudioCore && window.StudioCore.state; }

// ========================================================================
// PIPELINE — see ANCHOR_PIPELINE below
// ========================================================================

function applyToContext(ctx, w, h, params) {
    if (_isIdentity(params)) return;
    if (typeof _applyDevelopFull !== "function") return; // skeleton-only mode
    if (params._dragging) {
        _applyDevelopProxy(ctx, w, h, params);
    } else {
        _applyDevelopFull(ctx, w, h, params);
    }
}

// ANCHOR_PIPELINE — chunk 2 inserts pipeline functions here
// ========================================================================
// PHASE A — per-channel Float32 LUT
//
// Chains: linearize (sRGB→linear) → WB scale → exposure scale.
// Output is Float32 in linear space (may exceed 1.0 due to exposure gain).
// Cached on S._developLutCache keyed by the params that contribute.
//
// WB math (matches spec):
//   R *= 1 + temp/200       (warm = +R)
//   B *= 1 - temp/200       (warm = -B)
//   G *= 1 + tint/200       (green-magenta axis)
// Exposure: v *= 2^(exposure * 3/100)   ⇒ ±3 stops at the slider extremes.
// (Was ±5 stops — too easy to crush highlights at moderate slider values.)
// ========================================================================
function _buildLutA(p) {
    var temp = p.temperature || 0;
    var tint = p.tint || 0;
    var rGain = 1 + temp / 200;
    var bGain = 1 - temp / 200;
    var gGain = 1 + tint / 200;
    var expGain = Math.pow(2, (p.exposure || 0) * 3 / 100);
    var rScale = rGain * expGain;
    var gScale = gGain * expGain;
    var bScale = bGain * expGain;
    var lutR = new Float32Array(256);
    var lutG = new Float32Array(256);
    var lutB = new Float32Array(256);
    for (var i = 0; i < 256; i++) {
        var lin = _SRGB_TO_LIN[i];
        lutR[i] = lin * rScale;
        lutG[i] = lin * gScale;
        lutB[i] = lin * bScale;
    }
    return { lutR: lutR, lutG: lutG, lutB: lutB };
}

function _getLutA(p) {
    var S = _S();
    var sig = (p.temperature | 0) + "|" + (p.tint | 0) + "|" + (p.exposure | 0);
    if (S && S._developLutCache && S._developLutCache.sig === sig) return S._developLutCache;
    var lut = _buildLutA(p);
    lut.sig = sig;
    if (S) S._developLutCache = lut;
    return lut;
}

// ========================================================================
// PHASE B — highlights/shadows lift/pull
//
// Computes a luminance buffer from the post-LUT-A pixels, blurs it heavily
// (sigma scales with the smaller canvas dimension), then builds soft masks:
//   shadowMask    = 1 - smoothstep(0.0, 0.5, lumBlur)
//   highlightMask =     smoothstep(0.5, 1.0, lumBlur)
// Targets: shadows lift toward 0.6, highlights pull toward 0.4. Strength
// from the slider (-100..100) acts as a signed multiplier.
//
// Cache: S._developBlurCache.lumBlur is reused while Phase A inputs (and
// canvas dims) don't change. The masks themselves recompute cheaply.
// ========================================================================
function _getLumBlur(rLin, gLin, bLin, w, h, sig) {
    var S = _S();
    // Quarter-resolution blur. The HL/shadow mask is intentionally low-frequency
    // (large kernel, smooth gradients), so blurring at 1/4 res and indexing back
    // via (y>>2)*lw + (x>>2) is mathematically near-identical and ~16× cheaper.
    var lw = Math.max(1, w >> 2);
    var lh = Math.max(1, h >> 2);
    if (S && S._developBlurCache && S._developBlurCache.sig === sig
        && S._developBlurCache.w === w && S._developBlurCache.h === h) {
        return S._developBlurCache;
    }
    var lum = new Float32Array(lw * lh);
    var counts = new Uint16Array(lw * lh);
    for (var y = 0; y < h; y++) {
        var dy = y >> 2;
        var rowL = dy * lw;
        var rowF = y * w;
        for (var x = 0; x < w; x++) {
            var dx = x >> 2;
            var v = 0.2126 * rLin[rowF + x] + 0.7152 * gLin[rowF + x] + 0.0722 * bLin[rowF + x];
            if (v < 0) v = 0; else if (v > 2) v = 2;
            lum[rowL + dx] += v;
            counts[rowL + dx]++;
        }
    }
    for (var i = 0; i < lum.length; i++) if (counts[i] > 0) lum[i] /= counts[i];
    // sigma scales with the downsampled buffer: ~12 on a 1/4-res 1024² doc.
    var sigma = Math.max(2, Math.min(lw, lh) * 0.05);
    _separableGaussian(lum, lw, lh, sigma);
    var cache = { sig: sig, w: w, h: h, lumBlur: lum, lw: lw, lh: lh };
    if (S) S._developBlurCache = cache;
    return cache;
}

function _applyHighlightsShadows(rLin, gLin, bLin, blurCache, w, h, hlAmt, shAmt) {
    var lumBlur = blurCache.lumBlur;
    var lw = blurCache.lw;
    var hl = hlAmt / 100;
    var sh = shAmt / 100;
    var hlTarget = 0.4;
    var shTarget = 0.6;
    for (var y = 0; y < h; y++) {
        var ly = (y >> 2) * lw;
        var rowF = y * w;
        for (var x = 0; x < w; x++) {
            var i = rowF + x;
            var Yl = lumBlur[ly + (x >> 2)];
            // Build masks against perceptual (sRGB-encoded) luminance, NOT
            // linear. A pixel at sRGB 0.7 sits at linear ~0.45, so a linear
            // smoothstep(0.5, 1.0, Y) returns ~0 for almost everything and
            // the highlights slider feels dead. Gamma-encode the blurred
            // luminance for the threshold only — the lift/pull math below
            // still runs in linear for HDR correctness.
            var Yp = _lin2u8(Yl) / 255;
            if (sh !== 0) {
                var sm = 1 - _smoothstep(0, 0.5, Yp);
                var sd = sh * sm;
                rLin[i] += (shTarget - rLin[i]) * sd;
                gLin[i] += (shTarget - gLin[i]) * sd;
                bLin[i] += (shTarget - bLin[i]) * sd;
            }
            if (hl !== 0) {
                var hm = _smoothstep(0.5, 1.0, Yp);
                // Direct lerp toward target (no negation):
                //   positive Highlights → recovery (darken brights toward 0.4)
                //   negative Highlights → boost (push brights away from target)
                // Matches the "positive = recovery, positive shadows = open"
                // convention used elsewhere in this pipeline.
                var hd = hl * hm;
                rLin[i] += (hlTarget - rLin[i]) * hd;
                gLin[i] += (hlTarget - gLin[i]) * hd;
                bLin[i] += (hlTarget - bLin[i]) * hd;
            }
        }
    }
}

// ========================================================================
// FULL-RESOLUTION PIPELINE
// ========================================================================
function _applyDevelopFull(ctx, w, h, p) {
    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data;
    var n = w * h;

    // ---- Phase A: per-channel LUT, sRGB U8 → linear Float32 ----
    var lut = _getLutA(p);
    var lutR = lut.lutR, lutG = lut.lutG, lutB = lut.lutB;
    var rLin = new Float32Array(n);
    var gLin = new Float32Array(n);
    var bLin = new Float32Array(n);
    for (var i = 0, j = 0; i < n; i++, j += 4) {
        rLin[i] = lutR[d[j]];
        gLin[i] = lutG[d[j + 1]];
        bLin[i] = lutB[d[j + 2]];
    }

    // ---- Phase B: highlights/shadows ----
    var hlAmt = p.highlights | 0;
    var shAmt = p.shadows | 0;
    if (hlAmt !== 0 || shAmt !== 0) {
        var blurCache = _getLumBlur(rLin, gLin, bLin, w, h, lut.sig);
        _applyHighlightsShadows(rLin, gLin, bLin, blurCache, w, h, hlAmt, shAmt);
    }

    // ---- Phase C: whites/blacks (linear) → re-encode → contrast (perceptual) ----
    // Whites/blacks are endpoint remaps that are mathematically natural in
    // linear space. Contrast is moved to a post-encode pass in sRGB U8 space
    // pivoting at U8 128 (= sRGB 0.5 = perceptual middle gray) — pivoting at
    // linear 0.5 (which is sRGB ~0.74) was crushing midtone-shadows because
    // most pixels in a typical photo sit *below* linear 0.5 and got pushed
    // toward 0 by the sigmoid.
    //   Krita-style sigmoid: slope = tan((c+1)*π/4), c ∈ [-1, 1].
    //   Gentle near 0 (slope 1.5 at +25), ramps sharply near ±1.
    var blackPoint = (p.blacks  || 0) / 200;
    var whitePoint = 1 + (p.whites || 0) / 200;
    var range = whitePoint - blackPoint;
    if (Math.abs(range) < 1e-4) range = 1e-4;
    var invRange = 1 / range;
    var cNorm = (p.contrast || 0) / 100;
    if (cNorm < -1) cNorm = -1; else if (cNorm > 1) cNorm = 1;
    var contrastSlope = Math.tan((cNorm + 1) * Math.PI / 4);
    var doRemap = blackPoint !== 0 || whitePoint !== 1;
    var doContrast = (p.contrast | 0) !== 0;

    for (var k = 0, m = 0; k < n; k++, m += 4) {
        var r = rLin[k], g = gLin[k], b = bLin[k];
        if (doRemap) {
            r = (r - blackPoint) * invRange;
            g = (g - blackPoint) * invRange;
            b = (b - blackPoint) * invRange;
        }
        // clamp + re-encode via 4096-entry LUT (no Math.pow in the hot loop)
        d[m]     = _lin2u8(r);
        d[m + 1] = _lin2u8(g);
        d[m + 2] = _lin2u8(b);
    }

    // Contrast in sRGB U8, via a 256-entry LUT built once per call.
    if (doContrast) {
        var cLut = new Uint8Array(256);
        for (var v = 0; v < 256; v++) {
            var t = (v - 128) * contrastSlope + 128;
            cLut[v] = t < 0 ? 0 : (t > 255 ? 255 : (t + 0.5) | 0);
        }
        for (var pq = 0, end = n * 4; pq < end; pq += 4) {
            d[pq]     = cLut[d[pq]];
            d[pq + 1] = cLut[d[pq + 1]];
            d[pq + 2] = cLut[d[pq + 2]];
        }
    }

    // ---- Phase D: vibrance, then saturation ----
    var vibAmt = (p.vibrance || 0) / 100;
    if (vibAmt !== 0) _applyVibrance(d, n, vibAmt);
    var satAmt = (p.saturation || 0) / 100;
    if (satAmt !== 0) _applySaturation(d, n, satAmt);

    // ---- Phase E: spatial USM (texture / clarity / sharpening) ----
    if ((p.texture | 0) !== 0)        _unsharpMaskLuma(d, w, h, 8,  (p.texture || 0) / 100, false);
    if ((p.clarity | 0) !== 0)        _unsharpMaskLuma(d, w, h, 40, (p.clarity || 0) / 200, true);
    if ((p.sharpenAmount | 0) !== 0)  _unsharpMaskLuma(d, w, h, p.sharpenRadius || 1.0, (p.sharpenAmount || 0) / 100, false);

    // ---- Phase F: vignette + grain ----
    if ((p.vignetteAmount | 0) !== 0) _applyVignette(d, w, h, (p.vignetteAmount || 0) / 100);
    if ((p.grainAmount | 0) !== 0)    _applyGrain(d, w, h, (p.grainAmount || 0) / 100, p.grainSize || 25);

    ctx.putImageData(img, 0, 0);
}

// ========================================================================
// PROXY-RESOLUTION PIPELINE
//
// During slider drag we render at reduced resolution to keep the UI
// responsive on big canvases. The downsampled buffer is processed by the
// full pipeline, then upscaled back into the original ctx with smoothing.
// ========================================================================
function _proxyScale(w, h) {
    // Drag-time only — full-resolution path runs on slider release.
    // Empirically the LUT-based pipeline tops out around 0.5 MP at 60fps,
    // so half-res starts kicking in at ~0.5 MP.
    var mp = (w * h) / 1e6;
    if (mp <= 0.5) return 1;
    if (mp <= 2) return 0.5;
    return 0.25;
}

function _applyDevelopProxy(ctx, w, h, p) {
    var scale = _proxyScale(w, h);
    if (scale >= 1) { _applyDevelopFull(ctx, w, h, p); return; }
    var pw = Math.max(1, Math.round(w * scale));
    var ph = Math.max(1, Math.round(h * scale));
    var tmp = document.createElement("canvas");
    tmp.width = pw; tmp.height = ph;
    var tx = tmp.getContext("2d");
    tx.imageSmoothingEnabled = true;
    tx.drawImage(ctx.canvas, 0, 0, pw, ph);
    _applyDevelopFull(tx, pw, ph, p);
    // Replace the original ctx contents with the upscaled proxy result.
    var prevSmoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(tmp, 0, 0, pw, ph, 0, 0, w, h);
    ctx.imageSmoothingEnabled = prevSmoothing;
}

// ========================================================================
// PHASE D HELPERS — vibrance + saturation
//
// Vibrance: protects already-saturated pixels by weighting the boost by
// (1 - currentSat). Cross-channel — can't go in the LUT.
// Saturation: HSL conversion path matching canvas-core.js#_applyHSLToCtx so
// behavior is consistent with the per-layer Hue/Sat adjustment.
// ========================================================================
function _applyVibrance(d, n, amount) {
    for (var p = 0, end = n * 4; p < end; p += 4) {
        var R = d[p], G = d[p + 1], B = d[p + 2];
        var max = R > G ? (R > B ? R : B) : (G > B ? G : B);
        if (max === 0) continue;
        var avg = (R + G + B) / 3;
        var sat = (max - avg) / max;       // 0..1 perceived saturation
        var weight = 1 - sat;              // protect saturated pixels
        var dR = (max - R) * weight * amount;
        var dG = (max - G) * weight * amount;
        var dB = (max - B) * weight * amount;
        d[p]     = _clampU8(R + dR);
        d[p + 1] = _clampU8(G + dG);
        d[p + 2] = _clampU8(B + dB);
    }
}

function _applySaturation(d, n, amount) {
    var scale = 1 + amount;
    if (scale < 0) scale = 0;
    for (var p = 0, end = n * 4; p < end; p += 4) {
        var r = d[p] / 255, g = d[p + 1] / 255, b = d[p + 2] / 255;
        var max = r > g ? (r > b ? r : b) : (g > b ? g : b);
        var min = r < g ? (r < b ? r : b) : (g < b ? g : b);
        var L = (max + min) * 0.5;
        var delta = max - min;
        if (delta === 0) continue; // gray pixel — saturation has no effect
        var H, S;
        var denom = 1 - Math.abs(2 * L - 1);
        S = denom <= 0 ? 0 : delta / denom;
        if (max === r)      H = ((g - b) / delta) % 6;
        else if (max === g) H = (b - r) / delta + 2;
        else                H = (r - g) / delta + 4;
        H *= 60; if (H < 0) H += 360;
        S *= scale;
        if (S > 1) S = 1; else if (S < 0) S = 0;
        var C = (1 - Math.abs(2 * L - 1)) * S;
        var X = C * (1 - Math.abs((H / 60) % 2 - 1));
        var off = L - C * 0.5;
        var rr, gg, bb;
        var seg = (H / 60) | 0;
        if      (seg === 0) { rr = C; gg = X; bb = 0; }
        else if (seg === 1) { rr = X; gg = C; bb = 0; }
        else if (seg === 2) { rr = 0; gg = C; bb = X; }
        else if (seg === 3) { rr = 0; gg = X; bb = C; }
        else if (seg === 4) { rr = X; gg = 0; bb = C; }
        else                { rr = C; gg = 0; bb = X; }
        d[p]     = _clampU8((rr + off) * 255);
        d[p + 1] = _clampU8((gg + off) * 255);
        d[p + 2] = _clampU8((bb + off) * 255);
    }
}

// ANCHOR_SPATIAL — chunk 3 inserts spatial ops here
// ========================================================================
// SEPARABLE GAUSSIAN — in-place blur of a Float32 single-channel buffer.
//
// Builds a 1D kernel of radius ~3*sigma, then runs an H-pass + V-pass.
// O(n * radius) total per pass instead of O(n * radius²) for 2D.
// ========================================================================
function _gaussianKernel(sigma) {
    var r = Math.max(1, Math.ceil(sigma * 3));
    var size = r * 2 + 1;
    var k = new Float32Array(size);
    var s2 = 2 * sigma * sigma;
    var sum = 0;
    for (var i = -r; i <= r; i++) {
        var v = Math.exp(-(i * i) / s2);
        k[i + r] = v;
        sum += v;
    }
    for (var j = 0; j < size; j++) k[j] /= sum;
    return { kernel: k, radius: r };
}

function _separableGaussian(buf, w, h, sigma) {
    var kk = _gaussianKernel(sigma);
    var k = kk.kernel;
    var r = kk.radius;
    var tmp = new Float32Array(buf.length);
    var x, y, i, idx, sum;

    // Horizontal pass
    for (y = 0; y < h; y++) {
        var row = y * w;
        for (x = 0; x < w; x++) {
            sum = 0;
            for (i = -r; i <= r; i++) {
                var sx = x + i;
                if (sx < 0) sx = 0; else if (sx >= w) sx = w - 1;
                sum += buf[row + sx] * k[i + r];
            }
            tmp[row + x] = sum;
        }
    }
    // Vertical pass
    for (x = 0; x < w; x++) {
        for (y = 0; y < h; y++) {
            sum = 0;
            for (i = -r; i <= r; i++) {
                var sy = y + i;
                if (sy < 0) sy = 0; else if (sy >= h) sy = h - 1;
                sum += tmp[sy * w + x] * k[i + r];
            }
            buf[y * w + x] = sum;
        }
    }
}

// ========================================================================
// UNSHARP MASK on luminance only.
//
// Avoids color fringing by extracting Y, blurring, computing Y - Yblur,
// and adding (amount * detail) back to all three channels equally.
// `midToneWeighted` clamps the boost near pure black/white using
// 4 * v * (1 - v) — used by Clarity to preserve highlights/shadows.
// ========================================================================
function _unsharpMaskLuma(d, w, h, radius, amount, midToneWeighted) {
    if (amount === 0 || radius <= 0) return;
    var n = w * h;
    var Y = new Float32Array(n);
    for (var i = 0, j = 0; i < n; i++, j += 4) {
        Y[i] = (0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2]) / 255;
    }

    // For large-radius blurs (clarity at r=40), processing at full resolution
    // is wildly expensive. Since the blur is already low-frequency, we can
    // compute it on a 1/4-res buffer and sample back via index math without
    // visible artifacts. Sharpening (small radius) stays at full res because
    // it relies on high-frequency precision.
    var detailLookup;
    if (radius >= 8) {
        var sw = Math.max(1, w >> 2);
        var sh = Math.max(1, h >> 2);
        var Ys = new Float32Array(sw * sh);
        var counts = new Uint16Array(sw * sh);
        for (var yy = 0; yy < h; yy++) {
            var sy = yy >> 2;
            var rowS = sy * sw;
            var rowF = yy * w;
            for (var xx = 0; xx < w; xx++) {
                Ys[rowS + (xx >> 2)] += Y[rowF + xx];
                counts[rowS + (xx >> 2)]++;
            }
        }
        for (var c = 0; c < Ys.length; c++) if (counts[c] > 0) Ys[c] /= counts[c];
        _separableGaussian(Ys, sw, sh, radius * 0.25);
        detailLookup = function (x, y, fullY) {
            return fullY - Ys[(y >> 2) * sw + (x >> 2)];
        };
    } else {
        var Yb = new Float32Array(Y);
        _separableGaussian(Yb, w, h, radius);
        detailLookup = function (x, y, fullY) {
            return fullY - Yb[y * w + x];
        };
    }

    for (var yyy = 0; yyy < h; yyy++) {
        var rowI = yyy * w;
        var rowP = yyy * w * 4;
        for (var xxx = 0; xxx < w; xxx++) {
            var fullY = Y[rowI + xxx];
            var detail = detailLookup(xxx, yyy, fullY);
            var boost = amount * detail;
            if (midToneWeighted) {
                var v = fullY;
                if (v < 0) v = 0; else if (v > 1) v = 1;
                boost *= 4 * v * (1 - v);
            }
            var add = boost * 255;
            var p = rowP + xxx * 4;
            d[p]     = _clampU8(d[p]     + add);
            d[p + 1] = _clampU8(d[p + 1] + add);
            d[p + 2] = _clampU8(d[p + 2] + add);
        }
    }
}

// ========================================================================
// VIGNETTE — radial multiplicative falloff.
//
// factor = 1 + (amount/1) * r²,  r = normalized distance from center.
// amount < 0 darkens edges, amount > 0 lightens.
// ========================================================================
function _applyVignette(d, w, h, amount) {
    var cx = w / 2, cy = h / 2;
    var invCx = 1 / cx, invCy = 1 / cy;
    for (var y = 0; y < h; y++) {
        var dy = (y - cy) * invCy;
        var dy2 = dy * dy;
        var row = y * w * 4;
        for (var x = 0; x < w; x++) {
            var dx = (x - cx) * invCx;
            var r2 = dx * dx + dy2;
            var factor = 1 + amount * r2;
            if (factor < 0) factor = 0;
            var p = row + x * 4;
            d[p]     = _clampU8(d[p]     * factor);
            d[p + 1] = _clampU8(d[p + 1] * factor);
            d[p + 2] = _clampU8(d[p + 2] * factor);
        }
    }
}

// ========================================================================
// FILM GRAIN — deterministic per-document noise tile, scaled per pixel.
//
// Uses a tile sized 4x the grainSize so the pattern doesn't visibly repeat.
// The tile is generated with xorshift32 seeded from a fixed constant so
// the same params produce the same grain pattern (matches spec).
//
// grainSize controls the apparent grain frequency: smaller = finer.
// Cache keyed on (size|w|h) — invalidated on canvas resize.
// ========================================================================
function _getGrainTile(size, w, h) {
    var S = _S();
    var sig = (size | 0) + "|" + w + "|" + h;
    if (S && S._developGrainCache && S._developGrainCache.sig === sig) {
        return S._developGrainCache;
    }
    // Tile dimensions: roughly canvas-sized at the chosen frequency.
    var tw = Math.max(64, Math.min(w, 1024));
    var th = Math.max(64, Math.min(h, 1024));
    // The "size" controls grain coarseness — we step through the noise
    // table at intervals of `size/25` so larger size = blockier grain.
    var noise = new Int8Array(tw * th);
    var seed = 0x9E3779B9 ^ (size & 0xFF);
    var state = seed | 1;
    for (var i = 0; i < noise.length; i++) {
        state = _xs32(state);
        // Symmetric -128..+127 (was -64..+63 — biased and wasted half the
        // Int8 range). amp scaling below is divided by 128 to compensate so
        // peak grain amplitude stays visually equivalent.
        noise[i] = ((state & 0xFF) - 128);
    }
    var cache = { sig: sig, w: tw, h: th, noise: noise };
    if (S) S._developGrainCache = cache;
    return cache;
}

function _applyGrain(d, w, h, amount, size) {
    var tile = _getGrainTile(size, w, h);
    var noise = tile.noise;
    var tw = tile.w, th = tile.h;
    // step >= 1 — larger size produces blockier grain by repeating samples.
    var step = Math.max(1, Math.round(size / 12));
    var amp = amount * 0.6 * 255 / 128;  // peak amplitude in U8 units (noise range now ±128)
    for (var y = 0; y < h; y++) {
        var ty = ((y / step) | 0) % th;
        if (ty < 0) ty += th;
        var rowSrc = ty * tw;
        var rowDst = y * w * 4;
        for (var x = 0; x < w; x++) {
            var tx = ((x / step) | 0) % tw;
            if (tx < 0) tx += tw;
            var nv = noise[rowSrc + tx] * amp;
            var p = rowDst + x * 4;
            d[p]     = _clampU8(d[p]     + nv);
            d[p + 1] = _clampU8(d[p + 1] + nv);
            d[p + 2] = _clampU8(d[p + 2] + nv);
        }
    }
}

// ========================================================================
// UI — see ANCHOR_UI below
// ========================================================================

var _panel = null;
var _splitLine = null;
var _splitLabelL = null;
var _splitLabelR = null;
var _proxyRafId = 0;
var _fullRafId = 0;

function _showPanel() { if (_panel) _panel.classList.add("visible"); }
function _hidePanel() { if (_panel) _panel.classList.remove("visible"); }

// Element registry — populated during _buildPanel, used by syncPanel
var _rowEls = {};            // key → { row, range, num, def, step }
var _histCanvas = null;
var _histChannelMode = "lum"; // lum | rgb
var _histScale = "log";       // log | linear
var _enableToggleEl = null;
var _beforeAfterBtn = null;
var _splitActive = false;
var _splitPos = 0.5;          // 0..1 fraction of viewport width

// ========================================================================
// REDRAW SCHEDULING — RAF-coalesced
//
// During slider drag we set _developParams._dragging so applyToContext
// picks the proxy path. On the change event (commit) we clear the flag and
// schedule a full-resolution redraw on the next frame.
// ========================================================================
function _redrawNow(withHistogram) {
    var UI = window.StudioUI;
    if (UI && UI.redraw) UI.redraw();
    // Histogram triggers a full getImageData GPU readback — too expensive
    // to run every drag frame. Only update on the committed (full-res) path.
    if (withHistogram) _renderHistogram();
    if (_splitActive) _renderSplitOverlay();
}

function _bumpCompositeCache() {
    var C = window.StudioCore;
    if (C && C.markCompositeDirty) C.markCompositeDirty();
}

function _scheduleProxyRedraw() {
    if (_proxyRafId) return;
    _proxyRafId = requestAnimationFrame(function () {
        _proxyRafId = 0;
        var S = _S();
        if (S && S.developParams) S.developParams._dragging = true;
        _bumpCompositeCache();
        _redrawNow(false);
    });
}

function _scheduleFullRedraw() {
    if (_fullRafId) cancelAnimationFrame(_fullRafId);
    _fullRafId = requestAnimationFrame(function () {
        _fullRafId = 0;
        var S = _S();
        if (S && S.developParams) S.developParams._dragging = false;
        _bumpCompositeCache();
        _redrawNow(true);
    });
}

// ========================================================================
// PANEL CONSTRUCTION
// ========================================================================
function _buildPanel() {
    if (_panel) return;
    _panel = document.createElement("div");
    _panel.className = "develop-panel";

    // ---- Header ----
    var header = document.createElement("div");
    header.className = "develop-panel-header";

    var title = document.createElement("div");
    title.className = "develop-panel-title";
    title.textContent = "Develop";
    header.appendChild(title);

    _enableToggleEl = document.createElement("button");
    _enableToggleEl.className = "develop-toggle";
    _enableToggleEl.title = "Enable Develop";
    _enableToggleEl.addEventListener("click", function () {
        var S = _S(); if (!S || !S.developParams) return;
        S.developParams.enabled = !S.developParams.enabled;
        _enableToggleEl.classList.toggle("on", !!S.developParams.enabled);
        _scheduleFullRedraw();
    });
    header.appendChild(_enableToggleEl);

    _beforeAfterBtn = document.createElement("button");
    _beforeAfterBtn.className = "develop-header-btn";
    _beforeAfterBtn.textContent = "B/A";
    _beforeAfterBtn.title = "Before / After split";
    _beforeAfterBtn.addEventListener("click", _toggleBeforeAfter);
    header.appendChild(_beforeAfterBtn);

    var resetBtn = document.createElement("button");
    resetBtn.className = "develop-header-btn";
    resetBtn.textContent = "Reset";
    resetBtn.title = "Reset all sliders";
    resetBtn.addEventListener("click", _resetAll);
    header.appendChild(resetBtn);

    _panel.appendChild(header);

    // ---- Body (scrollable) ----
    var body = document.createElement("div");
    body.className = "develop-panel-body";

    // Histogram
    var histWrap = document.createElement("div");
    histWrap.className = "develop-histogram-wrap";
    _histCanvas = document.createElement("canvas");
    _histCanvas.className = "develop-histogram-canvas";
    _histCanvas.width = 296; _histCanvas.height = 60;
    histWrap.appendChild(_histCanvas);

    var histCtrl = document.createElement("div");
    histCtrl.className = "develop-histogram-controls";
    function makeHistBtn(mode, label, group) {
        var b = document.createElement("button");
        b.textContent = label;
        if ((group === "ch" && mode === _histChannelMode) ||
            (group === "sc" && mode === _histScale)) b.classList.add("active");
        b.addEventListener("click", function () {
            if (group === "ch") _histChannelMode = mode;
            else _histScale = mode;
            histCtrl.querySelectorAll("button[data-grp='" + group + "']").forEach(function (x) { x.classList.remove("active"); });
            b.classList.add("active");
            _renderHistogram();
        });
        b.dataset.grp = group;
        return b;
    }
    histCtrl.appendChild(makeHistBtn("lum", "L", "ch"));
    histCtrl.appendChild(makeHistBtn("rgb", "RGB", "ch"));
    var spacer = document.createElement("span"); spacer.style.flex = "1"; histCtrl.appendChild(spacer);
    histCtrl.appendChild(makeHistBtn("log", "log", "sc"));
    histCtrl.appendChild(makeHistBtn("linear", "lin", "sc"));
    histWrap.appendChild(histCtrl);
    body.appendChild(histWrap);

    // Sections
    SECTIONS.forEach(function (sec) { body.appendChild(_buildSection(sec)); });

    // Presets section (chunk 5 fills _buildPresetSection)
    if (typeof _buildPresetSection === "function") {
        body.appendChild(_buildPresetSection());
    }

    _panel.appendChild(body);
    document.body.appendChild(_panel);
}

function _buildSection(sec) {
    var s = document.createElement("div");
    s.className = "develop-section" + (sec.open ? "" : " collapsed");
    var head = document.createElement("div");
    head.className = "develop-section-header";
    var arrow = document.createElement("span");
    arrow.className = "develop-section-arrow"; arrow.textContent = "▾";
    head.appendChild(arrow);
    var name = document.createElement("span"); name.textContent = sec.label; head.appendChild(name);
    head.addEventListener("click", function () { s.classList.toggle("collapsed"); });
    s.appendChild(head);
    var body = document.createElement("div");
    body.className = "develop-section-body";
    sec.rows.forEach(function (row) {
        if (row.divider) {
            var d = document.createElement("div"); d.className = "develop-section-divider";
            body.appendChild(d);
        } else {
            body.appendChild(_buildSliderRow(row));
        }
    });
    s.appendChild(body);
    return s;
}

function _buildSliderRow(field) {
    var row = document.createElement("div");
    row.className = "develop-row";
    row.dataset.key = field.key;

    var lbl = document.createElement("span");
    lbl.className = "develop-row-label";
    lbl.textContent = field.label;
    lbl.title = "Double-click to reset";
    row.appendChild(lbl);

    var range = document.createElement("input");
    range.type = "range";
    range.min = field.min; range.max = field.max; range.step = field.step;
    range.value = field.def;
    row.appendChild(range);

    var num = document.createElement("input");
    num.type = "number";
    num.min = field.min; num.max = field.max; num.step = field.step;
    num.value = field.def;
    row.appendChild(num);

    function commit(v, isDrag) {
        v = Number(v);
        if (isNaN(v)) v = field.def;
        if (v < field.min) v = field.min;
        if (v > field.max) v = field.max;
        var S = _S(); if (!S) return;
        if (!S.developParams) S.developParams = defaultParams();
        S.developParams[field.key] = v;
        // Auto-enable when user moves a slider away from default.
        if (v !== field.def && !S.developParams.enabled) {
            S.developParams.enabled = true;
            if (_enableToggleEl) _enableToggleEl.classList.add("on");
        }
        range.value = v; num.value = v;
        row.classList.toggle("modified", v !== field.def);
        if (isDrag) _scheduleProxyRedraw(); else _scheduleFullRedraw();
    }

    range.addEventListener("input",  function () { commit(range.value, true); });
    range.addEventListener("change", function () { commit(range.value, false); });
    num.addEventListener("change",   function () { commit(num.value, false); });
    num.addEventListener("input",    function () { commit(num.value, true); });

    function reset() { commit(field.def, false); }
    lbl.addEventListener("dblclick", reset);
    range.addEventListener("dblclick", reset);

    _rowEls[field.key] = { row: row, range: range, num: num, def: field.def, step: field.step };
    return row;
}

// ========================================================================
// SYNC PANEL ← S.developParams (called on doc tab switch and B/A toggle)
// ========================================================================
function syncPanel() {
    if (!_panel) return;
    var S = _S(); if (!S) return;
    var p = S.developParams;
    if (!p) { p = defaultParams(); S.developParams = p; }
    if (_enableToggleEl) _enableToggleEl.classList.toggle("on", !!p.enabled);
    Object.keys(_rowEls).forEach(function (key) {
        var el = _rowEls[key];
        var v = p[key];
        if (v === undefined || v === null) v = el.def;
        el.range.value = v;
        el.num.value = v;
        el.row.classList.toggle("modified", v !== el.def);
    });
}

// ========================================================================
// HISTOGRAM
//
// Reads the current display ctx (which is already developed since the
// compositor hook ran). Bins luminance (or R/G/B separately) into 256
// buckets and draws as bars. Log scale is the default; the toggle in the
// header switches to linear.
// ========================================================================
function _renderHistogram() {
    if (!_histCanvas) return;
    var S = _S(); if (!S || !S.canvas) return;
    var hctx = _histCanvas.getContext("2d");
    var W = _histCanvas.width, H = _histCanvas.height;
    hctx.fillStyle = "rgba(0,0,0,0.0)";
    hctx.clearRect(0, 0, W, H);

    // Sample the visible canvas at coarse stride so this stays cheap even on big docs.
    var src = S.canvas;
    var sw = src.width, sh = src.height;
    if (!sw || !sh) return;
    var stride = Math.max(1, Math.floor(Math.sqrt((sw * sh) / 90000)));
    var sctx;
    try { sctx = src.getContext("2d"); } catch (e) { return; }
    var sample;
    try { sample = sctx.getImageData(0, 0, sw, sh); } catch (e) { return; }
    var sd = sample.data;
    var binsR = new Uint32Array(256), binsG = new Uint32Array(256), binsB = new Uint32Array(256), binsL = new Uint32Array(256);
    for (var y = 0; y < sh; y += stride) {
        var off = y * sw * 4;
        for (var x = 0; x < sw; x += stride) {
            var p = off + x * 4;
            var r = sd[p], g = sd[p + 1], b = sd[p + 2];
            binsR[r]++; binsG[g]++; binsB[b]++;
            var lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) | 0;
            if (lum > 255) lum = 255;
            binsL[lum]++;
        }
    }
    function maxOf(a) { var m = 0; for (var i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; }
    var transform = (_histScale === "log")
        ? function (v, max) { return max <= 0 ? 0 : Math.log(1 + v) / Math.log(1 + max); }
        : function (v, max) { return max <= 0 ? 0 : v / max; };

    function drawBins(bins, color) {
        var mx = maxOf(bins);
        if (mx === 0) return;
        hctx.fillStyle = color;
        for (var i = 0; i < 256; i++) {
            var t = transform(bins[i], mx);
            var bh = t * H;
            var bx = (i / 256) * W;
            var bw = W / 256;
            hctx.fillRect(bx, H - bh, bw + 0.5, bh);
        }
    }
    if (_histChannelMode === "rgb") {
        hctx.globalCompositeOperation = "screen";
        drawBins(binsR, "rgba(220, 60, 60, 0.7)");
        drawBins(binsG, "rgba( 60,200, 80, 0.7)");
        drawBins(binsB, "rgba( 90,140,255, 0.7)");
        hctx.globalCompositeOperation = "source-over";
    } else {
        drawBins(binsL, "rgba(220, 220, 220, 0.85)");
    }
}

// ========================================================================
// RESET ALL — keeps a 1-step undo by stashing the previous params.
// ========================================================================
var _resetUndoBuf = null;

function _resetAll() {
    var S = _S(); if (!S || !S.developParams) return;
    var p = S.developParams;
    var blank = defaultParams();
    blank.enabled = !!p.enabled;
    // Stash current for one-shot undo
    _resetUndoBuf = JSON.parse(JSON.stringify(p));
    Object.keys(blank).forEach(function (k) { p[k] = blank[k]; });
    syncPanel();
    _scheduleFullRedraw();
    if (window.showToast) window.showToast("Develop reset (click again to undo)", "info");
    // The button itself doesn't change; second click within ~5s undoes it.
    var prev = _resetUndoBuf;
    setTimeout(function () { if (_resetUndoBuf === prev) _resetUndoBuf = null; }, 5000);
}

// Undo the last reset if pressed again within window
function _undoReset() {
    var S = _S(); if (!S || !_resetUndoBuf) return false;
    S.developParams = JSON.parse(JSON.stringify(_resetUndoBuf));
    _resetUndoBuf = null;
    syncPanel();
    _scheduleFullRedraw();
    return true;
}

// ANCHOR_EXTRAS — chunk 5 inserts presets + before/after here
// ========================================================================
// PRESETS — JSON files saved server-side under presets/develop/.
// Endpoints (studio_api.py):
//   GET  /studio/develop/presets         → [{name, params}, ...]
//   POST /studio/develop/presets         { name, params }
// ========================================================================
var _presetSelect = null;

function _buildPresetSection() {
    var s = document.createElement("div");
    s.className = "develop-section";
    var head = document.createElement("div");
    head.className = "develop-section-header";
    var arrow = document.createElement("span");
    arrow.className = "develop-section-arrow"; arrow.textContent = "▾";
    head.appendChild(arrow);
    var name = document.createElement("span"); name.textContent = "Presets"; head.appendChild(name);
    head.addEventListener("click", function () { s.classList.toggle("collapsed"); });
    s.appendChild(head);

    var body = document.createElement("div");
    body.className = "develop-section-body";

    var row = document.createElement("div");
    row.className = "develop-presets-row";

    _presetSelect = document.createElement("select");
    _presetSelect.className = "develop-presets-select";
    var defOpt = document.createElement("option");
    defOpt.value = ""; defOpt.textContent = "— Select a preset —";
    _presetSelect.appendChild(defOpt);
    _presetSelect.addEventListener("change", function () {
        var idx = _presetSelect.selectedIndex;
        if (idx <= 0) return;
        var preset = _presetSelect.options[idx]._presetData;
        if (preset) _applyPreset(preset);
    });
    row.appendChild(_presetSelect);

    var saveBtn = document.createElement("button");
    saveBtn.className = "develop-preset-save";
    saveBtn.textContent = "Save…";
    saveBtn.title = "Save current settings as a preset";
    saveBtn.addEventListener("click", _savePreset);
    row.appendChild(saveBtn);

    body.appendChild(row);
    s.appendChild(body);

    // Async list load
    _loadPresetList();
    return s;
}

function _loadPresetList() {
    if (!_presetSelect) return;
    fetch("/studio/develop/presets").then(function (r) { return r.json(); }).then(function (data) {
        if (!_presetSelect) return;
        // Reset
        while (_presetSelect.options.length > 1) _presetSelect.remove(1);
        var list = (data && data.presets) || [];
        list.forEach(function (item) {
            var opt = document.createElement("option");
            opt.value = item.name;
            opt.textContent = item.name;
            opt._presetData = item.params || {};
            _presetSelect.appendChild(opt);
        });
    }).catch(function (e) { console.warn(TAG, "Preset list fetch failed:", e); });
}

function _applyPreset(presetParams) {
    var S = _S(); if (!S) return;
    if (!S.developParams) S.developParams = defaultParams();
    var p = S.developParams;
    var version = p._version || 1;
    Object.keys(presetParams).forEach(function (k) {
        if (k === "_version") return;
        p[k] = presetParams[k];
    });
    p._version = version;
    if (!p.enabled) p.enabled = true;
    syncPanel();
    _scheduleFullRedraw();
}

function _savePreset() {
    var S = _S(); if (!S || !S.developParams) return;
    var name = window.prompt("Preset name:", "");
    if (!name) return;
    name = String(name).trim();
    if (!/^[A-Za-z0-9 _-]{1,64}$/.test(name)) {
        if (window.showToast) window.showToast("Invalid preset name (letters, digits, space, _ -)", "error");
        return;
    }
    // Build a partial: only include non-default values, plus _version.
    var p = S.developParams;
    var defaults = defaultParams();
    var partial = { _version: p._version || 1 };
    Object.keys(p).forEach(function (k) {
        if (k === "_version" || k === "_dragging") return;
        if (p[k] !== defaults[k]) partial[k] = p[k];
    });
    fetch("/studio/develop/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name, params: partial })
    }).then(function (r) { return r.json(); }).then(function (resp) {
        if (resp && resp.ok) {
            if (window.showToast) window.showToast("Preset saved: " + name, "success");
            _loadPresetList();
        } else {
            if (window.showToast) window.showToast("Save failed: " + (resp && resp.error || "unknown"), "error");
        }
    }).catch(function (e) {
        if (window.showToast) window.showToast("Save failed: " + e.message, "error");
    });
}

// ========================================================================
// BEFORE / AFTER SPLIT
//
// Implementation: cache an "undeveloped" composite buffer once when split
// is toggled on. The display canvas already shows the developed result
// (the compositor hook always runs). To show the undeveloped half on the
// left, we draw the cached "before" buffer onto the left half of the
// display ctx, clipped at the split line. The cached buffer is invalidated
// when layers change but NOT when develop params change — so dragging
// sliders updates the right half only, exactly what we want.
//
// We hook by wrapping StudioUI.redraw: after every redraw we re-overlay
// the left half from the cache. The wrap is installed once on first toggle
// and sits idle (passes through) when _splitActive is false.
// ========================================================================
var _origRedraw = null;

function _installRedrawHook() {
    if (_origRedraw) return;
    var UI = window.StudioUI;
    if (!UI || !UI.redraw) return;
    _origRedraw = UI.redraw;
    UI.redraw = function () {
        _origRedraw.apply(UI, arguments);
        if (_splitActive) _renderSplitOverlay();
    };
}

function _buildBeforeBuffer() {
    var S = _S(); if (!S || !S.canvas) return null;
    var C = window.StudioCore; if (!C) return null;
    // Render layers without develop into a doc-resolution canvas.
    var c = document.createElement("canvas");
    c.width = S.W; c.height = S.H;
    var x = c.getContext("2d");
    x.fillStyle = "#ffffff"; x.fillRect(0, 0, S.W, S.H);
    for (var i = 0; i < S.layers.length; i++) {
        var L = S.layers[i];
        if (!L.visible) continue;
        if (L.type === "adjustment") { if (C._applyAdjustment) C._applyAdjustment(x, S.W, S.H, L); continue; }
        x.globalCompositeOperation = L.blendMode || "source-over";
        x.globalAlpha = L.opacity;
        if (L.canvas) x.drawImage(L.canvas, 0, 0);
    }
    x.globalCompositeOperation = "source-over"; x.globalAlpha = 1;
    return c;
}

function _ensureSplitElements() {
    if (!_splitLine) {
        _splitLine = document.createElement("div");
        _splitLine.className = "develop-split-line";
        document.body.appendChild(_splitLine);
        _splitLine.addEventListener("mousedown", _onSplitDragStart);
    }
    if (!_splitLabelL) {
        _splitLabelL = document.createElement("div");
        _splitLabelL.className = "develop-split-label";
        _splitLabelL.textContent = "Before";
        document.body.appendChild(_splitLabelL);
    }
    if (!_splitLabelR) {
        _splitLabelR = document.createElement("div");
        _splitLabelR.className = "develop-split-label";
        _splitLabelR.textContent = "After";
        document.body.appendChild(_splitLabelR);
    }
}

function _onSplitDragStart(e) {
    e.preventDefault();
    function move(ev) {
        var S = _S(); if (!S || !S.canvas) return;
        var rect = S.canvas.getBoundingClientRect();
        var x = ev.clientX - rect.left;
        _splitPos = Math.max(0.02, Math.min(0.98, x / Math.max(1, rect.width)));
        _redrawNow();
    }
    function up() {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
    }
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
}

function _renderSplitOverlay() {
    if (!_splitActive) return;
    var S = _S(); if (!S || !S.canvas || !S.ctx) return;
    var beforeBuf = S._developBeforeBuf;
    if (!beforeBuf) {
        beforeBuf = _buildBeforeBuffer();
        S._developBeforeBuf = beforeBuf;
    }
    if (!beforeBuf) return;
    var ctx = S.ctx;
    var z = S.zoom;
    var splitX = _splitPos * S.canvas.width;
    ctx.save();
    // Draw the "before" buffer on the left side using the same zoom transform
    // the compositor uses, clipped to splitX in display space.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(0, 0, splitX, S.canvas.height);
    ctx.clip();
    ctx.setTransform(z.scale, 0, 0, z.scale, z.ox, z.oy);
    ctx.drawImage(beforeBuf, 0, 0);
    ctx.restore();

    // Position the split line + labels in viewport coordinates
    _ensureSplitElements();
    var rect = S.canvas.getBoundingClientRect();
    var lineX = rect.left + splitX;
    _splitLine.style.left = (lineX - 1) + "px";
    _splitLine.style.top = rect.top + "px";
    _splitLine.style.height = rect.height + "px";
    _splitLabelL.style.left = (rect.left + 6) + "px";
    _splitLabelR.style.left = (lineX + 8) + "px";
    _splitLine.classList.add("visible");
    _splitLabelL.classList.add("visible");
    _splitLabelR.classList.add("visible");
}

function _toggleBeforeAfter() {
    _splitActive = !_splitActive;
    _beforeAfterBtn.classList.toggle("active", _splitActive);
    if (_splitActive) {
        _ensureSplitElements();
        _installRedrawHook();
        var S = _S(); if (S) S._developBeforeBuf = null; // rebuild fresh
        _redrawNow();
    } else {
        if (_splitLine) _splitLine.classList.remove("visible");
        if (_splitLabelL) _splitLabelL.classList.remove("visible");
        if (_splitLabelR) _splitLabelR.classList.remove("visible");
        var S2 = _S(); if (S2) S2._developBeforeBuf = null;
        _redrawNow();
    }
}

// ========================================================================
// MODULE REGISTRATION
// ========================================================================
//
// IMPORTANT: Develop is a *sidebar overlay* on top of the canvas, not a
// full-page module like Gallery / Workshop. The canvas viewport must stay
// visible behind our panel. module-system.js#_activateModule (line 156-158)
// hides #app-studio when any module activates — we override this in our
// activate() by re-adding the active class to #app-studio. The auto-created
// `.app-page` container for our module is set to display:none so it doesn't
// take any layout space.
//
// Do NOT remove the `#app-studio` re-show in activate() — without it the
// canvas vanishes when the user clicks the Develop tab.
//
if (window.StudioModules) {
    window.StudioModules.register("develop", {
        label: "Develop", icon: "◑",
        init: function (container, services) {
            console.log(TAG, "Initializing Develop module v" + VERSION);
            // Hide the auto-created module container — we render as a fixed overlay.
            container.style.display = "none";
            _buildPanel();
        },
        activate: function (container, services) {
            // Re-show the canvas page that module-system just hid.
            var studio = document.getElementById("app-studio");
            if (studio) studio.classList.add("active");
            _showPanel();
            syncPanel();
            // Histogram refresh on tab open
            try { _renderHistogram(); } catch (e) {}
        },
        deactivate: function () {
            _hidePanel();
            // Tear down before/after split overlay if open
            if (_splitLine) _splitLine.classList.remove("visible");
            if (_splitLabelL) _splitLabelL.classList.remove("visible");
            if (_splitLabelR) _splitLabelR.classList.remove("visible");
            var S = _S();
            if (S) S._developBeforeBuf = null;
        }
    });
} else {
    console.warn(TAG, "StudioModules not available — Develop cannot register");
}

// ========================================================================
// PUBLIC API
// ========================================================================
window.StudioDevelop = {
    defaultParams: defaultParams,
    applyToContext: applyToContext,
    syncPanel: function () { try { syncPanel(); } catch (e) {} },
    _isIdentity: _isIdentity,
};

console.log(TAG, "Develop module loaded v" + VERSION);

})();
