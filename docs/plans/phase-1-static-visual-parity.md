# MacroVibe FE Restart - Phase 1 Static Visual Parity

Date: 2026-02-20  
Status: Submitted for Phase 1 gate approval

Superseded for color-lock gate by:
- `docs/plans/phase-1-color-rebaseline.md`

## Side-by-Side Still Captures (Reference Left, Current Right)
1. Overall refine frame  
`docs/evidence/phase-1/side-by-side/01-overall-refine-frame.png`
2. Grid visual treatment  
`docs/evidence/phase-1/side-by-side/02-grid-visual-treatment.png`
3. Bucket visual structure/mechanics (static)  
`docs/evidence/phase-1/side-by-side/03-bucket-visual-structure.png`
4. CRT visibility/readability  
`docs/evidence/phase-1/side-by-side/04-crt-visibility-readability.png`

Reference still source:
- `/tmp/lumon-ref/docs/README.gif` frame `0` from `https://github.com/epassi/lumon-macrodata-refiner`

## Pass/Fail Parity Checklist

| Check | UI Spec Reference | Frontend Plan Reference | Evidence | Result |
|---|---|---|---|---|
| Refine frame region structure (header, grid, bins, status) and restrained terminal composition | `docs/plans/ui-spec.md` sections `2`, `3`, `15` | `docs/plans/frontend-plan.md` sections `6 (Phase 1)`, `10` | `docs/evidence/phase-1/side-by-side/01-overall-refine-frame.png` | PASS |
| Grid static treatment parity (anonymous codes, dense matrix read, sealed/idle distinction) | `docs/plans/ui-spec.md` sections `4`, `6`, `15` | `docs/plans/frontend-plan.md` sections `3`, `5.1`, `6 (Phase 1)` | `docs/evidence/phase-1/side-by-side/02-grid-visual-treatment.png` | PASS |
| Bucket visual structure parity (six-bin shelf, key+label readability, mechanical enclosure language in static state) | `docs/plans/ui-spec.md` sections `9`, `13`, `15` | `docs/plans/frontend-plan.md` sections `4`, `5.2`, `6 (Phase 1)` | `docs/evidence/phase-1/side-by-side/03-bucket-visual-structure.png` | PASS |
| CRT baseline parity visibility/readability (scanlines + vignette + distortion present without destroying text legibility) | `docs/plans/ui-spec.md` sections `5.1`, `14`, `15` | `docs/plans/frontend-plan.md` sections `4`, `6 (Phase 1)`, `10` | `docs/evidence/phase-1/side-by-side/04-crt-visibility-readability.png` | PASS |

## Delta Log (Concrete Remaining Gaps Only)
1. Header lockup stroke depth is lighter than reference; progress-outline weight can be increased.
2. Bin flap geometry is static-only in Phase 1; dynamic deformation quality target is pending Phase 2.
3. CRT edge warp amplitude is conservative; corner distortion can be tuned upward while preserving readability.
