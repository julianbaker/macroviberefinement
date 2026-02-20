# MacroVibe FE Restart - Phase 0 Parity Map (No Implementation)

Date: 2026-02-20  
Status: Awaiting PM/CTO gate approval before Phase 1

## Inputs Read (Required Order)
1. `/Users/julianbaker/Documents/Dropbox/dev/macroviberefinement/docs/plans/project-plan.md`
2. `/Users/julianbaker/Documents/Dropbox/dev/macroviberefinement/docs/plans/ui-spec.md`
3. `/Users/julianbaker/Documents/Dropbox/dev/macroviberefinement/docs/plans/frontend-plan.md`
4. `/Users/julianbaker/Documents/Dropbox/dev/macroviberefinement/docs/contracts/api-v1-contract-freeze.md`
5. `/Users/julianbaker/Documents/Dropbox/dev/macroviberefinement/docs/contracts/frontend-integration-handoff.md`
6. Medium reference: `https://epassi.medium.com/building-the-lumon-macrodata-refiner-2ba59fccbee9`
7. Git reference from Medium: `https://github.com/epassi/lumon-macrodata-refiner`

## Component Parity Map

| Reference Component (repo) | Planned FE Component | Parity Notes |
|---|---|---|
| `src/Refiner.js` | `RefineScreen` | Top-level refine composition and region structure (header -> grid -> bins -> status/footer -> overlays). |
| `src/components/Header.js` | `RefineHeader` | File label + progress lockup parity; typography restrained and procedural; no consumer app chrome. |
| `src/components/Divider.js` | `FrameDivider` | Structural separators between header/grid/bins/footer. |
| `src/components/DigitMatrix.js` | `RefineGrid` | Fixed file model: desktop 8x8 (64), mobile 30; manages hover focus neighborhood and sealed states. |
| `src/components/Digit.js` | `RefineCell` | Anonymous deterministic code label, lens scaling neighborhood, floating motion feel, throw-to-bin animation handoff. |
| `src/components/BinShelf.js` | `BinShelf` | Horizontal 6-bin shelf (`VELLUM`, `BRINE`, `HEAT`, `STATIC`, `HALO`, `GRIT`) with stable target centers. |
| `src/components/Bin.js` | `BinMechanism` | Mechanical opening/deform + acknowledge pulse quality; strict visual alignment (no lid/flap mismatch). |
| `src/components/Footer.js` | `SystemStatusBar` | Session/system telemetry text only; no metadata leak in refine mode. |
| `src/components/RetroMonitorScrim.js` | `CRTPipeline` | Required CRT stack: scanlines + vignette + geometric distortion + subtle flicker/noise with reduced-motion fallback. |
| `src/components/CompletionScreen.js` | `FileCompletionOverlay` | End-of-file state with `Start New File`; no intrusive reset while active file. |
| `src/components/MessageScreen.js` | `BlockingMessageOverlay` | Blocking states (pool shortage, placements disabled, unsupported mode) within same visual language. |
| `src/components/Cursor.js` | `RefineCursor` (optional) | Optional stylized cursor only if it does not reduce usability/accessibility. |
| N/A in reference | `AudioUnlockGate` | Mandatory `Begin Refinement` gate before any audible playback. |
| N/A in reference | `SessionAudioPreloader` | Preload full session set with retro progress UI, controlled concurrency. |
| N/A in reference | `DragPlacementLayer` | Only intentional interaction deviation: single-item drag/drop into bins. |
| N/A in reference | `ApiClientV1` | Frozen `/api/v1` contract integration only in Phase 4; no schema drift. |
| N/A in reference | `ArchiveBinsView` / `ArchiveBinDetailView` | Separate archive route and mode; membership browsing only, kept isolated from refine flow. |

## Behavior Matrix

| Domain | Reference Behavior Anchor | Planned Parity Behavior |
|---|---|---|
| Layout | Terminal frame with strong regions and separators; dense task-oriented composition. | Preserve region hierarchy and ritual tone. Refine shows only anonymous cell code, progress, bin labels, and system status. |
| Grid Motion | Hover-lens neighborhood magnification; subtle floating motion; weighted throw animation. | Lens neighborhood scaling per spec (`self 1.35`, cardinal `1.12`, diagonals `1.06`). Fluid/floating feel retained. Throw path curved with non-bouncy easing and differential axis timing. |
| Bin Mechanics | Mechanical open/deform response and bin acknowledgment from throw. | 6 bins with believable mechanics, aligned geometry, short acknowledge pulse (`180-220ms`), no flap/lid misalignment at any viewport. |
| CRT | Visible overlay effect with retro monitor treatment. | Required 4-layer stack: scanlines, corner vignette, geometric distortion, subtle flicker/noise; reduced-motion fallback keeps readability/focus visibility. |
| Audio | Interaction-coupled sound behavior in reference. | Unlock gate, preload-before-begin, hover continuity without restart, strict stop when pointer leaves refine area, drag-safe playback behavior. Preload concurrency defaults to `6`, configurable `4-8`. |

## Explicit Approved Deviation List
1. Replace keyboard-first bin assignment with **single-item drag/drop into bins**.
2. No other intentional interaction or visual deviation is approved in this phase.

## Phase 0 Parity Checklist

| Reference Behavior | Planned FE Behavior | Status |
|---|---|---|
| Structured refine frame (header/grid/bins/footer) | Direct component mapping and preserved hierarchy | PASS |
| Lens + floating grid motion model | Mapped to `RefineGrid`/`RefineCell` with spec constants | PASS |
| Mechanical bin behavior quality | Mapped to dedicated `BinMechanism` with alignment guardrail | PASS |
| CRT visible but readable | Mapped to `CRTPipeline` with explicit layer requirements | PASS |
| Audio interaction constraints | Mapped to unlock + preload + hover continuity + leave-area stop | PASS |
| Contract freeze compliance boundary | Mapped to Phase 4-only frozen `/api/v1` client | PASS |
| Deviation control | Exactly one approved deviation documented | PASS |

## Visual Evidence (Phase 0)
- Reference-only evidence source (no implementation yet):  
  - Medium article demo: `https://epassi.medium.com/building-the-lumon-macrodata-refiner-2ba59fccbee9`  
  - Reference repo demo artifact: `https://github.com/epassi/lumon-macrodata-refiner` (`docs/README.gif`)
- Side-by-side still captures are deferred to Phase 1 gate per plan.

## Delta Log
1. No frontend implementation exists yet in this restart (expected in Phase 0).
2. No critical parity deltas are open at planning level.
3. Next gate dependency: explicit PM/CTO approval to start Phase 1 static parity build.
