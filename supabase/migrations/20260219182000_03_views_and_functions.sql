begin;

create or replace view public.track_bin_counts as
select
  p.track_id,
  p.bin_id,
  count(*)::integer as count,
  max(p.created_at) as last_placed_at
from public.placements p
where p.is_valid = true
group by p.track_id, p.bin_id;

create or replace view public.track_current_bin as
with ranked as (
  select
    tbc.track_id,
    tbc.bin_id as current_bin_id,
    tbc.count as current_count,
    coalesce(
      (
        select max(tbc2.count)
        from public.track_bin_counts tbc2
        where tbc2.track_id = tbc.track_id
          and tbc2.bin_id <> tbc.bin_id
      ),
      0
    )::integer as runner_up_count,
    tbc.last_placed_at as assigned_at,
    row_number() over (
      partition by tbc.track_id
      order by tbc.count desc, tbc.last_placed_at desc, b.sort_order asc
    ) as row_rank
  from public.track_bin_counts tbc
  join public.bins b
    on b.id = tbc.bin_id
)
select
  ranked.track_id,
  ranked.current_bin_id,
  ranked.current_count,
  ranked.runner_up_count,
  ranked.assigned_at
from ranked
where ranked.row_rank = 1;

create or replace view public.archive_bin_counts as
select
  b.id as bin_id,
  b.code_name,
  b.display_name,
  b.sort_order,
  count(tcb.track_id)::integer as track_count
from public.bins b
left join public.track_current_bin tcb
  on tcb.current_bin_id = b.id
where b.is_active = true
group by b.id, b.code_name, b.display_name, b.sort_order;

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
  and tp.is_active = true;

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

create or replace function public.api_v1_submit_placement(
  p_session_token text,
  p_track_id text,
  p_bin_code text,
  p_ip_hash text,
  p_ua_hash text,
  p_latency_ms integer,
  p_rate_limit_session_per_min integer,
  p_rate_limit_ip_per_min integer,
  p_rate_limit_min_interval_ms integer,
  p_source_owner_handle text
)
returns table (
  status text,
  error_code text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bin_id uuid;
  v_last_attempt_at timestamptz;
  v_session_attempt_count integer;
  v_ip_attempt_count integer;
  v_ms_since_last_attempt numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended('placement-session:' || p_session_token, 0));
  perform pg_advisory_xact_lock(hashtextextended('placement-ip:' || p_ip_hash, 0));

  select b.id
  into v_bin_id
  from public.bins b
  where b.code_name = upper(p_bin_code)
    and b.is_active = true;

  if v_bin_id is null then
    insert into public.placement_attempts (
      session_token,
      ip_hash,
      track_id,
      result,
      reason
    ) values (
      p_session_token,
      p_ip_hash,
      p_track_id,
      'rejected',
      'invalid'
    );

    return query select 'rejected', 'INVALID_BIN';
    return;
  end if;

  if not exists (
    select 1
    from public.refine_session_tracks rst
    join public.track_pool tp
      on tp.track_id = rst.track_id
    where rst.session_token = p_session_token
      and rst.track_id = p_track_id
      and tp.is_active = true
      and tp.source_owner_handle = p_source_owner_handle
      and exists (
        select 1
        from public.source_playlist_tracks spt
        where spt.source_owner_handle = p_source_owner_handle
          and spt.track_id = tp.track_id
      )
  ) then
    insert into public.placement_attempts (
      session_token,
      ip_hash,
      track_id,
      result,
      reason
    ) values (
      p_session_token,
      p_ip_hash,
      p_track_id,
      'rejected',
      'invalid'
    );

    return query select 'rejected', 'INVALID_TRACK';
    return;
  end if;

  select pa.created_at
  into v_last_attempt_at
  from public.placement_attempts pa
  where pa.session_token = p_session_token
  order by pa.created_at desc
  limit 1;

  if v_last_attempt_at is not null then
    v_ms_since_last_attempt := extract(epoch from (now() - v_last_attempt_at)) * 1000;

    if v_ms_since_last_attempt < p_rate_limit_min_interval_ms then
      insert into public.placement_attempts (
        session_token,
        ip_hash,
        track_id,
        result,
        reason
      ) values (
        p_session_token,
        p_ip_hash,
        p_track_id,
        'rejected',
        'too_fast'
      );

      return query select 'rejected', 'TOO_FAST';
      return;
    end if;
  end if;

  select count(*)::integer
  into v_session_attempt_count
  from public.placement_attempts pa
  where pa.session_token = p_session_token
    and pa.created_at >= (now() - interval '1 minute');

  select count(*)::integer
  into v_ip_attempt_count
  from public.placement_attempts pa
  where pa.ip_hash = p_ip_hash
    and pa.created_at >= (now() - interval '1 minute');

  if v_session_attempt_count >= p_rate_limit_session_per_min
     or v_ip_attempt_count >= p_rate_limit_ip_per_min then
    insert into public.placement_attempts (
      session_token,
      ip_hash,
      track_id,
      result,
      reason
    ) values (
      p_session_token,
      p_ip_hash,
      p_track_id,
      'rejected',
      'rate_limited'
    );

    return query select 'rejected', 'RATE_LIMITED';
    return;
  end if;

  begin
    insert into public.placements (
      track_id,
      bin_id,
      session_token,
      ip_hash,
      ua_hash,
      latency_ms,
      is_valid
    ) values (
      p_track_id,
      v_bin_id,
      p_session_token,
      p_ip_hash,
      p_ua_hash,
      p_latency_ms,
      true
    );
  exception
    when unique_violation then
      insert into public.placement_attempts (
        session_token,
        ip_hash,
        track_id,
        result,
        reason
      ) values (
        p_session_token,
        p_ip_hash,
        p_track_id,
        'rejected',
        'duplicate'
      );

      return query select 'rejected', 'DUPLICATE_PLACEMENT';
      return;
  end;

  insert into public.placement_attempts (
    session_token,
    ip_hash,
    track_id,
    result,
    reason
  ) values (
    p_session_token,
    p_ip_hash,
    p_track_id,
    'accepted',
    'ok'
  );

  return query select 'accepted', null::text;
