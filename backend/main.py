"""LokaChat API (FastAPI) - deploy on Koyeb.

Auth, OTP/2FA, follows, posts, chats. Media upload and realtime delivery go
straight from the browser to Supabase Storage / Realtime using the session JWT
issued here (it is signed with the Supabase JWT secret so RLS applies).
Run locally:  uvicorn main:app --reload
"""
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

import auth_2fa as auth
from config import settings
from database import first, public_url, remove_files, rows, table
from models import (
    ChatCreate, FollowIn, KeyIn, KeysIn, LikeIn, LoginIn, PostCreate, ProfileUpdate, ResendIn,
    SendIn, SignupIn, TwoFADisableIn, TwoFAVerifyIn, VerifyOtpIn, ViewIn, check_uuid, contact_kind,
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("lokachat")

app = FastAPI(title="LokaChat API", version="3.0.0")
app.add_middleware(
    CORSMiddleware, allow_origins=settings.ALLOWED_ORIGINS, allow_credentials=False,
    allow_methods=["*"], allow_headers=["*"],
)
bearer = HTTPBearer(auto_error=False)
limiter = auth.limiter


# ================================================================= helpers
def now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def pub(u: Optional[dict], key: bool = False) -> Optional[dict]:
    """Whitelisted public profile - never leaks hashes, secrets or contact info."""
    if not u:
        return None
    d = {"id": u["id"], "username": u["username"], "display_name": u["display_name"],
         "bio": u.get("bio") or "", "avatar_url": public_url(u.get("avatar_path"))}
    if key:
        d["public_key"] = u.get("public_key")
    return d


def count(query_rows: list) -> int:
    return len(query_rows)


def me_shape(u: dict) -> dict:
    uid = u["id"]
    d = pub(u, key=True)
    d.update({
        "contact": auth.mask_contact(u.get("email") or u.get("phone") or ""),
        "totp_enabled": bool(u.get("totp_enabled")),
        "followers": count(rows(table("follows").select("follower_id").eq("following_id", uid))),
        "following": count(rows(table("follows").select("following_id").eq("follower_id", uid))),
        "posts": count(rows(table("posts").select("id").eq("author_id", uid))),
        "created_at": u.get("created_at"),
    })
    return d


def find_user(identifier: str) -> Optional[dict]:
    ident = identifier.strip().lower().lstrip("@")
    for col in ("username", "email"):
        u = first(table("users").select("*").eq(col, ident))
        if u:
            return u
    phone = re.sub(r"[\s\-()]", "", identifier.strip())
    return first(table("users").select("*").eq("phone", phone)) if phone else None


def get_user(user_id: str) -> Optional[dict]:
    return first(table("users").select("*").eq("id", user_id))


def get_user_by_name(username: str) -> Optional[dict]:
    return first(table("users").select("*").eq("username", username.strip().lower().lstrip("@")))


def current_user(creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer)) -> dict:
    if not creds:
        raise HTTPException(401, "Not authenticated")
    claims = auth.decode_token(creds.credentials, "session")
    user = get_user(claims["sub"])
    if not user or not user.get("is_verified"):
        raise HTTPException(401, "Account not found")
    return user


def session_for(user: dict) -> dict:
    return {"token": auth.create_session_token(user), "expires_in": settings.SESSION_TTL_HOURS * 3600, "user": me_shape(user)}


def send_otp_to(user: dict, purpose: str, bg: BackgroundTasks) -> dict:
    code = auth.issue_otp(user["id"], purpose)
    contact = user.get("email") or user.get("phone")
    bg.add_task(auth.deliver_otp, contact, code, purpose)
    out = {"destination": auth.mask_contact(contact), "channel": auth.delivery_channel(contact),
           "expires_in": settings.OTP_TTL_MINUTES * 60}
    if settings.OTP_DEV_MODE:
        out["dev_otp"] = code  # DEV ONLY - disable OTP_DEV_MODE in production
    return out


