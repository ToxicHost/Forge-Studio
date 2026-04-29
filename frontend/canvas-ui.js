/**
 * Forge Studio — Canvas UI (Standalone)
 * by ToxicHost & Moritz
 *
 * Phase 2: DOM integration for canvas-core.js.
 * All event listeners, panel rendering, cursor drawing, and viewport sync.
 * Requires StudioCore (canvas-core.js) to be loaded first.
 */
(function () {
"use strict";

const C = window.StudioCore;
if (!C) { console.error("[StudioUI] StudioCore not loaded!"); return; }
const S = C.state;

// ========================================================================
// VIEWPORT SYNC
// ========================================================================
function syncCanvasToViewport() {
    const vp = document.getElementById("studio-viewport");
    if (!vp || !S.canvas) return;
    const rect = vp.getBoundingClientRect();
    // If the viewport is hidden (e.g. on Workshop tab), rect is 0×0 —
    // don't resize the display canvas to 100×100. Just bail out.
    if (rect.width < 10 || rect.height < 10) return;
    const w = Math.max(100, Math.round(rect.width));
    const h = Math.max(100, Math.round(rect.height));
    if (S.canvas.width !== w || S.canvas.height !== h) {
        S.canvas.width = w; S.canvas.height = h;
        S.canvas.style.width = w + "px";
        S.canvas.style.height = h + "px";
        S.canvas.style.display = "block";
        C.composite();
    }
}

function updateStatus() {
    const el = document.getElementById("canvasStatus");
    if (el) el.innerHTML = S.W + " &times; " + S.H + " &ensp; " + Math.round(S.zoom.scale * 100) + "%";
    const dims = document.getElementById("statusDims");
    if (dims) dims.innerHTML = S.W + " &times; " + S.H;
}

// ========================================================================
// TOOL SWITCHING
// ========================================================================
// Per-tool brush settings memory
var _TOOL_SETTINGS_KEY = "studio-tool-settings";
var _toolSettingsDefaults = {
    brush:   { brushSize: 20, brushOpacity: 1.0, brushHardness: 1.0, smoothing: 4, toolStrength: 0.5 },
    eraser:  { brushSize: 20, brushOpacity: 1.0, brushHardness: 1.0, smoothing: 4, toolStrength: 0.5 },
    smudge:  { brushSize: 20, brushOpacity: 1.0, brushHardness: 0.5, smoothing: 4, toolStrength: 0.5 },
    blur:    { brushSize: 30, brushOpacity: 1.0, brushHardness: 0.5, smoothing: 4, toolStrength: 0.5 },
    dodge:   { brushSize: 20, brushOpacity: 1.0, brushHardness: 0.5, smoothing: 4, toolStrength: 0.3 },
    clone:   { brushSize: 20, brushOpacity: 1.0, brushHardness: 1.0, smoothing: 4, toolStrength: 0.5 },
    liquify: { brushSize: 30, brushOpacity: 1.0, brushHardness: 0.5, smoothing: 4, toolStrength: 0.5, liquifySpacing: 0.2, liquifyMode: "move" },
    pixelate: { brushSize: 30, brushOpacity: 1.0, brushHardness: 1.0, smoothing: 4, toolStrength: 0.5 },
    shape:   { brushSize: 3,  brushOpacity: 1.0, brushHardness: 1.0, smoothing: 0, toolStrength: 0.5 },
};
var _toolSettings = (function() {
    try {
        var saved = JSON.parse(localStorage.getItem(_TOOL_SETTINGS_KEY));
        if (saved && typeof saved === "object") {
            // Merge saved over defaults so new tools get defaults
            var merged = {};
            for (var k in _toolSettingsDefaults) merged[k] = Object.assign({}, _toolSettingsDefaults[k], saved[k] || {});
            return merged;
        }
    } catch (e) {}
    return JSON.parse(JSON.stringify(_toolSettingsDefaults));
})();
var _prevTool = null;
var _brushSettingTools = ["brush", "eraser", "smudge", "blur", "dodge", "clone", "liquify", "pixelate", "shape"];
var _brushResizing = null; // { startX, startY, startSize, startOpacity } — active during shift-drag resize

function _persistToolSettings() {
    try { localStorage.setItem(_TOOL_SETTINGS_KEY, JSON.stringify(_toolSettings)); } catch (e) {}
}

// Save current tool on page close so last-used settings survive restart
window.addEventListener("beforeunload", function() {
    _saveToolSettings(S.tool);
});

// Apply saved brush settings at startup (brush is default tool)
(function() {
    var saved = _toolSettings.brush;
    if (saved) {
        S.brushSize = saved.brushSize;
        S.brushOpacity = saved.brushOpacity;
        S.brushHardness = saved.brushHardness;
        S.smoothing = saved.smoothing;
        S.toolStrength = saved.toolStrength;
    }
})();

function _saveToolSettings(tool) {
    if (!_brushSettingTools.includes(tool)) return;
    _toolSettings[tool] = {
        brushSize: S.brushSize,
        brushOpacity: S.brushOpacity,
        brushHardness: S.brushHardness,
        smoothing: S.smoothing,
        toolStrength: S.toolStrength,
        brushRatio: S.brushRatio,
        brushSpikes: S.brushSpikes,
        brushFalloff: S.brushFalloff,
        brushDensity: S.brushDensity
    };
    if (tool === "liquify") {
        _toolSettings[tool].liquifySpacing = S.liquifySpacing;
        _toolSettings[tool].liquifyMode = S.liquifyMode;
    }
    _persistToolSettings();
}

function _restoreToolSettings(tool) {
    if (!_brushSettingTools.includes(tool)) return;
    var saved = _toolSettings[tool];
    if (!saved) return;
    S.brushSize = saved.brushSize;
    S.brushOpacity = saved.brushOpacity;
    S.brushHardness = saved.brushHardness;
    S.smoothing = saved.smoothing;
    S.toolStrength = saved.toolStrength;
    S.brushRatio = saved.brushRatio ?? 1.0;
    S.brushSpikes = saved.brushSpikes ?? 2;
    S.brushFalloff = saved.brushFalloff ?? "default";
    S.brushDensity = saved.brushDensity ?? 1.0;
    // Sync falloff button UI
    document.querySelectorAll("[data-falloff]").forEach(b => {
        b.classList.toggle("active", b.dataset.falloff === S.brushFalloff);
    });
    if (tool === "liquify") {
        S.liquifySpacing = saved.liquifySpacing ?? 0.2;
        S.liquifyMode = saved.liquifyMode ?? "move";
        document.querySelectorAll("[data-liqmode]").forEach(b => {
            b.classList.toggle("active", b.dataset.liqmode === S.liquifyMode);
        });
    }
}

function setTool(t) {
    // Auto-commit active transform when switching away
    if (S.transform.active && t !== "transform") {
        _commitTransform(); _redraw();
    }

    // Save current tool's brush settings before switching
    _saveToolSettings(_prevTool || S.tool);

    S.tool = t;

    // Restore this tool's saved settings (if any)
    _restoreToolSettings(t);
    _prevTool = t;
    document.querySelectorAll("#toolstrip .tool-btn").forEach(b => {
        const bt = b.dataset.tool;
        const isLasso = bt === "lasso" && (t === "lasso" || t === "polylasso" || t === "maglasso");
        b.classList.toggle("active", bt === t || isLasso);
    });

    // Per-tool context bar visibility
    const show = {
        brush:     ["size","opacity","hardness","smoothing","sym-opts","mask-toggle","pressure-opts"],
        eraser:    ["size","opacity","hardness","smoothing","mask-toggle","pressure-opts"],
        smudge:    ["size","strength","sym-opts"],
        blur:      ["size","strength"],
        pixelate:  ["size","strength"],
        dodge:     ["size","strength","db-opts"],
        liquify:   ["size","strength","liquify-opts"],
        clone:     ["size","opacity","hardness"],
        fill:      ["opacity"],
        gradient:  ["opacity","grad-opts"],
        shape:     ["size","opacity","shape-opts"],
        eyedropper:["eye-opts"],
        select:    [], ellipse:[], lasso:["lasso-opts"], polylasso:["lasso-opts"], maglasso:["lasso-opts"], wand:["strength"],
        transform: ["transform-opts"], crop:["crop-opts"], text:[]
    };
    const visible = new Set(show[t] || ["size","opacity"]);
    document.querySelectorAll("#contextBar .ctx-item").forEach(el => {
        const ctx = el.dataset.ctx;
        el.style.display = visible.has(ctx) ? "" : "none";
    });

    // Show/hide brush presets (only for brush/eraser)
    const presets = document.getElementById("brushPresets");
    if (presets) presets.style.display = (t === "brush" || t === "eraser") ? "" : "none";

    // If switching away from brush/eraser, turn off mask mode
    if (t !== "brush" && t !== "eraser" && S.editingMask && S._userMaskMode) {
        S.editingMask = false;
        S._userMaskMode = false;
        _updateMaskToggleUI();
        const ipBar = document.getElementById("inpaintBar");
        if (ipBar) ipBar.style.display = "none";
        const siSection = document.getElementById("softInpaintSection");
        if (siSection) siSection.style.display = "none";
    }

    // Cursor style
    if (S.canvas) {
        const customCursorTools = ["brush", "eraser", "smudge", "blur", "dodge", "clone", "liquify", "pixelate"];
        if (customCursorTools.includes(t)) S.canvas.style.cursor = "none";
        else if (["eyedropper", "fill", "gradient", "select", "ellipse", "lasso", "polylasso", "maglasso", "wand", "crop"].includes(t)) S.canvas.style.cursor = "crosshair";
        else S.canvas.style.cursor = "default";
    }

    // Sync lasso subtool buttons
    document.querySelectorAll("[data-lassotype]").forEach(b => {
        b.classList.toggle("active", b.dataset.lassotype === t);
    });

    // Sync context bar to show this tool's restored settings
    _syncCtxBar();
}

// Mask mode toggle — Q key or context bar button
function toggleMaskMode() {
    // Block mask toggle mid-stroke — drawTarget is locked at stroke start,
    // but flipping the UI state mid-draw is confusing and can cause undo mismatches.
    if (S.drawing) return;
    S._userMaskMode = !S._userMaskMode;
    S.editingMask = S._userMaskMode;
    if (S._userMaskMode && window.StudioCore) {
        window.StudioCore.state.mask.visible = true;
    }
    // Show/hide inpaint settings bar
    const ipBar = document.getElementById("inpaintBar");
    if (ipBar) ipBar.style.display = S._userMaskMode ? "" : "none";
    const siSection = document.getElementById("softInpaintSection");
    if (siSection) siSection.style.display = S._userMaskMode ? "" : "none";
    _updateMaskToggleUI();
    _redraw();
}

function _updateMaskToggleUI() {
    const btn = document.getElementById("maskModeBtn");
    if (btn) {
        btn.classList.toggle("active", S._userMaskMode);
        btn.textContent = S._userMaskMode ? "Mask ●" : "Mask";
    }
}

// ========================================================================
// CURSOR RENDERING
// ========================================================================
function drawCursor() {
    const pos = C.cursorPos;
    if ((pos.x === -1 && pos.y === -1) || S.tool === "eyedropper" || S.tool === "fill" ||
        S.tool === "select" || S.tool === "wand" || S.tool === "transform" ||
        S.tool === "crop" || S.tool === "gradient" || S.tool === "shape" ||
        S.tool === "text" || S.tool === "ellipse" || S.tool === "lasso" ||
        S.tool === "polylasso" || S.tool === "maglasso" || S.studioMode === "img2img") return;
    const c = S.ctx, z = S.zoom;
    c.setTransform(z.scale, 0, 0, z.scale, z.ox, z.oy);
    const pr = C.brushPx() / 2;
    const lw = 2 / z.scale, lwThin = 1 / z.scale;
    c.save();

    const preset = (S.tool === "brush" || S.tool === "eraser") ? S.brushPreset : "round";
    switch (preset) {
        case "flat": {
            const ang = C.strokeAngle || 0;
            c.translate(pos.x, pos.y); c.rotate(ang);
            c.strokeStyle = "rgba(0,0,0,0.85)"; c.lineWidth = lw; c.setLineDash([]);
            c.beginPath(); c.ellipse(0, 0, Math.max(1 / z.scale, pr), Math.max(1 / z.scale, pr * 0.3), 0, 0, Math.PI * 2); c.stroke();
            c.strokeStyle = "rgba(210,210,210,0.7)"; c.lineWidth = lwThin; c.setLineDash([3 / z.scale, 3 / z.scale]);
            c.beginPath(); c.ellipse(0, 0, Math.max(1 / z.scale, pr), Math.max(1 / z.scale, pr * 0.3), 0, 0, Math.PI * 2); c.stroke();
            c.rotate(-ang); c.translate(-pos.x, -pos.y);
            break;
        }
        case "marker": {
            const ang = 0.4;
            const rw = pr * 0.8 * 2, rh = pr * 0.35 * 2;
            c.translate(pos.x, pos.y); c.rotate(ang);
            c.strokeStyle = "rgba(0,0,0,0.85)"; c.lineWidth = lw; c.setLineDash([]);
            c.strokeRect(-rw / 2, -rh / 2, rw, rh);
            c.strokeStyle = "rgba(210,210,210,0.7)"; c.lineWidth = lwThin; c.setLineDash([3 / z.scale, 3 / z.scale]);
            c.strokeRect(-rw / 2, -rh / 2, rw, rh);
            c.rotate(-ang); c.translate(-pos.x, -pos.y);
            break;
        }
        case "scatter": {
            c.strokeStyle = "rgba(0,0,0,0.85)"; c.lineWidth = lw; c.setLineDash([2 / z.scale, 3 / z.scale]);
            c.beginPath(); c.arc(pos.x, pos.y, Math.max(1 / z.scale, pr), 0, Math.PI * 2); c.stroke();
            c.strokeStyle = "rgba(210,210,210,0.7)"; c.lineWidth = lwThin; c.setLineDash([3 / z.scale, 2 / z.scale]);
            c.beginPath(); c.arc(pos.x, pos.y, Math.max(1 / z.scale, pr), 0, Math.PI * 2); c.stroke();
            c.setLineDash([]); c.fillStyle = "rgba(180,180,180,0.4)";
            c.beginPath(); c.arc(pos.x, pos.y, Math.max(1 / z.scale, pr * 0.15), 0, Math.PI * 2); c.fill();
            break;
        }
        default: {
            c.strokeStyle = "rgba(0,0,0,0.85)"; c.lineWidth = lw; c.setLineDash([]);
            c.beginPath(); c.arc(pos.x, pos.y, Math.max(1 / z.scale, pr), 0, Math.PI * 2); c.stroke();
            c.strokeStyle = "rgba(210,210,210,0.7)"; c.lineWidth = lwThin; c.setLineDash([3 / z.scale, 3 / z.scale]);
            c.beginPath(); c.arc(pos.x, pos.y, Math.max(1 / z.scale, pr), 0, Math.PI * 2); c.stroke();
        }
    }
    // Mask mode indicator — red tint fill inside cursor
    if (S.editingMask && S._userMaskMode) {
        c.fillStyle = "rgba(255,40,40,0.18)";
        c.beginPath(); c.arc(pos.x, pos.y, Math.max(1 / z.scale, pr), 0, Math.PI * 2); c.fill();
    }
    // Crosshair — red when mask mode active
    c.setLineDash([]);
    c.strokeStyle = S.editingMask && S._userMaskMode ? "rgba(255,40,40,0.9)" : "rgba(0,0,0,0.8)";
    c.lineWidth = 1.5 / z.scale;
    const ch = 4 / z.scale;
    c.beginPath(); c.moveTo(pos.x - ch, pos.y); c.lineTo(pos.x + ch, pos.y); c.stroke();
    c.beginPath(); c.moveTo(pos.x, pos.y - ch); c.lineTo(pos.x, pos.y + ch); c.stroke();
    // Clone stamp source indicator
    if (S.tool === "clone" && S._cloneSource) {
        let sx, sy;
        if (S._cloneOffset) {
            // Show live sampling position relative to cursor
            sx = pos.x + S._cloneOffset.dx;
            sy = pos.y + S._cloneOffset.dy;
        } else {
            // Show alt-clicked source point (before first stroke)
            sx = S._cloneSource.x;
            sy = S._cloneSource.y;
        }
        const sch = 6 / z.scale, slw = 1.5 / z.scale;
        // Outer black for contrast
        c.strokeStyle = "rgba(0,0,0,0.7)"; c.lineWidth = slw + 1 / z.scale;
        c.beginPath(); c.moveTo(sx - sch, sy); c.lineTo(sx + sch, sy); c.stroke();
        c.beginPath(); c.moveTo(sx, sy - sch); c.lineTo(sx, sy + sch); c.stroke();
        // Inner cyan
        c.strokeStyle = "rgba(0,220,255,0.9)"; c.lineWidth = slw;
        c.beginPath(); c.moveTo(sx - sch, sy); c.lineTo(sx + sch, sy); c.stroke();
        c.beginPath(); c.moveTo(sx, sy - sch); c.lineTo(sx, sy + sch); c.stroke();
        // Source circle
        c.strokeStyle = "rgba(0,220,255,0.5)"; c.lineWidth = 1 / z.scale;
        c.setLineDash([3 / z.scale, 3 / z.scale]);
        c.beginPath(); c.arc(sx, sy, Math.max(1 / z.scale, pr), 0, Math.PI * 2); c.stroke();
        c.setLineDash([]);
    }
    c.restore();
    c.setTransform(1, 0, 0, 1, 0, 0);
}

// ========================================================================
// MARCHING ANTS
// ========================================================================
function drawMarchingAnts(c) {
    if (!S.selection.active || !S.selection.mask) return;
    c.save();
    const z = S.zoom;
    c.setTransform(z.scale, 0, 0, z.scale, z.ox, z.oy);
    const lw = 1 / z.scale, dash = 6 / z.scale;

    if (S.selection._isLasso && S.selection._contour) {
        const pts = S.selection._contour;
        c.lineWidth = lw; c.setLineDash([dash, dash]);
        c.strokeStyle = "#000"; c.lineDashOffset = -S.selection.marchOffset;
        c.beginPath(); c.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
        c.closePath(); c.stroke();
        c.strokeStyle = "#fff"; c.lineDashOffset = -S.selection.marchOffset + dash;
        c.beginPath(); c.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
        c.closePath(); c.stroke();
    } else if (S.selection._isEllipse && S.selection.rect) {
        const r = S.selection.rect;
        const ecx = r.x + r.w / 2, ecy = r.y + r.h / 2;
        c.lineWidth = lw; c.setLineDash([dash, dash]);
        c.strokeStyle = "#000"; c.lineDashOffset = -S.selection.marchOffset;
        c.beginPath(); c.ellipse(ecx, ecy, Math.max(1, r.w / 2), Math.max(1, r.h / 2), 0, 0, Math.PI * 2); c.stroke();
        c.strokeStyle = "#fff"; c.lineDashOffset = -S.selection.marchOffset + dash;
        c.beginPath(); c.ellipse(ecx, ecy, Math.max(1, r.w / 2), Math.max(1, r.h / 2), 0, 0, Math.PI * 2); c.stroke();
    } else if (S.selection._isMaskBased) {
        // Edge-based marching ants for mask selections
        // Cache edge pixel positions — only recompute when mask changes
        const w = S.W, h = S.H, mask = S.selection.mask;
        if (!S.selection._edgeCache || S.selection._edgeCacheMask !== mask || S.selection._edgeCacheLen !== mask.length) {
            const edges = [];
            for (let py = 0; py < h; py++) {
                for (let px = 0; px < w; px++) {
                    if (mask[py * w + px] === 0) continue;
                    const idx = py * w + px;
                    if (px === 0 || px === w - 1 || py === 0 || py === h - 1 ||
                        mask[idx - 1] === 0 || mask[idx + 1] === 0 ||
                        mask[idx - w] === 0 || mask[idx + w] === 0) {
                        edges.push(px, py);
                    }
                }
            }
            S.selection._edgeCache = edges;
            S.selection._edgeCacheMask = mask;
            S.selection._edgeCacheLen = mask.length;
        }
        const edges = S.selection._edgeCache;
        const edgeCanvas = C.getTempCanvas("marchingAnts", w, h);
        const ectx = edgeCanvas.getContext("2d");
        const eimg = ectx.createImageData(w, h);
        const ed = eimg.data;
        const phase = Math.floor(S.selection.marchOffset) % 8;
        for (let i = 0; i < edges.length; i += 2) {
            const px = edges[i], py = edges[i + 1];
            const j = (py * w + px) * 4;
            const stripe = ((px + py + phase) % 8) < 4;
            ed[j] = stripe ? 255 : 0; ed[j + 1] = stripe ? 255 : 0;
            ed[j + 2] = stripe ? 255 : 0; ed[j + 3] = 220;
        }
        ectx.putImageData(eimg, 0, 0);
        c.globalAlpha = 1; c.drawImage(edgeCanvas, 0, 0);
    } else if (S.selection.rect) {
        const r = S.selection.rect;
        c.strokeStyle = "#000"; c.lineWidth = lw; c.setLineDash([dash, dash]);
        c.lineDashOffset = -S.selection.marchOffset; c.strokeRect(r.x, r.y, r.w, r.h);
        c.strokeStyle = "#fff"; c.lineDashOffset = -S.selection.marchOffset + dash;
        c.strokeRect(r.x, r.y, r.w, r.h);
    }
    c.restore();
    c.setTransform(1, 0, 0, 1, 0, 0);
}

function startMarchingAnts() {
    stopMarchingAnts();
    function march() {
        S.selection.marchOffset = (S.selection.marchOffset + 0.5) % 24;
        _redraw();
        S.selection.animId = requestAnimationFrame(march);
    }
    S.selection.animId = requestAnimationFrame(march);
}

function stopMarchingAnts() {
    if (S.selection.animId) { cancelAnimationFrame(S.selection.animId); S.selection.animId = null; }
}

// ========================================================================
// TRANSFORM HANDLES
// ========================================================================
function drawTransformHandles(c) {
    const b = S.transform.bounds;
    if (!b) return;
    const z = S.zoom;
    const hs = C.HANDLE_SIZE / z.scale;

    // ── Perspective mode: grid-based rendering ──
    if (S.transform.perspective && S.transform.grid) {
        c.setTransform(z.scale, 0, 0, z.scale, z.ox, z.oy);
        const grid = S.transform.grid;
        const srcRect = { x: 0, y: 0, w: S.transform.canvas.width, h: S.transform.canvas.height };
        const opacity = S.layers[S.transform.layerIdx]?.opacity ?? 1;
        C.gridRender(c, S.transform.canvas, srcRect, grid, 3, opacity);
        C.gridDrawWireframe(c, grid, 0, "#4af", 1.5 / z.scale);
        // Corner handles
        c.fillStyle = "#fff"; c.strokeStyle = "#4af"; c.lineWidth = 1 / z.scale;
        for (let i = 0; i < grid.length; i++) {
            for (let j = 0; j < grid[i].length; j++) {
                const pt = grid[i][j];
                c.fillRect(pt.x - hs / 2, pt.y - hs / 2, hs, hs);
                c.strokeRect(pt.x - hs / 2, pt.y - hs / 2, hs, hs);
            }
        }
        c.setTransform(1, 0, 0, 1, 0, 0);
        return;
    }

    // ── Warp mode: MLS deformation ──
    if (S.transform.warp && S.transform.warpGrid && S.transform.warpOrigGrid) {
        c.setTransform(z.scale, 0, 0, z.scale, z.ox, z.oy);
        const srcRect = { x: 0, y: 0, w: S.transform.canvas.width, h: S.transform.canvas.height };
        const opacity = S.layers[S.transform.layerIdx]?.opacity ?? 1;
        const evalGrid = C.mlsEvalGrid(
            S.transform.warpOrigGrid, S.transform.warpGrid,
            b, 12, S.transform.warpMode || "rigid"
        );
        C.gridRender(c, S.transform.canvas, srcRect, evalGrid, 1, opacity);
        // Wireframe of eval grid (subtle)
        C.gridDrawWireframe(c, evalGrid, 0, "rgba(68,170,255,0.25)", 0.5 / z.scale);
        // Control grid wireframe (brighter)
        C.gridDrawWireframe(c, S.transform.warpGrid, 0, "#4af", 1.5 / z.scale);
        // Control point handles
        c.fillStyle = "#fff"; c.strokeStyle = "#4af"; c.lineWidth = 1 / z.scale;
        for (const row of S.transform.warpGrid) {
            for (const pt of row) {
                c.beginPath(); c.arc(pt.x, pt.y, hs * 0.6, 0, Math.PI * 2);
                c.fill(); c.stroke();
            }
        }
        c.setTransform(1, 0, 0, 1, 0, 0);
        return;
    }

    // ── Affine mode ──
    c.setTransform(z.scale, 0, 0, z.scale, z.ox, z.oy);
    const rot = S.transform.rotation || 0;
    const fh = S.transform.flipH, fv = S.transform.flipV;
    const skX = S.transform.skewX || 0, skY = S.transform.skewY || 0;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;

    if (S.transform.canvas) {
        c.save(); c.translate(cx, cy); c.rotate(rot);
        c.transform(1, skY, skX, 1, 0, 0);
        c.scale(fh ? -1 : 1, fv ? -1 : 1);
        c.globalAlpha = S.layers[S.transform.layerIdx]?.opacity ?? 1;
        c.drawImage(S.transform.canvas, -b.w / 2, -b.h / 2, b.w, b.h);
        c.restore();
    }
    c.save(); c.translate(cx, cy); c.rotate(rot);
    c.transform(1, skY, skX, 1, 0, 0);
    c.strokeStyle = "#4af"; c.lineWidth = 1.5 / z.scale; c.setLineDash([]);
    c.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);
    const corners = [[-b.w / 2, -b.h / 2], [b.w / 2, -b.h / 2], [-b.w / 2, b.h / 2], [b.w / 2, b.h / 2]];
    const edges = [[0, -b.h / 2], [0, b.h / 2], [-b.w / 2, 0], [b.w / 2, 0]];
    c.fillStyle = "#fff"; c.strokeStyle = "#4af"; c.lineWidth = 1 / z.scale;
    for (const [hx, hy] of corners) { c.fillRect(hx - hs / 2, hy - hs / 2, hs, hs); c.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs); }
    const ehs = hs * 0.7;
    if (S.transform.skewMode) {
        // Diamond-shaped edge handles indicate skew mode
        c.fillStyle = "#afe";
        for (const [hx, hy] of edges) {
            c.save(); c.translate(hx, hy); c.rotate(Math.PI / 4);
            c.fillRect(-ehs / 2, -ehs / 2, ehs, ehs);
            c.strokeRect(-ehs / 2, -ehs / 2, ehs, ehs);
            c.restore();
        }
    } else {
        c.fillStyle = "#ddf";
        for (const [hx, hy] of edges) { c.fillRect(hx - ehs / 2, hy - ehs / 2, ehs, ehs); c.strokeRect(hx - ehs / 2, hy - ehs / 2, ehs, ehs); }
    }
    // Rotation handle
    const rhY = -b.h / 2 - 25 / z.scale;
    c.beginPath(); c.moveTo(0, -b.h / 2); c.lineTo(0, rhY); c.stroke();
    c.beginPath(); c.arc(0, rhY, hs * 0.8, 0, Math.PI * 2);
    c.fillStyle = "#4af"; c.fill(); c.strokeStyle = "#fff"; c.stroke();
    c.restore();
    c.setTransform(1, 0, 0, 1, 0, 0);
}

