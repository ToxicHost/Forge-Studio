/**
 * Forge Studio — Canvas Core (Standalone Clean Engine)
 * by ToxicHost & Moritz
 *
 * Phase 1: Pure algorithm module. No DOM queries, no event listeners,
 * no panel rendering. Functions take data, return data.
 *
 * Browser canvas APIs (createElement("canvas"), getContext, ImageData) are used
 * for offscreen buffers — that's unavoidable. But nothing here calls
 * getElementById, querySelector, addEventListener, or manipulates layout.
 *
 * Exposes window.StudioCore — the contract Phase 2 (canvas-ui.js) binds to.
 */
(function () {
"use strict";

// ========================================================================
// OFFSCREEN CANVAS FACTORY
// ========================================================================
// Abstracted so we never call document.createElement directly in algorithm code.
function _createCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
}

// Reusable temp canvases — prevents per-frame allocation / GC pressure
const _tempCanvases = {};
function getTempCanvas(key, w, h) {
    let tc = _tempCanvases[key];
    if (!tc || tc.width !== w || tc.height !== h) {
        tc = _createCanvas(w, h);
        _tempCanvases[key] = tc;
    }
    const ctx = tc.getContext("2d");
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.filter = "none";
    ctx.clearRect(0, 0, w, h);
    return tc;
}

// ========================================================================
// STATE
// ========================================================================
const S = {
    // Display canvas — set by boot(), not owned by core
    canvas: null, ctx: null,

    // Document dimensions (independent of viewport)
    W: 768, H: 768,

    // Layer stack: {id, name, type, canvas, ctx, visible, opacity, blendMode, locked}
    // type: "reference" | "paint" | "adjustment"
    layers: [],
    activeLayerIdx: 1,
    nextLayerId: 0,

    // Inpaint mask — separate from layer stack
    mask: { canvas: null, ctx: null, visible: true, opacity: 0.5 },

    // Live painting — AI preview, separate from layer stack and undo
    livePreview: { canvas: null, ctx: null, active: false },

    // Current tool state
    tool: "brush",
    brushSize: 5,        // 1-100 (percentage slider)
    brushOpacity: 1,
    brushFlow: 1,
    brushHardness: 1.0,
    brushPreset: "round", // "round" | "flat" | "marker" | "scatter" | "custom"
    brushRatio: 1.0,      // 0.1-1.0 — ellipse ratio (1.0 = circle)
    brushSpikes: 2,       // 2-12 — star/spike count (2 = normal circle)
    brushFalloff: "default", // "default" | "gaussian" | "soft"
    brushDensity: 1.0,    // 0.05-1.0 — stipple density (1.0 = solid)
    color: "#000000",
    bgColor: "#ffffff",
    maskColor: "#ff0000",

    // Pressure
    pressureSensitivity: false,
    pressureAffects: "none", // "size" | "opacity" | "both" | "none"

    // Brush dynamics
    brushDynamics: {
        sizeJitter: 0, opacityJitter: 0, scatter: 0,
        rotationJitter: 0, followStroke: true, spacing: 0.08
    },

    // Custom brush tip (grayscale Uint8Array)
    customTip: { data: null, width: 0, height: 0 },

    // Stabilizer (smoothing)
    smoothing: 4,

    // Tool strength (smudge, blur, dodge/burn, magic wand tolerance)
    toolStrength: 0.5,

    // Liquify sub-modes and spacing
    liquifyMode: "move",    // "move" | "pinch" | "bloat" | "twirl_cw" | "twirl_ccw"
    liquifySpacing: 0.2,    // fraction of brush diameter between dabs (0.2 = 20%)

    // Symmetry
    symmetry: "none", // "none" | "h" | "v" | "both" | "radial"
    symmetryAxes: 4,  // N axes for radial mode (2-16)

    // Eyedropper
    sampleRadius: 1,   // 1-11 px
    sampleMerged: false,

    // Drawing state
    drawing: false,
    lastResult: null,
    lastSettings: null,
    ready: false,

    // Stroke buffers
    stroke: {
        canvas: null, ctx: null, alphaMap: null,
        dirty: { x0: 0, y0: 0, x1: 0, y1: 0 },
        points: [], stampPoints: [],
        lx: 0, ly: 0, lp: 0.5,
        _cachedImg: null
    },

    // Undo/redo
    undoStack: [], redoStack: [], maxUndo: 100,

    // Color history
    colorHistory: ["#000000", "#ffffff"],

    // Smudge
    smudgeBuffer: null,

    // Zoom/pan
    zoom: {
        scale: 1, ox: 0, oy: 0,
        panning: false, panStartX: 0, panStartY: 0,
        panOxStart: 0, panOyStart: 0
    },

    refLoaded: false,
    studioMode: "Create",  // "Create" | "Edit" | "img2img"
    inpaintMode: "Inpaint", // "Inpaint" | "Inpaint Sketch" | "Regional"
    editingMask: false,
    generating: false,
    _canvasDirty: false, // Set true on any user edit — tracks whether canvas has been touched

    // Selection
    selection: {
        active: false, rect: null, mask: null,
        dragging: false, startX: 0, startY: 0,
        marchOffset: 0, animId: null,
        lassoPoints: null,
        _isLasso: false, _isEllipse: false,
        _isMaskBased: false, _contour: null
    },

    // Clipboard
    clipboard: null,

    // Transform
    transform: {
        active: false, bounds: null, originalData: null, layerIdx: -1,
        dragMode: null, dragStart: null, origBounds: null,
        canvas: null, ctx: null, rotation: 0,
        flipH: false, flipV: false, aspectLock: false
    },

    // Regions (v3.0 Regional Inpainting)
    regions: [],
    activeRegionId: null,
    regionMode: false,
    _nextRegionId: 1,

    // AR state
    arLocked: false, arRatio: null,

    // Dodge/burn sub-mode
    _dodgeMode: "dodge",

    // Gradient/shape sub-modes
    _gradientMode: "linear",
    _shapeMode: "rect",
    _shapeFilled: false,

    // Clone stamp
    _cloneSource: null,
    _cloneOffset: null,

    // Poly lasso points
    _polyPoints: null,

    // Internal flags
    _resizeSuppressed: false,

    // Display options
    showGrid: false
};

// ========================================================================
// COMPOSITOR CACHE
// ========================================================================
let _compositeCache = null;
let _compBuffer = null, _compCtx = null;

// Stroke angle tracking (for follow-stroke rotation)
let _sa = 0, _saSmooth = 0;

// Cursor position in document space (for cursor rendering by UI layer)
let _cx = -1, _cy = -1;

// ========================================================================
// PSD BLEND MODE MAPS
// ========================================================================
const _blendToPS = {
    "source-over": "normal", "multiply": "multiply", "screen": "screen",
    "overlay": "overlay", "darken": "darken", "lighten": "lighten",
    "color-dodge": "color dodge", "color-burn": "color burn",
    "hard-light": "hard light", "soft-light": "soft light",
    "difference": "difference", "exclusion": "exclusion",
    "hue": "hue", "saturation": "saturation", "color": "color",
    "luminosity": "luminosity"
};
const _blendFromPS = {};
Object.keys(_blendToPS).forEach(k => _blendFromPS[_blendToPS[k]] = k);

const ALL_BLEND_MODES = [
    ["source-over", "Normal"], ["multiply", "Multiply"], ["screen", "Screen"],
    ["overlay", "Overlay"], ["darken", "Darken"], ["lighten", "Lighten"],
    ["color-dodge", "Color Dodge"], ["color-burn", "Color Burn"],
    ["hard-light", "Hard Light"], ["soft-light", "Soft Light"],
    ["difference", "Difference"], ["exclusion", "Exclusion"],
    ["hue", "Hue"], ["saturation", "Saturation"], ["color", "Color"],
    ["luminosity", "Luminosity"]
];

// ========================================================================
// REGION COLORS
// ========================================================================
const REGION_COLORS = [
    "#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6",
    "#a855f7", "#ec4899", "#14b8a6", "#f59e0b", "#8b5cf6"
];

// ========================================================================
// ADJUSTMENT LAYER DEFAULTS
// ========================================================================
// New v2 param shapes — see _migrateAdjustParams below for v1 → v2 conversion.
// brightness/contrast/saturation/lightness are integer percent (-100..100).
// levels black/white are 0..1 floats (UI shows 0..255), gamma is 0.1..9.99.
const _adjustDefaults = {
    "brightness": { _version: 2, brightness: 0, contrast: 0 },
    "hue":        { _version: 2, hue: 0, saturation: 0, lightness: 0, model: "HSL", colorize: false },
    "levels":     { _version: 2, levInBlack: 0, levInWhite: 1, levGamma: 1, levOutBlack: 0, levOutWhite: 1 }
};

// Idempotent migration from legacy adjustParam shapes to v2.
// Legacy: brightness/contrast/saturation/lightness stored as -1..1 floats; HSL had no
// `model` or `colorize` fields. v2 stamps `_version: 2` and rescales the affected fields.
function _migrateAdjustParams(adjustType, params) {
    const def = _adjustDefaults[adjustType];
    if (!def) return params || {};
    const p = Object.assign({}, def, params || {});
    if (p._version === 2) return p;
    if (adjustType === "brightness") {
        p.brightness = Math.round((p.brightness || 0) * 100);
        p.contrast   = Math.round((p.contrast   || 0) * 100);
    } else if (adjustType === "hue") {
        p.saturation = Math.round((p.saturation || 0) * 100);
        p.lightness  = Math.round((p.lightness  || 0) * 100);
        if (typeof p.model    !== "string")  p.model    = "HSL";
        if (typeof p.colorize !== "boolean") p.colorize = false;
    }
    p._version = 2;
    return p;
}

// ========================================================================
// DEFAULT BRUSH PRESETS
// ========================================================================
const DEFAULT_BRUSH_PRESETS = [
    { name: "Pencil", preset: "round", size: 3, hardness: 90, opacity: 80, flow: 60, smoothing: 2,
      dynamics: { sizeJitter: 0.05, opacityJitter: 0.1, scatter: 0, rotationJitter: 0, followStroke: true, spacing: 0.08 } },
    { name: "Soft Brush", preset: "round", size: 15, hardness: 0, opacity: 100, flow: 40, smoothing: 4,
      dynamics: { sizeJitter: 0, opacityJitter: 0, scatter: 0, rotationJitter: 0, followStroke: true, spacing: 0.08 } },
    { name: "Hard Ink", preset: "round", size: 8, hardness: 100, opacity: 100, flow: 100, smoothing: 1,
      dynamics: { sizeJitter: 0, opacityJitter: 0, scatter: 0, rotationJitter: 0, followStroke: true, spacing: 0.04 } },
    { name: "Airbrush", preset: "round", size: 30, hardness: 0, opacity: 50, flow: 15, smoothing: 6,
      dynamics: { sizeJitter: 0, opacityJitter: 0.05, scatter: 0.1, rotationJitter: 0, followStroke: true, spacing: 0.06 } },
    { name: "Flat Shader", preset: "flat", size: 20, hardness: 100, opacity: 70, flow: 100, smoothing: 3,
      dynamics: { sizeJitter: 0, opacityJitter: 0, scatter: 0, rotationJitter: 0, followStroke: true, spacing: 0.08 } },
    { name: "Scatter Dust", preset: "scatter", size: 25, hardness: 50, opacity: 60, flow: 80, smoothing: 1,
      dynamics: { sizeJitter: 0.3, opacityJitter: 0.2, scatter: 0.5, rotationJitter: 0.5, followStroke: false, spacing: 0.15 } },
    { name: "Bold Marker", preset: "marker", size: 12, hardness: 100, opacity: 90, flow: 100, smoothing: 2,
      dynamics: { sizeJitter: 0, opacityJitter: 0, scatter: 0, rotationJitter: 0, followStroke: true, spacing: 0.06 } },
    { name: "Sketch Light", preset: "round", size: 5, hardness: 70, opacity: 40, flow: 25, smoothing: 3,
      dynamics: { sizeJitter: 0.08, opacityJitter: 0.15, scatter: 0, rotationJitter: 0, followStroke: true, spacing: 0.08 } }
];

// ========================================================================
// COLOR MATH
// ========================================================================
function hexRgb(h) {
    return {
        r: parseInt(h.slice(1, 3), 16),
        g: parseInt(h.slice(3, 5), 16),
        b: parseInt(h.slice(5, 7), 16)
    };
}

function rgbHex(r, g, b) {
    return "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("");
}

function hsvToRgb(h, s, v) {
    s /= 100; v /= 100;
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return {
        r: Math.round((r + m) * 255),
        g: Math.round((g + m) * 255),
        b: Math.round((b + m) * 255)
    };
}

function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0, s = max === 0 ? 0 : d / max, v = max;
    if (d !== 0) {
        if (max === r) h = 60 * (((g - b) / d) % 6);
        else if (max === g) h = 60 * ((b - r) / d + 2);
        else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    return { h, s: s * 100, v: v * 100 };
}

// ========================================================================
// LAYER MODEL
// ========================================================================
function createLayerCanvas() {
    return _createCanvas(S.W, S.H);
}

function makeLayer(name, type, opts) {
    const c = createLayerCanvas();
    const ctx = c.getContext("2d");
    return {
        id: S.nextLayerId++, name: name, type: type || "paint",
        canvas: c, ctx: ctx,
        visible: true, opacity: 1, blendMode: "source-over", locked: false,
        ...(opts || {})
    };
}

function makeAdjustLayer(name, adjustType, params) {
    return {
        id: S.nextLayerId++, name: name, type: "adjustment",
        adjustType: adjustType,
        adjustParams: _migrateAdjustParams(adjustType, params),
        visible: true, opacity: 1, blendMode: "source-over", locked: false,
        canvas: null, ctx: null,
        _lutCache: null
    };
}

function activeLayer() {
    // Self-healing: if activeLayerIdx is invalid, reset to last paint layer
    if (S.activeLayerIdx == null || S.activeLayerIdx < 0 || S.activeLayerIdx >= S.layers.length) {
        let fixed = S.layers.findIndex(l => l.type === "paint");
        if (fixed < 0) fixed = 0;
        S.activeLayerIdx = fixed;
        console.warn("[StudioCore] activeLayerIdx was invalid, reset to", fixed);
    }
    return S.layers[S.activeLayerIdx] || S.layers[0];
}
function findLayerIdx(id) { return S.layers.findIndex(l => l.id === id); }

function drawTarget() {
    if (S.editingMask) return { canvas: S.mask.canvas, ctx: S.mask.ctx };
    const L = activeLayer();
    return { canvas: L.canvas, ctx: L.ctx };
}

function drawColor() { return S.editingMask ? S.maskColor : S.color; }

// ========================================================================
// BRUSH SIZE CONVERSION
// ========================================================================
// Slider 1-100 → pixel radius. Power curve for fine control at small sizes.
function brushPx() {
    const v = S.brushSize;
    const shortSide = Math.min(S.W, S.H);
    const pct = (Math.pow(v, 1.5) / Math.pow(100, 0.5)) / 100;
    return Math.max(1, Math.round(pct * shortSide));
}

// Pressure-adjusted size/opacity
function pSz(p) {
    const base = brushPx();
    if (!S.pressureSensitivity) return base;
    const v = Math.max(0.1, p);
    return (S.pressureAffects === "size" || S.pressureAffects === "both") ? base * v : base;
}

function pOp(p) {
    if (!S.pressureSensitivity) return S.brushFlow;
    const v = Math.max(0.1, p);
    return (S.pressureAffects === "opacity" || S.pressureAffects === "both") ? S.brushFlow * v : S.brushFlow;
}

// ========================================================================
// BRUSH STAMP ENGINE
// ========================================================================

// Dab alpha falloff with hardness
// Hard/medium brushes (hardness > 0): opaque core + smoothstep fade, uses max-blend
// Soft brush (hardness ≈ 0): Krita Airbrush_Soft curve, low per-dab alpha, uses source-over accumulation
// Error function approximation (Abramowitz & Stegun 7.1.26, max error 1.5e-7)
function _erf(x) {
    const sign = x >= 0 ? 1 : -1;
    x = Math.abs(x);
    const t = 1.0 / (1.0 + 0.3275911 * x);
    const y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return sign * y;
}

// Spike rotation — folds point angle into first sector (Krita's fixRotation)
function _applySpikeRotation(xr, yr, spikes) {
    if (spikes <= 2) return { x: xr, y: yr };
    const spikeAngle = Math.PI / spikes;
    const cs = Math.cos(-2 * spikeAngle);
    const ss = Math.sin(-2 * spikeAngle);
    let angle = Math.atan2(Math.abs(yr), xr);
    let sx = xr, sy = Math.abs(yr);
    while (angle > spikeAngle) {
        const nx = cs * sx - ss * sy;
        const ny = ss * sx + cs * sy;
        sx = nx; sy = ny;
        angle -= 2 * spikeAngle;
    }
    return { x: sx, y: sy };
}

function dabAlpha(dist, radius, hardness) {
    if (dist >= radius) return 0;
    if (hardness >= 0.01) {
        const innerR = radius * hardness;
        if (dist <= innerR) return 1;
        const t = (dist - innerR) / (radius - innerR);
        return 1 - (t * t * (3 - 2 * t));
    } else {
        const t = dist / radius;
        if (t <= 0.43) {
            return 0.4 - (0.4 - 0.12) * (t / 0.43);
        } else {
            return 0.12 * (1 - (t - 0.43) / (1 - 0.43));
        }
    }
}

function dabAlphaGauss(dist, radius, hardness) {
    if (dist >= radius) return 0;
    // Gaussian bell curve via erf (from Krita's KisGaussCircleMaskGenerator)
    // Map hardness to fade width — high hardness = narrow bell, low = wide soft
    const fade = Math.max(0.01, 1.0 - hardness * 0.85);
    const center = (2.5 * (6761.0 * fade - 10000.0)) / (1.41421356 * 6761.0 * fade);
    const alphafactor = 1.0 / (2.0 * _erf(center));
    const distfactor = 1.41421356 * 12500.0 / (6761.0 * fade * radius);
    const d = dist * distfactor;
    return alphafactor * (_erf(d + center) - _erf(d - center));
}

// Dispatch to active falloff mode
function _dabFalloff(dist, radius, hardness) {
    switch (S.brushFalloff) {
        case "gaussian": return dabAlphaGauss(dist, radius, hardness);
        default: return dabAlpha(dist, radius, hardness);
    }
}

// Shape distance functions — return normalized 0..1 (1 = edge)
function shapeDistRound(px, py, cx, cy, r) {
    let dx = px - cx, dy = py - cy;
    // Apply ratio (ellipse) — stretch Y distance
    const ratio = S.brushRatio || 1.0;
    if (ratio < 0.99) dy /= ratio;
    // Apply spikes — fold angle into first sector
    const spikes = S.brushSpikes || 2;
    if (spikes > 2) {
        const sp = _applySpikeRotation(dx, dy, spikes);
        dx = sp.x; dy = sp.y;
    }
    return Math.sqrt(dx * dx + dy * dy) / r;
}

function shapeDistFlat(px, py, cx, cy, r, ang) {
    const cosA = Math.cos(-ang), sinA = Math.sin(-ang);
    const dx = px - cx, dy = py - cy;
    const lx = dx * cosA - dy * sinA;
    const ly = dx * sinA + dy * cosA;
    const rx = r, ry = Math.max(1, r * 0.3);
    return Math.sqrt((lx / rx) * (lx / rx) + (ly / ry) * (ly / ry));
}

function shapeDistMarker(px, py, cx, cy, r, ang) {
    const cosA = Math.cos(-ang), sinA = Math.sin(-ang);
    const dx = px - cx, dy = py - cy;
    const lx = dx * cosA - dy * sinA;
    const ly = dx * sinA + dy * cosA;
    const hw = r * 0.8, hh = r * 0.35;
    return Math.max(Math.abs(lx) / hw, Math.abs(ly) / hh);
}

// Stamp onto the alpha map
// Hard brushes: per-pixel max (no accumulation within stroke)
// Soft brushes (hardness < 0.01): source-over accumulation capped at flow ceiling
function stampAlphaMap(cx, cy, sz, opacity, stampAngle) {
    const map = S.stroke.alphaMap;
    if (!map) return;
    const r = sz / 2;
    const hard = S.brushHardness;
    const preset = S.brushPreset;
    const ang = stampAngle !== undefined ? stampAngle : (preset === "flat" ? (_saSmooth || 0) : 0.4);
    const w = S.W, h = S.H;
    // Soft brush: source-over accumulation capped at flow level
    const useSoftBlend = hard < 0.01;
    const ceiling = useSoftBlend ? Math.min(255, (opacity * 255) | 0) : 255;

    const x0 = Math.max(0, Math.floor(cx - r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y1 = Math.min(h - 1, Math.ceil(cy + r));

    // Expand dirty rect
    const d = S.stroke.dirty;
    if (x0 < d.x0) d.x0 = x0;
    if (y0 < d.y0) d.y0 = y0;
    if (x1 > d.x1) d.x1 = x1;
    if (y1 > d.y1) d.y1 = y1;

    // Scatter preset: random sub-dabs
    if (preset === "scatter") {
        const n = Math.max(3, ~~(sz / 3));
        for (let i = 0; i < n; i++) {
            const sx = cx + (Math.random() - 0.5) * sz * 0.8;
            const sy = cy + (Math.random() - 0.5) * sz * 0.8;
            const sr = Math.random() * r * 0.3 + 1;
            const sx0 = Math.max(0, Math.floor(sx - sr));
            const sy0 = Math.max(0, Math.floor(sy - sr));
            const sx1 = Math.min(w - 1, Math.ceil(sx + sr));
            const sy1 = Math.min(h - 1, Math.ceil(sy + sr));
            if (sx0 < d.x0) d.x0 = sx0;
            if (sy0 < d.y0) d.y0 = sy0;
            if (sx1 > d.x1) d.x1 = sx1;
            if (sy1 > d.y1) d.y1 = sy1;
            for (let py = sy0; py <= sy1; py++) {
                for (let px = sx0; px <= sx1; px++) {
                    const dist = Math.sqrt((px - sx) * (px - sx) + (py - sy) * (py - sy));
                    let a = _dabFalloff(dist, sr, hard) * opacity;
                    if (a <= 0) continue;
                    const idx = py * w + px;
                    if (S.selection.active && S.selection.mask) {
                        a *= S.selection.mask[idx] / 255;
                        if (a <= 0) continue;
                    }
                    const a255 = (a * 255) | 0;
                    if (useSoftBlend) { const b = map[idx] + ((255 - map[idx]) * a255 + 127) / 255; map[idx] = b > ceiling ? Math.max(map[idx], ceiling) : b; } else { if (a255 > map[idx]) map[idx] = a255; }
                }
            }
        }
        return;
    }

    // Custom tip: sample from grayscale image
    if (preset === "custom" && S.customTip.data) {
        const tipW = S.customTip.width, tipH = S.customTip.height;
        const tipData = S.customTip.data;
        const cosA = Math.cos(-ang), sinA = Math.sin(-ang);
        const scaleX = tipW / sz, scaleY = tipH / sz;
        for (let py = y0; py <= y1; py++) {
            for (let px = x0; px <= x1; px++) {
                const dx = px - cx, dy = py - cy;
                const lx = dx * cosA - dy * sinA;
                const ly = dx * sinA + dy * cosA;
                const tx = (lx * scaleX + tipW / 2) | 0;
                const ty = (ly * scaleY + tipH / 2) | 0;
                if (tx < 0 || tx >= tipW || ty < 0 || ty >= tipH) continue;
                const tipAlpha = tipData[ty * tipW + tx] / 255;
                let a = tipAlpha * opacity;
                if (hard < 1.0 && tipAlpha > 0) {
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    a *= _dabFalloff(dist, r, hard);
                }
                if (a <= 0) continue;
                const idx = py * w + px;
                if (S.selection.active && S.selection.mask) {
                    a *= S.selection.mask[idx] / 255;
                    if (a <= 0) continue;
                }
                const a255 = (a * 255) | 0;
                if (useSoftBlend) { const b = map[idx] + ((255 - map[idx]) * a255 + 127) / 255; map[idx] = b > ceiling ? Math.max(map[idx], ceiling) : b; } else { if (a255 > map[idx]) map[idx] = a255; }
            }
        }
        return;
    }

    // Standard shapes (round, flat, marker)
    const density = S.brushDensity || 1.0;
    for (let py = y0; py <= y1; py++) {
        for (let px = x0; px <= x1; px++) {
            // Density skip — randomly omit pixels for stipple/charcoal effect
            if (density < 0.99 && Math.random() > density) continue;
            let normDist;
            switch (preset) {
                case "flat": normDist = shapeDistFlat(px, py, cx, cy, r, ang); break;
                case "marker": normDist = shapeDistMarker(px, py, cx, cy, r, ang); break;
                default: normDist = shapeDistRound(px, py, cx, cy, r); break;
            }
            let a = _dabFalloff(normDist * r, r, hard) * opacity;
            if (a <= 0) continue;
            const idx = py * w + px;
            if (S.selection.active && S.selection.mask) {
                a *= S.selection.mask[idx] / 255;
                if (a <= 0) continue;
            }
            const a255 = (a * 255) | 0;
            if (useSoftBlend) { const b = map[idx] + ((255 - map[idx]) * a255 + 127) / 255; map[idx] = b > ceiling ? Math.max(map[idx], ceiling) : b; } else { if (a255 > map[idx]) map[idx] = a255; }
        }
    }
}

// Convert alpha map → ImageData with a flat color (only processes dirty region)
function alphaMapToImageData(color) {
    const map = S.stroke.alphaMap;
    const w = S.W, h = S.H;
    const d = S.stroke.dirty;
    const img = S.stroke._cachedImg || (S.stroke._cachedImg = new ImageData(w, h));
    if (img.width !== w || img.height !== h) {
        S.stroke._cachedImg = new ImageData(w, h);
        return alphaMapToImageData(color);
    }
    const data = img.data;
    const rgb = hexRgb(color);
    const dx0 = Math.max(0, d.x0), dy0 = Math.max(0, d.y0);
    const dx1 = Math.min(w - 1, d.x1), dy1 = Math.min(h - 1, d.y1);
    for (let py = dy0; py <= dy1; py++) {
        for (let px = dx0; px <= dx1; px++) {
            const i = py * w + px;
            const a = map[i];
            const j = i * 4;
            if (a === 0) { data[j + 3] = 0; continue; }
            data[j]     = rgb.r;
            data[j + 1] = rgb.g;
            data[j + 2] = rgb.b;
            data[j + 3] = a;
        }
    }
    return img;
}

// Cached eraser stamp
let _stampCache = { canvas: null, size: 0, preset: "", col: "", ang: 0 };
function makeStamp(sz, preset, col, ang) {
    const d = Math.max(2, Math.ceil(sz));
    if (_stampCache.canvas && _stampCache.size === d && _stampCache.preset === preset &&
        _stampCache.col === col && Math.abs((_stampCache.ang || 0) - (ang || 0)) < 0.01) {
        return _stampCache.canvas;
    }
    const c = _createCanvas(d, d);
    const x = c.getContext("2d"), rgb = hexRgb(col), cx = d / 2, cy = d / 2, r = d / 2;
    switch (preset) {
        case "round":
            x.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},1)`;
            x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill(); break;
        case "flat":
            x.save(); x.translate(cx, cy); x.rotate(ang || 0);
            x.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},1)`;
            x.beginPath(); x.ellipse(0, 0, r, Math.max(1, r * 0.3), 0, 0, Math.PI * 2); x.fill();
            x.restore(); break;
        case "scatter": {
            const n = Math.max(3, ~~(sz / 3));
            for (let i = 0; i < n; i++) {
                x.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},1)`;
                x.beginPath();
                x.arc(cx + (Math.random() - 0.5) * d * 0.8, cy + (Math.random() - 0.5) * d * 0.8,
                    Math.random() * r * 0.3 + 1, 0, Math.PI * 2);
                x.fill();
            }
            break;
        }
        case "marker":
            x.save(); x.translate(cx, cy); x.rotate(ang || 0.4);
            x.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.85)`;
            x.fillRect(-r * 0.8, -r * 0.35, r * 1.6, r * 0.7);
            x.restore(); break;
    }
    _stampCache = { canvas: c, size: d, preset: preset, col: col, ang: ang };
    return c;
}

// ========================================================================
// STABILIZER
// ========================================================================
function stab(rx, ry, rp) {
    const pts = S.stroke.points;
    pts.push({ x: rx, y: ry, p: rp });
    const w = Math.min(S.smoothing, pts.length);
    let sx = 0, sy = 0, sp = 0;
    for (let i = pts.length - w; i < pts.length; i++) {
        sx += pts[i].x; sy += pts[i].y; sp += pts[i].p;
    }
    return { x: sx / w, y: sy / w, p: sp / w };
}

// ========================================================================
// STROKE ENGINE
// ========================================================================

function stampWet(x, y, p, stampRot) {
    const dyn = S.brushDynamics;
    let sz = Math.max(2, pSz(p)), op = pOp(p);
    if (!S.stroke.alphaMap) return;
    if (dyn.sizeJitter > 0) sz = Math.max(2, sz * (1 + (Math.random() * 2 - 1) * dyn.sizeJitter));
    if (dyn.opacityJitter > 0) op = Math.max(0.01, op * (1 + (Math.random() * 2 - 1) * dyn.opacityJitter));
    let ang = stampRot !== undefined ? stampRot : (dyn.followStroke ? (_saSmooth || 0) : 0.4);
    if (dyn.rotationJitter > 0) ang += (Math.random() * 2 - 1) * Math.PI * dyn.rotationJitter;
    // In Edit > Inpaint: force hard round mask brush
    const savedPreset = S.brushPreset, savedHard = S.brushHardness;
    if (S.editingMask) { S.brushPreset = "round"; S.brushHardness = 1.0; }
    const finalOp = S.editingMask ? 1 : op;
    stampAlphaMap(x, y, sz, finalOp, ang);
    if (S.symmetry === "h" || S.symmetry === "both") stampAlphaMap(S.W - x, y, sz, finalOp, ang);
    if (S.symmetry === "v" || S.symmetry === "both") stampAlphaMap(x, S.H - y, sz, finalOp, ang);
    if (S.symmetry === "both") stampAlphaMap(S.W - x, S.H - y, sz, finalOp, ang);
    if (S.symmetry === "radial") {
        const n = S.symmetryAxes || 4;
        const ccx = S.W / 2, ccy = S.H / 2;
        for (let k = 1; k < n; k++) {
            const a = (2 * Math.PI * k) / n;
            const cos = Math.cos(a), sin = Math.sin(a);
            const rx = ccx + (x - ccx) * cos - (y - ccy) * sin;
            const ry = ccy + (x - ccx) * sin + (y - ccy) * cos;
            stampAlphaMap(rx, ry, sz, finalOp, ang + a);
        }
    }
    if (S.editingMask) { S.brushPreset = savedPreset; S.brushHardness = savedHard; }
}

function stampWetErase(x, y, p) {
    const dyn = S.brushDynamics;
    let sz = Math.max(2, pSz(p));
    let op = pOp(p);
    if (dyn.sizeJitter > 0) sz = Math.max(2, sz * (1 + (Math.random() * 2 - 1) * dyn.sizeJitter));
    if (dyn.opacityJitter > 0) op = Math.max(0.01, op * (1 + (Math.random() * 2 - 1) * dyn.opacityJitter));
    const hardness = S.brushHardness ?? 1;
    const r = sz / 2;
    const ctx = S.stroke.ctx;

    function _eraseAt(ex, ey) {
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        ctx.globalAlpha = op;
        if (hardness >= 0.99) {
            // Hard eraser — solid circle
            ctx.fillStyle = "#fff";
            ctx.beginPath(); ctx.arc(ex, ey, r, 0, Math.PI * 2); ctx.fill();
        } else {
            // Soft eraser — radial gradient for feathered edges
            var grad = ctx.createRadialGradient(ex, ey, r * hardness, ex, ey, r);
            grad.addColorStop(0, "rgba(255,255,255,1)");
            grad.addColorStop(1, "rgba(255,255,255,0)");
            ctx.fillStyle = grad;
            ctx.beginPath(); ctx.arc(ex, ey, r, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
    }

    _eraseAt(x, y);
    if (S.symmetry === "h" || S.symmetry === "both") _eraseAt(S.W - x, y);
    if (S.symmetry === "v" || S.symmetry === "both") _eraseAt(x, S.H - y);
    if (S.symmetry === "both") _eraseAt(S.W - x, S.H - y);
    if (S.symmetry === "radial") {
        const n = S.symmetryAxes || 4;
        const ccx = S.W / 2, ccy = S.H / 2;
        for (let k = 1; k < n; k++) {
            const a = (2 * Math.PI * k) / n;
            const rx = ccx + (x - ccx) * Math.cos(a) - (y - ccy) * Math.sin(a);
            const ry = ccy + (x - ccx) * Math.sin(a) + (y - ccy) * Math.cos(a);
            _eraseAt(rx, ry);
        }
    }
}

function plotTo(x, y, p) {
    const x0 = S.stroke.lx, y0 = S.stroke.ly, p0 = S.stroke.lp;
    const dx = x - x0, dy = y - y0;
    if (Math.hypot(dx, dy) > 2) {
        const raw = Math.atan2(dy, dx);
        const diff = raw - _saSmooth;
        _saSmooth += Math.atan2(Math.sin(diff), Math.cos(diff)) * 0.3;
        _sa = raw;
    }
    const dyn = S.brushDynamics;
    const bpx = brushPx();
    const baseSpacing = Math.max(0.02, dyn.spacing || 0.08);
    const hardness = S.brushHardness ?? 1;
    // Soft brush with source-over accumulation: use Krita-standard 10% spacing
    // Hard/medium brush with max-blend: tighter spacing for smooth coverage
    const spacingFrac = hardness < 0.01 ? 0.10 : baseSpacing * (0.3 + 0.7 * hardness);
    const dist = Math.hypot(dx, dy);
    const sp = Math.max(0.5, bpx * spacingFrac);
    const steps = Math.max(1, Math.ceil(dist / sp));
    const fn = S.tool === "eraser" ? stampWetErase : stampWet;
    const strokeAngle = Math.atan2(dy, dx);
    const perpX = -Math.sin(strokeAngle), perpY = Math.cos(strokeAngle);
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        let sx = x0 + dx * t, sy = y0 + dy * t;
        if (dyn.scatter > 0 && S.tool !== "eraser") {
            const scatterDist = (Math.random() * 2 - 1) * bpx * dyn.scatter;
            sx += perpX * scatterDist;
            sy += perpY * scatterDist;
        }
        const stampP = p0 + (p - p0) * t;
        let stampRot = dyn.followStroke ? _saSmooth : 0.4;
        if (dyn.rotationJitter > 0) stampRot += (Math.random() * 2 - 1) * Math.PI * dyn.rotationJitter;
        fn(sx, sy, stampP, stampRot);
    }
    S.stroke.lx = x; S.stroke.ly = y; S.stroke.lp = p;
}

function beginStroke(x, y, p) {
    S.stroke.ctx.clearRect(0, 0, S.W, S.H);
    S.stroke.stampPoints = [];
    S.stroke.alphaMap = new Uint8Array(S.W * S.H);
    S.stroke.dirty = { x0: S.W, y0: S.H, x1: 0, y1: 0 };
    S.stroke._cachedImg = null;
    // Lock draw target at stroke start so commitStroke can't hit the wrong
    // canvas if editingMask toggles mid-stroke (e.g. Q key, mode switch).
    S.stroke._commitTarget = drawTarget();
    S.stroke._commitMask = S.editingMask;
    if (S.tool === "eraser") {
        S.stroke.ctx.save(); S.stroke.ctx.globalAlpha = 1;
        S.stroke.ctx.drawImage(S.stroke._commitTarget.canvas, 0, 0);
        S.stroke.ctx.restore();
    }
    // Prime stabilizer so first dab uses same pressure pipeline as the rest
    S.stroke.points = [{ x, y, p }];
    S.stroke.lx = x; S.stroke.ly = y; S.stroke.lp = p;
    const fn = S.tool === "eraser" ? stampWetErase : stampWet;
    fn(x, y, p, S.brushDynamics.followStroke ? (_saSmooth || 0) : 0.4);
}

function commitStroke() {
    // Use draw target locked at beginStroke time to prevent layer wipe
    // if editingMask changed mid-stroke.
    const T = S.stroke._commitTarget || drawTarget();
    const wasMask = S.stroke._commitMask != null ? S.stroke._commitMask : S.editingMask;
    if (S.tool === "eraser") {
        if (S.selection.active && S.selection.mask) {
            const orig = T.ctx.getImageData(0, 0, S.W, S.H);
            const erased = S.stroke.ctx.getImageData(0, 0, S.W, S.H);
            const od = orig.data, ed = erased.data, m = S.selection.mask;
            for (let i = 0; i < m.length; i++) {
                const j = i * 4, blend = m[i] / 255;
                od[j]     = Math.round(ed[j] * blend + od[j] * (1 - blend));
                od[j + 1] = Math.round(ed[j + 1] * blend + od[j + 1] * (1 - blend));
                od[j + 2] = Math.round(ed[j + 2] * blend + od[j + 2] * (1 - blend));
                od[j + 3] = Math.round(ed[j + 3] * blend + od[j + 3] * (1 - blend));
            }
            T.ctx.putImageData(orig, 0, 0);
        } else {
            T.ctx.clearRect(0, 0, S.W, S.H);
            T.ctx.drawImage(S.stroke.canvas, 0, 0);
        }
    } else {
        // Brush commit: merge alpha map into target at stroke opacity
        if (S.stroke.alphaMap) {
            const img = alphaMapToImageData(drawColor());
            const d2 = S.stroke.dirty;
            const dx = Math.max(0, d2.x0), dy = Math.max(0, d2.y0);
            const dw = Math.min(S.W, d2.x1 + 1) - dx, dh = Math.min(S.H, d2.y1 + 1) - dy;
            if (dw > 0 && dh > 0) {
                S.stroke.ctx.clearRect(0, 0, S.W, S.H);
                S.stroke.ctx.putImageData(img, 0, 0, dx, dy, dw, dh);
            }
            T.ctx.save();
            T.ctx.globalAlpha = wasMask ? 1 : S.brushOpacity;
            T.ctx.globalCompositeOperation = "source-over";
            T.ctx.drawImage(S.stroke.canvas, 0, 0);
            T.ctx.restore();
        }
    }
    S.stroke.alphaMap = null;
    S.stroke._cachedImg = null;
    S.stroke._commitTarget = null;
    S.stroke._commitMask = null;
    S.stroke.ctx.clearRect(0, 0, S.W, S.H);
    S.drawing = false;
}

// ========================================================================
// SMUDGE
// ========================================================================
function _symPoints(x, y) {
    // Returns array of {x, y} for all symmetry-derived points (including original)
    const pts = [{ x, y }];
    if (S.symmetry === "h" || S.symmetry === "both") pts.push({ x: S.W - x, y });
    if (S.symmetry === "v" || S.symmetry === "both") pts.push({ x, y: S.H - y });
    if (S.symmetry === "both") pts.push({ x: S.W - x, y: S.H - y });
    if (S.symmetry === "radial") {
        const n = S.symmetryAxes || 4;
        const ccx = S.W / 2, ccy = S.H / 2;
        for (let k = 1; k < n; k++) {
            const a = (2 * Math.PI * k) / n;
            pts.push({
                x: ccx + (x - ccx) * Math.cos(a) - (y - ccy) * Math.sin(a),
                y: ccy + (x - ccx) * Math.sin(a) + (y - ccy) * Math.cos(a)
            });
        }
    }
    return pts;
}

function _smudgeInitAt(ctx, x, y) {
    const sz = ~~Math.max(6, brushPx()), r = sz / 2;
    const ix = ~~Math.max(0, x - r), iy = ~~Math.max(0, y - r);
    const ex = ~~Math.min(S.W, x + r), ey = ~~Math.min(S.H, y + r);
    const w = ex - ix, h = ey - iy;
    if (w < 2 || h < 2) return null;
    const s = ctx.getImageData(ix, iy, w, h), d = s.data;
    const cl = x - ix, ct = y - iy;
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
        const dist = Math.hypot(px - cl, py - ct) / r, i = (py * w + px) * 4;
        if (dist > 1) { d[i] = 0; d[i+1] = 0; d[i+2] = 0; d[i + 3] = 0; }
        else if (dist > 0.6) {
            const fade = 1 - (dist - 0.6) / 0.4;
            d[i + 3] = ~~(d[i + 3] * fade);
        }
    }
    return { imageData: s, w, h };
}

function smudgeInit(ctx, x, y) {
    const pts = _symPoints(x, y);
    S.smudgeBuffer = _smudgeInitAt(ctx, pts[0].x, pts[0].y);
    S._smudgeSymBuffers = pts.length > 1 ? pts.slice(1).map(p => _smudgeInitAt(ctx, p.x, p.y)) : null;
}

function _smudgeDragAt(ctx, x, y, p, buffer) {
    if (!buffer) return null;
    const sz = ~~Math.max(6, brushPx()), r = sz / 2;
    const str = S.toolStrength * (S.pressureSensitivity ? Math.max(0.1, p) : 1);
    const ix = ~~Math.max(0, x - r), iy = ~~Math.max(0, y - r);
    const ex = ~~Math.min(S.W, x + r), ey = ~~Math.min(S.H, y + r);
    const w = ex - ix, h = ey - iy;
    if (w < 2 || h < 2) return buffer;
    const under = ctx.getImageData(ix, iy, w, h);
    const bufW = buffer.w, bufH = buffer.h;
    const bd = buffer.imageData.data;
    const ud = under.data;
    const cl = x - ix, ct = y - iy;
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
        const dist = Math.hypot(px - cl, py - ct) / r;
        if (dist > 1) continue;
        const bx = ~~(px * bufW / w), by = ~~(py * bufH / h);
        if (bx < 0 || bx >= bufW || by < 0 || by >= bufH) continue;
        const bi = (by * bufW + bx) * 4;
        if (bd[bi + 3] < 2) continue;
        const i = (py * w + px) * 4;
        const blend = (1 - dist) * str;
        ud[i]     = ud[i] + (bd[bi] - ud[i]) * blend;
        ud[i + 1] = ud[i + 1] + (bd[bi + 1] - ud[i + 1]) * blend;
        ud[i + 2] = ud[i + 2] + (bd[bi + 2] - ud[i + 2]) * blend;
        const blendedA = ud[i + 3] + (bd[bi + 3] - ud[i + 3]) * blend;
        if (blendedA > ud[i + 3]) ud[i + 3] = blendedA;
    }
    ctx.putImageData(under, ix, iy);
    // Refresh buffer
    const ns = ctx.getImageData(ix, iy, w, h), nd = ns.data;
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
        const dist = Math.hypot(px - cl, py - ct) / r, i = (py * w + px) * 4;
        if (dist > 1) { nd[i] = 0; nd[i+1] = 0; nd[i+2] = 0; nd[i + 3] = 0; }
        else if (dist > 0.6) {
            const fade = 1 - (dist - 0.6) / 0.4;
            nd[i + 3] = ~~(nd[i + 3] * fade);
        }
    }
    return { imageData: ns, w, h };
}

