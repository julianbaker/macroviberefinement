# Ingest Scheduler Configuration

Project ref: `ukqfnoemsifeiotqlxcp`

Status: Active

Created by migration:
- `/Users/julianbaker/Documents/Dropbox/dev/macroviberefinement/supabase/migrations/20260220002000_04_ingest_scheduler.sql`

## Schedule
- Job name: `ingest_every_6_hours`
- Cron: `0 */6 * * *`
- Action: `net.http_post` to `https://ukqfnoemsifeiotqlxcp.supabase.co/functions/v1/ingest`
- Request body: `{}`
- Header: `Content-Type: application/json`
- Timeout: `10000ms`

## Activation verification
Verification RPC:
- `public.get_ingest_scheduler_status()`

Observed result:
```json
[
  {
    "job_id": 1,
    "job_name": "ingest_every_6_hours",
    "cron_schedule": "0 */6 * * *",
    "active": true,
    "command": "select net.http_post(...)"
  }
]
```

## Manual trigger
```bash
curl -sS -X POST "https://ukqfnoemsifeiotqlxcp.supabase.co/functions/v1/ingest"
```