// ========================================================================
// COMPOSITE + OVERLAY (wraps core composite with UI overlays)
// ========================================================================
function _redraw() {
    C.composite();
    const c = S.ctx;
    if (!c) return;

    // Grid overlay — drawn in document space on top of composited layers
    if (S.showGrid) {
        const z = S.zoom;
        c.setTransform(z.scale, 0, 0, z.scale, z.ox, z.oy);
        c.save();
        c.strokeStyle = "rgba(255,255,255,0.07)";
        c.lineWidth = 1 / z.scale;
        const step = 32;
        c.beginPath();
        for (let x = 0; x <= S.W; x += step) { c.moveTo(x, 0); c.lineTo(x, S.H); }
        for (let y = 0; y <= S.H; y += step) { c.moveTo(0, y); c.lineTo(S.W, y); }
        c.stroke();
        c.restore();
        c.setTransform(1, 0, 0, 1, 0, 0);
    }

    // Draw overlays in zoom space
    if (S.selection.active && S.selection.mask) drawMarchingAnts(c);
    if (S.transform.active) { drawTransformHandles(c); _syncTransformInputs(); }
    // Selection drag preview
    if (S.selection.dragging && (S.tool === "select" || S.tool === "ellipse") && S.selection.rect) {
        const z = S.zoom, r = S.selection.rect;
        c.setTransform(z.scale, 0, 0, z.scale, z.ox, z.oy);
        c.save();
        c.strokeStyle = "rgba(100,180,255,0.6)"; c.lineWidth = 1 / z.scale;
        c.setLineDash([4 / z.scale, 4 / z.scale]);
        if (S.tool === "ellipse") {
            const ecx = r.x + r.w / 2, ecy = r.y + r.h / 2;
            const erx = Math.max(1, Math.abs(r.w) / 2), ery = Math.max(1, Math.abs(r.h) / 2);
            c.beginPath(); c.ellipse(ecx, ecy, erx, ery, 0, 0, Math.PI * 2);
            c.stroke();
            c.fillStyle = "rgba(100,180,255,0.08)"; c.fill();
        } else {
            c.strokeRect(r.x, r.y, r.w, r.h);
            c.fillStyle = "rgba(100,180,255,0.08)"; c.fillRect(r.x, r.y, r.w, r.h);
        }
        c.restore(); c.setTransform(1, 0, 0, 1, 0, 0);
    }
    // Poly lasso in-progress
    if (S._polyPoints && S._polyPoints.length > 0) {
        const z = S.zoom;
        c.setTransform(z.scale, 0, 0, z.scale, z.ox, z.oy);
        c.save(); c.strokeStyle = "#fff"; c.lineWidth = 1 / z.scale; c.setLineDash([3 / z.scale, 3 / z.scale]);
        c.beginPath(); c.moveTo(S._polyPoints[0].x, S._polyPoints[0].y);
        for (let i = 1; i < S._polyPoints.length; i++) c.lineTo(S._polyPoints[i].x, S._polyPoints[i].y);
        c.stroke();
        // Draw dots at vertices
        c.fillStyle = "#4af";
        for (const p of S._polyPoints) { c.beginPath(); c.arc(p.x, p.y, 3 / z.scale, 0, Math.PI * 2); c.fill(); }
        c.restore(); c.setTransform(1, 0, 0, 1, 0, 0);
    }
    // Freehand lasso in-progress
    if (S.tool === "lasso" && S.selection.dragging && S.selection.lassoPoints && S.selection.lassoPoints.length > 1) {
        const z = S.zoom, pts = S.selection.lassoPoints;
        c.setTransform(z.scale, 0, 0, z.scale, z.ox, z.oy);
        c.save(); c.strokeStyle = "rgba(100,180,255,0.6)"; c.lineWidth = 1 / z.scale; c.setLineDash([4 / z.scale, 4 / z.scale]);
        c.beginPath(); c.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
        c.stroke();
        c.restore(); c.setTransform(1, 0, 0, 1, 0, 0);
    }
    // Magnetic lasso in-progress
    if (S._magAnchors && S._magAnchors.length > 0) {
        const z = S.zoom;
        c.setTransform(z.scale, 0, 0, z.scale, z.ox, z.oy);
        c.save();
        // Draw committed paths (solid)
        c.strokeStyle = "#4af"; c.lineWidth = 1.5 / z.scale; c.setLineDash([]);
        for (const path of (S._magPaths || [])) {
            if (path.length < 2) continue;
            c.beginPath(); c.moveTo(path[0].x, path[0].y);
            for (let i = 1; i < path.length; i++) c.lineTo(path[i].x, path[i].y);
            c.stroke();
        }
        // Draw live preview path (dashed)
        if (S._magLivePath && S._magLivePath.length > 1) {
            c.strokeStyle = "rgba(100,200,255,0.6)"; c.setLineDash([3 / z.scale, 3 / z.scale]);
            c.beginPath(); c.moveTo(S._magLivePath[0].x, S._magLivePath[0].y);
            for (let i = 1; i < S._magLivePath.length; i++) c.lineTo(S._magLivePath[i].x, S._magLivePath[i].y);
            c.stroke();
        }
        // Draw anchor dots
        c.fillStyle = "#4af"; c.setLineDash([]);
        for (const a of S._magAnchors) { c.beginPath(); c.arc(a.x, a.y, 3.5 / z.scale, 0, Math.PI * 2); c.fill(); }
        // Close indicator — highlight first anchor if cursor near it
        if (S._magAnchors.length > 2 && C.cursorPos) {
            const first = S._magAnchors[0], cp = C.cursorPos;
            if (Math.hypot(cp.x - first.x, cp.y - first.y) < 12) {
                c.strokeStyle = "#fff"; c.lineWidth = 2 / z.scale;
                c.beginPath(); c.arc(first.x, first.y, 5 / z.scale, 0, Math.PI * 2); c.stroke();
            }
        }
        c.restore(); c.setTransform(1, 0, 0, 1, 0, 0);
    }
    drawCursor();

    // Restore zoom transform + safe composite state so Firefox's WebRender
    // compositor doesn't re-rasterize at identity (1:1) during layer transactions
    const _z = S.zoom;
    c.setTransform(_z.scale, 0, 0, _z.scale, _z.ox, _z.oy);
    c.globalAlpha = 1;
    c.globalCompositeOperation = "source-over";
}

// Override core's composite to add overlays
const _origComposite = C.composite;
// We don't override — we call _redraw which calls C.composite + overlays

// ========================================================================
// POINTER EVENT HANDLING
// ========================================================================
function pos(e) {
    const p = C.screenToDoc(e.clientX, e.clientY);
    p.pressure = e.pressure || 0.5;
    return p;
}

function getSelModifier(e) {
    if (e.shiftKey) return "add";
    if (e.altKey) return "subtract";
    return "replace";
}

