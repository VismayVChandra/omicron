-- Swell — hosted share links, with reading stats and comments.
--
-- Paste this whole file into the Supabase SQL editor and run it once. It is
-- separate from schema.sql so that a deployment which only wants accounts and
-- saved decks does not have to take any of this.
--
-- The difference from every other table here is that these are readable by
-- people who are not signed in — that is what a share link is. So the policies
-- are doing more work than usual, and each one says what it is allowing.

-- ---------------------------------------------------------------- shares ---
-- A share is a snapshot, not a pointer. Editing the deck afterwards must not
-- silently change what somebody was sent; updating the shared copy is a
-- deliberate act with its own button.
create table if not exists public.shares (
  id          text primary key,                      -- short slug, generated in the browser
  user_id     uuid not null references auth.users (id) on delete cascade,
  deck_id     uuid references public.decks (id) on delete set null,
  title       text not null default 'Untitled deck',
  theme       text not null default 'tide',
  slides      jsonb not null,
  visibility  text not null default 'link'
              check (visibility in ('link', 'paused')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists shares_user_idx on public.shares (user_id, created_at desc);

alter table public.shares enable row level security;

drop policy if exists "anyone reads a live share" on public.shares;
drop policy if exists "owner reads own shares"    on public.shares;
drop policy if exists "owner creates shares"      on public.shares;
drop policy if exists "owner updates own shares"  on public.shares;
drop policy if exists "owner deletes own shares"  on public.shares;

-- The one deliberately public read in this schema. Knowing the id is the
-- permission; 'paused' takes a link out of circulation without deleting it,
-- and the owner keeps their own access either way.
create policy "anyone reads a live share"
  on public.shares for select
  using (visibility = 'link');

create policy "owner reads own shares"
  on public.shares for select
  using (auth.uid() = user_id);

create policy "owner creates shares"
  on public.shares for insert
  with check (auth.uid() = user_id);

create policy "owner updates own shares"
  on public.shares for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "owner deletes own shares"
  on public.shares for delete
  using (auth.uid() = user_id);

-- ----------------------------------------------------------- share_views ---
-- One row per reader per share. "viewer" is a random string the reader's own
-- browser made up and kept — there is no IP, no user agent and no account
-- behind it, and it cannot be traced to a person. It exists so that opening a
-- deck twice does not read as two people.
create table if not exists public.share_views (
  id          uuid primary key default gen_random_uuid(),
  share_id    text not null references public.shares (id) on delete cascade,
  viewer      text not null,
  furthest    int  not null default 0,      -- highest slide number reached
  seconds     int  not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (share_id, viewer)
);

create index if not exists share_views_share_idx on public.share_views (share_id);

alter table public.share_views enable row level security;

drop policy if exists "readers record a view"   on public.share_views;
drop policy if exists "readers update own view" on public.share_views;
drop policy if exists "owner reads view stats"  on public.share_views;

-- A reader is anonymous by definition, so these have to accept writes from
-- nobody in particular. They are narrowed to shares that are actually live,
-- which stops the table being used as free storage. It does not stop somebody
-- who has the link from inflating their own numbers — these are indicative
-- counts, not an audited log, and the README says so.
create policy "readers record a view"
  on public.share_views for insert
  with check (exists (
    select 1 from public.shares s where s.id = share_id and s.visibility = 'link'
  ));

create policy "readers update own view"
  on public.share_views for update
  using (exists (
    select 1 from public.shares s where s.id = share_id and s.visibility = 'link'
  ))
  with check (true);

create policy "owner reads view stats"
  on public.share_views for select
  using (exists (
    select 1 from public.shares s where s.id = share_id and s.user_id = auth.uid()
  ));

-- -------------------------------------------------------- share_comments ---
create table if not exists public.share_comments (
  id          uuid primary key default gen_random_uuid(),
  share_id    text not null references public.shares (id) on delete cascade,
  slide       int  not null default 0,
  name        text not null default '' check (length(name) <= 60),
  body        text not null check (length(body) between 1 and 800),
  created_at  timestamptz not null default now()
);

create index if not exists share_comments_share_idx
  on public.share_comments (share_id, created_at);

alter table public.share_comments enable row level security;

drop policy if exists "readers leave comments"   on public.share_comments;
drop policy if exists "anyone reads comments"    on public.share_comments;
drop policy if exists "owner deletes comments"   on public.share_comments;

create policy "readers leave comments"
  on public.share_comments for insert
  with check (exists (
    select 1 from public.shares s where s.id = share_id and s.visibility = 'link'
  ));

-- Comments are visible to everyone who can open the deck, which is what makes
-- them a conversation rather than a suggestion box.
create policy "anyone reads comments"
  on public.share_comments for select
  using (exists (
    select 1 from public.shares s where s.id = share_id and s.visibility = 'link'
  ) or exists (
    select 1 from public.shares s where s.id = share_id and s.user_id = auth.uid()
  ));

create policy "owner deletes comments"
  on public.share_comments for delete
  using (exists (
    select 1 from public.shares s where s.id = share_id and s.user_id = auth.uid()
  ));

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

drop trigger if exists shares_touch_updated_at on public.shares;
create trigger shares_touch_updated_at
  before update on public.shares
  for each row execute function public.touch_updated_at();

drop trigger if exists share_views_touch_updated_at on public.share_views;
create trigger share_views_touch_updated_at
  before update on public.share_views
  for each row execute function public.touch_updated_at();
