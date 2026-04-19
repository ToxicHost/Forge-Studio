/**
 * Forge Studio — Tour Engine (StudioTour)
 * by ToxicHost & Moritz
 *
 * Generic walkthrough runner. Any module can create and run guided tours.
 * Handles spotlight highlighting, guide bubble, step advancement, persistence.
 *
 * Usage:
 *   var tour = StudioTour.create({
 *     id: "my-tour",
 *     steps: [
 *       { id: "step1", text: "Welcome!", btn: "Next", advance: "click" },
 *       { id: "step2", text: "Click this.", spotlight: "#myBtn", advance: "click-target" },
 *     ],
 *     onComplete: function() { console.log("done"); }
 *   });
 *   tour.start();
 *
 * Step format:
 *   {
 *     id:            string           — unique step identifier
 *     text:          string           — HTML content for guide bubble (\n → <br>)
 *     spotlight:     string|null      — CSS selector for highlighted element
 *     btn:           string|null      — primary button label (null = no button)
 *     advance:       string|object|fn — how this step advances (see below)
 *     reveal:        string[]         — CSS classes added to <body> (cumulative)
 *     beforeShow:    function|null    — called before step renders (can return Promise)
 *     position:      object|null      — custom {top,left,bottom,right} for guide
 *     focusTarget:   string|null      — CSS selector to focus after step renders
 *   }
 *
 * Advance types:
 *   "click"                          — advance when primary button is clicked
 *   "click-target"                   — advance when spotlight target is clicked
 *   { event, selector }              — advance on DOM event at selector
 *   { poll, interval? }              — advance when poll() returns true
 *   function(next, nextBtn, tour)    — custom: call next() to advance
 *   number                           — auto-advance after N ms
 */
