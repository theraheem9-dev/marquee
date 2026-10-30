-- Marquee database, for a fresh Supabase project (SQL Editor -> paste -> Run).
-- Rebuilt from what app.js reads and writes. For an existing database, run the files in
-- migrations/ instead: this file creates tables and policies and is meant to run once.
-- Every row belongs to the signed-in user (user_id defaults to auth.uid()); row-level
-- security lets each user see and change only their own rows.

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  media_type text not null check (media_type in ('movie', 'tv', 'game')),
  source text not null,              -- tmdb, rawg or manual
  ext_id text not null,              -- id in that source
  title text not null,
  year int,
  poster text,
  genres text[] not null default '{}',
  runtime_min int,
  status text check (status in ('want', 'progress', 'finished', 'dropped')),
  rating numeric(2,1) check (rating between 0.5 and 5),
  favourite boolean not null default false,
  review text,
  hours numeric,
  hours_by_platform jsonb not null default '{}',
  platforms text[] not null default '{}',
  trophies text,
  started_on date,
  finished_on date,
  last_played date,
  import_names text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, media_type, source, ext_id)
);

create table if not exists public.diary (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  item_id uuid not null references public.items on delete cascade,
  logged_on date not null default current_date,
  rating numeric(2,1),
  note text,
  rewatch boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.episodes (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  item_id uuid not null references public.items on delete cascade,
  season int not null,
  episode int not null,
  watched_on date,
  primary key (user_id, item_id, season, episode)
);

create table if not exists public.lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now()
);

create table if not exists public.list_items (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  list_id uuid not null references public.lists on delete cascade,
  item_id uuid not null references public.items on delete cascade,
  position int not null default 0,
  primary key (list_id, item_id)
);

create table if not exists public.showcase (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  media_type text not null check (media_type in ('movie', 'tv', 'game')),
  slot int not null check (slot between 1 and 4),
  item_id uuid not null references public.items on delete cascade,
  primary key (user_id, media_type, slot)
);

-- keep items.updated_at current (Home and Library sort by it)
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists items_touch on public.items;
create trigger items_touch before update on public.items for each row execute function public.touch_updated_at();

-- owner-only access on every table
do $$
declare t text;
begin
  foreach t in array array['items', 'diary', 'episodes', 'lists', 'list_items', 'showcase'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format('create policy "own rows" on public.%I for all using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;
