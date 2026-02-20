begin;

-- Remove pg_cron schedule for audius sync.
-- The sync job is now run by a GitHub Actions workflow on an hourly cron.
-- The audius_* tables created in migration 06 are kept as-is.

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

commit;
