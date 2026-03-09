import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { CrtWebglOverlay, CRT_CURVATURE } from "./CrtWebglOverlay";
import type { CursorType } from "./CrtWebglOverlay";
import { AlignmentReport } from "./AlignmentReport";
import { AudioEngine } from "./AudioEngine";
import type { TrackMeta } from "./AudioEngine";
import { api } from "./api";
import type { SessionInitResponse, SessionTrack } from "./api";
import logoUrl from "./assets/MVRLogo.svg?url";

const BIN_CODES = ["VELLUM", "BRINE", "HEAT", "STATIC", "HALO", "GRIT"] as const;

const BIN_PLAYLIST_URLS: Record<string, string> = {
  VELLUM: "https://audius.co/MacroVibeRefinement/playlist/vellum",
  BRINE:  "https://audius.co/MacroVibeRefinement/playlist/brine",
  HEAT:   "https://audius.co/MacroVibeRefinement/playlist/heat",
  STATIC: "https://audius.co/MacroVibeRefinement/playlist/static",
  HALO:   "https://audius.co/MacroVibeRefinement/playlist/halo",
  GRIT:   "https://audius.co/MacroVibeRefinement/playlist/grit",
};
const BIN_METERS = [26, 53, 47, 64, 16, 38] as const;
const SESSION_SIZE_MAX = 64;
const THROW_X_MS = 280;
const THROW_Y_MS = 340;
const THROW_TARGET_SCALE = 0.44;
const FLUID_ROW_COUNTS = [7, 8, 6, 8, 7, 8, 6, 7, 7] as const;

type AudioPhase = "locked" | "preloading" | "ready";

type Cell = {
  index: number;
  trackId: string;
  code: string;
  driftBaseX: number;
  driftBaseY: number;
  floatX: number;
  floatY: number;
  floatDuration: number;
  floatDelay: number;
};

type CellLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CellNode = CellLayout & {
  vx: number;
  vy: number;
  homeX: number;
  homeY: number;
};

type DragState = {
  cellId: number;
  code: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  overBin: number | null;
};

type ThrowState = {
  cellId: number;
  code: string;
  width: number;
  height: number;
  scale: number;
  x: number;
  y: number;
  opacity: number;
};

type PointerState = {
  x: number;
  y: number;
};

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);
const lerp = (from: number, to: number, progress: number): number => from + (to - from) * progress;
const easeInOut = (progress: number): number =>
  progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2;
const easeOut = (progress: number): number => 1 - Math.pow(1 - progress, 3);

const makeCode = (seed: string): string => {
  let hash = 2166136261;
  for (const ch of seed) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash).toString(36).toUpperCase().slice(0, 4).padEnd(4, "0");
};

const buildCellFromTrack = (track: SessionTrack, index: number): Cell => ({
  index,
  trackId: track.trackId,
  code: makeCode(track.seed),
  driftBaseX: (((index * 13) % 7) - 3) * 1.45,
  driftBaseY: (((index * 17) % 7) - 3) * 1.28,
  floatX: ((index * 7) % 5) * 0.85 + 0.9,
  floatY: ((index * 11) % 4) * 0.9 + 0.95,
  floatDuration: 2.4 + ((index * 3) % 8) * 0.22,
  floatDelay: ((index * 5) % 17) * 0.14,
});

const buildCellsFromTracks = (tracks: SessionTrack[]): Cell[] =>
  tracks.map((track, index) => buildCellFromTrack(track, index));

const FLUID_SLOTS = (() => {
  const slots: Array<{ x: number; y: number }> = [];
  const rowTotal = FLUID_ROW_COUNTS.length;

  FLUID_ROW_COUNTS.forEach((count, row) => {
    const rowOffset = row % 2 === 0 ? 0.018 : -0.02;
    for (let col = 0; col < count; col += 1) {
      const xProgress = (col + 0.52) / count;
      const yProgress = (row + 0.64) / (rowTotal + 0.22);
      const wobbleX = Math.sin((col + 1) * 1.48 + row * 0.9) * 0.012;
      const wobbleY = Math.cos((row + 1) * 1.13 + col * 0.62) * 0.009;
      slots.push({
        x: clamp(0.06 + xProgress * 0.88 + rowOffset + wobbleX, 0.06, 0.94),
        y: clamp(0.08 + yProgress * 0.83 + wobbleY, 0.08, 0.92),
      });
    }
  });
  return slots;
})();

const buildHomeLayout = (width: number, height: number, cells: Cell[]): Record<number, CellLayout> => {
  const slotWidth = width / 8.55;
  const slotHeight = height / 8.8;
  const map: Record<number, CellLayout> = {};

  cells.forEach((cell) => {
    const slot = FLUID_SLOTS[cell.index] ?? FLUID_SLOTS[cell.index % FLUID_SLOTS.length];
    const x = clamp(slot.x * width + cell.driftBaseX, slotWidth * 0.44, width - slotWidth * 0.44);
    const y = clamp(slot.y * height + cell.driftBaseY, slotHeight * 0.42, height - slotHeight * 0.42);
    map[cell.index] = {
      x,
      y,
      width: slotWidth * 0.98,
      height: slotHeight * 0.94,
    };
  });

  return map;
};

const getCellScale = (
  cellId: number,
  hoveredCellId: number | null,
  layoutByCell: Record<number, CellLayout>,
  isDragging: boolean,
): number => {
  if (isDragging || hoveredCellId === null) {
    return 1;
  }
  if (cellId === hoveredCellId) {
    return 1.35;
  }

  const cellLayout = layoutByCell[cellId];
  const hoveredLayout = layoutByCell[hoveredCellId];
  if (!cellLayout || !hoveredLayout) {
    return 1;
  }

  const dx = cellLayout.x - hoveredLayout.x;
  const dy = cellLayout.y - hoveredLayout.y;
  const dist = Math.hypot(dx, dy);
  const base = (hoveredLayout.width + hoveredLayout.height) * 0.5;
  if (dist <= base * 0.92) {
    return 1.12;
  }
  if (dist <= base * 1.45) {
    return 1.06;
  }
  return 1;
};

