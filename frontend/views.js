/* =====================================================================
   LokaChat - views.js   (v4)
   Stories (bar + viewer), post cards with hover-preview, the Home video hub
   (Recommended / Following / Community), community posts, Create, Search,
   notifications drawer, follow helpers and the public-profile modal.
   The watch page, player, comments and Reels live in watch.js.
   ===================================================================== */
(function () {
  "use strict";
  const { S, $, $$, esc, icon, avatar, toast, fail, modal, confirm: confirmBox } = App;
  const api = window.LokaApi;
  const MAX_BYTES = 50 * 1024 * 1024; // matches the Supabase free-plan bucket limit set in schema.sql
  const isVideo = (p) => (p.mime || "").startsWith("video/");

  // ============================================================ follow (optimistic)
  const isFollowing = (u) => (u.is_following != null ? !!u.is_following : S.following.has(u.username));
  App.isFollowing = isFollowing;
  App.followBtn = (u, cls) => u.is_me || u.id === S.user.id ? "" :
    `<button class="${cls || "btn sm"} ${isFollowing(u) ? "" : "primary"}" data-action="follow" data-user="${esc(u.username)}" data-following="${isFollowing(u) ? 1 : 0}">${isFollowing(u) ? "Following" : "Follow"}</button>`;
  const paintFollow = (username, on) => $$(`[data-action="follow"][data-user="${username}"]`).forEach((b) => {
    b.dataset.following = on ? "1" : "0"; b.textContent = on ? "Following" : "Follow"; b.classList.toggle("primary", !on);
  });
  App.actions.follow = async (el, ev) => {
    ev.stopPropagation();
    const name = el.dataset.user, on = el.dataset.following !== "1";
    on ? S.following.add(name) : S.following.delete(name);
    paintFollow(name, on);
    try {
      await api.post("/users/follow", { username: name, follow: on });
      App.cacheDrop("feed:following", "stories", "notes", "profile:");
    } catch (e) {
      on ? S.following.delete(name) : S.following.add(name);
      paintFollow(name, !on); fail(e, "Couldn't update follow");
    }
  };

  // ============================================================ stories
  const VIEWED_KEY = "loka_viewed_stories";
  const viewed = new Set((() => { try { return JSON.parse(localStorage.getItem(VIEWED_KEY) || "[]"); } catch (e) { return []; } })());
  const markViewed = (id) => {
    viewed.add(id);
    try { localStorage.setItem(VIEWED_KEY, JSON.stringify(Array.from(viewed).slice(-500))); } catch (e) { /* ignore */ }
  };
  const groupSeen = (g) => g.items.every((s) => viewed.has(s.id));
  App.groupSeen = groupSeen;

  /** Stories (own + people you follow), grouped per author - own first, unseen before seen. Cached 30s. */
  App.loadStories = async (force) => {
    const hit = S.cache.stories;
    if (!force && hit && Date.now() - hit.at < 30000) return hit.data;
    const { posts } = await api.get("/posts/feed?tab=stories");
    App.remember(posts);
    const map = new Map();
    posts.slice().reverse().forEach((p) => {
      if (!map.has(p.author.id)) map.set(p.author.id, { author: p.author, items: [] });
      map.get(p.author.id).items.push(p);
    });
    const groups = Array.from(map.values()).sort((a, b) => {
      const mine = (g) => (g.author.id === S.user.id ? 0 : 1);
      return mine(a) - mine(b) || groupSeen(a) - groupSeen(b);
    });
    App.cacheSet("stories", groups);
    return groups;
  };

  App.storyItemsHtml = (groups, withAdd) => {
    const mine = groups.find((g) => g.author.id === S.user.id);
    let html = "";
    if (withAdd) {
      html += `<div class="story-item" ${mine ? `data-action="open-story" data-id="${esc(S.user.id)}"` : 'data-action="add-story"'}>
        <span class="story-add">${avatar(S.user, "l", mine ? (groupSeen(mine) ? "seen" : "new") : null, mine ? S.user.id : null)}
        <span class="plus" data-action="add-story">+</span></span><span class="nm ellipsis">Your story</span></div>`;
    }
    groups.forEach((g) => {
      if (g.author.id === S.user.id && withAdd) return;
      html += `<div class="story-item" data-action="open-story" data-id="${esc(g.author.id)}">${avatar(g.author, "l", groupSeen(g) ? "seen" : "new", g.author.id)}
        <span class="nm ellipsis">${esc(g.author.id === S.user.id ? "Your story" : g.author.display_name)}</span></div>`;
    });
    return html;
  };
  App.actions["add-story"] = (el, ev) => { ev.stopPropagation(); S.postPreset = "story"; App.go("/post"); };
  App.actions["open-story"] = async (el) => {
    const groups = await App.loadStories();
    const i = groups.findIndex((g) => g.author.id === el.dataset.id);
    if (i >= 0) openStories(groups, i);
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
      const isVid = isVideo(s);
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
          App.cacheDrop("stories");
          if (!groups[gi].items.length) { groups.splice(gi, 1); if (!groups.length) { close(); return; } ii = 0; if (gi >= groups.length) gi = groups.length - 1; }
          else if (ii >= groups[gi].items.length) ii = groups[gi].items.length - 1;
          show(); toast("Story deleted");
        } catch (err) { fail(err); show(); }
      }
    });
    show();
  }

  // ============================================================ cards
  const kindIcon = (p) => (p.type === "photo" ? "image" : p.type === "clip" ? "clips" : "play");
  const kindLabel = (p) => (p.type === "photo" ? "Photo" : p.type === "clip" ? "Reel" : "Video");
  App.postThumb = (p) => p.poster_url || (p.type === "photo" || p.type === "community" ? p.media_url : "") || "";

  function vcard(p) {
    if (p.type === "community") return ccard(p);
    const thumb = App.postThumb(p);
    return `<article class="vcard" data-action="open-post" data-id="${esc(p.id)}">
      <div class="thumb" ${isVideo(p) ? `data-prev="${esc(p.media_url)}"` : ""}>${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy">` : ""}
        <span class="kind">${icon(kindIcon(p))}${kindLabel(p)}</span>
        ${p.duration ? `<span class="dur">${App.dur(p.duration)}</span>` : ""}</div>
      <div class="vmeta"><span data-action="open-profile" data-user="${esc(p.author.username)}">${avatar(p.author, "s")}</span>
        <div class="grow"><div class="vtitle">${esc(p.title)}</div>
        <div class="muted small">${esc(p.author.display_name)} · ${App.num(p.views)} views · ${App.timeAgo(p.created_at)}</div></div></div></article>`;
  }
  App.vcard = vcard;

  const likeBtn = (p, cls) => `<button class="chip-btn ${cls || ""} ${p.liked ? "liked" : ""}" data-action="like" data-like="${esc(p.id)}" data-id="${esc(p.id)}" aria-label="Like">${icon("heart")}<span class="n">${App.num(p.likes)}</span></button>`;
  const saveBtn = (p) => `<button class="chip-btn ${p.saved ? "liked" : ""}" data-action="save-post" data-save="${esc(p.id)}" data-id="${esc(p.id)}" aria-label="Save">${icon("bookmark")}</button>`;
  App.likeBtn = likeBtn; App.saveBtn = saveBtn;

  /** Community post card (text + optional image). Double-click / double-tap likes it. */
  function ccard(p) {
    return `<article class="ccard card" data-dbl="like-post" data-id="${esc(p.id)}">
      <div class="row"><span data-action="open-profile" data-user="${esc(p.author.username)}">${avatar(p.author, "s")}</span>
        <div class="grow"><b>${esc(p.author.display_name)}</b><div class="muted small">@${esc(p.author.username)} · ${App.timeAgo(p.created_at)}</div></div></div>
      ${p.title ? `<h3 class="c-title">${esc(p.title)}</h3>` : ""}
      ${p.caption ? `<p class="c-text">${esc(p.caption)}</p>` : ""}
      ${p.media_url ? `<img class="c-img" src="${esc(p.media_url)}" alt="" loading="lazy">` : ""}
      <div class="row c-actions">${likeBtn(p)}<button class="chip-btn" data-action="comments" data-id="${esc(p.id)}">${icon("comment")}<span class="n" data-ccount="${esc(p.id)}">${App.num(p.comments)}</span></button>
        <button class="chip-btn" data-action="share" data-id="${esc(p.id)}">${icon("share")}</button><span class="grow"></span>${saveBtn(p)}
        ${p.author.id === S.user.id ? `<button class="chip-btn" data-action="delete-post" data-id="${esc(p.id)}" aria-label="Delete">${icon("trash")}</button>` : ""}</div></article>`;
  }
  App.dbl["like-post"] = (el, pt) => { App.burst(el, pt); App.toggleLike(el.dataset.id, "on"); };

  App.actions["open-post"] = (el) => { const p = S.postCache.get(el.dataset.id); if (p) App.openPost(p); };
  App.openPost = (p) => {
    App.closeAllModals();
    if (p.type === "community") { App.openComments(p.id); return; }
    App.go("/watch/" + p.id);
  };
  App.actions["open-profile"] = (el, ev) => { ev.stopPropagation(); openProfile(el.dataset.user); };

  App.actions["save-post"] = async (el, ev) => {
    ev.stopPropagation();
    const p = S.postCache.get(el.dataset.id);
    if (!p) return;
    const paint = () => $$(`[data-save="${p.id}"]`).forEach((b) => b.classList.toggle("liked", !!p.saved));
    p.saved = !p.saved; paint();
    try {
      const r = await api.post("/posts/save", { post_id: p.id });
      p.saved = r.saved; paint(); App.cacheDrop("feed:saved"); toast(r.saved ? "Saved" : "Removed from saved");
    } catch (e) { p.saved = !p.saved; paint(); fail(e, "Couldn't save"); }
  };
  App.actions.share = async (el, ev) => {
    ev.stopPropagation();
    const url = location.origin + location.pathname + "#/watch/" + el.dataset.id;
    const p = S.postCache.get(el.dataset.id);
    try {
      if (navigator.share && !App.isDesktop()) { await navigator.share({ title: p ? p.title || "LokaChat" : "LokaChat", url }); return; }
      await navigator.clipboard.writeText(url); toast("Link copied");
    } catch (e) { if (e && e.name !== "AbortError") toast("Couldn't copy the link", "err"); }
  };
  App.actions["delete-post"] = async (el) => {
    if (!(await confirmBox("Delete this post?", "It will be removed permanently.", "Delete", true))) return;
    await App.busy(el, async () => {
      await api.del("/posts/" + el.dataset.id);
      S.postCache.delete(el.dataset.id);
      App.cacheDrop("feed:", "stories", "mine:", "profile:", "history");
      App.closeAllModals(); App.closeDrawers();
      toast("Deleted");
      if (S.route === "watch") App.go("/home"); else { if (App.paintFeed) App.paintFeed(); if (App.refreshYou) App.refreshYou(); }
    });
  };

  // ---------- hover-to-preview (muted live preview inside the thumbnail) ----------
  let hov = null, hovTimer = 0;
  const stopPreview = () => {
    clearTimeout(hovTimer);
    if (!hov) return;
    const v = hov.querySelector("video.prev");
    if (v) { v.pause(); try { v.currentTime = 0; } catch (e) { /* ignore */ } v.remove(); }
    hov.classList.remove("previewing"); hov = null;
  };
  document.addEventListener("mouseover", (e) => {
    if (!window.matchMedia("(hover: hover)").matches) return;
    const t = e.target.closest && e.target.closest(".thumb[data-prev]");
    if (t === hov) return;
    stopPreview();
    if (!t) return;
    hov = t;
    hovTimer = setTimeout(() => {
      if (hov !== t) return;
      const v = document.createElement("video");
      v.className = "prev"; v.muted = true; v.loop = true; v.playsInline = true; v.preload = "metadata"; v.src = t.dataset.prev;
      t.appendChild(v);
      v.play().then(() => t.classList.add("previewing")).catch(() => v.remove());
    }, 250);
  });
  document.addEventListener("mouseout", (e) => { if (hov && !hov.contains(e.relatedTarget)) stopPreview(); });

  // ============================================================ Home hub
  const TABS = [["recommended", "Recommended"], ["following", "Following"], ["community", "Community Posts"]];
  const PILLS = [["all", "All"], ["video", "Videos"], ["photo", "Photos"], ["clip", "Reels"], ["popular", "Popular"], ["new", "Newest"]];
  const feedUrl = (tab) => "/posts/feed?limit=40&tab=" + tab;
  const loadFeed = (tab, force) => App.swr("feed:" + tab, async () => App.remember((await api.get(feedUrl(tab))).posts), () => { if (S.homeTab === tab && S.route === "home") App.paintFeed(); }, { force, fresh: 30000 });
  App.prefetchHome = () => { ["recommended", "following", "community"].forEach((t) => loadFeed(t).catch(() => {})); App.loadStories().catch(() => {}); };

  const applyPill = (posts) => {
    const pill = S.homePill;
    if (pill === "all") return posts;
    if (pill === "popular") return posts.slice().sort((a, b) => (b.views || 0) - (a.views || 0));
    if (pill === "new") return posts.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return posts.filter((p) => p.type === pill);
  };
  App.paintFeed = () => {
    const box = $("#feed"); if (!box) return;
    const tab = S.homeTab, posts = App.cacheGet("feed:" + tab);
    $$("#home-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    $("#home-pills").hidden = tab === "community";
    $$("#home-pills button").forEach((b) => b.classList.toggle("on", b.dataset.pill === S.homePill));
    if (!posts) { box.innerHTML = '<div class="spinner"></div>'; return; }
    stopPreview();
    const list = tab === "community" ? posts : applyPill(posts);
    if (tab === "community") {
      box.innerHTML = `<div class="community">${list.length ? list.map(ccard).join("") : App.emptyBox("users", "No community posts yet", "Share an update, a poll idea or a photo with your followers.", `<button class="btn primary" data-action="create-type" data-type="community">Write a post</button>`)}</div>`;
      return;
    }
    box.innerHTML = list.length ? `<div class="grid">${list.map(vcard).join("")}</div>`
      : App.emptyBox("play", tab === "following" ? "Nothing from people you follow yet" : "No videos here yet",
        tab === "following" ? "Follow people from Search to fill this feed." : "Be the first - upload a video or photo.",
        `<a class="btn primary" href="#/${tab === "following" ? "search" : "post"}">${tab === "following" ? "Find people" : "Upload"}</a>`);
  };
  App.routes.home = {
    mount(pane) {
      pane.innerHTML = `<div class="page"><div class="story-bar hscroll" id="story-bar"></div>
        <div class="sticky-tabs"><div class="subtabs hscroll" id="home-tabs">${TABS.map(([k, l]) => `<button data-action="home-tab" data-tab="${k}">${l}</button>`).join("")}</div>
        <div class="pills hscroll" id="home-pills">${PILLS.map(([k, l]) => `<button data-action="home-pill" data-pill="${k}">${l}</button>`).join("")}</div></div>
        <div id="feed"></div></div>`;
    },
    async show(ctx) {
      const paintStories = (groups) => { const b = $("#story-bar"); if (b) b.innerHTML = App.storyItemsHtml(groups, true); };
      const cs = App.cacheGet("stories"); paintStories(cs || []);
      App.loadStories().then((g) => { if (!ctx.stale()) paintStories(g); }).catch(() => {});
      App.paintFeed();
      await loadFeed(S.homeTab);
      if (!ctx.stale()) App.paintFeed();
    },
  };
  App.actions["home-tab"] = (el) => { S.homeTab = el.dataset.tab; App.paintFeed(); loadFeed(S.homeTab).catch(fail); };
  App.actions["home-pill"] = (el) => { S.homePill = el.dataset.pill; App.paintFeed(); };

  // ============================================================ Create
  const TYPES = [["video", "Video"], ["clip", "Reel"], ["photo", "Photo"], ["story", "Story"], ["community", "Community"]];
  const accept = (t) => (t === "photo" || t === "community" ? "image/*" : t === "story" ? "image/*,video/*" : "video/*");
  const HINT = { story: "Stories are visible to your followers for 24 hours.", clip: "Reels are public short vertical videos.", community: "Community posts appear in the Community tab. An image is optional.", video: "", photo: "" };
  App.actions["create-type"] = (el) => { S.postPreset = el.dataset.type; App.closeMenus(); App.go("/post"); };

  App.routes.post = {
    fresh: true,
    mount(pane) {
      const t = S.postPreset || "video", needFile = t !== "community";
      pane.innerHTML = `<div class="page narrow"><div class="page-head"><h2>Create</h2></div>
        <form class="card section" data-form="post" id="post-form" style="display:grid;gap:14px">
          <div class="tabs hscroll" style="margin:0">${TYPES.map(([k, l]) => `<button type="button" data-action="post-type" data-type="${k}" class="${k === t ? "on" : ""}">${l}</button>`).join("")}</div>
          <input type="hidden" name="type" value="${t}">
          <div class="field"><label>${t === "community" ? "Image (optional)" : "File (max 50 MB)"}</label><input type="file" name="file" accept="${accept(t)}" ${needFile ? "required" : ""} id="post-file"></div>
          <div id="post-preview"></div>
          ${t === "story" ? "" : `<div class="field"><label>${t === "community" ? "Headline (optional)" : "Title"}</label><input name="title" maxlength="100" placeholder="${t === "community" ? "Add a headline" : "Give it a title"}" ${t === "community" ? "" : "required"}></div>`}
          <div class="field"><label>${t === "story" ? "Caption (optional)" : t === "community" ? "What's on your mind?" : "Description (optional)"}</label><textarea name="caption" maxlength="${t === "community" ? 1000 : 500}" ${t === "community" ? "required" : ""}></textarea></div>
          ${t === "clip" ? `<div class="field"><label>Audio / music tag (optional)</label><input name="music" maxlength="80" placeholder="e.g. Original audio - song name"></div>` : ""}
          ${t === "clip" || t === "story" ? "" : `<div class="field"><label>Who can see it</label><select name="visibility"><option value="public">Everyone</option><option value="followers">Followers only</option></select></div>`}
          <p class="muted small">${HINT[t]}</p>
          <button class="btn primary block" type="submit">Publish</button></form></div>`;
      $("#post-file", pane).addEventListener("change", (e) => {
        const f = e.target.files[0], box = $("#post-preview", pane);
        if (!f) { box.innerHTML = ""; return; }
        if (f.size > MAX_BYTES) { toast("That file is over 50 MB", "err"); e.target.value = ""; box.innerHTML = ""; return; }
        const url = URL.createObjectURL(f);
        box.innerHTML = f.type.startsWith("video/") ? `<video src="${url}" controls muted style="width:100%;max-height:260px;border-radius:12px;background:#000"></video>`
          : `<img src="${url}" alt="" style="width:100%;max-height:260px;object-fit:contain;border-radius:12px;background:#000">`;
      });
    },
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
    const file = $("#post-file").files[0], type = data.type;
    if (type !== "community" && !file) throw new Error("Choose a file first");
    if (file && file.size > MAX_BYTES) throw new Error("That file is over 50 MB");
    if ((type === "video" || type === "clip") && !file.type.startsWith("video/")) throw new Error("Please choose a video file");
    if ((type === "photo" || type === "community") && file && !file.type.startsWith("image/")) throw new Error("Please choose an image");
    const btn = form.querySelector("button[type=submit]");
    btn.textContent = "Uploading...";
    const id = crypto.randomUUID(), base = `${S.user.id}/${id}`, uploaded = [];
    let post;
    try {
      let duration = 0, poster = null, mediaPath = null, posterPath = null;
      if (file) {
        if (file.type.startsWith("video/")) ({ duration, poster } = await probeVideo(file));
        mediaPath = `${base}/media.${extOf(file)}`;
        await api.upload(mediaPath, file); uploaded.push(mediaPath);
        if (poster) { posterPath = `${base}/poster.jpg`; await api.upload(posterPath, new File([poster], "poster.jpg", { type: "image/jpeg" })); uploaded.push(posterPath); }
      }
      post = await api.post("/posts/create", {
        type, title: (data.title || "").trim(), caption: (data.caption || "").trim(), visibility: data.visibility || "public",
        media_path: mediaPath, poster_path: posterPath, mime: file ? file.type || "application/octet-stream" : null,
        music: (data.music || "").trim(), duration: Math.round(duration * 10) / 10, size: file ? file.size : 0,
      });
    } catch (e) { api.removeFiles(uploaded); btn.textContent = "Publish"; throw e; }
    const [p] = App.remember([post]);
    App.cacheDrop("stories", "mine:", "profile:");
    // show it immediately in the cached feeds, then refresh in the background
    const prepend = (key) => { const c = App.cacheGet(key); if (c && !c.some((x) => x.id === p.id)) c.unshift(p); };
    if (type === "community") { prepend("feed:community"); prepend("feed:following"); }
    else if (type !== "story") { prepend("feed:recommended"); if (type === "clip") prepend("feed:clips"); }
    toast(type === "story" ? "Story posted for 24 hours" : "Published!");
    S.postPreset = "video";
    S.user.posts = (S.user.posts || 0) + 1;
    App.go(type === "clip" ? "/reels" : type === "community" ? "/home" : "/home");
    if (type === "community") { S.homeTab = "community"; if (App.paintFeed) App.paintFeed(); }
  };

  // ============================================================ Search
  App.routes.search = {
    mount(pane) {
      pane.innerHTML = `<div class="page narrow"><div class="page-head"><h2>Search</h2></div>
        <input id="q" type="search" placeholder="Search people and videos" autocomplete="off">
        <div id="results" style="margin-top:18px"><div class="empty">${icon("search")}<h3>Find people and videos</h3><p>Type at least 2 characters.</p></div></div></div>`;
      const input = $("#q", pane);
      let seq = 0;
      input.addEventListener("input", App.debounce(async () => {
        const q = input.value.trim(), my = ++seq;
        if (q.length < 2) return;
        try {
          const [u, p] = await Promise.all([api.get("/users/search?q=" + encodeURIComponent(q)), api.get("/posts/feed?tab=recommended&limit=24&q=" + encodeURIComponent(q))]);
          if (my !== seq) return;
          App.remember(p.posts);
          $("#results", pane).innerHTML = (u.users.length ? `<h3 style="margin-bottom:8px">People</h3><div class="list-card card">${u.users.map((x) =>
            `<div class="user-row" data-action="open-profile" data-user="${esc(x.username)}">${avatar(x, "m")}<div class="grow"><b>${esc(x.display_name)}</b><div class="muted small">@${esc(x.username)}</div></div>${App.followBtn(x)}</div>`).join("")}</div>` : "")
            + (p.posts.length ? `<h3 style="margin:20px 0 8px">Videos & posts</h3><div class="grid">${p.posts.map(vcard).join("")}</div>` : "");
          if (!u.users.length && !p.posts.length) $("#results", pane).innerHTML = App.emptyBox("search", "No results", `Nothing matched "${q}".`);
        } catch (e) { fail(e); }
      }, 300));
    },
    show(ctx) { if (App.isDesktop()) setTimeout(() => { const i = $("#q", ctx.pane); if (i) i.focus(); }, 30); },
  };

  // ============================================================ Notifications drawer
  let notifTimer = 0;
  const setDot = (n) => {
    ["#notif-dot", "#notif-dot-m", "#notif-dot-r"].forEach((id) => { const d = $(id); if (d) { d.hidden = !n; d.textContent = n > 9 ? "9+" : String(n || ""); } });
  };
  App.pollNotifs = async () => {
    try { const r = await api.get("/users/notifications"); App.cacheSet("notifs", r); setDot(r.unread); return r; } catch (e) { return null; }
  };
  App.startNotifPolling = () => { clearInterval(notifTimer); App.pollNotifs(); notifTimer = setInterval(() => { if (!document.hidden) App.pollNotifs(); }, 45000); };
  App.stopNotifPolling = () => { clearInterval(notifTimer); setDot(0); };

  const notifText = (n) => n.type === "follow" ? "started following you"
    : n.type === "like" ? `liked your ${n.post.type === "photo" ? "photo" : n.post.type === "community" ? "post" : n.post.type === "clip" ? "reel" : "video"}${n.post.title ? ": " + esc(n.post.title) : ""}`
    : `commented${n.text ? ": " + esc(n.text) : ""}`;
  App.actions["open-notifs"] = async () => {
    const draw = (r) => {
      const box = $("#notif-list"); if (!box) return;
      box.innerHTML = r.items.length ? r.items.map((n) => `<div class="user-row" data-action="notif-open" data-type="${n.type}" data-user="${esc(n.user.username)}" ${n.post ? `data-id="${esc(n.post.id)}" data-ptype="${esc(n.post.type)}"` : ""}>
        ${avatar(n.user, "m")}<div class="grow"><b>${esc(n.user.display_name)}</b> ${notifText(n)}<div class="muted small">${App.timeAgo(n.at)}</div></div>
        ${n.post && n.post.poster_url ? `<img class="n-thumb" src="${esc(n.post.poster_url)}" alt="">` : n.type === "follow" ? App.followBtn(n.user) : ""}</div>`).join("")
        : App.emptyBox("heart", "You're all caught up", "Likes, comments and new followers show up here.");
    };
    App.drawer(`<h3 class="d-title">Notifications</h3><div class="d-body" id="notif-list"><div class="spinner"></div></div>`, { cls: "notifs" });
    const cached = App.cacheGet("notifs"); if (cached) draw(cached);
    const r = (await App.pollNotifs()) || cached;
    if (r) { draw(r); if (r.unread) { setDot(0); api.post("/users/notifications/seen", {}).then(() => { if (r.unread) r.unread = 0; }).catch(() => {}); } }
  };
  App.actions["notif-open"] = async (el) => {
    App.closeDrawers();
    if (el.dataset.type === "follow") { openProfile(el.dataset.user); return; }
    try {
      let p = S.postCache.get(el.dataset.id);
      if (!p) [p] = App.remember([await api.get("/posts/" + el.dataset.id)]);
      App.openPost(p);
    } catch (e) { toast("That post is no longer available", "err"); }
  };

  // ============================================================ Profile modal (other people)
  async function openProfile(username) {
    if (username === S.user.username) { App.closeAllModals(); App.closeDrawers(); App.go("/you"); return; }
    try {
      const [u, f] = await Promise.all([api.get("/users/" + encodeURIComponent(username)), api.get("/posts/feed?tab=user&limit=24&username=" + encodeURIComponent(username))]);
      App.remember(f.posts);
      if (u.is_following) S.following.add(u.username); else S.following.delete(u.username);
      modal(`<div class="profile-head">${avatar(u, "xl")}<div class="grow"><h3 style="padding:0">${esc(u.display_name)}</h3><div class="muted">@${esc(u.username)}</div>
        <div class="stats"><div><b>${u.posts != null ? u.posts : f.posts.length}</b><span class="muted small">posts</span></div><div><b>${u.followers}</b><span class="muted small">followers</span></div><div><b>${u.following}</b><span class="muted small">following</span></div></div>
        <div class="row">${App.followBtn(u)}<button class="btn sm" data-action="dm" data-user="${esc(u.username)}">Message</button></div></div></div>
        ${u.bio ? `<p style="white-space:pre-wrap">${esc(u.bio)}</p>` : ""}
        ${f.posts.length ? `<div class="mini-grid">${f.posts.map((p) => `<div class="vcard" data-action="open-post" data-id="${esc(p.id)}"><div class="thumb sq">${App.postThumb(p) ? `<img src="${esc(App.postThumb(p))}" alt="" loading="lazy">` : `<span class="c-ph">${esc((p.caption || p.title || "").slice(0, 60))}</span>`}</div></div>`).join("")}</div>`
          : App.emptyBox("play", "No posts yet", "")}`, { cls: "wide", noFocus: true });
    } catch (e) { fail(e); }
  }
  App.openProfile = openProfile;
})();