function smudgeDrag(ctx, x, y, p) {
    if (!S.smudgeBuffer) return;
    const pts = _symPoints(x, y);
    S.smudgeBuffer = _smudgeDragAt(ctx, pts[0].x, pts[0].y, p, S.smudgeBuffer);
    if (S._smudgeSymBuffers) {
        for (let k = 0; k < S._smudgeSymBuffers.length; k++) {
            const sp = pts[k + 1];
            if (sp) S._smudgeSymBuffers[k] = _smudgeDragAt(ctx, sp.x, sp.y, p, S._smudgeSymBuffers[k]);
        }
    }
}

function smudgeStroke(ctx, x1, y1, x2, y2, p1, p2) {
    const dx = x2 - x1, dy = y2 - y1, dist = Math.hypot(dx, dy);
    const sp = Math.max(2, brushPx() * 0.25);
    const steps = Math.max(1, Math.ceil(dist / sp));
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        smudgeDrag(ctx, x1 + dx * t, y1 + dy * t, p1 + (p2 - p1) * t);
    }
}

// ========================================================================
// BLUR TOOL
// ========================================================================
function blurAt(ctx, x, y, p) {
    const sz = Math.max(6, pSz(p)), r = ~~(sz / 2);
    const ix = ~~Math.max(0, x - r), iy = ~~Math.max(0, y - r);
    const ex = ~~Math.min(S.W, x + r), ey = ~~Math.min(S.H, y + r);
    const w = ex - ix, h = ey - iy;
    if (w < 3 || h < 3) return;
    const img = ctx.getImageData(ix, iy, w, h);
    const d = img.data;
    const out = new Uint8ClampedArray(d.length);
    const kR = Math.max(1, ~~(S.toolStrength * 4));
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
        let rr = 0, gg = 0, bb = 0, aa = 0, cnt = 0;
        for (let ky = -kR; ky <= kR; ky++) for (let kx = -kR; kx <= kR; kx++) {
            const sx2 = px + kx, sy2 = py + ky;
            if (sx2 >= 0 && sx2 < w && sy2 >= 0 && sy2 < h) {
                const si = (sy2 * w + sx2) * 4;
                rr += d[si]; gg += d[si + 1]; bb += d[si + 2]; aa += d[si + 3]; cnt++;
            }
        }
        const di = (py * w + px) * 4;
        out[di] = rr / cnt; out[di + 1] = gg / cnt; out[di + 2] = bb / cnt; out[di + 3] = aa / cnt;
    }
    const cl = w / 2, ct = h / 2;
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
        const dist = Math.hypot(px - cl, py - ct) / r;
        if (dist > 1) continue;
        const b = 1 - dist, di = (py * w + px) * 4;
        d[di] += (out[di] - d[di]) * b;
        d[di + 1] += (out[di + 1] - d[di + 1]) * b;
        d[di + 2] += (out[di + 2] - d[di + 2]) * b;
        d[di + 3] += (out[di + 3] - d[di + 3]) * b;
    }
    ctx.putImageData(img, ix, iy);
}

