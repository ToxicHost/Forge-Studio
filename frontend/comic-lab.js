/**
 * Forge Studio — Comic Lab 2.0
 * by ToxicHost & Moritz
 *
 * Canvas engine, panel system, multi-page support, bubble system,
 * generation controls, API integration, PDF/PNG export, save/load projects.
 * Registers as a Studio module. Self-contained state, no Gradio dependencies.
 */
(function () {
"use strict";

// ========================================================================
// STATE
// ========================================================================

const CL = {
    ready: false,
    // DOM
    root: null,         // module container
    viewport: null,     // canvas wrapper div
    canvas: null,
    ctx: null,
    sidebar: null,      // right sidebar div

    // Page
    pageW: 800, pageH: 1200, bgColor: "#ffffff",

    // Data
    panels: [],
    bubbles: [],        // Phase 3
    selected: -1,
    selectedBubble: -1, // Phase 3
    multiSelected: new Set(),

    // Interaction
    snapThreshold: 8,
    drag: null,
    _idCounter: 0,
    _images: {},
    _inlineEdit: null,
    _hoverIdx: -1,
    _hoverPos: null,

    // Undo
    _undoStack: [],
    _maxUndo: 30,

    // Generation
    generating: false,
    genQueue: [],       // panel indices queued for generation
    genCurrent: -1,     // index of panel currently generating
    samplers: [],
    schedulers: [],

    // Reading order overlay
    showReadingOrder: false,

    // Multi-page
    pages: [],
    currentPage: 0,

    // Services (set on init)
    services: null,
};

function uid() { return "cl_" + (++CL._idCounter) + "_" + Date.now().toString(36); }

function _roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

// Hardcoded panel gap — no UI control needed
const GUTTER = 10;

// Theme color cache — canvas drawing can't read CSS vars, so we resolve once
const _theme = {
    accent: "#888",
    accentDim: "rgba(136,136,136,.13)",
    amber: "#FF9100",
    pink: "#e91e63",
    border: "#2a2a30",
    text4: "#45454d",
    bgRaised: "#1c1c20",
};

function _readThemeColors() {
    const s = getComputedStyle(document.documentElement);
    const g = (v) => s.getPropertyValue(v).trim();
    _theme.accent = g("--accent") || _theme.accent;
    _theme.accentDim = g("--accent-dim") || _theme.accentDim;
    _theme.amber = g("--amber") || _theme.amber;
    _theme.pink = g("--pink") || _theme.pink;
    _theme.border = g("--border") || _theme.border;
    _theme.text4 = g("--text-4") || _theme.text4;
    _theme.bgRaised = g("--bg-raised") || _theme.bgRaised;
}

// ========================================================================
// BUBBLE SYSTEM — Constants & Data Model
// ========================================================================

const BUBBLE_DEFAULTS = {
    bold: false, italic: false, allCaps: true,
    textColor: "#000000", textAlign: "center",
    fillColor: "#ffffff", borderColor: "#000000",
    borderWidth: 2, opacity: 1.0, dropShadow: false,
    tail_curve: 0, font: "", fontSize: 14,
    textStroke: 0, textStrokeColor: "#000000",
};

const TAILED_STYLES = new Set(["speech", "thought", "whisper", "radio"]);
const TAILLESS_STYLES = new Set(["narration", "caption", "shout", "sfx"]);
const HANDLE_SIZE = 8;
const MIN_BUBBLE_W = 40, MIN_BUBBLE_H = 30;

function _makeBubble(overrides = {}) {
    const style = overrides.style || "speech";
    const hasTail = TAILED_STYLES.has(style);
    const bx = overrides.x ?? CL.pageW / 2 - 75;
    const by = overrides.y ?? CL.pageH / 4;
    return {
        id: uid(), x: bx, y: by, w: 150, h: 80,
        text: "Hello!", style,
        tail_x: hasTail ? bx + 50 : null,
        tail_y: hasTail ? by + 100 : null,
        ...BUBBLE_DEFAULTS,
        ...overrides,
    };
}

// ========================================================================
// BUBBLE SHAPE RENDERERS
// ========================================================================

function _ellipseClosestPoint(cx, cy, rx, ry, px, py) {
    const dx = px - cx, dy = py - cy;
    const angle = Math.atan2(dy / ry, dx / rx);
    return { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) };
}

function _roundRectClosestPoint(x, y, w, h, r, px, py) {
    const cx = x + w / 2, cy = y + h / 2;
    const angle = Math.atan2(py - cy, px - cx);
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const hw = w / 2, hh = h / 2;
    let t = Infinity;
    if (Math.abs(cos) > 1e-6) { const tx = (cos > 0 ? hw : -hw) / cos; if (tx > 0) t = Math.min(t, tx); }
    if (Math.abs(sin) > 1e-6) { const ty = (sin > 0 ? hh : -hh) / sin; if (ty > 0) t = Math.min(t, ty); }
    return { x: cx + cos * t * 0.95, y: cy + sin * t * 0.95 };
}

function _bubbleAttachPoint(b, targetX, targetY) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    if (b.style === "thought" || b.style === "speech") {
        return _ellipseClosestPoint(cx, cy, b.w / 2, b.h / 2, targetX, targetY);
    }
    return _roundRectClosestPoint(b.x, b.y, b.w, b.h, 12, targetX, targetY);
}

function _drawBubbleShape(ctx, b) {
    switch (b.style) {
        case "thought":   _drawThoughtBubble(ctx, b); break;
        case "shout":     _drawShoutBubble(ctx, b); break;
        case "whisper":   _drawWhisperBubble(ctx, b); break;
        case "narration": _drawNarrationBox(ctx, b); break;
        case "caption":   _drawCaptionBox(ctx, b); break;
        case "radio":     _drawRadioBubble(ctx, b); break;
        case "sfx":       break; // SFX: no shape, text only
        default:          _drawSpeechBubble(ctx, b); break;
    }
}

function _drawSpeechBubble(ctx, b) {
    const { x, y, w, h } = b;
    const r = Math.min(20, w / 4, h / 4);
    if (TAILED_STYLES.has(b.style) && b.tail_x != null && b.tail_y != null && b.style !== "thought" && b.style !== "radio") {
        _drawRoundRectWithTail(ctx, x, y, w, h, r, b.tail_x, b.tail_y, b.tail_curve || 0);
    } else {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, r);
        ctx.fill(); ctx.stroke();
    }
}

function _drawRoundRectWithTail(ctx, bx, by, bw, bh, r, tx, ty, tailCurve) {
    const cx = bx + bw / 2, cy = by + bh / 2;
    const spread = 12;
    const dx = tx - cx, dy = ty - cy;
    const normX = Math.abs(dx) / (bw / 2), normY = Math.abs(dy) / (bh / 2);
    let edge;
    if (normY >= normX) edge = dy > 0 ? "bottom" : "top";
    else edge = dx > 0 ? "right" : "left";

    let baseX, baseY, ax1x, ax1y, ax2x, ax2y;
    if (edge === "bottom") {
        baseX = Math.max(bx + r + spread, Math.min(bx + bw - r - spread, tx));
        baseY = by + bh;
        ax1x = baseX + spread; ax1y = baseY; ax2x = baseX - spread; ax2y = baseY;
    } else if (edge === "top") {
        baseX = Math.max(bx + r + spread, Math.min(bx + bw - r - spread, tx));
        baseY = by;
        ax1x = baseX - spread; ax1y = baseY; ax2x = baseX + spread; ax2y = baseY;
    } else if (edge === "right") {
        baseX = bx + bw;
        baseY = Math.max(by + r + spread, Math.min(by + bh - r - spread, ty));
        ax1x = baseX; ax1y = baseY - spread; ax2x = baseX; ax2y = baseY + spread;
    } else {
        baseX = bx;
        baseY = Math.max(by + r + spread, Math.min(by + bh - r - spread, ty));
        ax1x = baseX; ax1y = baseY + spread; ax2x = baseX; ax2y = baseY - spread;
    }

    const _tail = (c) => {
        if (tailCurve) {
            const perpOfs = tailCurve * 2;
            const m1x = (ax1x + tx) / 2, m1y = (ax1y + ty) / 2;
            const m2x = (tx + ax2x) / 2, m2y = (ty + ax2y) / 2;
            if (edge === "bottom") { c.quadraticCurveTo(m1x + perpOfs, m1y, tx, ty); c.quadraticCurveTo(m2x + perpOfs, m2y, ax2x, ax2y); }
            else if (edge === "top") { c.quadraticCurveTo(m1x - perpOfs, m1y, tx, ty); c.quadraticCurveTo(m2x - perpOfs, m2y, ax2x, ax2y); }
            else if (edge === "right") { c.quadraticCurveTo(m1x, m1y + perpOfs, tx, ty); c.quadraticCurveTo(m2x, m2y + perpOfs, ax2x, ax2y); }
            else { c.quadraticCurveTo(m1x, m1y - perpOfs, tx, ty); c.quadraticCurveTo(m2x, m2y - perpOfs, ax2x, ax2y); }
        } else {
            c.lineTo(tx, ty); c.lineTo(ax2x, ax2y);
        }
    };

    ctx.beginPath();
    if (edge === "bottom") {
        ctx.moveTo(bx + r, by);
        ctx.lineTo(bx + bw - r, by); ctx.arcTo(bx + bw, by, bx + bw, by + r, r);
        ctx.lineTo(bx + bw, by + bh - r); ctx.arcTo(bx + bw, by + bh, bx + bw - r, by + bh, r);
        ctx.lineTo(ax1x, ax1y); _tail(ctx); ctx.lineTo(bx + r, by + bh);
        ctx.arcTo(bx, by + bh, bx, by + bh - r, r); ctx.lineTo(bx, by + r);
        ctx.arcTo(bx, by, bx + r, by, r);
    } else if (edge === "top") {
        ctx.moveTo(bx + r, by);
        ctx.lineTo(ax1x, ax1y); _tail(ctx); ctx.lineTo(bx + bw - r, by);
        ctx.arcTo(bx + bw, by, bx + bw, by + r, r); ctx.lineTo(bx + bw, by + bh - r);
        ctx.arcTo(bx + bw, by + bh, bx + bw - r, by + bh, r); ctx.lineTo(bx + r, by + bh);
        ctx.arcTo(bx, by + bh, bx, by + bh - r, r); ctx.lineTo(bx, by + r);
        ctx.arcTo(bx, by, bx + r, by, r);
    } else if (edge === "right") {
        ctx.moveTo(bx + r, by);
        ctx.lineTo(bx + bw - r, by); ctx.arcTo(bx + bw, by, bx + bw, by + r, r);
        ctx.lineTo(ax1x, ax1y); _tail(ctx); ctx.lineTo(bx + bw, by + bh - r);
        ctx.arcTo(bx + bw, by + bh, bx + bw - r, by + bh, r); ctx.lineTo(bx + r, by + bh);
        ctx.arcTo(bx, by + bh, bx, by + bh - r, r); ctx.lineTo(bx, by + r);
        ctx.arcTo(bx, by, bx + r, by, r);
    } else {
        ctx.moveTo(bx + r, by);
        ctx.lineTo(bx + bw - r, by); ctx.arcTo(bx + bw, by, bx + bw, by + r, r);
        ctx.lineTo(bx + bw, by + bh - r); ctx.arcTo(bx + bw, by + bh, bx + bw - r, by + bh, r);
        ctx.lineTo(bx + r, by + bh); ctx.arcTo(bx, by + bh, bx, by + bh - r, r);
        ctx.lineTo(ax1x, ax1y); _tail(ctx); ctx.lineTo(bx, by + r);
        ctx.arcTo(bx, by, bx + r, by, r);
    }
    ctx.closePath(); ctx.fill(); ctx.stroke();
}

function _drawThoughtBubble(ctx, b) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
}

function _drawShoutBubble(ctx, b) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const rx = b.w / 2, ry = b.h / 2;
    const spikes = Math.max(8, Math.round((b.w + b.h) / 40));
    ctx.beginPath();
    for (let i = 0; i < spikes * 2; i++) {
        const angle = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
        const isOuter = i % 2 === 0;
        const r = isOuter ? 1.15 : 0.78;
        const jitter = isOuter ? (0.95 + Math.sin(i * 2.3) * 0.12) : 1;
        const px = cx + rx * r * jitter * Math.cos(angle);
        const py = cy + ry * r * jitter * Math.sin(angle);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath(); ctx.fill(); ctx.stroke();
}

function _drawWhisperBubble(ctx, b) {
    const { x, y, w, h } = b;
    const r = Math.min(20, w / 4, h / 4);
    ctx.setLineDash([6, 4]);
    if (TAILED_STYLES.has(b.style) && b.tail_x != null && b.tail_y != null) {
        _drawRoundRectWithTail(ctx, x, y, w, h, r, b.tail_x, b.tail_y, b.tail_curve || 0);
    } else {
        ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); ctx.stroke();
    }
    ctx.setLineDash([]);
}

function _drawNarrationBox(ctx, b) {
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
}

function _drawCaptionBox(ctx, b) {
    ctx.fillRect(b.x, b.y, b.w, b.h);
    if (b.borderWidth > 0) ctx.strokeRect(b.x, b.y, b.w, b.h);
}

function _drawRadioBubble(ctx, b) {
    const { x, y, w, h } = b;
    const jag = 6, step = 12;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let sx = x; sx < x + w; sx += step) { ctx.lineTo(sx + step / 2, y - jag); ctx.lineTo(Math.min(sx + step, x + w), y); }
    for (let sy = y; sy < y + h; sy += step) { ctx.lineTo(x + w + jag, sy + step / 2); ctx.lineTo(x + w, Math.min(sy + step, y + h)); }
    for (let sx = x + w; sx > x; sx -= step) { ctx.lineTo(sx - step / 2, y + h + jag); ctx.lineTo(Math.max(sx - step, x), y + h); }
    for (let sy = y + h; sy > y; sy -= step) { ctx.lineTo(x - jag, sy - step / 2); ctx.lineTo(x, Math.max(sy - step, y)); }
    ctx.closePath(); ctx.fill(); ctx.stroke();
}

// Tail renderers (for styles not unified with shape path)
function _drawPointedTail(ctx, b) {
    if (TAILLESS_STYLES.has(b.style) || b.style === "speech" || b.style === "whisper") return;
    const tx = b.tail_x, ty = b.tail_y;
    if (tx == null || ty == null) return;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const angle = Math.atan2(ty - cy, tx - cx);
    const ep = _ellipseClosestPoint(cx, cy, b.w / 2, b.h / 2, tx, ty);
    const spread = b.style === "shout" ? 14 : 10;
    const perpAngle = angle + Math.PI / 2;
    const ax1 = ep.x + Math.cos(perpAngle) * spread, ay1 = ep.y + Math.sin(perpAngle) * spread;
    const ax2 = ep.x - Math.cos(perpAngle) * spread, ay2 = ep.y - Math.sin(perpAngle) * spread;
    ctx.beginPath(); ctx.moveTo(ax1, ay1);
    if (b.tail_curve) {
        const cpOfs = b.tail_curve * 2;
        const midX = (ep.x + tx) / 2 + Math.cos(perpAngle) * cpOfs;
        const midY = (ep.y + ty) / 2 + Math.sin(perpAngle) * cpOfs;
        ctx.quadraticCurveTo(midX, midY, tx, ty);
        ctx.quadraticCurveTo(midX, midY, ax2, ay2);
    } else { ctx.lineTo(tx, ty); ctx.lineTo(ax2, ay2); }
    ctx.closePath(); ctx.fill(); ctx.stroke();
}

function _drawCloudTrail(ctx, b) {
    const tx = b.tail_x, ty = b.tail_y;
    if (tx == null || ty == null) return;
    const attach = _bubbleAttachPoint(b, tx, ty);
    const maxR = Math.max(6, Math.min(b.w, b.h) * 0.1);
    for (let i = 0; i < 3; i++) {
        const t = (i + 1) / 4;
        const cx = attach.x + (tx - attach.x) * t;
        const cy = attach.y + (ty - attach.y) * t;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(3, maxR * (1 - t * 0.5)), 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
    }
}

function _drawLightningTail(ctx, b) {
    const tx = b.tail_x, ty = b.tail_y;
    if (tx == null || ty == null) return;
    const attach = _bubbleAttachPoint(b, tx, ty);
    const dx = tx - attach.x, dy = ty - attach.y;
    const len = Math.hypot(dx, dy);
    if (len < 5) return;
    const perpX = -dy / len, perpY = dx / len;
    const zigW = Math.min(10, len * 0.15);
    ctx.beginPath(); ctx.moveTo(attach.x, attach.y);
    for (let i = 1; i < 4; i++) {
        const t = i / 4;
        const side = (i % 2 === 0) ? 1 : -1;
        ctx.lineTo(attach.x + dx * t + perpX * zigW * side, attach.y + dy * t + perpY * zigW * side);
    }
    ctx.lineTo(tx, ty);
    ctx.lineWidth = Math.max(2, (b.borderWidth || 2) + 1);
    ctx.stroke();
}