def following_ids(uid: str) -> list:
    return [r["following_id"] for r in rows(table("follows").select("following_id").eq("follower_id", uid))]


def valid_path(path: Optional[str], user: dict) -> Optional[str]:
    """Storage paths must live inside the caller's own folder: <user_id>/..."""
    if path is None:
        return None
    if not path.startswith(f"{user['id']}/") or ".." in path or "//" in path or path.endswith("/"):
        raise HTTPException(400, "Invalid media path")
    return path


# ================================================================== health
@app.get("/")
@app.get("/health")
def health():
    return {"status": "ok", "service": "lokachat-api", "version": app.version}


# ============================================================== auth: sign up
@app.post("/auth/signup")
def signup(body: SignupIn, request: Request, bg: BackgroundTasks):
    limiter.hit(f"signup:{client_ip(request)}", 10, 3600)
    kind = contact_kind(body.contact)
    col = "email" if kind == "email" else "phone"
    by_name = first(table("users").select("*").eq("username", body.username))
    by_contact = first(table("users").select("*").eq(col, body.contact))
    if by_name and by_name["is_verified"]:
        raise HTTPException(409, "That username is taken")
    if by_contact and by_contact["is_verified"]:
        raise HTTPException(409, f"That {kind} is already registered")

    fields = {"username": body.username, "display_name": body.display_name, "email": None, "phone": None,
              "password_hash": auth.hash_password(body.password), "is_verified": False}
    fields[col] = body.contact
    stale = by_name or by_contact  # an unverified earlier attempt may be re-used
    if by_name and by_contact and by_name["id"] != by_contact["id"]:
        table("users").delete().eq("id", by_contact["id"]).execute()
    if stale:
        table("users").update(fields).eq("id", stale["id"]).execute()
        user = {**stale, **fields}
    else:
        user = rows(table("users").insert(fields))[0]
    return {"user_id": user["id"], "username": user["username"], **send_otp_to(user, "signup", bg)}


@app.post("/auth/resend-otp")
def resend_otp(body: ResendIn, request: Request, bg: BackgroundTasks):
    limiter.hit(f"resend:{client_ip(request)}", 10, 600)
    if body.mfa_token:
        claims = auth.decode_token(body.mfa_token, "mfa")
        user, purpose = get_user(claims["sub"]), "login"
        if claims.get("kind") != "otp":
            raise HTTPException(400, "This sign-in uses an authenticator app")
    elif body.identifier:
        user, purpose = find_user(body.identifier), "signup"
        if user and user["is_verified"]:
            user = None
    else:
        raise HTTPException(422, "identifier or mfa_token is required")
    if user:  # identical response either way, so accounts cannot be enumerated
        limiter.hit(f"resend-user:{user['id']}", 5, 600)
        return send_otp_to(user, purpose, bg)
    return {"destination": "", "channel": "dev", "expires_in": settings.OTP_TTL_MINUTES * 60}


@app.post("/auth/verify-otp")
def verify_otp(body: VerifyOtpIn, request: Request):
    limiter.hit(f"otp:{client_ip(request)}", 30, 600)
    if body.mfa_token:                                   # sign-in step 2 (email/SMS OTP)
        claims = auth.decode_token(body.mfa_token, "mfa")
        if claims.get("kind") != "otp":
            raise HTTPException(400, "This sign-in needs your authenticator code")
        user, purpose = get_user(claims["sub"]), "login"
    elif body.identifier:                                # sign-up verification
        user, purpose = find_user(body.identifier), "signup"
        if user and user["is_verified"]:
            user = None
    else:
        raise HTTPException(422, "identifier or mfa_token is required")
    if not user or not auth.check_otp(user["id"], purpose, body.code):
        raise HTTPException(400, "Invalid or expired code")
    if purpose == "signup":
        table("users").update({"is_verified": True}).eq("id", user["id"]).execute()
        user["is_verified"] = True
    return session_for(user)


