/**
 * ShapeCFG — Blueprint Hooks
 * Ports the Python curve functions to JS and renders a live Canvas chart.
 * Replaces the matplotlib gr.Plot + Gradio JS polling hack.
 */

// ── Curve Functions ──────────────────────────────────────

function curveDecay(i, n, kw) {
  const t = i / Math.max(1, n - 1);
  const start = kw.decay_start ?? 1.35;
  const rate = kw.decay_rate ?? 3.0;
  return 1.0 + (start - 1.0) * Math.exp(-Math.min(rate * t, 20));
}

function curveFractal(i, n, kw) {
  const t = i / Math.max(1, n - 1);
  const base = kw.fractal_base ?? 1.0;
  const amp = kw.fractal_amp ?? 0.25;
  const wob = 0.5 * Math.sin(2 * Math.PI * 3 * t) +
              0.5 * Math.sin(2 * Math.PI * 7 * t + 0.3);
  return base + amp * wob;
}

function curveSpiral(i, n, kw) {
  const t = i / Math.max(1, n - 1);
  const floor = kw.floor_m ?? 0.55;
  const ceil = kw.ceil_m ?? 1.65;
  return floor + (ceil - floor) * t;
}

function curveThorn(i, n, kw) {
  const t = i / Math.max(1, n - 1);
  const thornCount = Math.max(1, kw.thorns ?? 3);
  const strength = kw.strength ?? 0.45;
  const sharp = Math.max(1e-6, (kw.sharpness ?? 0.08) ** 2);
  const layout = kw.layout ?? "golden";
  const jitter = kw.jitter ?? 0.05;
  const seed = kw.seed ?? 13.0;

  let centers = [];
  if (layout === "even") {
    for (let k = 0; k < thornCount; k++) centers.push((k + 1) / (thornCount + 1));
  } else if (layout === "late") {
    for (let k = 0; k < thornCount; k++) {
      const u = (k + 1) / (thornCount + 1);
      centers.push(0.55 + 0.45 * u);
    }
  } else {
    const phi = (Math.sqrt(5) - 1) / 2;
    let pos = 0.22;
    for (let k = 0; k < thornCount; k++) {
      centers.push(pos);
      pos = (pos + phi) % 1.0;
    }
    centers.sort((a, b) => a - b);
  }

  let spike = 0;
  for (const c of centers) spike += Math.exp(-0.5 * ((t - c) ** 2) / sharp);
  spike /= thornCount;

  const base = 0.9 + 0.1 * (1.0 - (1.0 - t) ** 2);
  const wobble = Math.sin((i + 1) * (seed * 0.137)) * jitter;
  return base + strength * spike + wobble;
}

function curveToxic(i, n, kw) {
  const high = kw.high ?? 1.35;
  const low = kw.low ?? 0.80;
  const period = Math.max(1, kw.period ?? 2);
  const smooth = kw.smooth ?? 0.20;

  const phase = Math.floor(i / period) % 2;
  const raw = phase === 0 ? high : low;
  const tLocal = (i % period) / Math.max(1, period);
  const tri = 1.0 - Math.abs(2.0 * tLocal - 1.0);
  const mid = (high + low) * 0.5;
  return raw + smooth * tri * (mid - raw);
}

function curveGrief(i, n, kw) {
  const t = i / Math.max(1, n - 1);
  const A = kw.grief_amplitude ?? 0.45;
  const lam = kw.grief_decay ?? 1.8;
  const omega = kw.grief_frequency ?? 2.5;
  const phi = kw.grief_phase ?? 0.0;
  const B = kw.grief_baseline ?? 1.0;
  return A * Math.exp(-Math.min(Math.abs(lam) * t, 20)) *
         Math.sin(omega * t * 2 * Math.PI + phi) + B;
}

const CURVES = {
  Decay: curveDecay, Fractal: curveFractal, Spiral: curveSpiral,
  Thorn: curveThorn, Toxic: curveToxic, Grief: curveGrief,
};

