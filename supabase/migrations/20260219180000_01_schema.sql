begin;

create extension if not exists pgcrypto;

create table if not exists public.bins (
  id uuid primary key default gen_random_uuid(),
  code_name text not null unique,
  display_name text not null,
  sort_order integer not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint bins_code_name_format check (code_name = upper(code_name))
);

insert into public.bins (code_name, display_name, sort_order)
values
  ('VELLUM', 'Vellum', 1),
  ('BRINE', 'Brine', 2),
  ('HEAT', 'Heat', 3),
  ('STATIC', 'Static', 4),
  ('HALO', 'Halo', 5),
  ('GRIT', 'Grit', 6)
on conflict (code_name) do update
set
  display_name = excluded.display_name,
  sort_order = excluded.sort_order,
  is_active = true;

create table if not exists public.track_pool (
  track_id text primary key,
  source text not null,
  source_owner_handle text not null,
  title text,
  artist_name text,
  artwork_url text,
  duration_sec integer,
  is_active boolean not null default true,
  added_at timestamptz not null default now(),
  last_seen_at timestamptz,
  seen_count integer not null default 0,
  last_allowlisted_at timestamptz,
  missing_runs integer not null default 0,
  constraint track_pool_source_check check (source <> ''),
  constraint track_pool_owner_handle_check check (source_owner_handle <> ''),
  constraint track_pool_duration_check check (duration_sec is null or duration_sec >= 0),
  constraint track_pool_seen_count_check check (seen_count >= 0),
  constraint track_pool_missing_runs_check check (missing_runs >= 0)
);

create table if not exists public.source_playlist_tracks (
  source_owner_handle text not null,
  playlist_id text not null,
  playlist_name text not null,
  track_id text not null,
  observed_at timestamptz not null default now(),
  primary key (source_owner_handle, playlist_id, track_id),
  constraint source_playlist_tracks_handle_check check (source_owner_handle <> ''),
  constraint source_playlist_tracks_playlist_check check (playlist_id <> ''),
  constraint source_playlist_tracks_track_check check (track_id <> '')
);

create table if not exists public.refine_sessions (
  session_token text primary key,
  device text not null,
  session_size integer not null,
  degraded boolean not null default false,
  source_owner_handle text not null,
  created_at timestamptz not null default now(),
  last_init_at timestamptz not null default now(),
  constraint refine_sessions_device_check check (device in ('desktop', 'mobile')),
  constraint refine_sessions_session_size_check check (session_size > 0),
  constraint refine_sessions_source_owner_handle_check check (source_owner_handle <> '')
);

create table if not exists public.refine_session_tracks (
  session_token text not null references public.refine_sessions(session_token) on delete cascade,
  track_id text not null references public.track_pool(track_id),
  position integer not null,
  seed text not null,
  created_at timestamptz not null default now(),
  primary key (session_token, track_id),
  unique (session_token, position),
  constraint refine_session_tracks_position_check check (position > 0),
  constraint refine_session_tracks_seed_check check (seed <> '')
);

create table if not exists public.placements (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  track_id text not null references public.track_pool(track_id),
  bin_id uuid not null references public.bins(id),
  session_token text not null references public.refine_sessions(session_token) on delete cascade,
  ip_hash text not null,
  ua_hash text not null,
  latency_ms integer,
  is_valid boolean not null default true,
  unique (track_id, session_token),
  constraint placements_ip_hash_check check (ip_hash <> ''),
  constraint placements_ua_hash_check check (ua_hash <> ''),
  constraint placements_latency_check check (latency_ms is null or latency_ms >= 0)
);

create table if not exists public.placement_attempts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  session_token text not null,
  ip_hash text not null,
  track_id text,
  result text not null,
  reason text not null,
  constraint placement_attempts_result_check check (result in ('accepted', 'rejected')),
  constraint placement_attempts_reason_check check (
    reason in (
      'ok',
      'too_fast',
      'rate_limited',
      'duplicate',
      'invalid',
      'placements_disabled',
      'session_token_mismatch'
    )
  ),
  constraint placement_attempts_session_token_check check (session_token <> ''),
  constraint placement_attempts_ip_hash_check check (ip_hash <> '')
);

create table if not exists public.ingest_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  source_owner_handle text not null,
  healthy boolean not null,
  source_resolved boolean not null,
  pagination_complete boolean not null,
  playlist_count integer not null default 0,
  track_count integer not null default 0,
  applied_snapshot boolean not null default false,
  error_code text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  constraint ingest_runs_source_owner_handle_check check (source_owner_handle <> ''),
  constraint ingest_runs_playlist_count_check check (playlist_count >= 0),
  constraint ingest_runs_track_count_check check (track_count >= 0)
);

create index if not exists placements_session_token_created_at_idx
  on public.placements (session_token, created_at desc);

create index if not exists placements_ip_hash_created_at_idx
  on public.placements (ip_hash, created_at desc);

create index if not exists placements_track_id_created_at_idx
  on public.placements (track_id, created_at desc);

create index if not exists placement_attempts_session_token_created_at_idx
  on public.placement_attempts (session_token, created_at desc);

create index if not exists placement_attempts_ip_hash_created_at_idx
  on public.placement_attempts (ip_hash, created_at desc);

create index if not exists track_pool_owner_active_seen_last_seen_idx
  on public.track_pool (source_owner_handle, is_active, seen_count, last_seen_at);

create index if not exists source_playlist_tracks_handle_track_idx
  on public.source_playlist_tracks (source_owner_handle, track_id);

create index if not exists refine_session_tracks_session_position_idx
  on public.refine_session_tracks (session_token, position);

create index if not exists ingest_runs_source_started_idx
  on public.ingest_runs (source_owner_handle, started_at desc);

commit;
