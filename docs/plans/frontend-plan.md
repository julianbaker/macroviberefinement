# MacroVibe Refinement - Frontend Restart Plan

## 0. Current State (CTO)
1. Phase 0 approved.
2. Phase 1 approved, including locked palette parity.
3. Phase 2 is functionally close but not fully closed.
4. Remaining Phase 2 gate items:
   - WebGL failure fallback must keep refine UI visible and interactive.
   - Submit concise Phase 2 checklist (no motion capture requirement).

## 1. Mission
Rebuild the frontend from zero using a strict reference-first process.  
Primary success criterion is MDR-style visual and interaction fidelity, then backend contract integration.

## 2. Required Inputs
Read in this exact order before writing code:
1. `docs/plans/project-plan.md`
2. `docs/plans/ui-spec.md`
3. frozen backend contract artifact from BE IC (`api-v1-contract-freeze.md` or equivalent)
4. frontend integration handoff artifact from BE IC (`frontend-integration-handoff.md` or equivalent)
5. Medium article reference used by PM.
6. Git reference linked from that article.

## 3. Non-Negotiable Rules
1. No approximation phase. Reference parity is required first.
2. No contract redesign in frontend thread.
3. No “modern app” chrome patterns.
4. No metadata in refine mode.
5. One intentional interaction drift only:
   - single-item drag and drop to bins (instead of keyboard binning-first workflow).
6. Reference color palette is locked:
   - base on/off: `#BEEEFF` and `#051021`
   - accents: `#77DB70`, `#F1EB5A`, `#FE7BD9`, `#1A3DF5`
   - no custom theme substitutions without explicit PM approval.

## 4. Required UX Outcomes
1. First-glance visual read feels MDR-like.
2. Grid items feel fluid/floating, not rigid.
3. Bucket mechanics feel sophisticated and mechanical.
4. CRT treatment is clearly visible without harming readability.
5. Hover playback works instantly and predictably.

## 5. Hard Interaction Requirements
### 5.1 Refine Core
1. Fixed-file session:
   - desktop 64 cells, mobile 30 cells.
2. Each successful placement seals the cell.
3. Completion presents `Start New File`.
4. No intrusive reset controls during active file.

### 5.2 Drag and Bucket Mechanics
1. Single active dragged item only.
2. Bucket open animation must visually align with the reference behavior quality.
3. Item-into-bucket animation must be curved and weighted.
4. No flap/lid misalignment at any viewport.

### 5.3 Hover Audio
1. Audio starts on hover after unlock gate.
2. Audio stops when pointer leaves refine area.
3. Crossfade behavior is required:
   - hovered-in item fades in while hovered-out item fades out.
   - brief overlap is expected during fast pointer movement.
4. Session-global virtual playhead is required:
   - timer starts at session initialization.
   - track position on hover = `elapsedSessionTime % trackDuration`.
   - track must not restart at `0` on each hover.
5. Drag state must not introduce audible regressions.

### 5.4 Preload and Start Gate
1. Before user can begin refining, preload the session audio set.
2. Show retro loading progress UI while preload runs.
3. Use controlled preload concurrency for reliability:
   - default concurrency 6
   - configurable range 4 to 8.

## 6. Reference-First Delivery Phases
No phase skipping.

### Phase 0 - Parity Map (No Implementation)
Deliver:
1. Component-by-component mapping:
   - reference component
   - target component
   - parity notes
2. Behavior matrix:
   - layout
   - grid motion
   - bin mechanics
   - CRT layers
   - audio behavior
3. Approved deviation list (only drag/drop adaptation).

Gate:
1. CTO/PM approval of parity map.

### Phase 1 - Static Visual Parity
Deliver:
1. Refine layout and typography parity.
2. Bucket visual structure parity.
3. CRT stack parity baseline.
4. Color-token parity against reference palette lock.

Gate:
1. Side-by-side stills vs reference.
2. Explicit pass/fail checklist per section.
3. Color audit table proving token/value parity.

### Phase 2 - Motion and Interaction Parity
Deliver:
1. Grid hover/lens behavior parity.
2. Bucket open/deform behavior parity.
3. Throw/placement animation parity.
4. Drag/drop adaptation integrated.

Gate:
1. WebGL fallback gate:
   - if WebGL is unavailable or fails, DOM refine UI remains visible and fully interactive.
2. Concise parity checklist with zero critical deltas.

### Phase 3 - Audio Behavior Parity
Deliver:
1. Unlock gate.
2. Preload state and progress bar.
3. Hover crossfade behavior:
   - in: gain ramp up
   - out: gain ramp down
   - controlled overlap between outgoing and incoming hovers.
4. Session-global virtual playhead behavior:
   - monotonic elapsed time from session init
   - per-track modulo playback position
   - no restart artifacts on re-hover.
5. Strict leave-area stop behavior.

Gate:
1. Audio parity checklist including pass/fail for:
   - hover in/out crossfade overlap
   - leave-area stop
   - no restart artifact on re-hover
   - modulo timeline behavior on mixed-duration tracks.

### Phase 4 - Contract Integration
Deliver:
1. `/api/v1` integration only.
2. Token precedence handling.
3. Frozen error/status handling.
4. Refine/archive route integration.

Gate:
1. Contract tests pass.
2. No UI regressions against Phase 3 parity baseline.

## 7. API Contract Requirements
Use only:
1. `GET /api/v1/session/init?device=desktop|mobile&reset=0|1`
2. `POST /api/v1/placements`
3. `GET /api/v1/archive/bins`
4. `GET /api/v1/archive/bin/:binCode`

Token behavior:
1. `X-Session-Token` header authoritative.
2. Mismatch handling must follow frozen contract.

Required status handling:
1. `400 BAD_REQUEST`
2. `400 SESSION_TOKEN_MISMATCH`
3. `404 INVALID_TRACK|INVALID_BIN`
4. `409 DUPLICATE_PLACEMENT`
5. `429 TOO_FAST|RATE_LIMITED`
6. `503 INSUFFICIENT_POOL`
7. `503 PLACEMENTS_DISABLED`

## 8. Implementation Guardrails
1. Do not reuse or adapt old failed frontend components.
2. Do not proceed to next phase with unresolved critical parity deltas.
3. Any intentional difference from reference must be documented before coding.
4. Keep external JSON field names camelCase.

## 9. Required Artifacts for Every Phase
1. Parity checklist:
   - reference behavior
   - implemented behavior
   - status: pass/fail
2. Lightweight evidence:
   - still image(s) only when needed for UI parity
   - no mandatory motion clips/video
3. Delta log:
   - remaining gaps
   - rationale
   - planned fix

## 10. Acceptance Criteria
1. MDR-like first glance in refine mode.
2. Buckets are mechanically believable and aligned.
3. CRT is visible and readable.
4. Hover audio behavior matches requirements exactly:
   - crossfade overlap
   - global virtual playhead modulo per track duration.
5. Session, sealing, and completion flow match fixed-file model.
6. Contract integration passes without schema or endpoint drift.
7. Refine and archive routes both function correctly.
