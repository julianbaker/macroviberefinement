# MacroVibe Refinement - Backend Execution Plan

## 1. Mission
Implement a deterministic, abuse-resistant backend for anonymous refinement sessions using a strict Audius allowlist and stable archive aggregation.

Master dependency:
- `/Users/julianbaker/Documents/Dropbox/dev/macroviberefinement/docs/plans/project-plan.md`

## 2. Locked Rules
- Bins fixed to 6 codenames in master plan.
- One placement per (`track_id`, `session_token`).
- Source allowlist:
  - only tracks present in playlists owned by `AUDIUS_SOURCE_HANDLE` (default `hotandnew`).
- Session size:
  - desktop 64, mobile 30.
- Session model:
  - fixed batch; no infinite refill endpoint.
- Majority assignment tie-break:
  1. count desc
  2. last placement desc
  3. bin sort order asc

## 3. Platform and Runtime
- Supabase Postgres
- Supabase Edge Functions
- Scheduled ingest job (every 6h)
- API base path `/api/v1`

API naming convention:
- external JSON contract uses `camelCase`.
- SQL schema/view fields remain `snake_case`.

## 4. Schema
### 4.1 Tables
- `bins`
- `track_pool`
- `source_playlist_tracks`
- `placements`
- `placement_attempts`

### 4.2 Required Columns
`track_pool`:
- includes metadata fields but not canonical persisted stream URL.
- response `streamUrl` is generated from `track_id` at read time.

`source_playlist_tracks`:
- snapshot provenance of allowlisted membership.
- primary key (`source_owner_handle`, `playlist_id`, `track_id`).

`placement_attempts`:
- shared rate-limit ledger and abuse telemetry.

Hashing requirement:
- derive `ip_hash` and `ua_hash` using `HMAC-SHA256(value, REQUEST_HASH_SECRET)`.
- store hex digest (or fixed-length truncated hex) consistently across environments.

### 4.3 Required Constraints and Indexes
- unique: `placements(track_id, session_token)`
- index: `placements(session_token, created_at desc)`
- index: `placements(ip_hash, created_at desc)`
- index: `placements(track_id, created_at desc)`
- index: `placement_attempts(session_token, created_at desc)`
- index: `placement_attempts(ip_hash, created_at desc)`
- index: `track_pool(source_owner_handle, is_active, seen_count, last_seen_at)`

## 5. RLS and Access Model
- Enable RLS on all base tables.
- No public direct writes.
- Client access pattern:
  - FE calls Edge Functions only.
  - Edge Functions use service-role key.
- Policy intent:
  - `anon/authenticated` deny base-table mutation and direct base-table reads.

Verification checklist:
1. direct client insert to `placements` fails.
2. direct client select from `track_pool` fails.
3. Edge function can read/write as designed.

## 6. Derived Views
### 6.1 `track_bin_counts`
- aggregate valid placements by track/bin:
  - `track_id`, `bin_id`, `count`, `last_placed_at`

### 6.2 `track_current_bin`
- rank bins per track by tie-break rule.
- expose:
  - `track_id`
  - `current_bin_id`
  - `current_count`
  - `runner_up_count`
  - `assigned_at` (last placement time in winning bin)

Archive ordering:
- `assigned_at DESC`, then `track_id ASC`.

## 7. API Endpoints
Error envelope:
`{ "error": { "code": "STRING", "message": "STRING" } }`

### 7.1 `GET /api/v1/session/init`
Query:
- `device=desktop|mobile`
- `reset=0|1`

Behavior:
1. determine target count (64/30).
2. if `reset=1` mint new session token.
3. sample active allowlisted tracks weighted by low `seen_count`.
4. return unique track ids only.
5. generate `streamUrl` as `https://api.audius.co/v1/tracks/{track_id}/stream`.

Shortage behavior:
- if available >= floor (`24` desktop, `12` mobile):
  - return partial with `degraded=true`.
- else return `503 INSUFFICIENT_POOL`.

Response:
- `sessionToken`, `sessionSize`, `degraded`, `tracks[]`.

### 7.2 `POST /api/v1/placements`
Request:
- `sessionToken`
- `trackId`
- `binCode`
- `clientTs`
- optional `latencyMs`

Validation order:
1. request shape.
2. `PLACEMENTS_ENABLED` gate.
3. bin and track resolution.
4. session/IP timing and rate checks via `placement_attempts`.
5. insert into `placements` (unique constraint for duplicates).
6. log attempt result.