function bindCanvas() {
    const cv = S.canvas;
    if (!cv) return;

    // Prevent default touch actions for stylus
    cv.style.touchAction = "none";

    // === PAN (right-click, middle-click, or Space+drag) ===
    // === ZOOM-DRAG (Krita-style Shift+Space+drag) ===
    let _spaceHeld = false;
    let _zoomDrag = { active: false, startY: 0, startScale: 1, anchorX: 0, anchorY: 0 };
    document.addEventListener("keydown", e => { if (e.code === "Space" && !["INPUT","TEXTAREA","SELECT"].includes(e.target.tagName)) { _spaceHeld = true; if (S.canvas) S.canvas.style.cursor = e.shiftKey ? "ns-resize" : "grab"; e.preventDefault(); } });
    document.addEventListener("keyup", e => { if (e.code === "Space") { _spaceHeld = false; if (S.canvas && !S.zoom.panning && !_zoomDrag.active) setTool(S.tool); } });

    cv.addEventListener("pointerdown", e => {
        // Shift+Space+LeftClick → zoom-drag (Krita-style). Must come before pan check.
        if (e.button === 0 && _spaceHeld && e.shiftKey) {
            _zoomDrag.active = true;
            _zoomDrag.startY = e.clientY;
            _zoomDrag.startScale = S.zoom.scale;
            _zoomDrag.anchorX = e.clientX;
            _zoomDrag.anchorY = e.clientY;
            cv.setPointerCapture(e.pointerId);
            if (S.canvas) S.canvas.style.cursor = "ns-resize";
            e.preventDefault();
            return;
        }
        if (e.button === 2 || e.button === 1 || (e.button === 0 && _spaceHeld) ||
            (e.button === 0 && e.altKey && S.tool !== "clone")) {
            S.zoom.panning = true;
            S.zoom.panStartX = e.clientX; S.zoom.panStartY = e.clientY;
            S.zoom.panOxStart = S.zoom.ox; S.zoom.panOyStart = S.zoom.oy;
            S.zoom._panMoved = false;
            cv.setPointerCapture(e.pointerId);
            if (S.canvas) S.canvas.style.cursor = "grabbing";
            e.preventDefault();
        }
    });
    cv.addEventListener("contextmenu", e => e.preventDefault());
    // Prevent browser context menu in Studio canvas — it's a full-screen app.
    // Allow native menu on text inputs (paste/spellcheck), gallery detail
    // images (save/open in new tab), and the gallery detail sidebar so
    // users can right-click → Copy on prompt / metadata text.
    document.addEventListener("contextmenu", e => {
        if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
        if (e.target.closest(".gal-detail-img-area")) return;
        if (e.target.closest(".gal-detail-sidebar")) return;
        e.preventDefault();
    });
    cv.addEventListener("pointermove", e => {
        if (_zoomDrag.active) {
            const deltaY = _zoomDrag.startY - e.clientY; // up = zoom in
            const targetScale = Math.min(16, Math.max(0.1, _zoomDrag.startScale * Math.pow(1.005, deltaY)));
            const factor = targetScale / S.zoom.scale;
            if (factor !== 1) { C.zoomAt(_zoomDrag.anchorX, _zoomDrag.anchorY, factor); updateStatus(); _redraw(); }
            return;
        }
        if (S.zoom.panning) {
            const dx = e.clientX - S.zoom.panStartX;
            const dy = e.clientY - S.zoom.panStartY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) S.zoom._panMoved = true;
            const r = cv.getBoundingClientRect();
            S.zoom.ox = S.zoom.panOxStart + (e.clientX - S.zoom.panStartX) * (cv.width / r.width);
            S.zoom.oy = S.zoom.panOyStart + (e.clientY - S.zoom.panStartY) * (cv.height / r.height);
            _redraw();
        }
    });
    cv.addEventListener("pointerup", e => {
        if (_zoomDrag.active) {
            _zoomDrag.active = false;
            try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
            if (S.canvas) S.canvas.style.cursor = _spaceHeld ? "grab" : "";
            if (!_spaceHeld) setTool(S.tool);
            return;
        }
        if (S.zoom.panning) {
            const didMove = S.zoom._panMoved;
            S.zoom.panning = false;
            S.zoom._panMoved = false;
            try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
            setTool(S.tool); // restore cursor
            // Right-click without drag → context menu
            if (e.button === 2 && !didMove) {
                _showCtxMenu(e.clientX, e.clientY);
            }
        }
    });

    // === ZOOM (wheel) ===
    cv.addEventListener("wheel", e => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        C.zoomAt(e.clientX, e.clientY, factor);
        updateStatus();
        _redraw();
    }, { passive: false });

    // === DRAWING / TOOLS ===
    cv.addEventListener("pointerdown", e => {
        if (e.button !== 0) return;
        // Suppress brush stroke if this click just dismissed the context menu
        if (_ctxMenuJustClosed) { _ctxMenuJustClosed = false; return; }
        if (S.zoom.panning || _spaceHeld) return;
        if (S.studioMode === "img2img") return;
        const p = pos(e);

        // Ctrl-click eyedropper — pick color without switching tools
        if (e.ctrlKey && !e.shiftKey && !e.altKey && S.tool !== "transform" && S.tool !== "text") {
            C.pickColor(p); updateColorUI(); _redraw(); return;
        }

        // Shift-drag brush resize — horizontal drag adjusts size
        // Excludes shape (shift = constrain proportions) and selection-adjacent tools
        if (e.shiftKey && !e.ctrlKey && !e.altKey &&
            ["brush", "eraser", "smudge", "blur", "dodge", "clone", "liquify", "pixelate"].includes(S.tool)) {
            _brushResizing = { startX: e.clientX, startY: e.clientY, startSize: S.brushSize };
            cv.setPointerCapture(e.pointerId);
            S.canvas.style.cursor = "ew-resize";
            return;
        }

        if (S.tool === "eyedropper") { C.saveUndo("Eyedropper"); C.pickColor(p); updateColorUI(); _redraw(); return; }
        if (S.tool === "fill") { C.saveUndo("Flood fill"); C.floodFill(p); renderHistoryPanel(); _redraw(); return; }

        // Wand
        if (S.tool === "wand") {
            const mod = getSelModifier(e);
            const result = C.magicWandSelect(p);
            if (result) {
                if (mod !== "replace" && S.selection.mask) {
                    C.selectionModify(result.mask, mod);
                } else {
                    S.selection.mask = result.mask;
                    S.selection.rect = result.rect;
                    S.selection.active = true;
                    S.selection._isMaskBased = true;
                }
                startMarchingAnts();
            }
            _redraw(); return;
        }

        // Transform
        if (S.tool === "transform") {
            if (!S.transform.active) {
                // Begin transform
                const L = C.activeLayer(); if (!L) return;
                let bounds;
                if (S.selection.active && S.selection.rect) bounds = { ...S.selection.rect };
                else bounds = C.getLayerContentBounds(L);
                if (!bounds) return;
                C.saveStructuralUndo("Transform");
                const origData = L.ctx.getImageData(0, 0, S.W, S.H);
                const tc = document.createElement("canvas");
                tc.width = bounds.w; tc.height = bounds.h;
                tc.getContext("2d").drawImage(L.canvas, bounds.x, bounds.y, bounds.w, bounds.h, 0, 0, bounds.w, bounds.h);
                L.ctx.clearRect(bounds.x, bounds.y, bounds.w, bounds.h);
                S.transform = {
                    active: true, bounds: { ...bounds }, origBounds: { ...bounds },
                    originalData: origData,
                    layerIdx: S.activeLayerIdx, canvas: tc, ctx: tc.getContext("2d"),
                    dragMode: null, dragStart: null, origDragBounds: null, rotation: 0,
                    flipH: false, flipV: false, aspectLock: false,
                    skewX: 0, skewY: 0, skewMode: false,
                    perspective: false, grid: null, dragGridPt: null,
                    warp: false, warpGrid: null, warpOrigGrid: null,
                    warpMode: "rigid", warpDensity: 3
                };
                C.selectionClear(); stopMarchingAnts();
                _redraw(); return;
            }
            // ── Perspective mode mousedown ──
            if (S.transform.perspective && S.transform.grid) {
                const grid = S.transform.grid;
                const tol = C.HANDLE_SIZE / S.zoom.scale;
                const gHit = C.gridHitTest(grid, p.x, p.y, tol);
                if (gHit) {
                    S.transform.dragGridPt = gHit;
                    S.transform.dragStart = { x: p.x, y: p.y };
                    S.transform._dragPtOrig = { ...grid[gHit.row][gHit.col] };
                    S.canvas.style.cursor = "move";
                    cv.setPointerCapture(e.pointerId); return;
                }
                // Check if inside the quad — if so, move all points
                if (_pointInGrid(grid, p.x, p.y)) {
                    S.transform.dragGridPt = "all";
                    S.transform.dragStart = { x: p.x, y: p.y };
                    // Snapshot all points for relative drag
                    S.transform._gridSnapshot = grid.map(row => row.map(pt => ({ ...pt })));
                    S.canvas.style.cursor = "move";
                    cv.setPointerCapture(e.pointerId); return;
                }
                // Click outside — commit
                _commitTransform(); _redraw(); return;
            }
            // ── Warp mode mousedown ──
            if (S.transform.warp && S.transform.warpGrid) {
                const grid = S.transform.warpGrid;
                const tol = C.HANDLE_SIZE / S.zoom.scale;
                const gHit = C.gridHitTest(grid, p.x, p.y, tol);
                if (gHit) {
                    S.transform.dragGridPt = gHit;
                    S.transform.dragStart = { x: p.x, y: p.y };
                    S.transform._dragPtOrig = { ...grid[gHit.row][gHit.col] };
                    S.canvas.style.cursor = "move";
                    cv.setPointerCapture(e.pointerId); return;
                }
                // Inside bounds = move all
                if (p.x >= S.transform.bounds.x && p.x <= S.transform.bounds.x + S.transform.bounds.w &&
                    p.y >= S.transform.bounds.y && p.y <= S.transform.bounds.y + S.transform.bounds.h) {
                    S.transform.dragGridPt = "all";
                    S.transform.dragStart = { x: p.x, y: p.y };
                    S.transform._gridSnapshot = grid.map(row => row.map(pt => ({ ...pt })));
                    S.canvas.style.cursor = "move";
                    cv.setPointerCapture(e.pointerId); return;
                }
                _commitTransform(); _redraw(); return;
            }
            // Hit test all handles (corners, edges, rotation, body)
            const hit = C.transformHitTest(p.x, p.y);
            if (!hit) { _commitTransform(); _redraw(); return; }
            if (hit === "rotate") {
                const b = S.transform.bounds;
                S.transform.dragMode = "rotate"; S.transform.dragStart = { x: p.x, y: p.y };
                S.transform.origDragBounds = { ...b }; S.transform._rotStartAngle = S.transform.rotation || 0;
                S.canvas.style.cursor = "grabbing";
                cv.setPointerCapture(e.pointerId); return;
            }
            S.transform.dragMode = hit; S.transform.dragStart = { x: p.x, y: p.y };
            S.transform.origDragBounds = { ...S.transform.bounds };
            S.transform._skewStartX = S.transform.skewX || 0;
            S.transform._skewStartY = S.transform.skewY || 0;
            S.canvas.style.cursor = _transformCursor(hit, S.transform.rotation || 0, S.transform.skewMode);
            cv.setPointerCapture(e.pointerId); return;
        }

        // Selection tools — preventDefault stops browser from re-rasterizing canvas
        if (S.tool === "select" || S.tool === "ellipse") {
            e.preventDefault();
            S._selModifier = getSelModifier(e);
            S.selection.dragging = true; S.selection.startX = Math.round(p.x); S.selection.startY = Math.round(p.y);
            S.selection.rect = { x: S.selection.startX, y: S.selection.startY, w: 0, h: 0 };
            _redraw(); return;
        }
        if (S.tool === "lasso") {
            e.preventDefault();
            S._selModifier = getSelModifier(e);
            S.selection.dragging = true;
            S.selection.lassoPoints = [{ x: Math.round(p.x), y: Math.round(p.y) }];
            _redraw(); return;
        }
        if (S.tool === "polylasso") {
            e.preventDefault();
            const px2 = Math.round(p.x), py2 = Math.round(p.y);
            if (!S._polyPoints) { S._polyPoints = [{ x: px2, y: py2 }]; _redraw(); return; }
            const first = S._polyPoints[0];
            if (Math.hypot(px2 - first.x, py2 - first.y) < 10 || e.detail >= 2) {
                _finishPolyLasso(e); return;
            }
            S._polyPoints.push({ x: px2, y: py2 }); _redraw(); return;
        }

        // Magnetic lasso
        if (S.tool === "maglasso") {
            e.preventDefault();
            const px2 = Math.round(p.x), py2 = Math.round(p.y);
            if (!S._magAnchors) {
                // First click — compute edge map once, place first anchor
                if (window.showToast) showToast("Computing edges...", "info");
                setTimeout(() => {
                    S._magEdgeMap = C.magneticEdgeMap();
                    S._magAnchors = [{ x: px2, y: py2 }];
                    S._magPaths = [];
                    S._magLivePath = null;
                    if (window.showToast) showToast("Click to add points, close or double-click to finish", "info");
                    _redraw();
                }, 10);
                return;
            }
            // Close if near first anchor or double-click
            const first = S._magAnchors[0];
            if (Math.hypot(px2 - first.x, py2 - first.y) < 12 || e.detail >= 2) {
                _finishMagLasso(e); return;
            }
            // Add path from last anchor to click point
            const last = S._magAnchors[S._magAnchors.length - 1];
            const path = C.magneticPath(S._magEdgeMap, S.W, S.H, last.x, last.y, px2, py2, 40);
            S._magPaths.push(path);
            S._magAnchors.push({ x: px2, y: py2 });
            S._magLivePath = null;
            _redraw(); return;
        }

        // Crop — preventDefault stops browser from re-rasterizing canvas
        if (S.tool === "crop") {
            e.preventDefault();
            S.selection.dragging = true; S.selection.startX = Math.round(p.x); S.selection.startY = Math.round(p.y);
            S.selection.rect = { x: S.selection.startX, y: S.selection.startY, w: 0, h: 0 };
            _redraw(); return;
        }

        // Gradient
        if (S.tool === "gradient") {
            S._gradientStart = { x: p.x, y: p.y }; S._gradientDragging = true;
            cv.setPointerCapture(e.pointerId); return;
        }

        // Shape
        if (S.tool === "shape") {
            S._shapeStart = { x: p.x, y: p.y }; S._shapeEnd = null; S._shapeDragging = true;
            cv.setPointerCapture(e.pointerId); return;
        }

        // Clone
        if (S.tool === "clone") {
            if (e.altKey) { S._cloneSource = { x: p.x, y: p.y }; S._cloneOffset = null; return; }
            if (!S._cloneSource) return;
            if (!S._cloneOffset) S._cloneOffset = { dx: S._cloneSource.x - p.x, dy: S._cloneSource.y - p.y };
            C.saveUndo("Clone stamp"); S.drawing = true;
            S.stroke.points = [];
            S.stroke.lx = p.x; S.stroke.ly = p.y; S.stroke.lp = p.pressure;
            cv.setPointerCapture(e.pointerId);
            C.cloneStamp(p.x, p.y, p.pressure); _redraw(); return;
        }

        // Liquify
        if (S.tool === "liquify") {
            C.saveUndo("Liquify"); S.drawing = true;
            S.stroke.points = []; S.stroke.lx = p.x; S.stroke.ly = p.y; S.stroke.lp = p.pressure;
            S.stroke._liquifyDist = 0; // accumulated distance for spacing
            cv.setPointerCapture(e.pointerId);
            C.cursorPos = { x: p.x, y: p.y }; _redraw(); return;
        }

        // Text tool
        if (S.tool === "text") {
            _showTextOverlay(p, e); return;
        }

        // Region painting
        if (S.regionMode && C.activeRegion() && (S.tool === "brush" || S.tool === "eraser")) {
            C.saveUndo("Region paint: " + C.activeRegion().name);
            S.drawing = true; cv.setPointerCapture(e.pointerId);
            if (S.tool === "eraser") C.regionEraseMove(p.x, p.y, p.x, p.y);
            else C.regionPaintAt(p.x, p.y);
            S.stroke.lx = p.x; S.stroke.ly = p.y;
            C.cursorPos = { x: p.x, y: p.y }; _redraw(); return;
        }

        // Auto-select nearest paint layer if active layer is an adjustment layer
        if (S.layers[S.activeLayerIdx]?.type === "adjustment") {
            let found = -1;
            for (let _i = S.activeLayerIdx - 1; _i >= 0; _i--) {
                if (S.layers[_i].type !== "adjustment") { found = _i; break; }
            }
            if (found < 0) {
                for (let _i = S.activeLayerIdx + 1; _i < S.layers.length; _i++) {
                    if (S.layers[_i].type !== "adjustment") { found = _i; break; }
                }
            }
            if (found >= 0) {
                S.activeLayerIdx = found;
                renderLayerPanel();
            } else {
                return; // no paint layer anywhere, do nothing
            }
        }

        // Brush/eraser/smudge/blur/dodge — only if click is within document bounds
        if (p.x < 0 || p.y < 0 || p.x >= S.W || p.y >= S.H) return;
        C.saveUndo();
        S.drawing = true; cv.setPointerCapture(e.pointerId);
        const T = C.drawTarget();
        if (S.tool === "smudge") { S.stroke.points = []; C.smudgeInit(T.ctx, p.x, p.y); S.stroke.lx = p.x; S.stroke.ly = p.y; S.stroke.lp = p.pressure; }
        else if (S.tool === "blur") { S.stroke.points = []; C.blurAt(T.ctx, p.x, p.y, p.pressure); S.stroke.lx = p.x; S.stroke.ly = p.y; S.stroke.lp = p.pressure; }
        else if (S.tool === "pixelate") { S.stroke.points = []; C.pixelateAt(T.ctx, p.x, p.y, p.pressure); S.stroke.lx = p.x; S.stroke.ly = p.y; S.stroke.lp = p.pressure; }
        else if (S.tool === "dodge") { S.stroke.points = []; S.stroke.lx = p.x; S.stroke.ly = p.y; S.stroke.lp = p.pressure; C.dodgeBurnAt(T.ctx, p.x, p.y, p.pressure); }
        else { C.beginStroke(p.x, p.y, p.pressure); }
        C.cursorPos = { x: p.x, y: p.y }; _redraw();
    });

    cv.addEventListener("pointermove", e => {
        if (S.zoom.panning) return;
        if (S.studioMode === "img2img") return;
        const p = pos(e);
        C.cursorPos = { x: p.x, y: p.y };

        // Shift-drag brush resize: horizontal = size, vertical = opacity
        if (_brushResizing) {
            const dx = e.clientX - _brushResizing.startX;
            S.brushSize = Math.max(1, Math.min(100, Math.round(_brushResizing.startSize + dx * 0.5)));
            _syncCtxBar();
            _redraw();
            return;
        }

        // Magnetic lasso live preview (throttled)
        if (S.tool === "maglasso" && S._magAnchors && S._magEdgeMap) {
            const now = performance.now();
            if (!S._magLastPreview || now - S._magLastPreview > 66) { // ~15fps
                S._magLastPreview = now;
                const last = S._magAnchors[S._magAnchors.length - 1];
                S._magLivePath = C.magneticPath(S._magEdgeMap, S.W, S.H, last.x, last.y, Math.round(p.x), Math.round(p.y), 40);
            }
            _redraw(); return;
        }

        // Transform hover cursor (when active but not dragging)
        if (S.tool === "transform" && S.transform.active && !S.transform.dragMode && !S.transform.dragGridPt) {
            if (S.transform.perspective && S.transform.grid) {
                const tol = C.HANDLE_SIZE / S.zoom.scale;
                const gHit = C.gridHitTest(S.transform.grid, p.x, p.y, tol);
                S.canvas.style.cursor = gHit ? "move" : (_pointInGrid(S.transform.grid, p.x, p.y) ? "move" : "default");
            } else if (S.transform.warp && S.transform.warpGrid) {
                const tol = C.HANDLE_SIZE / S.zoom.scale;
                const gHit = C.gridHitTest(S.transform.warpGrid, p.x, p.y, tol);
                S.canvas.style.cursor = gHit ? "move" : "default";
            } else {
                const hover = C.transformHitTest(p.x, p.y);
                S.canvas.style.cursor = _transformCursor(hover, S.transform.rotation || 0, S.transform.skewMode);
            }
            return;
        }

        // Perspective grid drag
        if (S.tool === "transform" && S.transform.perspective && S.transform.dragGridPt) {
            const dx = p.x - S.transform.dragStart.x, dy = p.y - S.transform.dragStart.y;
            if (S.transform.dragGridPt === "all") {
                const snap = S.transform._gridSnapshot;
                const grid = S.transform.grid;
                for (let i = 0; i < grid.length; i++) {
                    for (let j = 0; j < grid[i].length; j++) {
                        grid[i][j] = { x: snap[i][j].x + dx, y: snap[i][j].y + dy };
                    }
                }
            } else {
                const { row, col } = S.transform.dragGridPt;
                const orig = S.transform._dragPtOrig;
                S.transform.grid[row][col] = { x: orig.x + dx, y: orig.y + dy };
            }
            _redraw(); return;
        }

        // Warp grid drag
        if (S.tool === "transform" && S.transform.warp && S.transform.dragGridPt) {
            const dx = p.x - S.transform.dragStart.x, dy = p.y - S.transform.dragStart.y;
            if (S.transform.dragGridPt === "all") {
                const snap = S.transform._gridSnapshot;
                const grid = S.transform.warpGrid;
                for (let i = 0; i < grid.length; i++) {
                    for (let j = 0; j < grid[i].length; j++) {
                        grid[i][j] = { x: snap[i][j].x + dx, y: snap[i][j].y + dy };
                    }
                }
            } else {
                const { row, col } = S.transform.dragGridPt;
                const orig = S.transform._dragPtOrig;
                S.transform.warpGrid[row][col] = { x: orig.x + dx, y: orig.y + dy };
            }
            _redraw(); return;
        }

        // Transform drag
        if (S.tool === "transform" && S.transform.active && S.transform.dragMode) {
            if (S.transform.dragMode === "rotate") {
                const b = S.transform.bounds;
                const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
                const startAngle = Math.atan2(S.transform.dragStart.y - cy, S.transform.dragStart.x - cx);
                const curAngle = Math.atan2(p.y - cy, p.x - cx);
                S.transform.rotation = (S.transform._rotStartAngle || 0) + (curAngle - startAngle);
            } else {
                const dx = p.x - S.transform.dragStart.x, dy = p.y - S.transform.dragStart.y;
                const ob = S.transform.origDragBounds, b = S.transform.bounds;
                const mode = S.transform.dragMode;
                // Skew mode: edge handles shear instead of resize
                const isEdge = mode === "n" || mode === "s" || mode === "e" || mode === "w";
                if (S.transform.skewMode && isEdge) {
                    const startSkX = S.transform._skewStartX || 0;
                    const startSkY = S.transform._skewStartY || 0;
                    if (mode === "n") S.transform.skewX = startSkX - dx / (b.h / 2);
                    else if (mode === "s") S.transform.skewX = startSkX + dx / (b.h / 2);
                    else if (mode === "w") S.transform.skewY = startSkY - dy / (b.w / 2);
                    else if (mode === "e") S.transform.skewY = startSkY + dy / (b.w / 2);
                } else {
                switch (mode) {
                    case "move": b.x = ob.x + dx; b.y = ob.y + dy; break;
                    case "nw": b.x = ob.x + dx; b.y = ob.y + dy; b.w = ob.w - dx; b.h = ob.h - dy; break;
                    case "ne": b.y = ob.y + dy; b.w = ob.w + dx; b.h = ob.h - dy; break;
                    case "sw": b.x = ob.x + dx; b.w = ob.w - dx; b.h = ob.h + dy; break;
                    case "se": b.w = ob.w + dx; b.h = ob.h + dy; break;
                    case "n": b.y = ob.y + dy; b.h = ob.h - dy; break;
                    case "s": b.h = ob.h + dy; break;
                    case "w": b.x = ob.x + dx; b.w = ob.w - dx; break;
                    case "e": b.w = ob.w + dx; break;
                }
                // Aspect ratio constraint on corner handles:
                // When aspectLock is OFF: Shift = constrain proportions
                // When aspectLock is ON: proportional by default, Shift = free scale
                const wantLock = S.transform.aspectLock ? !e.shiftKey : e.shiftKey;
                if (wantLock && ob.w > 0 && ob.h > 0 && (mode === "nw" || mode === "ne" || mode === "sw" || mode === "se")) {
                    const aspect = ob.w / ob.h;
                    if (b.w / b.h > aspect) {
                        const newH = b.w / aspect;
                        if (mode === "nw" || mode === "ne") b.y = b.y + b.h - newH;
                        b.h = newH;
                    } else {
                        const newW = b.h * aspect;
                        if (mode === "nw" || mode === "sw") b.x = b.x + b.w - newW;
                        b.w = newW;
                    }
                }
                if (b.w < 4) b.w = 4; if (b.h < 4) b.h = 4;
                }
            }
            _redraw(); return;
        }

        // Selection drag
        if ((S.tool === "select" || S.tool === "ellipse") && S.selection.dragging) {
            let w = Math.abs(Math.round(p.x) - S.selection.startX);
            let h = Math.abs(Math.round(p.y) - S.selection.startY);
            if (e.shiftKey) { const sz = Math.max(w, h); w = sz; h = sz; }
            const sx = Math.round(p.x) < S.selection.startX ? S.selection.startX - w : S.selection.startX;
            const sy = Math.round(p.y) < S.selection.startY ? S.selection.startY - h : S.selection.startY;
            S.selection.rect = { x: sx, y: sy, w: w, h: h };
            _redraw(); return;
        }
        if (S.tool === "lasso" && S.selection.dragging) {
            if (S.selection.lassoPoints) S.selection.lassoPoints.push({ x: Math.round(p.x), y: Math.round(p.y) });
            _redraw(); return;
        }

        // Crop drag
        if (S.tool === "crop" && S.selection.dragging) {
            let w = Math.abs(Math.round(p.x) - S.selection.startX);
            let h = Math.abs(Math.round(p.y) - S.selection.startY);
            // Ratio constraint: always enforce when a ratio is selected; Shift=square in free mode
            const wantConstrain = S._cropRatio > 0 || e.shiftKey;
            if (wantConstrain) {
                const ratio = S._cropRatio || 1;
                if (w / h > ratio) w = Math.round(h * ratio);
                else h = Math.round(w / ratio);
            }
            // Snap to multiples of 8 (generation-friendly)
            w = Math.max(8, Math.round(w / 8) * 8);
            h = Math.max(8, Math.round(h / 8) * 8);
            const sx = Math.round(p.x) < S.selection.startX ? S.selection.startX - w : S.selection.startX;
            const sy = Math.round(p.y) < S.selection.startY ? S.selection.startY - h : S.selection.startY;
            S.selection.rect = { x: sx, y: sy, w, h };
            // Draw crop preview
            C.composite();
            const c = S.ctx, z = S.zoom, r = S.selection.rect;
            c.setTransform(z.scale, 0, 0, z.scale, z.ox, z.oy);
            c.save();
            c.fillStyle = "rgba(0,0,0,0.5)";
            c.fillRect(0, 0, S.W, r.y);
            c.fillRect(0, r.y + r.h, S.W, S.H - r.y - r.h);
            c.fillRect(0, r.y, r.x, r.h);
            c.fillRect(r.x + r.w, r.y, S.W - r.x - r.w, r.h);
            c.strokeStyle = "#fff"; c.lineWidth = 1.5 / z.scale; c.setLineDash([]);
            c.strokeRect(r.x, r.y, r.w, r.h);
            // Dimension label
            c.fillStyle = "rgba(0,0,0,0.7)"; c.font = `${11 / z.scale}px sans-serif`;
            c.textAlign = "center"; c.fillStyle = "#fff";
            c.fillText(`${r.w} × ${r.h}`, r.x + r.w / 2, r.y + r.h + 14 / z.scale);
            c.restore(); c.setTransform(1, 0, 0, 1, 0, 0);
            drawCursor(); return;
        }

        // Gradient drag
        if (S.tool === "gradient" && S._gradientDragging) {
            S._gradientEnd = { x: p.x, y: p.y };
            C.composite();
            const c = S.ctx, z = S.zoom;
            c.setTransform(z.scale, 0, 0, z.scale, z.ox, z.oy);
            c.save(); c.strokeStyle = "rgba(255,255,255,0.5)"; c.lineWidth = 1 / z.scale;
            c.setLineDash([4 / z.scale, 4 / z.scale]);
            c.beginPath(); c.moveTo(S._gradientStart.x, S._gradientStart.y); c.lineTo(p.x, p.y); c.stroke();
            c.restore(); c.setTransform(1, 0, 0, 1, 0, 0);
            drawCursor(); return;
        }

        // Shape drag
        if (S.tool === "shape" && S._shapeDragging) {
            let ex = p.x, ey = p.y;
            if (e.shiftKey) {
                const dx = ex - S._shapeStart.x, dy = ey - S._shapeStart.y;
                const sz = Math.max(Math.abs(dx), Math.abs(dy));
                ex = S._shapeStart.x + sz * Math.sign(dx || 1);
                ey = S._shapeStart.y + sz * Math.sign(dy || 1);
            }
            S._shapeEnd = { x: ex, y: ey };
            C.composite();
            const c = S.ctx, z = S.zoom;
            c.setTransform(z.scale, 0, 0, z.scale, z.ox, z.oy);
            c.save();
            c.strokeStyle = C.drawColor(); c.fillStyle = C.drawColor();
            c.lineWidth = C.brushPx(); c.globalAlpha = S.brushOpacity;
            C.drawShapePath(c, S._shapeMode, S._shapeStart.x, S._shapeStart.y, ex, ey, S._shapeFilled);
            c.restore(); c.setTransform(1, 0, 0, 1, 0, 0);
            drawCursor(); return;
        }

        // Clone drag
        if (S.tool === "clone" && S.drawing) {
            const sp = C.stab(p.x, p.y, p.pressure);
            const dx = sp.x - S.stroke.lx, dy = sp.y - S.stroke.ly;
            const dist = Math.hypot(dx, dy), step = Math.max(2, C.brushPx() * 0.4);
            const steps = Math.max(1, Math.ceil(dist / step));
            for (let i = 1; i <= steps; i++) { const t = i / steps; C.cloneStamp(S.stroke.lx + dx * t, S.stroke.ly + dy * t, sp.p); }
            S.stroke.lx = sp.x; S.stroke.ly = sp.y; S.stroke.lp = sp.p;
            _redraw(); return;
        }

        // Liquify drag
        if (S.tool === "liquify" && S.drawing) {
            const sp = C.stab(p.x, p.y, p.pressure);
            const dx = sp.x - S.stroke.lx, dy = sp.y - S.stroke.ly;
            const dist = Math.hypot(dx, dy);
            if (dist < 0.5) { _redraw(); return; }
            // Spacing: only fire dabs at intervals of brushSize * liquifySpacing
            const spacing = Math.max(1, C.brushPx() * (S.liquifySpacing || 0.2));
            S.stroke._liquifyDist = (S.stroke._liquifyDist || 0) + dist;
            if (S.stroke._liquifyDist >= spacing) {
                // Normalize direction for consistent displacement regardless of speed
                const nx = dx / dist, ny = dy / dist;
                C.liquifyPush(C.drawTarget().ctx, sp.x, sp.y, nx * spacing, ny * spacing, sp.p);
                S.stroke._liquifyDist = 0;
            }
            S.stroke.lx = sp.x; S.stroke.ly = sp.y; S.stroke.lp = sp.p;
            _redraw(); return;
        }

        // Region paint move
        if (S.regionMode && S.drawing && C.activeRegion() && (S.tool === "brush" || S.tool === "eraser")) {
            if (S.tool === "eraser") C.regionEraseMove(S.stroke.lx, S.stroke.ly, p.x, p.y);
            else C.regionPaintMove(S.stroke.lx, S.stroke.ly, p.x, p.y);
            S.stroke.lx = p.x; S.stroke.ly = p.y;
            _redraw(); return;
        }

        // Brush/eraser/smudge/blur/dodge move
        if (!S.drawing) { _redraw(); return; }
        const sp = C.stab(p.x, p.y, p.pressure), T = C.drawTarget();
        if (S.tool === "smudge") { C.smudgeStroke(T.ctx, S.stroke.lx, S.stroke.ly, sp.x, sp.y, S.stroke.lp, sp.p); S.stroke.lx = sp.x; S.stroke.ly = sp.y; S.stroke.lp = sp.p; }
        else if (S.tool === "blur") { C.blurAt(T.ctx, sp.x, sp.y, sp.p); }
        else if (S.tool === "pixelate") { C.pixelateAt(T.ctx, sp.x, sp.y, sp.p); }
        else if (S.tool === "dodge") { C.dodgeBurnStroke(T.ctx, S.stroke.lx, S.stroke.ly, sp.x, sp.y, sp.p); S.stroke.lx = sp.x; S.stroke.ly = sp.y; S.stroke.lp = sp.p; }
        else { C.plotTo(sp.x, sp.y, sp.p); }
        if (S.tool === "brush" && S.stroke.alphaMap) C.composite(true);
        else C.composite();
        drawCursor();
    });

    cv.addEventListener("pointerup", e => {
        // Shift-drag brush resize end
        if (_brushResizing) {
            _brushResizing = null;
            try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
            setTool(S.tool); // restore cursor
            _redraw();
            return;
        }
        // Transform up
        if (S.tool === "transform" && S.transform.active) {
            S.transform.dragMode = null; S.transform.dragStart = null;
            S.transform.dragGridPt = null; S.transform._dragPtOrig = null; S.transform._gridSnapshot = null;
            try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
            return;
        }
        // Selection up
        if ((S.tool === "select") && S.selection.dragging) {
            S.selection.dragging = false;
            _finalizeMarquee(); return;
        }
        if (S.tool === "ellipse" && S.selection.dragging) {
            S.selection.dragging = false;
            _finalizeEllipse(); return;
        }
        if (S.tool === "lasso" && S.selection.dragging) {
            S.selection.dragging = false;
            _finalizeLasso(); return;
        }
        // Crop up
        if (S.tool === "crop" && S.selection.dragging) {
            S.selection.dragging = false;
            _finalizeCrop(); return;
        }
        // Gradient up
        if (S.tool === "gradient" && S._gradientDragging) {
            S._gradientDragging = false;
            try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
            if (S._gradientStart && S._gradientEnd && Math.hypot(S._gradientEnd.x - S._gradientStart.x, S._gradientEnd.y - S._gradientStart.y) >= 3) {
                C.saveUndo("Gradient");
                C.drawGradient(S._gradientStart, S._gradientEnd, S._gradientMode);
            }
            renderHistoryPanel(); _redraw(); return;
        }
        // Shape up
        if (S.tool === "shape" && S._shapeDragging) {
            S._shapeDragging = false;
            try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
            if (S._shapeStart && S._shapeEnd && Math.hypot(S._shapeEnd.x - S._shapeStart.x, S._shapeEnd.y - S._shapeStart.y) >= 2) {
                C.saveUndo("Shape");
                C.commitShape(S._shapeStart, S._shapeEnd, S._shapeMode, S._shapeFilled);
            }
            renderHistoryPanel(); _redraw(); return;
        }
        // Liquify up — clear snapshot and spacing state
        if (S.tool === "liquify" && S.drawing) {
            S.drawing = false;
            S._liquifySnapshot = null;
            S.stroke._liquifyDist = 0;
            try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
            renderHistoryPanel(); _redraw(); return;
        }
        // Clone up
        if (S.tool === "clone" && S.drawing) {
            S.drawing = false;
            try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
            renderHistoryPanel(); _redraw(); return;
        }
        // Regular stroke up
        if (S.drawing) {
            try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
            if ((S.tool === "brush" || S.tool === "eraser") && !S.regionMode) C.commitStroke();
            S.smudgeBuffer = null;
            if (S.tool === "brush" && !S.editingMask) C.addColor(S.color);
        }
        S.drawing = false;
        _redraw();
        renderLayerPanel();
        renderHistoryPanel();
        // Notify Live Painting of canvas change
        if (window.Live && Live.active) Live.onCanvasChanged();
    });

    cv.addEventListener("pointerleave", () => {
        if (S.drawing) {
            if ((S.tool === "brush" || S.tool === "eraser") && !S.regionMode) C.commitStroke();
            if (S.tool === "liquify") S._liquifySnapshot = null;
            S.smudgeBuffer = null;
            // Notify Live Painting of canvas change
            if (window.Live && Live.active) Live.onCanvasChanged();
        }
        if (S.selection.dragging) { S.selection.dragging = false; S.selection.lassoPoints = null; }
        S.drawing = false; C.cursorPos = { x: -1, y: -1 }; _redraw();
    });

    // Drag-and-drop: handled by app.js on .canvas-area (resizes canvas,
    // reads PNG metadata, updates params). Do NOT handle here — the old
    // handler scaled to current canvas size without resizing.
}

// ========================================================================
// SELECTION FINALIZATION
// ========================================================================
function _finalizeMarquee() {
    const r = S.selection.rect;
    if (!r || r.w < 2 || r.h < 2) { if (S._selModifier === "replace") C.selectionClear(); stopMarchingAnts(); _redraw(); return; }
    const x0 = Math.max(0, Math.round(r.x)), y0 = Math.max(0, Math.round(r.y));
    const x1 = Math.min(S.W, Math.round(r.x + r.w)), y1 = Math.min(S.H, Math.round(r.y + r.h));
    const newMask = new Uint8Array(S.W * S.H);
    for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) newMask[py * S.W + px] = 255;
    const mod = S._selModifier || "replace";
    if (mod !== "replace" && S.selection.active && S.selection.mask) {
        C.selectionModify(newMask, mod);
        S.selection._isMaskBased = true; S.selection._isLasso = false; S.selection._isEllipse = false;
    } else {
        S.selection.rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        S.selection.mask = newMask;
        S.selection.active = true;
        S.selection._isLasso = false; S.selection._isEllipse = false; S.selection._isMaskBased = false;
    }
    startMarchingAnts(); _redraw();
}

function _finalizeEllipse() {
    const r = S.selection.rect;
    if (!r || Math.abs(r.w) < 2 || Math.abs(r.h) < 2) { if (S._selModifier === "replace") C.selectionClear(); stopMarchingAnts(); _redraw(); return; }
    let x0 = r.x, y0 = r.y, w = r.w, h = r.h;
    if (w < 0) { x0 += w; w = -w; } if (h < 0) { y0 += h; h = -h; }
    x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
    const x1 = Math.min(S.W, Math.round(x0 + w)), y1 = Math.min(S.H, Math.round(y0 + h));
    const cx = x0 + (x1 - x0) / 2, cy = y0 + (y1 - y0) / 2;
    const rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
    const newMask = new Uint8Array(S.W * S.H);
    for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) {
        const dx = (px - cx) / rx, dy = (py - cy) / ry;
        if (dx * dx + dy * dy <= 1) newMask[py * S.W + px] = 255;
    }
    const mod = S._selModifier || "replace";
    if (mod !== "replace" && S.selection.active && S.selection.mask) {
        C.selectionModify(newMask, mod);
        S.selection._isMaskBased = true; S.selection._isLasso = false; S.selection._isEllipse = false;
    } else {
        S.selection.rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        S.selection.mask = newMask; S.selection.active = true; S.selection._isEllipse = true;
    }
    startMarchingAnts(); _redraw();
}

