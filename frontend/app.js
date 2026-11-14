/* =====================================================================
   LokaChat - app.js
   Boot sequence, Sign in / Create account gate (password + 6-digit OTP or
   authenticator code), session handling, logout and realtime wiring.
   ===================================================================== */
(function () {
  "use strict";
  const { S, $, esc, icon, avatar, toast } = App;
  const api = window.LokaApi, C = window.LokaCrypto;

  // ============================================================ screens
  const show = (id) => {
    ["#splash", "#setup", "#auth", "#app"].forEach((s) => { const el = $(s); if (el) el.hidden = s !== id; });
  };
  App.setRailAvatar = () => { $("#rail-avatar").innerHTML = avatar(S.user, "xs"); };

  // ============================================================ auth gate
  let auth = { tab: "in", stage: "form", ctx: {} }; // stage: form | otp | totp

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
  App.actions["auth-tab"] = (el) => { auth = { tab: el.dataset.tab, stage: "form", ctx: {} }; renderAuth(); };
  App.actions["auth-back"] = () => { auth = { tab: auth.tab, stage: "form", ctx: {} }; renderAuth(); };

  const gotoOtp = (res, extra) => { auth.stage = "otp"; auth.ctx = { ...extra, destination: res.destination, expires_in: res.expires_in, dev_otp: res.dev_otp }; renderAuth(); };
  const fail = (e) => renderAuth(e.message || "Something went wrong");

  App.forms.signup = async (form, data) => {
    try {
      const res = await api.post("/auth/signup", { username: data.username.trim(), contact: data.contact.trim(), display_name: data.display_name.trim(), password: data.password }, { auth: false });
      gotoOtp(res, { identifier: res.username, kind: "signup" });
    } catch (e) { fail(e); }
  };
  App.forms.login = async (form, data) => {
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
    api.setToken(res.token);
    await enterApp(res.user);
  }

  async function syncIdentity(user) {
    try {
      const id = await C.ensureIdentity(user.id);
      S.identity = id;
      let server = null;
      try { server = user.public_key ? JSON.parse(user.public_key) : null; } catch (e) { /* ignore */ }
      if (!server || server.x !== id.publicJwk.x || server.y !== id.publicJwk.y) {
        await api.put("/users/me/key", { public_key: JSON.stringify(id.publicJwk) });
        if (server) toast("New device: older encrypted chats can only be read on the device that created them.", "err");
      }
    } catch (e) {
      S.identity = null; // e.g. IndexedDB blocked in private mode - chat creation will explain
    }
  }

  async function enterApp(user) {
    S.user = user;
    show("#app");
    App.applyPin();
    App.setRailAvatar();
    await syncIdentity(user);
    api.subscribe(user.id, {
      onMessage: (m) => App.chatRealtime.onMessage(m),
      onMembership: () => App.chatRealtime.onMembership(),
      onPost: (p) => { if (p.author_id !== S.user.id && App.parseHash().name === "home") toast("New posts are available - reload the feed"); },
    });
    App.loadChats().then(() => App.updateBadge()).catch(() => {});
    if (!location.hash || location.hash === "#") location.hash = "#/home";
    App.route();
  }

  function logout(message) {
    api.unsubscribe();
    api.setToken(null);
    if (App.lockVault) App.lockVault();
    if (App.resetChat) App.resetChat();
    App.closeAllModals();
    Object.assign(S, { user: null, identity: null, chats: [], unread: {} });
    S.postCache.clear();
    location.hash = "";
    auth = { tab: "in", stage: "form", ctx: {} };
    show("#auth");
    renderAuth();
    if (message) toast(message, "err");
  }
  App.actions.logout = async (el) => {
    if (await App.confirm("Log out?", "You'll need your password and a code to sign back in.", "Log out", true)) logout();
  };
  api.onUnauthorized(() => { if (S.user) logout("Your session expired - please sign in again."); });

  // ============================================================ boot
  async function boot() {
    const splashDone = new Promise((r) => setTimeout(r, 1800));
    let next = "auth", user = null, err = null;

    const missing = [];
    const cfg = window.LOKA_CONFIG || {};
    if (!cfg.SUPABASE_URL) missing.push("SUPABASE_URL");
    if (!cfg.SUPABASE_ANON_KEY) missing.push("SUPABASE_ANON_KEY");
    if (!cfg.API_URL) missing.push("API_URL");
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

  window.addEventListener("DOMContentLoaded", boot);
})();
