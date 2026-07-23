/*
 * prompt-targets.js — shared prompt-target registry
 *
 * Single source of truth for "which prompt field is the active insert/preview
 * target" across the LoRA Browser, Wildcard Browser, and TagComplete.
 *
 * Replaces the two duplicated `_trackPromptFocus()` loops (in lora-browser.js
 * and wildcard-browser.js) that an init-once race (`window._studioPromptTracker`)
 * froze to just [paramPrompt, paramNeg] — whichever browser initialized first
 * won, and neither ever tracked the ADetailer slot prompts or the runtime
 * regional prompt fields. As a result LoRA/wildcard insert (and the new preview)
 * silently fell back to the main prompt when the caret was in an AD-slot or
 * region field, even though autocomplete already worked there.
 *
 * Implementation: ONE document-level `focusin` listener records the last-focused
 * prompt target. Because it classifies elements by id / class / TagComplete
 * marker rather than by a static per-element registration, runtime-added fields
 * (regional prompts) are covered automatically with no re-registration and no
 * ordering hazard.
 */
(function () {
  "use strict";

  // Statically-known prompt surfaces. Regional prompt fields are matched by the
  // `.region-prompt` class instead (they are created/destroyed at runtime), and
  // anything TagComplete attaches to is matched by its `_tacAttached` marker.
  const STATIC_IDS = [
    "paramPrompt", "paramNeg",
    "paramAD1Prompt", "paramAD2Prompt", "paramAD3Prompt",
  ];

  const _extra = new WeakSet();   // elements registered explicitly via register()
  let _last = null;               // last-focused prompt target element

  function isTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.id && STATIC_IDS.indexOf(el.id) !== -1) return true;
    if (el.classList && el.classList.contains("region-prompt")) return true;
    if (el._tacAttached) return true;   // any field TagComplete attached to
    return _extra.has(el);
  }

  function register(el) {
    if (el && el.nodeType === 1) _extra.add(el);
  }

  // Resolve the field an insert/preview action should target right now:
  // the focused element if it is a prompt target, else the last one that was,
  // else the main prompt as a safe default.
  function getActiveTarget() {
    const ae = document.activeElement;
    if (isTarget(ae)) return ae;
    if (_last && document.contains(_last)) return _last;
    return document.getElementById("paramPrompt");
  }

  let _inited = false;
  function init() {
    if (_inited) return;
    _inited = true;
    document.addEventListener("focusin", function (e) {
      if (isTarget(e.target)) _last = e.target;
    });
    // Legacy flag: makes any stale `_trackPromptFocus()` copy early-return.
    window._studioPromptTracker = true;
  }

  window.PromptTargets = {
    init: init,
    register: register,
    isTarget: isTarget,
    getActiveTarget: getActiveTarget,
    getTargetTextarea: getActiveTarget,   // alias — the old browser-local name
    STATIC_IDS: STATIC_IDS,
  };

  // Back-compat: older code reads/writes window._studioLastPrompt directly.
  // Route it through the registry so both paths stay consistent.
  try {
    Object.defineProperty(window, "_studioLastPrompt", {
      configurable: true,
      get: function () { return getActiveTarget(); },
      set: function (v) { if (v && v.nodeType === 1) _last = v; },
    });
  } catch (_) { /* already defined by an older build — leave it */ }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
