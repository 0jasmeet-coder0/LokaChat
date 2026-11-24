# V8 Progress (resume with: "continue from V8_PROGRESS.md")

Rule: after each file is finished, mark it `[x] DONE` and note the next file.

## Phase 1 — Backend security / E2EE / auth
- [x] 1.1 `frontend/crypto.js` — WebCrypto ECDH P-256 + HKDF + AES-256-GCM, per-device identity keys, encrypted key backup, group key rotation
- [x] 1.2 `backend/main.py` — device keys / wrapped keys / rotation endpoints (private chats only)
- [x] 1.3 `frontend/chat.js` — use new E2EE for private 1:1, groups, attachments
- [x] 1.4 `frontend/auth.js` — fix Google OAuth callback (?code= PKCE / #access_token=)
- [x] 1.5 `backend/main.py` — SMTP error detail on /api/auth/signup when OTP_DEV_MODE=false
- [x] 1.6 `backend/migrations/v8.sql` — device keys, key wraps, account privacy, blocks, reports, message/comment controls, RLS
- [x] 1.7 `backend/main.py` + `backend/models.py` — privacy / block / report / who-can-message / who-can-comment authorization
- [x] 1.8 `frontend/` UI for privacy, block, report, controls (you.js / views.js)

## Phase 2 — Header, bottom nav, scroll
- [x] 2.1 `frontend/index.html` — header/bottom-nav markup (Home | Search | Chats | You)
- [x] 2.2 `frontend/style.css` — per-page header rules, hide-on-scroll, hidden on Reels/chat
- [x] 2.3 `frontend/app.js` — route-based header, hide-on-scroll for Home/Search/Messages/Me

## Phase 3 — Screens
- [x] 3.1 `frontend/chat.js` + `style.css` — locked 100dvh mobile chat
- [x] 3.2 `frontend/v6.js` — Music Note window (auto-fit, auto-play, trimmer, vertical text buttons)
- [x] 3.3 `frontend/you.js` — Me page: Log out only in Settings, action row (Edit / Share / + contact)
- [x] 3.4 `frontend/watch.js` — player ⚙️ settings, swipe up fullscreen / down miniplayer, grey description + comments boxes, send-arrow, Auto-CC
- [x] 3.5 `frontend/watch.js` + `v6.js` — full-height Reels, swipe L→Home / R→Search
- [x] 3.6 `frontend/v6.js` — Search page: Reels-only 9:16 grid

## Phase 4 — Wrap-up
- [x] 4.1 `frontend/service-worker.js` VERSION -> `lokachat-shell-v8`
- [x] 4.2 `CLAUDE.md` — v8 section + E2EE boundaries

## Notes
- Tooling in this session: file read/write/edit + `node --check` (node v24) available; **Python is NOT installed**, so `backend/` was reviewed by reading, not compiled.
- All `frontend/*.js` pass `node --check`.
- Next file: (none — v8 complete)
