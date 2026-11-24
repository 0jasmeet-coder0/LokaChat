-- =====================================================================
-- LokaChat v8 migration  -  run in Supabase -> SQL Editor AFTER v7.sql.
-- Safe to re-run (IF NOT EXISTS / DROP POLICY IF EXISTS / CREATE OR REPLACE).
--
-- Adds:
--   1. True end-to-end encryption for PRIVATE chats: per-device identity keys, per-conversation key epochs
--      wrapped for every device (ECDH P-256 + HKDF + AES-256-GCM, done in the browser), key rotation flags.
--   2. Community safety: public/private accounts (+ follow requests), user blocking, user/content reports,
--      "who can message me" and "who can comment on my posts" controls.
--   3. RLS: private accounts and blocks are enforced for browser reads (Realtime/PostgREST) too.
-- The API (FastAPI, service_role) enforces the same rules for every write and every API read.
-- =====================================================================

-- ------------------------------------------------------------ users: privacy controls
alter table public.users add column if not exists account_privacy  text not null default 'public';
alter table public.users add column if not exists who_can_message  text not null default 'everyone';
alter table public.users add column if not exists who_can_comment  text not null default 'everyone';
alter table public.users add column if not exists key_backup       text;            -- opaque sealed blob (client-side encrypted)
alter table public.users add column if not exists key_backup_at    timestamptz;

alter table public.users drop constraint if exists users_account_privacy_check;
alter table public.users add  constraint users_account_privacy_check check (account_privacy in ('public', 'private'));
alter table public.users drop constraint if exists users_who_can_message_check;
alter table public.users add  constraint users_who_can_message_check check (who_can_message in ('everyone', 'followers', 'nobody'));
alter table public.users drop constraint if exists users_who_can_comment_check;
alter table public.users add  constraint users_who_can_comment_check check (who_can_comment in ('everyone', 'followers', 'nobody'));

-- ------------------------------------------------------------ follow requests (private accounts)
create table if not exists public.follow_requests (
  requester_id  uuid not null references public.users(id) on delete cascade,
  target_id     uuid not null references public.users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (requester_id, target_id),
  constraint no_self_request check (requester_id <> target_id)
);
create index if not exists follow_requests_target_idx on public.follow_requests (target_id, created_at desc);

-- ------------------------------------------------------------ blocks
create table if not exists public.blocks (
  blocker_id  uuid not null references public.users(id) on delete cascade,
  blocked_id  uuid not null references public.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint no_self_block check (blocker_id <> blocked_id)
);
create index if not exists blocks_blocked_idx on public.blocks (blocked_id);

-- ------------------------------------------------------------ reports (users, posts, comments, messages)
create table if not exists public.reports (
  id           uuid primary key default gen_random_uuid(),
  reporter_id  uuid not null references public.users(id) on delete cascade,
  target_type  text not null check (target_type in ('user', 'post', 'comment', 'message')),
  target_id    text not null,                                  -- uuid of the user/post/comment/message
  reason       text not null check (reason in ('spam', 'harassment', 'hate', 'violence', 'nudity', 'scam', 'self_harm', 'impersonation', 'other')),
  details      text not null default '',                       -- for E2EE messages this is whatever the reporter chooses to share
  status       text not null default 'open' check (status in ('open', 'reviewing', 'actioned', 'dismissed')),
  created_at   timestamptz not null default now()
);
create index if not exists reports_target_idx   on public.reports (target_type, target_id);
create index if not exists reports_reporter_idx on public.reports (reporter_id, created_at desc);
-- one open report per reporter per target (duplicates are ignored by the API)
create unique index if not exists reports_once on public.reports (reporter_id, target_type, target_id) where status = 'open';

-- ------------------------------------------------------------ E2EE: devices, key epochs, wrapped keys
create table if not exists public.device_keys (
  user_id      uuid not null references public.users(id) on delete cascade,
  device_id    text not null check (device_id ~ '^[a-f0-9]{16,64}$'),
  public_key   text not null,                                  -- ECDH P-256 public JWK (JSON string). Private key never leaves the device.
  label        text not null default '',
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at   timestamptz,
  primary key (user_id, device_id)
);