// Main bubble renderer
function _renderBubble(ctx, b, idx) {
    ctx.save();
    const sel = idx === CL.selectedBubble;
    const fillColor = b.fillColor || "#ffffff";
    const strokeColor = sel ? _theme.pink : (b.borderColor || "#000000");
    const lineW = sel ? 3 : (b.borderWidth ?? 2);

    // Drop shadow (not for SFX)
    if (b.dropShadow && b.style !== "sfx") {
        ctx.save(); ctx.globalAlpha = 0.3; ctx.fillStyle = "#000000"; ctx.strokeStyle = "transparent";
        ctx.translate(3, 3); _drawBubbleShape(ctx, b); ctx.restore();
    }

    ctx.globalAlpha = b.opacity ?? 1.0;
    if (b.style !== "sfx") {
        ctx.fillStyle = fillColor; ctx.strokeStyle = strokeColor; ctx.lineWidth = lineW;
        _drawBubbleShape(ctx, b);
    }

    // Tails for styles not unified with shape
    if (TAILED_STYLES.has(b.style)) {
        ctx.fillStyle = fillColor; ctx.strokeStyle = strokeColor; ctx.lineWidth = lineW;
        if (b.style === "thought") _drawCloudTrail(ctx, b);
        else if (b.style === "radio") _drawLightningTail(ctx, b);
        else if (b.style === "shout") _drawPointedTail(ctx, b);
        // speech/whisper: tail drawn by _drawRoundRectWithTail

        // Tail endpoint handle when selected
        if (sel && b.tail_x != null && b.tail_y != null) {
            ctx.fillStyle = _theme.pink; ctx.beginPath();
            ctx.arc(b.tail_x, b.tail_y, 6, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.stroke();
        }
    }

    // Text
    const fontName = b.font || "sans-serif";
    const fontSize = b.fontSize || 14;
    _renderBubbleText(ctx, b, fontName, fontSize);

    // Resize handles when selected
    if (sel) _drawBubbleResizeHandles(ctx, b);
    ctx.restore();
}

// ========================================================================
// BUBBLE TEXT ENGINE
// ========================================================================

function _buildFontString(fontSize, fontName, bold, italic) {
    let s = "";
    if (italic) s += "italic ";
    if (bold) s += "bold ";
    s += fontSize + "px '" + fontName + "', sans-serif";
    return s;
}

function _ovalWidthFraction(yFraction) {
    const angle = yFraction * Math.PI;
    return 0.55 + 0.45 * Math.sin(angle);
}

function _wrapOval(ctx, text, maxWidth, lineHeight, maxLines) {
    const paragraphs = text.split("\n");
    const allLines = [];
    for (const para of paragraphs) {
        const words = para.split(/\s+/).filter(w => w);
        if (!words.length) { allLines.push(""); continue; }
        let line = "";
        for (const word of words) {
            const test = line ? line + " " + word : word;
            if (ctx.measureText(test).width > maxWidth && line) { allLines.push(line); line = word; }
            else line = test;
            while (ctx.measureText(line).width > maxWidth && line.length > 1) {
                let fit = line.length - 1;
                while (fit > 1 && ctx.measureText(line.slice(0, fit)).width > maxWidth) fit--;
                allLines.push(line.slice(0, fit)); line = line.slice(fit);
            }
        }
        if (line) allLines.push(line);
    }
    if (allLines.length <= 2) return allLines;

    // Re-wrap with oval shaping
    const ovalLines = [];
    const inputWords = text.replace(/\n/g, " \n ").split(/\s+/).filter(w => w);
    const estLines = allLines.length;
    let line = "", lineIdx = 0;
    for (const word of inputWords) {
        if (word === "\n") {
            if (line) ovalLines.push(line); else ovalLines.push("");
            line = ""; lineIdx++; continue;
        }
        const yFrac = estLines > 1 ? lineIdx / (estLines - 1) : 0.5;
        const availWidth = maxWidth * _ovalWidthFraction(yFrac);
        const test = line ? line + " " + word : word;
        if (ctx.measureText(test).width > availWidth && line) {
            ovalLines.push(line); line = word; lineIdx++;
        } else line = test;
        while (ctx.measureText(line).width > availWidth && line.length > 1) {
            let fit = line.length - 1;
            const yw = maxWidth * _ovalWidthFraction(estLines > 1 ? lineIdx / (estLines - 1) : 0.5);
            while (fit > 1 && ctx.measureText(line.slice(0, fit)).width > yw) fit--;
            ovalLines.push(line.slice(0, fit)); line = line.slice(fit); lineIdx++;
        }
    }
    if (line) ovalLines.push(line);
    return ovalLines;
}

function _renderBubbleText(ctx, b, fontName, fontSize) {
    if (!b.text) return;
    let text = b.text;
    if (b.allCaps !== false) text = text.toUpperCase();
    const bold = !!b.bold || b.style === "shout";
    const italic = !!b.italic;
    const padding = Math.max(10, fontSize * 0.7);
    const textAreaW = b.w - padding * 2;
    const textAreaH = b.h - padding * 2;
    if (textAreaW <= 0 || textAreaH <= 0) return;

    ctx.save();
    ctx.beginPath(); ctx.rect(b.x, b.y, b.w, b.h); ctx.clip();

    let actualFontSize = fontSize;
    let fontStr = _buildFontString(actualFontSize, fontName, bold, italic);
    ctx.font = fontStr;
    let lines = _wrapOval(ctx, text, textAreaW, actualFontSize * 1.25, 999);
    let lineHeight = actualFontSize * 1.25;
    let totalTextH = lines.length * lineHeight;

    while (totalTextH > textAreaH && actualFontSize > 8) {
        actualFontSize -= 1;
        fontStr = _buildFontString(actualFontSize, fontName, bold, italic);
        ctx.font = fontStr;
        lineHeight = actualFontSize * 1.25;
        lines = _wrapOval(ctx, text, textAreaW, lineHeight, 999);
        totalTextH = lines.length * lineHeight;
    }

    ctx.font = fontStr;
    ctx.fillStyle = b.textColor || "#000000";
    ctx.textAlign = b.textAlign || "center";
    ctx.textBaseline = "middle";

    let alignX;
    const align = b.textAlign || "center";
    if (align === "left") alignX = b.x + padding;
    else if (align === "right") alignX = b.x + b.w - padding;
    else alignX = b.x + b.w / 2;

    const startY = b.y + (b.h - totalTextH) / 2 + lineHeight / 2;
    // Text stroke (SFX outline effect, also available on all bubbles)
    if (b.textStroke > 0) {
        ctx.strokeStyle = b.textStrokeColor || "#000000";
        ctx.lineWidth = b.textStroke;
        ctx.lineJoin = "round";
        lines.forEach((line, i) => { ctx.strokeText(line, alignX, startY + i * lineHeight); });
    }
    lines.forEach((line, i) => { ctx.fillText(line, alignX, startY + i * lineHeight); });
    ctx.restore();
}

// ========================================================================
// BUBBLE RESIZE HANDLES & HIT TESTING
// ========================================================================

function _drawBubbleResizeHandles(ctx, b) {
    const hs = HANDLE_SIZE;
    ctx.fillStyle = _theme.pink; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1;
    for (const h of _getBubbleHandleRects(b)) {
        ctx.fillRect(h.x - hs / 2, h.y - hs / 2, hs, hs);
        ctx.strokeRect(h.x - hs / 2, h.y - hs / 2, hs, hs);
    }
}

function _getBubbleHandleRects(b) {
    const mx = b.x + b.w / 2, my = b.y + b.h / 2;
    return [
        { x: b.x,       y: b.y,       type: "bresize-tl" },
        { x: b.x + b.w, y: b.y,       type: "bresize-tr" },
        { x: b.x,       y: b.y + b.h, type: "bresize-bl" },
        { x: b.x + b.w, y: b.y + b.h, type: "bresize-br" },
        { x: mx,        y: b.y,       type: "bresize-t" },
        { x: mx,        y: b.y + b.h, type: "bresize-b" },
        { x: b.x,       y: my,        type: "bresize-l" },
        { x: b.x + b.w, y: my,        type: "bresize-r" },
    ];
}

function _hitBubbleHandle(mx, my, b) {
    const hs = HANDLE_SIZE;
    for (const h of _getBubbleHandleRects(b)) {
        if (Math.abs(mx - h.x) <= hs && Math.abs(my - h.y) <= hs) return h.type;
    }
    return null;
}

function _bubbleHandleCursor(type) {
    switch (type) {
        case "bresize-tl": case "bresize-br": return "nwse-resize";
        case "bresize-tr": case "bresize-bl": return "nesw-resize";
        case "bresize-t": case "bresize-b": return "ns-resize";
        case "bresize-l": case "bresize-r": return "ew-resize";
        default: return "default";
    }
}

function _applyBubbleResize(b, handleType, dx, dy) {
    switch (handleType) {
        case "bresize-tl": b.x += dx; b.y += dy; b.w -= dx; b.h -= dy; break;
        case "bresize-tr": b.y += dy; b.w += dx; b.h -= dy; break;
        case "bresize-bl": b.x += dx; b.w -= dx; b.h += dy; break;
        case "bresize-br": b.w += dx; b.h += dy; break;
        case "bresize-t": b.y += dy; b.h -= dy; break;
        case "bresize-b": b.h += dy; break;
        case "bresize-l": b.x += dx; b.w -= dx; break;
        case "bresize-r": b.w += dx; break;
    }
    if (b.w < MIN_BUBBLE_W) b.w = MIN_BUBBLE_W;
    if (b.h < MIN_BUBBLE_H) b.h = MIN_BUBBLE_H;
}

function _hitB(mx, my) {
    for (let i = CL.bubbles.length - 1; i >= 0; i--) {
        const b = CL.bubbles[i];
        if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) return i;
    }
    return -1;
}

function _hitT(mx, my) {
    for (let i = CL.bubbles.length - 1; i >= 0; i--) {
        const b = CL.bubbles[i];
        if (!TAILED_STYLES.has(b.style)) continue;
        if (b.tail_x == null || b.tail_y == null) continue;
        if (Math.hypot(mx - b.tail_x, my - b.tail_y) < 12) return i;
    }
    return -1;
}

// ========================================================================
// BUBBLE CRUD
// ========================================================================

function addBubble(style) {
    _saveUndo("Add bubble");
    CL.selectedBubble = -1; // deselect so sidebar doesn't write back
    style = style || "speech";
    let bx = CL.pageW / 2 - 75, by = CL.pageH / 4;
    if (CL.selected >= 0 && CL.selected < CL.panels.length) {
        const p = CL.panels[CL.selected];
        bx = p.x + p.w / 2 - 75; by = p.y + 20;
    }
    const sfxOverrides = style === "sfx" ? { w: 200, h: 80, text: "BOOM!", fontSize: 36, bold: true, font: "Impact, sans-serif", textColor: "#FFD600", textStroke: 4, textStrokeColor: "#000000", fillColor: "transparent", borderColor: "transparent", borderWidth: 0 } : {};
    CL.bubbles.push(_makeBubble({ x: bx, y: by, style, ...sfxOverrides }));
    CL.selectedBubble = CL.bubbles.length - 1;
    _syncBubbleSidebar();
    render();
}

function removeBubble() {
    if (CL.selectedBubble < 0 || CL.selectedBubble >= CL.bubbles.length) return;
    _saveUndo("Remove bubble");
    CL.bubbles.splice(CL.selectedBubble, 1);
    CL.selectedBubble = CL.bubbles.length > 0 ? Math.min(CL.selectedBubble, CL.bubbles.length - 1) : -1;
    _syncBubbleSidebar();
    render();
}


function bubbleUp() {
    const i = CL.selectedBubble;
    if (i < 0 || i >= CL.bubbles.length - 1) return;
    _saveUndo("Reorder bubble");
    [CL.bubbles[i], CL.bubbles[i + 1]] = [CL.bubbles[i + 1], CL.bubbles[i]];
    CL.selectedBubble = i + 1;
    render();
}

function bubbleDown() {
    const i = CL.selectedBubble;
    if (i <= 0) return;
    _saveUndo("Reorder bubble");
    [CL.bubbles[i], CL.bubbles[i - 1]] = [CL.bubbles[i - 1], CL.bubbles[i]];
    CL.selectedBubble = i - 1;
    render();
}

function bubbleToFront() {
    const i = CL.selectedBubble;
    if (i < 0 || i >= CL.bubbles.length - 1) return;
    _saveUndo("Bubble to front");
    const b = CL.bubbles.splice(i, 1)[0];
    CL.bubbles.push(b);
    CL.selectedBubble = CL.bubbles.length - 1;
    render();
}

function bubbleToBack() {
    const i = CL.selectedBubble;
    if (i <= 0) return;
    _saveUndo("Bubble to back");
    const b = CL.bubbles.splice(i, 1)[0];
    CL.bubbles.unshift(b);
    CL.selectedBubble = 0;
    render();
}
function _applyBubblePreset(preset) {
    if (CL.selectedBubble < 0 || CL.selectedBubble >= CL.bubbles.length) return;
    _saveUndo("Apply preset");
    const b = CL.bubbles[CL.selectedBubble];
    const presets = {
        comic_standard: { allCaps: true, textAlign: "center", bold: true, italic: false, fillColor: "#ffffff", borderColor: "#000000", borderWidth: 2, textColor: "#000000", dropShadow: false, opacity: 1.0, style: "speech" },
        narration: { allCaps: false, textAlign: "left", bold: false, italic: true, fillColor: "#FFFDE7", borderColor: "#000000", borderWidth: 1, textColor: "#000000", dropShadow: false, opacity: 1.0, style: "narration" },
        whisper: { allCaps: true, textAlign: "center", bold: false, italic: false, fillColor: "#ffffff", borderColor: "#000000", borderWidth: 1, textColor: "#000000", dropShadow: false, opacity: 0.9, fontSize: 11, style: "whisper" },
        sfx: { allCaps: true, textAlign: "center", bold: true, italic: false, fillColor: "transparent", borderColor: "transparent", borderWidth: 0, textColor: "#FFD600", dropShadow: false, opacity: 1.0, fontSize: 36, style: "sfx", font: "Impact, sans-serif", textStroke: 4, textStrokeColor: "#000000" },
    };
    const p = presets[preset];
    if (!p) return;
    Object.assign(b, p);
    if (TAILLESS_STYLES.has(b.style)) { b.tail_x = null; b.tail_y = null; }
    else if (b.tail_x == null) { b.tail_x = b.x + 50; b.tail_y = b.y + b.h + 20; }
    _syncBubbleSidebar();
    render();
}

// Inline bubble text edit
function _showBubbleInline(idx) {
    _dismissInline();
    const b = CL.bubbles[idx], r = CL.canvas.getBoundingClientRect();
    const sx = r.width / CL.canvas.width, sy = r.height / CL.canvas.height;
    const ta = document.createElement("textarea");
    ta.value = b.text || ""; ta.placeholder = "Bubble text...";
    ta.style.cssText = `position:fixed;left:${r.left + b.x * sx}px;top:${r.top + b.y * sy}px;width:${b.w * sx}px;height:${b.h * sy}px;z-index:10000;background:rgba(0,0,0,.85);color:#fff;border:2px solid ${_theme.pink};border-radius:4px;padding:6px;font-size:13px;font-family:monospace;resize:none;outline:none;text-align:center;`;
    document.body.appendChild(ta); ta.focus(); ta.select();
    ta.onkeydown = ev => {
        if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); _commitInline(); }
        if (ev.key === "Escape") _dismissInline();
    };
    ta.onblur = () => setTimeout(_commitInline, 100);
    CL._inlineEdit = { idx, textarea: ta, kind: "bubble" };
}

// ========================================================================
// MIN RESOLUTION ENFORCEMENT (ported from studio_comics.py)
// ========================================================================

const MIN_GEN_SIDE = 768;

function _enforceMinRes(pw, ph) {
    const shortest = Math.min(pw, ph);
    if (shortest >= MIN_GEN_SIDE) return { w: pw, h: ph, downscale: false };
    const scale = MIN_GEN_SIDE / shortest;
    const w = Math.max(MIN_GEN_SIDE, Math.round(pw * scale / 8) * 8);
    const h = Math.max(MIN_GEN_SIDE, Math.round(ph * scale / 8) * 8);
    return { w, h, downscale: true };
}

// ========================================================================
// TEMPLATES (ported from studio_comics.py)
// ========================================================================

function _grid(cols, rows, pw, ph) {
    const g = GUTTER;
    const cw = Math.floor((pw - g * (cols + 1)) / cols);
    const ch = Math.floor((ph - g * (rows + 1)) / rows);
    const panels = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            panels.push(_makePanel({
                id: `tpl_${r * cols + c}`,
                x: g + c * (cw + g), y: g + r * (ch + g),
                w: cw, h: ch,
            }));
        }
    }
    return panels;
}

function _makePanel(overrides = {}) {
    return {
        id: uid(), x: 0, y: 0, w: 300, h: 420,
        prompt: "", neg_prompt: "", seed: -1,
        gen_width: 0, gen_height: 0,
        image_b64: "", gallery: [], generated: false,
        panX: 0, panY: 0, zoom: 1,
        rotation: 0, skewX: 0, skewY: 0,
        ...overrides,
    };
}

