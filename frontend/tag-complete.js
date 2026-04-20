/**
 * Forge Studio — Tag Autocomplete
 * by ToxicHost & Moritz
 *
 * Lightweight tag completion for the standalone UI.
 * Supports: danbooru tags, LoRA insertion, embedding names, wildcards.
 *
 * Triggers:
 *   - Normal typing (2+ chars)  → danbooru tag search
 *   - <lora:                    → LoRA name search
 *   - <                         → shows LoRA trigger hint
 *   - embedding:                → embedding name search
 *   - __                        → wildcard path search
 */

(function () {
  "use strict";

  // ── Config ──────────────────────────────────────────────
  const MAX_RESULTS = 20;
  const DEBOUNCE_MS = 80;
  const MIN_CHARS = 2;

  // Category colors (matches danbooru tag categories)
  const CAT_COLORS = {
    0: "var(--text-1)",       // general (white)
    1: "#e8a4a4",             // artist (red-ish)
    3: "#c4a4e8",             // copyright (purple)
    4: "#a4c8e8",             // character (blue)
    5: "#e8c4a4",             // meta (orange)
  };

  // Special category colors for non-tag items
  const LORA_COLOR = "#a4e8a4";       // green
  const EMBEDDING_COLOR = "#e8e4a4";  // yellow
  const WILDCARD_COLOR = "#e8a4d4";   // pink

  // ── State ───────────────────────────────────────────────
  let tags = [];            // [{name, cat, count, aliases}]
  let loras = [];           // [{name, file}]  — name without extension
  let embeddings = [];      // [{name, file}]
  let wildcards = [];       // [{name, path}]  — name is path without .txt
  let tagsLoaded = false;
  let extrasLoaded = false;
  let loading = false;
  let dropdown = null;      // DOM element
  let activeTextarea = null;
  let selectedIdx = -1;
  let currentResults = [];
  let debounceTimer = null;

  // ── CSV Loading ─────────────────────────────────────────

  async function findTagPath() {
    // Try reading Gradio's tmp file that tagcomplete writes
    try {
      const resp = await fetch(`file=tmp/tagAutocompletePath.txt?${Date.now()}`);
      if (resp.ok) {
        const path = (await resp.text()).trim();
        if (path) return path;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function parseCSVLine(line) {
    const result = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { result.push(current); current = ""; continue; }
      current += ch;
    }
    result.push(current);
    return result;
  }

  async function loadTags() {
    if (tagsLoaded || loading) return;
    loading = true;

    const basePath = await findTagPath();
    if (!basePath) {
      console.warn("[TagComplete] Could not find tag autocomplete path");
      loading = false;
      return;
    }

    console.log(`[TagComplete] Loading tags from ${basePath}/danbooru.csv`);

    try {
      const resp = await fetch(`file=${basePath}/danbooru.csv?${Date.now()}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      const lines = text.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const parts = parseCSVLine(line);
        if (parts.length < 3) continue;

        const name = parts[0].trim();
        const cat = parseInt(parts[1]) || 0;
        const count = parseInt(parts[2]) || 0;
        const aliases = parts[3] ? parts[3].trim().split(",").map(a => a.trim()).filter(Boolean) : [];

        tags.push({ name, cat, count, aliases });
      }

      tagsLoaded = true;
      console.log(`[TagComplete] Loaded ${tags.length} tags`);
    } catch (e) {
      console.error("[TagComplete] Failed to load tags:", e);
    }
    loading = false;
  }

  // ── Extra Data Loading (LoRAs, Embeddings, Wildcards) ───

  async function loadExtras() {
    if (extrasLoaded) return;

    const base = window.location.origin;
    console.log("[TagComplete] Loading extras (LoRAs, embeddings, wildcards)...");

    try {
      const [loraResp, embResp, wcResp] = await Promise.allSettled([
        fetch(base + "/studio/loras").then(r => r.json()),
        fetch(base + "/studio/embeddings").then(r => r.json()),
        fetch(base + "/studio/wildcards").then(r => r.json()),
      ]);

      if (loraResp.status === "fulfilled" && Array.isArray(loraResp.value)) {
        loras = loraResp.value.map(l => ({
          name: l.name.replace(/\.(safetensors|ckpt|pt)$/i, ""),
          file: l.name,
        }));
        console.log(`[TagComplete] Loaded ${loras.length} LoRAs`);
      } else {
        console.warn("[TagComplete] LoRA load failed:", loraResp.reason || loraResp.value);
      }

      if (embResp.status === "fulfilled" && Array.isArray(embResp.value)) {
        embeddings = embResp.value;
        console.log(`[TagComplete] Loaded ${embeddings.length} embeddings`);
      } else {
        console.warn("[TagComplete] Embeddings load failed:", embResp.reason || embResp.value);
      }

      if (wcResp.status === "fulfilled" && Array.isArray(wcResp.value)) {
        wildcards = wcResp.value;
        console.log(`[TagComplete] Loaded ${wildcards.length} wildcards`);
      } else {
        console.warn("[TagComplete] Wildcards load failed:", wcResp.reason || wcResp.value);
      }
    } catch (e) {
      console.error("[TagComplete] loadExtras error:", e);
    }

    extrasLoaded = true;
  }

  // ── Search ──────────────────────────────────────────────

  function searchTags(query) {
    if (!tagsLoaded || !query || query.length < MIN_CHARS) return [];
    const q = query.toLowerCase().replace(/ /g, "_");

    const results = [];
    for (let i = 0; i < tags.length && results.length < MAX_RESULTS * 3; i++) {
      const t = tags[i];
      if (t.name.startsWith(q)) {
        results.push({ tag: t, matchType: "prefix", pos: 0 });
        continue;
      }
      if (t.name.includes(q)) {
        results.push({ tag: t, matchType: "contains", pos: t.name.indexOf(q) });
        continue;
      }
      for (const a of t.aliases) {
        if (a.startsWith(q) || a.includes(q)) {
          results.push({ tag: t, matchType: "alias", pos: 0 });
          break;
        }
      }
    }

    results.sort((a, b) => {
      if (a.matchType !== b.matchType) {
        const order = { prefix: 0, contains: 1, alias: 2 };
        return order[a.matchType] - order[b.matchType];
      }
      return b.tag.count - a.tag.count;
    });

    return results.slice(0, MAX_RESULTS);
  }

  function searchLoras(query) {
    const q = query.toLowerCase();
    return loras
      .filter(l => l.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const aStart = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bStart = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return aStart - bStart || a.name.localeCompare(b.name);
      })
      .slice(0, MAX_RESULTS)
      .map(l => ({ type: "lora", name: l.name, display: l.name, color: LORA_COLOR }));
  }

  function searchEmbeddings(query) {
    const q = query.toLowerCase();
    return embeddings
      .filter(e => e.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const aStart = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bStart = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return aStart - bStart || a.name.localeCompare(b.name);
      })
      .slice(0, MAX_RESULTS)
      .map(e => ({ type: "embedding", name: e.name, display: e.name, color: EMBEDDING_COLOR }));
  }

  function searchWildcards(query) {
    const q = query.toLowerCase();
    return wildcards
      .filter(w => w.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const aStart = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bStart = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return aStart - bStart || a.name.localeCompare(b.name);
      })
      .slice(0, MAX_RESULTS)
      .map(w => ({ type: "wildcard", name: w.name, display: w.name, color: WILDCARD_COLOR }));
  }

  // ── Context Detection ───────────────────────────────────

  /**
   * Analyze the text around the cursor to determine what kind of
   * completion is needed.
   *
   * Returns: { mode, query, replaceStart, replaceEnd }
   *   mode: "tag" | "lora" | "embedding" | "wildcard" | null
   */
  function getContext(textarea) {
    const text = textarea.value;
    const cursor = textarea.selectionStart;

    // Look backwards from cursor for trigger patterns
    const before = text.substring(0, cursor);

    // ── LoRA: <lora:query
    const loraMatch = before.match(/<lora:([^>]*)$/);
    if (loraMatch) {
      const query = loraMatch[1];
      const start = cursor - query.length;
      return { mode: "lora", query, replaceStart: start, replaceEnd: cursor, triggerStart: cursor - loraMatch[0].length };
    }

    // ── Completed wildcard: cursor right after __name__
    // Show contents for selection or just move on
    const completedWc = before.match(/__([^_,\s]+)__$/);
    if (completedWc) {
      const wcName = completedWc[1];
      const wcStart = cursor - completedWc[0].length;
      const wcEnd = cursor;
      return { mode: "wildcard_content", query: wcName, wcStart, wcEnd, replaceStart: wcStart, replaceEnd: wcEnd, triggerStart: wcStart };
    }

    // ── Wildcard: __query (open, not yet completed)
    const wcMatch = before.match(/__([^_,\s]*)$/);
    if (wcMatch) {
      const query = wcMatch[1];
      const start = cursor - query.length;
      return { mode: "wildcard", query, replaceStart: start, replaceEnd: cursor, triggerStart: cursor - wcMatch[0].length };
    }

    // ── Embedding: embedding:query (or just after the word "embedding:")
    const embMatch = before.match(/(?:^|[\s,])embedding:([^\s,]*)$/);
    if (embMatch) {
      const query = embMatch[1];
      const start = cursor - query.length;
      return { mode: "embedding", query, replaceStart: start, replaceEnd: cursor, triggerStart: cursor - embMatch[0].length };
    }

    // ── Default: tag completion
    // Find start of current tag (after last comma or start)
    let tagStart = cursor;
    while (tagStart > 0 && text[tagStart - 1] !== ',') tagStart--;
    while (tagStart < cursor && text[tagStart] === ' ') tagStart++;

    const word = text.substring(tagStart, cursor);
    if (word.length >= MIN_CHARS) {
      return { mode: "tag", query: word, replaceStart: tagStart, replaceEnd: cursor, triggerStart: tagStart };
    }

    return { mode: null, query: "", replaceStart: cursor, replaceEnd: cursor, triggerStart: cursor };
  }

  // ── Insertion ───────────────────────────────────────────

  function insertCompletion(textarea, ctx, selectedItem) {
    const text = textarea.value;

    let insert = "";
    let cursorOffset = 0; // offset from end of insertion

    switch (ctx.mode) {
      case "lora": {
        // Replace from <lora: to cursor with full lora syntax
        const fullInsert = `<lora:${selectedItem.name}:1>`;
        const triggerStart = ctx.triggerStart;
        // Position cursor on the weight number
        const newText = text.substring(0, triggerStart) + fullInsert + text.substring(ctx.replaceEnd);
        textarea.value = newText;
        // Cursor before the closing >
        const newPos = triggerStart + fullInsert.length - 1;
        textarea.selectionStart = textarea.selectionEnd = newPos;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }

      case "embedding": {
        // Replace the query part, keep "embedding:" prefix
        insert = selectedItem.name;
        break;
      }

      case "wildcard": {
        // Replace from __ to cursor with __name__
        const triggerStart = ctx.triggerStart;
        const fullInsert = `__${selectedItem.name}__`;
        const after = text.substring(ctx.replaceEnd);
        const skipEnd = after.startsWith("__") ? ctx.replaceEnd + 2 : ctx.replaceEnd;
        const newText = text.substring(0, triggerStart) + fullInsert + text.substring(skipEnd);
        textarea.value = newText;
        const newPos = triggerStart + fullInsert.length;
        textarea.selectionStart = textarea.selectionEnd = newPos;

        // Now show the wildcard contents as a dropdown
        _showWildcardContents(textarea, selectedItem.name, triggerStart, triggerStart + fullInsert.length);
        return;
      }

      case "wildcard_content": {
        // Replace the __wildcard__ with the selected content value
        const wcStart = ctx.wcStart;
        const wcEnd = ctx.wcEnd;
        const after = text.substring(wcEnd).trimStart();
        const sep = (after.length === 0 || after[0] !== ',') ? ", " : " ";
        const newText = text.substring(0, wcStart) + selectedItem.name + sep + text.substring(wcEnd);
        textarea.value = newText;
        const newPos = wcStart + selectedItem.name.length + sep.length;
        textarea.selectionStart = textarea.selectionEnd = newPos;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }

      case "tag":
      default: {
        insert = (selectedItem.tag ? selectedItem.tag.name : selectedItem.name).replace(/_/g, " ");
        // Add comma + space after
        const after = text.substring(ctx.replaceEnd).trimStart();
        if (after.length === 0 || after[0] !== ',') {
          insert += ", ";
        } else {
          insert += " ";
        }
        break;
      }
    }

    const newText = text.substring(0, ctx.replaceStart) + insert + text.substring(ctx.replaceEnd);
    textarea.value = newText;
    const newPos = ctx.replaceStart + insert.length;
    textarea.selectionStart = textarea.selectionEnd = newPos;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // ── Wildcard Content Dropdown ───────────────────────────

  let _wcContentCtx = null;  // tracks active wildcard_content context

  async function _showWildcardContents(textarea, wcName, wcStart, wcEnd) {
    // Fetch content
    let data;
    if (previewCache[wcName]) {
      data = previewCache[wcName];
    } else {
      try {
        const resp = await fetch(`${window.location.origin}/studio/wildcard_content?name=${encodeURIComponent(wcName)}`);
        data = await resp.json();
        previewCache[wcName] = data;
      } catch (e) {
        return;
      }
    }

    if (!data.lines || data.lines.length === 0) return;

    // Build results for the dropdown
    const results = data.lines.map(line => ({
      type: "wildcard_content",
      name: line,
      display: line,
      color: WILDCARD_COLOR,
      wcName: wcName,
    }));

    // Set context so insertCompletion knows how to handle selection
    _wcContentCtx = { mode: "wildcard_content", wcStart, wcEnd };
    _lastCtx = _wcContentCtx;

    currentResults = results;
    selectedIdx = -1;

    // Render the dropdown
    const dd = createDropdown();
    const header = `<div style="padding:4px 10px;color:var(--text-4,#666);font-size:9px;border-bottom:1px solid var(--border-subtle,#222);">
      __${wcName}__ · ${data.count} entries${data.truncated ? " (showing 50)" : ""} · select to replace, Esc to keep wildcard
    </div>`;
    dd.innerHTML = header + results.map((r, i) => renderItem(r, i)).join("");

    const rect = textarea.getBoundingClientRect();
    dd.style.left = rect.left + "px";
    dd.style.top = (rect.bottom + 4) + "px";
    dd.style.display = "block";
    const ddW = dd.offsetWidth || 380;
    if (rect.left + ddW > window.innerWidth - 8) dd.style.left = Math.max(4, window.innerWidth - ddW - 8) + "px";

    dd.querySelectorAll(".tac-item").forEach(item => {
      item.addEventListener("click", () => {
        const idx = parseInt(item.dataset.idx);
        if (idx >= 0 && idx < currentResults.length) {
          insertCompletion(textarea, _wcContentCtx, currentResults[idx]);
          hideDropdown();
        }
      });
    });
  }

  let previewCache = {};  // name → {lines, count, truncated}

  // ── Dropdown UI ─────────────────────────────────────────

  function createDropdown() {
    if (dropdown) return dropdown;
    const el = document.createElement("div");
    el.className = "tac-dropdown";
    el.style.cssText = `
      display:none; position:fixed; z-index:9999;
      background:var(--bg-surface, #1a1a2e); border:1px solid var(--border, #333);
      border-radius:6px; box-shadow:0 8px 24px rgba(0,0,0,0.6);
      max-height:320px; overflow-y:auto; width:380px;
      font-family:var(--font, sans-serif); font-size:11px;
      scrollbar-width:thin; scrollbar-gutter:stable;
    `;
    document.body.appendChild(el);
    dropdown = el;
    el.addEventListener("mousedown", e => e.preventDefault());
    return el;
  }

  function renderItem(item, idx) {
    // Tag items (from danbooru search)
    if (item.tag) {
      const t = item.tag;
      const color = CAT_COLORS[t.cat] || CAT_COLORS[0];
      const countStr = t.count >= 1000000 ? (t.count / 1000000).toFixed(1) + "M"
                     : t.count >= 1000 ? (t.count / 1000).toFixed(0) + "k"
                     : t.count.toString();
      const aliasStr = t.aliases.length > 0
        ? ` <span style="color:var(--text-4,#666);">${t.aliases.slice(0, 3).join(", ")}</span>` : "";
      return `<div class="tac-item" data-idx="${idx}" style="
        padding:4px 10px; cursor:pointer; display:flex; align-items:center; justify-content:space-between;
        border-bottom:1px solid var(--border-subtle, #222);
      ">
        <span style="color:${color};min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${t.name.replace(/_/g, " ")}${aliasStr}</span>
        <span style="color:var(--text-3,#999);font-size:10px;font-family:var(--mono,monospace);white-space:nowrap;margin-left:8px;">${countStr}</span>
      </div>`;
    }

    // Special items (LoRA, embedding, wildcard)
    const typeLabel = item.type === "lora" ? "LoRA"
                    : item.type === "embedding" ? "TI"
                    : item.type === "wildcard" ? "WC" : "";
    return `<div class="tac-item" data-idx="${idx}" style="
      padding:4px 10px; cursor:pointer; display:flex; align-items:center; gap:6px;
      border-bottom:1px solid var(--border-subtle, #222);
    ">
      <span style="color:${item.color};flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
        ${item.display}
      </span>
      <span style="color:var(--text-4,#666);font-size:9px;font-family:var(--mono,monospace);flex-shrink:0;
        background:var(--bg-raised,#252540);padding:1px 5px;border-radius:3px;">${typeLabel}</span>
    </div>`;
  }

  function showDropdown(results, textarea) {
    const dd = createDropdown();
    currentResults = results;
    selectedIdx = -1;

    if (results.length === 0) {
      dd.style.display = "none";
      return;
    }

    dd.innerHTML = results.map((r, i) => renderItem(r, i)).join("");

    const rect = textarea.getBoundingClientRect();
    dd.style.left = rect.left + "px";
    dd.style.top = (rect.bottom + 4) + "px";
    dd.style.display = "block";
    const ddW = dd.offsetWidth || 380;
    if (rect.left + ddW > window.innerWidth - 8) dd.style.left = Math.max(4, window.innerWidth - ddW - 8) + "px";

    dd.querySelectorAll(".tac-item").forEach(item => {
      item.addEventListener("click", () => {
        const idx = parseInt(item.dataset.idx);
        if (idx >= 0 && idx < currentResults.length) {
          insertCompletion(activeTextarea, _lastCtx, currentResults[idx]);
          hideDropdown();
        }
      });
    });
  }

  function hideDropdown() {
    if (dropdown) dropdown.style.display = "none";
    currentResults = [];
    selectedIdx = -1;
    _wcContentCtx = null;
  }

  function updateSelection(idx) {
    if (!dropdown) return;
    const items = dropdown.querySelectorAll(".tac-item");
    items.forEach((item, i) => {
      item.style.background = i === idx ? "var(--accent-dim, #333)" : "transparent";
    });
    selectedIdx = idx;
    if (items[idx]) items[idx].scrollIntoView({ block: "nearest" });
  }

  // ── Event Handlers ──────────────────────────────────────

  let _lastCtx = null;

  function onInput(e) {
    const textarea = e.target;
    activeTextarea = textarea;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const ctx = getContext(textarea);
      _lastCtx = ctx;

      if (!ctx.mode) {
        hideDropdown();
        return;
      }

      let results = [];

      switch (ctx.mode) {
        case "lora":
          results = searchLoras(ctx.query);
          // Show all if query is empty (just typed <lora:)
          if (!ctx.query && loras.length) {
            results = loras.slice(0, MAX_RESULTS).map(l => ({
              type: "lora", name: l.name, display: l.name, color: LORA_COLOR
            }));
          }
          break;

        case "embedding":
          results = searchEmbeddings(ctx.query);
          if (!ctx.query && embeddings.length) {
            results = embeddings.slice(0, MAX_RESULTS).map(e => ({
              type: "embedding", name: e.name, display: e.name, color: EMBEDDING_COLOR
            }));
          }
          break;

        case "wildcard":
          results = searchWildcards(ctx.query);
          if (!ctx.query && wildcards.length) {
            results = wildcards.slice(0, MAX_RESULTS).map(w => ({
              type: "wildcard", name: w.name, display: w.name, color: WILDCARD_COLOR
            }));
          }
          break;

        case "wildcard_content":
          // Show contents of the completed wildcard
          _showWildcardContents(textarea, ctx.query, ctx.wcStart, ctx.wcEnd);
          return;  // _showWildcardContents handles dropdown directly

        case "tag":
          results = searchTags(ctx.query);
          break;
      }

      showDropdown(results, textarea);
    }, DEBOUNCE_MS);
  }

  function onKeyDown(e) {
    if (!dropdown || dropdown.style.display === "none" || currentResults.length === 0) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        updateSelection(Math.min(selectedIdx + 1, currentResults.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        updateSelection(Math.max(selectedIdx - 1, 0));
        break;
      case "Tab":
      case "Enter":
        // If nothing selected, Tab auto-selects the first result
        if (e.key === "Tab" && selectedIdx < 0 && currentResults.length > 0) {
          selectedIdx = 0;
          updateSelection(0);
        }
        if (selectedIdx >= 0 && selectedIdx < currentResults.length) {
          e.preventDefault();
          insertCompletion(e.target, _lastCtx, currentResults[selectedIdx]);
          hideDropdown();
        }
        break;
      case "Escape":
        e.preventDefault();
        hideDropdown();
        break;
    }
  }

  function onBlur(e) {
    setTimeout(() => {
      if (document.activeElement !== activeTextarea) {
        hideDropdown();
      }
    }, 200);
  }

  // ── Setup ───────────────────────────────────────────────

  function attachToTextarea(textarea) {
    if (!textarea || textarea._tacAttached) return;
    textarea._tacAttached = true;
    textarea.addEventListener("input", onInput);
    textarea.addEventListener("keydown", onKeyDown);
    textarea.addEventListener("blur", onBlur);
  }

  async function init() {
    // Load tags first (from tagcomplete extension CSV)
    await loadTags();

    // Load extras from Studio API (LoRAs, embeddings, wildcards)
    // Delay slightly to ensure API routes are registered
    setTimeout(async () => {
      await loadExtras();
    }, 1000);

    if (!tagsLoaded) {
      console.warn("[TagComplete] No tag data loaded — autocomplete limited to extras");
    }

    // Attach to prompt textareas
    const targets = [
      "paramPrompt", "paramNeg",
      "paramAD1Prompt", "paramAD2Prompt", "paramAD3Prompt"
    ];
    targets.forEach(id => {
      const el = document.getElementById(id);
      if (el) attachToTextarea(el);
    });

    // Watch for dynamically created region prompt textareas
    const observer = new MutationObserver(() => {
      document.querySelectorAll("[id^=regionPrompt]").forEach(el => attachToTextarea(el));
    });
    const regionList = document.getElementById("regionList");
    if (regionList) observer.observe(regionList, { childList: true, subtree: true });

    console.log("[TagComplete] Ready");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
