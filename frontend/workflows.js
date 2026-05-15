/**
 * Forge Studio — Workflow Profiles UI
 * by ToxicHost & Moritz
 *
 * Generate-panel buttons that wrap window.StudioWorkflowState with named
 * persistent profiles. Save / Apply / New Tab / Delete.
 *
 * Apply triggers a model load when the workflow's checkpoint differs
 * from what's currently loaded — Forge Studio has no Generate-time
 * auto-load path, so without firing the dropdown's `change` listener
 * the model never switches and Generate would silently use the old
 * checkpoint. StudioWorkflowState dedupes by tracking which model
 * fields actually changed and dispatching `change` exactly once on
 * paramModel (which cascades to VAE+TE inside Forge's load listener).
 *
 * Loaded after app.js (needs the API namespace) and either before or
 * after studio-docs.js (only consumes StudioDocs.newDoc).
 */
(function () {
"use strict";

var TAG = "[Workflows]";

var _list = [];            // metadata list cached from /studio/workflows
var _select = null;
var _applyBtn = null;
var _newTabBtn = null;
var _saveBtn = null;
var _deleteBtn = null;

function _t(key, fallback, params) {
  return (window.I18N && window.I18N.t)
    ? window.I18N.t(key, fallback, params)
    : fallback;
}

function _toast(msg, kind) {
  if (typeof window.showToast === "function") window.showToast(msg, kind || "info");
}

function _applyI18n(root) {
  if (window.I18N && window.I18N.applyToDom) window.I18N.applyToDom(root);
}

// ---------------------------------------------------------------------------
// Dropdown
// ---------------------------------------------------------------------------

function _populate() {
  if (!_select) return;
  var current = _select.value;
  while (_select.firstChild) _select.removeChild(_select.firstChild);
  var blank = document.createElement("option");
  blank.value = "";
  blank.textContent = _list.length
    ? _t("workflows.select.placeholder", "Workflow…")
    : _t("workflows.select.empty", "No workflows saved");
  _select.appendChild(blank);
  _list.forEach(function (meta) {
    var opt = document.createElement("option");
    opt.value = meta.id;
    var label = meta.name || meta.id;
    if (meta.family && meta.family !== "any") label += " · " + meta.family;
    opt.textContent = label;
    _select.appendChild(opt);
  });
  // Restore selection if still present
  if (current && _list.some(function (m) { return m.id === current; })) {
    _select.value = current;
  }
  _syncButtons();
}

function _syncButtons() {
  var hasSelection = !!(_select && _select.value);
  if (_applyBtn) _applyBtn.disabled = !hasSelection;
  if (_newTabBtn) _newTabBtn.disabled = !hasSelection;
  if (_deleteBtn) _deleteBtn.disabled = !hasSelection;
}

async function refresh() {
  try {
    _list = (await API.workflows()) || [];
    if (!Array.isArray(_list)) _list = [];
  } catch (e) {
    console.warn(TAG, "list failed:", e && e.message || e);
    _list = [];
  }
  _populate();
}

// ---------------------------------------------------------------------------
// Save dialog (compact modal)
// ---------------------------------------------------------------------------

function _openSaveDialog(prefill, onSubmit) {
  prefill = prefill || {};
  var overlay = document.createElement("div");
  overlay.className = "modal-overlay workflow-save-overlay";

  var box = document.createElement("div");
  box.className = "modal-box workflow-save-box";

  box.innerHTML =
    '<h3 data-i18n="workflows.save.title">Save Workflow</h3>' +
    '<label class="workflow-field"><span data-i18n="workflows.save.name">Name</span>' +
    '  <input type="text" id="wfDlgName" maxlength="200"></label>' +
    '<label class="workflow-field"><span data-i18n="workflows.save.description">Description</span>' +
    '  <input type="text" id="wfDlgDesc" maxlength="1000"></label>' +
    '<label class="workflow-field"><span data-i18n="workflows.save.family">Family</span>' +
    '  <select id="wfDlgFamily">' +
    '    <option value="any" data-i18n="workflows.family.any">Any</option>' +
    '    <option value="sd15">SD 1.5</option>' +
    '    <option value="sdxl">SDXL</option>' +
    '    <option value="flux">FLUX</option>' +
    '    <option value="sd3">SD3</option>' +
    '    <option value="cosmos">Cosmos / Anima</option>' +
    '    <option value="other" data-i18n="workflows.family.other">Other</option>' +
    '  </select></label>' +
    '<label class="workflow-checkrow"><input type="checkbox" id="wfDlgIncPrompt" checked> <span data-i18n="workflows.save.includePrompt">Include prompt</span></label>' +
    '<label class="workflow-checkrow"><input type="checkbox" id="wfDlgIncNeg" checked> <span data-i18n="workflows.save.includeNegativePrompt">Include negative prompt</span></label>' +
    '<label class="workflow-checkrow"><input type="checkbox" id="wfDlgIncDims" checked> <span data-i18n="workflows.save.includeDimensions">Include dimensions</span></label>' +
    '<div class="modal-actions">' +
    '  <button class="ar-btn ar-clear" id="wfDlgCancel" data-i18n="workflows.save.cancel">Cancel</button>' +
    '  <button class="ar-btn primary" id="wfDlgSave" data-i18n="workflows.save.submit">Save</button>' +
    '</div>';

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  _applyI18n(box);

  var nameEl = box.querySelector("#wfDlgName");
  var descEl = box.querySelector("#wfDlgDesc");
  var familyEl = box.querySelector("#wfDlgFamily");
  var incPromptEl = box.querySelector("#wfDlgIncPrompt");
  var incNegEl = box.querySelector("#wfDlgIncNeg");
  var incDimsEl = box.querySelector("#wfDlgIncDims");

  if (prefill.name) nameEl.value = prefill.name;
  if (prefill.description) descEl.value = prefill.description;
  if (prefill.family) familyEl.value = prefill.family;

  function close() { document.body.removeChild(overlay); }
  box.querySelector("#wfDlgCancel").addEventListener("click", close);
  overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });

  box.querySelector("#wfDlgSave").addEventListener("click", function () {
    var name = (nameEl.value || "").trim();
    if (!name) { nameEl.focus(); return; }
    var includePrompt = !!incPromptEl.checked;
    var includeNegativePrompt = !!incNegEl.checked;
    var includeDimensions = !!incDimsEl.checked;
    close();
    onSubmit({
      name: name,
      description: (descEl.value || "").trim(),
      family: familyEl.value || "any",
      includePrompt: includePrompt,
      includeNegativePrompt: includeNegativePrompt,
      includeDimensions: includeDimensions,
    });
  });

  setTimeout(function () { nameEl.focus(); }, 0);
}

