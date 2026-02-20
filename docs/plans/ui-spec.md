# MacroVibe Refinement - UI Specification

## 1. Purpose
Define the refine/archive interface in explicit terms so implementation does not depend on familiarity with MDR references.

## 2. Core Design Intent
- The interface should feel like a focused systems console.
- Visual language should be restrained, dense, and task-oriented.
- Interactions should feel intentional and slightly mechanical.
- Avoid modern consumer music app patterns.

## 3. Refine Layout Reference
Desktop frame (not to scale):

```text
+--------------------------------------------------------------+
| FILE: COLD HARBOUR-17             PROGRESS: 024 / 064        |
+==============================================================+
|                                                              |
|   [ ][ ][ ][ ][ ][ ][ ][ ]                                  |
|   [ ][ ][ ][ ][ ][ ][ ][ ]                                  |
|   [ ][ ][ ][ ][ ][ ][ ][ ]                                  |
|   [ ][ ][ ][ ][ ][ ][ ][ ]                                  |
|   [ ][ ][ ][ ][ ][ ][ ][ ]                                  |
|   [ ][ ][ ][ ][ ][ ][ ][ ]                                  |
|   [ ][ ][ ][ ][ ][ ][ ][ ]                                  |
|   [ ][ ][ ][ ][ ][ ][ ][ ]                                  |
|                                                              |
+==============================================================+
| [1]VELLUM [2]BRINE [3]HEAT [4]STATIC [5]HALO [6]GRIT         |
+--------------------------------------------------------------+
| SESSION: ...  AUDIO: ARMED  LATENCY: ...                     |
+--------------------------------------------------------------+
```

## 4. Refine View Rules
### 4.1 Allowed Content
- Anonymous cell code (derived from hash).
- Progress and system status text.
- Bin labels and key mappings.

### 4.2 Disallowed Content
- Track title, artist, album, genre.
- Popularity/trending rank.
- “Top in bin” or consensus hints.
- Social profile identity.

## 5. Visual Tokens
- `--bg-main: #07110d`
- `--bg-panel: #0c1a15`
- `--line: #274137`
- `--text-main: #c7dfcd`
- `--text-dim: #7ea08d`
- `--accent-positive: #7bcf9a`
- `--accent-secondary: #a6c4b0`
- `--accent-warning: #c0a96e`

Typography:
- body/system: monospace terminal stack
- optional headings: narrow utilitarian sans

## 5.1 CRT Display Stack (Required)
Apply as a post-process layer over refine view content.

Required layers:
1. Scanlines:
   - repeating horizontal line pattern
   - opacity target `0.08-0.14`
2. Corner vignette:
   - darkening strongest at corners
   - strength target `0.18-0.28`
3. Geometric distortion:
   - slight barrel-like warping near edges/corners
   - must preserve readability of small text
4. Low-amplitude flicker/noise:
   - subtle temporal variation only
   - avoid seizure-risk behavior and aggressive flicker

Implementation guidance:
- Preferred baseline: CSS overlay + SVG filter (no heavy dependencies).
- Progressive enhancement: canvas/WebGL distortion if stable and performant.
- Fallback mode on low-end devices: scanlines + vignette, disable distortion/flicker.

## 6. Cell Behavior
### 6.1 Identity
- Cell label is deterministic hash fragment from `trackId`.
- Example algorithm:
  - hash `trackId`
  - convert to base36
  - take 4 uppercase chars

### 6.2 State Styles
- `idle`: base text + subtle border.
- `focus`: brighter border + scale.
- `submitting`: temporary dim and movement.
- `accepted`: short accent flash.
- `sealed`: dimmed, non-interactive, visually complete.

## 7. Lens Interaction Math
For hovered coordinate `(r,c)`:
- self scale = `1.35`
- N/S/E/W = `1.12`
- diagonals = `1.06`
- all others = `1.00`

Update policy:
- only recalculate affected cells each frame/state change
- no full-grid style recalculation loops when avoidable

## 8. Placement Motion Spec
When cell assigned to bin:
1. Freeze cell interactions.
2. Animate position toward bin center with curved trajectory.
3. Run x and y with slightly different durations:
   - x `260ms`
   - y `340ms`
4. Trigger bin acknowledge animation.
5. Return cell to grid as sealed/non-interactive.

Easing:
- use smooth non-bouncy easing curve
- do not use spring/bounce

## 9. Bin Shelf Spec
- Horizontal row of 6 bins.
- Each bin shows key + code name:
  - `1 VELLUM`, `2 BRINE`, `3 HEAT`, `4 STATIC`, `5 HALO`, `6 GRIT`
- Active feedback:
  - short flap/deform pulse `180-220ms`
  - accent color flash

## 10. Audio UX Spec
### 10.1 Unlock Gate
- Show initial overlay button: `Begin Refinement`.
- No audible sound before explicit click/tap.

### 10.2 Hover Audio
- On hover/focus:
  - seek to virtual playhead position
  - gain ramp up ~`90ms`
- On blur/out:
  - gain ramp down ~`120ms`

### 10.3 Engine Constraints
- Decoder pool target: 8
- Config range: 6 to 12
- Loop window default: 12s (range 10-18s)

## 11. Mobile Adaptation
- 30 cells instead of 64.
- Tap to focus/preview.
- second tap or bin tap to assign.
- reduced-motion profile when `prefers-reduced-motion`.

## 11.1 Session Completion
- Session is a fixed file:
  - no endless refill behavior in MVP.
- Every successful placement seals a cell.
- When all cells are sealed, show completion state with `Start New File`.

## 12. Archive UI Spec
- Separate visual mode from refine:
  - cleaner browsing layout allowed
- Must still avoid popularity canon defaults.
- Show current bin membership only.
- Allow playback and optional outbound link behavior later.

## 13. Copy and Tone
- Use terse, procedural system copy.
- Avoid playful social copy in refine view.
- Keep labels minimal and consistent.

## 14. Accessibility Requirements
- Keyboard-only refine path supported.
- Focus indicators always visible.
- Contrast levels adequate for text and key controls.
- Motion reduction support.
- `prefers-reduced-motion` should reduce or disable flicker animation.
- CRT treatment must not compromise text readability or keyboard focus cues.

## 15. Acceptance Checklist
- Refine layout follows prescribed region structure.
- No metadata in refine cells.
- Lens and placement motion behaviors match timing targets.
- Bin shelf interaction feedback present.
- Audio unlock and hover ramps behave as specified.
- Mobile behavior works without hover dependence.
- CRT stack is visibly present in refine mode (scanlines + corner treatment minimum).
