/**
 * Forge Studio — Searchable Select widget
 *
 * Wraps a native <select> without rewriting its change handlers. The
 * native select stays in the DOM as the source of truth (visually
 * hidden); this component renders a styled trigger button next to it
 * and a floating panel with a filter input + filtered options on
 * click. Selecting an option writes back to the native select via
 * `select.value = …` and dispatches a bubbling "change" event so
 * existing listeners fire untouched.
 *
 * A MutationObserver watches the native select for option changes
 * (callers can repopulate `<option>` lists freely without notifying
 * the wrapper). The panel also lazily re-reads options each time it
 * opens, so even if the observer misses something the user always
 * sees the current set.
 *
 * Optgroups are rendered as non-interactive section headers above
 * their child options. Keyboard nav mirrors the wildcard browser in
 * lexicon.js — ↑/↓ move focus (with wrap), Enter selects, Escape
 * closes.
 *
 * API:
 *   const handle = StudioSearchableSelect.attach(selectEl, opts?);
 *   handle.refresh();   // force re-read from native select
 *   handle.destroy();   // restore native select
 *
 * Options:
 *   placeholder        — text shown when value is empty/missing
 *   searchPlaceholder  — placeholder for the filter input
 */
(function () {
"use strict";

const ATTR_KEY = "_studioSSelHandle";

function _esc(s) {
    if (s === null || s === undefined) return "";
    const d = document.createElement("div");
    d.textContent = String(s);
    return d.innerHTML;
}

function _readOptions(select) {
    // Walks the native select's children, collecting flat options +
    // optgroup boundaries. Output is a flat list where each entry has
    // either {kind: "group", label} or {kind: "option", value, text,
    // disabled, title, selected}.
    const out = [];
    for (const node of select.children) {
        if (node.tagName === "OPTGROUP") {
            out.push({ kind: "group", label: node.label || "" });
            for (const opt of node.children) {
                if (opt.tagName !== "OPTION") continue;
                out.push({
                    kind: "option",
                    value: opt.value,
                    text: opt.textContent,
                    disabled: !!opt.disabled,
                    title: opt.title || "",
                    selected: !!opt.selected,
                });
            }
        } else if (node.tagName === "OPTION") {
            out.push({
                kind: "option",
                value: node.value,
                text: node.textContent,
                disabled: !!node.disabled,
                title: node.title || "",
                selected: !!node.selected,
            });
        }
    }
    return out;
}

function _currentLabel(select, placeholder) {
    const opt = select.options[select.selectedIndex];
    if (!opt || opt.value === "") return placeholder || "— Select —";
    return opt.textContent;
}

function attach(select, opts) {
    if (!select || !(select instanceof HTMLSelectElement)) return null;
    if (select[ATTR_KEY]) return select[ATTR_KEY];   // already wrapped
    opts = opts || {};
    const placeholder = opts.placeholder || "— Select —";
    const searchPlaceholder = opts.searchPlaceholder || "Search…";

    // Build the trigger element. We carry over the native select's
    // class list (minus a couple of layout-only classes that don't
    // make sense on a button) so existing CSS still positions the
    // wrapper the same as the original select.
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "ssel-trigger " + (select.className || "");
    if (select.title) trigger.title = select.title;
    trigger.innerHTML = '<span class="ssel-trigger-label"></span>'
        + '<span class="ssel-trigger-chevron" aria-hidden="true">▾</span>';
    const triggerLabel = trigger.querySelector(".ssel-trigger-label");
    triggerLabel.textContent = _currentLabel(select, placeholder);

    // Inline-block the wrapper alongside the (hidden) native select
    // so any flex/grid layout the select sat in still flows the same.
    select.classList.add("ssel-native-hidden");
    select.parentNode.insertBefore(trigger, select);

    let panel = null;
    let listEl = null;
    let searchEl = null;
    let kbIdx = -1;     // index into the *flat visible* option list

    function _close() {
        if (!panel) return;
        document.removeEventListener("click", _outsideClick, true);
        document.removeEventListener("keydown", _hostKey, true);
        panel.remove();
        panel = null; listEl = null; searchEl = null; kbIdx = -1;
        trigger.classList.remove("ssel-trigger-open");
        // Mirror native select focus/blur so callers that bind
        // `select.addEventListener("focus" | "blur", …)` (e.g. the
        // workshop's row-reference highlight) keep working without
        // having to know about the wrapper.
        select.dispatchEvent(new Event("blur", { bubbles: false }));
    }

    function _outsideClick(e) {
        if (!panel) return;
        if (panel.contains(e.target) || trigger.contains(e.target)) return;
        _close();
    }

    function _hostKey(e) {
        if (!panel) return;
        if (e.key === "Escape") {
            e.preventDefault();
            _close();
            trigger.focus();
            return;
        }
    }

    function _renderList() {
        const all = _readOptions(select);
        const q = (searchEl?.value || "").trim().toLowerCase();
        const visible = [];
        // Track which group label belongs to the next visible option
        // so groups whose every option is filtered out don't render.
        let pendingGroup = null;
        for (const item of all) {
            if (item.kind === "group") {
                pendingGroup = item.label;
                continue;
            }
            if (q && !item.text.toLowerCase().includes(q)) continue;
            if (pendingGroup !== null) {
                visible.push({ kind: "group", label: pendingGroup });
                pendingGroup = null;
            }
            visible.push(item);
        }

        if (visible.length === 0) {
            listEl.innerHTML = '<div class="ssel-empty">No matches</div>';
            kbIdx = -1;
            return;
        }

        let html = "";
        for (let i = 0; i < visible.length; i++) {
            const it = visible[i];
            if (it.kind === "group") {
                html += '<div class="ssel-optgroup-header">' + _esc(it.label) + '</div>';
            } else {
                const cls = "ssel-option"
                    + (it.value === select.value ? " selected" : "")
                    + (it.disabled ? " disabled" : "");
                html += '<div class="' + cls + '" role="option"'
                    + ' data-idx="' + i + '"'
                    + ' data-value="' + _esc(it.value) + '"'
                    + (it.title ? ' title="' + _esc(it.title) + '"' : "")
                    + '>' + _esc(it.text) + '</div>';
            }
        }
        listEl.innerHTML = html;

        // Pick an initial keyboard focus: the currently-selected
        // option if it's still visible, else the first option.
        kbIdx = visible.findIndex(it => it.kind === "option" && it.value === select.value);
        if (kbIdx < 0) kbIdx = visible.findIndex(it => it.kind === "option");
        _paintKbFocus();

        // Bind once per render — listEl.innerHTML wipes prior children.
        listEl.querySelectorAll(".ssel-option:not(.disabled)").forEach(el => {
            el.addEventListener("click", () => {
                const idx = parseInt(el.dataset.idx, 10);
                _commit(visible, idx);
            });
            el.addEventListener("mouseenter", () => {
                kbIdx = parseInt(el.dataset.idx, 10);
                _paintKbFocus();
            });
        });

        // Keyboard nav lives on the search input so typing + arrows
        // chain naturally. The list itself doesn't take focus.
        searchEl.onkeydown = (e) => {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                kbIdx = _nextOptIdx(visible, kbIdx, +1);
                _paintKbFocus(); _scrollKbIntoView();
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                kbIdx = _nextOptIdx(visible, kbIdx, -1);
                _paintKbFocus(); _scrollKbIntoView();
            } else if (e.key === "Enter") {
                e.preventDefault();
                if (kbIdx >= 0) _commit(visible, kbIdx);
            } else if (e.key === "Escape") {
                e.preventDefault();
                _close();
                trigger.focus();
            }
        };
    }

    function _nextOptIdx(visible, from, dir) {
        // Wrap around, skipping group headers and disabled options.
        const n = visible.length;
        if (n === 0) return -1;
        let i = from < 0 ? (dir > 0 ? -1 : 0) : from;
        for (let step = 0; step < n; step++) {
            i = ((i + dir) % n + n) % n;
            const it = visible[i];
            if (it.kind === "option" && !it.disabled) return i;
        }
        return -1;
    }

    function _paintKbFocus() {
        if (!listEl) return;
        listEl.querySelectorAll(".kb-focus").forEach(el => el.classList.remove("kb-focus"));
        if (kbIdx < 0) return;
        const el = listEl.querySelector('.ssel-option[data-idx="' + kbIdx + '"]');
        if (el) el.classList.add("kb-focus");
    }

    function _scrollKbIntoView() {
        const el = listEl?.querySelector(".kb-focus");
        if (el) el.scrollIntoView({ block: "nearest" });
    }

    function _commit(visible, idx) {
        const it = visible[idx];
        if (!it || it.kind !== "option" || it.disabled) return;
        if (select.value !== it.value) {
            select.value = it.value;
            triggerLabel.textContent = _currentLabel(select, placeholder);
            select.dispatchEvent(new Event("change", { bubbles: true }));
        }
        _close();
        trigger.focus();
    }

    function _open() {
        if (panel) { _close(); return; }
        panel = document.createElement("div");
        panel.className = "ssel-panel";
        panel.innerHTML = '<div class="ssel-search-row">'
            + '<input class="ssel-search" type="text" placeholder="' + _esc(searchPlaceholder) + '" autocomplete="off" spellcheck="false">'
            + '</div>'
            + '<div class="ssel-list" role="listbox"></div>';
        document.body.appendChild(panel);
        listEl = panel.querySelector(".ssel-list");
        searchEl = panel.querySelector(".ssel-search");

        // Position below the trigger; right-edge clamp so a wide
        // panel doesn't shoot off-screen on a narrow column.
        const r = trigger.getBoundingClientRect();
        const minWidth = Math.max(r.width, 240);
        panel.style.minWidth = minWidth + "px";
        const maxLeft = window.innerWidth - 8 - panel.offsetWidth;
        panel.style.left = Math.max(8, Math.min(r.left, maxLeft)) + "px";
        panel.style.top = (r.bottom + 4) + "px";

        trigger.classList.add("ssel-trigger-open");
        _renderList();
        searchEl.addEventListener("input", _renderList);
        searchEl.focus();

        document.addEventListener("click", _outsideClick, true);
        document.addEventListener("keydown", _hostKey, true);

        // See the matching dispatch in _close() — keeps existing
        // focus/blur listeners on the native select working.
        select.dispatchEvent(new Event("focus", { bubbles: false }));
    }

    trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        _open();
    });

    // Refresh the trigger label whenever the native select's value
    // is set programmatically (which doesn't fire "change"). Also
    // refresh on options-list changes.
    const observer = new MutationObserver((mutations) => {
        let optionsChanged = false;
        for (const m of mutations) {
            if (m.type === "childList") optionsChanged = true;
            if (m.type === "attributes" && m.attributeName === "value") optionsChanged = true;
        }
        triggerLabel.textContent = _currentLabel(select, placeholder);
        if (optionsChanged && panel) _renderList();
    });
    observer.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ["value"] });

    // Native "change" can also be triggered by other code paths (e.g.
    // keyboard) — keep the trigger label in sync.
    select.addEventListener("change", () => {
        triggerLabel.textContent = _currentLabel(select, placeholder);
    });

    const handle = {
        refresh() {
            triggerLabel.textContent = _currentLabel(select, placeholder);
            if (panel) _renderList();
        },
        destroy() {
            _close();
            observer.disconnect();
            trigger.remove();
            select.classList.remove("ssel-native-hidden");
            delete select[ATTR_KEY];
        },
    };
    select[ATTR_KEY] = handle;
    return handle;
}

function attachAll(root, opts) {
    const scope = root || document;
    const out = [];
    scope.querySelectorAll("select.ssel").forEach(sel => {
        out.push(attach(sel, opts));
    });
    return out;
}

window.StudioSearchableSelect = { attach, attachAll };

})();
