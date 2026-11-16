-- =====================================================================
-- LokaChat database schema  (PostgreSQL / Supabase)
-- v4 NOTE: after running this file, also run backend/migrations/v4.sql (comments, notes, saves, reactions, key backup).
-- Run once:  Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Safe to re-run (uses IF NOT EXISTS / DROP POLICY IF EXISTS).
--
-- Security model
--   * The FastAPI server (Koyeb) uses the service_role key and does all writes.
--   * The browser uses the anon key + a session JWT minted by FastAPI (role =
--     authenticated, sub = users.id). With that JWT the browser may only READ
--     rows it is allowed to see (RLS below) - used for Realtime and Storage.
--   * users and otp_codes are NOT readable from the browser at all.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- users
create table if not exists public.users (
  id                   uuid primary key default gen_random_uuid(),
  username             text not null check (username ~ '^[a-z0-9_.]{3,20}$'),
  email                text,
  phone                text,
  display_name         text not null,
  bio                  text not null default '',
  avatar_path          text,                       -- path inside the 'media' bucket
  password_hash        text not null,              -- bcrypt
  is_verified          boolean not null default false,
  totp_secret          text,                       -- encrypted (Fernet) by the API
  totp_pending_secret  text,                       -- set during 2FA setup, before confirmation
  totp_enabled         boolean not null default false,
  totp_last_step       bigint not null default 0,  -- blocks TOTP code replay
  public_key           text,                       -- ECDH P-256 public JWK for E2EE chats
  created_at           timestamptz not null default now(),
  constraint users_contact_required check (email is not null or phone is not null)
);
create unique index if not exists users_username_key on public.users (lower(username));
create unique index if not exists users_email_key    on public.users (lower(email)) where email is not null;
create unique index if not exists users_phone_key    on public.users (phone)        where phone is not null;

-- ------------------------------------------------------------ otp_codes
create table if not exists public.otp_codes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  purpose     text not null check (purpose in ('signup', 'login')),
  code_hash   text not null,                       -- keyed hash, never the raw code
  expires_at  timestamptz not null,
  attempts    int not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists otp_codes_lookup on public.otp_codes (user_id, purpose, created_at desc);

-- --------------------------------------------------------------- follows
create table if not exists public.follows (
  follower_id   uuid not null references public.users(id) on delete cascade,
  following_id  uuid not null references public.users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (follower_id, following_id),
  constraint no_self_follow check (follower_id <> following_id)
);
create index if not exists follows_following_idx on public.follows (following_id);

-- ----------------------------------------------------------------- posts
create table if not exists public.posts (
  id           uuid primary key default gen_random_uuid(),
  author_id    uuid not null references public.users(id) on delete cascade,
  type         text not null check (type in ('video', 'clip', 'photo', 'story')),
  title        text not null default '',
  caption      text not null default '',
  visibility   text not null default 'public' check (visibility in ('public', 'followers')),
  media_path   text not null,                      -- path inside the 'media' bucket
  poster_path  text,
  mime         text not null,
  duration     real not null default 0,
  size         bigint not null default 0,
  views        int not null default 0,
  likes        int not null default 0,
  expires_at   timestamptz,                        -- stories: created_at + 24h
  created_at   timestamptz not null default now()
);
create index if not exists posts_author_idx on public.posts (author_id, created_at desc);
create index if not exists posts_feed_idx   on public.posts (type, visibility, created_at desc);

