/* =====================================================================
   LokaChat - core.js   (v4)
   Shared state + helpers, the in-memory cache (stale-while-revalidate), persistent
   route panes (instant tab switching), drawers, modals, double-tap + heart burst,
   optimistic like/follow helpers and the central data-action delegation.
   Other files (views.js, chat.js, you.js, app.js) plug into window.App.
   ===================================================================== */
(function () {
  "use strict";
  const App = (window.App = {
    S: {
      user: null, identity: null, chats: [], unread: {}, pw: null,
      cache: {},                 // key -> { data, at }   (feeds, stories, notes, profiles, comments, history ...)
      postCache: new Map(),      // post id -> canonical post object (mutated by optimistic updates)
      following: new Set(),      // usernames I follow
      homeTab: "recommended", homePill: "all", youTab: "posts", msgTab: "chats", postPreset: "video", muted: false,
    },
    routes: {},     // name -> { mount(pane), show(ctx), hide(), fresh? }
    actions: {},    // data-action name -> function(el, event)
    forms: {},      // data-form name -> async function(form, data)
    dbl: {},        // data-dbl name -> function(el, point)
    leaveHooks: [],
  });

  // ---------- tiny DOM / format helpers ----------
  App.$ = (sel, root) => (root || document).querySelector(sel);
  App.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  App.esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const esc = App.esc, $ = App.$, $$ = App.$$;

  App.timeAgo = (iso) => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s >= 31536000) return Math.floor(s / 31536000) + "y ago";
    if (s >= 2592000) return Math.floor(s / 2592000) + "mo ago";
    for (const [div, u] of [[604800, "w"], [86400, "d"], [3600, "h"], [60, "m"]]) if (s >= div) return Math.floor(s / div) + u + " ago";
    return "just now";
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
  App.isDesktop = () => window.matchMedia("(min-width: 768px)").matches;
  App.emptyBox = (ic, title, text, btn) => `<div class="empty">${App.icon(ic)}<h3>${esc(title)}</h3><p>${esc(text)}</p>${btn || ""}</div>`;

  /** Avatar markup. ring: undefined = none, "new" = gradient ring, "seen" = muted ring. */
  App.avatar = (user, size, ring, ringKey) => {
    const u = user || {};
    const inner = u.avatar_url
      ? `<img src="${esc(u.avatar_url)}" alt="" loading="lazy">`
      : esc((u.display_name || u.username || "?").trim().charAt(0).toUpperCase());
    const av = `<span class="avatar av-${size || "m"}">${inner}</span>`;
    return ring ? `<span class="ring ${ring === "seen" ? "seen" : ""}" ${ringKey ? `data-ring="${esc(ringKey)}"` : ""}>${av}</span>` : av;
  };

  // ---------- toast + error text ----------
  App.toast = (msg, type) => {
    const el = document.createElement("div");
    el.className = "toast" + (type === "err" ? " err" : "");
    el.textContent = msg;
    App.$("#toast-root").appendChild(el);
    setTimeout(() => el.remove(), type === "err" ? 6000 : 2800);
  };
  /** Always shows a useful reason (DOMException messages are often empty, so the name is included). */
  App.errText = (e) => {
    if (!e) return "Something went wrong";
    if (window.LokaApi && e instanceof window.LokaApi.ApiError) return e.message;
    const name = e.name && e.name !== "Error" ? e.name : "";
    const msg = e.message || "";
    return name && msg ? `${name}: ${msg}` : name || msg || "Something went wrong";
  };
  App.fail = (e, prefix) => { if (e && e.message !== "__silent") App.toast((prefix ? prefix + ": " : "") + App.errText(e), "err"); };

  // ---------- cache: stale-while-revalidate ----------
  /** Render the cached copy immediately, refresh in the background, re-render only if the data changed. */
  App.swr = async (key, fetcher, render, opts) => {
    opts = opts || {};
    const cache = App.S.cache, hit = cache[key];
    if (hit) render(hit.data, true);
    if (hit && !opts.force && Date.now() - hit.at < (opts.fresh == null ? 20000 : opts.fresh)) return hit.data;
    try {
      const data = await fetcher();
      const changed = !hit || JSON.stringify(hit.data) !== JSON.stringify(data);
      cache[key] = { data, at: Date.now() };
      if (changed) render(data, false);
      return data;
    } catch (e) {
      if (!hit) throw e;
      return hit.data;
    }
  };
  App.cacheGet = (key) => (App.S.cache[key] ? App.S.cache[key].data : undefined);
  App.cacheSet = (key, data) => { App.S.cache[key] = { data, at: Date.now() }; };
  App.cacheDrop = (...prefixes) => Object.keys(App.S.cache).forEach((k) => { if (prefixes.some((p) => k.startsWith(p))) delete App.S.cache[k]; });
  /** Keep ONE canonical object per post so optimistic like/save updates show up everywhere. */
  App.remember = (posts) => posts.map((p) => {
    const old = App.S.postCache.get(p.id);
    if (old) { Object.assign(old, p); return old; }
    App.S.postCache.set(p.id, p);
    return p;
  });

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

  // ---------- slide-over drawers (notifications, comments, quick chat) ----------
  const drawers = [];
  App.drawer = (html, opts) => {
    opts = opts || {};
    const root = App.$("#drawer-root");
    const back = document.createElement("div");
    back.className = "drawer-back";
    back.innerHTML = `<aside class="drawer ${opts.cls || ""}" role="dialog" aria-modal="true"><button class="icon-btn x" data-action="close-drawer" aria-label="Close">${App.icon("close")}</button>${html}</aside>`;
    const handle = {
      el: back.firstElementChild, back,
      close() {
        const i = drawers.indexOf(handle);
        if (i < 0) return;
        drawers.splice(i, 1);
        back.classList.remove("open");
        setTimeout(() => back.remove(), 220);
        if (opts.onClose) opts.onClose();
      },
    };
    back.addEventListener("mousedown", (e) => { if (e.target === back) handle.close(); });
    root.appendChild(back);
    drawers.push(handle);
    requestAnimationFrame(() => back.classList.add("open"));
    return handle;
  };
  App.closeDrawers = () => { while (drawers.length) drawers[drawers.length - 1].close(); };
  App.actions["close-drawer"] = (el) => { const d = drawers.find((h) => h.el.contains(el)); if (d) d.close(); };

  /** Disable a button while an async job runs; toast any error. */
  App.busy = async (btn, fn) => {
    if (btn) btn.disabled = true;
    try { return await fn(); } catch (e) { App.fail(e); } finally { if (btn) btn.disabled = false; }
  };

  // ---------- router with persistent panes ----------
  const ALIASES = { clips: "reels" };
  let renderToken = 0, current = null;
  App.view = () => $("#view");
  App.go = (path) => { if (location.hash === "#" + path) App.route(); else location.hash = "#" + path; };
  App.onLeave = (fn) => App.leaveHooks.push(fn);
  App.parseHash = () => {
    const raw = location.hash.replace(/^#\/?/, "");
    const [path, query] = raw.split("?");
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    const name = ALIASES[parts[0]] || parts[0] || "home";
    return { name, args: parts.slice(1), query: new URLSearchParams(query || "") };
  };
  App.pane = (name) => {
    let p = $(`#view > [data-pane="${name}"]`);
    if (!p) {
      p = document.createElement("section");
      p.className = "pane"; p.dataset.pane = name; p.hidden = true;
      App.view().appendChild(p);
    }
    return p;
  };
  App.route = async () => {
    if (!App.S.user) return;
    const parsed = App.parseHash();
    const name = App.routes[parsed.name] ? parsed.name : "home";
    const def = App.routes[name];
    const tok = ++renderToken;
    App.leaveHooks.splice(0).forEach((h) => { try { h(); } catch (e) { /* ignore */ } });
    if (current && App.routes[current] && App.routes[current].hide) { try { App.routes[current].hide(); } catch (e) { /* ignore */ } }
    const prevPane = current && $(`#view > [data-pane="${current}"]`);
    if (prevPane) prevPane._scroll = window.scrollY;
    current = name;
    App.S.route = name;
    document.body.dataset.route = name;
    $$("[data-route]").forEach((a) => a.classList.toggle("active", a.dataset.route === name));
    $$("#view > .pane").forEach((p) => { p.hidden = p.dataset.pane !== name; });
    const pane = App.pane(name);
    pane.hidden = false;
    if (def.fresh || !pane._mounted) {
      pane._mounted = true;
      pane.innerHTML = "";
      if (def.mount) def.mount(pane);
    }
    window.scrollTo(0, def.fresh ? 0 : pane._scroll || 0);
    const ctx = { args: parsed.args, query: parsed.query, pane, view: pane, stale: () => tok !== renderToken };
    try {
      if (def.show) await def.show(ctx);
    } catch (e) {
      if (tok === renderToken && !pane.querySelector("[data-keep]")) {
        pane.innerHTML = `<div class="empty"><h3>Couldn't load this page</h3><p>${esc(App.errText(e))}</p><button class="btn" data-action="reload-view">Try again</button></div>`;
        pane._mounted = false;
      }
    }
    if (App.onRouted) App.onRouted(name);
  };
  App.actions["reload-view"] = () => { const p = $(`#view > [data-pane="${current}"]`); if (p) p._mounted = false; App.route(); };
  window.addEventListener("hashchange", () => App.route());

  // ---------- double-tap / double-click -> like + heart burst ----------
  /** Animated sky-blue/white heart in the centre (or at the tap point) of `box`. */
  App.burst = (box, point) => {
    if (!box) return;
    const r = box.getBoundingClientRect();
    const x = point ? point.x - r.left : r.width / 2, y = point ? point.y - r.top : r.height / 2;
    const h = document.createElement("div");
    h.className = "heart-burst";
    h.style.left = x + "px"; h.style.top = y + "px";
    h.innerHTML = `<svg viewBox="0 0 24 24"><defs><linearGradient id="hb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#38BDF8"/><stop offset=".55" stop-color="#FFFFFF"/><stop offset="1" stop-color="#0284C7"/></linearGradient></defs><path fill="url(#hb)" d="M12 21s-8-5.2-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.8-8 11-8 11z"/></svg>`;
    box.appendChild(h);
    setTimeout(() => h.remove(), 800);
  };
  let lastTap = { t: 0, x: 0, y: 0, el: null };
  const fireDbl = (el, point) => { const fn = App.dbl[el.dataset.dbl]; if (fn) fn(el, point); };
  document.addEventListener("dblclick", (e) => {
    const el = e.target.closest("[data-dbl]");
    if (el && !e.target.closest("button,a,input,textarea,[data-nodbl]")) { e.preventDefault(); fireDbl(el, { x: e.clientX, y: e.clientY }); }
  });
  document.addEventListener("touchend", (e) => {
    const el = e.target.closest("[data-dbl]");
    if (!el || e.target.closest("button,a,input,textarea,[data-nodbl]")) return;
    const t = e.changedTouches[0], now = Date.now();
    if (lastTap.el === el && now - lastTap.t < 320 && Math.abs(t.clientX - lastTap.x) < 40 && Math.abs(t.clientY - lastTap.y) < 40) {
      e.preventDefault(); lastTap = { t: 0, x: 0, y: 0, el: null };
      fireDbl(el, { x: t.clientX, y: t.clientY });
    } else lastTap = { t: now, x: t.clientX, y: t.clientY, el };
  }, { passive: false });

  // ---------- optimistic helpers ----------
  const likeCount = (p) => App.num(p.likes);
  /** Update every like button for a post from the canonical object. */
  App.paintLike = (p) => {
    $$(`[data-like="${p.id}"]`).forEach((b) => {
      b.classList.toggle("liked", !!p.liked);
      const n = b.querySelector(".n"); if (n) n.textContent = likeCount(p);
    });
  };
  /** Like/unlike immediately, then confirm with the server (rolls back on failure). `only`: "on" never un-likes (double-tap). */
  App.toggleLike = async (id, only) => {
    const p = App.S.postCache.get(id);
    if (!p || (only === "on" && p.liked)) return;
    const was = { liked: p.liked, likes: p.likes };
    p.liked = !p.liked; p.likes = Math.max(0, (p.likes || 0) + (p.liked ? 1 : -1));
    App.paintLike(p);
    try {
      const r = await window.LokaApi.post("/posts/like", { post_id: id });
      p.liked = r.liked; p.likes = r.likes; App.paintLike(p);
    } catch (e) { Object.assign(p, was); App.paintLike(p); App.fail(e, "Couldn't like"); }
  };
  App.actions.like = (el, ev) => { ev.stopPropagation(); App.toggleLike(el.dataset.id); };

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
    if (e.key !== "Escape") return;
    if (stack.length) stack[stack.length - 1].close();
    else if (drawers.length) drawers[drawers.length - 1].close();
    else if (App.closeMenus) App.closeMenus();
  });
  document.addEventListener("click", (e) => { if (App.closeMenus && !e.target.closest("[data-menu-root]")) App.closeMenus(); }, true);

  // ---------- sidebar (YouTube-style toggle; the wordmark never collapses) ----------
  const PIN_KEY = "loka_rail_pinned";
  App.applyPin = () => {
    let on = false;
    try { on = localStorage.getItem(PIN_KEY) === "1"; } catch (e) { /* ignore */ }
    document.body.classList.toggle("pinned", on);
    const b = $("#rail-toggle");
    if (b) { b.innerHTML = App.icon(on ? "menu" : "arrow-right"); b.setAttribute("aria-label", on ? "Collapse sidebar" : "Expand sidebar"); }
  };
  App.actions["toggle-pin"] = () => {
    const on = !document.body.classList.contains("pinned");
    try { localStorage.setItem(PIN_KEY, on ? "1" : "0"); } catch (e) { /* ignore */ }
    App.applyPin();
  };

  // ---------- small popover menus (+ Create) ----------
  App.closeMenus = () => $$(".menu.open").forEach((m) => m.classList.remove("open"));
  App.actions["toggle-menu"] = (el) => {
    const m = $("#" + el.dataset.target);
    const open = !m.classList.contains("open");
    App.closeMenus();
    m.classList.toggle("open", open);
  };

  // ---------- unread badges ----------
  App.updateBadge = () => {
    const total = Object.values(App.S.unread).reduce((a, b) => a + b, 0);
    ["#badge-msg", "#badge-msg-m", "#pill-badge"].forEach((id) => {
      const b = $(id);
      if (!b) return;
      b.hidden = total === 0;
      b.textContent = total > 99 ? "99+" : String(total);
    });
    if (App.updatePill) App.updatePill();
  };
})();
