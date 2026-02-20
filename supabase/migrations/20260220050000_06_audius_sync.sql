begin;

-- ── Bin-to-playlist mapping ────────────────────────────────────────────────────
-- One row per bin. Populated once via audius-sync?setup=1. Read on every sync.
create table if not exists public.audius_bin_playlists (
  bin_code      text primary key,
  playlist_id   text not null,
  playlist_name text not null,
  created_at    timestamptz not null default now(),
  constraint audius_bin_playlists_bin_code_fk
    foreign key (bin_code) references public.bins(code_name),
  constraint audius_bin_playlists_bin_code_upper
    check (bin_code = upper(bin_code)),
  constraint audius_bin_playlists_playlist_id_nonempty
    check (playlist_id <> ''),
  constraint audius_bin_playlists_playlist_name_nonempty
    check (playlist_name <> '')
);

-- ── Published track state ──────────────────────────────────────────────────────
-- One row per track reflecting what is currently in the Audius playlists.
-- Diff between this table and archive_tracks defines sync work each run.
create table if not exists public.audius_published_tracks (
  track_id     text primary key,
  bin_code     text not null,
  published_at timestamptz not null default now(),
  constraint audius_published_tracks_bin_code_fk
    foreign key (bin_code) references public.bins(code_name),
  constraint audius_published_tracks_track_id_nonempty
    check (track_id <> ''),
  constraint audius_published_tracks_bin_code_upper
    check (bin_code = upper(bin_code))
);

-- ── Sync run history ───────────────────────────────────────────────────────────
-- Mirrors the ingest_runs pattern for observability.
create table if not exists public.audius_sync_runs (
  id             bigint generated always as identity primary key,
  started_at     timestamptz not null,
  finished_at    timestamptz,
  healthy        boolean,
  tracks_added   integer not null default 0,
  tracks_removed integer not null default 0,
  tracks_moved   integer not null default 0,
  error_code     text,
  error_message  text,
  metadata       jsonb
);

-- ── RLS: deny all direct access, Edge Function uses service-role ───────────────
alter table public.audius_bin_playlists enable row level security;
alter table public.audius_published_tracks enable row level security;
alter table public.audius_sync_runs enable row level security;

-- ── pg_cron: hourly sync ───────────────────────────────────────────────────────
do $$
declare
  v_job_id bigint;
begin
  for v_job_id in
    select jobid
    from cron.job
    where jobname = 'audius_sync_hourly'
  loop
    perform cron.unschedule(v_job_id);
  end loop;
end;
$$;

select cron.schedule(
  'audius_sync_hourly',
  '0 * * * *',
  $$
  select
    net.http_post(
      url := 'https://ukqfnoemsifeiotqlxcp.supabase.co/functions/v1/audius-sync',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $$
);

commit;