// ========================================================================
// PIXELATE / CENSOR
// ========================================================================
function pixelateAt(ctx, x, y, p) {
    const sz = Math.max(8, pSz(p)), r = ~~(sz / 2);
    const blockSize = Math.max(4, ~~(sz * Math.max(0.1, S.toolStrength)));
    const ix = ~~Math.max(0, x - r), iy = ~~Math.max(0, y - r);
    const ex = ~~Math.min(S.W, x + r), ey = ~~Math.min(S.H, y + r);
    const w = ex - ix, h = ey - iy;
    if (w < 4 || h < 4) return;
    // Align to global grid so overlapping strokes produce consistent blocks
    const gx0 = ix - (((ix % blockSize) + blockSize) % blockSize);
    const gy0 = iy - (((iy % blockSize) + blockSize) % blockSize);
    const img = ctx.getImageData(ix, iy, w, h);
    const d = img.data;
    const cl = x - ix, ct = y - iy;
    for (let by = gy0; by < ey; by += blockSize) {
        for (let bx = gx0; bx < ex; bx += blockSize) {
            // Check if block center is within brush circle
            const bcx = bx + blockSize / 2, bcy = by + blockSize / 2;
            const dist = Math.hypot(bcx - x, bcy - y) / r;
            if (dist > 1) continue;
            // Average colors in this block
            let rr = 0, gg = 0, bb = 0, aa = 0, cnt = 0;
            for (let py = Math.max(by, iy); py < Math.min(by + blockSize, ey); py++) {
                for (let px = Math.max(bx, ix); px < Math.min(bx + blockSize, ex); px++) {
                    const i = ((py - iy) * w + (px - ix)) * 4;
                    rr += d[i]; gg += d[i + 1]; bb += d[i + 2]; aa += d[i + 3]; cnt++;
                }
            }
            if (cnt === 0) continue;
            rr = ~~(rr / cnt); gg = ~~(gg / cnt); bb = ~~(bb / cnt); aa = ~~(aa / cnt);
            // Fill block with average
            for (let py = Math.max(by, iy); py < Math.min(by + blockSize, ey); py++) {
                for (let px = Math.max(bx, ix); px < Math.min(bx + blockSize, ex); px++) {
                    const i = ((py - iy) * w + (px - ix)) * 4;
                    d[i] = rr; d[i + 1] = gg; d[i + 2] = bb; d[i + 3] = aa;
                }
            }
        }
    }
    ctx.putImageData(img, ix, iy);
}

// ========================================================================
// DODGE / BURN
// ========================================================================
function dodgeBurnAt(ctx, x, y, p) {
    const sz = Math.max(6, pSz(p)), r = ~~(sz / 2);
    const str = S.toolStrength * (S.pressureSensitivity ? Math.max(0.1, p) : 1);
    const ix = ~~Math.max(0, x - r), iy = ~~Math.max(0, y - r);
    const ex = ~~Math.min(S.W, x + r), ey = ~~Math.min(S.H, y + r);
    const w = ex - ix, h = ey - iy;
    if (w < 2 || h < 2) return;
    const img = ctx.getImageData(ix, iy, w, h), d = img.data;
    const isDodge = S._dodgeMode === "dodge";
    const cl = x - ix, ct = y - iy, hard = S.brushHardness;
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
        const dist = Math.hypot(px - cl, py - ct) / r;
        if (dist > 1) continue;
        const innerR = hard;
        let falloff = 1;
        if (dist > innerR && innerR < 1) falloff = 1 - (dist - innerR) / (1 - innerR);
        const amount = str * falloff * 0.012;
        const i = (py * w + px) * 4;
        if (d[i + 3] < 2) continue;
        if (isDodge) {
            d[i]     = Math.min(255, d[i] + amount * (255 - d[i]));
            d[i + 1] = Math.min(255, d[i + 1] + amount * (255 - d[i + 1]));
            d[i + 2] = Math.min(255, d[i + 2] + amount * (255 - d[i + 2]));
        } else {
            d[i]     = Math.max(0, d[i] - amount * d[i]);
            d[i + 1] = Math.max(0, d[i + 1] - amount * d[i + 1]);
            d[i + 2] = Math.max(0, d[i + 2] - amount * d[i + 2]);
        }
    }
    ctx.putImageData(img, ix, iy);
}

function dodgeBurnStroke(ctx, x1, y1, x2, y2, p) {
    const dx = x2 - x1, dy = y2 - y1, dist = Math.hypot(dx, dy);
    const sp = Math.max(1, brushPx() * 0.08);
    const steps = Math.max(1, Math.ceil(dist / sp));
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        dodgeBurnAt(ctx, x1 + dx * t, y1 + dy * t, p);
    }
}

// ========================================================================
// LIQUIFY
// ========================================================================
function liquifyPush(ctx, cx, cy, dx, dy, pressure) {
    const sz = Math.max(8, pSz(pressure));
    const r = sz / 2;
    const str = S.toolStrength * 0.25 * (S.pressureSensitivity ? Math.max(0.1, pressure) : 1);
    const hard = S.brushHardness;
    const pad = Math.ceil(Math.hypot(dx, dy) * str) + 4;
    const ix = Math.max(0, Math.floor(cx - r - pad));
    const iy = Math.max(0, Math.floor(cy - r - pad));
    const ex = Math.min(S.W, Math.ceil(cx + r + pad));
    const ey = Math.min(S.H, Math.ceil(cy + r + pad));
    const w = ex - ix, h = ey - iy;
    if (w < 4 || h < 4) return;
    const src = ctx.getImageData(ix, iy, w, h);
    const dst = new ImageData(new Uint8ClampedArray(src.data), w, h);
    const sd = src.data, dd = dst.data;
    const mode = S.liquifyMode || "move";

    for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
            const worldX = px + ix, worldY = py + iy;
            const distFromCenter = Math.hypot(worldX - cx, worldY - cy);
            if (distFromCenter >= r) continue;
            const innerR = r * hard;
            let falloff = 1;
            if (distFromCenter > innerR && innerR < r) {
                falloff = 1 - (distFromCenter - innerR) / (r - innerR);
            }
            const weight = falloff * str;

            // Compute displacement based on mode
            let dispX, dispY;
            if (mode === "move") {
                dispX = dx * weight;
                dispY = dy * weight;
            } else if (mode === "pinch") {
                // Pull toward brush center
                const toX = cx - worldX, toY = cy - worldY;
                dispX = toX * weight * 0.15;
                dispY = toY * weight * 0.15;
            } else if (mode === "bloat") {
                // Push away from brush center
                const awayX = worldX - cx, awayY = worldY - cy;
                const d = Math.max(distFromCenter, 0.001);
                dispX = (awayX / d) * weight * r * 0.08;
                dispY = (awayY / d) * weight * r * 0.08;
            } else if (mode === "twirl_cw" || mode === "twirl_ccw") {
                // Rotate around brush center
                const relX = worldX - cx, relY = worldY - cy;
                const angle = weight * 0.3 * (mode === "twirl_ccw" ? -1 : 1);
                const cos = Math.cos(angle), sin = Math.sin(angle);
                dispX = (relX * cos - relY * sin) - relX;
                dispY = (relX * sin + relY * cos) - relY;
            } else {
                dispX = dx * weight;
                dispY = dy * weight;
            }

            // Bilinear sample from displaced source position
            const srcPxF = px - dispX;
            const srcPyF = py - dispY;
            const sx0 = Math.floor(srcPxF), sy0 = Math.floor(srcPyF);
            const fx = srcPxF - sx0, fy = srcPyF - sy0;
            const sx1 = sx0 + 1, sy1 = sy0 + 1;
            if (sx0 < 0 || sy0 < 0 || sx1 >= w || sy1 >= h) continue;
            const i00 = (sy0 * w + sx0) * 4;
            const i10 = (sy0 * w + sx1) * 4;
            const i01 = (sy1 * w + sx0) * 4;
            const i11 = (sy1 * w + sx1) * 4;
            const di = (py * w + px) * 4;
            for (let ch = 0; ch < 4; ch++) {
                const v = sd[i00 + ch] * (1 - fx) * (1 - fy) + sd[i10 + ch] * fx * (1 - fy) +
                          sd[i01 + ch] * (1 - fx) * fy + sd[i11 + ch] * fx * fy;
                dd[di + ch] = Math.round(v);
            }
        }
    }
    ctx.putImageData(dst, ix, iy);
}

// ========================================================================
// CLONE STAMP
// ========================================================================
function cloneStamp(x, y, p) {
    if (!S._cloneSource || !S._cloneOffset) return;
    const T = drawTarget();
    const sz = pSz(p), r = sz / 2;
    const srcX = x + S._cloneOffset.dx, srcY = y + S._cloneOffset.dy;
    // Composite visible layers for source sampling
    const tc = getTempCanvas("cloneSrc", S.W, S.H);
    const tctx = tc.getContext("2d");
    for (const L of S.layers) {
        if (L.visible && L.canvas) { tctx.globalAlpha = L.opacity; tctx.drawImage(L.canvas, 0, 0); }
    }
    const stamp = getTempCanvas("cloneStamp", Math.ceil(sz), Math.ceil(sz));
    const sctx = stamp.getContext("2d");
    sctx.save();
    sctx.beginPath(); sctx.arc(r, r, r, 0, Math.PI * 2); sctx.clip();
    sctx.drawImage(tc, srcX - r, srcY - r, sz, sz, 0, 0, sz, sz);
    sctx.restore();
    if (S.brushHardness < 1) {
        const sd = sctx.getImageData(0, 0, Math.ceil(sz), Math.ceil(sz));
        for (let py = 0; py < sd.height; py++) for (let px = 0; px < sd.width; px++) {
            const dist = Math.hypot(px - r, py - r);
            const a = _dabFalloff(dist, r, S.brushHardness);
            sd.data[(py * sd.width + px) * 4 + 3] = Math.round(sd.data[(py * sd.width + px) * 4 + 3] * a);
        }
        sctx.putImageData(sd, 0, 0);
    }
    T.ctx.save(); T.ctx.globalAlpha = pOp(p);
    T.ctx.drawImage(stamp, x - r, y - r);
    T.ctx.restore();
}

