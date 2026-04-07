/**
 * Forge Studio — Show Me System
 * by ToxicHost & Moritz
 *
 * Interactive tutorials launched from Codex. Each tutorial:
 * 1. Switches to Studio tab
 * 2. Creates a tutorial document via StudioDocs (or reuses canvas)
 * 3. Sets up canvas state (draws shapes, loads images, sets prompts)
 * 4. Runs a walkthrough via StudioTour
 * 5. Optionally closes the tutorial doc on completion
 *
 * Tutorials register by Codex entry ID. Codex checks StudioShowMe.has(id)
 * and renders a "Show Me" button on matching entries.
 */
(function () {
"use strict";

var TAG = "[ShowMe]";
var _tutorials = {};
var _activeTutorialDoc = -1; // doc index of active tutorial, or -1

// ========================================================================
// REGISTRATION
// ========================================================================
// Tutorials register with a unique tutorialId and an entryId that maps
// to a Codex entry. Multiple tutorials can share one entryId (e.g.
// controlnet_canny, controlnet_openpose both map to "controlnet").

function _register(tutorialId, config) {
  _tutorials[tutorialId] = {
    entryId: config.entryId || tutorialId,
    label: config.label || "Show Me",
    run: config.run
  };
}

function has(entryId) {
  for (var k in _tutorials) {
    if (_tutorials[k].entryId === entryId) return true;
  }
  return false;
}

function forEntry(entryId) {
  var result = [];
  for (var k in _tutorials) {
    if (_tutorials[k].entryId === entryId) {
      result.push({ id: k, label: _tutorials[k].label });
    }
  }
  return result;
}

// ========================================================================
// EXECUTION
// ========================================================================

function run(tutorialId) {
  var tut = _tutorials[tutorialId];
  if (!tut) { console.warn(TAG, "No tutorial for", tutorialId); return; }

  // Switch to Studio tab
  if (window.StudioModules) {
    StudioModules.activateStudio();
  }

  // Cancel any active tour
  if (window.StudioTour && StudioTour.active) {
    StudioTour.active._forceCancel();
  }

  // Small delay for tab switch to render
  setTimeout(function () {
    try {
      tut.run();
    } catch (e) {
      console.error(TAG, "Tutorial error:", entryId, e);
    }
  }, 200);
}

// ========================================================================
// HELPERS
// ========================================================================

function _createTutorialDoc(name) {
  if (!window.StudioDocs) { console.warn(TAG, "StudioDocs not available"); return -1; }
  var idx = StudioDocs.newDoc("Tutorial: " + name);
  _activeTutorialDoc = idx;
  return idx;
}

function _closeTutorialDoc() {
  if (_activeTutorialDoc >= 0 && window.StudioDocs) {
    // Mark not dirty so close doesn't prompt
    var doc = StudioDocs.docs[_activeTutorialDoc];
    if (doc) doc._canvasDirty = false;
    StudioDocs.closeDoc(_activeTutorialDoc);
    _activeTutorialDoc = -1;
  }
}

// Draw a simple colored rectangle on a layer
function _drawRect(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

// Draw a simple scene on the reference layer (colored shapes for tutorials)
function _drawTutorialScene() {
  var S = window.StudioCore.state;
  var ref = S.layers.find(function (l) { return l.type === "reference"; });
  if (!ref) return;

  var W = S.W, H = S.H;
  var ctx = ref.ctx;

  // Sky gradient
  var grad = ctx.createLinearGradient(0, 0, 0, H * 0.6);
  grad.addColorStop(0, "#2c3e6b");
  grad.addColorStop(1, "#6b88b5");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H * 0.6);

  // Ground
  ctx.fillStyle = "#4a6741";
  ctx.fillRect(0, H * 0.6, W, H * 0.4);

  // Sun
  ctx.fillStyle = "#f0c040";
  ctx.beginPath();
  ctx.arc(W * 0.75, H * 0.2, 40, 0, Math.PI * 2);
  ctx.fill();

  // Tree trunk
  ctx.fillStyle = "#5c3a1e";
  ctx.fillRect(W * 0.2 - 10, H * 0.35, 20, H * 0.25);

  // Tree canopy
  ctx.fillStyle = "#2d5a1e";
  ctx.beginPath();
  ctx.arc(W * 0.2, H * 0.3, 45, 0, Math.PI * 2);
  ctx.fill();

  // House body
  ctx.fillStyle = "#c4956a";
  ctx.fillRect(W * 0.5, H * 0.4, 100, 80);

  // House roof
  ctx.fillStyle = "#8b3a3a";
  ctx.beginPath();
  ctx.moveTo(W * 0.5 - 10, H * 0.4);
  ctx.lineTo(W * 0.5 + 50, H * 0.28);
  ctx.lineTo(W * 0.5 + 110, H * 0.4);
  ctx.closePath();
  ctx.fill();

  // Door
  ctx.fillStyle = "#5c3a1e";
  ctx.fillRect(W * 0.5 + 38, H * 0.48, 24, 32);

  // Window
  ctx.fillStyle = "#a8c8e8";
  ctx.fillRect(W * 0.5 + 15, H * 0.44, 18, 18);
  ctx.fillRect(W * 0.5 + 68, H * 0.44, 18, 18);
}

// ========================================================================
// TUTORIAL DEFINITIONS
// ========================================================================

// ── Core Workflow (beginner tour replay) ─────────────────────────────

_register("core_workflow", {
  label: "Show Me",
  run: function () {
    if (window.Education) {
      Education.reset();
      Education.showFirstRun();
    } else {
      if (window.showToast) showToast("Education system not available", "error");
    }
  }
});

_register("first_image_showme", {
  entryId: "first_image",
  label: "Show Me",
  run: function () {
    if (window.Education) {
      Education.reset();
      Education.showFirstRun();
    } else {
      if (window.showToast) showToast("Education system not available", "error");
    }
  }
});

// ── Inpainting ───────────────────────────────────────────────────────

_register("inpaint_basics", {
  label: "Basic Inpainting",
  run: function () {
    _createTutorialDoc("Inpainting");
    _drawTutorialScene();
    window.StudioCore.composite();
    window.StudioUI.redraw();
    window.StudioUI.renderLayerPanel();

    // Pre-fill prompt so generation doesn't choke on empty string
    var promptEl = document.getElementById("paramPrompt");
    if (promptEl) promptEl.value = "a full moon in a night sky, stars";

    StudioTour.create({
      id: "showme-inpaint",
      steps: [
        {
          id: "si_intro",
          text: "Here\u2019s a simple scene. Let\u2019s change part of it using <em>inpainting</em>.\n\nSee the sun in the sky? We\u2019re going to replace it with something else.",
          spotlight: null, advance: "click", btn: "Next",
          position: { bottom: "80px", left: "calc(50% - 190px)" }
        },
        {
          id: "si_mask",
          text: "Press <span class=\"cx-kbd\">Q</span> to enter mask mode. Your brush now paints a <em>red overlay</em> instead of color.\n\nPaint red over the sun. It doesn\u2019t need to be precise \u2014 just cover it.",
          spotlight: "#maskModeBtn", advance: "click", btn: "I\u2019ve masked the sun"
        },
        {
          id: "si_prompt",
          text: "A prompt has been pre-filled \u2014 \"a full moon in a night sky\" \u2014 but you can change it to whatever you want. The AI will only change the red area.",
          spotlight: "#paramPrompt", advance: "click", btn: "Next",
          focusTarget: "#paramPrompt"
        },
        {
          id: "si_generate",
          text: "Hit <em>Generate</em>. Only the masked area changes \u2014 the rest stays untouched.\n\nAfterward, press <span class=\"cx-kbd\">Q</span> to exit mask mode. Try different denoise values to see how much changes.",
          spotlight: "#genBtn", advance: "click", btn: "Got it"
        },
      ],
      persist: false, confirmCancel: false,
      onComplete: function () { console.log(TAG, "Inpaint tutorial complete"); },
      onCancel: function () {},
    }).start(0);
  }
});

// ── Regional Prompting ───────────────────────────────────────────────

_register("regional_prompting", {
  run: function () {
    _createTutorialDoc("Regional Prompting");
    window.StudioCore.composite();
    window.StudioUI.redraw();

    // Pre-fill main prompt
    var promptEl = document.getElementById("paramPrompt");
    if (promptEl) promptEl.value = "digital painting, detailed, dramatic lighting, high quality";

    StudioTour.create({
      id: "showme-regions",
      steps: [
        {
          id: "sr_intro",
          text: "Regional prompting lets you assign <em>different prompts to different areas</em> of your canvas.\n\nInstead of one description for the whole image, you can say \"forest on the left, city on the right.\"",
          spotlight: null, advance: "click", btn: "Next",
          position: { bottom: "80px", left: "calc(50% - 190px)" }
        },
        {
          id: "sr_add",
          text: "Scroll down in the Generate panel to the <em>Regions</em> section. Click the <strong>+</strong> button to add a region.\n\nA new region appears with a colored swatch and a prompt field.",
          spotlight: null, advance: "click", btn: "I added a region",
          position: { bottom: "80px", right: "340px" }
        },
        {
          id: "sr_paint",
          text: "Now paint on the canvas with the <em>brush</em> (<span class=\"cx-kbd\">B</span>). The region\u2019s color marks where this prompt applies.\n\nPaint the left half of the canvas, then type a prompt like \"dense forest, green trees\" in the region\u2019s prompt field.",
          spotlight: "#toolstrip", advance: "click", btn: "Next"
        },
        {
          id: "sr_second",
          text: "Add a <em>second region</em> with the <strong>+</strong> button. Paint the right half with the new color. Give it a different prompt like \"modern city skyline.\"\n\nThe <em>main prompt</em> (top box) has been pre-filled with a style \u2014 it sets the overall look for all regions.",
          spotlight: null, advance: "click", btn: "Next",
          position: { bottom: "80px", left: "calc(50% - 190px)" }
        },
        {
          id: "sr_generate",
          text: "Hit <em>Generate</em>. Each region gets its own content based on its prompt. Small regions work too \u2014 Studio\u2019s system is designed for this.\n\nRemember to clear regions when done \u2014 they persist until removed.",
          spotlight: "#genBtn", advance: "click", btn: "Got it"
        },
      ],
      persist: false, confirmCancel: false,
      onComplete: function () { console.log(TAG, "Regions tutorial complete"); },
      onCancel: function () {},
    }).start(0);
  }
});

// ── ControlNet ───────────────────────────────────────────────────────

_register("controlnet", {
  label: "Overview",
  run: function () {
    _createTutorialDoc("ControlNet");
    _drawTutorialScene();
    window.StudioCore.composite();
    window.StudioUI.redraw();
    window.StudioUI.renderLayerPanel();

    // Pre-fill a prompt so generation doesn't choke on empty string
    var promptEl = document.getElementById("paramPrompt");
    if (promptEl) promptEl.value = "a snowy village at night, northern lights, detailed, high quality";

    StudioTour.create({
      id: "showme-controlnet",
      steps: [
        {
          id: "sc_intro",
          text: "ControlNet uses the <em>structure</em> of an existing image to guide generation. Let\u2019s use this scene as our structural source.\n\nThe AI will follow the layout (where the sky is, where the ground is, where objects are) but create new content.",
          spotlight: null, advance: "click", btn: "Next",
          position: { bottom: "80px", left: "calc(50% - 190px)" }
        },
        {
          id: "sc_enable",
          text: "In the <em>Extensions</em> tab, find <strong>ControlNet Unit 1</strong>. Enable the checkbox.\n\nSet the <em>Preprocessor</em> and <em>Model</em> to a matching pair \u2014 for example, <strong>Canny</strong> preprocessor with a <strong>Canny</strong> model. Set <em>Source</em> to <strong>Canvas</strong>.\n\nPreprocessor and model must match in type AND architecture (SD1.5 vs SDXL).",
          spotlight: null, advance: "click", btn: "Next",
          position: { bottom: "80px", right: "340px" }
        },
        {
          id: "sc_prompt",
          text: "A prompt has been pre-filled for you, but you can change it to whatever you like. Describe what the image should <em>become</em> while keeping this layout.\n\nThe structural map preserves the spatial arrangement \u2014 where foreground and background are, where objects sit.",
          spotlight: "#paramPrompt", advance: "click", btn: "Next",
          focusTarget: "#paramPrompt"
        },
        {
          id: "sc_generate",
          text: "Hit <em>Generate</em>. The result follows the spatial structure of the original but with completely new content.\n\n<strong>Weight</strong> controls how strongly the structure guides (1.0 = full). <strong>Start/End</strong> controls which denoising steps it applies to \u2014 try 0.0\u20130.5 for looser structure.",
          spotlight: "#genBtn", advance: "click", btn: "Got it"
        },
      ],
      persist: false, confirmCancel: false,
      onComplete: function () { console.log(TAG, "ControlNet tutorial complete"); },
      onCancel: function () {},
    }).start(0);
  }
});

// ── Layers ───────────────────────────────────────────────────────────

_register("layers_basics", {
  run: function () {
    _createTutorialDoc("Layers");
    var S = window.StudioCore.state;
    var C = window.StudioCore;

    // Draw on reference layer
    var ref = S.layers.find(function (l) { return l.type === "reference"; });
    if (ref) {
      ref.ctx.fillStyle = "#e8dcc8";
      ref.ctx.fillRect(0, 0, S.W, S.H);
      _drawRect(ref.ctx, 100, 100, 200, 200, "#6b88b5");
    }

    // Draw on paint layer
    var paint = S.layers.find(function (l) { return l.type === "paint"; });
    if (paint) {
      _drawRect(paint.ctx, 200, 200, 200, 200, "#c04040");
    }

    C.composite();
    window.StudioUI.redraw();
    window.StudioUI.renderLayerPanel();

    StudioTour.create({
      id: "showme-layers",
      steps: [
        {
          id: "sl_intro",
          text: "This canvas has two layers. The <em>Background</em> layer has a blue square. <em>Layer 1</em> has a red square overlapping it.\n\nLayers are transparent sheets stacked on each other.",
          spotlight: "#layersList", advance: "click", btn: "Next",
          beforeShow: function () {
            var genTab = document.querySelector('[data-panel="generate"]');
            if (genTab) genTab.click();
            return new Promise(function (r) { setTimeout(r, 200); });
          }
        },
        {
          id: "sl_visibility",
          text: "Try clicking the <em>eye icon</em> on Layer 1 to hide it. The red square disappears, revealing the blue one underneath.\n\nClick it again to show it. This is how you control what\u2019s visible without deleting anything.",
          spotlight: "#layersList", advance: "click", btn: "Next"
        },
        {
          id: "sl_generation",
          text: "When you <em>Generate</em>, the result lands on the reference (bottom) layer. Your painting on upper layers is <strong>never overwritten</strong>.\n\nThis means you can always regenerate without losing your edits.",
          spotlight: null, advance: "click", btn: "Next",
          position: { bottom: "80px", left: "calc(50% - 190px)" }
        },
        {
          id: "sl_blend",
          text: "Each layer has <em>Opacity</em> and <em>Blend Mode</em>. Try changing Layer 1\u2019s blend mode to Multiply or Screen to see how it interacts with the layer below.\n\nExport the full stack as PSD via the <em>Export</em> button.",
          spotlight: "#layersList", advance: "click", btn: "Got it"
        },
      ],
      persist: false, confirmCancel: false,
      onComplete: function () { console.log(TAG, "Layers tutorial complete"); },
      onCancel: function () {},
    }).start(0);
  }
});

// ── Clone Stamp ──────────────────────────────────────────────────────

_register("tool_clone", {
  run: function () {
    _createTutorialDoc("Clone Stamp");
    _drawTutorialScene();

    // Add an "unwanted" object to remove
    var S = window.StudioCore.state;
    var ref = S.layers.find(function (l) { return l.type === "reference"; });
    if (ref) {
      ref.ctx.fillStyle = "#ff00ff";
      ref.ctx.fillRect(S.W * 0.4, S.H * 0.65, 30, 30);
    }

    window.StudioCore.composite();
    window.StudioUI.redraw();
    window.StudioUI.renderLayerPanel();

    StudioTour.create({
      id: "showme-clone",
      steps: [
        {
          id: "scl_intro",
          text: "See the pink square on the ground? We\u2019ll remove it using the <em>Clone Stamp</em>.\n\nThis tool copies pixels from one area and paints them over another \u2014 perfect for removing unwanted objects.",
          spotlight: null, advance: "click", btn: "Next",
          position: { bottom: "80px", left: "calc(50% - 190px)" }
        },
        {
          id: "scl_select",
          text: "Press <span class=\"cx-kbd\">K</span> to select the Clone Stamp tool.",
          spotlight: "#toolstrip", advance: "click", btn: "Next"
        },
        {
          id: "scl_source",
          text: "Now hold <span class=\"cx-kbd\">Alt</span> and click on a <em>clean area</em> of green ground near the pink square. This sets your <strong>source point</strong> \u2014 where the clone copies from.",
          spotlight: null, advance: "click", btn: "I set the source",
          position: { bottom: "80px", left: "calc(50% - 190px)" }
        },
        {
          id: "scl_paint",
          text: "Now paint directly over the pink square. The tool copies green ground from the source point, covering the pink.\n\nIf the clone starts picking up wrong content, <span class=\"cx-kbd\">Alt+Click</span> a new source and keep going.",
          spotlight: null, advance: "click", btn: "Got it",
          position: { bottom: "80px", left: "calc(50% - 190px)" }
        },
      ],
      persist: false, confirmCancel: false,
      onComplete: function () { console.log(TAG, "Clone stamp tutorial complete"); },
      onCancel: function () {},
    }).start(0);
  }
});

// ── Transform & Warp ─────────────────────────────────────────────────

_register("tool_transform", {
  run: function () {
    _createTutorialDoc("Transform & Warp");
    var S = window.StudioCore.state;
    var paint = S.layers.find(function (l) { return l.type === "paint"; });
    if (paint) {
      // Draw a star shape to transform
      var cx = S.W / 2, cy = S.H / 2, or = 80, ir = 35;
      paint.ctx.fillStyle = "#e04040";
      paint.ctx.beginPath();
      for (var i = 0; i < 10; i++) {
        var r = i % 2 === 0 ? or : ir;
        var a = (Math.PI * 2 * i / 10) - Math.PI / 2;
        if (i === 0) paint.ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
        else paint.ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
      }
      paint.ctx.closePath();
      paint.ctx.fill();
    }

    window.StudioCore.composite();
    window.StudioUI.redraw();
    window.StudioUI.renderLayerPanel();

    StudioTour.create({
      id: "showme-transform",
      steps: [
        {
          id: "st_intro",
          text: "Here\u2019s a shape on the canvas. Press <span class=\"cx-kbd\">V</span> to activate the <em>Transform</em> tool.\n\nDrag the handles to resize, drag inside to move, and rotate from the corners.",
          spotlight: "#toolstrip", advance: "click", btn: "Next"
        },
        {
          id: "st_basic",
          text: "Try the basics: drag a corner handle to resize. Hold <span class=\"cx-kbd\">Shift</span> to constrain proportions. Drag inside to reposition.\n\n<span class=\"cx-kbd\">Enter</span> applies the transform. <span class=\"cx-kbd\">Escape</span> cancels.",
          spotlight: null, advance: "click", btn: "Next",
          position: { bottom: "80px", left: "calc(50% - 190px)" }
        },
        {
          id: "st_warp",
          text: "In the context bar, you\u2019ll see <em>warp mode buttons</em>:\n\n\u2022 <strong>Affine</strong> \u2014 free deformation with control points\n\u2022 <strong>Similitude</strong> \u2014 scale + rotate only (no skew)\n\u2022 <strong>Rigid</strong> \u2014 minimal distortion, natural repositioning\n\u2022 <strong>Perspective</strong> \u2014 four-corner pin\n\nTry each one to see how they differ.",
          spotlight: null, advance: "click", btn: "Got it",
          position: { bottom: "80px", left: "calc(50% - 190px)" }
        },
      ],
      persist: false, confirmCancel: false,
      onComplete: function () { console.log(TAG, "Transform tutorial complete"); },
      onCancel: function () {},
    }).start(0);
  }
});

// ── Canvas Routing ───────────────────────────────────────────────────

_register("canvas_routing", {
  run: function () {
    _createTutorialDoc("Canvas Routing");
    window.StudioCore.composite();
    window.StudioUI.redraw();

    // Pre-fill prompt so generation doesn't choke on empty string
    var promptEl = document.getElementById("paramPrompt");
    if (promptEl) promptEl.value = "a colorful landscape, digital painting, detailed";

    StudioTour.create({
      id: "showme-routing",
      steps: [
        {
          id: "scr_blank",
          text: "This is a <em>blank canvas</em>. If you hit Generate right now, Studio runs <strong>txt2img</strong> \u2014 generating from scratch based only on your prompt.\n\nNo mode selection needed. The canvas state IS the mode.",
          spotlight: null, advance: "click", btn: "Next",
          position: { bottom: "80px", left: "calc(50% - 190px)" }
        },
        {
          id: "scr_content",
          text: "Now paint something on the canvas \u2014 anything. A scribble, a shape, a splash of color.\n\nOnce there are pixels on the canvas, Generate switches to <strong>img2img</strong> automatically. The AI works <em>with</em> what\u2019s there. <em>Denoise</em> controls how much it changes.",
          spotlight: "#toolstrip", advance: "click", btn: "I painted something"
        },
        {
          id: "scr_mask",
          text: "Now press <span class=\"cx-kbd\">Q</span> to enter mask mode. Paint a red overlay over part of your content.\n\nWith a mask present, Generate switches to <strong>inpainting</strong> \u2014 only the masked area changes. Everything else stays untouched.\n\nThree modes, zero toggles. The pixels decide.",
          spotlight: "#maskModeBtn", advance: "click", btn: "Got it"
        },
      ],
      persist: false, confirmCancel: false,
      onComplete: function () { console.log(TAG, "Canvas routing tutorial complete"); },
      onCancel: function () {},
    }).start(0);
  }
});

// ── ControlNet: Canny ────────────────────────────────────────────────

_register("controlnet_canny", {
  entryId: "controlnet",
  label: "Canny (Edges)",
  run: function () {
    _createTutorialDoc("ControlNet: Canny");
    _drawTutorialScene();
    window.StudioCore.composite();
    window.StudioUI.redraw();
    window.StudioUI.renderLayerPanel();

    var promptEl = document.getElementById("paramPrompt");
    if (promptEl) promptEl.value = "a winter village at night, snow covered roofs, warm window light, high quality";

    StudioTour.create({
      id: "showme-cn-canny",
      steps: [
        {
          id: "cnc_intro",
          text: "<em>Canny</em> extracts edge lines from your image. The AI follows those edges while generating new content \u2014 maintaining architectural layouts, linework, and structural outlines.",
          spotlight: null, advance: "click", btn: "Next",
          position: { bottom: "80px", left: "calc(50% - 190px)" }
        },
        {
          id: "cnc_setup",
          text: "In the <em>Extensions</em> tab:\n\n1. Enable <strong>ControlNet Unit 1</strong>\n2. Set Preprocessor to <strong>Canny</strong>\n3. Set Model to a <strong>Canny</strong> ControlNet model\n4. Set Source to <strong>Canvas</strong>\n\nPreprocessor and model must both be Canny, and match your checkpoint architecture (SD1.5 or SDXL).",
          spotlight: null, advance: "click", btn: "Next",
          position: { bottom: "80px", right: "340px" }
        },
        {
          id: "cnc_generate",
          text: "A prompt has been pre-filled. Hit <em>Generate</em> \u2014 the result follows the edges of the original scene (house outline, tree shape, horizon line) but with completely new colors, textures, and content.\n\nLower the <strong>Weight</strong> for looser edge following. Try <strong>Start/End 0.0\u20130.5</strong> for structural guidance that fades during detail refinement.",
          spotlight: "#genBtn", advance: "click", btn: "Got it"
        },
      ],
      persist: false, confirmCancel: false,
      onComplete: function () { console.log(TAG, "Canny tutorial complete"); },
      onCancel: function () {},
    }).start(0);
  }
});

// ── ControlNet: OpenPose ─────────────────────────────────────────────

_register("controlnet_openpose", {
  entryId: "controlnet",
  label: "OpenPose (Poses)",
  run: function () {
    _createTutorialDoc("ControlNet: OpenPose");

    // Draw a simple figure for pose detection
    var S = window.StudioCore.state;
    var ref = S.layers.find(function (l) { return l.type === "reference"; });
    if (ref) {
      var ctx = ref.ctx, W = S.W, H = S.H;
      ctx.fillStyle = "#c8d8e8"; ctx.fillRect(0, 0, W, H);
      // Simple stick figure
      ctx.strokeStyle = "#333"; ctx.lineWidth = 4; ctx.lineCap = "round";
      var cx = W / 2, headY = H * 0.2;
      // Head
      ctx.beginPath(); ctx.arc(cx, headY, 20, 0, Math.PI * 2); ctx.stroke();
      // Torso
      ctx.beginPath(); ctx.moveTo(cx, headY + 20); ctx.lineTo(cx, H * 0.55); ctx.stroke();
      // Arms
      ctx.beginPath(); ctx.moveTo(cx - 60, H * 0.35); ctx.lineTo(cx, H * 0.3); ctx.lineTo(cx + 70, H * 0.4); ctx.stroke();
      // Legs
      ctx.beginPath(); ctx.moveTo(cx - 40, H * 0.75); ctx.lineTo(cx, H * 0.55); ctx.lineTo(cx + 45, H * 0.78); ctx.stroke();
    }

    window.StudioCore.composite();
    window.StudioUI.redraw();
    window.StudioUI.renderLayerPanel();

    var promptEl = document.getElementById("paramPrompt");
    if (promptEl) promptEl.value = "a woman standing, casual outfit, park background, natural lighting, high quality";

    StudioTour.create({
      id: "showme-cn-openpose",
      steps: [
        {
          id: "cnp_intro",
          text: "<em>OpenPose</em> detects body poses \u2014 the position of head, arms, legs, and joints. The AI generates a new character following that exact pose.\n\nHere\u2019s a simple figure. OpenPose will extract its pose.",
          spotlight: null, advance: "click", btn: "Next",
          position: { bottom: "80px", left: "calc(50% - 190px)" }
        },
        {
          id: "cnp_setup",
          text: "In the <em>Extensions</em> tab:\n\n1. Enable <strong>ControlNet Unit 1</strong>\n2. Set Preprocessor to <strong>OpenPose</strong>\n3. Set Model to an <strong>OpenPose</strong> ControlNet model\n4. Set Source to <strong>Canvas</strong>\n\nThe preprocessor detects the pose skeleton. The model uses it to guide generation.",
          spotlight: null, advance: "click", btn: "Next",
          position: { bottom: "80px", right: "340px" }
        },
        {
          id: "cnp_generate",
          text: "Hit <em>Generate</em>. The result shows a new character in the same pose as the figure.\n\nOpenPose is great for: maintaining specific poses, transferring poses from reference photos, generating consistent character positions across images.\n\nYou can also use a real photo as the source \u2014 set Source to <strong>Upload</strong> instead of Canvas.",
          spotlight: "#genBtn", advance: "click", btn: "Got it"
        },
      ],
      persist: false, confirmCancel: false,
      onComplete: function () { console.log(TAG, "OpenPose tutorial complete"); },
      onCancel: function () {},
    }).start(0);
  }
});

// ── ControlNet: Depth ────────────────────────────────────────────────

_register("controlnet_depth", {
  entryId: "controlnet",
  label: "Depth (Layout)",
  run: function () {
    _createTutorialDoc("ControlNet: Depth");
    _drawTutorialScene();
    window.StudioCore.composite();
    window.StudioUI.redraw();
    window.StudioUI.renderLayerPanel();

    var promptEl = document.getElementById("paramPrompt");
    if (promptEl) promptEl.value = "an alien landscape, bioluminescent plants, purple sky, sci-fi, detailed";

    StudioTour.create({
      id: "showme-cn-depth",
      steps: [
        {
          id: "cnd_intro",
          text: "<em>Depth</em> extracts a depth map \u2014 what\u2019s close vs far. The AI preserves the spatial arrangement (foreground objects stay in front, background stays behind) while creating entirely new content.",
          spotlight: null, advance: "click", btn: "Next",
          position: { bottom: "80px", left: "calc(50% - 190px)" }
        },
        {
          id: "cnd_setup",
          text: "In the <em>Extensions</em> tab:\n\n1. Enable <strong>ControlNet Unit 1</strong>\n2. Set Preprocessor to <strong>Depth</strong> (or Depth Anything)\n3. Set Model to a <strong>Depth</strong> ControlNet model\n4. Set Source to <strong>Canvas</strong>\n\n<em>Note:</em> Some Depth preprocessors require compatible GPU drivers. If you get an error, try <strong>Canny</strong> instead.",
          spotlight: null, advance: "click", btn: "Next",
          position: { bottom: "80px", right: "340px" }
        },
        {
          id: "cnd_generate",
          text: "Hit <em>Generate</em>. The house, tree, and ground stay in their spatial positions but become entirely new content.\n\nDepth is ideal for: scene reimagination, style transfer while keeping composition, maintaining spatial relationships in complex scenes.",
          spotlight: "#genBtn", advance: "click", btn: "Got it"
        },
      ],
      persist: false, confirmCancel: false,
      onComplete: function () { console.log(TAG, "Depth tutorial complete"); },
      onCancel: function () {},
    }).start(0);
  }
});

// ── Soft Inpainting ──────────────────────────────────────────────────

_register("soft_inpainting", {
  entryId: "inpaint_basics",
  label: "Soft Inpainting",
  run: function () {
    _createTutorialDoc("Soft Inpainting");
    _drawTutorialScene();
    window.StudioCore.composite();
    window.StudioUI.redraw();
    window.StudioUI.renderLayerPanel();

    var promptEl = document.getElementById("paramPrompt");
    if (promptEl) promptEl.value = "a castle tower, stone walls, medieval, detailed";

    StudioTour.create({
      id: "showme-softinpaint",
      steps: [
        {
          id: "ssi_intro",
          text: "Standard inpainting has a hard boundary \u2014 inside the mask changes, outside doesn\u2019t. <em>Soft Inpainting</em> adds smooth blending at the boundary for more natural transitions.\n\nLet\u2019s try it. First, press <span class=\"cx-kbd\">Q</span> and mask an area \u2014 paint over the house.",
          spotlight: "#maskModeBtn", advance: "click", btn: "I\u2019ve masked the house"
        },
        {
          id: "ssi_enable",
          text: "Find <em>Soft Inpainting</em> in the Generate panel (it appears when mask mode is active). Enable the checkbox.\n\nYou\u2019ll see six parameters. Here\u2019s what matters most:\n\n\u2022 <strong>Preservation</strong> \u2014 how much the original is kept outside the mask. Higher = less change.\n\u2022 <strong>Transition Contrast</strong> \u2014 how sharp the blend edge is. Lower = softer blend.",
          spotlight: null, advance: "click", btn: "Next",
          position: { bottom: "80px", right: "340px" }
        },
        {
          id: "ssi_generate",
          text: "Hit <em>Generate</em> and compare the result to standard inpainting (disable Soft Inpainting and regenerate with the same mask to compare).\n\nSoft Inpainting works best with <em>feathered masks</em> \u2014 use a soft brush (low hardness) to paint your mask for the best blending.\n\nThe other parameters (Schedule Bias, Mask Influence, Difference Threshold/Contrast) are fine at defaults until you need specific control.",
          spotlight: "#genBtn", advance: "click", btn: "Got it"
        },
      ],
      persist: false, confirmCancel: false,
      onComplete: function () { console.log(TAG, "Soft inpainting tutorial complete"); },
      onCancel: function () {},
    }).start(0);
  }
});

// ── Radial Symmetry ──────────────────────────────────────────────────

_register("tool_radial_symmetry", {
  label: "Show Me",
  run: function () {
    _createTutorialDoc("Radial Symmetry");
    window.StudioCore.composite();
    window.StudioUI.redraw();

    StudioTour.create({
      id: "showme-radialsym",
      steps: [
        {
          id: "srs_intro",
          text: "Radial symmetry mirrors your brush strokes around a center point. Let\u2019s paint a mandala pattern.\n\nFirst, select the <em>Brush</em> tool (<span class=\"cx-kbd\">B</span>).",
          spotlight: "#toolstrip", advance: "click", btn: "Next"
        },
        {
          id: "srs_enable",
          text: "In the context bar (top of the canvas area), find the symmetry buttons (near the right side). Click the <strong>radial</strong> button (the starburst icon).\n\nSet the <em>axis count</em> \u2014 try <strong>6</strong> for a snowflake pattern or <strong>8</strong> for a mandala. More axes = more repetitions.",
          spotlight: null, advance: "click", btn: "Next",
          position: { top: "100px", left: "calc(50% - 190px)" }
        },
        {
          id: "srs_paint",
          text: "Now paint on the canvas. Every stroke is replicated around the center point.\n\nTry painting outward from the center, or in arcs. Even simple strokes create complex patterns.\n\nThe smudge tool also works with radial symmetry \u2014 each segment has its own independent smudge buffer.",
          spotlight: null, advance: "click", btn: "Got it",
          position: { bottom: "80px", left: "calc(50% - 190px)" }
        },
      ],
      persist: false, confirmCancel: false,
      onComplete: function () { console.log(TAG, "Radial symmetry tutorial complete"); },
      onCancel: function () {},
    }).start(0);
  }
});

// ── LoRA Browser ─────────────────────────────────────────────────────

_register("lora_browser", {
  entryId: "loras",
  label: "LoRA Browser",
  run: function () {
    StudioTour.create({
      id: "showme-loras",
      steps: [
        {
          id: "slb_intro",
          text: "The <em>LoRA Browser</em> lets you visually browse and insert LoRAs without typing the syntax manually.\n\nLook for the <strong>LORA</strong> button near the prompt box in the Generate panel \u2014 click it to open the browser.",
          spotlight: null, advance: "click", btn: "Next",
          position: { bottom: "80px", right: "340px" }
        },
        {
          id: "slb_browse",
          text: "The browser shows cards for each LoRA file in your <code>models/Lora/</code> folder. Cards display the name and <em>trigger words</em> (read from sidecar <code>.json</code> metadata files).\n\nUse the search bar to filter by name or trigger word.",
          spotlight: null, advance: "click", btn: "Next",
          position: { bottom: "80px", right: "340px" }
        },
        {
          id: "slb_insert",
          text: "Click a LoRA card to insert it into your prompt. The browser auto-inserts the <code>&lt;lora:name:weight&gt;</code> tag AND any trigger words at the preferred weight.\n\nYou can stack multiple LoRAs \u2014 just click more cards. Lower individual weights (0.5\u20130.7) when stacking to prevent conflicts.",
          spotlight: null, advance: "click", btn: "Got it",
          position: { bottom: "80px", right: "340px" }
        },
      ],
      persist: false, confirmCancel: false,
      onComplete: function () { console.log(TAG, "LoRA browser tutorial complete"); },
      onCancel: function () {},
    }).start(0);
  }
});

// ── Brush Dynamics ───────────────────────────────────────────────────

_register("brush_dynamics", {
  entryId: "tool_brush",
  label: "Brush Dynamics",
  run: function () {
    _createTutorialDoc("Brush Dynamics");
    window.StudioCore.composite();
    window.StudioUI.redraw();

    StudioTour.create({
      id: "showme-dynamics",
      steps: [
        {
          id: "sbd_intro",
          text: "The brush engine has a <em>dynamics panel</em> that controls advanced stroke behavior.\n\nSelect the <em>Brush</em> (<span class=\"cx-kbd\">B</span>) and look for the <strong>gear icon</strong> in the brush presets area below the context bar.",
          spotlight: "#toolstrip", advance: "click", btn: "Next"
        },
        {
          id: "sbd_panel",
          text: "The Brush Dynamics panel exposes:\n\n\u2022 <strong>Spacing</strong> \u2014 gap between brush stamps (lower = smoother, higher = dotted)\n\u2022 <strong>Size Jitter</strong> \u2014 random size variation per stamp\n\u2022 <strong>Opacity Jitter</strong> \u2014 random opacity variation\n\u2022 <strong>Scatter</strong> \u2014 random offset from stroke path\n\u2022 <strong>Rotation Jitter</strong> \u2014 random angle per stamp\n\u2022 <strong>Follow Stroke</strong> \u2014 stamps rotate to follow stroke direction",
          spotlight: null, advance: "click", btn: "Next",
          position: { top: "120px", left: "60px" }
        },
        {
          id: "sbd_try",
          text: "Try painting with different dynamics settings. High scatter + size jitter creates foliage and particle effects. High spacing creates dotted/stippled lines.\n\nThe <strong>Scatter</strong> preset is pre-configured with dynamics for textured spray effects. Each preset stores its own dynamics.",
          spotlight: null, advance: "click", btn: "Got it",
          position: { bottom: "80px", left: "calc(50% - 190px)" }
        },
      ],
      persist: false, confirmCancel: false,
      onComplete: function () { console.log(TAG, "Brush dynamics tutorial complete"); },
      onCancel: function () {},
    }).start(0);
  }
});

// ── Wildcards ────────────────────────────────────────────────────────

_register("wildcards_tutorial", {
  entryId: "wildcards",
  label: "Show Me",
  run: function () {
    StudioTour.create({
      id: "showme-wildcards",
      steps: [
        {
          id: "sw_intro",
          text: "Wildcards insert <em>random text</em> into your prompts for automatic variety. The syntax is <code>__name__</code> (double underscores).\n\nEach generation picks a different line from the matching text file.",
          spotlight: null, advance: "click", btn: "Next",
          position: { bottom: "80px", left: "calc(50% - 190px)" }
        },
        {
          id: "sw_browse",
          text: "Click the <strong>WILDCARD</strong> button near the prompt box to open the wildcard browser. This shows all your installed wildcard files.\n\nWildcard files live in <code>extensions/sd-dynamic-prompts/wildcards/</code>. Each <code>.txt</code> file is one wildcard \u2014 the filename becomes the name.",
          spotlight: null, advance: "click", btn: "Next",
          position: { bottom: "80px", right: "340px" }
        },
        {
          id: "sw_syntax",
          text: "Try typing in your prompt: <code>a __colors__ cat sitting on a __furniture__</code>\n\nEach generation replaces <code>__colors__</code> with a random line from <code>colors.txt</code> and <code>__furniture__</code> from <code>furniture.txt</code>.\n\n<strong>Folders work too:</strong> a file at <code>wildcards/animals/cats.txt</code> is used as <code>__animals/cats__</code>.",
          spotlight: "#paramPrompt", advance: "click", btn: "Next",
          focusTarget: "#paramPrompt"
        },
        {
          id: "sw_lexicon",
          text: "The <em>Wildcards</em> tab (in the main tab bar) provides a full wildcard editor \u2014 folder tree, file creation, inline editing, and preview.\n\nWildcards work in the negative prompt too. Common pattern: put your standard negatives in <code>neg4.txt</code> and use <code>__neg4__</code> instead of typing them every time.",
          spotlight: null, advance: "click", btn: "Got it",
          position: { bottom: "80px", left: "calc(50% - 190px)" }
        },
      ],
      persist: false, confirmCancel: false,
      onComplete: function () { console.log(TAG, "Wildcards tutorial complete"); },
      onCancel: function () {},
    }).start(0);
  }
});

// ========================================================================
// PUBLIC API
// ========================================================================

window.StudioShowMe = {
  has: has,
  forEntry: forEntry,
  run: run
};

console.log(TAG, "Show Me system loaded \u2014", Object.keys(_tutorials).length, "tutorials registered");

})();
