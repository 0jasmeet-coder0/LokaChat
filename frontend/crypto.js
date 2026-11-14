/* =====================================================================
   LokaChat - crypto.js   (WebCrypto only, no dependencies)
   - E2EE identity: per-user ECDH P-256 key pair kept in IndexedDB
   - Chat keys: random AES-256-GCM key, wrapped per member with ECDH + HKDF
   - Message encryption: AES-256-GCM
   - Local vault: PBKDF2 -> AES-GCM sealed JSON
   - TOTP (RFC 6238, HMAC-SHA1) + base32 + otpauth:// parsing
   ===================================================================== */
(function () {
  "use strict";
  const subtle = crypto.subtle;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // ---------- base64 helpers ----------
  const b64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

  // ---------- IndexedDB key store ----------
  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("lokachat-keys", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("keys");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGet(key) {
    const db = await idb();
    return new Promise((res, rej) => {
      const r = db.transaction("keys").objectStore("keys").get(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbSet(key, value) {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction("keys", "readwrite");
      tx.objectStore("keys").put(value, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  /** Returns { privateKey, publicJwk, created } - generating a new pair on first use on this device. */
  async function ensureIdentity(userId) {
    const k = "identity:" + userId;
    const saved = await idbGet(k);
    if (saved && saved.privateKey && saved.publicJwk) return { ...saved, created: false };
    const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const publicJwk = await subtle.exportKey("jwk", pair.publicKey);
    const rec = { privateKey: pair.privateKey, publicJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y } };
    await idbSet(k, rec);
    return { ...rec, created: true };
  }

  // ---------- chat keys ----------
  async function newChatKeyRaw() {
    const key = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    return new Uint8Array(await subtle.exportKey("raw", key));
  }
  const importChatKey = (raw) => subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);

  async function wrapKeyFor(myPrivate, theirPublicJwk) {
    const pub = await subtle.importKey("jwk", theirPublicJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const bits = await subtle.deriveBits({ name: "ECDH", public: pub }, myPrivate, 256);
    const hk = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    return subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode("lokachat-chat-key-wrap-v1") },
      hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  /** Wrap raw chat key for a recipient. Returns base64(iv || ciphertext). */
  async function wrapChatKey(raw, myPrivate, theirPublicJwk) {
    const k = await wrapKeyFor(myPrivate, theirPublicJwk);
    const iv = rand(12);
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, k, raw));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv); out.set(ct, 12);
    return b64(out);
  }
  /** Unwrap a chat key that `wrapperPublicJwk`'s owner wrapped for me. */
  async function unwrapChatKey(wrapped, myPrivate, wrapperPublicJwk) {
    const k = await wrapKeyFor(myPrivate, wrapperPublicJwk);
    const bytes = unb64(wrapped);
    const raw = await subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, k, bytes.slice(12));
    return importChatKey(new Uint8Array(raw));
  }

  // ---------- message encryption ----------
  async function encryptText(key, text) {
    const iv = rand(12);
    const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text));
    return { ciphertext: b64(ct), iv: b64(iv) };
  }
  async function decryptText(key, ciphertext, iv) {
    const pt = await subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ciphertext));
    return dec.decode(pt);
  }

  // ---------- local vault (sealed with a passphrase) ----------
  async function passKey(pass, salt) {
    const base = await subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
    return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 250000 }, base,
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function sealJson(key, salt, obj) {
    const iv = rand(12);
    const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj)));
    return { salt: b64(salt), iv: b64(iv), ct: b64(ct) };
  }
  async function vaultCreate(pass, obj) {
    const salt = rand(16);
    const key = await passKey(pass, salt);
    return { key, salt, blob: await sealJson(key, salt, obj) };
  }
  async function vaultOpen(pass, blob) {
    const salt = unb64(blob.salt);
    const key = await passKey(pass, salt);
    const pt = await subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) }, key, unb64(blob.ct)); // throws on wrong pass
    return { key, salt, data: JSON.parse(dec.decode(pt)) };
  }

  // ---------- TOTP ----------
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  function base32ToBytes(s) {
    const clean = s.toUpperCase().replace(/[\s=-]/g, "");
    let bits = "";
    for (const ch of clean) {
      const v = B32.indexOf(ch);
      if (v < 0) throw new Error("Invalid base32 secret");
      bits += v.toString(2).padStart(5, "0");
    }
    const out = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
    return new Uint8Array(out);
  }
  async function totp(secret, { digits = 6, period = 30, time = Date.now() } = {}) {
    const key = await subtle.importKey("raw", base32ToBytes(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const counter = Math.floor(time / 1000 / period);
    const msg = new ArrayBuffer(8);
    const view = new DataView(msg);
    view.setUint32(0, Math.floor(counter / 2 ** 32));
    view.setUint32(4, counter >>> 0);
    const h = new Uint8Array(await subtle.sign("HMAC", key, msg));
    const o = h[h.length - 1] & 15;
    const bin = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
    return String(bin % 10 ** digits).padStart(digits, "0");
  }
  /** Accepts a bare base32 secret or an otpauth://totp/... URI. */
  function parseOtpauth(input) {
    const t = input.trim();
    if (!/^otpauth:\/\//i.test(t)) {
      base32ToBytes(t); // validates
      return { secret: t.replace(/[\s-]/g, "").toUpperCase(), issuer: "", account: "", digits: 6, period: 30 };
    }
    const u = new URL(t);
    const label = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
    const [issuerPart, accountPart] = label.includes(":") ? label.split(/:(.+)/) : ["", label];
    const secret = u.searchParams.get("secret");
    if (!secret) throw new Error("This link has no secret");
    base32ToBytes(secret);
    return {
      secret: secret.replace(/[\s-]/g, "").toUpperCase(),
      issuer: u.searchParams.get("issuer") || issuerPart || "",
      account: accountPart || "",
      digits: Number(u.searchParams.get("digits")) || 6,
      period: Number(u.searchParams.get("period")) || 30,
    };
  }

  window.LokaCrypto = {
    ensureIdentity, newChatKeyRaw, importChatKey, wrapChatKey, unwrapChatKey,
    encryptText, decryptText, vaultCreate, vaultOpen, sealJson, totp, parseOtpauth, base32ToBytes,
  };
})();
