# Frontend Source Guide

Current frontend implementation lives in this directory.

## Key files

- `main.tsx`: entry point, including mobile gate routing and `?preview=alignment` dev preview mode.
- `App.tsx`: desktop refine flow (session init, drag/throw interactions, audio gate, completion state).
- `AlignmentReport.tsx`: post-session consensus alignment view.
- `MobileGate.tsx`: mobile-only access gate with direct Audius playlist links.
- `CrtWebglOverlay.tsx`: shared CRT render pipeline for App, Mobile Gate, and Alignment Report.
- `AudioEngine.ts`: two-phase hover-audio preload and playback orchestration.
- `api.ts`: typed client for `/api/v1` endpoints.
- `styles.css`: visual system, layout, and fallback UI styling.

## Supporting docs

- `docs/CODEBASE.md` for architecture and implementation details.
- `docs/contracts/` for API request/response contracts and test guidance.
- `docs/plans/` for planning artifacts and historical execution plans.
