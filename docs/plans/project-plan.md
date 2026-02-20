# MacroVibe Refinement - Master Project Plan

## 1. Objective
Build a public web toy where users sort anonymized music snippets into cryptic bins using an MDR-inspired terminal workflow. The product should feel ritualized and opaque, not like a normal music app.

## 2. Source Context
Primary ideation source:
- `/Users/julianbaker/Downloads/ChatGPT-Community Music Curation.md`

Normative UI companion:
- `/Users/julianbaker/Documents/Dropbox/dev/macroviberefinement/docs/plans/ui-spec.md`

Key intent preserved:
- public and no-auth MVP
- randomized session grids
- fixed cryptic bins
- strict source allowlist from Audius `hotandnew` playlists
- refine mode separated from archive mode to reduce curation bias
- no metadata reveal in refine mode for MVP

## 3. Product Pillars
1. Opaque classification:
   - sorting by feel, not explicit metadata.
2. Mechanical ritual:
   - deliberate, weighted interactions.
3. Emergent consensus:
   - meaning comes from aggregate behavior.
4. Bias separation:
   - archive browsing does not contaminate refine flow.

## 4. Locked MVP Decisions
- Bins:
  - `VELLUM`, `BRINE`, `HEAT`, `STATIC`, `HALO`, `GRIT`
- Grid size:
  - desktop `8x8` (64 cells), mobile 30 cells
- Refine metadata:
  - hidden
- Placement policy:
  - one placement per (`track_id`, `session_token`)
- Aggregation:
  - majority vote by count
  - tie-break:
    1. highest count
    2. latest placement among tied bins
    3. lowest bin `sort_order`
- Session model:
  - fixed-batch "file" per session (no infinite refill)
- Moderation:
  - out of scope for MVP

## 5. UI Canon Summary
- `/refine` must match the explicit layout, motion, and CRT requirements in `ui-spec.md`.
- Required visual treatment includes:
  - scanlines
  - corner vignette/distortion
  - subtle CRT flicker/noise
- Color system is locked to the reference palette:
  - `#BEEEFF` (on)
  - `#051021` (off)
  - `#77DB70`, `#F1EB5A`, `#FE7BD9`, `#1A3DF5` (category accents)
- No custom palette reinterpretation without explicit PM approval.
- Refine mode must never display title/artist/genre/popularity.

## 6. Experience Separation Rules
### 6.1 Refine Mode
- show only anonymous cell code, progress, bins, system status.
- hide consensus/popularity and archive ranking signals.

### 6.2 Archive Mode
- separate route and visual mode.
- show current bin assignment only.
- default deterministic ordering:
  - `assignedAt DESC`, then `trackId ASC`.

`assignedAt` definition:
- last placement timestamp for the track in its current winning bin.

## 7. Architecture
- Frontend:
  - React + TypeScript + Vite
  - Web Audio API
- Backend:
  - Supabase Postgres
  - Supabase Edge Functions (public API surface)
  - scheduled ingest job
- Source:
  - Audius API, handle `hotandnew`, playlist-union allowlist

## 7.1 Runtime Environments
- `local`
- `staging`
- `production`

Recommended hosting:
- FE: Vercel (preview/staging/prod)
- BE: Supabase project split by env

## 7.2 Secrets and Config
Required env vars:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `AUDIUS_API_BASE_URL` (default `https://api.audius.co/v1`)
- `AUDIUS_SOURCE_HANDLE` (default `hotandnew`)
- `MISSING_RUN_THRESHOLD` (default `2`)
- `MIN_PLAYLISTS_FLOOR` (default `20`)
- `RATE_LIMIT_SESSION_PER_MIN` (default `40`)
- `RATE_LIMIT_IP_PER_MIN` (default `120`)
- `RATE_LIMIT_MIN_INTERVAL_MS` (default `300`)
- `PLACEMENTS_ENABLED` (`true|false`)
- `REQUEST_HASH_SECRET` (required; HMAC secret for IP/UA hashing)