// ========================================================================
// FLOOD FILL
// ========================================================================
function floodFill(pt) {
    const T = drawTarget(), ctx = T.ctx, w = S.W, h = S.H;
    const sx = ~~pt.x, sy = ~~pt.y;
    if (sx < 0 || sx >= w || sy < 0 || sy >= h) return;
    if (S.selection.active && S.selection.mask && S.selection.mask[sy * w + sx] === 0) return;
    const img = ctx.getImageData(0, 0, w, h), d = img.data;
    const idx = (sy * w + sx) * 4;
    const tR = d[idx], tG = d[idx + 1], tB = d[idx + 2], tA = d[idx + 3];
    const fc = hexRgb(drawColor()), fA = ~~(S.brushOpacity * 255);
    if (tR === fc.r && tG === fc.g && tB === fc.b && tA === fA) return;
    const tol = 32, stack = [sx, sy], vis = new Uint8Array(w * h);
    const sel = S.selection.active ? S.selection.mask : null;
    while (stack.length) {
        const cy2 = stack.pop(), cx2 = stack.pop();
        const ci = cy2 * w + cx2;
        if (vis[ci]) continue;
        if (sel && sel[ci] === 0) continue;
        const pi = ci * 4;
        if (Math.abs(d[pi] - tR) > tol || Math.abs(d[pi + 1] - tG) > tol ||
            Math.abs(d[pi + 2] - tB) > tol || Math.abs(d[pi + 3] - tA) > tol) continue;
        vis[ci] = 1;
        d[pi] = fc.r; d[pi + 1] = fc.g; d[pi + 2] = fc.b; d[pi + 3] = fA;
        if (cx2 > 0) stack.push(cx2 - 1, cy2);
        if (cx2 < w - 1) stack.push(cx2 + 1, cy2);
        if (cy2 > 0) stack.push(cx2, cy2 - 1);
        if (cy2 < h - 1) stack.push(cx2, cy2 + 1);
    }
    ctx.putImageData(img, 0, 0);
}