# ================================================================ auth: login
@app.post("/auth/login")
def login(body: LoginIn, request: Request, bg: BackgroundTasks):
    limiter.hit(f"login:{client_ip(request)}", 30, 600)
    limiter.hit(f"login-id:{body.identifier.lower()}", 8, 600)
    user = find_user(body.identifier)
    ok = auth.verify_password(body.password, user["password_hash"] if user else None)
    if not user or not ok:
        raise HTTPException(401, "Incorrect username or password")
    if not user["is_verified"]:
        return {"step": "verify_signup", "identifier": user["username"], **send_otp_to(user, "signup", bg)}
    if user.get("totp_enabled"):
        return {"step": "totp", "mfa_token": auth.create_mfa_token(user, "totp")}
    return {"step": "otp", "mfa_token": auth.create_mfa_token(user, "otp"), **send_otp_to(user, "login", bg)}


@app.get("/auth/me")
def me(user: dict = Depends(current_user)):
    return me_shape(user)


# ================================================================ auth: 2FA
@app.post("/auth/2fa/setup")
def twofa_setup(user: dict = Depends(current_user)):
    if user.get("totp_enabled"):
        raise HTTPException(409, "2FA is already enabled")
    secret = auth.new_totp_secret()
    table("users").update({"totp_pending_secret": auth.encrypt_secret(secret)}).eq("id", user["id"]).execute()
    return {"secret": secret, "otpauth_uri": auth.totp_uri(secret, user["username"])}


@app.post("/auth/2fa/verify")
def twofa_verify(body: TwoFAVerifyIn, request: Request, creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer)):
    """With mfa_token: finish sign-in. With a session token: confirm and enable 2FA."""
    limiter.hit(f"2fa:{client_ip(request)}", 30, 600)
    if body.mfa_token:
        claims = auth.decode_token(body.mfa_token, "mfa")
        if claims.get("kind") != "totp":
            raise HTTPException(400, "This sign-in uses an email/SMS code")
        user = get_user(claims["sub"])
        if not user or not user.get("totp_enabled") or not user.get("totp_secret"):
            raise HTTPException(400, "2FA is not enabled")
        limiter.hit(f"2fa-user:{user['id']}", 10, 600)
        step = auth.verify_totp(auth.decrypt_secret(user["totp_secret"]), body.code, user.get("totp_last_step") or 0)
        if step is None:
            raise HTTPException(400, "Invalid or expired code")
        table("users").update({"totp_last_step": step}).eq("id", user["id"]).execute()
        return session_for(user)
    user = current_user(creds)
    if not user.get("totp_pending_secret"):
        raise HTTPException(400, "Start 2FA setup first")
    limiter.hit(f"2fa-user:{user['id']}", 10, 600)
    secret = auth.decrypt_secret(user["totp_pending_secret"])
    step = auth.verify_totp(secret, body.code)
    if step is None:
        raise HTTPException(400, "Invalid code - check your authenticator app and try again")
    table("users").update({"totp_secret": user["totp_pending_secret"], "totp_pending_secret": None,
                           "totp_enabled": True, "totp_last_step": step}).eq("id", user["id"]).execute()
    return {"enabled": True}


@app.post("/auth/2fa/disable")
def twofa_disable(body: TwoFADisableIn, user: dict = Depends(current_user)):
    if not user.get("totp_enabled"):
        raise HTTPException(400, "2FA is not enabled")
    limiter.hit(f"2fa-user:{user['id']}", 10, 600)
    if not auth.verify_password(body.password, user["password_hash"]):
        raise HTTPException(401, "Incorrect password")
    if auth.verify_totp(auth.decrypt_secret(user["totp_secret"]), body.code, user.get("totp_last_step") or 0) is None:
        raise HTTPException(400, "Invalid or expired code")
    table("users").update({"totp_enabled": False, "totp_secret": None, "totp_pending_secret": None}).eq("id", user["id"]).execute()
    return {"enabled": False}