## 8. Data Model
### 8.1 Tables
- `bins`
  - `id` uuid pk
  - `code_name` text unique
  - `display_name` text
  - `sort_order` int unique
  - `is_active` bool
  - `created_at` timestamptz

- `track_pool`
  - `track_id` text pk
  - `source` text
  - `source_owner_handle` text
  - `title` text nullable
  - `artist_name` text nullable
  - `artwork_url` text nullable
  - `duration_sec` int nullable
  - `is_active` bool
  - `added_at` timestamptz
  - `last_seen_at` timestamptz
  - `seen_count` int default 0
  - `last_allowlisted_at` timestamptz
  - `missing_runs` int default 0

- `source_playlist_tracks` (allowlist provenance snapshot)
  - `source_owner_handle` text
  - `playlist_id` text
  - `playlist_name` text
  - `track_id` text
  - `observed_at` timestamptz
  - primary key (`source_owner_handle`, `playlist_id`, `track_id`)

- `placements`
  - `id` uuid pk
  - `created_at` timestamptz
  - `track_id` text fk
  - `bin_id` uuid fk
  - `session_token` text
  - `ip_hash` text
  - `ua_hash` text
  - `latency_ms` int nullable
  - `is_valid` bool default true
  - unique (`track_id`, `session_token`)

- `placement_attempts` (rate-limit ledger)
  - `id` uuid pk
  - `created_at` timestamptz
  - `session_token` text
  - `ip_hash` text
  - `track_id` text nullable
  - `result` text (`accepted|rejected`)
  - `reason` text (`ok|too_fast|rate_limited|duplicate|invalid`)

### 8.2 Derived Views
- `track_bin_counts`
  - `track_id`, `bin_id`, `count`, `last_placed_at`
- `track_current_bin`
  - `track_id`, `current_bin_id`, `current_count`, `runner_up_count`, `assigned_at`

## 9. API Contract (Normative)
Base path:
- `/api/v1`

Error envelope:
`{ "error": { "code": "STRING", "message": "STRING" } }`

API field naming convention:
- JSON responses and requests use `camelCase`.
- DB schema/view internals may use `snake_case`.

Session token transport:
- request header: `X-Session-Token` (preferred)
- response includes `sessionToken` for first-init or reset flows

Session token precedence:
1. if `X-Session-Token` header exists, it is authoritative.
2. if header missing, server may use body `sessionToken`.
3. if both exist and differ, return `400 SESSION_TOKEN_MISMATCH`.

### 9.1 `GET /api/v1/session/init?device=desktop|mobile&reset=0|1`
Behavior:
- `device=desktop` target size 64.
- `device=mobile` target size 30.
- `reset=1` forces a new session token and new batch.
- samples only from active allowlisted tracks.

Response `200`:
- `sessionToken`
- `sessionSize`
- `degraded` boolean
- `tracks[]`:
  - `trackId`
  - `streamUrl` (computed on response; not persisted canonical DB field)
  - `artworkUrl`
  - `seed`

Pool shortage behavior:
- if available tracks >= floor (`24` desktop / `12` mobile):
  - return partial batch and `degraded=true`
- else:
  - `503` with `INSUFFICIENT_POOL`

### 9.2 `POST /api/v1/placements`
Request:
- `sessionToken`
- `trackId`
- `binCode`
- `clientTs`
- `latencyMs` optional

Success:
- `200 { "ok": true }`

If placements are paused:
- `503 { "error": { "code": "PLACEMENTS_DISABLED", ... } }`

### 9.3 `GET /api/v1/archive/bins`
Response `200`:
- `bins`: `{ code, displayName, count }[]`

### 9.4 `GET /api/v1/archive/bin/:binCode`
Response `200`:
- `bin`
- `tracks`: `{ trackId, streamUrl, artworkUrl, assignedAt }[]`