const TEMPLATES = {
    "4-panel (2×2)": (pw, ph) => _grid(2, 2, pw, ph),
    "6-panel manga (2×3)": (pw, ph) => _grid(2, 3, pw, ph),
    "6-panel wide (3×2)": (pw, ph) => _grid(3, 2, pw, ph),
    "8-panel manga (2×4)": (pw, ph) => _grid(2, 4, pw, ph),
    "8-panel US (4×2)": (pw, ph) => _grid(4, 2, pw, ph),
    "9-panel grid (3×3)": (pw, ph) => _grid(3, 3, pw, ph),
    "3-panel vertical": (pw, ph) => {
        const g = GUTTER;
        const h = Math.floor((ph - g * 4) / 3), w = pw - g * 2;
        return [0, 1, 2].map(i => _makePanel({ id: `tpl_${i}`, x: g, y: g + i * (h + g), w, h }));
    },
    "Full splash": (pw, ph) => {
        const g = GUTTER;
        return [_makePanel({ id: "tpl_0", x: g, y: g, w: pw - g * 2, h: ph - g * 2 })];
    },
    "Hero left + 2 right": (pw, ph) => {
        const g = GUTTER;
        const hw = Math.floor((pw - g * 3) / 2), fh = ph - g * 2, hh = Math.floor((ph - g * 3) / 2);
        return [
            _makePanel({ id: "tpl_0", x: g, y: g, w: hw, h: fh }),
            _makePanel({ id: "tpl_1", x: g * 2 + hw, y: g, w: hw, h: hh }),
            _makePanel({ id: "tpl_2", x: g * 2 + hw, y: g * 2 + hh, w: hw, h: hh }),
        ];
    },
    "2 left + Hero right": (pw, ph) => {
        const g = GUTTER;
        const hw = Math.floor((pw - g * 3) / 2), fh = ph - g * 2, hh = Math.floor((ph - g * 3) / 2);
        return [
            _makePanel({ id: "tpl_0", x: g, y: g, w: hw, h: hh }),
            _makePanel({ id: "tpl_1", x: g, y: g * 2 + hh, w: hw, h: hh }),
            _makePanel({ id: "tpl_2", x: g * 2 + hw, y: g, w: hw, h: fh }),
        ];
    },
    "Top splash + 3 below": (pw, ph) => {
        const g = GUTTER;
        const th = Math.floor((ph - g * 3) / 2), bh = ph - g * 3 - th;
        const cw = Math.floor((pw - g * 4) / 3);
        const panels = [_makePanel({ id: "tpl_0", x: g, y: g, w: pw - g * 2, h: th })];
        for (let i = 0; i < 3; i++) {
            panels.push(_makePanel({ id: `tpl_${i + 1}`, x: g + i * (cw + g), y: g * 2 + th, w: cw, h: bh }));
        }
        return panels;
    },
    "L-layout (1 tall + 2 wide)": (pw, ph) => {
        const g = GUTTER;
        const tw = Math.floor((pw - g * 3) / 3), ww = pw - g * 3 - tw;
        const hh = Math.floor((ph - g * 3) / 2);
        return [
            _makePanel({ id: "tpl_0", x: g, y: g, w: tw, h: ph - g * 2 }),
            _makePanel({ id: "tpl_1", x: g * 2 + tw, y: g, w: ww, h: hh }),
            _makePanel({ id: "tpl_2", x: g * 2 + tw, y: g * 2 + hh, w: ww, h: hh }),
        ];
    },
};

// ========================================================================
// PANEL TRANSFORM UTILITIES (ported verbatim)
// ========================================================================

function _panelMatrix(p) {
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    const rot = (p.rotation || 0) * Math.PI / 180;
    const skx = (p.skewX || 0) * Math.PI / 180;
    const sky = (p.skewY || 0) * Math.PI / 180;
    const cosR = Math.cos(rot), sinR = Math.sin(rot);
    const tanX = Math.tan(skx), tanY = Math.tan(sky);
    const a = cosR + (-sinR) * tanY;
    const b = sinR + cosR * tanY;
    const c = cosR * tanX + (-sinR);
    const d = sinR * tanX + cosR;
    const tx = cx - (a * cx + c * cy);
    const ty = cy - (b * cx + d * cy);
    return { a, b, c, d, tx, ty, cx, cy };
}

function _applyPanelTransform(ctx, p) {
    const m = _panelMatrix(p);
    ctx.setTransform(m.a, m.b, m.c, m.d, m.tx, m.ty);
}

function _resetTransform(ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function _invTransformPoint(p, px, py) {
    const m = _panelMatrix(p);
    const det = m.a * m.d - m.b * m.c;
    if (Math.abs(det) < 1e-10) return { x: px, y: py };
    const x = px - m.tx, y = py - m.ty;
    return {
        x: (m.d * x - m.c * y) / det,
        y: (-m.b * x + m.a * y) / det,
    };
}

function _hasTransform(p) {
    return (p.rotation || 0) !== 0 || (p.skewX || 0) !== 0 || (p.skewY || 0) !== 0;
}

// ========================================================================
// UNDO
// ========================================================================

function _saveUndo(label) {
    CL._undoStack.push({
        label,
        snap: JSON.stringify({
            panels: CL.panels.map(p => ({ ...p })),
            bubbles: CL.bubbles.map(b => ({ ...b })),
        }),
    });
    if (CL._undoStack.length > CL._maxUndo) CL._undoStack.shift();
}

function _undo() {
    if (!CL._undoStack.length) return;
    const e = CL._undoStack.pop();
    try {
        const d = JSON.parse(e.snap);
        CL.panels = d.panels || [];
        CL.bubbles = d.bubbles || [];
        CL._images = {};
        CL.panels.forEach(p => { if (p.image_b64) _loadImg(p); });
        if (CL.selected >= CL.panels.length) CL.selected = CL.panels.length - 1;
        _syncSidebar();
        render();
    } catch (err) { console.error("[Comic Lab] Undo error:", err); }
}


// ========================================================================
// MULTI-PAGE SYSTEM
// ========================================================================

function _initPages() {
    CL.pages = [];
    CL.currentPage = 0;
    _savePage(0);
    _renderPageStrip();
}

function _savePage(idx) {
    CL.pages[idx] = {
        pageW: CL.pageW,
        pageH: CL.pageH,
        bgColor: CL.bgColor,
        panels: CL.panels.map(p => ({ ...p })),
        bubbles: CL.bubbles.map(b => ({ ...b })),
        _undoStack: CL._undoStack.slice(),
    };
}

function _loadPage(idx) {
    const pg = CL.pages[idx];
    if (!pg) return;
    CL.pageW = pg.pageW;
    CL.pageH = pg.pageH;
    CL.bgColor = pg.bgColor;
    CL.panels = pg.panels.map(p => ({ ...p }));
    CL.bubbles = pg.bubbles.map(b => ({ ...b }));
    CL._undoStack = pg._undoStack ? pg._undoStack.slice() : [];
    CL._images = {};
    CL.selected = CL.panels.length > 0 ? 0 : -1;
    CL.selectedBubble = -1;
    CL.multiSelected.clear();
    CL.currentPage = idx;

    if (CL.canvas) {
        CL.canvas.width = CL.pageW;
        CL.canvas.height = CL.pageH;
    }

    CL.panels.forEach(p => { if (p.image_b64) _loadImg(p); });

    const pw = CL.sidebar?.querySelector("#cl-page-w");
    const ph = CL.sidebar?.querySelector("#cl-page-h");
    const bg = CL.sidebar?.querySelector("#cl-bg-color");
    if (pw) pw.value = CL.pageW;
    if (ph) ph.value = CL.pageH;
    if (bg) bg.value = CL.bgColor;
}

function switchPage(idx) {
    if (idx === CL.currentPage || idx < 0 || idx >= CL.pages.length) return;
    _dismissInline();
    _savePage(CL.currentPage);
    _loadPage(idx);
    _syncSidebar();
    _updateToolbarInfo();
    _renderPageStrip();
    render();
}

function addPage() {
    _savePage(CL.currentPage);
    const newIdx = CL.currentPage + 1;
    CL.pages.splice(newIdx, 0, {
        pageW: CL.pageW, pageH: CL.pageH, bgColor: CL.bgColor,
        panels: [], bubbles: [], _undoStack: [],
    });
    _loadPage(newIdx);
    _syncSidebar();
    _updateToolbarInfo();
    _renderPageStrip();
    render();
    _toast("Added page " + (newIdx + 1), "success");
}

function duplicatePage(idx) {
    _savePage(CL.currentPage);
    const pg = CL.pages[idx];
    const dupe = {
        pageW: pg.pageW, pageH: pg.pageH, bgColor: pg.bgColor,
        panels: pg.panels.map(p => ({ ...p, id: uid() })),
        bubbles: pg.bubbles.map(b => ({ ...b, id: uid() })),
        _undoStack: [],
    };
    CL.pages.splice(idx + 1, 0, dupe);
    _loadPage(idx + 1);
    _syncSidebar();
    _updateToolbarInfo();
    _renderPageStrip();
    render();
    _toast("Duplicated page " + (idx + 1), "success");
}

function removePage(idx) {
    if (CL.pages.length <= 1) { _toast("Can\u2019t remove the only page", "error"); return; }
    _savePage(CL.currentPage);
    CL.pages.splice(idx, 1);
    let newIdx = CL.currentPage;
    if (idx <= CL.currentPage) newIdx = Math.max(0, CL.currentPage - 1);
    if (newIdx >= CL.pages.length) newIdx = CL.pages.length - 1;
    _loadPage(newIdx);
    _syncSidebar();
    _updateToolbarInfo();
    _renderPageStrip();
    render();
    _toast("Removed page " + (idx + 1), "success");
}

function _renderPageStrip() {
    const strip = CL.root?.querySelector("#cl-page-strip");
    if (!strip) return;
    strip.innerHTML = "";

    CL.pages.forEach((pg, i) => {
        const tab = document.createElement("button");
        tab.className = "cl-page-tab" + (i === CL.currentPage ? " active" : "");
        tab.textContent = String(i + 1);
        tab.title = "Page " + (i + 1) + " \u00b7 " + pg.pageW + "\u00d7" + pg.pageH + " \u00b7 " + pg.panels.length + " panels";
        tab.onclick = () => switchPage(i);
        tab.oncontextmenu = (e) => _showPageContextMenu(e, i);
        strip.appendChild(tab);
    });

    const addBtn = document.createElement("button");
    addBtn.className = "cl-page-add";
    addBtn.textContent = "+";
    addBtn.title = "Add page";
    addBtn.onclick = addPage;
    strip.appendChild(addBtn);
}

function _showPageContextMenu(e, pageIdx) {
    e.preventDefault();
    _dismissPageContextMenu();
    const menu = document.createElement("div");
    menu.id = "cl-page-ctx";
    menu.style.cssText = "position:fixed;left:" + e.clientX + "px;top:" + e.clientY + "px;z-index:10002;background:var(--bg-surface);border:1px solid var(--border);border-radius:6px;padding:4px 0;font-family:var(--font);box-shadow:0 4px 12px rgba(0,0,0,.4);";

    const items = [{ label: "Duplicate", fn: () => duplicatePage(pageIdx) }];
    if (CL.pages.length > 1) items.push({ label: "Delete", fn: () => removePage(pageIdx) });

    items.forEach(item => {
        const btn = document.createElement("div");
        btn.textContent = item.label;
        btn.style.cssText = "padding:6px 16px;font-size:11px;cursor:pointer;color:var(--text-1);";
        btn.onmouseenter = () => btn.style.background = "var(--bg-raised)";
        btn.onmouseleave = () => btn.style.background = "transparent";
        btn.onclick = () => { _dismissPageContextMenu(); item.fn(); };
        menu.appendChild(btn);
    });

    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener("click", _dismissPageContextMenu, { once: true }), 0);
}

function _dismissPageContextMenu() {
    const m = document.getElementById("cl-page-ctx");
    if (m) m.remove();
}


// ========================================================================
// READING ORDER OVERLAY
// ========================================================================

function toggleReadingOrder() {
    CL.showReadingOrder = !CL.showReadingOrder;
    const btn = CL.root?.querySelector("#cl-tb-order");
    if (btn) btn.classList.toggle("cl-tb-active", CL.showReadingOrder);
    render();
}

function _renderReadingOrder(c) {
    if (!CL.showReadingOrder || CL.panels.length < 1) return;

    const centers = CL.panels.map(p => ({
        x: p.x + p.w / 2,
        y: p.y + p.h / 2,
    }));

    // Connecting lines
    if (centers.length > 1) {
        c.save();
        c.strokeStyle = _theme.accent;
        c.lineWidth = 2;
        c.setLineDash([6, 4]);
        c.globalAlpha = 0.6;
        c.beginPath();
        c.moveTo(centers[0].x, centers[0].y);
        for (let i = 1; i < centers.length; i++) {
            c.lineTo(centers[i].x, centers[i].y);
        }
        c.stroke();
        c.setLineDash([]);

        // Arrowheads
        c.globalAlpha = 0.7;
        c.fillStyle = _theme.accent;
        for (let i = 1; i < centers.length; i++) {
            const from = centers[i - 1], to = centers[i];
            const dx = to.x - from.x, dy = to.y - from.y;
            const len = Math.hypot(dx, dy);
            if (len < 40) continue;
            const mx = from.x + dx * 0.55, my = from.y + dy * 0.55;
            const angle = Math.atan2(dy, dx);
            c.save();
            c.translate(mx, my);
            c.rotate(angle);
            c.beginPath();
            c.moveTo(8, 0);
            c.lineTo(-6, -5);
            c.lineTo(-6, 5);
            c.closePath();
            c.fill();
            c.restore();
        }
        c.restore();
    }

    // Numbered circles
    c.save();
    centers.forEach((pt, i) => {
        const r = 16;
        c.globalAlpha = 0.85;
        c.fillStyle = _theme.accent;
        c.beginPath();
        c.arc(pt.x, pt.y, r, 0, Math.PI * 2);
        c.fill();
        c.globalAlpha = 1;
        c.fillStyle = "#fff";
        c.font = "bold 13px sans-serif";
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText(String(i + 1), pt.x, pt.y + 1);
    });
    c.restore();
}

// ========================================================================
// IMAGE LOADING
// ========================================================================

function _loadImg(panel) {
    if (!panel.image_b64) return;
    const img = new Image();
    img.onload = () => { CL._images[panel.id] = img; render(); };
    img.src = "data:image/png;base64," + panel.image_b64;
}

// ========================================================================
// SNAP TO GRID / PANEL EDGES (ported verbatim)
// ========================================================================

function _snap(nx, ny, w, h, skipIdx) {
    const s = CL.snapThreshold, g = GUTTER;
    let bx = nx, by = ny;
    const xTargets = [0, CL.pageW];
    const yTargets = [0, CL.pageH];
    for (let i = 0; i <= Math.ceil(CL.pageW / (w + g)); i++) xTargets.push(g + i * (w + g));
    for (let i = 0; i <= Math.ceil(CL.pageH / (h + g)); i++) yTargets.push(g + i * (h + g));
    CL.panels.forEach((p, i) => {
        if (i === skipIdx) return;
        xTargets.push(p.x, p.x + p.w, p.x + p.w + g);
        yTargets.push(p.y, p.y + p.h, p.y + p.h + g);
    });
    for (const t of xTargets) { if (Math.abs(nx - t) < s) { bx = t; break; } }
    for (const t of xTargets) { if (Math.abs((nx + w) - t) < s) { bx = t - w; break; } }
    for (const t of yTargets) { if (Math.abs(ny - t) < s) { by = t; break; } }
    for (const t of yTargets) { if (Math.abs((ny + h) - t) < s) { by = t - h; break; } }
    return { x: bx, y: by };
}

function _snapEdge(val, axis, skipIdx) {
    const s = CL.snapThreshold, g = GUTTER;
    const targets = axis === "x" ? [0, CL.pageW, CL.pageW - g] : [0, CL.pageH, CL.pageH - g];
    CL.panels.forEach((p, i) => {
        if (i === skipIdx) return;
        if (axis === "x") targets.push(p.x, p.x + p.w, p.x - g);
        else targets.push(p.y, p.y + p.h, p.y - g);
    });
    for (const t of targets) { if (Math.abs(val - t) < s) return t; }
    return null;
}

// ========================================================================
// HIT TESTING (ported verbatim)
// ========================================================================

function _c(e) {
    const r = CL.canvas.getBoundingClientRect();
    return {
        x: (e.clientX - r.left) / r.width * CL.canvas.width,
        y: (e.clientY - r.top) / r.height * CL.canvas.height,
    };
}

function _hitP(mx, my) {
    for (let i = CL.panels.length - 1; i >= 0; i--) {
        const p = CL.panels[i];
        let lx = mx, ly = my;
        if (_hasTransform(p)) {
            const inv = _invTransformPoint(p, mx, my);
            lx = inv.x; ly = inv.y;
        }
        if (lx >= p.x && lx <= p.x + p.w && ly >= p.y && ly <= p.y + p.h) return i;
    }
    return -1;
}

function _hitR(mx, my, p) {
    if (!p) return false;
    let lx = mx, ly = my;
    if (_hasTransform(p)) {
        const inv = _invTransformPoint(p, mx, my);
        lx = inv.x; ly = inv.y;
    }
    return lx >= p.x + p.w - 18 && ly >= p.y + p.h - 18;
}

// ========================================================================
// RENDER
// ========================================================================

