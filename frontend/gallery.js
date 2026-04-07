/**
 * Forge Studio — Gallery Module (Frontend)
 * by ToxicHost & Moritz
 * Based on TrackImage v6.8 by Moritz (integrated with permission)
 *
 * Image library manager: browse, tag, search, rename, move, delete.
 * Registers via StudioModules.register("gallery", {...})
 */
(function () {
"use strict";

const TAG = "[Gallery]";
const API_BASE = "/studio/gallery";
const VERSION = "1.1";

// ========================================================================
// SVG ICONS (Lucide-style, 14x14, stroke=currentColor)
// ========================================================================

const _s = (d, w) => `<svg class="gi" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w||2.2}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const IC = {
    folder:     _s('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
    folderPlus: _s('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>'),
    explorer:   _s('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'),
    move:       _s('<polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="19 9 22 12 19 15"/><polyline points="9 19 12 22 15 19"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/>'),
    edit:       _s('<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>'),
    trash:      _s('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
    settings:   _s('<circle cx="12" cy="12" r="3"/><path d="M12 1v2m0 18v2m-9-11h2m18 0h2m-4.2-6.8-1.4 1.4M6.6 17.4l-1.4 1.4m0-12.8 1.4 1.4m10.8 10.8 1.4 1.4"/>',1.8),
    canvas:     _s('<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/>'),
    params:     _s('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M9 12h6"/><path d="M9 16h6"/>'),
    refresh:    _s('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/>'),
    unlink:     _s('<path d="M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M5.16 11.75l-1.72 1.71a5 5 0 0 0 7.07 7.07l1.72-1.71"/><line x1="2" y1="2" x2="22" y2="22"/>'),
    play:       _s('<polygon points="5 3 19 12 5 21 5 3"/>'),
    chevLeft:   _s('<polyline points="15 18 9 12 15 6"/>'),
    chevRight:  _s('<polyline points="9 18 15 12 9 6"/>'),
    image:      _s('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>'),
    search:     _s('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
};

// ========================================================================
// STATE
// ========================================================================

const G = {
    page: "gallery", scanFolders: [], characters: [], folders: [], images: [], stats: {},
    ignoreWords: [], filter: { character: "", folder: "", search: "" },
    sort: "filename", order: "asc", total: 0, allLoaded: false, loadingMore: false,
    currentImageId: null, currentImageIndex: -1, scrollPosition: 0, initialized: false,
    loading: false, openFolders: {}, filteredTotal: 0,
    detailZoom: 1, detailPan: { x: 0, y: 0 }, detailPanning: false,
    selectedImages: new Set(), lastSelectedIndex: -1, openTagGroups: {},
    tagsModified: false, volume: parseFloat(localStorage.getItem("gal_volume")) || 0.5,
    dragIds: null, undoStack: [], _container: null, _imgIndexMap: null,
    watcherActive: false,
};

// ========================================================================
// HELPERS
// ========================================================================

async function api(path, opts) {
    opts = opts || {};
    if (!opts.headers) opts.headers = { "Content-Type": "application/json" };
    const r = await fetch(API_BASE + path, opts);
    const j = await r.json();
    if (!r.ok) j.error = j.error || "Request failed";
    return j;
}
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function toast(m, type, undoable) { if (window.showToast) window.showToast(m + (undoable ? " (Ctrl+Z to undo)" : ""), type || "info"); }
function invalidateIndexMap() { G._imgIndexMap = null; }
function getImgIndex(id) { if (!G._imgIndexMap) { G._imgIndexMap = new Map(); G.images.forEach((img, i) => G._imgIndexMap.set(img.id, i)); } return G._imgIndexMap.has(id) ? G._imgIndexMap.get(id) : -1; }
function natSort(a, b) { const ka = a.toLowerCase().replace(/\d+/g, n => String(parseInt(n)).padStart(10, "0")); const kb = b.toLowerCase().replace(/\d+/g, n => String(parseInt(n)).padStart(10, "0")); return ka < kb ? -1 : ka > kb ? 1 : 0; }
function pushUndo(entry) { G.undoStack.push(entry); if (G.undoStack.length > 50) G.undoStack.shift(); }

// ========================================================================
// DATA LOADING
// ========================================================================

async function loadStats() { G.stats = await api("/stats"); }
async function loadCharacters() { let url = "/characters"; if (G.filter.folder) url += "?folder=" + encodeURIComponent(G.filter.folder); G.characters = await api(url); }
async function loadFolders() { G.folders = await api("/folders"); }
async function loadIgnoreWords() { G.ignoreWords = await api("/ignore-words"); }
async function loadScanFolders() { G.scanFolders = await api("/scan-folders"); }
async function loadImagesReset() {
    G.images = []; G.allLoaded = false; G.selectedImages.clear(); invalidateIndexMap();
    const p = new URLSearchParams();
    if (G.filter.character) p.set("character", G.filter.character);
    if (G.filter.folder) p.set("folder", G.filter.folder);
    if (G.filter.search) p.set("search", G.filter.search);
    p.set("sort", G.sort); p.set("order", G.order); p.set("page", 1); p.set("per_page", 60);
    const d = await api("/images?" + p);
    G.images = d.images; G.total = d.total; G.filteredTotal = d.total;
    G.allLoaded = d.images.length >= d.total;
}
async function loadMoreImages() {
    if (G.allLoaded || G.loadingMore) return; G.loadingMore = true;
    const pg = Math.floor(G.images.length / 60) + 1;
    const p = new URLSearchParams();
    if (G.filter.character) p.set("character", G.filter.character);
    if (G.filter.folder) p.set("folder", G.filter.folder);
    if (G.filter.search) p.set("search", G.filter.search);
    p.set("sort", G.sort); p.set("order", G.order); p.set("page", pg); p.set("per_page", 60);
    const d = await api("/images?" + p);
    if (!d.images.length) G.allLoaded = true;
    else { const ids = new Set(G.images.map(i => i.id)); d.images.forEach(img => { if (!ids.has(img.id)) G.images.push(img); }); G.total = d.total; if (G.images.length >= d.total) G.allLoaded = true; }
    G.loadingMore = false; invalidateIndexMap(); appendGalleryItems(d.images);
}

// ========================================================================
// SCANNING
// ========================================================================

let _scanPollTimer = null;
function showScanProgress(p) {
    let el = document.getElementById("gal-scan-progress");
    if (!p.active || !p.folders || !p.folders.length) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement("div"); el.id = "gal-scan-progress"; el.className = "gal-scan-progress"; document.body.appendChild(el); }
    let h = ""; p.folders.forEach(f => { if (f.phase === "Done" && f.current >= f.total) return; const pct = f.total > 0 ? Math.round(f.current / f.total * 100) : 0; h += '<div class="gal-sp-row' + (f.phase === "Done" ? " done" : "") + '"><span class="gal-spinner"></span><span class="sp-text">' + esc(f.phase) + ' "' + esc(f.name) + '" ' + f.current + '/' + f.total + '</span><div class="sp-bar"><div class="sp-fill" style="width:' + pct + '%"></div></div></div>'; });
    el.innerHTML = h; if (!h && el) el.remove();
}
async function pollScanProgress() { try { const p = await api("/scan-progress"); showScanProgress(p); if (p.active) _scanPollTimer = setTimeout(pollScanProgress, 500); else _scanPollTimer = null; } catch { _scanPollTimer = null; } }
async function rescan() {
    G.loading = true; render(); _scanPollTimer = setTimeout(pollScanProgress, 300);
    try { const r = await api("/scan", { method: "POST" }); if (r.error) toast("Error: " + r.error); else toast("Scan: " + r.new + " new, " + r.removed + " removed", "success"); await api("/rescan-characters", { method: "POST" }); G.initialized = true; await Promise.all([loadStats(), loadCharacters(), loadFolders(), loadImagesReset()]); } catch { toast("Scan failed"); }
    G.loading = false; showScanProgress({ active: false, folders: [] }); if (_scanPollTimer) { clearTimeout(_scanPollTimer); _scanPollTimer = null; } render();
}

// ========================================================================
// FOLDER MANAGEMENT
// ========================================================================

// ── SSE auto-sync ──────────────────────────────────────────────────
let _sse = null, _sseRetry = null;
function connectSSE() {
    if (_sse) _sse.close();
    _sse = new EventSource(API_BASE + "/events");
    _sse.addEventListener("sync", e => { try { onAutoSync(JSON.parse(e.data)); } catch {} });
    _sse.addEventListener("watcher_status", e => { try { const d = JSON.parse(e.data); G.watcherActive = d.active; updateWatcherIndicator(); } catch {} });
    _sse.onerror = () => { G.watcherActive = false; updateWatcherIndicator(); if (_sseRetry) clearTimeout(_sseRetry); _sseRetry = setTimeout(connectSSE, 5000); };
}
let _syncDebounce = null;
function onAutoSync(d) {
    if (_syncDebounce) clearTimeout(_syncDebounce);
    _syncDebounce = setTimeout(async () => {
        if (G.page === "detail") return;
        await Promise.all([loadStats(), loadCharacters(), loadFolders(), loadImagesReset()]);
        renderMain(); renderTagList(); renderFolderSidebar();
        if (d.new > 0 || d.removed > 0) {
            const parts = [];
            if (d.new) parts.push(d.new + " new");
            if (d.removed) parts.push(d.removed + " removed");
            toast("Auto-sync: " + parts.join(", "), "success");
        }
    }, 300);
}
function updateWatcherIndicator() {
    const el = G._container?.querySelector("#gal-watcher-dot");
    if (el) { el.className = "gal-watcher-dot" + (G.watcherActive ? " active" : ""); el.title = G.watcherActive ? "Auto-sync active" : "Auto-sync inactive"; }
}

async function pickAndAddFolder() { try { const r = await api("/pick-folder", { method: "POST" }); if (r.error) { toast("Error: " + r.error); return; } if (!r.path) return; await api("/scan-folders", { method: "POST", body: JSON.stringify({ path: r.path }) }); await loadScanFolders(); toast("Folder added! Scanning...", "success"); await rescan(); } catch { toast("Failed to pick folder"); } }
async function createFolderIn(parent) { const name = prompt("New folder name:", ""); if (!name || !name.trim()) return; const r = await api("/create-folder", { method: "POST", body: JSON.stringify({ parent: parent || "", name: name.trim() }) }); if (r.error) return toast("Error: " + r.error); toast("Folder created!", "success"); await Promise.all([loadFolders(), loadImagesReset()]); render(); }
async function deleteFolderIdx(idx) { const fp = _folderPaths[idx]; if (!fp) return; const node = findFolderNode(fp); const cnt = node ? countAll(node) : 0; let msg = 'Delete folder "' + fp + '"?'; if (cnt > 0) { msg += "\n\nThis folder contains " + cnt + " image" + (cnt > 1 ? "s" : "") + " that will be PERMANENTLY DELETED."; if (!confirm(msg)) return; if (!confirm("Are you absolutely sure? " + cnt + " file" + (cnt > 1 ? "s" : "") + " removed from disk forever.")) return; } else { if (!confirm(msg)) return; } const r = await api("/delete-folder", { method: "POST", body: JSON.stringify({ folder: fp }) }); if (r.error) return toast("Error: " + r.error); toast("Folder deleted (" + r.deleted_files + " files)", "success"); if (G.filter.folder === fp) G.filter.folder = ""; await Promise.all([loadFolders(), loadCharacters(), loadImagesReset(), loadStats()]); render(); }
async function renameFolderIdx(idx) { const fp = _folderPaths[idx]; if (!fp) return; const parts = fp.replace(/\//g, "\\").split("\\"); const name = prompt("Rename folder:", parts[parts.length - 1]); if (!name || !name.trim() || name.trim() === parts[parts.length - 1]) return; const r = await api("/rename-folder", { method: "POST", body: JSON.stringify({ folder: fp, new_name: name.trim() }) }); if (r.error) return toast("Error: " + r.error); toast("Renamed!", "success"); if (G.filter.folder === fp) G.filter.folder = ""; await Promise.all([loadScanFolders(), loadFolders(), loadCharacters(), loadImagesReset(), loadStats()]); render(); }
async function unlinkFolderIdx(idx) { const fp = _folderPaths[idx]; if (!fp) return; if (!confirm('Unlink "' + fp + '"?\n\nFiles stay on disk.')) return; const r = await api("/unlink-folder", { method: "POST", body: JSON.stringify({ folder: fp }) }); if (r.error) return toast("Error: " + r.error); toast("Unlinked", "success"); if (G.filter.folder === fp) G.filter.folder = ""; await Promise.all([loadScanFolders(), loadFolders(), loadCharacters(), loadImagesReset(), loadStats()]); render(); }

// ========================================================================
// FILTERING & SORTING
// ========================================================================

function filterByCharacter(n) { G.filter.character = G.filter.character === n ? "" : n; G.selectedImages.clear(); loadImagesReset().then(() => { renderMain(); updateTagActive(); updateFolderActive(); }); }
async function filterByFolder(f) { G.filter.folder = G.filter.folder === f ? "" : f; G.selectedImages.clear(); await Promise.all([loadCharacters(), loadImagesReset()]); renderMain(); renderTagList(); updateFolderActive(); updateTagActive(); }
function setSort(s) { if (G.sort === s) G.order = G.order === "asc" ? "desc" : "asc"; else { G.sort = s; G.order = s === "newest" ? "desc" : "asc"; } updateSortButtons(); loadImagesReset().then(renderMain); }
function updateSortButtons() { G._container.querySelectorAll(".gal-sort-btn").forEach(b => { const s = b.dataset.sort; b.classList.toggle("active", s === G.sort); if (s === "filename") b.textContent = G.sort === "filename" ? (G.order === "asc" ? "A\u2013Z" : "Z\u2013A") : "A\u2013Z"; if (s === "newest") b.textContent = G.sort === "newest" ? (G.order === "desc" ? "Newest" : "Oldest") : "Newest"; }); }
let _searchTimeout;
function onSearch(v) { clearTimeout(_searchTimeout); _searchTimeout = setTimeout(() => { G.filter.search = v; G.selectedImages.clear(); loadImagesReset().then(renderMain); }, 300); }

// ── Search autocomplete via /suggest ────────────────────────────────
let _suggestTimeout, _suggestIdx = -1;
function onSearchInput(v) {
    onSearch(v);
    clearTimeout(_suggestTimeout);
    const box = G._container?.querySelector("#gal-suggest");
    if (!box) return;
    if (v.trim().length < 1) { box.innerHTML = ""; box.style.display = "none"; _suggestIdx = -1; return; }
    _suggestTimeout = setTimeout(async () => {
        try {
            const results = await api("/suggest?q=" + encodeURIComponent(v.trim()));
            if (!results.length) { box.innerHTML = ""; box.style.display = "none"; _suggestIdx = -1; return; }
            _suggestIdx = -1;
            box.innerHTML = results.map((r, i) =>
                '<div class="gal-suggest-item" data-sidx="' + i + '" data-sval="' + esc(r.name) + '">' +
                '<span class="gs-name">' + esc(r.name) + '</span>' +
                '<span class="gs-meta">' + r.count + (r.type === "tag" ? "" : " · meta") + '</span></div>'
            ).join("");
            box.style.display = "block";
            box.querySelectorAll(".gal-suggest-item").forEach(el => {
                el.addEventListener("mousedown", e => {
                    e.preventDefault();
                    applySuggestion(el.dataset.sval);
                });
            });
        } catch { box.innerHTML = ""; box.style.display = "none"; }
    }, 150);
}
function applySuggestion(val) {
    const inp = G._container?.querySelector("#gal-search-input");
    if (inp) inp.value = val;
    const box = G._container?.querySelector("#gal-suggest");
    if (box) { box.innerHTML = ""; box.style.display = "none"; }
    _suggestIdx = -1;
    G.filter.search = val; G.selectedImages.clear(); loadImagesReset().then(renderMain);
}
function suggestKeydown(e) {
    const box = G._container?.querySelector("#gal-suggest");
    if (!box || box.style.display === "none") return;
    const items = box.querySelectorAll(".gal-suggest-item");
    if (!items.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); _suggestIdx = Math.min(_suggestIdx + 1, items.length - 1); _highlightSuggest(items); }
    else if (e.key === "ArrowUp") { e.preventDefault(); _suggestIdx = Math.max(_suggestIdx - 1, -1); _highlightSuggest(items); }
    else if (e.key === "Enter" && _suggestIdx >= 0) { e.preventDefault(); applySuggestion(items[_suggestIdx].dataset.sval); }
    else if (e.key === "Escape") { box.innerHTML = ""; box.style.display = "none"; _suggestIdx = -1; }
}
function _highlightSuggest(items) { items.forEach((el, i) => el.classList.toggle("active", i === _suggestIdx)); }

// ========================================================================
// SELECTION
// ========================================================================

let _clickTimer = null, _clickId = 0, _clickCount = 0;
function onItemClick(imgId, e) {
    e.preventDefault(); e.stopPropagation();
    if (_clickTimer && _clickId === imgId) {
        // Second click on same image within timeout = double-click = open
        clearTimeout(_clickTimer); _clickTimer = null; _clickId = 0; _clickCount = 0;
        G.selectedImages.clear(); updateSelectionUI(); openImage(imgId); return;
    }
    // Clear any pending timer from a different image
    if (_clickTimer) { clearTimeout(_clickTimer); _clickTimer = null; _clickCount = 0; }
    _clickId = imgId; _clickCount = 1;
    const shiftKey = e.shiftKey, ctrlKey = e.ctrlKey || e.metaKey;
    // Immediately apply selection (don't wait for timeout) for better responsiveness
    const idx = getImgIndex(imgId); const prev = new Set(G.selectedImages);
    if (shiftKey && G.lastSelectedIndex >= 0) { const a = Math.min(G.lastSelectedIndex, idx), b = Math.max(G.lastSelectedIndex, idx); if (!ctrlKey) G.selectedImages.clear(); for (let i = a; i <= b; i++) G.selectedImages.add(G.images[i].id); }
    else if (ctrlKey) { if (G.selectedImages.has(imgId)) G.selectedImages.delete(imgId); else G.selectedImages.add(imgId); }
    else { if (G.selectedImages.size === 1 && G.selectedImages.has(imgId)) G.selectedImages.clear(); else { G.selectedImages.clear(); G.selectedImages.add(imgId); } }
    G.lastSelectedIndex = idx; updateSelectionDiff(prev);
    // Start timer to clear double-click window
    _clickTimer = setTimeout(() => { _clickTimer = null; _clickId = 0; _clickCount = 0; }, 350);
}
function updateSelectionDiff(prev) { const all = new Set([...prev, ...G.selectedImages]); all.forEach(id => { const w = prev.has(id), n = G.selectedImages.has(id); if (w !== n) { const el = G._container.querySelector('.gal-card[data-id="' + id + '"]'); if (el) el.classList.toggle("selected", n); } }); updateSelectionBar(); }
function updateSelectionUI() { G._container.querySelectorAll(".gal-card").forEach(el => { el.classList.toggle("selected", G.selectedImages.has(parseInt(el.dataset.id))); }); updateSelectionBar(); }
function updateSelectionBar() { const si = G._container.querySelector("#gal-sel-info"); if (si) { if (G.selectedImages.size > 0) { si.style.display = "flex"; si.querySelector(".sel-count").textContent = G.selectedImages.size + " selected"; } else si.style.display = "none"; } ["gal-btn-explorer","gal-btn-move","gal-btn-rename","gal-btn-delete"].forEach(id => { const b = G._container.querySelector("#" + id); if (b) b.disabled = G.selectedImages.size === 0; }); }
function clearSelection() { G.selectedImages.clear(); updateSelectionUI(); }

// ========================================================================
// BULK OPERATIONS
// ========================================================================

async function bulkDeleteSelected() { const n = G.selectedImages.size; if (!n || !confirm("Delete " + n + " image" + (n > 1 ? "s" : "") + "?")) return; const ids = Array.from(G.selectedImages); const r = await api("/images/bulk-delete", { method: "POST", body: JSON.stringify({ ids }) }); if (r.error) return toast("Error: " + r.error); if (r.trash_ids && r.trash_ids.length) pushUndo({ type: "delete_bulk", trashIds: r.trash_ids }); toast(r.deleted + " deleted", "success", true); G.selectedImages.clear(); await Promise.all([loadImagesReset(), loadCharacters(), loadFolders(), loadStats()]); renderMain(); renderTagList(); renderFolderSidebar(); }
async function bulkOpenExplorer() { for (const id of Array.from(G.selectedImages)) await api("/image/" + id + "/open-explorer", { method: "POST" }); }
async function bulkRenameSelected() {
    const n = G.selectedImages.size; if (!n) return;
    const base = prompt("New filename base" + (n > 1 ? " (" + n + " files numbered)" : "") + ":\n\nMulti-character: use + separator (Oliver+Luca)\nNumbering continues globally.", "");
    if (!base || !base.trim()) return; const ids = Array.from(G.selectedImages);
    const ordered = G.images.filter(img => ids.includes(img.id)).map(img => img.id);
    if (n > 1) { const nn = await api("/next-number", { method: "POST", body: JSON.stringify({ base_name: base.trim(), exclude_ids: ordered }) }); if (nn.next > 1 && !confirm("Continue numbering: " + base.trim() + " (" + nn.next + ") through (" + (nn.next + n - 1) + ")\n\n" + n + " files. Continue?")) return; }
    const r = await api("/images/bulk-rename", { method: "POST", body: JSON.stringify({ ids: ordered, base_name: base.trim(), continue_numbering: true }) });
    if (r.error) return toast("Error: " + r.error); if (r.old_names && r.old_names.length) pushUndo({ type: "rename_bulk", entries: r.old_names }); toast(r.renamed + " renamed", "success", true); G.selectedImages.clear(); await Promise.all([loadImagesReset(), loadCharacters(), loadStats()]); renderMain(); renderTagList();
}

// ========================================================================
// CONTEXT MENUS (createElement only — no innerHTML for items)
// ========================================================================

function hideCtx() { document.getElementById("gal-ctx-menu")?.remove(); }
function _buildCtxMenu(items, x, y) {
    const m = document.createElement("div"); m.className = "gal-ctx-menu"; m.id = "gal-ctx-menu";
    items.forEach(item => {
        if (!item) { const sep = document.createElement("div"); sep.className = "gal-ctx-sep"; m.appendChild(sep); return; }
        const d = document.createElement("div"); d.className = "gal-ctx-item" + (item.cls ? " " + item.cls : "");
        d.innerHTML = (item.icon || "") + " " + item.label;
        d.addEventListener("click", () => { hideCtx(); item.fn(); }); m.appendChild(d);
    });
    document.body.appendChild(m);
    if (x + m.offsetWidth > window.innerWidth) x = window.innerWidth - m.offsetWidth - 4;
    if (y + m.offsetHeight > window.innerHeight) y = window.innerHeight - m.offsetHeight - 4;
    m.style.left = x + "px"; m.style.top = y + "px";
}
function showGalleryCtx(e, imgId) {
    e.preventDefault(); e.stopPropagation(); hideCtx();
    if (!G.selectedImages.has(imgId)) { G.selectedImages.clear(); G.selectedImages.add(imgId); updateSelectionUI(); }
    const n = G.selectedImages.size; const items = [{ icon: IC.explorer, label: "Open in Explorer", fn: bulkOpenExplorer }];
    if (n === 1 && typeof displayOnCanvas === "function") items.push({ icon: IC.canvas, label: "Send to Canvas", fn: () => sendToCanvas(imgId) });
    items.push({ icon: IC.move, label: "Move to folder\u2026", fn: showMoveModal }); items.push(null);
    items.push(n === 1 ? { icon: IC.edit, label: "Rename", fn: () => renameFromCtx(imgId) } : { icon: IC.edit, label: "Rename " + n + " files", fn: bulkRenameSelected });
    items.push(null); items.push({ icon: IC.trash, label: "Delete " + (n > 1 ? n + " images" : "image"), cls: "danger", fn: () => n === 1 ? deleteSingleFromCtx(imgId) : bulkDeleteSelected() });
    _buildCtxMenu(items, e.clientX, e.clientY);
}
function showFolderCtx(e, idx) {
    e.preventDefault(); e.stopPropagation(); hideCtx();
    _buildCtxMenu([{ icon: IC.folderPlus, label: "New subfolder", fn: () => createFolderIn(_folderPaths[idx]) }, { icon: IC.edit, label: "Rename", fn: () => renameFolderIdx(idx) }, null, { icon: IC.unlink, label: "Unlink", fn: () => unlinkFolderIdx(idx) }, { icon: IC.trash, label: "Delete from disk", cls: "danger", fn: () => deleteFolderIdx(idx) }], e.clientX, e.clientY);
}
async function renameFromCtx(imgId) { const img = G.images.find(i => i.id === imgId); if (!img) return; const name = prompt("Rename file:", img.filename); if (!name || !name.trim() || name.trim() === img.filename) return; let r = await api("/image/" + imgId + "/rename", { method: "POST", body: JSON.stringify({ filename: name.trim(), continue_numbering: true }) }); if (r.error) { if (r.suggestion && confirm('File exists. Rename to "' + r.suggestion + '"?')) r = await api("/image/" + imgId + "/rename", { method: "POST", body: JSON.stringify({ filename: name.trim(), auto_increment: true, continue_numbering: true }) }); if (r.error) return toast("Error: " + r.error); } pushUndo({ type: "rename", imageId: imgId, oldFilename: img.filename, newFilename: r.filename }); toast("Renamed!", "success", true); await Promise.all([loadImagesReset(), loadCharacters(), loadStats()]); renderMain(); renderTagList(); }
async function deleteSingleFromCtx(imgId) { if (!confirm("Delete this image?")) return; const r = await api("/image/" + imgId + "/delete", { method: "POST" }); if (r.error) return toast("Error: " + r.error); pushUndo({ type: "delete", trashId: r.trash_id }); toast("Deleted", "success", true); G.selectedImages.clear(); await Promise.all([loadImagesReset(), loadCharacters(), loadFolders(), loadStats()]); renderMain(); renderTagList(); renderFolderSidebar(); }

// ========================================================================
// STUDIO INTEGRATION
// ========================================================================

async function copyImageToClipboard(imgId) {
    const img = G.images.find(i => i.id === imgId);
    try {
        const resp = await fetch(API_BASE + "/full/" + imgId);
        const blob = await resp.blob();
        // Clipboard API requires image/png; convert if needed
        let pngBlob = blob;
        if (blob.type !== "image/png") {
            const bmp = await createImageBitmap(blob);
            const canvas = document.createElement("canvas");
            canvas.width = bmp.width; canvas.height = bmp.height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(bmp, 0, 0);
            pngBlob = await new Promise(r => canvas.toBlob(r, "image/png"));
        }
        await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
        toast("Copied" + (img ? " " + img.filename : "") + " to clipboard", "success");
    } catch (e) { toast("Copy failed: " + e.message); }
}
async function downloadImage(imgId) {
    const img = G.images.find(i => i.id === imgId);
    if (!img) return;
    try {
        const resp = await fetch(API_BASE + "/full/" + imgId);
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = img.filename;
        document.body.appendChild(a); a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    } catch (e) { toast("Download failed: " + e.message); }
}
async function sendToCanvas(imgId) { try { const resp = await fetch(API_BASE + "/full/" + imgId); const blob = await resp.blob(); const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); }); if (typeof displayOnCanvas === "function") { if (window.State) { window.State.baseGenW = 0; window.State.baseGenH = 0; } displayOnCanvas(dataUrl, { newLayer: true, layerName: "Gallery", undoLabel: "Gallery send" }); toast("Sent to canvas", "success"); setTimeout(() => { if (window.StudioModules) window.StudioModules.activateStudio(); }, 100); } } catch (e) { toast("Failed: " + e.message); } }
async function importParamsFromImage(imgId) { try { const meta = await api("/image/" + imgId + "/metadata"); if (meta.raw_parameters && typeof _applyInfotextToUI === "function") { _applyInfotextToUI(meta.raw_parameters); toast("Parameters imported", "success"); if (window.StudioModules) window.StudioModules.activateStudio(); } else toast("No generation parameters found"); } catch (e) { toast("Failed: " + e.message); } }

// ========================================================================
// MOVE MODAL
// ========================================================================

function showMoveModal() {
    if (!G.selectedImages.size) return; const bg = document.createElement("div"); bg.className = "gal-move-bg"; bg.id = "gal-move-bg"; bg.addEventListener("click", e => { if (e.target === bg) bg.remove(); });
    const tree = buildFolderTree();
    const cur = new Set(); G.selectedImages.forEach(id => { const img = G.images.find(i => i.id === id); if (img) cur.add(img.folder); });
    // Build collapsible folder tree for move dialog
    const _moveOpen = {};
    function buildMoveTree(node, depth) {
        let h = "";
        const keys = Object.keys(node.children).sort(natSort);
        keys.forEach(k => {
            const n = node.children[k]; const hasKids = Object.keys(n.children).length > 0;
            const isCur = cur.size === 1 && cur.has(n.fullPath);
            const uid = "mm-" + n.fullPath.replace(/[\\\/\s]/g, "_");
            h += '<div class="mm-node">';
            h += '<div class="mm-item' + (isCur ? " current" : "") + '" style="padding-left:' + (depth * 16 + 12) + 'px" ' + (isCur ? "" : 'data-folder="' + esc(n.fullPath) + '"') + '>';
            if (hasKids) h += '<span class="mm-toggle" data-mm-toggle="' + uid + '">\u25B6</span>';
            else h += '<span style="width:14px;display:inline-block"></span>';
            h += '<span class="gal-tree-icon">' + IC.folder + '</span> ' + esc(k);
            if (isCur) h += ' <span style="color:var(--text-4);font-size:10px;margin-left:auto">(current)</span>';
            h += '</div>';
            if (hasKids) h += '<div class="mm-children" id="' + uid + '" style="display:none">' + buildMoveTree(n, depth + 1) + '</div>';
            h += '</div>';
        });
        return h;
    }
    let h = '<div class="gal-move-modal"><h3>Move ' + G.selectedImages.size + " file" + (G.selectedImages.size > 1 ? "s" : "") + '</h3><div class="mm-list">';
    h += buildMoveTree(tree, 0);
    h += '</div><div class="mm-footer"><button class="gal-btn" id="gal-move-cancel">Cancel</button></div></div>';
    bg.innerHTML = h;
    bg.addEventListener("click", e => {
        // Toggle collapse
        const toggle = e.target.closest(".mm-toggle");
        if (toggle) { e.stopPropagation(); const tid = toggle.dataset.mmToggle; const ch = document.getElementById(tid); if (ch) { const open = ch.style.display !== "none"; ch.style.display = open ? "none" : "block"; toggle.classList.toggle("open", !open); } return; }
        const item = e.target.closest(".mm-item[data-folder]"); if (item) { doMoveToFolder(item.dataset.folder); bg.remove(); }
        if (e.target.id === "gal-move-cancel") bg.remove();
    });
    document.body.appendChild(bg);
}
async function doMoveToFolder(targetFolder) {
    const ids = Array.from(G.selectedImages); const moves = ids.map(id => { const img = G.images.find(i => i.id === id); return { id, folder: img ? img.folder : "" }; });
    const r = ids.length === 1 ? await api("/image/" + ids[0] + "/move", { method: "POST", body: JSON.stringify({ folder: targetFolder }) }) : await api("/images/bulk-move", { method: "POST", body: JSON.stringify({ ids, folder: targetFolder }) });
    if (r.error) return toast("Error: " + r.error); const cnt = r.moved || 1;
    pushUndo(ids.length === 1 ? { type: "move", imageId: ids[0], oldFolder: moves[0].folder } : { type: "move_bulk", moves });
    toast(cnt + " file" + (cnt > 1 ? "s" : "") + " moved", "success", true); G.selectedImages.clear(); await Promise.all([loadImagesReset(), loadFolders(), loadCharacters(), loadStats()]); renderMain(); renderTagList();
}

// ========================================================================
// DRAG & DROP
// ========================================================================

function onGalleryDragStart(e, imgId) { if (!G.selectedImages.has(imgId)) { G.selectedImages.clear(); G.selectedImages.add(imgId); updateSelectionUI(); } G.dragIds = Array.from(G.selectedImages); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", JSON.stringify(G.dragIds)); requestAnimationFrame(() => { G._container.querySelectorAll(".gal-card").forEach(el => { if (G.selectedImages.has(parseInt(el.dataset.id))) el.classList.add("dragging"); }); }); }
function onGalleryDragEnd() { G.dragIds = null; G._container.querySelectorAll(".gal-card.dragging").forEach(el => el.classList.remove("dragging")); G._container.querySelectorAll(".gal-tree-toggle.drop-over").forEach(el => el.classList.remove("drop-over")); }
function onFolderDrop(e, idx) { e.preventDefault(); e.currentTarget.classList.remove("drop-over"); if (!G.dragIds || !G.dragIds.length) return; const fp = _folderPaths[idx]; if (!fp) return; G.selectedImages = new Set(G.dragIds); doMoveToFolder(fp); }

// ========================================================================
// UNDO
// ========================================================================

async function performUndo() {
    if (!G.undoStack.length) { toast("Nothing to undo"); return; } const u = G.undoStack.pop();
    try {
        if (u.type === "rename") { await api("/image/" + u.imageId + "/rename", { method: "POST", body: JSON.stringify({ filename: u.oldFilename }) }); toast("Undo: renamed back", "success"); }
        else if (u.type === "rename_bulk") { for (const e of u.entries) await api("/image/" + e.id + "/rename", { method: "POST", body: JSON.stringify({ filename: e.old_filename, auto_increment: true }) }); toast("Undo: " + u.entries.length + " renamed back", "success"); }
        else if (u.type === "move") { await api("/image/" + u.imageId + "/move", { method: "POST", body: JSON.stringify({ folder: u.oldFolder }) }); toast("Undo: moved back", "success"); }
        else if (u.type === "move_bulk") { for (const mv of u.moves) await api("/image/" + mv.id + "/move", { method: "POST", body: JSON.stringify({ folder: mv.folder }) }); toast("Undo: moved back", "success"); }
        else if (u.type === "delete") { await api("/restore/" + u.trashId, { method: "POST" }); toast("Undo: restored", "success"); }
        else if (u.type === "delete_bulk") { await api("/bulk-restore", { method: "POST", body: JSON.stringify({ trash_ids: u.trashIds }) }); toast("Undo: " + u.trashIds.length + " restored", "success"); }
        else if (u.type === "tag_add") { await api("/image/" + u.imageId + "/remove-tag", { method: "POST", body: JSON.stringify({ tag: u.tag, add_ignore: false }) }); toast("Undo: tag removed", "success"); }
        else if (u.type === "tag_remove") { await api("/image/" + u.imageId + "/add-tag", { method: "POST", body: JSON.stringify({ tag: u.tag }) }); if (u.wasIgnored) await api("/ignore-words", { method: "DELETE", body: JSON.stringify({ word: u.tag.toLowerCase() }) }); toast("Undo: tag restored", "success"); }
        G.tagsModified = true; await Promise.all([loadImagesReset(), loadCharacters(), loadFolders(), loadStats()]); renderMain(); renderTagList(); renderFolderSidebar();
    } catch (e) { toast("Undo failed: " + e.message); }
}

// ========================================================================
// FOLDER TREE
// ========================================================================

let _folderPaths = [];
function buildFolderTree() { const tree = { children: {}, count: 0, fullPath: "" }; G.folders.forEach(f => { const parts = f.folder.replace(/\//g, "\\").split("\\"); let node = tree, path = ""; for (let i = 0; i < parts.length; i++) { path += (i ? "\\" : "") + parts[i]; if (!node.children[parts[i]]) node.children[parts[i]] = { children: {}, count: 0, fullPath: path, name: parts[i] }; node = node.children[parts[i]]; } node.count = f.image_count; }); return tree; }
function findFolderNode(fp) { const tree = buildFolderTree(); const parts = fp.replace(/\//g, "\\").split("\\"); let node = tree; for (const p of parts) { if (!node.children[p]) return null; node = node.children[p]; } return node; }
function countAll(node) { let c = node.count || 0; Object.keys(node.children).forEach(k => c += countAll(node.children[k])); return c; }
function renderFolderNode(node, depth) {
    const keys = Object.keys(node.children).sort(natSort); let h = "";
    keys.forEach(k => { const n = node.children[k]; const hasKids = Object.keys(n.children).length > 0; const isActive = G.filter.folder === n.fullPath; const isOpen = G.openFolders[n.fullPath]; const cnt = countAll(n); const idx = _folderPaths.length; _folderPaths.push(n.fullPath);
        h += '<div class="gal-tree-node"><div class="gal-tree-toggle' + (isActive ? " active" : "") + '" data-fidx="' + idx + '" style="padding-left:' + (depth * 14 + 12) + 'px">';
        h += hasKids ? '<span class="arrow' + (isOpen ? " open" : "") + '" data-toggle-folder="' + idx + '">\u25B6</span>' : '<span style="width:14px;display:inline-block"></span>';
        h += '<span class="gal-tree-icon">' + IC.folder + '</span>';
        h += '<span style="flex:1;overflow:hidden;text-overflow:ellipsis" data-click-folder="' + idx + '">' + esc(k) + '</span>';
        h += '<span class="tcnt">' + cnt + '</span></div>';
        if (hasKids) h += '<div class="gal-tree-children' + (isOpen ? " open" : "") + '" id="gal-fc-' + idx + '">' + renderFolderNode(n, depth + 1) + '</div>';
        h += '</div>'; });
    return h;
}
function toggleFolderIdx(idx) { const key = _folderPaths[idx]; G.openFolders[key] = !G.openFolders[key]; const ch = G._container.querySelector("#gal-fc-" + idx); const ar = G._container.querySelector('[data-toggle-folder="' + idx + '"]'); if (ch) ch.classList.toggle("open", G.openFolders[key]); if (ar) ar.classList.toggle("open", G.openFolders[key]); }

// ========================================================================
// TAG LIST
// ========================================================================

function getFolderTotal() { if (!G.filter.folder) return G.stats.total_images || 0; let c = 0; G.folders.forEach(f => { if (f.folder === G.filter.folder || f.folder.indexOf(G.filter.folder + "\\") === 0) c += f.image_count; }); return c || G.filteredTotal; }
function buildTagsHtml(allCount) {
    let h = '<div class="gal-tag-item' + (G.filter.character === "" ? " active" : "") + '" data-tag="__all"><span>All</span><span class="count">' + allCount + '</span></div>';
    const unknowns = [], grouped = {};
    G.characters.forEach(c => { if (c.name.toLowerCase() === "unknown") { unknowns.push(c); return; } let first = c.name.charAt(0).toUpperCase(); if (!/[A-Z]/.test(first)) first = "#"; if (!grouped[first]) grouped[first] = []; grouped[first].push(c); });
    unknowns.forEach(c => { h += '<div class="gal-tag-item' + (G.filter.character === c.name ? " active" : "") + '" data-tag="' + esc(c.name) + '"><span>' + esc(c.name) + '</span><span class="count">' + c.image_count + '</span></div>'; });
    Object.keys(grouped).sort().forEach(letter => { const isOpen = G.openTagGroups[letter] !== false;
        h += '<div class="gal-tag-letter" data-letter="' + letter + '"><span class="tl-arrow' + (isOpen ? " open" : "") + '" data-tga="' + letter + '">\u25B6</span>' + letter + '</div>';
        h += '<div class="gal-tag-group' + (isOpen ? " open" : "") + '" data-tag-group="' + letter + '">';
        grouped[letter].forEach(c => { h += '<div class="gal-tag-item' + (G.filter.character === c.name ? " active" : "") + '" data-tag="' + esc(c.name) + '"><span>' + esc(c.name) + '</span><span class="count">' + c.image_count + '</span></div>'; });
        h += '</div>'; });
    return h;
}
function renderTagList() { const el = G._container.querySelector("#gal-tag-list"); if (el) el.innerHTML = buildTagsHtml(getFolderTotal()); }
function updateTagActive() { G._container.querySelectorAll(".gal-tag-item").forEach(el => el.classList.toggle("active", el.dataset.tag === (G.filter.character || "__all"))); }
function updateFolderActive() { G._container.querySelectorAll(".gal-tree-toggle").forEach(el => { const idx = el.dataset.fidx; if (idx !== undefined) el.classList.toggle("active", _folderPaths[parseInt(idx)] === G.filter.folder); }); }
function renderFolderSidebar() {
    const col = G._container?.querySelector(".gal-sidebar-col");
    if (!col) return;
    _folderPaths = [];
    const tree = buildFolderTree();
    const titleHtml = '<div class="gal-sidebar-title"><span>Folders</span></div>';
    col.innerHTML = titleHtml + renderFolderNode(tree, 0) + '<div class="gal-link-folder-btn" id="gal-link-folder">' + IC.folderPlus + ' Link new folder</div>';
    col.querySelector("#gal-link-folder")?.addEventListener("click", pickAndAddFolder);
    updateFolderActive();
}

// ========================================================================
// GALLERY GRID
// ========================================================================

function cardMediaHtml(img) { const u = API_BASE + "/thumb/" + img.id + "?h=" + img.fphash; if (img.is_video) return '<img src="' + u + '" alt="' + esc(img.filename) + '" loading="lazy"/><span class="video-badge">' + IC.play + ' VIDEO</span>'; const ext = img.filename.split(".").pop().toLowerCase(); if (ext === "gif") return '<img src="' + u + '" alt="' + esc(img.filename) + '" loading="lazy"/><span class="video-badge">GIF</span>'; return '<img src="' + u + '" alt="' + esc(img.filename) + '" loading="lazy"/>'; }
function renderMainContent() {
    let h = '<div class="gal-grid" id="gal-grid">' + G.images.map(img => { const sel = G.selectedImages.has(img.id) ? " selected" : ""; return '<div class="gal-card' + sel + '" data-id="' + img.id + '" draggable="true"><div class="img-wrap">' + cardMediaHtml(img) + '</div><div class="card-info"><div class="card-filename">' + esc(img.filename) + '</div><div class="card-folder"><span class="gal-tree-icon">' + IC.folder + '</span> ' + esc(img.folder) + '</div></div></div>'; }).join("") + '</div>';
    if (!G.images.length) h = '<div class="gal-empty"><div style="opacity:0.12">' + IC.image + '</div><div>No images found.</div></div>';
    if (!G.allLoaded && G.images.length) h += '<div class="gal-load-more"><div id="gal-load-trigger"><span class="gal-spinner"></span></div></div>';
    return h;
}
function appendGalleryItems(items) { const g = G._container.querySelector("#gal-grid"); if (!g) return; const ids = new Set(); g.querySelectorAll(".gal-card").forEach(el => ids.add(el.dataset.id)); items.forEach(img => { if (ids.has(String(img.id))) return; const d = document.createElement("div"); d.className = "gal-card"; d.dataset.id = img.id; d.draggable = true; d.innerHTML = '<div class="img-wrap">' + cardMediaHtml(img) + '</div><div class="card-info"><div class="card-filename">' + esc(img.filename) + '</div><div class="card-folder"><span class="gal-tree-icon">' + IC.folder + '</span> ' + esc(img.folder) + '</div></div>'; g.appendChild(d); }); if (G.allLoaded) { const lt = G._container.querySelector("#gal-load-trigger"); if (lt && lt.parentElement) lt.parentElement.remove(); } else setupInfiniteScroll(); }

// ========================================================================
// DETAIL VIEW
// ========================================================================

function openImage(id) { const m = G._container.querySelector(".gal-main"); if (m) G.scrollPosition = m.scrollTop; G.currentImageIndex = G.images.findIndex(i => i.id === id); G.currentImageId = id; G.page = "detail"; G.tagsModified = false; showDetailOverlay(); }
function closeDetail() { document.getElementById("gal-detail-overlay")?.remove(); if (G.page === "detail") G.page = "gallery"; if (G.tagsModified) { G.tagsModified = false; loadCharacters().then(renderTagList); loadImagesReset().then(renderMain); } }
function buildDetailTagsHtml(imgId, chars) { return chars.map(c => { const isLast = chars.length === 1; return '<span class="tag-pill' + (isLast ? " tag-last" : "") + '" data-tag-action="' + (isLast ? "" : "remove") + '" data-img-id="' + imgId + '" data-tag="' + esc(c) + '">' + esc(c) + '</span>'; }).join("") + '<button class="gal-add-tag-btn" id="gal-add-tag-toggle" title="Add tag">+</button><div class="gal-add-tag-inline" id="gal-add-tag-inline"><input id="gal-add-tag-input" placeholder="Tag name..." /></div>'; }
const BROWSER_VIDEO = { mp4: 1, webm: 1, m4v: 1, mov: 1 };

function showDetailOverlay() {
    document.getElementById("gal-detail-overlay")?.remove();
    const img = G.images[G.currentImageIndex]; if (!img) return;
    const ov = document.createElement("div"); ov.id = "gal-detail-overlay"; ov.className = "gal-detail";
    const fullUrl = API_BASE + "/full/" + img.id; const ext = img.filename.split(".").pop().toLowerCase();
    let mediaHtml;
    if (img.is_video && BROWSER_VIDEO[ext]) mediaHtml = '<video id="gal-detail-video" src="' + fullUrl + '" controls autoplay style="max-width:100%;max-height:100%;object-fit:contain"></video>';
    else if (img.is_video) mediaHtml = '<div style="display:flex;flex-direction:column;align-items:center;gap:16px"><img src="' + API_BASE + '/thumb/' + img.id + '?h=' + img.fphash + '" style="max-width:80%;max-height:70vh;border-radius:8px;object-fit:contain"/><button class="gal-btn-primary" data-action="open-file" data-img-id="' + img.id + '" style="padding:10px 28px">' + IC.play + ' Open in Player</button></div>';
    else mediaHtml = '<img id="gal-detail-img" src="' + fullUrl + '" alt="' + esc(img.filename) + '"/>';
    const hasCanvas = typeof displayOnCanvas === "function";
    ov.innerHTML = '<div class="gal-detail-img-area" id="gal-detail-img-area">' + mediaHtml + '</div><div class="gal-detail-sidebar"><div class="gal-detail-panel"><input class="gal-detail-filename" id="gal-rename-input" value="' + esc(img.filename) + '" /><div class="gal-detail-folder"><span class="gal-tree-icon">' + IC.folder + '</span> ' + esc(img.folder) + '</div>' + (img.width ? '<div class="gal-detail-dims">' + img.width + ' \u00d7 ' + img.height + ' px</div>' : '') + '<div class="gal-detail-actions"><button class="gal-detail-btn" data-action="explorer" data-img-id="' + img.id + '">' + IC.explorer + ' Browse</button><button class="gal-detail-btn" data-action="copy-image" data-img-id="' + img.id + '">&#x1F4CB; Copy</button><button class="gal-detail-btn" data-action="download-image" data-img-id="' + img.id + '">&#x2B07; Save</button>' + (hasCanvas ? '<button class="gal-detail-btn accent" data-action="send-canvas" data-img-id="' + img.id + '">' + IC.canvas + ' Image to Canvas</button>' : '') + '<button class="gal-detail-btn" data-action="import-params" data-img-id="' + img.id + '">' + IC.params + ' Params to Canvas</button><span class="gal-detail-sep"></span><button class="gal-detail-btn danger" data-action="delete" data-img-id="' + img.id + '">' + IC.trash + ' Delete</button></div><div class="gal-detail-chars" id="gal-detail-chars">' + buildDetailTagsHtml(img.id, img.characters) + '</div><div class="gal-detail-nav"><button class="gal-detail-btn nav" data-action="prev" ' + (G.currentImageIndex <= 0 ? "disabled" : "") + '>' + IC.chevLeft + '</button><button class="gal-btn" data-action="back" style="flex:1">Back</button><button class="gal-detail-btn nav" data-action="next" ' + (G.currentImageIndex >= G.images.length - 1 ? "disabled" : "") + '>' + IC.chevRight + '</button></div></div><div class="gal-meta-panel" id="gal-meta-panel"><div class="gal-meta-section-title">Metadata</div><div class="gal-meta-empty">Loading...</div></div></div>';
    document.body.appendChild(ov); G.detailZoom = 1; G.detailPan = { x: 0, y: 0 };
    _wireDetailEvents(ov, img); setTimeout(() => loadMetadata(img.id), 50);
}

function _wireDetailEvents(ov, img) {
    const ri = ov.querySelector("#gal-rename-input"); if (ri) { ri.addEventListener("keydown", e => { if (e.key === "Enter") ri.blur(); }); ri.addEventListener("blur", renameFile); }
    ov.addEventListener("click", e => { const a = e.target.closest("[data-action]"); if (!a) return; const act = a.dataset.action, id = parseInt(a.dataset.imgId);
        if (act === "explorer") api("/image/" + id + "/open-explorer", { method: "POST" }); else if (act === "send-canvas") sendToCanvas(id); else if (act === "import-params") importParamsFromImage(id); else if (act === "delete") deleteImage(id); else if (act === "open-file") api("/image/" + id + "/open-file", { method: "POST" }); else if (act === "copy-image") copyImageToClipboard(id); else if (act === "download-image") downloadImage(id); else if (act === "prev") prevImage(); else if (act === "next") nextImage(); else if (act === "back") closeDetail(); });
    ov.addEventListener("click", e => { const pill = e.target.closest("[data-tag-action='remove']"); if (pill) { removeTag(parseInt(pill.dataset.imgId), pill.dataset.tag); return; } if (e.target.closest("#gal-add-tag-toggle")) toggleAddTag(); });
    const ai = ov.querySelector("#gal-add-tag-input"); if (ai) ai.addEventListener("keydown", e => { if (e.key === "Enter") addTag(G.currentImageId); if (e.key === "Escape") toggleAddTag(); });
    if (!img.is_video) setupDetailZoom(ov); else { const vid = ov.querySelector("#gal-detail-video"); if (vid) { vid.volume = G.volume; vid.addEventListener("volumechange", () => { G.volume = vid.volume; localStorage.setItem("gal_volume", String(vid.volume)); }); } }
    const area = ov.querySelector("#gal-detail-img-area"); if (area) area.addEventListener("click", e => {
        if (e.target.closest("button") || e.target.closest("video")) return;
        const isImg = e.target.id === "gal-detail-img";
        if (isImg) {
            // Click on image: toggle zoom 2.5x
            if (G.detailZoom > 1) { G.detailZoom = 1; G.detailPan = { x: 0, y: 0 }; } else {
                G.detailZoom = 2.5;
                const r = area.getBoundingClientRect();
                const mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2;
                G.detailPan.x = mx - mx * G.detailZoom; G.detailPan.y = my - my * G.detailZoom;
            }
            const imgEl = ov.querySelector("#gal-detail-img");
            if (imgEl) { area.classList.toggle("zoomed", G.detailZoom > 1); imgEl.style.transform = "translate(" + G.detailPan.x + "px," + G.detailPan.y + "px) scale(" + G.detailZoom + ")"; }
        } else {
            // Click on black area around image: close detail
            closeDetail();
        }
    });
}
function setupDetailZoom(ov) {
    const area = ov.querySelector("#gal-detail-img-area"), imgEl = ov.querySelector("#gal-detail-img"); if (!area || !imgEl) return;
    area.addEventListener("wheel", e => { e.preventDefault(); const oldZ = G.detailZoom; G.detailZoom = Math.max(1, Math.min(12, G.detailZoom * (e.deltaY > 0 ? 0.85 : 1.15))); if (G.detailZoom <= 1) G.detailPan = { x: 0, y: 0 }; else { const r = area.getBoundingClientRect(); const mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2; const ratio = G.detailZoom / oldZ; G.detailPan.x = mx - (mx - G.detailPan.x) * ratio; G.detailPan.y = my - (my - G.detailPan.y) * ratio; } applyZ(); }, { passive: false });
    area.addEventListener("dblclick", e => { if (e.target !== imgEl) return; if (G.detailZoom > 1) { G.detailZoom = 1; G.detailPan = { x: 0, y: 0 }; } else { G.detailZoom = 2.5; const r = area.getBoundingClientRect(); const mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2; G.detailPan.x = mx - mx * G.detailZoom; G.detailPan.y = my - my * G.detailZoom; } applyZ(); });
    let sx, sy; area.addEventListener("mousedown", e => { if (G.detailZoom <= 1 || e.target.tagName === "BUTTON") return; G.detailPanning = true; sx = e.clientX - G.detailPan.x; sy = e.clientY - G.detailPan.y; area.classList.add("panning"); e.preventDefault(); });
    window.addEventListener("mousemove", e => { if (!G.detailPanning) return; G.detailPan.x = e.clientX - sx; G.detailPan.y = e.clientY - sy; applyZ(); });
    window.addEventListener("mouseup", () => { if (G.detailPanning) { G.detailPanning = false; area.classList.remove("panning"); } });
    function applyZ() { area.classList.toggle("zoomed", G.detailZoom > 1); imgEl.style.transform = "translate(" + G.detailPan.x + "px," + G.detailPan.y + "px) scale(" + G.detailZoom + ")"; }
}
function prevImage() { if (G.currentImageIndex > 0) { G.currentImageIndex--; G.currentImageId = G.images[G.currentImageIndex].id; showDetailOverlay(); } }
function nextImage() { if (G.currentImageIndex < G.images.length - 1) { G.currentImageIndex++; G.currentImageId = G.images[G.currentImageIndex].id; showDetailOverlay(); } }
async function renameFile() { const inp = document.getElementById("gal-rename-input"); if (!inp) return; const val = inp.value.trim(); if (!val) return; const img = G.images[G.currentImageIndex]; if (!img || val === img.filename) return; let r = await api("/image/" + G.currentImageId + "/rename", { method: "POST", body: JSON.stringify({ filename: val, continue_numbering: true }) }); if (r.error) { if (r.suggestion && confirm('File exists. Rename to "' + r.suggestion + '"?')) { r = await api("/image/" + G.currentImageId + "/rename", { method: "POST", body: JSON.stringify({ filename: val, auto_increment: true, continue_numbering: true }) }); if (r.error) { toast("Error: " + r.error); inp.value = img.filename; return; } } else { inp.value = img.filename; return; } } pushUndo({ type: "rename", imageId: G.currentImageId, oldFilename: img.filename }); toast("Renamed!", "success", true); G.images[G.currentImageIndex].filename = r.filename; G.images[G.currentImageIndex].characters = r.characters; G.tagsModified = true; inp.value = r.filename; const dc = document.getElementById("gal-detail-chars"); if (dc) dc.innerHTML = buildDetailTagsHtml(img.id, r.characters); }
async function removeTag(id, t) { const img = G.images[G.currentImageIndex]; if (img && img.characters && img.characters.length <= 1) { toast("Cannot remove the last tag"); return; } const r = await api("/image/" + id + "/remove-tag", { method: "POST", body: JSON.stringify({ tag: t, add_ignore: false }) }); if (r.error) return toast("Error: " + r.error); pushUndo({ type: "tag_remove", imageId: id, tag: t, wasIgnored: false }); toast('"' + t + '" removed', "success", true); if (G.currentImageIndex >= 0) G.images[G.currentImageIndex].characters = r.characters; G.tagsModified = true; showDetailOverlay(); }
async function addTag(id) { const i = document.getElementById("gal-add-tag-input"); const t = i.value.trim(); if (!t) return; const r = await api("/image/" + id + "/add-tag", { method: "POST", body: JSON.stringify({ tag: t }) }); if (r.error) return toast("Error: " + r.error); pushUndo({ type: "tag_add", imageId: id, tag: t.charAt(0).toUpperCase() + t.slice(1) }); toast("Tag added", "success", true); if (G.currentImageIndex >= 0) G.images[G.currentImageIndex].characters = r.characters; G.tagsModified = true; showDetailOverlay(); }
async function deleteImage(id) { if (!confirm("Delete this image?")) return; const r = await api("/image/" + id + "/delete", { method: "POST" }); if (r.error) return toast("Error: " + r.error); pushUndo({ type: "delete", trashId: r.trash_id }); toast("Deleted", "success", true); G.images.splice(G.currentImageIndex, 1); G.total--; G.tagsModified = true; if (!G.images.length) { closeDetail(); loadImagesReset().then(() => { render(); loadCharacters(); loadFolders(); loadStats(); }); return; } if (G.currentImageIndex >= G.images.length) G.currentImageIndex = G.images.length - 1; G.currentImageId = G.images[G.currentImageIndex].id; showDetailOverlay(); }
function toggleAddTag() { const el = document.getElementById("gal-add-tag-inline"), btn = document.getElementById("gal-add-tag-toggle"); if (!el) return; if (el.classList.contains("open")) { el.classList.remove("open"); if (btn) btn.style.display = ""; } else { el.classList.add("open"); if (btn) btn.style.display = "none"; document.getElementById("gal-add-tag-input")?.focus(); } }
function prettyLabel(k) { return k.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()); }
async function loadMetadata(id) {
    const p = document.getElementById("gal-meta-panel"); if (!p) return;
    try { const m = await api("/image/" + id + "/metadata"); let h = '<div class="gal-meta-section-title">Metadata</div>'; let has = false; const img = G.images[G.currentImageIndex];
        const dv = m.date_original || m.date_time || ""; if (dv) { has = true; h += '<div class="gal-meta-row"><div class="gal-meta-label">Date</div><div class="gal-meta-value">' + esc(dv) + '</div></div>'; } else if (img && img.file_date) { has = true; h += '<div class="gal-meta-row"><div class="gal-meta-label">Date</div><div class="gal-meta-value">' + new Date(img.file_date * 1000).toLocaleDateString("en-US", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) + '</div></div>'; }
        if (img && img.width) { has = true; h += '<div class="gal-meta-row"><div class="gal-meta-label">Dimensions</div><div class="gal-meta-value">' + img.width + ' \u00d7 ' + img.height + ' px</div></div>'; }
        if (m.file_size) { has = true; const mb = m.file_size / (1024 * 1024); h += '<div class="gal-meta-row"><div class="gal-meta-label">File Size</div><div class="gal-meta-value">' + (mb >= 1 ? mb.toFixed(1) + " MB" : (m.file_size / 1024).toFixed(0) + " KB") + '</div></div>'; }
        const ord = [["prompt","Prompt"],["negative_prompt","Negative"],["model","Model"],["steps","Steps"],["sampler","Sampler"],["cfg_scale","CFG Scale"],["seed","Seed"],["size","Size"],["clip_skip","Clip Skip"],["denoising","Denoise"],["hires_upscaler","Hires Up."],["hires_steps","Hires Steps"],["hires_upscale","Hires Scale"],["model_hash","Model Hash"],["camera_make","Camera"],["camera_model","Camera Model"],["lens_make","Lens"],["lens_model","Lens Model"],["focal_length","Focal Length"],["focal_length_35mm","Focal 35mm"],["f_number","Aperture"],["exposure_time","Exposure"],["iso","ISO"],["flash","Flash"],["software","Software"]];
        for (const [k, l] of ord) { if (m[k] != null && m[k] !== "") { has = true; h += '<div class="gal-meta-row"><div class="gal-meta-label">' + l + '</div><div class="gal-meta-value' + (k === "prompt" || k === "negative_prompt" ? " prompt" : "") + '">' + esc(String(m[k])) + '</div></div>'; } }
        const skip = new Set(["file_size","error","raw_parameters","comfyui_prompt","comfyui_workflow","pixel_x","pixel_y","orientation","x_resolution","y_resolution","resolution_unit","date_digitized","date_original","date_time","color_space","sensing_method","spectral_sensitivity","gain_control","file_source","serial_number","digital_zoom","max_aperture","exposure_bias","exposure_mode","exposure_program","metering_mode","scene_type","contrast","saturation","sharpness","white_balance","subject_distance","shutter_speed","aperture","lens_info","ExifOffset","tag_34665"].concat(ord.map(o => o[0])));
        Object.keys(m).forEach(k => { if (!skip.has(k) && m[k] != null && m[k] !== "") { has = true; h += '<div class="gal-meta-row"><div class="gal-meta-label">' + esc(prettyLabel(k)) + '</div><div class="gal-meta-value">' + esc(String(m[k]).substring(0, 500)) + '</div></div>'; } });
        if (!has) h += '<div class="gal-meta-empty">No metadata found.</div>'; p.innerHTML = h;
    } catch { p.innerHTML = '<div class="gal-meta-section-title">Metadata</div><div class="gal-meta-empty">Could not load.</div>'; }
}

// ========================================================================
// SETTINGS
// ========================================================================

async function renderSettingsView() { await loadIgnoreWords(); return '<div class="gal-settings"><div class="gal-settings-title">Gallery Settings</div><div class="gal-settings-card"><h3>Ignore Words</h3><p>Words to skip when parsing character tags from filenames.</p><div style="margin-bottom:8px;display:flex;flex-wrap:wrap;align-items:center;gap:0">' + G.ignoreWords.map(w => '<span class="gal-ignore-word-tag">' + esc(w) + ' <span class="remove" data-remove-word="' + esc(w) + '">\u00d7</span></span>').join("") + (!G.ignoreWords.length ? '<span style="color:var(--text-4);font-size:11px">None.</span>' : "") + '<button class="gal-add-tag-btn" id="gal-ignore-toggle" style="margin:2px">+</button><div class="gal-add-tag-inline" id="gal-ignore-inline" style="min-width:100px;margin:2px"><input id="gal-ignore-input" placeholder="Word..." /></div></div><p style="margin-top:4px;font-size:10px;color:var(--text-4)">After changes, re-scan to apply.</p></div><div class="gal-settings-card"><h3>Tagging Rules</h3><div style="font-size:11px;color:var(--text-2);line-height:1.8"><strong>Character separators:</strong> comma, plus (+)<br><strong>Name connectors:</strong> space, underscore, dash (joined into one name)<br><strong>Filtered:</strong> (...), [...], trailing numbers, numeric strings, ignore words<br><strong>Min length:</strong> 2+ characters with a letter<br><strong>Manual:</strong> add/remove tags per image in detail view</div></div></div>'; }
async function addIgnoreWord() { const i = document.getElementById("gal-ignore-input"); const w = i.value.trim(); if (!w) return; await api("/ignore-words", { method: "POST", body: JSON.stringify({ word: w }) }); i.value = ""; toast('"' + w + '" added', "success"); G.page = "settings"; render(); }
async function removeIgnoreWord(w) { await api("/ignore-words", { method: "DELETE", body: JSON.stringify({ word: w }) }); G.page = "settings"; render(); }


// ========================================================================
// INFINITE SCROLL
// ========================================================================

let _scrollObs;
function setupInfiniteScroll() { if (_scrollObs) _scrollObs.disconnect(); const t = G._container.querySelector("#gal-load-trigger"); if (!t || G.allLoaded) return; _scrollObs = new IntersectionObserver(entries => { if (entries[0].isIntersecting && !G.loadingMore && !G.allLoaded) loadMoreImages(); }, { root: G._container.querySelector(".gal-main"), rootMargin: "400px" }); _scrollObs.observe(t); }

// ========================================================================
// MAIN RENDER
// ========================================================================

function renderMain() { const m = G._container.querySelector("#gal-main-area"); if (!m) { render(); return; } m.innerHTML = renderMainContent(); requestAnimationFrame(setupInfiniteScroll); updateTagActive(); updateFolderActive(); updateSelectionUI(); }
function renderTopbar() {
    return '<div class="gal-topbar"><div class="gal-search-box">' + IC.search + '<input type="text" placeholder="Search tags, filenames, metadata..." value="' + esc(G.filter.search) + '" id="gal-search-input" autocomplete="off" /><div class="gal-suggest" id="gal-suggest"></div></div><div class="gal-sort-controls"><button class="gal-sort-btn' + (G.sort === "filename" ? " active" : "") + '" data-sort="filename">' + (G.sort === "filename" ? (G.order === "asc" ? "A\u2013Z" : "Z\u2013A") : "A\u2013Z") + '</button><button class="gal-sort-btn' + (G.sort === "folder" ? " active" : "") + '" data-sort="folder">Folder</button><button class="gal-sort-btn' + (G.sort === "newest" ? " active" : "") + '" data-sort="newest">' + (G.sort === "newest" ? (G.order === "desc" ? "Newest" : "Oldest") : "Newest") + '</button><button class="gal-sort-btn" data-sort="rescan" title="Scan folders"' + (G.loading ? " disabled" : "") + '>' + IC.refresh + '</button></div><div class="gal-sel-info" id="gal-sel-info" style="display:none"><span class="sel-count">0</span></div><div style="display:flex;gap:3px;align-items:center;margin-left:auto"><span class="gal-watcher-dot' + (G.watcherActive ? " active" : "") + '" id="gal-watcher-dot" title="' + (G.watcherActive ? "Auto-sync active" : "Auto-sync inactive") + '"></span><button class="gal-btn" id="gal-btn-explorer" disabled title="Open in Explorer">' + IC.explorer + '</button><button class="gal-btn" id="gal-btn-move" disabled title="Move">' + IC.move + '</button><button class="gal-btn" id="gal-btn-rename" disabled title="Rename">' + IC.edit + '</button><button class="gal-btn danger" id="gal-btn-delete" disabled title="Delete">' + IC.trash + '</button><button class="gal-btn settings' + (G.page === "settings" ? " active" : "") + '" id="gal-btn-settings" title="Settings">' + IC.settings + '</button></div></div>';
}
function renderSetup() { return '<div class="gal-setup"><div class="gal-setup-card"><h2>Gallery</h2><p>Add a folder containing your images to get started.</p><button class="gal-btn-primary" id="gal-setup-btn">' + IC.folderPlus + ' Choose folder & scan</button></div></div>'; }

async function render() {
    const c = G._container; if (!c) return;
    if (!G.initialized) { c.innerHTML = renderSetup(); c.querySelector("#gal-setup-btn")?.addEventListener("click", pickAndAddFolder); return; }
    _folderPaths = []; const tree = buildFolderTree(); const allCount = getFolderTotal();
    const sb = '<div class="gal-sidebar"><div class="gal-sidebar-col"><div class="gal-sidebar-title"><span>Folders</span></div>' + renderFolderNode(tree, 0) + '<div class="gal-link-folder-btn" id="gal-link-folder">' + IC.folderPlus + ' Link new folder</div></div><div class="gal-sidebar-col"><div class="gal-sidebar-title">Tags</div><div class="gal-tag-list" id="gal-tag-list">' + buildTagsHtml(allCount) + '</div></div></div>';
    const mc = G.page === "settings" ? await renderSettingsView() : renderMainContent();
    c.innerHTML = '<div class="gal-layout">' + renderTopbar() + sb + '<div class="gal-main" id="gal-main-area">' + mc + '</div></div>';
    if (G.page !== "settings") requestAnimationFrame(setupInfiniteScroll);
    wireGlobalEvents();
}

// ========================================================================
// EVENT WIRING
// ========================================================================

function wireGlobalEvents() {
    const c = G._container;
    c.querySelector("#gal-search-input")?.addEventListener("input", e => onSearchInput(e.target.value));
    c.querySelector("#gal-search-input")?.addEventListener("keydown", suggestKeydown);
    c.querySelector("#gal-search-input")?.addEventListener("blur", () => { setTimeout(() => { const box = c.querySelector("#gal-suggest"); if (box) { box.innerHTML = ""; box.style.display = "none"; } _suggestIdx = -1; }, 200); });
    c.querySelectorAll(".gal-sort-btn").forEach(b => b.addEventListener("click", () => { if (b.dataset.sort === "rescan") rescan(); else setSort(b.dataset.sort); }));
    c.querySelector("#gal-btn-explorer")?.addEventListener("click", bulkOpenExplorer);
    c.querySelector("#gal-btn-move")?.addEventListener("click", showMoveModal);
    c.querySelector("#gal-btn-rename")?.addEventListener("click", bulkRenameSelected);
    c.querySelector("#gal-btn-delete")?.addEventListener("click", bulkDeleteSelected);
    c.querySelector("#gal-btn-settings")?.addEventListener("click", () => { G.page = G.page === "settings" ? "gallery" : "settings"; render(); });
    c.querySelector("#gal-link-folder")?.addEventListener("click", pickAndAddFolder);
    c.addEventListener("click", e => { const ti = e.target.closest(".gal-tag-item"); if (ti) { filterByCharacter(ti.dataset.tag === "__all" ? "" : ti.dataset.tag); return; } const tl = e.target.closest(".gal-tag-letter"); if (tl) { const l = tl.dataset.letter; G.openTagGroups[l] = G.openTagGroups[l] === false; const grp = c.querySelector('.gal-tag-group[data-tag-group="' + l + '"]'); const arr = c.querySelector('[data-tga="' + l + '"]'); if (grp) grp.classList.toggle("open", G.openTagGroups[l] !== false); if (arr) arr.classList.toggle("open", G.openTagGroups[l] !== false); } });
    c.addEventListener("click", e => { const ar = e.target.closest("[data-toggle-folder]"); if (ar) { e.stopPropagation(); toggleFolderIdx(parseInt(ar.dataset.toggleFolder)); return; } const fc = e.target.closest("[data-click-folder]"); if (fc) { filterByFolder(_folderPaths[parseInt(fc.dataset.clickFolder)]); return; } const t = e.target.closest(".gal-tree-toggle"); if (t && !ar && !fc) { const idx = parseInt(t.dataset.fidx); if (!isNaN(idx)) filterByFolder(_folderPaths[idx]); } });
    c.addEventListener("contextmenu", e => { const t = e.target.closest(".gal-tree-toggle"); if (t) { const idx = parseInt(t.dataset.fidx); if (!isNaN(idx)) showFolderCtx(e, idx); } });
    c.addEventListener("dragover", e => { const t = e.target.closest(".gal-tree-toggle"); if (t && G.dragIds) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; t.classList.add("drop-over"); } });
    c.addEventListener("dragleave", e => { const t = e.target.closest(".gal-tree-toggle"); if (t) t.classList.remove("drop-over"); });
    c.addEventListener("drop", e => { const t = e.target.closest(".gal-tree-toggle"); if (t) { const idx = parseInt(t.dataset.fidx); if (!isNaN(idx)) onFolderDrop(e, idx); } });
    c.addEventListener("click", e => { const card = e.target.closest(".gal-card"); if (card) { onItemClick(parseInt(card.dataset.id), e); return; } if (G.selectedImages.size && e.target.closest(".gal-main") && !e.target.closest(".gal-card") && !e.target.closest(".gal-topbar")) clearSelection(); });
    c.addEventListener("contextmenu", e => { const card = e.target.closest(".gal-card"); if (card) showGalleryCtx(e, parseInt(card.dataset.id)); });
    c.addEventListener("dragstart", e => { const card = e.target.closest(".gal-card"); if (card) onGalleryDragStart(e, parseInt(card.dataset.id)); });
    c.addEventListener("dragend", e => { if (e.target.closest(".gal-card")) onGalleryDragEnd(); });
    c.addEventListener("click", e => { const rm = e.target.closest("[data-remove-word]"); if (rm) removeIgnoreWord(rm.dataset.removeWord); if (e.target.id === "gal-ignore-toggle") { const el = c.querySelector("#gal-ignore-inline"), btn = c.querySelector("#gal-ignore-toggle"); if (el.classList.contains("open")) { el.classList.remove("open"); btn.style.display = ""; } else { el.classList.add("open"); btn.style.display = "none"; c.querySelector("#gal-ignore-input")?.focus(); } } });
    c.querySelector("#gal-ignore-input")?.addEventListener("keydown", e => { if (e.key === "Enter") addIgnoreWord(); if (e.key === "Escape") { c.querySelector("#gal-ignore-inline")?.classList.remove("open"); c.querySelector("#gal-ignore-toggle").style.display = ""; } });

    if (G.page === "gallery") requestAnimationFrame(() => { const m = c.querySelector(".gal-main"); if (m) m.scrollTop = G.scrollPosition; });
}

function onKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "z" && window.StudioModules && window.StudioModules.activeId === "gallery") { e.preventDefault(); performUndo(); return; }
    if (G.page === "detail") { if (document.activeElement && document.activeElement.tagName === "INPUT") return; if (e.key === "Escape") closeDetail(); else if (e.key === "ArrowLeft") prevImage(); else if (e.key === "ArrowRight") nextImage(); }
    // Arrow key navigation for folders/tags in gallery view
    if (G.page === "gallery" && window.StudioModules && window.StudioModules.activeId === "gallery") {
        if (document.activeElement && (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA")) return;
        if (!(e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Enter" || e.key === " ")) return;
        e.preventDefault();
        const c = G._container; if (!c) return;
        if (!G._kbNavCol) G._kbNavCol = "folders";

        // Helper: get only VISIBLE folder toggles (skip ones inside collapsed containers)
        function visibleFolders() {
            return Array.from(c.querySelectorAll(".gal-tree-toggle")).filter(el => el.offsetParent !== null);
        }
        // Helper: get only VISIBLE tag items (skip ones inside collapsed letter groups)
        function visibleTags() {
            return Array.from(c.querySelectorAll(".gal-tag-item")).filter(el => el.offsetParent !== null);
        }
        // Helper: clear all kb-focus
        function clearFocus() { c.querySelectorAll(".kb-focus").forEach(el => el.classList.remove("kb-focus")); }
        // Helper: move focus in a list
        function moveFocus(items, dir) {
            if (!items.length) return;
            let cur = items.findIndex(el => el.classList.contains("kb-focus"));
            if (cur < 0) cur = items.findIndex(el => el.classList.contains("active"));
            let next;
            if (dir === 1) next = cur < items.length - 1 ? cur + 1 : 0;
            else next = cur > 0 ? cur - 1 : items.length - 1;
            clearFocus();
            items[next].classList.add("kb-focus");
            items[next].scrollIntoView({ block: "nearest", behavior: "smooth" });
        }

        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            const dir = e.key === "ArrowDown" ? 1 : -1;
            moveFocus(G._kbNavCol === "tags" ? visibleTags() : visibleFolders(), dir);
        }
        else if (e.key === "ArrowLeft") {
            if (G._kbNavCol === "tags") {
                // Switch to folders column
                G._kbNavCol = "folders"; clearFocus();
                const f = visibleFolders(); const act = f.find(el => el.classList.contains("active")) || f[0];
                if (act) { act.classList.add("kb-focus"); act.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
            } else {
                // Collapse the focused folder
                const focused = c.querySelector(".gal-tree-toggle.kb-focus") || c.querySelector(".gal-tree-toggle.active");
                if (focused) { const arrow = focused.querySelector(".arrow.open"); if (arrow) arrow.click(); }
            }
        }
        else if (e.key === "ArrowRight") {
            if (G._kbNavCol === "folders") {
                // Try to expand focused folder first
                const focused = c.querySelector(".gal-tree-toggle.kb-focus") || c.querySelector(".gal-tree-toggle.active");
                if (focused) { const arrow = focused.querySelector(".arrow:not(.open)"); if (arrow) { arrow.click(); return; } }
                // Already expanded or leaf — switch to tags column
                G._kbNavCol = "tags"; clearFocus();
                const t = visibleTags(); const act = t.find(el => el.classList.contains("active")) || t[0];
                if (act) { act.classList.add("kb-focus"); act.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
            } else {
                // Toggle tag letter group of focused tag
                const ft = c.querySelector(".gal-tag-item.kb-focus");
                if (ft) { const grp = ft.closest(".gal-tag-group"); if (grp) { const lEl = c.querySelector('.gal-tag-letter[data-letter="' + grp.dataset.tagGroup + '"]'); if (lEl) lEl.click(); } }
            }
        }
        else if (e.key === "Enter" || e.key === " ") {
            const focused = c.querySelector(".gal-tree-toggle.kb-focus") || c.querySelector(".gal-tag-item.kb-focus");
            if (focused) focused.click();
        }
    }
}

// ========================================================================
// MODULE REGISTRATION
// ========================================================================

if (window.StudioModules) {
    StudioModules.register("gallery", {
        label: "Gallery", icon: "\uD83D\uDDBC",
        async init(container) {
            console.log(TAG, "Initializing"); G._container = container;
            if (!document.querySelector('link[href*="gallery.css"]')) { const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/studio/static/gallery.css?v=" + VERSION; document.head.appendChild(link); }
            document.addEventListener("keydown", onKeyDown);
            document.addEventListener("click", e => { if (!e.target.closest(".gal-ctx-menu")) hideCtx(); });
            G.scanFolders = await api("/scan-folders"); G.initialized = G.scanFolders.length > 0;
            if (G.initialized) await Promise.all([loadStats(), loadCharacters(), loadFolders(), loadImagesReset()]);
            connectSSE();
            render();
        },
        activate(container) { G._container = container; if (G.initialized) { loadCharacters(); loadFolders(); } },
        deactivate() { if (G.page === "detail") closeDetail(); },
    });
} else console.warn(TAG, "StudioModules not available");
})();