# ================================================================== users
@app.patch("/users/me")
def update_me(body: ProfileUpdate, user: dict = Depends(current_user)):
    changes = body.model_dump(exclude_none=True)
    if "avatar_path" in changes:
        changes["avatar_path"] = valid_path(changes["avatar_path"], user)
    if changes:
        table("users").update(changes).eq("id", user["id"]).execute()
        user = {**user, **changes}
    return me_shape(user)


@app.put("/users/me/key")
def set_public_key(body: KeyIn, user: dict = Depends(current_user)):
    """Store the user's ECDH public key (JWK) used by other members to wrap chat keys."""
    table("users").update({"public_key": body.public_key}).eq("id", user["id"]).execute()
    return {"ok": True}


@app.post("/users/keys")
def user_keys(body: KeysIn, user: dict = Depends(current_user)):
    names = list({n.strip().lower().lstrip("@") for n in body.usernames})
    found = rows(table("users").select("*").in_("username", names))
    return {"users": [pub(u, key=True) for u in found if u["is_verified"]]}


@app.get("/users/search")
def search_users(q: str = Query("", max_length=40), user: dict = Depends(current_user)):
    q = re.sub(r"[%,]", "", q.strip())
    if len(q) < 2:
        return {"users": []}
    found = {}
    for col in ("username", "display_name"):
        for u in rows(table("users").select("*").ilike(col, f"%{q}%").limit(15)):
            if u["is_verified"]:
                found[u["id"]] = u
    followed = set(following_ids(user["id"]))
    return {"users": [{**pub(u), "is_following": u["id"] in followed, "is_me": u["id"] == user["id"]} for u in found.values()][:15]}


@app.get("/users/following")
def list_following(user: dict = Depends(current_user)):
    ids = following_ids(user["id"])
    return {"users": [pub(u) for u in rows(table("users").select("*").in_("id", ids))] if ids else []}


@app.get("/users/notifications")
def notifications(user: dict = Depends(current_user)):
    items = []
    fol = rows(table("follows").select("*").eq("following_id", user["id"]).order("created_at", desc=True).limit(20))
    ids = list({f["follower_id"] for f in fol})
    people = {u["id"]: u for u in rows(table("users").select("*").in_("id", ids))} if ids else {}
    items += [{"type": "follow", "user": pub(people.get(f["follower_id"])), "at": f["created_at"]} for f in fol if f["follower_id"] in people]
    followed = following_ids(user["id"])
    if followed:
        posts = rows(table("posts").select("*").in_("author_id", followed).in_("type", ["video", "photo", "clip"])
                     .order("created_at", desc=True).limit(20))
        authors = {u["id"]: u for u in rows(table("users").select("*").in_("id", list({p["author_id"] for p in posts})))} if posts else {}
        items += [{"type": "post", "user": pub(authors.get(p["author_id"])), "at": p["created_at"],
                   "post": {"id": p["id"], "title": p["title"], "type": p["type"], "poster_url": public_url(p.get("poster_path"))}}
                  for p in posts if p["author_id"] in authors]
    items.sort(key=lambda i: i["at"], reverse=True)
    return {"items": items[:30]}


@app.get("/users/{username}")
def user_profile(username: str, user: dict = Depends(current_user)):
    target = get_user_by_name(username)
    if not target or not target["is_verified"]:
        raise HTTPException(404, "User not found")
    tid = target["id"]
    return {**pub(target),
            "followers": count(rows(table("follows").select("follower_id").eq("following_id", tid))),
            "following": count(rows(table("follows").select("following_id").eq("follower_id", tid))),
            "is_following": first(table("follows").select("*").eq("follower_id", user["id"]).eq("following_id", tid)) is not None,
            "is_me": tid == user["id"]}


