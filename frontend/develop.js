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
// i18n helper — every dynamically-built label/tooltip in this module
// passes its English source through _t() so the locale-aware text shows
// on first paint. Elements that get inserted into the DOM also receive a
// data-i18n* attribute so the global applyToDom() walker keeps them in
// sync when the user switches locales without us needing per-site
// re-render logic.
// ========================================================================
function _t(key, fallback) {
    return (window.I18N && window.I18N.t) ? window.I18N.t(key, fallback) : fallback;
}

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
// DEFAULT PARAMS — V2 shape. Existing V1 docs are migrated on load (see
// _migrateParams). All V2 fields default to identity so the pipeline is
// pixel-identical to V1 with the new code present but no V2 sliders moved.
// ========================================================================
function defaultParams() {
    return {
        _version: 2,
        enabled: false,

        // === V1: White Balance ===
        temperature: 0,
        tint: 0,

        // === V1: Tone ===
        exposure: 0,
        contrast: 0,
        highlights: 0,
        shadows: 0,
        whites: 0,
        blacks: 0,

        // === Calibration (set by eyedroppers — true remap, independent of sliders) ===
        // Linear-RGB endpoints: pixel ≤ calibBlackLin → 0, ≥ calibWhiteLin → 1.
        // Defaults preserve identity. Slider blacks/whites apply on top.
        // Note: White Balance is NOT a calibration field — the WB eyedropper
        // adjusts the Temperature/Tint sliders directly so the user can fine
        // tune from the picked neutral.
        calibBlackLin: 0,
        calibWhiteLin: 1,

        // === V1: Presence ===
        texture: 0,
        clarity: 0,
        vibrance: 0,
        saturation: 0,

        // === V1: Detail ===
        sharpenAmount: 0,
        sharpenRadius: 1.0,
        sharpenThreshold: 0,           // 0..255 — skip pixels below this detail level

        // === V1: Effects ===
        vignetteAmount: 0,
        grainAmount: 0,
        grainSize: 25,

        // === V2: Tone Curve ===
        toneCurveMode: "point",        // "point" only — Parametric mode retired
        tcHighlights: 0,               // -100..100
        tcLights: 0,                   // -100..100
        tcDarks: 0,                    // -100..100
        tcShadows: 0,                  // -100..100
        tcSplit1: 25, tcSplit2: 50, tcSplit3: 75,
        tcPoints:  [[0, 0], [255, 255]],
        tcPointsR: [[0, 0], [255, 255]],
        tcPointsG: [[0, 0], [255, 255]],
        tcPointsB: [[0, 0], [255, 255]],
        tcChannel: "rgb",              // "rgb" | "r" | "g" | "b"

        // === V2: HSL / Color Mixer === (8 bands: R, O, Y, G, A, B, P, M)
        hslHue: [0, 0, 0, 0, 0, 0, 0, 0],   // -30..30 per band
        hslSat: [0, 0, 0, 0, 0, 0, 0, 0],   // -100..100 per band
        hslLum: [0, 0, 0, 0, 0, 0, 0, 0],   // -100..100 per band
        hslMode: "hue",                      // UI tab only

        // === V2: Color Grading (3-way + Global) ===
        cgShadowH:    0, cgShadowS:    0, cgShadowL:    0,
        cgMidtoneH:   0, cgMidtoneS:   0, cgMidtoneL:   0,
        cgHighlightH: 0, cgHighlightS: 0, cgHighlightL: 0,
        cgGlobalH:    0, cgGlobalS:    0, cgGlobalL:    0,
        cgBlending: 50,                // 0..100
        cgBalance: 0,                  // -100..100
        cgPreserveLuminosity: true,    // restore L after RGB offsets (Krita default)

        // === V2: Dehaze ===
        dehaze: 0,                     // -100..100

        // === V2: Noise Reduction ===
        nrLuminance: 0,                // 0..100
        nrColor: 0,                    // 0..100

        // === V2: Color Calibration ===
        // Per-primary hue rotation + saturation scaling, plus a green↔magenta
        // tint that's weighted toward shadows. Operates as a 3×3 matrix on
        // the linear-RGB buffer right after WB — see _applyCalibration. The
        // hue sliders rotate each primary in chroma-space relative to the
        // luminance axis (Lightroom convention); saturation sliders scale
        // the primary's distance from the luminance neutral. All zero =
        // identity, pipeline bypasses entirely.
        calRedHue: 0,                  // -100..100, ±30° at extremes
        calRedSat: 0,                  // -100..100, 0..2× at extremes
        calGreenHue: 0,                // -100..100
        calGreenSat: 0,                // -100..100
        calBlueHue: 0,                 // -100..100
        calBlueSat: 0,                 // -100..100
        calShadowTint: 0,              // -100..100, green↔magenta in shadows only
    };
}

// One-shot V1 → V2 migration. Idempotent: re-running on a v2 doc is a no-op.
//
// NOTE for future versions: this fills MISSING fields with current defaults
// but does NOT transform existing field shapes. If V3+ changes the shape of
// an existing field (e.g. tcPoints format), add field-specific logic here
// gated on the source _version BEFORE bumping _version.
function _migrateParams(p) {
    if (!p) return;
    var defaults = defaultParams();
    // V1 → V2: fill every missing field with current defaults.
    if ((p._version | 0) < 2) {
        Object.keys(defaults).forEach(function (k) {
            if (!(k in p)) p[k] = defaults[k];
        });
        p._version = 2;
        return;
    }
    // Forward-fill for V2 docs that predate the calibration eyedropper
    // fields. Any field added post-V2 with an identity default is safe to
    // back-fill on load — without this, _calibIsActive misreads
    // `undefined` calibWhiteLin (default 1) as "calibration set".
    var v2NewKeys = ["calibBlackLin", "calibWhiteLin"];
    for (var i = 0; i < v2NewKeys.length; i++) {
        var k = v2NewKeys[i];
        if (!(k in p)) p[k] = defaults[k];
    }
    // V2 cleanup: Parametric tone curve mode was retired in favor of
    // Point mode only.
    //
    // INTENTIONAL DATA LOSS: Legacy docs saved with
    // toneCurveMode="parametric" are migrated to Point with their
    // Parametric slider values cleared. Anyone who saved tone-curve
    // work in Parametric mode loses that work on next load — the
    // resulting image will render as if no tone curve were applied.
    // This is a deliberate trade-off (Parametric is removed from the
    // UI; rather than carry orphan data forward and have it silently
    // not influence anything, we zero it so _isIdentity / cache
    // signatures behave cleanly). Affected users would need to redo
    // their work using Point mode.
    if (p.toneCurveMode === "parametric") {
        p.toneCurveMode = "point";
        p.tcShadows = 0;
        p.tcDarks = 0;
        p.tcLights = 0;
        p.tcHighlights = 0;
    }
}

// ========================================================================
// SLIDER DEFINITIONS — drives the UI section layout
// Each row: { key, label, min, max, step, def }
// ========================================================================
// Forward-declare V2 custom builders so SECTIONS can reference them.
// (Hoisted by the JS engine since they're function declarations below.)
var SECTIONS = [
    {
        id: "basic", label: "Calibrate", open: true,
        // Calibration eyedroppers (WB / White / Black) sit in their own
        // block at the top of the section — see _buildCalibrationBlock.
        // The sliders below are pure adjustments that apply *on top of*
        // whatever the eyedroppers calibrated.
        customBuild: _buildCalibrationBlock,
        rows: [
            { key: "temperature", label: "Temperature", min: -100, max: 100, step: 1, def: 0,
              track: "temperature" },
            { key: "tint",        label: "Tint",        min: -100, max: 100, step: 1, def: 0, track: "tint" },
            { divider: true },
            { key: "exposure",    label: "Exposure",    min: -100, max: 100, step: 1, def: 0 },
            { key: "contrast",    label: "Contrast",    min: -100, max: 100, step: 1, def: 0 },
            { key: "highlights",  label: "Highlights",  min: -100, max: 100, step: 1, def: 0 },
            { key: "shadows",     label: "Shadows",     min: -100, max: 100, step: 1, def: 0 },
            { key: "whites",      label: "Whites",      min: -100, max: 100, step: 1, def: 0 },
            { key: "blacks",      label: "Blacks",      min: -100, max: 100, step: 1, def: 0 },
            { divider: true },
            { key: "vibrance",   label: "Vibrance",   min: -100, max: 100, step: 1, def: 0 },
            { key: "saturation", label: "Saturation", min: -100, max: 100, step: 1, def: 0 },
        ]
    },
    {
        id: "detail", label: "Detail", open: false,
        rows: [
            { key: "sharpenAmount",    label: "Sharpen Amt", min: 0,   max: 150, step: 1,   def: 0   },
            { key: "sharpenRadius",    label: "Sharpen Rad", min: 0.5, max: 3.0, step: 0.1, def: 1.0 },
            { key: "sharpenThreshold", label: "Threshold",   min: 0,   max: 255, step: 1,   def: 0   },
            // V2: Noise Reduction
            { key: "nrLuminance",   label: "NR Luma",    min: 0,   max: 100, step: 1, def: 0, heavyOp: true },
            { key: "nrColor",       label: "NR Color",   min: 0,   max: 100, step: 1, def: 0, heavyOp: true },
        ]
    },
    {
        // Presence (Texture/Clarity/Dehaze) was previously a separate
        // section; merged into Effects since the conceptual line between
        // them was fuzzy and most users expected one place for "image
        // character" controls. Order: detail-amplification controls
        // first (Texture/Clarity/Dehaze), then visual treatments
        // (Vignette/Grain).
        id: "effects", label: "Effects", open: false,
        rows: [
            { key: "texture",    label: "Texture",    min: -100, max: 100, step: 1, def: 0 },
            { key: "clarity",    label: "Clarity",    min: -100, max: 100, step: 1, def: 0 },
            { key: "dehaze",     label: "Dehaze",     min: -100, max: 100, step: 1, def: 0, heavyOp: true },
            { divider: true },
            { key: "vignetteAmount", label: "Vignette",    min: -100, max: 100, step: 1, def: 0  },
            { key: "grainAmount",    label: "Grain Amount", min: 0,    max: 100, step: 1, def: 0  },
            { key: "grainSize",      label: "Grain Size",   min: 10,   max: 100, step: 1, def: 25 },
        ]
    },
];

// V2: insert custom-widget sections at the correct positions:
//   basic → toneCurve → hsl → colorGrading → detail(+nr) → effects(+presence)
SECTIONS.splice(1, 0, { id: "toneCurve",    label: "Tone Curve",    open: false, customBuild: _buildToneCurveSection });
SECTIONS.splice(2, 0, { id: "hsl",          label: "HSL / Color",   open: false, customBuild: _buildHSLSection });
SECTIONS.splice(3, 0, { id: "colorGrading", label: "Color Grading", open: false, customBuild: _buildColorGradingSection });

// Color Calibration sits at the very bottom of the Develop panel as an
// "advanced" tool — same convention as Lightroom. Collapsed by default.
// Visually grouped via {heading: ...} rows so the seven sliders read as
// "Shadows", "Red Primary", "Green Primary", "Blue Primary".
SECTIONS.push({
    id: "calibration", label: "Calibration", open: false,
    rows: [
        { heading: "Shadows", i18nKey: "develop.calibration.heading.shadows" },
        { key: "calShadowTint", label: "Tint", min: -100, max: 100, step: 1, def: 0, track: "shadowTint" },
        { divider: true },
        { heading: "Red Primary",   color: "red",   i18nKey: "develop.calibration.heading.redPrimary" },
        { key: "calRedHue",   label: "Hue",        min: -100, max: 100, step: 1, def: 0, track: "redHue" },
        { key: "calRedSat",   label: "Saturation", min: -100, max: 100, step: 1, def: 0, track: "redSat" },
        { divider: true },
        { heading: "Green Primary", color: "green", i18nKey: "develop.calibration.heading.greenPrimary" },
        { key: "calGreenHue", label: "Hue",        min: -100, max: 100, step: 1, def: 0, track: "greenHue" },
        { key: "calGreenSat", label: "Saturation", min: -100, max: 100, step: 1, def: 0, track: "greenSat" },
        { divider: true },
        { heading: "Blue Primary",  color: "blue",  i18nKey: "develop.calibration.heading.bluePrimary" },
        { key: "calBlueHue",  label: "Hue",        min: -100, max: 100, step: 1, def: 0, track: "blueHue" },
        { key: "calBlueSat",  label: "Saturation", min: -100, max: 100, step: 1, def: 0, track: "blueSat" },
    ]
});

// ========================================================================
// IDENTITY CHECK — early-out before any getImageData
// All sliders that contribute when their amount is non-zero are listed.
// sharpenRadius / grainSize have non-zero defaults but contribute nothing
// when sharpenAmount / grainAmount are zero, so they're not checked.
// V2 additions: tone curve params, HSL bands, color-grading, dehaze, NR.
// tcSplit{1,2,3} are non-zero defaults but only matter when tcShadows /
// tcDarks / tcLights / tcHighlights are non-zero. cgBlending defaults to
// 50; only matters when a CG slider is non-zero.
// ========================================================================
function _arrayAllZero(a) {
    if (!a || !a.length) return true;
    for (var i = 0; i < a.length; i++) { if ((a[i] | 0) !== 0) return false; }
    return true;
}
// Returns true when the curve is the identity straight line — exactly
// two endpoints at (0,0) and (255,255), or a missing / empty array
// (no curve data at all is treated as the identity curve).
// PRIOR BUG: the chain of `||` returned true precisely when ANY of the
// non-identity conditions held, i.e. when the curve was NOT identity.
// _toneCurveIsIdentity / _isIdentity then early-outed on every modified
// curve, which is why dragging points appeared to do nothing — the
// pipeline skipped the curve LUT entirely. Inverted to match the name.
function _pointsAreIdentity(pts) {
    if (!pts || pts.length === 0) return true;
    return pts.length === 2
        && pts[0][0] === 0   && pts[0][1] === 0
        && pts[1][0] === 255 && pts[1][1] === 255;
}
function _isIdentity(p) {
    if (!p) return true;
    if (!p.enabled) return true;
    // V1
    if (((p.temperature | 0) !== 0) || ((p.tint | 0) !== 0)) return false;
    if (((p.exposure | 0) !== 0) || ((p.contrast | 0) !== 0)) return false;
    if (((p.highlights | 0) !== 0) || ((p.shadows | 0) !== 0)) return false;
    if (((p.whites | 0) !== 0) || ((p.blacks | 0) !== 0)) return false;
    // Calibration (set by white/black eyedroppers — independent of sliders)
    if ((p.calibBlackLin || 0) > 1e-6 || Math.abs((p.calibWhiteLin || 1) - 1) > 1e-6) return false;
    if (((p.texture | 0) !== 0) || ((p.clarity | 0) !== 0)) return false;
    if (((p.vibrance | 0) !== 0) || ((p.saturation | 0) !== 0)) return false;
    if ((p.sharpenAmount | 0) !== 0) return false;
    if ((p.vignetteAmount | 0) !== 0 || (p.grainAmount | 0) !== 0) return false;
    // V2 — short-circuit for v1 docs (gate at version)
    if ((p._version | 0) < 2) return true;
    // Tone curve — Point mode only. Identity when all relevant point
    // sets are flat. (Legacy parametric tcShadows/tcDarks/tcLights/
    // tcHighlights values are cleared during _migrateParams so they
    // can't influence identity here.)
    if (!_pointsAreIdentity(p.tcPoints)) return false;
    if (!_pointsAreIdentity(p.tcPointsR)) return false;
    if (!_pointsAreIdentity(p.tcPointsG)) return false;
    if (!_pointsAreIdentity(p.tcPointsB)) return false;
    // HSL — any non-zero entry across hue/sat/lum
    if (!_arrayAllZero(p.hslHue) || !_arrayAllZero(p.hslSat) || !_arrayAllZero(p.hslLum)) return false;
    // Color grading — any region's saturation or luminance non-zero
    if ((p.cgShadowS | 0) !== 0 || (p.cgShadowL | 0) !== 0) return false;
    if ((p.cgMidtoneS | 0) !== 0 || (p.cgMidtoneL | 0) !== 0) return false;
    if ((p.cgHighlightS | 0) !== 0 || (p.cgHighlightL | 0) !== 0) return false;
    if ((p.cgGlobalS | 0) !== 0 || (p.cgGlobalL | 0) !== 0) return false;
    // Dehaze + NR
    if ((p.dehaze | 0) !== 0) return false;
    if ((p.nrLuminance | 0) !== 0 || (p.nrColor | 0) !== 0) return false;
    // Color Calibration — any non-zero per-primary hue/sat or shadow tint
    if ((p.calRedHue   | 0) !== 0 || (p.calRedSat   | 0) !== 0) return false;
    if ((p.calGreenHue | 0) !== 0 || (p.calGreenSat | 0) !== 0) return false;
    if ((p.calBlueHue  | 0) !== 0 || (p.calBlueSat  | 0) !== 0) return false;
    if ((p.calShadowTint | 0) !== 0) return false;
    return true;
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

// Linear-Float → sRGB-U8 LUT. Spans input range 0..1 — values at or above
// linear 1.0 hard-clip to sRGB 255, values below encode faithfully via the
// sRGB curve. The earlier version of this LUT applied a Reinhard soft
// shoulder starting at v=0.85 to roll exposure-boosted floats >1.0 into
// the [241..255] range; the price was that any in-range pixel above ~218
// sRGB also got compressed, so any non-zero slider squashed the bright
// end of the histogram by ~14 levels. The shoulder cost was much higher
// than its benefit (most images don't have meaningful >1.0 data), so we
// removed it. HDR-headroom preservation now belongs to the EXR export
// path, not the on-screen pipeline.
//
// Collapses ~6 Math.pow calls per pixel in Phase C into 6 array lookups.
var _LIN_TO_SRGB_U8 = (function () {
    var lut = new Uint8Array(2049);
    for (var i = 0; i <= 2048; i++) {
        var v = i / 2048; // 0..1
        lut[i] = (_linearToSrgb01(v) * 255 + 0.5) | 0;
    }
    return lut;
})();
function _lin2u8(v) {
    if (v <= 0) return 0;
    if (v >= 1) return 255;
    return _LIN_TO_SRGB_U8[(v * 2048) | 0];
}

// xorshift32 — deterministic per-document grain seed
function _xs32(state) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; }

// CIE Lab helpers — used by Lab-space white balance. D65 reference white.
// Domain: linear (NOT sRGB) RGB → XYZ → Lab.
function _labF(t)    { return t > 0.008856 ? Math.cbrt(t) : (903.3 * t + 16) / 116; }
function _labFInv(t) { return t > 0.206897 ? t * t * t   : (116 * t - 16) / 903.3; }
var _LAB_WHITE_X = 0.95047, _LAB_WHITE_Y = 1.0, _LAB_WHITE_Z = 1.08883;

// ========================================================================
// STATE access — lazily resolved (StudioCore boots before us)
// ========================================================================
function _S() { return window.StudioCore && window.StudioCore.state; }

// ========================================================================
// PIPELINE — see ANCHOR_PIPELINE below
// ========================================================================