end;
$$;

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
      true,
      now(),
      now(),
      0
    from jsonb_to_recordset(coalesce(p_track_rows, '[]'::jsonb)) as x(
      track_id text,
      title text,
      artist_name text,
      artwork_url text,
      duration_sec integer
    )
    on conflict (track_id) do update
      set source = excluded.source,
          source_owner_handle = excluded.source_owner_handle,
          title = coalesce(excluded.title, public.track_pool.title),
          artist_name = coalesce(excluded.artist_name, public.track_pool.artist_name),
          artwork_url = coalesce(excluded.artwork_url, public.track_pool.artwork_url),
          duration_sec = coalesce(excluded.duration_sec, public.track_pool.duration_sec),
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

create or replace function public.api_v1_prune_placement_attempts()
returns bigint
language sql
security definer
set search_path = public
as $$
  with deleted as (
    delete from public.placement_attempts
    where created_at < (now() - interval '7 days')
    returning 1
  )
  select count(*)::bigint from deleted;
$$;

revoke all on table public.track_bin_counts from anon, authenticated;
revoke all on table public.track_current_bin from anon, authenticated;
revoke all on table public.archive_bin_counts from anon, authenticated;
revoke all on table public.archive_tracks from anon, authenticated;

grant select on table public.track_bin_counts to service_role;
grant select on table public.track_current_bin to service_role;
grant select on table public.archive_bin_counts to service_role;
grant select on table public.archive_tracks to service_role;

revoke all on function public.api_v1_init_session_batch(text, text, integer, integer, text) from public, anon, authenticated;
revoke all on function public.api_v1_submit_placement(text, text, text, text, text, integer, integer, integer, integer, text) from public, anon, authenticated;
revoke all on function public.api_v1_apply_allowlist_snapshot(text, jsonb, jsonb, integer, boolean) from public, anon, authenticated;
revoke all on function public.api_v1_prune_placement_attempts() from public, anon, authenticated;

grant execute on function public.api_v1_init_session_batch(text, text, integer, integer, text) to service_role;
grant execute on function public.api_v1_submit_placement(text, text, text, text, text, integer, integer, integer, integer, text) to service_role;
grant execute on function public.api_v1_apply_allowlist_snapshot(text, jsonb, jsonb, integer, boolean) to service_role;
grant execute on function public.api_v1_prune_placement_attempts() to service_role;

commit;