@app.post("/users/follow")
def follow(body: FollowIn, user: dict = Depends(current_user)):
    target = get_user_by_name(body.username)
    if not target or not target["is_verified"]:
        raise HTTPException(404, "User not found")
    if target["id"] == user["id"]:
        raise HTTPException(400, "You cannot follow yourself")
    if body.follow:
        table("follows").upsert({"follower_id": user["id"], "following_id": target["id"]}, on_conflict="follower_id,following_id").execute()
    else:
        table("follows").delete().eq("follower_id", user["id"]).eq("following_id", target["id"]).execute()
    return {"following": body.follow,
            "followers": count(rows(table("follows").select("follower_id").eq("following_id", target["id"])))}


# ================================================================== posts
def parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def is_live(post: dict) -> bool:
    return not post.get("expires_at") or parse_ts(post["expires_at"]) > now()


def can_view(post: dict, user: dict, followed: set) -> bool:
    if post["author_id"] == user["id"]:
        return True
    if not is_live(post):
        return False
    return post["visibility"] == "public" or post["author_id"] in followed


def shape_posts(posts: list, user: dict) -> list:
    if not posts:
        return []
    authors = {u["id"]: u for u in rows(table("users").select("*").in_("id", list({p["author_id"] for p in posts})))}
    liked = {r["post_id"] for r in rows(table("post_likes").select("post_id").eq("user_id", user["id"]).in_("post_id", [p["id"] for p in posts]))}
    return [{
        "id": p["id"], "type": p["type"], "title": p["title"], "caption": p.get("caption") or "",
        "visibility": p["visibility"], "mime": p["mime"], "duration": p.get("duration") or 0,
        "media_url": public_url(p["media_path"]), "poster_url": public_url(p.get("poster_path")),
        "views": p.get("views") or 0, "likes": p.get("likes") or 0, "liked": p["id"] in liked,
        "created_at": p["created_at"], "expires_at": p.get("expires_at"), "author": pub(authors.get(p["author_id"])),
    } for p in posts]


@app.post("/posts/create")
def create_post(body: PostCreate, user: dict = Depends(current_user)):
    media = valid_path(body.media_path, user)
    poster = valid_path(body.poster_path, user)
    video, image = body.mime.startswith("video/"), body.mime.startswith("image/")
    if body.type in ("video", "clip") and not video:
        raise HTTPException(400, "A video file is required")
    if body.type == "photo" and not image:
        raise HTTPException(400, "An image file is required")
    if body.type == "story" and not (video or image):
        raise HTTPException(400, "Stories must be a photo or video")
    if body.type != "story" and not body.title.strip():
        raise HTTPException(422, "A title is required")
    row = {
        "author_id": user["id"], "type": body.type, "title": body.title.strip(), "caption": body.caption.strip(),
        "visibility": "followers" if body.type == "story" else "public" if body.type == "clip" else body.visibility,
        "media_path": media, "poster_path": poster, "mime": body.mime, "duration": body.duration, "size": body.size,
        "expires_at": iso(now() + timedelta(hours=24)) if body.type == "story" else None,
    }
    created = rows(table("posts").insert(row))[0]
    return shape_posts([created], user)[0]