function applyToContext(ctx, w, h, params) {
    // V1 → V2 migration runs once per loaded doc — idempotent, no-op on v2.
    // Centralised here so any path that reaches the pipeline is migrated:
    // doc tab switch, undo/redo restore, freshly-constructed state, etc.
    _migrateParams(params);
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
// Chains: linearize (sRGB→linear) → exposure scale.
// Output is Float32 in linear space (may exceed 1.0 due to exposure gain).
// White balance moved out of the LUT into Phase A.5 so it can run in Lab
// (perceptually uniform) instead of as RGB multipliers — see
// _applyWhiteBalance below.
//
// Exposure: v *= 2^(exposure * 5/100)   ⇒ ±5 stops at slider extremes.
// ========================================================================
function _buildLutA(p) {
    var expGain = Math.pow(2, (p.exposure || 0) * 5 / 100);
    var lutR = new Float32Array(256);
    var lutG = new Float32Array(256);
    var lutB = new Float32Array(256);
    for (var i = 0; i < 256; i++) {
        var lin = _SRGB_TO_LIN[i] * expGain;
        lutR[i] = lin;
        lutG[i] = lin;
        lutB[i] = lin;
    }
    return { lutR: lutR, lutG: lutG, lutB: lutB };
}

function _getLutA(p) {
    var S = _S();
    var sig = "E" + (p.exposure | 0);
    if (S && S._developLutCache && S._developLutCache.sig === sig) return S._developLutCache;
    var lut = _buildLutA(p);
    lut.sig = sig;
    if (S) S._developLutCache = lut;
    return lut;
}

// ========================================================================
// PHASE A.5 — White Balance (Lab-space)
//
// Convert linear RGB → XYZ (D65) → Lab, shift the b* axis (blue↔yellow)
// by `temperature * 0.3` and the a* axis (green↔magenta) by `-tint * 0.15`,
// then convert back. Lab is perceptually uniform, so a temperature shift
// adjusts colour without inadvertently darkening or brightening the image,
// the way RGB-multiplier WB does.
//
// Drag-time (proxy) renders fall back to the cheaper RGB multipliers from
// the V1 implementation; the difference between the two is invisible at
// drag resolution and saves ~6 Math.cbrt calls per pixel.
// ========================================================================
function _applyWhiteBalance(rLin, gLin, bLin, n, p) {
    var temp = p.temperature || 0;
    var tint = p.tint || 0;
    if (temp === 0 && tint === 0) return;

    if (p._dragging) {
        // V1-style RGB multipliers — fast path for slider drag.
        var rGain = 1 + temp / 200;
        var bGain = 1 - temp / 200;
        var gGain = 1 + temp / 600 - tint / 300;
        for (var i = 0; i < n; i++) {
            rLin[i] *= rGain;
            gLin[i] *= gGain;
            bLin[i] *= bGain;
        }
        return;
    }

    // Full-resolution Lab path.
    var aShift = -tint * 0.15;
    var bShift =  temp * 0.3;
    var invX = 1 / _LAB_WHITE_X, invZ = 1 / _LAB_WHITE_Z;
    var aDelta = aShift / 500;
    var bDelta = bShift / 200;
    for (var j = 0; j < n; j++) {
        var R = rLin[j], G = gLin[j], B = bLin[j];
        // Linear sRGB → XYZ (D65)
        var X = 0.4124564 * R + 0.3575761 * G + 0.1804375 * B;
        var Y = 0.2126729 * R + 0.7151522 * G + 0.0721750 * B;
        var Z = 0.0193339 * R + 0.1191920 * G + 0.9503041 * B;
        // XYZ → Lab (we never need L itself here — only fx/fy/fz to shift)
        var fx = _labF(X * invX);
        var fy = _labF(Y);                  // _LAB_WHITE_Y is 1.0
        var fz = _labF(Z * invZ);
        // Apply shifts in Lab space:
        //   fx' = fy + (a* + aShift)/500 = fx + aShift/500
        //   fz' = fy - (b* + bShift)/200 = fz - bShift/200
        var fxn = fx + aDelta;
        var fzn = fz - bDelta;
        // Lab → XYZ
        var Xn = _LAB_WHITE_X * _labFInv(fxn);
        var Yn = _labFInv(fy);              // _LAB_WHITE_Y is 1.0
        var Zn = _LAB_WHITE_Z * _labFInv(fzn);
        // XYZ → linear sRGB
        var Rn =  3.2404542 * Xn - 1.5371385 * Yn - 0.4985314 * Zn;
        var Gn = -0.9692660 * Xn + 1.8760108 * Yn + 0.0415560 * Zn;
        var Bn =  0.0556434 * Xn - 0.2040259 * Yn + 1.0572252 * Zn;
        rLin[j] = Rn < 0 ? 0 : Rn;
        gLin[j] = Gn < 0 ? 0 : Gn;
        bLin[j] = Bn < 0 ? 0 : Bn;
    }
}

// ========================================================================
// PHASE A.6 — Color Calibration (V2 only)
//
// Applies a 3×3 matrix to the linear-RGB buffer, plus a shadow-tint pass
// that biases dark regions toward green or magenta. Operates after WB and
// before highlights/shadows: WB neutralizes the scene, then Calibration
// restyles the primaries; downstream tools (highlights, contrast, HSL,
// color grading) all see the calibration-shifted colors.
//
// Matrix construction (CIE xy chromaticity-space rotation):
//
//   The standard sRGB primaries sit at known chromaticities in CIE xy:
//     R: (0.640, 0.330)   G: (0.300, 0.600)   B: (0.150, 0.060)
//     White (D65): (0.3127, 0.3290)
//
//   Each primary's slider rotates that primary in xy space around the
//   white point. Purity (saturation) scales the radius from white. The
//   rotated primaries define a *new* RGB color space; the calibration
//   matrix re-interprets the input pixel values as if they were already
//   in the new space, then converts back to the working sRGB primaries.
//
//   M = sRGB_RGB_to_XYZ_inv × new_primaries_RGB_to_XYZ
//
//   This matches darktable's RGB Primaries module (GPL-3.0). Their
//   approach is to operate in a perceptual chromaticity space instead
//   of doing rotations in 3D RGB around the achromatic axis — the
//   former is roughly perceptually uniform across primaries, while
//   the latter is asymmetric (red feels right, blue feels weak in
//   3D-rotation models because BT.709's luminance weights aren't
//   symmetric).
//
//   Slider mapping:
//     Hue ±100  → ±30° rotation in xy space
//     Purity ±100 → multiplicative factor 0.01..5.0 (default 1.0 at 0)
//
//   At all sliders zero the new primaries == standard primaries, the
//   matrix is exact identity, and the per-pixel matmul is a no-op.
//
// Identity early-out: if all 7 calibration params are zero, the function
// returns immediately without touching the buffer. _isIdentity() also
// covers these so the whole _applyDevelopFull bypasses on a clean doc.
// ========================================================================

// Standard sRGB / Rec.709 primaries in CIE xy. Working profile is linear
// sRGB throughout the Develop pipeline (LUT-A inputs are sRGB-decoded
// canvas pixels), so these are the right anchor points.
var _CAL_PRIMARIES_XY = [
    [0.640, 0.330], // R
    [0.300, 0.600], // G
    [0.150, 0.060], // B
];
// D65 white point in xy.
var _CAL_WHITE_XY = [0.3127, 0.3290];

// Slider ±100 → ±20° rotation, matching darktable's stock soft range
// for `red_hue` / `green_hue` / `blue_hue` in dt_iop_primaries_params_t
// (hard range goes to ±π but the UI surfaces ±20° as the working
// envelope).
var _CAL_MAX_HUE_RAD = 20 * Math.PI / 180;

// Slider (-100..+100) → multiplicative purity factor anchored to the
// **sRGB gamut edge** along the rotated direction (cf. darktable's
// `_find_distance_to_edge` in custom_primaries.c). At purity = 1.0 the
// primary lies exactly on the sRGB triangle edge — matching the
// untouched primaries when no rotation is applied. At purity > 1.0 it
// pokes outside the gamut (super-saturated); at purity < 1.0 it pulls
// in toward the white point (desaturated).
//
// Range matches darktable's stock soft range for `*_purity` fields in
// dt_iop_primaries_params_t (50%..150%, displayed as percentage):
//   slider  0   → 1.0   (identity, primary stays at gamut edge)
//   slider +100 → 1.5
//   slider -100 → 0.5
function _calSliderToPurity(s) {
    if (!s) return 1.0;
    return 1.0 + (s / 100) * 0.5;
}

function _calSliderToHueRad(s) {
    return (s || 0) / 100 * _CAL_MAX_HUE_RAD;
}

// 2D ray–segment intersection. Ray starts at W=(wx,wy) in direction
// D=(dx,dy); segment runs from P1 to P2. Returns the ray distance s ≥ 0
// where the intersection occurs, or -1 if no intersection in the ray's
// forward half-line and within the segment. Used by _findDistanceToEdge.
function _rayIntersectSegment(wx, wy, dx, dy, p1x, p1y, p2x, p2y) {
    var v2x = p2x - p1x, v2y = p2y - p1y;
    var denom = dx * v2y - dy * v2x;
    if (Math.abs(denom) < 1e-12) return -1;  // ray parallel to segment
    var qx = p1x - wx, qy = p1y - wy;
    var s = (qx * v2y - qy * v2x) / denom;   // ray parameter
    var t = (qx * dy  - qy * dx)  / denom;   // segment parameter
    if (s < 0) return -1;
    if (t < -1e-9 || t > 1 + 1e-9) return -1;
    return s;
}

// Distance from white point to the sRGB chromaticity-triangle edge,
// along direction theta (radians, measured CCW from +x in xy plane).
// The white point lies inside the triangle, so a forward ray hits
// exactly one edge. Used to anchor primary purity to the gamut boundary
// — see darktable's _find_distance_to_edge (custom_primaries.c).
function _findDistanceToEdge(theta, whiteXY, primariesXY) {
    var dx = Math.cos(theta), dy = Math.sin(theta);
    var minS = Infinity;
    for (var i = 0; i < 3; i++) {
        var p1 = primariesXY[i];
        var p2 = primariesXY[(i + 1) % 3];
        var s = _rayIntersectSegment(whiteXY[0], whiteXY[1], dx, dy,
                                     p1[0], p1[1], p2[0], p2[1]);
        if (s >= 0 && s < minS) minS = s;
    }
    // Fallback: ray didn't hit any segment (shouldn't happen for white
    // inside the triangle). Use the original primary radius so we
    // degrade gracefully.
    return minS === Infinity ? 0.25 : minS;
}

// Rotate a primary around the white point in xy chromaticity, then
// place its radius at `purity × edgeDistance(rotated direction)`. The
// resulting xy coord is fed into _buildRgbToXyzMatrix to construct the
// new RGB→XYZ basis. Mirrors darktable's dt_rotate_and_scale_primary
// adapted to anchor on the sRGB triangle (Studio's working gamut)
// rather than the visible-spectrum locus.
function _rotatePrimaryInXY(primaryXY, whiteXY, allPrimariesXY, rotationRad, purity) {
    var dx = primaryXY[0] - whiteXY[0];
    var dy = primaryXY[1] - whiteXY[1];
    var theta = Math.atan2(dy, dx) + rotationRad;
    var edgeDist = _findDistanceToEdge(theta, whiteXY, allPrimariesXY);
    var rNew = edgeDist * purity;
    return [
        whiteXY[0] + rNew * Math.cos(theta),
        whiteXY[1] + rNew * Math.sin(theta),
    ];
}

// Convert chromaticity (x, y) at unit luminance Y=1 to XYZ.
function _xyToXYZ(xy) {
    var x = xy[0], y = xy[1];
    if (y < 1e-10) return [0, 0, 0];
    return [x / y, 1.0, (1 - x - y) / y];
}

// 3×3 matrix-vector multiply. Matrix is row-major flat [9].
function _mat3MulVec(m, v) {
    return [
        m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
        m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
        m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ];
}

// 3×3 matrix-matrix multiply (row-major flat [9] × row-major flat [9]).
function _mat3Mul(a, b) {
    var r = new Array(9);
    for (var i = 0; i < 3; i++) {
        for (var j = 0; j < 3; j++) {
            r[i * 3 + j] =
                a[i * 3 + 0] * b[0 * 3 + j] +
                a[i * 3 + 1] * b[1 * 3 + j] +
                a[i * 3 + 2] * b[2 * 3 + j];
        }
    }
    return r;
}

// 3×3 matrix inverse via cofactors. Returns null on singular matrix.
function _mat3Inverse(m) {
    var a = m[0], b = m[1], c = m[2];
    var d = m[3], e = m[4], f = m[5];
    var g = m[6], h = m[7], i = m[8];
    var det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < 1e-12) return null;
    var inv = 1 / det;
    return [
         (e * i - f * h) * inv, -(b * i - c * h) * inv,  (b * f - c * e) * inv,
        -(d * i - f * g) * inv,  (a * i - c * g) * inv, -(a * f - c * d) * inv,
         (d * h - e * g) * inv, -(a * h - b * g) * inv,  (a * e - b * d) * inv,
    ];
}

// Build the RGB→XYZ matrix for a color space defined by primaries
// (3 chromaticity coordinates) and a white point (1 chromaticity).
// Standard Bruce Lindbloom construction:
//   1. Each primary at unit luminance has XYZ = (x/y, 1, (1-x-y)/y).
//   2. Form M_unscaled with these primaries as columns.
//   3. Solve M_unscaled × S = white_XYZ for the per-primary scale vector S.
//   4. Final RGB→XYZ = M_unscaled with each column multiplied by S[i].
function _buildRgbToXyzMatrix(primariesXY, whiteXY) {
    var rXYZ = _xyToXYZ(primariesXY[0]);
    var gXYZ = _xyToXYZ(primariesXY[1]);
    var bXYZ = _xyToXYZ(primariesXY[2]);
    var whiteXYZ = _xyToXYZ(whiteXY);

    // M_unscaled with primaries as columns, row-major flat:
    //   [ Xr Xg Xb ]
    //   [ Yr Yg Yb ]    Yr=Yg=Yb=1
    //   [ Zr Zg Zb ]
    var Munsc = [
        rXYZ[0], gXYZ[0], bXYZ[0],
        rXYZ[1], gXYZ[1], bXYZ[1],
        rXYZ[2], gXYZ[2], bXYZ[2],
    ];
    var MunscInv = _mat3Inverse(Munsc);
    if (!MunscInv) return null;
    var S = _mat3MulVec(MunscInv, whiteXYZ);

    // Scale columns of Munsc by S
    return [
        Munsc[0] * S[0], Munsc[1] * S[1], Munsc[2] * S[2],
        Munsc[3] * S[0], Munsc[4] * S[1], Munsc[5] * S[2],
        Munsc[6] * S[0], Munsc[7] * S[1], Munsc[8] * S[2],
    ];
}

function _buildCalibrationMatrix(p) {
    // Rotate each primary in xy chromaticity around the white point.
    var rHue = _calSliderToHueRad(p.calRedHue);
    var gHue = _calSliderToHueRad(p.calGreenHue);
    var bHue = _calSliderToHueRad(p.calBlueHue);
    var rPur = _calSliderToPurity(p.calRedSat);
    var gPur = _calSliderToPurity(p.calGreenSat);
    var bPur = _calSliderToPurity(p.calBlueSat);

    var newPrimaries = [
        _rotatePrimaryInXY(_CAL_PRIMARIES_XY[0], _CAL_WHITE_XY, _CAL_PRIMARIES_XY, rHue, rPur),
        _rotatePrimaryInXY(_CAL_PRIMARIES_XY[1], _CAL_WHITE_XY, _CAL_PRIMARIES_XY, gHue, gPur),
        _rotatePrimaryInXY(_CAL_PRIMARIES_XY[2], _CAL_WHITE_XY, _CAL_PRIMARIES_XY, bHue, bPur),
    ];

    // Build matrix per darktable's `_calculate_adjustment_matrix`:
    //   1. NEW primaries → XYZ
    //   2. compose with XYZ → STANDARD primaries (the inverse of the
    //      working profile's RGB→XYZ matrix)
    //   3. result M reinterprets the input pixel as if it had been
    //      authored against the new primaries, then re-encodes it back
    //      into the standard working space.
    //
    // M × stdRGB = stdFromXYZ × newToXYZ × stdRGB, i.e.: take the input
    // RGB, treat it as RGB in the NEW primary basis, project to XYZ,
    // and re-express in the standard basis. White is preserved by
    // construction because both bases share the same white point.
    var stdToXYZ = _buildRgbToXyzMatrix(_CAL_PRIMARIES_XY, _CAL_WHITE_XY);
    var newToXYZ = _buildRgbToXyzMatrix(newPrimaries, _CAL_WHITE_XY);
    if (!stdToXYZ || !newToXYZ) {
        // Degenerate primaries (e.g., purity ≈ 0 collapsing onto white).
        return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    }
    var stdFromXYZ = _mat3Inverse(stdToXYZ);
    if (!stdFromXYZ) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    return _mat3Mul(stdFromXYZ, newToXYZ);
}

