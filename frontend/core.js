/* =====================================================================
   LokaChat - core.js
   Shared state + helpers: escaping, formatting, avatars, toasts, modal stack,
   hash router and the central data-action click delegation.
   Other files (views.js, chat.js, you.js, app.js) plug into window.App.
   ===================================================================== */
(function () {
  "use strict";
  const App = (window.App = {
    S: {
      user: null, identity: null, chats: [], unread: {}, postCache: new Map(),
      homeTab: "recommended", youTab: "uploads", msgTab: "chats", postPreset: "video",
    },
    routes: {},     // name -> async function(ctx)
    actions: {},    // data-action name -> function(el, event)
    forms: {},      // data-form name -> async function(form, data)
    leaveHooks: [], // cleanups run when leaving a view
  });

  // ---------- tiny DOM / format helpers ----------
  App.$ = (sel, root) => (root || document).querySelector(sel);
  App.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  App.esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const esc = App.esc;

  App.timeAgo = (iso) => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    const steps = [[60, "m"], [3600, "h"], [86400, "d"], [604800, "w"]];
    if (s >= 31536000) return Math.floor(s / 31536000) + "y ago";
    if (s >= 2592000) return Math.floor(s / 2592000) + "mo ago";
    let out = "just now";
    for (const [div, u] of steps) if (s >= div) out = Math.floor(s / div) + u + " ago";
    return out;
  };
  App.clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  App.dur = (sec) => {
    sec = Math.round(sec || 0);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  };
  App.num = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(n || 0));
  App.icon = (name, cls) => `<svg class="ic ${cls || ""}"><use href="#i-${name}"/></svg>`;
  App.debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  /** Avatar markup. ring: undefined = none, "new" = gradient ring, "seen" = muted ring. */
  App.avatar = (user, size, ring, ringKey) => {
    const u = user || {};
    const inner = u.avatar_url
      ? `<img src="${esc(u.avatar_url)}" alt="" loading="lazy">`
      : esc((u.display_name || u.username || "?").trim().charAt(0).toUpperCase());
    const av = `<span class="avatar av-${size || "m"}">${inner}</span>`;
    return ring ? `<span class="ring ${ring === "seen" ? "seen" : ""}" ${ringKey ? `data-ring="${esc(ringKey)}"` : ""}>${av}</span>` : av;
  };

  // ---------- toast ----------
  App.toast = (msg, type) => {
    const el = document.createElement("div");
    el.className = "toast" + (type === "err" ? " err" : "");
    el.textContent = msg;
    App.$("#toast-root").appendChild(el);
    setTimeout(() => el.remove(), type === "err" ? 5000 : 2800);
  };
  App.fail = (e) => { App.toast(e && e.message ? e.message : "Something went wrong", "err"); };

  // ---------- modal stack ----------
  const stack = [];
  App.modal = (html, opts) => {
    opts = opts || {};
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="modal ${opts.cls || ""}" role="dialog" aria-modal="true">` +
      `<button class="icon-btn x" data-action="close-modal" aria-label="Close">${App.icon("close")}</button>${html}</div>`;
    const handle = {
      el: back.firstElementChild, back,
      close() {
        const i = stack.indexOf(handle);
        if (i < 0) return;
        stack.splice(i, 1);
        back.remove();
        if (opts.onClose) opts.onClose();
      },
    };
    back.addEventListener("mousedown", (e) => { if (e.target === back) handle.close(); });
    App.$("#modal-root").appendChild(back);
    stack.push(handle);
    const first = back.querySelector("input:not([type=file]),textarea,select");
    if (first && !opts.noFocus) setTimeout(() => first.focus(), 30);
    return handle;
  };
  App.closeAllModals = () => { while (stack.length) stack[stack.length - 1].close(); };
  App.topModal = () => stack[stack.length - 1];
  App.confirm = (title, text, okLabel, danger) => new Promise((resolve) => {
    let done = false;
    const m = App.modal(`<h3>${esc(title)}</h3><p class="muted">${esc(text)}</p>
      <div class="modal-actions"><button class="btn" data-action="confirm-no">Cancel</button>
      <button class="btn ${danger ? "danger" : "primary"}" data-action="confirm-yes">${esc(okLabel || "OK")}</button></div>`,
      { noFocus: true, onClose: () => { if (!done) { done = true; resolve(false); } } });
    m.el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-action^=confirm-]");
      if (!b) return;
      done = true; resolve(b.dataset.action === "confirm-yes"); m.close();
    });
  });
  App.actions["close-modal"] = (el) => { const m = stack.find((h) => h.el.contains(el)); if (m) m.close(); };

  /** Disable a button while an async job runs; toast any error. */
  App.busy = async (btn, fn) => {
    if (btn) btn.disabled = true;
    try { return await fn(); } catch (e) { App.fail(e); } finally { if (btn) btn.disabled = false; }
  };

  // ---------- router ----------
  let renderToken = 0;
  App.view = () => App.$("#view");
  App.go = (path) => { location.hash = "#" + path; };
  App.onLeave = (fn) => App.leaveHooks.push(fn);
  App.parseHash = () => {
    const raw = location.hash.replace(/^#\/?/, "");
    const [path, query] = raw.split("?");
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    return { name: parts[0] || "home", args: parts.slice(1), query: new URLSearchParams(query || "") };
  };
  App.route = async () => {
    if (!App.S.user) return;
    const { name, args, query } = App.parseHash();
    const fn = App.routes[name] || App.routes.home;
    const tok = ++renderToken;
    App.leaveHooks.splice(0).forEach((h) => { try { h(); } catch (e) { /* ignore */ } });
    const current = App.routes[name] ? name : "home";
    App.$$("[data-route]").forEach((a) => a.classList.toggle("active", a.dataset.route === current));
    const view = App.view();
    view.innerHTML = '<div class="spinner"></div>';
    window.scrollTo(0, 0);
    try {
      await fn({ args, query, stale: () => tok !== renderToken, view });
    } catch (e) {
      if (tok === renderToken) view.innerHTML = `<div class="empty"><h3>Couldn't load this page</h3><p>${esc(e.message || e)}</p>
        <button class="btn" data-action="reload-view">Try again</button></div>`;
    }
  };
  App.actions["reload-view"] = () => App.route();
  window.addEventListener("hashchange", () => App.route());

  // ---------- global event delegation ----------
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const fn = App.actions[el.dataset.action];
    if (fn) { e.preventDefault(); fn(el, e); }
  });
  document.addEventListener("submit", async (e) => {
    const form = e.target.closest("form[data-form]");
    if (!form) return;
    e.preventDefault();
    const fn = App.forms[form.dataset.form];
    if (!fn) return;
    const data = Object.fromEntries(new FormData(form).entries());
    const btn = form.querySelector("button[type=submit]");
    await App.busy(btn, () => fn(form, data));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && stack.length) stack[stack.length - 1].close();
  });

  // ---------- sidebar pin ----------
  const PIN_KEY = "loka_rail_pinned";
  App.applyPin = () => {
    let on = false;
    try { on = localStorage.getItem(PIN_KEY) === "1"; } catch (e) { /* ignore */ }
    document.body.classList.toggle("pinned", on);
    const b = App.$(".rail-pin");
    if (b) b.classList.toggle("on", on);
  };
  App.actions["toggle-pin"] = () => {
    const on = !document.body.classList.contains("pinned");
    try { localStorage.setItem(PIN_KEY, on ? "1" : "0"); } catch (e) { /* ignore */ }
    App.applyPin();
  };

  // ---------- unread badge ----------
  App.updateBadge = () => {
    const total = Object.values(App.S.unread).reduce((a, b) => a + b, 0);
    ["#badge-msg", "#badge-msg-m"].forEach((id) => {
      const b = App.$(id);
      if (!b) return;
      b.hidden = total === 0;
      b.textContent = total > 99 ? "99+" : String(total);
    });
  };
})();