@app.get("/posts/feed")
def feed(tab: Literal["recommended", "following", "clips", "stories", "mine", "user"] = "recommended",
         q: str = Query("", max_length=60), username: str = Query("", max_length=40),
         before: Optional[str] = None, limit: int = Query(30, ge=1, le=60), user: dict = Depends(current_user)):
    uid, followed = user["id"], following_ids(user["id"])

    def base():
        qb = table("posts").select("*")
        if before:
            qb = qb.lt("created_at", before)
        if q.strip():
            qb = qb.ilike("title", f"%{re.sub('[%,]', '', q.strip())}%")
        return qb

    found: list = []
    if tab == "recommended":
        found = rows(base().eq("visibility", "public").in_("type", ["video", "photo"]).order("created_at", desc=True).limit(limit))
    elif tab == "clips":
        found = rows(base().eq("visibility", "public").eq("type", "clip").order("created_at", desc=True).limit(limit))
    elif tab == "following":
        if followed:
            found += rows(base().in_("author_id", followed).in_("type", ["video", "photo", "clip"]).order("created_at", desc=True).limit(limit))
        found += rows(base().eq("author_id", uid).eq("visibility", "followers").in_("type", ["video", "photo", "clip"]).order("created_at", desc=True).limit(limit))
    elif tab == "stories":
        found = rows(base().in_("author_id", followed + [uid]).eq("type", "story").gt("expires_at", iso(now())).order("created_at", desc=True).limit(100))
    elif tab == "mine":
        found = [p for p in rows(base().eq("author_id", uid).order("created_at", desc=True).limit(limit)) if is_live(p)]
    elif tab == "user":
        target = get_user_by_name(username)
        if not target:
            raise HTTPException(404, "User not found")
        found = [p for p in rows(base().eq("author_id", target["id"]).neq("type", "story").order("created_at", desc=True).limit(limit))
                 if can_view(p, user, set(followed))]
    found.sort(key=lambda p: p["created_at"], reverse=True)
    return {"posts": shape_posts(found[:limit], user)}


def viewable_post(post_id: str, user: dict) -> dict:
    post = first(table("posts").select("*").eq("id", post_id))
    if not post or not can_view(post, user, set(following_ids(user["id"]))):
        raise HTTPException(404, "Post not found")
    return post


@app.post("/posts/like")
def like(body: LikeIn, user: dict = Depends(current_user)):
    post = viewable_post(body.post_id, user)
    existing = first(table("post_likes").select("*").eq("post_id", post["id"]).eq("user_id", user["id"]))
    if existing:
        table("post_likes").delete().eq("post_id", post["id"]).eq("user_id", user["id"]).execute()
    else:
        table("post_likes").insert({"post_id": post["id"], "user_id": user["id"]}).execute()
    total = max(0, (post.get("likes") or 0) + (-1 if existing else 1))
    table("posts").update({"likes": total}).eq("id", post["id"]).execute()
    return {"liked": not existing, "likes": total}


@app.post("/posts/view")
def view(body: ViewIn, user: dict = Depends(current_user)):
    """Log a watch (and resume position) into watch_history; optionally count a view."""
    post = viewable_post(body.post_id, user)
    table("watch_history").upsert({
        "user_id": user["id"], "post_id": post["id"], "watched_at": iso(now()),
        "position": body.position, "duration": body.duration or post.get("duration") or 0,
    }, on_conflict="user_id,post_id").execute()
    views = post.get("views") or 0
    if body.count:
        views += 1
        table("posts").update({"views": views}).eq("id", post["id"]).execute()
    return {"views": views}


@app.get("/history")
def history(user: dict = Depends(current_user)):
    h = rows(table("watch_history").select("*").eq("user_id", user["id"]).order("watched_at", desc=True).limit(60))
    if not h:
        return {"items": []}
    followed = set(following_ids(user["id"]))
    posts = {p["id"]: p for p in rows(table("posts").select("*").in_("id", [x["post_id"] for x in h]))}
    visible = [posts[x["post_id"]] for x in h if x["post_id"] in posts and can_view(posts[x["post_id"]], user, followed)]
    shaped = {p["id"]: p for p in shape_posts(visible, user)}
    return {"items": [{"post": shaped[x["post_id"]], "position": x["position"], "duration": x["duration"], "watched_at": x["watched_at"]}
                      for x in h if x["post_id"] in shaped]}


@app.delete("/posts/{post_id}")
def delete_post(post_id: str, user: dict = Depends(current_user)):
    post = first(table("posts").select("*").eq("id", check_uuid(post_id)))
    if not post or post["author_id"] != user["id"]:
        raise HTTPException(404, "Post not found")
    table("posts").delete().eq("id", post["id"]).execute()
    remove_files([post.get("media_path"), post.get("poster_path")])
    return {"deleted": True}


