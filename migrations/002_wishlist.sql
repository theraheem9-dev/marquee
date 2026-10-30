-- Adds the Wishlist status and a stored release date for the calendar.
-- Run once in Supabase (SQL Editor). Safe to run again.
alter table public.items add column if not exists release_date date;
alter table public.items drop constraint if exists items_status_check;
alter table public.items add constraint items_status_check
  check (status in ('wishlist', 'want', 'progress', 'finished', 'dropped'));
