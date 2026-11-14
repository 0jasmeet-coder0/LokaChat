/* =====================================================================
   LokaChat - you.js
   "You" tab: profile + edit, uploads, watch history, security (account 2FA
   backed by the API) and the local authenticator vault (sealed with a passphrase,
   stored only in this browser). Log out lives here too.
   ===================================================================== */
(function () {
  "use strict";
  const { S, $, $$, esc, icon, avatar, toast, fail, modal } = App;
  const api = window.LokaApi, C = window.LokaCrypto;

  const vaultKey = () => "loka_vault_" + S.user.id;
  let vault = null; // { key, salt, data:{entries:[]} } while unlocked (memory only)
  const readBlob = () => { try { return JSON.parse(localStorage.getItem(vaultKey()) || "null"); } catch (e) { return null; } };
  const saveVault = async () => localStorage.setItem(vaultKey(), JSON.stringify(await C.sealJson(vault.key, vault.salt, vault.data)));
  App.lockVault = () => { vault = null; };

  // ============================================================ route
  App.routes.you = async (ctx) => {
    const u = S.user;
    ctx.view.innerHTML = `<div class="page" style="max-width:900px">
      <div class="profile-head">${avatar(u, "xl")}<div class="grow"><h2>${esc(u.display_name)}</h2><div class="muted">@${esc(u.username)} · ${esc(u.contact)}</div>
        <div class="stats"><div><b id="st-posts">${u.posts}</b><span class="muted small">posts</span></div><div><b>${u.followers}</b><span class="muted small">followers</span></div><div><b>${u.following}</b><span class="muted small">following</span></div></div>
        ${u.bio ? `<p style="white-space:pre-wrap;margin:4px 0 10px">${esc(u.bio)}</p>` : ""}
        <div class="row" style="flex-wrap:wrap"><button class="btn sm" data-action="edit-profile">Edit profile</button>
        <button class="btn sm danger" data-action="logout">${icon("logout")}Log out</button></div></div></div>
      <div class="tabs" id="you-tabs">${[["uploads", "My uploads"], ["history", "Watch history"], ["security", "Security"], ["vault", "Authenticator vault"]]
        .map(([k, l]) => `<button data-action="you-tab" data-tab="${k}" class="${S.youTab === k ? "on" : ""}">${l}</button>`).join("")}</div>
      <div id="you-body"><div class="spinner"></div></div></div>`;
    await renderTab(ctx);
  };

  async function renderTab(ctx) {
    const body = $("#you-body");
    if (!body) return;
    const stale = () => (ctx && ctx.stale && ctx.stale()) || !$("#you-body");
    if (S.youTab === "uploads") {
      const { posts } = await api.get("/posts/feed?tab=mine&limit=60");
      if (stale()) return;
      posts.forEach((p) => S.postCache.set(p.id, p));
      const st = $("#st-posts"); if (st) st.textContent = posts.length;
      body.innerHTML = posts.length ? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr))">${posts.map((p) => `<div class="vcard" data-action="open-post" data-id="${esc(p.id)}">
        <div class="thumb">${p.poster_url || p.type === "photo" ? `<img src="${esc(p.poster_url || p.media_url)}" alt="" loading="lazy">` : ""}
        <span class="kind">${p.type === "story" ? "Story" : p.type === "clip" ? "Clip" : p.type === "photo" ? "Photo" : "Video"}</span></div>
        <div class="vtitle" style="padding-top:6px">${esc(p.title || p.caption || "Story")}</div>
        <div class="muted small">${App.num(p.views)} views · ${p.type === "story" ? "expires " + new Date(p.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : App.timeAgo(p.created_at)}</div></div>`).join("")}</div>`
        : App.emptyBox("plus", "Nothing posted yet", "Videos, clips, photos and stories you upload live here.", `<a class="btn primary" href="#/post">Create your first post</a>`);
    } else if (S.youTab === "history") {
      const { items } = await api.get("/history");
      if (stale()) return;
      items.forEach((i) => S.postCache.set(i.post.id, i.post));
      body.innerHTML = items.length ? `<div class="list-card card">${items.map((i) => `<div class="user-row" data-action="open-post" data-id="${esc(i.post.id)}">
        <div class="thumb" style="width:120px;flex:none;border-radius:10px">${i.post.poster_url || i.post.type === "photo" ? `<img src="${esc(i.post.poster_url || i.post.media_url)}" alt="">` : ""}</div>
        <div class="grow"><div class="vtitle">${esc(i.post.title || "Story")}</div><div class="muted small">${esc(i.post.author.display_name)} · watched ${App.timeAgo(i.watched_at)}</div>
        ${i.duration ? `<div style="height:3px;background:var(--border-subtle);border-radius:2px;margin-top:6px"><div style="height:100%;width:${Math.min(100, (i.position / i.duration) * 100)}%;background:var(--accent-blue);border-radius:2px"></div></div>` : ""}</div></div>`).join("")}</div>`
        : App.emptyBox("eye", "No watch history yet", "Videos you watch in the player are logged here.");
    } else if (S.youTab === "security") renderSecurity(body);
    else renderVault(body, ctx);
  }
  App.actions["you-tab"] = (el) => {
    S.youTab = el.dataset.tab;
    $$("#you-tabs button").forEach((b) => b.classList.toggle("on", b === el));
    App.leaveHooks.splice(0).forEach((h) => h());
    $("#you-body").innerHTML = '<div class="spinner"></div>';
    renderTab(null).catch(fail);
  };

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
    S.user = await api.patch("/users/me", body);
    App.setRailAvatar();
    App.closeAllModals();
    toast("Profile updated");
    App.route();
  };

  // ============================================================ security (account 2FA)
  function renderSecurity(body) {
    const u = S.user;
    body.innerHTML = `<div class="card section"><div class="row"><span style="color:var(--accent-blue)">${icon("shield")}</span><h3 class="grow" style="margin:0">Two-factor authentication</h3>
      <b class="${u.totp_enabled ? "" : "muted"}" style="${u.totp_enabled ? "color:var(--accent-blue)" : ""}">${u.totp_enabled ? "On" : "Off"}</b></div>
      <p class="muted">${u.totp_enabled ? "Sign-in asks for a 6-digit code from your authenticator app." : "Sign-in currently sends a 6-digit code to " + esc(u.contact) + ". Turn on 2FA to use an authenticator app (RFC 6238) instead."}</p>
      ${u.totp_enabled ? `<button class="btn danger" data-action="2fa-disable">Turn off 2FA</button>` : `<button class="btn primary" data-action="2fa-setup">Set up authenticator 2FA</button>`}</div>
      <div class="card section"><div class="row"><span style="color:var(--accent-blue)">${icon("lock")}</span><h3 style="margin:0">End-to-end encryption</h3></div>
      <p class="muted">${S.identity ? "This device holds your private chat key. Messages are encrypted before they leave your browser; the server only sees ciphertext." : "Encryption keys aren't available in this browser mode, so chats can't be opened."}
      Signing in on a new device creates a new key - older chats stay readable only on the device that created them.</p></div>
      <div class="card section"><div class="row"><h3 class="grow" style="margin:0">Session</h3><button class="btn danger" data-action="logout">${icon("logout")}Log out</button></div></div>`;
  }

  App.actions["2fa-setup"] = async (el) => {
    await App.busy(el, async () => {
      const r = await api.post("/auth/2fa/setup", {});
      const grouped = r.secret.replace(/(.{4})/g, "$1 ").trim();
      modal(`<h3>Set up authenticator</h3><p class="muted small">Add this key to Google Authenticator, Authy, 1Password or the Vault tab here, then enter the 6-digit code it shows.</p>
        <div class="secret-box">${esc(grouped)}</div>
        <div class="row" style="margin:10px 0;flex-wrap:wrap"><button class="btn sm" data-action="copy" data-text="${esc(r.secret)}">${icon("copy")}Copy key</button>
        <button class="btn sm" data-action="copy" data-text="${esc(r.otpauth_uri)}">Copy otpauth link</button>
        <button class="btn sm" data-action="2fa-to-vault" data-uri="${esc(r.otpauth_uri)}">Add to my vault</button></div>
        <form data-form="2fa-verify"><div class="field"><label>6-digit code</label><input class="otp-input" name="code" inputmode="numeric" pattern="\\d{6}" maxlength="6" required autocomplete="one-time-code"></div>
        <div class="modal-actions"><button class="btn primary" type="submit">Turn on 2FA</button></div></form>`);
    });
  };
  App.forms["2fa-verify"] = async (form, data) => {
    await api.post("/auth/2fa/verify", { code: data.code });
    S.user.totp_enabled = true;
    App.closeAllModals(); toast("Two-factor authentication is on");
    if ($("#you-body")) renderSecurity($("#you-body"));
  };
  App.actions["2fa-disable"] = () => modal(`<h3>Turn off 2FA</h3><form data-form="2fa-disable">
    <div class="field"><label>Password</label><input type="password" name="password" required autocomplete="current-password"></div>
    <div class="field"><label>Authenticator code</label><input class="otp-input" name="code" inputmode="numeric" maxlength="6" pattern="\\d{6}" required></div>
    <div class="modal-actions"><button class="btn danger" type="submit">Turn off</button></div></form>`);
  App.forms["2fa-disable"] = async (form, data) => {
    await api.post("/auth/2fa/disable", { password: data.password, code: data.code });
    S.user.totp_enabled = false;
    App.closeAllModals(); toast("2FA turned off");
    if ($("#you-body")) renderSecurity($("#you-body"));
  };
  App.actions.copy = async (el) => {
    try { await navigator.clipboard.writeText(el.dataset.text); toast("Copied"); } catch (e) { toast("Couldn't copy - select the text instead", "err"); }
  };
  App.actions["2fa-to-vault"] = async (el) => {
    if (!vault) { toast("Open the Authenticator vault tab and unlock it first", "err"); return; }
    await addEntry(C.parseOtpauth(el.dataset.uri), "LokaChat " + S.user.username);
    toast("Added to your vault");
  };

  // ============================================================ vault
  function renderVault(body, ctx) {
    const blob = readBlob();
    if (!vault) {
      body.innerHTML = `<div class="card section" style="max-width:460px"><div class="row"><span style="color:var(--accent-blue)">${icon("key")}</span><h3 style="margin:0">${blob ? "Unlock vault" : "Create your vault"}</h3></div>
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
        const row = $(`.vault-item[data-eid="${e.id}"]`);
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
    const iv = setInterval(() => { if (!$("#you-body") || !document.body.contains(body)) clearInterval(iv); else tick(); }, 1000);
    App.onLeave(() => clearInterval(iv));
  }

  async function addEntry(p, fallbackName) {
    vault.data.entries.push({
      id: crypto.randomUUID(), name: p.issuer || fallbackName || p.account || "Account", account: p.issuer ? p.account : "",
      secret: p.secret, digits: p.digits, period: p.period,
    });
    await saveVault();
    if ($("#you-body") && S.youTab === "vault") { App.leaveHooks.splice(0).forEach((h) => h()); renderVault($("#you-body")); }
  }

  App.forms["vault-create"] = async (form, data) => {
    if (data.pass !== data.pass2) throw new Error("Passphrases don't match");
    const v = await C.vaultCreate(data.pass, { entries: [] });
    vault = { key: v.key, salt: v.salt, data: { entries: [] } };
    localStorage.setItem(vaultKey(), JSON.stringify(v.blob));
    renderVault($("#you-body"));
  };
  App.forms["vault-unlock"] = async (form, data) => {
    try {
      const o = await C.vaultOpen(data.pass, readBlob());
      vault = { key: o.key, salt: o.salt, data: { entries: Array.isArray(o.data.entries) ? o.data.entries : [] } };
    } catch (e) { throw new Error("Wrong passphrase"); }
    renderVault($("#you-body"));
  };
  App.actions["vault-lock"] = () => { vault = null; App.leaveHooks.splice(0).forEach((h) => h()); renderVault($("#you-body")); };
  App.actions["vault-add"] = () => modal(`<h3>Add account</h3><form data-form="vault-add">
    <div class="field"><label>Name</label><input name="name" placeholder="e.g. GitHub" maxlength="40"></div>
    <div class="field"><label>Secret key or otpauth:// link</label><input name="secret" required autocomplete="off" spellcheck="false" placeholder="JBSWY3DPEHPK3PXP"></div>
    <div class="modal-actions"><button class="btn primary" type="submit">Add</button></div></form>`);
  App.forms["vault-add"] = async (form, data) => {
    let p;
    try { p = C.parseOtpauth(data.secret); await C.totp(p.secret); } catch (e) { throw new Error("That doesn't look like a valid secret key"); }
    if (data.name.trim()) { p.issuer = data.name.trim(); }
    await addEntry(p, "Account");
    App.closeAllModals(); toast("Account added");
  };
  App.actions["vault-del"] = async (el) => {
    const e = vault.data.entries.find((x) => x.id === el.dataset.eid);
    if (!e || !(await App.confirm("Remove " + e.name + "?", "Make sure you can still sign in to that service without this code.", "Remove", true))) return;
    vault.data.entries = vault.data.entries.filter((x) => x.id !== e.id);
    await saveVault();
    App.leaveHooks.splice(0).forEach((h) => h()); renderVault($("#you-body"));
  };
  App.actions["copy-code"] = async (el) => {
    const codes = JSON.parse($("#you-body").dataset.codes || "{}");
    const c = codes[el.dataset.eid];
    if (!c) return;
    try { await navigator.clipboard.writeText(c); toast("Code copied"); } catch (e) { toast("Couldn't copy", "err"); }
  };
})();