# ================================================================== chats
def shape_message(m: dict) -> dict:
    return {"id": m["id"], "conversation_id": m["conversation_id"], "sender_id": m["sender_id"],
            "ciphertext": m["ciphertext"], "iv": m.get("iv") or "", "encrypted": bool(m.get("encrypted", True)),
            "created_at": m["created_at"]}


def membership(conv_id: str, user: dict) -> dict:
    mem = first(table("conversation_members").select("*").eq("conversation_id", conv_id).eq("user_id", user["id"]))
    if not mem:
        raise HTTPException(403, "You are not a member of this conversation")
    return mem


@app.get("/chats")
def list_chats(user: dict = Depends(current_user)):
    mine = rows(table("conversation_members").select("*").eq("user_id", user["id"]))
    if not mine:
        return {"chats": []}
    ids = [m["conversation_id"] for m in mine]
    convs = {c["id"]: c for c in rows(table("conversations").select("*").in_("id", ids))}
    members = rows(table("conversation_members").select("*").in_("conversation_id", ids))
    uids = list({m["user_id"] for m in members} | {m["wrapped_by"] for m in mine if m.get("wrapped_by")})
    people = {u["id"]: u for u in rows(table("users").select("*").in_("id", uids))}
    out = []
    for m in mine:
        c = convs.get(m["conversation_id"])
        if not c:
            continue
        cm = [x for x in members if x["conversation_id"] == c["id"]]
        shown = [x for x in cm if c["type"] != "channel" or x["role"] == "owner"]
        last = first(table("messages").select("*").eq("conversation_id", c["id"]).order("created_at", desc=True))
        out.append({
            "id": c["id"], "type": c["type"], "title": c.get("title") or "", "description": c.get("description") or "",
            "created_at": c["created_at"], "last_message_at": c.get("last_message_at") or c["created_at"],
            "my_role": m["role"], "wrapped_key": m.get("wrapped_key"),
            "wrapped_by": pub(people.get(m.get("wrapped_by")), key=True), "member_count": len(cm),
            "members": [{**pub(people[x["user_id"]], key=True), "role": x["role"]} for x in shown if x["user_id"] in people],
            "last_message": shape_message(last) if last else None,
        })
    out.sort(key=lambda c: c["last_message_at"], reverse=True)
    return {"chats": out}


@app.post("/chats/create")
def create_chat(body: ChatCreate, user: dict = Depends(current_user)):
    me_id, names = user["id"], []
    for m in body.members:
        n = m.username.strip().lower().lstrip("@")
        if n != user["username"] and n not in names:
            names.append(n)
    if body.type == "channel":
        if not body.title.strip():
            raise HTTPException(422, "A channel name is required")
        names = []
    elif not names:
        raise HTTPException(422, "Add at least one other member")
    if body.type == "direct" and len(names) != 1:
        raise HTTPException(422, "A direct chat has exactly one other person")
    if body.type == "group" and not body.title.strip():
        raise HTTPException(422, "A group name is required")

    people = {u["username"]: u for u in rows(table("users").select("*").in_("username", names))} if names else {}
    missing = [n for n in names if n not in people or not people[n]["is_verified"]]
    if missing:
        raise HTTPException(404, "User not found: " + ", ".join(missing))

    direct_key = None
    if body.type == "direct":
        direct_key = "|".join(sorted([me_id, people[names[0]]["id"]]))
        existing = first(table("conversations").select("*").eq("direct_key", direct_key))
        if existing:
            return {"id": existing["id"], "existing": True}

    keys = {m.username.strip().lower().lstrip("@"): m.wrapped_key for m in body.members}
    if body.type != "channel":
        if not body.my_wrapped_key or any(not keys.get(n) for n in names):
            raise HTTPException(422, "Missing encrypted chat keys for one or more members")
    conv = rows(table("conversations").insert({
        "type": body.type, "title": body.title.strip(), "description": body.description.strip(),
        "creator_id": me_id, "direct_key": direct_key,
    }))[0]
    base = {"conversation_id": conv["id"], "wrapped_by": me_id}
    table("conversation_members").insert({**base, "user_id": me_id, "role": "owner", "wrapped_key": body.my_wrapped_key}).execute()
    for n in names:
        table("conversation_members").insert({**base, "user_id": people[n]["id"], "role": "member", "wrapped_key": keys[n]}).execute()
    return {"id": conv["id"], "existing": False}


