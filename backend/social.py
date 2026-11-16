"""LokaChat social endpoints: single post, comments (+likes), saved posts, notes, message reactions.

Built by a factory so it needs no import of main.py (avoids circular imports on any runtime):
main.py calls `social.build_router(helpers)` once at the bottom of the file.
"""
import json
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException

from models import CommentIn, CommentLikeIn, NoteIn, ReactIn, SaveIn, check_uuid


def vid(value: str) -> str:
    try:
        return check_uuid(value)
    except ValueError:
        raise HTTPException(404, "Not found")


def build_router(h):
    r = APIRouter()
    me = Depends(h.current_user)

    def count_rows(tbl: str, col: str, val: str) -> int:
        return len(h.rows(h.table(tbl).select(col).eq(col, val)))

    # ------------------------------------------------------------ single post
    @r.get("/posts/{post_id}")
    def get_post(post_id: str, user: dict = me):
        return h.shape_posts([h.viewable_post(vid(post_id), user)], user)[0]

    # --------------------------------------------------------------- comments
    def shape_comments(cs: list, user: dict) -> list:
        if not cs:
            return []
        authors = {u["id"]: u for u in h.rows(h.table("users").select("*").in_("id", list({c["author_id"] for c in cs})))}
        liked = {x["comment_id"] for x in h.rows(h.table("comment_likes").select("comment_id").eq("user_id", user["id"])
                                                 .in_("comment_id", [c["id"] for c in cs]))}
        return [{"id": c["id"], "post_id": c["post_id"], "parent_id": c.get("parent_id"), "body": c["body"],
                 "likes": c.get("likes") or 0, "liked": c["id"] in liked, "created_at": c["created_at"],
                 "author": h.pub(authors.get(c["author_id"]))} for c in cs]

    @r.get("/posts/{post_id}/comments")
    def list_comments(post_id: str, user: dict = me):
        post = h.viewable_post(vid(post_id), user)
        cs = h.rows(h.table("comments").select("*").eq("post_id", post["id"]).order("created_at", desc=True).limit(300))
        return {"comments": shape_comments(cs, user)}

    @r.post("/posts/comment")
    def add_comment(body: CommentIn, user: dict = me):
        h.limiter.hit(f"comment:{user['id']}", 30, 60)
        post = h.viewable_post(body.post_id, user)
        parent_id = body.parent_id
        if parent_id:
            parent = h.first(h.table("comments").select("*").eq("id", parent_id).eq("post_id", post["id"]))
            if not parent:
                raise HTTPException(404, "Comment not found")
            parent_id = parent.get("parent_id") or parent["id"]  # one level of replies, like YouTube
        c = h.rows(h.table("comments").insert({"post_id": post["id"], "author_id": user["id"], "parent_id": parent_id, "body": body.body.strip()}))[0]
        total = count_rows("comments", "post_id", post["id"])
        h.table("posts").update({"comments": total}).eq("id", post["id"]).execute()
        return {"comment": shape_comments([c], user)[0], "comments": total}

    @r.delete("/comments/{comment_id}")
    def delete_comment(comment_id: str, user: dict = me):
        c = h.first(h.table("comments").select("*").eq("id", vid(comment_id)))
        if not c:
            raise HTTPException(404, "Comment not found")
        post = h.first(h.table("posts").select("*").eq("id", c["post_id"]))
        if user["id"] not in (c["author_id"], post and post["author_id"]):
            raise HTTPException(403, "You can't delete this comment")
        h.table("comments").delete().eq("id", c["id"]).execute()
        h.table("comments").delete().eq("parent_id", c["id"]).execute()  # replies (also cascaded in SQL)
        total = count_rows("comments", "post_id", c["post_id"])
        h.table("posts").update({"comments": total}).eq("id", c["post_id"]).execute()
        return {"deleted": True, "comments": total}

    @r.post("/comments/like")
    def like_comment(body: CommentLikeIn, user: dict = me):
        c = h.first(h.table("comments").select("*").eq("id", body.comment_id))
        if not c:
            raise HTTPException(404, "Comment not found")
        h.viewable_post(c["post_id"], user)
        had = h.first(h.table("comment_likes").select("*").eq("comment_id", c["id"]).eq("user_id", user["id"]))
        if had:
            h.table("comment_likes").delete().eq("comment_id", c["id"]).eq("user_id", user["id"]).execute()
        else:
            h.table("comment_likes").insert({"comment_id": c["id"], "user_id": user["id"]}).execute()
        total = count_rows("comment_likes", "comment_id", c["id"])
        h.table("comments").update({"likes": total}).eq("id", c["id"]).execute()
        return {"liked": not had, "likes": total}

    # ------------------------------------------------------------------ saved
    @r.post("/posts/save")
    def save_post(body: SaveIn, user: dict = me):
        post = h.viewable_post(body.post_id, user)
        had = h.first(h.table("saved_posts").select("*").eq("user_id", user["id"]).eq("post_id", post["id"]))
        if had:
            h.table("saved_posts").delete().eq("user_id", user["id"]).eq("post_id", post["id"]).execute()
        else:
            h.table("saved_posts").insert({"user_id": user["id"], "post_id": post["id"]}).execute()
        return {"saved": not had}

    # ------------------------------------------------------------------ notes
    def note_shape(n: dict, u: dict) -> dict:
        try:
            track = json.loads(n.get("track") or "null")
        except ValueError:
            track = None
        return {"user": h.pub(u), "text": n["text"], "music": n.get("music") or "", "track": track, "created_at": n["created_at"]}

    @r.put("/users/me/note")
    def set_note(body: NoteIn, user: dict = me):
        row = {"user_id": user["id"], "text": body.text.strip(), "music": body.music.strip(),
               "track": json.dumps(body.track) if body.track else "",
               "created_at": h.iso(h.now()), "expires_at": h.iso(h.now() + timedelta(hours=24))}
        if not row["text"] and not body.track:
            raise HTTPException(422, "Note can't be empty")
        h.table("notes").upsert(row, on_conflict="user_id").execute()
        return note_shape(row, user)

    @r.delete("/users/me/note")
    def clear_note(user: dict = me):
        h.table("notes").delete().eq("user_id", user["id"]).execute()
        return {"deleted": True}

    @r.get("/notes")
    def list_notes(user: dict = me):
        ids = h.following_ids(user["id"]) + [user["id"]]
        live = [n for n in h.rows(h.table("notes").select("*").in_("user_id", ids)) if n["expires_at"] > h.iso(h.now())]
        people = {u["id"]: u for u in h.rows(h.table("users").select("*").in_("id", [n["user_id"] for n in live]))} if live else {}
        return {"notes": [note_shape(n, people[n["user_id"]]) for n in live if n["user_id"] in people]}

    # -------------------------------------------------------------- reactions
    @r.post("/chats/react")
    def react(body: ReactIn, user: dict = me):
        h.limiter.hit(f"react:{user['id']}", 120, 60)
        msg = h.first(h.table("messages").select("*").eq("id", body.message_id))
        if not msg:
            raise HTTPException(404, "Message not found")
        h.membership(msg["conversation_id"], user)
        h.table("message_reactions").upsert({
            "message_id": msg["id"], "user_id": user["id"], "conversation_id": msg["conversation_id"],
            "emoji": body.emoji, "updated_at": h.iso(h.now()),
        }, on_conflict="message_id,user_id").execute()
        return {"ok": True, "emoji": body.emoji}

    return r