Session token precedence:
1. `X-Session-Token` header is authoritative when present.
2. fallback to body `sessionToken` only when header absent.
3. if both present and unequal, return `400 SESSION_TOKEN_MISMATCH`.

Success:
- `200 { "ok": true }`

Paused mode:
- if `PLACEMENTS_ENABLED=false`, return `503 PLACEMENTS_DISABLED`.

### 7.3 `GET /api/v1/archive/bins`
- returns active bins and current membership counts.

### 7.4 `GET /api/v1/archive/bin/:binCode`
- returns assigned tracks from `track_current_bin`.
- ordering fixed as defined above.
- response property name must be `assignedAt` (camelCase), mapped from SQL `assigned_at`.

### 7.5 Status Map
- `400 BAD_REQUEST`
- `400 SESSION_TOKEN_MISMATCH`
- `404 INVALID_BIN`, `INVALID_TRACK`
- `409 DUPLICATE_PLACEMENT`
- `429 TOO_FAST`, `RATE_LIMITED`
- `503 INSUFFICIENT_POOL`
- `503 PLACEMENTS_DISABLED`
- `500 SERVER_ERROR`

## 8. Rate Limiting and Abuse Logic
Threshold defaults:
- min interval per session: 300ms
- max attempts/min per session: 40
- max attempts/min per IP: 120

Algorithm (MVP):
1. hash IP/UA server-side.
2. open DB transaction.
3. acquire advisory transaction locks derived from `session_token` and `ip_hash`.
4. query recent `placement_attempts`.
5. reject if too fast or over cap.
6. write attempt record (`accepted` or `rejected` + reason).
7. on pass, insert placement in same transaction.

Retention:
- prune `placement_attempts` older than 7 days.

## 9. Ingest Pipeline
### 9.1 Source
- `AUDIUS_SOURCE_HANDLE` (default `hotandnew`).

### 9.2 Steps
1. resolve user by handle.
2. fetch all playlists with pagination (`limit=100`, increment offset until empty).
3. build playlist->track membership snapshot.
4. replace snapshot rows in `source_playlist_tracks` for handle.
5. derive track union and upsert into `track_pool`:
   - set `is_active=true`, `last_allowlisted_at=now()`, `missing_runs=0`.
6. for previously known tracks absent in current union:
   - increment `missing_runs`.
   - deactivate when `missing_runs >= MISSING_RUN_THRESHOLD`.
7. fetch/update metadata for union tracks.

### 9.3 Safety Gates
Only apply missing/deactivation logic on healthy ingest runs:
- source resolved
- full pagination completed
- playlist count >= `MIN_PLAYLISTS_FLOOR`

If unhealthy:
- keep prior allowlist active
- skip deactivation
- emit ingest error event

## 10. Session Semantics
- Init returns one fixed file for the session.
- Placement consumes a track for that session and cannot be repeated.
- FE determines completion when all tracks in session are placed/sealed.
- New file requires `session/init` with `reset=1`.

## 11. Observability
Required events:
- `session_init_success`
- `session_init_error`
- `placement_accept`
- `placement_reject`
- `rate_limit_triggered`
- `ingest_run_summary`
- `ingest_run_error`

Required metrics:
- attempt rejection rate
- duplicate rate
- active allowlist size
- session init degraded rate
- bin membership distribution

## 12. Test Plan
### 12.1 SQL
- tie-break correctness
- assigned_at correctness
- uniqueness and FK constraints
- RLS access checks

### 12.2 API
- endpoint status code mapping
- session sizes and degraded behavior
- placement duplicate handling
- rate-limit and too-fast enforcement
- archive ordering determinism

### 12.3 Ingest
- pagination over >100 playlists
- membership snapshot replacement correctness
- allowlist exclusion correctness
- unhealthy-run safety behavior

## 13. Delivery Sequence
1. migrations and indexes
2. RLS and policy verification
3. views
4. `/api/v1/session/init`
5. `/api/v1/placements`
6. archive endpoints
7. ingest job
8. telemetry and cleanup jobs

## 14. Deployment and Rollback
Staging gates before prod:
- migrations clean
- ingest healthy
- endpoint contract tests green

Rollback levers:
- set `PLACEMENTS_ENABLED=false`
- redeploy previous FE build
- preserve last known allowlist snapshot

## 15. Done Criteria
- all locked rules enforced
- API contract and statuses match master plan
- strict allowlist enforced end-to-end
- no direct public DB writes possible
- deterministic archive assignment and ordering