@app.get("/chats/{conversation_id}/messages")
def chat_messages(conversation_id: str, before: Optional[str] = None, limit: int = Query(100, ge=1, le=200), user: dict = Depends(current_user)):
    cid = check_uuid(conversation_id)
    membership(cid, user)
    qb = table("messages").select("*").eq("conversation_id", cid)
    if before:
        qb = qb.lt("created_at", before)
    msgs = rows(qb.order("created_at", desc=True).limit(limit))
    return {"messages": [shape_message(m) for m in reversed(msgs)]}


@app.post("/chats/send")
def send_message(body: SendIn, request: Request, user: dict = Depends(current_user)):
    limiter.hit(f"send:{user['id']}", 60, 60)
    mem = membership(body.conversation_id, user)
    conv = first(table("conversations").select("*").eq("id", body.conversation_id))
    if not conv:
        raise HTTPException(404, "Conversation not found")
    if conv["type"] == "channel":
        if mem["role"] not in ("owner", "admin"):
            raise HTTPException(403, "Only channel admins can post")
        encrypted, iv = False, ""  # channels are public broadcasts (plaintext)
    else:
        if not body.iv:
            raise HTTPException(422, "Messages in chats must be end-to-end encrypted")
        encrypted, iv = True, body.iv
    msg = rows(table("messages").insert({
        "conversation_id": conv["id"], "sender_id": user["id"], "ciphertext": body.ciphertext, "iv": iv, "encrypted": encrypted,
    }))[0]
    table("conversations").update({"last_message_at": msg["created_at"]}).eq("id", conv["id"]).execute()
    return shape_message(msg)


@app.post("/chats/{conversation_id}/join")
def join_channel(conversation_id: str, user: dict = Depends(current_user)):
    cid = check_uuid(conversation_id)
    conv = first(table("conversations").select("*").eq("id", cid))
    if not conv or conv["type"] != "channel":
        raise HTTPException(404, "Channel not found")
    table("conversation_members").upsert({"conversation_id": cid, "user_id": user["id"], "role": "subscriber"},
                                         on_conflict="conversation_id,user_id").execute()
    return {"joined": True}


@app.delete("/chats/{conversation_id}")
def leave_chat(conversation_id: str, user: dict = Depends(current_user)):
    """Leave a conversation. When the last member leaves, it is deleted with its messages."""
    cid = check_uuid(conversation_id)
    membership(cid, user)
    table("conversation_members").delete().eq("conversation_id", cid).eq("user_id", user["id"]).execute()
    if not rows(table("conversation_members").select("user_id").eq("conversation_id", cid).limit(1)):
        table("conversations").delete().eq("id", cid).execute()
    return {"left": True}


@app.get("/channels/discover")
def discover_channels(q: str = Query("", max_length=40), user: dict = Depends(current_user)):
    qb = table("conversations").select("*").eq("type", "channel")
    q = re.sub(r"[%,]", "", q.strip())
    if q:
        qb = qb.ilike("title", f"%{q}%")
    found = rows(qb.order("created_at", desc=True).limit(30))
    mine = {m["conversation_id"] for m in rows(table("conversation_members").select("*").eq("user_id", user["id"]))}
    owners = {u["id"]: u for u in rows(table("users").select("*").in_("id", list({c["creator_id"] for c in found if c.get("creator_id")})))} if found else {}
    return {"channels": [{"id": c["id"], "title": c["title"], "description": c.get("description") or "",
                          "owner": pub(owners.get(c["creator_id"])), "joined": c["id"] in mine} for c in found]}