function _applyCalibration(rLin, gLin, bLin, n, p) {
    if ((p._version | 0) < 2) return;

    var rH = p.calRedHue   | 0, rS = p.calRedSat   | 0;
    var gH = p.calGreenHue | 0, gS = p.calGreenSat | 0;
    var bH = p.calBlueHue  | 0, bS = p.calBlueSat  | 0;
    var st = p.calShadowTint | 0;
    if (rH === 0 && rS === 0 && gH === 0 && gS === 0 && bH === 0 && bS === 0 && st === 0) {
        return;
    }

    var matrixActive = (rH !== 0 || rS !== 0 || gH !== 0 || gS !== 0 || bH !== 0 || bS !== 0);
    var m = matrixActive ? _buildCalibrationMatrix(p) : null;
    var m0, m1, m2, m3, m4, m5, m6, m7, m8;
    if (m) {
        m0 = m[0]; m1 = m[1]; m2 = m[2];
        m3 = m[3]; m4 = m[4]; m5 = m[5];
        m6 = m[6]; m7 = m[7]; m8 = m[8];
    }

    // Shadow-tint amount in linear units. The 0.15 scale matches the
    // perceptual weight of the existing WB tint slider — at shadowTint=±100
    // the effect is visible on shadows without crushing midtone detail.
    var stAmt = st / 100 * 0.15;
    var stActive = stAmt !== 0;

    for (var i = 0; i < n; i++) {
        var r = rLin[i], g = gLin[i], b = bLin[i];

        if (matrixActive) {
            var rN = m0 * r + m1 * g + m2 * b;
            var gN = m3 * r + m4 * g + m5 * b;
            var bN = m6 * r + m7 * g + m8 * b;
            r = rN; g = gN; b = bN;
        }

        if (stActive) {
            // Luminance-weighted shadow tint. 1.0 at black, 0 above lum≈0.33.
            // Squared falloff keeps midtones clean while still reaching dark
            // areas smoothly.
            var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            var w = 1.0 - lum * 3.0;
            if (w > 0) {
                if (w > 1) w = 1;
                w *= w;
                // Positive stAmt = magenta (push G down, R+B up); negative = green.
                var shift = stAmt * w;
                g -= shift;
                r += shift * 0.5;
                b += shift * 0.5;
            }
        }

        rLin[i] = r;
        gLin[i] = g;
        bLin[i] = b;
    }
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
    // Krita-derived toward-edge proportional push (replaces the previous
    // additive lerp toward fixed targets):
    //   dstV = dv > 0 ? 1.0 : 0.0
    //   v   += |dv| * (dstV - v)
    //   chroma *= 1 - |dv|              // pixels approach gray near edges
    // Effect: a dark pixel (v=0.2) moves much further than a bright pixel
    // (v=0.9) under the same +Shadows slider, output never overshoots, and
    // chroma drops naturally as pixels are pushed toward the extremes.
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
            var R = rLin[i], G = gLin[i], B = bLin[i];
            if (sh !== 0) {
                var sm = 1 - _smoothstep(0, 0.5, Yp);
                var dv = sh * sm;                    // signed
                if (dv !== 0) {
                    var dst = dv > 0 ? 1.0 : 0.0;
                    var mag = dv < 0 ? -dv : dv;
                    R += mag * (dst - R);
                    G += mag * (dst - G);
                    B += mag * (dst - B);
                    var Y1 = 0.2126 * R + 0.7152 * G + 0.0722 * B;
                    var k1 = 1 - mag;
                    R = Y1 + (R - Y1) * k1;
                    G = Y1 + (G - Y1) * k1;
                    B = Y1 + (B - Y1) * k1;
                }
            }
            if (hl !== 0) {
                var hm = _smoothstep(0.5, 1.0, Yp);
                var dv2 = hl * hm;
                if (dv2 !== 0) {
                    var dst2 = dv2 > 0 ? 1.0 : 0.0;
                    var mag2 = dv2 < 0 ? -dv2 : dv2;
                    R += mag2 * (dst2 - R);
                    G += mag2 * (dst2 - G);
                    B += mag2 * (dst2 - B);
                    var Y2 = 0.2126 * R + 0.7152 * G + 0.0722 * B;
                    var k2 = 1 - mag2;
                    R = Y2 + (R - Y2) * k2;
                    G = Y2 + (G - Y2) * k2;
                    B = Y2 + (B - Y2) * k2;
                }
            }
            rLin[i] = R;
            gLin[i] = G;
            bLin[i] = B;
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

    // ---- Phase A: sRGB → linear Float32 (with exposure gain) ----
    // High-precision path: when a float32 sidecar is loaded and matches
    // the canvas dims, decode from float (sub-LSB precision + headroom
    // above 1.0). Float values are sRGB-encoded just like the uint8
    // input, so the gamma decode still runs — only the /255 normalize
    // step is skipped and headroom carries through into linear space.
    var lut = _getLutA(p);
    var rLin = new Float32Array(n);
    var gLin = new Float32Array(n);
    var bLin = new Float32Array(n);
    if (_floatSrc && _floatSrc.w === w && _floatSrc.h === h
            && _floatSrc.r && _floatSrc.r.length === n) {
        var srcR = _floatSrc.r, srcG = _floatSrc.g, srcB = _floatSrc.b;
        var expGain = Math.pow(2, (p.exposure || 0) * 5 / 100);
        for (var k = 0; k < n; k++) {
            // Inline sRGB → linear (Rec.709 piecewise gamma). VAE noise
            // can produce small negatives — clamp to 0 (LUT does the
            // same implicitly). Values >1 carry through the curve so the
            // headroom feeds into linear.
            var sr = srcR[k]; if (sr < 0) sr = 0;
            var sg = srcG[k]; if (sg < 0) sg = 0;
            var sb = srcB[k]; if (sb < 0) sb = 0;
            var lr = sr <= 0.04045 ? sr / 12.92 : Math.pow((sr + 0.055) / 1.055, 2.4);
            var lg = sg <= 0.04045 ? sg / 12.92 : Math.pow((sg + 0.055) / 1.055, 2.4);
            var lb = sb <= 0.04045 ? sb / 12.92 : Math.pow((sb + 0.055) / 1.055, 2.4);
            rLin[k] = lr * expGain;
            gLin[k] = lg * expGain;
            bLin[k] = lb * expGain;
        }
    } else {
        var lutR = lut.lutR, lutG = lut.lutG, lutB = lut.lutB;
        for (var i = 0, j = 0; i < n; i++, j += 4) {
            rLin[i] = lutR[d[j]];
            gLin[i] = lutG[d[j + 1]];
            bLin[i] = lutB[d[j + 2]];
        }
    }

    // ---- Phase A.5: white balance (Lab-space at full res, RGB on drag) ----
    _applyWhiteBalance(rLin, gLin, bLin, n, p);

    // ---- Phase A.6: color calibration (3×3 matrix on linear RGB + shadow tint) ----
    // Runs AFTER WB (which neutralizes the scene) and BEFORE highlights/shadows
    // (so all downstream tools see the calibration-shifted primaries). Identity
    // early-out inside the function so this is free when no calibration sliders
    // are touched.
    _applyCalibration(rLin, gLin, bLin, n, p);

    // ---- Phase A.7: tone curve (linear-light Float32, 4096-entry LUT) ----
    // Moved out of post-Phase-C (where it ran on U8 and banded badly even on
    // small adjustments) into linear-light float space. HP headroom (>1.0)
    // passes through to the LUT's last entry; lerp between bins gives
    // effectively-infinite output precision. Identity / version-gate
    // early-out inside the function — free when curves are flat.
    _applyToneCurve(rLin, gLin, bLin, n, p);

    // ---- Phase B: highlights/shadows ----
    var hlAmt = p.highlights | 0;
    var shAmt = p.shadows | 0;
    if (hlAmt !== 0 || shAmt !== 0) {
        var wbSig = lut.sig + "|T" + (p.temperature | 0) + "|N" + (p.tint | 0);
        var blurCache = _getLumBlur(rLin, gLin, bLin, w, h, wbSig);
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
    // +Whites lifts whites (brighter). +Blacks lifts blacks (brighter) —
    // both sliders move their endpoint toward the middle, matching
    // Lightroom convention. -Blacks crushes blacks toward 0; -Whites
    // pulls whites down. Divisor /500 (max ±20% endpoint shift): the
    // previous /200 was clipping ±50% of the tonal range at the slider
    // extremes, which felt drastically more aggressive than Lightroom.
    // whitePoint < 1 brightens (output gets multiplied by 1/whitePoint > 1);
    // blackPoint < 0 lifts dark pixels above 0 after the (r - bp) * invRange map.
    // Calibration endpoints from the eyedroppers do a true linear remap:
    //   pixel ≤ calibBlackLin → 0,  pixel ≥ calibWhiteLin → 1
    // Slider blacks/whites apply *on top* as additional offset, so the
    // user can fine-tune after calibrating.
    var calibBlk = p.calibBlackLin || 0;
    var calibWht = (p.calibWhiteLin == null) ? 1 : p.calibWhiteLin;
    if (calibBlk < 0) calibBlk = 0; else if (calibBlk > 1) calibBlk = 1;
    if (calibWht < 0) calibWht = 0; else if (calibWht > 1) calibWht = 1;
    var blackPoint = calibBlk - (p.blacks  || 0) / 500;
    var whitePoint = calibWht - (p.whites  || 0) / 500;
    var range = whitePoint - blackPoint;
    if (Math.abs(range) < 1e-4) range = 1e-4;
    var invRange = 1 / range;
    // Contrast scaling: slider 100 was hitting Studio-15-equivalent feel
    // (slope tan(0.575π) ≈ 1.27) only at slider 15; at slider 100 the slope
    // ran toward tan(π/2) → ∞ and at slider -100 it hit slope 0 (which
    // collapsed every pixel to gray 128 — the spike-in-histogram bug).
    // Scale slider 100 to cNorm 0.15 so slider 100 ≈ Lightroom +100.
    var cNorm = (p.contrast || 0) * 0.0015;
    if (cNorm < -0.95) cNorm = -0.95; else if (cNorm > 0.95) cNorm = 0.95;
    var contrastSlope = Math.tan((cNorm + 1) * Math.PI / 4);
    var doRemap = Math.abs(blackPoint) > 1e-6 || Math.abs(whitePoint - 1) > 1e-6;
    var doContrast = (p.contrast | 0) !== 0;
    // Note: we deliberately do NOT hard-clamp the remap output. _lin2u8's
    // soft shoulder (Reinhard roll-off above linear 0.85) preserves
    // highlight detail above the picked-white instead of slamming
    // everything to a flat sRGB 255 spike — matches Lightroom-style
    // highlight preservation. The cost is that the picked-white pixel
    // renders at ~241 sRGB instead of exact 255; users wanting exact
    // 255-clip can pull the Whites slider on top of the calibration.

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

    // (Tone curve moved upstream to Phase A.7 — runs in linear-light
    // float before HL/SH, eliminating U8-LUT banding.)

    // ---- Phase D: vibrance, then saturation ----
    var vibAmt = (p.vibrance || 0) / 100;
    if (vibAmt !== 0) _applyVibrance(d, n, vibAmt);
    var satAmt = (p.saturation || 0) / 100;
    if (satAmt !== 0) _applySaturation(d, n, satAmt);

    // ---- V2: HSL / Color Mixer ----
    _applyHSL(d, n, p);

    // ---- V2: Color Grading (3-way + Global) ----
    _applyColorGrading(d, n, p);

    // ---- Phase E: spatial USM (texture / clarity) → V2 dehaze → sharpen ----
    if ((p.texture | 0) !== 0)        _unsharpMaskLuma(d, w, h, 8,  (p.texture || 0) / 100, false);
    if ((p.clarity | 0) !== 0)        _unsharpMaskLuma(d, w, h, 40, (p.clarity || 0) / 200, true);
    // V2: Dehaze sits between Clarity and Sharpening per spec
    _applyDehaze(d, n, w, h, p);
    if ((p.sharpenAmount | 0) !== 0)
        _unsharpMaskLuma(d, w, h, p.sharpenRadius || 1.0, (p.sharpenAmount || 0) / 100, false,
                         p.sharpenThreshold | 0, true);

    // ---- V2: Noise Reduction (luminance bilateral + color Cb/Cr blur) ----
    _applyNoiseReduction(d, n, w, h, p);

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
    // Earlier thresholds (0.5 MP / 2 MP / 0.25 fallback) caused visible
    // pixelation at SDXL native (1024² = 1 MP) and worse at hires
    // (2048² = 4 MP → quartered to 512²). Bumped to keep all common
    // generation sizes at full or half res — never quarter. The LUT-based
    // pipeline holds 60fps at 2 MP on any modern hardware; 0.5 scale
    // covers everything up through ~2832².
    var mp = (w * h) / 1e6;
    if (mp <= 2) return 1;
    return 0.5;
}

// Reused across slider-drag frames so we don't allocate a new GPU texture
// per call. Reallocated only when the proxy dimensions change (i.e. when
// the document is resized).
var _proxyTmp = null;
var _proxyTmpW = 0;
var _proxyTmpH = 0;

function _applyDevelopProxy(ctx, w, h, p) {
    var scale = _proxyScale(w, h);
    if (scale >= 1) { _applyDevelopFull(ctx, w, h, p); return; }
    var pw = Math.max(1, Math.round(w * scale));
    var ph = Math.max(1, Math.round(h * scale));
    if (!_proxyTmp || _proxyTmpW !== pw || _proxyTmpH !== ph) {
        _proxyTmp = document.createElement("canvas");
        _proxyTmp.width = pw; _proxyTmp.height = ph;
        _proxyTmpW = pw; _proxyTmpH = ph;
    }
    var tx = _proxyTmp.getContext("2d", { colorSpace: "srgb" });
    tx.imageSmoothingEnabled = true;
    tx.drawImage(ctx.canvas, 0, 0, pw, ph);
    _applyDevelopFull(tx, pw, ph, p);
    // Replace the original ctx contents with the upscaled proxy result.
    var prevSmoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(_proxyTmp, 0, 0, pw, ph, 0, 0, w, h);
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
    // Positive amount saturates: push non-max channels AWAY from max so the
    // gap (= perceived saturation) widens. Negative amount desaturates by
    // pulling them toward max. Already-saturated pixels are protected by
    // the (1 - sat) weight.
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
        d[p]     = _clampU8(R - dR);
        d[p + 1] = _clampU8(G - dG);
        d[p + 2] = _clampU8(B - dB);
    }
}

// HSL conversion helpers — extracted from V1's inlined _applySaturation so
// V2's HSL section, color grading, and any future per-pixel HSL pass share
// one source of truth. Operates on normalized 0..1 RGB inputs.
//
// _rgb2hsl(r, g, b) → { h: 0..360, s: 0..1, l: 0..1 }
// _hsl2rgb(h, s, l) → { r: 0..1, g: 0..1, b: 0..1 }
function _rgb2hsl(r, g, b) {
    var max = r > g ? (r > b ? r : b) : (g > b ? g : b);
    var min = r < g ? (r < b ? r : b) : (g < b ? g : b);
    var L = (max + min) * 0.5;
    var delta = max - min;
    if (delta === 0) return { h: 0, s: 0, l: L };
    var denom = 1 - Math.abs(2 * L - 1);
    var S = denom <= 0 ? 0 : delta / denom;
    var H;
    if (max === r)      H = ((g - b) / delta) % 6;
    else if (max === g) H = (b - r) / delta + 2;
    else                H = (r - g) / delta + 4;
    H *= 60; if (H < 0) H += 360;
    return { h: H, s: S, l: L };
}
function _hsl2rgb(H, S, L) {
    var C = (1 - Math.abs(2 * L - 1)) * S;
    var X = C * (1 - Math.abs((H / 60) % 2 - 1));
    var off = L - C * 0.5;
    var r, g, b;
    var seg = (H / 60) | 0;
    if      (seg === 0) { r = C; g = X; b = 0; }
    else if (seg === 1) { r = X; g = C; b = 0; }
    else if (seg === 2) { r = 0; g = C; b = X; }
    else if (seg === 3) { r = 0; g = X; b = C; }
    else if (seg === 4) { r = X; g = 0; b = C; }
    else                { r = C; g = 0; b = X; }
    return { r: r + off, g: g + off, b: b + off };
}

function _applySaturation(d, n, amount) {
    // Krita's nonlinear positive boost: moderate amounts produce natural
    // saturation, extremes ramp up aggressively. Negative stays linear so
    // -100 cleanly desaturates to gray.
    var posMul = 1 + amount + 2 * amount * amount;     // amount > 0
    var negMul = 1 + amount;                           // amount <= 0
    if (negMul < 0) negMul = 0;
    var positive = amount > 0;
    for (var p = 0, end = n * 4; p < end; p += 4) {
        var r = d[p] / 255, g = d[p + 1] / 255, b = d[p + 2] / 255;
        var hsl = _rgb2hsl(r, g, b);
        if (hsl.s === 0) continue;            // gray pixel — saturation has no effect
        var S;
        if (positive) {
            S = hsl.s * posMul;
            if (S > 1) S = 1;
        } else {
            S = hsl.s * negMul;
            if (S < 0) S = 0;
        }
        var rgb = _hsl2rgb(hsl.h, S, hsl.l);
        d[p]     = _clampU8(rgb.r * 255);
        d[p + 1] = _clampU8(rgb.g * 255);
        d[p + 2] = _clampU8(rgb.b * 255);
    }
}

// ========================================================================
// V2 — TONE CURVE
//
// Two modes: parametric (4 region sliders + 3 split boundaries) and point
// (Fritsch-Carlson monotone cubic through user-placed control points,
// optionally per-channel). Both modes evaluate to a 256-entry U8 LUT
// applied per-pixel. Caches keyed on stringified params.
// ========================================================================


// Fritsch-Carlson monotone cubic interpolation. Point set must contain
// at least the two endpoints (0,0) and (255,255). Sorts on x. Returns a
// 256-entry U8 LUT.
// Produces a 4096-entry Float32 LUT covering input x ∈ [0, 255] mapped
// to output y ∈ [0, 1]. Used by the linear-domain tone curve pass: 16x
// finer resolution than the old 256-entry U8 LUT eliminates output
// banding on small adjustments, and storing as float skips the per-bin
// integer rounding that was the dominant source of staircase artifacts.
function _buildPointCurveLut(points) {
    var LUT_N = 4096;
    var LUT_LAST = LUT_N - 1;
    var inv255 = 1 / 255;
    var xStep = 255 / LUT_LAST;
    if (!points || points.length < 2) {
        // identity: y == x/255 across the LUT (lookup of v*4095 returns v)
        var idLut = new Float32Array(LUT_N);
        var idStep = 1 / LUT_LAST;
        for (var i = 0; i < LUT_N; i++) idLut[i] = i * idStep;
        return idLut;
    }
    // Copy + sort on x; deduplicate same-x entries (keep the last)
    var pts = points.slice().sort(function (a, b) { return a[0] - b[0]; });
    var clean = [pts[0]];
    for (var k = 1; k < pts.length; k++) {
        if (pts[k][0] === clean[clean.length - 1][0]) clean[clean.length - 1] = pts[k];
        else clean.push(pts[k]);
    }
    pts = clean;
    var n = pts.length;
    var x = new Float32Array(n), y = new Float32Array(n);
    for (var i2 = 0; i2 < n; i2++) { x[i2] = pts[i2][0]; y[i2] = pts[i2][1]; }
    // Slopes between adjacent points
    var d = new Float32Array(n - 1);
    for (var i3 = 0; i3 < n - 1; i3++) {
        var h = x[i3 + 1] - x[i3];
        d[i3] = h === 0 ? 0 : (y[i3 + 1] - y[i3]) / h;
    }
    // Tangents — average of adjacent slopes (one-sided at endpoints)
    var m = new Float32Array(n);
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (var i4 = 1; i4 < n - 1; i4++) m[i4] = (d[i4 - 1] + d[i4]) * 0.5;
    // Enforce monotonicity (Fritsch-Carlson)
    for (var i5 = 0; i5 < n - 1; i5++) {
        if (d[i5] === 0) {
            m[i5] = 0; m[i5 + 1] = 0;
        } else {
            var alpha = m[i5] / d[i5];
            var beta  = m[i5 + 1] / d[i5];
            var s = alpha * alpha + beta * beta;
            if (s > 9) {
                var tau = 3 / Math.sqrt(s);
                m[i5]     = tau * alpha * d[i5];
                m[i5 + 1] = tau * beta  * d[i5];
            }
        }
    }
    // Evaluate to LUT_N-entry float LUT at evenly spaced x in [0, 255]
    var lut = new Float32Array(LUT_N);
    var seg = 0;
    for (var ti = 0; ti < LUT_N; ti++) {
        var t = ti * xStep;
        // Advance segment so x[seg] <= t < x[seg+1]
        while (seg < n - 2 && t >= x[seg + 1]) seg++;
        var x0 = x[seg], x1 = x[seg + 1];
        if (t <= x0) {
            var y0 = y[0] * inv255;
            lut[ti] = y0 < 0 ? 0 : (y0 > 1 ? 1 : y0);
            continue;
        }
        if (t >= x[n - 1]) {
            var yL = y[n - 1] * inv255;
            lut[ti] = yL < 0 ? 0 : (yL > 1 ? 1 : yL);
            continue;
        }
        var hh = x1 - x0;
        var ss = (t - x0) / hh;
        var ss2 = ss * ss, ss3 = ss2 * ss;
        var h00 = 2 * ss3 - 3 * ss2 + 1;
        var h10 = ss3 - 2 * ss2 + ss;
        var h01 = -2 * ss3 + 3 * ss2;
        var h11 = ss3 - ss2;
        var v = (h00 * y[seg] + h10 * hh * m[seg] + h01 * y[seg + 1] + h11 * hh * m[seg + 1]) * inv255;
        lut[ti] = v < 0 ? 0 : (v > 1 ? 1 : v);
    }
    return lut;
}

// LUT cache. Sig key is JSON.stringify of the relevant points array.
// Per-channel mode builds three separate LUTs (one per R/G/B).
function _getToneCurveLuts(p) {
    var S = _S();
    var cache = (S && S._developToneCurveCache) || null;
    if (p.tcChannel === "rgb") {
        var sig = "P|" + JSON.stringify(p.tcPoints);
        if (cache && cache.sig === sig) return cache;
        var lut = _buildPointCurveLut(p.tcPoints);
        cache = { sig: sig, mode: "point-rgb", lut: lut };
    } else {
        var sigR = "PR|" + JSON.stringify(p.tcPointsR);
        var sigG = "PG|" + JSON.stringify(p.tcPointsG);
        var sigB = "PB|" + JSON.stringify(p.tcPointsB);
        var sigPC = sigR + "|" + sigG + "|" + sigB;
        if (cache && cache.sig === sigPC) return cache;
        cache = {
            sig: sigPC, mode: "point-perchan",
            lutR: _buildPointCurveLut(p.tcPointsR),
            lutG: _buildPointCurveLut(p.tcPointsG),
            lutB: _buildPointCurveLut(p.tcPointsB)
        };
    }
    if (S) S._developToneCurveCache = cache;
    return cache;
}

function _toneCurveIsIdentity(p) {
    // Point mode only — Parametric was retired. Active-channel curve
    // determines whether the LUT pass runs at all; non-active channels
    // are stored in the doc but only contribute when their channel is
    // selected.
    if (p.tcChannel === "rgb") return _pointsAreIdentity(p.tcPoints);
    return _pointsAreIdentity(p.tcPointsR)
        && _pointsAreIdentity(p.tcPointsG)
        && _pointsAreIdentity(p.tcPointsB);
}

// Apply tone curve to the linear-light Float32 buffers. Pipeline
// position: Phase A.7 — after exposure gain (Phase A), white balance
// (A.5) and color calibration (A.6), before highlights/shadows (Phase
// B). Operating on float values in linear space (with HP headroom > 1.0
// passing through to the LUT's last entry) eliminates output banding
// that the previous U8-LUT pass produced; values stay float through
// every downstream phase until Phase C re-encodes to U8 once at the
// end. Linear interpolation between LUT bins gives effectively-infinite
// output precision.
function _applyToneCurve(rLin, gLin, bLin, n, p) {
    if ((p._version | 0) < 2) return;
    if (_toneCurveIsIdentity(p)) return;
    var c = _getToneCurveLuts(p);
    var LAST = 4095;
    if (c.mode === "point-perchan") {
        var lR = c.lutR, lG = c.lutG, lB = c.lutB;
        for (var i = 0; i < n; i++) {
            var r = rLin[i]; if (r < 0) r = 0;
            var g = gLin[i]; if (g < 0) g = 0;
            var b = bLin[i]; if (b < 0) b = 0;
            var ri = r * 4095; if (ri > LAST) ri = LAST;
            var gi = g * 4095; if (gi > LAST) gi = LAST;
            var bi = b * 4095; if (bi > LAST) bi = LAST;
            var r0 = ri | 0, r1 = r0 < LAST ? r0 + 1 : LAST;
            var g0 = gi | 0, g1 = g0 < LAST ? g0 + 1 : LAST;
            var b0 = bi | 0, b1 = b0 < LAST ? b0 + 1 : LAST;
            rLin[i] = lR[r0] + (lR[r1] - lR[r0]) * (ri - r0);
            gLin[i] = lG[g0] + (lG[g1] - lG[g0]) * (gi - g0);
            bLin[i] = lB[b0] + (lB[b1] - lB[b0]) * (bi - b0);
        }
    } else {
        var lut = c.lut;
        for (var j = 0; j < n; j++) {
            var rr = rLin[j]; if (rr < 0) rr = 0;
            var gg = gLin[j]; if (gg < 0) gg = 0;
            var bb = bLin[j]; if (bb < 0) bb = 0;
            var rri = rr * 4095; if (rri > LAST) rri = LAST;
            var ggi = gg * 4095; if (ggi > LAST) ggi = LAST;
            var bbi = bb * 4095; if (bbi > LAST) bbi = LAST;
            var rr0 = rri | 0, rr1 = rr0 < LAST ? rr0 + 1 : LAST;
            var gg0 = ggi | 0, gg1 = gg0 < LAST ? gg0 + 1 : LAST;
            var bb0 = bbi | 0, bb1 = bb0 < LAST ? bb0 + 1 : LAST;
            rLin[j] = lut[rr0] + (lut[rr1] - lut[rr0]) * (rri - rr0);
            gLin[j] = lut[gg0] + (lut[gg1] - lut[gg0]) * (ggi - gg0);
            bLin[j] = lut[bb0] + (lut[bb1] - lut[bb0]) * (bbi - bb0);
        }
    }
}

// ========================================================================
// V2 — HSL / COLOR MIXER
//
// 8 bands at hue centers [0, 30, 60, 120, 180, 240, 280, 320]°. Each
// band gets a raised-cosine weight window of half-width 60° around its
// center, so adjacent bands always overlap and there are no coverage
// gaps in the hue circle (per maintainer amendment to spec).
//
// For each pixel: rgb→hsl, accumulate weighted hue shift / sat scale /
// lum scale across all 8 bands, apply, hsl→rgb.
//
// No spatial dependency, no caching. Cheap enough to run at full res.
// ========================================================================
var _HSL_BAND_CENTERS = [0, 30, 60, 120, 180, 240, 280, 320];
var _HSL_HALF_WIDTH = 60;

function _hslIsIdentity(p) {
    return _arrayAllZero(p.hslHue) && _arrayAllZero(p.hslSat) && _arrayAllZero(p.hslLum);
}

