/* =====================================================================
   LokaChat - chat.js   (v4)  Instagram-style Messages
   - Header @username, search, Notes + Stories row, Chats / Stories / Channels
   - End-to-end encrypted messages: text, GIF/stickers, image/video/audio/voice
     attachments (encrypted in the browser, stored as opaque blobs), replies,
     heart reactions (double-tap), optimistic sending with retry
   - The floating bottom-right Messages pill + quick-chat popover (desktop)
   Encryption is invisible (WhatsApp style): each chat has an AES-256-GCM key wrapped per member with ECDH+HKDF.
   If that key is unavailable (no recipient key, new device, OperationError) the chat silently uses a deterministic
   fallback conversation key (iv marked "f.") so sending never fails and both people can always read.
   Decrypted message text is JSON: {v:1,k:"text|gif|image|video|audio|voice|music",...}
   ===================================================================== */
(function () {
  "use strict";
  const { S, $, $$, esc, icon, avatar, toast, fail, modal } = App;
  const api = window.LokaApi, C = window.LokaCrypto;
  const MAX_ATT = 25 * 1024 * 1024;

  const keyCache = new Map();   // conversation id -> CryptoKey
  const msgStore = new Map();   // conversation id -> [message]
  const previews = new Map();   // conversation id -> preview text
  const attCache = new Map();   // storage path -> blob URL (decrypted attachment)
  let openId = null;            // conversation currently shown in #conv
  let replyTo = null;           // { id, n, p }
  let chatQuery = "";

  // ---------- helpers ----------
  const other = (chat) => chat.members.find((m) => m.id !== S.user.id) || chat.members[0] || {};
  const titleOf = (chat) => (chat.type === "direct" ? other(chat).display_name || "Chat" : chat.title || "Untitled");
  const avatarOf = (chat, size) => (chat.type === "direct" ? avatar(other(chat), size || "m")
    : `<span class="avatar av-${size || "m"}">${chat.type === "channel" ? icon("hash") : icon("users")}</span>`);
  const find = (id) => S.chats.find((c) => c.id === id);
  const canPost = (chat) => chat.type !== "channel" || chat.my_role === "owner" || chat.my_role === "admin";
  const safeJson = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
  const uid = () => crypto.randomUUID();

  // ---------- payloads ----------
  const parsePayload = (text) => {
    if (typeof text === "string" && text.charAt(0) === "{") { const o = safeJson(text); if (o && o.v === 1 && o.k) return o; }
    return { k: "text", t: text };
  };
  const previewOf = (pl) => ({ text: pl.t, music: "🎵 " + (pl.t || "Music"), gif: "GIF", sticker: "Sticker", image: "📷 Photo", video: "🎥 Video", audio: "🎵 Music clip", voice: "🎤 Voice message" }[pl.k] || pl.t || "");

  // ---------- keys + decoding ----------
  /** The ECDH chat key, or null when this chat uses the fallback key / the key can't be unwrapped on this device. */
  async function e2eKey(chat) {
    if (chat.type === "channel" || !chat.wrapped_key || chat.wrapped_key === "fb1") return null;
    if (keyCache.has(chat.id)) return keyCache.get(chat.id);
    if (!S.identity) return null;
    try {
      const fallback = chat.wrapped_by && safeJson(chat.wrapped_by.public_key);
      const key = await C.unwrapChatKey(chat.wrapped_key, S.identity.privateKey, fallback);
      keyCache.set(chat.id, key);
      return key;
    } catch (e) { return null; }   // OperationError etc: never surfaced, we fall back instead
  }
  const fbKey = (chat) => C.fallbackKey(chat.id);
  const isFb = (iv) => typeof iv === "string" && iv.charAt(0) === "f" && iv.charAt(1) === ".";
  /** Key used to SEND in this chat: the ECDH key when it works, else the fallback key. */
  async function sendKey(chat) { const k = await e2eKey(chat); return k ? { key: k, fb: false } : { key: await fbKey(chat), fb: true }; }
  async function decode(chat, m) {
    const base = { ...m, failed: false, reactions: m.reactions || [] };
    if (!m.encrypted) return { ...base, payload: { k: "text", t: m.ciphertext } };
    try {
      const fb = isFb(m.iv), key = fb ? await fbKey(chat) : await e2eKey(chat);
      if (!key) throw new Error("No key for this message");
      return { ...base, payload: parsePayload(await C.decryptText(key, m.ciphertext, fb ? m.iv.slice(2) : m.iv)) };
    } catch (e) { return { ...base, payload: { k: "text", t: "" }, failed: true }; }
  }
  const previewMsg = (chat, m) => (m.sender_id === S.user.id ? "You: " : "") + (m.failed ? "Message from earlier session" : previewOf(m.payload));

  // ---------- data (stale-while-revalidate) ----------
  async function computePreviews(chats) {
    await Promise.all(chats.map(async (c) => { if (c.last_message) previews.set(c.id, previewMsg(c, await decode(c, c.last_message))); else previews.set(c.id, "No messages yet"); }));
  }
  async function loadChats(force) {
    const chats = await App.swr("chats", async () => (await api.get("/chats")).chats, () => {}, { force, fresh: 15000 });
    S.chats = chats;
    await computePreviews(chats);
    paintList(); App.updateBadge();
    return chats;
  }
  App.loadChats = loadChats;

  async function loadMessages(chat, force) {
    const key = "msgs:" + chat.id;
    const messages = await App.swr(key, async () => (await api.get(`/chats/${chat.id}/messages`)).messages, () => {}, { force, fresh: 6000 });
    const list = await Promise.all(messages.map((m) => decode(chat, m)));
    // keep optimistic messages that aren't confirmed yet
    const pending = (msgStore.get(chat.id) || []).filter((m) => m.pending || m.failedSend);
    msgStore.set(chat.id, list.concat(pending.filter((p) => !list.some((x) => x.id === p.id))));
    return msgStore.get(chat.id);
  }
  App.loadNotes = () => App.swr("notes", async () => (await api.get("/notes")).notes, () => {}, { fresh: 30000 });

  // ---------- layout ----------
  App.routes.messages = {
    mount(pane) {
      pane.innerHTML = `<div class="chat-wrap" id="chat-wrap"><div class="chat-list" id="chat-list">
        <div class="chat-head"><h2 class="me-name">@${esc(S.user.username)}</h2><button class="icon-btn" data-action="new-chat" aria-label="New message" title="New message">${icon("edit")}</button></div>
        <div class="chat-search">${icon("search")}<input id="chat-q" type="search" placeholder="Search" autocomplete="off"></div>
        <div class="notes-row hscroll" id="notes-row"></div>
        <div class="tabs hscroll" id="msg-tabs">${["chats", "stories", "channels"].map((t) => `<button data-action="msg-tab" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div>
        <div class="chat-scroll" id="chat-scroll"></div></div>
        <div class="conv" id="conv"></div></div>`;
      $("#chat-q", pane).addEventListener("input", App.debounce((e) => { chatQuery = e.target.value.trim(); paintList(); }, 200));
    },
    async show(ctx) {
      const id = ctx.args[0] || null;
      $("#chat-wrap").classList.toggle("has-conv", !!id);
      if (S.chats.length || App.cacheGet("chats")) { S.chats = App.cacheGet("chats") || S.chats; paintList(); }
      paintNotes();
      App.loadNotes().then(() => { if (!ctx.stale()) paintNotes(); }).catch(() => {});
      App.loadStories().then(() => { if (!ctx.stale()) paintNotes(); }).catch(() => {});
      if (id) { const c = find(id); if (c) openConv(c, ctx); else $("#conv").innerHTML = '<div class="spinner"></div>'; }
      else { openId = null; paintEmptyConv(); }
      await loadChats();
      if (ctx.stale()) return;
      if (id) { const c = find(id); if (!c) { App.go("/messages"); return; } if (openId !== id || !$("#msgs")) openConv(c, ctx); }
    },
  };
  function paintEmptyConv() {
    const c = $("#conv"); if (!c) return;
    c.innerHTML = `<div class="conv-empty"><div>${icon("lock")}<h3>Your messages</h3><p>Chats are end-to-end encrypted.<br>Pick a conversation or send a new message.</p><button class="btn primary" data-action="new-chat">Send message</button></div></div>`;
  }

  // ---------- notes + stories row ----------
  function paintNotes() {
    const row = $("#notes-row"); if (!row) return;
    const notes = App.cacheGet("notes") || [], groups = App.cacheGet("stories") || [];
    const noteOf = (id) => notes.find((n) => n.user.id === id);
    const groupOf = (id) => groups.find((g) => g.author.id === id);
    const people = new Map();
    groups.forEach((g) => people.set(g.author.id, g.author));
    notes.forEach((n) => people.set(n.user.id, n.user));
    people.delete(S.user.id);
    const sorted = Array.from(people.values()).sort((a, b) => {
      const ga = groupOf(a.id), gb = groupOf(b.id);
      return (gb ? !App.groupSeen(gb) : 0) - (ga ? !App.groupSeen(ga) : 0);
    });
    const eq = '<span class="eq"><i></i><i></i><i></i></span>';
    const item = (u, me) => {
      const n = noteOf(u.id), g = groupOf(u.id);
      const trk = n && safeTrack(n.track);
      const bubble = n ? `<span class="note-bubble" data-action="note-view" data-id="${esc(u.id)}">${n.text ? `<span class="nb-t">${esc(n.text)}</span>` : ""}${trk ? `<i class="nb-trk">${eq}${esc(trk.title)}</i>` : n.music ? `<i class="nb-trk">♪ ${esc(n.music)}</i>` : ""}</span>` : me ? `<span class="note-bubble empty" data-action="note-menu">Note...</span>` : "";
      return `<div class="nt-item" data-action="${me ? "note-menu" : g ? "open-story" : n ? "note-view" : "dm"}" data-id="${esc(u.id)}" data-user="${esc(u.username)}">${bubble}
        ${avatar(u, "l", g ? (App.groupSeen(g) ? "seen" : "new") : null, g ? u.id : null)}<span class="nm ellipsis">${me ? "Your note" : esc(u.display_name)}</span></div>`;
    };
    row.innerHTML = item(S.user, true) + sorted.map((u) => item(u, false)).join("");
  }
  // ---------- music (iTunes Search API: free, no key, 30 s .m4a previews) ----------
  const okHost = (u) => { try { const x = new URL(u); const h = x.hostname.toLowerCase(); return x.protocol === "https:" && (h === "apple.com" || h.endsWith(".apple.com") || h.endsWith(".mzstatic.com")); } catch (e) { return false; } };
  /** Validates a track coming from the network (notes, messages): only https Apple preview/artwork hosts are playable. */
  const safeTrack = (t) => (t && t.title && okHost(t.url) ? { title: String(t.title).slice(0, 80), artist: String(t.artist || "").slice(0, 80), url: t.url, cover: t.cover && okHost(t.cover) ? t.cover : "" } : null);
  App.safeTrack = safeTrack;
  async function itunesSearch(q) {
    const res = await fetch("https://itunes.apple.com/search?media=music&entity=song&limit=12&term=" + encodeURIComponent(q));
    if (!res.ok) throw new Error("Music search failed (" + res.status + ")");
    const { results } = await res.json();
    return (results || []).filter((r) => r.previewUrl).map((r) => safeTrack({ title: r.trackName, artist: r.artistName, url: r.previewUrl, cover: (r.artworkUrl100 || "").replace("100x100", "200x200") })).filter(Boolean);
  }
  App.itunesSearch = itunesSearch;
  const eqHtml = '<span class="eq"><i></i><i></i><i></i></span>';
  const coverHtml = (t) => (t.cover ? `<img class="trk-cover" src="${esc(t.cover)}" alt="" loading="lazy">` : `<span class="trk-cover ph">${icon("music")}</span>`);
  function musicCard(pl) {
    const t = safeTrack({ title: pl.t, artist: pl.a, url: pl.u, cover: pl.c });
    if (!t) return `<span class="txt">🎵 ${esc(pl.t || "Music")}</span>`;
    return `<div class="mus-card">${coverHtml(t)}<div class="grow"><b class="ellipsis" style="display:block">${esc(t.title)}</b><div class="muted small ellipsis">${esc(t.artist)}</div><audio controls preload="none" src="${esc(t.url)}"></audio></div></div>`;
  }

  let previewAudio = null, previewIdx = -1;
  const stopPreview = () => { if (previewAudio) { try { previewAudio.pause(); } catch (e) { /* ignore */ } previewAudio = null; } previewIdx = -1; $$(".trk-row.playing").forEach((r) => r.classList.remove("playing")); };
  /** Search box + results. onPick(track) is called when a result's action button is pressed. */
  function wireTrackSearch(root, actionLabel, onPick) {
    const input = $(".trk-q", root), list = $(".trk-list", root);
    let results = [], seq = 0;
    const paint = () => {
      list.innerHTML = results.length ? results.map((t, i) => `<div class="trk-row" data-i="${i}">${coverHtml(t)}<div class="grow"><b class="ellipsis" style="display:block">${esc(t.title)}</b><div class="muted small ellipsis">${esc(t.artist)}</div></div>
        <button type="button" class="btn sm" data-trk="play" aria-label="Preview">${icon("play")}</button><button type="button" class="btn sm primary" data-trk="pick">${esc(actionLabel)}</button></div>`).join("") : '<p class="muted small center" style="padding:14px 0">No songs found.</p>';
    };
    input.addEventListener("input", App.debounce(async () => {
      const q = input.value.trim(), my = ++seq;
      if (q.length < 2) { list.innerHTML = '<p class="muted small">Search for a song to add a 30-second preview.</p>'; return; }
      list.innerHTML = '<div class="spinner"></div>';
      try { const r = await itunesSearch(q); if (my !== seq) return; results = r; paint(); }
      catch (e) { if (my === seq) list.innerHTML = `<p class="muted small center" style="padding:14px 0">${esc(App.errText(e))}</p>`; }
    }, 350));
    list.addEventListener("click", (e) => {
      const b = e.target.closest("[data-trk]"), row = e.target.closest(".trk-row");
      if (!b || !row) return;
      const i = Number(row.dataset.i), t = results[i];
      if (!t) return;
      if (b.dataset.trk === "play") {
        const was = previewIdx === i && previewAudio; stopPreview();
        if (was) return;
        previewAudio = new Audio(t.url); previewIdx = i; row.classList.add("playing");
        previewAudio.addEventListener("ended", stopPreview);
        previewAudio.play().catch(() => { toast("Couldn't play this preview", "err"); stopPreview(); });
      } else { stopPreview(); onPick(t); }
    });
  }
  const trackSearchHtml = () => `<div class="trk-search"><input class="trk-q" type="search" placeholder="Search songs or artists" autocomplete="off"><div class="trk-list"><p class="muted small">Search for a song to add a 30-second preview.</p></div></div>`;

  // send a song in a chat
  App.actions["pick-music"] = () => {
    closeAttMenu();
    const chat = find(openId); if (!chat) return;
    const m = modal(`<h3>Send music</h3>${trackSearchHtml()}`, { cls: "wide", onClose: stopPreview });
    wireTrackSearch(m.el, "Send", (t) => { m.close(); sendPayload(chat, { k: "music", t: t.title, a: t.artist, u: t.url, c: t.cover, ...(replyTo ? { r: replyTo } : {}) }); clearReply(); });
  };

  // ---------- notes (text + optional song) ----------
  let noteTrack = null;
  const noteOf = (id) => (App.cacheGet("notes") || []).find((n) => n.user.id === id);
  const trackChip = () => (noteTrack ? `<div class="trk-chip">${coverHtml(noteTrack)}<div class="grow"><b class="ellipsis" style="display:block">${esc(noteTrack.title)}</b><span class="muted small">${esc(noteTrack.artist)}</span></div>${eqHtml}<button type="button" class="icon-btn" data-action="note-track-clear" aria-label="Remove song">${icon("close")}</button></div>` : "");
  App.actions["note-track-clear"] = () => { noteTrack = null; const c = $("#note-track"); if (c) c.innerHTML = ""; };
  App.actions["note-menu"] = () => {
    const mine = noteOf(S.user.id);
    noteTrack = mine ? safeTrack(mine.track) : null;
    const m = modal(`<h3>${mine ? "Leave a new note" : "New note"}</h3><form data-form="note">
      <div class="field"><label>Share a thought (24h, 60 characters)</label><input name="text" maxlength="60" value="${esc(mine ? mine.text : "")}" placeholder="What's on your mind?" autocomplete="off"></div>
      <div id="note-track">${trackChip()}</div>
      <div class="field"><label>Add a song (optional)</label>${trackSearchHtml()}</div>
      <div class="modal-actions"><button class="btn primary" type="submit">Share</button></div></form>
      <div class="note-alt"><button class="btn block" data-action="add-story">Add to your story</button></div>`, { onClose: stopPreview });
    wireTrackSearch(m.el, "Use", (t) => { noteTrack = t; const c = $("#note-track"); if (c) c.innerHTML = trackChip(); });
  };
  App.forms.note = async (form, data) => {
    const text = (data.text || "").trim();
    if (!text && !noteTrack) throw new Error("Write something or pick a song");
    stopPreview();
    const track = noteTrack;
    const list = (App.cacheGet("notes") || []).filter((n) => n.user.id !== S.user.id);
    list.unshift({ user: { id: S.user.id, username: S.user.username, display_name: S.user.display_name, avatar_url: S.user.avatar_url }, text, music: "", track, created_at: new Date().toISOString() });
    App.cacheSet("notes", list); paintNotes(); App.closeAllModals();
    try { await api.put("/users/me/note", { text, music: "", track }); toast("Note shared"); } catch (e) { App.cacheDrop("notes"); App.loadNotes().then(paintNotes); throw e; }
  };
  App.actions["note-del"] = async () => {
    App.closeAllModals();
    App.cacheSet("notes", (App.cacheGet("notes") || []).filter((n) => n.user.id !== S.user.id)); paintNotes();
    try { await api.del("/users/me/note"); toast("Note deleted"); } catch (e) { fail(e); }
  };
  /** Opens a note: shows it, plays the 30 s preview, and offers reply (friends) or new/delete (own). */
  App.actions["note-view"] = (el, ev) => {
    if (ev) ev.stopPropagation();
    const n = noteOf(el.dataset.id); if (!n) return;
    const mine = n.user.id === S.user.id, t = safeTrack(n.track);
    const m = modal(`<div class="note-card">${avatar(n.user, "l")}<b>${esc(mine ? "Your note" : n.user.display_name)}</b>
      ${n.text ? `<div class="nc-text">${esc(n.text)}</div>` : ""}
      ${t ? `<div class="trk-chip big">${coverHtml(t)}<div class="grow"><b class="ellipsis" style="display:block">${esc(t.title)}</b><span class="muted small">${esc(t.artist)}</span></div>${eqHtml}</div><audio class="nc-audio" controls src="${esc(t.url)}"></audio>`
        : n.music ? `<div class="muted">♪ ${esc(n.music)}</div>` : ""}
      <div class="muted small">${App.timeAgo(n.created_at)}</div>
      ${mine ? `<div class="modal-actions"><button class="btn danger" data-action="note-del">Delete note</button><button class="btn primary" data-action="note-new">Leave a new note</button></div>`
        : `<form data-form="note-reply" data-user="${esc(n.user.username)}"><div class="row"><input name="text" maxlength="500" placeholder="Reply to ${esc(n.user.display_name)}'s note..." autocomplete="off" required><button class="btn primary sm" type="submit">Send message</button></div></form>`}</div>`, { onClose: () => { const a = $(".nc-audio"); if (a) a.pause(); } });
    const a = $(".nc-audio", m.el); if (a) a.play().catch(() => {});
  };
  App.actions["note-new"] = () => { App.closeAllModals(); App.actions["note-menu"](); };
  App.forms["note-reply"] = async (form, data) => {
    const username = form.dataset.user, text = (data.text || "").trim(); if (!text) return;
    const n = (App.cacheGet("notes") || []).find((x) => x.user.username === username);
    const res = await createChat("direct", "", "", [username]);
    await loadChats(true);
    const chat = find(res.id); if (!chat) throw new Error("Couldn't open the chat");
    App.closeAllModals();
    sendPayload(chat, { k: "text", t: text, r: { id: "note", n: n ? n.user.display_name : username, p: "Note: " + ((n && (n.text || (n.track && n.track.title))) || "").slice(0, 70) } });
    toast("Reply sent");
  };

  // ---------- chat theme + details panel ----------
  const THEMES = [["sky", "Classic Sky", "#38BDF8"], ["mono", "Monochrome", "#FFFFFF"], ["indigo", "Midnight Indigo", "linear-gradient(135deg,#6366F1,#4338CA)"], ["rose", "Crimson Rose", "#F43F5E"], ["mint", "Emerald Mint", "#10B981"], ["violet", "Royal Violet", "#A855F7"]];
  const themeKey = (id) => "loka_chat_theme:" + id;
  function getTheme(id) { try { const t = localStorage.getItem(themeKey(id)); return THEMES.some((x) => x[0] === t) ? t : "sky"; } catch (e) { return "sky"; } }
  App.actions["chat-info"] = (el) => {
    const chat = find(el.dataset.id); if (!chat) return;
    const cur = getTheme(chat.id), isDirect = chat.type === "direct", o = other(chat);
    const members = chat.type === "group" ? `<div class="sec-title"><h3>Members</h3></div><div class="list-card">${chat.members.map((u) => `<div class="user-row" data-action="open-profile" data-user="${esc(u.username)}">${avatar(u, "s")}<div class="grow"><b>${esc(u.display_name)}</b><div class="muted small">@${esc(u.username)}</div></div></div>`).join("")}</div>` : "";
    App.drawer(`<h3 class="d-title">Details</h3><div class="d-body">
      <div class="info-head">${avatarOf(chat, "xl")}<b>${esc(titleOf(chat))}</b>${isDirect ? `<span class="muted small">@${esc(o.username || "")}</span>` : ""}</div>
      <div class="sec-title"><h3>Chat theme</h3></div>
      <div class="theme-grid" data-chat="${esc(chat.id)}">${THEMES.map(([k, name, bg]) => `<button class="theme-opt ${k === cur ? "on" : ""}" data-action="set-theme" data-theme="${k}" data-chat="${esc(chat.id)}"><span class="sw" style="background:${bg}"></span><span>${esc(name)}</span></button>`).join("")}</div>
      ${members}
      <button class="btn danger block" style="margin-top:18px" data-action="leave-chat" data-id="${esc(chat.id)}">${icon("logout")}Leave conversation</button></div>`, { cls: "info" });
  };
  App.actions["set-theme"] = (el) => {
    const id = el.dataset.chat, t = el.dataset.theme;
    try { localStorage.setItem(themeKey(id), t); } catch (e) { /* ignore */ }
    if (openId === id) { const c = $("#conv"); if (c) c.dataset.theme = t; }
    $$(".theme-opt", el.closest(".theme-grid")).forEach((b) => b.classList.toggle("on", b === el));
  };

  // ---------- conversation list ----------
  function paintList() {
    $$("#msg-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.msgTab));
    const box = $("#chat-scroll"); if (!box) return;
    const row = (c) => `<div class="chat-item ${c.id === openId ? "on" : ""}" data-action="open-chat" data-id="${esc(c.id)}">${avatarOf(c)}
      <div class="grow"><b class="ellipsis" style="display:block">${esc(titleOf(c))}</b><div class="muted small ellipsis">${esc(previews.get(c.id) || "")}</div></div>
      ${S.unread[c.id] ? `<span class="unread">${S.unread[c.id]}</span>` : ""}</div>`;
    const q = chatQuery.toLowerCase();
    if (S.msgTab === "chats") {
      const chats = S.chats.filter((c) => c.type !== "channel" && (!q || titleOf(c).toLowerCase().includes(q) || (other(c).username || "").includes(q)));
      box.innerHTML = (chats.length ? chats.map(row).join("") : q ? "" : App.emptyBox("chat", "No messages yet", "Send a private message to someone you know.", `<button class="btn primary" data-action="new-chat">Send message</button>`)) + (q.length >= 2 ? '<div id="chat-people"></div>' : "");
      if (q.length >= 2) searchPeople(q);
    } else if (S.msgTab === "channels") {
      const mine = S.chats.filter((c) => c.type === "channel");
      box.innerHTML = (mine.length ? mine.map(row).join("") : "") + `<div class="muted small" style="padding:14px 10px 6px">Discover channels</div><div id="discover"><div class="spinner"></div></div>`;
      loadDiscover();
    } else {
      const groups = App.cacheGet("stories");
      box.innerHTML = groups && groups.length ? `<div class="story-grid" style="padding:10px">${App.storyItemsHtml(groups, true)}</div>`
        : App.emptyBox("clips", "No stories right now", "Stories from people you follow appear here for 24 hours.", `<button class="btn primary" data-action="add-story">Add yours</button>`);
    }
  }
  let peopleSeq = 0;
  async function searchPeople(q) {
    const my = ++peopleSeq;
    try {
      const { users } = await api.get("/users/search?q=" + encodeURIComponent(q));
      const box = $("#chat-people"); if (!box || my !== peopleSeq) return;
      box.innerHTML = users.length ? `<div class="muted small" style="padding:10px 10px 4px">People</div>` + users.filter((u) => !u.is_me).map((u) => `<div class="chat-item" data-action="dm" data-user="${esc(u.username)}">${avatar(u, "m")}<div class="grow"><b>${esc(u.display_name)}</b><div class="muted small">@${esc(u.username)}</div></div><span class="btn sm">Message</span></div>`).join("") : "";
    } catch (e) { /* ignore */ }
  }
  async function loadDiscover() {
    try {
      const { channels } = await api.get("/channels/discover");
      const box = $("#discover"); if (!box) return;
      box.innerHTML = channels.length ? channels.map((c) => `<div class="chat-item"><span class="avatar av-m">${icon("hash")}</span>
        <div class="grow"><b class="ellipsis" style="display:block">${esc(c.title)}</b><div class="muted small ellipsis">${esc(c.description || (c.owner ? "by " + c.owner.display_name : ""))}</div></div>
        ${c.joined ? `<button class="btn sm" data-action="open-chat" data-id="${esc(c.id)}">Open</button>` : `<button class="btn sm primary" data-action="join-channel" data-id="${esc(c.id)}">Join</button>`}</div>`).join("")
        : '<div class="muted small" style="padding:6px 10px">No channels yet - create the first with the new-message button.</div>';
    } catch (e) { fail(e); }
  }

  // ---------- conversation ----------
  function openConv(chat, ctx) {
    openId = chat.id; replyTo = null;
    S.unread[chat.id] = 0; App.updateBadge();
    const conv = $("#conv");
    conv.dataset.theme = getTheme(chat.id);
    conv.innerHTML = `<div class="conv-head"><button class="icon-btn back" data-action="conv-back" aria-label="Back">${icon("back")}</button>${avatarOf(chat)}
      <div class="grow"><b class="ellipsis" style="display:block">${esc(titleOf(chat))}</b>
      <span class="muted small">${chat.type === "direct" ? "@" + esc(other(chat).username || "") : chat.type === "group" ? chat.member_count + " members" : "Public channel"}</span></div>
      ${chat.type === "channel" ? `<span class="e2ee">${icon("hash")}Broadcast</span>` : ""}
      <button class="icon-btn" data-action="chat-info" data-id="${esc(chat.id)}" aria-label="Chat details" title="Details">${icon("info")}</button></div>
      <div class="msgs" id="msgs"></div><div id="reply-bar" hidden></div><div id="picker" hidden></div>
      ${canPost(chat) ? composerHtml(chat) : `<div class="composer muted small" style="justify-content:center">Only channel admins can post here.</div>`}`;
    paintList();
    const cached = msgStore.get(chat.id);
    if (cached) paintMessages(chat, cached); else $("#msgs").innerHTML = '<div class="spinner"></div>';
    wireSwipe(chat);
    loadMessages(chat).then((list) => { if (openId === chat.id) paintMessages(chat, list); })
      .catch((e) => { if (openId === chat.id && !cached) $("#msgs").innerHTML = `<div class="conv-empty"><div>${esc(App.errText(e))}<br><button class="btn" data-action="reload-view">Try again</button></div></div>`; });
    if (App.isDesktop()) { const inp = $(".composer input[name=text]"); if (inp) inp.focus(); }
  }
  const composerHtml = (chat) => {
    const e2e = chat.type !== "channel";
    return `<form class="composer ig" data-form="send" data-id="${esc(chat.id)}" id="composer">
      <div class="pill-input">${e2e ? `<button type="button" class="ci" data-action="pick-toggle" aria-label="Emoji and GIFs">${icon("smile")}</button>` : ""}
      <input name="text" placeholder="${e2e ? "Message..." : "Broadcast to subscribers"}" autocomplete="off" maxlength="4000">
      ${e2e ? `<span class="c-tools att-wrap"><button type="button" class="ci" data-action="att-menu" aria-label="Attach">${icon("add")}</button><button type="button" class="ci" data-action="rec-toggle" aria-label="Voice message">${icon("mic")}</button></span>` : ""}
      <button class="ci send" type="submit" aria-label="Send">${icon("send")}</button>
      ${e2e ? `<div class="att-menu" id="att-menu" hidden><button type="button" data-action="attach">${icon("image")}<span>Photo or video</span></button><button type="button" data-action="pick-music">${icon("music")}<span>Music</span></button><button type="button" data-action="pick-gif">${icon("smile")}<span>GIF or sticker</span></button></div>` : ""}</div>
      ${e2e ? `<input type="file" id="att-file" accept="image/*,video/*" hidden>` : ""}</form>`;
  };
  App.actions["conv-back"] = () => App.go("/messages");

  // ---------- message rendering ----------
  const attHtml = (m) => {
    const pl = m.payload;
    const url = m.localUrl || attCache.get(pl.p);
    if (url) return mediaTag(pl.k, url, pl);
    return `<div class="att" data-path="${esc(pl.p)}" data-kind="${esc(pl.k)}"><span class="att-load">${icon(pl.k === "image" ? "image" : pl.k === "video" ? "play" : "mic")} Loading...</span></div>`;
  };
  const mediaTag = (k, url, pl) => k === "image" ? `<img class="att-img" src="${esc(url)}" alt="${esc(pl.n || "Photo")}" loading="lazy">`
    : k === "video" ? `<video class="att-vid" src="${esc(url)}" controls playsinline preload="metadata"></video>`
    : `<div class="att-aud">${k === "voice" ? "🎤 Voice message" : "🎵 " + esc(pl.n || "Music clip")}<audio src="${esc(url)}" controls preload="metadata"></audio></div>`;
  const reactHtml = (m) => {
    if (!m.reactions || !m.reactions.length) return "";
    const g = {};
    m.reactions.forEach((r) => { (g[r.emoji] = g[r.emoji] || []).push(r.user_id); });
    return `<span class="reacts">${Object.entries(g).map(([e, us]) => `<button class="rx ${us.includes(S.user.id) ? "mine" : ""}" data-action="m-react" data-mid="${esc(m.id)}" data-emoji="${esc(e)}">${esc(e)}${us.length > 1 ? `<i>${us.length}</i>` : ""}</button>`).join("")}</span>`;
  };
  function msgHtml(chat, m) {
    const mine = m.sender_id === S.user.id, pl = m.payload;
    const who = !mine && chat.type !== "direct" ? chat.members.find((x) => x.id === m.sender_id) : null;
    let body;
    if (m.failed) body = `<span class="undec">Message from earlier session</span>`;
    else if (pl.k === "music") body = musicCard(pl);
    else if (pl.k === "gif") body = pl.u ? `<img class="gif" src="${esc(pl.u)}" alt="${esc(pl.t || "GIF")}" loading="lazy">` : `<span class="sticker">${esc(pl.t)}</span>`;
    else if (pl.k === "image" || pl.k === "video" || pl.k === "audio" || pl.k === "voice") body = attHtml(m);
    else body = `<span class="txt">${esc(pl.t)}</span>`;
    const reply = pl.r ? `<div class="m-quote" data-action="m-jump" data-mid="${esc(pl.r.id)}"><b>${esc(pl.r.n || "")}</b><span>${esc(pl.r.p || "")}</span></div>` : "";
    const status = m.pending ? "Sending..." : m.failedSend ? `Not sent · <button class="link-btn small" data-action="m-retry" data-mid="${esc(m.id)}">Retry</button>` : App.clock(m.created_at);
    return `<div class="mrow ${mine ? "mine" : ""} ${m.pending ? "pending" : ""}" data-mid="${esc(m.id)}">
      ${!mine && chat.type !== "direct" ? `<span class="m-av">${avatar(who, "xs")}</span>` : ""}
      <div class="bubble ${pl.k === "gif" || pl.k === "image" || pl.k === "video" ? "media" : ""} ${m.failed ? "fail" : ""}" ${m.id.startsWith("tmp-") ? "" : `data-dbl="react-heart" data-mid="${esc(m.id)}"`}>
        ${who ? `<span class="who">${esc(who.display_name)}</span>` : ""}${reply}${body}<span class="t">${status}</span>${reactHtml(m)}</div>
      ${m.id.startsWith("tmp-") ? "" : `<button class="m-reply" data-action="m-reply" data-mid="${esc(m.id)}" aria-label="Reply">${icon("reply")}</button>`}</div>`;
  }
  function hydrate(chat, scope) {
    $$(".att[data-path]", scope || $("#msgs")).forEach(async (el) => {
      const path = el.dataset.path, kind = el.dataset.kind;
      if (el.dataset.busy) return; el.dataset.busy = "1";
      try {
        let url = attCache.get(path);
        if (!url) {
          const m = (msgStore.get(chat.id) || []).find((x) => x.payload && x.payload.p === path);
          const res = await fetch(api.publicUrl(path));
          if (!res.ok) throw new Error("Attachment unavailable (" + res.status + ")");
          const key = m && m.payload.e === "f" ? await fbKey(chat) : await e2eKey(chat);
          if (!key) throw new Error("Attachment from an earlier session");
          const plain = await C.decryptBytes(key, await res.arrayBuffer());
          url = URL.createObjectURL(new Blob([plain], { type: (m && m.payload.m) || "application/octet-stream" }));
          attCache.set(path, url);
        }
        if (el.isConnected) { const m = (msgStore.get(chat.id) || []).find((x) => x.payload && x.payload.p === path); el.outerHTML = mediaTag(kind, url, (m && m.payload) || {}); }
      } catch (e) { if (el.isConnected) el.innerHTML = `<span class="muted small">Couldn't load attachment: ${esc(App.errText(e))}</span>`; }
    });
  }
  function paintMessages(chat, list) {
    const box = $("#msgs"); if (!box || openId !== chat.id) return;
    const banner = chat.type === "channel" ? "" : `<div class="e2e-banner">${icon("lock")}<span>Messages in this chat are end-to-end encrypted. No one outside of this chat, not even LokaChat, can read, listen to, or share them.</span></div>`;
    box.innerHTML = banner + (list.length ? list.map((m) => msgHtml(chat, m)).join("")
      : `<div class="conv-empty"><div><p>${chat.type === "channel" ? "No broadcasts yet." : "No messages yet. Say hello!"}</p></div></div>`);
    box.scrollTop = box.scrollHeight;
    hydrate(chat);
  }
  function repaintMsg(chat, m) {
    const row = $(`.mrow[data-mid="${m.__oldId || m.id}"]`); if (!row) return;
    row.outerHTML = msgHtml(chat, m);
    hydrate(chat, $("#msgs"));
  }
  function appendMessage(chat, m) {
    const list = msgStore.get(chat.id) || [];
    if (list.some((x) => x.id === m.id)) return false;
    list.push(m); msgStore.set(chat.id, list);
    if (openId !== chat.id) return true;
    const box = $("#msgs"); if (!box) return true;
    const empty = box.querySelector(".conv-empty"); if (empty) empty.remove();
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 160 || m.sender_id === S.user.id;
    box.insertAdjacentHTML("beforeend", msgHtml(chat, m));
    hydrate(chat, box);
    if (near) box.scrollTop = box.scrollHeight;
    return true;
  }

  // ---------- sending (optimistic) ----------
  async function sendPayload(chat, payload, extra) {
    const tmp = { id: "tmp-" + uid(), conversation_id: chat.id, sender_id: S.user.id, created_at: new Date().toISOString(), encrypted: chat.type !== "channel", payload, pending: true, failed: false, reactions: [], ...extra };
    appendMessage(chat, tmp);
    previews.set(chat.id, "You: " + previewOf(payload)); paintList();
    await transmit(chat, tmp);
  }
  async function transmit(chat, tmp) {
    tmp.pending = true; tmp.failedSend = false; repaintMsg(chat, tmp);
    try {
      let body;
      if (chat.type === "channel") body = { conversation_id: chat.id, ciphertext: tmp.payload.t, iv: "" };
      else {
        const { key, fb } = await sendKey(chat);
        if (tmp.payload._file) {                                // attachment: encrypt + upload first
          const f = tmp.payload._file;
          const bytes = await C.encryptBytes(key, await f.arrayBuffer());
          const path = `${S.user.id}/chat/${uid()}.bin`;
          await api.upload(path, new Blob([bytes], { type: "application/octet-stream" }), "application/octet-stream");
          tmp.payload = { ...tmp.payload, p: path, e: fb ? "f" : "k" }; delete tmp.payload._file;
          attCache.set(path, tmp.localUrl);
        }
        const sealed = await C.encryptText(key, JSON.stringify({ v: 1, ...tmp.payload }));
        body = { conversation_id: chat.id, ciphertext: sealed.ciphertext, iv: fb ? "f." + sealed.iv : sealed.iv };
      }
      const sent = await api.post("/chats/send", body);
      const oldId = tmp.id;
      Object.assign(tmp, { id: sent.id, created_at: sent.created_at, pending: false, failedSend: false, __oldId: oldId });
      repaintMsg(chat, tmp); delete tmp.__oldId;
      chat.last_message = sent; chat.last_message_at = sent.created_at;
    } catch (e) {
      tmp.pending = false; tmp.failedSend = true; repaintMsg(chat, tmp);
      fail(e, "Couldn't send");
    }
  }
  App.actions["m-retry"] = (el) => { const chat = find(openId), m = (msgStore.get(openId) || []).find((x) => x.id === el.dataset.mid); if (chat && m) transmit(chat, m); };

  App.forms.send = async (form, data) => {
    const chat = find(form.dataset.id), text = (data.text || "").trim();
    if (!chat || !text) return;
    const input = form.querySelector("input[name=text]"); input.value = "";
    const payload = chat.type === "channel" ? { k: "text", t: text } : { k: "text", t: text, ...(replyTo ? { r: replyTo } : {}) };
    clearReply();
    sendPayload(chat, payload);
    input.focus();
  };

  // ---------- reply ----------
  function setReply(m, chat) {
    const name = m.sender_id === S.user.id ? "yourself" : (chat.members.find((x) => x.id === m.sender_id) || {}).display_name || "them";
    replyTo = { id: m.id, n: name, p: previewOf(m.payload).slice(0, 80) };
    const bar = $("#reply-bar"); if (!bar) return;
    bar.hidden = false;
    bar.innerHTML = `<div class="reply-bar"><div class="grow"><b>Replying to ${esc(name)}</b><div class="muted small ellipsis">${esc(replyTo.p)}</div></div><button class="icon-btn" data-action="reply-cancel" aria-label="Cancel reply">${icon("close")}</button></div>`;
    const inp = $(".composer input[name=text]"); if (inp) inp.focus();
  }
  function clearReply() { replyTo = null; const bar = $("#reply-bar"); if (bar) { bar.hidden = true; bar.innerHTML = ""; } }
  App.actions["reply-cancel"] = clearReply;
  App.actions["m-reply"] = (el) => { const chat = find(openId), m = (msgStore.get(openId) || []).find((x) => x.id === el.dataset.mid); if (chat && m && !m.failed) setReply(m, chat); };
  App.actions["m-jump"] = (el) => { const row = $(`.mrow[data-mid="${el.dataset.mid}"]`); if (row) { row.scrollIntoView({ block: "center", behavior: "smooth" }); row.classList.add("flash"); setTimeout(() => row.classList.remove("flash"), 1200); } };
  function wireSwipe(chat) {
    const box = $("#msgs"); if (!box) return;
    let sx = 0, sy = 0, row = null;
    box.addEventListener("touchstart", (e) => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; row = e.target.closest(".mrow"); }, { passive: true });
    box.addEventListener("touchend", (e) => {
      if (!row) return;
      const t = e.changedTouches[0], dx = t.clientX - sx, dy = Math.abs(t.clientY - sy);
      if (dx > 70 && dy < 30) { const m = (msgStore.get(chat.id) || []).find((x) => x.id === row.dataset.mid); if (m && !m.failed && !m.id.startsWith("tmp-")) setReply(m, chat); }
      row = null;
    }, { passive: true });
  }

  // ---------- reactions (double-tap = heart) ----------
  async function react(mid, emoji) {
    const chat = find(openId), m = (msgStore.get(openId) || []).find((x) => x.id === mid);
    if (!chat || !m || mid.startsWith("tmp-")) return;
    const before = m.reactions.slice();
    m.reactions = m.reactions.filter((r) => r.user_id !== S.user.id);
    if (emoji) m.reactions.push({ user_id: S.user.id, emoji });
    repaintMsg(chat, m);
    try { await api.post("/chats/react", { message_id: mid, emoji }); }
    catch (e) { m.reactions = before; repaintMsg(chat, m); fail(e, "Couldn't react"); }
  }
  App.dbl["react-heart"] = (el, pt) => {
    const m = (msgStore.get(openId) || []).find((x) => x.id === el.dataset.mid);
    App.burst(el, pt);
    if (m && !m.reactions.some((r) => r.user_id === S.user.id && r.emoji === "❤️")) react(el.dataset.mid, "❤️");
  };
  App.actions["m-react"] = (el) => {
    const m = (msgStore.get(openId) || []).find((x) => x.id === el.dataset.mid);
    const mineSame = m && m.reactions.some((r) => r.user_id === S.user.id && r.emoji === el.dataset.emoji);
    react(el.dataset.mid, mineSame ? "" : el.dataset.emoji);
  };

  // ---------- emoji + GIF picker ----------
  const EMOJI = ("😀 grin|😂 laugh lol|🤣 rofl|😊 smile|😍 love eyes|🥰 adore|😘 kiss|😎 cool|🤔 think|😢 cry sad|😭 sob|😡 angry|😴 sleep|🤯 mind blown|🥳 party|😇 angel|😉 wink|🙃 upside|😅 sweat|🤗 hug|😬 grimace|🙄 eyeroll|😮 wow|😱 scream|🤩 star struck|😜 silly|🥺 pleading|😏 smirk|😋 yum|🤤 drool|🤒 sick|🤕 hurt|" +
    "👍 thumbs up yes|👎 thumbs down no|👏 clap|🙌 raise hands|🙏 pray thanks please|💪 strong muscle|🤝 deal handshake|✌️ peace|🤞 luck fingers|👌 ok|👋 wave hi|🤙 call me|🫶 heart hands|✊ fist|☝️ point up|👀 eyes look|🧠 brain|" +
    "❤️ heart love|🧡 orange heart|💛 yellow heart|💚 green heart|💙 blue heart|💜 purple heart|🖤 black heart|🤍 white heart|💔 broken heart|💕 hearts|💖 sparkle heart|💯 hundred|🔥 fire hot|✨ sparkles|⭐ star|🌟 glow|💥 boom|🎉 party popper|🎊 confetti|🎁 gift|🏆 trophy win|🥇 gold medal|" +
    "🐶 dog|🐱 cat|🦊 fox|🐼 panda|🦁 lion|🐸 frog|🦄 unicorn|🐢 turtle|🌹 rose|🌸 blossom|🌈 rainbow|☀️ sun|🌙 moon|⚡ lightning|❄️ snow|🌊 wave|🍕 pizza|🍔 burger|🍟 fries|🍩 donut|🍦 ice cream|☕ coffee|🍺 beer|🍷 wine|🎂 cake|" +
    "⚽ football soccer|🏀 basketball|🏏 cricket|🎮 gaming|🎵 music note|🎧 headphones|🎤 mic sing|📸 camera|🚀 rocket|✈️ plane|🚗 car|🏠 home|💡 idea|📚 books|💻 laptop|📱 phone|⏰ clock time|✅ check done|❌ cross|⚠️ warning|🔒 lock|🎯 target|💸 money fly|🤑 money face").split("|").map((s) => { const i = s.indexOf(" "); return [s.slice(0, i), s.slice(i + 1)]; });
  const STICKERS = [["😂", "lol laugh funny"], ["😭", "cry sob sad"], ["🥹", "touched aww"], ["😍", "love heart eyes"], ["🔥", "fire lit hot"], ["💯", "hundred perfect"], ["👏", "clap bravo"], ["🙏", "thanks please pray"], ["😎", "cool"], ["🤯", "mind blown wow"], ["🥳", "party celebrate"], ["😴", "sleepy tired"], ["🤔", "hmm think"], ["😡", "angry mad"], ["💀", "dead dying lol"], ["🫡", "salute respect"], ["🤝", "deal agree"], ["🎉", "congrats party"], ["❤️", "love heart"], ["👍", "yes ok good"], ["👎", "no bad"], ["😮", "wow surprise"], ["🤗", "hug"], ["💪", "strong gym"]];
  const QUICK = ["❤️", "😂", "😮", "😢", "🔥", "👍", "🙏", "🎉"];

  App.actions["pick-toggle"] = () => {
    const p = $("#picker"); if (!p) return;
    if (!p.hidden) { p.hidden = true; return; }
    p.hidden = false; p.dataset.tab = p.dataset.tab || "emoji";
    paintPicker();
  };
  function paintPicker(query) {
    const p = $("#picker"); if (!p) return;
    const tab = p.dataset.tab, q = (query || "").toLowerCase();
    p.innerHTML = `<div class="pk-quick">${QUICK.map((e) => `<button data-action="pk-emoji" data-e="${e}">${e}</button>`).join("")}</div>
      <div class="pk-tabs"><button data-action="pk-tab" data-tab="emoji" class="${tab === "emoji" ? "on" : ""}">Emoji</button><button data-action="pk-tab" data-tab="gif" class="${tab === "gif" ? "on" : ""}">GIFs</button>
      <input id="pk-q" type="search" placeholder="Search ${tab === "gif" ? "GIFs and reactions" : "emoji"}" value="${esc(query || "")}" autocomplete="off"></div><div class="pk-grid" id="pk-grid"></div>`;
    const grid = $("#pk-grid", p), input = $("#pk-q", p);
    input.addEventListener("input", App.debounce(() => { const v = input.value; paintPickerGrid(v); }, 200));
    paintPickerGrid(query || "");
    if (App.isDesktop() && q) input.focus();
  }
  async function paintPickerGrid(q) {
    const p = $("#picker"), grid = $("#pk-grid"); if (!p || !grid) return;
    q = q.toLowerCase();
    if (p.dataset.tab === "emoji") {
      grid.className = "pk-grid emo";
      grid.innerHTML = EMOJI.filter(([, k]) => !q || k.includes(q)).map(([e]) => `<button data-action="pk-emoji" data-e="${e}">${e}</button>`).join("") || '<p class="muted small">No emoji found</p>';
      return;
    }
    const key = (window.LOKA_CONFIG || {}).GIPHY_KEY;
    const stickers = STICKERS.filter(([, k]) => !q || k.includes(q));
    const stickerHtml = stickers.map(([e, k]) => `<button class="stk" data-action="pk-sticker" data-e="${e}" title="${esc(k)}">${e}</button>`).join("");
    if (!key) { grid.className = "pk-grid stkgrid"; grid.innerHTML = stickerHtml || '<p class="muted small">Nothing found</p>'; if (!q) grid.insertAdjacentHTML("afterbegin", ""); return; }
    grid.className = "pk-grid gifgrid"; grid.innerHTML = '<div class="spinner"></div>';
    try {
      const url = `https://api.giphy.com/v1/gifs/${q ? "search" : "trending"}?api_key=${encodeURIComponent(key)}&limit=24&rating=g${q ? "&q=" + encodeURIComponent(q) : ""}`;
      const res = await fetch(url); if (!res.ok) throw new Error("GIF search failed (" + res.status + ")");
      const { data } = await res.json();
      if ($("#pk-grid") !== grid) return;
      grid.innerHTML = data.map((g) => `<button class="gifc" data-action="pk-gif" data-u="${esc(g.images.fixed_height.url)}" data-t="${esc(g.title || "GIF")}"><img src="${esc(g.images.fixed_height_small.url)}" alt="" loading="lazy"></button>`).join("") || '<p class="muted small">No GIFs found</p>';
    } catch (e) { grid.className = "pk-grid stkgrid"; grid.innerHTML = `<p class="muted small" style="grid-column:1/-1">${esc(App.errText(e))} - showing reactions instead.</p>` + stickerHtml; }
  }
  App.actions["pk-tab"] = (el) => { $("#picker").dataset.tab = el.dataset.tab; paintPicker(); };
  App.actions["pk-emoji"] = (el) => { const inp = $(".composer input[name=text]"); if (inp) { inp.value += el.dataset.e; inp.focus(); } };
  App.actions["pk-sticker"] = (el) => { const chat = find(openId); if (chat) { $("#picker").hidden = true; sendPayload(chat, { k: "gif", t: el.dataset.e, ...(replyTo ? { r: replyTo } : {}) }); clearReply(); } };
  App.actions["pk-gif"] = (el) => { const chat = find(openId); if (chat) { $("#picker").hidden = true; sendPayload(chat, { k: "gif", u: el.dataset.u, t: el.dataset.t }); } };

  // ---------- attachments + voice ----------
  const closeAttMenu = () => { const m = $("#att-menu"); if (m) m.hidden = true; };
  App.actions["att-menu"] = () => { const m = $("#att-menu"); if (m) m.hidden = !m.hidden; };
  document.addEventListener("click", (e) => { if (!e.target.closest(".att-wrap") && !e.target.closest("#att-menu")) closeAttMenu(); }, true);
  App.actions.attach = () => { closeAttMenu(); const f = $("#att-file"); if (f) f.click(); };
  App.actions["pick-gif"] = () => { closeAttMenu(); const p = $("#picker"); if (!p) return; p.hidden = false; p.dataset.tab = "gif"; paintPicker(); };
  document.addEventListener("change", (e) => {
    if (e.target.id !== "att-file") return;
    const f = e.target.files[0]; e.target.value = "";
    const chat = find(openId); if (f && chat) sendFile(chat, f, null);
  });
  function sendFile(chat, file, forceKind, dur) {
    if (file.size > MAX_ATT) { toast("Attachments can be up to 25 MB", "err"); return; }
    const kind = forceKind || (file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : null);
    if (!kind) { toast("Choose a photo or video", "err"); return; }
    const localUrl = URL.createObjectURL(file);
    const payload = { k: kind, m: file.type || "application/octet-stream", n: (file.name || "").slice(0, 80), s: file.size, d: dur || 0, _file: file, ...(replyTo ? { r: replyTo } : {}) };
    clearReply();
    sendPayload(chat, payload, { localUrl });
  }
  let rec = null;
  App.actions["rec-toggle"] = async () => {
    const chat = find(openId); if (!chat) return;
    if (rec) { rec.stop(); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast("Voice recording isn't supported in this browser. Use the attach button to share an audio file.", "err"); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream), chunks = [], t0 = Date.now();
      const bar = $("#reply-bar"); bar.hidden = false;
      const tick = setInterval(() => { bar.innerHTML = `<div class="reply-bar rec"><span class="rec-dot"></span><b>Recording ${App.dur((Date.now() - t0) / 1000)}</b><span class="grow"></span><button class="btn sm" data-action="rec-cancel">Cancel</button><button class="btn sm primary" data-action="rec-toggle">Send</button></div>`; }, 250);
      let cancelled = false;
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.onstop = () => {
        clearInterval(tick); stream.getTracks().forEach((t) => t.stop()); rec = null; clearReply();
        if (cancelled || !chunks.length) return;
        const type = mr.mimeType || "audio/webm";
        const file = new File([new Blob(chunks, { type })], "voice." + (type.includes("mp4") ? "m4a" : "webm"), { type });
        sendFile(chat, file, "voice", Math.round((Date.now() - t0) / 1000));
      };
      rec = { stop: () => mr.stop(), cancel: () => { cancelled = true; mr.stop(); } };
      mr.start();
    } catch (e) { toast("Microphone unavailable: " + App.errText(e), "err"); }
  };
  App.actions["rec-cancel"] = () => { if (rec) rec.cancel(); };

  document.addEventListener("input", (e) => { if (e.target.name === "text" && e.target.closest("#composer")) e.target.closest("#composer").classList.toggle("has-text", !!e.target.value.trim()); });

  // ---------- realtime ----------
  App.chatRealtime = {
    async onMessage(raw) {
      let chat = find(raw.conversation_id);
      if (!chat) { try { await loadChats(true); } catch (e) { return; } chat = find(raw.conversation_id); if (!chat) return; }
      const mine = raw.sender_id === S.user.id;
      if (mine && (msgStore.get(chat.id) || []).some((x) => x.pending || x.id === raw.id)) return; // our own optimistic send handles itself
      const m = await decode(chat, { id: raw.id, conversation_id: raw.conversation_id, sender_id: raw.sender_id, ciphertext: raw.ciphertext, iv: raw.iv || "", encrypted: raw.encrypted !== false, created_at: raw.created_at });
      chat.last_message = raw; chat.last_message_at = raw.created_at;
      previews.set(chat.id, previewMsg(chat, m));
      S.chats.sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
      const viewing = S.route === "messages" && openId === chat.id;
      if (msgStore.has(chat.id) || viewing) appendMessage(chat, m);
      App.cacheDrop("msgs:" + chat.id);
      if (!viewing && !mine) { S.unread[chat.id] = (S.unread[chat.id] || 0) + 1; App.updateBadge(); }
      paintList();
    },
    async onMembership() { try { await loadChats(true); } catch (e) { /* ignore */ } },
    onReaction(row) {
      if (!row || !row.message_id) return;
      const list = msgStore.get(row.conversation_id); if (!list) return;
      const m = list.find((x) => x.id === row.message_id); if (!m) return;
      m.reactions = m.reactions.filter((r) => r.user_id !== row.user_id);
      if (row.emoji) m.reactions.push({ user_id: row.user_id, emoji: row.emoji });
      const chat = find(row.conversation_id); if (chat && openId === chat.id) repaintMsg(chat, m);
    },
  };

  // ---------- actions ----------
  App.actions["msg-tab"] = (el) => { S.msgTab = el.dataset.tab; paintList(); };
  App.actions["open-chat"] = (el) => { App.closeDrawers(); App.closeMenus(); App.go("/messages/" + el.dataset.id); };
  App.actions["join-channel"] = async (el) => App.busy(el, async () => {
    await api.post(`/chats/${el.dataset.id}/join`, {});
    await loadChats(true); toast("Joined channel"); App.go("/messages/" + el.dataset.id);
  });
  App.actions["leave-chat"] = async (el) => {
    const chat = find(el.dataset.id);
    if (!chat || !(await App.confirm("Leave this conversation?", chat.type === "channel" ? "You will stop receiving broadcasts." : "You will lose access to its messages.", "Leave", true))) return;
    await App.busy(el, async () => {
      await api.del("/chats/" + chat.id);
      S.chats = S.chats.filter((c) => c.id !== chat.id); App.cacheDrop("chats"); msgStore.delete(chat.id); keyCache.delete(chat.id);
      App.closeDrawers(); toast("Left conversation"); App.go("/messages");
    });
  };

  // ---------- new chat ----------
  App.actions["new-chat"] = () => {
    modal(`<h3>New message</h3><form data-form="new-chat">
      <div class="field"><label>Type</label><select name="type" id="nc-type"><option value="direct">Direct message</option><option value="group">Group chat</option><option value="channel">Channel (public broadcast)</option></select></div>
      <div class="field" id="nc-users"><label id="nc-users-l">Their username</label><input name="users" placeholder="e.g. priya" autocomplete="off"></div>
      <div class="field" id="nc-title" hidden><label>Name</label><input name="title" maxlength="60"></div>
      <div class="field" id="nc-desc" hidden><label>Description (optional)</label><input name="description" maxlength="200"></div>
      <p class="muted small" id="nc-hint">Direct and group chats are end-to-end encrypted.</p>
      <div class="modal-actions"><button class="btn primary" type="submit">Create</button></div></form>`);
    $("#nc-type").addEventListener("change", () => {
      const t = $("#nc-type").value;
      $("#nc-users").hidden = t === "channel"; $("#nc-title").hidden = t === "direct"; $("#nc-desc").hidden = t !== "channel";
      $("#nc-users-l").textContent = t === "group" ? "Usernames (comma separated)" : "Their username";
      $("#nc-hint").textContent = t === "channel" ? "Channels are public: anyone can find and join them, and only admins can post. Messages are not encrypted." : "Direct and group chats are end-to-end encrypted.";
    });
  };
  async function createChat(type, title, description, usernames) {
    if (type === "channel") return api.post("/chats/create", { type, title, description, members: [] });
    const names = Array.from(new Set(usernames.map((u) => u.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))).filter((n) => n !== S.user.username);
    if (!names.length) throw new Error("Add at least one other person");
    if (type === "direct" && names.length !== 1) throw new Error("A direct chat has exactly one other person");
    const { users } = await api.post("/users/keys", { usernames: names });
    const byName = Object.fromEntries(users.map((u) => [u.username, u]));
    const missing = names.filter((n) => !byName[n]);
    if (missing.length) throw new Error("User not found: " + missing.join(", "));
    let members, my_wrapped_key;
    try {
      if (!S.identity || names.some((n) => !byName[n].public_key)) throw new Error("no key");
      const raw = await C.newChatKeyRaw(), mine = S.identity;
      members = await Promise.all(names.map(async (n) => ({ username: n, wrapped_key: await C.wrapChatKey(raw, mine.privateKey, JSON.parse(byName[n].public_key), mine.publicJwk) })));
      my_wrapped_key = await C.wrapChatKey(raw, mine.privateKey, mine.publicJwk, mine.publicJwk);
    } catch (e) {                     // missing key or OperationError: silently use the fallback conversation key
      members = names.map((n) => ({ username: n, wrapped_key: "fb1" })); my_wrapped_key = "fb1";
    }
    return api.post("/chats/create", { type, title, description, members, my_wrapped_key });
  }
  App.forms["new-chat"] = async (form, data) => {
    const users = (data.users || "").split(/[,\s]+/).filter(Boolean);
    const res = await createChat(data.type, (data.title || "").trim(), (data.description || "").trim(), users);
    App.closeAllModals();
    await loadChats(true);
    toast(res.existing ? "Opened your existing chat" : "Conversation created");
    S.msgTab = data.type === "channel" ? "channels" : "chats";
    App.go("/messages/" + res.id);
  };
  App.actions.dm = async (el, ev) => {
    if (ev) ev.stopPropagation();
    await App.busy(el, async () => {
      const res = await createChat("direct", "", "", [el.dataset.user]);
      App.closeAllModals(); App.closeDrawers(); await loadChats(true); S.msgTab = "chats"; App.go("/messages/" + res.id);
    });
  };

  // ---------- floating Messages pill + quick chat popover (desktop) ----------
  App.updatePill = () => {
    const av = $("#pill-avs"); if (!av) return;
    const direct = S.chats.filter((c) => c.type === "direct").slice(0, 3);
    av.innerHTML = direct.map((c) => avatar(other(c), "xs")).join("");
  };
  App.actions["pill-toggle"] = () => {
    const pop = $("#pill-pop"); if (!pop) return;
    const open = !pop.classList.contains("open");
    pop.classList.toggle("open", open);
    if (!open) return;
    const chats = S.chats.slice(0, 8);
    pop.innerHTML = `<div class="pp-head"><b>Messages</b><span class="grow"></span><button class="icon-btn" data-action="new-chat" aria-label="New message">${icon("edit")}</button><button class="btn sm" data-action="pill-open">Open all</button></div>
      <div class="pp-list">${chats.length ? chats.map((c) => `<div class="chat-item" data-action="open-chat" data-id="${esc(c.id)}">${avatarOf(c)}<div class="grow"><b class="ellipsis" style="display:block">${esc(titleOf(c))}</b><div class="muted small ellipsis">${esc(previews.get(c.id) || "")}</div></div>${S.unread[c.id] ? `<span class="unread">${S.unread[c.id]}</span>` : ""}</div>`).join("") : '<p class="muted small" style="padding:16px">No conversations yet.</p>'}</div>`;
  };
  App.actions["pill-open"] = () => { $("#pill-pop").classList.remove("open"); App.go("/messages"); };
  document.addEventListener("click", (e) => { const pop = $("#pill-pop"); if (pop && pop.classList.contains("open") && !e.target.closest("#msg-pill-wrap")) pop.classList.remove("open"); }, true);

  /** Called on logout: forget keys and cached plaintext. */
  App.resetChat = () => { keyCache.clear(); msgStore.clear(); previews.clear(); attCache.forEach((u) => URL.revokeObjectURL(u)); attCache.clear(); openId = null; replyTo = null; chatQuery = ""; const p = $("#view [data-pane=messages]"); if (p) p.remove(); };
  /** After restoring keys, forget undecryptable results and re-render. */
  App.refreshChats = async () => { keyCache.clear(); msgStore.clear(); App.cacheDrop("chats", "msgs:"); await loadChats(true); const c = find(openId); if (c && S.route === "messages") openConv(c, {}); };
})();
