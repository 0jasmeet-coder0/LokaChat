/* =====================================================================
   LokaChat - watch.js   (v4, extended in v6)
   Comments (optimistic, replies, likes), the custom video player, the
   YouTube-style Theater Watch page and the Instagram-style Reels feed.
   ===================================================================== */
(function () {
  "use strict";
  const { S, $, $$, esc, icon, avatar, toast, fail } = App;
  const api = window.LokaApi;
  const isVideo = (p) => (p.mime || "").startsWith("video/");

  // ============================================================ comments
  const ckey = (id) => "comments:" + id;
  const list = (id) => App.cacheGet(ckey(id)) || [];
  const postOf = (id) => S.postCache.get(id);

  function commentHtml(c, replies, post) {
    const mine = c.author && c.author.id === S.user.id, canDel = mine || (post && post.author.id === S.user.id);
    const a = c.author || {}, owner = !!(post && post.author.id === S.user.id), tmp = c.id.startsWith("tmp-");
    const gif = c.gif_url ? (c.gif_url.startsWith("sticker:") ? `<div class="cm-sticker">${esc(c.gif_url.slice(8))}</div>` : `<img class="cm-gif" src="${esc(c.gif_url)}" alt="GIF" loading="lazy">`) : "";
    return `<div class="cm ${tmp ? "pending" : ""} ${c.pinned ? "is-pinned" : ""}" data-cid="${esc(c.id)}">${avatar(a, "s")}<div class="grow">
      ${c.pinned ? '<div class="cm-pinned">\u{1F4CC} Pinned by creator</div>' : ""}
      <div class="cm-h"><b data-action="open-profile" data-user="${esc(a.username)}">@${esc(a.username)}</b> <span class="muted small">${App.timeAgo(c.created_at)}</span></div>
      ${c.body ? `<div class="cm-b">${esc(c.body)}</div>` : ""}${gif}
      <div class="cm-a"><button class="chip-btn ${c.liked ? "liked" : ""}" data-action="c-like" data-cid="${esc(c.id)}" data-pid="${esc(c.post_id)}">${icon("heart")}<span class="n">${c.likes ? App.num(c.likes) : ""}</span></button>
        <button class="link-btn small" data-action="c-reply" data-cid="${esc(c.parent_id || c.id)}" data-user="${esc(a.username)}">Reply</button>
        ${owner && !c.parent_id && !tmp ? `<button class="link-btn small" data-action="c-pin" data-cid="${esc(c.id)}" data-pid="${esc(c.post_id)}">${c.pinned ? "Unpin" : "\u{1F4CC} Pin"}</button>` : ""}
        ${canDel && !c.id.startsWith("tmp-") ? `<button class="link-btn small danger-t" data-action="c-del" data-cid="${esc(c.id)}" data-pid="${esc(c.post_id)}">Delete</button>` : ""}</div>
      ${replies.length ? `<div class="cm-replies">${replies.map((r) => commentHtml(r, [], post)).join("")}</div>` : ""}</div></div>`;
  }
  function paintComments(id) {
    const all = list(id), post = postOf(id);
    const tops = all.filter((c) => !c.parent_id).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)), kids = (pid) => all.filter((c) => c.parent_id === pid).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    $$(`[data-comments="${id}"]`).forEach((box) => {
      const body = $(".cm-list", box); if (!body) return;
      body.innerHTML = tops.length ? tops.map((c) => commentHtml(c, kids(c.id), post)).join("") : `<p class="muted small center" style="padding:18px 0">No comments yet. Be the first.</p>`;
      const h = $(".cm-count", box); if (h) h.textContent = all.length + (all.length === 1 ? " Comment" : " Comments");
    });
    $$(`[data-ccount="${id}"]`).forEach((n) => { n.textContent = App.num(all.length); });
  }
  /** Mount the comments UI for a post into `box` (renders cached comments instantly, then refreshes). */
  App.mountComments = (box, id) => {
    box.dataset.comments = id;
    box.innerHTML = `<div class="cm-head"><b class="cm-count">Comments</b></div>
      <form class="cm-form" data-form="comment"><input type="hidden" name="post_id" value="${esc(id)}"><input type="hidden" name="parent_id" value="">
        <div class="cm-reply-chip" hidden><span></span><button type="button" data-action="c-reply-cancel" aria-label="Cancel reply">${icon("close")}</button></div>
        <input type="hidden" name="gif_url" value="">
        <div class="row">${avatar(S.user, "s")}<input name="body" maxlength="500" placeholder="Add a comment..." autocomplete="off">
        <button class="gif-btn" type="button" data-action="c-gif" aria-label="Add a GIF or sticker">GIF</button>
        <button class="btn primary sm" type="submit">Post</button></div>
        <div class="cm-gifchip" hidden></div><div class="cm-pick-host"></div></form>
      <div class="cm-list"><div class="spinner"></div></div>`;
    if (App.cacheGet(ckey(id))) paintComments(id);
    App.swr(ckey(id), async () => (await api.get(`/posts/${id}/comments`)).comments, () => paintComments(id), { fresh: 8000 })
      .catch((e) => { const l = $(".cm-list", box); if (l && !App.cacheGet(ckey(id))) l.innerHTML = `<p class="muted small center">${esc(App.errText(e))}</p>`; });
  };
  App.openComments = (id) => {
    const p = postOf(id);
    const d = App.drawer(`<h3 class="d-title">Comments</h3>
      ${p ? `<div class="d-post row">${avatar(p.author, "s")}<div class="grow"><b>@${esc(p.author.username)}</b><div class="muted small ellipsis">${esc(p.title || p.caption || "")}</div></div></div>` : ""}
      <div class="d-body" id="d-comments"></div>`, { cls: "comments sheet" });
    App.mountComments($("#d-comments", d.el), id);
  };
  App.actions.comments = (el, ev) => { ev.stopPropagation(); App.openComments(el.dataset.id); };

  App.forms.comment = async (form, data) => {
    const id = data.post_id, body = (data.body || "").trim(), gifUrl = data.gif_url || "";
    if (!body && !gifUrl) return;
    const input = form.querySelector("input[name=body]");
    input.value = ""; clearGif(form);
    const tmp = { id: "tmp-" + crypto.randomUUID(), post_id: id, parent_id: data.parent_id || null, body, gif_url: gifUrl, likes: 0, liked: false, created_at: new Date().toISOString(), author: { id: S.user.id, username: S.user.username, display_name: S.user.display_name, avatar_url: S.user.avatar_url } };
    const all = list(id); all.unshift(tmp); App.cacheSet(ckey(id), all);
    const p = postOf(id); if (p) p.comments = (p.comments || 0) + 1;
    resetReply(form); paintComments(id);
    try {
      const r = await api.post("/posts/comment", { post_id: id, body, parent_id: tmp.parent_id || undefined, gif_url: gifUrl || undefined });
      const cur = list(id), i = cur.findIndex((c) => c.id === tmp.id);
      if (i >= 0) cur[i] = r.comment;
      if (p) p.comments = r.comments;
      paintComments(id);
    } catch (e) {
      App.cacheSet(ckey(id), list(id).filter((c) => c.id !== tmp.id));
      if (p) p.comments = Math.max(0, (p.comments || 1) - 1);
      input.value = body; paintComments(id); throw e;
    }
  };
  function clearGif(form) {
    form.elements.gif_url.value = ""; const chip = $(".cm-gifchip", form); if (chip) { chip.hidden = true; chip.innerHTML = ""; }
    const host = $(".cm-pick-host", form); if (host) host.innerHTML = "";
  }
  App.actions["c-gif"] = (el) => {
    const form = el.closest("form"), host = $(".cm-pick-host", form);
    if (host.innerHTML) { host.innerHTML = ""; return; }
    host.innerHTML = '<div class="cm-picker"></div>';
    App.gifPicker($(".cm-picker", host), (url) => {
      form.elements.gif_url.value = url; host.innerHTML = "";
      const chip = $(".cm-gifchip", form); chip.hidden = false;
      chip.innerHTML = (url.startsWith("sticker:") ? `<span class="st">${esc(url.slice(8))}</span>` : `<img src="${esc(url)}" alt="">`) + `<span>attached</span><button type="button" class="icon-btn" data-action="c-gif-x" aria-label="Remove">${icon("close")}</button>`;
      form.elements.body.focus();
    });
  };
  App.actions["c-gif-x"] = (el) => clearGif(el.closest("form"));
  App.actions["c-pin"] = async (el) => {
    const id = el.dataset.pid, before = list(id).map((c) => ({ ...c })), c = list(id).find((x) => x.id === el.dataset.cid);
    if (!c) return;
    const to = !c.pinned;
    list(id).forEach((x) => { x.pinned = to && x.id === c.id; }); paintComments(id);
    try { await api.post("/comments/pin", { comment_id: c.id }); toast(to ? "Comment pinned" : "Comment unpinned"); const r = await api.get(`/posts/${id}/comments`); App.cacheSet(ckey(id), r.comments); paintComments(id); }
    catch (e) { App.cacheSet(ckey(id), before); paintComments(id); fail(e); }
  };
  function resetReply(form) {
    form.elements.parent_id.value = ""; const chip = $(".cm-reply-chip", form); if (chip) chip.hidden = true;
  }
  App.actions["c-reply"] = (el) => {
    const form = $(".cm-form", el.closest("[data-comments]")); if (!form) return;
    form.elements.parent_id.value = el.dataset.cid;
    const chip = $(".cm-reply-chip", form); chip.hidden = false; $("span", chip).textContent = "Replying to @" + el.dataset.user;
    form.elements.body.focus();
  };
  App.actions["c-reply-cancel"] = (el) => resetReply(el.closest("form"));
  App.actions["c-like"] = async (el) => {
    const id = el.dataset.pid, c = list(id).find((x) => x.id === el.dataset.cid);
    if (!c || c.id.startsWith("tmp-")) return;
    const was = { liked: c.liked, likes: c.likes };
    c.liked = !c.liked; c.likes = Math.max(0, c.likes + (c.liked ? 1 : -1)); paintComments(id);
    try { const r = await api.post("/comments/like", { comment_id: c.id }); c.liked = r.liked; c.likes = r.likes; paintComments(id); }
    catch (e) { Object.assign(c, was); paintComments(id); fail(e); }
  };
  App.actions["c-del"] = async (el) => {
    const id = el.dataset.pid, before = list(id).slice();
    if (!(await App.confirm("Delete comment?", "Replies to it are removed too.", "Delete", true))) return;
    const gone = el.dataset.cid;
    App.cacheSet(ckey(id), before.filter((c) => c.id !== gone && c.parent_id !== gone)); paintComments(id);
    try { const r = await api.del("/comments/" + gone); const p = postOf(id); if (p) p.comments = r.comments; paintComments(id); }
    catch (e) { App.cacheSet(ckey(id), before); paintComments(id); fail(e); }
  };

  // ============================================================ custom video player
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const QUALITIES = ["Auto", "1080p", "720p", "480p", "360p"];

  function makePlayer(box, p, opts) {
    opts = opts || {};
    box.innerHTML = `<div class="vplayer" tabindex="0" data-dbl="like-post" data-id="${esc(p.id)}">
      <video preload="metadata" playsinline ${p.poster_url ? `poster="${esc(p.poster_url)}"` : ""} src="${esc(p.media_url)}"></video>
      <div class="vp-center">${icon("play")}</div><div class="vp-cc"></div>
      <div class="mini-ctl" data-p="mini-max"><button type="button" data-p="mini-play" aria-label="Play or pause">${icon("pause")}</button><button type="button" class="mini-x" data-p="mini-close" aria-label="Close miniplayer">${icon("close")}</button></div>
      <div class="vp-bar" data-nodbl>
        <input class="vp-seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek">
        <div class="vp-row">
          <button class="vp-b" data-p="play" aria-label="Play">${icon("play")}</button>
          <button class="vp-b" data-p="mute" aria-label="Mute">${icon("volume")}</button>
          <input class="vp-vol" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume">
          <span class="vp-time">0:00 / 0:00</span><span class="grow"></span>
          <button class="vp-b vp-txt" data-p="cc" aria-label="Captions">CC</button>
          <span class="vp-pop" data-pm="quality"><button class="vp-b vp-txt" data-p="menu" data-m="quality">Auto</button><div class="vp-menu"><div class="vp-mh">Quality</div>
            ${QUALITIES.map((q) => `<button data-p="q" data-q="${q}" class="${q === "Auto" ? "on" : ""}">${q}${q === "Auto" ? " (adaptive)" : q === "360p" ? " Data Saver" : q === "1080p" ? " HD" : ""}</button>`).join("")}
            <div class="vp-note">Resolution is scaled on this device from the one stored file.</div></div></span>
          <span class="vp-pop" data-pm="speed"><button class="vp-b vp-txt" data-p="menu" data-m="speed">1x</button><div class="vp-menu"><div class="vp-mh">Speed</div>
            ${SPEEDS.map((s) => `<button data-p="speed" data-s="${s}" class="${s === 1 ? "on" : ""}">${s === 1 ? "Normal" : s + "x"}</button>`).join("")}</div></span>
          <button class="vp-b" data-p="pip" aria-label="Picture in picture">${icon("pip")}</button>
          <button class="vp-b" data-p="full" aria-label="Fullscreen">${icon("full")}</button></div></div></div>`;
    const root = $(".vplayer", box), v = $("video", root), seek = $(".vp-seek", root), vol = $(".vp-vol", root), time = $(".vp-time", root);
    let dragging = false, idleT = 0, clickT = 0, lastSent = 0, counted = false, docked = false, dismissed = false, releasedFromDrag = 0;
    const scaler = App.attachScaler(root, v, ({ q, effective }) => { const l = $("[data-m=quality]", root); if (l) l.textContent = q === "Auto" ? "Auto" + (effective ? " · " + effective + "p" : "") : q; });
    const cc = App.attachCC(root, v);
    const undock = () => { docked = false; root.classList.remove("mini"); box.style.minHeight = ""; };
    const fmt = (s) => App.dur(isFinite(s) ? s : 0);
    const setFill = (el, f) => el.style.setProperty("--p", (f * 100).toFixed(1) + "%");
    const paintPlay = () => {
      const paused = v.paused;
      root.classList.toggle("paused", paused);
      $("[data-p=play]", root).innerHTML = icon(paused ? "play" : "pause");
      $("[data-p=mini-play]", root).innerHTML = icon(paused ? "play" : "pause");
    };
    const paintTime = () => {
      const d = v.duration || p.duration || 0;
      time.textContent = fmt(v.currentTime) + " / " + fmt(d);
      if (!dragging) { const f = d ? v.currentTime / d : 0; seek.value = String(Math.round(f * 1000)); setFill(seek, f); }
    };
    const toggle = () => { if (!preDone) { startPreRoll(); return; } v.paused ? v.play().catch(() => {}) : v.pause(); };
    const send = (count) => api.post("/posts/view", { post_id: p.id, position: v.currentTime || 0, duration: isFinite(v.duration) ? v.duration : p.duration || 0, count })
      .then((r) => { if (count && r && typeof r.views === "number") p.views = r.views; }).catch(() => {});
    v.addEventListener("play", () => { paintPlay(); if (!counted) { counted = true; send(true); } });
    v.addEventListener("pause", paintPlay);
    v.addEventListener("ended", () => { paintPlay(); send(false); });
    v.addEventListener("loadedmetadata", paintTime);
    v.addEventListener("timeupdate", () => {
      paintTime();
      if (!midDone && AD_PLACE === "midroll" && isFinite(v.duration) && v.duration && v.currentTime / v.duration >= 0.5) { midDone = true; try { v.pause(); } catch (er) { /* ignore */ } runAd(() => v.play().catch(() => {})); }
      if (Date.now() - lastSent > 10000) { lastSent = Date.now(); send(false); }
    });
    v.addEventListener("volumechange", () => { $("[data-p=mute]", root).innerHTML = icon(v.muted || v.volume === 0 ? "mute" : "volume"); });
    v.addEventListener("error", () => toast("This video couldn't be played", "err"));
    seek.addEventListener("input", () => { dragging = true; const d = v.duration || 0; if (d) v.currentTime = (seek.value / 1000) * d; setFill(seek, seek.value / 1000); });
    seek.addEventListener("change", () => { dragging = false; });
    vol.addEventListener("input", () => { v.volume = Number(vol.value); v.muted = v.volume === 0; setFill(vol, Number(vol.value)); });
    setFill(vol, 1);
    // single click toggles play, double click likes (delay tells them apart)
    $(".vp-center", root).addEventListener("click", () => { clearTimeout(clickT); clickT = setTimeout(toggle, 230); });
    v.addEventListener("click", () => { clearTimeout(clickT); clickT = setTimeout(toggle, 230); });
    root.addEventListener("dblclick", () => clearTimeout(clickT), true);
    root.addEventListener("mousemove", () => { root.classList.remove("idle"); clearTimeout(idleT); idleT = setTimeout(() => { if (!v.paused) root.classList.add("idle"); }, 2500); });
    root.addEventListener("click", (e) => {
      const b = e.target.closest("[data-p]"); if (!b) return;
      e.stopPropagation();
      const k = b.dataset.p;
      if (k === "play") toggle();
      else if (k === "mute") { v.muted = !v.muted; }
      else if (k === "menu") { const pop = b.closest(".vp-pop"), open = !pop.classList.contains("open"); $$(".vp-pop", root).forEach((x) => x.classList.remove("open")); pop.classList.toggle("open", open); }
      else if (k === "speed") { v.playbackRate = Number(b.dataset.s); $("[data-m=speed]", root).textContent = b.dataset.s === "1" ? "1x" : b.dataset.s + "x"; $$("[data-p=speed]", root).forEach((x) => x.classList.toggle("on", x === b)); $$(".vp-pop", root).forEach((x) => x.classList.remove("open")); }
      else if (k === "q") { scaler.set(b.dataset.q); $$("[data-p=q]", root).forEach((x) => x.classList.toggle("on", x === b)); $$(".vp-pop", root).forEach((x) => x.classList.remove("open")); }
      else if (k === "cc") { b.classList.toggle("on", cc.toggle()); }
      else if (k === "mini-play") toggle();
      else if (k === "mini-close") { dismissed = true; try { v.pause(); } catch (er) { /* ignore */ } undock(); }
      else if (k === "mini-max") { if (Date.now() - releasedFromDrag < 350) return; undock(); box.scrollIntoView({ behavior: "smooth", block: "center" }); }
      else if (k === "pip") {
        if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
        else if (v.requestPictureInPicture) v.requestPictureInPicture().catch(() => toast("Picture-in-picture isn't available here", "err"));
        else toast("Picture-in-picture isn't supported in this browser", "err");
      }
      else if (k === "full") { document.fullscreenElement ? document.exitFullscreen() : (root.requestFullscreen ? root.requestFullscreen().catch(() => {}) : v.webkitEnterFullscreen && v.webkitEnterFullscreen()); }
    });
    // ---- miniplayer: drag to any corner (pointer events cover mouse + touch), tap to maximize ----
    const ctl = $(".mini-ctl", root);
    let pdrag = null;
    const clampXY = (x, y) => {
      const w = root.offsetWidth || 220, h = root.offsetHeight || 124, pad = 8;
      return { x: Math.min(Math.max(pad, x), Math.max(pad, window.innerWidth - w - pad)), y: Math.min(Math.max(pad, y), Math.max(pad, window.innerHeight - h - pad)) };
    };
    const place = (x, y) => { root.style.left = x + "px"; root.style.top = y + "px"; root.style.right = "auto"; root.style.bottom = "auto"; };
    ctl.addEventListener("pointerdown", (e) => {
      if (!root.classList.contains("mini")) return;
      if (e.button && e.button !== 0) return;
      if (e.target.closest("button")) return;                 // let the play / close buttons work
      const r = root.getBoundingClientRect();
      pdrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
      try { ctl.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
      e.preventDefault();
    });
    ctl.addEventListener("pointermove", (e) => {
      if (!pdrag || e.pointerId !== pdrag.id) return;
      const dx = e.clientX - pdrag.sx, dy = e.clientY - pdrag.sy;
      if (!pdrag.moved && Math.hypot(dx, dy) < 6) return;     // a small wobble is still a tap
      if (!pdrag.moved) { pdrag.moved = true; root.classList.add("dragging", "dragged"); }
      const pos = clampXY(pdrag.ox + dx, pdrag.oy + dy);
      place(pos.x, pos.y);
    });
    const endDrag = (e) => {
      if (!pdrag || (e && e.pointerId !== pdrag.id)) return;
      const moved = pdrag.moved; pdrag = null;
      root.classList.remove("dragging");
      if (!moved) return;                                     // a tap -> the click handler maximizes
      releasedFromDrag = Date.now();                          // suppress the click that follows the drag
      const w = root.offsetWidth || 220, h = root.offsetHeight || 124, pad = 10;
      const box2 = root.getBoundingClientRect();
      const x = box2.left + w / 2 < window.innerWidth / 2 ? pad : window.innerWidth - w - pad;
      const y = box2.top + h / 2 < window.innerHeight / 2 ? pad : window.innerHeight - h - pad;
      place(x, y);                                            // snap to the nearest corner
    };
    ctl.addEventListener("pointerup", endDrag);
    ctl.addEventListener("pointercancel", endDrag);
    // ---- sponsored ads: skippable 5s pre-roll and mid-roll (only for sponsored videos) ----
    const AD_PLACE = p.is_sponsored ? (p.ad_placement || "none") : "none";
    let preDone = AD_PLACE !== "preroll", midDone = false, adTick = 0, adNode = null;
    function runAd(done) {
      if (adNode) return;
      const wrap = document.createElement("div");
      wrap.innerHTML = `<div class="ad-layer"><div class="ad-top"><span class="spons">Sponsored</span><span class="ad-t ellipsis">${esc(p.title || "Promoted")} · ${esc(p.author.display_name)}</span></div>${p.poster_url ? `<img alt="" src="${esc(p.poster_url)}" style="width:100%;height:100%;object-fit:contain;background:#000">` : ""}<div class="ad-bot"><span class="ad-t" data-adcount>Ad · 5s</span><button type="button" class="ad-skip" data-p="ad-skip" disabled>Skip in 5</button></div></div>`;
      adNode = wrap.firstElementChild; root.appendChild(adNode);
      const skip = $("[data-p=ad-skip]", adNode), count = $("[data-adcount]", adNode);
      let left = 5, finished = false;
      const paint = () => { skip.textContent = left > 0 ? "Skip in " + left : "Skip Ad"; skip.disabled = left > 0; if (count) count.textContent = left > 0 ? "Ad · " + left + "s" : "Skip to continue"; };
      const finish = () => { if (finished) return; finished = true; clearInterval(adTick); if (adNode) { adNode.remove(); adNode = null; } if (done) done(); };
      paint();
      adTick = setInterval(() => { left -= 1; paint(); if (left <= 0) { clearInterval(adTick); setTimeout(finish, 2000); } }, 1000);
      skip.addEventListener("click", () => { if (!skip.disabled) finish(); });
    }
    function startPreRoll() { if (preDone || adNode) return; try { v.pause(); } catch (er) { /* ignore */ } runAd(() => { preDone = true; v.play().catch(() => {}); }); }
    const key = (e) => {
      if (S.route !== "watch" || /INPUT|TEXTAREA|SELECT/.test((e.target.tagName || "")) && e.target.type !== "range") return;
      if (e.key === " " || e.key === "k") { e.preventDefault(); toggle(); }
      else if (e.key === "ArrowRight") v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 5);
      else if (e.key === "ArrowLeft") v.currentTime = Math.max(0, v.currentTime - 5);
      else if (e.key === "m") v.muted = !v.muted;
      else if (e.key === "f") $("[data-p=full]", root).click();
    };
    document.addEventListener("keydown", key);
    paintPlay(); paintTime();
    return {
      el: root, video: v, toggle,
      /** Dock into the floating miniplayer when the stage scrolls out of view (only once playback has started). */
      dock(want) {
        if (!want) dismissed = false;
        const on = want && !dismissed && (v.currentTime > 0 || !v.paused);
        if (on === docked) return;
        if (on) box.style.minHeight = box.getBoundingClientRect().height + "px";
        docked = on; root.classList.toggle("mini", on);
        // always re-anchor to the default corner (clears any inline drag position)
        root.classList.remove("dragging", "dragged");
        root.style.left = root.style.top = root.style.right = root.style.bottom = "";
        if (!on) box.style.minHeight = "";
      },
      destroy() { scaler.destroy(); cc.destroy(); document.removeEventListener("keydown", key); clearTimeout(clickT); clearTimeout(idleT); clearInterval(adTick); if (adNode) { adNode.remove(); adNode = null; } try { v.pause(); } catch (e) { /* ignore */ } if (counted) send(false); v.removeAttribute("src"); v.load(); },
    };
  }
  App.makePlayer = makePlayer;

  // ============================================================ Watch page
  let player = null, stageIO = null;
  const disliked = new Set((() => { try { return JSON.parse(localStorage.getItem("loka_disliked") || "[]"); } catch (e) { return []; } })());
  const upNext = (cur) => {
    const pool = (App.cacheGet("feed:recommended") || []).filter((x) => x.id !== cur.id && x.type !== "community");
    return pool.map((x) => `<div class="next-item" data-action="open-post" data-id="${esc(x.id)}"><div class="thumb">${App.postThumb(x) ? `<img src="${esc(App.postThumb(x))}" alt="" loading="lazy">` : ""}${x.duration ? `<span class="dur">${App.dur(x.duration)}</span>` : ""}</div>
      <div class="grow"><div class="vtitle">${esc(x.title)}</div><div class="muted small">${esc(x.author.display_name)}<br>${App.num(x.views)} views · ${App.timeAgo(x.created_at)}</div></div></div>`).join("")
      || `<p class="muted small">Nothing else to watch yet.</p>`;
  };
  function paintWatch(pane, p) {
    const vid = isVideo(p);
    pane.innerHTML = `<div class="watch"><div class="w-main">
      <div class="w-stage ${p.type === "clip" ? "tall" : ""}" id="w-stage"></div>
      <h1 class="w-title">${esc(p.title || "Untitled")}</h1>
      ${p.is_sponsored ? `<div class="w-sponsor"><span class="spons">Sponsored</span><span class="muted small grow">Promoted by ${esc(p.author.display_name)}</span>${p.cta_label && p.cta_label !== "Watch" ? App.adCta(p) : ""}</div>` : ""}
      <div class="w-meta"><span class="row" data-action="open-profile" data-user="${esc(p.author.username)}" style="cursor:pointer">${avatar(p.author, "m")}<span><b>${esc(p.author.display_name)}</b><div class="muted small">@${esc(p.author.username)}</div></span></span>
        ${App.followBtn(p.author, "btn")}
        <span class="grow"></span>
        <div class="w-actions">${App.likeBtn(p)}<button class="chip-btn ${disliked.has(p.id) ? "liked" : ""}" data-action="dislike" data-id="${esc(p.id)}" aria-label="Dislike">${icon("thumbdown")}</button>
          <button class="chip-btn" data-action="share" data-id="${esc(p.id)}">${icon("share")}<span class="n">Share</span></button>${App.saveBtn(p)}
          ${vid && p.allow_download !== false ? `<button class="chip-btn" data-action="download-post" data-id="${esc(p.id)}">${icon("download")}<span class="n">Download</span></button>` : ""}
          ${p.author.id === S.user.id ? `<button class="chip-btn" data-action="delete-post" data-id="${esc(p.id)}">${icon("trash")}</button>` : ""}</div></div>
      <div class="w-desc card"><b>${App.num(p.views)} views · ${App.timeAgo(p.created_at)}</b>${p.music ? `<div class="muted small">♪ ${esc(App.musicLabel(p.music))}</div>${(() => { const mt = App.parseMusic(p.music); return mt && mt.url ? App.audioChip(mt.url, { start: mt.start, len: mt.len, label: "clip" }) : ""; })()}` : ""}<p>${p.caption ? esc(p.caption) : '<span class="muted">No description.</span>'}</p></div>
      <section class="w-comments" id="w-comments"></section></div>
      <aside class="w-next"><h3>Up next</h3>${upNext(p)}</aside></div>`;
    const stage = $("#w-stage", pane);
    if (stageIO) { stageIO.disconnect(); stageIO = null; }
    if (vid) {
      player = makePlayer(stage, p);
      if ("IntersectionObserver" in window) { stageIO = new IntersectionObserver((es) => { if (player) player.dock(!es[0].isIntersecting); }, { threshold: 0.05 }); stageIO.observe(stage); }
    }
    else if (p.media_url) { stage.innerHTML = `<img class="w-img" src="${esc(p.media_url)}" alt="${esc(p.title)}" data-dbl="like-post" data-id="${esc(p.id)}">`; api.post("/posts/view", { post_id: p.id, count: true }).catch(() => {}); }
    App.mountComments($("#w-comments", pane), p.id);
  }
  /** Download the video file - only offered when the creator allowed downloads. */
  App.actions["download-post"] = async (el) => {
    const p = postOf(el.dataset.id);
    if (!p || !p.media_url || p.allow_download === false) { toast("Downloads are off for this video", "err"); return; }
    const name = (p.title || "loka-video").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "loka-video";
    try {
      const res = await fetch(p.media_url);
      if (!res.ok) throw new Error("Download failed (" + res.status + ")");
      const blob = await res.blob(), ext = (blob.type.split("/")[1] || "mp4").split(";")[0];
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = name + "." + ext;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast("Downloading…");
    } catch (e) {
      // cross-origin fetch blocked: fall back to opening the file so the browser can save it
      try { window.open(p.media_url, "_blank", "noopener"); } catch (er) { fail(e, "Couldn't download"); }
    }
  };
  App.actions.dislike = (el) => {
    const id = el.dataset.id, on = !disliked.has(id);
    on ? disliked.add(id) : disliked.delete(id);
    try { localStorage.setItem("loka_disliked", JSON.stringify(Array.from(disliked).slice(-300))); } catch (e) { /* ignore */ }
    el.classList.toggle("liked", on);
    if (on) toast("Noted. Dislikes are private and kept on this device.");
  };
  App.routes.watch = {
    fresh: true,
    hide() { if (stageIO) { stageIO.disconnect(); stageIO = null; } if (player) { player.destroy(); player = null; } if (App.stopChip) App.stopChip(); },
    async show(ctx) {
      const id = ctx.args[0];
      let p = S.postCache.get(id);
      if (!p) {
        ctx.pane.innerHTML = '<div class="spinner"></div>';
        [p] = App.remember([await api.get("/posts/" + encodeURIComponent(id))]);
        if (ctx.stale()) return;
      }
      if (p.type === "community") { App.go("/home"); App.openComments(p.id); return; }
      paintWatch(ctx.pane, p);
      if (!App.cacheGet("feed:recommended")) App.swr("feed:recommended", async () => App.remember((await api.get("/posts/feed?limit=40&tab=recommended")).posts), () => { const n = $(".w-next", ctx.pane); if (n && !ctx.stale()) n.innerHTML = "<h3>Up next</h3>" + upNext(p); }).catch(() => {});
      // refresh counts (likes / comments) in the background
      api.get("/posts/" + encodeURIComponent(id)).then((fresh) => { if (!ctx.stale()) { const [q] = App.remember([fresh]); App.paintLike(q); } }).catch(() => {});
    },
  };

  // ============================================================ Reels
  const reelHtml = (p) => `<section class="reel" data-id="${esc(p.id)}">
    <div class="reel-stage" data-dbl="like-post" data-id="${esc(p.id)}"><video data-src="${esc(p.media_url)}" ${p.poster_url ? `poster="${esc(p.poster_url)}"` : ""} loop playsinline preload="none"></video>
      <div class="reel-pause">${icon("play")}</div></div>
    <div class="reel-side">
      ${App.likeBtn(p, "stack")}
      <button class="chip-btn stack" data-action="comments" data-id="${esc(p.id)}" aria-label="Comments">${icon("comment")}<span class="n" data-ccount="${esc(p.id)}">${App.num(p.comments)}</span></button>
      <button class="chip-btn stack" data-action="share" data-id="${esc(p.id)}" aria-label="Share">${icon("share")}</button>
      ${App.saveBtn(p).replace('class="chip-btn', 'class="chip-btn stack')}
      <button class="chip-btn stack" data-action="reel-mute" aria-label="Mute or unmute"><span class="mute-ic">${icon(S.muted ? "mute" : "volume")}</span></button></div>
    <div class="reel-info"><div class="row"><span data-action="open-profile" data-user="${esc(p.author.username)}">${avatar(p.author, "s")}</span>
      <b data-action="open-profile" data-user="${esc(p.author.username)}">@${esc(p.author.username)}</b>${App.followBtn(p.author, "pill-follow")}</div>
      ${p.is_sponsored ? `<div class="reel-ad"><span class="spons">Sponsored</span>${App.adCta(p)}</div>` : ""}
      <div class="reel-cap">${esc(p.title)}${p.caption ? " - " + esc(p.caption) : ""}</div>
      <div class="ticker"><span>♪ ${esc(App.musicLabel(p.music) || "Original audio - " + p.author.display_name)} &nbsp;&nbsp;&nbsp;&nbsp; ♪ ${esc(App.musicLabel(p.music) || "Original audio - " + p.author.display_name)} &nbsp;&nbsp;&nbsp;&nbsp;</span></div></div></section>`;

  let reelIO = null, reelLoadIO = null, activeReel = null;
  const reelVideos = () => $$("#reels video");
  function paintReels(posts) {
    const wrap = $("#reels"); if (!wrap) return;
    if (!posts.length) { wrap.innerHTML = App.emptyBox("clips", "No reels yet", "Short vertical videos appear here.", `<button class="btn primary" data-action="create-type" data-type="clip">Post a reel</button>`); return; }
    const prevScroll = wrap.scrollTop;
    wrap.innerHTML = posts.map(reelHtml).join("");
    wrap.scrollTop = prevScroll;
    if (reelIO) reelIO.disconnect();
    if (reelLoadIO) reelLoadIO.disconnect();
    const counted = paintReels.counted || (paintReels.counted = new Set());
    reelIO = new IntersectionObserver((entries) => entries.forEach((en) => {
      const vid = $("video", en.target);
      if (en.isIntersecting && en.intersectionRatio >= 0.6) {
        activeReel = en.target;
        if (!vid.src) vid.src = vid.dataset.src;
        vid.muted = S.muted;
        vid.play().catch(() => { if (!vid.muted) { S.muted = true; vid.muted = true; vid.play().catch(() => {}); syncMute(); toast("Tap the speaker to turn sound on"); } });
        const id = en.target.dataset.id, rp = S.postCache.get(id), mt = rp && App.parseMusic(rp.music);
        if (mt && mt.url) App.playClip(mt, S.muted); else App.stopClip();
        if (!counted.has(id)) { counted.add(id); api.post("/posts/view", { post_id: id }).catch(() => {}); }
      } else vid.pause();
    }), { root: wrap, threshold: [0, 0.6] });
    reelLoadIO = new IntersectionObserver((entries) => entries.forEach((en) => { if (en.isIntersecting) { const v = $("video", en.target); if (!v.src) { v.preload = "metadata"; v.src = v.dataset.src; } } }), { root: wrap, rootMargin: "100% 0px" });
    $$(".reel", wrap).forEach((r) => { reelIO.observe(r); reelLoadIO.observe(r); });
  }
  /** Scroll the Reels player to a specific clip (used when a shared reel is opened from a chat). */
  function focusReel(id) {
    const wrap = $("#reels"); if (!wrap || !id) return;
    const el = $(`.reel[data-id="${id}"]`, wrap); if (!el) { toast("That reel is no longer available"); return; }
    wrap.scrollTop = el.offsetTop;
  }
  const syncMute = () => $$("#reels .mute-ic").forEach((m) => { m.innerHTML = icon(S.muted ? "mute" : "volume"); });
  App.actions["reel-mute"] = () => { S.muted = !S.muted; reelVideos().forEach((v) => { v.muted = S.muted; }); if (App.muteClip) App.muteClip(S.muted); syncMute(); };

  let reelClick = 0;
  App.routes.reels = {
    mount(pane) {
      pane.innerHTML = `<div class="reels" id="reels" data-keep><div class="spinner"></div></div>`;
      $("#reels", pane).addEventListener("click", (e) => {
        const st = e.target.closest(".reel-stage"); if (!st || e.target.closest("button")) return;
        clearTimeout(reelClick);
        reelClick = setTimeout(() => { const v = $("video", st); if (v.paused) { v.play().catch(() => {}); st.classList.remove("paused"); } else { v.pause(); st.classList.add("paused"); } }, 230);
      });
      $("#reels", pane).addEventListener("dblclick", () => clearTimeout(reelClick), true);
    },
    hide() { reelVideos().forEach((v) => v.pause()); App.stopClip(); },
    async show(ctx) {
      const target = ctx.args[0] || null;
      const posts = await App.swr("feed:clips", async () => App.remember((await api.get("/posts/feed?tab=clips&limit=30")).posts), (d) => { if (S.route === "reels") paintReels(d); }, { fresh: 30000 });
      if (ctx.stale()) return;
      if (!$("#reels .reel") || !activeReel || !document.body.contains(activeReel)) paintReels(posts);
      else { const v = $("video", activeReel); if (v) { v.muted = S.muted; v.play().catch(() => {}); } }
      if (target) focusReel(target);
    },
  };
  // make the clips feed prefetch with the rest
  App.prefetchReels = () => App.swr("feed:clips", async () => App.remember((await api.get("/posts/feed?tab=clips&limit=30")).posts), () => {}, {}).catch(() => {});
})();
