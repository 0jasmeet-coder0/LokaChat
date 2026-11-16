/* =====================================================================
   LokaChat - you.js   (v4)  Privacy-first Instagram + YouTube profile
   Avatar, name, @username, bio, counts (NO email/phone anywhere), Edit profile,
   Watch History carousel, Posts / Reels / Saved grids, and a "Security & 2FA"
   modal (account 2FA, local authenticator vault, encryption keys). Log out.
   ===================================================================== */
(function () {
  "use strict";
  const { S, $, $$, esc, icon, avatar, toast, fail, modal } = App;
  const api = window.LokaApi, C = window.LokaCrypto;

  // ============================================================ profile page
  const tile = (p) => {
    const t = App.postThumb(p);
    return `<div class="gtile" data-action="open-post" data-id="${esc(p.id)}">${t ? `<img src="${esc(t)}" alt="" loading="lazy">` : `<span class="c-ph">${esc((p.caption || p.title || "").slice(0, 80))}</span>`}
      <span class="gk">${icon(p.type === "clip" ? "clips" : p.type === "photo" ? "image" : p.type === "community" ? "users" : "play")}</span>
      ${p.type !== "community" ? `<span class="gv">${icon("eye")}${App.num(p.views)}</span>` : ""}</div>`;
  };
  const histCard = (i) => `<div class="hcard" data-action="open-post" data-id="${esc(i.post.id)}"><div class="thumb">${App.postThumb(i.post) ? `<img src="${esc(App.postThumb(i.post))}" alt="" loading="lazy">` : ""}
    ${i.duration ? `<div class="hprog"><b style="width:${Math.min(100, (i.position / i.duration) * 100)}%"></b></div>` : ""}</div>
    <div class="vtitle">${esc(i.post.title || i.post.caption || "Post")}</div><div class="muted small ellipsis">${esc(i.post.author.display_name)}</div></div>`;

  App.routes.you = {
    mount(pane) {
      pane.innerHTML = `<div class="page profile-page"><div id="you-head"></div>
        <div class="sec-title row"><h3 class="grow">Watch history</h3></div><div class="hscroll hist" id="you-hist"></div>
        <div class="tabs prof-tabs" id="you-tabs">${[["posts", "Posts", "image"], ["reels", "Reels", "clips"], ["saved", "Saved", "bookmark"]].map(([k, l, ic]) => `<button data-action="you-tab" data-tab="${k}">${icon(ic)}${l}</button>`).join("")}</div>
        <div id="you-grid"></div></div>`;
    },
    async show(ctx) {
      paintHead(); paintHistory(); paintGrid();
      // refresh counts + lists in the background
      api.get("/auth/me").then((u) => { if (!S.user) return; S.user = { ...S.user, ...u }; if (!ctx.stale()) paintHead(); }).catch(() => {});
      App.swr("history", async () => (await api.get("/history")).items, () => paintHistory(), { fresh: 30000 }).catch(() => {});
      loadGrid(false);
    },
  };
  App.refreshYou = () => { if (S.route === "you") { paintHead(); paintHistory(); loadGrid(true); } };

  function paintHead() {
    const box = $("#you-head"); if (!box) return;
    const u = S.user;
    box.innerHTML = `<div class="profile-head">${avatar(u, "xl")}<div class="grow"><h2>${esc(u.display_name)}</h2><div class="muted">@${esc(u.username)}</div>
      <div class="stats"><div><b>${App.num(u.posts)}</b><span class="muted small">Posts</span></div><div><b>${App.num(u.followers)}</b><span class="muted small">Followers</span></div><div><b>${App.num(u.following)}</b><span class="muted small">Following</span></div></div>
      ${u.bio ? `<p class="bio">${esc(u.bio)}</p>` : ""}
      <div class="row wrap"><button class="btn sm" data-action="edit-profile">Edit Profile</button><button class="btn sm" data-action="open-security">${icon("shield")}Security & 2FA</button>
        <button class="btn sm danger" data-action="logout">${icon("logout")}Log out</button></div></div></div>`;
  }
  function paintHistory() {
    const box = $("#you-hist"); if (!box) return;
    const items = App.cacheGet("history");
    if (!items) { box.innerHTML = '<div class="spinner"></div>'; return; }
    items.forEach((i) => App.remember([i.post]));
    box.innerHTML = items.length ? items.map(histCard).join("") : `<p class="muted small" style="padding:8px 2px">Videos you watch are logged here.</p>`;
  }
  function paintGrid() {
    $$("#you-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.youTab));
    const box = $("#you-grid"); if (!box) return;
    const mine = App.cacheGet("mine:all"), saved = App.cacheGet("feed:saved");
    const src = S.youTab === "saved" ? saved : mine && (S.youTab === "reels" ? mine.filter((p) => p.type === "clip") : mine.filter((p) => ["video", "photo", "community"].includes(p.type)));
    if (!src) { box.innerHTML = '<div class="spinner"></div>'; return; }
    const none = { posts: ["image", "No posts yet", "Videos, photos and community posts you share live here.", "video"], reels: ["clips", "No reels yet", "Short vertical videos you post appear here.", "clip"], saved: ["bookmark", "Nothing saved", "Tap the bookmark on any post to keep it here.", null] }[S.youTab];
    box.innerHTML = src.length ? `<div class="gridp">${src.map(tile).join("")}</div>` : App.emptyBox(none[0], none[1], none[2], none[3] ? `<button class="btn primary" data-action="create-type" data-type="${none[3]}">Create</button>` : "");
  }
  function loadGrid(force) {
    App.swr("mine:all", async () => App.remember((await api.get("/posts/feed?tab=mine&limit=60")).posts), () => paintGrid(), { force, fresh: 20000 }).catch(() => {});
    App.swr("feed:saved", async () => App.remember((await api.get("/posts/feed?tab=saved&limit=60")).posts), () => paintGrid(), { force, fresh: 20000 }).catch(() => {});
  }
  App.actions["you-tab"] = (el) => { S.youTab = el.dataset.tab; paintGrid(); };

  // ============================================================ profile editing
  App.actions["edit-profile"] = () => {
    const u = S.user;
    modal(`<h3>Edit profile</h3><form data-form="edit-profile">
      <div class="row">${avatar(u, "l")}<div class="field grow"><label>Profile photo</label><input type="file" name="avatar" accept="image/*"></div></div>
      <div class="field"><label>Display name</label><input name="display_name" maxlength="40" required value="${esc(u.display_name)}"></div>
      <div class="field"><label>Bio</label><textarea name="bio" maxlength="160">${esc(u.bio)}</textarea></div>
      <div class="modal-actions"><button class="btn primary" type="submit">Save</button></div></form>`);
  };
  App.forms["edit-profile"] = async (form, data) => {
    const body = { display_name: data.display_name.trim(), bio: (data.bio || "").trim() };
    const file = form.querySelector("input[type=file]").files[0];
    if (file) {
      if (!file.type.startsWith("image/")) throw new Error("Profile photo must be an image");
      if (file.size > 5 * 1024 * 1024) throw new Error("Profile photo must be under 5 MB");
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "jpg";
      body.avatar_path = await api.upload(`${S.user.id}/avatar-${Date.now()}.${ext}`, file);
    }
    const u = await api.patch("/users/me", body);
    S.user = { ...S.user, ...u };
    App.setRailAvatar(); App.closeAllModals(); paintHead(); toast("Profile updated");
  };

  // ============================================================ Security & 2FA modal
  let vault = null; // { key, salt, data:{entries:[]} } while unlocked (memory only)
  let secTab = "2fa", vaultTimer = 0;
  const vaultKey = () => "loka_vault_" + S.user.id;
  const readBlob = () => { try { return JSON.parse(localStorage.getItem(vaultKey()) || "null"); } catch (e) { return null; } };
  const saveVault = async () => localStorage.setItem(vaultKey(), JSON.stringify(await C.sealJson(vault.key, vault.salt, vault.data)));
  App.lockVault = () => { vault = null; clearInterval(vaultTimer); };

  App.actions["open-security"] = (el, ev, tab) => {
    secTab = tab || "2fa";
    modal(`<h3>Security & 2FA</h3><div class="tabs hscroll" id="sec-tabs">${[["2fa", "Two-factor"], ["vault", "Authenticator vault"], ["keys", "Encryption keys"]].map(([k, l]) => `<button data-action="sec-tab" data-tab="${k}">${l}</button>`).join("")}</div>
      <div id="sec-body"></div>`, { cls: "wide", noFocus: true, onClose: () => clearInterval(vaultTimer) });
    renderSec();
  };
  App.openSecurity = (tab) => App.actions["open-security"](null, null, tab);
  App.actions["sec-tab"] = (el) => { secTab = el.dataset.tab; clearInterval(vaultTimer); renderSec(); };
  function renderSec() {
    $$("#sec-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === secTab));
    const body = $("#sec-body"); if (!body) return;
    if (secTab === "2fa") renderTwoFactor(body); else if (secTab === "vault") renderVault(body); else renderKeys(body);
  }

  // ---------- account 2FA (server-backed) ----------
  function renderTwoFactor(body) {
    const u = S.user;
    body.innerHTML = `<div class="card section"><div class="row"><span class="acc">${icon("shield")}</span><h3 class="grow" style="margin:0">Two-factor authentication</h3>
      <b class="${u.totp_enabled ? "acc" : "muted"}">${u.totp_enabled ? "On" : "Off"}</b></div>
      <p class="muted">${u.totp_enabled ? "Sign-in asks for a 6-digit code from your authenticator app." : "Sign-in currently sends a 6-digit code to your email or phone. Turn on 2FA to use an authenticator app (RFC 6238) instead."}</p>
      ${u.totp_enabled ? `<button class="btn danger" data-action="2fa-disable">Turn off 2FA</button>` : `<button class="btn primary" data-action="2fa-setup">Set up authenticator 2FA</button>`}</div>`;
  }
  App.actions["2fa-setup"] = async (el) => {
    await App.busy(el, async () => {
      const r = await api.post("/auth/2fa/setup", {});
      const grouped = r.secret.replace(/(.{4})/g, "$1 ").trim();
      modal(`<h3>Set up authenticator</h3><p class="muted small">Add this key to Google Authenticator, Authy, 1Password or the vault here, then enter the 6-digit code it shows.</p>
        <div class="secret-box">${esc(grouped)}</div>
        <div class="row wrap" style="margin:10px 0"><button class="btn sm" data-action="copy" data-text="${esc(r.secret)}">${icon("copy")}Copy key</button>
        <button class="btn sm" data-action="copy" data-text="${esc(r.otpauth_uri)}">Copy otpauth link</button>
        <button class="btn sm" data-action="2fa-to-vault" data-uri="${esc(r.otpauth_uri)}">Add to my vault</button></div>
        <form data-form="2fa-verify"><div class="field"><label>6-digit code</label><input class="otp-input" name="code" inputmode="numeric" pattern="\\d{6}" maxlength="6" required autocomplete="one-time-code"></div>
        <div class="modal-actions"><button class="btn primary" type="submit">Turn on 2FA</button></div></form>`, { cls: "stack2" });
    });
  };
  App.forms["2fa-verify"] = async (form, data) => {
    await api.post("/auth/2fa/verify", { code: data.code });
    S.user.totp_enabled = true;
    form.closest(".modal-back").remove(); toast("Two-factor authentication is on");
    const sb = $("#sec-body"); if (sb && secTab === "2fa") renderTwoFactor(sb);
  };
  App.actions["2fa-disable"] = () => modal(`<h3>Turn off 2FA</h3><form data-form="2fa-disable">
    <div class="field"><label>Password</label><input type="password" name="password" required autocomplete="current-password"></div>
    <div class="field"><label>Authenticator code</label><input class="otp-input" name="code" inputmode="numeric" maxlength="6" pattern="\\d{6}" required></div>
    <div class="modal-actions"><button class="btn danger" type="submit">Turn off</button></div></form>`, { cls: "stack2" });
  App.forms["2fa-disable"] = async (form, data) => {
    await api.post("/auth/2fa/disable", { password: data.password, code: data.code });
    S.user.totp_enabled = false;
    form.closest(".modal-back").remove(); toast("2FA turned off");
    const sb = $("#sec-body"); if (sb && secTab === "2fa") renderTwoFactor(sb);
  };
  App.actions.copy = async (el) => {
    try { await navigator.clipboard.writeText(el.dataset.text); toast("Copied"); } catch (e) { toast("Couldn't copy - select the text instead", "err"); }
  };
  App.actions["2fa-to-vault"] = async (el) => {
    if (!vault) { toast("Open the Authenticator vault tab and unlock it first", "err"); return; }
    await addEntry(C.parseOtpauth(el.dataset.uri), "LokaChat " + S.user.username);
    toast("Added to your vault");
  };

  // ---------- encryption keys ----------
  function renderKeys(body) {
    const has = !!S.identity, backed = !!S.user.key_backup;
    body.innerHTML = `<div class="card section"><div class="row"><span class="acc">${icon("lock")}</span><h3 style="margin:0">End-to-end encryption</h3></div>
      <p class="muted">Messages are encrypted in your browser; the server only stores ciphertext. Your private key is backed up <b>encrypted with your password</b>, so signing in on a new device restores the same key and every chat stays readable.</p>
      <ul class="keystat"><li><b>This device:</b> ${has ? '<span class="acc">has your key</span>' : '<span class="danger-t">no key yet</span>'}</li>
      <li><b>Password-protected backup:</b> ${backed ? '<span class="acc">saved</span>' : '<span class="danger-t">not saved</span>'}</li></ul>
      <div class="row wrap">${!has && backed ? `<button class="btn primary" data-action="restore-keys">Restore my keys</button>` : ""}
      <button class="btn ${has ? "" : "primary"}" data-action="reset-keys">${backed ? "Create new keys" : has ? "Create backup (new keys)" : "Set up keys"}</button></div>
      <p class="muted small" style="margin-top:10px">Creating new keys replaces the old ones: chats created before can't be opened afterwards.</p></div>
      <div class="card section"><div class="row"><h3 class="grow" style="margin:0">Session</h3><button class="btn danger" data-action="logout">${icon("logout")}Log out</button></div></div>`;
  }

  // ---------- local authenticator vault ----------
  function renderVault(body) {
    const blob = readBlob();
    if (!vault) {
      body.innerHTML = `<div class="card section" style="max-width:460px"><div class="row"><span class="acc">${icon("key")}</span><h3 style="margin:0">${blob ? "Unlock vault" : "Create your vault"}</h3></div>
        <p class="muted small">${blob ? "Enter your vault passphrase." : "A private place for authenticator codes. Entries are encrypted with a passphrase you choose and stored only in this browser. If you forget it, the vault can't be recovered."}</p>
        <form data-form="vault-${blob ? "unlock" : "create"}" style="display:grid;gap:12px">
        <div class="field"><label>Passphrase</label><input type="password" name="pass" minlength="8" required autocomplete="off"></div>
        ${blob ? "" : '<div class="field"><label>Repeat passphrase</label><input type="password" name="pass2" minlength="8" required autocomplete="off"></div>'}
        <button class="btn primary" type="submit">${blob ? "Unlock" : "Create vault"}</button></form></div>`;
      return;
    }
    const es = vault.data.entries;
    body.innerHTML = `<div class="page-head"><div class="muted">${es.length} account${es.length === 1 ? "" : "s"} · codes refresh every 30 s</div>
      <div class="row"><button class="btn sm primary" data-action="vault-add">+ Add account</button><button class="btn sm" data-action="vault-lock">Lock</button></div></div>
      ${es.length ? `<div class="card section list-card" style="padding:4px 18px">${es.map((e) => `<div class="vault-item" data-eid="${esc(e.id)}">
        <div class="grow"><b>${esc(e.name)}</b><div class="muted small">${esc(e.account || "")}</div><div class="vault-code" data-action="copy-code" data-eid="${esc(e.id)}" title="Click to copy">------</div></div>
        <svg class="countdown" viewBox="0 0 36 36"><circle class="bg" cx="18" cy="18" r="15"/><circle class="fg" cx="18" cy="18" r="15" stroke-dasharray="94.25" stroke-dashoffset="0"/></svg>
        <button class="icon-btn" data-action="vault-del" data-eid="${esc(e.id)}" aria-label="Remove">${icon("trash")}</button></div>`).join("")}</div>`
      : App.emptyBox("key", "No accounts yet", "Add a secret key or an otpauth:// link from any service that offers authenticator 2FA.", `<button class="btn primary" data-action="vault-add">+ Add account</button>`)}`;
    const codes = {};
    const tick = async () => {
      for (const e of es) {
        const row = $(`.vault-item[data-eid="${e.id}"]`, body);
        if (!row) continue;
        try {
          const code = await C.totp(e.secret, { digits: e.digits, period: e.period });
          codes[e.id] = code;
          $(".vault-code", row).textContent = code.length === 6 ? code.slice(0, 3) + " " + code.slice(3) : code;
        } catch (err) { $(".vault-code", row).textContent = "invalid"; }
        const left = e.period - (Math.floor(Date.now() / 1000) % e.period);
        $(".fg", row).style.strokeDashoffset = String(94.25 * (1 - left / e.period));
      }
      body.dataset.codes = JSON.stringify(codes);
    };
    tick();
    clearInterval(vaultTimer);
    vaultTimer = setInterval(() => { if (!document.body.contains(body)) clearInterval(vaultTimer); else tick(); }, 1000);
  }
  async function addEntry(p, fallbackName) {
    vault.data.entries.push({ id: crypto.randomUUID(), name: p.issuer || fallbackName || p.account || "Account", account: p.issuer ? p.account : "", secret: p.secret, digits: p.digits, period: p.period });
    await saveVault();
    if ($("#sec-body") && secTab === "vault") renderVault($("#sec-body"));
  }
  App.forms["vault-create"] = async (form, data) => {
    if (data.pass !== data.pass2) throw new Error("Passphrases don't match");
    const v = await C.vaultCreate(data.pass, { entries: [] });
    vault = { key: v.key, salt: v.salt, data: { entries: [] } };
    localStorage.setItem(vaultKey(), JSON.stringify(v.blob));
    renderVault($("#sec-body"));
  };
  App.forms["vault-unlock"] = async (form, data) => {
    try {
      const o = await C.vaultOpen(data.pass, readBlob());
      vault = { key: o.key, salt: o.salt, data: { entries: Array.isArray(o.data.entries) ? o.data.entries : [] } };
    } catch (e) { throw new Error("Wrong passphrase"); }
    renderVault($("#sec-body"));
  };
  App.actions["vault-lock"] = () => { vault = null; clearInterval(vaultTimer); renderVault($("#sec-body")); };
  App.actions["vault-add"] = () => modal(`<h3>Add account</h3><form data-form="vault-add">
    <div class="field"><label>Name</label><input name="name" placeholder="e.g. GitHub" maxlength="40"></div>
    <div class="field"><label>Secret key or otpauth:// link</label><input name="secret" required autocomplete="off" spellcheck="false" placeholder="JBSWY3DPEHPK3PXP"></div>
    <div class="modal-actions"><button class="btn primary" type="submit">Add</button></div></form>`, { cls: "stack2" });
  App.forms["vault-add"] = async (form, data) => {
    let p;
    try { p = C.parseOtpauth(data.secret); await C.totp(p.secret); } catch (e) { throw new Error("That doesn't look like a valid secret key"); }
    if (data.name.trim()) p.issuer = data.name.trim();
    await addEntry(p, "Account");
    form.closest(".modal-back").remove(); toast("Account added");
  };
  App.actions["vault-del"] = async (el) => {
    const e = vault.data.entries.find((x) => x.id === el.dataset.eid);
    if (!e || !(await App.confirm("Remove " + e.name + "?", "Make sure you can still sign in to that service without this code.", "Remove", true))) return;
    vault.data.entries = vault.data.entries.filter((x) => x.id !== e.id);
    await saveVault(); renderVault($("#sec-body"));
  };
  App.actions["copy-code"] = async (el) => {
    const c = JSON.parse($("#sec-body").dataset.codes || "{}")[el.dataset.eid];
    if (!c) return;
    try { await navigator.clipboard.writeText(c); toast("Code copied"); } catch (e) { toast("Couldn't copy", "err"); }
  };
})();
