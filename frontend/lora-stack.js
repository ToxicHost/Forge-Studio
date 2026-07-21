/**
 * Forge Studio — Structured LoRA Prompt Stack
 * by ToxicHost & Moritz
 *
 * Moves LoRAs out of raw prompt text into a structured UI. Rows are
 * compiled into <lora:name:weight> tags and appended to the positive
 * prompt at generation time (see app.js _compilePromptWithLoras at the
 * generate-button handler). Rows can also inject the LoRA's trigger
 * words (sidecar activation_text, fetched from /studio/loras): enabled
 * rows with triggers on get their activation text appended after the
 * tags at compile time — see refreshTriggers / compilePrompt.
 *
 * State is mirrored to a hidden <input id="paramLoraStack"> as a
 * JSON-serialized array. That hidden input is registered in
 * workflow-state.js FIELD_MAP so per-tab snapshots, workflow profiles,
 * and the session-save category for prompts all carry the stack
 * automatically — no separate plumbing per consumer.
 *
 * Reload triggers:
 *  - DOMContentLoaded: initial reload from any pre-populated hidden value
 *  - hidden.dispatchEvent("input"): fired by workflow-state._writeField
 *    after a workflow apply / tab switch writes the hidden value
 *  - LoraStack.reload(): explicit call after session-restore, mirroring
 *    the _syncPoolsFromDOM pattern in app.js
 */