function render() {
    if (!CL.ctx) return;
    const c = CL.ctx;
    c.clearRect(0, 0, CL.canvas.width, CL.canvas.height);
    c.fillStyle = CL.bgColor;
    c.fillRect(0, 0, CL.pageW, CL.pageH);
    c.strokeStyle = "#999"; c.lineWidth = 1;
    c.strokeRect(0, 0, CL.pageW, CL.pageH);

    CL.panels.forEach((p, i) => {
        const sel = i === CL.selected;
        const multiSel = CL.multiSelected.has(i);
        const hasXform = _hasTransform(p);

        if (hasXform) { c.save(); _applyPanelTransform(c, p); }

        // Panel fill
        const _br = p.borderRadius || 0;
        c.fillStyle = p.generated ? "#222" : "#f0f0f0";
        if (_br > 0) { c.beginPath(); _roundRect(c, p.x, p.y, p.w, p.h, _br); c.fill(); }
        else { c.fillRect(p.x, p.y, p.w, p.h); }

        // Image
        const img = CL._images[p.id];
        if (img && img.complete) {
            c.save();
            if (_br > 0) { c.beginPath(); _roundRect(c, p.x + 2, p.y + 2, p.w - 4, p.h - 4, Math.max(0, _br - 2)); c.clip(); }
            else { c.beginPath(); c.rect(p.x + 2, p.y + 2, p.w - 4, p.h - 4); c.clip(); }
            if (hasXform) _resetTransform(c);
            _drawViewport(c, img, p);
            c.restore();
            if (hasXform) { _resetTransform(c); _applyPanelTransform(c, p); }
        }

        // Border
        const pbw = p.borderWidth ?? 2;
        const br = p.borderRadius || 0;
        c.strokeStyle = sel ? _theme.accent : multiSel ? _theme.amber : (p.borderColor || "#000");
        c.lineWidth = (sel || multiSel) ? Math.max(3, pbw) : pbw;
        if (br > 0) {
            c.beginPath(); _roundRect(c, p.x, p.y, p.w, p.h, br); c.stroke();
        } else {
            c.strokeRect(p.x, p.y, p.w, p.h);
        }

        // Badge
        c.fillStyle = sel ? _theme.accent : multiSel ? _theme.amber : "rgba(0,0,0,.7)";
        c.font = "bold 12px sans-serif";
        const bStr = String(i + 1);
        const bw = Math.max(24, c.measureText(bStr).width + 12);
        c.fillRect(p.x, p.y, bw, 22);
        c.fillStyle = "#fff"; c.textAlign = "left"; c.textBaseline = "top";
        c.fillText(bStr, p.x + 6, p.y + 4);

        // Prompt preview (ungenerated panels)
        if (p.prompt && !p.generated) {
            c.fillStyle = "rgba(0,0,0,.5)";
            c.fillRect(p.x, p.y + p.h - 20, p.w, 20);
            c.fillStyle = "#ccc"; c.font = "10px sans-serif";
            c.textAlign = "left"; c.textBaseline = "middle";
            const m = Math.floor(p.w / 6);
            c.fillText(p.prompt.length > m ? p.prompt.slice(0, m) + "..." : p.prompt, p.x + 4, p.y + p.h - 10);
        }

        // Resize handle
        if (sel) {
            c.fillStyle = _theme.accent; c.beginPath();
            c.moveTo(p.x + p.w, p.y + p.h);
            c.lineTo(p.x + p.w - 16, p.y + p.h);
            c.lineTo(p.x + p.w, p.y + p.h - 16);
            c.closePath(); c.fill();
        }

        // Gallery count badge
        if (p.gallery && p.gallery.length > 1) {
            c.font = "bold 10px sans-serif";
            const gc = String(p.gallery.length);
            const gcw = c.measureText(gc).width + 10;
            c.save(); c.globalAlpha = 0.85;
            c.fillStyle = _theme.accent;
            c.fillRect(p.x + p.w - gcw - 2, p.y + 2, gcw, 18);
            c.restore();
            c.fillStyle = "#fff"; c.textAlign = "center";
            c.fillText(gc, p.x + p.w - gcw / 2 - 2, p.y + 13);
        }

        if (hasXform) { c.restore(); _resetTransform(c); }
    });

    // Bubbles
    CL.bubbles.forEach((b, i) => _renderBubble(c, b, i));

    // Reading order overlay (editing aid, not exported)
    _renderReadingOrder(c);

    _tooltip();
}

function _fitScale(img, p) {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (!iw || !ih) return 1;
    const dw = p.w - 4, dh = p.h - 4;
    return Math.min(dw / iw, dh / ih);
}

function _drawViewport(ctx, img, p) {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (!iw || !ih) return;
    const dw = p.w - 4, dh = p.h - 4;
    const fit = _fitScale(img, p);
    const zoom = (p.zoom || 1) * fit;
    const panX = p.panX || 0, panY = p.panY || 0;
    const sw = iw * zoom, sh = ih * zoom;
    const ix = p.x + 2 + (dw - sw) / 2 + panX;
    const iy = p.y + 2 + (dh - sh) / 2 + panY;
    ctx.drawImage(img, ix, iy, sw, sh);
}

// ========================================================================
// TOOLTIP
// ========================================================================

function _tooltip() {
    let t = document.getElementById("comic-tooltip");
    if (CL._hoverIdx < 0 || CL._hoverIdx >= CL.panels.length || CL.drag || CL._hoverIdx === CL.selected) {
        if (t) t.style.display = "none"; return;
    }
    const p = CL.panels[CL._hoverIdx];
    if (!p.prompt && !p.generated) { if (t) t.style.display = "none"; return; }
    if (!t) {
        t = document.createElement("div"); t.id = "comic-tooltip";
        t.style.cssText = "position:fixed;background:rgba(0,0,0,.9);color:#fff;padding:8px 12px;border-radius:6px;font-size:12px;max-width:280px;pointer-events:none;z-index:9999;white-space:pre-wrap;";
        document.body.appendChild(t);
    }
    let s = "Panel " + (CL._hoverIdx + 1) + " \u2022 " + p.w + "\u00d7" + p.h;
    if (p.prompt) s += "\n" + p.prompt.slice(0, 120) + (p.prompt.length > 120 ? "..." : "");
    if (p.gallery?.length > 1) s += "\n" + p.gallery.length + " results";
    t.textContent = s; t.style.display = "block";
    if (CL._hoverPos) { t.style.left = (CL._hoverPos.x + 16) + "px"; t.style.top = (CL._hoverPos.y + 16) + "px"; }
}

// ========================================================================
// INTERACTION
// ========================================================================

function onDown(e) {
    _dismissInline();
    const { x, y } = _c(e);

    // Bubble resize handles (highest priority when bubble selected)
    if (CL.selectedBubble >= 0 && CL.selectedBubble < CL.bubbles.length) {
        const b = CL.bubbles[CL.selectedBubble];
        const handleType = _hitBubbleHandle(x, y, b);
        if (handleType) {
            _saveUndo("Resize bubble");
            CL.drag = { type: "bresize", idx: CL.selectedBubble, handleType, sx: x, sy: y };
            render(); return;
        }
    }

    // Tail drag
    const ti = _hitT(x, y);
    if (ti >= 0) {
        CL.selectedBubble = ti; CL.selected = -1;
        _saveUndo("Move tail");
        CL.drag = { type: "tail", idx: ti };
        _syncBubbleSidebar(); render(); return;
    }

    // Bubble body drag
    const bi = _hitB(x, y);
    if (bi >= 0) {
        CL.selectedBubble = bi; CL.selected = -1;
        const b = CL.bubbles[bi];
        _saveUndo("Move bubble");
        CL.drag = { type: "bmove", idx: bi, ox: b.x, oy: b.y,
            otx: b.tail_x ?? (b.x + b.w * .35), oty: b.tail_y ?? (b.y + b.h + 20),
            sx: x, sy: y };
        _syncBubbleSidebar(); render(); return;
    }

    CL.selectedBubble = -1;

    // Panel interactions
    const pi = _hitP(x, y);
    if (pi >= 0) {
        if (e.altKey && CL._images[CL.panels[pi].id]) {
            CL.selected = pi; CL.multiSelected.clear();
            _saveUndo("Pan image");
            const p = CL.panels[pi];
            CL.drag = { type: "pan", idx: pi, oPanX: p.panX || 0, oPanY: p.panY || 0, sx: x, sy: y };
            CL.canvas.style.cursor = "move";
            _syncSidebar();
            render(); return;
        }
        if (e.shiftKey) {
            if (CL.multiSelected.has(pi)) CL.multiSelected.delete(pi);
            else CL.multiSelected.add(pi);
            CL.selected = pi;
            _syncSidebar();
            render(); return;
        }
        CL.multiSelected.clear();
        CL.selected = pi;
        const p = CL.panels[pi];
        if (_hitR(x, y, p)) {
            _saveUndo("Resize");
            CL.drag = { type: "resize", idx: pi, ow: p.w, oh: p.h, sx: x, sy: y };
        } else {
            _saveUndo("Move");
            CL.drag = { type: "move", idx: pi, ox: p.x, oy: p.y, sx: x, sy: y };
        }
        _syncSidebar();
    } else {
        CL.selected = -1;
        CL.multiSelected.clear();
    }
    render();
}

function onMove(e) {
    const { x, y } = _c(e);
    if (!CL.drag) {
        // Bubble resize handle cursor
        if (CL.selectedBubble >= 0 && CL.selectedBubble < CL.bubbles.length) {
            const b = CL.bubbles[CL.selectedBubble];
            const handleType = _hitBubbleHandle(x, y, b);
            if (handleType) { CL.canvas.style.cursor = _bubbleHandleCursor(handleType); return; }
        }

        const hi = _hitP(x, y);
        if (hi !== CL._hoverIdx) { CL._hoverIdx = hi; render(); }
        CL._hoverPos = { x: e.clientX, y: e.clientY }; _tooltip();
        if (hi >= 0 && _hitR(x, y, CL.panels[hi])) CL.canvas.style.cursor = "nwse-resize";
        else if (_hitT(x, y) >= 0) CL.canvas.style.cursor = "crosshair";
        else if (hi >= 0 && e.altKey && CL._images[CL.panels[hi].id]) CL.canvas.style.cursor = "move";
        else if (_hitB(x, y) >= 0) CL.canvas.style.cursor = "grab";
        else if (hi >= 0) CL.canvas.style.cursor = "grab";
        else CL.canvas.style.cursor = "default";
        return;
    }

    const d = CL.drag, dx = x - d.sx, dy = y - d.sy;
    if (d.type === "move") {
        const p = CL.panels[d.idx];
        let nx = Math.max(0, Math.min(CL.pageW - p.w, Math.round(d.ox + dx)));
        let ny = Math.max(0, Math.min(CL.pageH - p.h, Math.round(d.oy + dy)));
        const snapped = _snap(nx, ny, p.w, p.h, d.idx);
        p.x = snapped.x; p.y = snapped.y;
    } else if (d.type === "resize") {
        const p = CL.panels[d.idx];
        let nw = Math.max(64, Math.round(d.ow + dx));
        let nh = Math.max(64, Math.round(d.oh + dy));
        const snappedR = _snapEdge(p.x + nw, "x", d.idx);
        const snappedB = _snapEdge(p.y + nh, "y", d.idx);
        if (snappedR !== null) nw = snappedR - p.x;
        if (snappedB !== null) nh = snappedB - p.y;
        p.w = Math.max(64, nw); p.h = Math.max(64, nh);
        p.gen_width = p.w; p.gen_height = p.h;
    } else if (d.type === "bmove") {
        const b = CL.bubbles[d.idx];
        b.x = Math.round(d.ox + dx); b.y = Math.round(d.oy + dy);
        b.tail_x = Math.round(d.otx + dx); b.tail_y = Math.round(d.oty + dy);
    } else if (d.type === "tail") {
        CL.bubbles[d.idx].tail_x = Math.round(x);
        CL.bubbles[d.idx].tail_y = Math.round(y);
    } else if (d.type === "bresize") {
        const b = CL.bubbles[d.idx];
        _applyBubbleResize(b, d.handleType, x - d.sx, y - d.sy);
        d.sx = x; d.sy = y;
    } else if (d.type === "pan") {
        const p = CL.panels[d.idx];
        p.panX = Math.round(d.oPanX + dx);
        p.panY = Math.round(d.oPanY + dy);
    }
    render();
}

function onUp() {
    if (CL.drag) { CL.drag = null; }
}

function onDbl(e) {
    const { x, y } = _c(e);

    // Check bubbles first
    const bi = _hitB(x, y);
    if (bi >= 0) {
        CL.selectedBubble = bi; CL.selected = -1;
        _syncBubbleSidebar();
        _showBubbleInline(bi);
        render(); return;
    }

    const pi = _hitP(x, y);
    if (pi < 0) return;
    CL.selected = pi;
    _showInline(pi);
}

// ========================================================================
// INLINE PANEL PROMPT EDIT
// ========================================================================

function _showInline(idx) {
    _dismissInline();
    const p = CL.panels[idx], r = CL.canvas.getBoundingClientRect();
    const sx = r.width / CL.canvas.width, sy = r.height / CL.canvas.height;
    const ta = document.createElement("textarea");
    ta.value = p.prompt || "";
    ta.placeholder = "Panel prompt (wildcards OK)...";
    ta.style.cssText = `position:fixed;left:${r.left + p.x * sx}px;top:${r.top + p.y * sy}px;width:${p.w * sx}px;height:${Math.min(p.h * sy, 120)}px;z-index:10000;background:rgba(0,0,0,.85);color:#fff;border:2px solid ${_theme.accent};border-radius:4px;padding:6px;font-size:13px;font-family:monospace;resize:none;outline:none;`;
    document.body.appendChild(ta); ta.focus(); ta.select();
    ta.onkeydown = ev => {
        if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); _commitInline(); }
        if (ev.key === "Escape") _dismissInline();
    };
    ta.onblur = () => setTimeout(_commitInline, 100);
    CL._inlineEdit = { idx, textarea: ta, kind: "panel" };
}

function _commitInline() {
    if (!CL._inlineEdit) return;
    const { idx, textarea, kind } = CL._inlineEdit;
    if (kind === "panel" && idx >= 0 && idx < CL.panels.length) {
        CL.panels[idx].prompt = textarea.value;
    } else if (kind === "bubble" && idx >= 0 && idx < CL.bubbles.length) {
        CL.bubbles[idx].text = textarea.value;
    }
    textarea.remove(); CL._inlineEdit = null;
    _syncSidebar();
    _syncBubbleSidebar();
    render();
}

function _dismissInline() {
    if (CL._inlineEdit) { CL._inlineEdit.textarea.remove(); CL._inlineEdit = null; }
}

// ========================================================================
// CRUD
// ========================================================================

function addPanel() {
    _saveUndo("Add panel");
    const g = GUTTER, cols = 2;
    const pw = Math.floor((CL.pageW - g * (cols + 1)) / cols);
    const ph = Math.floor(pw * 1.4);
    const idx = CL.panels.length, col = idx % cols, row = Math.floor(idx / cols);
    CL.panels.push(_makePanel({
        x: g + col * (pw + g), y: g + row * (ph + g), w: pw, h: ph,
    }));
    CL.selected = CL.panels.length - 1;
    _syncSidebar();
    render();
}

function removePanel() {
    if (CL.selected < 0 || CL.selected >= CL.panels.length) return;
    _saveUndo("Remove panel");
    const r = CL.panels.splice(CL.selected, 1)[0];
    delete CL._images[r.id];
    if (CL.selected >= CL.panels.length) CL.selected = CL.panels.length - 1;
    _syncSidebar();
    render();
}

function panelUp() {
    if (CL.selected < 0 || CL.selected >= CL.panels.length - 1) return;
    _saveUndo("Reorder");
    const i = CL.selected;
    [CL.panels[i], CL.panels[i + 1]] = [CL.panels[i + 1], CL.panels[i]];
    CL.selected = i + 1;
    _syncSidebar(); render();
}

function panelDown() {
    if (CL.selected <= 0) return;
    _saveUndo("Reorder");
    const i = CL.selected;
    [CL.panels[i], CL.panels[i - 1]] = [CL.panels[i - 1], CL.panels[i]];
    CL.selected = i - 1;
    _syncSidebar(); render();
}

function applyTemplate(name) {
    const tpl = TEMPLATES[name];
    if (!tpl) return;
    _saveUndo("Apply template");
    CL.panels = tpl(CL.pageW, CL.pageH);
    CL.bubbles = [];
    CL._images = {};
    CL.selected = CL.panels.length > 0 ? 0 : -1;
    if (CL.canvas) { CL.canvas.width = CL.pageW; CL.canvas.height = CL.pageH; }
    _syncSidebar();
    render();
}

// ========================================================================
// GENERATION
// ========================================================================

async function _populateDropdowns() {
    const api = window.API;
    if (!api) return;
    try {
        const [samplers, schedulers, upscalers, adModels] = await Promise.all([
            api.samplers(), api.schedulers(),
            api.upscalers().catch(() => []),
            api.adModels().catch(() => [{ name: "None" }]),
        ]);
        CL.samplers = samplers || [];
        CL.schedulers = schedulers || [];

        const samplerSel = CL.sidebar?.querySelector("#cl-sampler");
        if (samplerSel && CL.samplers.length) {
            samplerSel.innerHTML = CL.samplers.map(s =>
                `<option value="${s.name}" ${s.name === "DPM++ 2M SDE" ? "selected" : ""}>${s.name}</option>`
            ).join("");
        }
        const schedSel = CL.sidebar?.querySelector("#cl-scheduler");
        if (schedSel && CL.schedulers.length) {
            schedSel.innerHTML = CL.schedulers.map(s =>
                `<option value="${s.label}" ${s.label === "Karras" ? "selected" : ""}>${s.label}</option>`
            ).join("");
        }

        // Hires upscaler
        const hrUpscaler = CL.sidebar?.querySelector("#cl-hr-upscaler");
        if (hrUpscaler && upscalers.length) {
            hrUpscaler.innerHTML = '<option value="Latent">Latent</option>' +
                upscalers.map(u => `<option value="${u.name}">${u.name}</option>`).join("");
        }

        // ADetailer models (all 3 slots)
        [1, 2, 3].forEach(n => {
            const sel = CL.sidebar?.querySelector(`#cl-ad${n}-model`);
            if (sel) {
                sel.innerHTML = adModels.map(m =>
                    `<option value="${m.name}" ${n === 1 && m.name.includes("face_yolo") ? "selected" : ""}>${m.name}</option>`
                ).join("");
            }
        });

        console.log("[Comic Lab] Loaded", CL.samplers.length, "samplers,", CL.schedulers.length,
            "schedulers,", upscalers.length, "upscalers,", adModels.length, "AD models");
    } catch (e) {
        console.error("[Comic Lab] Failed to load dropdowns:", e);
    }
}