// ---------------------------------------------------------------------------
// Apply confirm modal (only when dirty canvas + mismatched dimensions)
// ---------------------------------------------------------------------------

function _confirmApplyWithResize(workflowName, onChoice) {
  var overlay = document.createElement("div");
  overlay.className = "modal-overlay workflow-confirm-overlay";
  var box = document.createElement("div");
  box.className = "modal-box workflow-confirm-box";
  box.innerHTML =
    '<h3 data-i18n="workflows.apply.title">Apply Workflow</h3>' +
    '<p id="wfApplyMsg"></p>' +
    '<div class="modal-actions">' +
    '  <button class="ar-btn ar-clear" data-choice="cancel" data-i18n="workflows.apply.cancel">Cancel</button>' +
    '  <button class="ar-btn" data-choice="settings-only" data-i18n="workflows.apply.settingsOnly">Apply settings only</button>' +
    '  <button class="ar-btn primary" data-choice="resize" data-i18n="workflows.apply.resize">Apply settings and resize canvas</button>' +
    '</div>';
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  // Fill the parameterised message first so applyI18n picks up the
  // sibling data-i18n attributes in the same pass.
  var msgEl = box.querySelector("#wfApplyMsg");
  if (msgEl) {
    msgEl.textContent = _t(
      "workflows.apply.dimensionsDiffer",
      "\"{name}\" has different dimensions than the current canvas.",
      { name: workflowName || "Workflow" },
    );
  }
  _applyI18n(box);

  function pick(choice) {
    document.body.removeChild(overlay);
    onChoice(choice);
  }
  box.querySelectorAll("[data-choice]").forEach(function (btn) {
    btn.addEventListener("click", function () { pick(btn.getAttribute("data-choice")); });
  });
  overlay.addEventListener("click", function (e) { if (e.target === overlay) pick("cancel"); });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function saveCurrent() {
  _openSaveDialog({}, async function (form) {
    var WF = window.StudioWorkflowState;
    if (!WF || typeof WF.captureWorkflowState !== "function") {
      _toast(_t("workflows.toast.helperNotLoaded", "Workflow helper not loaded"), "error");
      return;
    }
    var snapshot = WF.captureWorkflowState({
      includePrompt: form.includePrompt,
      includeNegativePrompt: form.includeNegativePrompt,
      includeDimensions: form.includeDimensions,
      mode: "profile",
    });
    var payload = {
      version: 1,
      name: form.name,
      description: form.description,
      family: form.family,
      options: {
        include_prompt: form.includePrompt,
        include_negative_prompt: form.includeNegativePrompt,
        include_dimensions: form.includeDimensions,
      },
      settings: snapshot.settings || {},
      dynamic: snapshot.dynamic || {},
    };
    try {
      var resp = await API.saveWorkflow(payload);
      _toast(_t("workflows.toast.saved", "Workflow saved"), "success");
      await refresh();
      if (resp && resp.id && _select) _select.value = resp.id;
      _syncButtons();
    } catch (e) {
      console.warn(TAG, "save failed:", e && e.message || e);
      _toast(_t("workflows.toast.saveFailed", "Workflow save failed"), "error");
    }
  });
}

async function _fetchSelected() {
  if (!_select || !_select.value) return null;
  try {
    return await API.workflow(_select.value);
  } catch (e) {
    console.warn(TAG, "fetch failed:", e && e.message || e);
    _toast(_t("workflows.toast.loadFailed", "Could not load workflow"), "error");
    return null;
  }
}

function _isCanvasDirty() {
  var S = window.StudioCore && window.StudioCore.state;
  return !!(S && S._canvasDirty);
}

async function applySelected() {
  var wf = await _fetchSelected();
  if (!wf) return;
  var WF = window.StudioWorkflowState;
  if (!WF || typeof WF.applyWorkflowState !== "function") {
    _toast(_t("workflows.toast.helperNotLoaded", "Workflow helper not loaded"), "error");
    return;
  }

  var hasDims = WF.workflowHasDimensions(wf);
  var dirty = _isCanvasDirty();
  var current = WF.getCurrentDimensions();
  var wfW = wf.settings && wf.settings.width;
  var wfH = wf.settings && wf.settings.height;
  var dimsDiffer = hasDims && (wfW !== current.width || wfH !== current.height);

  if (hasDims && dirty && dimsDiffer) {
    _confirmApplyWithResize(wf.name, function (choice) {
      if (choice === "cancel") return;
      WF.applyWorkflowState(wf, {
        applyDimensions: choice === "resize",
        loadModel: true,
      });
    });
    return;
  }
  WF.applyWorkflowState(wf, { applyDimensions: hasDims, loadModel: true });
}

async function newTabFromSelected() {
  var wf = await _fetchSelected();
  if (!wf) return;
  var WF = window.StudioWorkflowState;
  if (!WF || typeof WF.applyWorkflowState !== "function") {
    _toast(_t("workflows.toast.helperNotLoaded", "Workflow helper not loaded"), "error");
    return;
  }
  if (window.StudioDocs && typeof window.StudioDocs.newDoc === "function") {
    try { window.StudioDocs.newDoc(wf.name || "Workflow"); }
    catch (e) { console.warn(TAG, "newDoc failed:", e && e.message || e); }
  }
  // A fresh tab is never dirty, so dimensions apply silently.
  WF.applyWorkflowState(wf, {
    applyDimensions: WF.workflowHasDimensions(wf),
    loadModel: true,
  });
}

async function deleteSelected() {
  if (!_select || !_select.value) return;
  var meta = _list.find(function (m) { return m.id === _select.value; });
  var name = (meta && meta.name) || _select.value;
  var msg = _t("workflows.delete.confirm", "Delete workflow '{name}'?", { name: name });
  if (!window.confirm(msg)) return;
  try {
    await API.deleteWorkflow(_select.value);
    _toast(_t("workflows.toast.deleted", "Workflow deleted"), "success");
    await refresh();
    _syncButtons();
  } catch (e) {
    console.warn(TAG, "delete failed:", e && e.message || e);
    _toast(_t("workflows.toast.deleteFailed", "Workflow delete failed"), "error");
  }
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

function _wire() {
  _select    = document.getElementById("workflowSelect");
  _applyBtn  = document.getElementById("workflowApplyBtn");
  _newTabBtn = document.getElementById("workflowNewTabBtn");
  _saveBtn   = document.getElementById("workflowSaveBtn");
  _deleteBtn = document.getElementById("workflowDeleteBtn");
  if (!_select || !_saveBtn) return; // workflow row not present (older HTML)

  _select.addEventListener("change", _syncButtons);
  if (_applyBtn)  _applyBtn.addEventListener("click", applySelected);
  if (_newTabBtn) _newTabBtn.addEventListener("click", newTabFromSelected);
  _saveBtn.addEventListener("click", saveCurrent);
  if (_deleteBtn) _deleteBtn.addEventListener("click", deleteSelected);

  refresh();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _wire);
} else {
  _wire();
}

window.StudioWorkflows = {
  refresh: refresh,
  saveCurrent: saveCurrent,
  applySelected: applySelected,
  newTabFromSelected: newTabFromSelected,
  deleteSelected: deleteSelected,
};

})();