(function () {
"use strict";
var TAG = "[LoraStack]";

var state = [];
var container = null;
var rowsEl = null;
var hidden = null;
var previewEl = null;
var _suppressInput = false;

// LoRA short-name (lowercased) -> trimmed activation_text from the
// /studio/loras sidecar data. Filled async by refreshTriggers; compile
// stays synchronous and simply skips triggers until the map is loaded.
var triggerMap = Object.create(null);
var triggerLoadPromise = null;

function _t(key, fallback, params) {
  return (window.I18N && window.I18N.t) ? window.I18N.t(key, fallback, params) : fallback;
}

function _writeHidden() {
  if (!hidden) return;
  // Dispatch inside the suppress window: our own input listener short-
  // circuits via _suppressInput so we don't loop back into reload(), but
  // the bubbled event still reaches the session-autosave listener on
  // paramLoraStack (app.js:3834). Without this, stack-only edits sit in
  // the DOM until the next beforeunload/pagehide — fine on a clean tab
  // close, lost on a browser/OS crash.
  _suppressInput = true;
  hidden.value = JSON.stringify(state);
  hidden.dispatchEvent(new Event("input", { bubbles: true }));
  _suppressInput = false;
}

function _commit() {
  _writeHidden();
  render();
}

function reload() {
  if (!hidden) return;
  try {
    var parsed = JSON.parse(hidden.value || "[]");
    if (Array.isArray(parsed)) {
      state = parsed
        .filter(function (r) { return r && typeof r.name === "string" && r.name.length > 0; })
        .map(function (r) {
          var w = parseFloat(r.weight);
          return {
            name: String(r.name),
            weight: Number.isFinite(w) ? w : 1.0,
            enabled: r.enabled !== false,
            // Missing on rows saved before trigger support — default to
            // true so old workflows adopt trigger injection.
            triggers: r.triggers !== false,
          };
        });
    } else {
      state = [];
    }
  } catch (e) {
    state = [];
  }
  render();
}

function _normalizeLoraName(lora) {
  // lora-browser uses `lora.name.split("/").pop()` so the inserted tag is
  // just the filename — mirror that to stay consistent with manual inserts.
  if (typeof lora === "string") return lora.split("/").pop();
  if (lora && typeof lora.name === "string") return lora.name.split("/").pop();
  return "";
}

function _triggerKey(value) {
  return _normalizeLoraName(value).toLowerCase();
}

function _splitTriggers(text) {
  return String(text || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
}

// Insert text into the positive prompt at the caret, comma-separated so
// tags stay cleanly delimited.
function _insertIntoPrompt(text) {
  var ta = document.getElementById("paramPrompt");
  if (!ta || !text) return;
  var start = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
  var end = ta.selectionEnd == null ? start : ta.selectionEnd;
  var val = ta.value;
  var before = val.slice(0, start);
  var after = val.slice(end);
  var prefix = (before.length && !/[\s,]$/.test(before)) ? ", " : "";
  var suffix = (after.length && !/^[\s,]/.test(after)) ? ", " : "";
  ta.value = before + prefix + text + suffix + after;
  var pos = start + prefix.length + text.length + suffix.length;
  ta.selectionStart = ta.selectionEnd = pos;
  ta.focus();
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

// Move trigger word(s) into the prompt field so the user can edit them
// (e.g. swap a baked-in outfit). Switches the row to manual triggers so
// the same words aren't also auto-appended at generate.
function _moveTriggers(idx, words) {
  var text = (words || []).join(", ");
  if (!text) return;
  _insertIntoPrompt(text);
  if (state[idx] && state[idx].triggers !== false) setTriggers(idx, false);
}

// Load activation_text for every LoRA from /studio/loras. Non-fatal on
// failure — compile then appends tags only. force=true refetches even if
// already loaded (the browser's refresh passes it); otherwise concurrent
// callers share the in-flight promise.
function refreshTriggers(force) {
  if (triggerLoadPromise && !force) return triggerLoadPromise;
  triggerLoadPromise = fetch("/studio/loras")
    .then(function (resp) {
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return resp.json();
    })
    .then(function (list) {
      var map = Object.create(null);
      if (Array.isArray(list)) {
        for (var i = 0; i < list.length; i++) {
          var l = list[i];
          if (!l || typeof l.name !== "string") continue;
          var text = typeof l.activation_text === "string" ? l.activation_text.trim() : "";
          if (text) map[_triggerKey(l.name)] = text;
        }
      }
      triggerMap = map;
      // Re-render so rows built before the fetch finished pick up their
      // trigger chips (and the preview reflects the trigger words).
      render();
    })
    .catch(function (e) {
      console.warn(TAG, "Failed to load trigger words:", e);
    });
  return triggerLoadPromise;
}

function add(loraOrName, weight) {
  if (!triggerLoadPromise) refreshTriggers();
  var name = _normalizeLoraName(loraOrName);
  if (!name) return;
  var w = 1.0;
  if (typeof weight === "number" && Number.isFinite(weight)) {
    w = weight;
  } else if (loraOrName && typeof loraOrName === "object" &&
             typeof loraOrName.preferred_weight === "number" &&
             loraOrName.preferred_weight > 0) {
    w = loraOrName.preferred_weight;
  }

  // Dedup: the picker keeps the modal open for multi-add, so a double
  // click on the same card is the typical "duplicate" path. Skip the
  // push, flash the existing row, and let the user know the stack
  // already has it — they can edit weight/enabled inline.
  for (var i = 0; i < state.length; i++) {
    if (state[i].name === name) {
      _flashRow(i);
      if (typeof window.showToast === "function") {
        window.showToast(
          _t("loraStack.add.duplicate", "{name} is already in the stack", { name: name }),
          "info"
        );
      }
      return;
    }
  }

  state.push({ name: name, weight: w, enabled: true, triggers: true });
  _commit();
}

function _flashRow(idx) {
  if (!rowsEl) return;
  var row = rowsEl.querySelector('.lora-stack-row[data-idx="' + idx + '"]');
  if (!row) return;
  row.classList.add("flash");
  // Smooth-scroll only when off-screen — avoid jumping the panel
  // around for a row already in view.
  if (typeof row.scrollIntoView === "function") {
    var box = container && container.getBoundingClientRect();
    var r = row.getBoundingClientRect();
    if (box && (r.top < box.top || r.bottom > box.bottom)) {
      row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }
  setTimeout(function () { row.classList.remove("flash"); }, 700);
}

function remove(idx) {
  if (idx < 0 || idx >= state.length) return;
  state.splice(idx, 1);
  _commit();
}

function setEnabled(idx, enabled) {
  if (!state[idx]) return;
  state[idx].enabled = !!enabled;
  _commit();
}

function setTriggers(idx, on) {
  if (!state[idx]) return;
  state[idx].triggers = !!on;
  _commit();
}

function setWeight(idx, weight) {
  if (!state[idx]) return;
  var w = parseFloat(weight);
  if (!Number.isFinite(w)) return;
  state[idx].weight = w;
  // Skip full re-render: the number input is already showing the value
  // and a re-render would steal focus mid-edit.
  _writeHidden();
  if (previewEl && previewEl.classList.contains("open")) _renderPreview();
}

function moveRow(from, to) {
  if (from === to) return;
  if (from < 0 || from >= state.length) return;
  if (to < 0 || to >= state.length) return;
  var item = state.splice(from, 1)[0];
  state.splice(to, 0, item);
  _commit();
}

function compileTags() {
  return state
    .filter(function (r) { return r.enabled && r.name; })
    .map(function (r) {
      var w = Number.isFinite(r.weight) ? r.weight : 1.0;
      return "<lora:" + r.name + ":" + w + ">";
    })
    .join(", ");
}

function _appendSegment(base, segment) {
  if (!base) return segment;
  var sep = /[,;]$/.test(base) ? " " : ", ";
  return base + sep + segment;
}

function compilePrompt(prompt) {
  var raw = prompt == null ? "" : String(prompt);
  var out = raw.trim();
  var appended = false;
  var tags = compileTags();
  if (tags) {
    out = _appendSegment(out, tags);
    appended = true;
  }
  // Trigger words: for each enabled row that hasn't opted out, append the
  // LoRA's activation text unless the evolving output already contains it
  // (case-insensitive) — checking the evolving output also keeps two
  // stacked LoRAs sharing the same activation text from adding it twice.
  for (var i = 0; i < state.length; i++) {
    var r = state[i];
    if (!r.enabled || !r.name || r.triggers === false) continue;
    var text = triggerMap[_triggerKey(r.name)];
    if (!text) continue;
    text = String(text).trim();
    if (!text) continue;
    if (out.toLowerCase().indexOf(text.toLowerCase()) !== -1) continue;
    out = _appendSegment(out, text);
    appended = true;
  }
  return appended ? out : raw;
}

// Detect <lora:name:weight> tags in arbitrary text. Returns parsed rows
// and the text with those tags (plus the orphan commas around them)
// stripped out. Used by importFromPrompt.
function _extract(text) {
  var re = /<lora:([^:>]+)(?::(-?\d+(?:\.\d+)?))?>/g;
  var found = [];
  var stripped = (text || "").replace(re, function (_m, name, w) {
    found.push({
      name: String(name).trim(),
      weight: w == null ? 1.0 : parseFloat(w),
      enabled: true,
      triggers: true,
    });
    return "";
  });
  // Tidy double commas / leading-trailing punctuation left by stripping
  var cleaned = stripped
    .replace(/[ \t]+,/g, ",")
    .replace(/,(\s*,)+/g, ",")
    .replace(/^\s*,\s*/, "")
    .replace(/\s*,\s*$/, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n");
  return { found: found, cleaned: cleaned.trim() };
}

function importFromPrompt() {
  var ta = document.getElementById("paramPrompt");
  if (!ta) return;
  var out = _extract(ta.value);
  if (out.found.length === 0) {
    if (typeof window.showToast === "function") {
      window.showToast(
        _t("loraStack.import.none", "No <lora:…> tags in positive prompt"),
        "info"
      );
    }
    return;
  }
  for (var i = 0; i < out.found.length; i++) state.push(out.found[i]);
  ta.value = out.cleaned;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  _commit();
  if (typeof window.showToast === "function") {
    window.showToast(
      _t("loraStack.import.done", "Moved {count} LoRA(s) from prompt", { count: out.found.length }),
      "success"
    );
  }
}

function _renderPreview() {
  if (!previewEl) return;
  var textEl = previewEl.querySelector(".lora-stack-preview-text");
  if (!textEl) return;
  // Mirror what generation will actually send: current positive prompt
  // plus tags plus trigger words.
  var ta = document.getElementById("paramPrompt");
  var compiled = compilePrompt(ta ? ta.value : "");
  textEl.textContent = compiled || _t("loraStack.preview.empty", "(no enabled LoRAs)");
}

function render() {
  if (!rowsEl) return;
  rowsEl.innerHTML = "";

  if (state.length === 0) {
    var empty = document.createElement("div");
    empty.className = "lora-stack-empty";
    empty.textContent = _t("loraStack.empty", "No LoRAs added. Click + LoRAs to browse.");
    rowsEl.appendChild(empty);
  } else {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < state.length; i++) {
      frag.appendChild(_buildRow(i, state[i]));
    }
    rowsEl.appendChild(frag);
  }

  _renderPreview();
}

function _buildRow(idx, row) {
  var r = document.createElement("div");
  r.className = "lora-stack-row" + (row.enabled ? "" : " disabled");
  r.draggable = true;
  r.dataset.idx = String(idx);

  var drag = document.createElement("span");
  drag.className = "lora-stack-drag";
  drag.title = _t("loraStack.drag", "Drag to reorder");
  drag.textContent = "⋮⋮";
  r.appendChild(drag);

  var cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "lora-stack-enabled";
  cb.draggable = false;
  cb.checked = row.enabled;
  cb.title = _t("loraStack.toggle", "Enable / disable");
  cb.addEventListener("change", function () { setEnabled(idx, cb.checked); });
  r.appendChild(cb);

  var name = document.createElement("span");
  name.className = "lora-stack-name";
  name.title = row.name;
  name.textContent = row.name;
  r.appendChild(name);

  var w = document.createElement("input");
  w.type = "number";
  w.className = "lora-stack-weight";
  w.draggable = false;
  w.step = "0.05";
  w.min = "-2";
  w.max = "2";
  w.value = String(row.weight);
  w.title = _t("loraStack.weight", "Weight");
  w.addEventListener("input", function () { setWeight(idx, w.value); });
  w.addEventListener("change", function () { setWeight(idx, w.value); });
  // Don't start a row-drag from inside the weight input
  w.addEventListener("mousedown", function (e) { e.stopPropagation(); });
  r.appendChild(w);

  var rm = document.createElement("button");
  rm.type = "button";
  rm.className = "lora-stack-remove";
  rm.draggable = false;
  rm.title = _t("loraStack.remove", "Remove");
  rm.textContent = "×";
  rm.addEventListener("click", function () { remove(idx); });
  r.appendChild(rm);

  // Trigger words: second line inside the row, only when the sidecar
  // provided activation text for this LoRA (map is filled async by
  // refreshTriggers, which re-renders on completion).
  var trig = triggerMap[_triggerKey(row.name)];
  if (trig) {
    var tline = document.createElement("div");
    tline.className = "lora-stack-trigger-line";
    tline.draggable = false;

    var tbtn = document.createElement("button");
    tbtn.type = "button";
    tbtn.className = "lora-stack-trigger-toggle" + (row.triggers !== false ? " active" : "");
    tbtn.draggable = false;
    tbtn.textContent = "T";
    tbtn.title = _t("loraStack.triggers.tooltip", "Auto-add all trigger words at generate");
    tbtn.setAttribute("aria-pressed", row.triggers !== false ? "true" : "false");
    tbtn.addEventListener("click", function () {
      setTriggers(idx, !(state[idx] && state[idx].triggers !== false));
    });
    tline.appendChild(tbtn);

    // Trigger words as clickable chips: click a word to move just that one
    // into the prompt field (where you can edit it, e.g. swap an outfit);
    // "→ prompt" moves them all. Either switches the row to manual (T off).
    var words = _splitTriggers(trig);
    var chips = document.createElement("span");
    chips.className = "lora-stack-trigger-chips";
    words.forEach(function (word) {
      var c = document.createElement("button");
      c.type = "button";
      c.className = "lora-stack-trigger-chip";
      c.draggable = false;
      c.textContent = word;
      c.title = _t("loraStack.triggers.chipTip", "Move this word into the prompt");
      c.addEventListener("click", function () { _moveTriggers(idx, [word]); });
      chips.appendChild(c);
    });
    tline.appendChild(chips);

    if (words.length > 1) {
      var moveAll = document.createElement("button");
      moveAll.type = "button";
      moveAll.className = "lora-stack-trigger-moveall";
      moveAll.draggable = false;
      moveAll.textContent = _t("loraStack.triggers.moveAll", "→ prompt");
      moveAll.title = _t("loraStack.triggers.moveAllTip", "Move all trigger words into the prompt to edit them");
      moveAll.addEventListener("click", function () { _moveTriggers(idx, words); });
      tline.appendChild(moveAll);
    }

    r.appendChild(tline);
  }

  // Native HTML5 drag-and-drop for reordering
  r.addEventListener("dragstart", function (e) {
    r.classList.add("dragging");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", String(idx)); } catch (_) {}
    }
  });
  r.addEventListener("dragend", function () {
    r.classList.remove("dragging");
    var olds = rowsEl.querySelectorAll(".lora-stack-row.drag-over");
    for (var i = 0; i < olds.length; i++) olds[i].classList.remove("drag-over");
  });
  r.addEventListener("dragover", function (e) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    r.classList.add("drag-over");
  });
  r.addEventListener("dragleave", function () { r.classList.remove("drag-over"); });
  r.addEventListener("drop", function (e) {
    e.preventDefault();
    r.classList.remove("drag-over");
    var from = parseInt(e.dataTransfer && e.dataTransfer.getData("text/plain"), 10);
    var to = parseInt(r.dataset.idx, 10);
    if (Number.isFinite(from) && Number.isFinite(to)) moveRow(from, to);
  });

  return r;
}

function _openPicker() {
  var LB = window.LoraBrowser;
  if (!LB) {
    if (typeof window.showToast === "function") {
      window.showToast(_t("loraStack.picker.unavailable", "LoRA browser not ready"), "warning");
    }
    return;
  }
  if (typeof LB.openPick === "function") {
    // The browser passes through its resolved weight (current weight
    // field, overridden by the LoRA's preferred_weight sidecar).
    LB.openPick(function (lora, weight) { add(lora, weight); });
  } else {
    LB.open();
  }
}

function _togglePreview() {
  if (!previewEl) return;
  var btn = document.getElementById("loraStackPreviewBtn");
  var open = previewEl.classList.toggle("open");
  if (btn) btn.classList.toggle("active", open);
  if (open) _renderPreview();
}

function init() {
  container = document.getElementById("loraStackBox");
  rowsEl = document.getElementById("loraStackRows");
  hidden = document.getElementById("paramLoraStack");
  previewEl = document.getElementById("loraStackPreview");
  if (!container || !rowsEl || !hidden) {
    console.warn(TAG, "Required DOM elements missing — skipping init");
    return;
  }

  var addBtn = document.getElementById("loraStackAddBtn");
  var importBtn = document.getElementById("loraStackImportBtn");
  var previewBtn = document.getElementById("loraStackPreviewBtn");
  if (addBtn) addBtn.addEventListener("click", _openPicker);
  if (importBtn) importBtn.addEventListener("click", importFromPrompt);
  if (previewBtn) previewBtn.addEventListener("click", _togglePreview);

  // workflow-state._writeField dispatches "input" on hidden inputs after
  // a workflow/tab apply — that's our cue to re-read and re-render.
  hidden.addEventListener("input", function () {
    if (_suppressInput) return;
    reload();
  });

  reload();
  refreshTriggers();
  console.log(TAG, "Initialized");
}

window.LoraStack = {
  add: add,
  remove: remove,
  reload: reload,
  compilePrompt: compilePrompt,
  compileTags: compileTags,
  importFromPrompt: importFromPrompt,
  refreshTriggers: refreshTriggers,
  getState: function () { return state.map(function (r) { return { name: r.name, weight: r.weight, enabled: r.enabled, triggers: r.triggers !== false }; }); },
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
})();
