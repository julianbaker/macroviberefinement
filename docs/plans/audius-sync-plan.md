# MacroVibe Refinement - Audius Playlist Sync Plan

## 1. Objective

Publish the crowd-sourced bin assignments back to Audius as six managed playlists on the operator's Audius account. Each bin maps one-to-one to a playlist. The playlists stay in sync with the current majority-vote assignment of every track that has at least one placement.

This closes the data loop:

```
[Audius hotandnew]  →  [Ingest]  →  [track_pool]
                                          ↓
                              [Users refine / vote]
                                          ↓
                              [track_current_bin view]
                                          ↓
                      [audius-sync job]  →  [Audius playlists]
```

Master dependency:
- `/docs/plans/project-plan.md`
- `/docs/plans/backend-plan.md`

## 2. Locked Decisions

- **Bin-to-playlist mapping:** one Audius playlist per bin, named exactly after the bin code (`VELLUM`, `BRINE`, `HEAT`, `STATIC`, `HALO`, `GRIT`).
- **Eligibility threshold:** any track with a majority-vote assignment qualifies immediately — no minimum vote floor. A track with a single placement is eligible if that bin has the highest count.
- **Source of truth for assignments:** the existing `track_current_bin` view. No new aggregation logic is introduced.
- **One bin per track at a time:** if a track's winning bin changes, it is removed from the old playlist and added to the new one within the same sync run.
- **Sync interval:** hourly (replaces the 6-hour ingest interval for this job specifically).
- **Playlist ownership:** all six playlists are created on the operator's account at setup time and owned by that account permanently.
- **Audius SDK:** use `@audius/sdk` via `esm.sh` in the Deno Edge Function. If Deno-incompatible behaviour is discovered during implementation, fall back to direct Audius REST API calls with manual request signing.

## 3. New Secrets and Config

Three new environment variables are required. Add them to Supabase Vault / Edge Function secrets before running setup.

| Variable | Description |
|---|---|
| `AUDIUS_API_KEY` | Developer app API key from the Audius developer dashboard |
| `AUDIUS_API_SECRET` | Developer app API secret |
| `AUDIUS_MANAGED_USER_ID` | Audius user ID of the operator account that owns the playlists |
| `AUDIUS_SYNC_ENABLED` | `true\|false` — kill switch matching the `PLACEMENTS_ENABLED` pattern |

How to obtain credentials:
1. Create a developer app at https://audius.org/oauth/apps
2. Copy `API Key` and `API Secret`
3. Find your Audius user ID via your profile URL or `GET /v1/users/handle/{handle}`

Add `AUDIUS_SYNC_ENABLED` to `supabase/functions/_shared/env.ts` alongside the existing config fields.

## 4. Data Model

### 4.1 New Tables

**`audius_bin_playlists`** — maps each bin code to its Audius playlist ID. Populated once during setup, read on every sync run.

```
bin_code       text PRIMARY KEY REFERENCES bins(code_name)
playlist_id    text NOT NULL
playlist_name  text NOT NULL
created_at     timestamptz NOT NULL DEFAULT now()
```

**`audius_published_tracks`** — the last known published state. One row per track. Updated after each successful sync. The diff between this table and `track_current_bin` defines the work for each run.

```
track_id      text PRIMARY KEY
bin_code      text NOT NULL REFERENCES bins(code_name)
published_at  timestamptz NOT NULL DEFAULT now()
```

**`audius_sync_runs`** — history of sync attempts, mirroring the `ingest_runs` pattern.

```
id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY
started_at      timestamptz NOT NULL
finished_at     timestamptz
healthy         boolean
tracks_added    integer NOT NULL DEFAULT 0
tracks_removed  integer NOT NULL DEFAULT 0
tracks_moved    integer NOT NULL DEFAULT 0
error_code      text
error_message   text
metadata        jsonb
```

### 4.2 RLS

All three tables use the same model as existing tables:
- RLS enabled.
- `anon` and `authenticated` roles have no direct access.
- Only the Edge Function (service-role key) reads and writes.

## 5. Sync Runtime: GitHub Actions

> **Architecture note:** `@audius/sdk@11` bundles ethers.js and a full cryptographic signing stack. It exceeds the Supabase Edge Function bundler limit (bundle generation times out). The sync job runs as a **Node.js GitHub Actions workflow** instead. The Supabase data model (tables, views, RLS) is unchanged. The Edge Function stub at `supabase/functions/audius-sync/index.ts` is kept as reference but is not deployed.

Files:
- `scripts/audius-sync.mjs` — sync logic (Node.js ESM)
- `scripts/package.json` — dependencies (`@audius/sdk`, `@supabase/supabase-js`)
- `.github/workflows/audius-sync.yml` — hourly cron + manual trigger

### 5.1 Invocation Modes

| Mode | Trigger | Behaviour |
|---|---|---|
| `RUN_SETUP=true` | `workflow_dispatch` with `setup: true` | Creates the six Audius playlists, inserts rows into `audius_bin_playlists` |
| `RUN_SETUP=false` (default) | GitHub Actions hourly schedule | Runs the diff-and-sync algorithm |

Setup must be triggered once manually before the recurring sync is meaningful. It is idempotent: if a bin already has a row in `audius_bin_playlists`, the existing playlist ID is preserved and no new playlist is created.

### 5.2 Setup Mode Algorithm

