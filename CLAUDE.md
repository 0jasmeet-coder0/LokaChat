# LokaChat — Project Spec (v3)

Mobile-first, desktop-responsive social app: YouTube-style video feeds, Instagram-style follows,
24h stories and short clips, WhatsApp-style end-to-end encrypted chat, authenticator (TOTP) vault.

## Architecture
| Layer | Tech | Hosted on |
|---|---|---|
| Frontend `frontend/` | Vanilla HTML/CSS/JS, **no build step**, Supabase JS via CDN | Vercel (Root Directory = `frontend`) |
| API `backend/` | Python 3.12, FastAPI, supabase-py (service_role), passlib/bcrypt, python-jose, pyotp | Koyeb (Dockerfile, work dir `backend`) |
| Data | PostgreSQL + RLS, Realtime, public Storage bucket `media` | Supabase |

Flow: browser → FastAPI (auth, OTP, 2FA, follows, posts, chats). FastAPI mints a **Supabase-compatible JWT**
(signed with the project JWT secret, `role=authenticated`, `sub=users.id`). The browser uses it with the anon key
for **Storage uploads** (own `<user_id>/` folder only) and **Realtime** (RLS-filtered). The browser has read-only
DB access; all writes go through the API. `users` and `otp_codes` are never readable from the browser.

## Palette (monochrome + sky blue) — `style.css :root`
`--bg-base #000000` · `--bg-sidebar #050505` · `--bg-card #0F1115` · `--bg-elevated #181B22` ·
`--border-subtle #222630` · `--text-main #FFFFFF` · `--text-muted #8E95A5` · `--accent-blue #38BDF8`.
Blue is used only for the "Chat" half of the logo, primary buttons, active indicators and story rings.
Wordmark everywhere: **Loka** white + **Chat** `#38BDF8`.
Story rings: unviewed `linear-gradient(45deg,#38BDF8,#FFFFFF,#0284C7)` with a 2px `#000` gap; viewed `#2A2F3A`.

## Layout
- Desktop ≥768px: Instagram-style rail, 76px icons-only → 240px on hover or pin (`transition: width .22s ease`).
  Labels: Home, Clips, Messages, Search, Notifications, Post, You. Rail overlays on hover; `.rail-space` shifts content only when pinned.
  Content grid: `repeat(auto-fill, minmax(300px, 1fr))`.
- Mobile <768px: top bar + 60px bottom nav (Home, Post, Chats, You).
- Splash (1.8s, pure CSS on #000): blue droplet falls → two ripples (blue + white) → wordmark + pulsing dots → fade. No bar/arrow.

## Auth (no guest account)
Sign up (username, email/phone, display name, password) → 6-digit OTP → verified account.
Sign in = password, then email/SMS OTP, or authenticator code if 2FA is on. 2FA is enabled in **You → Security**.
Session = JWT in `localStorage` (`loka_token`). Log out button in the You tab. OTP delivery: SMTP, Twilio, or `OTP_DEV_MODE` (returns `dev_otp`).

## API (FastAPI, `backend/main.py`)
`GET /health` · `POST /auth/signup|resend-otp|verify-otp|login` · `GET /auth/me` · `POST /auth/2fa/setup|verify|disable` ·
`PATCH /users/me` · `PUT /users/me/key` · `POST /users/keys` · `GET /users/search|following|notifications|{username}` · `POST /users/follow` ·
`POST /posts/create` · `GET /posts/feed?tab=recommended|following|clips|stories|mine|user` · `POST /posts/like|view` · `GET /history` · `DELETE /posts/{id}` ·
`GET /chats` · `POST /chats/create|send|{id}/join` · `GET /chats/{id}/messages` · `DELETE /chats/{id}` · `GET /channels/discover`.

## E2EE
Per-user ECDH P-256 key pair in IndexedDB (public JWK stored on server). Each direct/group chat has a random AES-256-GCM key,
wrapped per member via ECDH + HKDF. Server stores only ciphertext. Channels are public plaintext broadcasts.
Limits: a new device creates a new key (older chats unreadable there); group membership is fixed at creation.

## Frontend files (load order)
`config.js` (paste keys) → `crypto.js` → `api.js` → `core.js` (helpers, modal stack, router, data-action delegation) →
`views.js` (home, stories, player, clips, upload, search, notifications, profile) → `chat.js` → `you.js` (profile, history, 2FA, vault) → `app.js` (auth gate + boot).

## Conventions
Modular, commented, no build step. Escape all interpolated text with `App.esc`. Use `data-action` / `data-form` delegation, not inline handlers.

## Status
- Phase 1 (v1–v3): complete — frontend + backend built. Backend tested (pytest vs fake Supabase); frontend tested end-to-end in a headless DOM against the real API with a fake Supabase.
- **Not yet verified against live Supabase/Koyeb or in real browsers** (Realtime, Storage, video upload/poster capture).
- Next: Phase 2 (per master spec) only after Phase 1 is confirmed on real infrastructure.
