/* ============================================================================
 * settings-page.js — Settings page navigation, search, accordions, deep-links
 * ----------------------------------------------------------------------------
 * Loaded after app.js and module-system.js. Owns ONLY the presentation shell
 * of #app-settings (category switching, collapse state, search, dependency
 * dimming). It never rebinds or recreates the setting controls themselves —
 * every control keeps the exact id/handler app.js wired at boot. All controls
 * exist in the DOM up-front; categories are shown/hidden, never lazily built.
 *
 * Persists UI state (not setting values) under the "studio" localStorage
 * prefix so `?reset` sweeps it:
 *   studio.settings.category           → active category slug
 *   studio.settings.collapsedSections  → { sectionSlug: "open"|"closed" }
 * ========================================================================== */
(function () {
  "use strict";

  var ROOT_ID = "app-settings";
  var CATEGORIES = [
    "general", "appearance-layout", "canvas-tools", "generation-preview",
    "prompts-metadata", "output-files", "performance-vram",
    "keyboard-shortcuts", "extensions", "about"
  ];
  var DEFAULT_CATEGORY = "general";
  var LS_CATEGORY = "studio.settings.category";
  var LS_COLLAPSED = "studio.settings.collapsedSections";
  var HASH_PREFIX = "#settings/";

  // sectionId → {category, section} for window.openStudioSettings(sectionId).
  // Folded cases (sessionCategories, sessionAccordion*) point at their host card.
  var TARGET_MAP = {
    toggleRememberSession: { category: "general", section: "session" },
    settingSessionLimit: { category: "general", section: "session" },
    clearSessionBtn: { category: "general", section: "session" },
    sessionCategories: { category: "general", section: "session" },
    sessionAccordionHeader: { category: "general", section: "session" },
    sessionAccordionBody: { category: "general", section: "session" },
    saveDefaults: { category: "general", section: "defaults" },
    resetDefaults: { category: "general", section: "defaults" },
    settingLocale: { category: "general", section: "language" },
    themeSelector: { category: "appearance-layout", section: "theme" },
    layoutSelector: { category: "appearance-layout", section: "layout" },
    densitySelector: { category: "appearance-layout", section: "layout" },
    toggleCustomize: { category: "appearance-layout", section: "layout" },
    toggleClassicStrip: { category: "appearance-layout", section: "layout" },
    layoutCurrentName: { category: "appearance-layout", section: "saved-layouts" },
    layoutLoadSelect: { category: "appearance-layout", section: "saved-layouts" },
    layoutResetBtn: { category: "appearance-layout", section: "saved-layouts" },
    layoutSaveBtn: { category: "appearance-layout", section: "saved-layouts" },
    layoutSaveAsBtn: { category: "appearance-layout", section: "saved-layouts" },
    layoutDeleteBtn: { category: "appearance-layout", section: "saved-layouts" },
    settingColorblind: { category: "appearance-layout", section: "accessibility" },
    settingMotion: { category: "appearance-layout", section: "accessibility" },
    toggleGrid: { category: "canvas-tools", section: "canvas" },
    toggleCanvasColorPreview: { category: "canvas-tools", section: "canvas" },
    toggleSaveOutputs: { category: "generation-preview", section: "generation" },
    toggleArchShowAll: { category: "generation-preview", section: "generation" },
    toggleHighPrecision: { category: "generation-preview", section: "generation" },
    toggleLivePreview: { category: "generation-preview", section: "live-preview" },
    settingLivePreviewQuality: { category: "generation-preview", section: "live-preview" },
    toggleTagAutocomplete: { category: "prompts-metadata", section: "prompt-autocomplete" },
    togglePromptCleanup: { category: "prompts-metadata", section: "prompt-autocomplete" },
    settingTagSource: { category: "prompts-metadata", section: "prompt-autocomplete" },
    dynamicPromptsSettings: { category: "prompts-metadata", section: "dynamic-prompts" },
    toggleStudioDynPrompts: { category: "prompts-metadata", section: "dynamic-prompts" },
    dynPromptsFolderRow: { category: "prompts-metadata", section: "dynamic-prompts" },
    dynPromptsFolderBrowse: { category: "prompts-metadata", section: "dynamic-prompts" },
    dynPromptsFolderReset: { category: "prompts-metadata", section: "dynamic-prompts" },
    dynPromptsFolderManualRow: { category: "prompts-metadata", section: "dynamic-prompts" },
    dynPromptsFolderInput: { category: "prompts-metadata", section: "dynamic-prompts" },
    dynPromptsFolderSet: { category: "prompts-metadata", section: "dynamic-prompts" },
    toggleCivitaiLookup: { category: "prompts-metadata", section: "civitai" },
    settingSaveFormat: { category: "output-files", section: "output-format" },
    toggleMetadata: { category: "output-files", section: "output-format" },
    fmtJpegOpts: { category: "output-files", section: "output-format" },
    settingJpegQuality: { category: "output-files", section: "output-format" },
    fmtWebpOpts: { category: "output-files", section: "output-format" },
    toggleWebpLossless: { category: "output-files", section: "output-format" },
    webpQualityRow: { category: "output-files", section: "output-format" },
    settingWebpQuality: { category: "output-files", section: "output-format" },
    settingGalleryFolder: { category: "output-files", section: "save-to-gallery" },
    galleryFolderTrust: { category: "output-files", section: "save-to-gallery" },
    galleryFolderBrowse: { category: "output-files", section: "save-to-gallery" },
    galleryFolderOpen: { category: "output-files", section: "save-to-gallery" },
    settingSaveTree: { category: "output-files", section: "save-folder" },
    settingSaveDir: { category: "output-files", section: "save-folder" },
    saveDirTrust: { category: "output-files", section: "save-folder" },
    saveDirBrowse: { category: "output-files", section: "save-folder" },
    saveDirOpen: { category: "output-files", section: "save-folder" },
    trustedRootsList: { category: "output-files", section: "save-folder" },
    toggleWatermark: { category: "output-files", section: "watermark" },
    watermarkOpts: { category: "output-files", section: "watermark" },
    settingWatermarkMode: { category: "output-files", section: "watermark" },
    settingWatermark: { category: "output-files", section: "watermark" },
    watermarkRefresh: { category: "output-files", section: "watermark" },
    watermarkOpenFolder: { category: "output-files", section: "watermark" },
    settingWatermarkPosition: { category: "output-files", section: "watermark" },
    settingWatermarkOpacity: { category: "output-files", section: "watermark" },
    settingWatermarkScale: { category: "output-files", section: "watermark" },
    settingWatermarkMargin: { category: "output-files", section: "watermark" },
    settingWatermarkRotation: { category: "output-files", section: "watermark" },
    unloadModelBtn: { category: "performance-vram", section: "vram" },
    vramReserveSlider: { category: "performance-vram", section: "vram" },
    toggleAutoUnload: { category: "performance-vram", section: "vram" },
    autoUnloadMinutesRow: { category: "performance-vram", section: "vram" },
    autoUnloadMinutes: { category: "performance-vram", section: "vram" },
    keyboardShortcutsSettings: { category: "keyboard-shortcuts", section: "keyboard-shortcuts" },
    shortcutSettingsRows: { category: "keyboard-shortcuts", section: "keyboard-shortcuts" },
    shortcutResetAll: { category: "keyboard-shortcuts", section: "keyboard-shortcuts" },
    extToggles: { category: "extensions", section: "extensions" },
    checkUpdateBtn: { category: "about", section: "updates" },
    updateCheckStatus: { category: "about", section: "updates" },
    creditsToggle: { category: "about", section: "credits" },
    creditsBody: { category: "about", section: "credits" }
  };

  // ── small helpers ─────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function root() { return document.getElementById(ROOT_ID); }
  function qsa(sel, ctx) { return Array.prototype.slice.call((ctx || root() || document).querySelectorAll(sel)); }
  function t(key, fallback, params) {
    try {
      if (window.I18N && typeof window.I18N.t === "function") return window.I18N.t(key, fallback, params);
    } catch (e) {}
    if (params && typeof fallback === "string") {
      return fallback.replace(/\{(\w+)\}/g, function (_, k) { return params[k] != null ? params[k] : ""; });
    }
    return fallback;
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  var _collapsedState = null;
  function collapsedState() {
    if (_collapsedState) return _collapsedState;
    try { _collapsedState = JSON.parse(lsGet(LS_COLLAPSED) || "{}") || {}; }
    catch (e) { _collapsedState = {}; }
    return _collapsedState;
  }
  function persistCollapsed() { lsSet(LS_COLLAPSED, JSON.stringify(collapsedState())); }

  // ── category navigation ───────────────────────────────────────────────────
  var _activeCategory = null;

  function validCategory(slug) { return CATEGORIES.indexOf(slug) !== -1 ? slug : null; }

  function isSettingsActive() {
    return !!(window.StudioModules && window.StudioModules.activeAppId === "settings");
  }

  function selectCategory(slug, opts) {
    opts = opts || {};
    slug = validCategory(slug) || DEFAULT_CATEGORY;
    var r = root();
    if (!r) return;

    // Clearing any active search first — categories are authoritative again.
    if (!opts.fromSearch) clearSearch(true);

    qsa("[data-settings-category]").forEach(function (panel) {
      var on = panel.getAttribute("data-settings-category") === slug;
      if (on) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
    });
    qsa(".settings-nav-button").forEach(function (btn) {
      var on = btn.getAttribute("data-settings-nav") === slug;
      btn.classList.toggle("active", on);
      if (on) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });
    var sel = $("settingsNavSelect");
    if (sel && sel.value !== slug) sel.value = slug;

    _activeCategory = slug;
    if (opts.persist !== false) lsSet(LS_CATEGORY, slug);
    // Only reflect into the URL while the Settings page is actually visible,
    // so boot-time restore doesn't stamp #settings/... onto another tab.
    if (opts.updateHash !== false && isSettingsActive()) setHash(slug);
    if (opts.scrollTop && r) r.scrollTop = 0;

    announce(t("settings.nav.announce", "{title}", { title: categoryTitle(slug) }));
  }

  function categoryTitle(slug) {
    var btn = document.querySelector('.settings-nav-button[data-settings-nav="' + slug + '"] span');
    return btn ? btn.textContent.trim() : slug;
  }

  function setHash(slug) {
    var want = HASH_PREFIX + slug;
    if (location.hash === want) return;
    try { history.replaceState(null, "", want); }
    catch (e) { location.hash = want; }
  }

  function categoryFromHash() {
    if (location.hash.indexOf(HASH_PREFIX) !== 0) return null;
    return validCategory(location.hash.slice(HASH_PREFIX.length));
  }

  // ── collapsible cards ─────────────────────────────────────────────────────
  function cardSection(card) { return card.getAttribute("data-settings-section"); }

  function setCardOpen(card, open, persist) {
    var head = card.querySelector(".settings-card-head");
    var body = card.querySelector(".settings-card-body");
    if (!head || !body) return;
    if (open) { body.removeAttribute("hidden"); head.setAttribute("aria-expanded", "true"); }
    else { body.setAttribute("hidden", ""); head.setAttribute("aria-expanded", "false"); }
    if (persist) {
      collapsedState()[cardSection(card)] = open ? "open" : "closed";
      persistCollapsed();
    }
  }

  function initCollapsibles() {
    var saved = collapsedState();
    qsa('.settings-card[data-collapsible="true"]').forEach(function (card) {
      var head = card.querySelector(".settings-card-head");
      if (!head || head._settingsBound) return;
      head._settingsBound = true;
      // Apply persisted state (HTML default is collapsed).
      var pref = saved[cardSection(card)];
      if (pref === "open") setCardOpen(card, true, false);
      else if (pref === "closed") setCardOpen(card, false, false);
      head.addEventListener("click", function () {
        var isOpen = head.getAttribute("aria-expanded") === "true";
        setCardOpen(card, !isOpen, true);
      });
    });

    // Bespoke cards (Credits): app.js owns the display toggle; we add keyboard
    // access and mirror aria-expanded / chevron from the body's visibility.
    qsa('.settings-card[data-collapsible="bespoke"]').forEach(function (card) {
      var head = card.querySelector(".settings-card-head-bespoke");
      var body = card.querySelector(".settings-card-body");
      if (!head || !body || head._settingsBound) return;
      head._settingsBound = true;
      head.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
          e.preventDefault();
          head.click();
        }
      });
      var sync = function () {
        var open = body.style.display !== "none";
        head.setAttribute("aria-expanded", open ? "true" : "false");
        head.classList.toggle("open", open);
      };
      sync();
      try {
        new MutationObserver(sync).observe(body, { attributes: true, attributeFilter: ["style"] });
      } catch (e) {}
    });
  }

  function expandCardForSection(category, section) {
    var panel = document.querySelector('[data-settings-category="' + category + '"]');
    if (!panel) return null;
    var card = panel.querySelector('[data-settings-section="' + section + '"]');
    if (!card) return null;
    var mode = card.getAttribute("data-collapsible");
    if (mode === "true") {
      setCardOpen(card, true, true);
    } else if (mode === "bespoke") {
      var body = card.querySelector(".settings-card-body");
      var head = card.querySelector(".settings-card-head-bespoke");
      if (body && head && body.style.display === "none") head.click();
    }
    return card;
  }

  // ── deep-link: window.openStudioSettings(sectionId) ───────────────────────
  function revealSection(sectionId) {
    var target = TARGET_MAP[sectionId];
    var el = sectionId ? $(sectionId) : null;
    var category, section;

    if (target) { category = target.category; section = target.section; }
    else if (el) {
      var pc = el.closest("[data-settings-category]");
      var ps = el.closest("[data-settings-section]");
      category = pc ? pc.getAttribute("data-settings-category") : DEFAULT_CATEGORY;
      section = ps ? ps.getAttribute("data-settings-section") : null;
    } else {
      return;
    }

    clearSearch(true);
    selectCategory(category, { scrollTop: false });
    if (section) expandCardForSection(category, section);

    requestAnimationFrame(function () {
      var focusEl = $(sectionId) || null;
      var scrollEl = focusEl ||
        document.querySelector('[data-setting-key="' + sectionId + '"]') ||
        (section ? document.querySelector('[data-settings-category="' + category + '"] [data-settings-section="' + section + '"]') : null);
      if (!scrollEl) return;
      try { scrollEl.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) { scrollEl.scrollIntoView(); }
      scrollEl.classList.add("settings-attention");
      setTimeout(function () { scrollEl.classList.remove("settings-attention"); }, 1200);
      if (focusEl && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(focusEl.tagName)) {
        try { focusEl.focus({ preventScroll: true }); } catch (e) {}
      }
    });
  }

  // Public deep-link entry; preserves the old activate-then-scroll contract.
  function openStudioSettings(sectionId) {
    var activated = window.StudioModules && window.StudioModules.activateApp
      ? window.StudioModules.activateApp("settings") : undefined;
    if (activated === false) return;
    if (!sectionId) { restoreCategory(); return; }
    // revealSection selects the category + expands the card synchronously, then
    // defers the scroll/highlight to its own rAF (page is visible by then).
    revealSection(sectionId);
  }

  // ── search ────────────────────────────────────────────────────────────────
  var _searchIndex = null;
  var _searchActive = false;

  function buildIndex() {
    _searchIndex = [];
    qsa(".settings-item[data-setting-key], .settings-action-row[data-setting-key]").forEach(function (item) {
      var panel = item.closest("[data-settings-category]");
      var card = item.closest("[data-settings-section]");
      var catTitle = panel ? categoryTitle(panel.getAttribute("data-settings-category")) : "";
      var cardTitleEl = card ? card.querySelector(".settings-card-title") : null;
      var text = [
        item.textContent,
        item.getAttribute("data-setting-search") || "",
        catTitle,
        cardTitleEl ? cardTitleEl.textContent : ""
      ].join(" ").toLowerCase();
      _searchIndex.push({ item: item, card: card, panel: panel, text: text });
    });
  }

  function runSearch(rawQuery) {
    var q = (rawQuery || "").trim().toLowerCase();
    var r = root();
    if (!r) return;
    if (!q) { clearSearch(false); return; }
    if (!_searchIndex) buildIndex();

    _searchActive = true;
    r.classList.add("is-searching");
    var clearBtn = $("settingsSearchClear");
    if (clearBtn) clearBtn.hidden = false;

    var terms = q.split(/\s+/).filter(Boolean);
    function matches(text) {
      for (var i = 0; i < terms.length; i++) { if (text.indexOf(terms[i]) === -1) return false; }
      return true;
    }

    var matchedCards = new Set();
    var matchedPanels = new Set();
    var count = 0;

    _searchIndex.forEach(function (entry) {
      var hit = matches(entry.text);
      entry.item.classList.toggle("settings-hidden-by-search", !hit);
      if (hit) {
        count++;
        if (entry.card) matchedCards.add(entry.card);
        if (entry.panel) matchedPanels.add(entry.panel);
      }
    });

    // Include injected extension rows (flat list) by textContent. Shortcut rows
    // have their own group-collapse + dedicated search box, so they're excluded
    // here to avoid fighting the collapse state.
    count += filterInjectedRows("#extToggles .setting-row", matches, matchedCards, matchedPanels);

    // Show only panels/cards that contain a match; expand matched cards.
    qsa("[data-settings-category]").forEach(function (panel) {
      if (matchedPanels.has(panel)) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
    });
    qsa(".settings-card").forEach(function (card) {
      var show = matchedCards.has(card);
      card.classList.toggle("settings-hidden-by-search", !show);
      var body = card.querySelector(".settings-card-body");
      var head = card.querySelector(".settings-card-head");
      if (body) {
        if (show) {
          body.classList.add("settings-search-expanded");
          // Keep the accessible state coherent with the force-shown body.
          if (head && card.hasAttribute("data-collapsible")) head.setAttribute("aria-expanded", "true");
        } else {
          body.classList.remove("settings-search-expanded");
        }
      }
    });

    var empty = $("settingsSearchEmpty");
    if (empty) empty.hidden = count > 0;
    announce(count > 0
      ? t("settings.search.resultsCount", "{count} results", { count: count })
      : t("settings.search.noResults", "No settings match your search."));
  }

  function filterInjectedRows(sel, matches, matchedCards, matchedPanels) {
    var n = 0;
    qsa(sel).forEach(function (rowEl) {
      var hit = matches(rowEl.textContent.toLowerCase());
      rowEl.classList.toggle("settings-hidden-by-search", !hit);
      if (hit) {
        n++;
        var card = rowEl.closest("[data-settings-section]");
        var panel = rowEl.closest("[data-settings-category]");
        if (card) matchedCards.add(card);
        if (panel) matchedPanels.add(panel);
      }
    });
    return n;
  }

  function clearSearch(silent) {
    var r = root();
    var input = $("settingsSearchInput");
    if (input && input.value) input.value = "";
    var clearBtn = $("settingsSearchClear");
    if (clearBtn) clearBtn.hidden = true;
    var empty = $("settingsSearchEmpty");
    if (empty) empty.hidden = true;
    if (!_searchActive) { if (!silent) announce(""); }
    _searchActive = false;
    if (r) r.classList.remove("is-searching");

    qsa(".settings-hidden-by-search").forEach(function (el) { el.classList.remove("settings-hidden-by-search"); });
    qsa(".settings-card-body.settings-search-expanded").forEach(function (el) { el.classList.remove("settings-search-expanded"); });
    // Restore each collapsible card's aria-expanded to its real collapse state
    // (search force-showed some bodies without touching the persistent state).
    qsa(".settings-card[data-collapsible]").forEach(function (card) {
      var head = card.querySelector(".settings-card-head");
      var body = card.querySelector(".settings-card-body");
      if (!head || !body) return;
      var open = card.getAttribute("data-collapsible") === "bespoke"
        ? body.style.display !== "none"
        : !body.hasAttribute("hidden");
      head.setAttribute("aria-expanded", open ? "true" : "false");
    });

    // Restore single-category view.
    if (_activeCategory) {
      qsa("[data-settings-category]").forEach(function (panel) {
        if (panel.getAttribute("data-settings-category") === _activeCategory) panel.removeAttribute("hidden");
        else panel.setAttribute("hidden", "");
      });
    }
    if (!silent) announce("");
  }

  function announce(msg) {
    var live = $("settingsSearchStatus");
    if (live) live.textContent = msg || "";
  }

  // ── dependency (disabled-because-parent-off) states ───────────────────────
  // Only the three NOT already handled by app.js. Driven by a MutationObserver
  // on the parent toggle's class list (fires AFTER app.js flips `.on`), so we
  // never race the click handler. Dimmed + inert; never display:none.
  function applyDependency(item, enabled) {
    item.classList.toggle("settings-dep-disabled", !enabled);
    if (enabled) item.removeAttribute("aria-disabled");
    else item.setAttribute("aria-disabled", "true");
    qsa("input, select, button, textarea", item).forEach(function (ctrl) {
      // Don't fight the manual-path fallback row toggled by app.js.
      if (ctrl.closest("#dynPromptsFolderManualRow")) return;
      ctrl.disabled = !enabled;
    });
  }

  function initDependencies() {
    qsa("[data-setting-depends]").forEach(function (item) {
      var toggleId = item.getAttribute("data-setting-depends");
      var toggle = $(toggleId);
      if (!toggle || item._depBound) return;
      item._depBound = true;
      var sync = function () { applyDependency(item, toggle.classList.contains("on")); };
      sync();
      try {
        new MutationObserver(sync).observe(toggle, { attributes: true, attributeFilter: ["class"] });
      } catch (e) {}
    });
  }

  // ── card state summaries + watermark auto-expand ──────────────────────────
  function initSummarySources() {
    qsa("[data-summary-source]").forEach(function (card) {
      var toggle = $(card.getAttribute("data-summary-source"));
      var summary = card.querySelector("[data-card-summary]");
      if (!toggle || !summary || card._sumBound) return;
      card._sumBound = true;
      var autoExpandId = card.getAttribute("data-auto-expand-on");
      // Seed prevOn from the current state so the initial render (and app.js's
      // async restore of the saved toggle) is NOT treated as an off->on
      // transition — that would re-open a card the user had collapsed (persisted
      // collapse must survive reload).
      var prevOn = toggle.classList.contains("on");
      summary.textContent = prevOn ? t("common.on", "On") : t("common.off", "Off");
      var sync = function () {
        var on = toggle.classList.contains("on");
        summary.textContent = on ? t("common.on", "On") : t("common.off", "Off");
        if (autoExpandId && on && !prevOn &&
            card.getAttribute("data-collapsible") === "true" &&
            collapsedState()[cardSection(card)] !== "closed") {
          setCardOpen(card, true, false);
        }
        prevOn = on;
      };
      try {
        new MutationObserver(sync).observe(toggle, { attributes: true, attributeFilter: ["class"] });
      } catch (e) {}
    });
  }

  // ── Extensions category: enabled count + local filter ─────────────────────
  function refreshExtSummary() {
    var container = $("extToggles");
    var summary = $("extEnabledSummary");
    if (!container || !summary) return;
    var rows = qsa(".toggle-track[data-ext-name]", container);
    if (!rows.length) return; // keep default hint until extensions load
    var total = rows.length;
    var on = rows.filter(function (r2) { return r2.classList.contains("on"); }).length;
    summary.textContent = t("settings.extensions.count", "{on} of {total} extensions enabled", { on: on, total: total });
  }

  function initExtensions() {
    var container = $("extToggles");
    if (!container || container._settingsBound) return;
    container._settingsBound = true;
    var filter = $("extSearchInput");
    if (filter) {
      filter.addEventListener("input", function () {
        var q = filter.value.trim().toLowerCase();
        qsa(".setting-row", container).forEach(function (row) {
          var label = row.querySelector(".setting-label");
          var name = (label ? label.textContent : row.textContent).toLowerCase();
          row.classList.toggle("settings-hidden-by-search", q && name.indexOf(q) === -1);
        });
      });
    }
    // Recompute on toggle clicks and on re-render.
    container.addEventListener("click", function () { setTimeout(refreshExtSummary, 0); });
    try {
      new MutationObserver(function () { refreshExtSummary(); }).observe(container, { childList: true });
    } catch (e) {}
    refreshExtSummary();
  }

  // ── Keyboard Shortcuts category: collapsible groups + counts + filter ─────
  // shortcuts.js renders a flat list: a `.shortcut-settings-category` header
  // followed by its `.shortcut-settings-row`s. We enhance non-destructively by
  // toggling classes on siblings (no reparenting → safe across re-renders).
  function enhanceShortcuts() {
    var container = $("shortcutSettingsRows");
    if (!container) return;
    var headers = qsa(".shortcut-settings-category", container);
    headers.forEach(function (header) {
      var rows = [];
      var node = header.nextElementSibling;
      while (node && !node.classList.contains("shortcut-settings-category")) {
        if (node.classList.contains("shortcut-settings-row")) rows.push(node);
        node = node.nextElementSibling;
      }
      header._rows = rows;
      if (!header._countEl) {
        var count = document.createElement("span");
        count.className = "shortcut-group-count";
        header.appendChild(count);
        header._countEl = count;
      }
      header._countEl.textContent = " (" + rows.length + ")";
      if (!header._collapseBound) {
        header._collapseBound = true;
        header.classList.add("shortcut-group-header");
        header.setAttribute("role", "button");
        header.setAttribute("tabindex", "0");
        var toggle = function () {
          var collapsed = header.classList.toggle("collapsed");
          header.setAttribute("aria-expanded", collapsed ? "false" : "true");
          (header._rows || []).forEach(function (r2) { r2.classList.toggle("shortcut-row-collapsed", collapsed); });
        };
        header.addEventListener("click", toggle);
        header.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") { e.preventDefault(); toggle(); }
        });
      }
      // Groups start collapsed by default (don't dominate the page).
      if (!header._defaultCollapsed) {
        header._defaultCollapsed = true;
        header.classList.add("collapsed");
        header.setAttribute("aria-expanded", "false");
        rows.forEach(function (r2) { r2.classList.add("shortcut-row-collapsed"); });
      }
    });
    updateShortcutSummary();
    applyShortcutFilter();
  }

  function updateShortcutSummary() {
    var summary = $("shortcutSummary");
    var container = $("shortcutSettingsRows");
    if (!summary || !container) return;
    var total = qsa(".shortcut-settings-row", container).length;
    if (!total) return;
    var custom = qsa(".shortcut-settings-row", container).filter(function (row) {
      return row.querySelector(".shortcut-chip") && !row.querySelector(".shortcut-chip-unbound");
    }).length;
    summary.textContent = t("settings.shortcuts.summary", "{total} actions", { total: total, custom: custom });
  }

  function applyShortcutFilter() {
    var input = $("shortcutSearchInput");
    var container = $("shortcutSettingsRows");
    if (!input || !container) return;
    var q = input.value.trim().toLowerCase();
    qsa(".shortcut-settings-category", container).forEach(function (header) {
      var anyVisible = false;
      (header._rows || []).forEach(function (row) {
        var label = row.querySelector(".shortcut-settings-label");
        var text = (label ? label.textContent : row.textContent).toLowerCase();
        var hit = !q || text.indexOf(q) !== -1;
        // When filtering, reveal matches regardless of collapse; else respect collapse.
        if (q) {
          row.classList.toggle("shortcut-hidden-by-search", !hit);
          row.classList.remove("shortcut-row-collapsed");
        } else {
          row.classList.remove("shortcut-hidden-by-search");
          if (header.classList.contains("collapsed")) row.classList.add("shortcut-row-collapsed");
        }
        if (hit) anyVisible = true;
      });
      header.classList.toggle("shortcut-hidden-by-search", q && !anyVisible);
    });
  }

  function initShortcuts() {
    var container = $("shortcutSettingsRows");
    if (!container || container._settingsBound) return;
    container._settingsBound = true;
    var input = $("shortcutSearchInput");
    if (input) input.addEventListener("input", applyShortcutFilter);
    try {
      new MutationObserver(function () { enhanceShortcuts(); }).observe(container, { childList: true });
    } catch (e) {}
    if (container.children.length) enhanceShortcuts();
  }

  // ── Session-categories accordion: keyboard + SR access ────────────────────
  // app.js owns the click/display toggle (#sessionAccordionHeader ->
  // #sessionAccordionBody). We only add the missing semantics/keyboard: role,
  // tabindex, aria-controls, Enter/Space -> click, and mirror aria-expanded from
  // the body's display. No second click handler (would double-toggle).
  function initSessionAccordion() {
    var head = $("sessionAccordionHeader");
    var body = $("sessionAccordionBody");
    if (!head || !body || head._settingsBound) return;
    head._settingsBound = true;
    head.setAttribute("role", "button");
    head.setAttribute("tabindex", "0");
    head.setAttribute("aria-controls", "sessionAccordionBody");
    head.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") { e.preventDefault(); head.click(); }
    });
    var sync = function () { head.setAttribute("aria-expanded", body.style.display !== "none" ? "true" : "false"); };
    sync();
    try { new MutationObserver(sync).observe(body, { attributes: true, attributeFilter: ["style"] }); } catch (e) {}
  }

  // ── About: version ────────────────────────────────────────────────────────
  function initAbout() {
    var el = $("aboutStudioVersion");
    if (el && window.__STUDIO_V) el.textContent = "v" + window.__STUDIO_V;
  }

  // ── activation / restore ──────────────────────────────────────────────────
  function restoreCategory() {
    var slug = categoryFromHash() || validCategory(lsGet(LS_CATEGORY)) || DEFAULT_CATEGORY;
    selectCategory(slug, { persist: false, updateHash: true });
  }

  var _wired = false;
  function wire() {
    if (_wired || !root()) return;
    _wired = true;

    // Sidebar buttons.
    qsa(".settings-nav-button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        selectCategory(btn.getAttribute("data-settings-nav"), { scrollTop: true });
      });
    });
    // Mobile select.
    var sel = $("settingsNavSelect");
    if (sel) sel.addEventListener("change", function () { selectCategory(sel.value, { scrollTop: true }); });

    // Search.
    var input = $("settingsSearchInput");
    if (input) {
      var timer = null;
      input.addEventListener("input", function () {
        var clearBtn = $("settingsSearchClear");
        if (clearBtn) clearBtn.hidden = !input.value;
        clearTimeout(timer);
        timer = setTimeout(function () { runSearch(input.value); }, 100);
      });
      input.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { clearSearch(false); input.blur(); }
      });
    }
    var clearBtn = $("settingsSearchClear");
    if (clearBtn) clearBtn.addEventListener("click", function () {
      clearSearch(false);
      if (input) input.focus();
    });

    initCollapsibles();
    initDependencies();
    initSummarySources();
    initExtensions();
    initShortcuts();
    initSessionAccordion();
    initAbout();

    // Deep-link API override (this file loads after app.js, so we win).
    window.openStudioSettings = openStudioSettings;

    // Rebuild search index and re-localize summaries on locale change.
    window.addEventListener("i18n:change", function () {
      _searchIndex = null;
      refreshExtSummary();
      updateShortcutSummary();
    });

    // React to hash navigation (e.g. shared URL / back button).
    window.addEventListener("hashchange", function () {
      var slug = categoryFromHash();
      if (!slug) return;
      var isActive = window.StudioModules ? window.StudioModules.activeAppId === "settings" : false;
      if (!isActive && window.StudioModules && window.StudioModules.activateApp) {
        window.StudioModules.activateApp("settings");
      }
      selectCategory(slug, { updateHash: false });
    });

    restoreCategory();

    // Shareable deep-link: if the page loaded on #settings/<cat>, open Settings
    // there once the module system has finished its own boot activation.
    if (categoryFromHash()) {
      requestAnimationFrame(function () {
        if (!isSettingsActive() && window.StudioModules && window.StudioModules.activateApp) {
          window.StudioModules.activateApp("settings");
        }
      });
    }
  }

  // Restore category each time the Settings page is shown (idempotent).
  window.addEventListener("studio:app-activated", function (e) {
    if (!e.detail || e.detail.id !== "settings") return;
    wire();
    if (!_searchActive) restoreCategory();
    // Re-enhance injected content that may have been re-rendered.
    refreshExtSummary();
    setTimeout(function () { enhanceShortcuts(); }, 0);
  });

  function boot() { wire(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  // Public surface.
  window.SettingsPage = {
    open: openStudioSettings,
    revealSection: revealSection,
    selectCategory: function (slug) { selectCategory(slug, { scrollTop: true }); },
    search: runSearch,
    clearSearch: function () { clearSearch(false); }
  };
})();
