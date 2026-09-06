-- Swell — deck storage.
-- Paste this whole file into the Supabase SQL editor and run it once.
--
-- The browser talks to Supabase directly using the publishable anon key, so
-- every rule that matters is enforced here by row level security rather than by
-- client code. Each policy compares auth.uid() to the row's user_id, which
-- means a signed-in person can only ever see and change their own decks — even
-- though they hold the same anon key as everyone else.

create table if not exists public.decks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  title       text not null default 'Untitled deck',
  topic       text not null default '',
  theme       text not null default 'tide',
  slides      jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- newest first, per person
create index if not exists decks_user_updated_idx
  on public.decks (user_id, updated_at desc);

alter table public.decks enable row level security;

drop policy if exists "read own decks"   on public.decks;
drop policy if exists "insert own decks" on public.decks;
drop policy if exists "update own decks" on public.decks;
drop policy if exists "delete own decks" on public.decks;

create policy "read own decks"
  on public.decks for select
  using (auth.uid() = user_id);

create policy "insert own decks"
  on public.decks for insert
  with check (auth.uid() = user_id);

create policy "update own decks"
  on public.decks for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "delete own decks"
  on public.decks for delete
  using (auth.uid() = user_id);

-- keep updated_at honest without trusting the client to send it
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists decks_touch_updated_at on public.decks;
create trigger decks_touch_updated_at
  before update on public.decks
  for each row execute function public.touch_updated_at();