function _makeBlankB64(w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    return c.toDataURL("image/png");
}

function _getGenParams() {
    const sb = CL.sidebar;
    if (!sb) return {};
    const _val = (id, fallback) => sb.querySelector(`#${id}`)?.value ?? fallback;
    const _num = (id, fallback) => parseFloat(_val(id, fallback)) || fallback;
    const _int = (id, fallback) => parseInt(_val(id, fallback)) || fallback;
    const _checked = (id) => sb.querySelector(`#${id}`)?.checked || false;

    return {
        globalPrompt: _val("cl-global-prompt", ""),
        globalNeg:    _val("cl-global-neg", ""),
        sampler:      _val("cl-sampler", "DPM++ 2M SDE"),
        scheduler:    _val("cl-scheduler", "Karras"),
        steps:        _int("cl-steps", 30),
        cfg:          _num("cl-cfg", 5.0),
        denoise:      _num("cl-denoise", 1.0),
        batch:        _int("cl-batch", 1),

        // Hires Fix
        hr_enable:    _checked("cl-hr-enable"),
        hr_upscaler:  _val("cl-hr-upscaler", "Latent"),
        hr_scale:     _num("cl-hr-scale", 2.0),
        hr_steps:     _int("cl-hr-steps", 0),
        hr_denoise:   _num("cl-hr-denoise", 0.3),

        // ADetailer
        ad_enable:    _checked("cl-ad-enable"),
        ad_slots: [1, 2, 3].map(n => ({
            enable:     _checked(`cl-ad${n}-enable`),
            model:      _val(`cl-ad${n}-model`, "None"),
            confidence: _num(`cl-ad${n}-conf`, 0.3),
            denoise:    _num(`cl-ad${n}-denoise`, 0.4),
            mask_blur:  _int(`cl-ad${n}-blur`, 4),
            prompt:     _val(`cl-ad${n}-prompt`, ""),
            neg_prompt: _val(`cl-ad${n}-neg`, ""),
        })),
    };
}

async function _generatePanel(idx) {
    if (idx < 0 || idx >= CL.panels.length) return;
    const panel = CL.panels[idx];
    const gp = _getGenParams();
    const api = window.API;
    if (!api) { _toast("No API connection", "error"); return; }

    // Assemble prompt: global + panel
    const parts = [gp.globalPrompt.trim(), (panel.prompt || "").trim()].filter(Boolean);
    const prompt = parts.join(", ");
    const negParts = [gp.globalNeg.trim(), (panel.neg_prompt || "").trim()].filter(Boolean);
    const neg = negParts.join(", ");

    // Enforce min resolution
    const pw = Math.max(64, Math.round(panel.w / 8) * 8);
    const ph = Math.max(64, Math.round(panel.h / 8) * 8);
    const res = _enforceMinRes(pw, ph);

    const params = {
        canvas_b64: _makeBlankB64(res.w, res.h),
        mask_b64: "",
        fg_b64: "null",
        mode: "Create",
        inpaint_mode: "Inpaint",
        prompt, neg_prompt: neg,
        steps: gp.steps,
        sampler_name: gp.sampler,
        schedule_type: gp.scheduler,
        cfg_scale: gp.cfg,
        denoising: gp.denoise,
        width: res.w, height: res.h,
        seed: panel.seed ?? -1,
        batch_count: gp.batch, batch_size: 1,
        // Defaults for inpaint (not used in Create mode)
        mask_blur: 4, inpainting_fill: 1, inpaint_full_res: 0, inpaint_pad: 32,
        // Hires Fix
        hr_enable: gp.hr_enable,
        hr_upscaler: gp.hr_upscaler,
        hr_scale: gp.hr_scale,
        hr_steps: gp.hr_steps,
        hr_denoise: gp.hr_denoise,
        hr_cfg: 0,
        hr_checkpoint: "Same",
        // ADetailer
        ad_enable: gp.ad_enable,
        ad_slots: gp.ad_slots,
        // No regional/CN for comic panels
        regions_json: "", cn_json: "",
    };

    console.log(`[Comic Lab] Panel ${idx + 1}: ${res.w}×${res.h}${res.downscale ? ` (from ${pw}×${ph})` : ""}, prompt="${prompt.slice(0, 60)}"`);

    try {
        const result = await api.generate(params);

        if (result.error) {
            _toast(`Panel ${idx + 1}: ${result.error}`, "error");
            return;
        }

        if (result.images && result.images.length) {
            // If we generated at upscaled min-res, we need to downscale the results
            const gallery = [];
            for (const imgSrc of result.images) {
                if (res.downscale) {
                    const downscaled = await _downscaleImage(imgSrc, pw, ph);
                    gallery.push(downscaled);
                } else {
                    // Strip data URL prefix to get raw base64
                    gallery.push(imgSrc.includes(",") ? imgSrc.split(",")[1] : imgSrc);
                }
            }

            panel.image_b64 = gallery[0];
            panel.gallery = gallery;
            panel.generated = true;
            panel.zoom = 1; panel.panX = 0; panel.panY = 0;
            if (result.seed > 0) panel._last_seed = result.seed;
            _loadImg(panel);
            _syncSidebar();
            _toast(`Panel ${idx + 1}: ${gallery.length} image${gallery.length > 1 ? "s" : ""}`, "success");
        } else {
            _toast(`Panel ${idx + 1}: No images returned`, "error");
        }
    } catch (e) {
        console.error("[Comic Lab] Generation error:", e);
        _toast(`Panel ${idx + 1}: ${e.message}`, "error");
    }
}

function _downscaleImage(imgSrc, targetW, targetH) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const c = document.createElement("canvas");
            c.width = targetW; c.height = targetH;
            c.getContext("2d").drawImage(img, 0, 0, targetW, targetH);
            resolve(c.toDataURL("image/png").split(",")[1]);
        };
        img.onerror = () => resolve(imgSrc.includes(",") ? imgSrc.split(",")[1] : imgSrc);
        img.src = imgSrc.startsWith("data:") ? imgSrc : "data:image/png;base64," + imgSrc;
    });
}

async function generateSelected() {
    if (CL.generating) return;

    // Determine which panels to generate
    let indices = [];
    if (CL.multiSelected.size > 0) {
        indices = Array.from(CL.multiSelected).sort((a, b) => a - b);
    } else if (CL.selected >= 0) {
        indices = [CL.selected];
    }
    if (!indices.length) { _toast("No panel selected", "error"); return; }

    CL.generating = true;
    _updateGenButton();

    for (let i = 0; i < indices.length; i++) {
        CL.genCurrent = indices[i];
        _updateGenButton(`${i + 1}/${indices.length}`);
        await _generatePanel(indices[i]);
        if (!CL.generating) break; // interrupted
    }

    CL.generating = false;
    CL.genCurrent = -1;
    _updateGenButton();
}

async function generateAll() {
    if (CL.generating) return;
    if (!CL.panels.length) { _toast("No panels", "error"); return; }

    CL.generating = true;
    _updateGenButton();

    for (let i = 0; i < CL.panels.length; i++) {
        CL.genCurrent = i;
        _updateGenButton(`${i + 1}/${CL.panels.length}`);
        await _generatePanel(i);
        if (!CL.generating) break;
    }

    CL.generating = false;
    CL.genCurrent = -1;
    _updateGenButton();
}

function interruptGen() {
    CL.generating = false;
    window.API?.interrupt();
    _toast("Interrupted", "info");
    _updateGenButton();
}

function _updateGenButton() {
    const btn = CL.root?.querySelector("#cl-gen-btn");
    if (!btn) return;
    if (CL.generating) {
        const label = arguments[0] || "...";
        btn.textContent = `Generating ${label}`;
        btn.classList.add("cl-gen-active");
    } else {
        const n = CL.multiSelected.size;
        btn.textContent = n > 0 ? `Generate Selected (${n})` : "Generate Panel";
        btn.classList.remove("cl-gen-active");
    }
}

function _toast(msg, type) {
    if (window.showToast) window.showToast(msg, type);
    else console.log(`[Comic Lab] ${type}: ${msg}`);
}

// ========================================================================
// GALLERY (per-panel result cycling)
// ========================================================================

function _renderGallery() {
    const wrap = CL.sidebar?.querySelector("#cl-gallery");
    if (!wrap) return;
    if (CL.selected < 0 || CL.selected >= CL.panels.length) { wrap.innerHTML = ""; return; }
    const p = CL.panels[CL.selected];
    const g = p.gallery || [];
    if (g.length < 2) { wrap.innerHTML = ""; return; }

    wrap.innerHTML = g.map((b64, i) => {
        const active = b64 === p.image_b64;
        return `<img class="cl-gallery-thumb${active ? " active" : ""}" data-gidx="${i}" src="data:image/png;base64,${b64}" title="Result ${i + 1}">`;
    }).join("");

    wrap.querySelectorAll("img").forEach(img => {
        img.addEventListener("click", () => {
            const gi = parseInt(img.dataset.gidx);
            if (gi >= 0 && gi < g.length) {
                p.image_b64 = g[gi];
                _loadImg(p);
                _renderGallery();
            }
        });
    });
}

// ========================================================================
// SIDEBAR — Phase 2: page + panels + generation controls
// ========================================================================

