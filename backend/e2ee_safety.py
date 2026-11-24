"""LokaChat v8 - E2EE key management + community-safety endpoints.

Built by a factory (like social.py) so it never imports main.py; main.py calls
`e2ee_safety.build_router(helpers)` once at the bottom of the file.

Covers:
  * per-device identity keys (`device_keys`) - the PRIVATE key never reaches the server
  * per-conversation key epochs + wrapped keys (`key_wraps`) and rotation (private chats only)
  * opaque, client-sealed key backup
  * group membership changes (add / remove members)
  * blocking, reporting and follow requests (private accounts)

The server only ever stores public keys and opaque wrapped-key blobs - it can never
read message plaintext.

NOTE: GET paths never start with `/users/...` (except nothing here does) because main.py
registers `GET /users/{username}` first; POST/DELETE under `/users/` are collision-free.
"""
from fastapi import APIRouter, Depends, HTTPException

from models import (
    HEX_ID_RE, AddMembersIn, BackupIn, BlockIn, DeviceIn, FollowRequestIn, ReportIn, RotateIn, check_uuid,
)


def build_router(h):
    r = APIRouter()
    me = Depends(h.current_user)

    # ------------------------------------------------------------- helpers
    def uuid_or_404(value: str, what: str = "Not found") -> str:
        try:
            return check_uuid(value)
        except ValueError:
            raise HTTPException(404, what)

    def conv_or_404(value: str) -> dict:
        cid = uuid_or_404(value, "Conversation not found")
        conv = h.first(h.table("conversations").select("*").eq("id", cid))
        if not conv:
            raise HTTPException(404, "Conversation not found")
        return conv

    def member_ids(conversation_id: str) -> list:
        return [m["user_id"] for m in h.rows(h.table("conversation_members").select("user_id").eq("conversation_id", conversation_id))]

    def active_devices(user_ids) -> list:
        ids = list({u for u in user_ids})
        if not ids:
            return []
        return [d for d in h.rows(h.table("device_keys").select("*").in_("user_id", ids)) if not d.get("revoked_at")]

    def mark_needs_rotation(conversation_id: str) -> None:
        h.table("conversations").update({"needs_rotation": True}).eq("id", conversation_id).neq("type", "channel").execute()

    def my_private_conversations(uid: str) -> list:
        return [m["conversation_id"] for m in h.rows(h.table("conversation_members").select("conversation_id").eq("user_id", uid))]

    # ------------------------------------------------------------- devices
    @r.post("/e2ee/devices")
    def register_device(body: DeviceIn, user: dict = me):
        """Announce this device's ECDH public key. A new device id forces a key rotation on next open."""
        existing = h.first(h.table("device_keys").select("*").eq("user_id", user["id"]).eq("device_id", body.device_id))
        if existing and not existing.get("revoked_at"):
            h.table("device_keys").update({"public_key": body.public_key, "label": body.label,
                                           "last_seen_at": h.iso(h.now())}).eq("user_id", user["id"]).eq("device_id", body.device_id).execute()
            fresh = False
        else:
            h.table("device_keys").upsert({
                "user_id": user["id"], "device_id": body.device_id, "public_key": body.public_key, "label": body.label,
                "created_at": h.iso(h.now()), "last_seen_at": h.iso(h.now()), "revoked_at": None,
            }, on_conflict="user_id,device_id").execute()
            h.table("users").update({"public_key": body.public_key}).eq("id", user["id"]).execute()  # keep the legacy single-key column in sync
            fresh = True
        if fresh:
            for cid in my_private_conversations(user["id"]):
                mark_needs_rotation(cid)
        return {"ok": True, "device_id": body.device_id, "new": fresh}

    @r.get("/e2ee/devices")
    def list_devices(user: dict = me):
        rows = [d for d in h.rows(h.table("device_keys").select("*").eq("user_id", user["id"])) if not d.get("revoked_at")]
        return {"devices": [{"device_id": d["device_id"], "public_key": d["public_key"], "label": d.get("label") or "",
                             "created_at": d.get("created_at"), "last_seen_at": d.get("last_seen_at")} for d in rows]}

    @r.delete("/e2ee/devices/{device_id}")
    def revoke_device(device_id: str, user: dict = me):
        if not HEX_ID_RE.match(device_id or ""):
            raise HTTPException(404, "Device not found")
        h.table("device_keys").update({"revoked_at": h.iso(h.now())}).eq("user_id", user["id"]).eq("device_id", device_id).execute()
        h.table("key_wraps").delete().eq("user_id", user["id"]).eq("device_id", device_id).execute()
        for cid in my_private_conversations(user["id"]):
            mark_needs_rotation(cid)   # drop the revoked device from the next epoch
        return {"revoked": True, "device_id": device_id}

    # ------------------------------------------------------------- key backup (opaque)
    @r.get("/e2ee/backup")
    def get_backup(user: dict = me):
        u = h.get_user(user["id"])
        return {"backup": u.get("key_backup"), "updated_at": u.get("key_backup_at")}

    @r.put("/e2ee/backup")
    def put_backup(body: BackupIn, user: dict = me):
        stamp = h.iso(h.now())
        h.table("users").update({"key_backup": body.backup, "key_backup_at": stamp}).eq("id", user["id"]).execute()
        return {"ok": True, "updated_at": stamp}

    # ------------------------------------------------------------- per-chat key bundle
    @r.get("/e2ee/chats/{conversation_id}/keys")
    def chat_keys(conversation_id: str, user: dict = me):
        """Everything a device needs to wrap/unwrap this chat: current epoch, my wraps, and member devices."""
        conv = conv_or_404(conversation_id)
        mem = h.membership(conv["id"], user)
        mids = member_ids(conv["id"])
        people = {u["id"]: u for u in h.rows(h.table("users").select("*").in_("id", mids))} if mids else {}
        roles = {m["user_id"]: m["role"] for m in h.rows(h.table("conversation_members").select("*").eq("conversation_id", conv["id"]))}
        members = []
        for mid in mids:
            u = people.get(mid)
            if not u:
                continue
            members.append({"id": mid, "username": u["username"], "display_name": u["display_name"],
                            "role": roles.get(mid), "avatar_url": h.pub(u).get("avatar_url"),
                            "devices": [{"device_id": d["device_id"], "public_key": d["public_key"], "label": d.get("label") or ""}
                                        for d in active_devices([mid])]})
        my_wraps = [{"epoch": w["epoch"], "device_id": w["device_id"], "eph_pub": w["eph_pub"], "wrapped": w["wrapped"]}
                    for w in h.rows(h.table("key_wraps").select("*").eq("conversation_id", conv["id"]).eq("user_id", user["id"]))]
        return {"conversation_id": conv["id"], "type": conv["type"], "key_epoch": conv.get("key_epoch") or 0,
                "needs_rotation": bool(conv.get("needs_rotation")), "my_role": mem["role"],
                "my_wraps": my_wraps, "members": members}

    # ------------------------------------------------------------- rotation
    @r.post("/e2ee/chats/{conversation_id}/rotate")
    def rotate(conversation_id: str, body: RotateIn, user: dict = me):
        """Start a new key epoch: the caller wrapped the fresh random key for EVERY active member device."""
        conv = conv_or_404(conversation_id)
        if conv["type"] == "channel":
            raise HTTPException(400, "Channels are not end-to-end encrypted")
        h.membership(conv["id"], user)
        cur = conv.get("key_epoch") or 0
        if body.epoch != cur + 1:
            raise HTTPException(409, f"stale_epoch: expected epoch {cur + 1}")
        mids = set(member_ids(conv["id"]))
        active = {(d["user_id"], d["device_id"]): d for d in active_devices(mids)}
        covered = set()
        for w in body.wraps:
            if w.user_id not in mids:
                raise HTTPException(400, "A key wrap targets a non-member")
            if (w.user_id, w.device_id) not in active:
                raise HTTPException(400, "A key wrap targets an unknown device")
            covered.add((w.user_id, w.device_id))
        missing = [k for k in active if k not in covered]
        if missing:
            raise HTTPException(409, "incomplete_wraps: every active member device must receive the new key")
        h.table("key_wraps").delete().eq("conversation_id", conv["id"]).eq("epoch", body.epoch).execute()
        h.table("key_wraps").insert([{
            "conversation_id": conv["id"], "epoch": body.epoch, "user_id": w.user_id, "device_id": w.device_id,
            "eph_pub": w.eph_pub, "wrapped": w.wrapped, "wrapped_by": user["id"],
        } for w in body.wraps]).execute()
        h.table("conversations").update({"key_epoch": body.epoch, "needs_rotation": False}).eq("id", conv["id"]).execute()
        return {"ok": True, "key_epoch": body.epoch}

    # ------------------------------------------------------------- group members
    @r.post("/e2ee/chats/{conversation_id}/members")
    def add_members(conversation_id: str, body: AddMembersIn, user: dict = me):
        conv = conv_or_404(conversation_id)
        if conv["type"] != "group":
            raise HTTPException(400, "Only groups can gain members")
        mem = h.membership(conv["id"], user)
        if mem["role"] not in ("owner", "admin"):
            raise HTTPException(403, "Only group admins can add members")
        names = list({n.strip().lower().lstrip("@") for n in body.usernames})
        people = {u["username"]: u for u in h.rows(h.table("users").select("*").in_("username", names))} if names else {}
        blocked = h.blocked_pairs(user["id"])
        existing = set(member_ids(conv["id"]))
        added = []
        for n in names:
            u = people.get(n)
            if not u or not u["is_verified"] or u["id"] in existing:
                continue
            if u["id"] in blocked:
                raise HTTPException(403, f"You can't add @{n}")
            deny = h.dm_denied(user, u)
            if deny:
                raise HTTPException(403, deny)
            h.table("conversation_members").insert({"conversation_id": conv["id"], "user_id": u["id"], "role": "member",
                                                    "wrapped_by": user["id"], "wrapped_key": "e2ee"}).execute()
            existing.add(u["id"])
            added.append(u["username"])
        if added:
            mark_needs_rotation(conv["id"])   # new members only get the next epoch (no history)
        return {"added": added, "needs_rotation": bool(added)}

    @r.delete("/e2ee/chats/{conversation_id}/members/{user_id}")
    def remove_member(conversation_id: str, user_id: str, user: dict = me):
        conv = conv_or_404(conversation_id)
        mem = h.membership(conv["id"], user)
        target = uuid_or_404(user_id, "User not found")
        if target != user["id"] and mem["role"] not in ("owner", "admin"):
            raise HTTPException(403, "Only group admins can remove members")
        h.table("conversation_members").delete().eq("conversation_id", conv["id"]).eq("user_id", target).execute()
        h.table("key_wraps").delete().eq("conversation_id", conv["id"]).eq("user_id", target).execute()
        mark_needs_rotation(conv["id"])
        return {"removed": True}

    # ------------------------------------------------------------- blocks
    @r.post("/users/block")
    def block(body: BlockIn, user: dict = me):
        target = h.get_user_by_name(body.username)
        if not target or not target["is_verified"]:
            raise HTTPException(404, "User not found")
        if target["id"] == user["id"]:
            raise HTTPException(400, "You cannot block yourself")
        if body.block:
            h.table("blocks").upsert({"blocker_id": user["id"], "blocked_id": target["id"]},
                                     on_conflict="blocker_id,blocked_id").execute()
            h.table("follows").delete().eq("follower_id", user["id"]).eq("following_id", target["id"]).execute()
            h.table("follows").delete().eq("follower_id", target["id"]).eq("following_id", user["id"]).execute()
            h.table("follow_requests").delete().eq("requester_id", user["id"]).eq("target_id", target["id"]).execute()
            h.table("follow_requests").delete().eq("requester_id", target["id"]).eq("target_id", user["id"]).execute()
        else:
            h.table("blocks").delete().eq("blocker_id", user["id"]).eq("blocked_id", target["id"]).execute()
        return {"blocked": body.block, "username": target["username"]}

    @r.get("/blocks")
    def list_blocks(user: dict = me):
        ids = [b["blocked_id"] for b in h.rows(h.table("blocks").select("blocked_id").eq("blocker_id", user["id"]))]
        people = {u["id"]: u for u in h.rows(h.table("users").select("*").in_("id", ids))} if ids else {}
        return {"users": [h.pub(people[i]) for i in ids if i in people]}

    # ------------------------------------------------------------- reports
    @r.post("/users/report")
    def report(body: ReportIn, user: dict = me):
        h.limiter.hit(f"report:{user['id']}", 20, 3600)
        if body.target_type == "user":
            if not h.get_user(uuid_or_404(body.target_id, "User not found")):
                raise HTTPException(404, "User not found")
        elif body.target_type == "post":
            h.viewable_post(uuid_or_404(body.target_id, "Post not found"), user)
        elif body.target_type == "comment":
            if not h.first(h.table("comments").select("*").eq("id", uuid_or_404(body.target_id, "Comment not found"))):
                raise HTTPException(404, "Comment not found")
        else:  # message
            m = h.first(h.table("messages").select("*").eq("id", uuid_or_404(body.target_id, "Message not found")))
            if not m:
                raise HTTPException(404, "Message not found")
            h.membership(m["conversation_id"], user)
        already = h.first(h.table("reports").select("*").eq("reporter_id", user["id"]).eq("target_type", body.target_type)
                          .eq("target_id", body.target_id).eq("status", "open"))
        if not already:
            h.table("reports").insert({"reporter_id": user["id"], "target_type": body.target_type, "target_id": body.target_id,
                                       "reason": body.reason, "details": body.details}).execute()
        return {"reported": True}

    # ------------------------------------------------------------- follow requests (private accounts)
    @r.get("/follow-requests")
    def list_follow_requests(user: dict = me):
        reqs = h.rows(h.table("follow_requests").select("*").eq("target_id", user["id"]).order("created_at", desc=True))
        ids = [x["requester_id"] for x in reqs]
        people = {u["id"]: u for u in h.rows(h.table("users").select("*").in_("id", ids))} if ids else {}
        return {"requests": [{"user": h.pub(people[x["requester_id"]]), "at": x["created_at"]}
                             for x in reqs if x["requester_id"] in people]}

    @r.post("/users/follow-requests/respond")
    def respond_follow_request(body: FollowRequestIn, user: dict = me):
        requester = h.get_user_by_name(body.username)
        if not requester or not requester["is_verified"]:
            raise HTTPException(404, "User not found")
        req = h.first(h.table("follow_requests").select("*").eq("requester_id", requester["id"]).eq("target_id", user["id"]))
        if not req:
            raise HTTPException(404, "No pending request from this user")
        if body.approve:
            h.table("follows").upsert({"follower_id": requester["id"], "following_id": user["id"]},
                                      on_conflict="follower_id,following_id").execute()
        h.table("follow_requests").delete().eq("requester_id", requester["id"]).eq("target_id", user["id"]).execute()
        return {"approved": body.approve, "username": requester["username"]}

    return r
