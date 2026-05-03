/**
 * Forge Studio — i18n (Phase 0 infrastructure)
 *
 * Lightweight handrolled localization. No build step, no NPM, no library
 * dependency. Drop-in script tag, exposes `window.I18N`.
 *
 * Public API:
 *   I18N.t(key, params?)                 → translated string, falls back to English source
 *   I18N.t.plural(key, count, params?)   → plural-aware lookup via Intl.PluralRules
 *   I18N.setLocale(code)                 → switches locale, fires "i18n:change"
 *   I18N.getLocale()                     → current code
 *   I18N.getSupported()                  → ["en", "de", "fr", "es"]
 *   I18N.detect()                        → best supported locale from navigator
 *   I18N.applyToDom(root?)               → walks data-i18n attrs under root
 *   I18N.ready                           → Promise<void>, resolves once initial locale is loaded
 *
 * DOM instrumentation:
 *   <button data-i18n="settings.refresh">Refresh</button>
 *   <input data-i18n-placeholder="search.placeholder" placeholder="Search">
 *   <span data-i18n-title="info.tooltip" title="Info">…</span>
 *   <span data-i18n-aria-label="actions.close" aria-label="Close">×</span>
 *
 * The English text in the markup acts as the fallback — if a locale doesn't
 * have the key, the original markup text stays put. So a partially-translated
 * locale never shows raw keys to the user.
 *
 * URL flags:
 *   ?locale=de         → force locale at boot (overrides storage + detect)
 *   ?locale=keys       → debug: render every translated string as its key
 *
 * Backed by per-locale JSON files at /studio/static/locales/<code>.json.
 * English is always loaded first (fallback layer); other locales lazy-load
 * on first use.
 */

