# LokaChat — Project Spec (v6 + PWA/Capacitor)

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
Scrollbars: vertical 3px, thumb `#222630`, transparent track; horizontal scrollbars are hidden everywhere (v6).

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
- Encryption is symmetric only (see "Invisible E2EE" below): no per-device key pairs, so every device reads every message. Error toasts show name + message.
- Message plaintext is JSON: text `{v:1,k:"text",t,r}`, gif `{k:"gif",u,t}`, attachments `{k:"image|video|audio|voice",p,m,i,n,d,s}`. Attachments are encrypted client-side with the conversation key and uploaded as opaque `.bin` blobs. Reactions are plaintext metadata.

### 6. Profile (You)
- **No email or phone is shown anywhere.** Avatar, display name, `@username`, bio, Posts / Followers / Following, Edit Profile.
- Horizontal Watch History carousel; grid tabs Posts / Reels / Saved. The 2FA authenticator vault lives in a **Security & 2FA** modal.

## v5 specification

### Invisible E2EE (WhatsApp style)
- No lock pills, no "Set up encryption" modals, no "Restore my keys" links. Each open chat starts with a centered `.e2e-banner` (max-width 420px, `#161920`): "Messages in this chat are end-to-end encrypted. No one outside of this chat, not even LokaChat, can read, listen to, or share them."
- **No ECDH, no per-device keys, no identity/key backup.** `crypto.js` `conversationKey(conversation_id)` = AES-256-GCM key from PBKDF2-SHA256 (100k iterations, salt `lokachat-fallback-conversation-key-v1`, lowercased conversation id), cached per conversation. `chat.js` `convKey(chat)` is used for text and attachments in both directions on every device. New chats store the placeholder `wrapped_key = "fb1"`. Legacy messages with an `"f."` iv prefix decrypt (prefix stripped); old ECDH messages can no longer be decrypted.
- Undecryptable old messages render as a subtle pill "Message from earlier session" (`.undec`), no restore link.
- **Limitation:** the key is derivable from the conversation id + public salt, so chats are access-controlled, not truly end-to-end secret (the server operator could derive it). The banner wording overstates this.
- Backend `/users/me/key`, `users.key_backup` and `users.public_key` still exist but are unused by the frontend.

### Music notes + chat media
- Notes: text and/or a song picked via the iTunes Search API (`https://itunes.apple.com/search?media=music&entity=song`, no key, 30 s `.m4a` previews). Stored in `notes.track` (JSON `{title,artist,url,cover}`); hosts are validated (https, `apple.com`/`*.apple.com`/`*.mzstatic.com`) in `models.clean_track` and `chat.js safeTrack`. Bubble shows title + animated `.eq` bars; clicking a note opens `note-view` (plays preview; own note: Leave a new note / Delete note; friends: quick reply -> DM).
- Chat `+` menu: Photo or video (encrypted upload to the `media` bucket), Music (iTunes search, inline `<audio>` card, payload `{k:"music",t,a,u,c}`), GIF or sticker.

### Chat themes
- Details panel (ⓘ in chat header) has 6 presets: Classic Sky `#38BDF8`, Monochrome, Midnight Indigo, Crimson Rose, Emerald Mint, Royal Violet. `.conv[data-theme]` sets `--c-bubble/--c-bubble-fg/--c-accent`; saved per conversation in `localStorage` key `loka_chat_theme:<id>`.

### Sidebar + favicon
- Rail order: Home, Reels, Messages, Search, Notifications, Create, Profile; Settings (gear) and More (☰: Saved, Watch history, Security & 2FA vault, Log out) pinned at the bottom (`.rail-bottom{margin-top:auto}`). Pin/collapse arrow (←/→) sits next to the wordmark. Inline SVG favicon in `index.html` (no `/favicon.ico` request).

### PWA
- `frontend/manifest.json` (standalone, `#000000`, 192/512 icons), `frontend/service-worker.js` (caches only the same-origin static shell; bypasses `/api`, Supabase, cross-origin, non-GET and range requests; network-first for static files; bump `VERSION` on deploys, currently `lokachat-shell-v6`), registered in `app.js` (skipped inside Capacitor; the page reloads once when a new worker takes control). `viewport-fit=cover`, Apple touch icon and meta tags in `index.html`.
- Icons: run `node tools/make-icons.js` from the project root to generate `frontend/assets/icon-192.png` and `icon-512.png` (dependency-free). `frontend/assets/icon.svg` is the vector source.