function _buildSidebar() {
    const sb = CL.sidebar;
    sb.innerHTML = `
    <div class="cl-sidebar-inner">
      <div class="cl-section">
        <div class="cl-section-title">Page</div>
        <div class="cl-row">
          <label class="cl-label">W</label>
          <input type="number" class="cl-input" id="cl-page-w" value="${CL.pageW}" min="200" max="4000" step="10">
          <label class="cl-label">H</label>
          <input type="number" class="cl-input" id="cl-page-h" value="${CL.pageH}" min="200" max="6000" step="10">
          <label class="cl-label">BG</label>
          <input type="color" class="cl-color" id="cl-bg-color" value="${CL.bgColor}">
        </div>
      </div>

      <div class="cl-section">
        <div class="cl-section-title">Template</div>
        <select class="cl-select" id="cl-template">
          <option value="">Choose...</option>
          ${Object.keys(TEMPLATES).map(k => `<option value="${k}">${k}</option>`).join("")}
        </select>
      </div>

      <div class="cl-section">
        <div class="cl-section-title">
          <span>Panels</span>
          <span class="cl-section-actions">
            <button class="cl-btn" id="cl-add-panel" title="Add panel">+</button>
            <button class="cl-btn cl-btn-danger" id="cl-remove-panel" title="Remove selected">−</button>
            <button class="cl-btn" id="cl-panel-up" title="Move up">▲</button>
            <button class="cl-btn" id="cl-panel-down" title="Move down">▼</button>
          </span>
        </div>
        <div id="cl-panel-list" class="cl-panel-list"></div>
      </div>

      <div class="cl-section" id="cl-panel-detail" style="display:none;">
        <div class="cl-section-title">Selected Panel</div>
        <div class="cl-field">
          <label class="cl-label">Prompt</label>
          <textarea class="cl-textarea" id="cl-panel-prompt" rows="3" placeholder="Panel prompt..."></textarea>
        </div>
        <div class="cl-field">
          <label class="cl-label">Neg</label>
          <textarea class="cl-textarea" id="cl-panel-neg" rows="2" placeholder="Negative prompt..."></textarea>
        </div>
        <div class="cl-row">
          <label class="cl-label">Seed</label>
          <input type="number" class="cl-input" id="cl-panel-seed" value="-1">
          <label class="cl-label cl-dims" id="cl-panel-dims"></label>
        </div>
        <div class="cl-row" style="margin-top:4px;">
            <div class="cl-field" style="flex:1;">
              <label class="cl-label">Border W</label>
              <input type="number" class="cl-input" id="cl-panel-borderw" value="2" min="0" max="20">
            </div>
            <div class="cl-field" style="flex:1;">
              <label class="cl-label">Radius</label>
              <input type="number" class="cl-input" id="cl-panel-borderradius" value="0" min="0" max="50">
            </div>
            <div class="cl-field" style="flex:1;">
              <label class="cl-label">Color</label>
              <input type="color" class="cl-color" id="cl-panel-bordercolor" value="#000000">
            </div>
          </div>
        <div class="cl-row" style="margin-top:4px; align-items:center;" id="cl-zoom-row" title="Zoom the image within this panel. 100% = fit to panel.">
            <label class="cl-label" style="min-width:38px;">Zoom</label>
            <input type="range" id="cl-panel-zoom" min="10" max="500" value="100" step="5" style="flex:1; margin:0 6px;">
            <span id="cl-panel-zoom-val" style="min-width:40px; text-align:right; font-size:11px; color:#aaa;">100%</span>
            <button class="cl-btn cl-btn-sm" id="cl-panel-zoom-fit" title="Reset to fit" style="margin-left:4px; padding:2px 6px; font-size:11px;">Fit</button>
        </div>
        <div id="cl-zoom-hint" style="font-size:10px; color:#666; margin-top:2px; padding:0 2px;">
            Alt+Scroll to zoom · Alt+Drag to pan image
        </div>
        <div id="cl-gallery" class="cl-gallery"></div>
      </div>

      <div class="cl-section cl-gen-section">
        <div class="cl-section-title">Generation</div>
        <div class="cl-field">
          <label class="cl-label">Global Prompt</label>
          <textarea class="cl-textarea" id="cl-global-prompt" rows="2" placeholder="Scene/style prompt prepended to all panels..."></textarea>
        </div>
        <div class="cl-field">
          <label class="cl-label">Global Neg</label>
          <textarea class="cl-textarea" id="cl-global-neg" rows="1" placeholder="Global negative..."></textarea>
        </div>
        <div class="cl-row">
          <div class="cl-field" style="flex:1;">
            <label class="cl-label">Sampler</label>
            <select class="cl-select" id="cl-sampler"><option>DPM++ 2M SDE</option></select>
          </div>
          <div class="cl-field" style="flex:1;">
            <label class="cl-label">Scheduler</label>
            <select class="cl-select" id="cl-scheduler"><option>Karras</option></select>
          </div>
        </div>
        <div class="cl-row">
          <div class="cl-field" style="flex:1;">
            <label class="cl-label">Steps</label>
            <input type="number" class="cl-input" id="cl-steps" value="30" min="1" max="150">
          </div>
          <div class="cl-field" style="flex:1;">
            <label class="cl-label">CFG</label>
            <input type="number" class="cl-input" id="cl-cfg" value="5.0" min="1" max="30" step="0.5">
          </div>
          <div class="cl-field" style="flex:1;">
            <label class="cl-label">Denoise</label>
            <input type="number" class="cl-input" id="cl-denoise" value="1.0" min="0" max="1" step="0.05">
          </div>
        </div>
        <div class="cl-row">
          <div class="cl-field" style="flex:1;">
            <label class="cl-label">Batch</label>
            <input type="number" class="cl-input" id="cl-batch" value="1" min="1" max="8">
          </div>
        </div>

        <!-- Hires Fix -->
        <div class="cl-collapse">
          <div class="cl-collapse-header" data-collapse="cl-hr-body">
            <input type="checkbox" class="cl-collapse-check" id="cl-hr-enable">
            <span class="cl-collapse-title">Hires Fix</span>
            <span class="cl-collapse-arrow">▾</span>
          </div>
          <div class="cl-collapse-body" id="cl-hr-body">
            <div class="cl-field">
              <label class="cl-label">Upscaler</label>
              <select class="cl-select" id="cl-hr-upscaler"><option value="Latent">Latent</option></select>
            </div>
            <div class="cl-row">
              <div class="cl-field" style="flex:1;">
                <label class="cl-label">Scale</label>
                <input type="number" class="cl-input" id="cl-hr-scale" value="2.0" min="1" max="4" step="0.1">
              </div>
              <div class="cl-field" style="flex:1;">
                <label class="cl-label">Steps</label>
                <input type="number" class="cl-input" id="cl-hr-steps" value="0" min="0" max="150">
              </div>
              <div class="cl-field" style="flex:1;">
                <label class="cl-label">Denoise</label>
                <input type="number" class="cl-input" id="cl-hr-denoise" value="0.3" min="0" max="1" step="0.05">
              </div>
            </div>
          </div>
        </div>

        <!-- ADetailer -->
        <div class="cl-collapse">
          <div class="cl-collapse-header" data-collapse="cl-ad-body">
            <input type="checkbox" class="cl-collapse-check" id="cl-ad-enable">
            <span class="cl-collapse-title">ADetailer</span>
            <span class="cl-collapse-arrow">▾</span>
          </div>
          <div class="cl-collapse-body" id="cl-ad-body">
            ${[1, 2, 3].map(n => `
            <div class="cl-ad-slot">
              <div class="cl-row" style="margin-bottom:4px;">
                <input type="checkbox" class="cl-collapse-check" id="cl-ad${n}-enable" ${n === 1 ? "checked" : ""}>
                <span class="cl-label" style="font-weight:500;">Slot ${n}</span>
              </div>
              <div class="cl-field">
                <label class="cl-label">Model</label>
                <select class="cl-select" id="cl-ad${n}-model"><option>None</option></select>
              </div>
              <div class="cl-row">
                <div class="cl-field" style="flex:1;">
                  <label class="cl-label">Conf</label>
                  <input type="number" class="cl-input" id="cl-ad${n}-conf" value="0.3" min="0" max="1" step="0.05">
                </div>
                <div class="cl-field" style="flex:1;">
                  <label class="cl-label">Denoise</label>
                  <input type="number" class="cl-input" id="cl-ad${n}-denoise" value="0.4" min="0" max="1" step="0.05">
                </div>
                <div class="cl-field" style="flex:1;">
                  <label class="cl-label">Blur</label>
                  <input type="number" class="cl-input" id="cl-ad${n}-blur" value="4" min="0" max="64">
                </div>
              </div>
              <div class="cl-field">
                <label class="cl-label">AD Prompt</label>
                <input type="text" class="cl-input" id="cl-ad${n}-prompt" placeholder="Blank = use panel prompt" style="text-align:left;">
              </div>
              <div class="cl-field">
                <label class="cl-label">AD Neg</label>
                <input type="text" class="cl-input" id="cl-ad${n}-neg" placeholder="Blank = use global neg" style="text-align:left;">
              </div>
            </div>`).join("")}
          </div>
        </div>

        <button class="cl-gen-btn" id="cl-gen-btn">Generate Panel</button>
        <div class="cl-gen-actions">
          <button class="cl-gen-action" id="cl-gen-all">Generate All</button>
          <button class="cl-gen-action cl-gen-interrupt" id="cl-interrupt">Interrupt</button>
        </div>
        <div class="cl-progress"><div class="cl-progress-fill" id="cl-progress-fill"></div></div>
      </div>

      <div class="cl-section" id="cl-bubble-section">
        <div class="cl-section-title">
          <span>Bubbles</span>
          <span class="cl-section-actions">
            <button class="cl-btn cl-btn-sm" id="cl-bubble-to-back" title="Send to back (Shift+[)">⤓</button>
            <button class="cl-btn cl-btn-sm" id="cl-bubble-down" title="Move back ([)">↓</button>
            <button class="cl-btn cl-btn-sm" id="cl-bubble-up" title="Move forward (])">↑</button>
            <button class="cl-btn cl-btn-sm" id="cl-bubble-to-front" title="Bring to front (Shift+])">⤒</button>
            <span style="width:4px;"></span>
            <button class="cl-btn" id="cl-add-bubble" title="Add bubble">+</button>
            <button class="cl-btn cl-btn-danger" id="cl-remove-bubble" title="Remove selected">−</button>
          </span>
        </div>
        <div class="cl-row">
          <label class="cl-label">Style</label>
          <select class="cl-select" id="cl-bubble-style">
            <option value="speech">Speech</option>
            <option value="thought">Thought</option>
            <option value="shout">Shout</option>
            <option value="whisper">Whisper</option>
            <option value="narration">Narration</option>
            <option value="caption">Caption</option>
            <option value="radio">Radio</option>
            <option value="sfx">SFX</option>
          </select>
        </div>
        <div id="cl-bubble-detail" style="display:none;">
          <div class="cl-field">
            <label class="cl-label">Text</label>
            <textarea class="cl-textarea" id="cl-bubble-text" rows="2" placeholder="Bubble text..."></textarea>
          </div>
          <div class="cl-row">
            <div class="cl-field" style="flex:1;">
              <label class="cl-label">Font</label>
              <select class="cl-select" id="cl-bubble-font">
                <option value="sans-serif">Sans-serif</option>
                <option value="serif">Serif</option>
                <option value="monospace">Monospace</option>
                <option value="'Comic Sans MS', 'Comic Neue', cursive">Comic Sans</option>
                <option value="'Bangers', cursive">Bangers</option>
                <option value="'Permanent Marker', cursive">Permanent Marker</option>
                <option value="'Creepster', cursive">Creepster</option>
                <option value="'Special Elite', cursive">Special Elite</option>
                <option value="Impact, sans-serif">Impact</option>
              </select>
            </div>
          </div>
          <div class="cl-row">
            <div class="cl-field" style="flex:1;">
              <label class="cl-label">Font Size</label>
              <input type="number" class="cl-input" id="cl-bubble-fontsize" value="14" min="6" max="72">
            </div>
            <div class="cl-field" style="flex:1;">
              <label class="cl-label">Align</label>
              <select class="cl-select" id="cl-bubble-align">
                <option value="left">Left</option>
                <option value="center" selected>Center</option>
                <option value="right">Right</option>
              </select>
            </div>
          </div>
          <div class="cl-row">
            <label class="cl-label" style="min-width:12px;">B</label>
            <input type="checkbox" id="cl-bubble-bold" class="cl-collapse-check">
            <label class="cl-label" style="min-width:12px;">I</label>
            <input type="checkbox" id="cl-bubble-italic" class="cl-collapse-check">
            <label class="cl-label" style="min-width:30px;">CAPS</label>
            <input type="checkbox" id="cl-bubble-allcaps" class="cl-collapse-check" checked>
            <label class="cl-label" style="min-width:36px;">Shadow</label>
            <input type="checkbox" id="cl-bubble-shadow" class="cl-collapse-check">
          </div>
          <div class="cl-row">
            <label class="cl-label">Text</label>
            <input type="color" class="cl-color" id="cl-bubble-textcolor" value="#000000">
            <label class="cl-label">Fill</label>
            <input type="color" class="cl-color" id="cl-bubble-fillcolor" value="#ffffff">
            <label class="cl-label">Border</label>
            <input type="color" class="cl-color" id="cl-bubble-bordercolor" value="#000000">
          </div>
          <div class="cl-row">
            <div class="cl-field" style="flex:1;">
              <label class="cl-label">Border W</label>
              <input type="number" class="cl-input" id="cl-bubble-borderwidth" value="2" min="0" max="10">
            </div>
            <div class="cl-field" style="flex:1;">
              <label class="cl-label">Opacity</label>
              <input type="number" class="cl-input" id="cl-bubble-opacity" value="1.0" min="0" max="1" step="0.05">
            </div>
            <div class="cl-field" style="flex:1;">
              <label class="cl-label">Tail Curve</label>
              <input type="number" class="cl-input" id="cl-bubble-tailcurve" value="0" min="-30" max="30">
            </div>
          </div>
          <div class="cl-row">
            <div class="cl-field" style="flex:1;">
              <label class="cl-label">Stroke W</label>
              <input type="number" class="cl-input" id="cl-bubble-strokew" value="0" min="0" max="20">
            </div>
            <div class="cl-field" style="flex:1;">
              <label class="cl-label">Stroke Color</label>
              <input type="color" class="cl-color" id="cl-bubble-strokecolor" value="#000000">
            </div>
          </div>
          <div class="cl-row" style="margin-top:4px;">
            <button class="cl-btn" id="cl-preset-standard" title="Comic Standard" style="width:auto;padding:2px 8px;font-size:9px;">Standard</button>
            <button class="cl-btn" id="cl-preset-narration" title="Narration" style="width:auto;padding:2px 8px;font-size:9px;">Narration</button>
            <button class="cl-btn" id="cl-preset-whisper" title="Whisper" style="width:auto;padding:2px 8px;font-size:9px;">Whisper</button>
            <button class="cl-btn" id="cl-preset-sfx" title="SFX" style="width:auto;padding:2px 8px;font-size:9px;">SFX</button>
          </div>
        </div>
      </div>
    </div>`;

    // Wire events
    sb.querySelector("#cl-add-panel").addEventListener("click", addPanel);
    sb.querySelector("#cl-remove-panel").addEventListener("click", removePanel);
    sb.querySelector("#cl-panel-up").addEventListener("click", panelUp);
    sb.querySelector("#cl-panel-down").addEventListener("click", panelDown);

    sb.querySelector("#cl-template").addEventListener("change", e => {
        if (e.target.value) { _confirmApplyTemplate(e.target.value); e.target.value = ""; }
    });

    // Page settings
    const _pageChange = () => {
        const w = parseInt(sb.querySelector("#cl-page-w").value) || CL.pageW;
        const h = parseInt(sb.querySelector("#cl-page-h").value) || CL.pageH;
        const bg = sb.querySelector("#cl-bg-color").value;
        if (w !== CL.pageW || h !== CL.pageH) {
            CL.pageW = w; CL.pageH = h;
            if (CL.canvas) { CL.canvas.width = w; CL.canvas.height = h; }
        }
        if (bg && /^#[0-9a-fA-F]{6}$/.test(bg)) CL.bgColor = bg;
        render();
    };
    ["cl-page-w", "cl-page-h", "cl-bg-color"].forEach(id => {
        sb.querySelector(`#${id}`).addEventListener("change", _pageChange);
    });

    // Panel detail fields
    const _detailSave = () => {
        if (CL.selected < 0 || CL.selected >= CL.panels.length) return;
        const p = CL.panels[CL.selected];
        p.prompt = sb.querySelector("#cl-panel-prompt").value;
        p.neg_prompt = sb.querySelector("#cl-panel-neg").value;
        p.seed = parseInt(sb.querySelector("#cl-panel-seed").value) || -1;
        p.borderWidth = parseInt(sb.querySelector("#cl-panel-borderw")?.value) ?? 2;
        p.borderRadius = parseInt(sb.querySelector("#cl-panel-borderradius")?.value) || 0;
        p.borderColor = sb.querySelector("#cl-panel-bordercolor")?.value || "#000000";
        const zoomSlider = sb.querySelector("#cl-panel-zoom");
        if (zoomSlider) {
            p.zoom = parseInt(zoomSlider.value) / 100;
            const zoomVal = sb.querySelector("#cl-panel-zoom-val");
            if (zoomVal) zoomVal.textContent = Math.round(p.zoom * 100) + "%";
        }
        render();
    };
    ["cl-panel-prompt", "cl-panel-neg", "cl-panel-seed", "cl-panel-borderw", "cl-panel-borderradius", "cl-panel-bordercolor"].forEach(id => {
        const el = sb.querySelector(`#${id}`);
        el.addEventListener("change", _detailSave);
        el.addEventListener("blur", _detailSave);
        let debounce = null;
        el.addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(_detailSave, 600); });
    });

    // Zoom slider — live update on input, not debounced
    const zoomSlider = sb.querySelector("#cl-panel-zoom");
    if (zoomSlider) {
        zoomSlider.addEventListener("input", () => {
            if (CL.selected < 0 || CL.selected >= CL.panels.length) return;
            const p = CL.panels[CL.selected];
            p.zoom = parseInt(zoomSlider.value) / 100;
            const zoomVal = sb.querySelector("#cl-panel-zoom-val");
            if (zoomVal) zoomVal.textContent = Math.round(p.zoom * 100) + "%";
            render();
        });
    }
    const fitBtn = sb.querySelector("#cl-panel-zoom-fit");
    if (fitBtn) {
        fitBtn.addEventListener("click", () => {
            if (CL.selected < 0 || CL.selected >= CL.panels.length) return;
            const p = CL.panels[CL.selected];
            p.zoom = 1; p.panX = 0; p.panY = 0;
            _syncPanelDetail();
            render();
        });
    }

    // Generation buttons
    sb.querySelector("#cl-gen-btn").addEventListener("click", generateSelected);
    sb.querySelector("#cl-gen-all").addEventListener("click", generateAll);
    sb.querySelector("#cl-interrupt").addEventListener("click", interruptGen);

    // Collapsible sections
    sb.querySelectorAll(".cl-collapse-header").forEach(header => {
        header.addEventListener("click", e => {
            // Don't toggle collapse when clicking the checkbox itself
            if (e.target.type === "checkbox") return;
            const bodyId = header.dataset.collapse;
            const body = sb.querySelector(`#${bodyId}`);
            const arrow = header.querySelector(".cl-collapse-arrow");
            if (body) body.classList.toggle("open");
            if (arrow) arrow.classList.toggle("open");
        });
    });

    // Populate sampler/scheduler/upscaler/AD dropdowns from API
    _populateDropdowns();

    // Bubble sidebar events
    sb.querySelector("#cl-add-bubble").addEventListener("click", () => {
        const style = sb.querySelector("#cl-bubble-style")?.value || "speech";
        addBubble(style);
    });
    sb.querySelector("#cl-remove-bubble").addEventListener("click", removeBubble);
    sb.querySelector("#cl-bubble-up").addEventListener("click", bubbleUp);
    sb.querySelector("#cl-bubble-down").addEventListener("click", bubbleDown);
    sb.querySelector("#cl-bubble-to-front").addEventListener("click", bubbleToFront);
    sb.querySelector("#cl-bubble-to-back").addEventListener("click", bubbleToBack);

    // Bubble style change
    sb.querySelector("#cl-bubble-style").addEventListener("change", e => {
        if (CL.selectedBubble < 0 || CL.selectedBubble >= CL.bubbles.length) return;
        const b = CL.bubbles[CL.selectedBubble];
        _saveUndo("Change style");
        b.style = e.target.value;
        if (TAILLESS_STYLES.has(b.style)) { b.tail_x = null; b.tail_y = null; }
        else if (b.tail_x == null) { b.tail_x = b.x + 50; b.tail_y = b.y + b.h + 20; }
        render();
    });

    // Bubble detail field changes
    const _bubbleSave = () => {
        if (CL.selectedBubble < 0 || CL.selectedBubble >= CL.bubbles.length) return;
        const b = CL.bubbles[CL.selectedBubble];
        b.text = sb.querySelector("#cl-bubble-text")?.value || "";
        b.font = sb.querySelector("#cl-bubble-font")?.value || "sans-serif";
        b.textStroke = parseInt(sb.querySelector("#cl-bubble-strokew")?.value) || 0;
        b.textStrokeColor = sb.querySelector("#cl-bubble-strokecolor")?.value || "#000000";
        b.fontSize = parseInt(sb.querySelector("#cl-bubble-fontsize")?.value) || 14;
        b.textAlign = sb.querySelector("#cl-bubble-align")?.value || "center";
        b.bold = sb.querySelector("#cl-bubble-bold")?.checked || false;
        b.italic = sb.querySelector("#cl-bubble-italic")?.checked || false;
        b.allCaps = sb.querySelector("#cl-bubble-allcaps")?.checked ?? true;
        b.dropShadow = sb.querySelector("#cl-bubble-shadow")?.checked || false;
        b.textColor = sb.querySelector("#cl-bubble-textcolor")?.value || "#000000";
        b.fillColor = sb.querySelector("#cl-bubble-fillcolor")?.value || "#ffffff";
        b.borderColor = sb.querySelector("#cl-bubble-bordercolor")?.value || "#000000";
        b.borderWidth = parseInt(sb.querySelector("#cl-bubble-borderwidth")?.value) ?? 2;
        b.opacity = parseFloat(sb.querySelector("#cl-bubble-opacity")?.value) ?? 1.0;
        b.tail_curve = parseInt(sb.querySelector("#cl-bubble-tailcurve")?.value) || 0;
        render();
    };
    ["cl-bubble-text", "cl-bubble-font", "cl-bubble-fontsize", "cl-bubble-align", "cl-bubble-borderwidth",
     "cl-bubble-opacity", "cl-bubble-tailcurve", "cl-bubble-strokew", "cl-bubble-strokecolor", "cl-bubble-textcolor", "cl-bubble-fillcolor",
     "cl-bubble-bordercolor"].forEach(id => {
        const el = sb.querySelector(`#${id}`);
        if (el) { el.addEventListener("change", _bubbleSave); el.addEventListener("input", _bubbleSave); }
    });
    ["cl-bubble-bold", "cl-bubble-italic", "cl-bubble-allcaps", "cl-bubble-shadow"].forEach(id => {
        const el = sb.querySelector(`#${id}`);
        if (el) el.addEventListener("change", _bubbleSave);
    });

    // Presets
    sb.querySelector("#cl-preset-standard")?.addEventListener("click", () => _applyBubblePreset("comic_standard"));
    sb.querySelector("#cl-preset-narration")?.addEventListener("click", () => _applyBubblePreset("narration"));
    sb.querySelector("#cl-preset-whisper")?.addEventListener("click", () => _applyBubblePreset("whisper"));
    sb.querySelector("#cl-preset-sfx")?.addEventListener("click", () => _applyBubblePreset("sfx"));
}

function _syncSidebar() {
    if (!CL.sidebar) return;
    _renderPanelList();
    _syncPanelDetail();
    _renderGallery();
    _updateGenButton();
}

