# MacroVibe FE - Phase 1 Color Rebaseline

Date: 2026-02-20  
Status: Submitted for explicit color parity approval (Phase 2 blocked)

## Immediate Action Delivery
1. Phase 1 static UI rebaselined to locked palette and reference-like bin structure.
2. Grid opacity normalized; no faded/disabled visual state in static parity.
3. Header lockup updated with reference-style segmented bar treatment.
4. Bin structure refined to dual-row label+meter geometry with reference-aligned linework.
5. Side-by-side stills regenerated for palette parity verification.
6. Full color token audit included below.

## Side-by-Side Stills (Reference Left, Current Right)
1. `docs/evidence/phase-1/side-by-side/01-overall-refine-frame.png`
2. `docs/evidence/phase-1/side-by-side/02-grid-visual-treatment.png`
3. `docs/evidence/phase-1/side-by-side/03-bucket-visual-structure.png`
4. `docs/evidence/phase-1/side-by-side/04-crt-visibility-readability.png`
5. `docs/evidence/phase-1/side-by-side/05-palette-parity-closeup.png`

Reference still source:
- `/tmp/lumon-ref/docs/README.gif` frame `0` from `https://github.com/epassi/lumon-macrodata-refiner`

## Color Audit Table

Source of truth lock:
- `on/off`: `#BEEEFF` / `#051021`
- accents: `#77DB70`, `#F1EB5A`, `#FE7BD9`, `#1A3DF5`

All UI color tokens in use (`src/styles.css`):

| Token | Hex | Palette Basis | Usage |
|---|---|---|---|
| `--color-on` | `#BEEEFF` | locked `on` | base text/line color |
| `--color-off` | `#051021` | locked `off` | base background/text-outline |
| `--accent-wo` | `#77DB70` | locked accent | bin key accent class |
| `--accent-fc` | `#F1EB5A` | locked accent | bin key accent class |
| `--accent-dr` | `#FE7BD9` | locked accent | bin key accent class |
| `--accent-ma` | `#1A3DF5` | locked accent | bin key accent class |
| `--on-88` | `#BEEEFFE0` | `on` + alpha | progress/bin text emphasis |
| `--on-72` | `#BEEEFFB8` | `on` + alpha | grid/status text |
| `--on-56` | `#BEEEFF8F` | `on` + alpha | frame/bin borders |
| `--on-40` | `#BEEEFF66` | `on` + alpha | header separator lines |
| `--on-24` | `#BEEEFF3D` | `on` + alpha | section dividers |
| `--on-08` | `#BEEEFF14` | `on` + alpha | subtle glyph glow |
| `--off-96` | `#051021F5` | `off` + alpha | dark stripe background |
| `--off-86` | `#051021DB` | `off` + alpha | dark stripe background |
| `--off-72` | `#051021B8` | `off` + alpha | bin panel backgrounds |
| `--off-44` | `#05102170` | `off` + alpha | scanline/vignette layer |
| `--off-00` | `#05102100` | `off` + alpha | transparent stops in CRT gradients |
| `--accent-wo-56` | `#77DB708F` | `accent-wo` + alpha | bin meter fill variant |
| `--accent-fc-56` | `#F1EB5A8F` | `accent-fc` + alpha | bin meter fill variant |
| `--accent-dr-56` | `#FE7BD98F` | `accent-dr` + alpha | bin meter fill variant |
| `--accent-ma-56` | `#1A3DF58F` | `accent-ma` + alpha | bin meter fill variant |

Literal non-token hex usage in UI files:
- None outside token definitions in `src/styles.css`.

## Delta Log (Concrete Remaining Gaps Only)
1. Header logo/outline lockup does not yet replicate reference emblem geometry.
2. Grid currently lacks reference hover-enlargement state (Phase 2 motion scope).
3. Bin deformation/open mechanics are not implemented in static phase (Phase 2 scope).
4. CRT tuning is static-only in Phase 1; temporal flicker/noise remains pending motion pass.
