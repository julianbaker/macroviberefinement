# MacroVibe Refinement

A web app for crowd-sourced music curation. Users sort anonymized audio snippets from [Audius](https://audius.co) into six bins by feel — no track metadata is shown. Majority vote across sessions determines each track's canonical bin, which syncs back to Audius as public playlists via a scheduled GitHub Actions job.

**Live:** [macrovibes.com](https://macrovibes.com)

**Stack:** React 19 · TypeScript · Vite · Web Audio API · WebGL · Supabase (Postgres + Edge Functions) · Audius SDK · GitHub Actions

Built solo with AI-assisted development (Claude).

---

## Notable implementation details

- WebGL CRT post-process shader (scanlines, barrel distortion, bloom, chromatic aberration). Barrel distortion requires forward UV mapping applied to pointer coordinates for accurate drag hit-testing.
- Virtual playhead audio — all tracks maintain a shared session clock so hovering a cell resumes playback at the correct position rather than restarting.
- Two-phase audio preload — HTTP Range requests (~512 KB) unblock the UI gate; full files load in the background and swap buffers in-place.
- Physics simulation with pairwise cell repulsion, orbit drift, and pointer repulsion running in a rAF loop. Hover and drag state read via refs to avoid restarting the loop.
- Optimistic placement — cells seal on throw; API confirms asynchronously and reverts on failure.

---

## Running locally

```bash
npm install
cp .env.local.example .env.local
npm run dev
```

Set `VITE_FUNCTION_BASE_URL` to your Supabase edge function URL. See [`docs/CODEBASE.md`](docs/CODEBASE.md) for full backend setup.

---

MIT
