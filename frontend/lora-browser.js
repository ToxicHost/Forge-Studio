/**
 * Forge Studio — LoRA Browser
 * by ToxicHost & Moritz
 *
 * Modal overlay for browsing, searching, and inserting LoRAs into prompts.
 * Self-contained: injects its own CSS, builds its own DOM, manages its own state.
 * Trigger buttons injected into both positive and negative prompt boxes on init.
 *
 * Features:
 *   - Folder tree navigation with subfolder support
 *   - Search, sort (name/date/size), configurable insert weight
 *   - Preview thumbnails where available
 *   - Set preview from disk upload or canvas capture (right-click card)
 *   - Refresh without reloading the UI
 *   - Works for both positive and negative prompts
 *   - Ctrl+L keyboard shortcut
 */
(function () {
  "use strict";

  const TAG = "[LoRA Browser]";

  // ── State ──────────────────────────────────────────────
  let allLoras = [];
  let folders = [];
  let activeFolder = "";
  let searchQuery = "";
  let sortMode = "name";
  let insertWeight = 1.0;
  let modal = null;
  let loaded = false;
  let collapsedFolders = new Set();

  // ── Shared: last-focused prompt tracking ───────────────
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
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.3px;
  padding: 2px 7px;
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
    if (modal) { renderFolderTree(); renderGrid(); }
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


  // ── Filtering & Sorting ────────────────────────────────
  function getFiltered() {
    let list = allLoras;
    if (activeFolder) list = list.filter(l => l.subfolder === activeFolder);
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
          <input class="lora-search" type="text" placeholder="Search LoRAs..." spellcheck="false" autocomplete="off">
          <select class="lora-sort">
            <option value="name">Name</option>
            <option value="date">Newest</option>
            <option value="size">Largest</option>
          </select>
          <div class="lora-weight-wrap">
            <span class="lora-weight-label">Weight</span>
            <input class="lora-weight-input" type="number" min="0" max="2" step="0.05" value="1">
          </div>
          <button class="lora-header-btn lora-refresh-btn" title="Refresh LoRA list">${REFRESH_SVG}</button>
          <button class="lora-close" title="Close (Esc)">&times;</button>
        </div>
        <div class="lora-body">
          <div class="lora-folders"></div>
          <div class="lora-grid-wrap"><div class="lora-grid"></div></div>
        </div>
        <div class="lora-footer">
          <span class="lora-status"></span>
          <button class="lora-open-folder" title="Open LoRA folder in file manager">Open Folder</button>
          <span class="lora-hint">Click to insert &middot; Right-click for options</span>
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
      <span class="lora-folder-name" title="${folderPath || "All LoRAs"}">${displayName}</span>
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
      empty.innerHTML = `<span class="lora-empty-text">${allLoras.length === 0 ? "No LoRAs found in your models/Lora directory" : "No LoRAs match your search"}</span>`;
      wrap.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const lora of filtered) {
      const card = document.createElement("div");
      card.className = "lora-card";
      card.title = lora.activation_text
        ? `${lora.name}\nTrigger: ${lora.activation_text}`
        : lora.name;
      const baseName = lora.name.split("/").pop();
      const triggerHtml = lora.activation_text
        ? `<div class="lora-card-trigger" title="${escHtml(lora.activation_text)}">${escHtml(lora.activation_text)}</div>`
        : "";

      if (lora.preview) {
        card.innerHTML = `
          <img class="lora-card-preview" src="${lora.preview}" loading="lazy" alt=""
               onerror="this.outerHTML='<div class=\\'lora-card-placeholder\\'><span class=\\'lora-card-placeholder-text\\'>${escHtml(baseName)}</span></div>'">
          <div class="lora-card-info"><div class="lora-card-name">${escHtml(baseName)}</div>${triggerHtml}<div class="lora-card-meta">${formatSize(lora.size)}</div></div>`;
      } else {
        card.innerHTML = `
          <div class="lora-card-placeholder"><span class="lora-card-placeholder-text">${escHtml(baseName)}</span></div>
          <div class="lora-card-info"><div class="lora-card-name">${escHtml(baseName)}</div>${triggerHtml}<div class="lora-card-meta">${formatSize(lora.size)}</div></div>`;
      }

      card.addEventListener("click", e => {
        if (e.target.closest(".lora-card-menu")) return;
        insertLora(lora);
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

    const btnUpload = document.createElement("button");
    btnUpload.className = "lora-card-menu-item";
    btnUpload.textContent = "Set preview from file\u2026";
    btnUpload.addEventListener("click", () => { dismissContextMenu(); pickPreviewFile(lora); });
    menu.appendChild(btnUpload);

    const btnCanvas = document.createElement("button");
    btnCanvas.className = "lora-card-menu-item";
    btnCanvas.textContent = "Set preview from canvas";
    btnCanvas.addEventListener("click", () => { dismissContextMenu(); captureCanvasPreview(lora); });
    menu.appendChild(btnCanvas);

    if (lora.preview) {
      const sep = document.createElement("div"); sep.className = "lora-card-menu-sep";
      menu.appendChild(sep);
      const btnRm = document.createElement("button");
      btnRm.className = "lora-card-menu-item";
      btnRm.textContent = "Remove preview";
      btnRm.style.color = "var(--red)";
      btnRm.addEventListener("click", () => { dismissContextMenu(); removePreview(lora); });
      menu.appendChild(btnRm);
    }

    const modalRect = modal.querySelector(".lora-modal").getBoundingClientRect();
    menu.style.left = Math.min(e.clientX, modalRect.right - 180) + "px";
    menu.style.top = Math.min(e.clientY, modalRect.bottom - 120) + "px";
    modal.appendChild(menu);
    activeMenu = menu;
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
    let text = `<lora:${lora.name}:${weight}>`;
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


  // ── Open / Close ───────────────────────────────────────
  async function openModal() {
    await fetchLoras();
    buildModal();
    modal.style.display = "flex";
    renderFolderTree();
    renderGrid();
    const search = modal.querySelector(".lora-search");
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
    btn.textContent = "LoRA";
    btn.title = "Browse LoRAs (Ctrl+L)";
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

    // Ctrl+L shortcut
    document.addEventListener("keydown", e => {
      if (e.ctrlKey && e.key === "l" && !e.shiftKey && !e.altKey) {
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

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.LoraBrowser = { open: openModal, close: closeModal, refresh: refreshLoras };
})();