function _applyHSL(d, n, p) {
    if ((p._version | 0) < 2) return;
    if (_hslIsIdentity(p)) return;
    var hueArr = p.hslHue, satArr = p.hslSat, lumArr = p.hslLum;
    var hw = _HSL_HALF_WIDTH;
    for (var px = 0, end = n * 4; px < end; px += 4) {
        var r = d[px] / 255, g = d[px + 1] / 255, b = d[px + 2] / 255;
        var hsl = _rgb2hsl(r, g, b);
        if (hsl.s === 0) continue;          // gray pixel — no hue, skip
        // Accumulate per-band weighted contributions
        var hueShift = 0, satScale = 0, lumScale = 0, totalWeight = 0;
        for (var k = 0; k < 8; k++) {
            var center = _HSL_BAND_CENTERS[k];
            var diff = Math.abs(hsl.h - center);
            if (diff > 180) diff = 360 - diff;       // shortest arc
            if (diff >= hw) continue;
            var w = 0.5 * (1 + Math.cos(Math.PI * diff / hw));
            hueShift += w * hueArr[k];
            satScale += w * satArr[k] / 100;
            lumScale += w * lumArr[k] / 100;
            totalWeight += w;
        }
        if (totalWeight === 0) continue;
        // hueShift is sum-of-weighted-degrees (max ~30 at peak band)
        var H = hsl.h + hueShift;
        if (H < 0) H = ((H % 360) + 360) % 360;
        else if (H >= 360) H = H % 360;
        var S = hsl.s * (1 + satScale);
        if (S < 0) S = 0; else if (S > 1) S = 1;
        var L = hsl.l * (1 + lumScale);
        if (L < 0) L = 0; else if (L > 1) L = 1;
        var rgb = _hsl2rgb(H, S, L);
        d[px]     = _clampU8(rgb.r * 255);
        d[px + 1] = _clampU8(rgb.g * 255);
        d[px + 2] = _clampU8(rgb.b * 255);
    }
}

// ========================================================================
// V2 — COLOR GRADING (3-way wheels + Global)
//
// For each pixel: compute luminance Y, derive shadow / midtone / highlight
// weights via smoothsteps with boundaries shifted by Balance and softened
// by Blending. Sum precomputed RGB offset vectors per region (hue+sat
// converted to a 3-channel tint) plus per-region luminance offsets. The
// region offsets are computed once per param change — only the weights
// vary per pixel.
// ========================================================================
var CG_RGB_GAIN = 0.15;       // sat=100 produces ~±0.15 per-channel offset
var CG_LUM_GAIN = 0.30;       // L=±100 produces ~±0.30 brightness offset

function _cgRegionOffset(h, s) {
    // hue degrees, sat 0..100 → RGB triple, scaled by CG_RGB_GAIN
    var sat = (s | 0) / 100;
    if (sat <= 0) return [0, 0, 0];
    var hr = h * Math.PI / 180;
    return [
        sat * Math.cos(hr) * CG_RGB_GAIN,
        sat * Math.cos(hr - 2 * Math.PI / 3) * CG_RGB_GAIN,
        sat * Math.cos(hr - 4 * Math.PI / 3) * CG_RGB_GAIN
    ];
}

function _cgIsIdentity(p) {
    return ((p.cgShadowS    | 0) === 0) && ((p.cgShadowL    | 0) === 0)
        && ((p.cgMidtoneS   | 0) === 0) && ((p.cgMidtoneL   | 0) === 0)
        && ((p.cgHighlightS | 0) === 0) && ((p.cgHighlightL | 0) === 0)
        && ((p.cgGlobalS    | 0) === 0) && ((p.cgGlobalL    | 0) === 0);
}

function _applyColorGrading(d, n, p) {
    if ((p._version | 0) < 2) return;
    if (_cgIsIdentity(p)) return;

    // Precomputed region offset vectors
    var oSh = _cgRegionOffset(p.cgShadowH    || 0, p.cgShadowS    || 0);
    var oMt = _cgRegionOffset(p.cgMidtoneH   || 0, p.cgMidtoneS   || 0);
    var oHl = _cgRegionOffset(p.cgHighlightH || 0, p.cgHighlightS || 0);
    var oGb = _cgRegionOffset(p.cgGlobalH    || 0, p.cgGlobalS    || 0);
    var lSh = ((p.cgShadowL    || 0) / 100) * CG_LUM_GAIN;
    var lMt = ((p.cgMidtoneL   || 0) / 100) * CG_LUM_GAIN;
    var lHl = ((p.cgHighlightL || 0) / 100) * CG_LUM_GAIN;
    var lGb = ((p.cgGlobalL    || 0) / 100) * CG_LUM_GAIN;

    // Krita / GIMP color-balance transfer function. Linear ramps with a
    // single transition width, multiplied for the midtone band so its
    // weight peaks in the middle and decays into both shoulders.
    var a = 0.25;
    var b = 0.333 + ((p.cgBalance | 0) / 300);    // cgBalance shifts boundary
    if (b < 0.05) b = 0.05; else if (b > 0.95) b = 0.95;
    var cgScale = 0.7;
    var invA = 1 / a;
    var preserveLum = p.cgPreserveLuminosity !== false;

    for (var px = 0, end = n * 4; px < end; px += 4) {
        var R = d[px] / 255, G = d[px + 1] / 255, B = d[px + 2] / 255;
        var hsl = _rgb2hsl(R, G, B);
        var L = hsl.l;

        var shadowW = -(L - b) * invA + 0.5;
        if (shadowW < 0) shadowW = 0; else if (shadowW > 1) shadowW = 1;
        shadowW *= cgScale;

        var midA = (L - b) * invA + 0.5;
        if (midA < 0) midA = 0; else if (midA > 1) midA = 1;
        var midC = -(L + b - 1) * invA + 0.5;
        if (midC < 0) midC = 0; else if (midC > 1) midC = 1;
        var midW = midA * midC * cgScale;

        var hlW = (L + b - 1) * invA + 0.5;
        if (hlW < 0) hlW = 0; else if (hlW > 1) hlW = 1;
        hlW *= cgScale;

        var dR = shadowW * oSh[0] + midW * oMt[0] + hlW * oHl[0] + oGb[0];
        var dG = shadowW * oSh[1] + midW * oMt[1] + hlW * oHl[1] + oGb[1];
        var dB = shadowW * oSh[2] + midW * oMt[2] + hlW * oHl[2] + oGb[2];
        var dL = shadowW * lSh   + midW * lMt   + hlW * lHl   + lGb;

        var nR = R + dR, nG = G + dG, nB = B + dB;

        if (preserveLum) {
            // Restore the original L, applying any explicit L offset on top.
            var clampedR = nR < 0 ? 0 : (nR > 1 ? 1 : nR);
            var clampedG = nG < 0 ? 0 : (nG > 1 ? 1 : nG);
            var clampedB = nB < 0 ? 0 : (nB > 1 ? 1 : nB);
            var newHsl = _rgb2hsl(clampedR, clampedG, clampedB);
            var finalL = L + dL;
            if (finalL < 0) finalL = 0; else if (finalL > 1) finalL = 1;
            var rgb = _hsl2rgb(newHsl.h, newHsl.s, finalL);
            nR = rgb.r; nG = rgb.g; nB = rgb.b;
        } else {
            nR += dL; nG += dL; nB += dL;
        }

        d[px]     = _clampU8(nR * 255);
        d[px + 1] = _clampU8(nG * 255);
        d[px + 2] = _clampU8(nB * 255);
    }
}

// ========================================================================
// V2 — DEHAZE
//
// Dark Channel Prior (He, Sun & Tang, CVPR 2009):
//   1. Dark channel: per pixel min(R,G,B), then minimum filter over a
//      local window (separable, deque-based — O(N) per pass).
//   2. Atmospheric light: top 0.1% of dark-channel pixels, pick the
//      brightest (R+G+B)/3 in original among them. Vector A.
//   3. Transmission t = 1 - omega * darkChannel(I/A); clamp t >= 0.1.
//      Then box-blur t (cheap guided-filter approximation).
//   4. Recover J_c = (I_c - A_c)/t + A_c per channel.
//   5. Negative dehaze (adding haze): blend toward A.
//
// Heavy. Always proxy on drag. Cache the dark channel, A, and refined t
// keyed on upstream params (anything that changes the input pixels).
// ========================================================================

// van-Herk / Gil-Werman style separable minimum filter (1D deque).
// Operates on a Float32 single-channel buffer in place. radius is in pixels.
function _separableMinFilter(buf, w, h, radius) {
    if (radius < 1) return;
    var k = radius * 2 + 1;
    var tmp = new Float32Array(buf.length);

    // Horizontal pass: for each row, sliding-window min over k pixels.
    var deqIdx = new Int32Array(w);
    for (var y = 0; y < h; y++) {
        var row = y * w;
        var head = 0, tail = 0;
        for (var x = 0; x < w; x++) {
            // Drop indices outside the window
            while (head < tail && deqIdx[head] < x - radius) head++;
            // Drop indices whose value is >= incoming (they can never be the min while incoming is in window)
            var v = buf[row + x];
            while (head < tail && buf[row + deqIdx[tail - 1]] >= v) tail--;
            deqIdx[tail++] = x;
            // Output the min for the window centered at (x - radius)
            var outX = x - radius;
            if (outX >= 0) tmp[row + outX] = buf[row + deqIdx[head]];
        }
        // Trailing tail (last `radius` columns)
        for (var xt = w - radius; xt < w; xt++) {
            while (head < tail && deqIdx[head] < xt - radius) head++;
            tmp[row + xt] = buf[row + deqIdx[head]];
        }
    }

    // Vertical pass: same as above but on columns of tmp → buf.
    var deqIdxV = new Int32Array(h);
    for (var x2 = 0; x2 < w; x2++) {
        var headV = 0, tailV = 0;
        for (var y2 = 0; y2 < h; y2++) {
            while (headV < tailV && deqIdxV[headV] < y2 - radius) headV++;
            var v2 = tmp[y2 * w + x2];
            while (headV < tailV && tmp[deqIdxV[tailV - 1] * w + x2] >= v2) tailV--;
            deqIdxV[tailV++] = y2;
            var outY = y2 - radius;
            if (outY >= 0) buf[outY * w + x2] = tmp[deqIdxV[headV] * w + x2];
        }
        for (var yt = h - radius; yt < h; yt++) {
            while (headV < tailV && deqIdxV[headV] < yt - radius) headV++;
            buf[yt * w + x2] = tmp[deqIdxV[headV] * w + x2];
        }
    }
}

// Box blur via two passes of the moving-average. Cheap guided-filter approx.
function _boxBlur1D(src, dst, w, h, radius, axis) {
    var inv = 1 / (radius * 2 + 1);
    if (axis === "h") {
        for (var y = 0; y < h; y++) {
            var row = y * w;
            // Initialize the running sum with the first window
            var sum = 0;
            for (var i = 0; i < radius; i++) sum += src[row + i] * 2;       // mirror left edge
            for (var i2 = 0; i2 <= radius; i2++) sum += src[row + i2];
            for (var x = 0; x < w; x++) {
                dst[row + x] = sum * inv;
                var addX = x + radius + 1;
                var dropX = x - radius;
                sum += addX < w ? src[row + addX] : src[row + (w - 1)];
                sum -= dropX >= 0 ? src[row + dropX] : src[row];
            }
        }
    } else {
        for (var x2 = 0; x2 < w; x2++) {
            var sum2 = 0;
            for (var j = 0; j < radius; j++) sum2 += src[j * w + x2] * 2;
            for (var j2 = 0; j2 <= radius; j2++) sum2 += src[j2 * w + x2];
            for (var y2 = 0; y2 < h; y2++) {
                dst[y2 * w + x2] = sum2 * inv;
                var addY = y2 + radius + 1;
                var dropY = y2 - radius;
                sum2 += addY < h ? src[addY * w + x2] : src[(h - 1) * w + x2];
                sum2 -= dropY >= 0 ? src[dropY * w + x2] : src[x2];
            }
        }
    }
}
function _boxBlur(buf, w, h, radius) {
    if (radius < 1) return;
    var tmp = new Float32Array(buf.length);
    _boxBlur1D(buf, tmp, w, h, radius, "h");
    _boxBlur1D(tmp, buf, w, h, radius, "v");
}

function _dehazeIsIdentity(p) { return (p.dehaze | 0) === 0; }

function _applyDehaze(d, n, w, h, p) {
    if ((p._version | 0) < 2) return;
    if (_dehazeIsIdentity(p)) return;

    var dehaze = (p.dehaze | 0) / 100;       // -1..1
    // Window size: 15 px at 1024x, scale roughly with min dim.
    var winRadius = Math.max(3, Math.round(Math.min(w, h) * 0.0075));
    if (winRadius > 25) winRadius = 25;
    var blurRadius = Math.max(1, winRadius >> 1);

    // ===== Dark channel =====
    var dark = new Float32Array(n);
    for (var i = 0, m = 0; i < n; i++, m += 4) {
        var r = d[m], g = d[m + 1], b = d[m + 2];
        var mi = r < g ? (r < b ? r : b) : (g < b ? g : b);
        dark[i] = mi / 255;
    }
    _separableMinFilter(dark, w, h, winRadius);

    // ===== Atmospheric light =====
    // Top 0.1% pixels by dark-channel brightness — these are the haze / sky
    // candidates. Average their RGB instead of picking the single brightest:
    // a single near-white outlier (sun glint, specular highlight, signature
    // pixel on AI-generated images) used to skew A toward 255 and crush the
    // recovery. Averaging stabilizes A across content types.
    var topN = Math.max(10, Math.floor(n * 0.001));
    var idxArr = new Uint32Array(n);
    for (var ii = 0; ii < n; ii++) idxArr[ii] = ii;
    var idxList = Array.from(idxArr);
    idxList.sort(function (a, b) { return dark[b] - dark[a]; });
    var Ar = 0, Ag = 0, Ab = 0;
    for (var t = 0; t < topN; t++) {
        var pi = idxList[t];
        var pm = pi * 4;
        Ar += d[pm]; Ag += d[pm + 1]; Ab += d[pm + 2];
    }
    Ar /= topN; Ag /= topN; Ab /= topN;
    // Cap A at 240/255 — the recovery formula J = (I - A)/t + A is wildly
    // sensitive to A when A is near max. Capping prevents the "everything
    // crushes to black" failure mode on highly saturated / synthetic images
    // (anime renders, AI generations) where the brightest area is genuine
    // bright content rather than haze.
    if (Ar > 240) Ar = 240; if (Ag > 240) Ag = 240; if (Ab > 240) Ab = 240;
    if (Ar < 1) Ar = 1; if (Ag < 1) Ag = 1; if (Ab < 1) Ab = 1;

    if (dehaze >= 0) {
        // ===== Positive dehaze: estimate transmission, recover scene =====
        // Cap effective omega at 0.85 — full omega = 1.0 with t0 = 0.1 produces
        // tInv up to 10×, which crushes mid-tones and clips highlights even
        // on photographs. Adobe's published behavior runs in roughly this range.
        var omega = dehaze * 0.85;
        var t1 = new Float32Array(n);
        for (var i2 = 0, m2 = 0; i2 < n; i2++, m2 += 4) {
            // dark channel of (I/A): min over channels of ratio
            var rr = d[m2] / Ar, gg = d[m2 + 1] / Ag, bb = d[m2 + 2] / Ab;
            var minRatio = rr < gg ? (rr < bb ? rr : bb) : (gg < bb ? gg : bb);
            t1[i2] = minRatio;
        }
        // Min-filter over the window (this is the dark channel of I/A)
        _separableMinFilter(t1, w, h, winRadius);
        // Higher t0 floor (0.2 vs old 0.1): keeps tInv ≤ 5 even at maximum
        // omega. Combined with the omega cap above, this produces a wide
        // safe range without the crush-to-black failure mode.
        for (var i3 = 0; i3 < n; i3++) {
            var tv = 1 - omega * t1[i3];
            if (tv < 0.2) tv = 0.2;
            t1[i3] = tv;
        }
        _boxBlur(t1, w, h, blurRadius);

        // Recover: J_c = (I_c - A_c)/t + A_c
        for (var i4 = 0, m4 = 0; i4 < n; i4++, m4 += 4) {
            var tInv = 1 / t1[i4];
            d[m4]     = _clampU8((d[m4]     - Ar) * tInv + Ar);
            d[m4 + 1] = _clampU8((d[m4 + 1] - Ag) * tInv + Ag);
            d[m4 + 2] = _clampU8((d[m4 + 2] - Ab) * tInv + Ab);
        }
    } else {
        // ===== Negative dehaze: blend toward atmospheric light (add haze) =====
        var omegaN = -dehaze;
        var ao = 1 - omegaN;
        for (var i5 = 0, m5 = 0; i5 < n; i5++, m5 += 4) {
            d[m5]     = _clampU8(d[m5]     * ao + Ar * omegaN);
            d[m5 + 1] = _clampU8(d[m5 + 1] * ao + Ag * omegaN);
            d[m5 + 2] = _clampU8(d[m5 + 2] * ao + Ab * omegaN);
        }
    }
}

// ========================================================================
// V2 — NOISE REDUCTION
//
// Luminance: bilateral filter (edge-preserving smoothing) on Y. Capped
// radius 5 (per spec) so a kernel is at most 11×11. Always proxy on drag.
// Color: separate Y / Cb / Cr, Gaussian-blur Cb and Cr only, recombine.
// Cb/Cr blur reuses _separableGaussian.
//
// Both subpasses operate on the U8 buffer in place.
// ========================================================================

function _applyNoiseReductionLuma(d, n, w, h, amount /* 0..1 */) {
    if (amount <= 0) return;
    var spatialSigma = 1 + amount * 4;             // 1..5 px
    var rangeSigma = 0.05 + amount * 0.20;         // 0.05..0.25 (normalized)
    var radius = Math.min(5, Math.ceil(spatialSigma * 2));
    var twoSpatial2 = 2 * spatialSigma * spatialSigma;
    var twoRange2 = 2 * rangeSigma * rangeSigma;

    // Extract Y (BT.601), normalize 0..1
    var Y = new Float32Array(n);
    for (var i = 0, m = 0; i < n; i++, m += 4) {
        Y[i] = (0.299 * d[m] + 0.587 * d[m + 1] + 0.114 * d[m + 2]) / 255;
    }
    // Filtered Y
    var Yf = new Float32Array(n);
    // Spatial weight LUT (radius²+1 entries)
    var spatialLut = new Float32Array((2 * radius + 1) * (2 * radius + 1));
    var idx = 0;
    for (var dy = -radius; dy <= radius; dy++) {
        for (var dx = -radius; dx <= radius; dx++) {
            spatialLut[idx++] = Math.exp(-(dx * dx + dy * dy) / twoSpatial2);
        }
    }
    for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
            var c = y * w + x;
            var Yc = Y[c];
            var sum = 0, wSum = 0;
            var sIdx = 0;
            for (var dy2 = -radius; dy2 <= radius; dy2++) {
                var yy = y + dy2;
                if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1;
                var rowOff = yy * w;
                for (var dx2 = -radius; dx2 <= radius; dx2++) {
                    var xx = x + dx2;
                    if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1;
                    var Yn = Y[rowOff + xx];
                    var diff = Yn - Yc;
                    var wT = spatialLut[sIdx++] * Math.exp(-(diff * diff) / twoRange2);
                    sum += Yn * wT;
                    wSum += wT;
                }
            }
            Yf[c] = wSum > 0 ? sum / wSum : Yc;
        }
    }
    // Apply ratio per pixel
    for (var i2 = 0, m2 = 0; i2 < n; i2++, m2 += 4) {
        var ratio = Yf[i2] / Math.max(Y[i2], 0.001);
        d[m2]     = _clampU8(d[m2]     * ratio);
        d[m2 + 1] = _clampU8(d[m2 + 1] * ratio);
        d[m2 + 2] = _clampU8(d[m2 + 2] * ratio);
    }
}

function _applyNoiseReductionColor(d, n, w, h, amount /* 0..1 */) {
    if (amount <= 0) return;
    var sigma = amount * 15;         // 0..15 px
    if (sigma < 0.5) return;
    // Convert to YCbCr, blur Cb and Cr, recombine.
    var Cb = new Float32Array(n);
    var Cr = new Float32Array(n);
    var Y  = new Float32Array(n);
    for (var i = 0, m = 0; i < n; i++, m += 4) {
        var R = d[m], G = d[m + 1], B = d[m + 2];
        Y[i]  =  0.299 * R + 0.587 * G + 0.114 * B;
        Cb[i] = -0.169 * R - 0.331 * G + 0.500 * B;
        Cr[i] =  0.500 * R - 0.419 * G - 0.081 * B;
    }
    _separableGaussian(Cb, w, h, sigma);
    _separableGaussian(Cr, w, h, sigma);
    for (var i2 = 0, m2 = 0; i2 < n; i2++, m2 += 4) {
        var rR = Y[i2] + 1.403 * Cr[i2];
        var rG = Y[i2] - 0.344 * Cb[i2] - 0.714 * Cr[i2];
        var rB = Y[i2] + 1.770 * Cb[i2];
        d[m2]     = _clampU8(rR);
        d[m2 + 1] = _clampU8(rG);
        d[m2 + 2] = _clampU8(rB);
    }
}