const CURVE_COLORS = {
  Decay: "#53d8a8", Fractal: "#a855f7", Spiral: "#f59e0b",
  Thorn: "#ef4444", Toxic: "#22d3ee", Grief: "#6366f1",
};

// Default params per curve (for blend secondary which uses factory defaults)
const DEFAULTS = {
  decay_start: 1.35, decay_rate: 3.0,
  fractal_base: 1.0, fractal_amp: 0.25,
  thorns: 3, strength: 0.45, sharpness: 0.08, layout: "golden", jitter: 0.05, seed: 13.0,
  high: 1.35, low: 0.80, period: 2, smooth: 0.20,
  grief_amplitude: 0.45, grief_decay: 1.8, grief_frequency: 2.5, grief_phase: 0.0, grief_baseline: 1.0,
};

// ── Chart Drawing ────────────────────────────────────────

function drawChart(canvas, params) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  // Colors
  const bg = "#16213e";
  const gridCol = "#2a2a4a";
  const floorCeilCol = "#3a3a5a";
  const textCol = "#c8c8d8";

  // Background
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const { curveName, floorM, ceilM, baseCfg, steps, kw,
          blendEnabled, blendCurve, blendWeight } = params;

  const n = Math.max(2, steps);
  const cfg = Math.max(0.1, baseCfg);
  const curveFn = CURVES[curveName] || curveDecay;
  const fullKw = { ...kw, floor_m: floorM, ceil_m: ceilM };

  // Compute primary
  const primaryRaw = [];
  for (let i = 0; i < n; i++) primaryRaw.push(curveFn(i, n, fullKw));
  const primaryClamped = primaryRaw.map(v => Math.max(floorM, Math.min(ceilM, v)));

  // Compute blend
  let blendClamped = null;
  let finalMults = primaryClamped;
  const doBlend = blendEnabled && blendCurve in CURVES && blendWeight > 0;
  if (doBlend) {
    const bFn = CURVES[blendCurve];
    const bKw = { ...DEFAULTS, floor_m: floorM, ceil_m: ceilM };
    const bRaw = [];
    for (let i = 0; i < n; i++) bRaw.push(bFn(i, n, bKw));
    blendClamped = bRaw.map(v => Math.max(floorM, Math.min(ceilM, v)));
    const bw = Math.max(0, Math.min(1, blendWeight));
    finalMults = primaryClamped.map((p, i) => {
      const m = p * (1 - bw) + blendClamped[i] * bw;
      return Math.max(floorM, Math.min(ceilM, m));
    });
  }

  const finalVals = finalMults.map(m => m * cfg);
  const floorCfg = floorM * cfg;
  const ceilCfg = ceilM * cfg;

  // Chart area
  const pad = { top: 14, right: 12, bottom: 28, left: 42 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;

  const yLo = Math.max(0, floorCfg - cfg * 0.1);
  const yHi = ceilCfg + cfg * 0.1;

  const xScale = (i) => pad.left + (i / Math.max(1, n - 1)) * cw;
  const yScale = (v) => pad.top + ch - ((v - yLo) / (yHi - yLo)) * ch;

  // Floor/ceil shaded zones
  ctx.fillStyle = floorCeilCol;
  ctx.globalAlpha = 0.2;
  ctx.fillRect(pad.left, yScale(floorCfg), cw, ch - (ch - (yScale(floorCfg) - pad.top)));
  const ceilY = yScale(ceilCfg);
  ctx.fillRect(pad.left, pad.top, cw, ceilY - pad.top);
  ctx.globalAlpha = 1;

  // Grid lines
  ctx.strokeStyle = gridCol;
  ctx.lineWidth = 0.4;
  ctx.globalAlpha = 0.5;
  const yRange = yHi - yLo;
  const yStep = yRange < 3 ? 0.5 : yRange < 8 ? 1.0 : 2.0;
  for (let v = Math.ceil(yLo / yStep) * yStep; v <= yHi; v += yStep) {
    const y = yScale(v);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Floor/ceil dashed lines
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = floorCeilCol;
  ctx.lineWidth = 0.8;
  ctx.globalAlpha = 0.6;
  ctx.beginPath(); ctx.moveTo(pad.left, yScale(floorCfg)); ctx.lineTo(W - pad.right, yScale(floorCfg)); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(pad.left, yScale(ceilCfg)); ctx.lineTo(W - pad.right, yScale(ceilCfg)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // Base CFG dotted line
  ctx.setLineDash([2, 3]);
  ctx.strokeStyle = textCol;
  ctx.lineWidth = 0.5;
  ctx.globalAlpha = 0.3;
  ctx.beginPath(); ctx.moveTo(pad.left, yScale(cfg)); ctx.lineTo(W - pad.right, yScale(cfg)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  const primaryColor = CURVE_COLORS[curveName] || "#e94560";

  // Draw helper
  function drawLine(vals, color, width, alpha, dash) {
    ctx.setLineDash(dash || []);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    for (let i = 0; i < vals.length; i++) {
      const x = xScale(i), y = yScale(vals[i]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // Fill under final curve
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = doBlend ? "#e94560" : primaryColor;
  ctx.beginPath();
  ctx.moveTo(xScale(0), yScale(floorCfg));
  for (let i = 0; i < finalVals.length; i++) ctx.lineTo(xScale(i), yScale(finalVals[i]));
  ctx.lineTo(xScale(n - 1), yScale(floorCfg));
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;

  // Blend ghost curves
  if (doBlend) {
    const priCfg = primaryClamped.map(m => m * cfg);
    const bleCfg = blendClamped.map(m => m * cfg);
    drawLine(priCfg, primaryColor, 1, 0.35, [4, 3]);
    drawLine(bleCfg, CURVE_COLORS[blendCurve] || "#0f3460", 1, 0.35, [4, 3]);
    drawLine(finalVals, "#e94560", 2.2, 0.95);
  } else {
    drawLine(finalVals, primaryColor, 2.2, 0.95);
  }

  // Dots
  const dotColor = doBlend ? "#e94560" : primaryColor;
  ctx.fillStyle = dotColor;
  ctx.globalAlpha = 0.7;
  const dotR = n > 50 ? 1.5 : n > 30 ? 2 : 3;
  for (let i = 0; i < finalVals.length; i++) {
    ctx.beginPath();
    ctx.arc(xScale(i), yScale(finalVals[i]), dotR, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Axes
  ctx.strokeStyle = gridCol;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, pad.top + ch);
  ctx.lineTo(pad.left + cw, pad.top + ch);
  ctx.stroke();

  // Labels
  ctx.fillStyle = textCol;
  ctx.font = "9px sans-serif";
  ctx.textAlign = "center";

  // X axis step labels
  const xLabelCount = Math.min(n, 12);
  const xLabelStep = Math.max(1, Math.floor(n / xLabelCount));
  for (let i = 0; i < n; i += xLabelStep) {
    ctx.fillText(i, xScale(i), H - pad.bottom + 16);
  }
  ctx.fillText("Step", pad.left + cw / 2, H - 2);

  // Y axis labels
  ctx.textAlign = "right";
  for (let v = Math.ceil(yLo / yStep) * yStep; v <= yHi; v += yStep) {
    ctx.fillText(v.toFixed(1), pad.left - 4, yScale(v) + 3);
  }

  // Legend
  ctx.font = "8px sans-serif";
  ctx.textAlign = "left";
  const legendX = W - pad.right - 80;
  let legendY = pad.top + 10;
  if (doBlend) {
    const bw = Math.max(0, Math.min(1, blendWeight));
    _legendItem(ctx, legendX, legendY, primaryColor, curveName, [4, 3]); legendY += 12;
    _legendItem(ctx, legendX, legendY, CURVE_COLORS[blendCurve] || "#0f3460", blendCurve, [4, 3]); legendY += 12;
    _legendItem(ctx, legendX, legendY, "#e94560", `Blend ${Math.round((1 - bw) * 100)}/${Math.round(bw * 100)}`); legendY += 12;
  } else {
    _legendItem(ctx, legendX, legendY, primaryColor, curveName);
  }
}

function _legendItem(ctx, x, y, color, label, dash) {
  ctx.strokeStyle = color;
  ctx.lineWidth = dash ? 1 : 2;
  ctx.setLineDash(dash || []);
  ctx.globalAlpha = dash ? 0.5 : 0.9;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 16, y); ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#c8c8d8";
  ctx.fillText(label, x + 20, y + 3);
}

// ── Arg Index Map ────────────────────────────────────────
// Relative indices → param keys (matches blueprint layout)

const ARG_MAP = {
  0: "enable", 1: "curveName", 2: "floor_m", 3: "ceil_m",
  4: "decay_start", 5: "decay_rate",
  6: "fractal_base", 7: "fractal_amp",
  8: "thorns", 9: "strength", 10: "sharpness", 11: "layout", 12: "jitter", 13: "seed",
  14: "high", 15: "low", 16: "period", 17: "smooth",
  18: "grief_amplitude", 19: "grief_decay", 20: "grief_frequency", 21: "grief_phase", 22: "grief_baseline",
  23: "blend_enable", 24: "blend_curve", 25: "blend_weight",
};

function readAllValues(controls) {
  const vals = {};
  for (const [relIdx, el] of Object.entries(controls)) {
    const key = ARG_MAP[relIdx];
    if (!key) continue;
    if (el.type === "checkbox") vals[key] = el.checked;
    else if (el.type === "range" || el.type === "number") vals[key] = parseFloat(el.value);
    else vals[key] = el.value;
  }
  return vals;
}

function buildChartParams(vals) {
  const steps = parseInt(document.getElementById("paramSteps")?.value) || 30;
  const baseCfg = parseFloat(document.getElementById("paramCFG")?.value) || 7.0;

  const kw = {};
  // Copy all numeric/string params into kw
  for (const [k, v] of Object.entries(vals)) {
    if (k !== "enable" && k !== "curveName" && k !== "floor_m" && k !== "ceil_m" &&
        k !== "blend_enable" && k !== "blend_curve" && k !== "blend_weight") {
      kw[k] = v;
    }
  }

  return {
    curveName: vals.curveName || "Decay",
    floorM: vals.floor_m ?? 0.55,
    ceilM: vals.ceil_m ?? 1.65,
    baseCfg,
    steps,
    kw,
    blendEnabled: !!vals.blend_enable,
    blendCurve: vals.blend_curve || "Grief",
    blendWeight: vals.blend_weight ?? 0.3,
  };
}

// ── Hooks Export ──────────────────────────────────────────

let _canvas = null;
let _controls = null;

function redraw() {
  if (!_canvas || !_controls) return;
  const vals = readAllValues(_controls);
  const params = buildChartParams(vals);
  drawChart(_canvas, params);
}

export default {
  onRender(container, controls, ext) {
    _controls = controls;

    // Build chart wrapper
    const wrap = document.createElement("div");
    wrap.className = "ext-control";
    wrap.innerHTML = `<div class="ext-control-label">Curve Preview</div>`;

    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width:100%;height:180px;border-radius:4px;display:block;margin-top:4px;";
    wrap.appendChild(canvas);
    container.appendChild(wrap);
    _canvas = canvas;

    // Listen to Studio's Steps and CFG inputs for live sync
    const stepsEl = document.getElementById("paramSteps");
    const cfgEl = document.getElementById("paramCFG");
    if (stepsEl) { stepsEl.addEventListener("input", redraw); stepsEl.addEventListener("change", redraw); }
    if (cfgEl) { cfgEl.addEventListener("input", redraw); cfgEl.addEventListener("change", redraw); }

    // Initial draw (slight delay for DOM measurement)
    requestAnimationFrame(redraw);
  },

  onChange(index, value, allValues, container) {
    redraw();
  },
};