### Capacitor (Android/iOS)
- `capacitor.config.json` (`appId com.lokachat.app`, `webDir frontend`) and a root `package.json`. Inside the native shell the page origin is `https://localhost`, so `api.js` uses `config.js` `MOBILE_API_URL` (full `https://<your-app>.vercel.app/api`) whenever `API_URL` is relative. The boot setup screen flags a missing `MOBILE_API_URL`. Backend CORS must allow the app origin (`ALLOWED_ORIGINS` defaults to `*`).
- Commands: `npm install`, `npx cap add android`, `npx cap sync android`, `npx cap open android`.

## v6 specification

### Shell + scrolling
- Horizontal scrollbars hidden everywhere (content still scrolls/swipes). Desktop rail: collapsed 72px shows only the arrow/menu toggle (no "LC"); expanded/pinned 240px shows **Loka**(white)**Chat**(#38BDF8) + ← arrow.
- Mobile <768px: horizontal swipe (`v6.js`) moves Recommended → Following → Community, Chats → Stories → Channels, profile sub-tabs, then across Home → Reels → Messages → You. Swipes starting in `.hscroll`, inputs, the player, modals, stories or an open chat are ignored. You page header has a ⚙️ Settings button (`.set-mobile`: Edit profile, Privacy, Security & 2FA, 2FA Vault).
- Mobile overhaul: safe-area padding, 44px targets, edge-to-edge cards, full-screen Reels (topbar hidden), bottom tab bar.

### + Create studio (`v6.js`)
- Menu: Upload video / Create post / Create story → modal studio (`App.openCreate`). Drag-and-drop; auto-detects 16:9 video, 9:16 reel, image post, community post; live preview, Fit/Fill, photo crop (Original/1:1/4:5/16:9, baked client-side), cover-thumbnail picker (6 frames) for videos, upload progress.
- Toggles: **Share as 24h Story** (second `story` post from the same file) and **Promote as Sponsored Ad** (CTA Watch / Visit site / Learn more + https URL).
- No native `<audio controls>` anywhere: `App.audioChip(url,{start,len})` is a custom play/pause pill with progress + animated equalizer (`.ap`).
- **Music Library** (`App.musicLibrary`): iTunes Search + curated trending chips (Trending/Hindi/Pop/Hip-Hop/Chill) + ♥ Saved; album art, animated `.eq` bars; waveform clip selector (draggable 5/10/15/30 s window over the 30 s preview; real waveform when the audio can be decoded, else a seeded synthetic one). Used for Reels and Stories; picked tracks are stored in `posts.music` as JSON `{title,artist,url,cover,start,len}` and played with `App.playClip` (loops only that window). Saved audios: `liked_audios`.
- Profile tabs: Posts · Reels · Saved · Liked Videos · Liked Reels · Saved Audios (+ Watch History carousel).

### Watch page / player
- Floating bottom-right **miniplayer** (play/pause, ✕, click to maximize) when the stage scrolls out of view after playback started (PC + mobile; sits above the bottom nav on mobile).
- **Auto-CC**: uses real `.vtt` tracks when present, otherwise the Web Speech API + `.vp-cc` caption overlay.
- **Adaptive resolution**: Auto / 1080p / 720p / 480p / 360p Data Saver drawn through a canvas (`App.attachScaler`) from the one stored file; Auto follows Network Information / player size. Speed 0.5×–2×.
- Comments: `gap:14px` between Reply and Delete; GIF / sticker comments (`comments.gif_url`; GIPHY if `GIPHY_KEY` else built-in stickers); creator can 📌 Pin one top-level comment (`posts.pinned_comment_id`, shown first with a "Pinned by creator" tag) and delete any comment on their own post.

### Ranking + Sponsored ads
- Recommended/Reels/Explore: `score = (views*1 + likes*4 + comments*6 + watch_completion*5) × age decay`; Following stays chronological (`main.py rank_posts`).
- Sponsored posts (`posts.is_sponsored, cta_label, cta_url`) are excluded from organic ranking and injected as ads: Home grid every 6th card, Reels every 5th reel, each with a **Sponsored** badge and CTA button.

### Search, share, DM
- Search tab: Instagram-style masonry grid of trending Reels & Videos before typing; instant filters All / Users / Reels / Videos / Audios.
- Share sheet (✈): row of friends (one tap sends a `{k:"share"}` message into their E2EE chat), Copy link, WhatsApp, X, More (Web Share).
- DM message actions (right-click on PC, 400 ms long-press on mobile): floating emoji pill (❤️ 😂 😮 😢 😡 👍 +) above the message, menu below: Reply, Forward (re-encrypts attachments for the target chat), Edit (own text; `edited_at`, "edited" label), Copy, Translate (MyMemory, only after a confirm), Pin (`conversations.pinned_message_id`, pin bar), Unsend (deletes for everyone; realtime UPDATE/DELETE). Composer has Emoji, GIF, Photo/Video, Mic.

## API additions (v6)
`POST /comments/pin` · `POST /chats/edit` · `DELETE /chats/messages/{id}` · `POST /chats/pin` · `GET /audios` · `POST /audios/toggle` · feed tabs `explore`, `liked`, `liked_reels` · `POST /posts/create` accepts `is_sponsored`, `cta_label`, `cta_url` and a JSON `music` track · `POST /posts/comment` accepts `gif_url` (body optional). Database: run `backend/migrations/v6.sql` after `v5.sql` (adds `messages` to the realtime publication and `replica identity full`).

## API additions (v5)
`PUT /users/me/note` accepts `track` (iTunes track object) and allows song-only notes; `GET /notes` returns `track`. Database: run `backend/migrations/v5.sql` after `v4.sql`.

## API additions (v4)
`GET /posts/{id}` · `GET /posts/{id}/comments` · `POST /posts/comment` · `DELETE /comments/{id}` · `POST /comments/like` · `POST /posts/save` ·
`PUT|DELETE /users/me/note` · `GET /notes` · `POST /chats/react` · `POST /users/notifications/seen` ·
feed tabs `community` and `saved` · `POST /posts/create` accepts type `community` (text, optional image) and `music`.
`GET /users/notifications` → `{items, unread}`. `PUT /users/me/key` accepts `key_backup`.
Database: run `backend/schema.sql`, then `backend/migrations/v4.sql`.

## Honest limitations
- Resolution options are simulated on-device with a canvas from the single stored file: they change sharpness/CPU, **not** bandwidth. Auto-CC uses the microphone (it hears the speakers), is Chrome/Edge/Safari-only and not frame-accurate.
- Photo crop is baked into the upload; video is never cropped (preview Fit/Fill only). Waveform falls back to a synthetic one if the audio host blocks decoding.
- Translate sends the message text to the third-party MyMemory API (after confirmation). Pinned DM messages only update for others on their next chat-list refresh.
- GIF search needs `GIPHY_KEY` in `config.js`; without it only built-in stickers are offered. Sponsored ads are creator-labelled (no payments/targeting).
- Dislike is local only. Message reactions are not encrypted. Channels are plaintext.
- In-memory rate limiter is per serverless instance.

## Frontend files (load order)
`config.js` → `crypto.js` → `api.js` → `core.js` → `views.js` → `watch.js` → `chat.js` → `you.js` → `v6.js` → `app.js`. `v6.js` overrides `App.routes.post/search`, `App.actions.share/create-type/add-story`; keep it after `you.js`.

## Conventions
Modular, commented, no build step. Escape all interpolated text with `App.esc`. Use `data-action` / `data-form` delegation, not inline handlers.

## Status
- v3–v6 implemented (v6 = this session). v6 files were only syntax-checked (`node --check`, `py_compile`); no browser or live run yet.
- v3, v4 and v5 complete. Backend tested with pytest (fake Supabase); frontend exercised in a jsdom end-to-end run (35 checks).
- **Not yet verified against live Supabase/Vercel, live iTunes/CORS, a real Android build, or in real browsers.**
