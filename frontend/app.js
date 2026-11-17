/* =====================================================================
   LokaChat - app.js
   Boot sequence, Sign in / Create account gate (password + 6-digit OTP or
   authenticator code), session handling, logout and realtime wiring.
   ===================================================================== */
(function () {
  "use strict";
  const { S, $, esc, icon, avatar, toast } = App;
  const api = window.LokaApi;

  // ============================================================ screens
  const show = (id) => {
    ["#splash", "#setup", "#auth", "#app"].forEach((s) => { const el = $(s); if (el) el.hidden = s !== id; });
  };
  App.setRailAvatar = () => { $("#rail-avatar").innerHTML = avatar(S.user, "xs"); };

  // ============================================================ auth gate
  let auth = { tab: "in", stage: "form", ctx: {}, pw: null }; // stage: form | otp | totp

  function field(label, name, type, extra) {
    return `<div class="field"><label>${label}</label><input name="${name}" type="${type || "text"}" ${extra || ""} required></div>`;
  }
  function renderAuth(error) {
    const body = $("#auth-body");
    const err = error ? `<div class="notice err">${esc(error)}</div>` : "";
    if (auth.stage === "otp") {
      const c = auth.ctx;
      body.innerHTML = `<h2 style="margin-top:18px">Enter your code</h2>
        <p class="muted small">We sent a 6-digit code to <b>${esc(c.destination || "your contact")}</b>. It expires in ${Math.round((c.expires_in || 600) / 60)} minutes.</p>
        ${c.dev_otp ? `<div class="notice dev">Dev mode: your code is <b>${esc(c.dev_otp)}</b> (shown because the server has OTP_DEV_MODE on)</div>` : ""}
        ${err}<form data-form="otp"><input class="otp-input" name="code" inputmode="numeric" pattern="\\d{6}" maxlength="6" placeholder="------" autocomplete="one-time-code" required autofocus>
        <button class="btn primary block" type="submit">Verify</button></form>
        <p class="small muted" style="margin-top:14px"><button class="link-btn" data-action="auth-resend">Send a new code</button> · <button class="link-btn" data-action="auth-back">Back</button></p>`;
    } else if (auth.stage === "totp") {
      body.innerHTML = `<h2 style="margin-top:18px">Two-factor code</h2><p class="muted small">Open your authenticator app and enter the 6-digit code for LokaChat.</p>
        ${err}<form data-form="totp"><input class="otp-input" name="code" inputmode="numeric" pattern="\\d{6}" maxlength="6" placeholder="------" autocomplete="one-time-code" required autofocus>
        <button class="btn primary block" type="submit">Verify</button></form>
        <p class="small muted" style="margin-top:14px"><button class="link-btn" data-action="auth-back">Back</button></p>`;
    } else if (auth.tab === "in") {
      body.innerHTML = `<div class="auth-tabs"><button class="on">Sign in</button><button data-action="auth-tab" data-tab="up">Create account</button></div>${err}
        <form data-form="login">${field("Username or email", "identifier", "text", 'autocomplete="username" autofocus')}${field("Password", "password", "password", 'autocomplete="current-password"')}
        <button class="btn primary block" type="submit">Sign in</button></form>`;
    } else {
      body.innerHTML = `<div class="auth-tabs"><button data-action="auth-tab" data-tab="in">Sign in</button><button class="on">Create account</button></div>${err}
        <form data-form="signup">${field("Username", "username", "text", 'autocomplete="username" pattern="[A-Za-z0-9_.]{3,20}" title="3-20 letters, numbers, . or _" autofocus')}
        ${field("Email or phone", "contact", "text", 'autocomplete="email" placeholder="you@example.com or +91..."')}
        ${field("Display name", "display_name", "text", 'maxlength="40" autocomplete="name"')}
        ${field("Password (min 8 characters)", "password", "password", 'minlength="8" maxlength="72" autocomplete="new-password"')}
        <button class="btn primary block" type="submit">Create account</button>
        <p class="muted small center" style="margin:0">We'll send a 6-digit code to verify it's you.</p></form>`;
    }
  }
  App.actions["auth-tab"] = (el) => { auth = { tab: el.dataset.tab, stage: "form", ctx: {}, pw: null }; renderAuth(); };
  App.actions["auth-back"] = () => { auth = { tab: auth.tab, stage: "form", ctx: {}, pw: null }; renderAuth(); };

  const gotoOtp = (res, extra) => { auth.stage = "otp"; auth.ctx = { ...extra, destination: res.destination, expires_in: res.expires_in, dev_otp: res.dev_otp }; renderAuth(); };
  const fail = (e) => renderAuth(e.message || "Something went wrong");

  App.forms.signup = async (form, data) => {
    auth.pw = data.password;
    try {
      const res = await api.post("/auth/signup", { username: data.username.trim(), contact: data.contact.trim(), display_name: data.display_name.trim(), password: data.password }, { auth: false });
      gotoOtp(res, { identifier: res.username, kind: "signup" });
    } catch (e) { fail(e); }
  };
  App.forms.login = async (form, data) => {
    auth.pw = data.password;
    try {
      const res = await api.post("/auth/login", { identifier: data.identifier.trim(), password: data.password }, { auth: false });
      if (res.step === "totp") { auth.stage = "totp"; auth.ctx = { mfa_token: res.mfa_token }; renderAuth(); }
      else if (res.step === "otp") gotoOtp(res, { mfa_token: res.mfa_token, kind: "login" });
      else gotoOtp(res, { identifier: res.identifier, kind: "signup" });
    } catch (e) { fail(e); }
  };
  App.forms.otp = async (form, data) => {
    const c = auth.ctx;
    try {
      const body = c.mfa_token ? { code: data.code, mfa_token: c.mfa_token } : { code: data.code, identifier: c.identifier };
      await startSession(await api.post("/auth/verify-otp", body, { auth: false }));
    } catch (e) { fail(e); }
  };
  App.forms.totp = async (form, data) => {
    try { await startSession(await api.post("/auth/2fa/verify", { code: data.code, mfa_token: auth.ctx.mfa_token }, { auth: false })); }
    catch (e) { fail(e); }
  };
  App.actions["auth-resend"] = async (el) => {
    await App.busy(el, async () => {
      const c = auth.ctx;
      const res = await api.post("/auth/resend-otp", c.mfa_token ? { mfa_token: c.mfa_token } : { identifier: c.identifier }, { auth: false });
      auth.ctx = { ...c, destination: res.destination || c.destination, expires_in: res.expires_in, dev_otp: res.dev_otp };
      renderAuth(); toast("New code sent");
    });
  };

  // ============================================================ session
  async function startSession(res) {
    auth.pw = null;
    api.setToken(res.token);
    await enterApp(res.user);
  }

  async function enterApp(user) {
    S.user = user;
    show("#app");
    App.applyPin();
    App.setRailAvatar();
    document.body.classList.add("in-app");
    // paint the shell first (instant), then load the data
    if (!location.hash || location.hash === "#") location.hash = "#/home";
    App.route();
    api.subscribe(user.id, {
      onMessage: (m) => App.chatRealtime.onMessage(m),
      onMembership: () => App.chatRealtime.onMembership(),
      onReaction: (r) => App.chatRealtime.onReaction(r),
      onMessageEdit: (m) => App.chatRealtime.onEdit && App.chatRealtime.onEdit(m),
      onMessageDelete: (m) => App.chatRealtime.onDelete && App.chatRealtime.onDelete(m),
      onPost: (p) => { if (p.author_id !== S.user.id) { App.cacheDrop("feed:recommended", "feed:clips"); } },
    });
    // prefetch everything so tab switches never wait on the network
    api.get("/users/following").then((r) => { S.following = new Set(r.users.map((u) => u.username)); }).catch(() => {});
    App.prefetchHome(); if (App.prefetchReels) App.prefetchReels();
    App.loadChats().catch(() => {}); App.loadNotes().catch(() => {});
    App.startNotifPolling();
  }

  function logout(message) {
    api.unsubscribe();
    api.setToken(null);
    App.stopNotifPolling();
    if (App.lockVault) App.lockVault();
    if (App.resetChat) App.resetChat();
    App.closeAllModals(); App.closeDrawers();
    Object.assign(S, { user: null, chats: [], unread: {}, cache: {}, following: new Set(), route: null });
    S.postCache.clear();
    $("#view").innerHTML = "";
    document.body.classList.remove("in-app");
    location.hash = "";
    auth = { tab: "in", stage: "form", ctx: {}, pw: null };
    show("#auth");
    renderAuth();
    if (message) toast(message, "err");
  }
  App.actions.logout = async () => {
    if (await App.confirm("Log out?", "You'll need your password and a code to sign back in.", "Log out", true)) logout();
  };
  api.onUnauthorized(() => { if (S.user) logout("Your session expired - please sign in again."); });

  // ---------- header / shell wiring ----------
  App.onRouted = (name) => {
    const pill = $("#msg-pill-wrap");
    if (pill) pill.classList.toggle("gone", name === "messages");
    App.closeMenus();
  };

  // ============================================================ boot
  async function boot() {
    const splashDone = new Promise((r) => setTimeout(r, 1800));
    let next = "auth", user = null, err = null;

    const missing = [];
    const cfg = window.LOKA_CONFIG || {};
    if (!cfg.SUPABASE_URL) missing.push("SUPABASE_URL");
    if (!cfg.SUPABASE_ANON_KEY) missing.push("SUPABASE_ANON_KEY");
    if (!cfg.API_URL) missing.push("API_URL");
    else if (api.isNative && api.isNative() && !api.apiRoot()) missing.push("MOBILE_API_URL (full https://YOUR-APP.vercel.app/api URL, needed inside the mobile app)");
    if (!window.supabase) missing.push("Supabase SDK failed to load (check your internet connection)");

    if (missing.length) next = "setup";
    else if (api.hasToken()) {
      try { user = await api.get("/auth/me"); next = "app"; }
      catch (e) {
        if (e.status === 401) api.setToken(null);
        else err = e.message;
      }
    }
    await splashDone;
    $("#splash").hidden = true;
    if (next === "setup") {
      $("#setup-missing").innerHTML = missing.map((m) => `<li>${esc(m)}</li>`).join("");
      show("#setup");
    } else if (next === "app") await enterApp(user);
    else { show("#auth"); renderAuth(); if (err) toast(err, "err"); }
  }

  // PWA: register the service worker (skipped inside the Capacitor app and on non-https/localhost dev)
  function registerSW() {
    try {
      if (!("serviceWorker" in navigator) || (api.isNative && api.isNative())) return;
      if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return;
      const hadController = !!navigator.serviceWorker.controller;
      let reloaded = false;
      // a new service worker (new app version) just took over: reload once so the page runs the fresh JS
      navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
      window.addEventListener("load", () => navigator.serviceWorker.register("service-worker.js").catch(() => {}));
    } catch (e) { /* ignore */ }
  }
  registerSW();

  window.addEventListener("DOMContentLoaded", boot);
})();