function _syncBubbleSidebar() {
    const sb = CL.sidebar;
    if (!sb) return;
    const detail = sb.querySelector("#cl-bubble-detail");
    if (!detail) return;

    if (CL.selectedBubble < 0 || CL.selectedBubble >= CL.bubbles.length) {
        detail.style.display = "none";
        return;
    }
    detail.style.display = "";
    const b = CL.bubbles[CL.selectedBubble];

    const _v = (id, val) => { const el = sb.querySelector(`#${id}`); if (el) el.value = val; };
    const _c = (id, val) => { const el = sb.querySelector(`#${id}`); if (el) el.checked = val; };

    _v("cl-bubble-style", b.style || "speech");
    _v("cl-bubble-text", b.text || "");
    _v("cl-bubble-font", b.font || "sans-serif");
    _v("cl-bubble-fontsize", b.fontSize || 14);
    _v("cl-bubble-align", b.textAlign || "center");
    _c("cl-bubble-bold", !!b.bold);
    _c("cl-bubble-italic", !!b.italic);
    _c("cl-bubble-allcaps", b.allCaps !== false);
    _c("cl-bubble-shadow", !!b.dropShadow);
    _v("cl-bubble-textcolor", b.textColor || "#000000");
    _v("cl-bubble-fillcolor", b.fillColor || "#ffffff");
    _v("cl-bubble-bordercolor", b.borderColor || "#000000");
    _v("cl-bubble-borderwidth", b.borderWidth ?? 2);
    _v("cl-bubble-opacity", b.opacity ?? 1.0);
    _v("cl-bubble-tailcurve", b.tail_curve || 0);
    _v("cl-bubble-strokew", b.textStroke || 0);
    _v("cl-bubble-strokecolor", b.textStrokeColor || "#000000");
}

function _renderPanelList() {
    const list = CL.sidebar.querySelector("#cl-panel-list");
    if (!list) return;
    list.innerHTML = CL.panels.map((p, i) => {
        const sel = i === CL.selected;
        const multi = CL.multiSelected.has(i);
        const cls = sel ? "cl-panel-item active" : multi ? "cl-panel-item multi" : "cl-panel-item";
        const prompt = p.prompt ? p.prompt.slice(0, 40) + (p.prompt.length > 40 ? "..." : "") : "—";
        const gen = p.generated ? "●" : "○";
        return `<div class="${cls}" data-idx="${i}">
            <span class="cl-panel-badge">${i + 1}</span>
            <span class="cl-panel-info">${p.w}×${p.h} ${gen}</span>
            <span class="cl-panel-prompt-preview">${_escapeHtml(prompt)}</span>
        </div>`;
    }).join("");

    list.querySelectorAll(".cl-panel-item").forEach(item => {
        item.addEventListener("click", e => {
            const idx = parseInt(item.dataset.idx);
            if (e.shiftKey) {
                if (CL.multiSelected.has(idx)) CL.multiSelected.delete(idx);
                else CL.multiSelected.add(idx);
            } else {
                CL.multiSelected.clear();
            }
            CL.selected = idx;
            _syncSidebar();
            render();
        });
    });
}

function _syncPanelDetail() {
    const detail = CL.sidebar?.querySelector("#cl-panel-detail");
    if (!detail) return;
    if (CL.selected < 0 || CL.selected >= CL.panels.length) {
        detail.style.display = "none";
        return;
    }
    detail.style.display = "";
    const p = CL.panels[CL.selected];
    CL.sidebar.querySelector("#cl-panel-prompt").value = p.prompt || "";
    CL.sidebar.querySelector("#cl-panel-neg").value = p.neg_prompt || "";
    CL.sidebar.querySelector("#cl-panel-seed").value = p.seed ?? -1;
    CL.sidebar.querySelector("#cl-panel-dims").textContent = `${p.w}×${p.h}`;
    CL.sidebar.querySelector("#cl-panel-borderw").value = p.borderWidth ?? 2;
    CL.sidebar.querySelector("#cl-panel-borderradius").value = p.borderRadius || 0;
    CL.sidebar.querySelector("#cl-panel-bordercolor").value = p.borderColor || "#000000";
    const zoomPct = Math.round((p.zoom || 1) * 100);
    const zoomSlider = CL.sidebar.querySelector("#cl-panel-zoom");
    const zoomVal = CL.sidebar.querySelector("#cl-panel-zoom-val");
    if (zoomSlider) zoomSlider.value = zoomPct;
    if (zoomVal) zoomVal.textContent = zoomPct + "%";
    const zoomRow = CL.sidebar.querySelector("#cl-zoom-row");
    const zoomHint = CL.sidebar.querySelector("#cl-zoom-hint");
    const hasImg = !!CL._images[p.id];
    if (zoomRow) zoomRow.style.display = hasImg ? "" : "none";
    if (zoomHint) zoomHint.style.display = hasImg ? "" : "none";
}

function _escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ========================================================================
// DRAG & DROP IMAGE IMPORT
// ========================================================================

function _setupDragDrop() {
    CL.canvas.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    CL.canvas.addEventListener("drop", e => {
        e.preventDefault();
        const file = e.dataTransfer?.files?.[0];
        if (!file) return;

        // Project file drop
        if (file.name.endsWith(".comic.json") || (file.type === "application/json" && file.name.includes("comic"))) {
            loadProject(file); return;
        }

        // Image drop into panel
        if (!file.type.startsWith("image/")) return;
        const { x, y } = _c(e);
        let pi = _hitP(x, y);
        if (pi < 0) pi = CL.selected;
        if (pi < 0 && CL.panels.length > 0) pi = 0;
        if (pi < 0 || pi >= CL.panels.length) return;

        const reader = new FileReader();
        reader.onload = (ev) => {
            const b64 = ev.target.result.split(",")[1];
            if (!b64) return;
            _saveUndo("Import image");
            CL.panels[pi].image_b64 = b64;
            CL.panels[pi].gallery = [b64];
            CL.panels[pi].generated = true;
            CL.panels[pi].zoom = 1; CL.panels[pi].panX = 0; CL.panels[pi].panY = 0;
            CL.selected = pi;
            _loadImg(CL.panels[pi]);
            _syncSidebar();
            console.log("[Comic Lab] Dropped image into panel", pi + 1);
        };
        reader.readAsDataURL(file);
    });
}

// ========================================================================
// KEYBOARD
// ========================================================================

function _onKey(e) {
    // Only handle if Comic Lab tab is active
    if (window.StudioModules?.activeId !== "comic") return;

    // Global shortcuts (work even in inputs)
    if ((e.ctrlKey || e.shiftKey) && e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); generateSelected(); return; }
    if (e.ctrlKey && e.key === "s") { e.preventDefault(); saveProject(); return; }
    if (e.ctrlKey && e.shiftKey && e.key === "E") { e.preventDefault(); exportPDF(); return; }
    if (e.ctrlKey && e.key === "e") { e.preventDefault(); exportPNG(); return; }
    if (e.ctrlKey && e.key === "PageDown") { e.preventDefault(); switchPage(CL.currentPage + 1); return; }
    if (e.ctrlKey && e.key === "PageUp") { e.preventDefault(); switchPage(CL.currentPage - 1); return; }

    // Don't intercept when typing in inputs
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;

    if (e.key === "r" && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); toggleReadingOrder(); }
    if (e.key === "]" && !e.ctrlKey) { e.preventDefault(); e.shiftKey ? bubbleToFront() : bubbleUp(); }
    if (e.key === "[" && !e.ctrlKey) { e.preventDefault(); e.shiftKey ? bubbleToBack() : bubbleDown(); }
    if (e.ctrlKey && e.key === "z") { e.preventDefault(); _undo(); }
    if (e.key === "Delete") {
        e.preventDefault();
        if (CL.selectedBubble >= 0) removeBubble();
        else if (CL.selected >= 0) removePanel();
    }
}

// ========================================================================
// DOM BUILDING
// ========================================================================

function _buildLayout(container) {
    container.innerHTML = `
    <div class="cl-layout">
      <div class="cl-canvas-area">
        <div class="cl-toolbar">
          <button class="cl-toolbar-btn" id="cl-tb-add" title="Add panel">+ Panel</button>
          <button class="cl-toolbar-btn" id="cl-tb-undo" title="Undo (Ctrl+Z)">↩ Undo</button>
          <span class="cl-toolbar-sep"></span>
          <button class="cl-toolbar-btn" id="cl-tb-save" title="Save project (Ctrl+S)">Save</button>
          <button class="cl-toolbar-btn" id="cl-tb-load" title="Load project">Load</button>
          <button class="cl-toolbar-btn" id="cl-tb-order" title="Toggle reading order (R)">Order</button>
          <span class="cl-toolbar-sep"></span>
          <button class="cl-toolbar-btn" id="cl-tb-export" title="Export PNG (Ctrl+E)">Export</button>
          <button class="cl-toolbar-btn" id="cl-tb-pdf" title="Export PDF (Ctrl+Shift+E)">PDF</button>
          <span class="cl-toolbar-spacer"></span>
          <span class="cl-toolbar-info" id="cl-tb-info">800 × 1200 · 0 panels</span>
        </div>
        <div class="cl-page-strip" id="cl-page-strip"></div>
        <div class="cl-viewport" id="cl-viewport"></div>
      </div>
      <div class="cl-sidebar" id="cl-sidebar"></div>
    </div>`;

    CL.root = container;
    CL.sidebar = container.querySelector("#cl-sidebar");
    CL.viewport = container.querySelector("#cl-viewport");

    // Create canvas
    const canvas = document.createElement("canvas");
    canvas.id = "cl-canvas";
    canvas.width = CL.pageW; canvas.height = CL.pageH;
    CL.viewport.appendChild(canvas);
    CL.canvas = canvas;
    CL.ctx = canvas.getContext("2d");

    // Wire canvas events
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", () => {
        onUp();
        CL._hoverIdx = -1;
        const t = document.getElementById("comic-tooltip");
        if (t) t.style.display = "none";
    });
    canvas.addEventListener("dblclick", onDbl);

    // Mouse wheel zoom on panels
    canvas.addEventListener("wheel", (e) => {
        if (!e.altKey) return;
        const { x, y } = _c(e);
        const pi = _hitP(x, y);
        if (pi < 0 || !CL._images[CL.panels[pi].id]) return;
        e.preventDefault();
        const p = CL.panels[pi];
        const delta = e.deltaY > 0 ? -0.05 : 0.05;
        p.zoom = Math.max(0.1, Math.min(5, (p.zoom || 1) + delta));
        CL.selected = pi;
        _syncSidebar();
        render();
    }, { passive: false });

    _setupDragDrop();

    // Toolbar buttons
    container.querySelector("#cl-tb-add").addEventListener("click", addPanel);
    container.querySelector("#cl-tb-undo").addEventListener("click", _undo);
    container.querySelector("#cl-tb-save").addEventListener("click", saveProject);
    container.querySelector("#cl-tb-load").addEventListener("click", _promptLoadFile);
    container.querySelector("#cl-tb-order").addEventListener("click", toggleReadingOrder);
    container.querySelector("#cl-tb-export").addEventListener("click", exportPNG);
    container.querySelector("#cl-tb-pdf").addEventListener("click", exportPDF);

    // WebSocket progress listener
    if (window.Progress) {
        window.Progress.onProgress(_handleProgress);
    }

    // Keyboard
    document.addEventListener("keydown", _onKey, true);

    // Build sidebar
    _buildSidebar();
}

function _updateToolbarInfo() {
    const el = CL.root?.querySelector("#cl-tb-info");
    if (el) {
        const n = CL.panels.length;
        const pg = CL.pages.length > 1 ? `Page ${CL.currentPage + 1}/${CL.pages.length} · ` : "";
        el.textContent = `${pg}${CL.pageW} × ${CL.pageH} · ${n} panel${n !== 1 ? "s" : ""}`;
    }
}

// ========================================================================
// PROGRESS HANDLER (WebSocket)
// ========================================================================

function _handleProgress(data) {
    if (!CL.generating) return;
    const fill = CL.root?.querySelector("#cl-progress-fill");
    if (fill) fill.style.width = (data.progress * 100) + "%";
    if (data.total_steps > 0) {
        const btn = CL.root?.querySelector("#cl-gen-btn");
        if (btn) btn.textContent = `${data.step}/${data.total_steps}`;
    }
}


// ========================================================================
// OFFSCREEN RENDERING (shared by PNG/PDF export)
// ========================================================================

function _renderPageOffscreen(pg, images) {
    const exp = document.createElement("canvas");
    exp.width = pg.pageW; exp.height = pg.pageH;
    const c = exp.getContext("2d");

    c.fillStyle = pg.bgColor || "#ffffff";
    c.fillRect(0, 0, pg.pageW, pg.pageH);

    pg.panels.forEach(p => {
        const hasXform = _hasTransform(p);
        if (hasXform) { c.save(); _applyPanelTransform(c, p); }
        const obr = p.borderRadius || 0;
        c.fillStyle = p.generated ? "#222" : "#f0f0f0";
        if (obr > 0) { c.beginPath(); _roundRect(c, p.x, p.y, p.w, p.h, obr); c.fill(); }
        else { c.fillRect(p.x, p.y, p.w, p.h); }
        const img = images[p.id];
        if (img && img.complete) {
            c.save();
            if (obr > 0) { c.beginPath(); _roundRect(c, p.x + 2, p.y + 2, p.w - 4, p.h - 4, Math.max(0, obr - 2)); c.clip(); }
            else { c.beginPath(); c.rect(p.x + 2, p.y + 2, p.w - 4, p.h - 4); c.clip(); }
            if (hasXform) _resetTransform(c);
            _drawViewport(c, img, p);
            c.restore();
            if (hasXform) { _resetTransform(c); _applyPanelTransform(c, p); }
        }
        const ebw = p.borderWidth ?? 2;
        const ebr = p.borderRadius || 0;
        c.strokeStyle = p.borderColor || "#000"; c.lineWidth = ebw;
        if (ebr > 0) { c.beginPath(); _roundRect(c, p.x, p.y, p.w, p.h, ebr); c.stroke(); }
        else { c.strokeRect(p.x, p.y, p.w, p.h); }
        if (hasXform) { c.restore(); _resetTransform(c); }
    });

    pg.bubbles.forEach((b, i) => _renderBubble(c, b, i));
    return exp;
}

function _loadImagesAsync(panels) {
    const images = {};
    const promises = [];
    panels.forEach(p => {
        if (p.image_b64) {
            const img = new Image();
            promises.push(new Promise(r => { img.onload = r; img.onerror = r; }));
            img.src = "data:image/png;base64," + p.image_b64;
            images[p.id] = img;
        }
    });
    return Promise.all(promises).then(() => images);
}

function _canvasToJpeg(canvas) {
    return new Promise(resolve => {
        canvas.toBlob(blob => {
            blob.arrayBuffer().then(buf => resolve(new Uint8Array(buf)));
        }, "image/jpeg", 0.92);
    });
}

// ========================================================================
// EXPORT PNG (current page)
// ========================================================================

