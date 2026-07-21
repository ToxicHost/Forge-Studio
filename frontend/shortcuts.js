// Forge Studio — universal remappable keyboard shortcut registry.
//
// Exposes window.Shortcuts. Loaded after prefs.js and before canvas-ui.js
// and app.js (see index.html script order).
//
// Two binding types:
//  - "key":  matches event.key (lowercased) — follows the active keyboard
//            layout ("bind by character").
//  - "code": matches event.code exactly — follows the physical key position
//            ("bind by physical position").
//
// Modifiers are tri-state in registry defaults: true = required,
// false = must be absent, null = ignored. Captured user bindings are always
// exact (true/false only). Tri-state exists so legacy letter-tool defaults
// keep tolerating Shift while e.g. the German '#' brush default can reject
// US Shift+3 (which produces '#').
//
// Dispatch: one capture-phase keydown listener dispatches only actions that
// have a registered handler (app scope). Canvas tool actions are
// lookup-only: canvas-ui.js resolves them via Shortcuts.match() inside its
// own keydown handler so stateful canvas logic keeps its current home.
//
// Persistence: Prefs key "shortcuts" stores overrides only —
// { actionId: [bindings...] }. Empty array = intentionally unbound.
// Missing id = registry defaults. Never persist the full defaults table.

(function () {
    "use strict";

    // ── i18n helper (English fallback always available) ─────────────────
    function _t(key, fallback) {
        try {
            if (window.I18N && typeof window.I18N.t === "function") {
                return window.I18N.t(key, fallback);
            }
        } catch (e) { /* fall back */ }
        return fallback;
    }

    // ── Registry state ──────────────────────────────────────────────────
    var _actions = Object.create(null);   // actionId -> definition
    var _order = [];                      // registration order for stable match/render
    var _handlers = Object.create(null);  // actionId -> handler fn
    var _overrides = Object.create(null); // actionId -> [bindings] (exact)

    function _normKeyValue(value) {
        var v = String(value);
        if (v === " " || v.toLowerCase() === "spacebar") return "space";
        return v.toLowerCase();
    }

    function _mkBinding(spec) {
        return {
            type: spec.type === "code" ? "code" : "key",
            value: spec.type === "code" ? String(spec.value) : _normKeyValue(spec.value),
            ctrl: spec.ctrl === undefined ? false : spec.ctrl,
            shift: spec.shift === undefined ? false : spec.shift,
            alt: spec.alt === undefined ? false : spec.alt,
            meta: spec.meta === undefined ? false : spec.meta,
        };
    }

    function _sanitizeBindingList(list) {
        if (!Array.isArray(list)) return null;
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var b = list[i];
            if (!b || typeof b !== "object") continue;
            if (b.type !== "key" && b.type !== "code") continue;
            if (typeof b.value !== "string" || !b.value) continue;
            out.push({
                type: b.type,
                value: b.type === "key" ? _normKeyValue(b.value) : b.value,
                ctrl: !!b.ctrl,
                shift: !!b.shift,
                alt: !!b.alt,
                meta: !!b.meta,
            });
        }
        return out;
    }

    function _modMatches(required, actual) {
        if (required === null || required === undefined) return true;
        return !!required === !!actual;
    }

    function _bindingMatchesEvent(binding, ev) {
        if (!_modMatches(binding.ctrl, ev.ctrlKey)) return false;
        if (!_modMatches(binding.shift, ev.shiftKey)) return false;
        if (!_modMatches(binding.alt, ev.altKey)) return false;
        if (!_modMatches(binding.meta, ev.metaKey)) return false;
        if (binding.type === "code") return binding.value === ev.code;
        return binding.value === _normKeyValue(ev.key || "");
    }

    // ── Typing context ──────────────────────────────────────────────────
    function isTypingContext(target) {
        if (!target || target.nodeType !== 1) return false;
        var tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
        if (target.isContentEditable) return true;
        return false;
    }

    function _bindingHasModifier(binding) {
        return binding.ctrl === true || binding.shift === true ||
               binding.alt === true || binding.meta === true;
    }

    // ── Reserved bindings (conflict detection only; never dispatched) ───
    // Stateful handlers for these stay where they currently live
    // (canvas-ui.js / app.js). Escape additionally cancels capture mode and
    // can never be assigned.
    function _snapMods(snap) {
        return { ctrl: !!snap.ctrl, shift: !!snap.shift, alt: !!snap.alt, meta: !!snap.meta };
    }

    var _RESERVED = [
        { label: "Space (canvas pan)", test: function (s) { return s.key === "space" && !s.ctrl && !s.alt && !s.meta; } },
        { label: "Ctrl+Z (undo)", test: function (s) { return s.key === "z" && s.ctrl && !s.shift && !s.alt && !s.meta; } },
        { label: "Ctrl+Shift+Z (redo)", test: function (s) { return s.key === "z" && s.ctrl && s.shift && !s.alt && !s.meta; } },
        { label: "Ctrl+Y (redo)", test: function (s) { return s.key === "y" && s.ctrl && !s.shift && !s.alt && !s.meta; } },
        { label: "Escape", test: function (s) { return s.key === "escape"; } },
        { label: "Enter (transform commit)", test: function (s) { return s.key === "enter" && !s.ctrl && !s.shift && !s.alt && !s.meta; } },
    ];

    // Browser/window navigation combos Studio does not own. Ctrl+S stays
    // available because Studio already intercepts it.
    var _BROWSER_PROTECTED = [
        { label: "Ctrl/Meta+W", test: function (s) { return s.key === "w" && (s.ctrl || s.meta) && !s.alt; } },
        { label: "Ctrl/Meta+T", test: function (s) { return s.key === "t" && (s.ctrl || s.meta) && !s.alt; } },
        { label: "Ctrl/Meta+N", test: function (s) { return s.key === "n" && (s.ctrl || s.meta) && !s.alt; } },
        { label: "Ctrl/Meta+R", test: function (s) { return s.key === "r" && (s.ctrl || s.meta) && !s.alt; } },
        { label: "Ctrl/Meta+L", test: function (s) { return s.key === "l" && (s.ctrl || s.meta) && !s.alt; } },
        { label: "Ctrl/Meta+Q", test: function (s) { return s.key === "q" && (s.ctrl || s.meta) && !s.alt; } },
        { label: "Ctrl/Meta+Tab", test: function (s) { return s.key === "tab" && (s.ctrl || s.meta); } },
        { label: "Alt+Left", test: function (s) { return s.key === "arrowleft" && s.alt && !s.ctrl && !s.meta; } },
        { label: "Alt+Right", test: function (s) { return s.key === "arrowright" && s.alt && !s.ctrl && !s.meta; } },
        { label: "F5", test: function (s) { return s.key === "f5"; } },
    ];

    function _findReserved(snap) {
        for (var i = 0; i < _RESERVED.length; i++) {
            if (_RESERVED[i].test(snap)) return { kind: "reserved", label: _RESERVED[i].label };
        }
        for (var j = 0; j < _BROWSER_PROTECTED.length; j++) {
            if (_BROWSER_PROTECTED[j].test(snap)) return { kind: "browser", label: _BROWSER_PROTECTED[j].label };
        }
        return null;
    }

    // ── Public registry API ─────────────────────────────────────────────
    function register(actionId, definition) {
        var def = definition || {};
        var existed = !!_actions[actionId];
        _actions[actionId] = {
            id: actionId,
            label: def.label || actionId,
            i18nKey: def.i18nKey || null,
            category: def.category || "Other",
            categoryI18nKey: def.categoryI18nKey || null,
            defaultBindings: (def.defaultBindings || []).map(_mkBinding),
            scope: def.scope === "canvas" ? "canvas" : "app",
            allowInTyping: !!def.allowInTyping,
            allowRepeat: !!def.allowRepeat,
            reserved: !!def.reserved,
            when: typeof def.when === "function" ? def.when : null,
            preventDefault: !!def.preventDefault,
        };
        if (typeof def.handler === "function") _handlers[actionId] = def.handler;
        if (!existed) _order.push(actionId);
    }

    function unregister(actionId) {
        delete _actions[actionId];
        delete _handlers[actionId];
        var idx = _order.indexOf(actionId);
        if (idx !== -1) _order.splice(idx, 1);
    }

    function getAction(actionId) {
        return _actions[actionId] || null;
    }

    function getBindings(actionId) {
        var def = _actions[actionId];
        if (!def) return [];
        if (Object.prototype.hasOwnProperty.call(_overrides, actionId)) {
            return _overrides[actionId].slice();
        }
        return def.defaultBindings.slice();
    }

    function _actionMatchesEvent(actionId, ev) {
        var bindings = getBindings(actionId);
        for (var i = 0; i < bindings.length; i++) {
            if (_bindingMatchesEvent(bindings[i], ev)) return bindings[i];
        }
        return null;
    }

    // match(event, { scope }) -> { actionId, action, binding } | null
    function match(ev, options) {
        var scope = options && options.scope;
        for (var i = 0; i < _order.length; i++) {
            var id = _order[i];
            var def = _actions[id];
            if (!def) continue;
            if (scope && def.scope !== scope) continue;
            if (def.when && !def.when()) continue;
            var binding = _actionMatchesEvent(id, ev);
            if (binding) return { actionId: id, action: def, binding: binding };
        }
        return null;
    }

    function registerHandler(actionId, handler) {
        if (typeof handler === "function") _handlers[actionId] = handler;
    }

    // ── Persistence ─────────────────────────────────────────────────────
    function reloadFromPrefs() {
        _overrides = Object.create(null);
        var stored = window.Prefs ? window.Prefs.get("shortcuts", {}) : {};
        if (stored && typeof stored === "object" && !Array.isArray(stored)) {
            Object.keys(stored).forEach(function (actionId) {
                var list = _sanitizeBindingList(stored[actionId]);
                if (list !== null) _overrides[actionId] = list;
            });
        }
    }

    function _persistOverrides() {
        var plain = {};
        Object.keys(_overrides).forEach(function (id) { plain[id] = _overrides[id]; });
        if (window.Prefs) window.Prefs.set("shortcuts", plain);
    }

    function setBindings(actionId, bindings) {
        var list = _sanitizeBindingList(bindings) || [];
        var def = _actions[actionId];
        if (def && _bindingListsEquivalent(list, def.defaultBindings)) {
            delete _overrides[actionId];
        } else {
            _overrides[actionId] = list;
        }
        _persistOverrides();
    }

    function _bindingListsEquivalent(a, b) {
        if (a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) {
            var x = a[i], y = b[i];
            if (x.type !== y.type || x.value !== y.value) return false;
            // Tri-state defaults never equal exact captures unless identical.
            if (x.ctrl !== y.ctrl || x.shift !== y.shift ||
                x.alt !== y.alt || x.meta !== y.meta) return false;
        }
        return true;
    }

    function reset(actionId) {
        delete _overrides[actionId];
        _persistOverrides();
    }

    function resetAll() {
        _overrides = Object.create(null);
        _persistOverrides();
    }

    // ── Display formatting ──────────────────────────────────────────────
    var _KEY_DISPLAY = {
        "enter": "Enter", "space": "Space", "escape": "Escape", "tab": "Tab",
        "arrowleft": "←", "arrowright": "→",
        "arrowup": "↑", "arrowdown": "↓",
        "backspace": "Backspace", "delete": "Delete",
    };

    function formatBinding(binding) {
        if (!binding) return "";
        var parts = [];
        if (binding.ctrl === true) parts.push("Ctrl");
        if (binding.alt === true) parts.push("Alt");
        if (binding.shift === true) parts.push("Shift");
        if (binding.meta === true) parts.push("Meta");
        var keyLabel;
        if (binding.type === "code") {
            keyLabel = "⌨ " + binding.value; // physical-position binding
        } else {
            keyLabel = _KEY_DISPLAY[binding.value] ||
                (binding.value.length === 1 ? binding.value.toUpperCase() : binding.value);
        }
        parts.push(keyLabel);
        return parts.join("+");
    }

    // ── Capture-phase dispatcher (handler actions only) ─────────────────
    function _dispatchKeydown(ev) {
        // Escape is reserved (interrupt/cancel/close) — never dispatched.
        if (ev.key === "Escape") return;
        for (var i = 0; i < _order.length; i++) {
            var id = _order[i];
            var def = _actions[id];
            if (!def || def.reserved) continue;
            var handler = _handlers[id];
            if (!handler) continue; // lookup-only actions are not consumed here
            if (def.when && !def.when()) continue;
            var binding = _actionMatchesEvent(id, ev);
            if (!binding) continue;
            if (isTypingContext(ev.target)) {
                // Modifier-less actions never fire from typing contexts.
                if (!def.allowInTyping || !_bindingHasModifier(binding)) continue;
            }
            if (ev.repeat && !def.allowRepeat) {
                // Swallow repeats of a handled combo entirely — the first
                // press already fired, and letting repeats fall through
                // would e.g. type newlines into the prompt while
                // Shift+Enter is held, or stack layers while N is held.
                ev.preventDefault();
                ev.stopPropagation();
                return;
            }
            var handled = false;
            try {
                handled = handler(ev, { actionId: id, binding: binding }) !== false;
            } catch (err) {
                console.error("[Shortcuts] Handler error for " + id, err);
                handled = false;
            }
            if (handled || def.preventDefault) {
                ev.preventDefault();
                ev.stopPropagation();
            }
            return;
        }
    }

    // ── Default actions ─────────────────────────────────────────────────
    // Legacy letter tools use shift: null so Shift stays tolerated exactly
    // as the old hardcoded switch behaved. Ctrl/Alt/Meta remain prohibited.
    function _tool(value) {
        return { type: "key", value: value, ctrl: false, shift: null, alt: false, meta: false };
    }

    var _DEFAULT_ACTIONS = [
        // App scope --------------------------------------------------------
        {
            id: "app.generate", label: "Generate",
            i18nKey: "shortcuts.action.app_generate",
            category: "General", categoryI18nKey: "shortcuts.category.general",
            scope: "app", allowInTyping: true,
            defaultBindings: [
                { type: "key", value: "enter", ctrl: true, shift: false, alt: false, meta: false },
                { type: "key", value: "enter", ctrl: false, shift: true, alt: false, meta: false },
            ],
        },
        {
            id: "app.saveCanvas", label: "Save canvas",
            i18nKey: "shortcuts.action.app_saveCanvas",
            category: "General", categoryI18nKey: "shortcuts.category.general",
            scope: "app", allowInTyping: true,
            defaultBindings: [
                { type: "key", value: "s", ctrl: true, shift: false, alt: false, meta: false },
            ],
        },
        {
            id: "app.sendNewestToCanvas", label: "Send newest output to canvas",
            i18nKey: "shortcuts.action.app_sendNewestToCanvas",
            category: "General", categoryI18nKey: "shortcuts.category.general",
            scope: "app", allowInTyping: false,
            defaultBindings: [
                { type: "key", value: "n", ctrl: false, shift: false, alt: false, meta: false },
            ],
        },
        {
            id: "panel.search-focus", label: "Focus parameter search",
            i18nKey: "shortcuts.action.panel_searchFocus",
            category: "General", categoryI18nKey: "shortcuts.category.general",
            scope: "app", allowInTyping: false,
            defaultBindings: [
                // All modifiers tri-state null on purpose: '/' is Shift+7
                // on QWERTZ, so a shift:false binding would be unreachable
                // on German layouts (same lesson as the '#' brush default).
                { type: "key", value: "/", ctrl: null, shift: null, alt: null, meta: null },
            ],
        },

        // Prompt editing (handlers in app.js). Modifier bindings on purpose:
        // allowInTyping + a required modifier is what lets these fire inside
        // the prompt text fields, same as Ctrl+Enter generate. allowRepeat
        // so holding the combo keeps stepping the weight.
        {
            id: "prompt.weight-up", label: "Prompt weight: increase",
            i18nKey: "shortcuts.action.prompt_weight_up",
            category: "Prompt", categoryI18nKey: "shortcuts.category.prompt",
            scope: "app", allowInTyping: true, allowRepeat: true,
            defaultBindings: [
                { type: "key", value: "arrowup", ctrl: true, shift: false, alt: false, meta: false },
            ],
        },
        {
            id: "prompt.weight-down", label: "Prompt weight: decrease",
            i18nKey: "shortcuts.action.prompt_weight_down",
            category: "Prompt", categoryI18nKey: "shortcuts.category.prompt",
            scope: "app", allowInTyping: true, allowRepeat: true,
            defaultBindings: [
                { type: "key", value: "arrowdown", ctrl: true, shift: false, alt: false, meta: false },
            ],
        },
        {
            id: "prompt.weight-up-fine", label: "Prompt weight: increase (fine)",
            i18nKey: "shortcuts.action.prompt_weight_up_fine",
            category: "Prompt", categoryI18nKey: "shortcuts.category.prompt",
            scope: "app", allowInTyping: true, allowRepeat: true,
            defaultBindings: [
                { type: "key", value: "arrowup", ctrl: true, shift: true, alt: false, meta: false },
            ],
        },
        {
            id: "prompt.weight-down-fine", label: "Prompt weight: decrease (fine)",
            i18nKey: "shortcuts.action.prompt_weight_down_fine",
            category: "Prompt", categoryI18nKey: "shortcuts.category.prompt",
            scope: "app", allowInTyping: true, allowRepeat: true,
            defaultBindings: [
                { type: "key", value: "arrowdown", ctrl: true, shift: true, alt: false, meta: false },
            ],
        },

        // Canvas tools (lookup-only; dispatched by canvas-ui.js) ------------
        { id: "canvas.tool.brush", label: "Brush tool", i18nKey: "shortcuts.action.canvas_tool_brush", category: "Canvas tools", categoryI18nKey: "shortcuts.category.canvasTools", scope: "canvas", defaultBindings: [_tool("b")] },
        { id: "canvas.tool.eraser", label: "Eraser tool", i18nKey: "shortcuts.action.canvas_tool_eraser", category: "Canvas tools", categoryI18nKey: "shortcuts.category.canvasTools", scope: "canvas", defaultBindings: [_tool("e")] },
        { id: "canvas.tool.eyedropper", label: "Eyedropper tool", i18nKey: "shortcuts.action.canvas_tool_eyedropper", category: "Canvas tools", categoryI18nKey: "shortcuts.category.canvasTools", scope: "canvas", defaultBindings: [_tool("i")] },
        { id: "canvas.tool.fillGradient", label: "Fill / gradient tool", i18nKey: "shortcuts.action.canvas_tool_fillGradient", category: "Canvas tools", categoryI18nKey: "shortcuts.category.canvasTools", scope: "canvas", defaultBindings: [_tool("g")] },
        { id: "canvas.tool.smudge", label: "Smudge tool", i18nKey: "shortcuts.action.canvas_tool_smudge", category: "Canvas tools", categoryI18nKey: "shortcuts.category.canvasTools", scope: "canvas", defaultBindings: [_tool("s")] },
        { id: "canvas.tool.blur", label: "Blur tool", i18nKey: "shortcuts.action.canvas_tool_blur", category: "Canvas tools", categoryI18nKey: "shortcuts.category.canvasTools", scope: "canvas", defaultBindings: [_tool("r")] },
        { id: "canvas.tool.marquee", label: "Marquee selection", i18nKey: "shortcuts.action.canvas_tool_marquee", category: "Canvas tools", categoryI18nKey: "shortcuts.category.canvasTools", scope: "canvas", defaultBindings: [_tool("m")] },
        { id: "canvas.tool.lasso", label: "Cycle lasso tools", i18nKey: "shortcuts.action.canvas_tool_lasso", category: "Canvas tools", categoryI18nKey: "shortcuts.category.canvasTools", scope: "canvas", defaultBindings: [_tool("l")] },
        { id: "canvas.tool.ellipse", label: "Ellipse selection", i18nKey: "shortcuts.action.canvas_tool_ellipse", category: "Canvas tools", categoryI18nKey: "shortcuts.category.canvasTools", scope: "canvas", defaultBindings: [_tool("o")] },
        { id: "canvas.tool.wand", label: "Magic wand", i18nKey: "shortcuts.action.canvas_tool_wand", category: "Canvas tools", categoryI18nKey: "shortcuts.category.canvasTools", scope: "canvas", defaultBindings: [_tool("w")] },
        { id: "canvas.tool.transform", label: "Transform tool", i18nKey: "shortcuts.action.canvas_tool_transform", category: "Canvas tools", categoryI18nKey: "shortcuts.category.canvasTools", scope: "canvas", defaultBindings: [_tool("v")] },
        { id: "canvas.mask.toggle", label: "Toggle mask mode", i18nKey: "shortcuts.action.canvas_mask_toggle", category: "Canvas tools", categoryI18nKey: "shortcuts.category.canvasTools", scope: "canvas", defaultBindings: [_tool("q")] },
        { id: "canvas.tool.crop", label: "Crop tool", i18nKey: "shortcuts.action.canvas_tool_crop", category: "Canvas tools", categoryI18nKey: "shortcuts.category.canvasTools", scope: "canvas", defaultBindings: [_tool("c")] },
        { id: "canvas.tool.text", label: "Text tool", i18nKey: "shortcuts.action.canvas_tool_text", category: "Canvas tools", categoryI18nKey: "shortcuts.category.canvasTools", scope: "canvas", defaultBindings: [_tool("t")] },
        { id: "canvas.tool.shape", label: "Shape tool", i18nKey: "shortcuts.action.canvas_tool_shape", category: "Canvas tools", categoryI18nKey: "shortcuts.category.canvasTools", scope: "canvas", defaultBindings: [_tool("u")] },
        { id: "canvas.colors.reset", label: "Reset foreground/background colors", i18nKey: "shortcuts.action.canvas_colors_reset", category: "Canvas tools", categoryI18nKey: "shortcuts.category.canvasTools", scope: "canvas", defaultBindings: [_tool("d")] },
        { id: "canvas.tool.clone", label: "Clone tool", i18nKey: "shortcuts.action.canvas_tool_clone", category: "Canvas tools", categoryI18nKey: "shortcuts.category.canvasTools", scope: "canvas", defaultBindings: [_tool("k")] },
        { id: "canvas.tool.pixelate", label: "Pixelate tool", i18nKey: "shortcuts.action.canvas_tool_pixelate", category: "Canvas tools", categoryI18nKey: "shortcuts.category.canvasTools", scope: "canvas", defaultBindings: [_tool("p")] },
        { id: "canvas.tool.dodge", label: "Dodge tool", i18nKey: "shortcuts.action.canvas_tool_dodge", category: "Canvas tools", categoryI18nKey: "shortcuts.category.canvasTools", scope: "canvas", defaultBindings: [_tool("j")] },
        { id: "canvas.tool.liquify", label: "Liquify tool", i18nKey: "shortcuts.action.canvas_tool_liquify", category: "Canvas tools", categoryI18nKey: "shortcuts.category.canvasTools", scope: "canvas", defaultBindings: [_tool("y")] },
        { id: "canvas.colors.swap", label: "Swap foreground/background colors", i18nKey: "shortcuts.action.canvas_colors_swap", category: "Canvas tools", categoryI18nKey: "shortcuts.category.canvasTools", scope: "canvas", defaultBindings: [_tool("x")] },

        // Brush parameters ---------------------------------------------------
        {
            id: "canvas.brushSize.decrease", label: "Brush size: decrease",
            i18nKey: "shortcuts.action.canvas_brushSize_decrease",
            category: "Canvas brush", categoryI18nKey: "shortcuts.category.canvasBrush",
            scope: "canvas", allowRepeat: true,
            defaultBindings: [
                { type: "key", value: "[", ctrl: false, shift: null, alt: false, meta: false },
                // German-friendly secondary default. Shift is ignored so
                // Shift+Ö also decrements.
                { type: "key", value: "ö", ctrl: false, shift: null, alt: false, meta: false },
            ],
        },
        {
            id: "canvas.brushSize.increase", label: "Brush size: increase",
            i18nKey: "shortcuts.action.canvas_brushSize_increase",
            category: "Canvas brush", categoryI18nKey: "shortcuts.category.canvasBrush",
            scope: "canvas", allowRepeat: true,
            defaultBindings: [
                { type: "key", value: "]", ctrl: false, shift: null, alt: false, meta: false },
                // Must reject US Shift+3, whose produced key is '#'.
                { type: "key", value: "#", ctrl: false, shift: false, alt: false, meta: false },
            ],
        },
        {
            id: "canvas.brushHardness.decrease", label: "Brush hardness: decrease",
            i18nKey: "shortcuts.action.canvas_brushHardness_decrease",
            category: "Canvas brush", categoryI18nKey: "shortcuts.category.canvasBrush",
            scope: "canvas", allowRepeat: true,
            defaultBindings: [
                { type: "key", value: "{", ctrl: false, shift: null, alt: false, meta: false },
            ],
        },
        {
            id: "canvas.brushHardness.increase", label: "Brush hardness: increase",
            i18nKey: "shortcuts.action.canvas_brushHardness_increase",
            category: "Canvas brush", categoryI18nKey: "shortcuts.category.canvasBrush",
            scope: "canvas", allowRepeat: true,
            defaultBindings: [
                { type: "key", value: "}", ctrl: false, shift: null, alt: false, meta: false },
            ],
        },
        {
            id: "canvas.zoom.fit", label: "Fit canvas to view",
            i18nKey: "shortcuts.action.canvas_zoom_fit",
            category: "Canvas view", categoryI18nKey: "shortcuts.category.canvasView",
            scope: "canvas",
            defaultBindings: [
                { type: "key", value: "f", ctrl: false, shift: null, alt: false, meta: false },
                { type: "key", value: "0", ctrl: false, shift: null, alt: false, meta: false },
            ],
        },
    ];

    function _registerDefaults() {
        _DEFAULT_ACTIONS.forEach(function (def) {
            register(def.id, def);
        });
    }

    // ── Settings UI ─────────────────────────────────────────────────────
    var _captureState = null; // { actionId, mode: "replace"|"add", keydownFn, row }

    function _actionLabel(def) {
        return def.i18nKey ? _t(def.i18nKey, def.label) : def.label;
    }

    function _categoryLabel(def) {
        return def.categoryI18nKey ? _t(def.categoryI18nKey, def.category) : def.category;
    }

    function _el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function _cancelCapture() {
        if (!_captureState) return;
        document.removeEventListener("keydown", _captureState.keydownFn, true);
        if (_captureState.panel && _captureState.panel.parentNode) {
            _captureState.panel.parentNode.removeChild(_captureState.panel);
        }
        _captureState = null;
    }

    function _snapshotFromEvent(ev) {
        return {
            key: _normKeyValue(ev.key || ""),
            rawKey: ev.key || "",
            code: ev.code || "",
            ctrl: !!ev.ctrlKey,
            shift: !!ev.shiftKey,
            alt: !!ev.altKey,
            meta: !!ev.metaKey,
        };
    }

    function _snapshotToEventLike(snap) {
        return {
            key: snap.rawKey,
            code: snap.code,
            ctrlKey: snap.ctrl,
            shiftKey: snap.shift,
            altKey: snap.alt,
            metaKey: snap.meta,
        };
    }

    function _bindingFromSnapshot(snap, bindType) {
        return {
            type: bindType,
            value: bindType === "code" ? snap.code : snap.key,
            ctrl: snap.ctrl,
            shift: snap.shift,
            alt: snap.alt,
            meta: snap.meta,
        };
    }

    // Find conflicts: any other action whose effective bindings would match
    // the captured event snapshot (key- and code-type bindings both tested
    // against the snapshot, not compared structurally).
    function _findConflicts(snap, excludeActionId) {
        var evLike = _snapshotToEventLike(snap);
        var conflicts = [];
        _order.forEach(function (id) {
            if (id === excludeActionId) return;
            var def = _actions[id];
            if (!def) return;
            var bindings = getBindings(id);
            bindings.forEach(function (b) {
                if (_bindingMatchesEvent(b, evLike)) {
                    conflicts.push({ actionId: id, binding: b });
                }
            });
        });
        return conflicts;
    }

    // Remove one binding from another action as part of a steal. If the
    // action was still on defaults, materialize the effective list minus the
    // stolen binding as its override first.
    function _stealBinding(conflict) {
        var id = conflict.actionId;
        var effective = getBindings(id);
        var kept = effective.filter(function (b) {
            return !(b.type === conflict.binding.type &&
                     b.value === conflict.binding.value &&
                     b.ctrl === conflict.binding.ctrl &&
                     b.shift === conflict.binding.shift &&
                     b.alt === conflict.binding.alt &&
                     b.meta === conflict.binding.meta);
        });
        _overrides[id] = _sanitizeBindingList(kept) || [];
    }

    function _startCapture(actionId, mode, row) {
        _cancelCapture();

        var panel = _el("div", "shortcut-capture-panel");
        var hint = _el("div", "shortcut-capture-hint",
            _t("settings.shortcuts.captureHint", "Press the key you want (Esc cancels)"));
        panel.appendChild(hint);
        row.appendChild(panel);

        var keydownFn = function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            if (ev.key === "Escape") { _cancelCapture(); return; }
            // Ignore bare modifier presses; wait for a real key.
            if (ev.key === "Control" || ev.key === "Shift" || ev.key === "Alt" || ev.key === "Meta") return;
            document.removeEventListener("keydown", keydownFn, true);
            _captureState.keydownFn = null;
            _showCaptureChoice(actionId, mode, row, panel, _snapshotFromEvent(ev));
        };
        document.addEventListener("keydown", keydownFn, true);
        _captureState = { actionId: actionId, mode: mode, keydownFn: keydownFn, panel: panel, row: row };
    }

    function _showCaptureChoice(actionId, mode, row, panel, snap) {
        panel.textContent = "";

        var reserved = _findReserved(snap);
        if (reserved) {
            var msg = reserved.kind === "browser"
                ? _t("settings.shortcuts.browserReserved",
                     "This combination is reserved for the browser and cannot be bound.")
                : _t("settings.shortcuts.reserved",
                     "This key is reserved by Studio and cannot be bound.");
            panel.appendChild(_el("div", "shortcut-capture-error", msg + " (" + reserved.label + ")"));
            var okBtn = _el("button", "defaults-btn", _t("settings.shortcuts.cancel", "Cancel"));
            okBtn.type = "button";
            okBtn.addEventListener("click", _cancelCapture);
            panel.appendChild(okBtn);
            return;
        }

        var charLabel = _t("settings.shortcuts.bindByCharacter", "Bind by character");
        var codeLabel = _t("settings.shortcuts.bindByPhysical", "Bind by physical position");

        var info = _el("div", "shortcut-capture-info");
        info.appendChild(_el("div", null,
            _t("settings.shortcuts.characterLabel", "Character") + ": " +
            formatBinding(_bindingFromSnapshot(snap, "key"))));
        info.appendChild(_el("div", null,
            _t("settings.shortcuts.physicalLabel", "Physical key") + ": " +
            formatBinding(_bindingFromSnapshot(snap, "code"))));
        panel.appendChild(info);

        var choiceWrap = _el("div", "shortcut-capture-choice");
        var radioName = "shortcutBindType_" + Date.now();
        function mkChoice(value, label, checked) {
            var lab = _el("label", "shortcut-capture-choice-item");
            var input = document.createElement("input");
            input.type = "radio";
            input.name = radioName;
            input.value = value;
            input.checked = !!checked;
            lab.appendChild(input);
            lab.appendChild(document.createTextNode(" " + label));
            return lab;
        }
        choiceWrap.appendChild(mkChoice("key", charLabel, true));
        choiceWrap.appendChild(mkChoice("code", codeLabel, false));
        panel.appendChild(choiceWrap);

        var conflictBox = _el("div", "shortcut-capture-conflict");
        panel.appendChild(conflictBox);

        var btnRow = _el("div", "shortcut-capture-buttons");
        var confirmBtn = _el("button", "defaults-btn", _t("settings.shortcuts.confirm", "Confirm"));
        confirmBtn.type = "button";
        var cancelBtn = _el("button", "defaults-btn", _t("settings.shortcuts.cancel", "Cancel"));
        cancelBtn.type = "button";
        btnRow.appendChild(confirmBtn);
        btnRow.appendChild(cancelBtn);
        panel.appendChild(btnRow);

        cancelBtn.addEventListener("click", _cancelCapture);

        var conflicts = _findConflicts(snap, actionId);
        if (conflicts.length) {
            var names = conflicts.map(function (c) {
                var d = _actions[c.actionId];
                return d ? _actionLabel(d) : c.actionId;
            }).join(", ");
            conflictBox.appendChild(_el("div", "shortcut-capture-error",
                _t("settings.shortcuts.conflict", "Already used by:") + " " + names));
            confirmBtn.textContent = _t("settings.shortcuts.useHere", "Use here");
        }

        confirmBtn.addEventListener("click", function () {
            var bindType = "key";
            var radios = choiceWrap.querySelectorAll("input[type=radio]");
            for (var i = 0; i < radios.length; i++) {
                if (radios[i].checked) bindType = radios[i].value;
            }
            var binding = _bindingFromSnapshot(snap, bindType);

            // Steal from conflicting actions first, then assign, then
            // persist the complete overrides object once.
            conflicts.forEach(_stealBinding);

            var current = mode === "add" ? getBindings(actionId) : [];
            current.push(binding);
            var def = _actions[actionId];
            var sanitized = _sanitizeBindingList(current) || [];
            if (def && _bindingListsEquivalent(sanitized, def.defaultBindings)) {
                delete _overrides[actionId];
            } else {
                _overrides[actionId] = sanitized;
            }
            _persistOverrides();
            _cancelCapture();
            renderSettings();
        });
    }

    function renderSettings() {
        var container = document.getElementById("shortcutSettingsRows");
        if (!container) return;
        _cancelCapture();
        container.textContent = "";

        // Group actions by category, in registration order.
        var byCategory = [];
        var catIndex = Object.create(null);
        _order.forEach(function (id) {
            var def = _actions[id];
            if (!def || def.reserved) return;
            var catLabel = _categoryLabel(def);
            if (!(catLabel in catIndex)) {
                catIndex[catLabel] = byCategory.length;
                byCategory.push({ label: catLabel, actions: [] });
            }
            byCategory[catIndex[catLabel]].actions.push(def);
        });

        byCategory.forEach(function (group) {
            container.appendChild(_el("div", "shortcut-settings-category", group.label));
            group.actions.forEach(function (def) {
                var row = _el("div", "shortcut-settings-row");
                row.dataset.actionId = def.id;

                row.appendChild(_el("span", "shortcut-settings-label", _actionLabel(def)));

                var chips = _el("span", "shortcut-settings-chips");
                var bindings = getBindings(def.id);
                if (!bindings.length) {
                    chips.appendChild(_el("span", "shortcut-chip shortcut-chip-unbound",
                        _t("settings.shortcuts.unbound", "Unbound")));
                } else {
                    bindings.forEach(function (b) {
                        chips.appendChild(_el("span", "shortcut-chip", formatBinding(b)));
                    });
                }
                row.appendChild(chips);

                var buttons = _el("span", "shortcut-settings-buttons");
                var changeBtn = _el("button", "defaults-btn shortcut-btn-change",
                    _t("settings.shortcuts.change", "Change"));
                changeBtn.type = "button";
                changeBtn.addEventListener("click", function () {
                    _startCapture(def.id, "replace", row);
                });
                buttons.appendChild(changeBtn);

                var addBtn = _el("button", "defaults-btn shortcut-btn-add",
                    _t("settings.shortcuts.add", "+"));
                addBtn.type = "button";
                addBtn.title = _t("settings.shortcuts.addTitle", "Add a secondary binding");
                addBtn.addEventListener("click", function () {
                    _startCapture(def.id, "add", row);
                });
                buttons.appendChild(addBtn);

                var resetBtn = _el("button", "defaults-btn shortcut-btn-reset",
                    _t("settings.shortcuts.reset", "Reset"));
                resetBtn.type = "button";
                resetBtn.addEventListener("click", function () {
                    reset(def.id);
                    renderSettings();
                });
                buttons.appendChild(resetBtn);

                row.appendChild(buttons);
                container.appendChild(row);
            });
        });

        var resetAllBtn = document.getElementById("shortcutResetAll");
        if (resetAllBtn && !resetAllBtn.dataset.shortcutsBound) {
            resetAllBtn.dataset.shortcutsBound = "1";
            resetAllBtn.addEventListener("click", function () {
                resetAll();
                renderSettings();
            });
        }
    }

    // ── Bootstrapping ───────────────────────────────────────────────────
    _registerDefaults();
    document.addEventListener("keydown", _dispatchKeydown, true);

    window.Shortcuts = {
        register: register,
        unregister: unregister,
        getAction: getAction,
        getBindings: getBindings,
        match: match,
        registerHandler: registerHandler,
        reloadFromPrefs: reloadFromPrefs,
        setBindings: setBindings,
        reset: reset,
        resetAll: resetAll,
        isTypingContext: isTypingContext,
        formatBinding: formatBinding,
        renderSettings: renderSettings,
    };
})();
