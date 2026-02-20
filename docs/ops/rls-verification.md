# RLS Verification Notes

## Scope
RLS is enabled on all base tables:
- `public.bins`
- `public.track_pool`
- `public.source_playlist_tracks`
- `public.refine_sessions`
- `public.refine_session_tracks`
- `public.placements`
- `public.placement_attempts`
- `public.ingest_runs`

No `anon`/`authenticated` policies are defined; only `service_role` has permissive policies.

## Verification Queries
Run these checks in SQL editor and with API clients.

1. Confirm RLS enabled:
```sql
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in (
    'bins',
    'track_pool',
    'source_playlist_tracks',
    'refine_sessions',
    'refine_session_tracks',
    'placements',
    'placement_attempts',
    'ingest_runs'
  )
order by tablename;
```

2. Confirm only `service_role` policies:
```sql
select schemaname, tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
  and tablename in (
    'bins',
    'track_pool',
    'source_playlist_tracks',
    'refine_sessions',
    'refine_session_tracks',
    'placements',
    'placement_attempts',
    'ingest_runs'
  )
order by tablename, policyname;
```

3. Confirm public role grants are revoked:
```sql
select table_schema, table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in (
    'bins',
    'track_pool',
    'source_playlist_tracks',
    'refine_sessions',
    'refine_session_tracks',
    'placements',
    'placement_attempts',
    'ingest_runs'
  )
  and grantee in ('anon', 'authenticated')
order by table_name, grantee;
```
Expected: zero rows.

4. Runtime check with anon key (should fail):
- `insert` into `placements` => denied.
- `select` from `track_pool` => denied.

5. Runtime check via edge functions using service-role key (should pass):
- `/api/v1/session/init` reads allowlisted tracks.
- `/api/v1/placements` writes `placements` and `placement_attempts`.

## Notes
- Derived views are not publicly exposed; only `service_role` gets `select` grants.
- Edge functions are the only supported public API surface.
