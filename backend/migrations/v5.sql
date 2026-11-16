-- LokaChat v5 migration (idempotent). Run AFTER schema.sql and migrations/v4.sql in the Supabase SQL editor.
-- Adds: music tracks on notes (iTunes Search preview), notes may be song-only.

alter table public.notes add column if not exists track text not null default '';   -- JSON {title, artist, url, cover}
alter table public.notes drop constraint if exists notes_text_check;
alter table public.notes add constraint notes_text_check check (char_length(text) between 0 and 60);
