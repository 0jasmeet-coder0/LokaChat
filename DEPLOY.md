# Deploying LokaChat (Supabase + one Vercel project)

**Current setup:** frontend AND the FastAPI backend deploy together in a single Vercel project (`vercel.json`).
The API lives at `/api/*` on the same domain, so `frontend/config.js` uses `API_URL: "/api"` (no CORS).
Skip section 2 (Koyeb) below - it is only kept as an alternative; the `Dockerfile` is not used by Vercel.

## Vercel (frontend + API) - do this after step 1
1. Push the repo (repo root = `D:\LokaChat`, containing `vercel.json`, `requirements.txt`, `frontend/`, `backend/`) to GitHub.
2. Vercel -> New Project -> import it. **Root Directory: leave as the repo root.** Framework: Other. No build/output settings.
3. **Settings -> Environment Variables** (Production): `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_JWT_SECRET`,
   `OTP_DEV_MODE` (`true` for first test only), and for real email `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`.
4. Put your Supabase URL and anon key in `frontend/config.js` (leave `API_URL: "/api"`), commit, deploy.
5. Check `https://<your-project>.vercel.app/api/health` returns `{"status":"ok"...}`.

Serverless notes: first request after idle is slower; the in-memory rate limiter is per instance (weaker than on a long-running server);
Hobby plan functions time out at ~10 s. Local dev still works: `cd backend && uvicorn main:app --reload` (routes work with or without `/api`).

## 1. Supabase
1. Create a project at supabase.com.
2. **SQL Editor → New query** → paste all of `backend/schema.sql` → **Run** (safe to re-run).
3. **Project Settings → API** — copy:
   - **Project URL** → `SUPABASE_URL`
   - **anon public** key → goes in `frontend/config.js`
   - **service_role** key (secret) → Koyeb env `SUPABASE_SERVICE_KEY`
   - **JWT Settings → (Legacy) JWT Secret** → Koyeb env `SUPABASE_JWT_SECRET`
     (if your project only shows asymmetric signing keys, use the legacy secret / "Legacy JWT Secret" tab)
4. Check **Storage** shows a public bucket `media`, and **Database → Replication** lists `messages`, `posts`, `conversation_members`.

## 2. Koyeb (API)
1. Push the repo to GitHub. Koyeb → **Create Service → GitHub** → pick the repo.
2. Builder: **Dockerfile**, **Work directory: `backend`**. Port 8000 (HTTP). Health check path `/health`.
3. Environment variables (see `backend/.env.example`): `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_JWT_SECRET`,
   `ALLOWED_ORIGINS=*` (or your Vercel URL), and OTP delivery:
   - Quick test: `OTP_DEV_MODE=true` (code is shown on screen — **never leave on in production**)
   - Real email: `OTP_DEV_MODE=false`, `SMTP_HOST`, `SMTP_PORT=587`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` (Gmail: App Password)
   - Optional SMS: `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM`
4. Deploy, then open `https://<your-app>.koyeb.app/health` — expect `{"status":"ok",...}`.

## 3. Frontend config
Edit `frontend/config.js`:
```js
window.LOKA_CONFIG = {
  SUPABASE_URL: "https://xxxx.supabase.co",
  SUPABASE_ANON_KEY: "eyJ...anon...",
  API_URL: "https://<your-app>.koyeb.app",   // no trailing slash
};
```
Never put the service_role key or JWT secret here.

## 4. Vercel
New Project → import repo → **Root Directory: `frontend`**, Framework: Other, no build command, no output directory → Deploy.
Test locally first: `cd frontend && python -m http.server 8080` → http://localhost:8080.

## Checklist
Sign up → enter OTP → home → post a photo → open You → enable 2FA → log out → sign in with authenticator code.
Chat needs two accounts that have each signed in once (that creates their encryption keys).

## Known limits
- New device/browser = new encryption key; older chats stay readable only on the original device.
- Group membership is fixed at creation. Media bucket is public (URLs unguessable, not private).
- Free Koyeb/Supabase tiers may cold-start; first request can be slow. Uploads ≤ 50 MB.