const getBinFromPoint = (binElements: Array<HTMLElement | null>, clientX: number, clientY: number): number | null => {
  for (let index = 0; index < binElements.length; index += 1) {
    const element = binElements[index];
    if (!element) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top - 18 && clientY <= rect.bottom + 12) {
      return index;
    }
  }
  return null;
};

export function App() {
  const headerBars = Array.from({ length: 22 }, (_, idx) => idx);
  const frameRef = useRef<HTMLElement | null>(null);
  const binRefs = useRef<Array<HTMLElement | null>>([]);
  const gridRef = useRef<HTMLOListElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);
  const lastLayoutCommitRef = useRef<number>(0);
  const dragRef = useRef<DragState | null>(null);
  const physicsRef = useRef<Record<number, CellNode>>({});
  const homeLayoutRef = useRef<Record<number, CellLayout>>({});
  // Debounce ref for clearing hoveredCellId on cell leave so that moving
  // directly between adjacent cells doesn't flash the cursor to "default".
  const cellLeaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Session state
  const [cells, setCells] = useState<Cell[]>([]);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [sessionSize, setSessionSize] = useState(SESSION_SIZE_MAX);
  const [sessionDegraded, setSessionDegraded] = useState(false);
  const [sessionLabel, setSessionLabel] = useState("––––-––––");
  const [sessionInitError, setSessionInitError] = useState<string | null>(null);

  // Refs for use inside callbacks without stale closures
  const sessionTokenRef = useRef<string | null>(null);
  const cellsRef = useRef<Cell[]>([]);
  sessionTokenRef.current = sessionToken;
  cellsRef.current = cells;

  const [hoveredCellId, setHoveredCellId] = useState<number | null>(null);
  const [hoveredBinPlaylist, setHoveredBinPlaylist] = useState<number | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [throwState, setThrowState] = useState<ThrowState | null>(null);
  const [placedBins, setPlacedBins] = useState<Record<number, number>>({});
  const [activeBinPulse, setActiveBinPulse] = useState<number | null>(null);
  const [gridSize, setGridSize] = useState({ width: 0, height: 0 });
  const [gridViewport, setGridViewport] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const [displayLayoutByCell, setDisplayLayoutByCell] = useState<Record<number, CellLayout>>({});
  const [pointerInGrid, setPointerInGrid] = useState<PointerState | null>(null);
  const [crtStatus, setCrtStatus] = useState<"initializing" | "ready" | "failed">("initializing");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [hoveredButton, setHoveredButton] = useState(false);

  const [audioPhase, setAudioPhase] = useState<AudioPhase>("locked");
  const [preloadProgress, setPreloadProgress] = useState({ loaded: 0, total: SESSION_SIZE_MAX });
  const [bgLoad, setBgLoad] = useState<{ upgraded: number; total: number } | null>(null);
  const audioEngineRef = useRef<AudioEngine | null>(null);
  const prevHoverIdRef = useRef<number | null>(null);
  const hoverStartTimeRef = useRef<number | null>(null);
  // Pre-fetched session data (started on mount, before user gesture)
  const prefetchRef = useRef<Promise<SessionInitResponse | null> | null>(null);
  // Incremented each initSession so stale upgrade callbacks are ignored
  const sessionGenRef = useRef(0);

  dragRef.current = dragState;

  const [showAlignment, setShowAlignment] = useState(false);

  const placedCount = Object.keys(placedBins).length;
  const isDragging = dragState !== null;
  const isComplete = cells.length > 0 && placedCount >= sessionSize;

  // Reset hoveredButton whenever the set of interactive buttons on screen changes.
  // Clicking a button can unmount it before onPointerLeave fires, leaving
  // hoveredButton permanently true and the cursor stuck on "pointer".
  useEffect(() => {
    setHoveredButton(false);
  }, [audioPhase, isComplete]);

  // During gate/preload only the gate button receives pointer events (overlay is pointer-events: none).
  // Ignore grid/bin hover so we don't show grab/pointer from content beneath the transparent overlay.
  const inGatePhase = audioPhase === "locked" || audioPhase === "preloading";
  const cursorType: CursorType = inGatePhase
    ? hoveredButton
      ? "pointer"
      : "default"
    : isDragging
      ? "grabbing"
      : hoveredCellId !== null
        ? "grab"
        : hoveredBinPlaylist !== null || hoveredButton
          ? "pointer"
          : "default";

  const cellById = useMemo(() => {
    const map: Record<number, Cell> = {};
    for (const cell of cells) {
      map[cell.index] = cell;
    }
    return map;
  }, [cells]);

  const activeCellIds = useMemo(
    () =>
      cells
        .map((cell) => cell.index)
        .filter((cellId) => placedBins[cellId] === undefined)
        .sort((a, b) => a - b),
    [cells, placedBins],
  );

  // Clear transient status messages after a delay
  useEffect(() => {
    if (!statusMessage) return;
    const id = window.setTimeout(() => setStatusMessage(null), 4200);
    return () => window.clearTimeout(id);
  }, [statusMessage]);

  // Speculative pre-fetch: start session/init immediately so API latency is
  // hidden while the user reads the gate screen. No AudioContext needed here.
  useEffect(() => {
    prefetchRef.current = api
      .sessionInit("desktop", false)
      .then((r) => (r.ok ? r.data : null));
  }, []);

  const initSession = useCallback(async (reset: boolean, prefetched?: SessionInitResponse | null) => {
    setSessionInitError(null);
    setAudioPhase("preloading");
    setPreloadProgress({ loaded: 0, total: SESSION_SIZE_MAX });
    setBgLoad(null);
    const gen = ++sessionGenRef.current;

    // Reset grid state
    setPlacedBins({});
    setDisplayLayoutByCell({});
    physicsRef.current = {};
    setHoveredCellId(null);
    setDragState(null);
    setThrowState(null);
    setActiveBinPulse(null);
    prevHoverIdRef.current = null;
    hoverStartTimeRef.current = null;
    audioEngineRef.current?.stopAll();

    // AudioContext must exist — caller creates it on user gesture
    if (!audioEngineRef.current) {
      const ctx = new AudioContext();
      audioEngineRef.current = new AudioEngine(ctx);
    }

    // Use pre-fetched data if supplied (and not a reset), otherwise fetch now
    let sessionData: SessionInitResponse | null = (!reset && prefetched !== undefined)
      ? prefetched
      : null;

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
      setStatusMessage(`POOL: DEGRADED ${size}/${SESSION_SIZE_MAX}`);
    }

    // durationSec is unused — virtual playhead uses the decoded buffer duration
    const trackMetas: TrackMeta[] = tracks.map((t) => ({
      trackId: t.trackId,
      streamUrl: t.streamUrl || null,
      durationSec: 0,
    }));

    setPreloadProgress({ loaded: 0, total: tracks.length });
    const engine = audioEngineRef.current;

    // Phase 1 (gate blocks): partial fetch ~512 KB per track → real audio
    // Phase 2 (background): full file swaps in per-track, gate already open
    const { failedTrackIds } = await engine.preload(
      trackMetas,
      (loaded, total) => setPreloadProgress({ loaded, total }),
      (upgraded, upgradeTotal) => {
        if (sessionGenRef.current !== gen) return;
        setBgLoad(upgraded < upgradeTotal ? { upgraded, total: upgradeTotal } : null);
      },
    );

    // Replace failed tracks during preload so every cell is playable before gate opens
    if (failedTrackIds.length > 0 && sessionGenRef.current === gen) {
      const failedIndices = failedTrackIds
        .map((id) => tracks.findIndex((t) => t.trackId === id))
        .filter((i) => i >= 0);
      const replacements: Array<{ index: number; track: SessionTrack }> = [];
      for (const index of failedIndices) {
        const result = await api.sessionReplaceTrack(token, index, failedTrackIds);
        if (sessionGenRef.current !== gen) return;
        if (result.ok) {
          replacements.push({ index, track: result.data });
        }
      }
      if (replacements.length > 0 && sessionGenRef.current === gen) {
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
        const { failedTrackIds: replacementFailedTrackIds } = await engine.preload(
          replacementMetas,
          (loaded, total) => setPreloadProgress({ loaded: tracks.length - failedTrackIds.length + loaded, total: tracks.length }),
          undefined,
        );
        if (sessionGenRef.current !== gen) return;

        // One retry round for replacements that failed to load
        if (replacementFailedTrackIds.length > 0 && sessionGenRef.current === gen) {
          // Correct progress to actual loaded count so the bar does not jump backwards
          const actualLoaded =
            tracks.length - failedTrackIds.length + (replacements.length - replacementFailedTrackIds.length);
          setPreloadProgress({ loaded: actualLoaded, total: tracks.length });

          const retryExclude = [...failedTrackIds, ...replacementFailedTrackIds];
          const retryIndices = replacements
            .filter((r) => replacementFailedTrackIds.includes(r.track.trackId))
            .map((r) => r.index);
          const retryReplacements: Array<{ index: number; track: SessionTrack }> = [];
          for (const index of retryIndices) {
            const result = await api.sessionReplaceTrack(token, index, retryExclude);
            if (sessionGenRef.current !== gen) return;
            if (result.ok) {
              retryReplacements.push({ index, track: result.data });
            }
          }
          if (retryReplacements.length > 0 && sessionGenRef.current === gen) {
            setCells((prev) => {
              const next = [...prev];
              for (const { index, track } of retryReplacements) {
                next[index] = buildCellFromTrack(track, index);
              }
              return next;
            });
            const retryMetas: TrackMeta[] = retryReplacements.map((r) => ({
              trackId: r.track.trackId,
              streamUrl: r.track.streamUrl || null,
              durationSec: 0,
            }));
            await engine.preload(
              retryMetas,
              (loaded, total) =>
                setPreloadProgress({
                  loaded: tracks.length - failedTrackIds.length + (replacements.length - replacementFailedTrackIds.length) + loaded,
                  total: tracks.length,
                }),
              undefined,
            );
            if (sessionGenRef.current !== gen) return;
          }
        }
      }
    }

    engine.startSession();
    setAudioPhase("ready");
  }, []);

  const handleUnlock = useCallback(async () => {
    // AudioContext must be created inside a user gesture handler
    if (!audioEngineRef.current) {
      const ctx = new AudioContext();
      audioEngineRef.current = new AudioEngine(ctx);
    }
    // Consume the pre-fetched session data (may already be resolved)
    const prefetched = prefetchRef.current ? await prefetchRef.current : null;
    prefetchRef.current = null;
    await initSession(false, prefetched);
  }, [initSession]);

  useEffect(() => {
    const element = gridRef.current;
    if (!element) {
      return;
    }
    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setGridSize({ width: rect.width, height: rect.height });
      const frameRect = frameRef.current?.getBoundingClientRect();
      if (frameRect) {
        setGridViewport({
          x: rect.left - frameRect.left,
          y: rect.top - frameRect.top,
          width: rect.width,
          height: rect.height,
        });
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (gridSize.width <= 0 || gridSize.height <= 0 || cells.length === 0) {
      return;
    }

    const home = buildHomeLayout(gridSize.width, gridSize.height, cells);
    homeLayoutRef.current = home;

    const rebuilt: Record<number, CellNode> = {};
    for (const cell of cells) {
      if (placedBins[cell.index] !== undefined) {
        continue;
      }
      const prev = physicsRef.current[cell.index];
      const target = home[cell.index];
      rebuilt[cell.index] = {
        x: prev?.x ?? target.x,
        y: prev?.y ?? target.y,
        vx: prev?.vx ?? 0,
        vy: prev?.vy ?? 0,
        width: target.width,
        height: target.height,
        homeX: target.x,
        homeY: target.y,
      };
    }
    physicsRef.current = rebuilt;
    setDisplayLayoutByCell(
      Object.fromEntries(
        Object.entries(rebuilt).map(([id, node]) => [
          Number(id),
          { x: node.x, y: node.y, width: node.width, height: node.height },
        ]),
      ),
    );
  }, [gridSize.height, gridSize.width, cells, placedBins]);

  useEffect(() => {
    const tick = () => {
      const nowMs = performance.now();
      const previousMs = lastTickRef.current || nowMs;
      const dt = clamp((nowMs - previousMs) / 16.666, 0.68, 1.6);
      const now = nowMs * 0.001;
      lastTickRef.current = nowMs;

      const ids = activeCellIds;
      if (ids.length > 0) {
        const nodes = physicsRef.current;
        const forceById: Record<number, { fx: number; fy: number }> = {};
        const centerX = gridSize.width * 0.5;
        const centerY = gridSize.height * 0.5;
        const repelRadius = Math.min(246, Math.max(142, (gridSize.width + gridSize.height) * 0.105));
        const repelRadiusSq = repelRadius * repelRadius;

        ids.forEach((id) => {
          const node = nodes[id];
          if (!node) {
            return;
          }
          const home = homeLayoutRef.current[id];
          node.width = home.width;
          node.height = home.height;
          node.homeX = home.x;
          node.homeY = home.y;
          const orbitX =
            Math.sin(now * (0.48 + (id % 5) * 0.04) + id * 0.73) * 9 +
            Math.cos(now * (0.23 + (id % 7) * 0.03) + id * 0.11) * 4.6;
          const orbitY =
            Math.cos(now * (0.51 + (id % 6) * 0.035) + id * 0.66) * 8 +
            Math.sin(now * (0.25 + (id % 4) * 0.05) + id * 0.2) * 4.1;
          const targetX = node.homeX + orbitX;
          const targetY = node.homeY + orbitY;
          const flowX = Math.sin(node.y * 0.014 + now * 0.82 + id * 0.1) * 0.011;
          const flowY = Math.cos(node.x * 0.012 - now * 0.76 + id * 0.12) * 0.011;
          forceById[id] = {
            fx: (targetX - node.x) * 0.00126 + (centerX - node.x) * 0.00019 + flowX,
            fy: (targetY - node.y) * 0.00126 + (centerY - node.y) * 0.00019 + flowY,
          };
        });

        for (let i = 0; i < ids.length; i += 1) {
          const idA = ids[i];
          const a = nodes[idA];
          if (!a) {
            continue;
          }
          for (let j = i + 1; j < ids.length; j += 1) {
            const idB = ids[j];
            const b = nodes[idB];
            if (!b) {
              continue;
            }
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dSq = dx * dx + dy * dy;
            if (dSq <= 0.0001 || dSq > repelRadiusSq) {
              continue;
            }
            const d = Math.sqrt(dSq);
            const proximity = (repelRadius - d) / repelRadius;
            const strength = proximity * proximity * 0.31;
            const nx = dx / d;
            const ny = dy / d;
            forceById[idA].fx -= nx * strength;
            forceById[idA].fy -= ny * strength;
            forceById[idB].fx += nx * strength;
            forceById[idB].fy += ny * strength;
          }
        }

        if (pointerInGrid && !isDragging) {
          const pointerRadius = Math.min(250, Math.max(146, (gridSize.width + gridSize.height) * 0.11));
          const pointerRadiusSq = pointerRadius * pointerRadius;
          ids.forEach((id) => {
            const node = nodes[id];
            if (!node) {
              return;
            }
            const dx = node.x - pointerInGrid.x;
            const dy = node.y - pointerInGrid.y;
            const dSq = dx * dx + dy * dy;
            if (dSq <= 0.0001 || dSq > pointerRadiusSq) {
              return;
            }
            const d = Math.sqrt(dSq);
            const nx = dx / d;
            const ny = dy / d;
            const falloff = Math.pow((pointerRadius - d) / pointerRadius, 1.7);
            const strength = falloff * 0.115;
            const tangentX = -ny;
            const tangentY = nx;
            forceById[id].fx += nx * strength + tangentX * strength * 0.09;
            forceById[id].fy += ny * strength + tangentY * strength * 0.09;
          });
        }

        if (hoveredCellId !== null && nodes[hoveredCellId] && !isDragging) {
          const hovered = nodes[hoveredCellId];
          const pushRadius = Math.min(238, Math.max(134, (gridSize.width + gridSize.height) * 0.098));
          const pushRadiusSq = pushRadius * pushRadius;
          ids.forEach((id) => {
            if (id === hoveredCellId) {
              return;
            }
            const node = nodes[id];
            if (!node) {
              return;
            }
            const dx = node.x - hovered.x;
            const dy = node.y - hovered.y;
            const dSq = dx * dx + dy * dy;
            if (dSq <= 0.0001 || dSq > pushRadiusSq) {
              return;
            }
            const d = Math.sqrt(dSq);
            const nx = dx / d;
            const ny = dy / d;
            const strength = Math.pow((pushRadius - d) / pushRadius, 1.8) * 0.178;
            forceById[id].fx += nx * strength;
            forceById[id].fy += ny * strength;
            forceById[hoveredCellId].fx -= nx * strength * 0.12;
            forceById[hoveredCellId].fy -= ny * strength * 0.12;
          });
        }

        const minX = Math.max(36, gridSize.width * 0.05);
        const maxX = Math.max(minX + 1, gridSize.width - minX);
        const minY = Math.max(34, gridSize.height * 0.06);
        const maxY = Math.max(minY + 1, gridSize.height - minY);

        ids.forEach((id) => {
          const node = nodes[id];
          if (!node) {
            return;
          }
          if (dragState?.cellId === id || throwState?.cellId === id) {
            return;
          }

          const force = forceById[id];
          node.vx = (node.vx + force.fx * dt) * 0.918;
          node.vy = (node.vy + force.fy * dt) * 0.918;
          const speed = Math.hypot(node.vx, node.vy);
          const maxSpeed = 2.25;
          if (speed > maxSpeed) {
            const scale = maxSpeed / speed;
            node.vx *= scale;
            node.vy *= scale;
          }
          node.x += node.vx * dt;
          node.y += node.vy * dt;

          if (node.x < minX) {
            node.x = minX;
            node.vx *= -0.26;
          } else if (node.x > maxX) {
            node.x = maxX;
            node.vx *= -0.26;
          }
          if (node.y < minY) {
            node.y = minY;
            node.vy *= -0.24;
          } else if (node.y > maxY) {
            node.y = maxY;
            node.vy *= -0.24;
          }
        });

        if (nowMs - lastLayoutCommitRef.current >= 33.3 || isDragging || throwState !== null) {
          setDisplayLayoutByCell(
            Object.fromEntries(
              ids.map((id) => {
                const node = nodes[id];
                return [id, { x: node.x, y: node.y, width: node.width, height: node.height }];
              }),
            ),
          );
          lastLayoutCommitRef.current = nowMs;
        }
      } else {
        setDisplayLayoutByCell({});
      }

      animationFrameRef.current = requestAnimationFrame(tick);
    };

    lastTickRef.current = 0;
    lastLayoutCommitRef.current = 0;
    animationFrameRef.current = requestAnimationFrame(tick);
    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [activeCellIds, dragState?.cellId, gridSize.height, gridSize.width, hoveredCellId, isDragging, pointerInGrid, throwState?.cellId]);

  const meterValues = useMemo(() => {
    const counts = new Array(BIN_CODES.length).fill(0);
    for (const binIndex of Object.values(placedBins)) {
      counts[binIndex] += 1;
    }
    return BIN_METERS.map((base, index) => clamp(base + counts[index] * 2, 8, 98));
  }, [placedBins]);

  const startThrowAnimation = useCallback((source: DragState) => {
    if (source.overBin === null) {
      return;
    }
    const binElement = binRefs.current[source.overBin];
    if (!binElement) {
      return;
    }

    const binRect = binElement.getBoundingClientRect();
    const startScale = source.scale;
    const targetScale = Math.max(0.34, Math.min(0.72, source.scale * THROW_TARGET_SCALE));
    const startCenterX = source.x + source.width * startScale * 0.5;
    const startCenterY = source.y + source.height * startScale * 0.5;
    const targetCenterX = binRect.left + binRect.width * 0.5;
    const targetCenterY = binRect.top + Math.max(14, binRect.height * 0.24);
    const startTime = performance.now();
    const clientTs = Date.now();

    setThrowState({
      cellId: source.cellId,
      code: source.code,
      width: source.width,
      height: source.height,
      scale: startScale,
      x: source.x,
      y: source.y,
      opacity: 1,
    });

    const run = (now: number) => {
      const xProgress = clamp((now - startTime) / THROW_X_MS, 0, 1);
      const yProgress = clamp((now - startTime) / THROW_Y_MS, 0, 1);
      const easedX = easeOut(xProgress);
      const easedY = easeInOut(yProgress);
      const scaleProgress = Math.max(xProgress, yProgress);
      const scale = lerp(startScale, targetScale, easeInOut(scaleProgress));
      const centerX = lerp(startCenterX, targetCenterX, easedX);
      const centerY = lerp(startCenterY, targetCenterY, easedY) + Math.sin(Math.PI * yProgress) * 6;
      const opacityFadeProgress = clamp((yProgress - 0.74) / 0.26, 0, 1);
      const opacity = lerp(1, 0.16, easeInOut(opacityFadeProgress));

      setThrowState((current) => {
        if (!current) {
          return null;
        }
        return {
          ...current,
          scale,
          x: centerX - source.width * scale * 0.5,
          y: centerY - source.height * scale * 0.5,
          opacity,
        };
      });

      if (xProgress < 1 || yProgress < 1) {
        requestAnimationFrame(run);
        return;
      }

      // Animation done: optimistically seal the cell
      setThrowState(null);
      setPlacedBins((current) => ({
        ...current,
        [source.cellId]: source.overBin as number,
      }));
      setActiveBinPulse(source.overBin);

      // Fade out audio for placed cell — it is now sealed
      const cell = cellsRef.current[source.cellId];
      if (cell) {
        audioEngineRef.current?.hoverOut(cell.trackId);
      }
      // Only clear prevHoverIdRef if it still points to the placed cell.
      // If the user moved to another cell during the throw animation, that
      // cell's index must remain tracked so the next onPointerEnter calls
      // hoverOut correctly and doesn't leave a ghost voice in voices[].
      if (prevHoverIdRef.current === source.cellId) {
        prevHoverIdRef.current = null;
      }

      // Fire API placement
      const token = sessionTokenRef.current;
      const binCode = BIN_CODES[source.overBin as number];
      const latencyMs = hoverStartTimeRef.current != null ? clientTs - hoverStartTimeRef.current : undefined;
      hoverStartTimeRef.current = null;

      if (token && cell) {
        api
          .submitPlacement({ sessionToken: token, trackId: cell.trackId, binCode, clientTs, latencyMs })
          .then((result) => {
            if (!result.ok && result.error.code !== "DUPLICATE_PLACEMENT") {
              // Reject: unseal and surface error
              setPlacedBins((current) => {
                const next = { ...current };
                delete next[source.cellId];
                return next;
              });
              setStatusMessage(`PLACEMENT: ${result.error.code}`);
            }
          });
      }
    };

    requestAnimationFrame(run);
  }, []);

  useEffect(() => {
    if (activeBinPulse === null) {
      return;
    }
    const timeout = window.setTimeout(() => setActiveBinPulse(null), 260);
    return () => window.clearTimeout(timeout);
  }, [activeBinPulse]);

  useEffect(() => {
    if (!isDragging) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) {
        return;
      }
      const overBin = getBinFromPoint(binRefs.current, event.clientX, event.clientY);
      setDragState({
        ...current,
        x: event.clientX - current.offsetX * current.scale,
        y: event.clientY - current.offsetY * current.scale,
        overBin,
      });
    };

    const handlePointerFinish = () => {
      const current = dragRef.current;
      dragRef.current = null;
      setDragState(null);
      if (current && current.overBin !== null) {
        startThrowAnimation(current);
      } else {
        // Released with no bin target: nothing is hovered, kill any playing voice
        audioEngineRef.current?.stopAll();
        prevHoverIdRef.current = null;
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerFinish);
    window.addEventListener("pointercancel", handlePointerFinish);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerFinish);
      window.removeEventListener("pointercancel", handlePointerFinish);
    };
  }, [isDragging, startThrowAnimation]);

  // Grid-level pointer-down handler with CRT-corrected hit testing.
  // The CRT shader visually shifts cells toward the screen centre by up to
  // ~20px at the edges, so clicks on visual cells can miss the DOM hit areas.
  // Applying the forward CRT mapping to the click position converts it to the
  // equivalent source-canvas coordinate, which matches the cell layout data.
  const handleGridPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    // Use the ref (set synchronously on drop) so rapid re-grabs aren't blocked
    // by a stale React state value that hasn't re-rendered yet.
    if (dragRef.current !== null) return;

    const frameRect = frameRef.current?.getBoundingClientRect();
    if (!frameRect) return;

    // Forward CRT mapping: real screen click → source-canvas equivalent position
    const clickFrameX = event.clientX - frameRect.left;
    const clickFrameY = event.clientY - frameRect.top;
    const uvX = clickFrameX / frameRect.width;
    const uvY = 1.0 - clickFrameY / frameRect.height;
    const cxc = uvX * 2.0 - 1.0;
    const cyc = uvY * 2.0 - 1.0;
    const distc = cxc * cxc + cyc * cyc;
    const sc = 1.0 + distc * (CRT_CURVATURE * 0.25);
    const srcFrameX = (cxc * sc * 0.5 + 0.5) * frameRect.width;
    const srcFrameY = (1.0 - (cyc * sc * 0.5 + 0.5)) * frameRect.height;

    // Convert to grid-relative source coordinates
    const gridSrcX = srcFrameX - gridViewport.x;
    const gridSrcY = srcFrameY - gridViewport.y;

    // Find the cell whose layout centre is closest to the corrected click
    let bestCell: Cell | null = null;
    let bestDist = Infinity;
    const HIT_PAD = 8;

    for (const cellId of activeCellIds) {
      const cell = cellById[cellId];
      const layout = displayLayoutByCell[cellId];
      if (!cell || !layout) continue;
      if (throwState !== null && throwState.cellId === cell.index) continue;
      if (placedBins[cell.index] !== undefined) continue;

      const scale = getCellScale(cell.index, hoveredCellId, displayLayoutByCell, false);
      const halfW = layout.width * scale * 0.5 + HIT_PAD;
      const halfH = layout.height * scale * 0.5 + HIT_PAD;

      if (Math.abs(gridSrcX - layout.x) <= halfW && Math.abs(gridSrcY - layout.y) <= halfH) {
        const d = Math.hypot(gridSrcX - layout.x, gridSrcY - layout.y);
        if (d < bestDist) {
          bestDist = d;
          bestCell = cell;
        }
      }
    }

    if (!bestCell) return;

    // Audio intentionally continues while dragging — hoverOut fires only when
    // drag ends without placement (stopAll) or placement is confirmed (hoverOut).

    const cell = bestCell;
    const pickupScale = getCellScale(cell.index, hoveredCellId, displayLayoutByCell, false);
    const layout = displayLayoutByCell[cell.index];
    if (!layout) return;

    const baseWidth = layout.width;
    const baseHeight = layout.height;

    // Offset = where in the cell (source-canvas space) the user clicked.
    // Using CRT-corrected source coords gives stable hotspot alignment when
    // the item is rendered back through forward CRT mapping in drawSourceSurface.
    const cellOriginSrcX = gridViewport.x + layout.x - baseWidth * pickupScale * 0.5;
    const cellOriginSrcY = gridViewport.y + layout.y - baseHeight * pickupScale * 0.5;
    const clampedOffsetX = clamp((srcFrameX - cellOriginSrcX) / pickupScale, 0, baseWidth);
    const clampedOffsetY = clamp((srcFrameY - cellOriginSrcY) / pickupScale, 0, baseHeight);
    const originX = event.clientX - clampedOffsetX * pickupScale;
    const originY = event.clientY - clampedOffsetY * pickupScale;

    if (cellLeaveTimeoutRef.current !== null) {
      clearTimeout(cellLeaveTimeoutRef.current);
      cellLeaveTimeoutRef.current = null;
    }
    setDragState({
      cellId: cell.index,
      code: cell.code,
      x: originX,
      y: originY,
      width: baseWidth,
      height: baseHeight,
      scale: pickupScale,
      offsetX: clampedOffsetX,
      offsetY: clampedOffsetY,
      overBin: getBinFromPoint(binRefs.current, event.clientX, event.clientY),
    });
    setHoveredCellId(null);
    event.preventDefault();
  };

  const resetFile = useCallback(async () => {
    await initSession(true, null);
  }, [initSession]);

  const surfaceCells = useMemo(
    () =>
      activeCellIds
        .map((cellId) => {
          const cell = cellById[cellId];
          const layout = displayLayoutByCell[cellId];
          if (!cell || !layout) {
            return null;
          }
          const isDragOrigin = dragState?.cellId === cell.index || throwState?.cellId === cell.index;
          const scale = getCellScale(cell.index, hoveredCellId, displayLayoutByCell, isDragging);
          return {
            id: cell.index,
            code: cell.code,
            x: layout.x,
            y: layout.y,
            width: layout.width,
            height: layout.height,
            scale,
            isDragOrigin,
          };
        })
        .filter((cell): cell is NonNullable<typeof cell> => cell !== null),
    [activeCellIds, cellById, displayLayoutByCell, dragState?.cellId, hoveredCellId, isDragging, throwState?.cellId],
  );

  const footerRight = statusMessage
    ? statusMessage
    : bgLoad
      ? `AUDIO ${String(bgLoad.upgraded).padStart(2, "0")}/${String(bgLoad.total).padStart(2, "0")}`
      : sessionDegraded
        ? `POOL: DEGRADED`
        : "LATENCY: OK";

  return (
    <main className={`app-shell${crtStatus === "ready" ? " crt-active" : ""}`}>
      <div className="crt-scene">
        <section
          ref={frameRef}
          className={`refine-frame${crtStatus === "ready" ? " refine-frame-proxy" : ""}`}
          aria-label="Refine Console"
        >
          <header className="frame-row frame-header">
            <div className="title-lockup">
              <h1>MacroVibe Refinement</h1>
              <div className="header-bars" aria-hidden="true">
                {headerBars.map((bar) => (
                  <span key={bar} />
                ))}
              </div>
            </div>
            <p className="progress-text">
              PROGRESS: {String(placedCount).padStart(3, "0")} / {String(sessionSize).padStart(3, "0")}
            </p>
          </header>

          <section
            className="frame-row frame-grid"
            aria-label="Refine Grid"
            onPointerDown={handleGridPointerDown}
            onPointerMove={(event) => {
              const rect = gridRef.current?.getBoundingClientRect();
              if (!rect) {
                return;
              }
              setPointerInGrid({
                x: clamp(event.clientX - rect.left, 0, rect.width),
                y: clamp(event.clientY - rect.top, 0, rect.height),
              });
            }}
            onPointerLeave={() => {
              if (cellLeaveTimeoutRef.current !== null) {
                clearTimeout(cellLeaveTimeoutRef.current);
                cellLeaveTimeoutRef.current = null;
              }
              setHoveredCellId(null);
              setPointerInGrid(null);
              // While dragging, the pointer naturally exits the grid heading toward
              // a bin — do not cut audio here. The throw/cancel handlers own that.
              if (!isDragging) {
                prevHoverIdRef.current = null;
                audioEngineRef.current?.stopAll();
              }
            }}
          >
            <ol ref={gridRef} className="grid" role="list">
              {activeCellIds.map((cellId) => {
                const cell = cellById[cellId];
                const layout = displayLayoutByCell[cellId];
                if (!layout) {
                  return null;
                }
                const isDragOrigin = dragState?.cellId === cell.index || throwState?.cellId === cell.index;
                const isHovered = hoveredCellId === cell.index;
                const scale = getCellScale(cell.index, hoveredCellId, displayLayoutByCell, isDragging);
                const wobbleStyle = {
                  "--float-x": `${cell.floatX}px`,
                  "--float-y": `${cell.floatY}px`,
                  animationDuration: `${cell.floatDuration}s`,
                  animationDelay: `-${cell.floatDelay}s`,
                } as CSSProperties;

                return (
                  <li
                    key={cell.index}
                    className={`grid-cell${isDragOrigin ? " is-drag-origin" : ""}${isHovered ? " is-hovered" : ""}`}
                    style={{
                      width: `${layout.width}px`,
                      height: `${layout.height}px`,
                      transform: `translate3d(${layout.x}px, ${layout.y}px, 0) translate(-50%, -50%) scale(${scale})`,
                    }}
                    onPointerEnter={() => {
                      // Cancel any pending leave-clear before processing enter
                      if (cellLeaveTimeoutRef.current !== null) {
                        clearTimeout(cellLeaveTimeoutRef.current);
                        cellLeaveTimeoutRef.current = null;
                      }
                      if (isDragging) return;
                      setHoveredCellId(cell.index);
                      if (hoverStartTimeRef.current === null) {
                        hoverStartTimeRef.current = Date.now();
                      }
                      if (audioPhase === "ready") {
                        const engine = audioEngineRef.current;
                        const prev = prevHoverIdRef.current;
                        if (prev !== null && prev !== cell.index) {
                          engine?.hoverOut(cellsRef.current[prev]?.trackId ?? `track-${prev + 1}`);
                        }
                        engine?.hoverIn(cell.trackId);
                        prevHoverIdRef.current = cell.index;
                      }
                    }}
                    onPointerLeave={() => {
                      // Defer the clear — if the pointer enters another cell before
                      // the timeout fires, that enter handler cancels this timeout,
                      // avoiding a "default" cursor flash when crossing between cells.
                      const leavingId = cell.index;
                      const leavingTrackId = cell.trackId;
                      cellLeaveTimeoutRef.current = setTimeout(() => {
                        cellLeaveTimeoutRef.current = null;
                        setHoveredCellId((current) => (current === leavingId ? null : current));
                        // During a drag the pointer naturally exits the cell heading
                        // toward a bin — audio must keep playing until drop/cancel.
                        if (dragRef.current) return;
                        if (prevHoverIdRef.current === leavingId) {
                          audioEngineRef.current?.hoverOut(leavingTrackId);
                          prevHoverIdRef.current = null;
                        }
                      }, 0);
                    }}
                  >
                    <span className="cell-wobble" style={wobbleStyle}>
                      <span className="cell-shell">
                        <span className="cell-code">{cell.code}</span>
                      </span>
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>

          <section className="frame-row frame-bins" aria-label="Bin Shelf">
            {BIN_CODES.map((code, index) => {
              const isOpen = dragState?.overBin === index;
              const isPulse = activeBinPulse === index;
              return (
                <article
                  key={code}
                  ref={(element) => {
                    binRefs.current[index] = element;
                  }}
                  className={`bin${isOpen ? " is-open" : ""}${isPulse ? " is-pulse" : ""}`}
                  onPointerEnter={() => {
                    if (!isDragging && BIN_PLAYLIST_URLS[code]) setHoveredBinPlaylist(index);
                  }}
                  onPointerLeave={() => setHoveredBinPlaylist(null)}
                  onClick={() => {
                    if (!isDragging) {
                      const url = BIN_PLAYLIST_URLS[code];
                      if (url) window.open(url, "_blank", "noopener noreferrer");
                    }
                  }}
                >
                  <div className="bin-lid" aria-hidden="true">
                    <span className="bin-flap bin-flap-left" />
                    <span className="bin-flap bin-flap-right" />
                    <span className="bin-mouth" />
                  </div>
                  <div className="bin-label-row">
                    <span className={`bin-key accent-${index % 4}`}>{index + 1}</span>
                    <span className="bin-code">{code}</span>
                  </div>
                  <div className="bin-meter" aria-hidden="true">
                    <div className={`bin-meter-fill accent-bg-${index % 4}`} style={{ width: `${meterValues[index]}%` }} />
                  </div>
                </article>
              );
            })}
          </section>

          <footer className="frame-row frame-status">
            <span>SESSION: {sessionLabel}</span>
            <span>
              {audioPhase === "locked"
                ? "AUDIO: LOCKED"
                : audioPhase === "preloading"
                  ? "AUDIO: LOADING"
                  : "AUDIO: ARMED"}
            </span>
            <span className={statusMessage ? "status-alert" : ""}>{footerRight}</span>
          </footer>

          {isComplete && (
            <div className="completion-overlay">
              <div className="completion-overlay-buttons">
                <button
                  type="button"
                  className="completion-button"
                  onClick={resetFile}
                  onPointerEnter={() => setHoveredButton(true)}
                  onPointerLeave={() => setHoveredButton(false)}
                >
                  START NEW FILE
                </button>
                <button
                  type="button"
                  className="completion-button is-secondary"
                  onClick={() => setShowAlignment(true)}
                  onPointerEnter={() => setHoveredButton(true)}
                  onPointerLeave={() => setHoveredButton(false)}
                >
                  VIEW ALIGNMENT REPORT
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      {/* Gate / preload — position:fixed z-index:50, above the CRT canvas (z-index:40).
          When CRT is ready: transparent (CRT draws the visual) but still the active
          click layer, so the button and archive link fire normally. When CRT is not
          ready: fully visible as the DOM fallback. */}
      {audioPhase !== "ready" && (
        <div
          className={`audio-gate-overlay${crtStatus === "ready" ? " audio-gate-overlay--transparent" : ""}`}
          aria-modal="true"
          role="dialog"
          aria-label="Session gate"
        >
          {audioPhase === "locked" ? (
            <div className="gate-lockup">
              <div className="gate-stack">
                <img src={logoUrl} className="gate-logo" alt="MacroVibe Refinement" aria-hidden="true" />
                {sessionInitError && (
                  <p className="gate-error">ERROR: {sessionInitError}</p>
                )}
                <button
                  type="button"
                  className="gate-button"
                  onClick={handleUnlock}
                  onPointerEnter={() => setHoveredButton(true)}
                  onPointerLeave={() => setHoveredButton(false)}
                >
                  BEGIN REFINEMENT
                </button>
              </div>
              <p className="gate-tagline">a collective curation experiment</p>
            </div>
          ) : (
            <div className="preload-screen">
              <img src={logoUrl} className="gate-logo preload-logo" alt="MacroVibe Refinement" aria-hidden="true" />
              <div className="preload-status">
                <p className="preload-label">LOADING SESSION AUDIO</p>
                <div
                  className="preload-bar-wrap"
                  role="progressbar"
                  aria-valuenow={preloadProgress.loaded}
                  aria-valuemax={preloadProgress.total}
                >
                  <div
                    className="preload-bar-fill"
                    style={{
                      width: `${Math.round((preloadProgress.loaded / Math.max(1, preloadProgress.total)) * 100)}%`,
                    }}
                  />
                </div>
                <p className="preload-count">
                  {String(preloadProgress.loaded).padStart(3, "0")} /{" "}
                  {String(preloadProgress.total).padStart(3, "0")}
                </p>
              </div>
            </div>
          )}
        </div>
      )}
      <CrtWebglOverlay
        frameRef={frameRef}
        gridViewport={gridViewport}
        cells={surfaceCells}
        meterValues={meterValues}
        binCodes={BIN_CODES}
        placedCount={placedCount}
        sessionSize={sessionSize}
        activeBin={dragState?.overBin ?? null}
        pulseBin={activeBinPulse}
        hoveredBinPlaylist={hoveredBinPlaylist}
        dragState={dragState}
        throwState={throwState}
        audioPhase={audioPhase}
        preloadProgress={preloadProgress}
        sessionInitError={sessionInitError}
        onStatusChange={setCrtStatus}
        cursorType={cursorType}
      />

      {showAlignment && sessionToken && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60 }}>
          <AlignmentReport
            cells={cells}
            placedBins={placedBins}
            sessionToken={sessionToken}
            onNewFile={() => {
              setShowAlignment(false);
              resetFile();
            }}
          />
        </div>
      )}
    </main>
  );
}
