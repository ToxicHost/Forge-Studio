/**
 * Forge Studio — Module System
 * by ToxicHost & Moritz
 *
 * Plug-and-play module architecture. Core canvas + generation is always present.
 * Modules (Comic Lab, Workshop, Corkboard, etc.) register at runtime and get:
 *   - A tab button in the title bar
 *   - A container div for their UI (viewport takeover)
 *   - Access to shared services (generation API, canvas, toasts, status)
 *
 * Modules register via:
 *   StudioModules.register("comic", {
 *     label: "Comic Lab",
 *     icon: "📖",
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
let _activeId = null;   // currently active module id (null = Studio)
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
            const ctx = tmp.getContext("2d");
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
    btn.textContent = config.icon ? config.icon + " " + config.label : config.label;
    btn.title = config.label;
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
        "comic":     "app-comic",
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

function _activateStudio() {
    // Deactivate current module
    if (_activeId && _modules[_activeId]) {
        const mod = _modules[_activeId];
        mod.container.classList.remove("active");
        if (mod.config.deactivate) {
            try { mod.config.deactivate(); }
            catch (e) { console.error(`[Modules] ${_activeId}.deactivate error:`, e); }
        }
    }
    _activeId = null;

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

    // Deactivate previous module (if different)
    if (_activeId && _activeId !== id && _modules[_activeId]) {
        const prev = _modules[_activeId];
        prev.container.classList.remove("active");
        if (prev.config.deactivate) {
            try { prev.config.deactivate(); }
            catch (e) { console.error(`[Modules] ${_activeId}.deactivate error:`, e); }
        }
    }

    // Hide any other built-in placeholder pages (workshop, corkboard that
    // might still exist if no module replaced them)
    document.querySelectorAll(".app-page:not(.module-page)").forEach(p => {
        if (p.id !== "app-studio") p.classList.remove("active");
    });

    _activeId = id;
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
        // Built-in placeholder tab (workshop, corkboard etc. that hasn't been
        // replaced by a module yet)
        _activeId = null;
        const page = document.getElementById("app-" + btn.dataset.app);
        if (page) page.classList.add("active");
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
     * @param {string} id - Unique module identifier (e.g. "comic", "workshop")
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
     * Get the active module id (null if Studio is active).
     */
    get activeId() { return _activeId; },

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
const TAB_ORDER = ["studio", "gallery", "workshop", "comic", "lexicon", "codex"];

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
