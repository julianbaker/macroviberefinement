begin;

-- Tracks that the managed account has already favorited/reposted.
-- Keeps the GitHub Action idempotent and avoids replaying the same social actions.
create table if not exists public.audius_track_engagements (
  track_id      text primary key,
  favorited_at  timestamptz,
  reposted_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint audius_track_engagements_track_id_nonempty
    check (track_id <> ''),
  constraint audius_track_engagements_has_action
    check (favorited_at is not null or reposted_at is not null)
);

create or replace function public.set_audius_track_engagements_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_audius_track_engagements_updated_at on public.audius_track_engagements;

create trigger trg_audius_track_engagements_updated_at
before update on public.audius_track_engagements
for each row
execute function public.set_audius_track_engagements_updated_at();

alter table public.audius_track_engagements enable row level security;

commit;