function _finalizeLasso() {
    const pts = S.selection.lassoPoints;
    if (!pts || pts.length < 3) { if ((S._selModifier || "replace") === "replace") C.selectionClear(); stopMarchingAnts(); _redraw(); return; }
    const simplified = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
        if (Math.hypot(pts[i].x - simplified[simplified.length - 1].x, pts[i].y - simplified[simplified.length - 1].y) >= 2)
            simplified.push(pts[i]);
    }
    if (simplified.length < 3) { if ((S._selModifier || "replace") === "replace") C.selectionClear(); _redraw(); return; }
    const newMask = new Uint8Array(S.W * S.H);
    C.fillPolygonMask(simplified, newMask, S.W, S.H);
    const mod = S._selModifier || "replace";
    if (mod !== "replace" && S.selection.active && S.selection.mask) {
        C.selectionModify(newMask, mod);
        S.selection._isMaskBased = true; S.selection._isLasso = false; S.selection._isEllipse = false;
        S.selection._contour = null;
    } else {
        S.selection.mask = newMask;
    }
    let x0 = S.W, y0 = S.H, x1 = 0, y1 = 0;
    for (const p of simplified) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
    S.selection.rect = { x: Math.max(0, x0), y: Math.max(0, y0), w: Math.min(S.W, x1) - Math.max(0, x0), h: Math.min(S.H, y1) - Math.max(0, y0) };
    S.selection.active = true;
    if (!S.selection._isMaskBased) { S.selection._isLasso = true; S.selection._contour = simplified; }
    S.selection.lassoPoints = null;
    startMarchingAnts(); _redraw();
}

function _finishPolyLasso(e) {
    const pts = S._polyPoints;
    if (!pts || pts.length < 3) { S._polyPoints = null; _redraw(); return; }
    const mod = getSelModifier(e);
    const newMask = new Uint8Array(S.W * S.H);
    C.fillPolygonMask(pts, newMask, S.W, S.H);
    if (mod !== "replace" && S.selection.mask) {
        C.selectionModify(newMask, mod);
        S.selection._isMaskBased = true; S.selection._isLasso = false; S.selection._isEllipse = false;
        S.selection._contour = null;
    } else {
        S.selection.mask = newMask;
    }
    let x0 = S.W, y0 = S.H, x1 = 0, y1 = 0;
    for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
    S.selection.rect = { x: Math.max(0, x0), y: Math.max(0, y0), w: Math.min(S.W, x1) - Math.max(0, x0), h: Math.min(S.H, y1) - Math.max(0, y0) };
    S.selection.active = true;
    if (!S.selection._isMaskBased) { S.selection._isLasso = true; S.selection._contour = pts; }
    S._polyPoints = null;
    startMarchingAnts(); _redraw();
}

function _finishMagLasso(e) {
    if (!S._magAnchors || S._magAnchors.length < 2) { _clearMagLasso(); _redraw(); return; }
    // Add closing path from last anchor to first
    const last = S._magAnchors[S._magAnchors.length - 1];
    const first = S._magAnchors[0];
    if (S._magEdgeMap) {
        const closePath = C.magneticPath(S._magEdgeMap, S.W, S.H, last.x, last.y, first.x, first.y, 40);
        S._magPaths.push(closePath);
    }
    // Collect all path points into one polygon
    const allPts = [];
    for (const path of S._magPaths) {
        // Paths are end→start, so reverse them
        for (let i = path.length - 1; i >= 0; i--) allPts.push(path[i]);
    }
    if (allPts.length < 3) { _clearMagLasso(); _redraw(); return; }
    // Simplify — remove points closer than 1px apart
    const simplified = [allPts[0]];
    for (let i = 1; i < allPts.length; i++) {
        if (Math.hypot(allPts[i].x - simplified[simplified.length - 1].x, allPts[i].y - simplified[simplified.length - 1].y) >= 1)
            simplified.push(allPts[i]);
    }
    if (simplified.length < 3) { _clearMagLasso(); _redraw(); return; }
    const mod = getSelModifier(e);
    const newMask = new Uint8Array(S.W * S.H);
    C.fillPolygonMask(simplified, newMask, S.W, S.H);
    if (mod !== "replace" && S.selection.mask) {
        C.selectionModify(newMask, mod);
        S.selection._isMaskBased = true; S.selection._isLasso = false; S.selection._isEllipse = false;
        S.selection._contour = null;
    } else {
        S.selection.mask = newMask;
    }
    let x0 = S.W, y0 = S.H, x1 = 0, y1 = 0;
    for (const p of simplified) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
    S.selection.rect = { x: Math.max(0, x0), y: Math.max(0, y0), w: Math.min(S.W, x1) - Math.max(0, x0), h: Math.min(S.H, y1) - Math.max(0, y0) };
    S.selection.active = true;
    S.selection._isLasso = true; S.selection._contour = simplified;
    _clearMagLasso();
    startMarchingAnts(); _redraw();
}

function _clearMagLasso() {
    S._magAnchors = null; S._magPaths = null; S._magEdgeMap = null;
    S._magLivePath = null; S._magLastPreview = 0;
}

function _finalizeCrop() {
    const r = S.selection.rect;
    if (!r || r.w < 8 || r.h < 8) { S.selection.rect = null; _redraw(); return; }
    const cx = Math.max(0, Math.round(r.x)), cy = Math.max(0, Math.round(r.y));
    const cw = Math.min(S.W - cx, Math.round(r.w)), ch = Math.min(S.H - cy, Math.round(r.h));
    if (cw < 8 || ch < 8) { S.selection.rect = null; _redraw(); return; }
    if (!confirm(`Crop to ${cw}×${ch}?`)) { S.selection.rect = null; _redraw(); return; }
    C.saveStructuralUndo("Crop");
    // Extract crop from each layer
    const croppedLayers = S.layers.map(L => {
        if (!L.canvas) return null;
        const tc = document.createElement("canvas"); tc.width = cw; tc.height = ch;
        tc.getContext("2d").drawImage(L.canvas, cx, cy, cw, ch, 0, 0, cw, ch);
        return tc;
    });
    const croppedMask = document.createElement("canvas"); croppedMask.width = cw; croppedMask.height = ch;
    croppedMask.getContext("2d").drawImage(S.mask.canvas, cx, cy, cw, ch, 0, 0, cw, ch);
    S.W = cw; S.H = ch;
    S.stroke.canvas.width = cw; S.stroke.canvas.height = ch;
    S.mask.canvas.width = cw; S.mask.canvas.height = ch; S.mask.ctx = S.mask.canvas.getContext("2d");
    S.mask.ctx.drawImage(croppedMask, 0, 0);
    for (let i = 0; i < S.layers.length; i++) {
        if (!S.layers[i].canvas) continue;
        S.layers[i].canvas.width = cw; S.layers[i].canvas.height = ch;
        S.layers[i].ctx = S.layers[i].canvas.getContext("2d");
        if (croppedLayers[i]) S.layers[i].ctx.drawImage(croppedLayers[i], 0, 0);
    }
    S.selection.rect = null;
    // Update width/height params so gen uses correct dimensions
    const wEl = document.getElementById("paramWidth");
    const hEl = document.getElementById("paramHeight");
    if (wEl) wEl.value = cw;
    if (hEl) hEl.value = ch;
    syncCanvasToViewport(); C.zoomFit(); updateStatus(); renderLayerPanel(); renderHistoryPanel(); _redraw();
}


// Point-in-quad test for perspective grid (uses cross products)
function _pointInGrid(grid, px, py) {
    if (!grid || grid.length < 2 || grid[0].length < 2) return false;
    const tl = grid[0][0], tr = grid[0][grid[0].length - 1];
    const bl = grid[grid.length - 1][0], br = grid[grid.length - 1][grid[0].length - 1];
    // Check if point is on the same side of all 4 edges
    const cross = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const d1 = cross(tl.x, tl.y, tr.x, tr.y, px, py);
    const d2 = cross(tr.x, tr.y, br.x, br.y, px, py);
    const d3 = cross(br.x, br.y, bl.x, bl.y, px, py);
    const d4 = cross(bl.x, bl.y, tl.x, tl.y, px, py);
    const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0) || (d4 < 0);
    const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0) || (d4 > 0);
    return !(hasNeg && hasPos);
}

// Rotation-aware cursor for transform handles
const _RESIZE_CURSORS = ["n-resize", "ne-resize", "e-resize", "se-resize", "s-resize", "sw-resize", "w-resize", "nw-resize"];
const _HANDLE_ANGLES = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 };
function _transformCursor(hit, rotation, skewMode) {
    if (!hit) return "default";
    if (hit === "rotate") return "grab";
    if (hit === "move") return "move";
    const isEdge = hit === "n" || hit === "s" || hit === "e" || hit === "w";
    if (skewMode && isEdge) {
        // Skew cursors: horizontal shear for n/s, vertical for e/w
        return (hit === "n" || hit === "s") ? "ew-resize" : "ns-resize";
    }
    // Map handle to base angle, add rotation, snap to nearest 45°
    const base = _HANDLE_ANGLES[hit] ?? 0;
    const deg = ((base + rotation * 180 / Math.PI) % 360 + 360) % 360;
    const idx = Math.round(deg / 45) % 8;
    return _RESIZE_CURSORS[idx];
}

function _togglePerspective() {
    if (!S.transform.active) return;
    S.transform.perspective = !S.transform.perspective;
    if (S.transform.perspective) {
        const b = S.transform.bounds;
        S.transform.grid = C.gridFromRect(b, 1, 1);
        S.transform.skewMode = false; S.transform.skewX = 0; S.transform.skewY = 0;
        S.transform.rotation = 0;
        S.transform.flipH = false; S.transform.flipV = false;
        S.transform.warp = false; S.transform.warpGrid = null; S.transform.warpOrigGrid = null;
        document.getElementById("tfSkewBtn")?.classList.remove("active");
        document.getElementById("tfWarpBtn")?.classList.remove("active");
        _updateWarpSubOpts();
    } else {
        const grid = S.transform.grid;
        if (grid) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const row of grid) for (const pt of row) {
                if (pt.x < minX) minX = pt.x; if (pt.y < minY) minY = pt.y;
                if (pt.x > maxX) maxX = pt.x; if (pt.y > maxY) maxY = pt.y;
            }
            S.transform.bounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
        }
        S.transform.grid = null;
    }
    document.getElementById("tfPerspBtn")?.classList.toggle("active", S.transform.perspective);
    if (window.showToast) showToast("Perspective " + (S.transform.perspective ? "ON" : "OFF"), "info");
    _redraw();
}

function _toggleWarp() {
    if (!S.transform.active) return;
    S.transform.warp = !S.transform.warp;
    if (S.transform.warp) {
        const b = S.transform.bounds;
        const d = S.transform.warpDensity || 3;
        S.transform.warpOrigGrid = C.gridFromRect(b, d, d);
        S.transform.warpGrid = C.gridFromRect(b, d, d);
        S.transform.perspective = false; S.transform.grid = null;
        S.transform.skewMode = false; S.transform.skewX = 0; S.transform.skewY = 0;
        S.transform.rotation = 0;
        S.transform.flipH = false; S.transform.flipV = false;
        document.getElementById("tfSkewBtn")?.classList.remove("active");
        document.getElementById("tfPerspBtn")?.classList.remove("active");
    } else {
        S.transform.warpGrid = null; S.transform.warpOrigGrid = null;
    }
    document.getElementById("tfWarpBtn")?.classList.toggle("active", S.transform.warp);
    _updateWarpSubOpts();
    if (window.showToast) showToast("Warp " + (S.transform.warp ? "ON" : "OFF"), "info");
    _redraw();
}

function _updateWarpSubOpts() {
    const el = document.getElementById("tfWarpOpts");
    if (el) el.style.display = S.transform.warp ? "flex" : "none";
}

function _rebuildWarpGrid() {
    if (!S.transform.active || !S.transform.warp) return;
    const b = S.transform.bounds;
    const d = S.transform.warpDensity || 3;
    S.transform.warpOrigGrid = C.gridFromRect(b, d, d);
    S.transform.warpGrid = C.gridFromRect(b, d, d);
    _redraw();
}

function _commitTransform() {
    if (!S.transform.active) return;
    const L = S.layers[S.transform.layerIdx];
    if (!L) { _resetTransformState(); return; }

    if (S.transform.warp && S.transform.warpGrid && S.transform.warpOrigGrid) {
        const b = S.transform.bounds;
        const srcRect = { x: 0, y: 0, w: S.transform.canvas.width, h: S.transform.canvas.height };
        const evalGrid = C.mlsEvalGrid(
            S.transform.warpOrigGrid, S.transform.warpGrid,
            b, 12, S.transform.warpMode || "rigid"
        );
        L.ctx.save();
        L.ctx.setTransform(1, 0, 0, 1, 0, 0);
        C.gridRender(L.ctx, S.transform.canvas, srcRect, evalGrid, 1, 1);
        L.ctx.restore();
    } else if (S.transform.perspective && S.transform.grid) {
        const srcRect = { x: 0, y: 0, w: S.transform.canvas.width, h: S.transform.canvas.height };
        L.ctx.save();
        L.ctx.setTransform(1, 0, 0, 1, 0, 0);
        C.gridRender(L.ctx, S.transform.canvas, srcRect, S.transform.grid, 3, 1);
        L.ctx.restore();
    } else {
        const b = S.transform.bounds, rot = S.transform.rotation || 0;
        const fh = S.transform.flipH, fv = S.transform.flipV;
        const skX = S.transform.skewX || 0, skY = S.transform.skewY || 0;
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        L.ctx.save();
        L.ctx.translate(cx, cy);
        L.ctx.rotate(rot);
        L.ctx.transform(1, skY, skX, 1, 0, 0);
        L.ctx.scale(fh ? -1 : 1, fv ? -1 : 1);
        L.ctx.drawImage(S.transform.canvas, -b.w / 2, -b.h / 2, b.w, b.h);
        L.ctx.restore();
    }
    _resetTransformState();
}

function _resetTransformState() {
    S.transform.active = false; S.transform.canvas = null; S.transform.rotation = 0;
    S.transform.flipH = false; S.transform.flipV = false;
    S.transform.skewX = 0; S.transform.skewY = 0; S.transform.skewMode = false;
    S.transform.perspective = false; S.transform.grid = null; S.transform.dragGridPt = null;
    S.transform.warp = false; S.transform.warpGrid = null; S.transform.warpOrigGrid = null;
    document.getElementById("tfSkewBtn")?.classList.remove("active");
    document.getElementById("tfPerspBtn")?.classList.remove("active");
    document.getElementById("tfWarpBtn")?.classList.remove("active");
    _updateWarpSubOpts();
}

// Sync numeric inputs with current transform state
function _syncTransformInputs() {
    if (!S.transform.active) return;
    const tfX = document.getElementById("tfX");
    const tfY = document.getElementById("tfY");
    const tfW = document.getElementById("tfW");
    const tfH = document.getElementById("tfH");
    const tfR = document.getElementById("tfR");
    if (!tfX) return;
    // Perspective/warp mode — numeric fields don't apply
    if (S.transform.perspective || S.transform.warp) {
        tfX.value = ""; tfY.value = ""; tfW.value = ""; tfH.value = ""; tfR.value = "";
        tfX.disabled = true; tfY.disabled = true; tfW.disabled = true; tfH.disabled = true; tfR.disabled = true;
        return;
    }
    tfX.disabled = false; tfY.disabled = false; tfW.disabled = false; tfH.disabled = false; tfR.disabled = false;
    // Don't overwrite while user is typing
    if (document.activeElement === tfX || document.activeElement === tfY ||
        document.activeElement === tfW || document.activeElement === tfH ||
        document.activeElement === tfR) return;
    const b = S.transform.bounds;
    tfX.value = Math.round(b.x);
    tfY.value = Math.round(b.y);
    tfW.value = Math.round(b.w);
    tfH.value = Math.round(b.h);
    tfR.value = Math.round((S.transform.rotation || 0) * 180 / Math.PI * 10) / 10;
}

// ========================================================================
// COLOR UI — HSV Wheel + SV Square + History
// ========================================================================
let _hsv = { h: 0, s: 0, v: 100 };
let _hueDrag = false, _svDrag = false;

function updateColorUI() {
    const fg = document.getElementById("colorFg");
    if (fg) fg.style.background = S.color;
    const fgInner = document.getElementById("fgSwatchInner");
    if (fgInner) fgInner.style.background = S.color;
    const bgInner = document.getElementById("bgSwatchInner");
    if (bgInner) bgInner.style.background = S.bgColor;
    const bgEl = document.getElementById("colorBg");
    if (bgEl) bgEl.style.background = S.bgColor;
    const hex = document.getElementById("hexInput");
    if (hex) hex.value = S.color;
    _renderColorHistory();
}

function _updateHSVFromColor(hex) {
    const rgb = C.hexRgb(hex);
    const hsv = C.rgbToHsv(rgb.r, rgb.g, rgb.b);
    _hsv.h = hsv.h; _hsv.s = hsv.s; _hsv.v = hsv.v;
}

function _applyHSV() {
    const rgb = C.hsvToRgb(_hsv.h, _hsv.s, _hsv.v);
    S.color = C.rgbHex(rgb.r, rgb.g, rgb.b);
    updateColorUI();
}

function _drawHueWheel() {
    const c = document.getElementById("hsvWheel"); if (!c) return;
    const ctx = c.getContext("2d"), cx = 80, cy = 80, ro = 75, ri = 52;
    ctx.clearRect(0, 0, 160, 160);
    for (let a = 0; a < 360; a++) {
        const r1 = a * Math.PI / 180, r2 = (a + 2) * Math.PI / 180;
        ctx.beginPath(); ctx.arc(cx, cy, ro, r1, r2); ctx.arc(cx, cy, ri, r2, r1, true); ctx.closePath();
        ctx.fillStyle = `hsl(${a},100%,50%)`; ctx.fill();
    }
    // Indicator
    const ia = _hsv.h * Math.PI / 180, ir = (ro + ri) / 2;
    ctx.beginPath(); ctx.arc(cx + Math.cos(ia) * ir, cy + Math.sin(ia) * ir, 5, 0, Math.PI * 2);
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
    ctx.strokeStyle = "#000"; ctx.lineWidth = 1; ctx.stroke();
}

function _drawSVSquare() {
    const c = document.getElementById("hsvSV"); if (!c) return;
    const ctx = c.getContext("2d"), w = 128, h = 128;
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const s_val = x / w * 100, v_val = (1 - y / h) * 100;
        const rgb = C.hsvToRgb(_hsv.h, s_val, v_val);
        const i = (y * w + x) * 4;
        img.data[i] = rgb.r; img.data[i + 1] = rgb.g; img.data[i + 2] = rgb.b; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    // Indicator
    const ix = _hsv.s / 100 * w, iy = (1 - _hsv.v / 100) * h;
    ctx.beginPath(); ctx.arc(ix, iy, 5, 0, Math.PI * 2);
    ctx.strokeStyle = _hsv.v > 50 ? "#000" : "#fff"; ctx.lineWidth = 2; ctx.stroke();
}

function _renderColorHistory() {
    const el = document.getElementById("colorHistory"); if (!el) return;
    el.innerHTML = "";
    for (const col of S.colorHistory) {
        const sw = document.createElement("div");
        sw.style.cssText = `width:14px;height:14px;border-radius:2px;cursor:pointer;border:1px solid #555;background:${col};`;
        sw.addEventListener("click", () => {
            S.color = col; _updateHSVFromColor(col); _applyHSV();
            _drawHueWheel(); _drawSVSquare();
        });
        el.appendChild(sw);
    }
}

function bindColorPicker() {
    const popup = document.getElementById("hsvPopup");
    const swatch = document.getElementById("colorSwatch");
    if (!popup || !swatch) return;

    // Toggle popup on swatch click
    swatch.addEventListener("click", e => {
        e.stopPropagation();
        if (popup.style.display !== "none") { popup.style.display = "none"; return; }
        _updateHSVFromColor(S.color);
        popup.style.display = "";
        // Position: center in viewport, clamped to screen bounds
        const r = swatch.getBoundingClientRect();
        const pw = 340, ph = 220; // approximate popup dimensions
        let left = r.right + 8;
        let top = r.top - 20;
        // Clamp to viewport
        if (left + pw > window.innerWidth - 10) left = Math.max(10, window.innerWidth - pw - 10);
        if (top + ph > window.innerHeight - 10) top = Math.max(10, window.innerHeight - ph - 10);
        if (top < 10) top = 10;
        popup.style.left = left + "px";
        popup.style.top = top + "px";
        _drawHueWheel(); _drawSVSquare(); _renderColorHistory();
    });

    // Close on click outside
    document.addEventListener("click", e => {
        if (popup.style.display === "none") return;
        if (!popup.contains(e.target) && !swatch.contains(e.target)) popup.style.display = "none";
    });

    // Block context menu inside popup
    popup.addEventListener("contextmenu", e => e.preventDefault());

    // Hue wheel drag
    const hc = document.getElementById("hsvWheel");
    const CX = 80, CY = 80, RO = 75, RI = 52;
    if (hc) {
        hc.addEventListener("pointerdown", e => {
            const r = hc.getBoundingClientRect();
            const mx = e.clientX - r.left - CX, my = e.clientY - r.top - CY;
            const dist = Math.sqrt(mx * mx + my * my);
            if (dist >= RI - 8 && dist <= RO + 5) {
                _hueDrag = true;
                _hsv.h = (Math.atan2(my, mx) * 180 / Math.PI + 360) % 360;
                _applyHSV(); _drawHueWheel(); _drawSVSquare();
                hc.setPointerCapture(e.pointerId);
                e.preventDefault(); e.stopPropagation();
            }
        });
        hc.addEventListener("pointermove", e => {
            if (!_hueDrag) return;
            const r = hc.getBoundingClientRect();
            _hsv.h = (Math.atan2(e.clientY - r.top - CY, e.clientX - r.left - CX) * 180 / Math.PI + 360) % 360;
            _applyHSV(); _drawHueWheel(); _drawSVSquare();
        });
        hc.addEventListener("pointerup", () => { _hueDrag = false; });
    }

    // SV square drag
    const sc = document.getElementById("hsvSV");
    if (sc) {
        sc.addEventListener("pointerdown", e => {
            _svDrag = true;
            const r = sc.getBoundingClientRect();
            _hsv.s = Math.max(0, Math.min(100, (e.clientX - r.left) / 128 * 100));
            _hsv.v = Math.max(0, Math.min(100, (1 - (e.clientY - r.top) / 128) * 100));
            _applyHSV(); _drawSVSquare();
            sc.setPointerCapture(e.pointerId);
            e.preventDefault(); e.stopPropagation();
        });
        sc.addEventListener("pointermove", e => {
            if (!_svDrag) return;
            const r = sc.getBoundingClientRect();
            _hsv.s = Math.max(0, Math.min(100, (e.clientX - r.left) / 128 * 100));
            _hsv.v = Math.max(0, Math.min(100, (1 - (e.clientY - r.top) / 128) * 100));
            _applyHSV(); _drawSVSquare();
        });
        sc.addEventListener("pointerup", () => { _svDrag = false; C.addColor(S.color); _renderColorHistory(); });
    }

    // Hex input
    document.getElementById("hexInput")?.addEventListener("change", e => {
        let v = e.target.value.trim();
        if (!v.startsWith("#")) v = "#" + v;
        if (/^#[0-9a-fA-F]{6}$/.test(v)) {
            S.color = v.toLowerCase(); _updateHSVFromColor(S.color);
            _applyHSV(); _drawHueWheel(); _drawSVSquare(); C.addColor(S.color);
        }
    });

    // FG/BG swap
    document.getElementById("fgBgSwap")?.addEventListener("click", () => {
        const tmp = S.color; S.color = S.bgColor; S.bgColor = tmp;
        _updateHSVFromColor(S.color); _applyHSV(); _drawHueWheel(); _drawSVSquare();
    });
}

// ========================================================================
// SAVE / EXPORT
// ========================================================================
async function saveFlattened(ext, mime) {
    // Map extensions to format names the API expects
    const fmtMap = { png: "png", jpg: "jpeg", webp: "webp" };
    await _ctxSaveCanvas(fmtMap[ext] || "png");
}

