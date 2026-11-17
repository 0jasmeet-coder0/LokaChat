-- =====================================================================
-- LokaChat v6 migration  (Supabase -> SQL Editor -> New query -> paste -> Run)
-- Run AFTER schema.sql, v4.sql and v5.sql. Idempotent: safe to re-run.
-- Adds: sponsored ads (is_sponsored / cta_label / cta_url), pinned comments (pinned_comment_id),
--       GIF + sticker comments (comments.gif_url), message edit / unsend / pin (edited_at, pinned_message_id),
--       Saved Audios (liked_audios) and Instagram-style GIF library favourites (gifs).
-- =====================================================================

-- ---- posts: sponsored ads + pinned top comment
alter table public.posts add column if not exists is_sponsored boolean not null default false;
alter table public.posts add column if not exists cta_label text not null default '';
alter table public.posts add column if not exists cta_url text not null default '';
alter table public.posts add column if not exists pinned_comment_id uuid references public.comments(id) on delete set null;
create index if not exists posts_sponsored_idx on public.posts (is_sponsored, created_at desc) where is_sponsored;

-- ---- comments: GIF / sticker comments (body may now be empty when a GIF or sticker is attached)
alter table public.comments add column if not exists gif_url text not null default '';
alter table public.comments drop constraint if exists comments_body_check;
alter table public.comments add constraint comments_body_check check (char_length(body) between 0 and 500);

-- ---- messages: edited marker (content itself stays end-to-end encrypted) + pinned message per chat
alter table public.messages add column if not exists edited_at timestamptz;
alter table public.conversations add column if not exists pinned_message_id uuid references public.messages(id) on delete set null;
-- realtime DELETE (unsend) and UPDATE (edit) events carry the full old row so clients can filter them
alter table public.messages replica identity full;

-- ---- Saved Audios (songs a user liked/saved from the Music Library; iTunes preview metadata only)
create table if not exists public.liked_audios (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 80),
  artist      text not null default '',
  url         text not null,
  cover       text not null default '',
  created_at  timestamptz not null default now(),
  unique (user_id, url)
);
create index if not exists liked_audios_user_idx on public.liked_audios (user_id, created_at desc);

-- ---- GIF favourites (recently used / starred GIFs and stickers for comments + chat)
create table if not exists public.gifs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  url         text not null,
  title       text not null default '',
  created_at  timestamptz not null default now(),
  unique (user_id, url)
);
create index if not exists gifs_user_idx on public.gifs (user_id, created_at desc);

-- ---- security: API-only tables are invisible to the browser (all access goes through FastAPI + service_role)
alter table public.liked_audios enable row level security;
alter table public.gifs         enable row level security;
revoke all on public.liked_audios, public.gifs from anon, authenticated;

-- ---- realtime: let clients see edits and unsends of messages (messages is already in the publication from schema.sql)
do $$
begin
  begin
    alter publication supabase_realtime add table public.messages;
  exception when duplicate_object then null;
  end;
end $$;
