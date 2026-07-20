// Forge Studio — server-backed preferences module.
//
// Wraps GET/POST/DELETE /studio/prefs so application preferences survive
// browser-storage clears. Exposes window.Prefs. Loaded before shortcuts.js,
// canvas-ui.js, app.js and gallery.js (see index.html script order).
//
// Design constraints:
//  - No network request at module evaluation time: app.js must get the
//    chance to process the ?reset emergency flow before the first GET.
//  - A failed same-origin API must never stop Studio from booting — legacy
//    localStorage values act as an in-memory fallback for that boot.
//  - Values handed out or taken in are cloned, so callers cannot mutate the
//    cache without going through set().

(function () {
    "use strict";

    var PREFS_URL = "/studio/prefs";
    var MIGRATED_MARKER = "studio-prefs-migrated";
    var DEBOUNCE_MS = 500;

    var _cache = {};            // authoritative in-memory preference state
    var _loadPromise = null;    // cached load() promise (one GET per boot)
    var _serverOk = false;      // last GET succeeded — migration marker gate
    var _pendingKeys = new Set();  // top-level keys queued for POST
    var _flushTimer = null;
    var _flushChain = Promise.resolve();  // serializes overlapping flushes

    function _clone(value) {
        if (value === null || typeof value !== "object") return value;
        try {
            if (typeof structuredClone === "function") return structuredClone(value);
        } catch (e) { /* fall through to JSON */ }
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (e) {
            return value;
        }
    }

    function _lsGet(key) {
        try { return window.localStorage.getItem(key); } catch (e) { return null; }
    }
    function _lsSet(key, value) {
        try { window.localStorage.setItem(key, value); } catch (e) { /* best effort */ }
    }

    // ── Legacy localStorage migration table ────────────────────────────
    // Each entry: server key, legacy localStorage key, and a converter that
    // returns { ok: true, value } for a usable legacy value. Converters are
    // defensive: legacy formats varied between raw strings, JSON, "1"/"true".

    function _convString(raw) {
        // Includes the empty string — "" is a meaningful folder setting.
        return { ok: true, value: String(raw) };
    }

    function _convBool(raw) {
        var s = String(raw).trim().toLowerCase();
        if (s === "1" || s === "true" || s === "yes" || s === "on") return { ok: true, value: true };
        if (s === "0" || s === "false" || s === "no" || s === "off" || s === "") return { ok: true, value: false };
        return { ok: false };
    }

    function _convFiniteNumber(raw) {
        var n = Number(raw);
        if (Number.isFinite(n)) return { ok: true, value: n };
        return { ok: false };
    }

    function _convSessionLimit(raw) {
        var n = parseInt(raw, 10);
        if (!Number.isFinite(n)) return { ok: false };
        return { ok: true, value: Math.min(200, Math.max(8, n)) };
    }

    function _convAutoUnload(raw) {
        try {
            var obj = JSON.parse(raw);
            if (obj && typeof obj === "object" && !Array.isArray(obj)) {
                return {
                    ok: true,
                    value: {
                        enabled: !!obj.enabled,
                        minutes: Number.isFinite(Number(obj.minutes)) ? Number(obj.minutes) : 10,
                    },
                };
            }
        } catch (e) { /* not JSON */ }
        return { ok: false };
    }

    function _convPromptVersion(raw) {
        var s = String(raw).trim();
        if (s === "resolved" || s === "raw") return { ok: true, value: s };
        return { ok: false };
    }

    function _convComponentMemory(raw) {
        try {
            var parsed = JSON.parse(raw);
            var mem = _normalizeComponentMemory(parsed);
            if (Object.keys(mem.by_model).length || Object.keys(mem.by_arch).length) {
                return { ok: true, value: mem };
            }
        } catch (e) { /* not JSON */ }
        return { ok: false };
    }

    // v2 component-memory normalizer (duplicated defensively in app.js —
    // both follow the shape documented in the C-part of the release notes):
    // { version: 2, by_model: { title: { te, vae } }, by_arch: { arch: { te, vae } } }
    // A model entry's own `vae: null` is the explicit "Automatic — stop
    // fallback" sentinel and must be preserved.
    function _normalizeComponentMemory(rawValue) {
        var out = { version: 2, by_model: {}, by_arch: {} };
        if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) return out;

        function normEntry(entry, allowNullVae) {
            if (typeof entry === "string") {
                return entry ? { te: entry } : null;
            }
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
            var e = {};
            if (typeof entry.te === "string" && entry.te) e.te = entry.te;
            if (typeof entry.vae === "string" && entry.vae) {
                e.vae = entry.vae;
            } else if (allowNullVae && entry.vae === null && "vae" in entry) {
                e.vae = null;
            }
            return Object.keys(e).length ? e : null;
        }

        var byModel = rawValue.by_model;
        var byArch = rawValue.by_arch;
        if (!byModel && !byArch) {
            // Legacy flat shape: { "<model title>": "<te filename>" }
            byModel = rawValue;
            byArch = {};
        }
        if (byModel && typeof byModel === "object" && !Array.isArray(byModel)) {
            Object.keys(byModel).forEach(function (title) {
                var e = normEntry(byModel[title], true);
                if (e) out.by_model[title] = e;
            });
        }
        if (byArch && typeof byArch === "object" && !Array.isArray(byArch)) {
            Object.keys(byArch).forEach(function (arch) {
                if (!arch || arch === "unknown") return;
                var e = normEntry(byArch[arch], false);
                if (e) out.by_arch[arch] = e;
            });
        }
        return out;
    }

    var LEGACY_MAP = [
        { server: "component_memory", legacy: "studio_te_memory", conv: _convComponentMemory },
        { server: "layout_preset", legacy: "studio-layout-preset", conv: _convString },
        { server: "session_limit", legacy: "studio-session-limit", conv: _convSessionLimit },
        { server: "gallery_folder", legacy: "studio-gallery-folder", conv: _convString },
        { server: "save_dir", legacy: "studio-save-dir", conv: _convString },
        { server: "vram_weights", legacy: "studio-vram-weights", conv: _convFiniteNumber },
        { server: "auto_unload", legacy: "studio-auto-unload", conv: _convAutoUnload },
        { server: "remember_session", legacy: "studio-remember-session", conv: _convBool },
        { server: "gal_send_prompt_version", legacy: "gal_send_prompt_version", conv: _convPromptVersion },
    ];

    function _collectLegacyValues(onlyMissing) {
        var found = {};
        LEGACY_MAP.forEach(function (m) {
            if (onlyMissing && Object.prototype.hasOwnProperty.call(_cache, m.server)) return;
            var raw = _lsGet(m.legacy);
            if (raw === null) return;
            var res = m.conv(raw);
            if (res.ok) found[m.server] = res.value;
        });
        return found;
    }

    // ── Network ────────────────────────────────────────────────────────

    async function _postKeys(payload, fetchOpts) {
        var resp = await fetch(PREFS_URL, Object.assign({
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        }, fetchOpts || {}));
        if (!resp.ok) throw new Error("prefs POST failed: HTTP " + resp.status);
        return resp;
    }

    async function _doLoad() {
        var serverData = null;
        try {
            var resp = await fetch(PREFS_URL, { method: "GET" });
            if (!resp.ok) throw new Error("prefs GET failed: HTTP " + resp.status);
            var data = await resp.json();
            if (data && typeof data === "object" && !Array.isArray(data)) {
                serverData = data;
            } else {
                serverData = {};
            }
        } catch (err) {
            console.warn("[Prefs] Could not load server preferences; using local fallback for this session.", err);
        }

        if (serverData !== null) {
            _serverOk = true;
            _cache = serverData;
            await _migrateLegacyIfNeeded();
        } else {
            // Offline/failure fallback: boot from any valid legacy values.
            // No migration marker is set; persistence retries on later set().
            _serverOk = false;
            _cache = _collectLegacyValues(false);
        }
        return _cache;
    }

    async function _migrateLegacyIfNeeded() {
        if (_lsGet(MIGRATED_MARKER) === "1") return;
        var migrate = _collectLegacyValues(true);
        var keys = Object.keys(migrate);
        if (keys.length) {
            try {
                await _postKeys(migrate);
                keys.forEach(function (k) { _cache[k] = migrate[k]; });
            } catch (err) {
                console.warn("[Prefs] Legacy preference migration failed; will retry next boot.", err);
                // Still usable this session — merge into memory only.
                keys.forEach(function (k) {
                    if (!Object.prototype.hasOwnProperty.call(_cache, k)) _cache[k] = migrate[k];
                });
                return; // marker not set; retried on a later boot
            }
        }
        _lsSet(MIGRATED_MARKER, "1");
    }

    function _scheduleFlush() {
        if (_flushTimer) clearTimeout(_flushTimer);
        _flushTimer = setTimeout(function () {
            _flushTimer = null;
            _flush();
        }, DEBOUNCE_MS);
    }

    function _flush(fetchOpts) {
        // Serialized: each flush waits for the previous request so changes
        // cannot reorder on the wire.
        _flushChain = _flushChain.then(function () {
            if (!_pendingKeys.size) return null;
            var payload = {};
            _pendingKeys.forEach(function (k) {
                payload[k] = _cache[k] === undefined ? null : _cache[k];
            });
            _pendingKeys.clear();
            return _postKeys(payload, fetchOpts).catch(function (err) {
                console.warn("[Prefs] Preference save failed; queued for retry.", err);
                // Re-queue unsent keys unless a newer change is already
                // pending (the cache always holds the newest value, so
                // re-adding the key is enough).
                Object.keys(payload).forEach(function (k) {
                    _pendingKeys.add(k);
                });
            });
        });
        return _flushChain;
    }

    var Prefs = {
        load: function () {
            if (!_loadPromise) _loadPromise = _doLoad();
            return _loadPromise;
        },

        has: function (key) {
            return Object.prototype.hasOwnProperty.call(_cache, key);
        },

        get: function (key, fallback) {
            if (!Object.prototype.hasOwnProperty.call(_cache, key)) return fallback;
            return _clone(_cache[key]);
        },

        set: function (key, value) {
            _cache[key] = _clone(value);
            _pendingKeys.add(key);
            _scheduleFlush();
        },

        flush: function (options) {
            if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
            var fetchOpts = options && options.keepalive ? { keepalive: true } : undefined;
            return _flush(fetchOpts);
        },

        resetAll: async function () {
            if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
            _pendingKeys.clear();
            try {
                await fetch(PREFS_URL, { method: "DELETE" });
            } catch (err) {
                console.warn("[Prefs] Preference reset request failed.", err);
            }
            _cache = {};
        },

        // Internal/testing hooks (not part of the stable API).
        _normalizeComponentMemory: _normalizeComponentMemory,
        _clearLoadedStateForReset: function () {
            _cache = {};
            _pendingKeys.clear();
            _loadPromise = null;
        },
    };

    window.addEventListener("pagehide", function () {
        if (_pendingKeys.size) Prefs.flush({ keepalive: true });
    });

    window.Prefs = Prefs;
})();