function savePSD() {
    if (!window.agPsd) { alert("PSD library not loaded"); return; }
    // Initialize ag-psd for browser canvas
    window.agPsd.initializeCanvas(
        (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; },
        (w, h) => new ImageData(w, h)
    );
    const children = [];
    for (let i = 0; i < S.layers.length; i++) {
        const L = S.layers[i];
        if (L.type === "adjustment") {
            const meta = JSON.stringify({ t: L.adjustType, p: L.adjustParams });
            const placeholder = document.createElement("canvas"); placeholder.width = S.W; placeholder.height = S.H;
            children.push({
                name: "⚙ " + L.name + " |ADJ|" + meta, canvas: placeholder,
                hidden: !L.visible, opacity: L.opacity != null ? L.opacity : 1,
                blendMode: C._blendToPS[L.blendMode] || "normal"
            });
            continue;
        }
        children.push({
            name: L.name || ("Layer " + (i + 1)), canvas: L.canvas,
            hidden: !L.visible, opacity: L.opacity != null ? L.opacity : 1,
            blendMode: C._blendToPS[L.blendMode] || "normal"
        });
    }
    const psd = { width: S.W, height: S.H, children: children };
    const buf = window.agPsd.writePsd(psd);
    const blob = new Blob([buf], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `studio_${S.W}x${S.H}.psd`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    console.log("[StudioUI] PSD saved:", a.download);
}

function showSaveMenu(anchor) {
    let menu = document.getElementById("saveMenu");
    if (menu) { menu.remove(); return; }
    menu = document.createElement("div");
    menu.id = "saveMenu";
    menu.style.cssText = "position:fixed;z-index:200;background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:4px;box-shadow:0 4px 16px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:2px;";
    const items = [
        { label: "Save as PNG", fn: () => saveFlattened("png", "image/png") },
        { label: "Save as JPEG", fn: () => saveFlattened("jpg", "image/jpeg") },
        { label: "Save as WebP", fn: () => saveFlattened("webp", "image/webp") },
        { label: "Export PSD (layers)", fn: () => savePSD() },
    ];
    for (const item of items) {
        const btn = document.createElement("button");
        btn.style.cssText = "padding:6px 14px;font-size:11px;text-align:left;background:none;border:none;color:var(--text-2);cursor:pointer;border-radius:4px;white-space:nowrap;font-family:var(--font);";
        btn.textContent = item.label;
        btn.addEventListener("mouseenter", () => btn.style.background = "var(--bg-raised)");
        btn.addEventListener("mouseleave", () => btn.style.background = "none");
        btn.addEventListener("click", () => { menu.remove(); item.fn(); });
        menu.appendChild(btn);
    }
    const r = anchor.getBoundingClientRect();
    // Position above the button, clamped to viewport
    let left = r.left;
    let bottom = window.innerHeight - r.top + 4;
    // Clamp: don't let it go off the right edge
    const menuWidth = 160;
    if (left + menuWidth > window.innerWidth - 10) left = window.innerWidth - menuWidth - 10;
    if (left < 10) left = 10;
    // If it would go off the top, show below instead
    if (bottom > window.innerHeight - 40) {
        menu.style.top = (r.bottom + 4) + "px";
    } else {
        menu.style.bottom = bottom + "px";
    }
    menu.style.left = left + "px";
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener("click", function h(e) {
        if (!menu.contains(e.target) && e.target !== anchor) { menu.remove(); document.removeEventListener("click", h); }
    }), 50);
}

// ========================================================================
// TEXT TOOL OVERLAY
// ========================================================================
function _showTextOverlay(p, e) {
    // Remove existing overlay
    let overlay = document.getElementById("textOverlay");
    if (overlay) overlay.remove();

    overlay = document.createElement("div");
    overlay.id = "textOverlay";
    overlay.style.cssText = "position:absolute;z-index:200;background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:10px;box-shadow:0 8px 24px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:6px;min-width:240px;";

    overlay.innerHTML = `
        <div style="display:flex;gap:4px;align-items:center;">
            <select id="textFont" style="flex:1;background:var(--bg-raised);color:var(--text-1);border:1px solid var(--border);border-radius:4px;padding:3px 6px;font-size:11px;">
                <option>Arial</option><option>Georgia</option><option>Courier New</option>
                <option>Impact</option><option>Verdana</option><option>Times New Roman</option>
                <option>Comic Sans MS</option><option>Trebuchet MS</option>
            </select>
            <input id="textSize" type="number" min="8" max="500" value="48" style="width:50px;background:var(--bg-raised);color:var(--text-1);border:1px solid var(--border);border-radius:4px;padding:3px 6px;font-size:11px;">
            <label style="font-size:10px;color:var(--text-3);display:flex;align-items:center;gap:2px;cursor:pointer;">
                <input id="textBold" type="checkbox"> <strong>B</strong>
            </label>
            <label style="font-size:10px;color:var(--text-3);display:flex;align-items:center;gap:2px;cursor:pointer;">
                <input id="textItalic" type="checkbox"> <em>I</em>
            </label>
        </div>
        <textarea id="textInput" rows="3" placeholder="Type text..." style="background:var(--bg-raised);color:var(--text-1);border:1px solid var(--border);border-radius:4px;padding:6px;font-size:14px;resize:vertical;min-width:200px;font-family:var(--font);"></textarea>
        <div style="display:flex;gap:4px;">
            <button id="textOk" style="flex:1;background:var(--accent);color:#fff;border:none;border-radius:4px;padding:5px 10px;cursor:pointer;font-size:11px;font-family:var(--font);">Place Text</button>
            <button id="textCancel" style="background:var(--bg-raised);color:var(--text-2);border:1px solid var(--border);border-radius:4px;padding:5px 10px;cursor:pointer;font-size:11px;font-family:var(--font);">Cancel</button>
        </div>`;

    // Append to viewport so position:absolute is relative to canvas area
    const vpEl = document.getElementById("studio-viewport") || document.body;
    vpEl.appendChild(overlay);

    // Position near click in viewport-relative coords, clamped to viewport
    const vpRect = vpEl.getBoundingClientRect();
    const screenX = p.x * S.zoom.scale + S.zoom.ox;
    const screenY = p.y * S.zoom.scale + S.zoom.oy;
    let left = Math.min(screenX, vpRect.width - 280);
    let top = Math.min(screenY, vpRect.height - 200);
    if (left < 10) left = 10; if (top < 10) top = 10;
    overlay.style.left = left + "px";
    overlay.style.top = top + "px";

    const textInput = document.getElementById("textInput");
    if (textInput) textInput.focus();

    const textPos = { x: p.x, y: p.y };

    function commitText() {
        const text = document.getElementById("textInput")?.value;
        if (!text) { overlay.remove(); return; }
        const font = document.getElementById("textFont")?.value || "Arial";
        const size = parseInt(document.getElementById("textSize")?.value) || 48;
        const bold = document.getElementById("textBold")?.checked;
        const italic = document.getElementById("textItalic")?.checked;
        overlay.remove();

        // Rasterize to a new layer
        C.saveStructuralUndo("Place text");
        const newL = C.makeLayer("Text: " + text.slice(0, 15), "paint");
        const style = `${italic ? "italic " : ""}${bold ? "bold " : ""}${size}px "${font}"`;
        newL.ctx.font = style;
        newL.ctx.fillStyle = S.color;
        newL.ctx.textBaseline = "top";
        const lines = text.split("\n");
        const lineHeight = size * 1.2;
        for (let i = 0; i < lines.length; i++) {
            newL.ctx.fillText(lines[i], textPos.x, textPos.y + i * lineHeight);
        }
        S.layers.splice(S.activeLayerIdx + 1, 0, newL);
        S.activeLayerIdx++;
        renderLayerPanel(); renderHistoryPanel(); _redraw();
    }

    document.getElementById("textOk")?.addEventListener("click", commitText);
    document.getElementById("textCancel")?.addEventListener("click", () => overlay.remove());
    textInput?.addEventListener("keydown", ev => {
        if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); commitText(); }
        if (ev.key === "Escape") overlay.remove();
        ev.stopPropagation(); // prevent tool shortcuts while typing
    });
    // Stop all key events from propagating while text overlay is open
    overlay.addEventListener("keydown", ev => ev.stopPropagation());
}

// ========================================================================
// ADJUSTMENT-LAYER WIDGETS
// ========================================================================
// Reusable gradient slider with N draggable handles, and a histogram canvas.
// Used by the Levels / HSL / Brightness editors below.

function _clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// handle kinds: "black" (down-pointing △ on top edge), "white" (△ on bottom),
// "gamma" (centered ◆), "point" (single tab on top edge for hue/sat/etc).
function buildGradientSlider(opts) {
    // opts: { min, max, step, gradient: cssString | "live", paintTrack?(canvas),
    //        handles: [{ id, value, kind, min?, max?, step? }], onChange(id, value) }
    const root = document.createElement("div");
    root.className = "gradient-slider";
    const track = document.createElement("div");
    track.className = "gradient-slider__track";
    if (opts.gradient && opts.gradient !== "live") track.style.background = opts.gradient;
    let trackCanvas = null;
    if (opts.paintTrack) {
        trackCanvas = document.createElement("canvas");
        trackCanvas.className = "gradient-slider__track-canvas";
        trackCanvas.width = 256; trackCanvas.height = 1;
        track.appendChild(trackCanvas);
    }
    root.appendChild(track);

    const handleEls = {};
    const range = (opts.max - opts.min) || 1;

    function valueToPct(v, min, max) { return ((v - min) / ((max - min) || 1)) * 100; }
    function positionHandles() {
        // Gamma is positioned proportionally between the live black and white handles,
        // log-mapped so g=10 sits at the black handle, g=1 at the midpoint, g=0.1 at the white handle.
        const inBlack = handleEls.black, inWhite = handleEls.white;
        for (const h of opts.handles) {
            const el = handleEls[h.id]; if (!el) continue;
            let pct;
            if (h.kind === "gamma" && inBlack && inWhite) {
                const lo = +inBlack.dataset.value, hi = +inWhite.dataset.value;
                const loPct = valueToPct(lo, opts.min, opts.max);
                const hiPct = valueToPct(hi, opts.min, opts.max);
                const g = +el.dataset.value;
                const frac = _clamp((1 - Math.log10(g)) * 0.5, 0, 1);
                pct = loPct + (hiPct - loPct) * frac;
            } else {
                pct = valueToPct(+el.dataset.value, h.min != null ? h.min : opts.min, h.max != null ? h.max : opts.max);
            }
            el.style.left = _clamp(pct, 0, 100) + "%";
        }
    }

    function setValue(id, v) {
        const el = handleEls[id]; if (!el) return;
        const h = opts.handles.find(x => x.id === id);
        const lo = h.min != null ? h.min : opts.min;
        const hi = h.max != null ? h.max : opts.max;
        el.dataset.value = String(_clamp(v, lo, hi));
        positionHandles();
    }

    function attachDrag(el, h) {
        let active = false;
        function onMove(ev) {
            if (!active) return;
            const r = track.getBoundingClientRect();
            const rel = _clamp((ev.clientX - r.left) / r.width, 0, 1);
            const lo = h.min != null ? h.min : opts.min;
            const hi = h.max != null ? h.max : opts.max;
            let v;
            if (h.kind === "gamma") {
                // Gamma's drag range is the segment between the live black and white
                // handles, log-mapped so center = 1.0, left edge = 10, right edge = 0.1.
                const inBlack = handleEls.black, inWhite = handleEls.white;
                const bPct = inBlack ? valueToPct(+inBlack.dataset.value, opts.min, opts.max) / 100 : 0;
                const wPct = inWhite ? valueToPct(+inWhite.dataset.value, opts.min, opts.max) / 100 : 1;
                const span = Math.max(0.001, wPct - bPct);
                const segRel = _clamp((rel - bPct) / span, 0, 1);
                const t = 1 - segRel * 2;        // 1 at left, -1 at right
                v = _clamp(Math.pow(10, t), 0.1, 9.99);
            } else {
                v = lo + rel * (hi - lo);
                if (h.step) v = Math.round(v / h.step) * h.step;
                else if (opts.step) v = Math.round(v / opts.step) * opts.step;
            }
            el.dataset.value = String(v);
            positionHandles();
            if (opts.onChange) opts.onChange(h.id, v);
        }
        function onUp() {
            active = false;
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
        }
        el.addEventListener("pointerdown", ev => {
            ev.stopPropagation(); ev.preventDefault();
            active = true;
            el.setPointerCapture && el.setPointerCapture(ev.pointerId);
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
        });
        el.addEventListener("dblclick", ev => {
            ev.stopPropagation();
            if (opts.onResetHandle) opts.onResetHandle(h.id);
        });
    }

    for (const h of opts.handles) {
        const el = document.createElement("div");
        el.className = "gradient-slider__handle gradient-slider__handle--" + h.kind;
        el.dataset.value = String(h.value);
        attachDrag(el, h);
        track.appendChild(el);
        handleEls[h.id] = el;
    }
    positionHandles();

    function paint() {
        if (trackCanvas && opts.paintTrack) opts.paintTrack(trackCanvas);
    }
    paint();

    return { el: root, setValue, repaint: paint };
}

function buildHistogram(opts) {
    // opts: { width, height }
    const wrap = document.createElement("div");
    wrap.className = "histogram";
    const canvas = document.createElement("canvas");
    canvas.width = opts.width || 256;
    canvas.height = opts.height || 60;
    canvas.className = "histogram__canvas";
    wrap.appendChild(canvas);
    const ctx = canvas.getContext("2d");

    function setSource(imgData) {
        const bins = new Uint32Array(256);
        const d = imgData.data;
        for (let p = 0, len = d.length; p < len; p += 4) {
            const a = d[p + 3];
            if (a === 0) continue;
            // perceptual luminance
            const y = (0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]) | 0;
            bins[y < 0 ? 0 : (y > 255 ? 255 : y)]++;
        }
        let max = 0;
        for (let i = 0; i < 256; i++) if (bins[i] > max) max = bins[i];
        const w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        // log-scale
        const lmax = Math.log(1 + max);
        ctx.fillStyle = "rgba(229,231,235,0.85)";
        const bw = w / 256;
        for (let i = 0; i < 256; i++) {
            const v = lmax === 0 ? 0 : Math.log(1 + bins[i]) / lmax;
            const bh = Math.round(v * h);
            ctx.fillRect(i * bw, h - bh, Math.ceil(bw), bh);
        }
    }

    return { el: wrap, setSource };
}

// Helper: build a small numeric input bound to an adjustParam key.
function _buildNumericInput(opts) {
    const inp = document.createElement("input");
    inp.type = "number"; inp.className = "adj-numeric-input";
    inp.min = opts.min; inp.max = opts.max; inp.step = opts.step != null ? opts.step : 1;
    inp.value = opts.value;
    inp.addEventListener("click", e => e.stopPropagation());
    inp.addEventListener("input", () => {
        let v = parseFloat(inp.value);
        if (Number.isNaN(v)) return;
        v = _clamp(v, opts.min, opts.max);
        opts.onChange(v);
    });
    return inp;
}

function _buildResetButton(onReset, title) {
    const b = document.createElement("button");
    b.className = "adj-reset-btn"; b.type = "button";
    b.textContent = "↺"; b.title = title || "Reset";
    b.addEventListener("click", e => { e.stopPropagation(); onReset(); });
    return b;
}

function _buildAdjEditor(L, redraw) {
    const wrap = document.createElement("div");
    wrap.className = "adj-editor";
    const ap = L.adjustParams;
    const ad = C._adjustDefaults[L.adjustType];

    // Brightness/Contrast — two -100..100 sliders, plain gray gradient, numeric + reset.
    if (L.adjustType === "brightness") {
        function row(label, key, min, max) {
            const r = document.createElement("div"); r.className = "adj-row";
            const lbl = document.createElement("span"); lbl.className = "adj-label"; lbl.textContent = label;
            const num = _buildNumericInput({
                min, max, step: 1, value: ap[key] | 0,
                onChange: v => { ap[key] = v | 0; L._lutCache = null; sliderApi.setValue("p", v); redraw(); }
            });
            const sliderApi = buildGradientSlider({
                min, max, step: 1,
                gradient: "linear-gradient(to right, #1a1a1a, #f4f4f4)",
                handles: [{ id: "p", value: ap[key] | 0, kind: "point" }],
                onChange: (_id, v) => {
                    ap[key] = Math.round(v); L._lutCache = null;
                    num.value = ap[key]; redraw();
                },
                onResetHandle: () => {
                    ap[key] = ad[key]; L._lutCache = null;
                    sliderApi.setValue("p", ap[key]); num.value = ap[key]; redraw();
                }
            });
            r.appendChild(lbl); r.appendChild(sliderApi.el); r.appendChild(num);
            r.appendChild(_buildResetButton(() => {
                ap[key] = ad[key]; L._lutCache = null;
                sliderApi.setValue("p", ap[key]); num.value = ap[key]; redraw();
            }, "Reset " + label));
            return r;
        }
        wrap.appendChild(row("Brightness", "brightness", -100, 100));
        wrap.appendChild(row("Contrast",   "contrast",   -100, 100));
        return wrap;
    }

    // HSL — model selector, colorize toggle, three sliders with live gradients.
    if (L.adjustType === "hue") {
        const head = document.createElement("div"); head.className = "adj-row adj-row--head";
        const segWrap = document.createElement("div"); segWrap.className = "adj-segmented";
        ["HSL", "HSV"].forEach(m => {
            const b = document.createElement("button"); b.type = "button"; b.textContent = m;
            if (ap.model === m) b.classList.add("active");
            b.addEventListener("click", e => {
                e.stopPropagation();
                ap.model = m;
                segWrap.querySelectorAll("button").forEach(x => x.classList.toggle("active", x.textContent === m));
                redraw();
            });
            segWrap.appendChild(b);
        });
        const colLabel = document.createElement("label"); colLabel.className = "adj-checkbox";
        const colInp = document.createElement("input"); colInp.type = "checkbox"; colInp.checked = !!ap.colorize;
        colInp.addEventListener("click", e => e.stopPropagation());
        colInp.addEventListener("change", () => { ap.colorize = colInp.checked; redraw(); });
        colLabel.appendChild(colInp); colLabel.appendChild(document.createTextNode(" Colorize"));
        head.appendChild(segWrap); head.appendChild(colLabel);
        wrap.appendChild(head);

        function paintHueTrack(canvas) {
            const cx = canvas.getContext("2d");
            const w = canvas.width, h = canvas.height;
            for (let x = 0; x < w; x++) {
                const hue = (x / w) * 360;
                cx.fillStyle = "hsl(" + hue + ", 100%, 50%)"; cx.fillRect(x, 0, 1, h);
            }
        }
        function paintSatTrack(canvas) {
            const cx = canvas.getContext("2d"); const w = canvas.width, h = canvas.height;
            const baseHue = ((ap.hue || 0) % 360 + 360) % 360;
            for (let x = 0; x < w; x++) {
                const t = x / w * 100;
                cx.fillStyle = "hsl(" + baseHue + "," + t + "%, 50%)"; cx.fillRect(x, 0, 1, h);
            }
        }
        function paintLightTrack(canvas) {
            const cx = canvas.getContext("2d"); const w = canvas.width, h = canvas.height;
            const baseHue = ((ap.hue || 0) % 360 + 360) % 360;
            for (let x = 0; x < w; x++) {
                const t = x / w * 100;
                cx.fillStyle = "hsl(" + baseHue + ", 100%, " + t + "%)"; cx.fillRect(x, 0, 1, h);
            }
        }

        const sliders = {};
        function makeRow(label, key, min, max, paint) {
            const r = document.createElement("div"); r.className = "adj-row";
            const lbl = document.createElement("span"); lbl.className = "adj-label"; lbl.textContent = label;
            const num = _buildNumericInput({
                min, max, step: 1, value: ap[key] | 0,
                onChange: v => { ap[key] = v | 0; sliderApi.setValue("p", v); _repaintDeps(key); redraw(); }
            });
            const sliderApi = buildGradientSlider({
                min, max, step: 1, paintTrack: paint,
                handles: [{ id: "p", value: ap[key] | 0, kind: "point" }],
                onChange: (_id, v) => {
                    ap[key] = Math.round(v); num.value = ap[key];
                    _repaintDeps(key); redraw();
                },
                onResetHandle: () => {
                    ap[key] = ad[key]; sliderApi.setValue("p", ap[key]);
                    num.value = ap[key]; _repaintDeps(key); redraw();
                }
            });
            sliders[key] = sliderApi;
            r.appendChild(lbl); r.appendChild(sliderApi.el); r.appendChild(num);
            r.appendChild(_buildResetButton(() => {
                ap[key] = ad[key]; sliderApi.setValue("p", ap[key]);
                num.value = ap[key]; _repaintDeps(key); redraw();
            }, "Reset " + label));
            return r;
        }
        function _repaintDeps(changedKey) {
            // Hue affects sat & light gradients; otherwise self-only.
            if (changedKey === "hue") {
                if (sliders.saturation) sliders.saturation.repaint();
                if (sliders.lightness)  sliders.lightness.repaint();
            }
        }
        wrap.appendChild(makeRow("Hue",        "hue",        -180, 180, paintHueTrack));
        wrap.appendChild(makeRow("Saturation", "saturation", -100, 100, paintSatTrack));
        wrap.appendChild(makeRow("Lightness",  "lightness",  -100, 100, paintLightTrack));

        const foot = document.createElement("div"); foot.className = "adj-row adj-row--foot";
        const resetAll = document.createElement("button"); resetAll.type = "button"; resetAll.className = "adj-button";
        resetAll.textContent = "Reset all";
        resetAll.addEventListener("click", e => {
            e.stopPropagation();
            Object.assign(ap, ad);
            renderLayerPanel(); redraw();
        });
        foot.appendChild(resetAll);
        wrap.appendChild(foot);
        return wrap;
    }

    // Levels — histogram, input slider with 3 handles, output slider with 2, numerics, auto + reset.
    if (L.adjustType === "levels") {
        const layerIdx = S.layers.indexOf(L);
        const histo = buildHistogram({ width: 256, height: 60 });
        wrap.appendChild(histo.el);

        let sourceImgData = null;
        function refreshHistogram() {
            try {
                const c = C._compositeLayersBelow(layerIdx);
                sourceImgData = c.getContext("2d").getImageData(0, 0, c.width, c.height);
                histo.setSource(sourceImgData);
            } catch (e) {
                console.error("[StudioUI] histogram build failed", e);
            }
        }
        refreshHistogram();

        const grayGrad = "linear-gradient(to right, #000, #fff)";

        // Input row with black/gamma/white
        const inSlider = buildGradientSlider({
            min: 0, max: 1, step: 0.001,
            gradient: grayGrad,
            handles: [
                { id: "black", value: ap.levInBlack || 0,   kind: "black" },
                { id: "gamma", value: ap.levGamma   || 1,   kind: "gamma", min: 0.1, max: 9.99 },
                { id: "white", value: ap.levInWhite || 1,   kind: "white" }
            ],
            onChange: (id, v) => {
                if (id === "black") ap.levInBlack = _clamp(v, 0, ap.levInWhite - 0.001);
                if (id === "white") ap.levInWhite = _clamp(v, ap.levInBlack + 0.001, 1);
                if (id === "gamma") ap.levGamma   = _clamp(v, 0.1, 9.99);
                L._lutCache = null;
                inBlackNum.value = Math.round(ap.levInBlack * 255);
                inWhiteNum.value = Math.round(ap.levInWhite * 255);
                gammaNum.value   = ap.levGamma.toFixed(2);
                inSlider.setValue("black", ap.levInBlack);
                inSlider.setValue("white", ap.levInWhite);
                inSlider.setValue("gamma", ap.levGamma);
                redraw();
            },
            onResetHandle: id => {
                if (id === "black") { ap.levInBlack = 0; inBlackNum.value = 0; }
                if (id === "white") { ap.levInWhite = 1; inWhiteNum.value = 255; }
                if (id === "gamma") { ap.levGamma   = 1; gammaNum.value = "1.00"; }
                L._lutCache = null;
                inSlider.setValue(id, id === "white" ? 1 : id === "gamma" ? 1 : 0);
                redraw();
            }
        });

        const inRow = document.createElement("div"); inRow.className = "adj-row";
        const inLbl = document.createElement("span"); inLbl.className = "adj-label"; inLbl.textContent = "Input";
        inRow.appendChild(inLbl); inRow.appendChild(inSlider.el);
        wrap.appendChild(inRow);

        const inNumRow = document.createElement("div"); inNumRow.className = "adj-row adj-row--nums";
        const inBlackNum = _buildNumericInput({
            min: 0, max: 254, step: 1, value: Math.round((ap.levInBlack || 0) * 255),
            onChange: v => {
                ap.levInBlack = _clamp(v / 255, 0, ap.levInWhite - 0.001);
                L._lutCache = null;
                inSlider.setValue("black", ap.levInBlack); redraw();
            }
        });
        const gammaNum = _buildNumericInput({
            min: 0.1, max: 9.99, step: 0.01, value: (ap.levGamma || 1).toFixed(2),
            onChange: v => {
                ap.levGamma = _clamp(v, 0.1, 9.99); L._lutCache = null;
                inSlider.setValue("gamma", ap.levGamma); redraw();
            }
        });
        const inWhiteNum = _buildNumericInput({
            min: 1, max: 255, step: 1, value: Math.round((ap.levInWhite != null ? ap.levInWhite : 1) * 255),
            onChange: v => {
                ap.levInWhite = _clamp(v / 255, ap.levInBlack + 0.001, 1);
                L._lutCache = null;
                inSlider.setValue("white", ap.levInWhite); redraw();
            }
        });
        inNumRow.appendChild(inBlackNum); inNumRow.appendChild(gammaNum); inNumRow.appendChild(inWhiteNum);
        wrap.appendChild(inNumRow);

        // Output row
        const outSlider = buildGradientSlider({
            min: 0, max: 1, step: 0.001,
            gradient: grayGrad,
            handles: [
                { id: "black", value: ap.levOutBlack || 0, kind: "black" },
                { id: "white", value: ap.levOutWhite || 1, kind: "white" }
            ],
            onChange: (id, v) => {
                if (id === "black") ap.levOutBlack = _clamp(v, 0, ap.levOutWhite - 0.001);
                if (id === "white") ap.levOutWhite = _clamp(v, ap.levOutBlack + 0.001, 1);
                L._lutCache = null;
                outBlackNum.value = Math.round(ap.levOutBlack * 255);
                outWhiteNum.value = Math.round(ap.levOutWhite * 255);
                outSlider.setValue("black", ap.levOutBlack);
                outSlider.setValue("white", ap.levOutWhite);
                redraw();
            },
            onResetHandle: id => {
                if (id === "black") { ap.levOutBlack = 0; outBlackNum.value = 0; outSlider.setValue("black", 0); }
                if (id === "white") { ap.levOutWhite = 1; outWhiteNum.value = 255; outSlider.setValue("white", 1); }
                L._lutCache = null; redraw();
            }
        });

        const outRow = document.createElement("div"); outRow.className = "adj-row";
        const outLbl = document.createElement("span"); outLbl.className = "adj-label"; outLbl.textContent = "Output";
        outRow.appendChild(outLbl); outRow.appendChild(outSlider.el);
        wrap.appendChild(outRow);

        const outNumRow = document.createElement("div"); outNumRow.className = "adj-row adj-row--nums";
        const outBlackNum = _buildNumericInput({
            min: 0, max: 254, step: 1, value: Math.round((ap.levOutBlack || 0) * 255),
            onChange: v => {
                ap.levOutBlack = _clamp(v / 255, 0, ap.levOutWhite - 0.001);
                L._lutCache = null;
                outSlider.setValue("black", ap.levOutBlack); redraw();
            }
        });
        const outWhiteNum = _buildNumericInput({
            min: 1, max: 255, step: 1, value: Math.round((ap.levOutWhite != null ? ap.levOutWhite : 1) * 255),
            onChange: v => {
                ap.levOutWhite = _clamp(v / 255, ap.levOutBlack + 0.001, 1);
                L._lutCache = null;
                outSlider.setValue("white", ap.levOutWhite); redraw();
            }
        });
        outNumRow.appendChild(outBlackNum); outNumRow.appendChild(outWhiteNum);
        wrap.appendChild(outNumRow);

        // Buttons row: refresh histogram, auto-levels, reset all
        const btnRow = document.createElement("div"); btnRow.className = "adj-row adj-row--foot";
        const refreshBtn = document.createElement("button"); refreshBtn.type = "button"; refreshBtn.className = "adj-button";
        refreshBtn.textContent = "Refresh histogram";
        refreshBtn.addEventListener("click", e => { e.stopPropagation(); refreshHistogram(); });

        const autoBtn = document.createElement("button"); autoBtn.type = "button"; autoBtn.className = "adj-button";
        autoBtn.textContent = "Auto";
        autoBtn.title = "Stretch input black/white to histogram 0.1% / 99.9% percentile";
        autoBtn.addEventListener("click", e => {
            e.stopPropagation();
            if (!sourceImgData) return;
            const bins = new Uint32Array(256);
            const d = sourceImgData.data; let total = 0;
            for (let p = 0, len = d.length; p < len; p += 4) {
                if (d[p + 3] === 0) continue;
                const y = (0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]) | 0;
                bins[y < 0 ? 0 : (y > 255 ? 255 : y)]++; total++;
            }
            if (!total) return;
            const lo = total * 0.001, hi = total * 0.999;
            let acc = 0, bv = 0, wv = 255;
            for (let i = 0; i < 256; i++) { acc += bins[i]; if (acc >= lo) { bv = i; break; } }
            acc = 0;
            for (let i = 0; i < 256; i++) { acc += bins[i]; if (acc >= hi) { wv = i; break; } }
            ap.levInBlack = bv / 255;
            ap.levInWhite = Math.max(ap.levInBlack + 0.001, wv / 255);
            L._lutCache = null;
            inBlackNum.value = bv; inWhiteNum.value = wv;
            inSlider.setValue("black", ap.levInBlack);
            inSlider.setValue("white", ap.levInWhite);
            redraw();
        });

        const resetBtn = document.createElement("button"); resetBtn.type = "button"; resetBtn.className = "adj-button";
        resetBtn.textContent = "Reset";
        resetBtn.addEventListener("click", e => {
            e.stopPropagation();
            Object.assign(ap, ad); L._lutCache = null;
            renderLayerPanel(); redraw();
        });

        btnRow.appendChild(refreshBtn); btnRow.appendChild(autoBtn); btnRow.appendChild(resetBtn);
        wrap.appendChild(btnRow);
        return wrap;
    }

    return wrap;
}

