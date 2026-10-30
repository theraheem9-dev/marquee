-- Lets a game remember the PlayStation/Steam titles it was imported or re-matched from,
-- so re-importing lands on the game you picked instead of adding a duplicate.
-- Run once in Supabase (SQL Editor). Safe to run again.
alter table public.items add column if not exists import_names text[] not null default '{}';
