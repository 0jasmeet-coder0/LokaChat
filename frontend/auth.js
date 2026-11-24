/* =====================================================================
   LokaChat - auth.js   (v7 Part 1)
   - "Continue with Google" through Supabase OAuth (PKCE) -> POST /auth/google
   - Onboarding stage for new Google users: choose @username + display name
   - Saved accounts on this device + the Instagram-style "@username v" switcher modal
   Plugs into app.js through App.authDecorate / App.authStages / App.authResume /
   App.oauthPending / App.oauthComplete / App.accounts / App.session / App.auth.
   Load order: ... v6.js -> auth.js -> app.js
   ===================================================================== */
(function () {
  "use strict";
  const { S, $, esc, toast } = App;
  const api = window.LokaApi;

  // ============================================================ saved accounts (this device only)
  // Each entry keeps that account's session token, exactly like the single "loka_token" already does,
  // so switching never asks for a password. A token is dropped when you log out of the account or it expires.
  const KEY = "loka_accounts_v1", MAX = 5;
  const read = () => {
    try { const a = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(a) ? a.filter((x) => x && x.id && x.token) : []; }
    catch (e) { return []; }
  };
  const write = (list) => { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* storage blocked */ } };
  let returnTo = null;   // "Add account" in progress: id of the account to go back to on Cancel

  const accounts = (App.accounts = {
    max: MAX,
    all: read,
    get: (id) => read().find((a) => a.id === id),
    save(user, token) {
      if (!user || !token) return;
      const entry = { id: user.id, username: user.username, display_name: user.display_name, avatar_url: user.avatar_url || null, token };
      let list = read();
      const i = list.findIndex((a) => a.id === user.id);
      if (i >= 0) list[i] = entry; else list.push(entry);
      while (list.length > MAX) { const j = list.findIndex((a) => a.id !== user.id); list.splice(j, 1); }
      write(list);
    },
    /** Called by app.js whenever an account becomes active. */
    sync(user) {
      accounts.save(user, api.getToken());
      returnTo = null;
      accounts.paint();
    },
    remove(id) { write(read().filter((a) => a.id !== id)); },
    /** Show "@username v" in the top bar. */
    paint() {
      const btn = $("#acct-trigger"), name = $("#acct-name");
      if (!btn || !name) return;
      btn.hidden = !S.user;
      if (S.user) name.textContent = S.user.username;
    },
  });

  // ============================================================ Continue with Google
  const PENDING = "loka_oauth_pending";
  const googleOk = () => !!(window.supabase && api.configured() && !api.isNative());   // native (Capacitor) needs a deep link - not in Part 1
  const G_LOGO = '<svg class="g-logo" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

  // A dedicated client: PKCE needs to remember its code verifier across the redirect, which the app's main client
  // (persistSession:false) does not do. It is signed out again as soon as the code has been exchanged.
  let oauthClient = null;
  function oauth() {
    if (!oauthClient) {
      const c = window.LOKA_CONFIG;
      oauthClient = window.supabase.createClient(c.SUPABASE_URL, c.SUPABASE_ANON_KEY, {
        auth: { flowType: "pkce", persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "loka-oauth" },
      });
    }
    return oauthClient;
  }
  const setPending = (on) => { try { on ? localStorage.setItem(PENDING, String(Date.now())) : localStorage.removeItem(PENDING); } catch (e) { /* ignore */ } };

  App.actions["auth-google"] = (el) => App.busy(el, async () => {
    setPending(true);
    const { error } = await oauth().auth.signInWithOAuth({
      provider: "google",
      // select_account: lets people pick a different Google account when adding a second LokaChat account
      options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: "select_account" } },
    });
    if (error) { setPending(false); throw error; }
  });

  /** True when this page load is the redirect back from Google (we started it, and a ?code / #access_token / error is present). */
  App.oauthPending = () => {
    let t = 0;
    try { t = Number(localStorage.getItem(PENDING)) || 0; } catch (e) { /* ignore */ }
    if (!t) return false;
    if (Date.now() - t > 15 * 60 * 1000) { setPending(false); return false; }
    const q = new URLSearchParams(location.search);
    const h = new URLSearchParams(location.hash.replace(/^#/, ""));
    return q.has("code") || q.has("error") || q.has("error_description")
        || h.has("access_token") || h.has("error") || h.has("error_description");
  };

  /** Finish the OAuth redirect: PKCE (?code) is exchanged for a session; the implicit flow (#access_token) is read
   *  straight from the hash. Either way we hand the resulting Supabase access token to our API and return its answer
   *  ({token,user} | {step:"totp",mfa_token} | {step:"setup",...}). */
  App.oauthComplete = async () => {
    const url = new URL(location.href), q = url.searchParams, h = new URLSearchParams(url.hash.replace(/^#/, ""));
    const code = q.get("code");
    const implicitToken = h.get("access_token");
    const problem = q.get("error_description") || q.get("error") || h.get("error_description") || h.get("error");
    setPending(false);
    // Strip the one-time OAuth params from BOTH the query and the hash before doing anything else.
    ["code", "error", "error_code", "error_description", "state"].forEach((k) => q.delete(k));
    const clean = url.pathname + url.search;   // the hash (tokens/errors) is always dropped
    try { history.replaceState(null, "", clean); } catch (e) { /* ignore */ }

    let accessToken = implicitToken;
    if (!accessToken && code) {
      const c = oauth();
      const { data, error } = await c.auth.exchangeCodeForSession(code);
      if (error || !data || !data.session) throw new Error((error && error.message) || "Google sign-in failed");
      accessToken = data.session.access_token;
      try { await c.auth.signOut({ scope: "local" }); } catch (e) { /* the token is only needed once */ }
    }
    if (!accessToken) throw new Error((problem || "Google sign-in was cancelled").replace(/\+/g, " "));
    return api.post("/auth/google", { access_token: accessToken }, { auth: false });
  };

  /** app.js boot: continue the sign-in with the step the API asked for. */
  App.authResume = (res) => {
    if (res.step === "totp") App.auth.setStage("totp", { mfa_token: res.mfa_token });
    else if (res.step === "setup") {
      App.auth.setStage("gsetup", {
        setup_token: res.setup_token, username: res.suggested_username || "", display_name: res.display_name || "",
        avatar_url: res.avatar_url || null, destination: res.destination || "",
      });
    }
  };

  // ============================================================ sign-in screen extras
  /** Appended under the Sign in / Create account forms. */
  App.authDecorate = (body, tab) => {
    let html = "";
    if (googleOk()) {
      html += `<div class="auth-or"><span>or</span></div>
        <button class="btn block g-btn" type="button" data-action="auth-google">${G_LOGO}<span>Continue with Google</span></button>`;
    }
    const saved = accounts.all();
    if (tab === "in" && saved.length) {
      html += `<div class="auth-saved"><p class="muted small">Saved on this device</p><ul class="sw-list">${saved.map((a) => `<li>
        <button class="sw-row" type="button" data-action="acct-switch" data-id="${esc(a.id)}">${App.avatar(a, "m")}
        <span class="sw-names"><b>@${esc(a.username)}</b><small>${esc(a.display_name)}</small></span><span class="sw-go">Continue</span></button></li>`).join("")}</ul></div>`;
    }
    if (returnTo && accounts.get(returnTo)) html += `<p class="small muted center" style="margin-top:14px"><button class="link-btn" data-action="acct-cancel-add">Cancel - go back to my account</button></p>`;
    if (html) body.insertAdjacentHTML("beforeend", html);
  };

  // ---------- onboarding stage for brand-new Google users ----------
  App.authStages = {
    gsetup: (a, err) => {
      const c = a.ctx;
      return `<h2 style="margin-top:18px">Finish your profile</h2>
        <p class="muted small">Signed in with Google as <b>${esc(c.destination)}</b>. Choose how people will find you on LokaChat.</p>
        <div class="gs-av">${App.avatar({ avatar_url: c.avatar_url, display_name: c.display_name, username: c.username }, "m")}</div>${err}
        <form data-form="gsetup">
          <div class="field"><label>Display name</label><input name="display_name" type="text" maxlength="40" value="${esc(c.display_name)}" autocomplete="name" required></div>
          <div class="field"><label>Username</label><div class="at-input"><span>@</span>
            <input id="gs-username" name="username" type="text" value="${esc(c.username)}" minlength="3" maxlength="20" pattern="[a-z0-9_.]{3,20}" title="3-20 letters, numbers, . or _" autocapitalize="none" autocomplete="off" spellcheck="false" required></div>
            <small class="gs-hint" id="gs-hint"></small></div>
          <button class="btn primary block" type="submit">Continue</button></form>
        <p class="small muted" style="margin-top:14px"><button class="link-btn" data-action="auth-back">Cancel</button></p>`;
    },
  };
  App.forms.gsetup = async (form, data) => {
    const c = App.auth.state.ctx;
    c.username = data.username.trim(); c.display_name = data.display_name.trim();   // survive an error re-render
    try {
      await App.session.start(await api.post("/auth/google/complete", { setup_token: c.setup_token, username: c.username, display_name: c.display_name }, { auth: false }));
    } catch (e) { App.auth.render(e.message || "Something went wrong"); }
  };

  // live @username rules + availability
  const checkName = App.debounce(async (input) => {
    const hint = $("#gs-hint");
    if (!hint) return;
    const v = input.value;
    if (v.length < 3) { hint.textContent = ""; hint.className = "gs-hint"; return; }
    try {
      const r = await api.get("/auth/username-available?username=" + encodeURIComponent(v));
      if (input.value !== v) return;                                   // typed on since
      hint.textContent = r.available ? "@" + r.username + " is available" : r.reason;
      hint.className = "gs-hint " + (r.available ? "ok" : "bad");
    } catch (e) { hint.textContent = ""; hint.className = "gs-hint"; }
  }, 350);
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (!t || t.id !== "gs-username") return;
    const clean = t.value.toLowerCase().replace(/^@/, "").replace(/[^a-z0-9_.]/g, "");
    if (clean !== t.value) t.value = clean;
    checkName(t);
  });

  // ============================================================ multi-account switcher (@username v)
  function openSwitcher() {
    if (!S.user) return;
    accounts.save(S.user, api.getToken());                              // refresh name/avatar of the active account
    const list = accounts.all();
    const rowsHtml = list.map((a) => {
      const on = a.id === S.user.id;
      return `<li class="sw-item"><button class="sw-row ${on ? "on" : ""}" type="button" data-action="acct-switch" data-id="${esc(a.id)}">${App.avatar(a, "m")}
        <span class="sw-names"><b>@${esc(a.username)}</b><small>${esc(a.display_name)}</small></span>${on ? `<span class="sw-check">${App.icon("check")}</span>` : ""}</button>
        ${on ? "" : `<button class="icon-btn sw-x" type="button" data-action="acct-remove" data-id="${esc(a.id)}" aria-label="Remove @${esc(a.username)} from this device">${App.icon("close")}</button>`}</li>`;
    }).join("");
    App.modal(`<h3 class="sw-title">Switch account</h3><ul class="sw-list">${rowsHtml}</ul>
      <button class="sw-add" type="button" data-action="acct-add"><span class="sw-plus">${App.icon("add")}</span>Add account</button>
      <p class="muted small sw-note">Up to ${MAX} accounts on this device. Log out of an account to forget it.</p>`, { cls: "switcher", noFocus: true });
  }
  App.actions["open-switcher"] = () => { App.closeMenus(); openSwitcher(); };

  /** Verify the saved token first (no side effects), then tear the old session down and enter the new one. */
  async function switchTo(id) {
    const a = accounts.get(id);
    if (!a) throw new Error("That account is no longer saved");
    let res;
    try { res = await fetch(api.apiRoot().replace(/\/+$/, "") + "/auth/me", { headers: { Authorization: "Bearer " + a.token } }); }
    catch (e) { throw new Error("Can't reach the server. Check your connection and try again."); }
    if (res.status === 401) { accounts.remove(id); throw new Error("Session expired for @" + a.username + ". Add the account again to sign in."); }
    if (!res.ok) throw new Error("Couldn't switch account (" + res.status + ")");
    const user = await res.json();
    App.closeAllModals();
    if (S.user) App.session.reset();
    api.setToken(a.token);
    await App.session.enter(user);
  }
  async function switchAction(id, btn) {
    if (S.user && S.user.id === id) { App.closeAllModals(); return; }
    if (btn) btn.disabled = true;
    try { await switchTo(id); }
    catch (e) {
      App.fail(e); if (btn) btn.disabled = false;
      if (App.topModal()) { App.closeAllModals(); openSwitcher(); } else if (!S.user) App.auth.render();   // list may have lost an expired account
    }
  }
  App.actions["acct-switch"] = (el) => switchAction(el.dataset.id, el);
  App.actions["acct-remove"] = async (el) => {
    const a = accounts.get(el.dataset.id);
    if (!a) return;
    if (!(await App.confirm("Remove account?", "@" + a.username + " will be removed from this device. You can sign in to it again any time.", "Remove", true))) return;
    accounts.remove(a.id);
    App.closeAllModals(); openSwitcher();
  };
  App.actions["acct-add"] = () => {
    if (accounts.all().length >= MAX) { toast("You can add up to " + MAX + " accounts on this device", "err"); return; }
    const current = S.user && S.user.id;
    App.closeAllModals();
    App.session.reset();                                               // keeps every saved token
    returnTo = current;
    App.auth.show("#auth");
    App.auth.setStage("form", {});
  };
  App.actions["acct-cancel-add"] = (el) => {
    const id = returnTo;
    returnTo = null;
    if (id) switchAction(id, el);
  };
})();
