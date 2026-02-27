begin;

-- Artists the managed Audius account has already followed.
-- Keeps follow operations idempotent across hourly GitHub Action runs.
create table if not exists public.audius_followed_artists (
  artist_user_id text primary key,
  followed_at    timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint audius_followed_artists_artist_user_id_nonempty
    check (artist_user_id <> '')
);

create or replace function public.set_audius_followed_artists_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_audius_followed_artists_updated_at on public.audius_followed_artists;

create trigger trg_audius_followed_artists_updated_at
before update on public.audius_followed_artists
for each row
execute function public.set_audius_followed_artists_updated_at();

alter table public.audius_followed_artists enable row level security;

commit;
