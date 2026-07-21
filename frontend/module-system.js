/**
 * Forge Studio — Module System
 * by ToxicHost & Moritz
 *
 * Plug-and-play module architecture. Core canvas + generation is always present.
 * Modules (Workshop, Corkboard, etc.) register at runtime and get:
 *   - A tab button in the title bar
 *   - A container div for their UI (viewport takeover)
 *   - Access to shared services (generation API, canvas, toasts, status)
 *
 * Modules register via:
 *   StudioModules.register("workshop", {
 *     label: "Workshop",
 *     icon: "🔧",
 *     init(container, services) { ... },   // called once on first activation
 *     activate(container, services) { ... }, // called every time tab is shown
 *     deactivate() { ... },                 // called when switching away
 *   });
 *
 * Loaded after app.js in the script chain.
 */
(function () {
"use strict";

// ========================================================================
// REGISTRY
// ========================================================================

const _modules = {};    // id → { config, container, initialized }
let _activeId = null;   // currently active module id (null = a built-in app page)
let _activeAppId = "studio"; // active top-level surface: a module id OR a built-in app id ("studio", "settings")
const _initCallbacks = {};  // id → [fn, fn, ...]

// ========================================================================
// SHARED SERVICES — passed to every module
// ========================================================================
// Lazily assembled so modules registering before full boot still work.

function _getServices() {
    return {
        // Generation API (from app.js)
        api: window.API || null,

        // Canvas engine
        core: window.StudioCore || null,
        ui: window.StudioUI || null,

        // Toast notifications
        toast: window.showToast || function () {},

        // Status bar
        statusBar: window.StatusBar || null,

        // App state
        state: window.State || null,

        // Get composite canvas as data URL (convenience)
        getCanvasDataURL(format = "image/png") {
            const core = window.StudioCore;
            if (!core) return null;
            const S = core.state;
            const tmp = document.createElement("canvas");
            tmp.width = S.W; tmp.height = S.H;
            const ctx = tmp.getContext("2d", { colorSpace: "srgb" });
            // Draw composited result
            for (const L of S.layers) {
                if (!L.visible || L.type === "adjustment") continue;
                ctx.globalAlpha = L.opacity;
                ctx.globalCompositeOperation = L.blendMode || "source-over";
                ctx.drawImage(L.canvas, 0, 0);
            }
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "source-over";
            return tmp.toDataURL(format);
        },

        // Get composite as base64 (no data URL prefix)
        getCanvasB64(format = "image/png") {
            const url = this.getCanvasDataURL(format);
            return url ? url.split(",")[1] : "";
        },
    };
}

// ========================================================================
// TAB BAR INTEGRATION
// ========================================================================

function _getTabBar() {
    return document.getElementById("appTabs");
}

function _createTabButton(id, config) {
    const btn = document.createElement("button");
    btn.dataset.module = id;
    // Tab labels translate via tabs.<id>; the markup English is the fallback.
    const tr = (window.I18N && window.I18N.t) ? window.I18N.t : null;
    const label = tr ? tr("tabs." + id, config.label) : config.label;
    const icon = config.icon || "";
    // An icon string starting with "<" is inline SVG/HTML markup (the
    // emoji-free path); anything else is treated as a text/emoji glyph.
    const isMarkup = typeof icon === "string" && icon.trim().startsWith("<");
    btn.title = label;

    if (isMarkup) {
        // Keep the SVG in a dedicated span and the translatable label in its
        // own span. data-i18n lives on the label span (not the button) so
        // applyToDom() retranslates the text without wiping out the icon.
        const iconSpan = document.createElement("span");
        iconSpan.className = "tab-icon";
        iconSpan.innerHTML = icon;
        const labelSpan = document.createElement("span");
        labelSpan.className = "tab-label";
        labelSpan.dataset.i18n = "tabs." + id;
        labelSpan.textContent = label;
        btn.dataset.i18nTitle = "tabs." + id;
        btn.appendChild(iconSpan);
        btn.appendChild(document.createTextNode(" "));
        btn.appendChild(labelSpan);
        return btn;
    }

    // Text/emoji icon: applyToDom would clobber the icon-prefixed
    // textContent on locale switch, so re-render on i18n:change instead.
    btn.dataset.i18n = "tabs." + id;
    btn.dataset.i18nTitle = "tabs." + id;
    btn.textContent = icon ? icon + " " + label : label;
    if (icon) {
        const renderIcon = () => {
            const newLabel = (window.I18N && window.I18N.t)
                ? window.I18N.t("tabs." + id, config.label)
                : config.label;
            btn.textContent = icon + " " + newLabel;
            btn.title = newLabel;
        };
        window.addEventListener("i18n:change", renderIcon);
    }
    return btn;
}

function _createContainer(id) {
    const div = document.createElement("div");
    div.className = "app-page module-page";
    div.id = "app-module-" + id;
    // Insert into .main alongside the other app-pages
    const main = document.querySelector(".main");
    if (main) main.appendChild(div);
    return div;
}

// Remove placeholder pages that now have a real module
function _removeBuiltinPlaceholder(id) {
    // Map module ids to the hardcoded placeholder ids in index.html
    const builtinMap = {
        "workshop":  "app-workshop",
        "corkboard": "app-corkboard",
    };
    const placeholderId = builtinMap[id];
    if (!placeholderId) return;
    const el = document.getElementById(placeholderId);
    if (el) el.remove();

    // Also remove the hardcoded tab button
    const tabBar = _getTabBar();
    if (tabBar) {
        tabBar.querySelectorAll("button[data-app]").forEach(btn => {
            if (btn.dataset.app === id) btn.remove();
        });
    }
}

// ========================================================================
// TAB SWITCHING — unified handler for both built-in and module tabs
// ========================================================================

// Deactivate whatever module is currently active (hide its page + run its
// deactivate() once), then clear _activeId. Shared by every transition so a
// module's teardown always runs exactly once when navigating away — including
// to a built-in app page like Settings.
function _deactivateCurrentModule() {
    if (!_activeId || !_modules[_activeId]) return;

    const mod = _modules[_activeId];
    mod.container.classList.remove("active");

    if (mod.config.deactivate) {
        try { mod.config.deactivate(); }
        catch (e) { console.error(`[Modules] ${_activeId}.deactivate error:`, e); }
    }

    _activeId = null;
}

// Activate a built-in (non-module) app page by id — "studio", "settings".
function _activateBuiltin(id) {
    _deactivateCurrentModule();

    document.querySelectorAll(".app-page").forEach(page => {
        page.classList.remove("active");
    });

    const page = document.getElementById("app-" + id);
    if (!page) {
        console.warn(`[Modules] Cannot activate unknown built-in app "${id}"`);
        return false;
    }

    page.classList.add("active");
    _activeAppId = id;

    window.dispatchEvent(new CustomEvent("studio:app-activated", {
        detail: { id },
    }));

    return true;
}

function _activateStudio() {
    _deactivateCurrentModule();
    _activeAppId = "studio";

    // Show Studio page
    const studioPage = document.getElementById("app-studio");
    if (studioPage) studioPage.classList.add("active");
}

function _activateModule(id) {
    const mod = _modules[id];
    if (!mod) return;

    // Hide Studio page
    const studioPage = document.getElementById("app-studio");
    if (studioPage) studioPage.classList.remove("active");

    // Deactivate previous module (only when switching to a different one, so
    // re-activating the same module doesn't tear it down)
    if (_activeId !== id) _deactivateCurrentModule();

    // Hide any other built-in app pages (studio, settings, or leftover
    // workshop/corkboard placeholders)
    document.querySelectorAll(".app-page:not(.module-page)").forEach(p => {
        if (p.id !== "app-studio") p.classList.remove("active");
    });

    _activeId = id;
    _activeAppId = id;
    mod.container.classList.add("active");

    const services = _getServices();

    // Initialize on first activation
    if (!mod.initialized && mod.config.init) {
        try {
            mod.config.init(mod.container, services);
            mod.initialized = true;
            console.log(`[Modules] ${id} initialized`);
            // Fire registered init callbacks
            if (_initCallbacks[id]) {
                _initCallbacks[id].forEach(fn => {
                    try { fn(mod.container, services); }
                    catch (e) { console.error(`[Modules] ${id} onInit callback error:`, e); }
                });
            }
        } catch (e) {
            console.error(`[Modules] ${id}.init error:`, e);
        }
    }

    // Activate
    if (mod.config.activate) {
        try { mod.config.activate(mod.container, services); }
        catch (e) { console.error(`[Modules] ${id}.activate error:`, e); }
    }
}

function _onTabClick(e) {
    const btn = e.target.closest("button");
    if (!btn) return;

    const tabBar = _getTabBar();
    if (!tabBar) return;

    // Deselect all tabs
    tabBar.querySelectorAll("button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    // Hide all pages
    document.querySelectorAll(".app-page").forEach(p => p.classList.remove("active"));

    if (btn.dataset.module) {
        // Module tab
        _activateModule(btn.dataset.module);
    } else if (btn.dataset.app === "studio") {
        // Studio tab
        _activateStudio();
    } else if (btn.dataset.app) {
        // Built-in app page (Settings, or a workshop/corkboard placeholder
        // not yet replaced by a module). Routes through _activateBuiltin so
        // the current module's deactivate() runs.
        _activateBuiltin(btn.dataset.app);
    }
}

function _hookTabBar() {
    const tabBar = _getTabBar();
    if (!tabBar) return;

    // Replace the existing click handler from app.js with ours
    // We use a capturing listener that stops propagation, so app.js's
    // delegated handler on #appTabs doesn't fire.
    tabBar.addEventListener("click", (e) => {
        e.stopImmediatePropagation();
        _onTabClick(e);
    }, true);
}

// ========================================================================
// PUBLIC API
// ========================================================================

const StudioModules = {
    /**
     * Register a module.
     * @param {string} id - Unique module identifier (e.g. "workshop", "gallery")
     * @param {object} config - Module configuration:
     *   @param {string} config.label - Display name for the tab
     *   @param {string} [config.icon] - Emoji or short icon text
     *   @param {function} [config.init] - Called once: init(container, services)
     *   @param {function} [config.activate] - Called each time tab shown: activate(container, services)
     *   @param {function} [config.deactivate] - Called when switching away
     */
    register(id, config) {
        if (_modules[id]) {
            console.warn(`[Modules] "${id}" already registered — skipping`);
            return;
        }

        // Remove the hardcoded placeholder if this module replaces one
        _removeBuiltinPlaceholder(id);

        // Create the tab button and page container
        const tabBar = _getTabBar();
        const btn = _createTabButton(id, config);
        if (tabBar) { tabBar.appendChild(btn); _reorderTabs(); }

        const container = _createContainer(id);

        _modules[id] = {
            config,
            container,
            initialized: false,
        };

        console.log(`[Modules] Registered "${id}" (${config.label})`);
    },

    /**
     * Programmatically activate a module by id.
     */
    activate(id) {
        if (!_modules[id]) {
            console.warn(`[Modules] Cannot activate unknown module "${id}"`);
            return;
        }
        // Update tab bar visual state
        const tabBar = _getTabBar();
        if (tabBar) {
            tabBar.querySelectorAll("button").forEach(b => b.classList.remove("active"));
            const btn = tabBar.querySelector(`button[data-module="${id}"]`);
            if (btn) btn.classList.add("active");
        }
        // Hide all pages
        document.querySelectorAll(".app-page").forEach(p => p.classList.remove("active"));
        _activateModule(id);
    },

    /**
     * Switch back to Studio.
     */
    activateStudio() {
        const tabBar = _getTabBar();
        if (tabBar) {
            tabBar.querySelectorAll("button").forEach(b => b.classList.remove("active"));
            const studioBtn = tabBar.querySelector('button[data-app="studio"]');
            if (studioBtn) studioBtn.classList.add("active");
        }
        document.querySelectorAll(".app-page").forEach(p => p.classList.remove("active"));
        _activateStudio();
        const studioPage = document.getElementById("app-studio");
        if (studioPage) studioPage.classList.add("active");
    },

    /**
     * Check if a module is registered.
     */
    has(id) { return id in _modules; },

    /**
     * Get list of registered module ids.
     */
    list() { return Object.keys(_modules); },

    /**
     * Get the active module id (null if a built-in app page is active).
     */
    get activeId() { return _activeId; },

    /**
     * Get the active top-level surface id — a module id, or a built-in app
     * id ("studio", "settings"). Unlike activeId, never null.
     */
    get activeAppId() { return _activeAppId; },

    /**
     * Activate a built-in (non-module) app page by id — e.g. "settings",
     * "studio". Syncs the main tab visual state and runs the active module's
     * deactivate(). Returns false for an unknown built-in app.
     */
    activateApp(id) {
        const tabBar = _getTabBar();
        const button = tabBar?.querySelector(`button[data-app="${id}"]`);
        const page = document.getElementById("app-" + id);

        if (!button || !page) {
            console.warn(`[Modules] Cannot activate unknown built-in app "${id}"`);
            return false;
        }

        tabBar.querySelectorAll("button").forEach(btn => {
            btn.classList.toggle("active", btn === button);
        });

        return _activateBuiltin(id);
    },

    /**
     * Get shared services object.
     */
    get services() { return _getServices(); },

    /**
     * Register a callback for when a module is first initialized.
     * If the module is already initialized, fires immediately.
     * @param {string} id - Module id
     * @param {function} fn - Callback: fn(container, services)
     */
    onInit(id, fn) {
        if (_modules[id] && _modules[id].initialized) {
            try { fn(_modules[id].container, _getServices()); }
            catch (e) { console.error(`[Modules] ${id} onInit callback error:`, e); }
            return;
        }
        if (!_initCallbacks[id]) _initCallbacks[id] = [];
        _initCallbacks[id].push(fn);
    },
};

// ========================================================================
// BOOT
// ========================================================================

// Canonical tab order — applied inside register() after each new tab is added
const TAB_ORDER = ["studio", "develop", "gallery", "workshop", "lexicon", "codex", "settings"];

function _reorderTabs() {
    const bar = _getTabBar();
    if (!bar) return;
    const buttons = [...bar.querySelectorAll("button")];
    const sorted = [];
    for (const id of TAB_ORDER) {
        const btn = buttons.find(b => b.dataset.app === id || b.dataset.module === id);
        if (btn) sorted.push(btn);
    }
    for (const btn of buttons) { if (!sorted.includes(btn)) sorted.push(btn); }
    sorted.forEach(btn => bar.appendChild(btn));
}

_hookTabBar();
window.StudioModules = StudioModules;
console.log("[Modules] Module system loaded");

})();