```
FOR each bin in bins WHERE is_active = true ORDER BY sort_order:
  IF bin_code already exists in audius_bin_playlists:
    SKIP (preserve existing playlist_id)
  ELSE:
    CREATE Audius playlist named bin_code on AUDIUS_MANAGED_USER_ID
    INSERT INTO audius_bin_playlists (bin_code, playlist_id, playlist_name)
```

### 5.3 Sync Mode Algorithm

```
1. READ desired state
   SELECT track_id, bin_code
   FROM track_current_bin
   JOIN bins ON current_bin_id = bins.id
   (no vote floor — any majority winner qualifies)

2. READ current published state
   SELECT track_id, bin_code
   FROM audius_published_tracks

3. COMPUTE diff
   removals  = published - desired          (tracks no longer assigned)
   additions = desired - published          (newly assigned tracks)
   moves     = tracks where bin_code changed between published and desired
               (a move = removal from old bin + addition to new bin)

4. LOAD playlist IDs
   SELECT bin_code, playlist_id FROM audius_bin_playlists

5. EXECUTE Audius API calls (in order: removals first, then additions)
   FOR each removal: sdk.playlists.removeTrackFromPlaylist(...)
   FOR each addition: sdk.playlists.addTrackToPlaylist(...)
   Moved tracks are handled as removal + addition in the same pass.

6. UPDATE audius_published_tracks
   DELETE rows for removed tracks
   UPSERT rows for added/moved tracks

7. INSERT audius_sync_runs record
```

### 5.4 Error Handling

- Audius API errors for individual tracks do not abort the full run. Failed operations are logged and counted in `metadata`.
- If the playlist ID map cannot be loaded (setup not run), the function returns an error immediately without attempting any Audius calls.
- If `AUDIUS_SYNC_ENABLED=false`, the function returns `503 SYNC_DISABLED` immediately.
- The `healthy` flag on `audius_sync_runs` is `false` if any Audius API calls failed, `true` if all operations completed without error.

### 5.5 SDK Usage Pattern

```typescript
import { sdk } from "https://esm.sh/@audius/sdk";

const audiusSdk = sdk({
  appName: "MacroVibe Refinement",
  apiKey: config.audiusApiKey,
  apiSecret: config.audiusApiSecret,
});

// Add a track to a playlist
await audiusSdk.playlists.addTrackToPlaylist({
  userId: config.audiusManagedUserId,
  playlistId: playlistId,
  trackId: trackId,
});

// Remove a track from a playlist
await audiusSdk.playlists.removeTrackFromPlaylist({
  userId: config.audiusManagedUserId,
  playlistId: playlistId,
  trackId: trackId,
});
```

## 6. Schedule

Owned by GitHub Actions. The pg_cron schedule added in migration `06` is removed in migration `07`:

```yaml
on:
  schedule:
    - cron: "0 * * * *"   # every hour at :00
  workflow_dispatch:       # manual trigger — set setup: true for first run
```

## 7. Config

```typescript
audiusApiKey: string;        // AUDIUS_API_KEY
audiusApiSecret: string;     // AUDIUS_API_SECRET
audiusManagedUserId: string; // AUDIUS_MANAGED_USER_ID
audiusSyncEnabled: boolean;  // AUDIUS_SYNC_ENABLED
```

All four fields are required. The function throws on startup if any are missing, matching the existing `getRuntimeConfig()` pattern.

## 8. Observability

Required log events (matching the `logEvent` pattern used in `api/index.ts` and `ingest/index.ts`):

| Event | When |
|---|---|
| `audius_sync_start` | Sync run begins |
| `audius_sync_complete` | Run finishes with totals: added, removed, moved, failed |
| `audius_sync_error` | Unhandled error aborts the run |
| `audius_track_add_fail` | Individual track add fails (per-track) |
| `audius_track_remove_fail` | Individual track remove fails (per-track) |
| `audius_setup_complete` | Setup mode creates all playlists |

## 9. Delivery Sequence

1. ✅ Obtain Audius developer credentials and operator user ID.
2. ✅ Migration `06_audius_sync.sql` — tables, RLS (pg_cron schedule added then removed in `07`).
3. ✅ Migration `07_remove_audius_cron.sql` — removes pg_cron; GitHub Actions owns scheduling.
4. ✅ `_shared/env.ts` updated with `AudiusSyncConfig` / `getAudiusSyncConfig()`.
5. ✅ `scripts/audius-sync.mjs` + `scripts/package.json` created.
6. ✅ `.github/workflows/audius-sync.yml` created.
7. Add GitHub Actions secrets: `AUDIUS_API_KEY`, `AUDIUS_API_SECRET`, `AUDIUS_MANAGED_USER_ID`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
8. Trigger workflow manually with `setup: true` to create the six playlists.
9. Verify `audius_bin_playlists` has six rows and playlists appear on the Audius account.
10. Trigger one normal sync run and confirm `audius_sync_runs` shows `healthy: true`.
11. Confirm Audius playlists reflect `archive_tracks` state.
12. Hourly GitHub Actions cron takes over from that point.

## 10. Done Criteria

- Six playlists exist on the operator's Audius account, one per bin code.
- `audius_bin_playlists` has one row per bin.
- After a sync run, every track in `track_current_bin` appears in the correct Audius playlist.
- A track that changes bins is removed from the old playlist and added to the new one within one sync cycle.
- `audius_sync_runs` records are inserted for every run with accurate counts.
- `AUDIUS_SYNC_ENABLED=false` disables all sync without touching the cron schedule.
- No direct public DB writes are possible on the new tables.
- pg_cron runs hourly without intervention.