alter table public.conversations add column if not exists key_epoch      int     not null default 0;   -- 0 = legacy (server-derivable) key, >=1 = true E2EE
alter table public.conversations add column if not exists needs_rotation boolean not null default false;
alter table public.messages      add column if not exists key_epoch      int     not null default 0;

-- One row per (conversation, epoch, recipient device): the epoch's AES key, wrapped with an ephemeral ECDH key + HKDF + AES-GCM.
create table if not exists public.key_wraps (
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  epoch            int  not null check (epoch >= 1),
  user_id          uuid not null references public.users(id) on delete cascade,
  device_id        text not null,
  eph_pub          text not null,                              -- ephemeral public JWK used for this wrap
  wrapped          text not null,                              -- base64(iv || AES-GCM(raw key))
  wrapped_by       uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  primary key (conversation_id, epoch, user_id, device_id)
);
create index if not exists key_wraps_device_idx on public.key_wraps (user_id, device_id);

-- ------------------------------------------------------------ helper functions used by RLS
create or replace function public.is_blocked(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.blocks
                 where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a));
$$;
revoke all on function public.is_blocked(uuid, uuid) from public, anon;
grant execute on function public.is_blocked(uuid, uuid) to authenticated;

-- true when the signed-in user may see content of `author`: themself, or not blocked AND (public account OR follows them)
create or replace function public.can_see_author(author uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select author = auth.uid() or (
    not public.is_blocked(author, auth.uid())
    and (coalesce((select u.account_privacy from public.users u where u.id = author), 'public') = 'public'
         or exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.following_id = author)));
$$;
revoke all on function public.can_see_author(uuid) from public, anon;
grant execute on function public.can_see_author(uuid) to authenticated;

-- ------------------------------------------------------------ RLS
alter table public.follow_requests enable row level security;
alter table public.blocks          enable row level security;
alter table public.reports         enable row level security;
alter table public.device_keys     enable row level security;
alter table public.key_wraps       enable row level security;

-- Safety tables are API-only (service_role). The browser never reads them.
revoke all on public.follow_requests, public.blocks, public.reports from anon, authenticated;
-- Key material: a device may read only wraps addressed to the signed-in user; no writes from the browser.
revoke all on public.device_keys, public.key_wraps from anon;
revoke insert, update, delete on public.device_keys, public.key_wraps from authenticated;
grant select on public.device_keys, public.key_wraps to authenticated;

drop policy if exists device_keys_select on public.device_keys;
create policy device_keys_select on public.device_keys for select to authenticated using (user_id = auth.uid());

drop policy if exists key_wraps_select on public.key_wraps;
create policy key_wraps_select on public.key_wraps for select to authenticated using (user_id = auth.uid());

-- Posts: private accounts + blocks are enforced for Realtime / direct reads too.
drop policy if exists posts_select on public.posts;
create policy posts_select on public.posts for select to authenticated
  using (
    author_id = auth.uid()
    or ((expires_at is null or expires_at > now())
        and public.can_see_author(author_id)
        and (visibility = 'public'
             or exists (select 1 from public.follows f
                        where f.follower_id = auth.uid() and f.following_id = posts.author_id)))
  );

-- Messages: members only (ciphertext). A blocked pair can no longer exchange new rows through the API.
-- (policy unchanged from v4-v7; re-declared so this file is the single source of truth for v8)
drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated using (public.is_member(conversation_id));

-- ------------------------------------------------------------ realtime: new wraps/rotations reach devices instantly
do $$
begin
  begin
    alter publication supabase_realtime add table public.key_wraps;
  exception when duplicate_object then null;
  end;
end $$;

-- ------------------------------------------------------------ notes
-- * Existing chats stay at key_epoch = 0 (legacy). The first v8 client that opens one upgrades it to epoch 1
--   (a random key wrapped for every member device). Old messages keep decrypting with the legacy key.
-- * New messages in private chats MUST carry key_epoch >= 1 (the API rejects epoch 0 for non-channel chats).
-- * Channels remain public broadcast (plaintext) by design.
