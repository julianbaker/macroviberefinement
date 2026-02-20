# Ingest Pipeline (Allowlist + Safety Gates)

## Function
- Edge function: `supabase/functions/ingest/index.ts`
- Uses `SUPABASE_SERVICE_ROLE_KEY` for all DB writes.

## Source of truth
- `AUDIUS_SOURCE_HANDLE` playlists only.
- Playlist-track provenance snapshot table: `public.source_playlist_tracks`.

## Pipeline steps
1. Resolve source user by handle.
2. Fetch playlists with pagination (`limit=100`, incrementing `offset` until empty).
3. Build playlist-track snapshot entries.
4. Build strict union of track IDs from those playlists.
5. Fetch missing track metadata for union IDs.
6. Apply DB snapshot via RPC `api_v1_apply_allowlist_snapshot`.

## Safety gates
A run is considered healthy only when all are true:
- source handle resolved,
- pagination completed,
- fetched playlist count >= `MIN_PLAYLISTS_FLOOR`.

If unhealthy:
- snapshot replacement is skipped,
- deactivation/missing-run updates are skipped,
- previous allowlist remains active.

## Missing-run deactivation logic
When healthy:
- union tracks are upserted in `track_pool` with `is_active=true`, `missing_runs=0`, `last_allowlisted_at=now()`.
- previously known tracks for source handle that are absent from current union get `missing_runs += 1`.
- tracks are deactivated when `missing_runs >= MISSING_RUN_THRESHOLD`.

## Observability
Each run writes `public.ingest_runs` with:
- health booleans,
- playlist and track counts,
- snapshot application status,
- error metadata when run fails.

Emitted events:
- `ingest_run_summary`
- `ingest_run_error`

## Invocation
```bash
curl -sS -X POST "${INGEST_FUNCTION_URL}"
```
