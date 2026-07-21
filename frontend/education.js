/**
 * Forge Studio — Education System
 * by ToxicHost & Moritz
 *
 * Guided walkthrough + first-run experience.
 * Zero VRAM, zero network, zero performance impact.
 *
 * Uses StudioTour engine for walkthrough rendering and navigation.
 * Education defines step content, branching logic, and path selection.
 *
 * Paths:
 *   - Beginner: Progressive reveal walkthrough. Makes first image, then
 *     reveals controls in groups. Inpaint branch if Result->Canvas clicked.
 *   - Experienced: Spatial orientation tour. Full UI visible from start.
 *     Covers what's different about Studio vs other AI/art tools.
 */
"use strict";

var Education = (function () {
  // i18n helper. Step arrays are built lazily via get*() so _t() resolves
  // against the live locale at tour-start time (after I18N.ready).
  function _t(key, fallback, params) {
    return (window.I18N && window.I18N.t) ? window.I18N.t(key, fallback, params) : fallback;
  }

  var STORAGE_PREFIX = "studio-edu-";
  var _state = {
    tier: null, enabled: true, guidedStep: 0, guidedActive: false,
    generationCount: 0, flags: {}, dismissedHints: []
  };
  var _tour = null;

  // ========================================================================
  // STATE PERSISTENCE
  // ========================================================================

  function _load() {
    _state.tier = localStorage.getItem(STORAGE_PREFIX + "tier") || null;
    _state.enabled = localStorage.getItem(STORAGE_PREFIX + "enabled") !== "0";
    _state.guidedStep = parseInt(localStorage.getItem(STORAGE_PREFIX + "guided-step")) || 0;
    _state.guidedActive = localStorage.getItem(STORAGE_PREFIX + "guided-active") === "1";
    _state.generationCount = parseInt(localStorage.getItem(STORAGE_PREFIX + "gen-count")) || 0;
    try { _state.flags = JSON.parse(localStorage.getItem(STORAGE_PREFIX + "flags") || "{}"); } catch (e) { _state.flags = {}; }
    try { _state.dismissedHints = JSON.parse(localStorage.getItem(STORAGE_PREFIX + "dismissed") || "[]"); } catch (e) { _state.dismissedHints = []; }
  }

  function _save() {
    if (_state.tier) localStorage.setItem(STORAGE_PREFIX + "tier", _state.tier);
    localStorage.setItem(STORAGE_PREFIX + "enabled", _state.enabled ? "1" : "0");
    localStorage.setItem(STORAGE_PREFIX + "guided-step", _state.guidedStep);
    localStorage.setItem(STORAGE_PREFIX + "guided-active", _state.guidedActive ? "1" : "0");
    localStorage.setItem(STORAGE_PREFIX + "gen-count", _state.generationCount);
    localStorage.setItem(STORAGE_PREFIX + "flags", JSON.stringify(_state.flags));
    localStorage.setItem(STORAGE_PREFIX + "dismissed", JSON.stringify(_state.dismissedHints));
  }

  function _setFlag(n, v) { if (v === undefined) v = true; _state.flags[n] = v; _save(); }

  function _reset() {
    Object.keys(localStorage).filter(function (k) { return k.startsWith(STORAGE_PREFIX) || k.startsWith("st-tour-"); }).forEach(function (k) { localStorage.removeItem(k); });
    _state.tier = null; _state.enabled = true; _state.guidedStep = 0; _state.guidedActive = false;
    _state.generationCount = 0; _state.flags = {}; _state.dismissedHints = [];
  }

  // ========================================================================
  // REVEAL CLASSES
  // ========================================================================

  var ALL_REVEAL = [
    "edu-show-output", "edu-show-sampling", "edu-show-canvas", "edu-show-seed",
    "edu-show-tools", "edu-show-layers", "edu-show-model", "edu-show-chrome",
    "edu-show-inpaint", "edu-show-hires", "edu-show-adetailer"
  ];

  // ========================================================================
  // MODEL ACQUISITION BRANCH
  // ========================================================================

  function getModelBranch() {
    return [
      {
        id: "need_model",
        text: _t("education.tour.modelBranch.needModel.text", "Before we start, you need an AI <em>model</em> \u2014 the brain that generates images. You don\u2019t have one installed yet.\n\nHere\u2019s a good starter model to get going:\n<a href=\"https://pixeldrain.com/u/5pv797g8\" target=\"_blank\" rel=\"noopener\" style=\"color:var(--accent-bright);text-decoration:underline;\">Download ToxicHost\u2019s recommended model</a>\n\nOnce downloaded, put the file in your Forge folder:\n<code>models/Stable-diffusion/</code>\n\nDon\u2019t close Studio \u2014 just drop the file in that folder."),
        spotlight: null, reveal: ["edu-show-model"], advance: "click",
        btn: _t("education.tour.modelBranch.needModel.btn", "I\u2019ve put it in the folder")
      },
      {
        id: "refresh_models",
        text: _t("education.tour.modelBranch.refreshModels.text", "Now click the <em>refresh button</em> (\u21bb) next to the Model dropdown. Studio will scan for new models without needing a restart.\n\nOnce your model appears in the dropdown, select it and we\u2019ll get started."),
        spotlight: "#refreshModelsBtn", reveal: ["edu-show-model"],
        advance: function (next, nextBtn, tour) {
          var poll = setInterval(function () {
            if (window.State && window.State.models && window.State.models.length > 0) {
              clearInterval(poll);
              _setFlag("model_downloaded");
              next();
            }
          }, 1000);
          tour.addCleanup(function () { clearInterval(poll); });
        },
        btn: null
      },
    ];
  }

  // ========================================================================
  // BEGINNER — CORE WALKTHROUGH
  // ========================================================================

  function getCoreSteps() {
    return [
      // ── Make your first image (4 steps) ──
      {
        id: "welcome",
        text: _t("education.tour.core.welcome.text", "Welcome to <em>Forge Studio</em>.\n\nLet\u2019s make your first image. See the text box on the right? Describe something you\u2019d like to see \u2014 anything at all."),
        spotlight: "#paramPrompt", reveal: [],
        advance: { poll: function () { var p = document.getElementById("paramPrompt"); return p && p.value.trim().length > 0; } },
        focusTarget: "#paramPrompt", btn: null
      },
      {
        id: "hit_generate",
        text: _t("education.tour.core.hitGenerate.text", "Now hit <em>Generate</em>."),
        spotlight: "#genBtn", reveal: [],
        advance: { event: "click", selector: "#genBtn" }, btn: null
      },
      {
        id: "generating",
        text: _t("education.tour.core.generating.text", "Working on it \u2014 watch the progress bar."),
        spotlight: null, reveal: [],
        advance: function (next, nextBtn, tour) {
          var poll = setInterval(function () {
            if (window.State && !window.State.generating && window.State.sessionEntries && window.State.sessionEntries.length > 0) {
              clearInterval(poll);
              _setFlag("has_generated_first_image");
              next();
            }
          }, 500);
          tour.addCleanup(function () { clearInterval(poll); });
        },
        btn: null
      },
      {
        id: "first_image",
        text: _t("education.tour.core.firstImage.text", "That\u2019s yours. You just made that. No one else has this exact image.\n\nYou can put it on your canvas to paint over it \u2014 try clicking <em>Result \u2192 Canvas</em>. Or hit <em>Next</em> to see what else is here."),
        spotlight: "#outputSection", reveal: ["edu-show-output"],
        advance: function (next, nextBtn, tour) {
          if (nextBtn) nextBtn.addEventListener("click", function () { next(); });
          var rtc = document.getElementById("outputToCanvas");
          if (rtc) {
            var h = function () {
              _setFlag("used_result_to_canvas");
              for (var i = 0; i < tour.steps.length; i++) {
                if (tour.steps[i].id === "first_image") {
                  tour.spliceSteps(i, getInpaintBranch());
                  break;
                }
              }
              next();
            };
            rtc.addEventListener("click", h, { once: true });
            tour.addCleanup(function () { rtc.removeEventListener("click", h); });
          }
        },
        btn: _t("education.tour.core.firstImage.btn", "Next")
      },

      // ── Orient to the workspace (3 steps) ──
      {
        id: "reveal_settings",
        text: _t("education.tour.core.revealSettings.text", "This panel is where you shape your results. A few things worth knowing right now:\n\n\u2022 <em>Model</em> \u2014 the AI brain. Different models, completely different styles.\n\u2022 <em>Denoise</em> \u2014 how much the AI changes existing canvas content. Your most important dial.\n\nEverything else \u2014 CFG, Steps, Seed, Sampler \u2014 you\u2019ll learn by experimenting. The <em>Codex</em> tab explains each one when you\u2019re ready."),
        spotlight: "#panelSampling", reveal: ["edu-show-model", "edu-show-sampling", "edu-show-canvas", "edu-show-seed", "edu-show-hires", "edu-show-adetailer"], advance: "click",
        btn: _t("education.tour.core.revealSettings.btn", "Next")
      },
      {
        id: "reveal_workspace",
        text: _t("education.tour.core.revealWorkspace.text", "<em>Toolstrip</em> (left) \u2014 19 painting tools. Start with <span class=\"cx-kbd\">B</span> for brush and <span class=\"cx-kbd\">E</span> for eraser.\n\n<em>Layers</em> (right panel) \u2014 generated images land on the bottom layer, your painting goes above. Regenerating never destroys your painted edits.\n\nThis is a real canvas. Paint, generate, paint more, generate again."),
        spotlight: "#toolstrip", reveal: ["edu-show-tools", "edu-show-layers"], advance: "click",
        btn: _t("education.tour.core.revealWorkspace.btn", "Next")
      },
      {
        id: "complete",
        text: _t("education.tour.core.complete.text", "That\u2019s the core: <em>describe, generate, paint, iterate</em>.\n\nThe rest of the UI is now open. Check the <em>Codex</em> tab anytime \u2014 it has reference docs for every tool, setting, and feature.\n\nEnjoy making things."),
        spotlight: null, reveal: ["edu-show-chrome"], advance: "click",
        btn: _t("education.tour.core.complete.btn", "Let\u2019s go")
      },
    ];
  }

  // ========================================================================
  // BEGINNER — INPAINT BRANCH
  // ========================================================================

  function getInpaintBranch() {
    return [
      {
        id: "branch_paint",
        text: _t("education.tour.inpaint.paint.text", "Your image is on the canvas now \u2014 ready to work with.\n\nPick up the <em>brush</em> (<span class=\"cx-kbd\">B</span>) and paint something on top of it. Scribble, add a shape, change a color. Don\u2019t worry about being precise."),
        spotlight: "#toolstrip", reveal: ["edu-show-tools"], advance: "click",
        btn: _t("education.tour.inpaint.paint.btn", "I painted something"),
        position: { bottom: "60px", left: "calc(50% - 190px)"}
      },
      {
        id: "branch_regenerate",
        text: _t("education.tour.inpaint.regenerate.text", "Now hit <em>Generate</em> again.\n\nThe AI sees your paint strokes and incorporates them. It reinterprets the whole canvas with your edits as input \u2014 not just pasting paint on top.\n\nThe <em>Denoise</em> slider controls how much it changes. Lower = keep more of what\u2019s there."),
        spotlight: "#genBtn", reveal: ["edu-show-sampling"], advance: "click",
        btn: _t("education.tour.inpaint.regenerate.btn", "Next")
      },
      {
        id: "branch_masking",
        text: _t("education.tour.inpaint.masking.text", "What if you only want to change <em>part</em> of the image?\n\nPress <span class=\"cx-kbd\">Q</span> to enter mask mode. Your brush now paints a red overlay. The red tells the AI: \"only change this area.\"\n\nPaint the mask \u2192 write what should go there \u2192 Generate. Only the masked area changes. Press <span class=\"cx-kbd\">Q</span> again to exit. You\u2019ll use this constantly."),
        spotlight: "#maskModeBtn", reveal: [], advance: "click",
        btn: _t("education.tour.inpaint.masking.btn", "Next")
      },
    ];
  }

  // ========================================================================
  // EXPERIENCED — ORIENTATION TOUR
  // ========================================================================

  function getExperiencedSteps() {
    return [
      {
        id: "exp_layout",
        text: _t("education.tour.experienced.layout.text", "Quick orientation. <em>Toolstrip</em> on the left (19 painting tools). <em>Canvas</em> in the center \u2014 scroll to zoom, Space+drag to pan. <em>Panel</em> on the right with Generate, Extensions, and Settings tabs. <span class=\"cx-kbd\">\\</span> collapses it.\n\nContext bar above the canvas shows controls for the active tool."),
        spotlight: null, reveal: [], advance: "click",
        btn: _t("education.tour.experienced.layout.btn", "Next"),
        position: { bottom: "80px", left: "calc(50% - 190px)" }
      },
      {
        id: "exp_canvas_routing",
        text: _t("education.tour.experienced.canvasRouting.text", "No separate txt2img/img2img tabs. Studio checks the canvas and routes automatically:\n\n\u2022 <strong>Blank canvas</strong> \u2192 txt2img\n\u2022 <strong>Content on canvas</strong> \u2192 img2img\n\u2022 <strong>Mask painted</strong> \u2192 inpainting\n\nThe pixels are the source of truth. Paint something, erase it all, generate \u2014 that\u2019s txt2img because the canvas is blank. No mode toggles."),
        spotlight: null, reveal: [], advance: "click",
        btn: _t("education.tour.experienced.canvasRouting.btn", "Next"),
        position: { bottom: "80px", left: "calc(50% - 190px)" }
      },
      {
        id: "exp_canvas_ux",
        text: _t("education.tour.experienced.canvasUx.text", "A few things that work differently here:\n\n\u2022 Context bar values are <em>scrub labels</em> \u2014 drag horizontally to adjust, click to type a number.\n\u2022 Each tool <em>remembers its own settings</em> independently. Switch tools and back \u2014 settings preserved.\n\u2022 <span class=\"cx-kbd\">Shift+Drag</span> on canvas adjusts brush size (horizontal) and opacity (vertical).\n\u2022 <span class=\"cx-kbd\">Ctrl+Click</span> eyedrops from any tool without switching.\n\u2022 At 200%+ zoom, pixels render nearest-neighbor (crisp, not blurry)."),
        spotlight: null, reveal: [], advance: "click",
        btn: _t("education.tour.experienced.canvasUx.btn", "Next"),
        position: { bottom: "80px", left: "calc(50% - 190px)" }
      },
      {
        id: "exp_mask_regions",
        text: _t("education.tour.experienced.maskRegions.text", "<em>Mask mode</em> (<span class=\"cx-kbd\">Q</span>) uses the same brush engine \u2014 pressure, hardness, all of it. No separate mask canvas.\n\n<em>Regional prompting</em> is painted directly on the canvas. Add a region, paint its area with the region color, write a prompt. Uses pre-softmax attention bias, not output blending \u2014 small regions actually get their own content."),
        spotlight: null, reveal: [], advance: "click",
        btn: _t("education.tour.experienced.maskRegions.btn", "Next"),
        position: { bottom: "80px", left: "calc(50% - 190px)" }
      },
      {
        id: "exp_layers",
        text: _t("education.tour.experienced.layers.text", "Real layer stack with blend modes, opacity, and reordering. Sending results to canvas creates a <em>new layer</em> \u2014 never overwrites your work.\n\nGeneration results go to a reusable \"Gen Result\" layer. Your painted edits on other layers are always safe. Export the full stack as PSD."),
        spotlight: "#layersList", reveal: [], advance: "click",
        btn: _t("education.tour.experienced.layers.btn", "Next"),
        beforeShow: function () {
          var genTab = document.querySelector('[data-panel="generate"]');
          if (genTab) genTab.click();
          return new Promise(function (resolve) {
            setTimeout(function () {
              var el = document.getElementById("layersList");
              if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
              setTimeout(resolve, 300);
            }, 100);
          });
        }
      },
      {
        id: "exp_extras",
        text: _t("education.tour.experienced.extras.text", "<em>ControlNet</em> (2 units) can source from the canvas composite, active layer, or an upload. <em>ADetailer</em> (3 slots) runs automatically after generation.\n\n<em>Drag and drop</em> an image onto the canvas to load it \u2014 resizes canvas, imports metadata, creates a new layer.\n\nSave current settings as <em>workflow defaults</em> \u2014 persists server-side across sessions."),
        spotlight: null, reveal: [], advance: "click",
        btn: _t("education.tour.experienced.extras.btn", "Next"),
        position: { bottom: "80px", right: "340px" }
      },
      {
        id: "exp_shortcuts",
        text: _t("education.tour.experienced.shortcuts.text", "Key shortcuts to know:\n\n<span class=\"cx-kbd\">Q</span> Mask mode \u2022 <span class=\"cx-kbd\">B</span> Brush \u2022 <span class=\"cx-kbd\">E</span> Eraser \u2022 <span class=\"cx-kbd\">V</span> Transform\n<span class=\"cx-kbd\">[</span>/<span class=\"cx-kbd\">]</span> Brush size \u2022 <span class=\"cx-kbd\">Shift+Drag</span> Size + opacity\n<span class=\"cx-kbd\">Ctrl+Enter</span> Generate \u2022 <span class=\"cx-kbd\">\\</span> Toggle panel\n<span class=\"cx-kbd\">Ctrl+Z</span> Undo \u2022 <span class=\"cx-kbd\">Space+Drag</span> Pan \u2022 <span class=\"cx-kbd\">Scroll</span> Zoom\n\nFull list in the <em>Codex</em> tab (highlighted above) under Keyboard Shortcuts.\n\nYou\u2019re set. Go make something."),
        spotlight: null, reveal: [], advance: "click",
        btn: _t("education.tour.experienced.shortcuts.btn", "Let\u2019s go"),
        position: { bottom: "80px", left: "calc(50% - 190px)" },
        beforeShow: function () {
          var codexTab = document.querySelector('button[data-module="codex"]');
          if (codexTab) {
            codexTab.style.outline = "2px solid var(--accent-bright)";
            codexTab.style.outlineOffset = "2px";
            codexTab.style.borderRadius = "4px";
          }
        }
      },
    ];
  }

  // ========================================================================
  // FIRST-RUN MODAL
  // ========================================================================

  function _showFirstRun() {
    var overlay = document.createElement("div"); overlay.className = "edu-modal-overlay";
    overlay.innerHTML = '<div class="edu-modal">' +
      '<div class="edu-modal-brand"><em>FORGE</em>&ensp;<span class="edu-brand-studio">STUDIO</span></div>' +
      '<div class="edu-modal-subtitle" data-i18n="education.pathPicker.title">' + _t("education.pathPicker.title", "How would you like to get started?") + '</div>' +
      '<div class="edu-cards">' +
        '<div class="edu-card" data-tier="beginner">' +
          '<div class="edu-card-icon">\u2726</div>' +
          '<div class="edu-card-body">' +
            '<div class="edu-card-title" data-i18n="education.pathPicker.beginner.title">' + _t("education.pathPicker.beginner.title", "I\u2019m new to AI image generation") + '</div>' +
            '<div class="edu-card-desc" data-i18n="education.pathPicker.beginner.desc">' + _t("education.pathPicker.beginner.desc", "Walk me through making my first image and show me the tools.") + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="edu-card" data-tier="experienced">' +
          '<div class="edu-card-icon">\u26a1</div>' +
          '<div class="edu-card-body">' +
            '<div class="edu-card-title" data-i18n="education.pathPicker.experienced.title">' + _t("education.pathPicker.experienced.title", "I\u2019ve used Stable Diffusion, Photoshop, or similar tools") + '</div>' +
            '<div class="edu-card-desc" data-i18n="education.pathPicker.experienced.desc">' + _t("education.pathPicker.experienced.desc", "Show me where things are and what\u2019s different here.") + '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<button class="edu-skip-link" data-tier="skip_quiet" data-i18n="education.pathPicker.skip">' + _t("education.pathPicker.skip", "I\u2019ll figure it out on my own") + '</button>' +
    '</div>';
    overlay.querySelectorAll(".edu-card").forEach(function (c) {
      c.addEventListener("click", function () { _selectTier(c.dataset.tier); overlay.remove(); });
    });
    overlay.querySelector(".edu-skip-link").addEventListener("click", function () { _selectTier("skip"); overlay.remove(); });
    document.body.appendChild(overlay);
  }

  function _selectTier(tier) {
    _state.tier = tier; _state.guidedStep = 0; _state.guidedActive = false; _save();
    if (tier === "beginner") _startGuidedWalkthrough();
    else if (tier === "experienced") _startExperiencedTour();
  }

  // ========================================================================
  // BEGINNER WALKTHROUGH
  // ========================================================================

  function _tagCollapse() {
    var map = [
      ["panelSampling", "eduSamplingSection"],
      ["panelCanvas", "eduCanvasSection"],
      ["panelSeedBatch", "eduSeedSection"],
      ["panelHires", "eduHiresSection"],
      ["panelAD", "eduADetailerSection"]
    ];
    map.forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      if (el) { var s = el.closest(".collapse-section"); if (s) s.id = pair[1]; }
    });
  }

  function _openPanel() {
    var p = document.getElementById("panelRight");
    var b = document.getElementById("panelCollapseBtn");
    if (p && p.classList.contains("collapsed")) {
      p.classList.remove("collapsed");
      if (b) b.classList.remove("collapsed");
    }
    var genTab = document.querySelector('[data-panel="generate"]');
    if (genTab) genTab.click();
  }

  function _createBeginnerTour(steps) {
    return StudioTour.create({
      id: "beginner-walkthrough",
      steps: steps,
      persist: true,
      bodyClass: "edu-guided",
      confirmCancel: true,
      cancelPrompt: _t("education.cancelConfirm.walkthrough", "End the walkthrough? You can restart it anytime from Settings."),
      onComplete: _completeWalkthrough,
      onCancel: _completeWalkthrough,
    });
  }

  function _startGuidedWalkthrough() {
    _state.guidedActive = true;
    var steps = getCoreSteps();

    var hasModels = window.State && window.State.models && window.State.models.length > 0;
    if (!hasModels) {
      var modelBranch = getModelBranch();
      for (var i = modelBranch.length - 1; i >= 0; i--) {
        steps.unshift(modelBranch[i]);
      }
      _setFlag("needed_model_download");
      console.log("[Education] No models detected \u2014 model acquisition branch added");
    }

    _save();
    _tagCollapse();
    _openPanel();

    _tour = _createBeginnerTour(steps);
    _tour.start(0);
  }

  function _resumeWalkthrough() {
    var steps = getCoreSteps();

    if (_state.flags.needed_model_download && !_state.flags.model_downloaded) {
      var modelBranch = getModelBranch();
      for (var m = modelBranch.length - 1; m >= 0; m--) {
        steps.unshift(modelBranch[m]);
      }
    }

    if (_state.flags.used_result_to_canvas) {
      var fi = -1;
      for (var j = 0; j < steps.length; j++) {
        if (steps[j].id === "first_image") { fi = j; break; }
      }
      if (fi >= 0) {
        var inpaintBranch = getInpaintBranch();
        for (var k = 0; k < inpaintBranch.length; k++) {
          steps.splice(fi + 1 + k, 0, inpaintBranch[k]);
        }
      }
    }

    _tagCollapse();
    _openPanel();

    _tour = _createBeginnerTour(steps);
    _tour.start();
  }

  function _completeWalkthrough() {
    _state.guidedActive = false;
    _state.guidedStep = 999;
    _save();
    _tour = null;
    document.body.classList.remove("edu-guided");
    ALL_REVEAL.forEach(function (c) { document.body.classList.remove(c); });
    console.log("[Education] Walkthrough complete");
  }

  // ========================================================================
  // EXPERIENCED TOUR
  // ========================================================================

  function _clearCodexHighlight() {
    var codexTab = document.querySelector('button[data-module="codex"]');
    if (codexTab) { codexTab.style.outline = ""; codexTab.style.outlineOffset = ""; codexTab.style.borderRadius = ""; }
  }

  function _startExperiencedTour() {
    _tour = StudioTour.create({
      id: "experienced-tour",
      steps: getExperiencedSteps(),
      persist: false,
      bodyClass: null,
      confirmCancel: true,
      cancelPrompt: _t("tour.endConfirm", "End the tour? You can restart it anytime from Settings."),
      onComplete: function () { _clearCodexHighlight(); _tour = null; console.log("[Education] Experienced tour complete"); },
      onCancel: function () { _clearCodexHighlight(); _tour = null; },
    });
    _tour.start(0);
  }

  // ========================================================================
  // SETTINGS
  // ========================================================================

  function _injectSettings() {
    var sc = document.querySelector("#app-settings .settings-content"); if (!sc) return;
    var titles = sc.querySelectorAll(".setting-group-title"), ag = null;
    for (var i = 0; i < titles.length; i++) { if (titles[i].textContent.trim() === "Accessibility") { ag = titles[i]; break; } }
    var ib = ag ? ag.closest(".setting-group") : null;

    var g = document.createElement("div"); g.className = "setting-group";
    g.innerHTML = '<div class="setting-group-title" data-i18n="education.settings.title">' + _t("education.settings.title", "Education") + '</div>' +
      '<div class="edu-settings-row"><span class="setting-label" data-i18n="education.settings.currentPath">' + _t("education.settings.currentPath", "Current path") + '</span>' +
      '<span style="font-size:10px;color:var(--text-3);font-family:var(--mono);" id="eduCurrentTier">' + _tierLabel(_state.tier) + '</span></div>' +
      '<div style="display:flex;gap:6px;margin-top:6px;">' +
      '<button class="edu-reset-btn" id="eduRestartTour" data-i18n="education.settings.restartTour">' + _t("education.settings.restartTour", "Restart Tour") + '</button>' +
      '<button class="edu-reset-btn" id="eduChangePath" data-i18n="education.settings.changePath">' + _t("education.settings.changePath", "Change Path") + '</button></div>';
    if (ib) sc.insertBefore(g, ib); else sc.appendChild(g);

    g.querySelector("#eduRestartTour").addEventListener("click", function () {
      if (!_state.tier || _state.tier === "skip") {
        if (window.showToast) window.showToast(_t("education.toast.selectPath", "Select a path first"), "info");
        return;
      }
      if (_tour && _tour.isActive) _tour._forceCancel();

      if (_state.tier === "beginner") {
        var gt = document.querySelector('[data-panel="generate"]'); if (gt) gt.click();
        _state.guidedStep = 0; _state.guidedActive = true;
        delete _state.flags.used_result_to_canvas;
        delete _state.flags.needed_model_download;
        delete _state.flags.model_downloaded;
        _save();
        setTimeout(function () { _startGuidedWalkthrough(); }, 200);
      } else if (_state.tier === "experienced" || _state.tier === "ai_user" || _state.tier === "art_user") {
        setTimeout(function () { _startExperiencedTour(); }, 200);
      }
    });

    g.querySelector("#eduChangePath").addEventListener("click", function () {
      if (_tour && _tour.isActive) _tour._forceCancel();
      _tour = null;
      _reset(); _showFirstRun();
      var upd = setInterval(function () {
        if (_state.tier) { var l = g.querySelector("#eduCurrentTier"); if (l) l.textContent = _tierLabel(_state.tier); clearInterval(upd); }
      }, 500);
      setTimeout(function () { clearInterval(upd); }, 30000);
    });
  }

  function _tierLabel(t) {
    return { beginner: "Beginner", experienced: "Experienced", ai_user: "Experienced", skip: "Skipped" }[t] || "Not set";
  }

  // ========================================================================
  // GENERATION COUNTER
  // ========================================================================

  function _hookGeneration() {
    var was = false;
    setInterval(function () {
      if (window.State) {
        if (was && !window.State.generating && window.State.sessionEntries && window.State.sessionEntries.length > 0) {
          _state.generationCount++;
          _save();
        }
        was = window.State.generating;
      }
    }, 1000);
  }

  // ========================================================================
  // FIRST-ENCOUNTER TIPS
  // ========================================================================
  // Exactly three static callouts — Layers, Regions, Live — each shown once
  // on the first meaningful interaction and never again after dismissal.
  // Seen-state persists server-side via prefs key "education"
  // ({seen:{layers:true,...}}), so it survives reloads and Clear Storage.
  // Deliberately not a tour engine. Copy teaches workflow, not UI labels.

  var TIPS = {
    layers: {
      i18n: "education.tip.layers",
      fallback: "Generate, send to canvas, mask, and regenerate to composite elements — layers are for building images in passes, like a paint program.",
      codexId: "layers_basics"
    },
    regions: {
      i18n: "education.tip.regions",
      fallback: "Each region carries its own prompt inside a single generation — draw where something should go, describe it in that region's prompt, and generate once.",
      codexId: "regional_prompting"
    },
    live: {
      i18n: "education.tip.live",
      fallback: "Live is img2img over your canvas, not a scribble-to-image guide — low strength follows your sketch closely, higher strength takes liberties. Apply commits the result beneath your paint layer.",
      codexId: "live_painting"
    }
  };
  var _tipEl = null;

  function _tipSeen() {
    var edu = (window.Prefs && window.Prefs.get) ? (window.Prefs.get("education", null) || {}) : {};
    return (edu && typeof edu.seen === "object" && edu.seen) ? edu.seen : {};
  }

  function _markTipSeen(id) {
    if (!(window.Prefs && window.Prefs.set)) return;
    var edu = window.Prefs.get("education", null);
    if (!edu || typeof edu !== "object") edu = {};
    edu.seen = Object.assign({}, _tipSeen());
    edu.seen[id] = true;
    window.Prefs.set("education", edu);
  }

  function _dismissTip() {
    if (_tipEl) { _tipEl.remove(); _tipEl = null; }
  }

  function _showTip(spec) {
    _dismissTip();
    var el = document.createElement("div");
    el.className = "edu-tip";
    el.setAttribute("role", "note");
    var text = document.createElement("div");
    text.className = "edu-tip-text";
    text.textContent = _t(spec.i18n, spec.fallback);
    el.appendChild(text);
    var row = document.createElement("div");
    row.className = "edu-tip-actions";
    var learn = document.createElement("button");
    learn.className = "edu-tip-btn edu-tip-learn";
    learn.textContent = _t("education.tip.learnMore", "Learn more in Codex");
    learn.addEventListener("click", function () {
      var codexId = spec.codexId;
      _dismissTip();
      if (window.Codex && window.Codex.openEntry) window.Codex.openEntry(codexId);
    });
    row.appendChild(learn);
    var ok = document.createElement("button");
    ok.className = "edu-tip-btn edu-tip-dismiss";
    ok.textContent = _t("education.tip.gotIt", "Got it");
    ok.addEventListener("click", _dismissTip);
    row.appendChild(ok);
    el.appendChild(row);
    document.body.appendChild(el);
    _tipEl = el;
  }

  function maybeShowTip(id) {
    var spec = TIPS[id];
    if (!spec) return;
    if (_tipSeen()[id]) return;
    _markTipSeen(id); // fires exactly once per install, dismissed or not
    _showTip(spec);
  }

  // ========================================================================
  // INIT
  // ========================================================================

  function init() {
    // Warm the prefs cache so tip seen-state is available synchronously by
    // the time a first interaction can happen (cached promise; app.js
    // already awaits the same load at boot).
    try { if (window.Prefs && window.Prefs.load) window.Prefs.load(); } catch (e) {}
    if (!window.StudioTour) {
      console.error("[Education] StudioTour engine not loaded \u2014 walkthroughs disabled");
      _load();
      _hookGeneration();
      _injectSettings();
      if (!_state.tier) { setTimeout(function () { _showFirstRun(); }, 800); }
      return;
    }

    _load();
    console.log("[Education] Init \u2014 tier:", _state.tier, "guided:", _state.guidedActive, "step:", _state.guidedStep);
    _hookGeneration();
    _injectSettings();

    if (!_state.tier) {
      setTimeout(function () { _showFirstRun(); }, 800);
      return;
    }

    if (_state.tier === "beginner" && _state.guidedActive) {
      _resumeWalkthrough();
      return;
    }
  }

  // ========================================================================
  // PUBLIC API
  // ========================================================================

  return {
    init: init,
    get state() {
      return {
        tier: _state.tier, enabled: _state.enabled, guidedStep: _state.guidedStep,
        guidedActive: _state.guidedActive, generationCount: _state.generationCount,
        flags: Object.assign({}, _state.flags)
      };
    },
    setFlag: _setFlag,
    reset: _reset,
    showFirstRun: _showFirstRun,
    startExperiencedTour: _startExperiencedTour,
    maybeShowTip: maybeShowTip,
    get tour() { return _tour; },
  };
})();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", function () { setTimeout(function () { Education.init(); }, 500); });
} else {
  setTimeout(function () { Education.init(); }, 500);
}
window.Education = Education;
