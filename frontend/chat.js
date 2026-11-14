/* =====================================================================
   LokaChat - chat.js
   Messages: chats (direct + group, end-to-end encrypted), Stories tab and
   Channels (public broadcasts). Live delivery through Supabase Realtime.
   E2EE: each chat has a random AES-256-GCM key, wrapped per member with an
   ECDH(P-256)+HKDF key. The server only ever stores ciphertext.
   ===================================================================== */
(function () {
  "use strict";
  const { S, $, $$, esc, icon, avatar, toast, fail, modal } = App;
  const api = window.LokaApi, C = window.LokaCrypto;

  const keyCache = new Map();   // conversation id -> CryptoKey
  const msgStore = new Map();   // conversation id -> [{...message, text, failed}]
  const previews = new Map();   // conversation id -> decrypted last-message text
  let ctxRef = null;            // current route context (for stale checks)
  let discover = null;          // cached channel discovery list

  // ---------- helpers ----------
  const other = (chat) => chat.members.find((m) => m.id !== S.user.id) || chat.members[0] || {};
  const titleOf = (chat) => (chat.type === "direct" ? other(chat).display_name || "Chat" : chat.title || "Untitled");
  const avatarOf = (chat) => (chat.type === "direct" ? avatar(other(chat), "m")
    : `<span class="avatar av-m">${chat.type === "channel" ? icon("hash") : icon("users")}</span>`);
  const find = (id) => S.chats.find((c) => c.id === id);
  const canPost = (chat) => chat.type !== "channel" || chat.my_role === "owner" || chat.my_role === "admin";
  const safeJson = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

  async function chatKey(chat) {
    if (chat.type === "channel") return null;
    if (keyCache.has(chat.id)) return keyCache.get(chat.id);
    if (!S.identity) throw new Error("Encryption isn't available in this browser mode");
    const wrapper = chat.wrapped_by && safeJson(chat.wrapped_by.public_key);
    if (!chat.wrapped_key || !wrapper) throw new Error("Missing chat key");
    const key = await C.unwrapChatKey(chat.wrapped_key, S.identity.privateKey, wrapper);
    keyCache.set(chat.id, key);
    return key;
  }
  async function decode(chat, m) {
    const base = { ...m, text: "", failed: false };
    if (!m.encrypted) return { ...base, text: m.ciphertext };
    try { return { ...base, text: await C.decryptText(await chatKey(chat), m.ciphertext, m.iv) }; }
    catch (e) { return { ...base, text: "Can't decrypt this message on this device", failed: true }; }
  }
  const previewText = async (chat) => {
    const m = chat.last_message;
    if (!m) return "No messages yet";
    const d = await decode(chat, m);
    return (m.sender_id === S.user.id ? "You: " : "") + (d.failed ? "🔒 Encrypted message" : d.text);
  };

  // ---------- data ----------
  async function loadChats() {
    const { chats } = await api.get("/chats");
    S.chats = chats;
    await Promise.all(chats.map(async (c) => previews.set(c.id, await previewText(c))));
    return chats;
  }
  App.loadChats = loadChats;

  async function loadMessages(chat) {
    const { messages } = await api.get(`/chats/${chat.id}/messages`);
    const list = await Promise.all(messages.map((m) => decode(chat, m)));
    msgStore.set(chat.id, list);
    return list;
  }

  // ---------- rendering ----------
  App.routes.messages = async (ctx) => {
    ctxRef = ctx;
    const convId = ctx.args[0];
    if (!S.chats.length || ctx.args.length === 0 || !find(convId)) await loadChats();
    if (ctx.stale()) return;
    const chat = convId ? find(convId) : null;
    if (convId && !chat) { App.go("/messages"); return; }
    ctx.view.innerHTML = `<div class="chat-wrap ${chat ? "has-conv" : ""}"><div class="chat-list" id="chat-list"></div><div class="conv" id="conv"></div></div>`;
    renderList();
    if (chat) await renderConv(chat, ctx); else $("#conv").innerHTML = `<div class="conv-empty"><div>${icon("lock")}<h3>Your messages</h3><p>Chats are end-to-end encrypted.<br>Pick a conversation or start a new one.</p></div></div>`;
    if (S.msgTab === "stories") renderListBody();
  };

  function renderList() {
    $("#chat-list").innerHTML = `<div class="chat-list-head"><h2>Messages</h2><button class="btn sm primary" data-action="new-chat">+ New</button></div>
      <div class="tabs">${["chats", "stories", "channels"].map((t) => `<button data-action="msg-tab" data-tab="${t}" class="${S.msgTab === t ? "on" : ""}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div>
      <div class="chat-scroll" id="chat-scroll"></div>`;
    renderListBody();
  }

  async function renderListBody() {
    const box = $("#chat-scroll");
    if (!box) return;
    const openId = ctxRef && ctxRef.args[0];
    const row = (c) => `<div class="chat-item ${c.id === openId ? "on" : ""}" data-action="open-chat" data-id="${esc(c.id)}">${avatarOf(c)}
      <div class="grow"><b class="ellipsis" style="display:block">${esc(titleOf(c))}</b><div class="muted small ellipsis">${esc(previews.get(c.id) || "")}</div></div>
      ${S.unread[c.id] ? `<span class="unread">${S.unread[c.id]}</span>` : ""}</div>`;
    if (S.msgTab === "chats") {
      const list = S.chats.filter((c) => c.type !== "channel");
      box.innerHTML = list.length ? list.map(row).join("") : App.emptyBox("chat", "No chats yet", "Start an encrypted chat with someone you know.", `<button class="btn primary" data-action="new-chat">+ New chat</button>`);
    } else if (S.msgTab === "channels") {
      const mine = S.chats.filter((c) => c.type === "channel");
      box.innerHTML = (mine.length ? mine.map(row).join("") : "") + `<div class="muted small" style="padding:14px 10px 6px">Discover channels</div><div id="discover"><div class="spinner"></div></div>`;
      loadDiscover();
    } else {
      box.innerHTML = '<div class="spinner"></div>';
      try {
        const groups = await App.loadStories();
        if (S.msgTab !== "stories" || !$("#chat-scroll")) return;
        $("#chat-scroll").innerHTML = groups.length ? `<div class="story-grid" style="padding:10px">${App.storyItemsHtml(groups, false)}</div>`
          : App.emptyBox("clips", "No stories right now", "Stories from people you follow appear here for 24 hours.", `<button class="btn primary" data-action="add-story">Add yours</button>`);
      } catch (e) { fail(e); }
    }
  }

  async function loadDiscover() {
    try {
      const { channels } = await api.get("/channels/discover");
      discover = channels;
      const box = $("#discover");
      if (!box) return;
      box.innerHTML = channels.length ? channels.map((c) => `<div class="chat-item"><span class="avatar av-m">${icon("hash")}</span>
        <div class="grow"><b class="ellipsis" style="display:block">${esc(c.title)}</b><div class="muted small ellipsis">${esc(c.description || (c.owner ? "by " + c.owner.display_name : ""))}</div></div>
        ${c.joined ? `<button class="btn sm" data-action="open-chat" data-id="${esc(c.id)}">Open</button>` : `<button class="btn sm primary" data-action="join-channel" data-id="${esc(c.id)}">Join</button>`}</div>`).join("")
        : '<div class="muted small" style="padding:6px 10px">No channels yet - create the first with + New.</div>';
    } catch (e) { fail(e); }
  }

  async function renderConv(chat, ctx) {
    const conv = $("#conv");
    S.unread[chat.id] = 0; App.updateBadge();
    conv.innerHTML = `<div class="conv-head"><button class="icon-btn back" data-action="conv-back" aria-label="Back">${icon("back")}</button>${avatarOf(chat)}
      <div class="grow"><b class="ellipsis" style="display:block">${esc(titleOf(chat))}</b>
      <span class="muted small">${chat.type === "direct" ? "@" + esc(other(chat).username || "") : chat.type === "group" ? chat.member_count + " members" : "Public channel"}</span></div>
      ${chat.type === "channel" ? `<span class="e2ee">${icon("hash")}Broadcast</span>` : `<span class="e2ee">${icon("lock")}E2EE</span>`}
      <button class="icon-btn" data-action="leave-chat" data-id="${esc(chat.id)}" aria-label="Leave" title="Leave">${icon("logout")}</button></div>
      <div class="msgs" id="msgs"><div class="spinner"></div></div>
      ${canPost(chat) ? `<form class="composer" data-form="send" data-id="${esc(chat.id)}"><input name="text" placeholder="${chat.type === "channel" ? "Broadcast to subscribers" : "Message (end-to-end encrypted)"}" autocomplete="off" maxlength="4000" required>
        <button class="btn primary" type="submit" aria-label="Send">${icon("send")}</button></form>`
      : `<div class="composer muted small" style="justify-content:center">Only channel admins can post here.</div>`}`;
    renderListBody();
    let list;
    try { list = await loadMessages(chat); } catch (e) { if (!ctx.stale()) $("#msgs").innerHTML = `<div class="conv-empty">${esc(e.message)}</div>`; return; }
    if (ctx.stale()) return;
    paintMessages(chat, list);
    const inp = $(".composer input"); if (inp && window.innerWidth >= 768) inp.focus();
  }

  const msgHtml = (chat, m) => {
    const mine = m.sender_id === S.user.id;
    const who = !mine && chat.type !== "direct" ? (chat.members.find((x) => x.id === m.sender_id) || {}).display_name : "";
    return `<div class="msg ${mine ? "mine" : ""} ${m.failed ? "fail" : ""}" data-mid="${esc(m.id)}">${who ? `<span class="who">${esc(who)}</span>` : ""}${esc(m.text)}<span class="t">${App.clock(m.created_at)}</span></div>`;
  };
  function paintMessages(chat, list) {
    const box = $("#msgs");
    if (!box) return;
    box.innerHTML = list.length ? list.map((m) => msgHtml(chat, m)).join("")
      : `<div class="conv-empty"><div>${icon(chat.type === "channel" ? "hash" : "lock")}<p>${chat.type === "channel" ? "No broadcasts yet." : "No messages yet. Say hello - everything here is end-to-end encrypted."}</p></div></div>`;
    box.scrollTop = box.scrollHeight;
  }
  function appendMessage(chat, m) {
    const list = msgStore.get(chat.id) || [];
    if (list.some((x) => x.id === m.id)) return;
    list.push(m); msgStore.set(chat.id, list);
    const box = $("#msgs");
    if (!box || !ctxRef || ctxRef.args[0] !== chat.id) return;
    const empty = box.querySelector(".conv-empty"); if (empty) empty.remove();
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140 || m.sender_id === S.user.id;
    box.insertAdjacentHTML("beforeend", msgHtml(chat, m));
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  // ---------- realtime ----------
  App.chatRealtime = {
    async onMessage(raw) {
      let chat = find(raw.conversation_id);
      if (!chat) { try { await loadChats(); } catch (e) { return; } chat = find(raw.conversation_id); if (!chat) return; }
      const m = await decode(chat, { id: raw.id, conversation_id: raw.conversation_id, sender_id: raw.sender_id, ciphertext: raw.ciphertext, iv: raw.iv || "", encrypted: raw.encrypted !== false, created_at: raw.created_at });
      chat.last_message = raw; chat.last_message_at = raw.created_at;
      previews.set(chat.id, (m.sender_id === S.user.id ? "You: " : "") + (m.failed ? "🔒 Encrypted message" : m.text));
      S.chats.sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
      const open = App.parseHash().name === "messages" && ctxRef && ctxRef.args[0] === chat.id;
      if (msgStore.has(chat.id) || open) appendMessage(chat, m);
      if (!open && m.sender_id !== S.user.id) { S.unread[chat.id] = (S.unread[chat.id] || 0) + 1; App.updateBadge(); }
      if (App.parseHash().name === "messages") renderListBody();
    },
    async onMembership() {
      try { await loadChats(); App.updateBadge(); if (App.parseHash().name === "messages") renderListBody(); } catch (e) { /* ignore */ }
    },
  };

  // ---------- actions ----------
  App.actions["msg-tab"] = (el) => { S.msgTab = el.dataset.tab; $$(".chat-list .tabs button").forEach((b) => b.classList.toggle("on", b === el)); renderListBody(); };
  App.actions["open-chat"] = (el) => App.go("/messages/" + el.dataset.id);
  App.actions["conv-back"] = () => App.go("/messages");
  App.actions["join-channel"] = async (el) => App.busy(el, async () => {
    await api.post(`/chats/${el.dataset.id}/join`, {});
    await loadChats(); toast("Joined channel"); App.go("/messages/" + el.dataset.id);
  });
  App.actions["leave-chat"] = async (el) => {
    const chat = find(el.dataset.id);
    if (!chat || !(await App.confirm("Leave this conversation?", chat.type === "channel" ? "You will stop receiving broadcasts." : "You will lose access to its messages.", "Leave", true))) return;
    await App.busy(el, async () => {
      await api.del("/chats/" + chat.id);
      S.chats = S.chats.filter((c) => c.id !== chat.id); msgStore.delete(chat.id); keyCache.delete(chat.id);
      toast("Left conversation"); App.go("/messages");
    });
  };

  App.forms.send = async (form, data) => {
    const chat = find(form.dataset.id), text = (data.text || "").trim();
    if (!chat || !text) return;
    const input = form.querySelector("input"); input.value = "";
    let payload;
    try {
      payload = chat.type === "channel" ? { conversation_id: chat.id, ciphertext: text, iv: "" }
        : { conversation_id: chat.id, ...(await C.encryptText(await chatKey(chat), text)) };
      const sent = await api.post("/chats/send", payload);
      const m = { ...sent, text, failed: false };
      chat.last_message = sent; chat.last_message_at = sent.created_at;
      previews.set(chat.id, "You: " + text);
      appendMessage(chat, m);
    } catch (e) { input.value = text; throw e; }
    input.focus();
  };

  // ---------- new chat ----------
  App.actions["new-chat"] = () => {
    modal(`<h3>New conversation</h3><form data-form="new-chat">
      <div class="field"><label>Type</label><select name="type" id="nc-type"><option value="direct">Direct message</option><option value="group">Group chat</option><option value="channel">Channel (public broadcast)</option></select></div>
      <div class="field" id="nc-users"><label id="nc-users-l">Their username</label><input name="users" placeholder="e.g. priya" autocomplete="off"></div>
      <div class="field" id="nc-title" hidden><label>Name</label><input name="title" maxlength="60"></div>
      <div class="field" id="nc-desc" hidden><label>Description (optional)</label><input name="description" maxlength="200"></div>
      <p class="muted small" id="nc-hint">Direct and group chats are end-to-end encrypted. Everyone must have signed in to LokaChat at least once.</p>
      <div class="modal-actions"><button class="btn primary" type="submit">Create</button></div></form>`);
    const sync = () => {
      const t = $("#nc-type").value;
      $("#nc-users").hidden = t === "channel"; $("#nc-title").hidden = t === "direct"; $("#nc-desc").hidden = t !== "channel";
      $("#nc-users-l").textContent = t === "group" ? "Usernames (comma separated)" : "Their username";
      $("#nc-hint").textContent = t === "channel" ? "Channels are public: anyone can find and join them, and only admins can post. Messages are not encrypted." : "Direct and group chats are end-to-end encrypted. Everyone must have signed in to LokaChat at least once.";
    };
    $("#nc-type").addEventListener("change", sync);
  };

  async function createChat(type, title, description, usernames) {
    if (type === "channel") return api.post("/chats/create", { type, title, description, members: [] });
    if (!S.identity) throw new Error("Encryption isn't available in this browser mode");
    const names = Array.from(new Set(usernames.map((u) => u.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))).filter((n) => n !== S.user.username);
    if (!names.length) throw new Error("Add at least one other person");
    if (type === "direct" && names.length !== 1) throw new Error("A direct chat has exactly one other person");
    const { users } = await api.post("/users/keys", { usernames: names });
    const byName = Object.fromEntries(users.map((u) => [u.username, u]));
    const missing = names.filter((n) => !byName[n]);
    if (missing.length) throw new Error("User not found: " + missing.join(", "));
    const noKey = names.filter((n) => !byName[n].public_key);
    if (noKey.length) throw new Error(`${noKey.join(", ")} hasn't opened LokaChat since signing up, so they have no encryption key yet.`);
    const raw = await C.newChatKeyRaw();
    const members = await Promise.all(names.map(async (n) => ({ username: n, wrapped_key: await C.wrapChatKey(raw, S.identity.privateKey, JSON.parse(byName[n].public_key)) })));
    const my_wrapped_key = await C.wrapChatKey(raw, S.identity.privateKey, S.identity.publicJwk);
    return api.post("/chats/create", { type, title, description, members, my_wrapped_key });
  }

  App.forms["new-chat"] = async (form, data) => {
    const users = (data.users || "").split(/[,\s]+/).filter(Boolean);
    const res = await createChat(data.type, (data.title || "").trim(), (data.description || "").trim(), users);
    App.closeAllModals();
    await loadChats();
    toast(res.existing ? "Opened your existing chat" : "Conversation created");
    S.msgTab = data.type === "channel" ? "channels" : "chats";
    App.go("/messages/" + res.id);
  };

  App.actions.dm = async (el) => {
    await App.busy(el, async () => {
      const res = await createChat("direct", "", "", [el.dataset.user]);
      App.closeAllModals(); await loadChats(); S.msgTab = "chats"; App.go("/messages/" + res.id);
    });
  };

  /** Called on logout: forget keys and cached plaintext. */
  App.resetChat = () => { keyCache.clear(); msgStore.clear(); previews.clear(); ctxRef = null; discover = null; };
})();
