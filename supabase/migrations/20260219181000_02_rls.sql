begin;

alter table public.bins enable row level security;
alter table public.track_pool enable row level security;
alter table public.source_playlist_tracks enable row level security;
alter table public.refine_sessions enable row level security;
alter table public.refine_session_tracks enable row level security;
alter table public.placements enable row level security;
alter table public.placement_attempts enable row level security;
alter table public.ingest_runs enable row level security;

revoke all on table public.bins from anon, authenticated;
revoke all on table public.track_pool from anon, authenticated;
revoke all on table public.source_playlist_tracks from anon, authenticated;
revoke all on table public.refine_sessions from anon, authenticated;
revoke all on table public.refine_session_tracks from anon, authenticated;
revoke all on table public.placements from anon, authenticated;
revoke all on table public.placement_attempts from anon, authenticated;
revoke all on table public.ingest_runs from anon, authenticated;

grant select, insert, update, delete on table public.bins to service_role;
grant select, insert, update, delete on table public.track_pool to service_role;
grant select, insert, update, delete on table public.source_playlist_tracks to service_role;
grant select, insert, update, delete on table public.refine_sessions to service_role;
grant select, insert, update, delete on table public.refine_session_tracks to service_role;
grant select, insert, update, delete on table public.placements to service_role;
grant select, insert, update, delete on table public.placement_attempts to service_role;
grant select, insert, update, delete on table public.ingest_runs to service_role;

create policy bins_service_role_full_access
  on public.bins
  for all
  to service_role
  using (true)
  with check (true);

create policy track_pool_service_role_full_access
  on public.track_pool
  for all
  to service_role
  using (true)
  with check (true);

create policy source_playlist_tracks_service_role_full_access
  on public.source_playlist_tracks
  for all
  to service_role
  using (true)
  with check (true);

create policy refine_sessions_service_role_full_access
  on public.refine_sessions
  for all
  to service_role
  using (true)
  with check (true);

create policy refine_session_tracks_service_role_full_access
  on public.refine_session_tracks
  for all
  to service_role
  using (true)
  with check (true);

create policy placements_service_role_full_access
  on public.placements
  for all
  to service_role
  using (true)
  with check (true);

create policy placement_attempts_service_role_full_access
  on public.placement_attempts
  for all
  to service_role
  using (true)
  with check (true);

create policy ingest_runs_service_role_full_access
  on public.ingest_runs
  for all
  to service_role
  using (true)
  with check (true);

commit;
