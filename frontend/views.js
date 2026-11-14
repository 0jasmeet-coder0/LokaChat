/* =====================================================================
   LokaChat - views.js
   Home feed, story bar + story viewer, theater player, Clips, Post (upload),
   Search, Notifications and the public profile modal.
   ===================================================================== */
(function () {
  "use strict";
  const { S, $, $$, esc, icon, avatar, toast, fail, modal, confirm: confirmBox } = App;
  const api = window.LokaApi;
  const MAX_BYTES = 50 * 1024 * 1024; // matches the Supabase free-plan bucket limit set in schema.sql

  const remember = (posts) => posts.forEach((p) => S.postCache.set(p.id, p));

  // ============================================================ stories
  const VIEWED_KEY = "loka_viewed_stories";
  const viewed = new Set((() => { try { return JSON.parse(localStorage.getItem(VIEWED_KEY) || "[]"); } catch (e) { return []; } })());
  const markViewed = (id) => {
    viewed.add(id);
    try { localStorage.setItem(VIEWED_KEY, JSON.stringify(Array.from(viewed).slice(-500))); } catch (e) { /* ignore */ }
  };
  const groupSeen = (g) => g.items.every((s) => viewed.has(s.id));
  let storyCache = { at: 0, groups: [] };

  /** Stories (own + people you follow), grouped per author - own group first, unseen before seen. */
  App.loadStories = async (force) => {
    if (!force && Date.now() - storyCache.at < 30000) return storyCache.groups;
    const { posts } = await api.get("/posts/feed?tab=stories");
    remember(posts);
    const map = new Map();
    posts.slice().reverse().forEach((p) => {                 // oldest first inside a group
      if (!map.has(p.author.id)) map.set(p.author.id, { author: p.author, items: [] });
      map.get(p.author.id).items.push(p);
    });
    const groups = Array.from(map.values()).sort((a, b) => {
      const mine = (g) => (g.author.id === S.user.id ? 0 : 1);
      return mine(a) - mine(b) || groupSeen(a) - groupSeen(b);
    });
    storyCache = { at: Date.now(), groups };
    return groups;
  };

  App.storyItemsHtml = (groups, withAdd) => {
    const mine = groups.find((g) => g.author.id === S.user.id);
    let html = "";
    if (withAdd) {
      html += `<div class="story-item" ${mine ? 'data-action="open-story" data-i="' + groups.indexOf(mine) + '"' : 'data-action="add-story"'}>
        <span class="story-add">${avatar(S.user, "l", mine ? (groupSeen(mine) ? "seen" : "new") : null, mine ? S.user.id : null)}
        <span class="plus" data-action="add-story">+</span></span><span class="nm ellipsis">Your story</span></div>`;
    }
    groups.forEach((g, i) => {
      if (g.author.id === S.user.id && withAdd) return;
      html += `<div class="story-item" data-action="open-story" data-i="${i}">${avatar(g.author, "l", groupSeen(g) ? "seen" : "new", g.author.id)}
        <span class="nm ellipsis">${esc(g.author.id === S.user.id ? "Your story" : g.author.display_name)}</span></div>`;
    });
    return html;
  };

  App.actions["add-story"] = (el, ev) => { ev.stopPropagation(); S.postPreset = "story"; App.go("/post"); };
  App.actions["open-story"] = async (el) => {
    const groups = await App.loadStories();
    openStories(groups, Number(el.dataset.i));
  };

  function openStories(groups, gi) {
    let ii = 0, raf = 0, startedAt = 0, total = 5000, vid = null, gone = false;
    const root = document.createElement("div");
    root.className = "story-view";
    document.body.appendChild(root);

    const close = () => {
      gone = true; cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey, true);
      root.remove();
      groups.forEach((g) => $$(`[data-ring="${g.author.id}"]`).forEach((r) => r.classList.toggle("seen", groupSeen(g))));
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopImmediatePropagation(); close(); }
      else if (e.key === "ArrowRight") next(); else if (e.key === "ArrowLeft") prev();
    };
    document.addEventListener("keydown", onKey, true);

    function show() {
      cancelAnimationFrame(raf);
      const g = groups[gi], s = g.items[ii];
      markViewed(s.id);
      if (s.author.id !== S.user.id) api.post("/posts/view", { post_id: s.id }).catch(() => {});
      const isVid = s.mime.startsWith("video/");
      root.innerHTML = `<div class="story-stage">
        <div class="story-top"><div class="story-bars">${g.items.map((_, k) => `<i><b style="width:${k < ii ? 100 : 0}%"></b></i>`).join("")}</div>
          <div class="row">${avatar(g.author, "s")}<div class="grow"><b>${esc(g.author.display_name)}</b>
          <span class="muted small"> ${App.timeAgo(s.created_at)}</span></div>
          ${s.author.id === S.user.id ? `<button class="icon-btn" data-sv="del" aria-label="Delete story">${icon("trash")}</button>` : ""}
          <button class="icon-btn" data-sv="close" aria-label="Close">${icon("close")}</button></div></div>
        <div class="story-tap l" data-sv="prev"></div><div class="story-tap r" data-sv="next"></div>
        ${isVid ? `<video src="${esc(s.media_url)}" autoplay playsinline></video>` : `<img src="${esc(s.media_url)}" alt="">`}
        ${s.caption ? `<div class="story-top" style="top:auto;bottom:0;background:linear-gradient(transparent,rgba(0,0,0,.8))">${esc(s.caption)}</div>` : ""}</div>`;
      vid = isVid ? root.querySelector("video") : null;
      total = isVid ? Math.min(Math.max((s.duration || 8) * 1000, 3000), 60000) : 5000;
      startedAt = performance.now();
      const bar = root.querySelectorAll(".story-bars i b")[ii];
      const tick = (now) => {
        if (gone) return;
        const p = vid && vid.duration ? vid.currentTime / vid.duration : (now - startedAt) / total;
        bar.style.width = Math.min(100, p * 100) + "%";
        if (p >= 1 || (vid && vid.ended)) next(); else raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
    function next() { const g = groups[gi]; if (ii < g.items.length - 1) { ii++; show(); } else if (gi < groups.length - 1) { gi++; ii = 0; show(); } else close(); }
    function prev() { if (ii > 0) { ii--; show(); } else if (gi > 0) { gi--; ii = 0; show(); } else show(); }

    root.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-sv]");
      if (!b) return;
      const k = b.dataset.sv;
      if (k === "next") next(); else if (k === "prev") prev(); else if (k === "close") close();
      else if (k === "del") {
        if (vid) vid.pause();
        cancelAnimationFrame(raf);
        if (!(await confirmBox("Delete story?", "This removes it for everyone.", "Delete", true))) { show(); return; }
        try {
          const s = groups[gi].items[ii];
          await api.del("/posts/" + s.id);
          groups[gi].items.splice(ii, 1);
          storyCache.at = 0;
          if (!groups[gi].items.length) { groups.splice(gi, 1); if (!groups.length) { close(); return; } ii = 0; if (gi >= groups.length) gi = groups.length - 1; }
          else if (ii >= groups[gi].items.length) ii = groups[gi].items.length - 1;
          show();
          toast("Story deleted");
        } catch (err) { fail(err); show(); }
      }
    });
    show();
  }

  // ============================================================ post card + player
  function vcard(p) {
    const isPhoto = p.type === "photo";
    const thumb = p.poster_url || (isPhoto ? p.media_url : "");
    return `<article class="vcard" data-action="open-post" data-id="${esc(p.id)}">
      <div class="thumb">${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy">` : ""}
        <span class="kind">${icon(isPhoto ? "image" : p.type === "clip" ? "clips" : "play")}${isPhoto ? "Photo" : p.type === "clip" ? "Clip" : "Video"}</span>
        ${p.duration ? `<span class="dur">${App.dur(p.duration)}</span>` : ""}</div>
      <div class="vmeta"><span data-action="open-profile" data-user="${esc(p.author.username)}">${avatar(p.author, "s")}</span>
        <div class="grow"><div class="vtitle">${esc(p.title)}</div>
        <div class="muted small">${esc(p.author.display_name)} · ${App.num(p.views)} views · ${App.timeAgo(p.created_at)}</div></div></div></article>`;
  }
  App.vcard = vcard;
  const emptyBox = (ic, title, text, btn) => `<div class="empty">${icon(ic)}<h3>${esc(title)}</h3><p>${esc(text)}</p>${btn || ""}</div>`;
  App.emptyBox = emptyBox;

  App.actions["open-post"] = (el) => { const p = S.postCache.get(el.dataset.id); if (p) openPost(p); };
  App.actions["open-profile"] = (el, ev) => { ev.stopPropagation(); openProfile(el.dataset.user); };

  App.actions.like = async (el, ev) => {
    ev.stopPropagation();
    const id = el.dataset.id;
    await App.busy(el, async () => {
      const r = await api.post("/posts/like", { post_id: id });
      const p = S.postCache.get(id);
      if (p) { p.liked = r.liked; p.likes = r.likes; }
      $$(`[data-action="like"][data-id="${id}"]`).forEach((b) => {
        b.classList.toggle("liked", r.liked);
        const n = b.querySelector(".n"); if (n) n.textContent = App.num(r.likes);
      });
    });
  };
  const likeBtn = (p) => `<button class="chip-btn ${p.liked ? "liked" : ""}" data-action="like" data-id="${esc(p.id)}">${icon("heart")}<span class="n">${App.num(p.likes)}</span></button>`;

  function openPost(p) {
    const isVid = p.mime.startsWith("video/");
    let lastSent = 0, counted = false, vidEl = null;
    const send = (count) => {
      const pos = vidEl ? vidEl.currentTime || 0 : 0;
      const dur = vidEl && isFinite(vidEl.duration) ? vidEl.duration : p.duration || 0;
      return api.post("/posts/view", { post_id: p.id, position: pos, duration: dur, count }).then((r) => {
        if (count && r && typeof r.views === "number") { p.views = r.views; }
      }).catch(() => {});
    };
    const m = modal(`<div class="player">${isVid ? `<video src="${esc(p.media_url)}" ${p.poster_url ? `poster="${esc(p.poster_url)}"` : ""} controls autoplay playsinline></video>`
      : `<img class="full" src="${esc(p.media_url)}" alt="${esc(p.title)}">`}
      <div class="player-info"><h3 style="padding-right:0">${esc(p.title)}</h3>
        <div class="row" style="margin:8px 0;flex-wrap:wrap"><span class="row" data-action="open-profile" data-user="${esc(p.author.username)}" style="cursor:pointer">${avatar(p.author, "s")}<b>${esc(p.author.display_name)}</b></span>
        <span class="muted small grow">${App.num(p.views)} views · ${App.timeAgo(p.created_at)}</span>${likeBtn(p)}
        ${p.author.id === S.user.id ? `<button class="chip-btn" data-action="delete-post" data-id="${esc(p.id)}">${icon("trash")}Delete</button>` : ""}</div>
        ${p.caption ? `<p class="muted" style="white-space:pre-wrap;margin:6px 0 0">${esc(p.caption)}</p>` : ""}</div></div>`,
      { cls: "player", noFocus: true, onClose: () => { if (vidEl) { vidEl.pause(); send(false); } } });
    vidEl = $("video", m.el);
    if (vidEl) {
      vidEl.addEventListener("play", () => { if (!counted) { counted = true; send(true); } });
      vidEl.addEventListener("timeupdate", () => { if (Date.now() - lastSent > 10000) { lastSent = Date.now(); send(false); } });
    } else send(true);
  }
  App.openPost = openPost;

  App.actions["delete-post"] = async (el) => {
    if (!(await confirmBox("Delete this post?", "It will be removed permanently.", "Delete", true))) return;
    await App.busy(el, async () => {
      await api.del("/posts/" + el.dataset.id);
      S.postCache.delete(el.dataset.id);
      storyCache.at = 0;
      App.closeAllModals();
      toast("Deleted");
      App.route();
    });
  };

  async function openPostById(id, username) {
    let p = S.postCache.get(id);
    if (!p) {
      const { posts } = await api.get("/posts/feed?tab=user&limit=60&username=" + encodeURIComponent(username));
      remember(posts); p = S.postCache.get(id);
    }
    if (p) openPost(p); else toast("That post is no longer available", "err");
  }

  // ============================================================ Home
  App.routes.home = async (ctx) => {
    const v = ctx.view;
    v.innerHTML = `<div class="page"><div class="story-bar" id="story-bar"></div>
      <div class="tabs"><button data-action="home-tab" data-tab="recommended" class="${S.homeTab === "recommended" ? "on" : ""}">Recommended</button>
      <button data-action="home-tab" data-tab="following" class="${S.homeTab === "following" ? "on" : ""}">Following</button></div>
      <div id="feed"><div class="spinner"></div></div></div>`;
    App.loadStories().then((groups) => {
      if (ctx.stale()) return;
      $("#story-bar").innerHTML = App.storyItemsHtml(groups, true);
    }).catch(() => { if (!ctx.stale()) $("#story-bar").innerHTML = App.storyItemsHtml([], true); });
    const { posts } = await api.get("/posts/feed?tab=" + S.homeTab);
    if (ctx.stale()) return;
    remember(posts);
    $("#feed").innerHTML = posts.length
      ? `<div class="grid">${posts.map(vcard).join("")}</div>`
      : emptyBox("play", S.homeTab === "following" ? "Nothing from people you follow yet" : "No videos yet",
        S.homeTab === "following" ? "Follow people from Search to fill this feed." : "Be the first - upload a video or photo.",
        `<a class="btn primary" href="#/${S.homeTab === "following" ? "search" : "post"}">${S.homeTab === "following" ? "Find people" : "Upload"}</a>`);
  };
  App.actions["home-tab"] = (el) => { S.homeTab = el.dataset.tab; App.route(); };

  // ============================================================ Clips
  App.routes.clips = async (ctx) => {
    const { posts } = await api.get("/posts/feed?tab=clips&limit=30");
    if (ctx.stale()) return;
    remember(posts);
    if (!posts.length) {
      ctx.view.innerHTML = `<div class="page">${emptyBox("clips", "No clips yet", "Short vertical videos appear here.", `<a class="btn primary" href="#/post" data-action="clip-preset">Post a clip</a>`)}</div>`;
      return;
    }
    ctx.view.innerHTML = `<div class="clips-wrap">${posts.map((p) => `<section class="clip" data-id="${esc(p.id)}">
      <video data-src="${esc(p.media_url)}" ${p.poster_url ? `poster="${esc(p.poster_url)}"` : ""} loop playsinline preload="none"></video>
      <div class="clip-side">${likeBtn(p)}<button class="chip-btn" data-action="open-profile" data-user="${esc(p.author.username)}">${avatar(p.author, "s")}</button></div>
      <div class="clip-ui"><b>${esc(p.author.display_name)}</b><div>${esc(p.title)}</div>
        ${p.caption ? `<div class="muted small">${esc(p.caption)}</div>` : ""}</div></section>`).join("")}</div>`;
    const counted = new Set();
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        const vid = en.target.querySelector("video");
        if (en.isIntersecting && en.intersectionRatio >= 0.6) {
          if (!vid.src) vid.src = vid.dataset.src;
          vid.play().catch(() => {});
          const id = en.target.dataset.id;
          if (!counted.has(id)) { counted.add(id); api.post("/posts/view", { post_id: id }).catch(() => {}); }
        } else vid.pause();
      });
    }, { threshold: [0, 0.6] });
    $$(".clip", ctx.view).forEach((c) => {
      io.observe(c);
      c.querySelector("video").addEventListener("click", (e) => { const v = e.target; v.paused ? v.play().catch(() => {}) : v.pause(); });
    });
    App.onLeave(() => { io.disconnect(); $$("video", ctx.view).forEach((v) => v.pause()); });
  };
  App.actions["clip-preset"] = () => { S.postPreset = "clip"; App.go("/post"); };

  // ============================================================ Post (upload)
  const TYPES = [["video", "Video"], ["clip", "Clip"], ["photo", "Photo"], ["story", "24h Story"]];
  const accept = (t) => (t === "photo" ? "image/*" : t === "story" ? "image/*,video/*" : "video/*");

  App.routes.post = async (ctx) => {
    const t = S.postPreset || "video";
    ctx.view.innerHTML = `<div class="page" style="max-width:560px"><div class="page-head"><h2>Create</h2></div>
      <form class="card section" data-form="post" id="post-form" style="display:grid;gap:14px">
        <div class="tabs" style="margin:0" id="type-tabs">${TYPES.map(([k, l]) => `<button type="button" data-action="post-type" data-type="${k}" class="${k === t ? "on" : ""}">${l}</button>`).join("")}</div>
        <input type="hidden" name="type" value="${t}">
        <div class="field"><label>File (max 50 MB)</label><input type="file" name="file" accept="${accept(t)}" required id="post-file"></div>
        <div id="post-preview"></div>
        <div class="field" id="f-title" ${t === "story" ? "hidden" : ""}><label>Title</label><input name="title" maxlength="100" placeholder="Give it a title" ${t === "story" ? "" : "required"}></div>
        <div class="field"><label>${t === "story" ? "Caption (optional)" : "Description (optional)"}</label><textarea name="caption" maxlength="500"></textarea></div>
        <div class="field" id="f-vis" ${t === "clip" || t === "story" ? "hidden" : ""}><label>Who can see it</label>
          <select name="visibility"><option value="public">Everyone</option><option value="followers">Followers only</option></select></div>
        <p class="muted small" id="post-hint">${t === "story" ? "Stories are visible to your followers for 24 hours." : t === "clip" ? "Clips are public short videos." : ""}</p>
        <button class="btn primary block" type="submit">Publish</button></form></div>`;
    $("#post-file").addEventListener("change", (e) => {
      const f = e.target.files[0], box = $("#post-preview");
      if (!f) { box.innerHTML = ""; return; }
      if (f.size > MAX_BYTES) { toast("That file is over 50 MB", "err"); e.target.value = ""; box.innerHTML = ""; return; }
      const url = URL.createObjectURL(f);
      box.innerHTML = f.type.startsWith("video/") ? `<video src="${url}" controls muted style="width:100%;max-height:260px;border-radius:12px;background:#000"></video>`
        : `<img src="${url}" alt="" style="width:100%;max-height:260px;object-fit:contain;border-radius:12px;background:#000">`;
    });
  };
  App.actions["post-type"] = (el) => { S.postPreset = el.dataset.type; App.route(); };

  /** Read duration and grab a poster frame from a video File. */
  function probeVideo(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file), v = document.createElement("video");
      let settled = false;
      const done = (r) => { if (settled) return; settled = true; URL.revokeObjectURL(url); resolve(r); };
      v.muted = true; v.playsInline = true; v.preload = "metadata"; v.src = url;
      v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 2) * 0.1); };
      v.onseeked = () => {
        try {
          const w = Math.min(640, v.videoWidth || 640), h = Math.round(w * ((v.videoHeight || 360) / (v.videoWidth || 640)));
          const c = document.createElement("canvas"); c.width = w; c.height = h;
          c.getContext("2d").drawImage(v, 0, 0, w, h);
          c.toBlob((b) => done({ duration: v.duration || 0, poster: b }), "image/jpeg", 0.8);
        } catch (e) { done({ duration: v.duration || 0, poster: null }); }
      };
      v.onerror = () => done({ duration: 0, poster: null });
      setTimeout(() => done({ duration: v.duration || 0, poster: null }), 8000);
    });
  }
  const extOf = (file) => (file.name.split(".").pop() || file.type.split("/")[1] || "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "bin";

  App.forms.post = async (form, data) => {
    const file = $("#post-file").files[0];
    if (!file) throw new Error("Choose a file first");
    if (file.size > MAX_BYTES) throw new Error("That file is over 50 MB");
    const type = data.type;
    if ((type === "video" || type === "clip") && !file.type.startsWith("video/")) throw new Error("Please choose a video file");
    if (type === "photo" && !file.type.startsWith("image/")) throw new Error("Please choose an image");
    const btn = form.querySelector("button[type=submit]");
    btn.textContent = "Uploading...";
    const id = crypto.randomUUID(), base = `${S.user.id}/${id}`;
    const uploaded = [];
    try {
      let duration = 0, poster = null;
      if (file.type.startsWith("video/")) ({ duration, poster } = await probeVideo(file));
      const mediaPath = `${base}/media.${extOf(file)}`;
      await api.upload(mediaPath, file); uploaded.push(mediaPath);
      let posterPath = null;
      if (poster) { posterPath = `${base}/poster.jpg`; await api.upload(posterPath, new File([poster], "poster.jpg", { type: "image/jpeg" })); uploaded.push(posterPath); }
      await api.post("/posts/create", {
        type, title: (data.title || "").trim(), caption: (data.caption || "").trim(), visibility: data.visibility || "public",
        media_path: mediaPath, poster_path: posterPath, mime: file.type || "application/octet-stream",
        duration: Math.round(duration * 10) / 10, size: file.size,
      });
    } catch (e) {
      api.removeFiles(uploaded);
      btn.textContent = "Publish";
      throw e;
    }
    storyCache.at = 0;
    toast(type === "story" ? "Story posted for 24 hours" : "Published!");
    S.postPreset = "video";
    App.go("/home");
  };

  // ============================================================ Search
  const followBtn = (u) => u.is_me ? "" : `<button class="btn sm ${u.is_following ? "" : "primary"}" data-action="follow" data-user="${esc(u.username)}" data-following="${u.is_following ? 1 : 0}">${u.is_following ? "Following" : "Follow"}</button>`;
  App.followBtn = followBtn;

  App.actions.follow = async (el, ev) => {
    ev.stopPropagation();
    const now = el.dataset.following !== "1";
    await App.busy(el, async () => {
      await api.post("/users/follow", { username: el.dataset.user, follow: now });
      $$(`[data-action="follow"][data-user="${el.dataset.user}"]`).forEach((b) => {
        b.dataset.following = now ? "1" : "0"; b.textContent = now ? "Following" : "Follow"; b.classList.toggle("primary", !now);
      });
      storyCache.at = 0;
    });
  };

  App.routes.search = async (ctx) => {
    ctx.view.innerHTML = `<div class="page" style="max-width:760px"><div class="page-head"><h2>Search</h2></div>
      <input id="q" type="search" placeholder="Search people and videos" autocomplete="off" autofocus>
      <div id="results" style="margin-top:18px"><div class="empty">${icon("search")}<h3>Find people and videos</h3><p>Type at least 2 characters.</p></div></div></div>`;
    const input = $("#q");
    let seq = 0;
    const run = App.debounce(async () => {
      const q = input.value.trim(), my = ++seq;
      if (q.length < 2) return;
      try {
        const [u, p] = await Promise.all([api.get("/users/search?q=" + encodeURIComponent(q)), api.get("/posts/feed?tab=recommended&limit=24&q=" + encodeURIComponent(q))]);
        if (my !== seq || ctx.stale()) return;
        remember(p.posts);
        $("#results").innerHTML = (u.users.length ? `<h3 style="margin-bottom:8px">People</h3><div class="list-card card">${u.users.map((x) =>
          `<div class="user-row" data-action="open-profile" data-user="${esc(x.username)}">${avatar(x, "m")}<div class="grow"><b>${esc(x.display_name)}</b><div class="muted small">@${esc(x.username)}</div></div>${followBtn(x)}</div>`).join("")}</div>` : "")
          + (p.posts.length ? `<h3 style="margin:20px 0 8px">Videos & photos</h3><div class="grid">${p.posts.map(vcard).join("")}</div>` : "");
        if (!u.users.length && !p.posts.length) $("#results").innerHTML = emptyBox("search", "No results", `Nothing matched "${q}".`);
      } catch (e) { fail(e); }
    }, 300);
    input.addEventListener("input", run);
  };

  // ============================================================ Notifications
  App.routes.notifications = async (ctx) => {
    const { items } = await api.get("/users/notifications");
    if (ctx.stale()) return;
    ctx.view.innerHTML = `<div class="page" style="max-width:680px"><div class="page-head"><h2>Notifications</h2></div>` + (items.length
      ? `<div class="list-card card">${items.map((n) => n.type === "follow"
        ? `<div class="user-row" data-action="open-profile" data-user="${esc(n.user.username)}">${avatar(n.user, "m")}<div class="grow"><b>${esc(n.user.display_name)}</b> started following you<div class="muted small">${App.timeAgo(n.at)}</div></div></div>`
        : `<div class="user-row" data-action="open-notif-post" data-id="${esc(n.post.id)}" data-user="${esc(n.user.username)}">${avatar(n.user, "m")}<div class="grow"><b>${esc(n.user.display_name)}</b> posted ${n.post.type === "photo" ? "a photo" : n.post.type === "clip" ? "a clip" : "a video"}: ${esc(n.post.title)}<div class="muted small">${App.timeAgo(n.at)}</div></div>
          ${n.post.poster_url ? `<img src="${esc(n.post.poster_url)}" alt="" style="width:64px;height:40px;object-fit:cover;border-radius:8px">` : ""}</div>`).join("")}</div>`
      : emptyBox("bell", "You're all caught up", "New followers and posts from people you follow show up here.")) + "</div>";
  };
  App.actions["open-notif-post"] = (el) => openPostById(el.dataset.id, el.dataset.user).catch(fail);

  // ============================================================ Profile modal
  async function openProfile(username) {
    if (username === S.user.username) { App.closeAllModals(); App.go("/you"); return; }
    try {
      const [u, f] = await Promise.all([api.get("/users/" + encodeURIComponent(username)), api.get("/posts/feed?tab=user&limit=24&username=" + encodeURIComponent(username))]);
      remember(f.posts);
      modal(`<div class="profile-head">${avatar(u, "xl")}<div class="grow"><h3 style="padding:0">${esc(u.display_name)}</h3><div class="muted">@${esc(u.username)}</div>
        <div class="stats"><div><b>${u.followers}</b><span class="muted small">followers</span></div><div><b>${u.following}</b><span class="muted small">following</span></div></div>
        <div class="row">${followBtn(u)}<button class="btn sm" data-action="dm" data-user="${esc(u.username)}">Message</button></div></div></div>
        ${u.bio ? `<p style="white-space:pre-wrap">${esc(u.bio)}</p>` : ""}
        ${f.posts.length ? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px">${f.posts.map((p) =>
          `<div class="vcard" data-action="open-post" data-id="${esc(p.id)}"><div class="thumb sq">${p.poster_url || p.type === "photo" ? `<img src="${esc(p.poster_url || p.media_url)}" alt="" loading="lazy">` : ""}</div></div>`).join("")}</div>`
          : emptyBox("play", "No posts yet", "")}`, { cls: "wide", noFocus: true });
    } catch (e) { fail(e); }
  }
  App.openProfile = openProfile;
})();
