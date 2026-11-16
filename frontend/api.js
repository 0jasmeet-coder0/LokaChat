/* =====================================================================
   LokaChat - api.js
   - fetch wrapper for the FastAPI backend (API_URL from config.js)
   - Supabase JS client (Storage uploads + Realtime) authenticated with the
     session JWT minted by the backend, so Row Level Security applies.
   ===================================================================== */
(function () {
  "use strict";
  const cfg = window.LOKA_CONFIG || {};
  const TOKEN_KEY = "loka_token";
  const BUCKET = "media";
  let token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { /* storage blocked */ }
  let sb = null;
  let channel = null;
  let onUnauthorized = () => {};

  const configured = () => !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && apiRoot() && window.supabase);
  // Inside a Capacitor app the page origin is https://localhost, so a relative "/api" would hit
  // the app itself. There we use the absolute MOBILE_API_URL (your live Vercel URL + "/api").
  const isNative = () => { try { return !!(window.Capacitor && (window.Capacitor.isNativePlatform ? window.Capacitor.isNativePlatform() : window.Capacitor.getPlatform && window.Capacitor.getPlatform() !== "web")); } catch (e) { return false; } };
  const apiRoot = () => (isNative() && !/^https?:\/\//i.test(cfg.API_URL || "") ? (cfg.MOBILE_API_URL || "") : (cfg.API_URL || ""));
  const base = () => apiRoot().replace(/\/+$/, "");

  class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }

  function errMessage(data, status) {
    const d = data && data.detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d) && d.length) {
      const e = d[0];
      const field = (e.loc || []).slice(1).join(".");
      const msg = String(e.msg || "Invalid value").replace(/^Value error, /, "");
      return field && !/^(body|query)$/.test(field) ? `${field}: ${msg}` : msg;
    }
    return status === 429 ? "Too many attempts. Please wait a moment." : `Request failed (${status})`;
  }

  async function request(method, path, body, { auth = true } = {}) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth && token) headers.Authorization = "Bearer " + token;
    let res;
    try {
      res = await fetch(base() + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch (e) {
      throw new ApiError("Can't reach the server. Check your connection and try again.", 0);
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) {
      if (res.status === 401 && auth && token && path !== "/auth/2fa/disable") onUnauthorized(); // wrong password there is not a dead session
      throw new ApiError(errMessage(data, res.status), res.status);
    }
    return data;
  }

  // ---------- supabase client ----------
  function buildClient() {
    if (!configured()) return null;
    if (channel && sb) { try { sb.removeChannel(channel); } catch (e) { /* ignore */ } channel = null; }
    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: token ? { Authorization: "Bearer " + token } : {} },
      realtime: { params: { eventsPerSecond: 10 } },
    });
    if (token) sb.realtime.setAuth(token);
    return sb;
  }

  function setToken(t) {
    token = t || null;
    try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
    buildClient();
  }

  async function upload(path, file, contentType) {
    if (!sb) throw new ApiError("Storage is not configured", 0);
    const { error } = await sb.storage.from(BUCKET).upload(path, file, {
      contentType: contentType || file.type || "application/octet-stream", upsert: false, cacheControl: "3600",
    });
    if (error) throw new ApiError(error.message || "Upload failed", 0);
    return path;
  }
  async function removeFiles(paths) {
    const list = paths.filter(Boolean);
    if (sb && list.length) { try { await sb.storage.from(BUCKET).remove(list); } catch (e) { /* best effort */ } }
  }
  const publicUrl = (path) => (sb && path ? sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl : "");

  /** Realtime: new messages, new memberships (someone started a chat with you), new posts. */
  function subscribe(userId, handlers) {
    if (!sb) return;
    if (channel) { try { sb.removeChannel(channel); } catch (e) { /* ignore */ } }
    channel = sb.channel("loka-live-" + userId)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (p) => handlers.onMessage && handlers.onMessage(p.new))
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "conversation_members", filter: "user_id=eq." + userId },
        (p) => handlers.onMembership && handlers.onMembership(p.new))
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "posts" }, (p) => handlers.onPost && handlers.onPost(p.new))
      .on("postgres_changes", { event: "*", schema: "public", table: "message_reactions" }, (p) => handlers.onReaction && handlers.onReaction(p.new || p.old))
      .subscribe((status) => handlers.onStatus && handlers.onStatus(status));
  }
  function unsubscribe() {
    if (sb && channel) { try { sb.removeChannel(channel); } catch (e) { /* ignore */ } }
    channel = null;
  }

  buildClient();

  window.LokaApi = {
    configured, ApiError, request, setToken, upload, removeFiles, publicUrl, subscribe, unsubscribe,
    hasToken: () => !!token,
    apiRoot,
    isNative,
    onUnauthorized: (fn) => { onUnauthorized = fn; },
    get: (p) => request("GET", p),
    post: (p, b, o) => request("POST", p, b === undefined ? {} : b, o),
    patch: (p, b) => request("PATCH", p, b),
    put: (p, b) => request("PUT", p, b),
    del: (p) => request("DELETE", p),
  };
})();
