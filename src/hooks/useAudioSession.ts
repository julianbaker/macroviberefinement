import { useCallback, useEffect, useRef, useState } from "react";
import { AudioEngine } from "../AudioEngine";
import type { TrackMeta } from "../AudioEngine";
import { api } from "../api";
import type { SessionInitResponse, SessionTrack } from "../api";
import type { AudioPhase, Cell } from "../types";
import { SESSION_SIZE_MAX, buildCellFromTrack, buildCellsFromTracks } from "../utils";

type UseAudioSessionParams = {
  /** Called synchronously at the top of every initSession so callers can
   *  reset physics, drag state, hover, etc. before new data arrives. */
  onWillReset: () => void;
  setStatusMessage: (msg: string | null) => void;
};

export type UseAudioSessionResult = {
  // Session state
  sessionToken: string | null;
  sessionSize: number;
  sessionDegraded: boolean;
  sessionLabel: string;
  sessionInitError: string | null;
  cells: Cell[];
  setCells: React.Dispatch<React.SetStateAction<Cell[]>>;
  // Audio state
  audioPhase: AudioPhase;
  preloadProgress: { loaded: number; total: number };
  bgLoad: { upgraded: number; total: number } | null;
  // Actions
  handleUnlock: () => Promise<void>;
  initSession: (reset: boolean, prefetched?: SessionInitResponse | null) => Promise<void>;
  // Refs shared with drag/drop and render
  audioEngineRef: React.MutableRefObject<AudioEngine | null>;
  hoverStartTimeRef: React.MutableRefObject<number | null>;
  prevHoverIdRef: React.MutableRefObject<number | null>;
  sessionTokenRef: React.MutableRefObject<string | null>;
  cellsRef: React.MutableRefObject<Cell[]>;
};