// ========================================================================
// LAYER PANEL
// ========================================================================
function renderLayerPanel() {
    const panel = document.getElementById("layersList");
    if (!panel) return;
    panel.innerHTML = "";
    for (let i = S.layers.length - 1; i >= 0; i--) {
        const L = S.layers[i];
        const isActive = !S.editingMask && !S.regionMode && i === S.activeLayerIdx;
        const row = document.createElement("div");
        row.className = "layer-item" + (isActive ? " selected" : "");
        const layerIdx = i;

        // Thumbnail
        const thumb = document.createElement("div");
        thumb.className = "layer-thumb";
        if (L.canvas) {
            try {
                const tc = document.createElement("canvas"); tc.width = 32; tc.height = 32;
                tc.getContext("2d").drawImage(L.canvas, 0, 0, S.W, S.H, 0, 0, 32, 32);
                thumb.style.backgroundImage = `url(${tc.toDataURL()})`;
                thumb.style.backgroundSize = "cover";
            } catch (_) {}
        }

        // Info section
        const info = document.createElement("div");
        info.className = "layer-info";
        const nameEl = document.createElement("div");
        nameEl.className = "layer-name"; nameEl.textContent = L.name;
        // Prevent single-click on name from triggering row rebuild (which kills dblclick)
        nameEl.addEventListener("click", e => e.stopPropagation());
        // Double-click to rename
        nameEl.addEventListener("dblclick", e => {
            e.stopPropagation();
            nameEl.contentEditable = "true"; nameEl.focus();
            const range = document.createRange(); range.selectNodeContents(nameEl);
            const sel2 = window.getSelection(); sel2.removeAllRanges(); sel2.addRange(range);
            const commit = () => {
                nameEl.contentEditable = "false";
                const n = nameEl.textContent.trim();
                if (n) L.name = n;
                renderLayerPanel();
            };
            nameEl.addEventListener("blur", commit, { once: true });
            nameEl.addEventListener("keydown", ev => {
                if (ev.key === "Enter") { ev.preventDefault(); nameEl.blur(); }
                if (ev.key === "Escape") { nameEl.textContent = L.name; nameEl.blur(); }
            });
        });

        // Active layer gets interactive controls
        if (isActive && L.type === "adjustment") {
            const meta = document.createElement("div");
            meta.className = "layer-meta";
            meta.textContent = "⚙ Adjustment";
            info.appendChild(nameEl); info.appendChild(meta);
            try {
                row._editorRow = _buildAdjEditor(L, _redraw);
                // Tag the editor row so it visually continues the
                // selected layer's accent left-border + bg tint instead
                // of ending the selection block at the row boundary.
                if (row._editorRow) row._editorRow.classList.add("layer-editor-active");
            } catch (e) {
                console.error("[StudioUI] Adjust editor build error:", e);
            }
        } else if (isActive && L.type !== "adjustment") {
            const controls = document.createElement("div");
            controls.className = "layer-meta layer-controls";

            const blendSel = document.createElement("select");
            blendSel.className = "layer-blend-select";
            for (const [val, label] of C.ALL_BLEND_MODES) {
                const opt = document.createElement("option");
                opt.value = val; opt.textContent = label;
                if (val === L.blendMode) opt.selected = true;
                blendSel.appendChild(opt);
            }
            blendSel.addEventListener("click", e => e.stopPropagation());
            blendSel.addEventListener("change", () => { L.blendMode = blendSel.value; _redraw(); });

            const opSlider = document.createElement("input");
            opSlider.type = "range"; opSlider.min = "0"; opSlider.max = "100";
            opSlider.value = Math.round(L.opacity * 100);
            opSlider.className = "layer-opacity-slider";
            opSlider.addEventListener("click", e => e.stopPropagation());
            opSlider.addEventListener("input", () => {
                L.opacity = +opSlider.value / 100;
                opLabel.textContent = Math.round(opSlider.value) + "%";
                _redraw();
            });

            const opLabel = document.createElement("span");
            opLabel.className = "layer-opacity-label";
            opLabel.textContent = Math.round(L.opacity * 100) + "%";

            controls.appendChild(blendSel); controls.appendChild(opSlider); controls.appendChild(opLabel);
            info.appendChild(nameEl); info.appendChild(controls);
        } else {
            const meta = document.createElement("div");
            meta.className = "layer-meta";
            if (L.type === "adjustment") {
                meta.textContent = "⚙ Adjustment";
            } else {
                const blendLabel = C.ALL_BLEND_MODES.find(b => b[0] === L.blendMode)?.[1] || "Normal";
                meta.textContent = blendLabel + " · " + Math.round(L.opacity * 100) + "%";
            }
            info.appendChild(nameEl); info.appendChild(meta);
        }

        // Visibility
        const vis = document.createElement("div");
        vis.className = "layer-vis";
        vis.innerHTML = L.visible
            ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity="0.3"><line x1="1" y1="1" x2="23" y2="23"/></svg>';
        vis.addEventListener("click", e => {
            e.stopPropagation(); L.visible = !L.visible; renderLayerPanel(); _redraw();
        });

        row.appendChild(thumb); row.appendChild(info); row.appendChild(vis);
        row.addEventListener("click", () => {
            S.editingMask = false; S.regionMode = false; S.activeLayerIdx = layerIdx;
            renderLayerPanel(); _redraw();
        });
        // Right-click → activate this layer first, then open the
        // flip/rotate context menu. Activate-on-contextmenu matches
        // the OS file-manager pattern users expect.
        row.addEventListener("contextmenu", e => {
            e.preventDefault();
            e.stopPropagation();
            S.editingMask = false; S.regionMode = false; S.activeLayerIdx = layerIdx;
            renderLayerPanel();
            _showLayerCtxMenu(e.clientX, e.clientY);
        });
        panel.appendChild(row);
        if (row._editorRow) panel.appendChild(row._editorRow);
    }
}

// ========================================================================
// HISTORY PANEL
// ========================================================================
function renderHistoryPanel() {
    const panel = document.getElementById("historyList");
    if (!panel) return;
    panel.innerHTML = "";
    // Show undo stack (past actions)
    for (let i = 0; i < S.undoStack.length; i++) {
        const e = S.undoStack[i];
        const row = document.createElement("div");
        row.className = "history-item" + (i === S.undoStack.length - 1 && !S.redoStack.length ? " current" : "");
        row.textContent = e.label || "Action";
        row.addEventListener("click", () => {
            const stepsBack = S.undoStack.length - 1 - i;
            for (let s = 0; s < stepsBack; s++) C.undo();
            renderLayerPanel(); renderHistoryPanel(); _redraw();
        });
        panel.appendChild(row);
    }
    // Show redo stack (future actions, greyed out) — reversed since redoStack is LIFO
    for (let i = S.redoStack.length - 1; i >= 0; i--) {
        const e = S.redoStack[i];
        const row = document.createElement("div");
        row.className = "history-item history-redo";
        row.textContent = e.label || "Action";
        row.addEventListener("click", () => {
            const stepsForward = S.redoStack.length - i;
            for (let s = 0; s < stepsForward; s++) C.redo();
            renderLayerPanel(); renderHistoryPanel(); _redraw();
        });
        panel.appendChild(row);
    }
}

// ========================================================================
// REGION PANEL
// ========================================================================
function updateRegionVisibility() {
    const section = document.getElementById("regionSection");
    if (!section) return;
    // Show regions panel in Create mode (attention coupling) or Edit > Regional
    const show = S.studioMode === "Create" || (S.studioMode === "Edit" && S.inpaintMode === "Regional") || S.regions.length > 0;
    section.style.display = show ? "" : "none";
}

function renderRegionPanel() {
    const panel = document.getElementById("regionList");
    if (!panel) return;
    panel.innerHTML = "";
    updateRegionVisibility();

    if (!S.regions.length) {
        const hint = document.createElement("div");
        hint.style.cssText = "font-size:10px;color:var(--text-4);padding:6px 4px;";
        hint.textContent = "Add regions for per-area prompts.";
        panel.appendChild(hint);
        return;
    }

    for (const r of S.regions) {
        const isActive = S.regionMode && r.id === S.activeRegionId;
        const row = document.createElement("div");
        row.style.cssText = `border:1px solid ${isActive ? r.color : "var(--border)"};border-radius:6px;margin-bottom:4px;padding:6px;background:${isActive ? "rgba(124,58,237,0.06)" : "var(--bg-raised)"};cursor:pointer;`;

        // Header: color dot, name, visibility, clear, delete
        const hdr = document.createElement("div");
        hdr.style.cssText = "display:flex;gap:4px;align-items:center;margin-bottom:4px;";

        const dot = document.createElement("span");
        dot.style.cssText = `width:10px;height:10px;border-radius:50%;background:${r.color};flex-shrink:0;`;

        const nm = document.createElement("span");
        nm.style.cssText = "font-size:10px;font-weight:600;flex:1;color:var(--text-1);cursor:pointer;user-select:none;";
        nm.textContent = r.name;
        // Double-click to rename (single-click selects region)
        nm.addEventListener("dblclick", e => {
            e.stopPropagation();
            nm.contentEditable = "true";
            nm.focus();
            // Select all text
            const range = document.createRange();
            range.selectNodeContents(nm);
            const sel = window.getSelection();
            sel.removeAllRanges(); sel.addRange(range);
        });
        nm.addEventListener("blur", () => { nm.contentEditable = "false"; r.name = nm.textContent.trim() || r.name; });
        nm.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); nm.blur(); } e.stopPropagation(); });

        const eyeBtn = document.createElement("button");
        eyeBtn.style.cssText = "font-size:10px;padding:1px 4px;background:none;border:1px solid var(--border);border-radius:3px;color:var(--text-3);cursor:pointer;";
        eyeBtn.textContent = r.visible ? "👁" : "—";
        eyeBtn.addEventListener("click", e => { e.stopPropagation(); r.visible = !r.visible; renderRegionPanel(); _redraw(); });

        const clrBtn = document.createElement("button");
        clrBtn.style.cssText = "font-size:9px;padding:1px 4px;background:none;border:1px solid var(--border);border-radius:3px;color:var(--text-3);cursor:pointer;";
        clrBtn.textContent = "⌫";
        clrBtn.title = "Clear region mask";
        clrBtn.addEventListener("click", e => { e.stopPropagation(); C.clearRegion(r.id); _redraw(); });

        const delBtn = document.createElement("button");
        delBtn.style.cssText = "font-size:9px;padding:1px 4px;background:none;border:1px solid var(--border);border-radius:3px;color:#ef4444;cursor:pointer;";
        delBtn.textContent = "✕";
        delBtn.addEventListener("click", e => { e.stopPropagation(); C.deleteRegion(r.id); renderRegionPanel(); _redraw(); });

        hdr.appendChild(dot); hdr.appendChild(nm); hdr.appendChild(eyeBtn); hdr.appendChild(clrBtn); hdr.appendChild(delBtn);

        // Prompt textarea
        const prompt = document.createElement("textarea");
        prompt.value = r.prompt;
        prompt.placeholder = "Region prompt...";
        prompt.style.cssText = "width:100%;font-size:10px;background:var(--bg-surface);color:var(--text-1);border:1px solid var(--border);border-radius:3px;padding:3px 5px;box-sizing:border-box;resize:vertical;min-height:32px;max-height:72px;font-family:var(--font);";
        prompt.addEventListener("click", e => e.stopPropagation());
        prompt.addEventListener("input", () => { r.prompt = prompt.value; });
        prompt.addEventListener("keydown", e => e.stopPropagation());

        // Negative prompt
        const neg = document.createElement("textarea");
        neg.value = r.negPrompt;
        neg.placeholder = "Negative (optional)...";
        neg.style.cssText = "width:100%;font-size:10px;background:var(--bg-surface);color:var(--text-4);border:1px solid var(--border);border-radius:3px;padding:3px 5px;box-sizing:border-box;resize:vertical;min-height:22px;max-height:50px;font-family:var(--font);margin-top:3px;";
        neg.addEventListener("click", e => e.stopPropagation());
        neg.addEventListener("input", () => { r.negPrompt = neg.value; });
        neg.addEventListener("keydown", e => e.stopPropagation());

        // Contextual slider: Weight (attention couple) or Denoise (regional inpaint)
        const isEditRegional = S.studioMode === "Edit";
        const denRow = document.createElement("div");
        denRow.style.cssText = "display:flex;align-items:center;gap:4px;margin-top:3px;";
        const denLbl = document.createElement("span");
        denLbl.style.cssText = "font-size:9px;color:var(--text-4);white-space:nowrap;";
        denLbl.textContent = isEditRegional ? "Denoise:" : "Weight:";
        const denSlider = document.createElement("input");
        denSlider.type = "range";
        if (isEditRegional) {
            denSlider.min = "10"; denSlider.max = "100"; denSlider.step = "5";
            denSlider.value = Math.round(r.denoising * 100);
        } else {
            denSlider.min = "25"; denSlider.max = "200"; denSlider.step = "5";
            denSlider.value = Math.round((r.weight || 1.0) * 100);
        }
        denSlider.style.cssText = `flex:1;height:3px;accent-color:${r.color};`;
        denSlider.addEventListener("click", e => e.stopPropagation());
        const denVal = document.createElement("span");
        denVal.style.cssText = "font-size:9px;color:var(--text-2);min-width:28px;text-align:right;";
        denVal.textContent = isEditRegional ? r.denoising.toFixed(2) : (r.weight || 1.0).toFixed(2);
        denSlider.addEventListener("input", () => {
            if (isEditRegional) {
                r.denoising = +denSlider.value / 100;
                denVal.textContent = r.denoising.toFixed(2);
            } else {
                r.weight = +denSlider.value / 100;
                denVal.textContent = r.weight.toFixed(2);
            }
        });
        denRow.appendChild(denLbl); denRow.appendChild(denSlider); denRow.appendChild(denVal);

        row.appendChild(hdr); row.appendChild(prompt); row.appendChild(neg); row.appendChild(denRow);

        // Click row to select/deselect region (toggle)
        row.addEventListener("click", () => {
            if (S.activeRegionId === r.id && S.regionMode) {
                // Already selected — deselect
                S.activeRegionId = null;
                S.regionMode = false;
            } else {
                // Select this region and enter paint mode
                S.activeRegionId = r.id;
                S.regionMode = true;
            }
            renderRegionPanel(); _redraw();
        });

        panel.appendChild(row);
    }

    // Hint text
    const hint = document.createElement("div");
    hint.style.cssText = "font-size:9px;color:var(--text-4);padding:3px 0;line-height:1.4;";
    if (S.regionMode && S.studioMode === "Edit") {
        hint.textContent = "Each region runs as a separate inpaint pass.";
    } else if (S.regionMode) {
        hint.textContent = "Paint regions for different characters/areas. Main prompt = scene.";
    } else {
        hint.textContent = "Enable Paint mode to draw region masks on canvas.";
    }
    panel.appendChild(hint);
}

// Wire undo/redo callback
C.onUndoRedo = () => {
    const prevW = S.W, prevH = S.H;
    renderLayerPanel(); renderHistoryPanel();
    // Structural undo may change canvas dimensions — sync everything
    var wEl = document.getElementById("paramWidth");
    var hEl = document.getElementById("paramHeight");
    if (wEl && parseInt(wEl.value) !== S.W) wEl.value = S.W;
    if (hEl && parseInt(hEl.value) !== S.H) hEl.value = S.H;
    if (window.StatusBar) window.StatusBar.setDimensions(S.W, S.H);
    syncCanvasToViewport();
    // Only refit if canvas dimensions actually changed — preserve user's zoom/pan otherwise
    if (S.W !== prevW || S.H !== prevH) C.zoomFit();
    _redraw();
};

// ========================================================================
// KEYBOARD SHORTCUTS
// ========================================================================
let _spaceDown = false;

// ── Layer helper functions (shared by buttons + shortcuts) ──

function _addLayer() {
    const C = window.StudioCore, S = C.state;
    C.saveStructuralUndo("Add layer");
    const L = C.makeLayer("Layer " + S.layers.length, "paint");
    S.layers.splice(S.activeLayerIdx + 1, 0, L);
    S.activeLayerIdx++;
    renderLayerPanel(); renderHistoryPanel(); _redraw();
}

function _duplicateLayer() {
    const C = window.StudioCore, S = C.state;
    const src = C.activeLayer(); if (!src || !src.canvas) return;
    C.saveStructuralUndo("Duplicate layer");
    const L = C.makeLayer(src.name + " copy", src.type);
    L.ctx.drawImage(src.canvas, 0, 0);
    L.opacity = src.opacity; L.blendMode = src.blendMode;
    if (src.type === "adjustment") L.adjustParams = { ...src.adjustParams };
    S.layers.splice(S.activeLayerIdx + 1, 0, L);
    S.activeLayerIdx++;
    renderLayerPanel(); renderHistoryPanel(); _redraw();
}

function _mergeDown() {
    const C = window.StudioCore, S = C.state;
    if (S.activeLayerIdx <= 0) return;
    const top = S.layers[S.activeLayerIdx];
    const bot = S.layers[S.activeLayerIdx - 1];
    if (!top.canvas || !bot.canvas) return;
    C.saveStructuralUndo("Merge down");
    bot.ctx.globalCompositeOperation = top.blendMode || "source-over";
    bot.ctx.globalAlpha = top.opacity;
    bot.ctx.drawImage(top.canvas, 0, 0);
    bot.ctx.globalCompositeOperation = "source-over";
    bot.ctx.globalAlpha = 1;
    S.layers.splice(S.activeLayerIdx, 1);
    S.activeLayerIdx--;
    renderLayerPanel(); renderHistoryPanel(); _redraw();
}

function _flattenVisible() {
    const C = window.StudioCore, S = C.state;
    if (S.layers.length <= 1) return;
    C.saveStructuralUndo("Flatten visible");
    const flat = C.makeLayer("Flattened", "paint");
    // Composite all visible layers onto flat
    for (const L of S.layers) {
        if (!L.visible) continue;
        if (L.type === "adjustment") { C._applyAdjustment(flat.ctx, S.W, S.H, L); continue; }
        flat.ctx.globalCompositeOperation = L.blendMode || "source-over";
        flat.ctx.globalAlpha = L.opacity;
        flat.ctx.drawImage(L.canvas, 0, 0);
    }
    flat.ctx.globalCompositeOperation = "source-over";
    flat.ctx.globalAlpha = 1;
    S.layers = [flat];
    S.activeLayerIdx = 0;
    renderLayerPanel(); renderHistoryPanel(); _redraw();
}

// ── Canvas Context Menu ─────────────────────────────────

let _ctxMenu = null;
let _ctxMenuJustClosed = false;