### 9.5 HTTP Status and Error Mapping
- `400` -> `BAD_REQUEST`
- `400` -> `SESSION_TOKEN_MISMATCH`
- `404` -> `INVALID_BIN`, `INVALID_TRACK`
- `409` -> `DUPLICATE_PLACEMENT`
- `429` -> `TOO_FAST`, `RATE_LIMITED`
- `503` -> `INSUFFICIENT_POOL`
- `503` -> `PLACEMENTS_DISABLED`
- `500` -> `SERVER_ERROR`

## 10. Security and Abuse Controls
### 10.1 Supabase Access Model
- Enable RLS on all base tables.
- `anon` and `authenticated` roles:
  - no direct `INSERT/UPDATE/DELETE` on `placements`, `track_pool`, `source_playlist_tracks`, `placement_attempts`, `bins`.
  - no direct base-table reads required by client.
- Public client talks only to Edge Functions.
- Edge Functions use service-role key and enforce validation.

### 10.2 Rate Limiting Strategy (MVP)
Storage:
- use `placement_attempts` as shared ledger.

Algorithm:
1. hash IP and user-agent server-side.
2. read recent attempt windows by `session_token` and `ip_hash`.
3. enforce:
   - min interval (`RATE_LIMIT_MIN_INTERVAL_MS`)
   - max attempts/min per session and per IP
4. write attempt row with result/reason.
5. on pass, insert `placements` row (unique constraint enforces single placement per track/session).

Concurrency requirement:
- rate-limit check and placement insert must run in one DB transaction.
- acquire transactional advisory lock on `session_token` and `ip_hash` derived keys before checking windows to prevent parallel-request bypass.

Retention:
- scheduled cleanup for attempts older than 7 days.

### 10.3 Source Integrity Controls
- ingest uses full pagination and full union recompute.
- apply deactivation only on healthy runs.
- unhealthy run:
  - keep previous allowlist active
  - log error reason

## 11. Session Lifecycle (MVP)
- Session is a fixed file:
  - user receives one batch at init.
  - no infinite track refill.
- On successful placement:
  - cell becomes sealed/non-interactive.
- Completion:
  - when sealed count equals session size.
  - UI offers `Start New File`, which calls `session/init` with `reset=1`.

## 12. Delivery Plan
### M0
- repo scaffold, env template, migrations baseline, API stubs

### M1
- backend schema + views + ingest + `/api/v1` endpoints

### M2
- refine UI + CRT + audio unlock + placement flow
- current FE gate before full audio phase:
  - WebGL fallback must preserve visible/interactive DOM UI when WebGL fails
  - concise Phase 2 checklist required (motion capture not required)

### M3
- archive views + anti-abuse tuning + observability

### M4
- QA, staging sign-off, production launch readiness

## 13. Execution Rails (Team Process)
- Branch naming:
  - FE: `fe/<milestone>-<topic>`
  - BE: `be/<milestone>-<topic>`
- PR checklist required:
  - scope summary
  - changed endpoints/schemas
  - test evidence
  - lightweight UI evidence (checklist plus still screenshot when needed)
- Required checks before merge:
  - FE: lint, typecheck, tests, build
  - BE: lint/tests, migration smoke, endpoint contract tests
- Merge strategy:
  - squash merge
- Daily agent status format:
  - completed
  - blockers
  - next 24h

## 14. Deployment and Rollback
- Staging first for every milestone.
- Production rollout gates:
  - API contract verified
  - ingest healthy
  - refine and archive smoke tests pass
- Rollback levers:
  - set `PLACEMENTS_ENABLED=false` for read-only mode
  - revert FE deployment to previous build
  - keep existing allowlist snapshot if ingest is failing

## 15. Acceptance Criteria
- UI matches `ui-spec.md`, including CRT layer.
- Refine mode shows no metadata.
- Session and placement policies are enforced deterministically.
- Only allowlisted tracks appear in refine/archive.
- API status codes and error codes match contract.
- RLS and service-role boundaries verified.
- Staging and production runbooks are documented.

## 16. Post-MVP
- Optional metadata reveal mechanism
- rotating bins/seasons
- richer assignment logic
- curator/admin capabilities
