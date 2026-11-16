# LokaChat — Project Spec (v4)

Mobile-first, desktop-responsive social app: YouTube-style video hub, Instagram-style follows, stories, reels and notes,
WhatsApp/Instagram-style end-to-end encrypted chat, authenticator (TOTP) vault.

## Architecture
| Layer | Tech | Hosted on |
|---|---|---|
| Frontend `frontend/` | Vanilla HTML/CSS/JS, **no build step**, Supabase JS via CDN | Vercel (same project) |
| API `backend/` | Python 3.12, FastAPI, supabase-py (service_role), passlib/bcrypt, python-jose, pyotp | Vercel Python runtime at `/api/*` |
| Data | PostgreSQL + RLS, Realtime, public Storage bucket `media` | Supabase |

One Vercel project: `vercel.json` routes `/api/(.*)` → `backend/main.py` and `/(.*)` → `frontend/$1`. `config.js` has `API_URL:"/api"`
(same origin, no CORS). A middleware strips the `/api` prefix so the backend also works without it. Root `requirements.txt` is used by Vercel.
On Vercel (`VERCEL` env) OTP email/SMS is sent synchronously. Turn `OTP_DEV_MODE` off in production.

Flow: browser → FastAPI (auth, OTP, 2FA, follows, posts, comments, chats). FastAPI mints a **Supabase-compatible JWT**
(`role=authenticated`, `sub=users.id`). The browser uses it with the anon key for **Storage uploads** (own `<user_id>/` folder only) and
**Realtime** (RLS-filtered). Browser DB access is read-only; all writes go through the API. `users`, `otp_codes`, `comments`, `saved_posts`,
`notes` are never readable from the browser. The service_role key and JWT secret never go in the frontend.

## Palette (monochrome + sky blue) — `style.css :root`
`--bg-base #000` · `--bg-sidebar #050505` · `--bg-card #0F1115` · `--bg-elevated #181B22` · `--border-subtle #222630` ·
`--text-main #FFF` · `--text-muted #8E95A5` · `--accent-blue #38BDF8`.
Wordmark everywhere: **Loka** white + **Chat** `#38BDF8`. It **never** collapses to "LC".
Story rings: unseen `linear-gradient(45deg,#38BDF8,#FFF,#0284C7)` with a 2px `#000` gap; seen `#2A2F3A`.
Scrollbars: 4px wide, thumb `#222630`, transparent track (`::-webkit-scrollbar`, plus `scrollbar-width: thin`).

## v4 specification

### 1. Zero-lag performance
- Never reload or re-fetch on tab switch. Each route is a persistent DOM pane toggled with `hidden`; switching Home / Reels / Messages / You is instant (<16ms).
- `App.S.cache` (state.cache) holds feeds, profiles, chats, comments, notes. Stale-while-revalidate: render the cached copy immediately, refresh in the background, re-render only if data changed. Prefetch after login.
- Optimistic UI for send message, like, comment, follow, save, react; roll back and toast on failure.

### 2. Shell
- Fixed top header: hamburger/arrow toggle button (`☰` / `→`) next to the **Loka**Chat wordmark. Sidebar rail: 76px icons → 240px on hover or when pinned. No "LC".
- Top-right cluster: notifications heart `♡` (unread dot; slide-over drawer with follows, likes, comments; `POST /users/notifications/seen` clears it) and a `+ Create` menu.
- Desktop ≥768px: floating bottom-right **Messages pill** (`position:fixed; bottom:20px; right:24px`): paper-plane, "Messages", unread badge, mini friend avatars; opens a quick-chat popover; jumps to Messages.
- Mobile <768px: sleek bottom nav (Home, Reels, Post, Chats, You), zero horizontal overflow, ≥44px tap targets.

### 3. Video hub (Home)
- Sticky horizontally slideable sub-tabs: **Recommended**, **Following**, **Community Posts** (text + optional image posts) plus category pills.
- Hover-to-preview: muted live preview inside the thumbnail on mouse enter, pause + reset on leave.
- Theater watch page: player, title, follow, like/dislike, share, save, full comments (replies one level, comment likes, delete) on the left; Up Next on the right.
- Custom controls: play/pause, scrubber, volume, quality (Auto/1080p/720p/480p), speed 0.5×–2×, CC, PiP, fullscreen; `<video preload="metadata">`.
- Double-click/tap on a video or post → sky-blue/white heart burst + like.

### 4. Reels
- Vertical 9:16 feed, `scroll-snap-type: y mandatory`, auto-play the visible reel, sound toggle.
- Double-tap heart; right action stack (like + count, comment drawer, share, mute); bottom overlay with avatar, `@username`, Follow pill, caption, scrolling music ticker.

### 5. Messages (Instagram-style, E2EE)
- Header `@username`, rounded search bar, horizontal Notes & Stories row (blue/white gradient rings; floating Note bubbles above avatars).
- Sub-tabs Chats / Stories / Channels. Pill input bar, emoji + GIF drawer (searchable; optional `GIPHY_KEY`, else built-in reaction grid), image/video/voice attachments.
- Double-tap a bubble → ❤️ reaction; reply-to-message.
- Multi-device E2EE fix: private key is backed up **encrypted with the user's password** (PBKDF2 250k → AES-GCM) in `users.key_backup`, restored on login on a new device. Wrapped chat keys embed the wrapper's public key so old messages stay decryptable after key changes. Error toasts show name + message.
- Message plaintext is JSON: text `{v:1,k:"text",t,r}`, gif `{k:"gif",u,t}`, attachments `{k:"image|video|audio|voice",p,m,i,n,d,s}`. Attachments are encrypted client-side with the chat key and uploaded as opaque `.bin` blobs. Reactions are plaintext metadata.

### 6. Profile (You)
- **No email or phone is shown anywhere.** Avatar, display name, `@username`, bio, Posts / Followers / Following, Edit Profile.
- Horizontal Watch History carousel; grid tabs Posts / Reels / Saved. The 2FA authenticator vault lives in a **Security & 2FA** modal.

## API additions (v4)
`GET /posts/{id}` · `GET /posts/{id}/comments` · `POST /posts/comment` · `DELETE /comments/{id}` · `POST /comments/like` · `POST /posts/save` ·
`PUT|DELETE /users/me/note` · `GET /notes` · `POST /chats/react` · `POST /users/notifications/seen` ·
feed tabs `community` and `saved` · `POST /posts/create` accepts type `community` (text, optional image) and `music`.
`GET /users/notifications` → `{items, unread}`. `PUT /users/me/key` accepts `key_backup`.
Database: run `backend/schema.sql`, then `backend/migrations/v4.sql`.

## Honest limitations
- Quality selector only offers the original file (no transcoding); other options are shown unavailable. CC works only if caption tracks exist.
- Dislike is local only. Message reactions are not encrypted. Channels are plaintext.
- In-memory rate limiter is per serverless instance.

## Frontend files (load order)
`config.js` → `crypto.js` → `api.js` → `core.js` → `views.js` → `chat.js` → `you.js` → `app.js`.

## Conventions
Modular, commented, no build step. Escape all interpolated text with `App.esc`. Use `data-action` / `data-form` delegation, not inline handlers.

## Status
- v3 complete and tested. v4 backend complete and tested (pytest, fake Supabase). v4 frontend in progress.
- **Not yet verified against live Supabase/Vercel or in real browsers.**