// ========================================================================
// GRADIENT
// ========================================================================
function drawGradient(start, end, mode) {
    const T = drawTarget();
    const col = drawColor(), rgb = hexRgb(col);
    T.ctx.save();
    let grad;
    if (mode === "radial") {
        const r = Math.hypot(end.x - start.x, end.y - start.y);
        grad = T.ctx.createRadialGradient(start.x, start.y, 0, start.x, start.y, r);
    } else {
        grad = T.ctx.createLinearGradient(start.x, start.y, end.x, end.y);
    }
    grad.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},${S.brushOpacity})`);
    grad.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
    if (S.selection.active && S.selection.mask) {
        const tc = getTempCanvas("gradientMask", S.W, S.H);
        const tctx = tc.getContext("2d");
        tctx.fillStyle = grad;
        tctx.fillRect(0, 0, S.W, S.H);
        const gd = tctx.getImageData(0, 0, S.W, S.H);
        for (let i = 0; i < S.selection.mask.length; i++) {
            if (S.selection.mask[i] === 0) gd.data[i * 4 + 3] = 0;
            else gd.data[i * 4 + 3] = Math.round(gd.data[i * 4 + 3] * S.selection.mask[i] / 255);
        }
        tctx.putImageData(gd, 0, 0);
        T.ctx.drawImage(tc, 0, 0);
    } else {
        T.ctx.fillStyle = grad;
        T.ctx.fillRect(0, 0, S.W, S.H);
    }
    T.ctx.restore();
}

// ========================================================================
// SHAPE DRAWING
// ========================================================================
function drawShapePath(ctx, mode, x1, y1, x2, y2, filled) {
    if (mode === "line") {
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    } else if (mode === "ellipse") {
        const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
        const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
        ctx.beginPath(); ctx.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
        if (filled) ctx.fill(); else ctx.stroke();
    } else {
        const x = Math.min(x1, x2), y = Math.min(y1, y2);
        const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
        if (filled) ctx.fillRect(x, y, w, h); else ctx.strokeRect(x, y, w, h);
    }
}

function commitShape(start, end, mode, filled) {
    const T = drawTarget(), col = drawColor();
    T.ctx.save();
    T.ctx.strokeStyle = col; T.ctx.fillStyle = col;
    T.ctx.lineWidth = brushPx();
    T.ctx.globalAlpha = S.brushOpacity;
    drawShapePath(T.ctx, mode, start.x, start.y, end.x, end.y, filled);
    T.ctx.restore();
}

// ========================================================================
// EYEDROPPER
// ========================================================================
function pickColor(pt) {
    const radius = S.sampleRadius || 1;
    const merged = S.sampleMerged || false;

    if (merged) {
        // Sample from composited visible layers
        const tmp = _createCanvas(S.W, S.H);
        const tc = tmp.getContext("2d");
        for (let i = 0; i < S.layers.length; i++) {
            const L = S.layers[i];
            if (!L.visible || !L.canvas) continue;
            tc.globalAlpha = L.opacity ?? 1;
            tc.globalCompositeOperation = L.blendMode && _blendToPS[L.blendMode] ? L.blendMode : "source-over";
            tc.drawImage(L.canvas, 0, 0);
        }
        tc.globalAlpha = 1; tc.globalCompositeOperation = "source-over";
        const avg = _sampleAverage(tc, pt.x, pt.y, radius);
        S.color = rgbHex(avg[0], avg[1], avg[2]);
    } else {
        // Sample from topmost visible layer with content
        let src = null;
        for (let i = S.layers.length - 1; i >= 0; i--) {
            const L = S.layers[i];
            if (!L.visible || !L.canvas) continue;
            const px = L.ctx.getImageData(~~pt.x, ~~pt.y, 1, 1).data;
            if (px[3] > 10) {
                src = _sampleAverage(L.ctx, pt.x, pt.y, radius);
                break;
            }
        }
        if (!src) src = _sampleAverage(S.layers[0].ctx, pt.x, pt.y, radius);
        S.color = rgbHex(src[0], src[1], src[2]);
    }
    addColor(S.color);
}

function _sampleAverage(ctx, cx, cy, radius) {
    if (radius <= 1) {
        const d = ctx.getImageData(~~cx, ~~cy, 1, 1).data;
        return [d[0], d[1], d[2]];
    }
    const r = Math.floor(radius / 2);
    const x0 = Math.max(0, ~~cx - r), y0 = Math.max(0, ~~cy - r);
    const sz = radius;
    const data = ctx.getImageData(x0, y0, sz, sz).data;
    let rr = 0, gg = 0, bb = 0, count = 0;
    const cr = sz / 2;
    for (let py = 0; py < sz; py++) {
        for (let px = 0; px < sz; px++) {
            // Circular sample area
            if (Math.hypot(px - cr + 0.5, py - cr + 0.5) > cr) continue;
            const idx = (py * sz + px) * 4;
            if (data[idx + 3] < 10) continue; // skip transparent
            rr += data[idx]; gg += data[idx + 1]; bb += data[idx + 2];
            count++;
        }
    }
    if (count === 0) return [0, 0, 0];
    return [Math.round(rr / count), Math.round(gg / count), Math.round(bb / count)];
}

// ========================================================================
// COLOR HISTORY
// ========================================================================
function addColor(hex) {
    hex = hex.toLowerCase();
    S.colorHistory = S.colorHistory.filter(c => c !== hex);
    S.colorHistory.unshift(hex);
    if (S.colorHistory.length > 10) S.colorHistory.pop();
}

// ========================================================================
// ZOOM / PAN
// ========================================================================
function zoomAt(screenX, screenY, factor) {
    const z = S.zoom;
    if (!S.canvas) return;
    const r = S.canvas.getBoundingClientRect();
    const ex = (screenX - r.left) / r.width * S.canvas.width;
    const ey = (screenY - r.top) / r.height * S.canvas.height;
    const newScale = Math.min(16, Math.max(0.1, z.scale * factor));
    z.ox = ex - (ex - z.ox) / z.scale * newScale;
    z.oy = ey - (ey - z.oy) / z.scale * newScale;
    z.scale = newScale;
}

function zoomFit() {
    if (!S.canvas) return;
    const cw = S.canvas.width, ch = S.canvas.height;
    if (!cw || !ch || !S.W || !S.H) {
        S.zoom.scale = 1; S.zoom.ox = 0; S.zoom.oy = 0; return;
    }
    const sx = cw / S.W, sy = ch / S.H;
    const scale = Math.min(sx, sy) * 0.9;
    S.zoom.scale = scale;
    S.zoom.ox = (cw - S.W * scale) / 2;
    S.zoom.oy = (ch - S.H * scale) / 2;
}

// Screen coordinates → document coordinates
function screenToDoc(screenX, screenY) {
    const z = S.zoom;
    if (!S.canvas) return { x: 0, y: 0 };
    const r = S.canvas.getBoundingClientRect();
    const canvasX = (screenX - r.left) / r.width * S.canvas.width;
    const canvasY = (screenY - r.top) / r.height * S.canvas.height;
    return {
        x: (canvasX - z.ox) / z.scale,
        y: (canvasY - z.oy) / z.scale
    };
}

// ========================================================================
// UNDO / REDO
// ========================================================================
function _undoTarget() {
    if (S.editingMask) return { ctx: S.mask.ctx, id: "mask" };
    const L = activeLayer();
    return { ctx: L.ctx, id: L.id };
}

function _undoResolve(id) {
    if (id === "mask") return S.mask.ctx;
    const L = S.layers.find(l => l.id === id);
    return L ? L.ctx : null;
}

function _inferActionLabel() {
    const labels = {
        brush: "Brush stroke", eraser: "Erase", smudge: "Smudge", blur: "Blur",
        fill: "Fill", gradient: "Gradient", shape: "Shape", text: "Text",
        clone: "Clone stamp", dodge: "Dodge/Burn", liquify: "Liquify",
        eyedropper: "Eyedropper", select: "Select", lasso: "Lasso",
        transform: "Transform", crop: "Crop"
    };
    return labels[S.tool] || "Paint";
}

function saveUndo(label) {
    S._canvasDirty = true;
    if (S.regionMode && activeRegion()) {
        const r = activeRegion();
        S.undoStack.push({
            type: "region", regionId: r.id,
            data: r.ctx.getImageData(0, 0, S.W, S.H),
            label: label || "Region paint"
        });
        if (S.undoStack.length > S.maxUndo) S.undoStack.shift();
        S.redoStack = [];
        return;
    }
    const t = _undoTarget();
    S.undoStack.push({
        type: "pixel", layerId: t.id,
        data: t.ctx.getImageData(0, 0, S.W, S.H),
        label: label || _inferActionLabel()
    });
    if (S.undoStack.length > S.maxUndo) S.undoStack.shift();
    S.redoStack = [];
}

function saveStructuralUndo(label) {
    S._canvasDirty = true;
    const snapshot = {
        type: "structural",
        label: label || "Layer change",
        layers: S.layers.map(L => {
            if (L.type === "adjustment") {
                return {
                    id: L.id, name: L.name, type: L.type,
                    adjustType: L.adjustType,
                    adjustParams: JSON.parse(JSON.stringify(L.adjustParams || {})),
                    visible: L.visible, opacity: L.opacity,
                    blendMode: L.blendMode, locked: L.locked, data: null
                };
            }
            return {
                id: L.id, name: L.name, type: L.type,
                visible: L.visible, opacity: L.opacity,
                blendMode: L.blendMode, locked: L.locked,
                data: L.ctx.getImageData(0, 0, S.W, S.H)
            };
        }),
        activeIdx: S.activeLayerIdx, editingMask: S.editingMask,
        maskData: S.mask.ctx.getImageData(0, 0, S.W, S.H),
        canvasW: S.W, canvasH: S.H
    };
    S.undoStack.push(snapshot);
    if (S.undoStack.length > S.maxUndo) S.undoStack.shift();
    S.redoStack = [];
}

// onUndoRedo: callback for UI layer to re-render panels
// Set by canvas-ui.js via StudioCore.onUndoRedo = fn
let _onUndoRedo = null;

function _restoreStructural(entry) {
    if (entry.canvasW && entry.canvasH && (entry.canvasW !== S.W || entry.canvasH !== S.H)) {
        S.W = entry.canvasW; S.H = entry.canvasH;
        S.stroke.canvas.width = S.W; S.stroke.canvas.height = S.H;
        S.mask.canvas.width = S.W; S.mask.canvas.height = S.H;
        S.mask.ctx = S.mask.canvas.getContext("2d");
    }
    if (entry.maskData) S.mask.ctx.putImageData(entry.maskData, 0, 0);
    S.layers = [];
    for (const ld of entry.layers) {
        if (ld.type === "adjustment") {
            const L = makeAdjustLayer(ld.name, ld.adjustType, JSON.parse(JSON.stringify(ld.adjustParams || {})));
            L.id = ld.id; L.visible = ld.visible; L.opacity = ld.opacity;
            L.blendMode = ld.blendMode; L.locked = ld.locked;
            L._lutCache = null;
            S.layers.push(L);
        } else {
            const c = createLayerCanvas(); const ctx = c.getContext("2d");
            if (ld.data) ctx.putImageData(ld.data, 0, 0);
            S.layers.push({
                id: ld.id, name: ld.name, type: ld.type, canvas: c, ctx: ctx,
                visible: ld.visible, opacity: ld.opacity, blendMode: ld.blendMode, locked: ld.locked
            });
        }
    }
    S.nextLayerId = Math.max(...S.layers.map(l => l.id)) + 1;
    S.activeLayerIdx = entry.activeIdx;
    S.editingMask = entry.editingMask;
}

function _captureStructural() {
    return {
        type: "structural",
        layers: S.layers.map(L => {
            if (L.type === "adjustment") {
                return {
                    id: L.id, name: L.name, type: L.type,
                    adjustType: L.adjustType,
                    adjustParams: JSON.parse(JSON.stringify(L.adjustParams || {})),
                    visible: L.visible, opacity: L.opacity,
                    blendMode: L.blendMode, locked: L.locked, data: null
                };
            }
            return {
                id: L.id, name: L.name, type: L.type,
                visible: L.visible, opacity: L.opacity,
                blendMode: L.blendMode, locked: L.locked,
                data: L.ctx.getImageData(0, 0, S.W, S.H)
            };
        }),
        activeIdx: S.activeLayerIdx, editingMask: S.editingMask,
        maskData: S.mask.ctx.getImageData(0, 0, S.W, S.H),
        canvasW: S.W, canvasH: S.H
    };
}

function undo() {
    if (!S.undoStack.length) return;
    if (S.transform.active) { S.transform.active = false; S.transform.canvas = null; S.transform.flipH = false; S.transform.flipV = false; }
    const e = S.undoStack.pop();
    if (e.type === "structural") {
        S.redoStack.push(_captureStructural());
        _restoreStructural(e);
    } else if (e.type === "region") {
        const r = S.regions.find(rr => rr.id === e.regionId);
        if (r) {
            S.redoStack.push({ type: "region", regionId: e.regionId, data: r.ctx.getImageData(0, 0, S.W, S.H), label: e.label });
            r.ctx.putImageData(e.data, 0, 0);
        }
    } else {
        const ctx = _undoResolve(e.layerId);
        if (!ctx) return;
        S.redoStack.push({ type: "pixel", layerId: e.layerId, data: ctx.getImageData(0, 0, S.W, S.H), label: e.label });
        ctx.putImageData(e.data, 0, 0);
    }
    if (_onUndoRedo) _onUndoRedo();
}

function redo() {
    if (!S.redoStack.length) return;
    const e = S.redoStack.pop();
    if (e.type === "structural") {
        S.undoStack.push(_captureStructural());
        _restoreStructural(e);
    } else if (e.type === "region") {
        const r = S.regions.find(rr => rr.id === e.regionId);
        if (r) {
            S.undoStack.push({ type: "region", regionId: e.regionId, data: r.ctx.getImageData(0, 0, S.W, S.H), label: e.label });
            r.ctx.putImageData(e.data, 0, 0);
        }
    } else {
        const ctx = _undoResolve(e.layerId);
        if (!ctx) return;
        S.undoStack.push({ type: "pixel", layerId: e.layerId, data: ctx.getImageData(0, 0, S.W, S.H), label: e.label });
        ctx.putImageData(e.data, 0, 0);
    }
    if (_onUndoRedo) _onUndoRedo();
}

// ========================================================================
// SELECTION ALGORITHMS
// ========================================================================

// Scanline polygon fill into mask buffer
function fillPolygonMask(pts, mask, w, h) {
    let yMin = h, yMax = 0;
    for (const p of pts) { if (p.y < yMin) yMin = p.y; if (p.y > yMax) yMax = p.y; }
    yMin = Math.max(0, Math.floor(yMin));
    yMax = Math.min(h - 1, Math.ceil(yMax));
    for (let y = yMin; y <= yMax; y++) {
        const intersections = [];
        for (let i = 0; i < pts.length; i++) {
            const j = (i + 1) % pts.length;
            const y0 = pts[i].y, y1 = pts[j].y;
            if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
                const t = (y - y0) / (y1 - y0);
                intersections.push(pts[i].x + t * (pts[j].x - pts[i].x));
            }
        }
        intersections.sort((a, b) => a - b);
        for (let i = 0; i < intersections.length - 1; i += 2) {
            const xStart = Math.max(0, Math.ceil(intersections[i]));
            const xEnd = Math.min(w - 1, Math.floor(intersections[i + 1]));
            for (let x = xStart; x <= xEnd; x++) mask[y * w + x] = 255;
        }
    }
}

// Magic wand — flood-fill selection by color similarity
function magicWandSelect(pt) {
    const tolerance = S.toolStrength * 50;
    const tc = _createCanvas(S.W, S.H);
    const tctx = tc.getContext("2d");
    for (const L of S.layers) {
        if (L.visible && L.canvas) { tctx.globalAlpha = L.opacity; tctx.drawImage(L.canvas, 0, 0); }
    }
    const img = tctx.getImageData(0, 0, S.W, S.H);
    const d = img.data, w = S.W, h = S.H;
    const sx = ~~pt.x, sy = ~~pt.y;
    if (sx < 0 || sx >= w || sy < 0 || sy >= h) return null;
    const idx = (sy * w + sx) * 4;
    const tR = d[idx], tG = d[idx + 1], tB = d[idx + 2], tA = d[idx + 3];
    const mask = new Uint8Array(w * h);
    const visited = new Uint8Array(w * h);
    const stack = [sx, sy];
    const tolSq = tolerance * tolerance * 3;
    while (stack.length) {
        const cy2 = stack.pop(), cx2 = stack.pop();
        if (cx2 < 0 || cx2 >= w || cy2 < 0 || cy2 >= h) continue;
        const ci = cy2 * w + cx2;
        if (visited[ci]) continue;
        visited[ci] = 1;
        const pi = ci * 4;
        const dr = d[pi] - tR, dg = d[pi + 1] - tG, db = d[pi + 2] - tB;
        if (dr * dr + dg * dg + db * db > tolSq) continue;
        if (Math.abs(d[pi + 3] - tA) > tolerance) continue;
        mask[ci] = 255;
        stack.push(cx2 + 1, cy2); stack.push(cx2 - 1, cy2);
        stack.push(cx2, cy2 + 1); stack.push(cx2, cy2 - 1);
    }
    // Compute bounding rect
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    let hasSelection = false;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (mask[y * w + x] > 0) {
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
            hasSelection = true;
        }
    }
    if (!hasSelection) return null;
    return { mask, rect: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
}

// Selection modification (add/subtract)
function selectionModify(newMask, mode) {
    if (mode === "add" && S.selection.mask) {
        for (let i = 0; i < newMask.length; i++) {
            if (newMask[i] > S.selection.mask[i]) S.selection.mask[i] = newMask[i];
        }
    } else if (mode === "subtract" && S.selection.mask) {
        for (let i = 0; i < S.selection.mask.length; i++) {
            if (newMask[i] > 0) S.selection.mask[i] = 0;
        }
    } else {
        S.selection.mask = newMask;
    }
    // Recalculate bounding rect
    const w = S.W, h = S.H, m = S.selection.mask;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (m[y * w + x] > 0) {
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
    }
    S.selection.rect = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    S.selection.active = true;
}

// Feather selection (3-pass box blur approximation of Gaussian)
function featherSelection(radius) {
    if (!S.selection.active || !S.selection.mask || !radius || radius < 1) return;
    const w = S.W, h = S.H;
    const src = S.selection.mask;
    const dst = new Uint8Array(w * h);
    const tmp = new Uint8Array(w * h);
    for (let pass = 0; pass < 3; pass++) {
        const input = pass === 0 ? src : (pass % 2 === 1 ? dst : tmp);
        const output = pass % 2 === 1 ? tmp : dst;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let sum = 0, cnt = 0;
                for (let kx = -radius; kx <= radius; kx++) {
                    const sx2 = x + kx;
                    if (sx2 >= 0 && sx2 < w) { sum += input[y * w + sx2]; cnt++; }
                }
                output[y * w + x] = (sum / cnt) | 0;
            }
        }
        const buf = new Uint8Array(w * h);
        for (let x2 = 0; x2 < w; x2++) {
            for (let y2 = 0; y2 < h; y2++) {
                let sum = 0, cnt = 0;
                for (let ky = -radius; ky <= radius; ky++) {
                    const sy2 = y2 + ky;
                    if (sy2 >= 0 && sy2 < h) { sum += output[sy2 * w + x2]; cnt++; }
                }
                buf[y2 * w + x2] = (sum / cnt) | 0;
            }
        }
        if (pass < 2) { for (let i = 0; i < w * h; i++) dst[i] = buf[i]; }
        else { S.selection.mask = buf; }
    }
    S.selection._isMaskBased = true;
}

// Selection operations
function selectionFill() {
    if (!S.selection.active || !S.selection.mask) return;
    const T = drawTarget(), ctx = T.ctx;
    const rgb = hexRgb(drawColor());
    const img = ctx.getImageData(0, 0, S.W, S.H);
    const d = img.data, mask = S.selection.mask;
    const fA = Math.round(S.brushOpacity * 255);
    for (let i = 0; i < mask.length; i++) {
        if (mask[i] === 0) continue;
        const j = i * 4, blend = mask[i] / 255;
        d[j]     = Math.round(rgb.r * blend + d[j] * (1 - blend));
        d[j + 1] = Math.round(rgb.g * blend + d[j + 1] * (1 - blend));
        d[j + 2] = Math.round(rgb.b * blend + d[j + 2] * (1 - blend));
        d[j + 3] = Math.max(d[j + 3], Math.round(fA * blend));
    }
    ctx.putImageData(img, 0, 0);
}

function selectionDelete() {
    if (!S.selection.active || !S.selection.mask) return;
    const T = drawTarget(), ctx = T.ctx;
    const img = ctx.getImageData(0, 0, S.W, S.H);
    const d = img.data, mask = S.selection.mask;
    for (let i = 0; i < mask.length; i++) {
        if (mask[i] === 0) continue;
        d[i * 4 + 3] = Math.round(d[i * 4 + 3] * (1 - mask[i] / 255));
    }
    ctx.putImageData(img, 0, 0);
}

function selectionInvert() {
    if (!S.selection.active || !S.selection.mask) return;
    for (let i = 0; i < S.selection.mask.length; i++) S.selection.mask[i] = 255 - S.selection.mask[i];
    S.selection.rect = { x: 0, y: 0, w: S.W, h: S.H };
}

function selectionAll() {
    S.selection.rect = { x: 0, y: 0, w: S.W, h: S.H };
    S.selection.mask = new Uint8Array(S.W * S.H);
    S.selection.mask.fill(255);
    S.selection.active = true;
}

function selectionClear() {
    S.selection.active = false;
    S.selection.rect = null;
    S.selection.mask = null;
    S.selection.dragging = false;
    S.selection._isLasso = false;
    S.selection._isEllipse = false;
    S.selection._isMaskBased = false;
    S.selection._contour = null;
    S.selection.lassoPoints = null;
}

function selectionToMask() {
    if (!S.selection.active || !S.selection.mask) return;
    const ctx = S.mask.ctx;
    const img = ctx.getImageData(0, 0, S.W, S.H);
    const d = img.data, mask = S.selection.mask;
    for (let i = 0; i < mask.length; i++) {
        if (mask[i] === 0) continue;
        const j = i * 4;
        d[j] = 255; d[j + 1] = 0; d[j + 2] = 0;
        d[j + 3] = Math.max(d[j + 3], mask[i]);
    }
    ctx.putImageData(img, 0, 0);
    S.mask.visible = true;
}

// Clipboard
function selectionCopy() {
    if (!S.selection.active || !S.selection.mask) return;
    const T = drawTarget(), ctx = T.ctx;
    const img = ctx.getImageData(0, 0, S.W, S.H);
    const d = img.data, mask = S.selection.mask;
    const copy = new ImageData(S.W, S.H);
    const cd = copy.data;
    for (let i = 0; i < mask.length; i++) {
        const j = i * 4;
        if (mask[i] > 0) {
            cd[j] = d[j]; cd[j + 1] = d[j + 1]; cd[j + 2] = d[j + 2];
            cd[j + 3] = Math.round(d[j + 3] * mask[i] / 255);
        }
    }
    S.clipboard = { data: copy, rect: S.selection.rect ? { ...S.selection.rect } : { x: 0, y: 0, w: S.W, h: S.H } };
}

function selectionCut() {
    if (!S.selection.active || !S.selection.mask) return;
    selectionCopy();
    selectionDelete();
}

function selectionPaste() {
    if (!S.clipboard) return;
    const newL = makeLayer("Pasted", "paint");
    newL.ctx.putImageData(S.clipboard.data, 0, 0);
    S.layers.splice(S.activeLayerIdx + 1, 0, newL);
    S.activeLayerIdx = S.activeLayerIdx + 1;
    S.editingMask = false;
    selectionClear();
}

// ========================================================================
// TRANSFORM DATA MODEL
// ========================================================================
const HANDLE_SIZE = 8;

function getLayerContentBounds(L) {
    const img = L.ctx.getImageData(0, 0, S.W, S.H);
    const d = img.data;
    let x0 = S.W, y0 = S.H, x1 = 0, y1 = 0, hasContent = false;
    for (let y = 0; y < S.H; y++) for (let x = 0; x < S.W; x++) {
        if (d[(y * S.W + x) * 4 + 3] > 0) {
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
            hasContent = true;
        }
    }
    return hasContent ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null;
}

function transformHitTest(px, py) {
    if (!S.transform.active || !S.transform.bounds) return null;
    const b = S.transform.bounds;
    const hs = HANDLE_SIZE / S.zoom.scale;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const rot = S.transform.rotation || 0;
    const skX = S.transform.skewX || 0, skY = S.transform.skewY || 0;

    // Transform mouse point into local (un-rotated, un-skewed) space
    let lx = px - cx, ly = py - cy;
    // Inverse rotate
    const cosR = Math.cos(-rot), sinR = Math.sin(-rot);
    const rx = lx * cosR - ly * sinR;
    const ry = lx * sinR + ly * cosR;
    // Inverse skew: inverse of [1, skX; skY, 1] = [1, -skX; -skY, 1] / det
    const det = 1 - skX * skY;
    lx = (rx - skX * ry) / det;
    ly = (-skY * rx + ry) / det;

    // Rotation handle — above top edge in local space
    const rhY = -b.h / 2 - 25 / S.zoom.scale;
    if (Math.abs(lx) <= hs * 1.5 && Math.abs(ly - rhY) <= hs * 1.5) return "rotate";

    // Corner handles (in local space, centered)
    const corners = [
        { name: "nw", x: -b.w / 2, y: -b.h / 2 }, { name: "ne", x: b.w / 2, y: -b.h / 2 },
        { name: "sw", x: -b.w / 2, y: b.h / 2 },  { name: "se", x: b.w / 2, y: b.h / 2 }
    ];
    const edges = [
        { name: "n", x: 0, y: -b.h / 2 }, { name: "s", x: 0, y: b.h / 2 },
        { name: "w", x: -b.w / 2, y: 0 }, { name: "e", x: b.w / 2, y: 0 }
    ];
    for (const c of corners) { if (Math.abs(lx - c.x) <= hs && Math.abs(ly - c.y) <= hs) return c.name; }
    for (const e of edges) { if (Math.abs(lx - e.x) <= hs && Math.abs(ly - e.y) <= hs) return e.name; }
    if (lx >= -b.w / 2 && lx <= b.w / 2 && ly >= -b.h / 2 && ly <= b.h / 2) return "move";
    return null;
}

// ========================================================================
// GRID SUBDIVISION RENDERER
// Shared backbone for non-affine transforms (perspective, mesh, cage).
// Renders a source image through an arbitrary grid of control points
// using textured-triangle rendering via Canvas 2D clip+drawImage.
// ========================================================================

/**
 * Subdivide a 2D grid of {x,y} points via bilinear interpolation.
 * Each level doubles resolution: R×C points → (2R-1)×(2C-1) points.
 * Shared edges are computed once (no seams).
 */
function _subdivideGrid(grid, levels) {
    let g = grid;
    for (let lvl = 0; lvl < levels; lvl++) {
        const rows = g.length, cols = g[0].length;
        const nr = rows * 2 - 1, nc = cols * 2 - 1;
        const ng = new Array(nr);
        for (let i = 0; i < nr; i++) {
            ng[i] = new Array(nc);
            for (let j = 0; j < nc; j++) {
                const ei = i % 2 === 0, ej = j % 2 === 0;
                if (ei && ej) {
                    // Original control point
                    ng[i][j] = g[i >> 1][j >> 1];
                } else if (ei) {
                    // Horizontal edge midpoint
                    const a = g[i >> 1][(j - 1) >> 1], b = g[i >> 1][(j + 1) >> 1];
                    ng[i][j] = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
                } else if (ej) {
                    // Vertical edge midpoint
                    const a = g[(i - 1) >> 1][j >> 1], b = g[(i + 1) >> 1][j >> 1];
                    ng[i][j] = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
                } else {
                    // Cell center — average of 4 corners
                    const tl = g[(i - 1) >> 1][(j - 1) >> 1], tr = g[(i - 1) >> 1][(j + 1) >> 1];
                    const bl = g[(i + 1) >> 1][(j - 1) >> 1], br = g[(i + 1) >> 1][(j + 1) >> 1];
                    ng[i][j] = { x: (tl.x + tr.x + bl.x + br.x) * 0.25, y: (tl.y + tr.y + bl.y + br.y) * 0.25 };
                }
            }
        }
        g = ng;
    }
    return g;
}

/**
 * Render one textured triangle.
 * Maps source triangle (s0,s1,s2) in image pixel coords
 * to destination triangle (d0,d1,d2) in canvas coords.
 * Uses affine transform + clip — exact for planar patches.
 */
function _renderTriangle(ctx, src, s0, s1, s2, d0, d1, d2) {
    const du1 = s1.x - s0.x, du2 = s2.x - s0.x;
    const dv1 = s1.y - s0.y, dv2 = s2.y - s0.y;
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-10) return; // degenerate triangle

    const dx1 = d1.x - d0.x, dx2 = d2.x - d0.x;
    const dy1 = d1.y - d0.y, dy2 = d2.y - d0.y;

    // Affine coefficients: maps source pixel (u,v) → document pixel (x,y)
    const a = (dx1 * dv2 - dx2 * dv1) / det;
    const c = (du1 * dx2 - du2 * dx1) / det;
    const e = d0.x - a * s0.x - c * s0.y;
    const b = (dy1 * dv2 - dy2 * dv1) / det;
    const d = (du1 * dy2 - du2 * dy1) / det;
    const f = d0.y - b * s0.x - d * s0.y;

    ctx.save();
    // Clip path in document space (current transform maps to screen)
    ctx.beginPath();
    ctx.moveTo(d0.x, d0.y);
    ctx.lineTo(d1.x, d1.y);
    ctx.lineTo(d2.x, d2.y);
    ctx.closePath();
    ctx.clip();
    // Compose source→document affine with existing context transform (zoom)
    // Result: source pixel → document coord → screen coord
    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(src, 0, 0);
    ctx.restore();
}

/**
 * Render a source image through a grid of control points.
 *
 * @param {CanvasRenderingContext2D} ctx  - destination context
 * @param {HTMLCanvasElement|Image} srcCanvas - source image
 * @param {{x,y,w,h}} srcRect - region of source to map through grid
 * @param {{x,y}[][]} gridPts - 2D array [row][col] of destination points.
 *        Minimum 2×2. gridPts[0][0] = where srcRect top-left lands.
 * @param {number} [subdivisions=3] - subdivision levels (each level 4× triangles)
 * @param {number} [opacity=1] - global alpha for the rendered output
 */
function gridRender(ctx, srcCanvas, srcRect, gridPts, subdivisions, opacity) {
    if (!gridPts || gridPts.length < 2 || gridPts[0].length < 2) return;
    const grid = _subdivideGrid(gridPts, subdivisions ?? 3);
    const rows = grid.length - 1;
    const cols = grid[0].length - 1;

    const prevAlpha = ctx.globalAlpha;
    if (opacity !== undefined && opacity !== 1) ctx.globalAlpha = opacity;

    for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
            // Source UVs — uniform subdivision of srcRect
            const u0 = srcRect.x + (j / cols) * srcRect.w;
            const v0 = srcRect.y + (i / rows) * srcRect.h;
            const u1 = srcRect.x + ((j + 1) / cols) * srcRect.w;
            const v1 = srcRect.y + ((i + 1) / rows) * srcRect.h;

            const s_tl = { x: u0, y: v0 }, s_tr = { x: u1, y: v0 };
            const s_bl = { x: u0, y: v1 }, s_br = { x: u1, y: v1 };

            const d_tl = grid[i][j],     d_tr = grid[i][j + 1];
            const d_bl = grid[i + 1][j], d_br = grid[i + 1][j + 1];

            // Two triangles per quad (consistent diagonal: TL→BR)
            _renderTriangle(ctx, srcCanvas, s_tl, s_tr, s_br, d_tl, d_tr, d_br);
            _renderTriangle(ctx, srcCanvas, s_tl, s_br, s_bl, d_tl, d_br, d_bl);
        }
    }

    ctx.globalAlpha = prevAlpha;
}

/**
 * Draw grid wireframe — for debug/UI overlay during non-affine transforms.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x,y}[][]} gridPts - control grid (pre-subdivision)
 * @param {number} [subdivisions=0] - subdivide before drawing (0 = control grid only)
 * @param {string} [color="#4af"] - stroke color
 * @param {number} [lineWidth=1] - stroke width
 */
function gridDrawWireframe(ctx, gridPts, subdivisions, color, lineWidth) {
    if (!gridPts || gridPts.length < 2 || gridPts[0].length < 2) return;
    const grid = subdivisions ? _subdivideGrid(gridPts, subdivisions) : gridPts;
    const rows = grid.length, cols = grid[0].length;

    ctx.save();
    ctx.strokeStyle = color || "#4af";
    ctx.lineWidth = lineWidth || 1;
    ctx.setLineDash([]);

    // Horizontal lines
    for (let i = 0; i < rows; i++) {
        ctx.beginPath();
        ctx.moveTo(grid[i][0].x, grid[i][0].y);
        for (let j = 1; j < cols; j++) ctx.lineTo(grid[i][j].x, grid[i][j].y);
        ctx.stroke();
    }
    // Vertical lines
    for (let j = 0; j < cols; j++) {
        ctx.beginPath();
        ctx.moveTo(grid[0][j].x, grid[0][j].y);
        for (let i = 1; i < rows; i++) ctx.lineTo(grid[i][j].x, grid[i][j].y);
        ctx.stroke();
    }
    ctx.restore();
}

/**
 * Build initial grid from a bounding rect.
 * Returns a (rows+1) × (cols+1) array of {x,y} points.
 * Default 2×2 (4 corners) — suitable for perspective.
 */
function gridFromRect(rect, rows, cols) {
    rows = rows || 1;
    cols = cols || 1;
    const pts = [];
    for (let i = 0; i <= rows; i++) {
        pts[i] = [];
        for (let j = 0; j <= cols; j++) {
            pts[i][j] = {
                x: rect.x + (j / cols) * rect.w,
                y: rect.y + (i / rows) * rect.h
            };
        }
    }
    return pts;
}

/**
 * Hit-test a grid's control points. Returns {row, col} or null.
 * Tests in un-zoomed document space.
 */
function gridHitTest(gridPts, px, py, tolerance) {
    tolerance = tolerance || 8;
    for (let i = 0; i < gridPts.length; i++) {
        for (let j = 0; j < gridPts[i].length; j++) {
            const pt = gridPts[i][j];
            if (Math.abs(px - pt.x) <= tolerance && Math.abs(py - pt.y) <= tolerance) {
                return { row: i, col: j };
            }
        }
    }
    return null;
}


// ========================================================================
// MAGNETIC LASSO
// Edge-snapping selection via gradient-based shortest path.
// Computes Sobel edge map, then Dijkstra between anchor points.
// ========================================================================

/**
 * Compute gradient magnitude map from a canvas context.
 * Returns Float32Array (W×H) with values 0-1.
 */
function _computeEdgeMap(ctx, w, h) {
    const img = ctx.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
        gray[i] = (img[i*4] * 0.299 + img[i*4+1] * 0.587 + img[i*4+2] * 0.114) / 255;
    }
    const grad = new Float32Array(w * h);
    let maxG = 0;
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            // Sobel 3x3
            const gx = -gray[(y-1)*w+x-1] + gray[(y-1)*w+x+1]
                      -2*gray[y*w+x-1]    + 2*gray[y*w+x+1]
                      -gray[(y+1)*w+x-1]  + gray[(y+1)*w+x+1];
            const gy = -gray[(y-1)*w+x-1] - 2*gray[(y-1)*w+x] - gray[(y-1)*w+x+1]
                      +gray[(y+1)*w+x-1]  + 2*gray[(y+1)*w+x] + gray[(y+1)*w+x+1];
            const g = Math.sqrt(gx * gx + gy * gy);
            grad[y * w + x] = g;
            if (g > maxG) maxG = g;
        }
    }
    // Normalize
    if (maxG > 0) for (let i = 0; i < grad.length; i++) grad[i] /= maxG;
    return grad;
}

/**
 * Build composite edge map from all visible layers.
 */
function magneticEdgeMap() {
    const tmp = _createCanvas(S.W, S.H);
    const tc = tmp.getContext("2d");
    for (const L of S.layers) {
        if (!L.visible || !L.canvas) continue;
        tc.globalAlpha = L.opacity ?? 1;
        tc.drawImage(L.canvas, 0, 0);
    }
    tc.globalAlpha = 1;
    return _computeEdgeMap(tc, S.W, S.H);
}

/**
 * Find shortest path between two points on the edge map.
 * Cost = 1 - gradient (low gradient = high cost = paths avoid flat areas).
 * Uses Dijkstra with 8-connected neighbors, bounded to a search region.
 *
 * @param {Float32Array} edgeMap - gradient magnitude (0-1), W×H
 * @param {number} w - image width
 * @param {number} h - image height
 * @param {number} x0 - start x
 * @param {number} y0 - start y
 * @param {number} x1 - end x
 * @param {number} y1 - end y
 * @param {number} [margin=40] - search region padding around bounding box
 * @returns {{x,y}[]} path from start to end
 */
function magneticPath(edgeMap, w, h, x0, y0, x1, y1, margin) {
    x0 = ~~x0; y0 = ~~y0; x1 = ~~x1; y1 = ~~y1;
    margin = margin || 40;

    // Bounded search region
    const bx0 = Math.max(0, Math.min(x0, x1) - margin);
    const by0 = Math.max(0, Math.min(y0, y1) - margin);
    const bx1 = Math.min(w - 1, Math.max(x0, x1) + margin);
    const by1 = Math.min(h - 1, Math.max(y0, y1) + margin);
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;

    const INF = 1e9;
    const dist = new Float32Array(bw * bh).fill(INF);
    const prev = new Int32Array(bw * bh).fill(-1);
    const visited = new Uint8Array(bw * bh);

    // Local coords
    const lx0 = x0 - bx0, ly0 = y0 - by0;
    const lx1 = x1 - bx0, ly1 = y1 - by0;
    dist[ly0 * bw + lx0] = 0;

    // Simple priority queue via sorted array (fast enough for bounded regions)
    // For regions up to ~100x100 = 10K pixels this is fine
    const queue = [[0, lx0, ly0]];

    const dx8 = [-1, 0, 1, -1, 1, -1, 0, 1];
    const dy8 = [-1, -1, -1, 0, 0, 1, 1, 1];
    const dc8 = [1.414, 1, 1.414, 1, 1, 1.414, 1, 1.414]; // diagonal costs

    while (queue.length > 0) {
        // Pop min
        let minIdx = 0;
        for (let i = 1; i < queue.length; i++) {
            if (queue[i][0] < queue[minIdx][0]) minIdx = i;
        }
        const [d, cx, cy] = queue[minIdx];
        queue[minIdx] = queue[queue.length - 1];
        queue.pop();

        const ci = cy * bw + cx;
        if (visited[ci]) continue;
        visited[ci] = 1;

        if (cx === lx1 && cy === ly1) break;

        for (let k = 0; k < 8; k++) {
            const nx = cx + dx8[k], ny = cy + dy8[k];
            if (nx < 0 || nx >= bw || ny < 0 || ny >= bh) continue;
            const ni = ny * bw + nx;
            if (visited[ni]) continue;

            // Cost: inverse of edge strength. Strong edges = cheap to traverse
            const gx = nx + bx0, gy = ny + by0;
            const edgeVal = edgeMap[gy * w + gx];
            const cost = (1 - edgeVal * 0.9) * dc8[k]; // keep 0.1 min cost
            const nd = d + cost;

            if (nd < dist[ni]) {
                dist[ni] = nd;
                prev[ni] = ci;
                queue.push([nd, nx, ny]);
            }
        }
    }

    // Backtrace
    const path = [];
    let ci = ly1 * bw + lx1;
    if (dist[ci] >= INF) {
        // No path found — straight line fallback
        path.push({ x: x1, y: y1 });
        path.push({ x: x0, y: y0 });
        return path;
    }
    while (ci !== -1) {
        const lx = ci % bw, ly = (ci / bw) | 0;
        path.push({ x: lx + bx0, y: ly + by0 });
        ci = prev[ci];
    }
    return path; // reversed (end→start), caller can reverse if needed
}


// ========================================================================
// MLS (Moving Least Squares) WARP
// Implements Schaefer et al. 2006 — three deformation modes.
// Affine: general, allows shear. Similitude: preserves angles.
// Rigid: preserves local shape and area.
// ========================================================================

/**
 * Warp a single point via MLS interpolation.
 * @param {{x,y}[]} origPts - original control point positions (flat array)
 * @param {{x,y}[]} curPts  - current (dragged) positions (flat array)
 * @param {{x,y}} v         - point to warp
 * @param {string} mode     - "affine", "similitude", or "rigid"
 * @returns {{x,y}}
 */
function _mlsWarp(origPts, curPts, v, mode) {
    const n = origPts.length;
    if (n === 0) return { x: v.x, y: v.y };

    // Weights: w_i = 1 / |p_i - v|²
    const w = new Array(n);
    let wSum = 0;
    for (let i = 0; i < n; i++) {
        const dx = origPts[i].x - v.x, dy = origPts[i].y - v.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 1e-10) return { x: curPts[i].x, y: curPts[i].y };
        w[i] = 1 / d2;
        wSum += w[i];
    }

    // Weighted centroids p*, q*
    let psx = 0, psy = 0, qsx = 0, qsy = 0;
    for (let i = 0; i < n; i++) {
        psx += w[i] * origPts[i].x; psy += w[i] * origPts[i].y;
        qsx += w[i] * curPts[i].x;  qsy += w[i] * curPts[i].y;
    }
    psx /= wSum; psy /= wSum;
    qsx /= wSum; qsy /= wSum;

    const vx = v.x - psx, vy = v.y - psy;

    if (mode === "affine") {
        // M = (Σ w_i p̂ᵀp̂)⁻¹ · (Σ w_i p̂ᵀq̂)
        let a = 0, b = 0, c = 0;
        let d = 0, e = 0, f = 0, g = 0;
        for (let i = 0; i < n; i++) {
            const phx = origPts[i].x - psx, phy = origPts[i].y - psy;
            const qhx = curPts[i].x - qsx, qhy = curPts[i].y - qsy;
            a += w[i] * phx * phx; b += w[i] * phx * phy; c += w[i] * phy * phy;
            d += w[i] * phx * qhx; e += w[i] * phx * qhy;
            f += w[i] * phy * qhx; g += w[i] * phy * qhy;
        }
        const det = a * c - b * b;
        if (Math.abs(det) < 1e-10) return { x: v.x + qsx - psx, y: v.y + qsy - psy };
        const m00 = (c * d - b * f) / det, m01 = (c * e - b * g) / det;
        const m10 = (-b * d + a * f) / det, m11 = (-b * e + a * g) / det;
        return { x: vx * m00 + vy * m10 + qsx, y: vx * m01 + vy * m11 + qsy };
    }

    // Similitude & Rigid share the conformal accumulation
    let mu = 0;
    for (let i = 0; i < n; i++) {
        const phx = origPts[i].x - psx, phy = origPts[i].y - psy;
        mu += w[i] * (phx * phx + phy * phy);
    }
    if (mu < 1e-10) return { x: v.x + qsx - psx, y: v.y + qsy - psy };

    let fx = 0, fy = 0;
    for (let i = 0; i < n; i++) {
        const phx = origPts[i].x - psx, phy = origPts[i].y - psy;
        const qhx = curPts[i].x - qsx, qhy = curPts[i].y - qsy;
        const dot = phx * vx + phy * vy;
        const cross = phx * vy - phy * vx;
        fx += w[i] * (qhx * dot - qhy * cross);
        fy += w[i] * (qhy * dot + qhx * cross);
    }
    fx /= mu; fy /= mu;

    if (mode === "rigid") {
        // Normalize to preserve distance from centroid
        const vlen = Math.sqrt(vx * vx + vy * vy);
        const flen = Math.sqrt(fx * fx + fy * fy);
        if (flen > 1e-10) { fx = fx * vlen / flen; fy = fy * vlen / flen; }
    }

    return { x: fx + qsx, y: fy + qsy };
}

/**
 * Evaluate MLS warp across a regular grid.
 * Takes N×N control grids (original + current), produces a dense
 * evaluation grid suitable for gridRender().
 *
 * @param {{x,y}[][]} origCtrl - original control grid positions
 * @param {{x,y}[][]} curCtrl  - current (dragged) control positions
 * @param {{x,y,w,h}} srcRect  - source bounds (for eval grid spacing)
 * @param {number} evalSize     - eval grid dimension (e.g. 12 → 13×13 points)
 * @param {string} mode         - "affine", "similitude", or "rigid"
 * @returns {{x,y}[][]}         - evaluation grid for gridRender
 */
function mlsEvalGrid(origCtrl, curCtrl, srcRect, evalSize, mode) {
    // Flatten control grids
    const origFlat = [], curFlat = [];
    for (const row of origCtrl) for (const pt of row) origFlat.push(pt);
    for (const row of curCtrl) for (const pt of row) curFlat.push(pt);

    const grid = [];
    for (let i = 0; i <= evalSize; i++) {
        grid[i] = [];
        for (let j = 0; j <= evalSize; j++) {
            const v = {
                x: srcRect.x + (j / evalSize) * srcRect.w,
                y: srcRect.y + (i / evalSize) * srcRect.h
            };
            grid[i][j] = _mlsWarp(origFlat, curFlat, v, mode);
        }
    }
    return grid;
}

// ========================================================================
// REGIONS
// ========================================================================
function addRegion(name) {
    const id = S._nextRegionId++;
    const colorIdx = (id - 1) % REGION_COLORS.length;
    const c = _createCanvas(S.W, S.H);
    const region = {
        id, name: name || ("Region " + id),
        prompt: "", negPrompt: "", denoising: 0.55, weight: 1.0,
        color: REGION_COLORS[colorIdx],
        canvas: c, ctx: c.getContext("2d"), visible: true
    };
    S.regions.push(region);
    S.activeRegionId = id;
    S.regionMode = true;
    return region;
}

function deleteRegion(id) {
    S.regions = S.regions.filter(r => r.id !== id);
    if (S.activeRegionId === id) S.activeRegionId = S.regions.length ? S.regions[S.regions.length - 1].id : null;
    if (!S.regions.length) S.regionMode = false;
}

function clearRegion(id) {
    const r = S.regions.find(r => r.id === id);
    if (r) r.ctx.clearRect(0, 0, S.W, S.H);
}

function activeRegion() { return S.regions.find(r => r.id === S.activeRegionId) || null; }

function serializeRegions() {
    if (!S.regions.length) return "";
    return JSON.stringify({
        regions: S.regions.map(r => ({
            name: r.name, prompt: r.prompt, negPrompt: r.negPrompt,
            denoising: r.denoising,
            weight: r.weight,
            color: r.color,
            mask_b64: r.canvas.toDataURL("image/png")
        }))
    });
}

function regionPaintAt(x, y) {
    const r = activeRegion();
    if (!r) return;
    r.ctx.fillStyle = "#fff";
    r.ctx.beginPath(); r.ctx.arc(x, y, Math.max(1, brushPx() / 2), 0, Math.PI * 2); r.ctx.fill();
}

function regionPaintMove(x1, y1, x2, y2) {
    const r = activeRegion();
    if (!r) return;
    const rad = Math.max(1, brushPx() / 2);
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (rad * 0.4)));
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        r.ctx.fillStyle = "#fff";
        r.ctx.beginPath();
        r.ctx.arc(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, rad, 0, Math.PI * 2);
        r.ctx.fill();
    }
}

function regionEraseMove(x1, y1, x2, y2) {
    const r = activeRegion();
    if (!r) return;
    const rad = Math.max(1, brushPx() / 2);
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (rad * 0.4)));
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        r.ctx.save(); r.ctx.globalCompositeOperation = "destination-out";
        r.ctx.fillStyle = "#fff";
        r.ctx.beginPath();
        r.ctx.arc(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, rad, 0, Math.PI * 2);
        r.ctx.fill(); r.ctx.restore();
    }
}

// ========================================================================
// ADJUSTMENT LAYER RENDERING
// ========================================================================
// Per-pixel transforms — replace the legacy ctx.filter pipeline. Algorithm
// references follow Krita's filter implementations (KisFilter, GPL-3.0,
// compatible with this project's license). The functions mutate `ctx` in
// place and are opacity-agnostic; _applyAdjustment handles `L.opacity` by
// snapshot-and-lerp around the dispatch.

const _LUT_IDENTITY_BC = new Uint8Array(256);
for (let i = 0; i < 256; i++) _LUT_IDENTITY_BC[i] = i;

function _isBrightnessIdentity(ap) {
    return (ap.brightness | 0) === 0 && (ap.contrast | 0) === 0;
}
function _isHSLIdentity(ap) {
    if (ap.colorize) return false;
    return (ap.hue | 0) === 0 && (ap.saturation | 0) === 0 && (ap.lightness | 0) === 0;
}
function _isLevelsIdentity(ap) {
    return (ap.levInBlack || 0) === 0
        && (ap.levInWhite !== undefined ? ap.levInWhite : 1) === 1
        && (ap.levGamma !== undefined ? ap.levGamma : 1) === 1
        && (ap.levOutBlack || 0) === 0
        && (ap.levOutWhite !== undefined ? ap.levOutWhite : 1) === 1;
}

function _getCachedLut(L, type, sig, build) {
    const cache = L._lutCache;
    if (cache && cache.type === type && cache.sig === sig) return cache.lut;
    const lut = build();
    L._lutCache = { type, sig, lut };
    return lut;
}

// Brightness offset + Krita-style sigmoid contrast centered at 0.5.
// contrast slope = tan((c+1) * π/4): c=0 → 1 (identity), c=1 → ∞ (binarize), c=-1 → 0 (flat).
function _buildBrightnessContrastLut(ap) {
    const b = (ap.brightness || 0) / 100;
    const c = Math.max(-1, Math.min(1, (ap.contrast || 0) / 100));
    const slope = Math.tan((c + 1) * Math.PI / 4);
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
        let t = v / 255;
        t = (t - 0.5) * slope + 0.5 + b;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        lut[v] = (t * 255 + 0.5) | 0;
    }
    return lut;
}

function _applyBrightnessContrastToCtx(ctx, w, h, ap, L) {
    const sig = (ap.brightness | 0) + ":" + (ap.contrast | 0);
    const lut = _getCachedLut(L, "brightness", sig, () => _buildBrightnessContrastLut(ap));
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    for (let p = 0, len = d.length; p < len; p += 4) {
        d[p] = lut[d[p]]; d[p + 1] = lut[d[p + 1]]; d[p + 2] = lut[d[p + 2]];
    }
    ctx.putImageData(imgData, 0, 0);
}

// HSL/HSV adjustment. Relative shifts use Krita's "linear toward edge" rule
// for saturation/lightness so extremes don't clip prematurely. `colorize`
// replaces hue and saturation with absolute targets.
function _applyHSLToCtx(ctx, w, h, ap) {
    const hShift   = ap.hue || 0;
    const sShift   = (ap.saturation || 0) / 100;
    const lShift   = (ap.lightness  || 0) / 100;
    const useHSV   = ap.model === "HSV";
    const colorize = !!ap.colorize;
    const cHue = ((ap.hue || 0) % 360 + 360) % 360;
    const cSat = useHSV ? Math.max(0, Math.min(1, (ap.saturation || 0) / 100))
                        : Math.max(0, Math.min(1, ((ap.saturation || 0) + 100) / 200));

    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    for (let p = 0, len = d.length; p < len; p += 4) {
        if (d[p + 3] === 0) continue;
        const r = d[p] / 255, g = d[p + 1] / 255, b = d[p + 2] / 255;
        const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
        const delta = max - min;

        let H = 0;
        if (delta > 0) {
            if (max === r)      H = ((g - b) / delta) % 6;
            else if (max === g) H = (b - r) / delta + 2;
            else                H = (r - g) / delta + 4;
            H *= 60; if (H < 0) H += 360;
        }

        let S, axis;
        if (useHSV) {
            axis = max;                                   // V
            S = max === 0 ? 0 : delta / max;
        } else {
            axis = (max + min) * 0.5;                      // L
            S = delta === 0 ? 0 : delta / (1 - Math.abs(2 * axis - 1));
        }

        if (colorize) {
            H = cHue;
            S = cSat;
            axis = Math.max(0, Math.min(1, axis + lShift));
        } else {
            H = (H + hShift) % 360; if (H < 0) H += 360;
            S = sShift >= 0 ? S + (1 - S) * sShift : S + S * sShift;
            if (S < 0) S = 0; else if (S > 1) S = 1;
            axis = lShift >= 0 ? axis + (1 - axis) * lShift : axis + axis * lShift;
            if (axis < 0) axis = 0; else if (axis > 1) axis = 1;
        }

        let C, m;
        if (useHSV) { C = axis * S; m = axis - C; }
        else        { C = (1 - Math.abs(2 * axis - 1)) * S; m = axis - C * 0.5; }
        const X = C * (1 - Math.abs((H / 60) % 2 - 1));
        let r2, g2, b2;
        const seg = (H / 60) | 0;
        if      (seg === 0) { r2 = C; g2 = X; b2 = 0; }
        else if (seg === 1) { r2 = X; g2 = C; b2 = 0; }
        else if (seg === 2) { r2 = 0; g2 = C; b2 = X; }
        else if (seg === 3) { r2 = 0; g2 = X; b2 = C; }
        else if (seg === 4) { r2 = X; g2 = 0; b2 = C; }
        else                { r2 = C; g2 = 0; b2 = X; }
        d[p]     = ((r2 + m) * 255 + 0.5) | 0;
        d[p + 1] = ((g2 + m) * 255 + 0.5) | 0;
        d[p + 2] = ((b2 + m) * 255 + 0.5) | 0;
    }
    ctx.putImageData(imgData, 0, 0);
}

// Levels: input black/white normalize → gamma → output black/white remap.
function _buildLevelsLut(ap) {
    const iBlk = ap.levInBlack || 0;
    const iWht = ap.levInWhite !== undefined ? ap.levInWhite : 1;
    const gamma = ap.levGamma !== undefined ? ap.levGamma : 1;
    const oBlk = ap.levOutBlack || 0;
    const oWht = ap.levOutWhite !== undefined ? ap.levOutWhite : 1;
    const iRange = Math.max(0.001, iWht - iBlk);
    const oRange = oWht - oBlk;
    const invGamma = 1 / Math.max(0.01, gamma);
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
        let t = (v / 255 - iBlk) / iRange;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        t = Math.pow(t, invGamma);
        let o = oBlk + t * oRange;
        if (o < 0) o = 0; else if (o > 1) o = 1;
        lut[v] = (o * 255 + 0.5) | 0;
    }
    return lut;
}

function _applyLevelsToCtx(ctx, w, h, ap, L) {
    const sig = (ap.levInBlack || 0) + "|" + (ap.levInWhite || 1) + "|"
              + (ap.levGamma || 1) + "|" + (ap.levOutBlack || 0) + "|" + (ap.levOutWhite || 1);
    const lut = _getCachedLut(L, "levels", sig, () => _buildLevelsLut(ap));
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    for (let p = 0, len = d.length; p < len; p += 4) {
        d[p] = lut[d[p]]; d[p + 1] = lut[d[p + 1]]; d[p + 2] = lut[d[p + 2]];
    }
    ctx.putImageData(imgData, 0, 0);
}

function _applyAdjustment(ctx, w, h, L) {
    const ap = L.adjustParams || {};
    let identity = false;
    if      (L.adjustType === "brightness") identity = _isBrightnessIdentity(ap);
    else if (L.adjustType === "hue")        identity = _isHSLIdentity(ap);
    else if (L.adjustType === "levels")     identity = _isLevelsIdentity(ap);
    else return;
    if (identity) return;

    const opacity = L.opacity != null ? L.opacity : 1;
    let snap = null;
    if (opacity < 1) snap = ctx.getImageData(0, 0, w, h);

    if      (L.adjustType === "brightness") _applyBrightnessContrastToCtx(ctx, w, h, ap, L);
    else if (L.adjustType === "hue")        _applyHSLToCtx(ctx, w, h, ap);
    else if (L.adjustType === "levels")     _applyLevelsToCtx(ctx, w, h, ap, L);

    if (snap) {
        const out = ctx.getImageData(0, 0, w, h);
        const od = out.data, sd = snap.data;
        const a = opacity, ia = 1 - opacity;
        for (let p = 0, len = od.length; p < len; p += 4) {
            od[p]     = (od[p]     * a + sd[p]     * ia + 0.5) | 0;
            od[p + 1] = (od[p + 1] * a + sd[p + 1] * ia + 0.5) | 0;
            od[p + 2] = (od[p + 2] * a + sd[p + 2] * ia + 0.5) | 0;
        }
        ctx.putImageData(out, 0, 0);
    }
}

// ========================================================================
// COMPOSITOR
// ========================================================================
function checker(ctx, w, h) {
    const s = 10;
    ctx.fillStyle = "#3a3a3a"; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#444";
    for (let y = 0; y < h; y += s) for (let x = 0; x < w; x += s) {
        if ((~~(x / s) + ~~(y / s)) & 1) ctx.fillRect(x, y, s, s);
    }
}

function _drawGrid(c, w, h, z) {
    if (!S.showGrid) return;
    const gStep = 64;
    const lw = 1 / z.scale;
    c.save();
    c.globalCompositeOperation = "difference";
    c.strokeStyle = "rgba(255,255,255,0.18)";
    c.lineWidth = lw;
    c.beginPath();
    for (let gx = gStep; gx < w; gx += gStep) {
        c.moveTo(gx, 0); c.lineTo(gx, h);
    }
    for (let gy = gStep; gy < h; gy += gStep) {
        c.moveTo(0, gy); c.lineTo(w, gy);
    }
    c.stroke();
    c.restore();
}

function symGuides(c) {
    c.save();
    c.strokeStyle = "rgba(100,200,255,0.3)";
    c.lineWidth = 1 / S.zoom.scale;
    c.setLineDash([4 / S.zoom.scale, 4 / S.zoom.scale]);
    if (S.symmetry === "h" || S.symmetry === "both") {
        c.beginPath(); c.moveTo(S.W / 2, 0); c.lineTo(S.W / 2, S.H); c.stroke();
    }
    if (S.symmetry === "v" || S.symmetry === "both") {
        c.beginPath(); c.moveTo(0, S.H / 2); c.lineTo(S.W, S.H / 2); c.stroke();
    }
    if (S.symmetry === "radial") {
        const n = S.symmetryAxes || 4;
        const ccx = S.W / 2, ccy = S.H / 2;
        const r = Math.max(S.W, S.H);
        for (let k = 0; k < n; k++) {
            const a = (2 * Math.PI * k) / n;
            c.beginPath();
            c.moveTo(ccx, ccy);
            c.lineTo(ccx + Math.cos(a) * r, ccy + Math.sin(a) * r);
            c.stroke();
        }
    }
    c.restore();
}

// Composite all layers below `idx` (exclusive) into a fresh canvas. Used by the
// adjustment-layer UI to source pixels for the histogram. Adjustment layers
// below `idx` are honored so the histogram reflects what the layer would see.
function _compositeLayersBelow(idx) {
    const c = _createCanvas(S.W, S.H);
    const x = c.getContext("2d");
    x.filter = "none"; x.globalAlpha = 1; x.globalCompositeOperation = "source-over";
    const stop = Math.min(idx, S.layers.length);
    for (let i = 0; i < stop; i++) {
        const L = S.layers[i];
        if (!L.visible) continue;
        if (L.type === "adjustment") { _applyAdjustment(x, S.W, S.H, L); continue; }
        x.globalCompositeOperation = L.blendMode || "source-over";
        x.globalAlpha = L.opacity;
        x.drawImage(L.canvas, 0, 0);
    }
    x.globalCompositeOperation = "source-over"; x.globalAlpha = 1;
    return c;
}

function _composite2D(c, w, h, z, eraserActive, AL, strokeDrawCanvas, showMask) {
    if (!_compBuffer || _compBuffer.width !== w || _compBuffer.height !== h) {
        _compBuffer = _createCanvas(w, h);
        _compCtx = _compBuffer.getContext("2d");
    }
    const x = _compCtx;
    x.clearRect(0, 0, w, h);
    x.filter = "none"; x.globalAlpha = 1; x.globalCompositeOperation = "source-over";
    const strokeInStack = strokeDrawCanvas && S.tool === "brush" && !S.editingMask;

    for (let i = 0; i < S.layers.length; i++) {
        const L = S.layers[i];
        if (!L.visible) continue;
        if (L.type === "adjustment") { _applyAdjustment(x, w, h, L); continue; }
        x.globalCompositeOperation = L.blendMode || "source-over";
        x.globalAlpha = L.opacity;
        if (eraserActive && L === AL && !S.editingMask) {
            x.drawImage(S.stroke.canvas, 0, 0);
        } else {
            x.drawImage(L.canvas, 0, 0);
            if (strokeInStack && L === AL) {
                x.save();
                x.globalAlpha = S.brushOpacity * L.opacity;
                x.globalCompositeOperation = "source-over";
                x.drawImage(strokeDrawCanvas, 0, 0);
                x.restore();
                x.globalCompositeOperation = "source-over";
                x.globalAlpha = 1;
            }
        }
        // Render AI preview after the reference layer (bottom-most layer)
        // so user paint layers appear on top of the preview
        if (i === 0 && S.livePreview.active && S.livePreview.canvas) {
            x.globalCompositeOperation = "source-over";
            x.globalAlpha = 1;
            x.drawImage(S.livePreview.canvas, 0, 0);
        }
    }
    c.globalAlpha = 1; c.globalCompositeOperation = "source-over";
    c.drawImage(_compBuffer, 0, 0);

    if (showMask) {
        c.globalCompositeOperation = "source-over";
        c.globalAlpha = S.mask.opacity;
        if (eraserActive && S.editingMask) c.drawImage(S.stroke.canvas, 0, 0);
        else c.drawImage(S.mask.canvas, 0, 0);
    }
    if (strokeDrawCanvas && S.tool === "brush" && S.editingMask) {
        c.globalAlpha = S.mask.opacity;
        c.globalCompositeOperation = "source-over";
        c.drawImage(strokeDrawCanvas, 0, 0);
    }
    c.globalAlpha = 1; c.globalCompositeOperation = "source-over";
}

function drawRegionOverlay(ctx) {
    if (!S.regions.length) return;
    ctx.save();
    for (let ri = 0; ri < S.regions.length; ri++) {
        const r = S.regions[ri];
        if (!r.visible) continue;
        const tmp = getTempCanvas("regionOvl_" + ri, S.W, S.H);
        const tc = tmp.getContext("2d");
        tc.fillStyle = r.color; tc.fillRect(0, 0, S.W, S.H);
        tc.globalCompositeOperation = "destination-in"; tc.drawImage(r.canvas, 0, 0);
        tc.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 0.38; ctx.drawImage(tmp, 0, 0); ctx.globalAlpha = 1;
        if (r.id === S.activeRegionId) {
            ctx.save(); ctx.strokeStyle = r.color; ctx.lineWidth = 2; ctx.setLineDash([5, 3]);
            ctx.strokeRect(1, 1, S.W - 2, S.H - 2); ctx.restore();
        }
    }
    ctx.restore();
}

function composite(dirtyOnly) {
    const c = S.ctx, w = S.W, h = S.H, z = S.zoom;
    if (!c) return;

    // Dirty-rect fast path during brush strokes
    const _canUseDirtyFastPath = (function () {
        if (!dirtyOnly || !S.drawing || S.tool !== "brush" || !S.stroke.alphaMap || !_compositeCache) return false;
        if (S.editingMask) return true;
        for (let i = S.activeLayerIdx + 1; i < S.layers.length; i++) {
            if (S.layers[i].visible) return false;
        }
        return true;
    })();

    if (_canUseDirtyFastPath) {
        const d = S.stroke.dirty;
        if (d.x1 >= d.x0 && d.y1 >= d.y0) {
            c.setTransform(1, 0, 0, 1, 0, 0);
            c.putImageData(_compositeCache, 0, 0);
            c.setTransform(z.scale, 0, 0, z.scale, z.ox, z.oy);
            const onMask = S.editingMask;
            const col = onMask ? S.maskColor : S.color;
            const img = alphaMapToImageData(col);
            const dx = Math.max(0, d.x0), dy = Math.max(0, d.y0);
            const dw = Math.min(S.W, d.x1 + 1) - dx, dh = Math.min(S.H, d.y1 + 1) - dy;
            if (dw > 0 && dh > 0) {
                S.stroke.ctx.clearRect(dx, dy, dw, dh);
                S.stroke.ctx.putImageData(img, 0, 0, dx, dy, dw, dh);
            }
            c.globalAlpha = onMask ? S.mask.opacity : S.brushOpacity;
            c.globalCompositeOperation = "source-over";
            c.drawImage(S.stroke.canvas, 0, 0);
            c.globalAlpha = 1; c.globalCompositeOperation = "source-over";
            c.setTransform(z.scale, 0, 0, z.scale, z.ox, z.oy);
            return;
        }
    }

    const eraserActive = S.drawing && S.stroke.canvas && S.tool === "eraser";
    const AL = activeLayer();
    const showMask = S.mask.visible && S.mask.canvas && (S.studioMode === "Edit" || S._userMaskMode);

    // Prepare wet stroke canvas for brush
    let strokeDrawCanvas = null;
    if (S.drawing && S.stroke.canvas && S.tool === "brush" && S.stroke.alphaMap) {
        const onMask = S.editingMask;
        const col = onMask ? S.maskColor : S.color;
        const img = alphaMapToImageData(col);
        const d = S.stroke.dirty;
        if (d.x1 >= d.x0 && d.y1 >= d.y0) {
            const dx = Math.max(0, d.x0), dy = Math.max(0, d.y0);
            const dw = Math.min(S.W, d.x1 + 1) - dx, dh = Math.min(S.H, d.y1 + 1) - dy;
            if (dw > 0 && dh > 0) {
                S.stroke.ctx.clearRect(0, 0, S.W, S.H);
                S.stroke.ctx.putImageData(img, 0, 0, dx, dy, dw, dh);
            }
        }
        strokeDrawCanvas = S.stroke.canvas;
    }

    // Background fill — reads --bg-void from CSS so themes apply
    c.setTransform(1, 0, 0, 1, 0, 0);
    if (!S._voidColor) S._voidColor = getComputedStyle(document.documentElement).getPropertyValue("--bg-void").trim() || "#1e2130";
    c.fillStyle = S._voidColor;
    c.fillRect(0, 0, S.canvas.width, S.canvas.height);

    c.setTransform(z.scale, 0, 0, z.scale, z.ox, z.oy);

    // Nearest-neighbor filtering at high zoom — crisp pixels instead of blurry interpolation
    c.imageSmoothingEnabled = z.scale < 2.0;

    // Clip checkerboard to exact document bounds — prevents subpixel bleed at edges
    c.save();
    c.beginPath(); c.rect(0, 0, w, h); c.clip();
    checker(c, w, h);
    c.restore();

    // Cache for dirty-rect during brush: capture base composite WITHOUT stroke
    // Only when no visible layers above active (same guard as dirty fast path)
    const _canBuildCache = S.drawing && S.tool === "brush" && strokeDrawCanvas && !S.editingMask &&
        !S.layers.slice(S.activeLayerIdx + 1).some(l => l.visible);
    if (_canBuildCache) {
        _composite2D(c, w, h, z, eraserActive, AL, null, showMask);
        _drawGrid(c, w, h, z);
        c.setTransform(1, 0, 0, 1, 0, 0);
        try { _compositeCache = c.getImageData(0, 0, S.canvas.width, S.canvas.height); } catch (e) { _compositeCache = null; }
        c.setTransform(z.scale, 0, 0, z.scale, z.ox, z.oy);
        // Draw stroke overlay on top for display
        c.globalAlpha = S.brushOpacity;
        c.globalCompositeOperation = "source-over";
        c.drawImage(strokeDrawCanvas, 0, 0);
        c.globalAlpha = 1; c.globalCompositeOperation = "source-over";
    } else if (S.drawing && S.tool === "brush" && strokeDrawCanvas && S.editingMask) {
        _composite2D(c, w, h, z, eraserActive, AL, null, showMask);
        _drawGrid(c, w, h, z);
        c.setTransform(1, 0, 0, 1, 0, 0);
        try { _compositeCache = c.getImageData(0, 0, S.canvas.width, S.canvas.height); } catch (e) { _compositeCache = null; }
        c.setTransform(z.scale, 0, 0, z.scale, z.ox, z.oy);
        c.globalAlpha = S.mask.opacity;
        c.globalCompositeOperation = "source-over";
        c.drawImage(strokeDrawCanvas, 0, 0);
        c.globalAlpha = 1; c.globalCompositeOperation = "source-over";
    } else {
        _composite2D(c, w, h, z, eraserActive, AL, strokeDrawCanvas, showMask);
        _drawGrid(c, w, h, z);
        _compositeCache = null;
    }

    // UI overlays
    c.globalAlpha = 1; c.globalCompositeOperation = "source-over";

    if (S.regions.length) {
        if (!S.regionMode) c.globalAlpha = 0.3;
        drawRegionOverlay(c);
        c.globalAlpha = 1;
    }
    if (S.symmetry !== "none" && (S.tool === "brush" || S.tool === "eraser" || S.tool === "smudge")) symGuides(c);

    // Restore zoom transform + safe state so browser compositor
    // doesn't re-rasterize at identity during layer transactions (Firefox WebRender)
    c.globalAlpha = 1;
    c.globalCompositeOperation = "source-over";
    c.setTransform(z.scale, 0, 0, z.scale, z.ox, z.oy);
}

// ========================================================================
// EXPORT
// ========================================================================
function exportCanvas() {
    const c = _createCanvas(S.W, S.H);
    const x = c.getContext("2d");
    x.filter = "none"; x.globalAlpha = 1; x.globalCompositeOperation = "source-over";
    // JPEG needs a white background (no alpha channel)
    x.fillStyle = "#ffffff";
    x.fillRect(0, 0, S.W, S.H);
    for (const L of S.layers) {
        if (!L.visible) continue;
        if (L.type === "adjustment") { _applyAdjustment(x, S.W, S.H, L); continue; }
        x.globalCompositeOperation = L.blendMode || "source-over";
        x.globalAlpha = L.opacity;
        x.drawImage(L.canvas, 0, 0);
    }
    x.filter = "none"; x.globalAlpha = 1; x.globalCompositeOperation = "source-over";
    // JPEG q=0.95 is visually lossless and ~10x smaller than PNG.
    // The image is only used as an img2img init — it gets denoised anyway.
    return c.toDataURL("image/jpeg", 0.95);
}

function isCanvasBlank() {
    // Check if the composited canvas is all near-white.
    // Used for txt2img routing: blank = txt2img, content = img2img.
    const c = _createCanvas(S.W, S.H);
    const x = c.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, S.W, S.H);
    for (const L of S.layers) {
        if (!L.visible) continue;
        if (L.type === "adjustment") { _applyAdjustment(x, S.W, S.H, L); continue; }
        x.globalCompositeOperation = L.blendMode || "source-over";
        x.globalAlpha = L.opacity;
        x.drawImage(L.canvas, 0, 0);
    }
    const d = x.getImageData(0, 0, S.W, S.H).data;
    for (let i = 0; i < d.length; i += 4) {
        if (d[i] < 249 || d[i + 1] < 249 || d[i + 2] < 249) return false;
    }
    return true;
}

function exportMask() {
    const isInpaintSketch = S.studioMode === "Edit" && S.inpaintMode === "Inpaint Sketch";
    if (isInpaintSketch) {
        const tmpC = _createCanvas(S.W, S.H);
        const tmpX = tmpC.getContext("2d");
        for (let i = 1; i < S.layers.length; i++) {
            if (S.layers[i].visible && S.layers[i].canvas) tmpX.drawImage(S.layers[i].canvas, 0, 0);
        }
        const pd = tmpX.getImageData(0, 0, S.W, S.H).data;
        let has = false;
        for (let i = 3; i < pd.length; i += 4) if (pd[i] > 0) { has = true; break; }
        if (!has) return "null";
        const c = _createCanvas(S.W, S.H);
        const x = c.getContext("2d");
        x.fillStyle = "#000"; x.fillRect(0, 0, S.W, S.H);
        const o = x.getImageData(0, 0, S.W, S.H), od = o.data;
        for (let i = 0; i < pd.length; i += 4) if (pd[i + 3] > 0) { od[i] = 255; od[i + 1] = 255; od[i + 2] = 255; od[i + 3] = 255; }
        x.putImageData(o, 0, 0);
        return c.toDataURL("image/png");
    }
    const maskC = _createCanvas(S.W, S.H);
    const mx = maskC.getContext("2d");
    mx.drawImage(S.mask.canvas, 0, 0);
    if (S.studioMode === "Edit" && S.inpaintMode === "Regional" && S.regions.length) {
        for (const r of S.regions) { if (r.visible) mx.drawImage(r.canvas, 0, 0); }
    }
    const d = mx.getImageData(0, 0, S.W, S.H).data;
    let has = false;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) { has = true; break; }
    if (!has) return "null";
    const c = _createCanvas(S.W, S.H);
    const x = c.getContext("2d");
    x.fillStyle = "#000"; x.fillRect(0, 0, S.W, S.H);
    const o = x.getImageData(0, 0, S.W, S.H), od = o.data;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) { od[i] = 255; od[i + 1] = 255; od[i + 2] = 255; od[i + 3] = 255; }
    x.putImageData(o, 0, 0);
    return c.toDataURL("image/png");
}

function exportFlattened(mime) {
    const c = _createCanvas(S.W, S.H);
    const x = c.getContext("2d");
    if (mime === "image/jpeg" || mime === "image/webp") {
        x.fillStyle = "#ffffff"; x.fillRect(0, 0, S.W, S.H);
    }
    for (const L of S.layers) {
        if (!L.visible) continue;
        if (L.type === "adjustment") { _applyAdjustment(x, S.W, S.H, L); continue; }
        x.globalCompositeOperation = L.blendMode || "source-over";
        x.globalAlpha = L.opacity;
        x.drawImage(L.canvas, 0, 0);
    }
    return c.toDataURL(mime || "image/png");
}

// ========================================================================
// LAYER FLIP / ROTATE — Photoshop-style transforms on the active layer
//
// All ops act on activeLayer().canvas in place. The layer canvas size
// is bound to the document (S.W × S.H), so 90°/270° rotations on a
// non-square doc center-crop / center-pad to keep the layer document-
// sized — matches Photoshop's "Layer → Rotate 90° CW" behavior.
//
// 90 / 180 paths use ImageData row/col swaps so they're lossless.
// Arbitrary rotation uses a temp canvas + drawImage for smoothing.
// Each op pushes one undo step before mutating.
// ========================================================================

function _flipLayerHorizontal() {
    const L = activeLayer();
    if (!L || L.type === "adjustment") return;
    saveUndo("Flip Horizontal");
    const w = S.W, h = S.H;
    const src = L.ctx.getImageData(0, 0, w, h);
    const sd = src.data;
    const dst = new ImageData(w, h);
    const dd = dst.data;
    for (let y = 0; y < h; y++) {
        const rowStart = y * w * 4;
        for (let x = 0; x < w; x++) {
            const si = rowStart + x * 4;
            const di = rowStart + (w - 1 - x) * 4;
            dd[di] = sd[si]; dd[di + 1] = sd[si + 1];
            dd[di + 2] = sd[si + 2]; dd[di + 3] = sd[si + 3];
        }
    }
    L.ctx.putImageData(dst, 0, 0);
}

function _flipLayerVertical() {
    const L = activeLayer();
    if (!L || L.type === "adjustment") return;
    saveUndo("Flip Vertical");
    const w = S.W, h = S.H;
    const src = L.ctx.getImageData(0, 0, w, h);
    const sd = src.data;
    const dst = new ImageData(w, h);
    const dd = dst.data;
    const rowBytes = w * 4;
    for (let y = 0; y < h; y++) {
        const srcStart = y * rowBytes;
        const dstStart = (h - 1 - y) * rowBytes;
        for (let i = 0; i < rowBytes; i++) dd[dstStart + i] = sd[srcStart + i];
    }
    L.ctx.putImageData(dst, 0, 0);
}

function _rotateLayer180() {
    const L = activeLayer();
    if (!L || L.type === "adjustment") return;
    saveUndo("Rotate 180°");
    const w = S.W, h = S.H;
    const src = L.ctx.getImageData(0, 0, w, h);
    const sd = src.data;
    const dst = new ImageData(w, h);
    const dd = dst.data;
    const total = w * h;
    for (let i = 0; i < total; i++) {
        const si = i * 4;
        const di = (total - 1 - i) * 4;
        dd[di] = sd[si]; dd[di + 1] = sd[si + 1];
        dd[di + 2] = sd[si + 2]; dd[di + 3] = sd[si + 3];
    }
    L.ctx.putImageData(dst, 0, 0);
}

// 90° rotation — operates on the layer's actual content bounding box
// (non-transparent region) instead of the full S.W × S.H canvas, so
// successive rotations don't compound over letterbox margins from a
// previous rotation. Content is placed centered on the canvas; any
// portion exceeding canvas bounds is clipped at draw time. Callers
// that want overflow preserved should engage the Transform tool via
// canvas-ui's _smartRotate helper before invoking this directly.
function _rotateLayer90Common(direction) {
    const L = activeLayer();
    if (!L || L.type === "adjustment") return;
    saveUndo(direction > 0 ? "Rotate 90° CW" : "Rotate 90° CCW");
    const w = S.W, h = S.H;
    const bounds = getLayerContentBounds(L);
    if (!bounds) return;
    const bx = bounds.x, by = bounds.y, bw = bounds.w, bh = bounds.h;

    const src = L.ctx.getImageData(bx, by, bw, bh);
    const sd = src.data;
    const rotW = bh, rotH = bw;
    const rot = new ImageData(rotW, rotH);
    const rd = rot.data;
    if (direction > 0) {
        for (let y = 0; y < rotH; y++) {
            for (let x = 0; x < rotW; x++) {
                const sx = y;
                const sy = bh - 1 - x;
                const si = (sy * bw + sx) * 4;
                const di = (y * rotW + x) * 4;
                rd[di] = sd[si]; rd[di + 1] = sd[si + 1];
                rd[di + 2] = sd[si + 2]; rd[di + 3] = sd[si + 3];
            }
        }
    } else {
        for (let y = 0; y < rotH; y++) {
            for (let x = 0; x < rotW; x++) {
                const sx = bw - 1 - y;
                const sy = x;
                const si = (sy * bw + sx) * 4;
                const di = (y * rotW + x) * 4;
                rd[di] = sd[si]; rd[di + 1] = sd[si + 1];
                rd[di + 2] = sd[si + 2]; rd[di + 3] = sd[si + 3];
            }
        }
    }
    const tmp = _createCanvas(rotW, rotH);
    tmp.getContext("2d").putImageData(rot, 0, 0);

    L.ctx.clearRect(0, 0, w, h);
    // Center the rotated content. May overflow canvas; the drawImage
    // call will clip naturally. Callers expecting to preserve overflow
    // should detect the overflow before calling and route to a
    // Transform-tool flow instead.
    const dx = Math.round((w - rotW) / 2);
    const dy = Math.round((h - rotH) / 2);
    L.ctx.drawImage(tmp, dx, dy);
}

function _rotateLayer90CW() { _rotateLayer90Common(1); }
function _rotateLayer90CCW() { _rotateLayer90Common(-1); }

// Arbitrary rotation — bilinear via canvas. Operates on the content
// bbox; content is rotated around the document center at 1× scale.
// Overflow is clipped at canvas bounds; engage Transform mode for
// non-destructive positioning (see canvas-ui's _smartRotate).
function _rotateLayerArbitrary(degrees) {
    const L = activeLayer();
    if (!L || L.type === "adjustment") return;
    const deg = Number(degrees);
    if (!Number.isFinite(deg) || deg === 0) return;
    saveUndo(`Rotate ${deg}°`);
    const w = S.W, h = S.H;
    const bounds = getLayerContentBounds(L);
    if (!bounds) return;
    const bx = bounds.x, by = bounds.y, bw = bounds.w, bh = bounds.h;

    const snap = _createCanvas(bw, bh);
    snap.getContext("2d").drawImage(L.canvas, bx, by, bw, bh, 0, 0, bw, bh);

    const rad = deg * Math.PI / 180;
    L.ctx.save();
    L.ctx.imageSmoothingEnabled = true;
    L.ctx.imageSmoothingQuality = "high";
    L.ctx.clearRect(0, 0, w, h);
    L.ctx.translate(w / 2, h / 2);
    L.ctx.rotate(rad);
    L.ctx.drawImage(snap, -bw / 2, -bh / 2);
    L.ctx.restore();
}

// ========================================================================
// LIVE PAINTING — canvas hooks
// ========================================================================

/**
 * Composite visible layers (excluding AI preview) and downscale to target
 * resolution for Live generation submission.
 * Returns base64 data URL or null if no layers have content.
 */
function compositeForLive(targetW, targetH) {
    // Composite at document resolution first
    const c = _createCanvas(S.W, S.H);
    const x = c.getContext("2d");
    x.fillStyle = "#ffffff";
    x.fillRect(0, 0, S.W, S.H);
    for (const L of S.layers) {
        if (!L.visible) continue;
        if (L.type === "adjustment") { _applyAdjustment(x, S.W, S.H, L); continue; }
        // Skip AI preview layer — we want user content only
        x.globalCompositeOperation = L.blendMode || "source-over";
        x.globalAlpha = L.opacity;
        x.drawImage(L.canvas, 0, 0);
    }

    // Downscale to generation resolution
    if (targetW !== S.W || targetH !== S.H) {
        const sc = _createCanvas(targetW, targetH);
        const sx = sc.getContext("2d");
        sx.drawImage(c, 0, 0, targetW, targetH);
        return sc.toDataURL("image/png");
    }
    return c.toDataURL("image/png");
}

/**
 * Set the AI preview image. Decodes base64 and stores for compositing.
 * Flicker-free: uses createImageBitmap for off-main-thread decode.
 */
function setLivePreview(imageB64) {
    if (!imageB64) return;

    // Ensure preview canvas exists at document size
    if (!S.livePreview.canvas || S.livePreview.canvas.width !== S.W || S.livePreview.canvas.height !== S.H) {
        S.livePreview.canvas = _createCanvas(S.W, S.H);
        S.livePreview.ctx = S.livePreview.canvas.getContext("2d");
    }

    // Decode image
    const img = new window.Image();
    img.onload = () => {
        S.livePreview.ctx.clearRect(0, 0, S.W, S.H);
        S.livePreview.ctx.drawImage(img, 0, 0, S.W, S.H);
        S.livePreview.active = true;
        composite();
    };
    img.src = imageB64;
}

/**
 * Clear the AI preview layer and trigger re-composite.
 */
function clearLivePreview() {
    if (S.livePreview.ctx) {
        S.livePreview.ctx.clearRect(0, 0, S.W, S.H);
    }
    S.livePreview.active = false;
    composite();
}

/**
 * Commit the AI preview to a new paint layer. Creates a layer named
 * "[Live]" with the current preview content.
 */
function applyLivePreview() {
    if (!S.livePreview.active || !S.livePreview.canvas) return;
    const L = makeLayer("[Live]", "paint");
    L.ctx.drawImage(S.livePreview.canvas, 0, 0);
    // Insert below active layer
    const idx = Math.max(0, S.activeLayerIdx);
    S.layers.splice(idx, 0, L);
    S.activeLayerIdx = idx;
    // Trigger UI update if callback exists
    if (S.onUndoRedo) S.onUndoRedo();
    composite();
}

// ========================================================================
// RESIZE
// ========================================================================
function resizeCanvas(nw, nh) {
    if (nw === S.W && nh === S.H) return;
    selectionClear();
    const savedLayers = S.layers.map(L => L.canvas ? L.ctx.getImageData(0, 0, S.W, S.H) : null);
    const savedMask = S.mask.ctx.getImageData(0, 0, S.W, S.H);
    // Save region canvases before dimension change
    // Use each region's actual canvas size (may differ from S.W×S.H if regions
    // were never resized by a prior resizeCanvas call — this is the first fix).
    const savedRegions = S.regions.map(r => ({
        data: r.ctx.getImageData(0, 0, r.canvas.width, r.canvas.height),
        w: r.canvas.width, h: r.canvas.height
    }));
    // Don't clear undo/redo — _restoreStructural handles dimension changes
    // via canvasW/canvasH stored in each snapshot.
    S.W = nw; S.H = nh;
    // Scale undo depth based on resolution to prevent RAM bloat
    // ~4MB per layer snapshot at 1024x1024, structural undos snapshot ALL layers
    const pixels = nw * nh;
    if (pixels > 4000000) S.maxUndo = 25;       // >2K: ~25 steps
    else if (pixels > 2000000) S.maxUndo = 50;   // >~1.5K: ~50 steps
    else S.maxUndo = 100;                         // standard
    // Trim stacks to new limit (resolution increase → smaller maxUndo)
    while (S.undoStack.length > S.maxUndo) S.undoStack.shift();
    while (S.redoStack.length > S.maxUndo) S.redoStack.shift();
    S.stroke.canvas.width = nw; S.stroke.canvas.height = nh;
    S.mask.canvas.width = nw; S.mask.canvas.height = nh;
    S.mask.ctx = S.mask.canvas.getContext("2d");
    for (let i = 0; i < S.layers.length; i++) {
        const L = S.layers[i];
        if (!L.canvas) continue;
        L.canvas.width = nw; L.canvas.height = nh;
        L.ctx = L.canvas.getContext("2d");
        if (L.type === "reference") {
            L.ctx.fillStyle = "#fff"; L.ctx.fillRect(0, 0, nw, nh);
        }
        if (savedLayers[i]) {
            const tmpC = _createCanvas(savedLayers[i].width, savedLayers[i].height);
            tmpC.getContext("2d").putImageData(savedLayers[i], 0, 0);
            L.ctx.drawImage(tmpC, 0, 0, nw, nh);
        }
    }
    const tmpM = _createCanvas(savedMask.width, savedMask.height);
    tmpM.getContext("2d").putImageData(savedMask, 0, 0);
    S.mask.ctx.drawImage(tmpM, 0, 0, nw, nh);
    // Resize region canvases to match new dimensions
    for (let i = 0; i < S.regions.length; i++) {
        const r = S.regions[i];
        r.canvas.width = nw; r.canvas.height = nh;
        r.ctx = r.canvas.getContext("2d");
        if (savedRegions[i]) {
            const sr = savedRegions[i];
            const tmpR = _createCanvas(sr.w, sr.h);
            tmpR.getContext("2d").putImageData(sr.data, 0, 0);
            r.ctx.drawImage(tmpR, 0, 0, nw, nh);
        }
    }
}

// ========================================================================
// BOOT
// ========================================================================
function boot(canvasElement) {
    if (S.ready) return;
    S.canvas = canvasElement;
    S.ctx = S.canvas.getContext("2d");
    S.canvas.width = 800; S.canvas.height = 600;

    // Initial layers
    const refLayer = makeLayer("Background", "reference");
    refLayer.ctx.fillStyle = "#fff"; refLayer.ctx.fillRect(0, 0, S.W, S.H);
    S.layers.push(refLayer);
    S.layers.push(makeLayer("Layer 1", "paint"));
    S.activeLayerIdx = 1;

    // Mask + stroke buffers
    S.mask.canvas = createLayerCanvas(); S.mask.ctx = S.mask.canvas.getContext("2d");
    S.stroke.canvas = _createCanvas(S.W, S.H); S.stroke.ctx = S.stroke.canvas.getContext("2d");

    S.ready = true;
    console.log("[StudioCore] Ready", S.W + "x" + S.H, "| Canvas 2D");
}

// ========================================================================
// APPLY MODE
// ========================================================================
function applyMode(mode) {
    S.studioMode = mode;
    if (!S.inpaintMode) S.inpaintMode = "Inpaint";
    const isSketch = mode === "Create", isInpaint = mode === "Edit";
    const ipModeVal = S.inpaintMode || "Inpaint";
    const isIPSketch = isInpaint && ipModeVal === "Inpaint Sketch";
    const isIPRegional = isInpaint && ipModeVal === "Regional";

    if (isSketch) {
        // In Create mode, editingMask is controlled by user's mask toggle (Q key)
        // Don't override if user has mask mode active
        if (!S._userMaskMode) S.editingMask = false;
        if (!S.regions.length) S.regionMode = false;
    } else if (isInpaint) {
        if (isIPRegional) {
            S.editingMask = false; S._userMaskMode = false; S.regionMode = true;
            if (!S.regions.length) addRegion("Region " + S._nextRegionId);
        } else {
            S.editingMask = S._userMaskMode || !isIPSketch; S.regionMode = false;
        }
    } else {
        if (!S._userMaskMode) S.editingMask = false;
        S.regionMode = false;
    }
}

// ========================================================================
// PUBLIC API — window.StudioCore
// ========================================================================
window.StudioCore = {
    // State access
    get state() { return S; },

    // Boot
    boot,

    // Compositor
    composite,

    // Export
    exportCanvas,
    exportMask,
    exportFlattened,
    serializeRegions,
    isCanvasBlank,

    // Layer flip / rotate
    flipLayerHorizontal: _flipLayerHorizontal,
    flipLayerVertical: _flipLayerVertical,
    rotateLayer90CW: _rotateLayer90CW,
    rotateLayer90CCW: _rotateLayer90CCW,
    rotateLayer180: _rotateLayer180,
    rotateLayerArbitrary: _rotateLayerArbitrary,

    // Resize
    resizeCanvas,

    // Mode
    applyMode,

    // Zoom/Pan
    zoomAt,
    zoomFit,
    screenToDoc,

    // Layers
    makeLayer,
    makeAdjustLayer,
    createLayerCanvas,
    activeLayer,
    findLayerIdx,
    drawTarget,
    drawColor,
    getLayerContentBounds,

    // Brush engine
    brushPx,
    pSz,
    pOp,
    beginStroke,
    plotTo,
    commitStroke,
    stampWet,
    stampWetErase,
    stab,

    // Tool algorithms
    floodFill,
    pickColor,
    drawGradient,
    drawShapePath,
    commitShape,
    smudgeInit,
    smudgeDrag,
    smudgeStroke,
    blurAt,
    pixelateAt,
    dodgeBurnAt,
    dodgeBurnStroke,
    liquifyPush,
    cloneStamp,
    regionPaintAt,
    regionPaintMove,
    regionEraseMove,

    // Color
    hexRgb,
    rgbHex,
    hsvToRgb,
    rgbToHsv,
    addColor,

    // Undo/Redo
    saveUndo,
    saveStructuralUndo,
    undo,
    redo,

    // Selection
    selectionAll,
    selectionClear,
    selectionInvert,
    selectionFill,
    selectionDelete,
    selectionToMask,
    selectionCopy,
    selectionCut,
    selectionPaste,
    selectionModify,
    featherSelection,
    fillPolygonMask,
    magicWandSelect,
    magneticEdgeMap,
    magneticPath,

    // Transform
    transformHitTest,
    HANDLE_SIZE,

    // Grid Renderer
    gridRender,
    gridDrawWireframe,
    gridFromRect,
    gridHitTest,
    mlsEvalGrid,

    // Regions
    addRegion,
    deleteRegion,
    clearRegion,
    activeRegion,

    // Live Painting
    compositeForLive,
    setLivePreview,
    clearLivePreview,
    applyLivePreview,

    // Constants
    ALL_BLEND_MODES,
    REGION_COLORS,
    DEFAULT_BRUSH_PRESETS,
    _blendToPS,
    _blendFromPS,
    _adjustDefaults,

    // Internal accessors for UI layer
    get cursorPos() { return { x: _cx, y: _cy }; },
    set cursorPos(v) { _cx = v.x; _cy = v.y; },
    get strokeAngle() { return _saSmooth; },
    set strokeAngle(v) { _saSmooth = v; },
    get strokeAngleRaw() { return _sa; },

    // Callback hooks for UI layer
    set onUndoRedo(fn) { _onUndoRedo = fn; },

    // Temp canvas utility (for UI overlays that need scratch space)
    getTempCanvas,

    // Adjustment rendering + helpers (for editor UI in canvas-ui.js)
    _applyAdjustment,
    _migrateAdjustParams,
    _compositeLayersBelow
};

console.log("[StudioCore] Module loaded — Phase 1 clean engine");

})();
