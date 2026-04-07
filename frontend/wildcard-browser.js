/**
 * Forge Studio — Wildcard Browser
 * by ToxicHost & Moritz
 *
 * Modal overlay for browsing and inserting wildcards into prompts.
 * Companion to the Lexicon wildcard editor — this is the quick-insert tool.
 * Self-contained: injects its own CSS, builds its own DOM, manages its own state.
 *
 * Features:
 *   - Folder tree navigation from wildcard paths
 *   - Search by name
 *   - Content preview: click a card to see wildcard entries before inserting
 *   - Click-to-insert __wildcard__ syntax
 *   - Works for both positive and negative prompts
 *   - Refresh without reloading the UI
 *   - Ctrl+Shift+L keyboard shortcut
 */
(function () {
  "use strict";

  const TAG = "[Wildcard Browser]";

  // ── State ──────────────────────────────────────────────
  let allWildcards = [];
  let folders = [];
  let activeFolder = "";
  let searchQuery = "";
  let sortMode = "name";
  let modal = null;
  let loaded = false;
  let collapsedFolders = new Set();
  let _foldersDefaulted = false;
  let previewPane = null;      // content preview element
  let previewName = "";        // currently previewed wildcard

  // ── Shared: prompt focus tracking (set up by lora-browser or us) ──
  function _trackPromptFocus() {
    if (window._studioPromptTracker) return;
    window._studioPromptTracker = true;
    window._studioLastPrompt = document.getElementById("paramPrompt");
    for (const id of ["paramPrompt", "paramNeg"]) {
      const el = document.getElementById(id);
      if (el) el.addEventListener("focusin", () => { window._studioLastPrompt = el; });
    }
  }

  function getTargetTextarea() {
    return window._studioLastPrompt || document.getElementById("paramPrompt");
  }

  // ── CSS Injection ──────────────────────────────────────
  function injectStyles() {
    if (document.getElementById("wildcard-browser-styles")) return;
    const style = document.createElement("style");
    style.id = "wildcard-browser-styles";
    style.textContent = `
/* ── Wildcard modal ──────────────────────────── */
.wc-overlay {
  position: fixed; inset: 0; z-index: 300;
  background: rgba(0, 0, 0, 0.88);
  display: flex; align-items: center; justify-content: center;
  animation: wc-fade-in 0.15s ease;
}
@keyframes wc-fade-in { from { opacity: 0; } to { opacity: 1; } }

.wc-modal {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  width: min(90vw, 900px);
  height: min(80vh, 640px);
  display: flex; flex-direction: column;
  overflow: hidden;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
}

.wc-header {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.wc-title {
  font-family: var(--font); font-size: 11px;
  font-weight: 600; color: var(--text-3);
  text-transform: uppercase; letter-spacing: 0.5px;
  white-space: nowrap;
}
.wc-search {
  flex: 1;
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  font-family: var(--font); font-size: 12px;
  color: var(--text-1); outline: none;
  transition: border-color 0.12s;
}
.wc-search:focus { border-color: var(--accent); }
.wc-search::placeholder { color: var(--text-4); }

.wc-header-btn {
  background: var(--bg-raised);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  color: var(--text-3);
  cursor: pointer; padding: 4px 6px;
  line-height: 1; transition: all 0.12s;
  display: flex; align-items: center; justify-content: center;
}
.wc-header-btn:hover { color: var(--text-1); border-color: var(--border-hover); }
.wc-header-btn.spinning svg { animation: wc-spin 0.6s linear; }
@keyframes wc-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.wc-close {
  background: none; border: none;
  color: var(--text-3); font-size: 18px;
  cursor: pointer; padding: 4px 6px;
  line-height: 1; transition: color 0.12s;
}
.wc-close:hover { color: var(--text-1); }

.wc-body { display: flex; flex: 1; overflow: hidden; }

/* Folder sidebar */
.wc-folders {
  width: 160px; flex-shrink: 0;
  border-right: 1px solid var(--border);
  overflow-y: auto; padding: 8px 0;
}
.wc-folder-item {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 12px;
  font-family: var(--font); font-size: 11px;
  color: var(--text-2); cursor: pointer;
  transition: all 0.12s;
  border-left: 2px solid transparent;
}
.wc-folder-item:hover { background: var(--bg-raised); color: var(--text-1); }
.wc-folder-item.active {
  color: var(--accent-bright, var(--accent));
  border-left-color: var(--accent);
  background: var(--accent-dim);
}
.wc-folder-icon { font-size: 12px; opacity: 0.6; width: 14px; text-align: center; flex-shrink: 0; }
.wc-folder-toggle { cursor: pointer; opacity: 0.8; transition: opacity 0.12s; }
.wc-folder-toggle:hover { opacity: 1; }
.wc-folder-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.wc-folder-count { font-family: var(--mono); font-size: 9px; color: var(--text-4); flex-shrink: 0; }

/* Content area: list + preview side-by-side */
.wc-content { display: flex; flex: 1; overflow: hidden; }

.wc-list-wrap { flex: 1; overflow-y: auto; padding: 6px; }
.wc-list { display: flex; flex-direction: column; gap: 2px; }

.wc-item {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px;
  background: var(--bg-raised);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  cursor: pointer; transition: all 0.12s;
}
.wc-item:hover { border-color: var(--accent); }
.wc-item.active { border-color: var(--accent); background: var(--accent-dim); }
.wc-item.inserted { border-color: var(--green); box-shadow: 0 0 6px var(--green-dim); }
.wc-item-name {
  flex: 1; font-family: var(--mono); font-size: 11px;
  color: var(--text-2); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
.wc-item-insert {
  background: var(--accent); color: #fff; border: none;
  border-radius: var(--radius-sm);
  font-family: var(--font); font-size: 9px; font-weight: 600;
  padding: 2px 8px; cursor: pointer;
  text-transform: uppercase; letter-spacing: 0.3px;
  opacity: 0; transition: opacity 0.12s;
}
.wc-item:hover .wc-item-insert { opacity: 1; }
.wc-item.kb-focus { border-color: var(--accent); outline: 1px solid var(--accent); outline-offset: -1px; }
.wc-folder-item.kb-focus { background: var(--bg-raised); color: var(--text-1); }

/* Preview pane */
.wc-preview {
  width: 240px; flex-shrink: 0;
  border-left: 1px solid var(--border);
  overflow-y: auto; padding: 10px;
  display: none;
}
.wc-preview.visible { display: block; }
.wc-preview-title {
  font-family: var(--mono); font-size: 11px;
  color: var(--accent); margin-bottom: 6px;
  word-break: break-all;
}
.wc-preview-count {
  font-family: var(--font); font-size: 10px;
  color: var(--text-4); margin-bottom: 8px;
}
.wc-preview-edit {
  display: block; width: 100%;
  background: var(--bg-raised);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  color: var(--text-2);
  font-family: var(--font); font-size: 10px;
  padding: 5px 8px; margin-bottom: 8px;
  cursor: pointer; transition: all 0.12s;
  text-align: center;
}
.wc-preview-edit:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-dim);
}
.wc-preview-entries {
  display: flex; flex-direction: column; gap: 2px;
}
.wc-preview-entry {
  font-family: var(--font); font-size: 10px;
  color: var(--text-2); padding: 2px 4px;
  background: var(--bg-input); border-radius: 3px;
  overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap;
}

/* Footer */
.wc-footer {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 14px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
.wc-status { font-family: var(--font); font-size: 10px; color: var(--text-4); }
.wc-hint { font-family: var(--font); font-size: 10px; color: var(--text-4); }

.wc-empty { display: flex; align-items: center; justify-content: center; flex: 1; padding: 40px; }
.wc-empty-text { font-family: var(--font); font-size: 12px; color: var(--text-3); text-align: center; }

.wc-list-wrap::-webkit-scrollbar, .wc-folders::-webkit-scrollbar, .wc-preview::-webkit-scrollbar { width: 6px; }
.wc-list-wrap::-webkit-scrollbar-track, .wc-folders::-webkit-scrollbar-track, .wc-preview::-webkit-scrollbar-track { background: transparent; }
.wc-list-wrap::-webkit-scrollbar-thumb, .wc-folders::-webkit-scrollbar-thumb, .wc-preview::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

@media (max-width: 640px) {
  .wc-folders { display: none; }
  .wc-preview { display: none !important; }
  .wc-modal { width: 95vw; height: 85vh; }
}
`;
    document.head.appendChild(style);
  }


  // ── Data Loading ───────────────────────────────────────
  async function fetchWildcards(force) {
    if (loaded && !force) return;
    try {
      const resp = await fetch("/studio/wildcards");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      allWildcards = await resp.json();

      const folderSet = new Set();
      for (const w of allWildcards) {
        const parts = w.name.split("/");
        if (parts.length > 1) {
          // Add all ancestor paths
          for (let i = 1; i < parts.length; i++) {
            folderSet.add(parts.slice(0, i).join("/"));
          }
        }
      }
      folders = [...folderSet].sort((a, b) => a.localeCompare(b));
      // Collapse all folders by default on first load
      if (!_foldersDefaulted) {
        _foldersDefaulted = true;
        for (const f of folders) collapsedFolders.add(f);
      }
      loaded = true;
      console.log(`${TAG} Loaded ${allWildcards.length} wildcards in ${folders.length} folders`);
    } catch (e) {
      console.error(`${TAG} Failed to fetch wildcards:`, e);
    }
  }

  async function refreshWildcards() {
    const btn = modal?.querySelector(".wc-refresh-btn");
    if (btn) btn.classList.add("spinning");
    loaded = false;
    await fetchWildcards(true);
    if (modal) { renderFolderTree(); renderList(); }
    if (btn) setTimeout(() => btn.classList.remove("spinning"), 300);
  }


  // ── Filtering ──────────────────────────────────────────
  function getFiltered() {
    let list = allWildcards;
    if (activeFolder === "__unsorted__") {
      list = list.filter(w => !w.name.includes("/"));
    } else if (activeFolder) {
      list = list.filter(w => w.name.startsWith(activeFolder + "/"));
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(w => w.name.toLowerCase().includes(q));
    }
    switch (sortMode) {
      case "name":
        list = [...list].sort((a, b) => a.name.localeCompare(b.name));
        break;
    }
    return list;
  }


  // ── DOM Building ───────────────────────────────────────
  const REFRESH_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`;

  function buildModal() {
    if (modal) return;
    modal = document.createElement("div");
    modal.className = "wc-overlay";
    modal.innerHTML = `
      <div class="wc-modal">
        <div class="wc-header">
          <span class="wc-title">Wildcards</span>
          <input class="wc-search" type="text" placeholder="Search wildcards..." spellcheck="false" autocomplete="off">
          <button class="wc-header-btn wc-refresh-btn" title="Refresh wildcard list">${REFRESH_SVG}</button>
          <button class="wc-close" title="Close (Esc)">&times;</button>
        </div>
        <div class="wc-body">
          <div class="wc-folders"></div>
          <div class="wc-content">
            <div class="wc-list-wrap"><div class="wc-list"></div></div>
            <div class="wc-preview"></div>
          </div>
        </div>
        <div class="wc-footer">
          <span class="wc-status"></span>
          <span class="wc-hint">Click name to preview &middot; Insert button adds to prompt</span>
        </div>
      </div>
    `;

    previewPane = modal.querySelector(".wc-preview");

    modal.querySelector(".wc-close").addEventListener("click", closeModal);
    modal.addEventListener("mousedown", e => { if (e.target === modal) closeModal(); });

    const searchInput = modal.querySelector(".wc-search");
    let searchTimer = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { searchQuery = searchInput.value.trim(); renderList(); }, 120);
    });

    modal.querySelector(".wc-refresh-btn").addEventListener("click", refreshWildcards);

    modal.addEventListener("keydown", e => {
      if (e.key === "Escape") { closeModal(); e.stopPropagation(); return; }
      // Arrow key navigation — works regardless of search focus
      if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight" || (e.key === "Enter" && document.activeElement !== modal.querySelector(".wc-search"))) {
        e.preventDefault();
        // Blur search if focused so navigation takes over
        const searchEl = modal.querySelector(".wc-search");
        if (document.activeElement === searchEl) searchEl.blur();
        _wcHandleKey(e.key);
      }
      e.stopPropagation();
    });
    modal.addEventListener("keyup", e => e.stopPropagation());

    document.body.appendChild(modal);
  }

  function renderFolderTree() {
    const container = modal.querySelector(".wc-folders");
    container.innerHTML = "";
    container.appendChild(makeFolderItem("", "All", allWildcards.length, false, 0));

    // Count wildcards not in any folder ("Unsorted")
    const unsortedCount = allWildcards.filter(w => !w.name.includes("/")).length;
    if (unsortedCount > 0) {
      container.appendChild(makeFolderItem("__unsorted__", "Unsorted", unsortedCount, false, 0));
    }

    for (const folder of folders) {
      if (isAncestorCollapsed(folder)) continue;

      const count = allWildcards.filter(w => w.name.startsWith(folder + "/")).length;
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
    item.className = "wc-folder-item" + (activeFolder === folderPath ? " active" : "");
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
      <span class="wc-folder-icon${hasChildren ? " wc-folder-toggle" : ""}">${icon}</span>
      <span class="wc-folder-name" title="${folderPath || "All Wildcards"}">${displayName}</span>
      <span class="wc-folder-count">${count}</span>
    `;

    if (hasChildren) {
      item.querySelector(".wc-folder-icon").addEventListener("click", e => {
        e.stopPropagation();
        if (collapsedFolders.has(folderPath)) collapsedFolders.delete(folderPath);
        else collapsedFolders.add(folderPath);
        renderFolderTree();
      });
    }

    item.addEventListener("click", () => {
      activeFolder = folderPath;
      modal.querySelectorAll(".wc-folder-item").forEach(el => el.classList.remove("active"));
      item.classList.add("active");
      renderList();
    });
    return item;
  }

  function renderList() {
    const listEl = modal.querySelector(".wc-list");
    const wrap = modal.querySelector(".wc-list-wrap");
    const status = modal.querySelector(".wc-status");
    const filtered = getFiltered();

    status.textContent = `${filtered.length} wildcard${filtered.length !== 1 ? "s" : ""}`;
    const oldEmpty = wrap.querySelector(".wc-empty");
    if (oldEmpty) oldEmpty.remove();

    if (!filtered.length) {
      listEl.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "wc-empty";
      empty.innerHTML = `<span class="wc-empty-text">${allWildcards.length === 0 ? "No wildcards found" : "No wildcards match your search"}</span>`;
      wrap.appendChild(empty);
      hidePreview();
      return;
    }

    const frag = document.createDocumentFragment();
    for (const wc of filtered) {
      const row = document.createElement("div");
      row.className = "wc-item" + (previewName === wc.name ? " active" : "");
      row.innerHTML = `
        <span class="wc-item-name" title="${escHtml(wc.name)}">${escHtml(wc.name)}</span>
        <button class="wc-item-insert" title="Insert into prompt">Insert</button>
      `;

      // Click name area: show preview
      row.querySelector(".wc-item-name").addEventListener("click", () => {
        modal.querySelectorAll(".wc-item").forEach(el => el.classList.remove("active"));
        row.classList.add("active");
        showPreview(wc.name);
      });

      // Click insert button
      row.querySelector(".wc-item-insert").addEventListener("click", e => {
        e.stopPropagation();
        insertWildcard(wc.name);
        row.classList.add("inserted");
        setTimeout(() => row.classList.remove("inserted"), 600);
      });

      frag.appendChild(row);
    }
    listEl.innerHTML = "";
    listEl.appendChild(frag);
  }


  // ── Preview ────────────────────────────────────────────
  function switchToWildcardsModule() {
    const name = previewName;
    closeModal();
    // Find and click the Wildcards/Lexicon tab button
    const tabBar = document.getElementById("appTabs");
    if (!tabBar) return;
    const btn = tabBar.querySelector('button[data-module="lexicon"]');
    if (btn) {
      btn.click();
      // Open the specific file after the module activates
      if (name && window.LexiconAPI?.openFile) {
        // Small delay to let the module init/activate if it hasn't yet
        // Lexicon paths include .txt extension; wildcard browser names don't
        setTimeout(() => window.LexiconAPI.openFile(name + ".txt"), 100);
      }
    }
  }

  async function showPreview(name) {
    previewName = name;
    previewPane.classList.add("visible");
    previewPane.innerHTML = `
      <div class="wc-preview-title">__${escHtml(name)}__</div>
      <button class="wc-preview-edit" title="Open in Wildcards editor">Edit in Wildcards</button>
      <div class="wc-preview-count">Loading...</div>
      <div class="wc-preview-entries"></div>
    `;

    // Wire up the edit button
    previewPane.querySelector(".wc-preview-edit").addEventListener("click", switchToWildcardsModule);

    try {
      const resp = await fetch(`/studio/wildcard_content?name=${encodeURIComponent(name)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      if (previewName !== name) return; // stale

      const countEl = previewPane.querySelector(".wc-preview-count");
      countEl.textContent = `${data.count} entries${data.truncated ? " (showing first 50)" : ""}`;

      const entriesEl = previewPane.querySelector(".wc-preview-entries");
      entriesEl.innerHTML = "";
      for (const line of data.lines) {
        const el = document.createElement("div");
        el.className = "wc-preview-entry";
        el.textContent = line;
        el.title = line;
        entriesEl.appendChild(el);
      }
    } catch (e) {
      console.error(`${TAG} Preview fetch failed:`, e);
      const countEl = previewPane.querySelector(".wc-preview-count");
      if (countEl) countEl.textContent = "Failed to load";
    }
  }

  function hidePreview() {
    previewName = "";
    if (previewPane) {
      previewPane.classList.remove("visible");
      previewPane.innerHTML = "";
    }
  }


  // ── Prompt Insertion ───────────────────────────────────
  function insertWildcard(name) {
    const textarea = getTargetTextarea();
    if (!textarea) return;
    const tag = `__${name}__`;
    insertAtCursor(textarea, tag);
    console.log(`${TAG} Inserted ${tag}`);
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


  // ── Open / Close ───────────────────────────────────────
  async function openModal() {
    await fetchWildcards();
    buildModal();
    modal.style.display = "flex";
    renderFolderTree();
    renderList();
    const search = modal.querySelector(".wc-search");
    search.value = searchQuery;
    setTimeout(() => search.focus(), 50);
  }

  function closeModal() {
    if (modal) modal.style.display = "none";
    const target = getTargetTextarea();
    if (target) target.focus();
  }


  // ── Utility ────────────────────────────────────────────
  function escHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function ensureUtilsBar(promptBoxEl) {
    let bar = promptBoxEl.querySelector(".prompt-utils-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "prompt-utils-bar";
      promptBoxEl.appendChild(bar);
    }
    return bar;
  }


  // ── Init ───────────────────────────────────────────────
  function makeButton() {
    const btn = document.createElement("button");
    btn.className = "prompt-browser-btn";
    btn.textContent = "Wildcard";
    btn.title = "Browse Wildcards (Ctrl+Shift+L)";
    btn.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); openModal(); });
    return btn;
  }

  function init() {
    injectStyles();
    _trackPromptFocus();

    // Positive prompt: use existing token bar
    const tokenBar = document.getElementById("tokenBar");
    const posBox = document.getElementById("paramPrompt")?.closest(".prompt-box");
    if (tokenBar) tokenBar.prepend(makeButton());
    else if (posBox) ensureUtilsBar(posBox).appendChild(makeButton());

    // Negative prompt: create or reuse utils bar
    const negBox = document.getElementById("paramNeg")?.closest(".prompt-box");
    if (negBox) ensureUtilsBar(negBox).appendChild(makeButton());

    // Ctrl+Shift+L shortcut
    document.addEventListener("keydown", e => {
      if (e.ctrlKey && e.shiftKey && e.key === "L") {
        const active = document.activeElement;
        const isPrompt = active && (active.id === "paramPrompt" || active.id === "paramNeg");
        const isBody = !active || active === document.body;
        if (isPrompt || isBody) {
          e.preventDefault();
          if (modal && modal.style.display === "flex") closeModal();
          else openModal();
        }
      }
    });

    console.log(`${TAG} Initialized`);
  }

  // Track which pane has keyboard focus: "folders" or "items"
  let _wcNavPane = "items";

  function _wcHandleKey(key) {
    if (!modal) return;

    // Enter on focused item: insert the wildcard
    if (key === "Enter") {
      const focusedItem = modal.querySelector(".wc-item.kb-focus");
      if (focusedItem) {
        const insertBtn = focusedItem.querySelector(".wc-item-insert");
        if (insertBtn) insertBtn.click();
      }
      return;
    }

    if (key === "ArrowUp" || key === "ArrowDown") {
      if (_wcNavPane === "folders") {
        const fi = Array.from(modal.querySelectorAll(".wc-folder-item"));
        if (!fi.length) return;
        const curIdx = fi.findIndex(el => el.classList.contains("kb-focus"));
        let next;
        if (key === "ArrowDown") next = curIdx < fi.length - 1 ? curIdx + 1 : 0;
        else next = curIdx > 0 ? curIdx - 1 : fi.length - 1;
        fi.forEach(el => el.classList.remove("kb-focus"));
        fi[next].classList.add("kb-focus");
        fi[next].click();
        fi[next].scrollIntoView({ block: "nearest", behavior: "smooth" });
      } else {
        const items = Array.from(modal.querySelectorAll(".wc-item"));
        if (!items.length) return;
        const curIdx = items.findIndex(el => el.classList.contains("kb-focus") || el.classList.contains("active"));
        let next;
        if (key === "ArrowDown") next = curIdx < items.length - 1 ? curIdx + 1 : 0;
        else next = curIdx > 0 ? curIdx - 1 : items.length - 1;
        items.forEach(el => el.classList.remove("kb-focus"));
        items[next].classList.add("kb-focus");
        const nameEl = items[next].querySelector(".wc-item-name");
        if (nameEl) nameEl.click();
        items[next].scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }

    if (key === "ArrowLeft") {
      if (_wcNavPane === "items") {
        _wcNavPane = "folders";
        modal.querySelectorAll(".wc-item").forEach(el => el.classList.remove("kb-focus"));
        const activeF = modal.querySelector(".wc-folder-item.active") || modal.querySelector(".wc-folder-item");
        if (activeF) {
          modal.querySelectorAll(".wc-folder-item").forEach(el => el.classList.remove("kb-focus"));
          activeF.classList.add("kb-focus");
          activeF.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      } else {
        const focused = modal.querySelector(".wc-folder-item.kb-focus");
        if (focused) {
          const toggle = focused.querySelector(".wc-folder-toggle");
          const folderPath = focused.querySelector(".wc-folder-name")?.title;
          if (toggle && folderPath && folderPath !== "All Wildcards" && !collapsedFolders.has(folderPath)) {
            toggle.click();
          }
        }
      }
    }

    if (key === "ArrowRight") {
      if (_wcNavPane === "folders") {
        const focused = modal.querySelector(".wc-folder-item.kb-focus");
        if (focused) {
          const toggle = focused.querySelector(".wc-folder-toggle");
          const folderPath = focused.querySelector(".wc-folder-name")?.title;
          if (toggle && folderPath && collapsedFolders.has(folderPath)) {
            toggle.click();
            return;
          }
        }
        _wcNavPane = "items";
        modal.querySelectorAll(".wc-folder-item").forEach(el => el.classList.remove("kb-focus"));
        const firstItem = modal.querySelector(".wc-item.active") || modal.querySelector(".wc-item");
        if (firstItem) {
          firstItem.classList.add("kb-focus");
          firstItem.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      }
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.WildcardBrowser = { open: openModal, close: closeModal, refresh: refreshWildcards };
})();