function _createCtxMenu() {
    if (_ctxMenu) return _ctxMenu;
    const el = document.createElement("div");
    el.className = "studio-ctx-menu";
    el.style.cssText = `
        display:none; position:fixed; z-index:9999;
        background:var(--bg-surface, #1a1a2e); border:1px solid var(--border, #333);
        border-radius:6px; box-shadow:0 8px 24px rgba(0,0,0,0.6);
        min-width:180px; padding:4px 0;
        font-family:var(--font, sans-serif); font-size:11px;
        color:var(--text-2, #ccc);
    `;
    document.body.appendChild(el);
    _ctxMenu = el;
    // Close on any click outside
    document.addEventListener("pointerdown", e => {
        if (_ctxMenu && _ctxMenu.style.display !== "none" && !_ctxMenu.contains(e.target)) {
            _hideCtxMenu();
            _ctxMenuJustClosed = true;
            setTimeout(() => { _ctxMenuJustClosed = false; }, 50);
        }
    });
    return el;
}

function _hideCtxMenu() {
    if (_ctxMenu) _ctxMenu.style.display = "none";
}

function _showCtxMenu(x, y) {
    const C = window.StudioCore, S = C.state;
    const menu = _createCtxMenu();
    const hasSel = S.selection?.active;

    const items = [
        { label: "Select All", shortcut: "Ctrl+A", action: () => { C.selectionAll(); startMarchingAnts(); _redraw(); } },
        hasSel ? { label: "Deselect", shortcut: "Ctrl+D", action: () => { C.selectionClear(); stopMarchingAnts(); _redraw(); } } : null,
        hasSel ? { label: "Invert Selection", shortcut: "Ctrl+Shift+I", action: () => { C.selectionInvert(); _redraw(); } } : null,
        { type: "sep" },
        hasSel ? { label: "Copy", shortcut: "Ctrl+C", action: () => { C.selectionCopy(); } } : null,
        hasSel ? { label: "Cut", shortcut: "Ctrl+X", action: () => { C.selectionCut(); _redraw(); } } : null,
        S.clipboard ? { label: "Paste", shortcut: "Ctrl+V", action: () => { C.selectionPaste(); renderLayerPanel(); _redraw(); } } : null,
        hasSel ? { label: "Delete", shortcut: "Del", action: () => { C.saveUndo("Delete"); C.selectionDelete(); _redraw(); } } : null,
        { type: "sep" },
        { label: "New Layer", shortcut: "Ctrl+Shift+N", action: _addLayer },
        { label: "Duplicate Layer", shortcut: "Ctrl+J", action: _duplicateLayer },
        { label: "Merge Down", shortcut: "Ctrl+E", action: _mergeDown },
        { label: "Flatten Visible", shortcut: "Ctrl+Shift+E", action: _flattenVisible },
        { type: "sep" },
        { label: "Zoom to Fit", shortcut: "F", action: () => { C.zoomFit(); updateStatus(); _redraw(); } },
        { type: "sep" },
        { label: "Save as PNG", action: () => _ctxSaveCanvas("png") },
        { label: "Save as JPEG", action: () => _ctxSaveCanvas("jpeg") },
        { label: "Save as WebP", action: () => _ctxSaveCanvas("webp") },
        { label: "Export PSD (layers)", action: () => savePSD() },
    ].filter(Boolean);

    menu.innerHTML = items.map(item => {
        if (item.type === "sep") return `<div style="height:1px;background:var(--border-subtle,#222);margin:3px 0;"></div>`;
        return `<div class="ctx-menu-item" style="padding:5px 12px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:16px;">
            <span>${item.label}</span>
            ${item.shortcut ? `<span style="color:var(--text-4,#666);font-size:10px;font-family:var(--mono,monospace);">${item.shortcut}</span>` : ""}
        </div>`;
    }).join("");

    // Bind click handlers
    const menuItems = menu.querySelectorAll(".ctx-menu-item");
    let actionIdx = 0;
    for (const item of items) {
        if (item.type === "sep") continue;
        const el = menuItems[actionIdx++];
        if (el) {
            el.addEventListener("click", () => { _hideCtxMenu(); item.action(); });
            el.addEventListener("mouseenter", () => el.style.background = "var(--accent-dim, #333)");
            el.addEventListener("mouseleave", () => el.style.background = "transparent");
        }
    }

    // Position (keep on screen)
    menu.style.left = Math.min(x, window.innerWidth - 200) + "px";
    menu.style.top = Math.min(y, window.innerHeight - 400) + "px";
    menu.style.display = "block";
}

// Right-click menu shown when the user contextmenus a layer row in
// the panel. Targets the active layer; the row's click handler also
// activates the layer first when called via the row binding below.
function _showLayerCtxMenu(x, y) {
    const C = window.StudioCore, S = C.state;
    const L = C.activeLayer();
    const isAdjust = L && L.type === "adjustment";
    const menu = _createCtxMenu();

    const apply = (fn) => () => { fn(); renderLayerPanel(); _redraw(); };

    const items = [
        { label: "Flip Horizontal", shortcut: "Ctrl+Shift+H", action: apply(() => C.flipLayerHorizontal()), disabled: isAdjust },
        { label: "Flip Vertical",   shortcut: "Ctrl+Shift+V", action: apply(() => C.flipLayerVertical()),   disabled: isAdjust },
        { type: "sep" },
        { label: "Rotate 90° CW",  action: apply(() => C.rotateLayer90CW()),  disabled: isAdjust },
        { label: "Rotate 90° CCW", action: apply(() => C.rotateLayer90CCW()), disabled: isAdjust },
        { label: "Rotate 180°",    action: apply(() => C.rotateLayer180()),   disabled: isAdjust },
        { label: "Rotate Arbitrary…", action: () => {
            const ans = prompt("Rotate by how many degrees? (positive = clockwise)", "15");
            if (ans === null) return;
            const deg = parseFloat(ans);
            if (!Number.isFinite(deg)) { if (window.showToast) window.showToast("Invalid angle", "warning"); return; }
            C.rotateLayerArbitrary(deg);
            renderLayerPanel(); _redraw();
        }, disabled: isAdjust },
    ];

    menu.innerHTML = items.map(item => {
        if (item.type === "sep") return `<div style="height:1px;background:var(--border-subtle,#222);margin:3px 0;"></div>`;
        const dim = item.disabled ? "opacity:0.4;cursor:not-allowed;" : "cursor:pointer;";
        return `<div class="ctx-menu-item" style="padding:5px 12px;display:flex;justify-content:space-between;align-items:center;gap:16px;${dim}">
            <span>${item.label}</span>
            ${item.shortcut ? `<span style="color:var(--text-4,#666);font-size:10px;font-family:var(--mono,monospace);">${item.shortcut}</span>` : ""}
        </div>`;
    }).join("");

    const menuItems = menu.querySelectorAll(".ctx-menu-item");
    let actionIdx = 0;
    for (const item of items) {
        if (item.type === "sep") continue;
        const el = menuItems[actionIdx++];
        if (!el) continue;
        if (item.disabled) continue;
        el.addEventListener("click", () => { _hideCtxMenu(); item.action(); });
        el.addEventListener("mouseenter", () => el.style.background = "var(--accent-dim, #333)");
        el.addEventListener("mouseleave", () => el.style.background = "transparent");
    }

    menu.style.left = Math.min(x, window.innerWidth - 220) + "px";
    menu.style.top = Math.min(y, window.innerHeight - 240) + "px";
    menu.style.display = "block";
}

async function _ctxSaveCanvas(fmt) {
    const C = window.StudioCore;
    const mimeMap = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
    const dataUrl = C.exportFlattened(mimeMap[fmt]);

    // Embed generation metadata in PNGs when available
    const State = window.State;
    let metadata = null;
    if (fmt === "png" && State?.embedMetadata && State.outputInfotexts?.length) {
        metadata = State.outputInfotexts[State.selectedOutputIdx] || State.outputInfotexts[0] || null;
    }

    // Use the active Canvas document's name as the save filename hint so
    // the file lands on disk with a recognizable name (and the URL the
    // saved image opens at carries that name into the browser's
    // right-click "Save image as…" suggestion). Without this hint the
    // backend falls back to studio_<timestamp>_<pid>, and some browsers
    // suggest "Untitled" when opening the resulting /file= URL.
    const docName = (window.StudioDocs?.activeDoc?.name || "").trim() || null;

    try {
        const result = await window.API.saveImage({
            image_b64: dataUrl,
            format: fmt,
            quality: 95,
            metadata: metadata,
            filename: docName,
        });
        if (result.ok && result.path) {
            // Open as /file= URL — browser shows image with native Save Image As on right-click
            window.open(`${window.API.base}/file=${result.path}`, "_blank");
            if (window.showToast) window.showToast(`Saved ${fmt.toUpperCase()} → ${result.filename}`, "success");
        } else {
            throw new Error(result.error || "Save failed");
        }
    } catch (e) {
        console.error("[StudioUI] Save failed:", e);
        // Fallback: client-side download
        const a = document.createElement("a");
        a.href = dataUrl;
        a.download = `studio_${Date.now()}.${fmt === "jpeg" ? "jpg" : fmt}`;
        document.body.appendChild(a); a.click();
        setTimeout(() => document.body.removeChild(a), 100);
        if (window.showToast) window.showToast(`Saved locally (server unavailable)`, "info");
    }
}

// ── Keyboard Shortcuts ──────────────────────────────────

function bindKeys() {
    document.addEventListener("keydown", e => {
        if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;

        // Space for pan mode
        if (e.key === " " && !e.repeat) {
            e.preventDefault();
            _spaceDown = true;
            if (S.canvas) S.canvas.style.cursor = "grab";
            return;
        }

        // Ctrl combos
        if (e.ctrlKey || e.metaKey) {
            // Ctrl+Shift+V → Flip active layer vertically. Has to come
            // before the Ctrl+V (paste) case below, which returns
            // unconditionally regardless of shift.
            if (e.shiftKey && e.key.toLowerCase() === "v" && !S.transform.active) {
                e.preventDefault();
                C.flipLayerVertical();
                renderLayerPanel(); _redraw();
                return;
            }
            switch (e.key.toLowerCase()) {
                case "z": e.preventDefault(); e.shiftKey ? C.redo() : C.undo(); renderLayerPanel(); renderHistoryPanel(); _redraw(); return;
                case "a": e.preventDefault(); C.selectionAll(); startMarchingAnts(); _redraw(); return;
                case "d": e.preventDefault(); C.selectionClear(); stopMarchingAnts(); _redraw(); return;
                case "c": if (S.selection.active) { e.preventDefault(); C.selectionCopy(); } return;
                case "x": if (S.selection.active) { e.preventDefault(); C.selectionCut(); _redraw(); } return;
                case "v": if (S.clipboard) { e.preventDefault(); C.selectionPaste(); renderLayerPanel(); _redraw(); } return;
                case "e":
                    e.preventDefault();
                    if (e.shiftKey) {
                        // Ctrl+Shift+E — Flatten visible
                        _flattenVisible();
                    } else {
                        // Ctrl+E — Merge down
                        _mergeDown();
                    }
                    return;
                case "j":
                    e.preventDefault();
                    // Ctrl+J — Duplicate layer
                    _duplicateLayer();
                    return;
                case "n":
                    if (e.shiftKey) {
                        e.preventDefault();
                        // Ctrl+Shift+N — New layer
                        _addLayer();
                    }
                    return;
                case "h":
                    if (e.shiftKey && !S.transform.active) {
                        e.preventDefault();
                        // Ctrl+Shift+H — Flip active layer horizontally
                        C.flipLayerHorizontal();
                        renderLayerPanel(); _redraw();
                    }
                    return;
            }
            if (e.shiftKey && e.key.toLowerCase() === "i") { e.preventDefault(); C.selectionInvert(); _redraw(); return; }
            return;
        }

        // Delete/Backspace
        if (e.key === "Delete" || e.key === "Backspace") {
            if (S.transform.active) {
                // Delete the transformed content (don't commit it back)
                e.preventDefault();
                _resetTransformState();
                renderLayerPanel(); renderHistoryPanel(); _redraw(); return;
            }
            if (S.selection.active) { e.preventDefault(); C.saveUndo("Delete"); C.selectionDelete(); _redraw(); return; }
            // No selection, no transform — reset canvas (undoable)
            e.preventDefault();
            C.saveStructuralUndo("Clear canvas");
            S.layers.length = 0;
            const bg = C.makeLayer("Background", "paint");
            bg.ctx.fillStyle = "#ffffff";
            bg.ctx.fillRect(0, 0, S.W, S.H);
            S.layers.push(bg);
            S.activeLayerIdx = 0;
            C.composite();
            renderLayerPanel(); renderHistoryPanel(); _redraw();
            return;
        }

        // Transform commit/cancel/flip
        if (e.key === "Enter" && S.transform.active) { e.preventDefault(); _commitTransform(); _redraw(); return; }
        if (S.transform.active) {
            // H/V flip while transform active (not in perspective)
            if (e.key.toLowerCase() === "h" && !e.ctrlKey) {
                e.preventDefault();
                if (S.transform.perspective) return;
                S.transform.flipH = !S.transform.flipH;
                _redraw(); return;
            }
            if (e.key.toLowerCase() === "v" && !e.ctrlKey) {
                e.preventDefault();
                if (S.transform.perspective) return;
                S.transform.flipV = !S.transform.flipV;
                _redraw(); return;
            }
            // A: toggle aspect ratio lock (not in perspective)
            if (e.key.toLowerCase() === "a" && !e.ctrlKey) {
                e.preventDefault();
                if (S.transform.perspective) return;
                S.transform.aspectLock = !S.transform.aspectLock;
                if (window.showToast) showToast("Aspect lock " + (S.transform.aspectLock ? "ON" : "OFF"), "info");
                return;
            }
            // K: toggle skew mode
            if (e.key.toLowerCase() === "k" && !e.ctrlKey) {
                e.preventDefault();
                if (S.transform.perspective) return; // can't skew while in perspective
                S.transform.skewMode = !S.transform.skewMode;
                const btn = document.getElementById("tfSkewBtn");
                if (btn) btn.classList.toggle("active", S.transform.skewMode);
                if (window.showToast) showToast("Skew " + (S.transform.skewMode ? "ON" : "OFF"), "info");
                _redraw(); return;
            }
            // P: toggle perspective mode
            if (e.key.toLowerCase() === "p" && !e.ctrlKey) {
                e.preventDefault();
                _togglePerspective();
                return;
            }
            // W: toggle warp mode
            if (e.key.toLowerCase() === "w" && !e.ctrlKey) {
                e.preventDefault();
                _toggleWarp();
                return;
            }
        }
        if (e.key === "Escape") {
            if (S._polyPoints) { e.preventDefault(); S._polyPoints = null; _redraw(); return; }
            if (S._magAnchors) { e.preventDefault(); _clearMagLasso(); _redraw(); return; }
            if (S.transform.active) {
                e.preventDefault();
                const L = S.layers[S.transform.layerIdx];
                if (L && S.transform.originalData) L.ctx.putImageData(S.transform.originalData, 0, 0);
                _resetTransformState();
                _redraw(); return;
            }
            if (S.regionMode) { e.preventDefault(); S.regionMode = false; S.activeRegionId = null; renderRegionPanel(); _redraw(); return; }
            if (S.selection.active) { e.preventDefault(); C.selectionClear(); stopMarchingAnts(); _redraw(); return; }
        }

        // Tool shortcuts
        switch (e.key.toLowerCase()) {
            case "b": setTool("brush"); break;
            case "e": setTool("eraser"); break;
            case "i": setTool("eyedropper"); break;
            case "g": setTool(S.tool === "fill" ? "gradient" : "fill"); break;
            case "s": setTool("smudge"); break;
            case "r": setTool("blur"); break;
            case "m": setTool("select"); break;
            case "l": {
                const lassoOrder = ["lasso", "polylasso", "maglasso"];
                const cur = lassoOrder.indexOf(S.tool);
                setTool(e.shiftKey ? lassoOrder[(cur + 1) % 3] : (cur >= 0 ? lassoOrder[(cur + 1) % 3] : "lasso"));
                break;
            }
            case "o": setTool("ellipse"); break;
            case "w": setTool("wand"); break;
            case "v": setTool("transform"); break;
            case "q": toggleMaskMode(); break;
            case "c": setTool("crop"); break;
            case "t": setTool("text"); break;
            case "u": setTool("shape"); break;
            case "d": {
                // Reset fg/bg to black/white (industry standard)
                S.color = "#000000"; S.bgColor = "#ffffff";
                _updateHSVFromColor(S.color); _applyHSV();
                _drawHueWheel(); _drawSVSquare();
                break;
            }
            case "k": setTool("clone"); break;
            case "p": setTool("pixelate"); break;
            case "j": setTool("dodge"); break;
            case "y": setTool("liquify"); break;
            case "x": {
                const tmp = S.color; S.color = S.bgColor; S.bgColor = tmp;
                updateColorUI(); break;
            }
            case "[": S.brushSize = Math.max(1, S.brushSize - 1); _syncCtxBar(); break;
            case "]": S.brushSize = Math.min(100, S.brushSize + 1); _syncCtxBar(); break;
            case "{": S.brushHardness = Math.max(0, (S.brushHardness ?? 1) - 0.1); _syncCtxBar(); break;
            case "}": S.brushHardness = Math.min(1, (S.brushHardness ?? 1) + 0.1); _syncCtxBar(); break;
            case "f": case "0": C.zoomFit(); updateStatus(); _redraw(); break;
        }
    });

    document.addEventListener("keyup", e => {
        if (e.key === " ") {
            _spaceDown = false;
            if (S.canvas && !S.zoom.panning) setTool(S.tool); // restore cursor
        }
    });
}

// ========================================================================
// SCRUB LABELS — Photoshop-style drag-to-adjust / click-to-type
// ========================================================================
const _scrubMap = {
    size:      { get: () => S.brushSize,                    set: v => { S.brushSize = v; } },
    opacity:   { get: () => Math.round(S.brushOpacity*100), set: v => { S.brushOpacity = v/100; } },
    hardness:  { get: () => Math.round(S.brushHardness*100),set: v => { S.brushHardness = v/100; } },
    smoothing: { get: () => S.smoothing ?? 4,               set: v => { S.smoothing = v; } },
    strength:  { get: () => Math.round(S.toolStrength*100), set: v => { S.toolStrength = v/100; } },
    spacing:   { get: () => Math.round((S.liquifySpacing || 0.2)*100), set: v => { S.liquifySpacing = v/100; } },
    blur:      { get: () => parseInt(document.getElementById("paramMaskBlur")?.value)||0,
                 set: v => { const el=document.getElementById("paramMaskBlur"); if(el) el.value=v; } },
    padding:   { get: () => parseInt(document.getElementById("paramPadding")?.value)||0,
                 set: v => { const el=document.getElementById("paramPadding"); if(el) el.value=v; } },
    sampleRadius: { get: () => S.sampleRadius || 1, set: v => { S.sampleRadius = v; } },
    symmetryAxes: { get: () => S.symmetryAxes || 4, set: v => { S.symmetryAxes = v; _redraw(); } },
    ratio:     { get: () => Math.round((S.brushRatio || 1.0) * 100), set: v => { S.brushRatio = v / 100; } },
    density:   { get: () => Math.round((S.brushDensity || 1.0) * 100), set: v => { S.brushDensity = v / 100; } },
    spikes:    { get: () => S.brushSpikes || 2, set: v => { S.brushSpikes = v; } },
};

function _scrubDisplay(el) {
    const key = el.dataset.key;
    const m = _scrubMap[key]; if (!m) return;
    const label = el.dataset.label || (key.charAt(0).toUpperCase() + key.slice(1));
    const suffix = el.dataset.suffix || "";
    el.textContent = label + ": " + m.get() + suffix;
}

function _syncCtxBar() {
    document.querySelectorAll("#contextBar .ctx-scrub, #inpaintBar .ctx-scrub").forEach(_scrubDisplay);
}

function _syncDynamicsPanel() {
    const d = S.brushDynamics;
    const _set = (id, val, fmt) => { const el = document.getElementById(id); if (el) el.value = val; const v = document.getElementById(id + "Val"); if (v) v.textContent = fmt; };
    _set("dynSpacing", Math.round(d.spacing * 100), d.spacing.toFixed(2));
    _set("dynSizeJitter", Math.round(d.sizeJitter * 100), Math.round(d.sizeJitter * 100) + "%");
    _set("dynOpacityJitter", Math.round(d.opacityJitter * 100), Math.round(d.opacityJitter * 100) + "%");
    _set("dynScatter", Math.round(d.scatter * 100), Math.round(d.scatter * 100) + "%");
    _set("dynRotJitter", Math.round(d.rotationJitter * 100), Math.round(d.rotationJitter * 100) + "%");
    const fs = document.getElementById("dynFollowStroke"); if (fs) fs.checked = d.followStroke;
    _set("dynRatio", Math.round((S.brushRatio || 1) * 100), Math.round((S.brushRatio || 1) * 100) + "%");
    _set("dynDensity", Math.round((S.brushDensity || 1) * 100), Math.round((S.brushDensity || 1) * 100) + "%");
    _set("dynSpikes", S.brushSpikes || 2, S.brushSpikes || 2);
    document.querySelectorAll("[data-falloff]").forEach(b => b.classList.toggle("active", b.dataset.falloff === (S.brushFalloff || "default")));
}

function _initScrubLabels() {
    document.querySelectorAll("#contextBar .ctx-scrub, #inpaintBar .ctx-scrub").forEach(el => {
        const key = el.dataset.key;
        const m = _scrubMap[key]; if (!m) return;
        const min = +(el.dataset.min || 0);
        const max = +(el.dataset.max || 100);
        const step = +(el.dataset.step || 1);
        const suffix = el.dataset.suffix || "";
        const label = el.dataset.label || (key.charAt(0).toUpperCase() + key.slice(1));

        let dragStartX = 0, dragStartVal = 0, dragged = false;

        el.addEventListener("pointerdown", e => {
            if (e.target.tagName === "INPUT") return; // don't interfere with text input
            e.preventDefault();
            dragStartX = e.clientX;
            dragStartVal = m.get();
            dragged = false;
            el.classList.add("scrubbing");
            el.setPointerCapture(e.pointerId);
        });

        el.addEventListener("pointermove", e => {
            if (!el.classList.contains("scrubbing")) return;
            const dx = e.clientX - dragStartX;
            if (Math.abs(dx) < 3 && !dragged) return; // dead zone
            dragged = true;
            // Sensitivity: 1px = 1 step for most, 0.5 step for fine controls
            const sensitivity = max <= 20 ? 0.3 : (max <= 100 ? 0.5 : 1);
            let v = dragStartVal + Math.round(dx * sensitivity / step) * step;
            v = Math.max(min, Math.min(max, v));
            m.set(v);
            el.textContent = label + ": " + v + suffix;
        });

        el.addEventListener("pointerup", e => {
            if (!el.classList.contains("scrubbing")) return;
            el.classList.remove("scrubbing");
            el.releasePointerCapture(e.pointerId);

            if (!dragged) {
                // Click — enter text editing mode
                const current = m.get();
                el.textContent = label + ": ";
                const input = document.createElement("input");
                input.type = "text";
                input.value = current;
                input.style.width = (String(current).length + 1) + "ch";
                el.appendChild(input);
                input.focus();
                input.select();

                const commit = () => {
                    let v = parseFloat(input.value);
                    if (isNaN(v)) v = current; // revert on bad input
                    v = Math.max(min, Math.min(max, Math.round(v / step) * step));
                    m.set(v);
                    _scrubDisplay(el);
                };
                input.addEventListener("blur", commit);
                input.addEventListener("keydown", ev => {
                    if (ev.key === "Enter") { commit(); input.blur(); }
                    if (ev.key === "Escape") { _scrubDisplay(el); }
                    ev.stopPropagation(); // don't trigger canvas shortcuts
                });
            }
        });
    });
}

