begin;

create or replace function public.api_v1_session_results(
  p_session_token text
)
returns table (
  track_id text,
  consensus_bin_code text
)
language sql
security definer
set search_path = public
as $$
  select
    rst.track_id,
    b.code_name as consensus_bin_code
  from public.refine_session_tracks rst
  left join public.track_current_bin tcb
    on tcb.track_id = rst.track_id
  left join public.bins b
    on b.id = tcb.current_bin_id
  where rst.session_token = p_session_token
  order by rst.position;
$$;

revoke all on function public.api_v1_session_results(text) from public, anon, authenticated;
grant execute on function public.api_v1_session_results(text) to service_role;

commit;
