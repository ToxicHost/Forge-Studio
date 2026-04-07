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
  let _foldersDefaulted = false;  // collapse folders on first load
  let previewPane = null;      // content preview element
  let previewName = "";        // currently previewed wildcard

  // ── Keyboard navigation state (survives re-renders) ──
  let _kbPane = null;          // null = not in kb nav, "folders" or "items"
  let _kbFolderPath = null;    // folder path currently kb-focused
  let _kbItemIdx = -1;         // item index currently kb-focused

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
          <span class="wc-hint">Click name to preview &middot; Tab to navigate &middot; Arrows to browse</span>
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
      const searchEl = modal.querySelector(".wc-search");
      const inSearch = document.activeElement === searchEl;

      // Tab toggles between search and keyboard nav
      if (e.key === "Tab") {
        e.preventDefault();
        if (inSearch) {
          searchEl.blur();
          // Enter folder nav if not already navigating
          if (!_kbPane) _enterFolderNav();
        } else {
          _clearKbFocus();
          searchEl.focus();
        }
        e.stopPropagation();
        return;
      }

      // Arrow keys only when NOT in search
      if (!inSearch && (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        _wcHandleKey(e.key);
      }
      // Enter on kb-focused item
      if (!inSearch && e.key === "Enter") {
        e.preventDefault();
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

    // Re-apply keyboard focus after DOM rebuild
    if (_kbPane === "folders" && _kbFolderPath !== null) {
      const match = container.querySelector(`.wc-folder-item .wc-folder-name[title="${_kbFolderPath || "All Wildcards"}"]`);
      if (match) match.closest(".wc-folder-item").classList.add("kb-focus");
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

    // Re-apply keyboard focus after DOM rebuild
    if (_kbPane === "items" && _kbItemIdx >= 0) {
      const items = listEl.querySelectorAll(".wc-item");
      if (items[_kbItemIdx]) items[_kbItemIdx].classList.add("kb-focus");
    }
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
    _clearKbFocus();
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

  // ── Keyboard Navigation ────────────────────────────────
  function _clearKbFocus() {
    _kbPane = null;
    _kbFolderPath = null;
    _kbItemIdx = -1;
    if (!modal) return;
    modal.querySelectorAll(".kb-focus").forEach(el => el.classList.remove("kb-focus"));
  }

  function _getVisibleFolderPaths() {
    // Return folder paths in DOM order (matches renderFolderTree output)
    const paths = [""];  // "All" is always first
    const unsorted = allWildcards.some(w => !w.name.includes("/"));
    if (unsorted) paths.push("__unsorted__");
    for (const f of folders) {
      if (!isAncestorCollapsed(f)) paths.push(f);
    }
    return paths;
  }

  function _applyFolderFocus(path) {
    _kbPane = "folders";
    _kbFolderPath = path;
    _kbItemIdx = -1;
    modal.querySelectorAll(".kb-focus").forEach(el => el.classList.remove("kb-focus"));
    const title = path || "All Wildcards";
    const nameEl = modal.querySelector(`.wc-folder-name[title="${title}"]`);
    if (nameEl) {
      const item = nameEl.closest(".wc-folder-item");
      item.classList.add("kb-focus");
      item.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  function _enterFolderNav() {
    // Start on the currently active folder, or "All"
    const path = activeFolder ?? "";
    _applyFolderFocus(path);
  }

  function _selectFolder(path) {
    activeFolder = path;
    modal.querySelectorAll(".wc-folder-item").forEach(el => el.classList.remove("active"));
    const title = path || "All Wildcards";
    const nameEl = modal.querySelector(`.wc-folder-name[title="${title}"]`);
    if (nameEl) nameEl.closest(".wc-folder-item").classList.add("active");
    renderList();
    // Re-apply folder kb-focus (renderList doesn't touch folders)
    _applyFolderFocus(path);
  }

  function _wcHandleKey(key) {
    if (!modal) return;

    // If not yet navigating, enter folder nav on any arrow
    if (!_kbPane) {
      _enterFolderNav();
      return;
    }

    if (key === "Enter") {
      if (_kbPane === "items" && _kbItemIdx >= 0) {
        const items = Array.from(modal.querySelectorAll(".wc-item"));
        const item = items[_kbItemIdx];
        if (item) {
          const btn = item.querySelector(".wc-item-insert");
          if (btn) btn.click();
        }
      }
      return;
    }

    if (key === "ArrowUp" || key === "ArrowDown") {
      const dir = key === "ArrowDown" ? 1 : -1;

      if (_kbPane === "folders") {
        const paths = _getVisibleFolderPaths();
        if (!paths.length) return;
        let cur = paths.indexOf(_kbFolderPath);
        if (cur === -1) cur = 0;
        let next = cur + dir;
        if (next < 0) next = paths.length - 1;
        if (next >= paths.length) next = 0;
        _applyFolderFocus(paths[next]);
        // Also select the folder to update the item list
        _selectFolder(paths[next]);
      } else {
        const items = Array.from(modal.querySelectorAll(".wc-item"));
        if (!items.length) return;
        let next = _kbItemIdx + dir;
        if (next < 0) next = items.length - 1;
        if (next >= items.length) next = 0;
        _kbItemIdx = next;
        modal.querySelectorAll(".wc-item.kb-focus").forEach(el => el.classList.remove("kb-focus"));
        items[next].classList.add("kb-focus");
        items[next].scrollIntoView({ block: "nearest", behavior: "smooth" });
        // Show preview for this item
        const nameEl = items[next].querySelector(".wc-item-name");
        if (nameEl) {
          const wcName = nameEl.getAttribute("title");
          modal.querySelectorAll(".wc-item").forEach(el => el.classList.remove("active"));
          items[next].classList.add("active");
          showPreview(wcName);
        }
      }
    }

    if (key === "ArrowLeft") {
      if (_kbPane === "items") {
        // Move to folder pane
        _kbItemIdx = -1;
        modal.querySelectorAll(".wc-item.kb-focus").forEach(el => el.classList.remove("kb-focus"));
        _applyFolderFocus(activeFolder ?? "");
      } else {
        // Collapse current folder if expanded and has children
        if (_kbFolderPath && _kbFolderPath !== "__unsorted__" && !collapsedFolders.has(_kbFolderPath)) {
          const hasChildren = folders.some(f => f !== _kbFolderPath && f.startsWith(_kbFolderPath + "/"));
          if (hasChildren) {
            collapsedFolders.add(_kbFolderPath);
            renderFolderTree();  // kb-focus re-applied by renderFolderTree
            return;
          }
        }
        // Otherwise move up to parent folder
        if (_kbFolderPath && _kbFolderPath.includes("/")) {
          const parent = _kbFolderPath.split("/").slice(0, -1).join("/");
          _applyFolderFocus(parent);
          _selectFolder(parent);
        }
      }
    }

    if (key === "ArrowRight") {
      if (_kbPane === "folders") {
        // If folder is collapsed and has children, expand it
        if (_kbFolderPath && collapsedFolders.has(_kbFolderPath)) {
          const hasChildren = folders.some(f => f !== _kbFolderPath && f.startsWith(_kbFolderPath + "/"));
          if (hasChildren) {
            collapsedFolders.delete(_kbFolderPath);
            renderFolderTree();  // kb-focus re-applied by renderFolderTree
            return;
          }
        }
        // Move to items pane
        _kbPane = "items";
        _kbItemIdx = 0;
        modal.querySelectorAll(".wc-folder-item.kb-focus").forEach(el => el.classList.remove("kb-focus"));
        const items = modal.querySelectorAll(".wc-item");
        if (items.length) {
          items[0].classList.add("kb-focus");
          items[0].scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      }
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.WildcardBrowser = { open: openModal, close: closeModal, refresh: refreshWildcards };
})();
