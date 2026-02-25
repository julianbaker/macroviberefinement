# MacroVibe Refinement — Codebase Documentation

> Comprehensive reference for contributors. Read this before making changes.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Repository Layout](#2-repository-layout)
3. [Tech Stack](#3-tech-stack)
4. [Frontend](#4-frontend)
   - 4.1 [Entry Point](#41-entry-point)
   - 4.2 [MobileGate.tsx — Mobile Device Gate](#42-mobilegatetsx--mobile-device-gate)
   - 4.3 [App.tsx — Main Component](#43-apptsx--main-component)
   - 4.4 [AudioEngine.ts](#44-audioenginets)
   - 4.5 [CrtWebglOverlay.tsx](#45-crtwebgloverlaytsx)
   - 4.6 [api.ts — HTTP Client](#46-apits--http-client)
   - 4.7 [styles.css — Design System](#47-stylescss--design-system)
5. [Backend — Supabase](#5-backend--supabase)
   - 5.1 [Database Schema](#51-database-schema)
   - 5.2 [Row-Level Security](#52-row-level-security)
   - 5.3 [Views and Stored Functions](#53-views-and-stored-functions)
   - 5.4 [Edge Function: api](#54-edge-function-api)
   - 5.5 [Edge Function: ingest](#55-edge-function-ingest)
   - 5.6 [Edge Function: audius-sync (archived)](#56-edge-function-audius-sync-archived)
   - 5.7 [Shared Utilities (_shared/)](#57-shared-utilities-_shared)
6. [Scripts](#6-scripts)
7. [Environment Variables](#7-environment-variables)
8. [Data Flows](#8-data-flows)
   - 8.1 [Session Init and Audio Unlock](#81-session-init-and-audio-unlock)
   - 8.2 [Placement Flow](#82-placement-flow)
   - 8.3 [Ingest Pipeline](#83-ingest-pipeline)
   - 8.4 [Audius Playlist Sync](#84-audius-playlist-sync)
9. [Key Design Decisions](#9-key-design-decisions)
10. [Development Workflow](#10-development-workflow)
11. [Configuration Reference](#11-configuration-reference)

---

## 1. Project Overview

MacroVibe Refinement (MVR) is a public web toy where users sort anonymized music snippets — sourced exclusively from [Audius](https://audius.co) — into six cryptic bins using a terminal-inspired, CRT-aesthetic interface. The design is deliberately opaque: users sort by "vibe feel" only. No track metadata (title, artist, genre) is ever shown in the refine interface.

**Core product pillars:**

| Pillar | Description |
|---|---|
| Opaque classification | Sort by feel, not by label |
| Mechanical ritual | Deliberate, weighted drag-and-throw interactions |
| Emergent consensus | Aggregate majority vote determines a track's canonical bin |
| Bias separation | Archive browsing cannot contaminate the refine flow |

**The six bins:** `VELLUM`, `BRINE`, `HEAT`, `STATIC`, `HALO`, `GRIT`

**Session model:** Fixed-batch "file" — you receive 64 cells (desktop) or 30 cells (mobile) at session start. No infinite refill. When all cells are placed, you can start a new file.

---

## 2. Repository Layout

```
macroviberefinement/
├── src/                        # Frontend — React + TypeScript
│   ├── main.tsx                # Vite entry point; mobile detection + routing
│   ├── App.tsx                 # Root component; all UI state and physics
│   ├── MobileGate.tsx          # Mobile device gate screen (CRT + bin links)
│   ├── AudioEngine.ts          # Web Audio API wrapper
│   ├── CrtWebglOverlay.tsx     # WebGL CRT post-process layer
│   ├── api.ts                  # Typed HTTP client for Edge Functions
│   ├── styles.css              # Full design-system CSS
│   ├── README.md               # Note: prior implementation removed; see docs/plans/
│   └── assets/
│       └── MVRLogo.svg
├── supabase/
│   ├── functions/
│   │   ├── api/index.ts        # Public REST API (session init, placements, archive)
│   │   ├── ingest/index.ts     # Audius playlist → track_pool ingest
│   │   ├── audius-sync/        # Supabase-side sync (deprecated; too large to bundle)
│   │   └── _shared/            # Shared utilities for Edge Functions
│   │       ├── env.ts          # Runtime config + secrets
│   │       ├── errors.ts       # Error code enum
│   │       ├── hash.ts         # HMAC-SHA256 helper
│   │       ├── http.ts         # Response builders
│   │       └── token.ts        # Session token resolution
│   └── migrations/             # Ordered SQL migrations (applied once, never modified)
│       ├── 20260219180000_01_schema.sql
│       ├── 20260219181000_02_rls.sql
│       ├── 20260219182000_03_views_and_functions.sql
│       ├── 20260220002000_04_ingest_scheduler.sql
│       ├── 20260220010000_05_genre_filter.sql
│       ├── 20260220050000_06_audius_sync.sql
│       └── 20260220060000_07_remove_audius_cron.sql
├── scripts/
│   ├── audius-sync.mjs         # Node.js hourly sync script (replaces Edge Function)
│   └── package.json
├── docs/
│   ├── plans/                  # Architectural and planning documents
│   ├── contracts/              # API v1 contract freeze and test specs
│   ├── ops/                    # Operational runbooks
│   └── evidence/               # Visual parity screenshots by phase
├── tests/
│   └── contracts/
│       └── api-v1.contract.test.mjs  # API contract tests
├── public/                     # Static assets (favicons, manifest)
├── index.html
├── vite.config.ts
├── tsconfig.json
└── package.json
```

---

## 3. Tech Stack

| Layer | Technology |
|---|---|
| Frontend framework | React 19 + TypeScript |
| Build tool | Vite 7 |
| Styling | Vanilla CSS (no CSS-in-JS, no utility framework) |
| Audio | Web Audio API (decoded PCM buffers, no `<audio>` element) |
| Visual effects | WebGL 1.0 (full-screen CRT post-process shader) |
| Backend runtime | Supabase Edge Functions (Deno) |
| Database | Supabase Postgres (PostgreSQL 15) |
| Auth | None — fully public, no user accounts |
| External data source | Audius public API (`api.audius.co/v1`) |
| Audius SDK | `@audius/sdk@11` (Node.js scripts only) |
| Deployment — Frontend | Vercel (recommended) |
| Deployment — Backend | Supabase project per environment |

---

## 4. Frontend

### 4.1 Entry Point

`src/main.tsx` evaluates `window.innerWidth <= 980` **once at load** (matching the CSS breakpoint) and renders either `<MobileGate />` or `<App />` into `#root`. There is no live resize switching — the check is intentionally a one-shot snapshot. There are no routing libraries, context providers, or global stores.

### 4.2 MobileGate.tsx — Mobile Device Gate

Rendered on viewports ≤ 980px wide. Informs users that the refine interface requires a desktop workstation and offers the six bin playlists as direct Audius links.

#### Architecture

- Uses `CrtWebglOverlay` with a custom `drawContent` callback — no audio phase or refine-UI props are passed.
- The `drawContent` function renders: logo, a divider line, a message block, and a 2 × 3 bin grid with accent-coloured index numbers and "OPEN ↗" hints. Layout is fully adaptive — every section is anchored to the bottom of the previous one so nothing overflows at any frame height.
- Invisible `<a>` tap targets are positioned in the DOM to match the CRT-drawn bin rectangles exactly. The coordinates are computed in the render closure using the same arithmetic as `drawContent`, keyed off `frameSize` (updated via `ResizeObserver`).
- DOM fallback: when WebGL has not yet initialised (`crtStatus !== "ready"`), a `.mobile-gate-dom-fallback` div renders the logo, message, and bin links without any CRT effect.

#### Constants

| Constant | Value | Notes |
|---|---|---|
| `BIN_CODES` | `["VELLUM","BRINE","HEAT","STATIC","HALO","GRIT"]` | Same order as App.tsx |
| `BIN_PLAYLIST_URLS` | Map of bin code → Audius URL | Shared with App.tsx |
| `ACCENT` | `["#77DB70","#F1EB5A","#FE7BD9","#1A3DF5"]` | Per-bin accent colours (indices 0–3) |
| `LOGO_ASPECT` | `1197 / 625` | SVG intrinsic aspect ratio |
| `MESSAGE_LINES` | 5-line copy array | "Mobile devices are not permitted…" |

### 4.3 App.tsx — Main Component

`App.tsx` is the single root component. All UI state is local React state or refs — there is no external state library.

#### 4.3.1 Constants

```
BIN_CODES        — ["VELLUM","BRINE","HEAT","STATIC","HALO","GRIT"]
BIN_PLAYLIST_URLS — Audius playlist links per bin (clicked from bin shelf)
BIN_METERS       — baseline meter fill percentages per bin
SESSION_SIZE_MAX — 64 (desktop target)
FLUID_ROW_COUNTS — [7,8,6,8,7,8,6,7,7] — slot layout grid
```

#### 4.3.2 Type Definitions

| Type | Purpose |
|---|---|
| `Cell` | A single refine unit: index, trackId, code, float/drift parameters |
| `CellLayout` | `{x, y, width, height}` — computed absolute position in grid |
| `CellNode` | `CellLayout` extended with velocity `vx/vy` and home position for physics |
| `DragState` | Live state of a cell being dragged: position, scale, which bin it hovers over |
| `ThrowState` | State driving the fly-to-bin animation after drag release |
| `AudioPhase` | `"locked" | "preloading" | "ready"` — audio readiness state |

#### 4.3.3 `makeCode(seed)`

Generates the 4-character alphanumeric code displayed on each cell (e.g. `"A3F7"`). Uses FNV-1a hash over the track's `seed` string returned by the API. This is deterministic per track — the same track always displays the same code within a session.

#### 4.3.4 `buildCellsFromTracks(tracks)`

Maps API `SessionTrack[]` to `Cell[]`. Assigns deterministic float/drift animation parameters from the cell index using modular arithmetic — no `Math.random()` here, so layout is stable across re-renders.

#### 4.3.5 `FLUID_SLOTS` (module-level constant)

Pre-computes normalized `{x, y}` slot positions for up to ~58 cells using the `FLUID_ROW_COUNTS` grid. These are used as "home" positions for the physics simulation. Slot positions have small per-cell wobble offsets baked in to avoid a perfectly uniform grid appearance.

#### 4.3.6 `buildHomeLayout(width, height, cells)`

Converts normalized slot positions to pixel coordinates for the current grid size. Called whenever the grid is resized or cells change.

#### 4.3.7 `getCellScale(cellId, hoveredCellId, layoutByCell, isDragging)`

Returns a CSS scale factor for a cell based on its distance from the currently hovered cell. Hover causes the hovered cell to scale up (`1.35×`) and nearby cells to scale slightly (`1.12×` and `1.06×`). Has no effect while dragging.

#### 4.3.8 Physics Loop (`useEffect` on `activeCellIds`)

Runs every `requestAnimationFrame`. Each active (unplaced) cell is treated as a particle with velocity:

1. **Home attraction** — soft spring pulling each cell toward its slot position.
2. **Orbit** — sinusoidal drift around the home position (unique per-cell phase).
3. **Flow field** — mild wave-based force across the grid.
4. **Cell-to-cell repulsion** — prevents overlap within `repelRadius`.
5. **Pointer repulsion** — cells scatter from the cursor when it enters the grid.
6. **Hover push** — cells nearest the hovered cell are pushed gently outward.
7. **Boundary bounce** — cells reverse direction with damping when hitting grid edges.

Layout commits to React state at ≤30 fps (`33.3 ms` throttle) unless drag or throw is active.

#### 4.3.9 Audio Unlock Flow

The Web Audio API requires a user gesture before `AudioContext` can be created. The flow:

1. On mount, `api.sessionInit()` is called **speculatively** (before any user gesture) to hide API latency. The result is stored in `prefetchRef`.
2. When the user clicks **BEGIN REFINEMENT**, `handleUnlock()` runs inside the click handler: creates `AudioContext`, awaits the pre-fetched session data (or fetches fresh), then calls `initSession()`.
3. `initSession()` sets audio phase to `"preloading"`, calls `AudioEngine.preload()`, then sets phase to `"ready"`.

#### 4.3.10 `startThrowAnimation(source)`

Animates a cell flying from its drag release point to the target bin over `THROW_X_MS = 280 ms` (X axis) and `THROW_Y_MS = 340 ms` (Y axis), with a small parabolic arc on Y. On completion:

- The cell is **optimistically sealed** (added to `placedBins`).
- `api.submitPlacement()` is called. If it fails (except `DUPLICATE_PLACEMENT`), the placement is reverted and a status message is shown.
- The audio voice for the placed track is faded out.

#### 4.3.11 Session Reset

Clicking **START NEW FILE** calls `initSession(true, null)`, which passes `reset=1` to the API. This mints a new session token and fetches a fresh track batch.

#### 4.3.12 Completion Detection

`isComplete = cells.length > 0 && placedCount >= sessionSize`. When true, a full-frame overlay with the reset button is rendered.

---

### 4.4 AudioEngine.ts

A minimal Web Audio API wrapper. Audio plays only on hover — there is no background music or persistent playback.

#### Architecture

- One `AudioContext` per session (created on user gesture).
- A `masterGain` node at `0.88` volume routes all voices to `ctx.destination`.
- `buffers: Map<trackId, AudioBuffer>` — decoded PCM data per track.
- `voices: Voice[]` — active `{source, gain}` pairs, max `MAX_VOICES = 2`.

#### `preload(tracks, onProgress, onUpgradeProgress)`

Two-phase loading:

**Phase 1 (gate blocks):** Fetches the first `524,287 bytes` (~30 s of 128 kbps MP3) of each track's stream URL via HTTP Range request. Falls back to a full fetch if the server doesn't support Range. Up to 8 tracks are loaded concurrently. Reports progress via `onProgress(loaded, total)`. The audio gate does not open until all tracks complete Phase 1.

**Phase 2 (background, fire-and-forget):** Fetches the full audio file for each track in the background after the gate opens. Buffers are swapped in-place in `this.buffers`. The next `hoverIn()` call automatically uses the upgraded buffer. Phase 2 only runs when the caller provides the optional `onUpgradeProgress` callback — `App.tsx` passes this callback; any caller that omits it skips background upgrading entirely.

Retry policy differs by phase:
- **Phase 1** — up to 2 retries, 800 ms base delay. Keeps total gate time predictable.
- **Phase 2** — up to 3 retries, 1000 ms base delay. More tolerant since it runs off the critical path.

HTTP 4xx errors other than 429 are not retried in either phase.

#### `hoverIn(trackId)` / `hoverOut(trackId)`

- `hoverIn` starts looped playback from the virtual session playhead offset (`elapsed % buffer.duration`) with a `120 ms` fade-in ramp.
- `hoverOut` fades out the voice over `150 ms` then stops the source.
- If `MAX_VOICES` (2) would be exceeded, the oldest voice is evicted before adding the new one.

#### `stopAll()`

Fades out all active voices (called on pointer leave, drag cancel, and session reset).

---

### 4.5 CrtWebglOverlay.tsx

A `position: fixed; inset: 0; z-index: 40` WebGL canvas that applies a CRT post-process effect to the entire `refine-frame` element. It is the **primary visual surface** — when WebGL initializes successfully, the DOM `refine-frame` is made `opacity: 0` (CSS class `refine-frame-proxy`) and all drawing happens on the WebGL canvas.

#### Rendering Pipeline

1. **Source canvas** (`2D canvas`, scaled at `SOURCE_SCALE = 0.72×`) — rendered at `SOURCE_FPS = 30` fps using the Canvas 2D API.
2. The source canvas is uploaded to a WebGL texture each source frame.
3. The WebGL shader reads the texture and applies all CRT effects per-pixel.

#### CRT Shader Effects (`FRAGMENT_SHADER`)

| Uniform | Effect |
|---|---|
| `scanlineIntensity / scanlineCount` | Horizontal scanlines (sinusoidal mask) |
| `adaptiveIntensity` | Varies scanline strength by vertical position |
| `brightness / contrast / saturation` | Color grading |
| `bloomIntensity / bloomThreshold` | Glow for bright pixels (5-tap cross sample) |
| `rgbShift` | Chromatic aberration (R and B shift laterally) |
| `vignetteStrength` | Corner darkening |
| `curvature` | Screen bow (barrel distortion) |
| `flickerStrength` | High-frequency luminance flicker |
| `time` | Drives flicker animation |

The shader only renders within `uFrameRect` (the bounding box of `refine-frame`). Pixels outside the frame are drawn solid black.

#### Source Canvas Dispatch (`draw` function)

Each source frame, one of three 2D drawing functions is called based on `audioPhase`:

| Phase | Function | What it draws |
|---|---|---|
| `"locked"` | `drawGateScreen` | Logo + "BEGIN REFINEMENT" button |
| `"preloading"` | `drawPreloadScreen` | Logo + progress bar + counter |
| `"ready"` | `drawSourceSurface` | Full refine UI: header, grid cells, bins, status bar |

#### Bin Open Animation

Each bin has a smoothed `binOpenAmount` (0–1) that tracks toward 1 when a dragged cell hovers over it. Animated via exponential approach: `amount += (target - amount) * (1 - exp(-dt * 24))`. The bin lid flaps and mouth rendering in the 2D canvas react to this value.

#### Gate / Preload Overlay (DOM layer)

The DOM renders an `audio-gate-overlay` div (`z-index: 50`) on top of the CRT canvas for the locked and preloading phases. When CRT is ready, this overlay becomes transparent (`opacity: 0`) so the CRT-drawn visual shows through, while the button element remains the active pointer-event target (accessible and keyboard-navigable).

#### `drawContent` Prop

The component accepts an optional `drawContent(ctx, frameWidth, frameHeight)` callback that completely replaces the built-in draw dispatch. This is used by archive and any future views to render custom content through the same CRT pipeline.

#### Fallback Behavior

If WebGL context creation fails, `onStatusChange("failed")` is called and the component reports `is-failed`. The DOM `refine-frame` remains fully visible as a non-CRT fallback.

---

### 4.6 api.ts — HTTP Client

A minimal typed fetch wrapper. All API calls go through `apiFetch<T>()`.

#### Configuration

| Variable | Default | Description |
|---|---|---|
| `VITE_FUNCTION_BASE_URL` | `""` | Base URL for Edge Function host |
| `VITE_API_BASE_PATH` | `"/api/v1"` | API path prefix |

#### Methods

| Method | Signature | Description |
|---|---|---|
| `api.sessionInit(device, reset?)` | `GET /session/init` | Fetch a new (or existing) session |
| `api.submitPlacement(request)` | `POST /placements` | Submit a bin assignment |
| `api.archiveBins()` | `GET /archive/bins` | List all bins with track counts |
| `api.archiveBinDetail(binCode)` | `GET /archive/bin/:code` | Tracks assigned to a specific bin |

All methods return `ApiResult<T>`:
- `{ ok: true, data: T }` on success
- `{ ok: false, statusCode: number, error: ApiError }` on failure

`ApiError` always has `code` (string) and `message` (string).

---

### 4.7 styles.css — Design System

#### Color Tokens

| Token | Value | Usage |
|---|---|---|
| `--color-on` | `#BEEEFF` | Primary foreground (phosphor blue-white) |
| `--color-off` | `#051021` | Background (near-black deep blue) |
| `--accent-wo` | `#77DB70` | Bin 1 VELLUM accent (green) |
| `--accent-fc` | `#F1EB5A` | Bin 2 BRINE accent (yellow) |
| `--accent-dr` | `#FE7BD9` | Bin 3 HEAT accent (pink) |
| `--accent-ma` | `#1A3DF5` | Bin 4 STATIC accent (blue) |

Opacity variants follow the pattern `--on-{pct}` (e.g. `--on-72` = `#BEEEFF` at 72% opacity) and `--off-{pct}` for the background color. These are never edited inline — always use tokens.

#### Typography

- Body/UI: **IBM Plex Mono** (400/500/600 weights) — loaded from Google Fonts
- Bin codes: **Archivo Narrow** (600 weight)

#### Layout

The shell uses a single CSS Grid column that fills the viewport. `.refine-frame` is sized to `min(93vw, 1340px)` width and nearly full-height, using `grid-template-rows: 3.5rem minmax(0, 1fr) 5.1rem 2.35rem` for header / grid / bins / status.

At `max-width: 980px`, the bin shelf collapses to 3 columns and the header bars are hidden.

#### Animation Keyframes

| Keyframe | Used by | Effect |
|---|---|---|
| `cell-float` | `.cell-wobble` | Idle cell float (CSS, per-cell duration/delay) |
| `bin-pulse` | `.bin.is-pulse` | Flash when a cell is dropped |
| `preload-blink` | `.preload-label`, `.status-alert` | Blinking step animation |
| `preload-cursor` | `.preload-bar-fill::after` | Blinking cursor on progress bar |

The scanline drift and CRT noise keyframes in CSS are vestiges — the CRT effect is driven entirely by the WebGL shader.

---

## 5. Backend — Supabase

### 5.1 Database Schema

All tables are in the `public` schema. Migrations are under `supabase/migrations/` and are applied in timestamp order. **Never edit an applied migration file** — add new migrations instead.

#### `bins`

The six fixed bins. Populated by seed data in migration `_01_schema.sql`.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `code_name` | text | Unique, uppercase (e.g. `"VELLUM"`) |
| `display_name` | text | Human-readable |
| `sort_order` | int | Unique, used for tie-breaking |
| `is_active` | bool | Soft-delete support |

#### `track_pool`

Every track sourced from Audius that has ever been eligible. Tracks are never hard-deleted.

| Column | Type | Notes |
|---|---|---|
| `track_id` | text | PK, Audius track ID |
| `source` | text | Always `"audius"` |
| `source_owner_handle` | text | Audius source handle |
| `title`, `artist_name`, `artwork_url`, `duration_sec` | nullable | Metadata (not shown in refine mode) |
| `is_active` | bool | Whether eligible for new sessions |
| `seen_count` | int | Times included in a session |
| `last_seen_at` | timestamptz | Last session appearance timestamp |
| `missing_runs` | int | Consecutive ingest runs absent from playlist |

Session selection favors tracks with lowest `seen_count`, then oldest `last_seen_at`, then random — ensuring even rotation.

#### `source_playlist_tracks`

The current snapshot of which tracks are in which playlists. Completely replaced on every healthy ingest run. This is the allowlist — only tracks present here can appear in sessions.

| Column | Type | Notes |
|---|---|---|
| `source_owner_handle` | text | |
| `playlist_id` | text | Audius playlist ID |
| `playlist_name` | text | |
| `track_id` | text | |
| PK | `(source_owner_handle, playlist_id, track_id)` | |

#### `refine_sessions`

One row per session token.

| Column | Type | Notes |
|---|---|---|
| `session_token` | text | PK (UUID without hyphens) |
| `device` | text | `"desktop"` or `"mobile"` |
| `session_size` | int | Actual batch size (may be < target if pool is degraded) |
| `degraded` | bool | True when pool has fewer tracks than target |
| `source_owner_handle` | text | The allowlist handle used |

#### `refine_session_tracks`

The tracks included in each session, with a deterministic ordering.

| Column | Type | Notes |
|---|---|---|
| `session_token` | text | FK → `refine_sessions` |
| `track_id` | text | FK → `track_pool` |
| `position` | int | 1-based display order |
| `seed` | text | `upper(substr(md5(track_id), 1, 4))` — used to generate the cell code |

#### `placements`

The canonical placement record. One row per `(track_id, session_token)` — the unique constraint enforces no duplicate placements.

| Column | Type | Notes |
|---|---|---|
| `track_id` | text | FK → `track_pool` |
| `bin_id` | uuid | FK → `bins` |
| `session_token` | text | FK → `refine_sessions` |
| `ip_hash` | text | HMAC-SHA256 of client IP |
| `ua_hash` | text | HMAC-SHA256 of User-Agent |
| `latency_ms` | int | Optional: time from hover start to drag release |
| `is_valid` | bool | Reserved for future moderation |

#### `placement_attempts`

The rate-limit ledger. Every placement attempt — accepted or rejected — appends a row here. Rows older than 7 days are pruned by a scheduled function.

| Column | Type | Notes |
|---|---|---|
| `session_token` | text | |
| `ip_hash` | text | |
| `track_id` | text | nullable |
| `result` | text | `"accepted"` or `"rejected"` |
| `reason` | text | `ok / too_fast / rate_limited / duplicate / invalid / placements_disabled / session_token_mismatch` |

#### `ingest_runs`

Audit log of every ingest function invocation.

| Column | Type | Notes |
|---|---|---|
| `healthy` | bool | Whether the run was considered safe to apply |
| `source_resolved` | bool | Whether the Audius user was found |
| `pagination_complete` | bool | Whether all playlist pages were fetched |
| `playlist_count` | int | Number of playlists found |
| `track_count` | int | Number of unique tracks in the snapshot |
| `applied_snapshot` | bool | Whether the allowlist was updated |
| `error_code`, `error_message` | nullable | Only on failure |

#### `audius_bin_playlists`

Maps each bin code to its corresponding Audius playlist ID. Populated once via the setup mode of `audius-sync`.

#### `audius_published_tracks`

The current state of what tracks are actually published into Audius playlists. Used by the sync script to compute diffs.

#### `audius_sync_runs`

Audit log of every sync run (mirrors `ingest_runs` pattern).

---

### 5.2 Row-Level Security

RLS is enabled on all tables. The `anon` and `authenticated` Supabase roles have **zero access** to any table. All access goes through Edge Functions using the `service_role` key.

The single policy per table is:
```sql
-- service_role can do everything; all other roles are blocked
CREATE POLICY <table>_service_role_full_access ON public.<table>
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

The public client never holds the `service_role` key — it communicates exclusively with Edge Functions via HTTP.

---

### 5.3 Views and Stored Functions

#### Views

| View | Description |
|---|---|
| `track_bin_counts` | Per-(track, bin) placement count and last placement time |
| `track_current_bin` | Each track's winning bin (majority vote, with tie-break) |
| `archive_bin_counts` | Per-bin track count (joined to `bins`) |
| `archive_tracks` | Full archive: bin assignment + metadata for active tracks |

**Tie-break rule** for `track_current_bin`:
1. Highest `count`
2. Latest `last_placed_at` among tied bins
3. Lowest `bins.sort_order`

#### `api_v1_init_session_batch(p_session_token, p_device, p_target_size, p_floor_size, p_source_owner_handle)`

The core session creation function. Uses a **transactional advisory lock** on the session token to prevent race conditions from parallel requests.

- If the session token already exists: updates `last_init_at` and returns the existing tracks (idempotent re-init).
- If new: checks available pool size, raises `INSUFFICIENT_POOL` if below `p_floor_size`.
- Selects `p_target_size` tracks sorted by `seen_count ASC, last_seen_at ASC NULLS FIRST, random()`.
- Inserts the session and track rows, increments `seen_count` on selected tracks.
- Returns `(track_id, artwork_url, seed, session_size, degraded)` rows.

#### `api_v1_submit_placement(...)`

The atomic placement function. Acquires advisory locks on both `session_token` and `ip_hash` before checking rate limits. Checks in order:
1. Bin validity (`INVALID_BIN`)
2. Track belongs to session and is still active (`INVALID_TRACK`)
3. Minimum interval check (`TOO_FAST`)
4. Per-session and per-IP rolling rate limits (`RATE_LIMITED`)
5. Duplicate check (handled by unique constraint catch → `DUPLICATE_PLACEMENT`)

Every code path inserts a row into `placement_attempts` before returning.

#### `api_v1_apply_allowlist_snapshot(p_source_owner_handle, p_snapshot_entries, p_track_rows, p_missing_run_threshold, p_run_healthy)`

Called by the ingest function after a successful run:
1. If `p_run_healthy = false`, returns early — the existing allowlist is preserved.
2. Deletes all `source_playlist_tracks` for the handle and replaces with the new snapshot.
3. Upserts `track_pool` rows (new tracks added; existing tracks' metadata refreshed, `missing_runs` reset to 0).
4. Increments `missing_runs` on tracks absent from the new snapshot; sets `is_active = false` once threshold is reached.

#### `api_v1_prune_placement_attempts()`

Deletes `placement_attempts` rows older than 7 days. Called on a schedule (migration `_04_ingest_scheduler.sql`).

---

### 5.4 Edge Function: api

**File:** `supabase/functions/api/index.ts`
**Runtime:** Deno

The sole public HTTP API. All routes are served from this single function.

#### Routes

| Method | Path | Handler |
|---|---|---|
| `GET` | `/api/v1/session/init?device=&reset=` | `handleSessionInit` |
| `POST` | `/api/v1/placements` | `handlePlacements` |
| `GET` | `/api/v1/archive/bins` | `handleArchiveBins` |
| `GET` | `/api/v1/archive/bin/:binCode` | `handleArchiveBinDetail` |

All routes return `OPTIONS 204` for CORS preflight.

#### `handleSessionInit`

1. Parses `device` and `reset` query params.
2. Derives the session token: re-use `X-Session-Token` header (unless `reset=1`), or mint a new UUID (hyphens stripped).
3. Calls `api_v1_init_session_batch` RPC.
4. On duplicate-key collision (race condition), mints a new token and retries once.
5. Builds `streamUrl` dynamically from config: `{audiusApiBaseUrl}/tracks/{trackId}/stream`.

#### `handlePlacements`

1. Validates request body fields.
2. Resolves session token from `X-Session-Token` header or body (header takes precedence; mismatch returns `SESSION_TOKEN_MISMATCH`).
3. Checks `placementsEnabled` flag — returns `PLACEMENTS_DISABLED` if false.
4. HMAC-hashes IP (`x-forwarded-for` or `cf-connecting-ip`) and User-Agent.
5. Calls `api_v1_submit_placement` RPC with rate-limit parameters from config.
6. Maps RPC result status to HTTP response.

#### `handleArchiveBins` / `handleArchiveBinDetail`

Read-only queries against the `archive_bin_counts` and `archive_tracks` views. No auth required.

---

### 5.5 Edge Function: ingest

**File:** `supabase/functions/ingest/index.ts`
**Runtime:** Deno

Fetches the current state of all playlists from the configured Audius source handle and updates the allowlist in the database.

#### `runIngest()` Steps

1. **Resolve source user ID** — looks up the Audius user by handle (`full/users/handle/` fallback).
2. **Paginate playlists** — fetches all playlists in pages of 100, collecting `(playlist_id, playlist_name, track_id)` tuples into `snapshotMap`.
3. **Resolve missing track metadata** — for any `track_id` in the snapshot that wasn't returned inline with the playlist, batches calls to `GET /tracks?id=...` in groups of 50.
4. **Evaluate health** — the run is "healthy" if: source was resolved, all pages were fetched, and `playlistCount >= minPlaylistsFloor`.
5. **Apply snapshot** — calls `api_v1_apply_allowlist_snapshot` RPC. If `healthy = false`, the function returns early and the existing allowlist is preserved.
6. **Log to `ingest_runs`** — always inserts a row, even on failure.

**Safety:** An unhealthy ingest run never modifies the allowlist. This prevents a temporary Audius API outage from wiping the track pool.

---

### 5.6 Edge Function: audius-sync (archived)

**File:** `supabase/functions/audius-sync/index.ts`

This Edge Function is **not deployable** — `@audius/sdk@11` exceeds the Supabase bundler size limit and times out during deployment. It exists as an archived reference only.

The sync logic has been ported to `scripts/audius-sync.mjs` (Node.js) and is run via GitHub Actions on an hourly cron schedule.

---

### 5.7 Shared Utilities (`_shared/`)

| File | Exports | Description |
|---|---|---|
| `env.ts` | `getRuntimeConfig()`, `getAudiusSyncConfig()` | Reads and validates environment variables; cached after first call |
| `errors.ts` | `ErrorCode` type | Union of all valid error code strings |
| `hash.ts` | `hmacSha256Hex(secret, data)` | HMAC-SHA256 using Web Crypto API |
| `http.ts` | `jsonResponse()`, `errorResponse()`, `preflightResponse()` | Response builders with CORS headers |
| `token.ts` | `resolveSessionToken(header, body)` | Enforces header-over-body precedence; returns mismatch error |

---

## 6. Scripts

### `scripts/audius-sync.mjs`

Node.js script that syncs the crowd-sourced bin assignments from Supabase to Audius playlists.

**Two modes:**

| `RUN_SETUP=true` | Creates 6 Audius playlists (one per bin) and records them in `audius_bin_playlists`. Idempotent. |
|---|---|
| _(default)_ | Hourly sync: diffs `archive_tracks` (desired) vs `audius_published_tracks` (current), applies add/remove/move operations. |

**Additional feature vs. the archived Edge Function:** The Node.js script also **evicts tracks deleted from Audius** — it calls `audiusSdk.tracks.getTrack()` for every published track in batches of 10 to check for `isDelete === true`, deactivates them in `track_pool`, and removes them from the desired set before diffing.

**Required environment variables:**
- `AUDIUS_API_KEY`
- `AUDIUS_API_SECRET`
- `AUDIUS_MANAGED_USER_ID`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

---

## 7. Environment Variables

### Frontend (Vite)

| Variable | Default | Description |
|---|---|---|
| `VITE_FUNCTION_BASE_URL` | `""` | Base URL of Edge Function host. Set to Supabase project URL in production. |
| `VITE_API_BASE_PATH` | `"/api/v1"` | Path prefix for all API calls. |

### Edge Functions / Backend (Deno)

| Variable | Required | Default | Description |
|---|---|---|---|
| `SUPABASE_URL` | ✓ | — | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | — | Service role secret for DB access |
| `REQUEST_HASH_SECRET` | ✓ | — | Secret for HMAC-SHA256 of IP and User-Agent |
| `AUDIUS_API_BASE_URL` | | `https://api.audius.co/v1` | Audius API base URL |
| `AUDIUS_SOURCE_HANDLE` | | `hotandnew` | Audius user handle to source playlists from |
| `MISSING_RUN_THRESHOLD` | | `2` | Consecutive ingest absences before deactivating a track |
| `MIN_PLAYLISTS_FLOOR` | | `20` | Minimum playlists required for a healthy ingest |
| `RATE_LIMIT_SESSION_PER_MIN` | | `40` | Max placement attempts per session per minute |
| `RATE_LIMIT_IP_PER_MIN` | | `120` | Max placement attempts per IP per minute |
| `RATE_LIMIT_MIN_INTERVAL_MS` | | `300` | Minimum ms between consecutive placements from the same session |
| `PLACEMENTS_ENABLED` | | `true` | Set to `false` to pause all placements (read-only mode) |

### Audius Sync Script (Node.js)

| Variable | Required | Description |
|---|---|---|
| `AUDIUS_API_KEY` | ✓ | Audius app API key |
| `AUDIUS_API_SECRET` | ✓ | Audius app API secret |
| `AUDIUS_MANAGED_USER_ID` | ✓ | Audius user ID that owns the bin playlists |
| `SUPABASE_URL` | ✓ | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | Service role key |
| `RUN_SETUP` | | Set to `"true"` for first-time playlist creation |

---

## 8. Data Flows

### 8.1 Session Init and Audio Unlock

```
Mount
  └─ prefetchRef = api.sessionInit("desktop", false)   [speculative, no AudioContext]

User clicks "BEGIN REFINEMENT"
  └─ handleUnlock()
       ├─ new AudioContext()                           [must be inside user gesture]
       ├─ await prefetchRef (or fresh fetch)
       └─ initSession(reset=false, prefetched)
            ├─ setAudioPhase("preloading")
            ├─ buildCellsFromTracks(tracks)
            ├─ AudioEngine.preload(trackMetas, onProgress, onUpgrade)
            │    ├─ Phase 1: Range fetch 512 KB per track (8 concurrent)
            │    └─ Phase 2: Full fetch per track (background, fire-and-forget)
            ├─ engine.startSession()
            └─ setAudioPhase("ready")
```

### 8.2 Placement Flow

```
User drags a cell
  └─ handleCellPointerDown → setDragState

While dragging
  └─ pointermove → update DragState.overBin (hit test against bin DOM rects)

User releases over a bin
  └─ startThrowAnimation(dragState)
       ├─ animate cell flying to bin (280 ms X, 340 ms Y)
       ├─ [on complete] optimistically setPlacedBins (cell sealed)
       ├─ audioEngine.hoverOut(cell.trackId)
       └─ api.submitPlacement({ sessionToken, trackId, binCode, clientTs, latencyMs })
            ├─ [success] placement confirmed
            └─ [failure, not DUPLICATE] revert placedBins + show status message

User releases over no bin
  └─ audioEngine.stopAll()    [no placement; cell returns to grid]
```

### 8.3 Ingest Pipeline

```
Trigger (HTTP POST to /ingest, or scheduled pg_cron)
  └─ resolveSourceUserId(audiusApiBaseUrl, sourceHandle)
  └─ fetchPlaylistsPage() × N pages
  └─ fetchTracksByIds() for missing metadata (batch 50)
  └─ evaluate health (source resolved + pagination complete + playlist count ≥ floor)
  └─ api_v1_apply_allowlist_snapshot(...)
       ├─ [healthy=false] no-op; existing allowlist preserved
       └─ [healthy=true]
            ├─ DELETE source_playlist_tracks WHERE source_owner_handle = handle
            ├─ INSERT new snapshot rows
            ├─ UPSERT track_pool (new tracks + refresh metadata + reset missing_runs)
            └─ INCREMENT missing_runs for absent tracks; deactivate at threshold
  └─ INSERT ingest_runs
```

### 8.4 Audius Playlist Sync

```
Hourly (scripts/audius-sync.mjs via GitHub Actions)
  └─ [RUN_SETUP=true] Create 6 playlists; populate audius_bin_playlists
  └─ [sync mode]
       ├─ Load playlist map (audius_bin_playlists)
       ├─ Load desired state (archive_tracks view)
       ├─ Load current state (audius_published_tracks)
       ├─ Check published tracks on Audius for isDelete; deactivate locally
       ├─ Compute diff (toAdd, toRemove, toMove)
       ├─ Apply: removeTrackFromPlaylist / addTrackToPlaylist via Audius SDK
       ├─ Update audius_published_tracks accordingly
       └─ INSERT audius_sync_runs
```

---

## 9. Key Design Decisions

### No User Accounts

The entire product is anonymous and unauthenticated. Sessions are identified by opaque tokens. IP and User-Agent are hashed server-side before storage, so no PII is persisted.

### Metadata Hidden in Refine Mode

The API returns `trackId`, `streamUrl`, `artworkUrl`, and `seed`. The frontend uses only `trackId` (for audio) and `seed` (to generate a cell code). Title, artist, and genre are intentionally never sent to the client during refinement.

### Two-Phase Audio Loading

Phase 1 (512 KB partial fetch) keeps the gate loading time short. Phase 2 (background full-file upgrade) ensures the best audio quality for longer hover sessions without blocking the user.

### Optimistic Placement with Revert

The cell is sealed immediately on throw completion to keep interactions feeling fast. The API call is fire-and-forget with a revert path only for hard failures. `DUPLICATE_PLACEMENT` errors are silently ignored (expected under retries).

### Physics Simulation Is Pure State

The physics loop reads from `physicsRef` (mutable ref, never causes re-renders) and commits computed positions to `displayLayoutByCell` React state at most 30 fps. This avoids 60 fps React reconciliation for pure motion. The only time it commits at full RAF rate is during drag or throw.

### WebGL as Primary Visual + DOM as Fallback

The DOM `refine-frame` is the authoritative layout reference. The WebGL canvas reads `frameRef.getBoundingClientRect()` to position itself correctly. When WebGL succeeds, the DOM frame becomes invisible (`opacity: 0`) and the canvas takes over as the visual layer. The DOM frame and its children remain fully interactive (pointer events pass through the CRT canvas overlay).

### Ingest Safety — Healthy Run Gate

The `api_v1_apply_allowlist_snapshot` function will not modify the allowlist unless `p_run_healthy = true`. An Audius API outage or paginator failure results in a logged error with zero allowlist changes — the existing session pool is preserved.

### Advisory Locks for Concurrency Safety

Both `api_v1_init_session_batch` and `api_v1_submit_placement` acquire PostgreSQL transactional advisory locks on derived keys before reading the rate-limit ledger and writing placement records. This ensures parallel requests from the same user cannot bypass rate limits.

### Bin Codes Are Fixed

`VELLUM`, `BRINE`, `HEAT`, `STATIC`, `HALO`, `GRIT` are encoded in the DB seed data, frontend constants, and Audius playlist names. Changing them requires a coordinated migration, frontend update, and Audius playlist recreation.

---

## 10. Development Workflow

### Frontend

```bash
# Install dependencies
npm install

# Start dev server (proxies to .env.local VITE_FUNCTION_BASE_URL)
npm run dev

# Type-check and build
npm run build

# Preview production build
npm run preview
```

Create a `.env.local` file with:
```
VITE_FUNCTION_BASE_URL=https://<your-supabase-project>.supabase.co/functions/v1
```

### Backend (Supabase)

```bash
# Apply migrations to local Supabase
supabase db push

# Deploy all Edge Functions
supabase functions deploy api
supabase functions deploy ingest

# Serve Edge Functions locally
supabase functions serve
```

### Running the Ingest Script Manually

```bash
cd scripts
npm install

# Full sync
AUDIUS_API_KEY=... AUDIUS_API_SECRET=... AUDIUS_MANAGED_USER_ID=... \
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
node audius-sync.mjs

# First-time setup (creates Audius playlists)
RUN_SETUP=true node audius-sync.mjs
```

### Contract Tests

```bash
# Run API v1 contract tests against a live or local endpoint
node tests/contracts/api-v1.contract.test.mjs
```

### Branch Naming

- Frontend changes: `fe/<milestone>-<topic>`
- Backend changes: `be/<milestone>-<topic>`

### PR Checklist (required before merge)

- [ ] Scope summary
- [ ] Changed endpoints or schema listed
- [ ] Test evidence (screenshot if UI, contract test output if API)
- [ ] FE: lint, typecheck, build pass
- [ ] BE: migration smoke, endpoint contract tests pass
- [ ] Squash merge

---

## 11. Configuration Reference

### `CRT_PARAMS` (CrtWebglOverlay.tsx)

These constants tune the visual CRT effect. Changing them affects every screen.

| Param | Value | Effect |
|---|---|---|
| `scanlineIntensity` | `0.5` | Strength of horizontal scanlines |
| `scanlineCount` | `256` | Number of scanlines across the frame height |
| `adaptiveIntensity` | `0.3` | How much scanline intensity varies by vertical position |
| `brightness` | `1.54` | Overall luminance boost |
| `contrast` | `1.05` | Contrast stretch |
| `saturation` | `1.09` | Color saturation |
| `bloomIntensity` | `0.72` | Glow strength for bright pixels |
| `bloomThreshold` | `0.42` | Luminance threshold for bloom trigger |
| `rgbShift` | `1.0` | Chromatic aberration magnitude |
| `vignetteStrength` | `0.67` | Corner darkening |
| `curvature` | `0.27` | Screen barrel distortion |
| `flickerStrength` | `0.015` | High-frequency luminance flicker |

### `AudioEngine` Constants

| Constant | Value | Description |
|---|---|---|
| `RAMP_IN_SEC` | `0.12` | Audio fade-in duration on hover |
| `RAMP_OUT_SEC` | `0.15` | Audio fade-out duration on hover leave |
| `MAX_VOICES` | `2` | Maximum simultaneous audio voices |
| `PRELOAD_CONCURRENCY` | `8` | Parallel track downloads during preload |
| `PARTIAL_BYTES` | `524287` | Byte range for Phase 1 partial fetch |

### Physics Constants (App.tsx)

| Constant | Value | Description |
|---|---|---|
| `THROW_X_MS` | `280` | Throw animation X-axis duration |
| `THROW_Y_MS` | `340` | Throw animation Y-axis duration |
| `THROW_TARGET_SCALE` | `0.44` | Cell scale at bin on throw completion |
| `SOURCE_SCALE` | `0.72` | CRT source canvas downscale factor |
| `SOURCE_FPS` | `30` | CRT source canvas max update rate |
