/**
 * Forge Studio — Checkpoint Browser
 *
 * Card-grid browser for checkpoints, mirroring the LoRA browser's
 * architecture: self-contained IIFE, lazily-built modal, folder tree,
 * search/sort, base-model filter chips, user-selectable previews.
 *
 * It deliberately reuses the LoRA browser's injected .lora-* CSS for the
 * shared skeleton (overlay, header, folders, grid, cards, chips, menu) —
 * lora-browser.js loads first and its styles are modal-scoped by markup,
 * not by module — and injects only checkpoint-specific styles on top.
 *
 * Selecting a card routes through the same path as the model dropdown:
 * set #paramModel to the full Forge title, refresh the searchable-select
 * label, then loadSelectedModelComponents("model-change") — so TE/VAE
 * component memory applies and the dropdown stays in sync.
 *
 * Data: GET /studio/checkpoints (registry-backed; previews via the
 * <stem>.preview.png ladder, base_model from Civitai Helper sidecars,
 * arch from the check_model_te cache — no header scans at browse time).
 */
(function () {
  "use strict";

  const TAG = "[Checkpoint Browser]";

  const _t = (key, fallback) => (window.I18N && window.I18N.t) ? window.I18N.t(key, fallback) : fallback;

  // ── State ──────────────────────────────────────────────
  let allCkpts = [];
  let folders = [];
  let activeFolder = "";
  let searchQuery = "";
  let activeBaseModels = new Set();
  let sortMode = "name";
  let modal = null;
  let loaded = false;
  let collapsedFolders = new Set();

  // ── Styles (checkpoint-specific only; skeleton reuses .lora-*) ──
  function injectStyles() {
    if (document.getElementById("ckpt-browser-styles")) return;
    const style = document.createElement("style");
    style.id = "ckpt-browser-styles";
    style.textContent = `
.ckpt-arch-badge {
  position: absolute; top: 4px; left: 4px;
  font-family: var(--mono); font-size: 9px;
  padding: 1px 5px; border-radius: 3px;
  background: rgba(0, 0, 0, 0.55); color: var(--text-1);
  pointer-events: none; max-width: calc(100% - 8px);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.lora-card.ckpt-current { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.lora-card.ckpt-current .lora-card-name { color: var(--accent-bright, var(--accent)); }
`;
    document.head.appendChild(style);
  }

  // ── Data ───────────────────────────────────────────────
  async function fetchCkpts(force) {
    if (loaded && !force) return;
    try {
      const resp = await fetch("/studio/checkpoints");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      allCkpts = await resp.json();
      const folderSet = new Set();
      for (const c of allCkpts) {
        if (c.subfolder) folderSet.add(c.subfolder);
      }
      folders = [...folderSet].sort((a, b) => a.localeCompare(b));
      loaded = true;
      console.log(`${TAG} Loaded ${allCkpts.length} checkpoints in ${folders.length} folders`);
    } catch (e) {
      console.error(`${TAG} Failed to fetch checkpoints:`, e);
    }
  }

  async function refreshCkpts() {
    const btn = modal?.querySelector(".lora-refresh-btn");
    if (btn) btn.classList.add("spinning");
    loaded = false;
    await fetchCkpts(true);
    if (modal) { renderFolderTree(); renderBaseChips(); renderGrid(); }
    if (btn) setTimeout(() => btn.classList.remove("spinning"), 300);
  }

  // ── Base-model filter chips (same mechanism as the LoRA browser) ──
  const _baseModelKey = (c) => (c.base_model || "").trim();

  function renderBaseChips() {
    const row = modal?.querySelector(".lora-chips");
    if (!row) return;
    row.innerHTML = "";
    const counts = new Map();
    for (const c of allCkpts) {
      const k = _baseModelKey(c);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const tagged = [...counts.keys()].filter(k => k).sort((a, b) => a.localeCompare(b));
    if (!tagged.length) { activeBaseModels.clear(); return; }
    for (const k of [...activeBaseModels]) {
      if (!counts.has(k)) activeBaseModels.delete(k);
    }
    const keys = counts.has("") ? [...tagged, ""] : tagged;
    for (const key of keys) {
      const chip = document.createElement("span");
      chip.className = "lora-chip" + (activeBaseModels.has(key) ? " active" : "");
      const label = key || _t("ckpt.baseFilter.untagged", "untagged");
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
    let list = allCkpts;
    if (activeFolder) list = list.filter(c => c.subfolder === activeFolder);
    if (activeBaseModels.size) list = list.filter(c => activeBaseModels.has(_baseModelKey(c)));
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(c => (c.name || "").toLowerCase().includes(q)
        || (c.title || "").toLowerCase().includes(q)
        || (c.base_model || "").toLowerCase().includes(q));
    }
    switch (sortMode) {
      case "name":
        list = [...list].sort((a, b) => (a.name || "").toLowerCase().localeCompare((b.name || "").toLowerCase()));
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
    const gb = bytes / (1024 ** 3);
    if (gb >= 1) return gb.toFixed(2) + " GB";
    return Math.round(bytes / (1024 ** 2)) + " MB";
  }

  // ── DOM ────────────────────────────────────────────────
  function buildModal() {
    if (modal) return;
    modal = document.createElement("div");
    modal.className = "lora-overlay ckpt-overlay";
    modal.style.display = "none";
    modal.innerHTML = `
      <div class="lora-modal">
        <div class="lora-header">
          <span class="lora-title" data-i18n="ckpt.title">${_t("ckpt.title", "Checkpoints")}</span>
          <input class="lora-search" type="text" data-i18n-placeholder="ckpt.search.placeholder" placeholder="${_t("ckpt.search.placeholder", "Search checkpoints...")}" spellcheck="false" autocomplete="off">
          <select class="lora-sort">
            <option value="name" data-i18n="lora.sort.name">${_t("lora.sort.name", "Name")}</option>
            <option value="date" data-i18n="lora.sort.date">${_t("lora.sort.date", "Newest")}</option>
            <option value="size" data-i18n="lora.sort.size">${_t("lora.sort.size", "Largest")}</option>
          </select>
          <button class="lora-header-btn lora-refresh-btn" data-i18n-title="ckpt.refresh.tooltip" title="${_t("ckpt.refresh.tooltip", "Refresh checkpoint list")}">&#x21bb;</button>
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
          <span class="lora-hint" data-i18n="ckpt.hint">${_t("ckpt.hint", "Click to load · Right-click to set a preview")}</span>
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
    modal.querySelector(".lora-refresh-btn").addEventListener("click", refreshCkpts);

    modal.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); e.stopPropagation(); });
    modal.addEventListener("keyup", e => e.stopPropagation());
    modal.addEventListener("click", e => { if (!e.target.closest(".lora-card-menu")) dismissContextMenu(); });

    document.body.appendChild(modal);
  }

  function renderFolderTree() {
    const container = modal.querySelector(".lora-folders");
    container.innerHTML = "";
    container.appendChild(makeFolderItem("", _t("ckpt.allFolder", "All"), allCkpts.length, false, 0));
    for (const folder of folders) {
      if (isAncestorCollapsed(folder)) continue;
      const count = allCkpts.filter(c => c.subfolder === folder).length;
      const hasChildren = folders.some(f => f !== folder && f.startsWith(folder + "/"));
      const depth = (folder.match(/\//g) || []).length;
      container.appendChild(makeFolderItem(folder, folder.split("/").pop() || folder, count, hasChildren, depth));
    }
  }

  function isAncestorCollapsed(folderPath) {
    const parts = folderPath.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (collapsedFolders.has(parts.slice(0, i).join("/"))) return true;
    }
    return false;
  }

  function makeFolderItem(folderPath, displayName, count, hasChildren, depth) {
    const item = document.createElement("div");
    item.className = "lora-folder-item" + (activeFolder === folderPath ? " active" : "");
    if (depth > 0) item.style.paddingLeft = (12 + depth * 12) + "px";

    let icon;
    if (folderPath === "") icon = "◈";
    else if (hasChildren) icon = collapsedFolders.has(folderPath) ? "▸" : "▾";
    else icon = "·";

    item.innerHTML = `
      <span class="lora-folder-icon${hasChildren ? " lora-folder-toggle" : ""}">${icon}</span>
      <span class="lora-folder-name" title="${folderPath || _t("ckpt.allFolder", "All")}">${escHtml(displayName)}</span>
      <span class="lora-folder-count">${count}</span>
    `;

    if (hasChildren) {
      item.querySelector(".lora-folder-icon").addEventListener("click", e => {
        e.stopPropagation();
        if (collapsedFolders.has(folderPath)) collapsedFolders.delete(folderPath);
        else collapsedFolders.add(folderPath);
        renderFolderTree();
      });
    }
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
    const currentTitle = document.getElementById("paramModel")?.value || "";

    status.textContent = `${filtered.length} checkpoint${filtered.length !== 1 ? "s" : ""}`;
    const oldEmpty = wrap.querySelector(".lora-empty");
    if (oldEmpty) oldEmpty.remove();

    if (!filtered.length) {
      grid.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "lora-empty";
      empty.innerHTML = `<span class="lora-empty-text">${allCkpts.length === 0 ? _t("ckpt.empty.none", "No checkpoints found") : _t("ckpt.empty.noMatch", "No checkpoints match your search")}</span>`;
      wrap.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const ckpt of filtered) {
      const card = document.createElement("div");
      card.className = "lora-card" + (currentTitle && ckpt.title === currentTitle ? " ckpt-current" : "");
      const tipLines = [ckpt.name || ckpt.title];
      if (ckpt.base_model) tipLines.push(`Base: ${ckpt.base_model}`);
      else if (ckpt.arch) tipLines.push(`Arch: ${ckpt.arch}`);
      card.title = tipLines.join("\n");

      // Arch badge, sourced cheaply: CH baseModel string first, else the
      // cached check_model_te arch (present only if the model was ever
      // inspected), else no badge at all.
      const badgeText = ckpt.base_model || ckpt.arch || "";
      const badge = badgeText ? `<span class="ckpt-arch-badge">${escHtml(badgeText)}</span>` : "";
      const baseName = ckpt.name || (ckpt.title || "").replace(/\s*\[[0-9a-fA-F]{8,16}\]\s*$/, "");
      const info = `<div class="lora-card-info"><div class="lora-card-name">${escHtml(baseName)}</div><div class="lora-card-meta">${formatSize(ckpt.size)}</div></div>`;

      if (ckpt.preview) {
        card.innerHTML = `
          <img class="lora-card-preview" src="${ckpt.preview}" loading="lazy" alt=""
               onerror="this.outerHTML='<div class=\\'lora-card-placeholder\\'><span class=\\'lora-card-placeholder-text\\'>${escHtml(baseName)}</span></div>'">
          ${badge}${info}`;
      } else {
        card.innerHTML = `
          <div class="lora-card-placeholder"><span class="lora-card-placeholder-text">${escHtml(baseName)}</span></div>
          ${badge}${info}`;
      }

      card.addEventListener("click", e => {
        if (e.target.closest(".lora-card-menu")) return;
        selectCheckpoint(ckpt);
      });
      card.addEventListener("contextmenu", e => { e.preventDefault(); showContextMenu(e, ckpt); });
      frag.appendChild(card);
    }
    grid.innerHTML = "";
    grid.appendChild(frag);
  }

  // ── Selection: exactly the dropdown's path ─────────────
  function selectCheckpoint(ckpt) {
    const sel = document.getElementById("paramModel");
    if (!sel || !ckpt.title) return;
    closeModal();
    if (sel.value !== ckpt.title) {
      sel.value = ckpt.title;
      // Refresh the searchable-select trigger label after a programmatic set
      sel._studioSSelHandle?.refresh?.();
    }
    // Same routine the dropdown change handler runs — restores the model's
    // remembered TE/VAE and keeps everything in sync. Self-queues when a
    // generation is in flight.
    if (typeof window.loadSelectedModelComponents === "function") {
      window.loadSelectedModelComponents("model-change");
    } else {
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  // ── Context menu: user-selectable previews ─────────────
  let activeMenu = null;

  function dismissContextMenu() {
    if (activeMenu) { activeMenu.remove(); activeMenu = null; }
  }

  function showContextMenu(e, ckpt) {
    dismissContextMenu();
    const menu = document.createElement("div");
    menu.className = "lora-card-menu";

    const canSidecar = !!ckpt.stem;

    const btnUpload = document.createElement("button");
    btnUpload.className = "lora-card-menu-item";
    btnUpload.dataset.i18n = "ckpt.menu.previewFromFile";
    btnUpload.textContent = _t("ckpt.menu.previewFromFile", "Set preview from file…");
    btnUpload.disabled = !canSidecar;
    btnUpload.addEventListener("click", () => { dismissContextMenu(); pickPreviewFile(ckpt); });
    menu.appendChild(btnUpload);

    const btnLast = document.createElement("button");
    btnLast.className = "lora-card-menu-item";
    btnLast.dataset.i18n = "ckpt.menu.previewFromOutput";
    btnLast.textContent = _t("ckpt.menu.previewFromOutput", "Use last output");
    btnLast.disabled = !canSidecar;
    btnLast.addEventListener("click", () => { dismissContextMenu(); useLastOutputPreview(ckpt); });
    menu.appendChild(btnLast);

    if (ckpt.preview) {
      const sep = document.createElement("div"); sep.className = "lora-card-menu-sep";
      menu.appendChild(sep);
      const btnRm = document.createElement("button");
      btnRm.className = "lora-card-menu-item";
      btnRm.dataset.i18n = "ckpt.menu.removePreview";
      btnRm.textContent = _t("ckpt.menu.removePreview", "Remove preview");
      btnRm.style.color = "var(--red)";
      btnRm.disabled = !canSidecar;
      btnRm.addEventListener("click", () => { dismissContextMenu(); removePreview(ckpt); });
      menu.appendChild(btnRm);
    }

    const modalRect = modal.querySelector(".lora-modal").getBoundingClientRect();
    menu.style.left = Math.min(e.clientX, modalRect.right - 180) + "px";
    menu.style.top = Math.min(e.clientY, modalRect.bottom - 120) + "px";
    modal.appendChild(menu);
    activeMenu = menu;
  }

  function pickPreviewFile(ckpt) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => savePreview(ckpt, reader.result);
      reader.readAsDataURL(file);
    });
    input.click();
  }

  // The newest generated output this session, as tracked by app.js
  // (StudioCore.state.lastResult = newest session entry's url/b64).
  async function useLastOutputPreview(ckpt) {
    const src = window.StudioCore?.state?.lastResult || null;
    if (!src) {
      window.showToast?.(_t("ckpt.toast.noOutput", "No generated output this session yet"), "info");
      return;
    }
    try {
      if (src.startsWith("data:")) {
        await savePreview(ckpt, src);
        return;
      }
      const blob = await fetch(src).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); });
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      await savePreview(ckpt, dataUrl);
    } catch (e) {
      console.error(`${TAG} Use-last-output failed:`, e);
    }
  }

  async function savePreview(ckpt, imageDataUrl) {
    try {
      const resp = await fetch("/studio/checkpoint_preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: ckpt.stem, image_b64: imageDataUrl }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const result = await resp.json();
      if (result.ok) { console.log(`${TAG} Preview saved for ${ckpt.stem}`); await refreshCkpts(); }
      else console.error(`${TAG} Preview save failed:`, result.error);
    } catch (e) { console.error(`${TAG} Preview save error:`, e); }
  }

  async function removePreview(ckpt) {
    try {
      const resp = await fetch(`/studio/checkpoint_preview?name=${encodeURIComponent(ckpt.stem)}`, {
        method: "DELETE",
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      console.log(`${TAG} Preview removed for ${ckpt.stem}`);
      await refreshCkpts();
    } catch (e) { console.error(`${TAG} Preview remove error:`, e); }
  }

  // ── Open / Close ───────────────────────────────────────
  async function openModal() {
    await fetchCkpts();
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
    if (modal) modal.style.display = "none";
    dismissContextMenu();
  }

  // ── Utility ────────────────────────────────────────────
  function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ── Init ───────────────────────────────────────────────
  function init() {
    injectStyles();
    document.getElementById("browseModelsBtn")?.addEventListener("click", openModal);
    console.log(`${TAG} Initialized`);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.CheckpointBrowser = { open: openModal, close: closeModal, refresh: refreshCkpts };
})();
