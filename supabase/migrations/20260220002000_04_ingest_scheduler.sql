begin;

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare
  v_job_id bigint;
begin
  for v_job_id in
    select jobid
    from cron.job
    where jobname = 'ingest_every_6_hours'
  loop
    perform cron.unschedule(v_job_id);
  end loop;
end;
$$;

select cron.schedule(
  'ingest_every_6_hours',
  '0 */6 * * *',
  $$
  select
    net.http_post(
      url := 'https://ukqfnoemsifeiotqlxcp.supabase.co/functions/v1/ingest',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 10000
    );
  $$
);

create or replace function public.get_ingest_scheduler_status()
returns table (
  job_id bigint,
  job_name text,
  cron_schedule text,
  active boolean,
  command text
)
language sql
security definer
set search_path = public, cron
as $$
  select
    j.jobid as job_id,
    j.jobname as job_name,
    j.schedule as cron_schedule,
    j.active,
    j.command
  from cron.job j
  where j.jobname = 'ingest_every_6_hours'
  order by j.jobid desc
  limit 1;
$$;

revoke all on function public.get_ingest_scheduler_status() from public, anon, authenticated;
grant execute on function public.get_ingest_scheduler_status() to service_role;

commit;
