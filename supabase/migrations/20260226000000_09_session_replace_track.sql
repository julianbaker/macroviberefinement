-- Replace a single track at a given position in an existing session (e.g. after preload failure).
-- Position is 0-based (cell index). Exclude list avoids reusing known-failed track IDs.
create or replace function public.api_v1_session_replace_track(
  p_session_token text,
  p_position integer,
  p_exclude_track_ids text[] default '{}'
)
returns table (
  track_id text,
  artwork_url text,
  seed text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_owner_handle text;
  v_new_track_id text;
  v_position_db integer;
begin
  v_position_db := p_position + 1;

  if v_position_db < 1 then
    raise exception 'INVALID_POSITION';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('session-init:' || p_session_token, 0));

  select rs.source_owner_handle
  into v_source_owner_handle
  from public.refine_sessions rs
  where rs.session_token = p_session_token;

  if v_source_owner_handle is null then
    raise exception 'SESSION_NOT_FOUND';
  end if;

  delete from public.refine_session_tracks
  where session_token = p_session_token
    and position = v_position_db;

  with pool_candidates as (
    select tp.track_id
    from public.track_pool tp
    where tp.is_active = true
      and tp.source_owner_handle = v_source_owner_handle
      and lower(coalesce(tp.genre, '')) <> 'podcast'
      and exists (
        select 1
        from public.source_playlist_tracks spt
        where spt.source_owner_handle = v_source_owner_handle
          and spt.track_id = tp.track_id
      )
      and not exists (
        select 1
        from public.refine_session_tracks rst
        where rst.session_token = p_session_token
          and rst.track_id = tp.track_id
      )
      and (cardinality(p_exclude_track_ids) = 0 or not (tp.track_id = any(p_exclude_track_ids)))
    order by tp.seen_count asc, tp.last_seen_at asc nulls first, random()
    limit 1
  )
  select pool_candidates.track_id into v_new_track_id from pool_candidates;

  if v_new_track_id is null then
    raise exception 'NO_REPLACEMENT_AVAILABLE';
  end if;

  insert into public.refine_session_tracks (
    session_token,
    track_id,
    position,
    seed
  ) values (
    p_session_token,
    v_new_track_id,
    v_position_db,
    upper(substr(md5(v_new_track_id), 1, 4))
  );

  update public.track_pool tp
  set
    seen_count = tp.seen_count + 1,
    last_seen_at = now()
  where tp.track_id = v_new_track_id;

  return query
  select
    tp.track_id,
    tp.artwork_url,
    rst.seed
  from public.refine_session_tracks rst
  join public.track_pool tp
    on tp.track_id = rst.track_id
  where rst.session_token = p_session_token
    and rst.position = v_position_db;
end;
$$;

revoke all on function public.api_v1_session_replace_track(text, integer, text[]) from public, anon, authenticated;
grant execute on function public.api_v1_session_replace_track(text, integer, text[]) to service_role;
