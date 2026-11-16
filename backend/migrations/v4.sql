-- =====================================================================
-- LokaChat v4 migration  (Supabase -> SQL Editor -> New query -> paste -> Run)
-- Run AFTER backend/schema.sql. Safe to re-run.
-- Adds: comments + comment likes, saved posts, notes, message reactions, community posts,
--       reel music tags, E2EE key backup, notification "seen" marker, chat attachment storage.
-- =====================================================================

-- ---- users
alter table public.users add column if not exists key_backup text;                    -- password-encrypted E2EE private key (opaque)
alter table public.users add column if not exists notifs_seen_at timestamptz not null default now();

-- ---- posts: community (text/image) posts, optional media, music tag, comment counter
alter table public.posts drop constraint if exists posts_type_check;
alter table public.posts add constraint posts_type_check check (type in ('video', 'clip', 'photo', 'story', 'community'));
alter table public.posts alter column media_path drop not null;
alter table public.posts alter column mime drop not null;
alter table public.posts add column if not exists music text not null default '';
alter table public.posts add column if not exists comments int not null default 0;

-- ---- comments (+ likes)
create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.posts(id) on delete cascade,
  author_id   uuid not null references public.users(id) on delete cascade,
  parent_id   uuid references public.comments(id) on delete cascade,
  body        text not null check (char_length(body) between 1 and 500),
  likes       int not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists comments_post_idx on public.comments (post_id, created_at desc);

create table if not exists public.comment_likes (
  comment_id  uuid not null references public.comments(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (comment_id, user_id)
);

-- ---- saved posts
create table if not exists public.saved_posts (
  user_id     uuid not null references public.users(id) on delete cascade,
  post_id     uuid not null references public.posts(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, post_id)
);
create index if not exists saved_posts_user_idx on public.saved_posts (user_id, created_at desc);

-- ---- notes (short 24h status, like Instagram notes)
create table if not exists public.notes (
  user_id     uuid primary key references public.users(id) on delete cascade,
  text        text not null check (char_length(text) between 1 and 60),
  music       text not null default '',
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

-- ---- message reactions (emoji; '' = removed)
create table if not exists public.message_reactions (
  message_id       uuid not null references public.messages(id) on delete cascade,
  user_id          uuid not null references public.users(id) on delete cascade,
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  emoji            text not null default '',
  updated_at       timestamptz not null default now(),
  primary key (message_id, user_id)
);

-- ---- security: API-only tables are invisible to the browser; reactions are readable by chat members (Realtime)
alter table public.comments          enable row level security;
alter table public.comment_likes     enable row level security;
alter table public.saved_posts       enable row level security;
alter table public.notes             enable row level security;
alter table public.message_reactions enable row level security;
revoke all on public.comments, public.comment_likes, public.saved_posts, public.notes from anon, authenticated;
revoke all on public.message_reactions from anon;
revoke insert, update, delete on public.message_reactions from authenticated;
grant select on public.message_reactions to authenticated;
drop policy if exists reactions_select on public.message_reactions;
create policy reactions_select on public.message_reactions for select to authenticated using (public.is_member(conversation_id));

-- ---- Realtime for live reactions
do $$
begin
  begin
    alter publication supabase_realtime add table public.message_reactions;
  exception when duplicate_object then null;
  end;
end $$;

-- ---- Storage: allow encrypted chat attachments (opaque blobs) and audio in the media bucket
update storage.buckets
   set allowed_mime_types = array['image/*', 'video/*', 'audio/*', 'application/octet-stream']
 where id = 'media';