(function () {
"use strict";

var TAG = "[Tour]";
var _active = null;

// ========================================================================
// TOUR CONSTRUCTOR
// ========================================================================

function Tour(opts) {
  this.id = opts.id;
  this.steps = (opts.steps || []).slice();
  this.persist = opts.persist !== false;
  this.onComplete = opts.onComplete || null;
  this.onCancel = opts.onCancel || null;
  this.onStep = opts.onStep || null;
  this.bodyClass = opts.bodyClass || null;
  this.confirmCancel = opts.confirmCancel !== false;
  this.cancelPrompt = opts.cancelPrompt || "End the tour? You can restart it anytime from Settings.";

  this._idx = -1;
  this._guide = null;
  this._spotlight = null;
  this._cleanups = [];
  this._escHandler = null;
  this._revealAll = _collectReveals(this.steps);
}

function _collectReveals(steps) {
  var set = [];
  for (var i = 0; i < steps.length; i++) {
    var r = steps[i].reveal;
    if (r) { for (var j = 0; j < r.length; j++) { if (set.indexOf(r[j]) < 0) set.push(r[j]); } }
  }
  return set;
}

// ── Persistence ──────────────────────────────────────────────────────────

var PERSIST_PREFIX = "st-tour-";

Tour.prototype._saveState = function () {
  if (!this.persist) return;
  localStorage.setItem(PERSIST_PREFIX + this.id, this._idx);
};

Tour.prototype._loadState = function () {
  if (!this.persist) return 0;
  return parseInt(localStorage.getItem(PERSIST_PREFIX + this.id)) || 0;
};

Tour.prototype._clearState = function () {
  localStorage.removeItem(PERSIST_PREFIX + this.id);
};

// ── Lifecycle ────────────────────────────────────────────────────────────

Tour.prototype.start = function (fromStep) {
  if (_active && _active !== this) _active._forceCancel();
  _active = this;

  var idx = (fromStep !== undefined) ? fromStep : this._loadState();
  if (idx >= this.steps.length) idx = 0;

  if (this.bodyClass) document.body.classList.add(this.bodyClass);

  // Escape key handler
  var self = this;
  this._escHandler = function (e) {
    if (e.key === "Escape" && _active === self) { e.preventDefault(); self.cancel(); }
  };
  document.addEventListener("keydown", this._escHandler);

  this._showStep(idx);
  console.log(TAG, "Started tour:", this.id, "at step", idx);
};

Tour.prototype.next = function () {
  this._showStep(this._idx + 1);
};

Tour.prototype.prev = function () {
  for (var i = this._idx - 1; i >= 0; i--) {
    if (this.steps[i].btn) { this._showStep(i); return; }
  }
};

Tour.prototype.goTo = function (idx) {
  this._showStep(idx);
};

Tour.prototype.cancel = function () {
  if (this.confirmCancel && !confirm(this.cancelPrompt)) return;
  this._forceCancel();
  if (this.onCancel) this.onCancel();
};

Tour.prototype._forceCancel = function () {
  this._teardown();
  _active = null;
};

Tour.prototype.complete = function () {
  this._teardown();
  this._clearState();
  console.log(TAG, "Completed tour:", this.id);
  if (this.onComplete) this.onComplete();
  _active = null;
};

Tour.prototype._teardown = function () {
  this._clearStepState();
  if (this._guide) { this._guide.remove(); this._guide = null; }
  if (this._escHandler) {
    document.removeEventListener("keydown", this._escHandler);
    this._escHandler = null;
  }
  if (this.bodyClass) document.body.classList.remove(this.bodyClass);
  var all = this._revealAll;
  for (var i = 0; i < all.length; i++) document.body.classList.remove(all[i]);
};

// ── Step Display ─────────────────────────────────────────────────────────

Tour.prototype._clearStepState = function () {
  if (this._spotlight) {
    this._spotlight.classList.remove("st-spotlight");
    this._spotlight = null;
  }
  for (var i = 0; i < this._cleanups.length; i++) this._cleanups[i]();
  this._cleanups = [];
};

Tour.prototype._showStep = function (idx) {
  if (idx >= this.steps.length) { this.complete(); return; }
  if (idx < 0) idx = 0;

  this._clearStepState();
  this._idx = idx;
  this._saveState();

  var step = this.steps[idx];

  // Reveal classes — accumulate through current step
  var all = this._revealAll;
  for (var i = 0; i < all.length; i++) document.body.classList.remove(all[i]);
  for (var j = 0; j <= idx; j++) {
    var r = this.steps[j].reveal;
    if (r) { for (var k = 0; k < r.length; k++) document.body.classList.add(r[k]); }
  }

  // beforeShow
  var self = this;
  var proceed = function () {
    // Spotlight
    if (step.spotlight) {
      var el = document.querySelector(step.spotlight);
      if (el) {
        self._spotlight = el;
        el.classList.add("st-spotlight");
        if (el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }

    self._renderGuide(step, idx);
    self._bindAdvance(step, idx);

    // Focus target
    if (step.focusTarget) {
      var ft = document.querySelector(step.focusTarget);
      if (ft) setTimeout(function () { ft.focus(); }, 100);
    }

    // Callback
    if (self.onStep) self.onStep(step, idx);
  };

  if (step.beforeShow) {
    try {
      var result = step.beforeShow();
      if (result && typeof result.then === "function") {
        result.then(proceed).catch(function (e) {
          console.error(TAG, "beforeShow error:", e);
          proceed();
        });
        return;
      }
    } catch (e) {
      console.error(TAG, "beforeShow error:", e);
    }
  }
  proceed();
};

// ── Guide Rendering ──────────────────────────────────────────────────────

Tour.prototype._renderGuide = function (step, idx) {
  if (this._guide) this._guide.remove();

  var total = this.steps.length;
  var text = step.text.replace(/\n/g, "<br>");
  var prevIdx = this._findPrev(idx);

  var el = document.createElement("div");
  el.className = "st-guide";

  var html = '<div class="st-guide-text">' + text + "</div>";
  html += '<div class="st-guide-actions">';
  html += '<span class="st-guide-step">' + (idx + 1) + " / " + total + "</span>";
  if (prevIdx >= 0) html += '<button class="st-guide-prev" data-action="prev">Back</button>';
  if (step.btn) html += '<button class="st-guide-btn" data-action="next">' + step.btn + "</button>";
  html += '<button class="st-guide-skip" data-action="cancel">End tour</button>';
  html += "</div>";
  el.innerHTML = html;

  this._positionGuide(el, step);
  document.body.appendChild(el);
  this._guide = el;

  // Wire static buttons
  var self = this;
  var prevBtn = el.querySelector('[data-action="prev"]');
  var cancelBtn = el.querySelector('[data-action="cancel"]');
  if (prevBtn) prevBtn.addEventListener("click", function () { self.prev(); });
  if (cancelBtn) cancelBtn.addEventListener("click", function () { self.cancel(); });
};

Tour.prototype._positionGuide = function (el, step) {
  // Custom position
  if (step.position && typeof step.position === "object") {
    el.style.position = "fixed";
    if (step.position.top != null) el.style.top = step.position.top;
    if (step.position.left != null) el.style.left = step.position.left;
    if (step.position.bottom != null) el.style.bottom = step.position.bottom;
    if (step.position.right != null) el.style.right = step.position.right;
    return;
  }

  // Near spotlight target
  if (step.spotlight && this._spotlight) {
    var r = this._spotlight.getBoundingClientRect();
    var l = r.left - 396;
    var t = r.top;
    if (l < 16) { l = Math.max(16, r.left); t = r.bottom + 16; }
    if (t + 200 > window.innerHeight) t = Math.max(16, window.innerHeight - 260);
    el.style.position = "fixed";
    el.style.left = l + "px";
    el.style.top = t + "px";
    el.style.bottom = "auto";
    el.style.right = "auto";
  } else {
    // Default: bottom-left
    el.style.position = "fixed";
    el.style.bottom = "60px";
    el.style.left = "60px";
    el.style.top = "auto";
    el.style.right = "auto";
  }
};

Tour.prototype._findPrev = function (from) {
  for (var i = from - 1; i >= 0; i--) {
    if (this.steps[i].btn) return i;
  }
  return -1;
};

// ── Advance Binding ──────────────────────────────────────────────────────

Tour.prototype._bindAdvance = function (step) {
  var self = this;
  var nextBtn = this._guide ? this._guide.querySelector('[data-action="next"]') : null;
  var adv = step.advance || "click";

  // "click" — advance on Next button
  if (adv === "click") {
    if (nextBtn) nextBtn.addEventListener("click", function () { self.next(); });
    return;
  }

  // "click-target" — advance when spotlight element is clicked
  if (adv === "click-target") {
    if (this._spotlight) {
      var h = function () { self.next(); };
      this._spotlight.addEventListener("click", h, { once: true });
      this._cleanups.push(function () { if (self._spotlight) self._spotlight.removeEventListener("click", h); });
    } else if (nextBtn) {
      nextBtn.addEventListener("click", function () { self.next(); });
    }
    return;
  }

  // { event, selector } — advance on DOM event
  if (adv && typeof adv === "object" && adv.event && adv.selector) {
    var target = document.querySelector(adv.selector);
    if (target) {
      var handler = function () { self.next(); };
      target.addEventListener(adv.event, handler, { once: true });
      this._cleanups.push(function () { target.removeEventListener(adv.event, handler); });
    }
    return;
  }

  // { poll, interval? } — poll a condition
  if (adv && typeof adv === "object" && typeof adv.poll === "function") {
    var interval = adv.interval || 500;
    if (adv.poll()) { setTimeout(function () { self.next(); }, 0); return; }
    var timer = setInterval(function () {
      if (adv.poll()) { clearInterval(timer); self.next(); }
    }, interval);
    this._cleanups.push(function () { clearInterval(timer); });
    return;
  }

  // function(next, nextBtn, tour) — custom advance
  if (typeof adv === "function") {
    adv.call(null, function () { self.next(); }, nextBtn, self);
    return;
  }

  // number — auto-advance after timeout
  if (typeof adv === "number") {
    var tmr = setTimeout(function () { self.next(); }, adv);
    this._cleanups.push(function () { clearTimeout(tmr); });
    return;
  }
};

// ── Step Manipulation ────────────────────────────────────────────────────

Tour.prototype.spliceSteps = function (afterIndex, newSteps) {
  if (!newSteps.length) return;
  // Guard against duplicate splicing
  if (this.steps.some(function (s) { return s.id === newSteps[0].id; })) return;
  for (var i = 0; i < newSteps.length; i++) {
    this.steps.splice(afterIndex + 1 + i, 0, newSteps[i]);
  }
  this._revealAll = _collectReveals(this.steps);
};

Tour.prototype.updateSteps = function (newSteps) {
  this.steps = newSteps.slice();
  this._revealAll = _collectReveals(this.steps);
};

/**
 * Register a cleanup function for the current step.
 * Called automatically when the step changes or tour ends.
 * Useful for custom advance functions that bind DOM events.
 */
Tour.prototype.addCleanup = function (fn) {
  this._cleanups.push(fn);
};

// ── State Query ──────────────────────────────────────────────────────────

Object.defineProperty(Tour.prototype, "currentStep", {
  get: function () { return this._idx; }
});

Object.defineProperty(Tour.prototype, "isActive", {
  get: function () { return _active === this; }
});

Object.defineProperty(Tour.prototype, "progress", {
  get: function () { return { current: this._idx, total: this.steps.length }; }
});

// ========================================================================
// PUBLIC API
// ========================================================================

window.StudioTour = {
  create: function (opts) { return new Tour(opts); },
  get active() { return _active; },
  cancel: function () { if (_active) _active.cancel(); }
};

console.log(TAG, "Tour engine loaded");

})();
