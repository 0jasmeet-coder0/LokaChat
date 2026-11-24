/* =====================================================================
   LokaChat - crypto.js   (v8, WebCrypto only, no dependencies)

   TRUE end-to-end encryption for PRIVATE chats (direct + group):
     * every device owns an ECDH P-256 identity key pair (the PRIVATE key never leaves the device)
     * every conversation has a random AES-256-GCM key per "epoch"
     * that key is wrapped for each member DEVICE with ephemeral ECDH -> HKDF-SHA256 -> AES-256-GCM
       (the server only ever sees public keys and opaque wrapped blobs)
     * adding/removing a member or device rotates the key (a new epoch), so leavers can't read new messages

   Channels stay public/plaintext. Old messages keep decrypting with the legacy server-derivable key
   (conversationKey / PBKDF2) - that path is kept ONLY for reading pre-v8 history.

   Also: local vault (PBKDF2-sealed JSON), encrypted key backup, TOTP (RFC 6238) + base32 + otpauth://.
   ===================================================================== */
(function () {
  "use strict";
  const subtle = crypto.subtle;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // ---------- base64 / random helpers ----------
  const b64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
  const hex = (buf) => Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, "0")).join("");

  // ==================================================== symmetric (legacy + shared)
  // Fallback key for messages sent BEFORE v8 (server-derivable; kept for reading old history only).
  const fbCache = new Map();
  async function conversationKey(conversationId) {
    const id = String(conversationId || "");
    if (fbCache.has(id)) return fbCache.get(id);
    const base = await subtle.importKey("raw", enc.encode(id.toLowerCase()), "PBKDF2", false, ["deriveKey"]);
    const key = await subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode("lokachat-fallback-conversation-key-v1"), iterations: 100000 },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    fbCache.set(id, key);
    return key;
  }

  async function encryptText(key, text) {
    const iv = rand(12);
    const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text));
    return { ciphertext: b64(ct), iv: b64(iv) };
  }
  async function decryptText(key, ciphertext, iv) {
    const pt = await subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ciphertext));
    return dec.decode(pt);
  }

  /** Attachments: iv (12 bytes) || ciphertext, as raw bytes. */
  async function encryptBytes(key, buf) {
    const iv = rand(12);
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, buf));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv); out.set(ct, 12);
    return out;
  }
  async function decryptBytes(key, buf) {
    const bytes = new Uint8Array(buf);
    return subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  }

  /** Import a raw 32-byte AES key. `extractable` is needed when the key must be wrapped for other devices. */
  const importRawKey = (raw, extractable = true) =>
    subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, extractable, ["encrypt", "decrypt"]);
  const exportRawKey = async (key) => new Uint8Array(await subtle.exportKey("raw", key));
  const generateConversationKey = () => rand(32);

  // ==================================================== ECDH P-256 device identity
  const DEVICE_ID_KEY = "loka_device_id_v8";
  const DEVICE_KEY_KEY = "loka_device_keys_v8";
  let deviceCache = null;

  function deviceId() {
    let id = null;
    try { id = localStorage.getItem(DEVICE_ID_KEY); } catch (e) { /* ignore */ }
    if (!id || !/^[a-f0-9]{16,64}$/.test(id)) {
      id = hex(rand(16)); // 32 hex chars
      try { localStorage.setItem(DEVICE_ID_KEY, id); } catch (e) { /* ignore */ }
    }
    return id;
  }

  /** Compact public JWK (exactly what the server accepts: kty/crv/x/y, never a private key). */
  const publicJwk = (dev) => JSON.stringify({ kty: "EC", crv: "P-256", x: dev.pubJwk.x, y: dev.pubJwk.y });

  /** Load this device's ECDH identity key pair, generating + persisting it on first use. */
  async function ensureDevice() {
    if (deviceCache) return deviceCache;
    const id = deviceId();
    let privateKey = null, pubJwk = null;
    try {
      const stored = JSON.parse(localStorage.getItem(DEVICE_KEY_KEY) || "null");
      if (stored && stored.privateKey && stored.publicKey) {
        privateKey = await subtle.importKey("jwk", stored.privateKey, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey", "deriveBits"]);
        pubJwk = stored.publicKey;
      }
    } catch (e) { privateKey = null; pubJwk = null; }
    if (!privateKey || !pubJwk) {
      const kp = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey", "deriveBits"]);
      const pub = await subtle.exportKey("jwk", kp.publicKey);
      const priv = await subtle.exportKey("jwk", kp.privateKey);
      pubJwk = { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y };
      try { localStorage.setItem(DEVICE_KEY_KEY, JSON.stringify({ publicKey: pubJwk, privateKey: priv })); } catch (e) { /* ignore */ }
      privateKey = await subtle.importKey("jwk", priv, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey", "deriveBits"]);
    }
    deviceCache = { id, privateKey, pubJwk, publicKey: publicJwk({ pubJwk }) };
    return deviceCache;
  }

  /** Forget this device's identity (used by "sign out everywhere" / reset). */
  function forgetDevice() {
    deviceCache = null;
    try { localStorage.removeItem(DEVICE_KEY_KEY); } catch (e) { /* ignore */ }
  }

  // ==================================================== key wrapping (ECDH-ES + HKDF + AES-GCM)
  const HKDF_SALT = "lokachat-e2ee-v1";
  const HKDF_INFO = "lokachat-key-wrap";

  async function kekFrom(myPrivate, theirPublic) {
    const bits = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: theirPublic }, myPrivate, 256));
    const base = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode(HKDF_SALT), info: enc.encode(HKDF_INFO) },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  /** Wrap the raw conversation key for one recipient device. Returns { eph_pub, wrapped }. */
  async function wrapKey(recipientPubJwk, rawKey) {
    const jwk = typeof recipientPubJwk === "string" ? JSON.parse(recipientPubJwk) : recipientPubJwk;
    const theirPub = await subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const eph = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey", "deriveBits"]);
    const kek = await kekFrom(eph.privateKey, theirPub);
    const iv = rand(12);
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, kek, rawKey));
    const packed = new Uint8Array(12 + ct.length); packed.set(iv); packed.set(ct, 12);
    const ephJwk = await subtle.exportKey("jwk", eph.publicKey);
    return { eph_pub: JSON.stringify({ kty: "EC", crv: "P-256", x: ephJwk.x, y: ephJwk.y }), wrapped: b64(packed) };
  }

  /** Unwrap an epoch key addressed to this device. Returns the raw 32-byte AES key. */
  async function unwrapKey(devicePrivateKey, ephPub, wrapped) {
    const jwk = typeof ephPub === "string" ? JSON.parse(ephPub) : ephPub;
    const eph = await subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const kek = await kekFrom(devicePrivateKey, eph);
    const packed = unb64(wrapped);
    return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: packed.slice(0, 12) }, kek, packed.slice(12)));
  }

  // ==================================================== encrypted key backup
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

  /** Seal arbitrary JSON (e.g. the device private key) into one portable, password-protected string. */
  async function backupSeal(pass, obj) {
    const salt = rand(16);
    const key = await passKey(pass, salt);
    return b64(enc.encode(JSON.stringify(await sealJson(key, salt, obj))));
  }
  async function backupOpen(pass, blob) {
    const sealed = JSON.parse(dec.decode(unb64(blob)));
    const key = await passKey(pass, unb64(sealed.salt));
    const pt = await subtle.decrypt({ name: "AES-GCM", iv: unb64(sealed.iv) }, key, unb64(sealed.ct)); // throws on wrong pass
    return JSON.parse(dec.decode(pt));
  }

  // ==================================================== local vault (authenticator secrets)
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

  // ==================================================== TOTP
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
    // symmetric / legacy
    conversationKey, encryptText, decryptText, encryptBytes, decryptBytes,
    importRawKey, exportRawKey, generateConversationKey,
    // ECDH P-256 device identity + key wrapping
    deviceId, ensureDevice, forgetDevice, publicJwk, wrapKey, unwrapKey,
    // encrypted key backup + vault + TOTP
    backupSeal, backupOpen, vaultCreate, vaultOpen, sealJson, totp, parseOtpauth, base32ToBytes,
    // small utils
    b64, unb64,
  };
})();
