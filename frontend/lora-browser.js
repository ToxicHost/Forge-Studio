/**
 * Forge Studio — LoRA Browser
 * by ToxicHost & Moritz
 *
 * Modal overlay for browsing, searching, and inserting LoRAs into prompts.
 * Self-contained: injects its own CSS, builds its own DOM, manages its own state.
 *
 * On the studio image tab, the LoRA Stack is the primary surface — its
 * "+ LoRAs" button opens this modal in pick mode and Ctrl+L is rebound
 * to the same picker. Browse mode (LoraBrowser.open() — clicking a card
 * inserts <lora:…> into the focused prompt) is still exported for surfaces
 * without a stack UI.
 *
 * Features:
 *   - Folder tree navigation with subfolder support
 *   - Search, sort (name/date/size), configurable insert weight
 *   - Preview thumbnails where available
 *   - Set preview from disk upload or canvas capture (right-click card)
 *   - Refresh without reloading the UI
 *   - Ctrl+L opens the stack picker (studio tab)
 */
(function () {
  "use strict";

  // i18n helper — every dynamically-built string passes its English source
  // through _t() so the locale-aware text shows on first render. Elements
  // also get data-i18n attributes so applyToDom() keeps them in sync on
  // locale switches.
  const _t = (key, fallback) => (window.I18N && window.I18N.t) ? window.I18N.t(key, fallback) : fallback;

  const TAG = "[LoRA Browser]";

  // ── State ──────────────────────────────────────────────
  let allLoras = [];
  let folders = [];
  let activeFolder = "";
  let searchQuery = "";
  // Base-model filter — multi-select chips built from the distinct
  // base_model values actually present ("" = untagged). ANDs with the
  // folder filter and search.
  let activeBaseModels = new Set();
  let sortMode = "name";
  let insertWeight = 1.0;
  let modal = null;
  let loaded = false;
  let collapsedFolders = new Set();
  // When set, clicking a card calls this callback with the LoRA object
  // instead of inserting <lora:…> into a textarea. Used by the LoRA Stack
  // "+ Add" button so picks go straight into the structured stack.
  let pickCallback = null;

  // ── Shared: last-focused prompt tracking (delegates to PromptTargets) ──
  // The registry (prompt-targets.js) tracks main / negative / AD-slot / regional
  // prompt fields via one document-level listener. Falls back to the old
  // paramPrompt default if the registry script isn't present.
  function _trackPromptFocus() {
    if (window.PromptTargets) window.PromptTargets.init();
  }

  function getTargetTextarea() {
    return (window.PromptTargets && window.PromptTargets.getActiveTarget())
      || document.getElementById("paramPrompt");
  }

  // ── CSS Injection ──────────────────────────────────────
  function injectStyles() {
    if (document.getElementById("lora-browser-styles")) return;
    const style = document.createElement("style");
    style.id = "lora-browser-styles";
    style.textContent = `
/* ── Prompt utility bar (shared between lora + wildcard browsers) ── */
.prompt-utils-bar {
  display: flex; align-items: center; gap: 4px;
  margin-top: 4px; padding-top: 4px;
  border-top: 1px solid var(--border-subtle);
}

/* ── Browser trigger buttons ──────────────────── */
.prompt-browser-btn {
  background: var(--bg-raised);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  color: var(--text-3);
  font-family: var(--font);
  font-size: var(--ui-font-small, 11px);
  font-weight: 500;
  letter-spacing: 0.3px;
  padding: 4px 9px;
  cursor: pointer;
  transition: all 0.12s;
  text-transform: uppercase;
  line-height: 1;
}
.prompt-browser-btn:hover {
  color: var(--text-1);
  border-color: var(--accent);
  background: var(--accent-dim);
}

/* ── Modal overlay ────────────────────────────── */
.lora-overlay {
  position: fixed; inset: 0; z-index: 300;
  background: rgba(0, 0, 0, 0.88);
  display: flex; align-items: center; justify-content: center;
  animation: lora-fade-in 0.15s ease;
}
@keyframes lora-fade-in { from { opacity: 0; } to { opacity: 1; } }

.lora-modal {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  width: min(90vw, 1100px);
  height: min(80vh, 720px);
  display: flex; flex-direction: column;
  overflow: hidden;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
}

.lora-header {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.lora-title {
  font-family: var(--font); font-size: 11px;
  font-weight: 600; color: var(--text-3);
  text-transform: uppercase; letter-spacing: 0.5px;
  white-space: nowrap;
}
.lora-search {
  flex: 1;
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  font-family: var(--font); font-size: 12px;
  color: var(--text-1); outline: none;
  transition: border-color 0.12s;
}
.lora-search:focus { border-color: var(--accent); }
.lora-search::placeholder { color: var(--text-4); }

.lora-sort {
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 5px 8px;
  font-family: var(--font); font-size: 11px;
  color: var(--text-2); outline: none;
  cursor: pointer;
  appearance: none; -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%236b6b74'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  padding-right: 22px;
}

.lora-weight-wrap {
  display: flex; align-items: center; gap: 4px;
}
.lora-weight-label {
  font-family: var(--font); font-size: 10px;
  color: var(--text-3); text-transform: uppercase;
  letter-spacing: 0.3px; white-space: nowrap;
}
.lora-weight-input {
  width: 52px;
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 5px 6px;
  font-family: var(--mono); font-size: 11px;
  color: var(--text-1); outline: none;
  text-align: center;
}
.lora-weight-input:focus { border-color: var(--accent); }

.lora-header-btn {
  background: var(--bg-raised);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  color: var(--text-3);
  cursor: pointer; padding: 4px 6px;
  line-height: 1; transition: all 0.12s;
  display: flex; align-items: center; justify-content: center;
}
.lora-header-btn:hover { color: var(--text-1); border-color: var(--border-hover); }
.lora-header-btn.spinning svg { animation: lora-spin 0.6s linear; }
@keyframes lora-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.lora-close {
  background: none; border: none;
  color: var(--text-3); font-size: 18px;
  cursor: pointer; padding: 4px 6px;
  line-height: 1; transition: color 0.12s;
}
.lora-close:hover { color: var(--text-1); }

.lora-body { display: flex; flex: 1; overflow: hidden; }

.lora-folders {
  width: 160px; flex-shrink: 0;
  border-right: 1px solid var(--border);
  overflow-y: auto; padding: 8px 0;
}
.lora-folder-item {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 12px;
  font-family: var(--font); font-size: 11px;
  color: var(--text-2); cursor: pointer;
  transition: all 0.12s;
  border-left: 2px solid transparent;
}
.lora-folder-item:hover { background: var(--bg-raised); color: var(--text-1); }
.lora-folder-item.active {
  color: var(--accent-bright, var(--accent));
  border-left-color: var(--accent);
  background: var(--accent-dim);
}
.lora-folder-icon { font-size: 12px; opacity: 0.6; width: 14px; text-align: center; flex-shrink: 0; }
.lora-folder-toggle { cursor: pointer; opacity: 0.8; transition: opacity 0.12s; }
.lora-folder-toggle:hover { opacity: 1; }
.lora-folder-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.lora-folder-count { font-family: var(--mono); font-size: 9px; color: var(--text-4); flex-shrink: 0; }

.lora-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.lora-chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 10px 0 10px; flex-shrink: 0; }
.lora-chips:empty { display: none; }
.lora-chip {
  font-family: var(--font); font-size: 10px;
  padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--border); color: var(--text-2);
  background: var(--bg-raised); cursor: pointer;
  transition: all 0.12s; user-select: none;
}
.lora-chip:hover { color: var(--text-1); border-color: var(--text-4); }
.lora-chip.active {
  color: var(--accent-bright, var(--accent));
  border-color: var(--accent);
  background: var(--accent-dim);
}
.lora-chip-count { font-family: var(--mono); font-size: 9px; color: var(--text-4); margin-left: 4px; }

.lora-grid-wrap { flex: 1; overflow-y: auto; padding: 10px; }
.lora-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 8px;
}

.lora-card {
  background: var(--bg-raised);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  overflow: hidden; cursor: pointer;
  transition: all 0.12s;
  display: flex; flex-direction: column;
  position: relative;
}
.lora-card:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}
.lora-card.inserted { border-color: var(--green); box-shadow: 0 0 8px var(--green-dim); }
.lora-card-preview { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; background: var(--bg-void); }

/* Civitai metadata badge — small marker in the top-right corner */
.lora-civ-badge {
  position: absolute; top: 4px; right: 4px;
  min-width: 16px; height: 16px; padding: 0 4px;
  display: inline-flex; align-items: center; justify-content: center;
  font-family: var(--mono); font-size: 10px; font-weight: 600;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.55);
  color: var(--text-2);
  pointer-events: auto;
  user-select: none;
  z-index: 2;
}
.lora-civ-badge.lora-civ-ok { color: var(--accent); }
.lora-civ-badge.lora-civ-ok.lora-civ-red { color: var(--red); }
.lora-civ-badge.lora-civ-notfound { color: var(--text-4); }
.lora-civ-badge.lora-civ-private { color: var(--amber); }

/* Footer "Fetch Civitai" button — mirrors .lora-open-folder visually
   but stays a separate class so the open-folder click handler can't
   accidentally bind to it (querySelector(".lora-open-folder") used to
   match this button first when it shared the class). */
.lora-civitai-btn {
  background: var(--bg-raised);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  color: var(--text-3);
  font-family: var(--font); font-size: 10px;
  padding: 3px 8px; cursor: pointer;
  transition: all 0.12s;
}
.lora-civitai-btn:hover {
  color: var(--text-1);
  border-color: var(--border-hover);
}
.lora-civitai-btn.spinning { opacity: 0.6; cursor: wait; }
.lora-civitai-btn:disabled { opacity: 0.5; cursor: wait; }

/* Bulk-fetch progress in footer status slot. The bar gives at-a-
   glance visual feedback for long runs (e.g. 100+ LoRAs), the text
   gives the count + ETA, and the cancel button stops the loop after
   the current in-flight request — never mid-request. */
.lora-civ-progress {
  display: inline-flex; align-items: center; gap: 8px;
  font-family: var(--font); font-size: 10px; color: var(--text-3);
}
.lora-civ-progress-bar {
  display: inline-block;
  width: 100px; height: 6px;
  background: var(--bg-input);
  border-radius: 3px; overflow: hidden;
  border: 1px solid var(--border-subtle);
}
.lora-civ-progress-fill {
  display: block; height: 100%;
  background: var(--accent);
  transition: width 0.2s linear;
}
.lora-civ-progress-text {
  font-family: var(--mono); white-space: nowrap;
  color: var(--text-2);
}
.lora-civ-cancel-btn {
  background: var(--bg-raised);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  color: var(--text-3);
  font-family: var(--font); font-size: 10px;
  padding: 2px 8px; cursor: pointer;
  transition: all 0.12s;
}
.lora-civ-cancel-btn:hover { color: var(--red); border-color: var(--red); }
.lora-civ-cancel-btn:disabled { opacity: 0.5; cursor: wait; }
.lora-card-placeholder {
  width: 100%; aspect-ratio: 1;
  display: flex; align-items: center; justify-content: center;
  padding: 10px; background: var(--bg-void);
}
.lora-card-placeholder-text {
  font-family: var(--font); font-size: 11px;
  color: var(--text-3); text-align: center;
  word-break: break-word; line-height: 1.3;
  overflow: hidden; display: -webkit-box;
  -webkit-line-clamp: 4; -webkit-box-orient: vertical;
}
.lora-card-info { padding: 6px 8px; border-top: 1px solid var(--border-subtle); }
.lora-card-name {
  font-family: var(--font); font-size: 10px; font-weight: 500;
  color: var(--text-2); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
.lora-card-meta { font-family: var(--mono); font-size: 9px; color: var(--text-4); margin-top: 2px; }
.lora-card-trigger {
  font-family: var(--mono); font-size: 9px; color: var(--accent-bright, var(--accent));
  margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  opacity: 0.8;
}

.lora-card-menu {
  position: fixed; z-index: 310;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
  padding: 4px 0; min-width: 160px;
}
.lora-card-menu-item {
  display: block; width: 100%; padding: 6px 12px;
  font-family: var(--font); font-size: 11px;
  color: var(--text-2); background: none; border: none;
  text-align: left; cursor: pointer; transition: all 0.1s;
}
.lora-card-menu-item:hover { background: var(--accent-dim); color: var(--text-1); }
.lora-card-menu-sep { height: 1px; background: var(--border-subtle); margin: 3px 0; }

.lora-footer {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 14px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
.lora-status { font-family: var(--font); font-size: 10px; color: var(--text-4); }
.lora-hint { font-family: var(--font); font-size: 10px; color: var(--text-4); }
.lora-open-folder {
  background: var(--bg-raised);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  color: var(--text-3);
  font-family: var(--font); font-size: 10px;
  padding: 3px 8px; cursor: pointer;
  transition: all 0.12s;
}
.lora-open-folder:hover {
  color: var(--text-1);
  border-color: var(--border-hover);
}

.lora-empty { display: flex; align-items: center; justify-content: center; flex: 1; padding: 40px; }
.lora-empty-text { font-family: var(--font); font-size: 12px; color: var(--text-3); text-align: center; }

.lora-grid-wrap::-webkit-scrollbar, .lora-folders::-webkit-scrollbar { width: 6px; }
.lora-grid-wrap::-webkit-scrollbar-track, .lora-folders::-webkit-scrollbar-track { background: transparent; }
.lora-grid-wrap::-webkit-scrollbar-thumb, .lora-folders::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

@media (max-width: 640px) {
  .lora-folders { display: none; }
  .lora-modal { width: 95vw; height: 85vh; }
}
`;
    document.head.appendChild(style);
  }


  // ── Data Loading ───────────────────────────────────────
  async function fetchLoras(force) {
    if (loaded && !force) return;
    try {
      const resp = await fetch("/studio/loras");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      allLoras = await resp.json();

      const folderSet = new Set();
      for (const l of allLoras) {
        if (l.subfolder) folderSet.add(l.subfolder);
      }
      folders = [...folderSet].sort((a, b) => a.localeCompare(b));
      loaded = true;
      console.log(`${TAG} Loaded ${allLoras.length} LoRAs in ${folders.length} folders`);
    } catch (e) {
      console.error(`${TAG} Failed to fetch LoRAs:`, e);
    }
  }

  async function refreshLoras() {
    const btn = modal?.querySelector(".lora-refresh-btn");
    if (btn) btn.classList.add("spinning");
    loaded = false;
    await fetchLoras(true);
    // Keep the stack's trigger-word map in sync with the refreshed list
    window.LoraStack?.refreshTriggers?.(true);
    if (modal) { renderFolderTree(); renderBaseChips(); renderGrid(); }
    if (btn) setTimeout(() => btn.classList.remove("spinning"), 300);
  }

  async function openLoraFolder() {
    try {
      const resp = await fetch("/studio/open_lora_folder", { method: "POST" });
      if (!resp.ok) console.error(`${TAG} Open folder failed: HTTP ${resp.status}`);
    } catch (e) {
      console.error(`${TAG} Open folder error:`, e);
    }
  }


  // ── Base-model filter chips ────────────────────────────
  const _baseModelKey = (l) => (l.base_model || "").trim();

  function renderBaseChips() {
    const row = modal?.querySelector(".lora-chips");
    if (!row) return;
    row.innerHTML = "";
    const counts = new Map();
    for (const l of allLoras) {
      const k = _baseModelKey(l);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const tagged = [...counts.keys()].filter(k => k).sort((a, b) => a.localeCompare(b));
    // No metadata anywhere → no row (a lone "untagged" chip filters nothing)
    if (!tagged.length) { activeBaseModels.clear(); return; }
    // Drop selections whose base model vanished (e.g. after a refresh)
    for (const k of [...activeBaseModels]) {
      if (!counts.has(k)) activeBaseModels.delete(k);
    }
    const keys = counts.has("") ? [...tagged, ""] : tagged;
    for (const key of keys) {
      const chip = document.createElement("span");
      chip.className = "lora-chip" + (activeBaseModels.has(key) ? " active" : "");
      const label = key || _t("lora.baseFilter.untagged", "untagged");
      chip.innerHTML = `${escHtml(label)}<span class="lora-chip-count">${counts.get(key)}</span>`;
      chip.addEventListener("click", () => {
        if (activeBaseModels.has(key)) activeBaseModels.delete(key);
        else activeBaseModels.add(key);
        renderBaseChips();
        renderGrid();
      });
      row.appendChild(chip);
    }
  }

  // ── Filtering & Sorting ────────────────────────────────
  function getFiltered() {
    let list = allLoras;
    if (activeFolder) list = list.filter(l => l.subfolder === activeFolder);
    if (activeBaseModels.size) list = list.filter(l => activeBaseModels.has(_baseModelKey(l)));
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(l => l.name.toLowerCase().includes(q)
        || (l.activation_text && l.activation_text.toLowerCase().includes(q)));
    }
    switch (sortMode) {
      case "name":
        list = [...list].sort((a, b) => a.name.split("/").pop().toLowerCase().localeCompare(b.name.split("/").pop().toLowerCase()));
        break;
      case "date":
        list = [...list].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
        break;
      case "size":
        list = [...list].sort((a, b) => (b.size || 0) - (a.size || 0));
        break;
    }
    return list;
  }

  function formatSize(bytes) {
    if (!bytes) return "";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
  }


  // ── DOM Building ───────────────────────────────────────
  const REFRESH_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`;

  function buildModal() {
    if (modal) return;
    modal = document.createElement("div");
    modal.className = "lora-overlay";
    modal.innerHTML = `
      <div class="lora-modal">
        <div class="lora-header">
          <span class="lora-title">LoRAs</span>
          <input class="lora-search" type="text" data-i18n-placeholder="lora.search.placeholder" placeholder="${_t("lora.search.placeholder", "Search LoRAs...")}" spellcheck="false" autocomplete="off">
          <select class="lora-sort">
            <option value="name" data-i18n="lora.sort.name">${_t("lora.sort.name", "Name")}</option>
            <option value="date" data-i18n="lora.sort.date">${_t("lora.sort.date", "Newest")}</option>
            <option value="size" data-i18n="lora.sort.size">${_t("lora.sort.size", "Largest")}</option>
          </select>
          <div class="lora-weight-wrap">
            <span class="lora-weight-label" data-i18n="lora.weight">${_t("lora.weight", "Weight")}</span>
            <input class="lora-weight-input" type="number" min="0" max="2" step="0.05" value="1">
          </div>
          <button class="lora-header-btn lora-refresh-btn" data-i18n-title="lora.refresh.tooltip" title="${_t("lora.refresh.tooltip", "Refresh LoRA list")}">${REFRESH_SVG}</button>
          <button class="lora-close" data-i18n-title="lora.close.tooltip" title="${_t("lora.close.tooltip", "Close (Esc)")}">&times;</button>
        </div>
        <div class="lora-body">
          <div class="lora-folders"></div>
          <div class="lora-main">
            <div class="lora-chips"></div>
            <div class="lora-grid-wrap"><div class="lora-grid"></div></div>
          </div>
        </div>
        <div class="lora-footer">
          <span class="lora-status"></span>
          <button class="lora-civitai-btn" style="display:none;" title="${_t("lora.civitai.fetchMissing.tooltip", "Fetch Civitai metadata for visible LoRAs that don't have it yet")}">${_t("lora.civitai.fetchMissing", "Fetch Civitai")}</button>
          <button class="lora-open-folder" data-i18n="lora.openFolder" data-i18n-title="lora.openFolder.tooltip" title="${_t("lora.openFolder.tooltip", "Open LoRA folder in file manager")}">${_t("lora.openFolder", "Open Folder")}</button>
          <span class="lora-hint" data-i18n="lora.hint">${_t("lora.hint", "Click to insert · Right-click for options")}</span>
        </div>
      </div>
    `;

    modal.querySelector(".lora-close").addEventListener("click", closeModal);
    modal.addEventListener("mousedown", e => { if (e.target === modal) closeModal(); });

    const searchInput = modal.querySelector(".lora-search");
    let searchTimer = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { searchQuery = searchInput.value.trim(); renderGrid(); }, 120);
    });

    modal.querySelector(".lora-sort").addEventListener("change", e => { sortMode = e.target.value; renderGrid(); });
    modal.querySelector(".lora-weight-input").addEventListener("input", e => { const v = parseFloat(e.target.value); if (!isNaN(v)) insertWeight = v; });
    modal.querySelector(".lora-refresh-btn").addEventListener("click", refreshLoras);
    modal.querySelector(".lora-open-folder").addEventListener("click", openLoraFolder);
    const civBtn = modal.querySelector(".lora-civitai-btn");
    if (civBtn) {
      civBtn.addEventListener("click", fetchMissingForView);
      // Show/hide based on toggle state, and react to runtime changes.
      const _syncCivBtn = () => {
        const on = window.StudioCivitai?.enabled?.() === true;
        civBtn.style.display = on ? "" : "none";
      };
      _syncCivBtn();
      window.addEventListener("studio-civitai-toggle", _syncCivBtn);
    }

    modal.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); e.stopPropagation(); });
    modal.addEventListener("keyup", e => e.stopPropagation());
    modal.addEventListener("click", e => { if (!e.target.closest(".lora-card-menu")) dismissContextMenu(); });

    document.body.appendChild(modal);
  }

  function renderFolderTree() {
    const container = modal.querySelector(".lora-folders");
    container.innerHTML = "";
    container.appendChild(makeFolderItem("", "All", allLoras.length, false, 0));

    for (const folder of folders) {
      // Skip if any ancestor is collapsed
      if (isAncestorCollapsed(folder)) continue;

      const count = allLoras.filter(l => l.subfolder === folder).length;
      const hasChildren = folders.some(f => f !== folder && f.startsWith(folder + "/"));
      const depth = (folder.match(/\//g) || []).length;
      const item = makeFolderItem(folder, folder.split("/").pop() || folder, count, hasChildren, depth);
      container.appendChild(item);
    }
  }

  function isAncestorCollapsed(folderPath) {
    const parts = folderPath.split("/");
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join("/");
      if (collapsedFolders.has(ancestor)) return true;
    }
    return false;
  }

  function makeFolderItem(folderPath, displayName, count, hasChildren, depth) {
    const item = document.createElement("div");
    item.className = "lora-folder-item" + (activeFolder === folderPath ? " active" : "");
    if (depth > 0) item.style.paddingLeft = (12 + depth * 12) + "px";

    let icon;
    if (folderPath === "") {
      icon = "◈";
    } else if (hasChildren) {
      icon = collapsedFolders.has(folderPath) ? "▸" : "▾";
    } else {
      icon = "·";
    }

    item.innerHTML = `
      <span class="lora-folder-icon${hasChildren ? " lora-folder-toggle" : ""}">${icon}</span>
      <span class="lora-folder-name" title="${folderPath || _t("lora.allFolder", "All LoRAs")}">${displayName}</span>
      <span class="lora-folder-count">${count}</span>
    `;

    // Click icon: toggle collapse (if has children)
    if (hasChildren) {
      item.querySelector(".lora-folder-icon").addEventListener("click", e => {
        e.stopPropagation();
        if (collapsedFolders.has(folderPath)) collapsedFolders.delete(folderPath);
        else collapsedFolders.add(folderPath);
        renderFolderTree();
      });
    }

    // Click row: select folder for filtering
    item.addEventListener("click", () => {
      activeFolder = folderPath;
      modal.querySelectorAll(".lora-folder-item").forEach(el => el.classList.remove("active"));
      item.classList.add("active");
      renderGrid();
    });
    return item;
  }

  function renderGrid() {
    const grid = modal.querySelector(".lora-grid");
    const wrap = modal.querySelector(".lora-grid-wrap");
    const status = modal.querySelector(".lora-status");
    const filtered = getFiltered();

    status.textContent = `${filtered.length} LoRA${filtered.length !== 1 ? "s" : ""}`;
    const oldEmpty = wrap.querySelector(".lora-empty");
    if (oldEmpty) oldEmpty.remove();

    if (!filtered.length) {
      grid.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "lora-empty";
      empty.innerHTML = `<span class="lora-empty-text">${allLoras.length === 0 ? _t("lora.empty.none", "No LoRAs found in your models/Lora directory") : _t("lora.empty.noMatch", "No LoRAs match your search")}</span>`;
      wrap.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const lora of filtered) {
      const card = document.createElement("div");
      card.className = "lora-card";
      // Build a richer tooltip with Civitai info when present. The
      // backend enriches `preview` / `activation_text` from Civitai
      // already; this just adds model/author/base-model context.
      const civ = lora.civitai;
      const tipLines = [lora.name];
      if (lora.activation_text) tipLines.push(`Trigger: ${lora.activation_text}`);
      if (civ && !civ.not_found && !civ.private) {
        if (civ.model_name) tipLines.push(`Civitai: ${civ.model_name}${civ.version_name ? ` (${civ.version_name})` : ""}`);
        if (civ.base_model) tipLines.push(`Base: ${civ.base_model}`);
        if (civ.author) tipLines.push(`Author: ${civ.author}`);
      }
      card.title = tipLines.join("\n");
      const baseName = lora.name.split("/").pop();
      const triggerHtml = lora.activation_text
        ? `<div class="lora-card-trigger" title="${escHtml(lora.activation_text)}">${escHtml(lora.activation_text)}</div>`
        : "";
      // Small civitai badge: C in accent for fetched (R if it came from
      // civitai.red), · dim for not-found, 🔒 for private. Visually
      // subtle so it doesn't dominate the card.
      let civBadge = "";
      if (civ) {
        if (civ.private) {
          civBadge = `<span class="lora-civ-badge lora-civ-private" title="Marked private — Civitai lookup disabled for this LoRA">🔒</span>`;
        } else if (civ.not_found) {
          civBadge = `<span class="lora-civ-badge lora-civ-notfound" title="No match on civitai.com or civitai.red">·</span>`;
        } else if (civ.fetched_at) {
          const isRed = (civ.source_host || "").includes("civitai.red");
          const letter = isRed ? "R" : "C";
          const cls = isRed ? "lora-civ-ok lora-civ-red" : "lora-civ-ok";
          const tip = isRed
            ? "Metadata cached from civitai.red"
            : "Metadata cached from civitai.com";
          civBadge = `<span class="lora-civ-badge ${cls}" title="${tip}">${letter}</span>`;
        }
      }

      if (lora.preview) {
        card.innerHTML = `
          <img class="lora-card-preview" src="${lora.preview}" loading="lazy" alt=""
               onerror="this.outerHTML='<div class=\\'lora-card-placeholder\\'><span class=\\'lora-card-placeholder-text\\'>${escHtml(baseName)}</span></div>'">
          ${civBadge}
          <div class="lora-card-info"><div class="lora-card-name">${escHtml(baseName)}</div>${triggerHtml}<div class="lora-card-meta">${formatSize(lora.size)}</div></div>`;
      } else {
        card.innerHTML = `
          <div class="lora-card-placeholder"><span class="lora-card-placeholder-text">${escHtml(baseName)}</span></div>
          ${civBadge}
          <div class="lora-card-info"><div class="lora-card-name">${escHtml(baseName)}</div>${triggerHtml}<div class="lora-card-meta">${formatSize(lora.size)}</div></div>`;
      }

      card.addEventListener("click", e => {
        if (e.target.closest(".lora-card-menu")) return;
        if (pickCallback) {
          // Resolve the same weight insertLora would have used so the
          // browser's weight field (and the LoRA's preferred_weight
          // sidecar) carry through to the structured stack.
          const weight = (lora.preferred_weight && lora.preferred_weight > 0)
            ? lora.preferred_weight : insertWeight;
          try { pickCallback(lora, weight); }
          catch (err) { console.error(`${TAG} pick callback error:`, err); }
        } else {
          insertLora(lora);
        }
        card.classList.add("inserted");
        setTimeout(() => card.classList.remove("inserted"), 600);
      });
      card.addEventListener("contextmenu", e => { e.preventDefault(); showContextMenu(e, lora); });
      frag.appendChild(card);
    }
    grid.innerHTML = "";
    grid.appendChild(frag);
  }


  // ── Context Menu ───────────────────────────────────────
  let activeMenu = null;

  function dismissContextMenu() {
    if (activeMenu) { activeMenu.remove(); activeMenu = null; }
  }

  function showContextMenu(e, lora) {
    dismissContextMenu();
    const menu = document.createElement("div");
    menu.className = "lora-card-menu";

    // Edit metadata + selective trigger insertion — the primary way to set
    // a LoRA's trigger words / model family and to add only the trigger
    // words you want (e.g. skip a baked-in outfit).
    const btnEdit = document.createElement("button");
    btnEdit.className = "lora-card-menu-item";
    btnEdit.dataset.i18n = "lora.menu.editMeta";
    btnEdit.textContent = _t("lora.menu.editMeta", "Edit & insert triggers…");
    btnEdit.addEventListener("click", () => { dismissContextMenu(); openDetail(lora); });
    menu.appendChild(btnEdit);
    const sepEdit = document.createElement("div"); sepEdit.className = "lora-card-menu-sep";
    menu.appendChild(sepEdit);

    // "Add to Stack" only appears when the structured stack is
    // available AND we're not already in pick mode (in pick mode the
    // card click already targets the stack \u2014 a menu duplicate would
    // be noise). Sits at the top so it's the obvious primary action
    // for users who treat the stack as the main workflow.
    if (!pickCallback && window.LoraStack && typeof window.LoraStack.add === "function") {
      const btnStack = document.createElement("button");
      btnStack.className = "lora-card-menu-item";
      btnStack.dataset.i18n = "lora.menu.addToStack";
      btnStack.textContent = _t("lora.menu.addToStack", "Add to LoRA Stack");
      btnStack.addEventListener("click", () => {
        dismissContextMenu();
        const weight = (lora.preferred_weight && lora.preferred_weight > 0)
          ? lora.preferred_weight : insertWeight;
        try { window.LoraStack.add(lora, weight); }
        catch (err) { console.error(`${TAG} stack add error:`, err); }
      });
      menu.appendChild(btnStack);
      const sep = document.createElement("div"); sep.className = "lora-card-menu-sep";
      menu.appendChild(sep);
    }

    const btnUpload = document.createElement("button");
    btnUpload.className = "lora-card-menu-item";
    btnUpload.dataset.i18n = "lora.menu.previewFromFile";
    btnUpload.textContent = _t("lora.menu.previewFromFile", "Set preview from file\u2026");
    btnUpload.addEventListener("click", () => { dismissContextMenu(); pickPreviewFile(lora); });
    menu.appendChild(btnUpload);

    const btnCanvas = document.createElement("button");
    btnCanvas.className = "lora-card-menu-item";
    btnCanvas.dataset.i18n = "lora.menu.previewFromCanvas";
    btnCanvas.textContent = _t("lora.menu.previewFromCanvas", "Set preview from canvas");
    btnCanvas.addEventListener("click", () => { dismissContextMenu(); captureCanvasPreview(lora); });
    menu.appendChild(btnCanvas);

    if (lora.preview) {
      const sep = document.createElement("div"); sep.className = "lora-card-menu-sep";
      menu.appendChild(sep);
      const btnRm = document.createElement("button");
      btnRm.className = "lora-card-menu-item";
      btnRm.dataset.i18n = "lora.menu.removePreview";
      btnRm.textContent = _t("lora.menu.removePreview", "Remove preview");
      btnRm.style.color = "var(--red)";
      btnRm.addEventListener("click", () => { dismissContextMenu(); removePreview(lora); });
      menu.appendChild(btnRm);
    }

    // ── Civitai actions ──
    // "Fetch from Civitai" only when the global toggle is on AND this
    // LoRA is not marked private. Privacy-related items (mark private,
    // remove cache) are always available so the user can manage data
    // even after disabling the feature globally.
    const civ = lora.civitai;
    const civEnabled = window.StudioCivitai?.enabled?.() === true;
    const isPrivate = !!(civ && civ.private);
    const hasCache = !!(civ && (civ.fetched_at || civ.not_found || civ.private));

    if (civEnabled || hasCache) {
      const sep2 = document.createElement("div"); sep2.className = "lora-card-menu-sep";
      menu.appendChild(sep2);
    }

    if (civEnabled && !isPrivate) {
      const btnFetch = document.createElement("button");
      btnFetch.className = "lora-card-menu-item";
      btnFetch.textContent = _t("lora.menu.fetchCivitai", "Fetch from Civitai");
      btnFetch.addEventListener("click", () => { dismissContextMenu(); fetchOneFromCivitai(lora); });
      menu.appendChild(btnFetch);
    }
    if (civEnabled || hasCache) {
      const btnPriv = document.createElement("button");
      btnPriv.className = "lora-card-menu-item";
      btnPriv.textContent = isPrivate
        ? _t("lora.menu.civitaiUnprivate", "Allow Civitai lookup for this LoRA")
        : _t("lora.menu.civitaiPrivate", "Never query Civitai for this LoRA");
      btnPriv.addEventListener("click", () => { dismissContextMenu(); setCivitaiPrivate(lora, !isPrivate); });
      menu.appendChild(btnPriv);
    }
    if (hasCache) {
      const btnRmCiv = document.createElement("button");
      btnRmCiv.className = "lora-card-menu-item";
      btnRmCiv.textContent = _t("lora.menu.civitaiRemove", "Remove Civitai cache");
      btnRmCiv.style.color = "var(--red)";
      btnRmCiv.addEventListener("click", () => { dismissContextMenu(); removeCivitaiCache(lora); });
      menu.appendChild(btnRmCiv);
    }

    const modalRect = modal.querySelector(".lora-modal").getBoundingClientRect();
    menu.style.left = Math.min(e.clientX, modalRect.right - 180) + "px";
    menu.style.top = Math.min(e.clientY, modalRect.bottom - 160) + "px";
    modal.appendChild(menu);
    activeMenu = menu;
  }

  // ── Civitai actions ────────────────────────────────────
  async function fetchOneFromCivitai(lora) {
    if (window.StudioCivitai?.enabled?.() !== true) return;
    try {
      const resp = await fetch("/studio/civitai/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: lora.name }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        showToast(`${_t("lora.civitai.fetchFailed", "Civitai fetch failed")}: ${data?.error || resp.status}`, "error");
        return;
      }
      if (data.not_found) {
        showToast(_t("lora.civitai.notFound", "No Civitai match for this LoRA"), "info");
      } else {
        showToast(_t("lora.civitai.fetched", "Fetched from Civitai"), "success");
      }
      await refreshLoras();
    } catch (e) {
      showToast(`${_t("lora.civitai.fetchFailed", "Civitai fetch failed")}: ${e.message || e}`, "error");
    }
  }

  async function setCivitaiPrivate(lora, makePrivate) {
    try {
      const resp = await fetch("/studio/civitai/private", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: lora.name, private: !!makePrivate }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        showToast(`${_t("lora.civitai.privateFailed", "Could not update privacy")}: ${data?.error || resp.status}`, "error");
        return;
      }
      showToast(makePrivate
        ? _t("lora.civitai.markedPrivate", "Marked private — Civitai lookup blocked")
        : _t("lora.civitai.markedPublic", "Civitai lookup re-allowed"),
        "info");
      await refreshLoras();
    } catch (e) {
      showToast(`${_t("lora.civitai.privateFailed", "Could not update privacy")}: ${e.message || e}`, "error");
    }
  }

  async function removeCivitaiCache(lora) {
    try {
      const resp = await fetch("/studio/civitai/clear_cache", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: lora.name }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        showToast(`${_t("lora.civitai.clearFailed", "Could not clear cache")}: ${data?.error || resp.status}`, "error");
        return;
      }
      showToast(_t("lora.civitai.cleared", "Civitai cache cleared"), "info");
      await refreshLoras();
    } catch (e) {
      showToast(`${_t("lora.civitai.clearFailed", "Could not clear cache")}: ${e.message || e}`, "error");
    }
  }

  async function fetchMissingForView() {
    if (window.StudioCivitai?.enabled?.() !== true) return;
    // Count LoRAs in the current view that lack any cache entry and aren't private.
    const visible = getVisibleLoras();
    const missing = visible.filter(l => !l.civitai || (!l.civitai.fetched_at && !l.civitai.not_found && !l.civitai.private));
    if (missing.length === 0) {
      showToast(_t("lora.civitai.allCached", "All visible LoRAs already have metadata"), "info");
      return;
    }
    const label = activeFolder || _t("lora.allFolder", "All LoRAs");
    // Rough estimate: ~2-4s per LoRA cold (hash + HTTP + preview), ~1s warm.
    const estSec = Math.round(missing.length * 2.5);
    const estLabel = estSec >= 60 ? `~${Math.ceil(estSec / 60)} min` : `~${estSec} s`;
    const ok = window.confirm(_t("lora.civitai.confirmFetch",
      `Fetch Civitai metadata for ${missing.length} LoRA(s) in “${label}”?\n\n` +
      `This sends file hashes (not filenames or prompts) to civitai.com.\n` +
      `Estimated time: ${estLabel}. You can cancel mid-way.`));
    if (!ok) return;

    // Per-LoRA loop with live progress + cancel, so 100+ LoRAs feels
    // navigable instead of "did it freeze?". Each request also persists
    // server-side as it completes — cancelling never loses what's done.
    const total = missing.length;
    let done = 0, ok_count = 0, notfound = 0, errors = 0;
    let cancelled = false;
    const startTime = performance.now();

    const btn = modal?.querySelector(".lora-civitai-btn");
    const status = modal?.querySelector(".lora-status");
    const prevStatusHTML = status?.innerHTML || "";
    if (btn) { btn.disabled = true; btn.classList.add("spinning"); }

    let cancelBtn = null;
    const _formatETA = (sec) => {
      if (!isFinite(sec) || sec <= 0) return "";
      if (sec < 60) return `${Math.round(sec)}s`;
      const m = Math.floor(sec / 60);
      const s = Math.round(sec % 60);
      return s ? `${m}m${String(s).padStart(2, "0")}s` : `${m}m`;
    };
    const _renderProgress = (currentName) => {
      if (!status) return;
      const elapsed = (performance.now() - startTime) / 1000;
      const rate = done > 0 ? elapsed / done : 0;
      const remaining = (total - done) * rate;
      // Wait for a couple of samples before showing ETA so the first one isn't wildly off
      const etaText = done >= 3 ? ` · ETA ${_formatETA(remaining)}` : "";
      const nameTrim = currentName && currentName.length > 28
        ? "…" + currentName.slice(-27) : (currentName || "");
      const nameText = nameTrim ? ` · ${escHtml(nameTrim)}` : "";
      status.innerHTML =
        `<span class="lora-civ-progress">` +
          `<span class="lora-civ-progress-bar"><span class="lora-civ-progress-fill" style="width:${(done / total * 100).toFixed(1)}%"></span></span>` +
          `<span class="lora-civ-progress-text">${done}/${total}${etaText}${nameText}</span>` +
        `</span>`;
      if (cancelBtn) status.appendChild(cancelBtn);
    };

    cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "lora-civ-cancel-btn";
    cancelBtn.textContent = _t("lora.civitai.cancel", "Cancel");
    cancelBtn.addEventListener("click", () => {
      cancelled = true;
      cancelBtn.disabled = true;
      cancelBtn.textContent = _t("lora.civitai.cancelling", "Stopping…");
    });

    _renderProgress(missing[0]?.name || "");

    for (const lora of missing) {
      if (cancelled) break;
      try {
        const resp = await fetch("/studio/civitai/fetch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: lora.name }),
        });
        const data = await resp.json().catch(() => null);
        if (resp.ok && data && data.ok) {
          if (data.not_found) notfound++;
          else ok_count++;
          // Update in-memory so badges reflect new state on the next refresh.
          if (data.civitai) lora.civitai = data.civitai;
        } else {
          errors++;
        }
      } catch (e) {
        errors++;
      }
      done++;
      _renderProgress(done < total ? missing[done].name : "");
    }

    // Restore footer status, drop spinner, summarize.
    if (status) status.innerHTML = prevStatusHTML;
    if (btn) { btn.disabled = false; btn.classList.remove("spinning"); }
    const errPart = errors ? ` · ${errors} error${errors === 1 ? "" : "s"}` : "";
    if (cancelled) {
      showToast(_t("lora.civitai.cancelled",
        `Stopped at ${done}/${total} · fetched ${ok_count} · no match ${notfound}${errPart}`),
        "info");
    } else {
      showToast(_t("lora.civitai.bulkDone",
        `Fetched ${ok_count} · no match ${notfound}${errPart}`),
        errors ? "info" : "success");
    }
    await refreshLoras();
  }

  // Helper: filtered LoRAs matching the current folder + search.
  function getVisibleLoras() {
    let arr = allLoras;
    if (activeFolder) arr = arr.filter(l => (l.subfolder || "") === activeFolder);
    if (activeBaseModels.size) arr = arr.filter(l => activeBaseModels.has(_baseModelKey(l)));
    const q = searchQuery.toLowerCase();
    if (q) arr = arr.filter(l =>
      (l.name || "").toLowerCase().includes(q) ||
      (l.activation_text || "").toLowerCase().includes(q));
    return arr;
  }

  function pickPreviewFile(lora) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => savePreview(lora, reader.result);
      reader.readAsDataURL(file);
    });
    input.click();
  }

  function captureCanvasPreview(lora) {
    try {
      const canvas = document.getElementById("mainCanvas");
      if (!canvas) { console.warn(`${TAG} No main canvas found`); return; }
      savePreview(lora, canvas.toDataURL("image/png"));
    } catch (e) {
      console.error(`${TAG} Canvas capture failed:`, e);
    }
  }

  async function savePreview(lora, imageDataUrl) {
    try {
      const resp = await fetch("/studio/lora_preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: lora.name, image_b64: imageDataUrl }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const result = await resp.json();
      if (result.ok) { console.log(`${TAG} Preview saved for ${lora.name}`); await refreshLoras(); }
      else console.error(`${TAG} Preview save failed:`, result.error);
    } catch (e) { console.error(`${TAG} Preview save error:`, e); }
  }

  async function removePreview(lora) {
    try {
      const resp = await fetch(`/studio/lora_preview?name=${encodeURIComponent(lora.name)}`, {
        method: "DELETE",
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      console.log(`${TAG} Preview removed for ${lora.name}`);
      await refreshLoras();
    } catch (e) { console.error(`${TAG} Preview remove error:`, e); }
  }


  // ── Prompt Insertion ───────────────────────────────────
  function insertLora(lora) {
    const textarea = getTargetTextarea();
    if (!textarea) return;
    const weight = (lora.preferred_weight && lora.preferred_weight > 0)
      ? lora.preferred_weight : insertWeight;
    let text = `<lora:${lora.name.split("/").pop()}:${weight}>`;
    if (lora.activation_text) text += " " + lora.activation_text;
    insertAtCursor(textarea, text);
    console.log(`${TAG} Inserted ${text}`);
  }

  function insertAtCursor(textarea, text) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const val = textarea.value;
    let prefix = "";
    if (start > 0 && !/[\s,]$/.test(val.slice(0, start))) prefix = " ";
    textarea.value = val.slice(0, start) + prefix + text + val.slice(end);
    const newPos = start + prefix.length + text.length;
    textarea.selectionStart = textarea.selectionEnd = newPos;
    textarea.focus();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // Comma-separated tag insert into the last-focused prompt — keeps
  // prompt tags cleanly delimited when adding individual trigger words.
  function _insertTag(text) {
    const ta = getTargetTextarea();
    if (!ta || !text) return;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    const val = ta.value;
    const before = val.slice(0, start);
    const after = val.slice(end);
    const prefix = (before.length && !/[\s,]$/.test(before)) ? ", " : "";
    const suffix = (after.length && !/^[\s,]/.test(after)) ? ", " : "";
    ta.value = before + prefix + text + suffix + after;
    const pos = start + prefix.length + text.length + suffix.length;
    ta.selectionStart = ta.selectionEnd = pos;
    ta.focus();
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }


  // ── Detail / edit panel ────────────────────────────────
  // Edit a LoRA's user metadata (trigger words, model family, preferred
  // weight) — written to the a1111 <stem>.json sidecar, the highest-
  // precedence layer the listing reads — and insert trigger words
  // selectively, one at a time, so you can skip parts you don't want.
  let detailOverlay = null;

  function _triggerWords(text) {
    return String(text || "").split(",").map(s => s.trim()).filter(Boolean);
  }

  async function saveLoraMetadata(name, patch) {
    const resp = await fetch("/studio/lora_metadata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ name }, patch)),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || !data.ok) throw new Error((data && data.error) || `HTTP ${resp.status}`);
    return data;
  }

  function _injectDetailStyles() {
    if (document.getElementById("lora-detail-styles")) return;
    const s = document.createElement("style");
    s.id = "lora-detail-styles";
    s.textContent = `
.lora-detail-overlay {
  position: fixed; inset: 0; z-index: 320;
  background: rgba(0, 0, 0, 0.6);
  display: flex; align-items: center; justify-content: center;
}
.lora-detail-panel {
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); width: min(94vw, 460px);
  max-height: 88vh; display: flex; flex-direction: column;
  overflow: hidden; box-shadow: 0 16px 48px rgba(0,0,0,0.55);
}
.lora-detail-head {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 14px; border-bottom: 1px solid var(--border-subtle);
}
.lora-detail-title {
  font-family: var(--font); font-size: 13px; font-weight: 600;
  color: var(--text-1); flex: 1; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
.lora-detail-close {
  background: none; border: none; color: var(--text-3);
  font-size: 18px; cursor: pointer; line-height: 1; padding: 0 4px;
}
.lora-detail-close:hover { color: var(--text-1); }
.lora-detail-body { padding: 12px 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.lora-detail-field { display: flex; flex-direction: column; gap: 4px; }
.lora-detail-label { font-family: var(--font); font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--text-3); }
.lora-detail-input, .lora-detail-textarea {
  background: var(--bg-input); border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm); color: var(--text-1);
  font-family: var(--font); font-size: 12px; padding: 6px 8px;
  width: 100%; box-sizing: border-box; outline: none;
}
.lora-detail-input:focus, .lora-detail-textarea:focus { border-color: var(--accent); }
.lora-detail-textarea { resize: vertical; min-height: 54px; }
.lora-detail-weight { width: 80px; }
.lora-detail-hint { font-family: var(--font); font-size: 10px; color: var(--text-4); margin: 0; }
.lora-detail-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.lora-detail-chip {
  font-family: var(--font); font-size: 11px; padding: 3px 9px;
  border-radius: 999px; border: 1px solid var(--border);
  color: var(--text-2); background: var(--bg-raised); cursor: pointer;
  transition: all 0.12s; user-select: none;
}
.lora-detail-chip:hover { color: var(--accent-bright, var(--accent)); border-color: var(--accent); background: var(--accent-dim); }
.lora-detail-chips-empty { font-family: var(--font); font-size: 11px; color: var(--text-4); font-style: italic; }
.lora-detail-foot {
  display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end;
  padding: 12px 14px; border-top: 1px solid var(--border-subtle);
}
.lora-detail-btn {
  font-family: var(--font); font-size: 11px; padding: 5px 12px;
  border-radius: var(--radius-sm); border: 1px solid var(--border);
  color: var(--text-2); background: var(--bg-raised); cursor: pointer;
  transition: all 0.12s;
}
.lora-detail-btn:hover { color: var(--text-1); border-color: var(--border-hover, var(--accent)); }
.lora-detail-btn.primary { color: var(--accent-bright, var(--accent)); border-color: var(--accent); background: var(--accent-dim); }
`;
    document.head.appendChild(s);
  }

  function closeDetail() {
    if (detailOverlay) { detailOverlay.remove(); detailOverlay = null; }
  }

  function openDetail(lora) {
    _injectDetailStyles();
    closeDetail();
    const baseName = lora.name.split("/").pop();

    const overlay = document.createElement("div");
    overlay.className = "lora-detail-overlay";
    overlay.addEventListener("mousedown", e => { if (e.target === overlay) closeDetail(); });
    // Keep keystrokes inside the editor from leaking to the browser modal
    overlay.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Escape") closeDetail();
    });

    const panel = document.createElement("div");
    panel.className = "lora-detail-panel";

    // Header
    const head = document.createElement("div");
    head.className = "lora-detail-head";
    const title = document.createElement("span");
    title.className = "lora-detail-title";
    title.textContent = baseName;
    title.title = lora.name;
    const closeBtn = document.createElement("button");
    closeBtn.className = "lora-detail-close";
    closeBtn.innerHTML = "&times;";
    closeBtn.addEventListener("click", closeDetail);
    head.appendChild(title); head.appendChild(closeBtn);

    const body = document.createElement("div");
    body.className = "lora-detail-body";

    // Model family
    const familyField = document.createElement("div");
    familyField.className = "lora-detail-field";
    const familyLabel = document.createElement("label");
    familyLabel.className = "lora-detail-label";
    familyLabel.textContent = _t("lora.detail.family", "Model family");
    const familyInput = document.createElement("input");
    familyInput.className = "lora-detail-input";
    familyInput.type = "text";
    familyInput.value = lora.base_model || "";
    familyInput.placeholder = _t("lora.detail.familyPlaceholder", "e.g. SDXL, Pony, Illustrious, SD 1.5");
    familyField.appendChild(familyLabel); familyField.appendChild(familyInput);

    // Trigger words
    const trigField = document.createElement("div");
    trigField.className = "lora-detail-field";
    const trigLabel = document.createElement("label");
    trigLabel.className = "lora-detail-label";
    trigLabel.textContent = _t("lora.detail.triggers", "Trigger words (comma-separated)");
    const trigArea = document.createElement("textarea");
    trigArea.className = "lora-detail-textarea";
    trigArea.value = lora.activation_text || "";
    trigArea.placeholder = _t("lora.detail.triggersPlaceholder", "trigger, style tag, outfit…");
    trigField.appendChild(trigLabel); trigField.appendChild(trigArea);

    // Selective-insert chips
    const hint = document.createElement("p");
    hint.className = "lora-detail-hint";
    hint.textContent = _t("lora.detail.chipsHint", "Click a word to add just that one to your prompt:");
    const chips = document.createElement("div");
    chips.className = "lora-detail-chips";
    const renderChips = () => {
      chips.innerHTML = "";
      const words = _triggerWords(trigArea.value);
      if (!words.length) {
        const empty = document.createElement("span");
        empty.className = "lora-detail-chips-empty";
        empty.textContent = _t("lora.detail.noTriggers", "No trigger words");
        chips.appendChild(empty);
        return;
      }
      for (const w of words) {
        const chip = document.createElement("span");
        chip.className = "lora-detail-chip";
        chip.textContent = w;
        chip.addEventListener("click", () => _insertTag(w));
        chips.appendChild(chip);
      }
    };
    trigArea.addEventListener("input", renderChips);

    // Preferred weight
    const weightField = document.createElement("div");
    weightField.className = "lora-detail-field";
    const weightLabel = document.createElement("label");
    weightLabel.className = "lora-detail-label";
    weightLabel.textContent = _t("lora.detail.weight", "Preferred weight (0 = use default)");
    const weightInput = document.createElement("input");
    weightInput.className = "lora-detail-input lora-detail-weight";
    weightInput.type = "number"; weightInput.step = "0.05"; weightInput.min = "0"; weightInput.max = "2";
    weightInput.value = (lora.preferred_weight && lora.preferred_weight > 0) ? String(lora.preferred_weight) : "";
    weightField.appendChild(weightLabel); weightField.appendChild(weightInput);

    body.appendChild(familyField);
    body.appendChild(trigField);
    body.appendChild(hint);
    body.appendChild(chips);
    body.appendChild(weightField);

    // Footer actions
    const foot = document.createElement("div");
    foot.className = "lora-detail-foot";

    const insertAllBtn = document.createElement("button");
    insertAllBtn.className = "lora-detail-btn";
    insertAllBtn.textContent = _t("lora.detail.insertAll", "Insert all triggers");
    insertAllBtn.addEventListener("click", () => {
      const words = _triggerWords(trigArea.value);
      if (words.length) _insertTag(words.join(", "));
    });

    const insertLoraBtn = document.createElement("button");
    insertLoraBtn.className = "lora-detail-btn";
    insertLoraBtn.textContent = _t("lora.detail.insertLora", "Insert LoRA tag");
    insertLoraBtn.addEventListener("click", () => {
      const ta = getTargetTextarea();
      if (!ta) return;
      const w = (lora.preferred_weight && lora.preferred_weight > 0) ? lora.preferred_weight : insertWeight;
      insertAtCursor(ta, `<lora:${baseName}:${w}>`);
    });

    const saveBtn = document.createElement("button");
    saveBtn.className = "lora-detail-btn primary";
    saveBtn.textContent = _t("lora.detail.save", "Save");
    saveBtn.addEventListener("click", async () => {
      const wRaw = weightInput.value.trim();
      const patch = {
        activation_text: trigArea.value.trim(),
        base_model: familyInput.value.trim(),
        preferred_weight: wRaw === "" ? 0 : (parseFloat(wRaw) || 0),
      };
      saveBtn.disabled = true;
      try {
        await saveLoraMetadata(lora.name, patch);
        // Reflect immediately in the open browser (and base-model chips).
        lora.activation_text = patch.activation_text;
        lora.base_model = patch.base_model;
        lora.preferred_weight = patch.preferred_weight;
        title.textContent = baseName; // unchanged; keeps parity if renamed later
        renderBaseChips();
        renderGrid();
        window.showToast?.(_t("lora.detail.saved", "LoRA metadata saved"), "success");
        // Keep the LoRA Stack's trigger map fresh if present.
        window.LoraStack?.refreshTriggers?.(true);
      } catch (e) {
        console.error(`${TAG} metadata save failed:`, e);
        window.showToast?.(_t("lora.detail.saveFailed", "Couldn't save LoRA metadata"), "error");
      } finally {
        saveBtn.disabled = false;
      }
    });

    const closeFootBtn = document.createElement("button");
    closeFootBtn.className = "lora-detail-btn";
    closeFootBtn.textContent = _t("lora.detail.close", "Close");
    closeFootBtn.addEventListener("click", closeDetail);

    foot.appendChild(insertAllBtn);
    foot.appendChild(insertLoraBtn);
    foot.appendChild(saveBtn);
    foot.appendChild(closeFootBtn);

    panel.appendChild(head);
    panel.appendChild(body);
    panel.appendChild(foot);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    detailOverlay = overlay;
    renderChips();
    setTimeout(() => trigArea.focus(), 30);
  }


  // ── Open / Close ───────────────────────────────────────
  async function openModal() {
    pickCallback = null;
    await fetchLoras();
    buildModal();
    modal.style.display = "flex";
    renderFolderTree();
    renderBaseChips();
    renderGrid();
    const search = modal.querySelector(".lora-search");
    search.value = searchQuery;
    setTimeout(() => search.focus(), 50);
  }

  // Open in "pick mode": clicking a card invokes `cb(lora)` and keeps the
  // modal open so multiple picks can be made in one session. Esc / close
  // button still dismiss normally.
  async function openPick(cb) {
    pickCallback = typeof cb === "function" ? cb : null;
    await fetchLoras();
    buildModal();
    modal.style.display = "flex";
    renderFolderTree();
    renderBaseChips();
    renderGrid();
    const search = modal.querySelector(".lora-search");
    search.value = searchQuery;
    setTimeout(() => search.focus(), 50);
  }

  function closeModal() {
    closeDetail();
    if (modal) modal.style.display = "none";
    pickCallback = null;
    const target = getTargetTextarea();
    if (target) target.focus();
  }


  // ── Utility ────────────────────────────────────────────
  function escHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }


  // ── Init ───────────────────────────────────────────────
  function init() {
    injectStyles();
    _trackPromptFocus();

    // Ctrl+L: open the LoRA Stack picker. Card-click adds to the stack
    // via LoraStack.add — same modal as browse mode, different callback.
    // Falls back to insert-token browse mode if the stack module isn't
    // loaded (e.g. trimmed builds).
    document.addEventListener("keydown", e => {
      if (e.ctrlKey && e.key === "l" && !e.shiftKey && !e.altKey) {
        const active = document.activeElement;
        // AD-slot prompt focused → pick into THAT slot's LoRA stack, never the
        // global LoRA Stack. The visible "+ LoRAs" button is the primary control;
        // this is a convenience. Guarded so it no-ops until ADLoRAStack loads.
        const adMatch = active && active.id && active.id.match(/^paramAD([123])Prompt$/);
        if (adMatch) {
          e.preventDefault();
          if (modal && modal.style.display === "flex") { closeModal(); return; }
          const slot = Number(adMatch[1]);
          if (window.ADLoRAStack && typeof window.ADLoRAStack.add === "function") {
            openPick((lora, weight) => window.ADLoRAStack.add(slot, lora, weight));
          }
          return;
        }
        const isPrompt = active && (active.id === "paramPrompt" || active.id === "paramNeg");
        const isBody = !active || active === document.body;
        if (!isPrompt && !isBody) return;
        e.preventDefault();
        if (modal && modal.style.display === "flex") { closeModal(); return; }
        if (window.LoraStack && typeof window.LoraStack.add === "function") {
          openPick((lora, weight) => window.LoraStack.add(lora, weight));
        } else {
          openModal();
        }
      }
    });

    console.log(`${TAG} Initialized`);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.LoraBrowser = { open: openModal, openPick: openPick, close: closeModal, refresh: refreshLoras };
})();