create table if not exists public.post_likes (
  post_id     uuid not null references public.posts(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (post_id, user_id)
);

-- --------------------------------------------------------- watch_history
create table if not exists public.watch_history (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  post_id     uuid not null references public.posts(id) on delete cascade,
  watched_at  timestamptz not null default now(),
  position    real not null default 0,             -- resume position (seconds)
  duration    real not null default 0,
  unique (user_id, post_id)
);
create index if not exists watch_history_user_idx on public.watch_history (user_id, watched_at desc);

-- --------------------------------------------------------- conversations
create table if not exists public.conversations (
  id               uuid primary key default gen_random_uuid(),
  type             text not null check (type in ('direct', 'group', 'channel')),
  title            text not null default '',
  description      text not null default '',
  creator_id       uuid references public.users(id) on delete set null,
  direct_key       text unique,                    -- "<idA>|<idB>" (sorted) de-duplicates 1:1 chats
  created_at       timestamptz not null default now(),
  last_message_at  timestamptz
);

create table if not exists public.conversation_members (
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  user_id          uuid not null references public.users(id) on delete cascade,
  role             text not null default 'member' check (role in ('owner', 'admin', 'member', 'subscriber')),
  wrapped_key      text,                           -- chat key encrypted for this member (E2EE)
  wrapped_by       uuid references public.users(id) on delete set null,
  joined_at        timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index if not exists conversation_members_user_idx on public.conversation_members (user_id);

create table if not exists public.messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  sender_id        uuid references public.users(id) on delete set null,
  ciphertext       text not null,                  -- AES-GCM ciphertext (plaintext only in channels)
  iv               text not null default '',
  encrypted        boolean not null default true,
  created_at       timestamptz not null default now()
);
create index if not exists messages_conv_idx on public.messages (conversation_id, created_at desc);

-- ============================================================ security (RLS)
alter table public.users                enable row level security;
alter table public.otp_codes            enable row level security;
alter table public.follows              enable row level security;
alter table public.posts                enable row level security;
alter table public.post_likes           enable row level security;
alter table public.watch_history        enable row level security;
alter table public.conversations        enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages             enable row level security;

-- Secrets: no access from the browser, ever.
revoke all on public.users, public.otp_codes from anon, authenticated;
-- Everything else: the browser may only read (the API does all writes).
revoke all on public.follows, public.posts, public.post_likes, public.watch_history,
              public.conversations, public.conversation_members, public.messages from anon;
revoke insert, update, delete on public.follows, public.posts, public.post_likes, public.watch_history,
              public.conversations, public.conversation_members, public.messages from authenticated;
grant select on public.follows, public.posts, public.post_likes, public.watch_history,
              public.conversations, public.conversation_members, public.messages to authenticated;

-- SECURITY DEFINER helper avoids infinite recursion in conversation_members policies.
create or replace function public.is_member(cid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.conversation_members m
                 where m.conversation_id = cid and m.user_id = auth.uid());
$$;
revoke all on function public.is_member(uuid) from public, anon;
grant execute on function public.is_member(uuid) to authenticated;

drop policy if exists follows_select on public.follows;
create policy follows_select on public.follows for select to authenticated
  using (follower_id = auth.uid() or following_id = auth.uid());

drop policy if exists posts_select on public.posts;
create policy posts_select on public.posts for select to authenticated
  using (
    author_id = auth.uid()
    or ((expires_at is null or expires_at > now())
        and (visibility = 'public'
             or exists (select 1 from public.follows f
                        where f.follower_id = auth.uid() and f.following_id = posts.author_id)))
  );

drop policy if exists post_likes_select on public.post_likes;
create policy post_likes_select on public.post_likes for select to authenticated using (user_id = auth.uid());

drop policy if exists watch_history_select on public.watch_history;
create policy watch_history_select on public.watch_history for select to authenticated using (user_id = auth.uid());

drop policy if exists conversations_select on public.conversations;
create policy conversations_select on public.conversations for select to authenticated using (public.is_member(id));

drop policy if exists members_select on public.conversation_members;
create policy members_select on public.conversation_members for select to authenticated
  using (user_id = auth.uid() or public.is_member(conversation_id));

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated using (public.is_member(conversation_id));

-- ============================================================== Realtime
-- Zero-delay live updates: new messages, new posts, and new conversations.
do $$
declare t text;
begin
  foreach t in array array['messages', 'posts', 'conversation_members'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ================================================================ Storage
-- One public bucket 'media'. Files live at <user_id>/<post_id>/... ; users can
-- only upload into / delete from their own folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 52428800, array['image/*', 'video/*'])      -- 50 MB (free-plan max)
on conflict (id) do update
  set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists lokachat_media_read on storage.objects;
create policy lokachat_media_read on storage.objects for select using (bucket_id = 'media');

drop policy if exists lokachat_media_insert on storage.objects;
create policy lokachat_media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists lokachat_media_delete on storage.objects;
create policy lokachat_media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);

-- ------------------------------------------------------------ optional upkeep
-- Purge expired OTP codes and stories hourly (enable the pg_cron extension first):
-- select cron.schedule('lokachat-cleanup', '0 * * * *', $c$
--   delete from public.otp_codes where expires_at < now();
--   delete from public.posts where type = 'story' and expires_at < now() - interval '1 day';
-- $c$);