export function useAudioSession({
  onWillReset,
  setStatusMessage,
}: UseAudioSessionParams): UseAudioSessionResult {
  // ── Session state ───────────────────────────────────────────────────────────
  const [cells, setCells] = useState<Cell[]>([]);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [sessionSize, setSessionSize] = useState(SESSION_SIZE_MAX);
  const [sessionDegraded, setSessionDegraded] = useState(false);
  const [sessionLabel, setSessionLabel] = useState("––––-––––");
  const [sessionInitError, setSessionInitError] = useState<string | null>(null);

  // ── Audio state ─────────────────────────────────────────────────────────────
  const [audioPhase, setAudioPhase] = useState<AudioPhase>("locked");
  const [preloadProgress, setPreloadProgress] = useState({ loaded: 0, total: SESSION_SIZE_MAX });
  const [bgLoad, setBgLoad] = useState<{ upgraded: number; total: number } | null>(null);

  // ── Stable refs ─────────────────────────────────────────────────────────────
  const audioEngineRef = useRef<AudioEngine | null>(null);
  const prefetchRef = useRef<Promise<SessionInitResponse | null> | null>(null);
  // Incremented on each initSession so stale async callbacks from a previous
  // session are silently discarded rather than corrupting the new one.
  const sessionGenRef = useRef(0);

  // Shadow refs kept in sync with state so async callbacks always read the
  // latest value without needing to close over the setState setter.
  const sessionTokenRef = useRef<string | null>(null);
  sessionTokenRef.current = sessionToken;
  const cellsRef = useRef<Cell[]>([]);
  cellsRef.current = cells;

  // Cross-concern refs returned to callers (drag hook, audio handlers).
  const hoverStartTimeRef = useRef<number | null>(null);
  const prevHoverIdRef = useRef<number | null>(null);

  // Stable ref wrappers so initSession's useCallback can call the latest
  // version without needing them in the dependency array.
  const onWillResetRef = useRef(onWillReset);
  onWillResetRef.current = onWillReset;
  const setStatusMessageRef = useRef(setStatusMessage);
  setStatusMessageRef.current = setStatusMessage;

  // ── Speculative pre-fetch ───────────────────────────────────────────────────
  // Start session init immediately on mount so API latency is hidden while the
  // user reads the gate screen. AudioContext is deferred to the button click.
  useEffect(() => {
    prefetchRef.current = api
      .sessionInit("desktop", false)
      .then((r) => (r.ok ? r.data : null));
  }, []);

  // ── Core session initialiser ────────────────────────────────────────────────
  const initSession = useCallback(
    async (reset: boolean, prefetched?: SessionInitResponse | null) => {
      // Let callers (physics, drag) clean up before state updates arrive.
      onWillResetRef.current();

      setSessionInitError(null);
      setAudioPhase("preloading");
      setPreloadProgress({ loaded: 0, total: SESSION_SIZE_MAX });
      setBgLoad(null);

      const gen = ++sessionGenRef.current;
      prevHoverIdRef.current = null;
      hoverStartTimeRef.current = null;
      audioEngineRef.current?.stopAll();

      // AudioContext must exist before preloading; it may already exist from a
      // previous session or from handleUnlock (which creates it on user gesture).
      if (!audioEngineRef.current) {
        const ctx = new AudioContext();
        audioEngineRef.current = new AudioEngine(ctx);
      }

      // Use the pre-fetched data when available (first run only, not reset).
      let sessionData: SessionInitResponse | null =
        !reset && prefetched !== undefined ? prefetched : null;

      if (!sessionData) {
        const result = await api.sessionInit("desktop", reset);
        if (!result.ok) {
          setSessionInitError(result.error.code);
          setAudioPhase("locked");
          return;
        }
        sessionData = result.data;
      }

      const { sessionToken: token, sessionSize: size, degraded, tracks } = sessionData;
      const newCells = buildCellsFromTracks(tracks);

      setSessionToken(token);
      setSessionSize(size);
      setSessionDegraded(degraded);
      setSessionLabel(token.slice(0, 4).toUpperCase() + "-" + token.slice(4, 8).toUpperCase());
      setCells(newCells);

      if (degraded) {
        setStatusMessageRef.current(`POOL: DEGRADED ${size}/${SESSION_SIZE_MAX}`);
      }

      // durationSec is intentionally 0 — the virtual playhead uses the decoded
      // buffer duration, not the API-reported value.
      const trackMetas: TrackMeta[] = tracks.map((t) => ({
        trackId: t.trackId,
        streamUrl: t.streamUrl || null,
        durationSec: 0,
      }));

      setPreloadProgress({ loaded: 0, total: tracks.length });
      const engine = audioEngineRef.current;

      // ── Phase 1 (gate-blocking): partial fetch ~512 KB per track ─────────
      // ── Phase 2 (background):    full files swap buffers in-place ────────
      const { failedTrackIds } = await engine.preload(
        trackMetas,
        (loaded, total) => setPreloadProgress({ loaded, total }),
        (upgraded, upgradeTotal) => {
          if (sessionGenRef.current !== gen) return;
          setBgLoad(upgraded < upgradeTotal ? { upgraded, total: upgradeTotal } : null);
        },
      );

      // Replace failed tracks — retry up to MAX_ROUNDS before dropping
      // unresolvable cells. Each round excludes all previously failed track
      // IDs so the pool doesn't hand back the same broken stream twice.
      // After all rounds, any cell still missing a buffer is removed from
      // the session so the user never encounters a silent cell.
      if (failedTrackIds.length > 0 && sessionGenRef.current === gen) {
        const MAX_ROUNDS = 4;
        const excluded: string[] = [];

        // currentTracks[i] = the track currently assigned to cell i.
        // Updated each round so subsequent rounds can locate failed cells
        // by index even after earlier replacements changed their track IDs.
        const currentTracks: SessionTrack[] = [...tracks];
        let currentFailed = failedTrackIds;

        for (
          let round = 0;
          round < MAX_ROUNDS && currentFailed.length > 0 && sessionGenRef.current === gen;
          round++
        ) {
          excluded.push(...currentFailed);

          // Find which cell indices currently hold a failed track ID.
          const failedIndices: number[] = [];
          for (let i = 0; i < currentTracks.length; i++) {
            if (currentFailed.includes(currentTracks[i].trackId)) failedIndices.push(i);
          }
          if (failedIndices.length === 0) break;

          const replacements: Array<{ index: number; track: SessionTrack }> = [];
          for (const idx of failedIndices) {
            const result = await api.sessionReplaceTrack(token, idx, excluded);
            if (sessionGenRef.current !== gen) return;
            if (result.ok) {
              replacements.push({ index: idx, track: result.data });
              currentTracks[idx] = result.data;
            }
          }
          if (replacements.length === 0) break;

          setCells((prev) => {
            const next = [...prev];
            for (const { index, track } of replacements) {
              next[index] = buildCellFromTrack(track, index);
            }
            return next;
          });

          const replacementMetas: TrackMeta[] = replacements.map((r) => ({
            trackId: r.track.trackId,
            streamUrl: r.track.streamUrl || null,
            durationSec: 0,
          }));

          const { failedTrackIds: roundFailed } = await engine.preload(
            replacementMetas,
            () => {},   // suppress per-replacement progress noise; bar is already full
            undefined,
          );
          if (sessionGenRef.current !== gen) return;
          currentFailed = roundFailed;
        }

        // Safety net: drop any cell that still has no decoded buffer so no
        // silent cells reach the user regardless of what failed above.
        if (sessionGenRef.current === gen) {
          const droppedCount = currentTracks.filter((t) => !engine.hasBuffer(t.trackId)).length;
          if (droppedCount > 0) {
            setStatusMessageRef.current(`DROPPED ${droppedCount} UNLOADABLE`);
            setCells((prev) => prev.filter((cell) => engine.hasBuffer(cell.trackId)));
          }
        }
      }

      // All buffers ready — stamp the session clock and open the gate.
      engine.startSession();
      setAudioPhase("ready");
    },
    [],
  );

  // ── Gate unlock handler ─────────────────────────────────────────────────────
  // Must be called inside a user-gesture handler so AudioContext creation is
  // allowed by the browser.
  const handleUnlock = useCallback(async () => {
    if (!audioEngineRef.current) {
      const ctx = new AudioContext();
      audioEngineRef.current = new AudioEngine(ctx);
    }
    // Consume the pre-fetched session data (likely already resolved by now).
    const prefetched = prefetchRef.current ? await prefetchRef.current : null;
    prefetchRef.current = null;
    await initSession(false, prefetched);
  }, [initSession]);

  return {
    sessionToken,
    sessionSize,
    sessionDegraded,
    sessionLabel,
    sessionInitError,
    cells,
    setCells,
    audioPhase,
    preloadProgress,
    bgLoad,
    handleUnlock,
    initSession,
    audioEngineRef,
    hoverStartTimeRef,
    prevHoverIdRef,
    sessionTokenRef,
    cellsRef,
  };
}
