/* LokaChat service worker - caches ONLY the same-origin static app shell.
   Never touches: /api calls, Supabase (REST, Storage, Realtime websockets), non-GET requests,
   range/media requests, or any cross-origin URL (CDN, iTunes, images). Bump VERSION to refresh. */
const VERSION = "lokachat-shell-v6";
const SHELL = ["./", "index.html", "style.css", "config.js", "crypto.js", "api.js", "core.js", "views.js", "watch.js", "chat.js", "you.js", "v6.js", "app.js", "manifest.json", "assets/icon-192.png", "assets/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // CDN, Supabase, iTunes...
  if (url.pathname.startsWith("/api")) return;                // backend
  if (req.mode === "navigate") {                              // network first, offline fallback
    e.respondWith(fetch(req).then((r) => { const cp = r.clone(); caches.open(VERSION).then((c) => c.put("index.html", cp)); return r; }).catch(() => caches.match("index.html")));
    return;
  }
  // static files: network first (so a reload always gets the newest JS/CSS), cached copy only when offline
  e.respondWith(fetch(req).then((r) => { if (r && r.ok && r.type === "basic") { const cp = r.clone(); caches.open(VERSION).then((c) => c.put(req, cp)); } return r; }).catch(() => caches.match(req)));
});
