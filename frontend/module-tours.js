/**
 * Forge Studio — Module Tours
 * by ToxicHost & Moritz
 *
 * First-visit orientation tours for Studio modules.
 * Uses StudioModules.onInit() to fire on first activation.
 * Each tour is 3-4 steps and runs only once (persisted via localStorage).
 */
(function () {
"use strict";

var TAG = "[ModuleTours]";
var PREFIX = "st-module-tour-";

function _seen(id) { return localStorage.getItem(PREFIX + id) === "1"; }
function _markSeen(id) { localStorage.setItem(PREFIX + id, "1"); }

// ========================================================================
// WORKSHOP TOUR
// ========================================================================

if (window.StudioModules) {

  StudioModules.onInit("workshop", function () {
    if (_seen("workshop") || !window.StudioTour) return;
    _markSeen("workshop");

    setTimeout(function () {
      StudioTour.create({
        id: "tour-workshop",
        steps: [
          {
            id: "ws_merge",
            text: "This is the <em>Workshop</em> \u2014 where you merge and combine AI models.\n\nThe merge panel has your <em>Method</em>, <em>Weight</em> slider, and model selectors. Pick two models, set a blend ratio, and merge.",
            spotlight: ".ws-merge-panel",
            advance: "click", btn: "Next"
          },
          {
            id: "ws_actions",
            text: "<em>Test Merge</em> hot-swaps the weights in memory \u2014 no file written. Generate some test images to see if you like the blend.\n\nHappy with it? <em>Save to Disk</em> writes the merged model as a new checkpoint.",
            spotlight: ".ws-action-row",
            advance: "click", btn: "Next"
          },
          {
            id: "ws_history",
            text: "The <em>History</em> tab keeps a journal of every merge you\u2019ve done \u2014 recipe, settings, and notes. You can rate, tag, and search your experiments.\n\nCheck the <em>Codex</em> for details on each merge method.",
            spotlight: ".ws-tabs",
            advance: "click", btn: "Got it"
          },
        ],
        persist: false,
        onComplete: function () { console.log(TAG, "Workshop tour complete"); },
        onCancel: function () {},
        confirmCancel: false,
      }).start(0);
    }, 600);
  });

  // ========================================================================
  // GALLERY TOUR
  // ========================================================================

  StudioModules.onInit("gallery", function () {
    if (_seen("gallery") || !window.StudioTour) return;
    _markSeen("gallery");

    setTimeout(function () {
      StudioTour.create({
        id: "tour-gallery",
        steps: [
          {
            id: "gal_layout",
            text: "This is the <em>Gallery</em> \u2014 a browser for all your generated images.\n\n<em>Sidebar</em> has folders and character tags for filtering. <em>Search</em> at the top matches filenames and metadata.",
            spotlight: ".gal-sidebar",
            advance: "click", btn: "Next"
          },
          {
            id: "gal_interact",
            text: "Click any image for a detail view with full metadata. Right-click for a context menu (rename, move, delete, send to canvas).\n\nDrag images between folders in the sidebar to organize.",
            spotlight: ".gal-main",
            advance: "click", btn: "Next"
          },
          {
            id: "gal_live",
            text: "The gallery updates <em>in real-time</em> \u2014 new images appear automatically as they\u2019re generated. The status dot in the topbar shows watcher status.\n\n<em>Send to Canvas</em> loads any image into Studio for editing.",
            spotlight: null,
            advance: "click", btn: "Got it",
            position: { bottom: "80px", left: "calc(50% - 190px)" }
          },
        ],
        persist: false,
        onComplete: function () { console.log(TAG, "Gallery tour complete"); },
        onCancel: function () {},
        confirmCancel: false,
      }).start(0);
    }, 600);
  });

} else {
  console.warn(TAG, "StudioModules not available");
}

console.log(TAG, "Module tours loaded");
})();