function _applyNoiseReduction(d, n, w, h, p) {
    if ((p._version | 0) < 2) return;
    var lumA = (p.nrLuminance | 0) / 100;
    var colA = (p.nrColor | 0) / 100;
    if (lumA <= 0 && colA <= 0) return;
    if (lumA > 0) _applyNoiseReductionLuma(d, n, w, h, lumA);
    if (colA > 0) _applyNoiseReductionColor(d, n, w, h, colA);
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
// and adding (amount * detail) back. `midToneWeighted` clamps the boost
// near pure black/white using 4 * v * (1 - v) — used by Clarity to
// preserve highlights/shadows.
//
// `threshold` (0..255 in U8 detail-magnitude units) skips pixels in flat
// areas — prevents noise amplification under aggressive sharpening.
//
// `useRatio` (sharpening only) scales R/G/B by Y_sharpened/Y_original
// instead of additive boost — preserves chroma at high-contrast edges,
// eliminates the colour fringing that the additive approach produces on
// saturated highlights.
// ========================================================================
function _unsharpMaskLuma(d, w, h, radius, amount, midToneWeighted, threshold, useRatio) {
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

    var thr = (threshold | 0) > 0 ? (threshold | 0) / 255 : 0;
    for (var yyy = 0; yyy < h; yyy++) {
        var rowI = yyy * w;
        var rowP = yyy * w * 4;
        for (var xxx = 0; xxx < w; xxx++) {
            var fullY = Y[rowI + xxx];
            var detail = detailLookup(xxx, yyy, fullY);
            if (thr > 0) {
                var ad = detail < 0 ? -detail : detail;
                if (ad < thr) continue;          // flat area — skip
            }
            var boost = amount * detail;
            if (midToneWeighted) {
                var v = fullY;
                if (v < 0) v = 0; else if (v > 1) v = 1;
                boost *= 4 * v * (1 - v);
            }
            var p = rowP + xxx * 4;
            if (useRatio) {
                // Lightness-only via ratio scaling — chroma preserved.
                var origY = fullY > 1e-4 ? fullY : 1e-4;
                var newY  = fullY + boost;
                if (newY < 0) newY = 0;
                var ratio = newY / origY;
                d[p]     = _clampU8(d[p]     * ratio);
                d[p + 1] = _clampU8(d[p + 1] * ratio);
                d[p + 2] = _clampU8(d[p + 2] * ratio);
            } else {
                var add = boost * 255;
                d[p]     = _clampU8(d[p]     + add);
                d[p + 1] = _clampU8(d[p + 1] + add);
                d[p + 2] = _clampU8(d[p + 2] + add);
            }
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

// High Precision: cached float32 RGB source loaded from a .float32.bin
// sidecar. When _floatSrc.w/h match the canvas dims passed to
// _applyDevelopFull, we feed planar Float32 data directly into the
// pipeline (with an inline sRGB→linear conversion + exposure gain),
// skipping the uint8 LUT path and preserving sub-LSB precision plus
// the small headroom above 1.0 the VAE produces on highlights.
var _floatSrc = null;
// Track the in-flight fetch so a rapid url change can supersede it.
var _floatSrcLoading = null;
var _hpBadge = null;

function _showPanel() { if (_panel) _panel.classList.add("visible"); }
function _hidePanel() { if (_panel) _panel.classList.remove("visible"); }

// Element registry — populated during _buildPanel, used by syncPanel
var _rowEls = {};            // key → { row, range, num, def, step }
var _histCanvas = null;
var _histClipL = null;       // shadow clip indicator
var _histClipR = null;       // highlight clip indicator
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

// Histogram update during proxy redraw is throttled — getImageData on the
// final canvas is the dominant cost on big docs, so we skip every other
// frame during drag rather than fire it on each one.
var _proxyHistFlip = 0;
function _scheduleProxyRedraw() {
    if (_proxyRafId) return;
    _proxyRafId = requestAnimationFrame(function () {
        _proxyRafId = 0;
        var S = _S();
        if (S && S.developParams) S.developParams._dragging = true;
        _bumpCompositeCache();
        var hist = (++_proxyHistFlip & 1) === 0;
        _redrawNow(hist);
    });
}

function _scheduleFullRedraw() {
    if (_fullRafId) cancelAnimationFrame(_fullRafId);
    // V2: mark heavy-op rows (.processing) BEFORE the RAF so the browser
    // gets a chance to paint the indicator state before we hog the main
    // thread with the bilateral filter / dehaze blur. We use double-RAF:
    // first frame paints the .processing class, second frame runs the
    // heavy work and clears it.
    _markHeavyRowsProcessing(true);
    _fullRafId = requestAnimationFrame(function () {
        // Yield once so the .processing paint actually shows
        requestAnimationFrame(function () {
            _fullRafId = 0;
            var S = _S();
            if (S && S.developParams) S.developParams._dragging = false;
            _bumpCompositeCache();
            _redrawNow(true);
            _markHeavyRowsProcessing(false);
        });
    });
}

// Toggle .processing on rows whose key is a heavy op (Dehaze, NR Luma,
// NR Color) AND whose current value is non-default — only those rows are
// actually doing the heavy work that warrants the indicator.
function _markHeavyRowsProcessing(on) {
    var heavyKeys = ["dehaze", "nrLuminance", "nrColor"];
    var S = _S(); var p = S && S.developParams;
    heavyKeys.forEach(function (k) {
        var els = _rowEls[k]; if (!els) return;
        var active = on && p && (p[k] | 0) !== 0;
        els.row.classList.toggle("processing", !!active);
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
    title.dataset.i18n = "develop.title";
    title.textContent = _t("develop.title", "Develop");
    header.appendChild(title);

    // High Precision badge — shown when a float32 sidecar is loaded
    // and matches the current canvas dims. Hidden by default. "HP" stays
    // English (technical abbreviation referenced in guides); the tooltip
    // gets translated.
    _hpBadge = document.createElement("span");
    _hpBadge.className = "develop-hp-badge";
    _hpBadge.textContent = "HP";
    _hpBadge.dataset.i18nTitle = "develop.hpBadge.tooltip";
    _hpBadge.title = _t("develop.hpBadge.tooltip", "High Precision: float32 source pixels active");
    _hpBadge.style.display = "none";
    header.appendChild(_hpBadge);

    _enableToggleEl = document.createElement("button");
    _enableToggleEl.className = "develop-toggle";
    _enableToggleEl.dataset.i18nTitle = "develop.enable.tooltip";
    _enableToggleEl.title = _t("develop.enable.tooltip", "Enable Develop");
    _enableToggleEl.addEventListener("click", function () {
        var S = _S(); if (!S || !S.developParams) return;
        S.developParams.enabled = !S.developParams.enabled;
        _enableToggleEl.classList.toggle("on", !!S.developParams.enabled);
        _scheduleFullRedraw();
    });
    header.appendChild(_enableToggleEl);

    // "B/A" button label stays English — it's a UI shorthand like B/W,
    // not a translatable phrase. Tooltip translates.
    _beforeAfterBtn = document.createElement("button");
    _beforeAfterBtn.className = "develop-header-btn";
    _beforeAfterBtn.textContent = "B/A";
    _beforeAfterBtn.dataset.i18nTitle = "develop.beforeAfter.tooltip";
    _beforeAfterBtn.title = _t("develop.beforeAfter.tooltip", "Before / After split");
    _beforeAfterBtn.addEventListener("click", _toggleBeforeAfter);
    header.appendChild(_beforeAfterBtn);

    var resetBtn = document.createElement("button");
    resetBtn.className = "develop-header-btn";
    resetBtn.dataset.i18n = "develop.reset";
    resetBtn.textContent = _t("develop.reset", "Reset");
    resetBtn.dataset.i18nTitle = "develop.reset.tooltip";
    resetBtn.title = _t("develop.reset.tooltip", "Reset all sliders");
    resetBtn.addEventListener("click", _resetAll);
    header.appendChild(resetBtn);

    _panel.appendChild(header);

    // ---- Body (scrollable) ----
    var body = document.createElement("div");
    body.className = "develop-panel-body";

    // Histogram — RGB only, log scale, with clipping-warning triangles.
    // Toggles for L / linear were removed at the maintainer's request; only
    // the RGB+log view turned out to be useful in practice.
    var histWrap = document.createElement("div");
    histWrap.className = "develop-histogram-wrap";

    // Two clipping triangles (shadow on the left, highlight on the right)
    // sit absolutely on top of the histogram corners and light up colored
    // when channels clip. Hidden by default, .clipping when active.
    _histClipL = document.createElement("button");
    _histClipL.type = "button";
    _histClipL.className = "develop-hist-clip develop-hist-clip-l";
    _histClipL.title = "Shadow clipping — channels at 0";
    _histClipR = document.createElement("button");
    _histClipR.type = "button";
    _histClipR.className = "develop-hist-clip develop-hist-clip-r";
    _histClipR.title = "Highlight clipping — channels at 255";
    histWrap.appendChild(_histClipL);
    histWrap.appendChild(_histClipR);

    _histCanvas = document.createElement("canvas");
    _histCanvas.className = "develop-histogram-canvas";
    _histCanvas.width = 296; _histCanvas.height = 60;
    histWrap.appendChild(_histCanvas);
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
    if (sec.id) s.dataset.section = sec.id;
    var head = document.createElement("div");
    head.className = "develop-section-header";
    var arrow = document.createElement("span");
    arrow.className = "develop-section-arrow"; arrow.textContent = "▾";
    head.appendChild(arrow);
    var name = document.createElement("span");
    var secKey = "develop.section." + sec.id;
    name.dataset.i18n = secKey;
    name.textContent = _t(secKey, sec.label);
    head.appendChild(name);
    head.addEventListener("click", function () { s.classList.toggle("collapsed"); });
    s.appendChild(head);
    var body = document.createElement("div");
    body.className = "develop-section-body";
    if (sec.customBuild) {
        // Custom widget section (Tone Curve, HSL tabs, Color Grading wheels,
        // or — for "Calibrate" — the calibration eyedropper block).
        // The build function attaches its own DOM and registers a sync hook.
        sec.customBuild(body);
    }
    if (sec.rows) {
        sec.rows.forEach(function (row) {
            if (row.divider) {
                var d = document.createElement("div"); d.className = "develop-section-divider";
                body.appendChild(d);
            } else if (row.heading) {
                // Sub-section heading — small label that visually groups the
                // following slider rows. Used by Color Calibration to label
                // the Red/Green/Blue primary groups. data-color (optional)
                // tints the heading in the primary's color. row.i18nKey is
                // an explicit translation key so applyToDom() can re-translate
                // on locale switches; markup English is the fallback.
                var h = document.createElement("div");
                h.className = "develop-section-heading";
                if (row.color) h.dataset.color = row.color;
                if (row.i18nKey) h.dataset.i18n = row.i18nKey;
                h.textContent = row.i18nKey ? _t(row.i18nKey, row.heading) : row.heading;
                body.appendChild(h);
            } else {
                body.appendChild(_buildSliderRow(row));
            }
        });
    }
    s.appendChild(body);
    return s;
}

// ========================================================================
// V2 — Custom widget builders (Tone Curve, HSL, Color Grading)
//
// Each build function receives the section body container and:
//   - Appends its DOM
//   - Registers per-section sync callbacks via _registerCustomSync
//   - Wires its own input handlers that call _scheduleProxyRedraw / Full
// ========================================================================
var _customSyncs = [];
function _registerCustomSync(fn) { _customSyncs.push(fn); }

// ========================================================================
// UNDO / REDO — Develop-owned stack
//
// Develop maintains its own undo/redo stack rather than integrating with
// StudioCore's canvas undo because the core stack is hard-coded to layer
// ImageData snapshots (entries dispatch on type === "pixel" / "region" /
// "structural"). Develop's state is non-destructive params, not pixel
// data, so the cleanest pattern is a parallel stack with hotkey routing
// in canvas-ui (when Develop is the active module, Ctrl+Z hits this
// stack first; falls through to canvas undo otherwise).
//
// Granularity: one entry per commit (slider mouseup, picker pick, curve
// point edit, color grading wheel commit, reset). Drag-time updates
// don't push entries — only the final committed value does. Matches
// Lightroom's behavior.
//
// Snapshot scope: full developParams deep clone. Simple and robust —
// one slider change to a 100-key params object is still cheap to
// snapshot, and downstream sync (syncPanel + custom-widget rebuilds)
// has a single, complete source of truth.
// ========================================================================
var _developUndoStack = [];
var _developRedoStack = [];
var _lastCommittedParams = null;  // baseline for the next recordUndo() call
var DEVELOP_MAX_UNDO = 100;

function _snapshotParams() {
    var p = _S() && _S().developParams;
    return p ? JSON.parse(JSON.stringify(p)) : null;
}

function _paramsEqual(a, b) {
    // JSON-stringify equality is fine — params is a flat-ish object of
    // numbers, short arrays, and booleans. ~100 keys; cost is negligible
    // and only runs on commit, never per-pixel.
    if (a === b) return true;
    if (!a || !b) return false;
    return JSON.stringify(a) === JSON.stringify(b);
}

// recordUndo(label) — call AFTER a commit-level mutation to developParams.
// Diff against the last recorded baseline; if changed, push a new undo
// entry and clear redo. No-op if nothing actually changed (handles the
// "user clicked slider thumb without dragging" case cleanly).
function recordUndo(label) {
    var current = _snapshotParams();
    if (!current) return;
    if (_lastCommittedParams === null) {
        // First call — establish baseline. No undo entry yet (there's
        // no "before" to roll back to).
        _lastCommittedParams = current;
        return;
    }
    if (_paramsEqual(_lastCommittedParams, current)) return;
    _developUndoStack.push({
        before: _lastCommittedParams,
        after:  current,
        label:  label || "Develop"
    });
    if (_developUndoStack.length > DEVELOP_MAX_UNDO) _developUndoStack.shift();
    _developRedoStack = [];
    _lastCommittedParams = current;
}

function canDevelopUndo() { return _developUndoStack.length > 0; }
function canDevelopRedo() { return _developRedoStack.length > 0; }

function developUndo() {
    if (!_developUndoStack.length) return false;
    var entry = _developUndoStack.pop();
    _developRedoStack.push(entry);
    _applyParamsSnapshot(entry.before);
    _lastCommittedParams = _snapshotParams();
    return true;
}

function developRedo() {
    if (!_developRedoStack.length) return false;
    var entry = _developRedoStack.pop();
    _developUndoStack.push(entry);
    _applyParamsSnapshot(entry.after);
    _lastCommittedParams = _snapshotParams();
    return true;
}

// Restore developParams from a snapshot, refresh all slider / curve /
// color-wheel UI from the new state, and trigger a full-resolution
// redraw. syncPanel() handles the DOM sync (covers basic sliders via
// _rowEls plus the V2 custom widgets via _customSyncs).
function _applyParamsSnapshot(snapshot) {
    var S = _S(); if (!S || !snapshot) return;
    S.developParams = JSON.parse(JSON.stringify(snapshot));
    syncPanel();
    _scheduleFullRedraw();
}

function isDevelopPanelVisible() {
    return !!(_panel && _panel.classList.contains("visible"));
}

// Helper: derive a human-readable label for a developParams key. Used
// when commit sites pass undefined and we still want a useful entry
// title in case we later expose history. Keeps labels English for now;
// when Phase 1+ i18n covers this surface we can route through I18N.
function _undoLabelForKey(key) {
    if (!key) return "Develop";
    // Group prefixes: hsl* / cg* / cal* / calib* / tc*
    if (key.indexOf("calib") === 0) return "Develop: Calibration";
    if (key.indexOf("cal") === 0)   return "Develop: Color Calibration";
    if (key.indexOf("hsl") === 0)   return "Develop: HSL";
    if (key.indexOf("cg") === 0)    return "Develop: Color Grading";
    if (key.indexOf("tc") === 0)    return "Develop: Tone Curve";
    if (key === "temperature" || key === "tint")     return "Develop: White Balance";
    if (key === "exposure" || key === "contrast")    return "Develop: " + key[0].toUpperCase() + key.slice(1);
    if (key === "highlights" || key === "shadows" || key === "whites" || key === "blacks")
        return "Develop: Tone";
    if (key === "vibrance" || key === "saturation")  return "Develop: Color";
    if (key === "texture" || key === "clarity" || key === "dehaze") return "Develop: Presence";
    if (key.indexOf("sharpen") === 0 || key.indexOf("nr") === 0)    return "Develop: Detail";
    if (key.indexOf("vignette") === 0 || key.indexOf("grain") === 0) return "Develop: Effects";
    return "Develop: " + key;
}

// Helper: seed the baseline from the current state. Call this once at
// boot (after defaults / migration) and after any external state load
// (preset apply, defaults restore). Without this, the first recordUndo
// after boot wouldn't have a "before" reference.
function _initDevelopUndoBaseline() {
    _lastCommittedParams = _snapshotParams();
    _developUndoStack = [];
    _developRedoStack = [];
}

// Helper: safely set a develop param + bump enabled + schedule a redraw.
// `live=true` schedules proxy (during slider/canvas drag);
// `live=false` schedules full-resolution redraw.
function _commitParam(key, value, live) {
    var S = _S(); if (!S) return;
    if (!S.developParams) S.developParams = defaultParams();
    S.developParams[key] = value;
    if (!S.developParams.enabled) {
        S.developParams.enabled = true;
        if (_enableToggleEl) _enableToggleEl.classList.add("on");
    }
    if (live) {
        _scheduleProxyRedraw();
    } else {
        recordUndo(_undoLabelForKey(key));
        _scheduleFullRedraw();
    }
}

// ────────────────────────────────────────────────────────────────────────
// V2 — TONE CURVE UI
//
// Point mode only — interactive curve editor canvas with per-channel
// (RGB / R / G / B) selector below. Parametric mode (region sliders +
// split markers) was retired; legacy parametric docs are migrated to
// Point on load.
// ────────────────────────────────────────────────────────────────────────
var _tcPointWrap = null;
var _tcCurveCanvas = null;
var _tcChannelBtns = null;

// Curve canvas pointer-state for the debounced add/move/remove pattern.
var _tcDragging = false;
var _tcHitIdx = null;
var _tcDownAt = null;     // {cx, cy, x, y}
// Drag-state for grab-offset + drag-away-to-delete behaviour.
var _tcGrabOff = null;    // {dx, dy} — offset from cursor to point centre at pointerdown
var _tcOrigPoint = null;  // [x, y] — original coords, used for re-insertion
var _tcOrigIdx = null;    // original index in the points array (for re-insert)
var _tcRemoved = false;   // true while the point is temporarily detached
// Currently-selected interior point index (for Delete/Backspace removal).
// Endpoints (0 and last) are never selectable. null = nothing selected.
var _tcSelectedIdx = null;
// Number of pixels the cursor must move beyond the canvas bounds before a
// drag detaches the point (drag-away-to-delete behaviour).
var _TC_DETACH_PX = 15;

function _tcCurrentChannel() {
    var S = _S(); return (S && S.developParams && S.developParams.tcChannel) || "rgb";
}
function _tcActivePoints() {
    var S = _S(); var p = S && S.developParams; if (!p) return [[0, 0], [255, 255]];
    // Lazy-init the per-channel arrays if missing — covers the case where
    // a V1 doc made it past syncPanel migration (e.g., panel opened mid-load).
    if (!p.tcPoints)  p.tcPoints  = [[0, 0], [255, 255]];
    if (!p.tcPointsR) p.tcPointsR = [[0, 0], [255, 255]];
    if (!p.tcPointsG) p.tcPointsG = [[0, 0], [255, 255]];
    if (!p.tcPointsB) p.tcPointsB = [[0, 0], [255, 255]];
    var ch = p.tcChannel || "rgb";
    if (ch === "r") return p.tcPointsR;
    if (ch === "g") return p.tcPointsG;
    if (ch === "b") return p.tcPointsB;
    return p.tcPoints;
}
function _tcSetActivePoints(pts) {
    var S = _S(); var p = S && S.developParams; if (!p) return;
    var ch = p.tcChannel || "rgb";
    if (ch === "r") p.tcPointsR = pts;
    else if (ch === "g") p.tcPointsG = pts;
    else if (ch === "b") p.tcPointsB = pts;
    else p.tcPoints = pts;
    // Curve-canvas mutations bypass _commitParam, so flip the enabled flag
    // here. Without this the pipeline early-outs at _isIdentity and the
    // edit appears to do nothing — most visibly for the RGB channel,
    // because the per-channel R/G/B tab-click already enables via
    // _commitParam("tcChannel", …) as a side effect.
    if (!p.enabled) {
        p.enabled = true;
        if (_enableToggleEl) _enableToggleEl.classList.add("on");
    }
}

function _buildToneCurveSection(body) {
    // Point mode only — Parametric was retired in favor of the
    // single, more direct "drag points on the graph" interaction.
    // Legacy docs with toneCurveMode="parametric" get migrated in
    // _migrateParams; the parametric data fields stay in the schema
    // for backwards compatibility but are no longer surfaced or read.
    _tcPointWrap = document.createElement("div");
    _tcPointWrap.className = "develop-tc-point-wrap";
    _tcCurveCanvas = document.createElement("canvas");
    _tcCurveCanvas.className = "develop-tone-curve-canvas";
    _tcCurveCanvas.width = 296; _tcCurveCanvas.height = 180;
    _tcPointWrap.appendChild(_tcCurveCanvas);
    _tcAttachCurveHandlers();
    // Channel selector
    var chRow = document.createElement("div");
    chRow.className = "develop-tc-channel-row";
    _tcChannelBtns = {};
    ["rgb", "r", "g", "b"].forEach(function (c) {
        var b = document.createElement("button");
        b.type = "button"; b.textContent = c.toUpperCase(); b.dataset.channel = c;
        b.className = "develop-tc-channel-btn develop-tc-channel-" + c;
        b.addEventListener("click", function () {
            _commitParam("tcChannel", c, false);
            _tcSelectedIdx = null;
            _tcSyncChannelUI(c);
            _tcRedrawCurve();
        });
        chRow.appendChild(b);
        _tcChannelBtns[c] = b;
    });
    _tcPointWrap.appendChild(chRow);
    body.appendChild(_tcPointWrap);

    _registerCustomSync(function (p) {
        _tcSyncChannelUI(p.tcChannel || "rgb");
        _tcRedrawCurve();
    });
}

function _tcSyncChannelUI(ch) {
    if (!_tcChannelBtns) return;
    Object.keys(_tcChannelBtns).forEach(function (k) {
        _tcChannelBtns[k].classList.toggle("active", k === ch);
    });
}

// Convert canvas pixel coords ↔ tonal coords (0..255 in both axes).
function _tcCanvasToCurve(cx, cy) {
    var w = _tcCurveCanvas.width, h = _tcCurveCanvas.height;
    var x = Math.round(cx / w * 255);
    var y = Math.round((1 - cy / h) * 255);
    if (x < 0) x = 0; else if (x > 255) x = 255;
    if (y < 0) y = 0; else if (y > 255) y = 255;
    return { x: x, y: y };
}
function _tcCurveToCanvas(x, y) {
    var w = _tcCurveCanvas.width, h = _tcCurveCanvas.height;
    return { cx: x / 255 * w, cy: (1 - y / 255) * h };
}
function _tcHitTest(cx, cy) {
    var pts = _tcActivePoints();
    for (var i = 0; i < pts.length; i++) {
        var p = _tcCurveToCanvas(pts[i][0], pts[i][1]);
        if (Math.hypot(p.cx - cx, p.cy - cy) <= 7) return i;
    }
    return null;
}

function _tcAttachCurveHandlers() {
    var c = _tcCurveCanvas;
    // Make the curve canvas keyboard-focusable so it can receive
    // keydown for Delete/Backspace point removal.
    if (!c.hasAttribute("tabindex")) c.tabIndex = 0;
    c.style.outline = "none";
    c.addEventListener("pointerdown", function (e) {
        var rect = c.getBoundingClientRect();
        var cx = e.clientX - rect.left, cy = e.clientY - rect.top;
        _tcHitIdx = _tcHitTest(cx, cy);
        _tcDownAt = { cx: cx, cy: cy };
        _tcDragging = false;
        _tcRemoved = false;
        _tcOrigIdx = _tcHitIdx;
        if (_tcHitIdx !== null) {
            var ptsDown = _tcActivePoints();
            var hp = ptsDown[_tcHitIdx];
            var hpC = _tcCurveToCanvas(hp[0], hp[1]);
            // Offset from cursor to the actual point — preserved through
            // the drag so the point doesn't snap to the cursor's centre.
            _tcGrabOff = { dx: hpC.cx - cx, dy: hpC.cy - cy };
            _tcOrigPoint = [hp[0], hp[1]];
        } else {
            _tcGrabOff = null;
            _tcOrigPoint = null;
        }
        // Selection: clicking a point selects it (interior only). Clicking
        // empty area clears selection. Confirmed on pointerup (so a drag
        // doesn't double-trigger selection logic).
        c.focus({ preventScroll: true });
        c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointermove", function (e) {
        if (_tcDownAt === null) return;
        var rect = c.getBoundingClientRect();
        var cx = e.clientX - rect.left, cy = e.clientY - rect.top;
        if (Math.hypot(cx - _tcDownAt.cx, cy - _tcDownAt.cy) > 3) _tcDragging = true;
        if (_tcDragging && _tcHitIdx !== null) {
            var pts = _tcActivePoints().slice();
            var canRemove = _tcOrigIdx !== null && _tcOrigIdx > 0
                         && _tcOrigPoint !== null
                         && (_tcRemoved || _tcOrigIdx < pts.length - 1);
            var outOfBounds = cx < -_TC_DETACH_PX || cx > c.width + _TC_DETACH_PX
                           || cy < -_TC_DETACH_PX || cy > c.height + _TC_DETACH_PX;

            if (canRemove && outOfBounds && !_tcRemoved) {
                // Detach: temporarily remove this point. If the cursor comes
                // back inside before pointerup it's re-inserted at the
                // original position; otherwise the deletion is committed.
                pts.splice(_tcHitIdx, 1);
                _tcRemoved = true;
                _tcSetActivePoints(pts);
                _tcRedrawCurve();
                _scheduleProxyRedraw();
                return;
            }
            if (canRemove && !outOfBounds && _tcRemoved) {
                // Re-insert at the original index/position; resume dragging.
                pts.splice(_tcOrigIdx, 0, [_tcOrigPoint[0], _tcOrigPoint[1]]);
                _tcRemoved = false;
                _tcHitIdx = _tcOrigIdx;
                _tcSetActivePoints(pts);
            }
            if (_tcRemoved) return;     // detached — don't update position

            // Apply the grab offset so the point tracks the cursor without
            // snapping to its centre.
            var adjCx = cx + (_tcGrabOff ? _tcGrabOff.dx : 0);
            var adjCy = cy + (_tcGrabOff ? _tcGrabOff.dy : 0);
            var pt = _tcCanvasToCurve(adjCx, adjCy);
            // Endpoints can move vertically only (x stays at 0 or 255).
            if (_tcHitIdx === 0) pt.x = 0;
            else if (_tcHitIdx === pts.length - 1) pt.x = 255;
            else {
                // Interior points: clamp horizontally so they can't cross
                // their neighbours — prevents curve self-intersection.
                var leftX  = pts[_tcHitIdx - 1][0] + 1;
                var rightX = pts[_tcHitIdx + 1][0] - 1;
                if (pt.x < leftX)  pt.x = leftX;
                if (pt.x > rightX) pt.x = rightX;
            }
            pts[_tcHitIdx] = [pt.x, pt.y];
            _tcSetActivePoints(pts);
            _tcRedrawCurve();
            _scheduleProxyRedraw();
        }
    });
    c.addEventListener("pointerup", function (e) {
        try { c.releasePointerCapture(e.pointerId); } catch (_) {}
        if (!_tcDragging && _tcHitIdx === null && _tcDownAt) {
            // Click on empty area → add new point + clear selection
            var pt = _tcCanvasToCurve(_tcDownAt.cx, _tcDownAt.cy);
            var pts = _tcActivePoints().slice();
            // Insert keeping x-sorted, dodge the endpoints
            if (pt.x <= 0) pt.x = 1;
            if (pt.x >= 255) pt.x = 254;
            var insertAt = pts.length - 1;
            for (var i = 1; i < pts.length; i++) {
                if (pts[i][0] >= pt.x) { insertAt = i; break; }
            }
            // Refuse if too close to an existing x
            if (Math.abs(pts[insertAt][0] - pt.x) < 2) { _tcSelectedIdx = null; _tcRedrawCurve(); _tcResetDrag(); return; }
            pts.splice(insertAt, 0, [pt.x, pt.y]);
            _tcSetActivePoints(pts);
            _tcSelectedIdx = null;
            _tcRedrawCurve();
            recordUndo("Develop: Tone Curve");
            _scheduleFullRedraw();
        } else if (!_tcDragging && _tcHitIdx !== null) {
            // Click (no drag) on existing point → select if interior, else clear
            var ptsSel = _tcActivePoints();
            if (_tcHitIdx > 0 && _tcHitIdx < ptsSel.length - 1) {
                _tcSelectedIdx = _tcHitIdx;
            } else {
                _tcSelectedIdx = null;
            }
            _tcRedrawCurve();
        } else if (_tcDragging) {
            // Drag-away-to-delete: if the point ended up detached, the
            // splice already removed it from the points array — just
            // commit and clear selection.
            if (_tcRemoved) {
                _tcSelectedIdx = null;
                _tcRedrawCurve();
            }
            recordUndo("Develop: Tone Curve");
            _scheduleFullRedraw();
        }
        _tcResetDrag();
    });
    c.addEventListener("dblclick", function (e) {
        var rect = c.getBoundingClientRect();
        var idx = _tcHitTest(e.clientX - rect.left, e.clientY - rect.top);
        if (idx === null) return;
        var pts = _tcActivePoints();
        if (idx === 0 || idx === pts.length - 1) return;     // endpoints are fixed
        var newPts = pts.slice(); newPts.splice(idx, 1);
        _tcSetActivePoints(newPts);
        if (_tcSelectedIdx === idx) _tcSelectedIdx = null;
        else if (_tcSelectedIdx !== null && _tcSelectedIdx > idx) _tcSelectedIdx -= 1;
        _tcRedrawCurve();
        recordUndo("Develop: Tone Curve");
        _scheduleFullRedraw();
    });
    c.addEventListener("keydown", function (e) {
        if (e.key !== "Delete" && e.key !== "Backspace") return;
        if (_tcSelectedIdx === null) return;
        var pts = _tcActivePoints();
        if (_tcSelectedIdx <= 0 || _tcSelectedIdx >= pts.length - 1) {
            _tcSelectedIdx = null; _tcRedrawCurve(); return;
        }
        var newPts = pts.slice(); newPts.splice(_tcSelectedIdx, 1);
        _tcSetActivePoints(newPts);
        _tcSelectedIdx = null;
        _tcRedrawCurve();
        recordUndo("Develop: Tone Curve");
        _scheduleFullRedraw();
        e.preventDefault();
    });
}
function _tcResetDrag() {
    _tcDragging = false;
    _tcHitIdx = null;
    _tcDownAt = null;
    _tcGrabOff = null;
    _tcOrigPoint = null;
    _tcOrigIdx = null;
    _tcRemoved = false;
}

function _tcRedrawCurve() {
    if (!_tcCurveCanvas) return;
    var ctx = _tcCurveCanvas.getContext("2d", { colorSpace: "srgb" });
    var w = _tcCurveCanvas.width, h = _tcCurveCanvas.height;
    ctx.clearRect(0, 0, w, h);
    // Background grid (4×4)
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (var i = 1; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(i * w / 4, 0); ctx.lineTo(i * w / 4, h);
        ctx.moveTo(0, i * h / 4); ctx.lineTo(w, i * h / 4);
        ctx.stroke();
    }
    // 45° identity diagonal
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(w, 0); ctx.stroke();
    // The curve itself — sample the LUT for the active channel
    var ch = _tcCurrentChannel();
    var p = _S() && _S().developParams;
    var lut;
    if (p) {
        var savedMode = p.toneCurveMode, savedCh = p.tcChannel;
        p.toneCurveMode = "point"; p.tcChannel = ch;
        var c = _getToneCurveLuts(p);
        if (c.mode === "point-perchan") {
            lut = ch === "r" ? c.lutR : ch === "g" ? c.lutG : c.lutB;
        } else {
            lut = c.lut;
        }
        p.toneCurveMode = savedMode; p.tcChannel = savedCh;
    }
    if (!lut) {
        var idLut = new Float32Array(4096);
        for (var ii = 0; ii < 4096; ii++) idLut[ii] = ii / 4095;
        lut = idLut;
    }
    ctx.strokeStyle = ch === "r" ? "#e24b4a" : ch === "g" ? "#5dca85" : ch === "b" ? "#5da3e2" : "#fff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    // LUT now stores 4096 float entries in [0, 1] indexed across input
    // x ∈ [0, 255]. Sample 256 evenly spaced points and rescale y to U8
    // for canvas drawing.
    for (var x = 0; x < 256; x++) {
        var idx = ((x * 4095) / 255 + 0.5) | 0;
        if (idx > 4095) idx = 4095;
        var pos = _tcCurveToCanvas(x, lut[idx] * 255);
        if (x === 0) ctx.moveTo(pos.cx, pos.cy);
        else ctx.lineTo(pos.cx, pos.cy);
    }
    ctx.stroke();
    // Control points — selected interior point gets a larger filled accent
    // dot with an outer ring; everything else is a plain white dot.
    var pts = _tcActivePoints();
    var accentCol = (getComputedStyle(document.documentElement).getPropertyValue("--accent") || "#7c3aed").trim();
    for (var k = 0; k < pts.length; k++) {
        var pp = _tcCurveToCanvas(pts[k][0], pts[k][1]);
        var isSel = (k === _tcSelectedIdx) && k > 0 && k < pts.length - 1;
        ctx.beginPath();
        ctx.arc(pp.cx, pp.cy, isSel ? 5 : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = isSel ? accentCol : "#fff";
        ctx.strokeStyle = isSel ? "#fff" : "rgba(0,0,0,0.6)";
        ctx.lineWidth = isSel ? 1.5 : 1;
        ctx.fill(); ctx.stroke();
    }
}

// ────────────────────────────────────────────────────────────────────────
// V2 — HSL / Color Mixer UI (3 tabs × 8 band sliders)
// ────────────────────────────────────────────────────────────────────────
var _hslTabBtns = null;
var _hslBandRows = { hue: [], sat: [], lum: [] };

var _HSL_BAND_NAMES  = ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"];
var _HSL_BAND_HEX = ["#e25052", "#e28e3e", "#dac042", "#56c66f", "#4ec0c0", "#5da3e2", "#9d6dde", "#d96fb7"];

function _buildHSLSection(body) {
    var tabRow = document.createElement("div");
    tabRow.className = "develop-hsl-tabs";
    _hslTabBtns = {};
    ["hue", "sat", "lum"].forEach(function (mode) {
        var b = document.createElement("button");
        b.type = "button";
        var enLabel = mode === "hue" ? "Hue" : mode === "sat" ? "Saturation" : "Luminance";
        var key = "develop.hsl." + mode;
        b.dataset.i18n = key;
        b.textContent = _t(key, enLabel);
        b.dataset.mode = mode;
        b.addEventListener("click", function () {
            _commitParam("hslMode", mode, false);
            _hslSyncModeUI(mode);
        });
        tabRow.appendChild(b);
        _hslTabBtns[mode] = b;
    });
    body.appendChild(tabRow);

    ["hue", "sat", "lum"].forEach(function (mode) {
        var wrap = document.createElement("div");
        wrap.className = "develop-hsl-tab-body develop-hsl-tab-" + mode;
        var min = mode === "hue" ? -30 : -100;
        var max = mode === "hue" ?  30 :  100;
        for (var k = 0; k < 8; k++) {
            var bandIdx = k;
            var row = document.createElement("div");
            row.className = "develop-row develop-hsl-row";
            // Color swatch as label prefix
            var swatch = document.createElement("span");
            swatch.className = "develop-hsl-band-swatch";
            swatch.style.background = _HSL_BAND_HEX[k];
            row.appendChild(swatch);
            var lbl = document.createElement("span");
            lbl.className = "develop-row-label";
            // i18n: each band gets its own key (develop.hsl.band.red etc.)
            // so applyToDom can translate on locale switch.
            var bandKey = "develop.hsl.band." + _HSL_BAND_NAMES[k].toLowerCase();
            lbl.dataset.i18n = bandKey;
            lbl.textContent = _t(bandKey, _HSL_BAND_NAMES[k]);
            lbl.dataset.i18nTitle = "develop.slider.resetHint";
            lbl.title = _t("develop.slider.resetHint", "Double-click to reset");
            row.appendChild(lbl);
            var range = document.createElement("input");
            range.type = "range"; range.min = min; range.max = max; range.step = 1; range.value = 0;
            row.appendChild(range);
            var num = document.createElement("input");
            num.type = "number"; num.min = min; num.max = max; num.step = 1; num.value = 0;
            row.appendChild(num);
            (function (m, idx, rangeEl, numEl) {
                function commit(v, live) {
                    v = Number(v); if (isNaN(v)) v = 0;
                    if (v < min) v = min; if (v > max) v = max;
                    var S = _S(); if (!S) return;
                    if (!S.developParams) S.developParams = defaultParams();
                    // Lazy-init the bands array if missing (V1 docs predate V2).
                    var key = m === "hue" ? "hslHue" : m === "sat" ? "hslSat" : "hslLum";
                    if (!S.developParams[key]) S.developParams[key] = [0, 0, 0, 0, 0, 0, 0, 0];
                    var arr = S.developParams[key];
                    arr[idx] = v;
                    rangeEl.value = v; numEl.value = v;
                    if (!S.developParams.enabled) {
                        S.developParams.enabled = true;
                        if (_enableToggleEl) _enableToggleEl.classList.add("on");
                    }
                    if (live) {
                        _scheduleProxyRedraw();
                    } else {
                        recordUndo("Develop: HSL");
                        _scheduleFullRedraw();
                    }
                }
                rangeEl.addEventListener("input",  function () { commit(rangeEl.value, true); });
                rangeEl.addEventListener("change", function () { commit(rangeEl.value, false); });
                numEl.addEventListener("change",   function () { commit(numEl.value, false); });
                numEl.addEventListener("input",    function () { commit(numEl.value, true); });
                lbl.addEventListener("dblclick", function () { commit(0, false); });
            })(mode, bandIdx, range, num);
            wrap.appendChild(row);
            _hslBandRows[mode][k] = { range: range, num: num };
        }
        body.appendChild(wrap);
    });

    _registerCustomSync(function (p) {
        _hslSyncModeUI(p.hslMode || "hue");
        ["hue", "sat", "lum"].forEach(function (m) {
            var arr = m === "hue" ? p.hslHue : m === "sat" ? p.hslSat : p.hslLum;
            for (var k = 0; k < 8; k++) {
                var v = (arr && arr[k]) || 0;
                var els = _hslBandRows[m][k];
                if (els) { els.range.value = v; els.num.value = v; }
            }
        });
    });
}
function _hslSyncModeUI(mode) {
    if (!_hslTabBtns) return;
    Object.keys(_hslTabBtns).forEach(function (k) {
        _hslTabBtns[k].classList.toggle("active", k === mode);
    });
    if (!_panel) return;
    var bodies = _panel.querySelectorAll(".develop-hsl-tab-body");
    bodies.forEach(function (el) {
        el.style.display = el.classList.contains("develop-hsl-tab-" + mode) ? "" : "none";
    });
}

// ────────────────────────────────────────────────────────────────────────
// V2 — COLOR GRADING UI (4 wheels in a 2×2 grid + Blending/Balance)
// ────────────────────────────────────────────────────────────────────────
var _cgWheels = {};
var _cgLumRows = {};

function _buildColorWheel(container, regionPrefix, label, i18nKey) {
    var wrap = document.createElement("div");
    wrap.className = "develop-cg-wheel-wrap";
    var caption = document.createElement("div");
    caption.className = "develop-cg-wheel-label";
    if (i18nKey) {
        caption.dataset.i18n = i18nKey;
        caption.textContent = _t(i18nKey, label);
    } else {
        caption.textContent = label;
    }
    wrap.appendChild(caption);
    var canvas = document.createElement("canvas");
    canvas.className = "develop-cg-wheel";
    canvas.width = 70; canvas.height = 70;
    wrap.appendChild(canvas);
    // L slider underneath
    var lumRow = document.createElement("div");
    lumRow.className = "develop-cg-lum";
    var lumRange = document.createElement("input");
    lumRange.type = "range"; lumRange.min = -100; lumRange.max = 100; lumRange.step = 1; lumRange.value = 0;
    var lumNum = document.createElement("input");
    lumNum.type = "number"; lumNum.min = -100; lumNum.max = 100; lumNum.step = 1; lumNum.value = 0;
    lumRow.appendChild(lumRange); lumRow.appendChild(lumNum);
    wrap.appendChild(lumRow);
    container.appendChild(wrap);

    function drawWheel() {
        var ctx = canvas.getContext("2d", { colorSpace: "srgb" });
        var w = canvas.width, h = canvas.height;
        var cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 1;
        ctx.clearRect(0, 0, w, h);
        // Conic-ish hue ring with sat fade toward center: draw per-degree wedges
        for (var deg = 0; deg < 360; deg++) {
            var a0 = (deg - 0.6) * Math.PI / 180, a1 = (deg + 0.6) * Math.PI / 180;
            var hueRgb = _hsl2rgb(deg, 1, 0.5);
            var grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
            grad.addColorStop(0, "rgb(128,128,128)");
            grad.addColorStop(1, "rgb(" + ((hueRgb.r * 255) | 0) + "," + ((hueRgb.g * 255) | 0) + "," + ((hueRgb.b * 255) | 0) + ")");
            ctx.fillStyle = grad;
            ctx.beginPath(); ctx.moveTo(cx, cy);
            ctx.arc(cx, cy, r, a0, a1); ctx.closePath(); ctx.fill();
        }
        // Indicator dot
        var p = _S() && _S().developParams;
        var H = (p && p[regionPrefix + "H"]) || 0;
        var S = ((p && p[regionPrefix + "S"]) || 0) / 100;
        var hr = H * Math.PI / 180;
        var ix = cx + Math.cos(hr) * r * S;
        var iy = cy + Math.sin(hr) * r * S;
        ctx.fillStyle = "#fff"; ctx.strokeStyle = "rgba(0,0,0,0.7)"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(ix, iy, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    function commit(H, S, live) {
        _commitParam(regionPrefix + "H", Math.round(H), live);
        var p = _S() && _S().developParams;
        if (p) p[regionPrefix + "S"] = Math.round(S);
        drawWheel();
    }
    function pointerToHS(e) {
        var rect = canvas.getBoundingClientRect();
        var cxLoc = canvas.width / 2, cyLoc = canvas.height / 2;
        var r = Math.min(canvas.width, canvas.height) / 2 - 1;
        var dx = (e.clientX - rect.left) - cxLoc;
        var dy = (e.clientY - rect.top) - cyLoc;
        var dist = Math.hypot(dx, dy);
        var H = Math.atan2(dy, dx) * 180 / Math.PI; if (H < 0) H += 360;
        var S = Math.min(1, dist / r) * 100;
        return { h: H, s: S };
    }
    var dragging = false;
    canvas.addEventListener("pointerdown", function (e) {
        dragging = true; canvas.setPointerCapture(e.pointerId);
        var hs = pointerToHS(e); commit(hs.h, hs.s, true);
    });
    canvas.addEventListener("pointermove", function (e) {
        if (!dragging) return;
        var hs = pointerToHS(e); commit(hs.h, hs.s, true);
    });
    canvas.addEventListener("pointerup", function (e) {
        try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
        if (dragging) {
            dragging = false;
            recordUndo("Develop: Color Grading");
            _scheduleFullRedraw();
        }
    });
    canvas.addEventListener("dblclick", function () {
        commit(0, 0, false); _scheduleFullRedraw();
    });
    function commitL(v, live) {
        v = Number(v); if (isNaN(v)) v = 0;
        if (v < -100) v = -100; if (v > 100) v = 100;
        _commitParam(regionPrefix + "L", v, live);
        lumRange.value = v; lumNum.value = v;
    }
    lumRange.addEventListener("input",  function () { commitL(lumRange.value, true); });
    lumRange.addEventListener("change", function () { commitL(lumRange.value, false); });
    lumNum.addEventListener("change",   function () { commitL(lumNum.value, false); });

    _cgWheels[regionPrefix] = { draw: drawWheel };
    _cgLumRows[regionPrefix] = { range: lumRange, num: lumNum };
    drawWheel();
}

function _buildColorGradingSection(body) {
    var grid = document.createElement("div");
    grid.className = "develop-cg-grid";
    body.appendChild(grid);
    _buildColorWheel(grid, "cgShadow",    "Shadows",    "develop.cg.shadows");
    _buildColorWheel(grid, "cgMidtone",   "Midtones",   "develop.cg.midtones");
    _buildColorWheel(grid, "cgHighlight", "Highlights", "develop.cg.highlights");
    _buildColorWheel(grid, "cgGlobal",    "Global",     "develop.cg.global");
    body.appendChild(_buildSliderRow({ key: "cgBlending", label: "Blending", min: 0,    max: 100, step: 1, def: 50 }));
    body.appendChild(_buildSliderRow({ key: "cgBalance",  label: "Balance",  min: -100, max: 100, step: 1, def: 0  }));

    _registerCustomSync(function (p) {
        Object.keys(_cgWheels).forEach(function (k) { _cgWheels[k].draw(); });
        Object.keys(_cgLumRows).forEach(function (k) {
            var v = (p && p[k + "L"]) || 0;
            _cgLumRows[k].range.value = v; _cgLumRows[k].num.value = v;
        });
    });
}

// Map an eyedropper mode to the developParams keys it calibrates. Used to
// detect "this row currently has a non-default calibration" and to clear it.
// Map an eyedropper mode to the developParams keys the picker writes.
// White-point and Black-point are calibration fields (true remap).
// White-balance is special: the picker writes the Temperature and Tint
// sliders directly, since WB is treated as an adjustment rather than a
// stored calibration. _calibIsActive / _clearCalib treat it accordingly.
var _CALIB_KEYS = {
    wb:     ["temperature", "tint"],
    blacks: ["calibBlackLin"],
    whites: ["calibWhiteLin"]
};

// ========================================================================
// CALIBRATION BLOCK — dedicated WB / White / Black eyedroppers shown at
// the top of the "Calibrate" section. These are calibration pickers (true
// remap), independent of the Temperature / Whites / Blacks sliders below
// them. Each row: pick button + label + active-state badge + clear button
// (the last is shown only while a calibration is active).
// ========================================================================
var _calibBlockEls = {};

function _buildCalibrationBlock(body) {
    var wrap = document.createElement("div");
    wrap.className = "develop-calib-block";
    body.appendChild(wrap);

    function row(mode, labelKey, labelEn, tooltipKey, tooltipEn, clearKey, clearEn) {
        var r = document.createElement("div");
        r.className = "develop-calib-row";
        r.dataset.mode = mode;

        var pick = document.createElement("button");
        pick.type = "button";
        pick.className = "develop-eyedrop develop-calib-pick";
        // Compose pick-tooltip: per-row description + the "Click to pick…"
        // suffix. Keep them as separate keys so the suffix translates once
        // and reads naturally instead of being duplicated three times.
        pick.dataset.i18nTitle = tooltipKey;
        var pickSuffix = _t("develop.pick.suffix",
            "\nClick to pick, then click the image. Shift-click to clear.");
        pick.title = _t(tooltipKey, tooltipEn) + pickSuffix;
        pick.innerHTML =
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
            ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M3 21v-3l9-9 3 3-9 9H3z"/><circle cx="19" cy="5" r="3"/></svg>';
        pick.addEventListener("click", function (e) {
            e.preventDefault(); e.stopPropagation();
            if (e.shiftKey || e.altKey || e.metaKey) {
                if (!_clearCalib(mode) && _pickMode === mode) _exitPickMode();
                return;
            }
            _enterPickMode(mode, pick);
        });
        pick.addEventListener("contextmenu", function (e) {
            e.preventDefault(); e.stopPropagation();
            _clearCalib(mode);
        });
        r.appendChild(pick);

        var lbl = document.createElement("span");
        lbl.className = "develop-calib-label";
        lbl.dataset.i18n = labelKey;
        lbl.textContent = _t(labelKey, labelEn);
        r.appendChild(lbl);

        var status = document.createElement("span");
        status.className = "develop-calib-status";
        status.textContent = "—";
        status.dataset.i18nTitle = "develop.calib.statusNone";
        status.title = _t("develop.calib.statusNone", "No calibration set");
        r.appendChild(status);

        var clear = document.createElement("button");
        clear.type = "button";
        clear.className = "develop-calib-clear";
        clear.dataset.i18nTitle = clearKey;
        clear.title = _t(clearKey, clearEn);
        clear.textContent = "×";
        clear.addEventListener("click", function (e) {
            e.preventDefault(); e.stopPropagation();
            _clearCalib(mode);
        });
        r.appendChild(clear);

        wrap.appendChild(r);
        _calibBlockEls[mode] = { row: r, pick: pick, status: status, clear: clear };
    }

    row("wb",
        "develop.calib.wb",          "White Balance",
        "develop.pick.wb.tooltip",   "White balance — pick a neutral pixel that should render as gray",
        "develop.calib.wb.clear",    "Clear white balance calibration");
    row("whites",
        "develop.calib.whitePoint",         "White Point",
        "develop.pick.whitePoint.tooltip",  "White point — pick the brightest pixel that should render as pure white",
        "develop.calib.whitePoint.clear",   "Clear white point calibration");
    row("blacks",
        "develop.calib.blackPoint",         "Black Point",
        "develop.pick.blackPoint.tooltip",  "Black point — pick the darkest pixel that should render as pure black",
        "develop.calib.blackPoint.clear",   "Clear black point calibration");

    _registerCustomSync(_syncCalibrationBlock);
}

function _syncCalibrationBlock(p) {
    if (!p) return;
    Object.keys(_calibBlockEls).forEach(function (mode) {
        var el = _calibBlockEls[mode];
        if (!el) return;
        var active = _calibIsActive(p, mode);
        el.row.classList.toggle("calibrated", active);
        el.pick.classList.toggle("calibrated", active);
        el.status.textContent = active ? "set" : "—";
        el.status.title = active ? "Calibration set — click × to clear" : "No calibration set";
    });
}
function _calibIsActive(p, mode) {
    if (!p || !mode) return false;
    var keys = _CALIB_KEYS[mode]; if (!keys) return false;
    var defs = defaultParams();
    for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (Math.abs((p[k] || 0) - (defs[k] || 0)) > 1e-6) return true;
    }
    return false;
}
function _clearCalib(mode) {
    var S = _S(); if (!S || !S.developParams) return false;
    var keys = _CALIB_KEYS[mode]; if (!keys) return false;
    var defs = defaultParams();
    var changed = false;
    for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (S.developParams[k] !== defs[k]) { S.developParams[k] = defs[k]; changed = true; }
    }
    if (changed) {
        syncPanel();
        _bumpCompositeCache();
        recordUndo("Develop: Clear " + mode);
        _scheduleFullRedraw();
    }
    return changed;
}

function _buildSliderRow(field) {
    var row = document.createElement("div");
    row.className = "develop-row";
    row.dataset.key = field.key;
    if (field.track) row.dataset.track = field.track;

    var lbl = document.createElement("span");
    lbl.className = "develop-row-label";
    var labelKey = "develop.slider." + field.key;
    lbl.dataset.i18n = labelKey;
    lbl.textContent = _t(labelKey, field.label);
    lbl.dataset.i18nTitle = "develop.slider.resetHint";
    lbl.title = _t("develop.slider.resetHint", "Double-click to reset");
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
        // Keep the WB calibration row's "set" badge in sync when the user
        // drags Temperature or Tint directly — those are the WB picker's
        // backing fields. Cheap (3 DOM nodes), safe to call on every commit.
        if (field.key === "temperature" || field.key === "tint") {
            _syncCalibrationBlock(S.developParams);
        }
        if (isDrag) {
            _scheduleProxyRedraw();
        } else {
            recordUndo(_undoLabelForKey(field.key));
            _scheduleFullRedraw();
        }
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
    // Run migration HERE (not just inside applyToContext): the panel reads
    // and the UI handlers WRITE V2 fields (tcPoints, hslHue, etc.) before
    // the pipeline ever runs. Without this, a V1 doc loaded from disk has
    // tcPoints/hslHue as undefined, and the first click on the curve
    // canvas crashes silently inside _tcHitTest (undefined.length), and
    // HSL slider commits crash on `arr[idx] = v`.
    _migrateParams(p);
    if (_enableToggleEl) _enableToggleEl.classList.toggle("on", !!p.enabled);
    Object.keys(_rowEls).forEach(function (key) {
        var el = _rowEls[key];
        var v = p[key];
        if (v === undefined || v === null) v = el.def;
        el.range.value = v;
        el.num.value = v;
        el.row.classList.toggle("modified", v !== el.def);
    });
    // V2: sync custom widget sections (Tone Curve, HSL, Color Grading)
    for (var ci = 0; ci < _customSyncs.length; ci++) {
        try { _customSyncs[ci](p); } catch (e) { console.error("[Develop] custom sync:", e); }
    }
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
    var hctx = _histCanvas.getContext("2d", { colorSpace: "srgb" });
    var W = _histCanvas.width, H = _histCanvas.height;
    hctx.clearRect(0, 0, W, H);

    // Sample the displayed canvas — already includes Develop output.
    var src = S.canvas;
    var sw = src.width, sh = src.height;
    if (!sw || !sh) return;
    var sctx;
    try { sctx = src.getContext("2d", { colorSpace: "srgb" }); } catch (e) { return; }
    // Compute the image's rect inside the display canvas so we can ignore
    // the surrounding "void" padding that the display canvas paints. Inside
    // the image rect, alpha=0 pixels count as bin 0 (the user sees them
    // against the dark backdrop and expects the histogram to reflect that);
    // outside the image rect, padding pixels are excluded entirely.
    var z = S.zoom || { scale: 1, ox: 0, oy: 0 };
    var rx0 = Math.max(0, Math.floor(z.ox));
    var ry0 = Math.max(0, Math.floor(z.oy));
    var rx1 = Math.min(sw, Math.ceil(z.ox + S.W * z.scale));
    var ry1 = Math.min(sh, Math.ceil(z.oy + S.H * z.scale));
    if (rx1 <= rx0 || ry1 <= ry0) { rx0 = 0; ry0 = 0; rx1 = sw; ry1 = sh; }
    var rw = rx1 - rx0, rh = ry1 - ry0;
    var sample;
    try { sample = sctx.getImageData(rx0, ry0, rw, rh); } catch (e) { return; }
    var sd = sample.data;
    var pixelCount = rw * rh;
    // Skip sampling: every Nth pixel for canvases > 1MP. nSkip=1 below 1MP,
    // 2 at 2MP, 5 at 4MP — keeps the histogram cost ~constant per frame.
    var nSkip = 1 + (pixelCount >> 20);
    var binsR = new Uint32Array(256), binsG = new Uint32Array(256), binsB = new Uint32Array(256);
    var sampleCount = 0;
    var step = nSkip * 4;
    for (var idx = 0, total = pixelCount * 4; idx < total; idx += step) {
        // We're already inside the image rect, so alpha=0 means a
        // transparent pixel within the image bounds (e.g. a layer mask or
        // erased area). The user sees those rendered against the dark
        // canvas backdrop — count them as bin-0 in all channels so the
        // histogram matches what they see, instead of disappearing.
        binsR[sd[idx]]++; binsG[sd[idx + 1]]++; binsB[sd[idx + 2]]++;
        sampleCount++;
    }

    // Per-channel ceiling. Old code took the 98th percentile across ALL
    // 256 bins; for a concentrated distribution (e.g. a fully-white image
    // where only bin 255 has content) that returns 0 and falls back to 1,
    // which made every single stray pixel render as a full-height bar —
    // so a uniform image looked like multiple noise spikes. Compute the
    // 95th percentile across NON-ZERO bins instead, so:
    //   • A single dominant bin keeps the ceiling near its own count and
    //     renders as one tall bar with no fake noise around it.
    //   • A spread distribution still gets the percentile-clip behaviour
    //     so one outlier doesn't crush the rest of the chart.
    function ceilingP(bins) {
        var nz = [];
        for (var i = 0; i < bins.length; i++) if (bins[i] > 0) nz.push(bins[i]);
        if (nz.length === 0) return 1;
        nz.sort(function (a, b) { return b - a; });
        var idx = Math.floor(nz.length * 0.05);
        if (idx >= nz.length) idx = nz.length - 1;
        var v = nz[idx];
        return v > 0 ? v : nz[0];
    }
    function drawBars(bins, fill) {
        var ceiling = ceilingP(bins);
        // Square-root compression so a 100× spike doesn't crush the rest
        // of the distribution into invisibility, while still ranking bins
        // monotonically.
        var sqCeil = Math.sqrt(ceiling);
        var barW = W / 256;
        hctx.fillStyle = fill;
        for (var i = 0; i < 256; i++) {
            var v = bins[i];
            if (v <= 0) continue;
            var t = Math.sqrt(v) / sqCeil;
            if (t > 1) t = 1;
            var bh = t * H;
            hctx.fillRect(i * barW, H - bh, barW, bh);
        }
    }
    hctx.globalCompositeOperation = "lighter";
    drawBars(binsR, "rgba(255, 0, 0, 0.25)");
    drawBars(binsG, "rgba(0, 255, 0, 0.25)");
    drawBars(binsB, "rgba(0, 0, 255, 0.25)");
    hctx.globalCompositeOperation = "source-over";

    // Clipping detection: a channel is "clipping" if more than CLIP_FRAC of
    // sampled pixels land in bin 0 (shadow) or bin 255 (highlight). The two
    // corner triangles light up colored to indicate which channels clip.
    // Stray pixels (single-digit counts) don't trip the warning.
    if (_histClipL && _histClipR) {
        var CLIP_FRAC = 0.001;
        var threshold = Math.max(2, sampleCount * CLIP_FRAC);
        var lo = {
            r: binsR[0] > threshold,
            g: binsG[0] > threshold,
            b: binsB[0] > threshold
        };
        var hi = {
            r: binsR[255] > threshold,
            g: binsG[255] > threshold,
            b: binsB[255] > threshold
        };
        _setClipIndicator(_histClipL, lo);
        _setClipIndicator(_histClipR, hi);
    }
}

// Color the clipping triangle: white if R+G+B all clip, else the additive
// mix (R+G=yellow, R+B=magenta, G+B=cyan, single channel = that color).
// Returns to dim/inactive state when no channel clips.
function _setClipIndicator(el, ch) {
    var any = ch.r || ch.g || ch.b;
    el.classList.toggle("clipping", !!any);
    if (!any) { el.style.color = ""; el.title = el.dataset.titleBase || el.title; return; }
    var r = ch.r ? 255 : 0, g = ch.g ? 255 : 0, b = ch.b ? 255 : 0;
    el.style.color = "rgb(" + r + "," + g + "," + b + ")";
    var labels = [];
    if (ch.r) labels.push("R");
    if (ch.g) labels.push("G");
    if (ch.b) labels.push("B");
    el.title = (el.classList.contains("develop-hist-clip-l") ? "Shadow clipping" : "Highlight clipping")
             + " — " + labels.join(", ");
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
    recordUndo("Develop: Reset all");
    _scheduleFullRedraw();
    if (window.showToast) window.showToast(_t("develop.resetPrompt", "Develop reset (click again to undo)"), "info");
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

// ========================================================================
// EYEDROPPERS — pick a pixel from the canvas to set WB / black / white.
//   • Black eyedropper (CALIBRATION): picked pixel becomes pure black
//     (and anything darker also clips to black). Stored as a linear-RGB
//     endpoint independent of the Blacks slider — the slider then acts
//     as further adjustment on top of the calibrated baseline.
//   • White eyedropper (CALIBRATION): picked pixel becomes pure white
//     (and anything brighter also clips). Stored as a linear-RGB
//     endpoint independent of the Whites slider.
//   • White-balance eyedropper (ADJUSTMENT): writes Temperature and
//     Tint slider values that neutralize the picked pixel. The user
//     can fine-tune from the picked neutral — same behaviour as
//     Lightroom's WB picker.
//
// All pickers read the PRE-DEVELOP composite (so already-applied develop
// settings don't double-count). We reuse _buildBeforeBuffer() from the
// before/after split feature for that.
//
// The canvas-ui pointerdown handler bails out when StudioModules.activeId
// is "develop" (so brush tools stay inert). To capture the pick click we
// install a capture-phase listener on the document that runs BEFORE any
// other handler — only active while a pick is armed.
// ========================================================================
var _pickMode = null;          // null | "wb" | "whites" | "blacks"
var _pickArmedBtn = null;      // currently-active button element
var _pickPrevCursor = "";      // saved body cursor while picking
var _pickPrevCanvasCursor = null;  // saved canvas inline cursor while picking
var _pickTooltip = null;       // floating div with live RGB readout

// Eyedropper cursor SVG (Material "colorize" icon) — shown on the canvas
// while a calibration pick is armed. Setting cursor on body alone wasn't
// enough: body.develop-active sets its own cursor on the canvas with
// higher specificity than inherited body cursor, so the canvas tool's
// arrow leaked through. Inline style on the canvas wins over both.
var _PICK_CURSOR = "url(\"data:image/svg+xml;utf8,"
  + "%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E"
  + "%3Cpath d='M17.66 5.41l.92.92-2.69 2.69-.92-.92zm.01-2.41c-.26 0-.51.1-.71.29l-3.12 3.12-1.93-1.91-1.41 1.41 1.42 1.42L3 16.59V21h4.41l8.62-8.62 1.42 1.42 1.41-1.41-1.92-1.92 3.12-3.12c.4-.4.4-1.03.01-1.42l-2.34-2.34c-.2-.2-.45-.29-.71-.29z'"
  + " fill='%23ffffff' stroke='%23000000' stroke-width='1' stroke-linejoin='round'/%3E"
  + "%3C/svg%3E\") 3 21, crosshair";

function _ensurePickTooltip() {
    if (_pickTooltip) return _pickTooltip;
    _pickTooltip = document.createElement("div");
    _pickTooltip.className = "develop-pick-tooltip";
    _pickTooltip.style.display = "none";
    document.body.appendChild(_pickTooltip);
    return _pickTooltip;
}

function _enterPickMode(mode, btn) {
    if (_pickMode === mode) { _exitPickMode(); return; }    // toggle off
    _exitPickMode();                                        // cancel any prior
    _pickMode = mode;
    _pickArmedBtn = btn || null;
    if (_pickArmedBtn) _pickArmedBtn.classList.add("armed");
    _pickPrevCursor = document.body.style.cursor || "";
    document.body.style.cursor = _PICK_CURSOR;
    var S = _S();
    if (S && S.canvas) {
        _pickPrevCanvasCursor = S.canvas.style.cursor;
        S.canvas.style.cursor = _PICK_CURSOR;
    }
    _ensurePickTooltip();
    document.addEventListener("pointerdown", _onPickClick, true);   // capture
    document.addEventListener("pointermove", _onPickMove, true);
    document.addEventListener("keydown", _onPickKey, true);
}

function _exitPickMode() {
    if (_pickMode === null) return;
    document.removeEventListener("pointerdown", _onPickClick, true);
    document.removeEventListener("pointermove", _onPickMove, true);
    document.removeEventListener("keydown", _onPickKey, true);
    if (_pickArmedBtn) _pickArmedBtn.classList.remove("armed");
    _pickArmedBtn = null;
    _pickMode = null;
    document.body.style.cursor = _pickPrevCursor;
    var S = _S();
    if (S && S.canvas && _pickPrevCanvasCursor !== null) {
        S.canvas.style.cursor = _pickPrevCanvasCursor;
    }
    _pickPrevCanvasCursor = null;
    if (_pickTooltip) _pickTooltip.style.display = "none";
}

// Live RGB readout: while a pick is armed, show a small floating tooltip
// near the cursor with the sampled sRGB value. Confirms which pixel is
// about to be picked and surfaces the RGB so the user can verify the
// calibration target before committing the click.
//
// Throttled to one sample per animation frame: _samplePreDevelopRegion
// rebuilds the layer composite each call, which can be costly on a
// multi-megapixel doc and pointermove can fire well above 60Hz on
// high-DPI mice.
var _pickMoveRaf = 0;
var _pickMoveLast = null;
function _onPickMove(e) {
    if (_pickMode === null) return;
    _pickMoveLast = { x: e.clientX, y: e.clientY, target: e.target };
    if (_pickMoveRaf) return;
    _pickMoveRaf = requestAnimationFrame(function () {
        _pickMoveRaf = 0;
        var ev = _pickMoveLast;
        if (_pickMode === null || !ev || !_pickTooltip) return;
        var S = _S(); if (!S || !S.canvas) return;
        if (ev.target !== S.canvas) {
            _pickTooltip.style.display = "none";
            return;
        }
        var rect = S.canvas.getBoundingClientRect();
        var z = S.zoom;
        var docX = Math.floor((ev.x - rect.left - z.ox) / z.scale);
        var docY = Math.floor((ev.y - rect.top  - z.oy) / z.scale);
        if (docX < 0 || docY < 0 || docX >= S.W || docY >= S.H) {
            _pickTooltip.style.display = "none";
            return;
        }
        // Sample 3x3 average to match what the click handler commits.
        // Larger neighborhoods (the previous 5x5) bled across sharp edges
        // — common in AI-generated content — and pulled the calibration
        // away from the intended pixel. 3x3 still smooths single-pixel
        // anomalies without spanning a visibly-large area at high zoom.
        var px = _samplePreDevelopRegion(docX, docY, 1);
        if (!px) { _pickTooltip.style.display = "none"; return; }
        var r = Math.max(0, Math.min(255, Math.round(px.r * 255)));
        var g = Math.max(0, Math.min(255, Math.round(px.g * 255)));
        var b = Math.max(0, Math.min(255, Math.round(px.b * 255)));
        _pickTooltip.textContent = "rgb(" + r + ", " + g + ", " + b + ")";
        _pickTooltip.style.display = "block";
        // Position to the lower-right of the cursor, away from the eyedropper
        // tip (which sits at the bottom-left of the cursor sprite).
        _pickTooltip.style.left = (ev.x + 18) + "px";
        _pickTooltip.style.top  = (ev.y + 18) + "px";
    });
}

function _onPickKey(e) {
    if (e.key === "Escape") { _exitPickMode(); e.preventDefault(); }
}

function _onPickClick(e) {
    if (_pickMode === null) return;
    var S = _S(); if (!S || !S.canvas) return;
    // Only handle clicks on the canvas itself.
    if (e.target !== S.canvas) {
        // Clicking elsewhere (panel, toolbar, etc.) cancels the pick.
        _exitPickMode();
        return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();

    var rect = S.canvas.getBoundingClientRect();
    var z = S.zoom;
    var docX = Math.floor((e.clientX - rect.left - z.ox) / z.scale);
    var docY = Math.floor((e.clientY - rect.top  - z.oy) / z.scale);
    if (docX < 0 || docY < 0 || docX >= S.W || docY >= S.H) {
        _exitPickMode(); return;
    }

    // Sample a 3x3 region around the click and average. 5x5 (the prior
    // value) bled across sharp edges — common on AI-generated content —
    // and pulled the calibration off-target relative to where the user
    // clicked. 3x3 still smooths single-pixel anomalies but stays close
    // enough to the click point that the committed value matches what
    // the user can verify in the tooltip and in external color tools.
    var px = _samplePreDevelopRegion(docX, docY, 1);
    if (!px) { _exitPickMode(); return; }

    var mode = _pickMode;
    if      (mode === "wb")     _applyWBPick(px);
    else if (mode === "blacks") _applyBlackPick(px);
    else if (mode === "whites") _applyWhitePick(px);

    _exitPickMode();
}

function _samplePreDevelopRegion(cx, cy, radius) {
    var S = _S(); if (!S) return null;
    var buf = _buildBeforeBuffer();
    if (!buf) return null;
    var x0 = Math.max(0, cx - radius);
    var y0 = Math.max(0, cy - radius);
    var x1 = Math.min(S.W - 1, cx + radius);
    var y1 = Math.min(S.H - 1, cy + radius);
    var w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (w <= 0 || h <= 0) return null;
    var img;
    try { img = buf.getContext("2d", { colorSpace: "srgb" }).getImageData(x0, y0, w, h); }
    catch (e) { return null; }
    var d = img.data, n = w * h;
    var rs = 0, gs = 0, bs = 0;
    for (var i = 0; i < n; i++) {
        var p = i * 4;
        rs += d[p]; gs += d[p + 1]; bs += d[p + 2];
    }
    return {
        r:  (rs / n) / 255,
        g:  (gs / n) / 255,
        b:  (bs / n) / 255,
        rL: _SRGB_TO_LIN[Math.round((rs / n))],
        gL: _SRGB_TO_LIN[Math.round((gs / n))],
        bL: _SRGB_TO_LIN[Math.round((bs / n))]
    };
}

// White-balance pick: compute Temperature + Tint slider values that
// neutralize the picked pixel in Lab space. The pipeline shifts:
//   new_a* = a* - tint * 0.15
//   new_b* = b* + temperature * 0.3
// To null both axes:  tint = a*/0.15, temperature = -b*/0.3.
// (WB stays a slider adjustment so the user can fine-tune from the
// picked neutral — only Whites/Blacks are stored as separate calibration.)
function _applyWBPick(px) {
    var S = _S(); if (!S || !S.developParams) return;
    var r = px.rL, g = px.gL, b = px.bL;
    if (r + g + b < 1e-6) return;             // near-black pixel — meaningless
    var X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
    var Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    var Z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
    var fx = _labF(X / _LAB_WHITE_X);
    var fy = _labF(Y);
    var fz = _labF(Z / _LAB_WHITE_Z);
    var aStar = 500 * (fx - fy);
    var bStar = 200 * (fy - fz);
    var tint = aStar / 0.15;
    var temp = -bStar / 0.3;
    if (temp < -100) temp = -100; else if (temp > 100) temp = 100;
    if (tint < -100) tint = -100; else if (tint > 100) tint = 100;
    var p = S.developParams;
    p.temperature = Math.round(temp);
    p.tint = Math.round(tint);
    p.enabled = true;
    syncPanel();
    _bumpCompositeCache();
    recordUndo("Develop: White Balance");
    _scheduleFullRedraw();
}

// Black-point pick (CALIBRATION): the picked pixel becomes the new black
// endpoint. Pixels at or below this luminance render as pure black; pixels
// above scale linearly into the new range. Use Rec.709 luminance.
function _applyBlackPick(px) {
    var S = _S(); if (!S || !S.developParams) return;
    var Y = 0.2126 * px.rL + 0.7152 * px.gL + 0.0722 * px.bL;
    if (Y < 0) Y = 0; else if (Y > 1) Y = 1;
    var p = S.developParams;
    // Refuse a black calibration that would collide with the white
    // calibration (range collapse → divide-by-zero in the remap).
    var calibWht = (p.calibWhiteLin == null) ? 1 : p.calibWhiteLin;
    if (Y >= calibWht - 0.02) Y = calibWht - 0.02;
    if (Y < 0) Y = 0;
    p.calibBlackLin = Y;
    p.enabled = true;
    syncPanel();
    _bumpCompositeCache();
    recordUndo("Develop: Black Point");
    _scheduleFullRedraw();
}

// White-point pick (CALIBRATION): the picked pixel becomes the new white
// endpoint. Pixels at or above this brightness render as pure white;
// pixels below scale linearly. Use the max channel — matches the
// conventional "this is the brightest non-clipping color" semantics.
function _applyWhitePick(px) {
    var S = _S(); if (!S || !S.developParams) return;
    var V = px.rL > px.gL ? (px.rL > px.bL ? px.rL : px.bL) : (px.gL > px.bL ? px.gL : px.bL);
    if (V < 0) V = 0; else if (V > 1) V = 1;
    if (V < 0.05) return;                     // refuse near-black
    var p = S.developParams;
    var calibBlk = p.calibBlackLin || 0;
    if (V <= calibBlk + 0.02) V = calibBlk + 0.02;
    if (V > 1) V = 1;
    p.calibWhiteLin = V;
    p.enabled = true;
    syncPanel();
    _bumpCompositeCache();
    recordUndo("Develop: White Point");
    _scheduleFullRedraw();
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
    var name = document.createElement("span");
    name.dataset.i18n = "develop.presets.title";
    name.textContent = _t("develop.presets.title", "Presets");
    head.appendChild(name);
    head.addEventListener("click", function () { s.classList.toggle("collapsed"); });
    s.appendChild(head);

    var body = document.createElement("div");
    body.className = "develop-section-body";

    var row = document.createElement("div");
    row.className = "develop-presets-row";

    _presetSelect = document.createElement("select");
    _presetSelect.className = "develop-presets-select";
    var defOpt = document.createElement("option");
    defOpt.value = ""; defOpt.textContent = _t("develop.preset.placeholder", "— Select a preset —");
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
    saveBtn.dataset.i18n = "develop.presets.save";
    saveBtn.textContent = _t("develop.presets.save", "Save…");
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
        if (window.showToast) window.showToast(_t("develop.preset.invalidName", "Invalid preset name (letters, digits, space, _ -)"), "error");
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
            if (window.showToast) window.showToast(_t("develop.preset.saveFailed", "Save failed"), "error");
        }
    }).catch(function (e) {
        if (window.showToast) window.showToast(_t("develop.preset.saveFailed", "Save failed"), "error");
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
// Hooked into StudioUI.onAfterRedraw — fires at the end of every local
// _redraw() in canvas-ui.js, including cursor moves, brush hover, panning.
// Wrapping window.StudioUI.redraw doesn't work because canvas-ui's internal
// calls go through the local _redraw reference, not through the property.
// ========================================================================
var _afterRedrawHookInstalled = false;

function _afterRedrawHook() {
    if (_splitActive) _renderSplitOverlay();
}

function _installRedrawHook() {
    if (_afterRedrawHookInstalled) return;
    var UI = window.StudioUI;
    if (!UI || typeof UI.onAfterRedraw !== "function") return;
    UI.onAfterRedraw(_afterRedrawHook);
    _afterRedrawHookInstalled = true;
}

function _buildBeforeBuffer() {
    var S = _S(); if (!S || !S.canvas) return null;
    var C = window.StudioCore; if (!C) return null;
    // Render layers without develop into a doc-resolution canvas.
    var c = document.createElement("canvas");
    c.width = S.W; c.height = S.H;
    var x = c.getContext("2d", { colorSpace: "srgb" });
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
        _splitLabelL.dataset.i18n = "develop.split.before";
        _splitLabelL.textContent = _t("develop.split.before", "Before");
        document.body.appendChild(_splitLabelL);
    }
    if (!_splitLabelR) {
        _splitLabelR = document.createElement("div");
        _splitLabelR.className = "develop-split-label";
        _splitLabelR.dataset.i18n = "develop.split.after";
        _splitLabelR.textContent = _t("develop.split.after", "After");
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

    // Position the split line + labels in viewport coordinates. Both labels
    // hug the split line: AFTER sits 8px to its right, BEFORE sits 8px to
    // its left (right-edge anchored). The previous approach pinned BEFORE
    // to the canvas element's left edge, which lands far off in the void
    // area when the document is zoomed-to-fit and centered.
    _ensureSplitElements();
    var rect = S.canvas.getBoundingClientRect();
    var lineX = rect.left + splitX;
    _splitLine.style.left = (lineX - 1) + "px";
    _splitLine.style.top = rect.top + "px";
    _splitLine.style.height = rect.height + "px";
    _splitLabelL.style.left = "auto";
    _splitLabelL.style.right = Math.max(0, (window.innerWidth - lineX + 8)) + "px";
    _splitLabelR.style.right = "auto";
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
            // Body class drives panel-right + tool-UI hide and any future
            // develop-only styling. The pointerdown gate in canvas-ui reads
            // StudioModules.activeId directly so it doesn't depend on this.
            document.body.classList.add("develop-active");
            _showPanel();
            syncPanel();
            // Seed undo baseline from current params now that the panel
            // is visible — Ctrl+Z routing only fires while visible.
            _initDevelopUndoBaseline();
            // CSS just freed the 42-px toolstrip column + the right panel —
            // resync the canvas element to the new viewport so it actually
            // fills the available width, then refit zoom and redraw.
            var UI = window.StudioUI;
            if (UI && UI.syncCanvasToViewport) UI.syncCanvasToViewport();
            var C = window.StudioCore;
            if (C && C.zoomFit) C.zoomFit();
            if (C && C.markCompositeDirty) C.markCompositeDirty();
            if (UI && UI.redraw) UI.redraw();
            try { _renderHistogram(); } catch (e) {}
        },
        deactivate: function () {
            document.body.classList.remove("develop-active");
            _hidePanel();
            // Tear down before/after split overlay if open
            if (_splitLine) _splitLine.classList.remove("visible");
            if (_splitLabelL) _splitLabelL.classList.remove("visible");
            if (_splitLabelR) _splitLabelR.classList.remove("visible");
            var S = _S();
            if (S) S._developBeforeBuf = null;
            // Resize the canvas back now that toolstrip + panel-right are
            // visible again.
            var UI = window.StudioUI;
            if (UI && UI.syncCanvasToViewport) UI.syncCanvasToViewport();
            var C = window.StudioCore;
            if (C && C.zoomFit) C.zoomFit();
            if (C && C.markCompositeDirty) C.markCompositeDirty();
            if (UI && UI.redraw) UI.redraw();
        }
    });
} else {
    console.warn(TAG, "StudioModules not available — Develop cannot register");
}

// ========================================================================
// HIGH PRECISION — float32 sidecar source
// ========================================================================
function _updateHpBadge() {
    if (!_hpBadge) return;
    if (!_floatSrc || !_floatSrc.r) {
        _hpBadge.style.display = "none";
        return;
    }
    _hpBadge.style.display = "";
    if (_floatSrc.hasMask) {
        _hpBadge.textContent = "HP+AD";
        _hpBadge.dataset.i18nTitle = "develop.hpBadge.composited";
        _hpBadge.title = _t("develop.hpBadge.composited",
            "High Precision: float buffer composited with AD/brush canvas pixels");
    } else {
        _hpBadge.textContent = "HP";
        _hpBadge.dataset.i18nTitle = "develop.hpBadge.tooltip";
        _hpBadge.title = _t("develop.hpBadge.tooltip",
            "High Precision: float32 source pixels active");
    }
}

function _splitInterleavedRGB(buf, w, h) {
    // Source layout: HxWx3 row-major float32, interleaved RGB (the
    // backend writes float_arr.tobytes() of an HWC numpy array).
    // We slice it into three planar arrays the pipeline consumes.
    var n = w * h;
    var f32 = new Float32Array(buf);
    if (f32.length !== n * 3) {
        throw new Error("float buffer size " + f32.length + " != " + (n * 3));
    }
    var R = new Float32Array(n);
    var G = new Float32Array(n);
    var B = new Float32Array(n);
    for (var i = 0, j = 0; i < n; i++, j += 3) {
        R[i] = f32[j];
        G[i] = f32[j + 1];
        B[i] = f32[j + 2];
    }
    return { r: R, g: G, b: B };
}

function _decodeMaskPng(url, w, h) {
    // Decode an 8-bit grayscale PNG via an off-DOM <img> + canvas. The
    // canvas decode rasterises to RGBA so we read just the red channel.
    return new Promise(function (resolve, reject) {
        var im = new Image();
        im.onload = function () {
            try {
                var c = document.createElement("canvas");
                c.width = w; c.height = h;
                var cx = c.getContext("2d", { colorSpace: "srgb" });
                cx.drawImage(im, 0, 0, w, h);
                var d = cx.getImageData(0, 0, w, h).data;
                var out = new Uint8ClampedArray(w * h);
                for (var i = 0, j = 0; i < out.length; i++, j += 4) out[i] = d[j];
                resolve(out);
            } catch (e) { reject(e); }
        };
        im.onerror = function () { reject(new Error("mask image failed to load")); };
        im.src = url;
    });
}

function _compositeFloatWithMask(planes, mask, canvasUint8) {
    // In-place composite: where mask = 1.0, replace float with the
    // canvas-uint8 pixel (promoted to [0, 1] and treated as sRGB-encoded
    // — same encoding as the float buffer, so the pipeline's gamma
    // decode handles both uniformly afterwards). Where mask = 0.0,
    // float is unchanged.
    var R = planes.r, G = planes.g, B = planes.b;
    var n = R.length;
    for (var i = 0, j = 0; i < n; i++, j += 4) {
        var a = mask[i] / 255;
        if (a <= 0) continue;
        var inv = 1 - a;
        R[i] = R[i] * inv + (canvasUint8[j]     / 255) * a;
        G[i] = G[i] * inv + (canvasUint8[j + 1] / 255) * a;
        B[i] = B[i] * inv + (canvasUint8[j + 2] / 255) * a;
    }
}

function _decodeImageToRGBA(url, w, h) {
    // Rasterize an arbitrary image URL (file URL or data URL) into a
    // throwaway canvas at the requested dimensions, returning the raw
    // RGBA Uint8ClampedArray. Used as the canvas source for the AD
    // mask composite — we deliberately do NOT read from Studio's live
    // canvas because the visible composite hasn't necessarily flushed
    // by the time setFloatSource fires (Studio's redraw is rAF-deferred).
    return new Promise(function (resolve, reject) {
        var im = new Image();
        im.onload = function () {
            try {
                var c = document.createElement("canvas");
                c.width = w; c.height = h;
                var cx = c.getContext("2d", { colorSpace: "srgb" });
                cx.drawImage(im, 0, 0, w, h);
                resolve(cx.getImageData(0, 0, w, h).data);
            } catch (e) { reject(e); }
        };
        im.onerror = function () { reject(new Error("image source failed to load")); };
        im.src = url;
    });
}

function setFloatSource(floatUrl, maskUrl, sourceUrl, w, h) {
    // Null floatUrl = clear. Same (float, mask, source) URL triple = no-op.
    // Otherwise fetch float + (optional) mask + (optional) source image,
    // composite at load time, and stash the result.
    //
    // sourceUrl is the canonical post-modification image (saved PNG/JPG
    // data URL or /file= URL). When a mask is present, we draw this
    // image into a throwaway canvas at (w, h) and read its pixel data —
    // this gives us deterministic post-AD pixels regardless of whether
    // Studio's visible canvas has finished its async redraw.
    if (!floatUrl) {
        _floatSrc = null;
        _floatSrcLoading = null;
        _updateHpBadge();
        _scheduleFullRedraw();
        return;
    }
    if (_floatSrc
            && _floatSrc.url === floatUrl
            && _floatSrc.maskUrl === (maskUrl || "")
            && _floatSrc.sourceUrl === (sourceUrl || "")
            && _floatSrc.w === w && _floatSrc.h === h) {
        return;
    }
    var token = { url: floatUrl, maskUrl: maskUrl || "", sourceUrl: sourceUrl || "", w: w, h: h };
    _floatSrcLoading = token;

    var floatP = fetch(floatUrl).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status + " on float sidecar");
        return r.arrayBuffer();
    });
    // Mask is optional — when absent, resolve to null and skip composite.
    var maskP = maskUrl
        ? _decodeMaskPng(maskUrl, w, h).catch(function (e) {
            console.warn(TAG, "blend-mask decode failed, falling back to plain HP:", e);
            return null;
        })
        : Promise.resolve(null);
    // Source image is needed only when we have a mask to composite with.
    var sourceP = (maskUrl && sourceUrl)
        ? _decodeImageToRGBA(sourceUrl, w, h).catch(function (e) {
            console.warn(TAG, "source image decode failed, falling back to plain HP:", e);
            return null;
        })
        : Promise.resolve(null);

    Promise.all([floatP, maskP, sourceP]).then(function (results) {
        if (_floatSrcLoading !== token) return;  // superseded
        try {
            var planes = _splitInterleavedRGB(results[0], w, h);
            var maskArr = results[1];
            var sourceRGBA = results[2];
            var hasMask = false;
            if (maskArr && sourceRGBA) {
                _compositeFloatWithMask(planes, maskArr, sourceRGBA);
                hasMask = true;
            } else if (maskArr && !sourceRGBA) {
                console.warn(TAG, "have mask but no source image — skipping composite");
            }
            _floatSrc = {
                url: floatUrl,
                maskUrl: maskUrl || "",
                sourceUrl: sourceUrl || "",
                w: w, h: h,
                r: planes.r, g: planes.g, b: planes.b,
                hasMask: hasMask,
            };
            _updateHpBadge();
            _scheduleFullRedraw();
        } catch (e) {
            console.warn(TAG, "float sidecar parse failed:", e);
            _floatSrc = null;
            _updateHpBadge();
        }
    }).catch(function (e) {
        if (_floatSrcLoading !== token) return;
        console.warn(TAG, "float sidecar fetch failed:", e);
        _floatSrc = null;
        _updateHpBadge();
    });
}

function clearFloatSource() { setFloatSource(null); }

function hasFloatSource(w, h) {
    return !!(_floatSrc && _floatSrc.r
        && (w == null || _floatSrc.w === w)
        && (h == null || _floatSrc.h === h));
}


// ========================================================================
// PUBLIC API
// ========================================================================
window.StudioDevelop = {
    defaultParams: defaultParams,
    applyToContext: applyToContext,
    syncPanel: function () { try { syncPanel(); } catch (e) {} },
    setFloatSource: setFloatSource,
    clearFloatSource: clearFloatSource,
    hasFloatSource: hasFloatSource,
    _isIdentity: _isIdentity,
    // Undo/redo (Ctrl+Z) — Develop owns its own stack of developParams
    // snapshots; canvas-ui.js routes Ctrl+Z through here first when the
    // Develop panel is visible, falling back to canvas undo otherwise.
    canUndo: canDevelopUndo,
    canRedo: canDevelopRedo,
    undo: developUndo,
    redo: developRedo,
    recordUndo: recordUndo,
    isPanelVisible: isDevelopPanelVisible,
};

console.log(TAG, "Develop module loaded v" + VERSION);

})();