(function () {
    "use strict";

    var SUPPORTED = ["en", "de", "fr", "es"];
    var DEFAULT_LOCALE = "en";
    var STORAGE_KEY = "studio_locale";
    var LOCALE_BASE = "/studio/static/locales/";

    var _current = DEFAULT_LOCALE;
    var _dict = Object.create(null);   // { en: {...}, de: {...}, ... }
    var _pluralRules = null;
    var _keysMode = false;             // when true, t() returns the key — debug aid

    // ── String tables ────────────────────────────────────────────────────
    function _loadLocale(code) {
        if (_dict[code]) return Promise.resolve(_dict[code]);
        // Cache-bust matches index.html's script ?v= so a deploy bump
        // forces fresh locale files alongside fresh JS. Without this the
        // browser returns 304-revalidated stale JSON and new keys appear
        // missing even though the JS knows about them.
        var v = (typeof window !== "undefined" && window.__STUDIO_V) ? window.__STUDIO_V : "0";
        return fetch(LOCALE_BASE + code + ".json?v=" + encodeURIComponent(v), { cache: "no-cache" })
            .then(function (r) { return r.ok ? r.json() : {}; })
            .then(function (json) { _dict[code] = json || {}; return _dict[code]; })
            .catch(function (e) {
                console.warn("[i18n] failed to load locale " + code, e);
                _dict[code] = {};
                return _dict[code];
            });
    }

    // ── Interpolation ────────────────────────────────────────────────────
    // ICU-ish single-brace interpolation. {name} → params.name. Unknown
    // placeholders are left as-is so a missing param is visible (better
    // than silently inserting "undefined").
    function _interp(str, params) {
        if (!params || typeof str !== "string") return str;
        return str.replace(/\{(\w+)\}/g, function (m, k) {
            return params[k] != null ? String(params[k]) : m;
        });
    }

    // ── Lookup ───────────────────────────────────────────────────────────
    function _lookup(key) {
        var loc = _dict[_current];
        if (loc && Object.prototype.hasOwnProperty.call(loc, key)) return loc[key];
        var en = _dict[DEFAULT_LOCALE];
        if (en && Object.prototype.hasOwnProperty.call(en, key)) return en[key];
        return null;
    }

    // Three overloads:
    //   t("key")                      → translation, or "key" on miss
    //   t("key", { name: "foo" })     → translation with interpolation
    //   t("key", "English fallback")  → translation, or fallback on miss
    //   t("key", "English {n}", {n})  → translation, or interpolated fallback
    //
    // Sites without a markup fallback (toasts, runtime-built strings) pass
    // the English source as the second arg so they don't show "key" during
    // the boot window before en.json finishes loading.
    function t(key, fallbackOrParams, paramsIfFallback) {
        if (_keysMode) return key;
        var fallback = null;
        var params = null;
        if (typeof fallbackOrParams === "string") {
            fallback = fallbackOrParams;
            params = paramsIfFallback || null;
        } else {
            params = fallbackOrParams || null;
        }
        var str = _lookup(key);
        if (str == null) {
            return fallback != null ? _interp(fallback, params) : key;
        }
        return _interp(str, params);
    }

    // Plural helper — Intl.PluralRules picks "one"/"other"/"few"/"many"/etc.
    // Lookup order: locale-specific category, then "other", then English
    // fallback. Param injection includes `count` automatically.
    t.plural = function (key, count, params) {
        if (_keysMode) return key;
        var p = Object.assign({}, params || {}, { count: count });
        var cat = _pluralRules ? _pluralRules.select(count) : "other";
        var str = _lookup(key + "." + cat) || _lookup(key + ".other");
        if (str == null) return key;
        return _interp(str, p);
    };

    // ── Detection ────────────────────────────────────────────────────────
    function detect() {
        var langs = (navigator && navigator.languages) || [navigator.language || DEFAULT_LOCALE];
        for (var i = 0; i < langs.length; i++) {
            var code = String(langs[i] || "").toLowerCase().split("-")[0];
            if (SUPPORTED.indexOf(code) !== -1) return code;
        }
        return DEFAULT_LOCALE;
    }

    // ── DOM walker ───────────────────────────────────────────────────────
    // Each pass overwrites text/attribute ONLY when t() returns a translated
    // string. If t() returns the key (no translation found in any locale),
    // we leave the existing markup alone — that's the English fallback.
    function applyToDom(root) {
        root = root || document;
        if (!root.querySelectorAll) return;

        // textContent
        root.querySelectorAll("[data-i18n]").forEach(function (el) {
            var key = el.getAttribute("data-i18n");
            var params = _readParams(el);
            var txt = t(key, params);
            if (txt !== key) el.textContent = txt;
            else if (_keysMode) el.textContent = key;
        });

        // attribute helpers — title, aria-label, placeholder
        var attrPairs = [
            ["data-i18n-title",       "title"],
            ["data-i18n-aria-label",  "aria-label"],
            ["data-i18n-placeholder", "placeholder"],
        ];
        attrPairs.forEach(function (pair) {
            var dataAttr = pair[0];
            var domAttr = pair[1];
            root.querySelectorAll("[" + dataAttr + "]").forEach(function (el) {
                var key = el.getAttribute(dataAttr);
                // Pass data-i18n-params through so attribute walkers can
                // interpolate the same way the textContent walker does
                // (e.g. crop-ratio tooltips with a {ratio} placeholder).
                var params = _readParams(el);
                var txt = t(key, params);
                if (txt !== key) el.setAttribute(domAttr, txt);
                else if (_keysMode) el.setAttribute(domAttr, key);
            });
        });
    }

    function _readParams(el) {
        var raw = el.getAttribute("data-i18n-params");
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (_) { return null; }
    }

    // ── Switching ────────────────────────────────────────────────────────
    function setLocale(code) {
        if (SUPPORTED.indexOf(code) === -1) code = DEFAULT_LOCALE;
        return _loadLocale(code).then(function () {
            _current = code;
            try { _pluralRules = new Intl.PluralRules(code); } catch (_) { _pluralRules = null; }
            try { localStorage.setItem(STORAGE_KEY, code); } catch (_) {}
            applyToDom();
            try {
                window.dispatchEvent(new CustomEvent("i18n:change", { detail: { locale: code } }));
            } catch (_) {}
        });
    }

    function getLocale() { return _current; }
    function getSupported() { return SUPPORTED.slice(); }

    // ── Boot ─────────────────────────────────────────────────────────────
    // English is preloaded unconditionally so it's always available as a
    // fallback layer behind any other locale.
    function _boot() {
        // URL override (handy for screenshots / debugging)
        var urlLocale = "";
        try {
            urlLocale = new URLSearchParams(window.location.search).get("locale") || "";
        } catch (_) { urlLocale = ""; }

        if (urlLocale === "keys") {
            _keysMode = true;
            urlLocale = DEFAULT_LOCALE;
        }

        var stored = "";
        try { stored = localStorage.getItem(STORAGE_KEY) || ""; } catch (_) {}

        var code = (urlLocale && SUPPORTED.indexOf(urlLocale) !== -1) ? urlLocale
                 : (stored    && SUPPORTED.indexOf(stored)    !== -1) ? stored
                 : detect();

        return _loadLocale(DEFAULT_LOCALE).then(function () {
            return code !== DEFAULT_LOCALE ? _loadLocale(code) : null;
        }).then(function () {
            _current = code;
            try { _pluralRules = new Intl.PluralRules(code); } catch (_) { _pluralRules = null; }
            applyToDom();
        });
    }

    window.I18N = {
        t: t,
        setLocale: setLocale,
        getLocale: getLocale,
        getSupported: getSupported,
        detect: detect,
        applyToDom: applyToDom,
        ready: _boot(),
    };
})();
