/* =====================================================================
   LokaChat - v6.js
   Loaded after you.js. Adds / overrides (nothing here needs a build step):
   - custom audio chip + clip player (no native <audio controls> anywhere)
   - Music Library (iTunes Search + curated trending + Saved audios) with the waveform clip selector
   - "+ Create" studio (Upload video / Create post / Create story) with auto-detect, cover + crop, music, Story + Sponsored toggles
   - Instagram-style Share sheet, Search explore grid with Users / Reels / Videos / Audios filters
   - Sponsored ad helpers, mobile horizontal swipe navigation
   - player helpers used by watch.js: adaptive resolution scaler (canvas) and Auto-CC (Web Speech API)
   ===================================================================== */
(function () {
  "use strict";
  const { S, $, $$, esc, icon, avatar, toast, fail, modal } = App;
  const api = window.LokaApi;
  const safeJson = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
  const mmss = (s) => App.dur(Math.max(0, s || 0));
  const isHttps = (u) => /^https:\/\//i.test(String(u || ""));

  // ============================================================ music tags on posts
  /** post.music is plain text, or a JSON track {title, artist, url, cover, start, len} picked in the Music Library. */
  App.parseMusic = (s) => {
    if (!s) return null;
    if (s.charAt(0) === "{") { const o = safeJson(s); const t = o && App.safeTrack ? App.safeTrack(o) : null; return t || null; }
    return { text: s };
  };
  App.musicLabel = (s) => { const m = App.parseMusic(s); return !m ? "" : m.text || (m.title + (m.artist ? " - " + m.artist : "")); };

  // ---------- background clip (story / reel / note music) ----------
  let clip = null;
  App.stopClip = () => { if (clip) { try { clip.a.pause(); clip.a.removeAttribute("src"); } catch (e) { /* ignore */ } clip = null; } };
  App.playClip = (t, muted) => {
    App.stopClip();
    if (!t || !t.url) return;
    const a = new Audio(), start = t.start || 0, end = t.len ? start + t.len : Infinity;
    a.preload = "auto"; a.muted = !!muted; a.src = t.url;
    a.addEventListener("loadedmetadata", () => { try { a.currentTime = start; } catch (e) { /* ignore */ } }, { once: true });
    a.addEventListener("timeupdate", () => { if (a.currentTime >= end - 0.05) { a.currentTime = start; if (a.paused) a.play().catch(() => {}); } });
    a.addEventListener("ended", () => { a.currentTime = start; a.play().catch(() => {}); });
    clip = { a, t };
    a.play().catch(() => {});
  };
  App.muteClip = (m) => { if (clip) clip.a.muted = !!m; };

  // ============================================================ custom audio chip (replaces <audio controls>)
  let apAudio = null, apEl = null;
  const stopChip = () => {
    if (apAudio) { try { apAudio.pause(); } catch (e) { /* ignore */ } apAudio = null; }
    if (apEl) { apEl.classList.remove("on"); const b = $(".ap-b", apEl); if (b) b.innerHTML = icon("play"); const bar = $(".ap-bar b", apEl); if (bar) bar.style.width = "0"; apEl = null; }
  };
  App.stopChip = stopChip;
  /** Small play/pause pill with progress + animated equalizer. url may be a blob: URL (voice messages). */
  App.audioChip = (url, o) => {
    o = o || {};
    return `<div class="ap" data-ap="${esc(url)}" data-start="${Number(o.start) || 0}" data-len="${Number(o.len) || 0}">
      <button type="button" class="ap-b" data-action="ap-toggle" aria-label="Play">${icon("play")}</button><span class="eq"><i></i><i></i><i></i></span>
      <span class="ap-bar"><b></b></span><span class="ap-t">${esc(o.label || "")}</span></div>`;
  };
  App.actions["ap-toggle"] = (el, ev) => {
    if (ev) ev.stopPropagation();
    const chip = el.closest(".ap"); if (!chip) return;
    if (apEl === chip) { stopChip(); return; }
    stopChip(); App.stopClip();
    const a = new Audio(chip.dataset.ap), start = Number(chip.dataset.start) || 0, len = Number(chip.dataset.len) || 0;
    apAudio = a; apEl = chip; chip.classList.add("on"); el.innerHTML = icon("pause");
    if (start) a.addEventListener("loadedmetadata", () => { try { a.currentTime = start; } catch (e) { /* ignore */ } }, { once: true });
    a.addEventListener("timeupdate", () => {
      const e = len ? start + len : (a.duration || 0), f = e > start ? Math.min(1, (a.currentTime - start) / (e - start)) : 0;
      const bar = $(".ap-bar b", chip); if (bar) bar.style.width = (f * 100).toFixed(1) + "%";
      if (len && a.currentTime >= start + len) stopChip();
    });
    a.addEventListener("ended", stopChip);
    a.play().catch(() => { toast("Couldn't play this audio", "err"); stopChip(); });
  };

  // ============================================================ saved audios (liked_audios)
  App.loadAudios = (force) => App.swr("audios", async () => (await api.get("/audios")).audios, () => {}, { force, fresh: 30000 });
  const isSaved = (url) => (App.cacheGet("audios") || []).some((a) => a.url === url);
  App.toggleAudio = async (t) => {
    const list = (App.cacheGet("audios") || []).slice(), had = list.some((a) => a.url === t.url);
    App.cacheSet("audios", had ? list.filter((a) => a.url !== t.url) : [{ title: t.title, artist: t.artist || "", url: t.url, cover: t.cover || "", created_at: new Date().toISOString() }, ...list]);
    try { await api.post("/audios/toggle", { title: t.title, artist: t.artist || "", url: t.url, cover: t.cover || "" }); toast(had ? "Removed from Saved audios" : "Saved to your audios"); }
    catch (e) { App.cacheSet("audios", list); fail(e, "Couldn't save audio"); }
  };
  App.actions["aud-save"] = async (el, ev) => {
    if (ev) ev.stopPropagation();
    await App.toggleAudio({ title: el.dataset.title, artist: el.dataset.artist, url: el.dataset.url, cover: el.dataset.cover });
    el.classList.toggle("on", isSaved(el.dataset.url));
    if (S.route === "you" && S.youTab === "audios" && App.paintYouAudios) App.paintYouAudios();
  };

  // ============================================================ Music Library + clip selector
  const TRENDING = { Trending: ["Dua Lipa", "The Weeknd", "Taylor Swift"], Hindi: ["Arijit Singh", "Diljit Dosanjh", "Badshah"], Pop: ["Billie Eilish", "Ariana Grande", "Harry Styles"], "Hip-Hop": ["Drake", "Kendrick Lamar", "Travis Scott"], Chill: ["lofi chill beats", "Frank Ocean", "Lana Del Rey"] };
  const trendCache = new Map();
  async function trending(name) {
    if (trendCache.has(name)) return trendCache.get(name);
    const lists = await Promise.all(TRENDING[name].map((q) => App.itunesSearch(q).then((r) => r.slice(0, 6)).catch(() => [])));
    const out = [], seen = new Set();
    for (let i = 0; i < 6; i++) lists.forEach((l) => { const t = l[i]; if (t && !seen.has(t.url)) { seen.add(t.url); out.push(t); } });
    if (out.length) trendCache.set(name, out);
    return out;
  }
  async function peaks(track, n) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const res = await fetch(track.url);
      if (!res.ok) throw new Error("no audio");
      const buf = await ctx.decodeAudioData(await res.arrayBuffer());
      if (ctx.close) ctx.close();
      const d = buf.getChannelData(0), step = Math.max(1, Math.floor(d.length / n)), out = [];
      for (let i = 0; i < n; i++) { let m = 0; for (let j = 0; j < step; j += Math.max(1, Math.floor(step / 40))) m = Math.max(m, Math.abs(d[i * step + j] || 0)); out.push(m); }
      const mx = Math.max.apply(null, out) || 1;
      return { bars: out.map((x) => Math.max(0.12, x / mx)), dur: buf.duration || 30 };
    } catch (e) {
      // the audio host blocked cross-origin reads: draw a stable pseudo waveform seeded by the title
      let h = 7; for (const c of String(track.title)) h = (h * 31 + c.charCodeAt(0)) | 0;
      const rnd = () => { h = (h * 1664525 + 1013904223) | 0; return ((h >>> 8) & 0xffff) / 0xffff; };
      return { bars: Array.from({ length: n }, (_, i) => Math.max(0.14, Math.abs(Math.sin(i / 4.5 + rnd())) * (0.55 + 0.45 * rnd()))), dur: 30 };
    }
  }

  /** Drag a 5/10/15/30 s window across the 30 s preview and return {...track, start, len}. */
  function clipSelector(host, track, done, back) {
    const N = 60;
    let len = Math.min(track.len || 15, 30), start = track.start || 0, dur = 30, pv = null, raf = 0, drag = false, off = 0;
    host.innerHTML = `<div class="clip-head"><span class="cv">${track.cover ? `<img src="${esc(track.cover)}" alt="">` : ""}</span><div class="grow"><b class="ellipsis" style="display:block">${esc(track.title)}</b><div class="muted small ellipsis">${esc(track.artist)}</div></div></div><div class="spinner"></div>`;
    const stopPv = () => { cancelAnimationFrame(raf); if (pv) { try { pv.pause(); } catch (e) { /* ignore */ } pv = null; } const hd = $(".head", host); if (hd) hd.style.display = "none"; const b = $("[data-cs=play]", host); if (b) b.innerHTML = icon("play") + "Preview"; };
    host._stop = stopPv;
    peaks(track, N).then(({ bars, dur: d }) => {
      dur = Math.max(5, Math.min(30, d)); len = Math.min(len, dur); start = Math.max(0, Math.min(start, dur - len));
      const lens = [5, 10, 15, 30].filter((x) => x <= dur + 0.5);
      host.innerHTML = `<div class="clip-head"><span class="cv">${track.cover ? `<img src="${esc(track.cover)}" alt="">` : ""}</span><div class="grow"><b class="ellipsis" style="display:block">${esc(track.title)}</b><div class="muted small ellipsis">${esc(track.artist)}</div></div></div>
        <p class="muted small" style="margin:12px 0 0">Drag the highlighted window to choose the part of the song to use.</p>
        <div class="wave" id="cs-wave">${bars.map((b) => `<i style="height:${Math.round(b * 100)}%"></i>`).join("")}<div class="win"></div><div class="head"></div></div>
        <div class="wave-meta"><span>0:00</span><b id="cs-sel" style="color:var(--text-main)"></b><span>${mmss(dur)}</span></div>
        <div class="cr-seg" style="margin:12px 0" id="cs-len">${lens.map((x) => `<button type="button" data-len="${x}" class="${x === len ? "on" : ""}">${x}s</button>`).join("")}</div>
        <div class="modal-actions"><button type="button" class="btn" data-cs="back">Back</button><button type="button" class="btn" data-cs="play">${icon("play")}Preview</button><button type="button" class="btn primary" data-cs="use">Use this part</button></div>`;
      const wave = $("#cs-wave", host), win = $(".win", wave), head = $(".head", wave), barEls = $$(":scope > i", wave);
      const layout = () => {
        win.style.left = (start / dur) * 100 + "%"; win.style.width = (len / dur) * 100 + "%";
        barEls.forEach((el, i) => el.classList.toggle("in", (i + 0.5) / N * dur >= start && (i + 0.5) / N * dur <= start + len));
        $("#cs-sel", host).textContent = mmss(start) + " - " + mmss(start + len);
      };
      const move = (e) => { const r = wave.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * dur; start = Math.max(0, Math.min(dur - len, x - off)); layout(); };
      wave.addEventListener("pointerdown", (e) => { stopPv(); drag = true; try { wave.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ } const r = wave.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * dur; off = e.target === win ? x - start : len / 2; move(e); });
      wave.addEventListener("pointermove", (e) => { if (drag) move(e); });
      wave.addEventListener("pointerup", () => { drag = false; });
      wave.addEventListener("pointercancel", () => { drag = false; });
      $("#cs-len", host).addEventListener("click", (e) => { const b = e.target.closest("[data-len]"); if (!b) return; stopPv(); len = Math.min(Number(b.dataset.len), dur); start = Math.max(0, Math.min(start, dur - len)); $$("#cs-len button", host).forEach((x) => x.classList.toggle("on", x === b)); layout(); });
      host.addEventListener("click", (e) => {
        const b = e.target.closest("[data-cs]"); if (!b) return;
        if (b.dataset.cs === "back") { stopPv(); back(); }
        else if (b.dataset.cs === "use") { stopPv(); done({ ...track, start: Math.round(start * 10) / 10, len: Math.round(len * 10) / 10 }); }
        else if (b.dataset.cs === "play") {
          if (pv) { stopPv(); return; }
          pv = new Audio(track.url); b.innerHTML = icon("pause") + "Stop"; head.style.display = "block";
          pv.addEventListener("loadedmetadata", () => { try { pv.currentTime = start; } catch (er) { /* ignore */ } }, { once: true });
          pv.play().catch(() => { toast("Couldn't play this preview", "err"); stopPv(); });
          const tick = () => { if (!pv) return; const t = pv.currentTime; head.style.left = Math.min(100, (t / dur) * 100) + "%"; if (t >= start + len - 0.05) { stopPv(); return; } raf = requestAnimationFrame(tick); };
          raf = requestAnimationFrame(tick);
        }
      });
      layout();
    });
  }

  /** Music Library & Search. opts: { title, onPick(track with start/len), clip:true }. */
  App.musicLibrary = (opts) => {
    opts = opts || {};
    let chip = "Trending", list = [], seq = 0, pv = null, pvI = -1, query = "";
    const stop = () => { if (pv) { try { pv.pause(); } catch (e) { /* ignore */ } pv = null; } pvI = -1; };
    let m;
    const cover = (t) => (t.cover ? `<img src="${esc(t.cover)}" alt="" loading="lazy">` : icon("music"));
    const paint = () => {
      const box = $(".lib-list", m.el); if (!box) return;
      box.innerHTML = list.length ? list.map((t, i) => `<div class="mlib-row ${pvI === i ? "playing" : ""}" data-i="${i}"><span class="cv">${cover(t)}<span class="eq"><i></i><i></i><i></i></span></span>
        <div class="grow"><b class="ellipsis" style="display:block">${esc(t.title)}</b><div class="muted small ellipsis">${esc(t.artist)}</div></div>
        <button type="button" class="icon-btn" data-mb="play" aria-label="Preview">${icon(pvI === i ? "pause" : "play")}</button>
        <button type="button" class="icon-btn heart ${isSaved(t.url) ? "on" : ""}" data-mb="heart" aria-label="Save audio">${icon("heart")}</button>
        <button type="button" class="btn sm primary" data-mb="pick">Select</button></div>`).join("") : '<p class="muted small center" style="padding:18px 0">No songs found.</p>';
    };
    const load = async () => {
      const my = ++seq, box = $(".lib-list", m.el); if (!box) return;
      box.innerHTML = '<div class="spinner"></div>';
      try {
        let r;
        if (query.length >= 2) r = await App.itunesSearch(query);
        else if (chip === "Saved") r = ((await App.loadAudios()) || []).map((a) => App.safeTrack(a)).filter(Boolean);
        else r = await trending(chip);
        if (my !== seq) return;
        list = r; stop(); paint();
      } catch (e) { if (my === seq) box.innerHTML = `<p class="muted small center" style="padding:18px 0">${esc(App.errText(e))}</p>`; }
    };
    const chips = () => Object.keys(TRENDING).concat(["Saved"]).map((c) => `<button type="button" data-chip="${esc(c)}" class="${c === chip && query.length < 2 ? "on" : ""}">${c === "Saved" ? "♥ Saved" : esc(c)}</button>`).join("");
    m = modal(`<h3>${esc(opts.title || "Music")}</h3><div id="lib-main"><div class="lib-top"><input class="lib-q" type="search" placeholder="Search songs or artists" autocomplete="off"></div>
      <div class="lib-chips">${chips()}</div><div class="lib-list"></div></div><div id="lib-clip" hidden></div>`, { cls: "wide stack2", noFocus: true, onClose: () => { stop(); const c = $("#lib-clip", m.el); if (c && c._stop) c._stop(); } });
    $(".lib-q", m.el).addEventListener("input", App.debounce((e) => { query = e.target.value.trim(); $(".lib-chips", m.el).innerHTML = chips(); load(); }, 350));
    $(".lib-chips", m.el).addEventListener("click", (e) => { const b = e.target.closest("[data-chip]"); if (!b) return; chip = b.dataset.chip; query = ""; $(".lib-q", m.el).value = ""; $(".lib-chips", m.el).innerHTML = chips(); load(); });
    $(".lib-list", m.el).addEventListener("click", (e) => {
      const b = e.target.closest("[data-mb]"), row = e.target.closest(".mlib-row"); if (!b || !row) return;
      const i = Number(row.dataset.i), t = list[i]; if (!t) return;
      if (b.dataset.mb === "play") {
        const was = pvI === i; stop(); App.stopClip(); stopChip();
        if (!was) { pv = new Audio(t.url); pvI = i; pv.addEventListener("ended", () => { stop(); paint(); }); pv.play().catch(() => { toast("Couldn't play this preview", "err"); stop(); paint(); }); }
        paint();
      } else if (b.dataset.mb === "heart") { App.toggleAudio(t).then(paint); paint(); }
      else {
        stop();
        if (opts.clip === false) { m.close(); opts.onPick && opts.onPick(t); return; }
        const host = $("#lib-clip", m.el); $("#lib-main", m.el).hidden = true; host.hidden = false;
        clipSelector(host, t, (picked) => { m.close(); opts.onPick && opts.onPick(picked); }, () => { if (host._stop) host._stop(); host.hidden = true; host.innerHTML = ""; $("#lib-main", m.el).hidden = false; });
      }
    });
    App.loadAudios().then(paint).catch(() => {});
    load();
    return m;
  };

  // ============================================================ + Create studio
  // v7: three formats (POST | STORY | REEL) with automatic format detection from the file.
  const PRESETS = { post: ["Create post", "image/*"], story: ["Create story", "image/*,video/*"], reel: ["Create a reel or video", "video/*"] };
  const TAB_LABEL = { post: "POST", story: "STORY", reel: "REEL" };
  const MAX_BYTES = 50 * 1024 * 1024;
  const extOf = (file) => (file.name.split(".").pop() || file.type.split("/")[1] || "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "bin";
  /** The upload "type" the backend wants, derived from the chosen tab + file + its shape. */
  const kindFor = (tab, isImg, info) => tab === "story" ? "story" : tab === "post" ? (isImg ? "photo" : "community") : (isImg ? null : (info && info.h > info.w ? "clip" : "video"));

  const probeMedia = (f, url) => new Promise((resolve) => {
    if (f.type.startsWith("image/")) {
      const i = new Image();
      i.onload = () => resolve({ isVideo: false, w: i.naturalWidth, h: i.naturalHeight, duration: 0 });
      i.onerror = () => resolve({ isVideo: false, w: 0, h: 0, duration: 0 });
      i.src = url; return;
    }
    const v = document.createElement("video");
    v.preload = "metadata"; v.muted = true; v.playsInline = true;
    v.onloadedmetadata = () => resolve({ isVideo: true, w: v.videoWidth, h: v.videoHeight, duration: v.duration || 0 });
    v.onerror = () => resolve({ isVideo: true, w: 0, h: 0, duration: 0 });
    setTimeout(() => resolve({ isVideo: true, w: 0, h: 0, duration: 0 }), 8000);
    v.src = url;
  });
  function frameAt(v, t, maxW, asBlob) {
    return new Promise((resolve) => {
      let done = false;
      const fin = (x) => { if (!done) { done = true; resolve(x); } };
      v.onseeked = () => {
        try {
          const w = Math.min(maxW, v.videoWidth || maxW), h = Math.round(w * ((v.videoHeight || 9) / (v.videoWidth || 16)));
          const c = document.createElement("canvas"); c.width = w; c.height = h;
          c.getContext("2d").drawImage(v, 0, 0, w, h);
          if (asBlob) c.toBlob((b) => fin(b), "image/jpeg", 0.82); else fin(c.toDataURL("image/jpeg", 0.6));
        } catch (e) { fin(null); }
      };
      try { v.currentTime = Math.max(0.05, t); } catch (e) { fin(null); }
      setTimeout(() => fin(null), 4000);
    });
  }
  async function grabPoster(url, t) {
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = url;
    await new Promise((r) => { v.onloadeddata = r; v.onerror = r; setTimeout(r, 6000); });
    return frameAt(v, t, 720, true);
  }
  const RATIOS = { "1:1": 1, "4:5": 0.8, "16:9": 16 / 9 };
  /** Center-crops an image to the chosen aspect and returns a JPEG Blob (null when no crop is needed). */
  function bakeImage(url, info, crop) {
    const ar = RATIOS[crop]; if (!ar || !info.w) return Promise.resolve(null);
    return new Promise((resolve) => {
      const i = new Image();
      i.onload = () => {
        let sw = i.naturalWidth, sh = i.naturalHeight;
        if (sw / sh > ar) sw = Math.round(sh * ar); else sh = Math.round(sw / ar);
        const sx = Math.round((i.naturalWidth - sw) / 2), sy = Math.round((i.naturalHeight - sh) / 2), k = Math.min(1, 1600 / sw);
        const c = document.createElement("canvas"); c.width = Math.round(sw * k); c.height = Math.round(sh * k);
        c.getContext("2d").drawImage(i, sx, sy, sw, sh, 0, 0, c.width, c.height);
        c.toBlob((b) => resolve(b), "image/jpeg", 0.9);
      };
      i.onerror = () => resolve(null);
      i.src = url;
    });
  }
  const kindLabel = (st) => {
    const i = st.info || {};
    if (st.kind === "clip") return "9:16 Vertical Reel";
    if (st.kind === "video") return Math.abs((i.w / (i.h || 1)) - 16 / 9) < 0.18 ? "16:9 Video" : "Video";
    if (st.kind === "photo") return "Image post";
    if (st.kind === "community") return "Text post";
    if (st.kind === "story") return "24h Story";
    return "Ready to publish";
  };
  const aspectOf = (st) => {
    const i = st.info || {};
    if (st.kind === "clip") return 9 / 16;
    if (st.kind === "video") return 16 / 9;
    if (RATIOS[st.crop]) return RATIOS[st.crop];
    return i.w && i.h ? Math.min(2, Math.max(0.5, i.w / i.h)) : 1;
  };

  App.openCreate = (preset) => {
    preset = preset === "video" ? "reel" : PRESETS[preset] ? preset : "reel";   // legacy "video" preset = the REEL tab
    const st = { tab: preset, file: null, kind: null, info: null, url: null, coverT: null, music: null, story: false, dl: true, ad: false, adp: "feed", cta: "Watch", crop: "orig", fit: false };
    const [heading, accept] = PRESETS[preset];
    const m = modal(`<h3>${heading}</h3><form data-form="create-studio" style="display:grid;gap:14px">
      <div id="cr-media"></div>
      <div id="cr-fields" hidden style="display:grid;gap:14px">
        <div class="field" id="f-title" hidden><label>Title</label><input name="title" maxlength="100" placeholder="Give it a title" autocomplete="off"></div>
        <div class="field" id="f-cap"><label>Description (optional)</label><textarea name="caption" maxlength="1000"></textarea></div>
        <div class="field" id="f-vis" hidden><label>Who can see it</label><select name="visibility"><option value="public">Everyone</option><option value="followers">Followers only</option></select></div>
        <div id="f-music" hidden></div>
        <div id="f-toggles" hidden>
          <div class="sw-row"><div><b>Share as 24h Story</b><small>Also posts it to your story for 24 hours</small></div><label class="switch"><input type="checkbox" data-cr="story"><i></i></label></div>
          <div class="sw-row"><div><b>Allow downloads</b><small>Lets viewers download this video to their device</small></div><label class="switch"><input type="checkbox" data-cr="dl" checked><i></i></label></div>
          <div class="sw-row"><div><b>Promote as Sponsored Ad</b><small>Shown with a Sponsored badge in feeds and the player</small></div><label class="switch"><input type="checkbox" data-cr="ad"><i></i></label></div>
          <div class="cr-ctas" id="cr-cta" hidden>
            <label class="muted small">Where should the ad show?</label>
            <div class="cr-seg" id="cr-adseg">${[["feed", "Feed"], ["preroll", "Pre-Roll"], ["midroll", "Mid-Roll"]].map(([v, l]) => `<button type="button" data-adp="${v}" class="${v === "feed" ? "on" : ""}">${l} Ad</button>`).join("")}</div>
            <label class="muted small">Call to action</label>
            <div class="cr-seg" id="cr-cta-seg">${["Watch", "Visit site", "Learn more"].map((c, i) => `<button type="button" data-cta="${c}" class="${i === 0 ? "on" : ""}">${c}</button>`).join("")}</div>
            <input name="cta_url" id="cr-cta-url" placeholder="https://yoursite.com (needed for Visit site / Learn more)" hidden autocomplete="off">
            <input name="ad_budget" type="number" min="0" step="1" placeholder="Budget in USD (optional)" autocomplete="off">
          </div>
        </div>
      </div>
      <div class="cr-prog" id="cr-prog" hidden><b></b></div>
      <div class="cr-tabs" id="cr-tabs" role="tablist">${["post", "story", "reel"].map((t) => `<button type="button" role="tab" data-cr-tab="${t}">${TAB_LABEL[t]}</button>`).join("")}</div>
      <div class="modal-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">Publish</button></div></form>`,
      { cls: "wide", noFocus: true, onClose: () => { if (st.url) URL.revokeObjectURL(st.url); App.stopClip(); } });
    const form = $("form", m.el);
    form._st = st; form._m = m;
    const media = $("#cr-media", m.el);

    const paintTabs = () => $$("#cr-tabs button", m.el).forEach((b) => b.classList.toggle("on", b.dataset.crTab === st.tab));
    /** Pre-roll / Mid-Roll ads are video-only (the backend rejects them for reels and photos). */
    const paintAd = () => {
      const box = $("#cr-cta", m.el); if (!box) return;
      box.hidden = !st.ad;
      if (st.ad && st.kind !== "video" && st.adp !== "feed") st.adp = "feed";
      $$("#cr-adseg button", m.el).forEach((b) => { const off = b.dataset.adp !== "feed" && st.kind !== "video"; b.disabled = off; b.classList.toggle("off", off); b.classList.toggle("on", b.dataset.adp === st.adp); });
    };
    const syncFields = () => {
      const k = st.kind, has = !!st.file;
      $("#cr-fields", m.el).hidden = !(has || k === "community");
      $("#f-title", m.el).hidden = !["video", "clip", "photo"].includes(k);
      $("#f-cap", m.el).querySelector("label").textContent = k === "community" ? "What's on your mind?" : k === "story" ? "Caption (optional)" : "Description (optional)";
      $("#f-vis", m.el).hidden = !["video", "photo"].includes(k);
      $("#f-music", m.el).hidden = !["clip", "story"].includes(k);
      $("#f-toggles", m.el).hidden = !["video", "clip", "photo"].includes(k);
      paintTabs(); paintMusic(); paintAd();
    };
    const paintMusic = () => {
      const box = $("#f-music", m.el); if (!box || box.hidden) return;
      const t = st.music;
      box.innerHTML = t ? `<div class="cr-music"><span class="cv" style="width:42px;height:42px;border-radius:8px;overflow:hidden;background:var(--bg-elevated);flex:none">${t.cover ? `<img src="${esc(t.cover)}" alt="" style="width:100%;height:100%;object-fit:cover">` : ""}</span>
        <div class="grow"><b class="ellipsis" style="display:block">${esc(t.title)}</b><span class="muted small">${esc(t.artist)} · ${mmss(t.start || 0)}-${mmss((t.start || 0) + (t.len || 30))}</span></div>
        <span class="eq"><i></i><i></i><i></i></span><button type="button" class="btn sm" data-cr="music">Change</button><button type="button" class="icon-btn" data-cr="music-x" aria-label="Remove music">${icon("close")}</button></div>`
        : `<button type="button" class="btn block" data-cr="music">${icon("music")}Add music</button>`;
    };
    const paintMedia = () => {
      if (!st.file) {
        const drop = st.tab === "post" ? "Add a photo (optional)" : st.tab === "reel" ? "Drag and drop a video" : "Drag and drop a photo or video";
        media.innerHTML = `<div class="cr-drop" data-cr="drop">${icon("add")}<b>${drop}</b><span>or click to select a file (max 50 MB)</span><input type="file" accept="${accept}" hidden></div>`;
        return;
      }
      const i = st.info || {}, ar = aspectOf(st);
      const crops = st.info && !i.isVideo && st.kind !== "story" ? `<div class="field"><label>Crop</label><div class="cr-seg" id="cr-crop">${["orig", "1:1", "4:5", "16:9"].map((c) => `<button type="button" data-crop="${c}" class="${c === st.crop ? "on" : ""}">${c === "orig" ? "Original" : c}</button>`).join("")}</div></div>` : "";
      media.innerHTML = `<div class="row wrap"><span class="cr-badge">${icon(st.kind === "clip" ? "clips" : "play")}${kindLabel(st)}</span>
        <span class="muted small ellipsis" style="max-width:260px">${i.w ? i.w + "×" + i.h : ""}${i.duration ? " · " + mmss(i.duration) : ""} · ${esc(st.file.name)}</span><span class="grow"></span>
        <button type="button" class="btn sm" data-cr="fit">${st.fit ? "Fill" : "Fit"}</button><button type="button" class="btn sm" data-cr="change">Change file</button></div>
        <div class="cr-prev ${st.fit ? "fit" : ""}" style="aspect-ratio:${ar};max-width:calc(52vh * ${ar.toFixed(3)});margin:0 auto">${i.isVideo ? `<video src="${esc(st.url)}" muted loop playsinline autoplay></video>` : `<img src="${esc(st.url)}" alt="">`}</div>
        ${i.isVideo && st.kind !== "story" ? `<div class="field"><label>Cover thumbnail</label><div class="cr-covers" id="cr-covers"><span class="muted small">Generating covers...</span></div></div>` : ""}${crops}`;
    };
    const makeCovers = async () => {
      const box = $("#cr-covers", m.el); if (!box || !st.info) return;
      const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = st.url;
      await new Promise((r) => { v.onloadeddata = r; v.onerror = r; setTimeout(r, 6000); });
      const d = st.info.duration || v.duration || 0;
      if (!d) { box.innerHTML = '<span class="muted small">Cover will be taken automatically.</span>'; return; }
      const parts = [];
      for (let i = 0; i < 6; i++) {
        const t = Math.max(0.1, Math.min(d - 0.1, (d * (i + 0.5)) / 6)), u = await frameAt(v, t, 160, false);
        if (u) parts.push(`<button type="button" data-t="${t.toFixed(2)}" class="${parts.length === 0 ? "on" : ""}"><img src="${u}" alt=""></button>`);
        if (!$("#cr-covers", m.el)) return;
      }
      if (!parts.length) { box.innerHTML = '<span class="muted small">Cover will be taken automatically.</span>'; return; }
      box.innerHTML = parts.join(""); st.coverT = Number($("button", box).dataset.t);
    };
    /** Switch the target-format tab, validating it against the file we already have. */
    const setTab = (tab) => {
      if (!TAB_LABEL[tab] || tab === st.tab) return;
      const isImg = !!(st.file && st.file.type.startsWith("image/")), isVid = !!(st.file && st.file.type.startsWith("video/"));
      if (st.file && tab === "reel" && !isVid) { toast("Reels need a video file", "err"); return; }
      if (st.file && tab === "post" && !isImg) { toast("Posts use a photo - remove the video to make a text post", "err"); return; }
      st.tab = tab;
      st.kind = kindFor(tab, isImg, st.info);
      if (tab !== "reel") { st.crop = "orig"; st.fit = false; }
      paintMedia(); syncFields();
      if (st.info && st.info.isVideo && st.kind && st.kind !== "story") makeCovers();
    };
    const setFile = async (f) => {
      if (!f) return;
      if (f.size > MAX_BYTES) { toast("That file is over 50 MB", "err"); return; }
      const isImg = f.type.startsWith("image/"), isVid = f.type.startsWith("video/");
      if (!isImg && !isVid) { toast("Choose a photo or video", "err"); return; }
      if (st.url) URL.revokeObjectURL(st.url);
      Object.assign(st, { file: f, url: URL.createObjectURL(f), coverT: null, crop: "orig", fit: false });
      st.info = await probeMedia(f, st.url);
      // auto-format detection: a photo belongs to POST, a video to REEL (stories accept both)
      if (st.tab !== "story") { const want = isImg ? "post" : "reel"; if (st.tab !== want) { st.tab = want; toast(isImg ? "Photo detected - switched to POST" : "Video detected - switched to REEL"); } }
      st.kind = kindFor(st.tab, isImg, st.info);
      paintMedia(); syncFields();
      if (st.info.isVideo && st.kind && st.kind !== "story") makeCovers();
    };
    paintMedia(); syncFields();

    // ---- local event wiring (the modal owns its own DOM)
    m.el.addEventListener("click", (e) => {
      const tabBtn = e.target.closest("[data-cr-tab]");
      if (tabBtn) { setTab(tabBtn.dataset.crTab); return; }
      const t = e.target.closest("[data-cr],[data-cta],[data-adp],[data-crop],#cr-covers button"); if (!t) return;
      if (t.dataset.cr === "drop") { const inp = $("input[type=file]", t); if (inp && e.target !== inp) inp.click(); }
      else if (t.dataset.cr === "change") { st.file = null; st.kind = kindFor(st.tab, false, null); if (st.url) URL.revokeObjectURL(st.url); st.url = null; paintMedia(); syncFields(); }
      else if (t.dataset.cr === "fit") { st.fit = !st.fit; paintMedia(); if (st.info && st.info.isVideo && st.kind !== "story") makeCovers(); }
      else if (t.dataset.cr === "music") App.musicLibrary({ title: st.kind === "story" ? "Add music to your story" : "Add music to your reel", onPick: (tr) => { st.music = tr; paintMusic(); } });
      else if (t.dataset.cr === "music-x") { st.music = null; paintMusic(); }
      else if (t.dataset.adp) { if (t.disabled) return; st.adp = t.dataset.adp; paintAd(); }
      else if (t.dataset.cta) { st.cta = t.dataset.cta; $$("#cr-cta-seg button", m.el).forEach((b) => b.classList.toggle("on", b === t)); $("#cr-cta-url", m.el).hidden = st.cta === "Watch"; }
      else if (t.dataset.crop) { st.crop = t.dataset.crop; paintMedia(); if (st.info && st.info.isVideo) makeCovers(); }
      else if (t.closest("#cr-covers")) { st.coverT = Number(t.dataset.t); $$("#cr-covers button", m.el).forEach((b) => b.classList.toggle("on", b === t)); }
    });
    m.el.addEventListener("change", (e) => {
      const t = e.target;
      if (t.type === "file") setFile(t.files[0]);
      else if (t.dataset && t.dataset.cr === "story") st.story = t.checked;
      else if (t.dataset && t.dataset.cr === "dl") st.dl = t.checked;
      else if (t.dataset && t.dataset.cr === "ad") { st.ad = t.checked; paintAd(); }
    });
    m.el.addEventListener("dragover", (e) => { const d = e.target.closest(".cr-drop"); if (d) { e.preventDefault(); d.classList.add("over"); } });
    m.el.addEventListener("dragleave", (e) => { const d = e.target.closest(".cr-drop"); if (d) d.classList.remove("over"); });
    m.el.addEventListener("drop", (e) => { const d = e.target.closest(".cr-drop"); if (!d) return; e.preventDefault(); d.classList.remove("over"); setFile(e.dataTransfer.files[0]); });
    return m;
  };

  const musicString = (t) => (t ? JSON.stringify({ title: t.title, artist: t.artist, url: t.url, cover: t.cover || "", start: t.start || 0, len: t.len || 0 }) : "");

  App.forms["create-studio"] = async (form, data) => {
    const st = form._st, m = form._m;
    const kind = st.kind || (st.tab === "post" ? "community" : null);
    if (!kind) throw new Error(st.tab === "reel" ? "Add a video first" : "Choose a photo or video first");
    const caption = (data.caption || "").trim(), title = (data.title || "").trim();
    if (kind === "community" && !caption) throw new Error("Write something to share");
    if (["video", "clip", "photo"].includes(kind) && !title) throw new Error("Give it a title");
    const ctaUrl = (data.cta_url || "").trim();
    if (st.ad && st.cta !== "Watch" && !isHttps(ctaUrl)) throw new Error("Add an https:// link for the '" + st.cta + "' button");
    const format = kind === "clip" ? "reel" : kind === "video" ? "video" : "post";   // v7: explicit format
    const btn = form.querySelector("button[type=submit]"), prog = $("#cr-prog", m.el), bar = $("b", prog);
    const step = (p, label) => { prog.hidden = false; bar.style.width = p + "%"; btn.textContent = label; };
    const uploaded = [], f = st.file, music = musicString(kind === "clip" || kind === "story" ? st.music : null);
    let post, storyPost = null;
    try {
      step(8, "Preparing...");
      const id = crypto.randomUUID(), base = `${S.user.id}/${id}`;
      let blob = f, mime = f ? f.type || "application/octet-stream" : null, mediaPath = null, posterPath = null, duration = st.info ? st.info.duration : 0;
      if (f && st.info && !st.info.isVideo && st.crop !== "orig") { const b = await bakeImage(st.url, st.info, st.crop); if (b) { blob = b; mime = "image/jpeg"; } }
      if (f) {
        const ext = blob === f ? extOf(f) : "jpg";
        step(20, "Uploading...");
        mediaPath = `${base}/media.${ext}`;
        await api.upload(mediaPath, blob, mime); uploaded.push(mediaPath);
        if (st.info.isVideo && kind !== "story") {
          const pb = await grabPoster(st.url, st.coverT || Math.min(1, (duration || 2) * 0.1));
          if (pb) { posterPath = `${base}/poster.jpg`; await api.upload(posterPath, new File([pb], "poster.jpg", { type: "image/jpeg" })); uploaded.push(posterPath); }
        }
      }
      step(60, "Publishing...");
      const body = {
        type: kind, title, caption, visibility: kind === "story" || kind === "clip" ? "public" : data.visibility || "public",
        format, allow_download: ["video", "clip"].includes(kind) ? !!st.dl : true,
        media_path: mediaPath, poster_path: posterPath, mime, music, duration: Math.round((duration || 0) * 10) / 10, size: blob ? blob.size || 0 : 0,
      };
      if (st.ad && ["video", "clip", "photo"].includes(kind)) {
        const placement = kind === "video" ? st.adp : "feed";   // pre-roll / mid-roll are video-only
        Object.assign(body, { is_sponsored: true, cta_label: st.cta, cta_url: st.cta === "Watch" ? "" : ctaUrl, ad_placement: placement, ad_budget: Math.max(0, Number(data.ad_budget) || 0) });
      }
      post = await api.post("/posts/create", body);
      if (st.story && f && ["video", "clip", "photo"].includes(kind)) {
        step(80, "Adding to your story...");
        const sPath = `${S.user.id}/${crypto.randomUUID()}/story.${blob === f ? extOf(f) : "jpg"}`;
        await api.upload(sPath, blob, mime);
        try { storyPost = await api.post("/posts/create", { type: "story", title: "", caption: title, visibility: "followers", media_path: sPath, mime, music, duration: body.duration, size: body.size }); }
        catch (e) { api.removeFiles([sPath]); toast("Posted, but the story copy failed: " + App.errText(e), "err"); }
      }
    } catch (e) { api.removeFiles(uploaded); btn.textContent = "Publish"; prog.hidden = true; throw e; }
    step(100, "Done");
    const [p] = App.remember([post]);
    App.cacheDrop("stories", "mine:", "profile:", "explore");
    const prepend = (key) => { const c = App.cacheGet(key); if (c && !c.some((x) => x.id === p.id)) c.unshift(p); };
    if (kind === "community") { prepend("feed:community"); prepend("feed:following"); }
    else if (kind !== "story") { prepend("feed:recommended"); if (kind === "clip") prepend("feed:clips"); }
    toast(kind === "story" || storyPost ? "Published - story is live for 24 hours" : st.ad ? "Published as a Sponsored ad" : "Published!");
    S.user.posts = (S.user.posts || 0) + 1;
    m.close();
    if (kind === "community") { S.homeTab = "community"; App.go("/home"); if (App.paintFeed) App.paintFeed(); }
    else if (kind === "story") App.go("/home");
    else App.go(kind === "clip" ? "/reels" : "/home");
  };

  // launcher route + menu actions
  App.routes.post = {
    fresh: true,
    mount(pane) {
      pane.innerHTML = `<div class="page narrow"><div class="page-head"><h2>Create</h2></div><div class="cr-launch">
        <button data-action="create-type" data-type="reel">${icon("clips")}Create a reel<small>Vertical 9:16 reels - the format tab auto-detects your file</small></button>
        <button data-action="create-type" data-type="post">${icon("image")}Create post<small>Text updates with an optional photo</small></button>
        <button data-action="create-type" data-type="story">${icon("clock")}Create story<small>Photo or video that lasts 24 hours</small></button></div></div>`;
    },
  };
  App.actions["create-type"] = (el) => {
    App.closeMenus();
    const t = el.dataset.type;
    App.openCreate(t === "story" ? "story" : t === "community" || t === "post" ? "post" : "reel");
  };
  App.actions["add-story"] = (el, ev) => { if (ev) ev.stopPropagation(); App.openCreate("story"); };

  // ============================================================ sponsored ads
  App.sponsBadge = (p) => (p && p.is_sponsored ? '<span class="spons">Sponsored</span>' : "");
  App.adCta = (p, cls) => (p && p.is_sponsored ? `<button type="button" class="${cls || "ad-cta"}" data-action="ad-cta" data-id="${esc(p.id)}">${esc(p.cta_label || "Watch")}</button>` : "");
  App.actions["ad-cta"] = (el, ev) => {
    if (ev) ev.stopPropagation();
    const p = S.postCache.get(el.dataset.id); if (!p) return;
    if (p.cta_label !== "Watch" && isHttps(p.cta_url)) window.open(p.cta_url, "_blank", "noopener,noreferrer");
    else App.openPost(p);
  };

  // ============================================================ Instagram-style share sheet
  App.actions.share = async (el, ev) => {
    if (ev) ev.stopPropagation();
    const id = el.dataset.id;
    let p = S.postCache.get(id);
    if (!p) { try { [p] = App.remember([await api.get("/posts/" + encodeURIComponent(id))]); } catch (e) { fail(e); return; } }
    const url = location.origin + location.pathname + "#/watch/" + id, text = (p.title || "Watch on LokaChat") + " " + url;
    const m = modal(`<h3>Share</h3><div class="share-row" id="share-row"><div class="spinner" style="margin:10px auto"></div></div>
      <div class="share-acts"><button data-sh="copy"><span class="ico">${icon("copy")}</span>Copy link</button><button data-sh="wa"><span class="ico">WA</span>WhatsApp</button>
      <button data-sh="x"><span class="ico">X</span>X</button><button data-sh="more"><span class="ico">•••</span>More</button></div>`, { noFocus: true });
    const row = $("#share-row", m.el);
    const people = new Map();
    S.chats.filter((c) => c.type === "direct").forEach((c) => { const o = c.members.find((u) => u.id !== S.user.id); if (o) people.set(o.username, o); });
    const paint = () => { row.innerHTML = people.size ? Array.from(people.values()).slice(0, 24).map((u) => `<button class="share-f" data-u="${esc(u.username)}">${avatar(u, "l")}<span class="nm">${esc(u.display_name)}</span></button>`).join("") : '<p class="muted small">Follow people to send them posts instantly.</p>'; };
    paint();
    api.get("/users/following").then((r) => { r.users.forEach((u) => { if (!people.has(u.username)) people.set(u.username, u); }); paint(); }).catch(() => {});
    m.el.addEventListener("click", async (e) => {
      const f = e.target.closest(".share-f"), b = e.target.closest("[data-sh]");
      if (f) {
        if (f.classList.contains("sent") || f.dataset.busy) return;
        f.dataset.busy = "1";
        const ok = await App.sendToUser(f.dataset.u, { k: "share", t: (p.title || p.caption || "Post").slice(0, 90), pid: p.id, ty: p.type, fmt: p.format || (p.type === "clip" ? "reel" : "video"), th: App.postThumb(p) || "" });
        delete f.dataset.busy; if (ok) f.classList.add("sent");
      } else if (b) {
        const k = b.dataset.sh;
        if (k === "copy") { try { await navigator.clipboard.writeText(url); toast("Link copied"); } catch (er) { toast("Couldn't copy the link", "err"); } }
        else if (k === "wa") window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank", "noopener,noreferrer");
        else if (k === "x") window.open("https://twitter.com/intent/tweet?text=" + encodeURIComponent(p.title || "Watch on LokaChat") + "&url=" + encodeURIComponent(url), "_blank", "noopener,noreferrer");
        else if (k === "more") { try { if (navigator.share) await navigator.share({ title: p.title || "LokaChat", url }); else { await navigator.clipboard.writeText(url); toast("Link copied"); } } catch (er) { if (er && er.name !== "AbortError") toast("Sharing isn't available here", "err"); } }
      }
    });
  };
  /** A shared Reel opens in the Reels player; a shared Video opens in the Theater player (strict by format). */
  App.actions["open-shared"] = (el) => {
    const id = el.dataset.pid; if (!/^[0-9a-f-]{36}$/i.test(id || "")) return;
    const reel = el.dataset.fmt === "reel" || el.dataset.ty === "clip";
    App.closeAllModals();
    App.go(reel ? "/reels/" + id : "/watch/" + id);
  };

  // ============================================================ Search: explore grid + filters
  const ex = { f: "all", q: "", users: [], posts: [], audios: [], seq: 0 };
  const exTile = (p) => `<div class="ex-tile t-${p.type === "clip" ? "clip" : p.type === "photo" ? "photo" : "video"}" data-action="open-post" data-id="${esc(p.id)}">${App.postThumb(p) ? `<img src="${esc(App.postThumb(p))}" alt="" loading="lazy">` : ""}
    <span class="gk">${icon(p.type === "clip" ? "clips" : p.type === "photo" ? "image" : "play")}</span><span class="gv">${icon("eye")}${App.num(p.views)}</span></div>`;
  const filterPosts = (posts) => posts.filter((p) => ex.f === "reels" ? p.type === "clip" : ex.f === "videos" ? p.type !== "clip" : true);
  const userRows = (users) => `<div class="list-card card">${users.map((x) => `<div class="user-row" data-action="open-profile" data-user="${esc(x.username)}">${avatar(x, "m")}<div class="grow"><b>${esc(x.display_name)}</b><div class="muted small">@${esc(x.username)}</div></div>${App.followBtn(x)}</div>`).join("")}</div>`;
  const audioRows = (list) => `<div class="aud-list">${list.map((t) => `<div class="aud-row card"><span class="cv">${t.cover ? `<img src="${esc(t.cover)}" alt="" loading="lazy">` : ""}</span><div class="grow"><b class="ellipsis" style="display:block">${esc(t.title)}</b><div class="muted small ellipsis">${esc(t.artist)}</div>${App.audioChip(t.url, { label: "30s" })}</div>
    <button type="button" class="icon-btn mlib-heart ${isSaved(t.url) ? "on acc" : ""}" data-action="aud-save" data-title="${esc(t.title)}" data-artist="${esc(t.artist)}" data-url="${esc(t.url)}" data-cover="${esc(t.cover || "")}" aria-label="Save audio">${icon("heart")}</button></div>`).join("")}</div>`;
  function paintExplore() {
    const box = $("#results"); if (!box) return;
    $$("#ex-filters button").forEach((b) => b.classList.toggle("on", b.dataset.f === ex.f));
    if (ex.q.length < 2) {
      if (ex.f === "users") { box.innerHTML = App.emptyBox("users", "Find people", "Type a name or @username to search."); return; }
      if (ex.f === "audios") { box.innerHTML = App.emptyBox("music", "Find music", "Search songs and artists to preview and save them."); return; }
      const posts = App.cacheGet("explore");
      if (!posts) { box.innerHTML = '<div class="spinner"></div>'; return; }
      const list = filterPosts(posts);
      box.innerHTML = list.length ? `<div class="explore">${list.map(exTile).join("")}</div>` : App.emptyBox("clips", "Nothing trending yet", "Reels and videos will show up here as people post them.");
      return;
    }
    const parts = [];
    if ((ex.f === "all" || ex.f === "users") && ex.users.length) parts.push(`<h3 style="margin-bottom:8px">People</h3>${userRows(ex.users)}`);
    const posts = filterPosts(ex.posts);
    if (["all", "reels", "videos"].includes(ex.f) && posts.length) parts.push(`<h3 style="margin:20px 0 8px">${ex.f === "reels" ? "Reels" : ex.f === "videos" ? "Videos" : "Reels & videos"}</h3><div class="explore">${posts.map(exTile).join("")}</div>`);
    if ((ex.f === "all" || ex.f === "audios") && ex.audios.length) parts.push(`<h3 style="margin:20px 0 8px">Audio</h3>${audioRows(ex.audios)}`);
    box.innerHTML = parts.join("") || App.emptyBox("search", "No results", `Nothing matched "${ex.q}".`);
  }
  async function runSearch() {
    const q = ex.q, my = ++ex.seq;
    if (q.length < 2) { paintExplore(); return; }
    const want = (k) => ex.f === "all" || ex.f === k;
    try {
      const [u, p, a] = await Promise.all([
        want("users") ? api.get("/users/search?q=" + encodeURIComponent(q)) : { users: [] },
        ex.f === "all" || ex.f === "reels" || ex.f === "videos" ? api.get("/posts/feed?tab=explore&limit=40&q=" + encodeURIComponent(q)) : { posts: [] },
        want("audios") ? App.itunesSearch(q).catch(() => []) : [],
      ]);
      if (my !== ex.seq) return;
      App.remember(p.posts);
      Object.assign(ex, { users: u.users, posts: p.posts, audios: a });
      paintExplore();
    } catch (e) { fail(e); }
  }
  App.routes.search = {
    mount(pane) {
      pane.innerHTML = `<div class="page explore-page"><div class="page-head"><h2>Search</h2></div>
        <input id="q" type="search" placeholder="Search people, reels, videos and audio" autocomplete="off">
        <div class="ex-filters hscroll" id="ex-filters">${[["all", "All"], ["users", "Users"], ["reels", "Reels"], ["videos", "Videos"], ["audios", "Audios"]].map(([k, l]) => `<button data-action="ex-filter" data-f="${k}" class="${k === ex.f ? "on" : ""}">${l}</button>`).join("")}</div>
        <div id="results"></div></div>`;
      $("#q", pane).addEventListener("input", App.debounce((e) => { ex.q = e.target.value.trim(); runSearch(); }, 280));
    },
    show(ctx) {
      paintExplore();
      App.swr("explore", async () => App.remember((await api.get("/posts/feed?tab=explore&limit=40")).posts), () => { if (S.route === "search" && ex.q.length < 2) paintExplore(); }, { fresh: 60000 }).catch(() => {});
      if (App.isDesktop()) setTimeout(() => { const i = $("#q", ctx.pane); if (i) i.focus(); }, 30);
    },
  };
  App.actions["ex-filter"] = (el) => { ex.f = el.dataset.f; if (ex.q.length >= 2) runSearch(); paintExplore(); };

  // ============================================================ mobile horizontal swipe navigation (< 768px)
  const SECTIONS = ["home", "reels", "messages", "you"];
  const SUBS = {
    home: () => ({ keys: ["recommended", "following", "community"], cur: S.homeTab, set: (k) => { App.actions["home-tab"]({ dataset: { tab: k } }); }, anim: "#feed" }),
    messages: () => ({ keys: ["chats", "stories", "channels"], cur: S.msgTab, set: (k) => { App.actions["msg-tab"]({ dataset: { tab: k } }); }, anim: "#chat-scroll" }),
    you: () => ({ keys: ["posts", "reels", "saved", "liked", "likedreels", "audios"], cur: S.youTab, set: (k) => { App.actions["you-tab"]({ dataset: { tab: k } }); }, anim: "#you-grid" }),
  };
  const slide = (sel, dir) => { const el = $(sel) || $("#view"); if (!el) return; el.classList.remove("swipe-in-l", "swipe-in-r"); void el.offsetWidth; el.classList.add(dir > 0 ? "swipe-in-l" : "swipe-in-r"); };
  function swipe(dir) {              // dir +1 = swiped left (go forward), -1 = swiped right (go back)
    const route = S.route, sub = SUBS[route] && SUBS[route]();
    if (route === "messages" && $("#chat-wrap") && $("#chat-wrap").classList.contains("has-conv")) return;
    if (sub) {
      const j = sub.keys.indexOf(sub.cur) + dir;
      if (j >= 0 && j < sub.keys.length) { sub.set(sub.keys[j]); slide(sub.anim, dir); return; }
    }
    const i = SECTIONS.indexOf(route), j = i + dir;
    if (i >= 0 && j >= 0 && j < SECTIONS.length) { App.go("/" + SECTIONS[j]); slide("#view", dir); }
  }
  const NO_SWIPE = ".hscroll,input,textarea,select,video,.vplayer,.wave,.modal-back,.drawer-back,.story-view,.mctx-back,.reel-side,.pk-grid,.vp-bar,.chat-wrap.has-conv,[data-noswipe]";
  let sw = null;
  document.addEventListener("touchstart", (e) => {
    sw = null;
    if (!window.matchMedia("(max-width: 767px)").matches || e.touches.length !== 1 || !S.user) return;
    if (e.target.closest(NO_SWIPE)) return;
    const t = e.touches[0]; sw = { x: t.clientX, y: t.clientY, t: Date.now() };
  }, { passive: true });
  document.addEventListener("touchend", (e) => {
    if (!sw) return;
    const t = e.changedTouches[0], dx = t.clientX - sw.x, dy = t.clientY - sw.y, dt = Date.now() - sw.t;
    sw = null;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 45 && Math.abs(dx) > Math.abs(dy) * 2 && dt < 650) swipe(dx < 0 ? 1 : -1);
  }, { passive: true });

  // ============================================================ watch-page player helpers (used by watch.js)
  const TIERS = { "1080p": 1080, "720p": 720, "480p": 480, "360p": 360 };
  /** Resolution scaler: draws the video into a smaller canvas and lets CSS scale it back up (works on any single uploaded file). */
  App.attachScaler = (root, v, onChange) => {
    const canvas = document.createElement("canvas"); canvas.className = "vp-canvas";
    v.insertAdjacentElement("afterend", canvas);
    const ctx = canvas.getContext("2d");
    let q = "Auto", target = 0, running = false, handle = 0, last = 0;
    const autoHeight = () => {
      const c = navigator.connection || {};
      if (c.saveData) return 360;
      if (c.effectiveType === "slow-2g" || c.effectiveType === "2g") return 360;
      if (c.effectiveType === "3g") return 480;
      const want = Math.ceil((root.clientHeight || 360) * (window.devicePixelRatio || 1));
      return [360, 480, 720, 1080].find((t) => t >= want) || 1080;
    };
    const stop = () => { running = false; if (v.cancelVideoFrameCallback && handle) { try { v.cancelVideoFrameCallback(handle); } catch (e) { /* ignore */ } } cancelAnimationFrame(handle); handle = 0; };
    const draw = () => {
      if (!running) return;
      const vw = v.videoWidth, vh = v.videoHeight, now = performance.now();
      if (vw && vh && now - last >= (target <= 360 ? 40 : 16)) {     // data saver also lowers the frame rate
        last = now;
        const w = Math.max(2, Math.round((target * vw) / vh));
        if (canvas.width !== w || canvas.height !== target) { canvas.width = w; canvas.height = target; }
        try { ctx.drawImage(v, 0, 0, w, target); } catch (e) { /* ignore */ }
      }
      handle = v.requestVideoFrameCallback ? v.requestVideoFrameCallback(draw) : requestAnimationFrame(draw);
    };
    const apply = () => {
      const want = q === "Auto" ? autoHeight() : TIERS[q], vh = v.videoHeight || 0;
      target = want;
      const scale = vh && want < vh;
      root.classList.toggle("scaled", !!scale);
      stop();
      if (scale) { running = true; draw(); }
      if (onChange) onChange({ q, effective: scale ? want : vh || 0 });
    };
    v.addEventListener("loadedmetadata", apply);
    window.addEventListener("resize", apply);
    if (navigator.connection && navigator.connection.addEventListener) navigator.connection.addEventListener("change", apply);
    return {
      set(next) { q = next; apply(); },
      get q() { return q; },
      destroy() { stop(); window.removeEventListener("resize", apply); if (navigator.connection && navigator.connection.removeEventListener) navigator.connection.removeEventListener("change", apply); canvas.remove(); root.classList.remove("scaled"); },
    };
  };

  /**
   * Captions (CC): reads the video's OWN caption/subtitle tracks and shows the active cue.
   * No microphone, no getUserMedia, no Web Speech API - if the video has no <track> we say so.
   */
  App.attachCC = (root, v) => {
    const box = $(".vp-cc", root);
    let on = false;
    const ccTracks = () => Array.from(v.textTracks || []).filter((t) => t.kind === "captions" || t.kind === "subtitles");
    const cueText = () => {
      let txt = "";
      ccTracks().forEach((t) => {
        if (t.mode !== "showing" || !t.activeCues) return;
        for (let i = 0; i < t.activeCues.length; i++) { const c = t.activeCues[i]; if (c && c.text) txt += (txt ? " " : "") + c.text; }
      });
      return txt.trim();
    };
    const paint = () => {
      if (!on) return;
      const txt = cueText();
      box.innerHTML = txt ? `<span>${esc(txt)}</span>` : "";
      box.classList.toggle("on", !!txt);
    };
    const cueChange = () => paint();
    ccTracks().forEach((t) => t.addEventListener("cuechange", cueChange));
    v.addEventListener("timeupdate", paint);
    const off = () => { on = false; ccTracks().forEach((t) => { t.mode = "hidden"; }); box.innerHTML = ""; box.classList.remove("on"); const b = $("[data-p=cc]", root); if (b) b.classList.remove("on"); };
    return {
      /** returns true when captions are now on */
      toggle() {
        let tracks = ccTracks();
        // a <track> element with kind=captions but not yet loaded into textTracks
        if (!tracks.length) {
          const el = v.querySelector && v.querySelector('track[kind="captions"],track[kind="subtitles"]');
          if (el && el.track) tracks = [el.track];
        }
        if (!tracks.length) { toast("Captions not available for this video", "err"); return false; }
        on = !on;
        tracks.forEach((t) => { t.mode = on ? "showing" : "hidden"; });
        if (on) { tracks.forEach((t) => t.addEventListener("cuechange", cueChange)); paint(); } else off();
        return on;
      },
      destroy() { ccTracks().forEach((t) => t.removeEventListener("cuechange", cueChange)); v.removeEventListener("timeupdate", paint); box.innerHTML = ""; box.classList.remove("on"); },
    };
  };

  // ============================================================ GIF / sticker picker for comments
  /** GIPHY search when config.js has GIPHY_KEY, otherwise the built-in sticker set. onPick(url) gets an https GIPHY url or "sticker:<emoji>". */
  App.gifPicker = (host, onPick) => {
    const key = (window.LOKA_CONFIG || {}).GIPHY_KEY;
    host.innerHTML = `<input type="search" class="gp-q" placeholder="${key ? "Search GIFs" : "Search stickers"}" autocomplete="off" style="width:100%;margin-bottom:8px"><div class="pk-grid ${key ? "gifgrid" : "stkgrid"}"></div>`;
    const grid = $(".pk-grid", host), q = $(".gp-q", host);
    const stickers = (term) => (App.STICKERS || []).filter(([, k]) => !term || k.includes(term)).map(([e, k]) => `<button type="button" class="stk" data-st="${esc(e)}" title="${esc(k)}">${e}</button>`).join("") || '<p class="muted small">Nothing found</p>';
    let seq = 0;
    const load = async () => {
      const term = q.value.trim().toLowerCase(), my = ++seq;
      if (!key) { grid.innerHTML = stickers(term); return; }
      grid.innerHTML = '<div class="spinner"></div>';
      try {
        const res = await fetch(`https://api.giphy.com/v1/gifs/${term ? "search" : "trending"}?api_key=${encodeURIComponent(key)}&limit=24&rating=g${term ? "&q=" + encodeURIComponent(term) : ""}`);
        if (!res.ok) throw new Error("GIF search failed (" + res.status + ")");
        const { data } = await res.json();
        if (my !== seq) return;
        grid.innerHTML = data.map((g) => `<button type="button" class="gifc" data-u="${esc(g.images.fixed_height.url)}"><img src="${esc(g.images.fixed_height_small.url)}" alt="" loading="lazy"></button>`).join("") || '<p class="muted small">No GIFs found</p>';
      } catch (e) { if (my === seq) { grid.className = "pk-grid stkgrid"; grid.innerHTML = `<p class="muted small" style="grid-column:1/-1">${esc(App.errText(e))} - showing stickers instead.</p>` + stickers(term); } }
    };
    q.addEventListener("input", App.debounce(load, 250));
    grid.addEventListener("click", (e) => {
      const s = e.target.closest("[data-st]"), g = e.target.closest("[data-u]");
      if (s) onPick("sticker:" + s.dataset.st); else if (g) onPick(g.dataset.u);
    });
    load();
  };
})();
