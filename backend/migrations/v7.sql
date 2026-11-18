-- =====================================================================
-- LokaChat v7 (Part 1) migration  (Supabase -> SQL Editor -> New query -> paste -> Run)
-- Run AFTER schema.sql, v4.sql, v5.sql and v6.sql. Idempotent: safe to re-run.
-- Adds: posts.format / allow_download / ad_placement / ad_budget,
--       Google OAuth profile support on users (google_sub, oauth_avatar_url, auth_provider, nullable password_hash).
-- =====================================================================

-- ---- posts.format: 'video' (16:9 watch page) | 'reel' (9:16) | 'post' (photo / community / story)
alter table public.posts add column if not exists format text;
update public.posts
   set format = case type when 'clip' then 'reel' when 'video' then 'video' else 'post' end
 where format is null;
alter table public.posts alter column format set not null;
alter table public.posts drop constraint if exists posts_format_check;
alter table public.posts add constraint posts_format_check check (format in ('video', 'reel', 'post'));

-- an insert that omits format (e.g. an older API build) still gets the right value
create or replace function public.posts_set_format()
returns trigger language plpgsql as $$
begin
  if new.format is null then
    new.format := case new.type when 'clip' then 'reel' when 'video' then 'video' else 'post' end;
  end if;
  return new;
end $$;
drop trigger if exists posts_set_format on public.posts;
create trigger posts_set_format before insert on public.posts
  for each row execute function public.posts_set_format();

-- ---- posts.allow_download: creator can hide the Download button (UI-level; the media bucket is public)
alter table public.posts add column if not exists allow_download boolean not null default true;

-- ---- posts.ad_placement / ad_budget: where a promoted post is shown + the creator-declared budget
alter table public.posts add column if not exists ad_placement text not null default 'none';
alter table public.posts drop constraint if exists posts_ad_placement_check;
alter table public.posts add constraint posts_ad_placement_check check (ad_placement in ('none', 'feed', 'preroll', 'midroll'));
alter table public.posts add column if not exists ad_budget numeric(12, 2) not null default 0;
alter table public.posts drop constraint if exists posts_ad_budget_check;
alter table public.posts add constraint posts_ad_budget_check check (ad_budget >= 0);
-- v6 sponsored posts were shown in the feed, so they become placement 'feed'
update public.posts set ad_placement = 'feed' where is_sponsored and ad_placement = 'none';
create index if not exists posts_ad_placement_idx on public.posts (ad_placement, created_at desc) where ad_placement <> 'none';

-- ---- users: Google OAuth profile support
-- Google-only accounts have no password, so password_hash becomes optional (password sign-in then always fails for them).
alter table public.users alter column password_hash drop not null;
alter table public.users add column if not exists auth_provider text not null default 'password';
alter table public.users drop constraint if exists users_auth_provider_check;
alter table public.users add constraint users_auth_provider_check check (auth_provider in ('password', 'google'));
alter table public.users add column if not exists google_sub text;           -- Google's stable account id
alter table public.users add column if not exists oauth_avatar_url text;     -- Google profile picture (https, googleusercontent.com)
create unique index if not exists users_google_sub_key on public.users (google_sub) where google_sub is not null;
alter table public.users drop constraint if exists users_credential_required;
alter table public.users add constraint users_credential_required check (password_hash is not null or google_sub is not null);
-- (users stays invisible to the browser: RLS + revoke from schema.sql also cover the new columns)
