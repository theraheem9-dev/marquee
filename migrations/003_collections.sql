-- Collections: franchise groupings such as the MCU or Nolan's Dark Knight trilogy.
-- A collection can follow a TMDB film collection, a TMDB keyword (films + series), or be
-- your own mix. Its titles are stored here whether or not they're in your library.
-- Run once in Supabase (SQL Editor). Safe to run again.

create table if not exists public.collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  description text,
  kind text not null default 'custom' check (kind in ('tmdb_collection', 'tmdb_keyword', 'custom')),
  ref text,                          -- TMDB collection id or keyword id
  poster text,
  synced_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.collection_items (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  collection_id uuid not null references public.collections on delete cascade,
  media_type text not null check (media_type in ('movie', 'tv', 'game')),
  source text not null,
  ext_id text not null,
  title text not null,
  year int,
  poster text,
  release_date date,
  auto boolean not null default false,   -- came from TMDB (refresh may update it)
  hidden boolean not null default false, -- you removed it; refresh won't bring it back
  added_at timestamptz not null default now(),
  primary key (collection_id, media_type, source, ext_id)
);

do $$
declare t text;
begin
  foreach t in array array['collections', 'collection_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format('create policy "own rows" on public.%I for all using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;