function exportPNG() {
    if (!CL.panels.length && !CL.bubbles.length) { _toast("Nothing to export", "error"); return; }
    const origSel = CL.selectedBubble;
    CL.selectedBubble = -1;
    const pg = { pageW: CL.pageW, pageH: CL.pageH, bgColor: CL.bgColor, panels: CL.panels, bubbles: CL.bubbles };
    const canvas = _renderPageOffscreen(pg, CL._images);
    CL.selectedBubble = origSel;
    const link = document.createElement("a");
    link.download = `comic_${Date.now()}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
    _toast("Exported PNG", "success");
}

// ========================================================================
// EXPORT PDF (all pages)
// ========================================================================

async function exportPDF() {
    _savePage(CL.currentPage);
    if (!CL.pages.length) { _toast("Nothing to export", "error"); return; }
    _toast("Building PDF...", "info");

    const origSel = CL.selectedBubble;
    CL.selectedBubble = -1;

    const pageJpegs = [];
    for (let i = 0; i < CL.pages.length; i++) {
        const pg = CL.pages[i];
        const images = await _loadImagesAsync(pg.panels);
        const canvas = _renderPageOffscreen(pg, images);
        const jpeg = await _canvasToJpeg(canvas);
        pageJpegs.push({ jpeg, w: pg.pageW, h: pg.pageH });
    }

    CL.selectedBubble = origSel;

    const pdfBytes = _buildPDF(pageJpegs);
    const blob = new Blob([pdfBytes], { type: "application/pdf" });
    const link = document.createElement("a");
    link.download = `comic_${Date.now()}.pdf`;
    link.href = URL.createObjectURL(blob);
    link.click();
    URL.revokeObjectURL(link.href);
    _toast(`Exported ${CL.pages.length}-page PDF`, "success");
}

function _buildPDF(pages) {
    const enc = new TextEncoder();
    const chunks = [];
    let offset = 0;
    const objOffsets = [];

    function write(str) { const b = enc.encode(str); chunks.push(b); offset += b.length; }
    function writeBytes(b) { chunks.push(b); offset += b.length; }
    function startObj(id) { objOffsets[id] = offset; write(id + " 0 obj\n"); }
    function endObj() { write("endobj\n\n"); }

    write("%PDF-1.4\n%\xFF\xFF\xFF\xFF\n\n");

    const N = pages.length;
    // Layout: 1=Catalog, 2=Pages, then per page: 3+3i=Page, 4+3i=Content, 5+3i=Image

    startObj(1);
    write("<< /Type /Catalog /Pages 2 0 R >>\n");
    endObj();

    startObj(2);
    const kids = [];
    for (let i = 0; i < N; i++) kids.push((3 + 3 * i) + " 0 R");
    write("<< /Type /Pages /Kids [" + kids.join(" ") + "] /Count " + N + " >>\n");
    endObj();

    for (let i = 0; i < N; i++) {
        const pg = pages[i];
        const pageId = 3 + 3 * i, contentId = 4 + 3 * i, imgId = 5 + 3 * i;

        startObj(pageId);
        write("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + pg.w + " " + pg.h + "] /Contents " + contentId + " 0 R /Resources << /XObject << /Img " + imgId + " 0 R >> >> >>\n");
        endObj();

        const cs = "q " + pg.w + " 0 0 " + pg.h + " 0 0 cm /Img Do Q";
        startObj(contentId);
        write("<< /Length " + cs.length + " >>\nstream\n");
        write(cs);
        write("\nendstream\n");
        endObj();

        startObj(imgId);
        write("<< /Type /XObject /Subtype /Image /Width " + pg.w + " /Height " + pg.h + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + pg.jpeg.length + " >>\nstream\n");
        writeBytes(pg.jpeg);
        write("\nendstream\n");
        endObj();
    }

    const xrefOffset = offset;
    const totalObjs = 2 + 3 * N + 1;
    write("xref\n0 " + totalObjs + "\n");
    write("0000000000 65535 f \n");
    for (let id = 1; id < totalObjs; id++) {
        write(String(objOffsets[id]).padStart(10, "0") + " 00000 n \n");
    }
    write("trailer\n<< /Size " + totalObjs + " /Root 1 0 R >>\nstartxref\n" + xrefOffset + "\n%%EOF\n");

    const totalLen = chunks.reduce((a, c) => a + c.length, 0);
    const result = new Uint8Array(totalLen);
    let pos = 0;
    for (const chunk of chunks) { result.set(chunk, pos); pos += chunk.length; }
    return result;
}

// ========================================================================
// SAVE / LOAD PROJECT (v2 — multi-page, backward-compatible with v1)
// ========================================================================

function saveProject() {
    _savePage(CL.currentPage);
    const data = {
        version: 2,
        currentPage: CL.currentPage,
        pages: CL.pages.map(pg => ({
            w: pg.pageW, h: pg.pageH, bgColor: pg.bgColor,
            panels: pg.panels.map(p => ({ ...p })),
            bubbles: pg.bubbles.map(b => ({ ...b })),
        })),
    };
    const json = JSON.stringify(data);
    const blob = new Blob([json], { type: "application/json" });
    const link = document.createElement("a");
    link.download = `comic_${Date.now()}.comic.json`;
    link.href = URL.createObjectURL(blob);
    link.click();
    URL.revokeObjectURL(link.href);
    _toast("Project saved", "success");
}

function loadProject(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        try {
            const data = JSON.parse(ev.target.result);
            if (!data.version) { _toast("Invalid project file", "error"); return; }
            _saveUndo("Load project");

            if (data.version === 1) {
                // Wrap v1 single-page format into multi-page
                CL.pages = [{
                    pageW: data.page?.w || 800,
                    pageH: data.page?.h || 1200,
                    bgColor: data.page?.bgColor || "#ffffff",
                    panels: data.panels || [],
                    bubbles: data.bubbles || [],
                    _undoStack: [],
                }];
                CL.currentPage = 0;
            } else {
                // v2 multi-page format
                CL.pages = (data.pages || []).map(pg => ({
                    pageW: pg.w || 800,
                    pageH: pg.h || 1200,
                    bgColor: pg.bgColor || "#ffffff",
                    panels: pg.panels || [],
                    bubbles: pg.bubbles || [],
                    _undoStack: [],
                }));
                CL.currentPage = data.currentPage || 0;
                if (CL.currentPage >= CL.pages.length) CL.currentPage = 0;
            }

            if (!CL.pages.length) {
                CL.pages = [{ pageW: 800, pageH: 1200, bgColor: "#ffffff", panels: [], bubbles: [], _undoStack: [] }];
                CL.currentPage = 0;
            }

            _loadPage(CL.currentPage);
            _syncSidebar();
            _updateToolbarInfo();
            _renderPageStrip();
            render();

            const totalPanels = CL.pages.reduce((a, pg) => a + pg.panels.length, 0);
            _toast(`Loaded: ${CL.pages.length} page${CL.pages.length !== 1 ? "s" : ""}, ${totalPanels} panels`, "success");
        } catch (e) {
            console.error("[Comic Lab] Load error:", e);
            _toast("Failed to load project: " + e.message, "error");
        }
    };
    reader.readAsText(file);
}

function _promptLoadFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.comic.json";
    input.onchange = () => { if (input.files[0]) loadProject(input.files[0]); };
    input.click();
}

// ========================================================================
// TEMPLATE CONFIRMATION
// ========================================================================

function _confirmApplyTemplate(name) {
    if (CL.panels.length === 0 && CL.bubbles.length === 0) {
        applyTemplate(name); return;
    }
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10001;display:flex;align-items:center;justify-content:center;";
    const box = document.createElement("div");
    box.style.cssText = "background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:20px 24px;max-width:340px;font-family:var(--font);color:var(--text-1);";
    box.innerHTML = `
        <div style="font-size:13px;font-weight:600;margin-bottom:10px;">Apply Template?</div>
        <div style="font-size:11px;color:var(--text-2);margin-bottom:16px;">This will replace all ${CL.panels.length} panel${CL.panels.length !== 1 ? "s" : ""} and ${CL.bubbles.length} bubble${CL.bubbles.length !== 1 ? "s" : ""}. This action can be undone.</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button id="cl-tpl-cancel" style="padding:6px 14px;background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-2);font-size:11px;cursor:pointer;font-family:var(--font);">Cancel</button>
            <button id="cl-tpl-confirm" style="padding:6px 14px;background:var(--accent);border:none;border-radius:var(--radius-sm);color:#fff;font-size:11px;font-weight:600;cursor:pointer;font-family:var(--font);">Apply</button>
        </div>`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const dismiss = () => overlay.remove();
    overlay.addEventListener("click", (e) => { if (e.target === overlay) dismiss(); });
    box.querySelector("#cl-tpl-cancel").addEventListener("click", dismiss);
    box.querySelector("#cl-tpl-confirm").addEventListener("click", () => { dismiss(); applyTemplate(name); });
}

// ========================================================================
// CSS (injected once)
// ========================================================================

let _cssInjected = false;

function _injectCSS() {
    if (_cssInjected) return;
    _cssInjected = true;
    const style = document.createElement("style");
    style.textContent = `
/* Comic Lab 2.0 — Phase 1 */

.cl-layout {
    display: flex; flex: 1; min-height: 0; height: 100%;
}

.cl-canvas-area {
    flex: 1; display: flex; flex-direction: column;
    background: var(--bg-void); overflow: hidden;
}

.cl-toolbar {
    height: 36px; display: flex; align-items: center;
    padding: 0 10px; gap: 6px;
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
}

.cl-toolbar-btn {
    font-family: var(--font); font-size: 10px; font-weight: 500;
    padding: 4px 10px; border: 1px solid var(--border);
    border-radius: var(--radius-sm); background: var(--bg-raised);
    color: var(--text-3); cursor: pointer; transition: all 0.12s;
}
.cl-toolbar-btn:hover { color: var(--text-1); border-color: var(--accent); }
.cl-tb-active { background: var(--accent-dim); border-color: var(--accent); color: var(--text-1); }

.cl-toolbar-spacer { flex: 1; }

.cl-toolbar-sep {
    width: 1px; height: 16px; background: var(--border);
    margin: 0 2px; flex-shrink: 0;
}

.cl-page-strip {
    display: flex; align-items: center; gap: 3px;
    padding: 4px 8px; border-bottom: 1px solid var(--border);
    background: var(--bg-surface); overflow-x: auto;
    min-height: 28px; flex-shrink: 0;
}
.cl-page-strip::-webkit-scrollbar { height: 3px; }
.cl-page-strip::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

.cl-page-tab {
    padding: 3px 10px; min-width: 28px; font-size: 11px; font-family: var(--font);
    background: transparent; border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text-2);
    cursor: pointer; white-space: nowrap; user-select: none;
    transition: all 0.12s; text-align: center;
}
.cl-page-tab:hover { border-color: var(--text-3); }
.cl-page-tab.active {
    background: var(--accent-dim); border-color: var(--accent);
    color: var(--text-1); font-weight: 600;
}

.cl-page-add {
    padding: 3px 8px; font-size: 11px; background: transparent;
    border: 1px dashed var(--border); border-radius: var(--radius-sm);
    color: var(--text-3); cursor: pointer; font-family: var(--font);
    transition: all 0.12s;
}
.cl-page-add:hover { border-color: var(--accent); color: var(--text-2); }

.cl-toolbar-info {
    font-size: 10px; color: var(--text-4); font-family: var(--mono);
}

.cl-viewport {
    flex: 1; display: flex; align-items: center; justify-content: center;
    overflow: hidden; padding: 20px;
    min-height: 0;
}

#cl-canvas {
    max-width: 100%; max-height: 100%;
    border: 1px solid var(--border); cursor: default;
    background: #2a2a2a;
}

.cl-sidebar {
    width: 280px; background: var(--bg-surface);
    border-left: 1px solid var(--border);
    overflow-y: auto; flex-shrink: 0;
}

.cl-sidebar-inner { padding: 0; }

.cl-section {
    border-bottom: 1px solid var(--border);
    padding: 10px 12px;
}

.cl-section-title {
    font-size: 10px; color: var(--text-4); font-weight: 500;
    letter-spacing: 0.8px; text-transform: uppercase;
    margin-bottom: 8px;
    display: flex; align-items: center; justify-content: space-between;
}

.cl-section-actions { display: flex; gap: 2px; }

.cl-row {
    display: flex; gap: 6px; align-items: center; margin-bottom: 6px;
}

.cl-field { margin-bottom: 6px; }

.cl-label {
    font-size: 10px; color: var(--text-3); flex-shrink: 0; min-width: 20px;
}

.cl-dims {
    font-family: var(--mono); font-size: 10px; color: var(--text-4);
}

.cl-input {
    background: var(--bg-input); border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm); padding: 4px 6px;
    font-size: 11px; color: var(--text-2); font-family: var(--mono);
    width: 100%; outline: none; text-align: center;
}
.cl-input:focus { border-color: var(--accent); color: var(--text-1); }

.cl-textarea {
    background: var(--bg-input); border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm); padding: 6px 8px;
    font-size: 11px; color: var(--text-2); font-family: var(--font);
    width: 100%; outline: none; resize: vertical; line-height: 1.4;
}
.cl-textarea:focus { border-color: var(--accent); color: var(--text-1); }

.cl-color {
    width: 28px; height: 28px; border: 1px solid var(--border);
    border-radius: var(--radius-sm); cursor: pointer; padding: 0;
    background: none;
}

.cl-select {
    appearance: none;
    background: var(--bg-input) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5' viewBox='0 0 8 5'%3E%3Cpath d='M0 0l4 4 4-4' fill='none' stroke='%236b6b74' stroke-width='1.5'/%3E%3C/svg%3E") no-repeat right 8px center;
    border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
    padding: 5px 22px 5px 8px; font-size: 11px; color: var(--text-2);
    font-family: var(--font); cursor: pointer; width: 100%; outline: none;
}
.cl-select:hover { border-color: var(--border); }
.cl-select:focus { border-color: var(--accent); }
.cl-select option { background: var(--bg-surface); color: var(--text-1); }

.cl-btn {
    width: 24px; height: 22px;
    background: var(--bg-raised); border: 1px solid var(--border-subtle);
    border-radius: 3px; color: var(--text-3);
    font-size: 12px; cursor: pointer; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.12s;
}
.cl-btn:hover { color: var(--text-1); border-color: var(--accent); }
.cl-btn-danger:hover { color: var(--red); border-color: var(--red); }
.cl-btn-sm { width: 20px; min-width: 20px; padding: 0; font-size: 10px; line-height: 18px; }

.cl-panel-list { max-height: 240px; overflow-y: auto; }

.cl-panel-item {
    display: flex; align-items: center; gap: 6px;
    padding: 5px 8px; cursor: pointer; transition: background 0.1s;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 11px; color: var(--text-3);
}
.cl-panel-item:hover { background: var(--bg-raised); }
.cl-panel-item.active { background: var(--accent-dim); color: var(--text-1); }
.cl-panel-item.multi { background: var(--amber-dim); color: var(--text-1); }

.cl-panel-badge {
    width: 18px; height: 18px; border-radius: 3px;
    background: var(--bg-input); font-family: var(--mono);
    font-size: 10px; font-weight: 600;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
}
.cl-panel-item.active .cl-panel-badge { background: var(--accent); color: #fff; }
.cl-panel-item.multi .cl-panel-badge { background: var(--amber); color: #fff; }

.cl-panel-info {
    font-family: var(--mono); font-size: 9px; color: var(--text-4);
    flex-shrink: 0;
}

.cl-panel-prompt-preview {
    flex: 1; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
    font-size: 10px; color: var(--text-4);
}

/* Generation controls */
.cl-gen-section { background: var(--bg-raised); }

.cl-gen-btn {
    width: 100%; padding: 10px 0; margin-top: 6px;
    background: var(--accent); color: #fff; border: none;
    border-radius: var(--radius); font-family: var(--font);
    font-size: 12px; font-weight: 600; cursor: pointer;
    transition: all 0.15s; letter-spacing: 0.5px;
    text-transform: uppercase;
}
.cl-gen-btn:hover { filter: brightness(1.1); }
.cl-gen-btn.cl-gen-active {
    animation: pulse 1.5s infinite;
}

.cl-gen-actions {
    display: flex; gap: 4px; margin-top: 4px;
}
.cl-gen-action {
    flex: 1; padding: 4px; font-size: 10px;
    background: var(--bg-input); border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm); color: var(--text-3);
    font-family: var(--font); cursor: pointer; transition: all 0.12s;
}
.cl-gen-action:hover { color: var(--text-1); border-color: var(--border); }
.cl-gen-interrupt:hover { color: var(--red); border-color: var(--red); }

.cl-progress {
    height: 3px; background: var(--bg-input); border-radius: 2px;
    margin-top: 6px; overflow: hidden;
}
.cl-progress-fill {
    height: 100%; width: 0%; background: var(--accent);
    transition: width 0.3s ease; border-radius: 2px;
}

/* Gallery thumbnails */
.cl-gallery {
    display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px;
}
.cl-gallery-thumb {
    height: 60px; width: auto; cursor: pointer;
    border: 2px solid transparent; border-radius: 4px;
    object-fit: cover; transition: border-color 0.12s;
}
.cl-gallery-thumb:hover { border-color: var(--border); }
.cl-gallery-thumb.active { border-color: var(--accent); }

/* Collapsible sections */
.cl-collapse { border-top: 1px solid var(--border-subtle); margin-top: 6px; }

.cl-collapse-header {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 0; cursor: pointer;
}
.cl-collapse-header:hover { color: var(--text-1); }

.cl-collapse-check {
    width: 14px; height: 14px; margin: 0; cursor: pointer;
    accent-color: var(--accent); flex-shrink: 0;
}

.cl-collapse-title {
    flex: 1; font-size: 11px; color: var(--text-3); font-weight: 500;
}

.cl-collapse-arrow {
    font-size: 10px; color: var(--text-4);
    transition: transform 0.2s;
}
.cl-collapse-arrow.open { transform: rotate(180deg); }

.cl-collapse-body {
    max-height: 0; overflow: hidden;
    transition: max-height 0.25s ease;
}
.cl-collapse-body.open { max-height: 800px; padding-bottom: 6px; }

/* AD slots */
.cl-ad-slot {
    padding: 6px 0;
    border-bottom: 1px solid var(--border-subtle);
}
.cl-ad-slot:last-child { border-bottom: none; }

/* Bubble section */
#cl-bubble-detail { margin-top: 6px; }
`;
    document.head.appendChild(style);
}

// ========================================================================
// MODULE REGISTRATION
// ========================================================================

if (!window.StudioModules) {
    console.error("[Comic Lab] StudioModules not found — module-system.js must load first");
    return;
}

window.StudioModules.register("comic", {
    label: "Comic Lab",
    icon: "\u229E",

    init(container, services) {
        CL.services = services;
        _injectCSS();
        _readThemeColors();
        _buildLayout(container);
        CL.ready = true;
        _initPages();
        _updateToolbarInfo();
        render();
        console.log("[Comic Lab 2.0] Initialized");
    },

    activate(container, services) {
        CL.services = services;
        _readThemeColors();
        _updateToolbarInfo();
        _renderPageStrip();
        render();
    },

    deactivate() {
        _dismissInline();
        CL._hoverIdx = -1;
        const t = document.getElementById("comic-tooltip");
        if (t) t.style.display = "none";
    },
});

// Expose for inter-module communication (Studio → Comic Lab)
window.ComicLabAPI = {
    isReady: () => CL.ready,
    exportPNG,
    exportPDF,
    saveProject,
    loadProject,
    switchPage,
    addPage,
    removePage,
    duplicatePage,
    getPageCount: () => CL.pages.length,
    getCurrentPage: () => CL.currentPage,
    toggleReadingOrder,
    importImage(b64, panelIdx) {
        let idx = panelIdx ?? -1;
        if (idx < 0 || idx >= CL.panels.length) idx = CL.selected >= 0 ? CL.selected : 0;
        if (idx < 0 || idx >= CL.panels.length) return false;
        CL.panels[idx].image_b64 = b64;
        CL.panels[idx].gallery = [b64];
        CL.panels[idx].generated = true;
        CL.panels[idx].zoom = 1; CL.panels[idx].panX = 0; CL.panels[idx].panY = 0;
        CL.selected = idx;
        _loadImg(CL.panels[idx]);
        _syncSidebar();
        return true;
    },
    getSelectedPanelIndex: () => CL.selected,
    getPanelCount: () => CL.panels.length,
};

console.log("[Comic Lab 2.0] Module loaded — awaiting activation");

})();
