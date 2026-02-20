begin;

-- Add genre column to track_pool for podcast exclusion
alter table public.track_pool
  add column if not exists genre text;

-- Recreate api_v1_apply_allowlist_snapshot to accept and store genre
create or replace function public.api_v1_apply_allowlist_snapshot(
  p_source_owner_handle text,
  p_snapshot_entries jsonb,
  p_track_rows jsonb,
  p_missing_run_threshold integer,
  p_run_healthy boolean
)
returns table (
  applied_snapshot boolean,
  upserted_tracks integer,
  deactivated_tracks integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_upserted_tracks integer := 0;
  v_deactivated_tracks integer := 0;
begin
  if p_run_healthy = false then
    return query select false, 0, 0;
    return;
  end if;

  delete from public.source_playlist_tracks spt
  where spt.source_owner_handle = p_source_owner_handle;

  insert into public.source_playlist_tracks (
    source_owner_handle,
    playlist_id,
    playlist_name,
    track_id,
    observed_at
  )
  select
    p_source_owner_handle,
    x.playlist_id,
    x.playlist_name,
    x.track_id,
    now()
  from jsonb_to_recordset(coalesce(p_snapshot_entries, '[]'::jsonb)) as x(
    playlist_id text,
    playlist_name text,
    track_id text
  );

  with upserted as (
    insert into public.track_pool (
      track_id,
      source,
      source_owner_handle,
      title,
      artist_name,
      artwork_url,
      duration_sec,
      genre,
      is_active,
      added_at,
      last_allowlisted_at,
      missing_runs
    )
    select
      x.track_id,
      'audius',
      p_source_owner_handle,
      x.title,
      x.artist_name,
      x.artwork_url,
      x.duration_sec,
      x.genre,
      true,
      now(),
      now(),
      0
    from jsonb_to_recordset(coalesce(p_track_rows, '[]'::jsonb)) as x(
      track_id text,
      title text,
      artist_name text,
      artwork_url text,
      duration_sec integer,
      genre text
    )
    on conflict (track_id) do update
      set source = excluded.source,
          source_owner_handle = excluded.source_owner_handle,
          title = coalesce(excluded.title, public.track_pool.title),
          artist_name = coalesce(excluded.artist_name, public.track_pool.artist_name),
          artwork_url = coalesce(excluded.artwork_url, public.track_pool.artwork_url),
          duration_sec = coalesce(excluded.duration_sec, public.track_pool.duration_sec),
          genre = coalesce(excluded.genre, public.track_pool.genre),
          is_active = true,
          last_allowlisted_at = now(),
          missing_runs = 0
    returning 1
  )
  select count(*)::integer
  into v_upserted_tracks
  from upserted;

  with absent_tracks as (
    select tp.track_id
    from public.track_pool tp
    where tp.source_owner_handle = p_source_owner_handle
      and not exists (
        select 1
        from jsonb_to_recordset(coalesce(p_track_rows, '[]'::jsonb)) as x(track_id text)
        where x.track_id = tp.track_id
      )
  ), updated as (
    update public.track_pool tp
    set
      missing_runs = tp.missing_runs + 1,
      is_active = case
        when (tp.missing_runs + 1) >= p_missing_run_threshold then false
        else tp.is_active
      end
    from absent_tracks at
    where tp.track_id = at.track_id
    returning tp.track_id
  )
  select count(*)::integer
  into v_deactivated_tracks
  from updated;

  return query select true, v_upserted_tracks, v_deactivated_tracks;
end;
$$;

-- Recreate session init to exclude podcast genre
create or replace function public.api_v1_init_session_batch(
  p_session_token text,
  p_device text,
  p_target_size integer,
  p_floor_size integer,
  p_source_owner_handle text
)
returns table (
  track_id text,
  artwork_url text,
  seed text,
  session_size integer,
  degraded boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_available_count integer;
  v_session_size integer;
  v_degraded boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('session-init:' || p_session_token, 0));

  if exists (
    select 1
    from public.refine_sessions rs
    where rs.session_token = p_session_token
  ) then
    update public.refine_sessions
    set last_init_at = now()
    where session_token = p_session_token;

    return query
    select
      rst.track_id,
      tp.artwork_url,
      rst.seed,
      rs.session_size,
      rs.degraded
    from public.refine_session_tracks rst
    join public.refine_sessions rs
      on rs.session_token = rst.session_token
    join public.track_pool tp
      on tp.track_id = rst.track_id
    where rst.session_token = p_session_token
    order by rst.position;

    return;
  end if;

  select count(distinct tp.track_id)::integer
  into v_available_count
  from public.track_pool tp
  where tp.is_active = true
    and tp.source_owner_handle = p_source_owner_handle
    and lower(coalesce(tp.genre, '')) <> 'podcast'
    and exists (
      select 1
      from public.source_playlist_tracks spt
      where spt.source_owner_handle = p_source_owner_handle
        and spt.track_id = tp.track_id
    );

  if v_available_count < p_floor_size then
    raise exception 'INSUFFICIENT_POOL';
  end if;

  v_session_size := least(p_target_size, v_available_count);
  v_degraded := (v_session_size < p_target_size);

  insert into public.refine_sessions (
    session_token,
    device,
    session_size,
    degraded,
    source_owner_handle
  ) values (
    p_session_token,
    p_device,
    v_session_size,
    v_degraded,
    p_source_owner_handle
  );

  with candidates as (
    select
      tp.track_id,
      tp.artwork_url
    from public.track_pool tp
    where tp.is_active = true
      and tp.source_owner_handle = p_source_owner_handle
      and lower(coalesce(tp.genre, '')) <> 'podcast'
      and exists (
        select 1
        from public.source_playlist_tracks spt
        where spt.source_owner_handle = p_source_owner_handle
          and spt.track_id = tp.track_id
      )
    order by tp.seen_count asc, tp.last_seen_at asc nulls first, random()
    limit v_session_size
  ), numbered as (
    select
      c.track_id,
      c.artwork_url,
      row_number() over () as position
    from candidates c
  )
  insert into public.refine_session_tracks (
    session_token,
    track_id,
    position,
    seed
  )
  select
    p_session_token,
    n.track_id,
    n.position,
    upper(substr(md5(n.track_id), 1, 4))
  from numbered n;

  update public.track_pool tp
  set
    seen_count = tp.seen_count + 1,
    last_seen_at = now()
  where exists (
    select 1
    from public.refine_session_tracks rst
    where rst.session_token = p_session_token
      and rst.track_id = tp.track_id
  );

  return query
  select
    rst.track_id,
    tp.artwork_url,
    rst.seed,
    rs.session_size,
    rs.degraded
  from public.refine_session_tracks rst
  join public.refine_sessions rs
    on rs.session_token = rst.session_token
  join public.track_pool tp
    on tp.track_id = rst.track_id
  where rst.session_token = p_session_token
  order by rst.position;
end;
$$;

-- Recreate archive_tracks view to also exclude podcasts
create or replace view public.archive_tracks as
select
  b.code_name as bin_code,
  tcb.track_id,
  tp.title,
  tp.artist_name,
  tp.artwork_url,
  tcb.current_count,
  tcb.assigned_at
from public.track_current_bin tcb
join public.bins b
  on b.id = tcb.current_bin_id
join public.track_pool tp
  on tp.track_id = tcb.track_id
where b.is_active = true
  and tp.is_active = true
  and lower(coalesce(tp.genre, '')) <> 'podcast';

-- Index to make the genre filter efficient
create index if not exists track_pool_genre_idx
  on public.track_pool (source_owner_handle, is_active, genre);

commit;