// ========================================================================
// CONTEXT BAR DRAG
// ========================================================================
function _initCtxBarDrag() {
    const wrap = document.getElementById("ctxBarWrap");
    const handle = document.getElementById("ctxDragHandle");
    if (!wrap || !handle) return;

    // Restore saved position
    try {
        const saved = JSON.parse(localStorage.getItem("studioCtxBarPos"));
        if (saved && typeof saved.x === "number" && typeof saved.y === "number") {
            wrap.style.right = "auto";
            wrap.style.top = saved.y + "px";
            wrap.style.left = saved.x + "px";
            // Defer clamp to next frame so layout is settled
            requestAnimationFrame(() => {
                const parentRect = wrap.offsetParent?.getBoundingClientRect() || { width: window.innerWidth, height: window.innerHeight };
                const wrapRect = wrap.getBoundingClientRect();
                let x = saved.x, y = saved.y;
                const maxX = parentRect.width - wrapRect.width;
                const maxY = parentRect.height - wrapRect.height;
                if (x > maxX) { x = Math.max(0, maxX); wrap.style.left = x + "px"; }
                if (y > maxY) { y = Math.max(0, maxY); wrap.style.top = y + "px"; }
            });
        }
    } catch(e) {}

    let dragStartX, dragStartY, barStartX, barStartY;

    handle.addEventListener("pointerdown", e => {
        e.preventDefault();
        e.stopPropagation();
        const rect = wrap.getBoundingClientRect();
        const parent = wrap.offsetParent?.getBoundingClientRect() || { left: 0, top: 0 };
        barStartX = rect.left - parent.left;
        barStartY = rect.top - parent.top;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        wrap.classList.add("dragging");
        handle.setPointerCapture(e.pointerId);

        const onMove = ev => {
            const dx = ev.clientX - dragStartX;
            const dy = ev.clientY - dragStartY;
            const parentRect = wrap.offsetParent?.getBoundingClientRect() || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
            const wrapRect = wrap.getBoundingClientRect();

            let nx = barStartX + dx;
            let ny = barStartY + dy;
            nx = Math.max(0, Math.min(nx, parentRect.width - wrapRect.width));
            ny = Math.max(0, Math.min(ny, parentRect.height - wrapRect.height));

            wrap.style.right = "auto";
            wrap.style.left = nx + "px";
            wrap.style.top = ny + "px";
        };

        const onUp = ev => {
            wrap.classList.remove("dragging");
            handle.releasePointerCapture(ev.pointerId);
            handle.removeEventListener("pointermove", onMove);
            handle.removeEventListener("pointerup", onUp);

            try {
                localStorage.setItem("studioCtxBarPos", JSON.stringify({
                    x: parseFloat(wrap.style.left),
                    y: parseFloat(wrap.style.top)
                }));
            } catch(e) {}
        };

        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
    });

    // Double-click handle resets to default position
    handle.addEventListener("dblclick", e => {
        e.preventDefault();
        wrap.style.right = "";
        wrap.style.left = "";
        wrap.style.top = "";
        try { localStorage.removeItem("studioCtxBarPos"); } catch(e) {}
    });

    // Clamp to viewport on resize (fixes bar hiding behind panel when leaving fullscreen)
    function _clampCtxBar() {
        if (!wrap.style.left || wrap.style.left === "") return; // default position, CSS handles it
        const parentRect = wrap.offsetParent?.getBoundingClientRect() || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
        const wrapRect = wrap.getBoundingClientRect();
        let x = parseFloat(wrap.style.left);
        let y = parseFloat(wrap.style.top);
        const maxX = parentRect.width - wrapRect.width;
        const maxY = parentRect.height - wrapRect.height;
        let clamped = false;
        if (x > maxX) { x = Math.max(0, maxX); clamped = true; }
        if (y > maxY) { y = Math.max(0, maxY); clamped = true; }
        if (clamped) {
            wrap.style.left = x + "px";
            wrap.style.top = y + "px";
            try { localStorage.setItem("studioCtxBarPos", JSON.stringify({ x, y })); } catch(e) {}
        }
    }
    window.addEventListener("resize", _clampCtxBar);
}

// ========================================================================
// TOOLBAR BINDINGS
// ========================================================================
function bindToolbar() {
    // Tool buttons
    document.querySelectorAll("#toolstrip [data-tool]").forEach(btn => {
        btn.addEventListener("click", () => setTool(btn.dataset.tool));
    });

    // Context bar scrub labels
    _initScrubLabels();

    // Context bar drag
    _initCtxBarDrag();

    // Brush presets
    const presetNames = ["round", "flat", "scatter", "marker", "custom"];
    document.querySelectorAll("#brushPresets .brush-preset-btn:not(#dynamicsToggle)").forEach((btn, i) => {
        btn.addEventListener("click", () => {
            S.brushPreset = presetNames[i] || "round";
            document.querySelectorAll("#brushPresets .brush-preset-btn:not(#dynamicsToggle)").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
        });
    });

    // Dynamics panel toggle
    document.getElementById("dynamicsToggle")?.addEventListener("click", () => {
        const dp = document.getElementById("dynamicsPanel");
        if (dp) {
            dp.style.display = dp.style.display === "none" ? "" : "none";
            if (dp.style.display !== "none") _syncDynamicsPanel();
        }
    });

    // Dynamics sliders
    document.getElementById("dynSpacing")?.addEventListener("input", e => {
        S.brushDynamics.spacing = +e.target.value / 100;
        const v = document.getElementById("dynSpacingVal"); if (v) v.textContent = S.brushDynamics.spacing.toFixed(2);
    });
    document.getElementById("dynSizeJitter")?.addEventListener("input", e => {
        S.brushDynamics.sizeJitter = +e.target.value / 100;
        const v = document.getElementById("dynSizeJitterVal"); if (v) v.textContent = Math.round(+e.target.value) + "%";
    });
    document.getElementById("dynOpacityJitter")?.addEventListener("input", e => {
        S.brushDynamics.opacityJitter = +e.target.value / 100;
        const v = document.getElementById("dynOpacityJitterVal"); if (v) v.textContent = Math.round(+e.target.value) + "%";
    });
    document.getElementById("dynScatter")?.addEventListener("input", e => {
        S.brushDynamics.scatter = +e.target.value / 100;
        const v = document.getElementById("dynScatterVal"); if (v) v.textContent = Math.round(+e.target.value) + "%";
    });
    document.getElementById("dynRotJitter")?.addEventListener("input", e => {
        S.brushDynamics.rotationJitter = +e.target.value / 100;
        const v = document.getElementById("dynRotJitterVal"); if (v) v.textContent = Math.round(+e.target.value) + "%";
    });
    document.getElementById("dynFollowStroke")?.addEventListener("change", e => {
        S.brushDynamics.followStroke = e.target.checked;
    });

    // Brush shape sliders (in dynamics panel)
    document.getElementById("dynRatio")?.addEventListener("input", e => {
        S.brushRatio = +e.target.value / 100;
        const v = document.getElementById("dynRatioVal"); if (v) v.textContent = Math.round(+e.target.value) + "%";
    });
    document.getElementById("dynDensity")?.addEventListener("input", e => {
        S.brushDensity = +e.target.value / 100;
        const v = document.getElementById("dynDensityVal"); if (v) v.textContent = Math.round(+e.target.value) + "%";
    });
    document.getElementById("dynSpikes")?.addEventListener("input", e => {
        S.brushSpikes = +e.target.value;
        const v = document.getElementById("dynSpikesVal"); if (v) v.textContent = +e.target.value;
    });

    // Shape mode buttons
    document.querySelectorAll("[data-smode]").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll("[data-smode]").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            S._shapeMode = btn.dataset.smode;
        });
    });
    document.querySelector("[data-sfill]")?.addEventListener("click", e => {
        S._shapeFilled = !S._shapeFilled;
        e.currentTarget.classList.toggle("active", S._shapeFilled);
    });

    // Gradient mode buttons
    document.querySelectorAll("[data-gmode]").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll("[data-gmode]").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            S._gradientMode = btn.dataset.gmode;
        });
    });

    // Dodge/Burn mode buttons
    document.querySelectorAll("[data-dbmode]").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll("[data-dbmode]").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            S._dodgeMode = btn.dataset.dbmode;
        });
    });

    // Liquify sub-mode buttons
    document.querySelectorAll("[data-liqmode]").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll("[data-liqmode]").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            S.liquifyMode = btn.dataset.liqmode;
        });
    });

    // Transform skew mode toggle
    document.getElementById("tfSkewBtn")?.addEventListener("click", () => {
        if (S.transform.perspective) return; // can't skew in perspective mode
        S.transform.skewMode = !S.transform.skewMode;
        document.getElementById("tfSkewBtn")?.classList.toggle("active", S.transform.skewMode);
        if (window.showToast) showToast("Skew " + (S.transform.skewMode ? "ON" : "OFF"), "info");
        _redraw();
    });

    // Perspective mode toggle
    document.getElementById("tfPerspBtn")?.addEventListener("click", () => {
        if (!S.transform.active) return;
        _togglePerspective();
    });

    // Warp mode toggle
    document.getElementById("tfWarpBtn")?.addEventListener("click", () => {
        if (!S.transform.active) return;
        _toggleWarp();
    });

    // Flip / rotate the active layer. These act on the layer pixels
    // immediately — independent of any active transform marquee. The
    // existing inside-transform Flip H/V keys (single H/V) operate on
    // the marquee's preview matrix; these buttons commit pixel-level
    // changes with their own undo step.
    function _layerOp(fn) {
        return () => {
            fn();
            renderLayerPanel();
            _redraw();
        };
    }
    document.getElementById("tfFlipHBtn")?.addEventListener("click", _layerOp(() => C.flipLayerHorizontal()));
    document.getElementById("tfFlipVBtn")?.addEventListener("click", _layerOp(() => C.flipLayerVertical()));
    document.getElementById("tfRot90CWBtn")?.addEventListener("click", _layerOp(() => C.rotateLayer90CW()));
    document.getElementById("tfRot90CCWBtn")?.addEventListener("click", _layerOp(() => C.rotateLayer90CCW()));
    document.getElementById("tfRot180Btn")?.addEventListener("click", _layerOp(() => C.rotateLayer180()));
    document.getElementById("tfRotArbBtn")?.addEventListener("click", () => {
        const ans = prompt("Rotate by how many degrees? (positive = clockwise)", "15");
        if (ans === null) return;
        const deg = parseFloat(ans);
        if (!Number.isFinite(deg)) {
            if (window.showToast) showToast("Invalid angle", "warning");
            return;
        }
        C.rotateLayerArbitrary(deg);
        renderLayerPanel();
        _redraw();
    });

    // Warp density buttons (3/4/5)
    document.querySelectorAll("[data-wdensity]").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll("[data-wdensity]").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            S.transform.warpDensity = parseInt(btn.dataset.wdensity);
            _rebuildWarpGrid();
        });
    });

    // Warp MLS mode buttons (affine/similitude/rigid)
    document.querySelectorAll("[data-wmode]").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll("[data-wmode]").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            S.transform.warpMode = btn.dataset.wmode;
            _redraw();
        });
    });

    // Lasso subtool buttons (free/poly/magnetic)
    document.querySelectorAll("[data-lassotype]").forEach(btn => {
        btn.addEventListener("click", () => {
            setTool(btn.dataset.lassotype);
        });
    });

    // Transform numeric inputs — typed values update transform state
    const _tfApply = () => {
        if (!S.transform.active) return;
        const b = S.transform.bounds;
        const x = parseFloat(document.getElementById("tfX")?.value);
        const y = parseFloat(document.getElementById("tfY")?.value);
        const w = parseFloat(document.getElementById("tfW")?.value);
        const h = parseFloat(document.getElementById("tfH")?.value);
        const r = parseFloat(document.getElementById("tfR")?.value);
        if (!isNaN(x)) b.x = Math.round(x);
        if (!isNaN(y)) b.y = Math.round(y);
        if (!isNaN(w) && w >= 4) b.w = Math.round(w);
        if (!isNaN(h) && h >= 4) b.h = Math.round(h);
        if (!isNaN(r)) S.transform.rotation = r * Math.PI / 180;
        _redraw();
    };
    ["tfX", "tfY", "tfW", "tfH", "tfR"].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener("change", _tfApply);
        el.addEventListener("keydown", e => {
            if (e.key === "Enter") { e.preventDefault(); _tfApply(); el.blur(); }
            if (e.key === "Escape") { e.preventDefault(); el.blur(); }
        });
    });

    // Mode is now always "Create" — pipeline auto-detects from canvas state
    S.studioMode = "Create";
    S.inpaintMode = "Inpaint";

    // Region panel buttons
    document.getElementById("regionAdd")?.addEventListener("click", () => {
        if (S.regions.length >= 8) return;
        C.addRegion("Region " + S._nextRegionId);
        renderRegionPanel(); _redraw();
    });
    document.getElementById("regionClearAll")?.addEventListener("click", () => {
        if (!S.regions.length) return;
        if (!confirm("Remove all regions?")) return;
        S.regions = []; S.activeRegionId = null; S._nextRegionId = 1; S.regionMode = false;
        renderRegionPanel(); _redraw();
    });

    // Panel tabs
    document.querySelectorAll("#panelTabs .panel-tab").forEach(tab => {
        tab.addEventListener("click", () => {
            document.querySelectorAll("#panelTabs .panel-tab").forEach(t => t.classList.remove("active"));
            document.querySelectorAll(".panel-page").forEach(p => p.classList.remove("active"));
            tab.classList.add("active");
            document.getElementById("page-" + tab.dataset.panel)?.classList.add("active");
        });
    });

    // HSV Color Picker (replaces native picker)
    bindColorPicker();

    // Collapse sections
    document.querySelectorAll(".collapse-header").forEach(h => {
        h.addEventListener("click", () => {
            const body = h.nextElementSibling;
            if (body) body.classList.toggle("collapsed");
            h.querySelector(".collapse-arrow")?.classList.toggle("collapsed");
        });
    });

    // Layer actions
    document.getElementById("layerAdd")?.addEventListener("click", () => {
        C.saveStructuralUndo("Add layer");
        const L = C.makeLayer("Layer " + (S.layers.length), "paint");
        S.layers.splice(S.activeLayerIdx + 1, 0, L);
        S.activeLayerIdx++;
        renderLayerPanel(); renderHistoryPanel(); _redraw();
    });
    document.getElementById("layerDel")?.addEventListener("click", () => {
        if (S.layers.length <= 1) return;
        C.saveStructuralUndo("Delete layer");
        S.layers.splice(S.activeLayerIdx, 1);
        if (S.activeLayerIdx >= S.layers.length) S.activeLayerIdx = S.layers.length - 1;
        renderLayerPanel(); renderHistoryPanel(); _redraw();
    });
    document.getElementById("layerDupe")?.addEventListener("click", () => {
        const src = C.activeLayer(); if (!src || !src.canvas) return;
        C.saveStructuralUndo("Duplicate layer");
        const L = C.makeLayer(src.name + " copy", src.type);
        L.ctx.drawImage(src.canvas, 0, 0);
        L.opacity = src.opacity; L.blendMode = src.blendMode;
        S.layers.splice(S.activeLayerIdx + 1, 0, L);
        S.activeLayerIdx++;
        renderLayerPanel(); renderHistoryPanel(); _redraw();
    });
    document.getElementById("layerUp")?.addEventListener("click", () => {
        if (S.activeLayerIdx >= S.layers.length - 1) return;
        C.saveStructuralUndo("Move layer up");
        const tmp = S.layers[S.activeLayerIdx];
        S.layers[S.activeLayerIdx] = S.layers[S.activeLayerIdx + 1];
        S.layers[S.activeLayerIdx + 1] = tmp;
        S.activeLayerIdx++;
        renderLayerPanel(); renderHistoryPanel(); _redraw();
    });
    document.getElementById("layerDown")?.addEventListener("click", () => {
        if (S.activeLayerIdx <= 0) return;
        C.saveStructuralUndo("Move layer down");
        const tmp = S.layers[S.activeLayerIdx];
        S.layers[S.activeLayerIdx] = S.layers[S.activeLayerIdx - 1];
        S.layers[S.activeLayerIdx - 1] = tmp;
        S.activeLayerIdx--;
        renderLayerPanel(); renderHistoryPanel(); _redraw();
    });
    document.getElementById("layerMerge")?.addEventListener("click", () => {
        if (S.activeLayerIdx <= 0) return;
        const top = S.layers[S.activeLayerIdx];
        const bot = S.layers[S.activeLayerIdx - 1];
        if (!top.canvas || !bot.canvas) return;
        C.saveStructuralUndo("Merge down");
        bot.ctx.globalCompositeOperation = top.blendMode || "source-over";
        bot.ctx.globalAlpha = top.opacity;
        bot.ctx.drawImage(top.canvas, 0, 0);
        bot.ctx.globalCompositeOperation = "source-over";
        bot.ctx.globalAlpha = 1;
        S.layers.splice(S.activeLayerIdx, 1);
        S.activeLayerIdx--;
        renderLayerPanel(); renderHistoryPanel(); _redraw();
    });

    // Save / Export button
    document.getElementById("layerSave")?.addEventListener("click", e => {
        showSaveMenu(e.currentTarget);
    });

    // Adjustment layer buttons
    try {
        const adjNames = { brightness: "Brightness/Contrast", hue: "Hue/Saturation", levels: "Levels" };

        ["Brightness", "Hue", "Levels"].forEach(type => {
            const id = "layerAdd" + type.charAt(0).toUpperCase() + type.slice(1);
            const typeKey = type.toLowerCase();
            const el = document.getElementById(id);
            el?.addEventListener("click", () => {
                C.saveStructuralUndo("Add " + (adjNames[typeKey] || typeKey));
                const L = C.makeAdjustLayer(adjNames[typeKey] || typeKey, typeKey);
                const insertIdx = S.activeLayerIdx + 1;
                S.layers.splice(insertIdx, 0, L);
                S.activeLayerIdx = insertIdx;
                renderLayerPanel(); renderHistoryPanel(); _redraw();
            });
        });
    } catch (e) { console.error("[StudioUI] Adjustment button setup error:", e); }

    // Symmetry toggle
    try {
        const symBtns = document.querySelectorAll("[data-sym]");
        symBtns.forEach(btn => {
            btn.addEventListener("click", () => {
                const mode = btn.dataset.sym;
                if (window.StudioCore) window.StudioCore.state.symmetry = mode;
                document.querySelectorAll("[data-sym]").forEach(b => b.classList.toggle("active", b.dataset.sym === mode));
                // Show/hide axes scrub for radial mode
                const axesScrub = document.getElementById("symAxesScrub");
                if (axesScrub) axesScrub.style.display = mode === "radial" ? "" : "none";
                _redraw();
            });
        });
    } catch (e) { console.error("[StudioUI] Symmetry setup error:", e); }

    // Eyedropper merged toggle
    document.getElementById("sampleMergedBtn")?.addEventListener("click", () => {
        S.sampleMerged = !S.sampleMerged;
        document.getElementById("sampleMergedBtn")?.classList.toggle("active", S.sampleMerged);
    });

    // Crop ratio presets
    document.querySelectorAll("[data-cropratio]").forEach(btn => {
        btn.addEventListener("click", () => {
            const val = btn.dataset.cropratio;
            if (val === "0") {
                // Free crop
                document.querySelectorAll("[data-cropratio]").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                S._cropRatio = 0;
                S._cropPortrait = false;
                return;
            }
            // Parse W:H ratio
            const parts = val.split(":").map(Number);
            if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) return;
            const ratio = parts[0] / parts[1];
            const isSquare = Math.abs(ratio - 1) < 0.01;

            // Re-clicking active ratio swaps orientation (like AR selector)
            if (btn.classList.contains("active") && !isSquare) {
                S._cropPortrait = !S._cropPortrait;
                S._cropRatio = S._cropPortrait ? (1 / ratio) : ratio;
                // Swap label to show current orientation
                const sep = S._cropPortrait ? ":" : ":";
                btn.textContent = S._cropPortrait ? parts[1] + sep + parts[0] : parts[0] + sep + parts[1];
                return;
            }

            // Fresh selection
            document.querySelectorAll("[data-cropratio]").forEach(b => {
                b.classList.remove("active");
                // Reset all labels to canonical
                const bv = b.dataset.cropratio;
                if (bv !== "0" && bv.includes(":")) b.textContent = bv;
            });
            btn.classList.add("active");
            S._cropPortrait = false;
            S._cropRatio = ratio;
        });
    });

    // Brush falloff mode buttons
    document.querySelectorAll("[data-falloff]").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll("[data-falloff]").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            S.brushFalloff = btn.dataset.falloff;
        });
    });

    // History undo/redo buttons
    document.getElementById("historyUndo")?.addEventListener("click", () => {
        C.undo(); renderLayerPanel(); renderHistoryPanel(); _redraw();
    });
    document.getElementById("historyRedo")?.addEventListener("click", () => {
        C.redo(); renderLayerPanel(); renderHistoryPanel(); _redraw();
    });

    // App tabs
    document.querySelectorAll("#appTabs button").forEach(tab => {
        tab.addEventListener("click", () => {
            document.querySelectorAll("#appTabs button").forEach(t => t.classList.remove("active"));
            document.querySelectorAll(".app-page").forEach(p => p.classList.remove("active"));
            tab.classList.add("active");
            document.getElementById("app-" + tab.dataset.app)?.classList.add("active");
        });
    });
}

// ========================================================================
// BOOT
// ========================================================================
function bootUI() {
    const el = document.getElementById("studio-canvas");
    if (!el) {
        console.error("[StudioUI] Canvas element not found");
        return;
    }

    // Hide canvas until layout settles to prevent flash of unsized canvas
    el.style.visibility = "hidden";

    // Boot core
    C.boot(el);

    // Wire everything
    bindCanvas();
    bindToolbar();
    bindKeys();

    // Mask mode toggle button
    document.getElementById("maskModeBtn")?.addEventListener("click", toggleMaskMode);

    // Initialize mask mode state
    S._userMaskMode = false;

    // Initial sync
    setTool(S.tool || "brush");
    syncCanvasToViewport();
    C.zoomFit();
    updateStatus();
    renderLayerPanel();
    renderHistoryPanel();
    updateRegionVisibility();
    renderRegionPanel();
    updateColorUI();
    _updateHSVFromColor(S.color);
    _drawHueWheel();
    _drawSVSquare();
    S.pressureSensitivity = false; // off until _applyDefaults + _syncPressureState
    S.pressureAffects = "none";
    S.showGrid = false;            // off until _applyDefaults loads saved state (prevents flash)
    // Hide the CSS grid div — grid is now drawn on canvas
    const cssGrid = document.querySelector(".canvas-grid");
    if (cssGrid) cssGrid.style.display = "none";
    _redraw();

    // Wait for viewport dimensions to stabilize before revealing canvas.
    // contain:strict can cause getBoundingClientRect to return intermediate
    // sizes during layout — wait until two consecutive frames agree.
    (function waitForLayout(lastW, lastH, n) {
        requestAnimationFrame(() => {
            const vp = document.getElementById("studio-viewport");
            const rect = vp ? vp.getBoundingClientRect() : null;
            const w = rect ? Math.round(rect.width) : 0;
            const h = rect ? Math.round(rect.height) : 0;
            if (n < 15 && (w < 10 || h < 10 || w !== lastW || h !== lastH)) {
                waitForLayout(w, h, n + 1);
                return;
            }
            syncCanvasToViewport();
            C.zoomFit();
            updateStatus();
            _redraw();
            S.canvas.style.visibility = "";
        });
    })(0, 0, 0);

    // Boot-phase ResizeObserver: catches layout shifts after reveal
    // (disconnects after first resize to avoid composite glitches on pointer events)
    const _bootVP = document.getElementById("studio-viewport");
    if (_bootVP && typeof ResizeObserver !== "undefined") {
        const _bootRO = new ResizeObserver(() => {
            syncCanvasToViewport();
            C.zoomFit();
            updateStatus();
            _redraw();
            _bootRO.disconnect();
        });
        _bootRO.observe(_bootVP);
        // Safety: disconnect after 2s regardless
        setTimeout(() => _bootRO.disconnect(), 2000);
    }

    // Manual resize on window resize only — no persistent ResizeObserver
    // (ResizeObserver was causing composite glitches on pointer events)
    window.addEventListener("resize", () => {
        // Preserve user's zoom/pan across resize: scale ox/oy by canvas dimension ratio
        const oldCW = S.canvas ? S.canvas.width : 0;
        const oldCH = S.canvas ? S.canvas.height : 0;
        syncCanvasToViewport();
        if (S.canvas && oldCW > 0 && oldCH > 0) {
            const rx = S.canvas.width / oldCW;
            const ry = S.canvas.height / oldCH;
            S.zoom.ox *= rx;
            S.zoom.oy *= ry;
        }
        updateStatus(); _redraw();
    });

    console.log("[StudioUI] Boot complete");
}

// Auto-boot
if (document.getElementById("studio-canvas")) {
    bootUI();
} else {
    let _attempts = 0;
    const _poll = setInterval(() => {
        if (document.getElementById("studio-canvas") || _attempts++ > 50) {
            clearInterval(_poll);
            bootUI();
        }
    }, 400);
}

// Expose for app.js integration
window.StudioUI = {
    redraw: _redraw,
    setTool,
    renderLayerPanel,
    renderHistoryPanel,
    renderRegionPanel,
    updateRegionVisibility,
    updateStatus,
    syncCanvasToViewport,
    syncCtxBar: _syncCtxBar,
    startMarchingAnts,
    stopMarchingAnts,
    updateColorUI,
    saveFlattened,
    savePSD,
    showSaveMenu
};

console.log("[StudioUI] Module loaded — Phase 2 DOM integration");

})();
