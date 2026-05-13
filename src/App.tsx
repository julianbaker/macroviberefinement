import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { CrtWebglOverlay } from "./CrtWebglOverlay";
import type { CursorType } from "./CrtWebglOverlay";
import { AlignmentReport } from "./AlignmentReport";
import { useAudioSession } from "./hooks/useAudioSession";
import { usePhysics } from "./hooks/usePhysics";
import { useDragAndDrop } from "./hooks/useDragAndDrop";
import type { CellLayout, PointerState } from "./types";
import {
  BIN_CODES,
  BIN_PLAYLIST_URLS,
  BIN_METERS,
  SESSION_SIZE_MAX,
  clamp,
  getCellScale,
} from "./utils";
import logoUrl from "./assets/MVRLogo.svg?url";

export function App() {
  const headerBars = Array.from({ length: 22 }, (_, idx) => idx);

  // ── DOM refs ──────────────────────────────────────────────────────────────────
  const frameRef = useRef<HTMLElement | null>(null);
  const binRefs = useRef<Array<HTMLElement | null>>([]);
  const gridRef = useRef<HTMLOListElement | null>(null);

  // ── UI state ──────────────────────────────────────────────────────────────────
  const [hoveredCellId, setHoveredCellId] = useState<number | null>(null);
  const [hoveredBinPlaylist, setHoveredBinPlaylist] = useState<number | null>(null);
  const [hoveredButton, setHoveredButton] = useState(false);
  const [gridSize, setGridSize] = useState({ width: 0, height: 0 });
  const [gridViewport, setGridViewport] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const [pointerInGrid, setPointerInGrid] = useState<PointerState | null>(null);
  const [crtStatus, setCrtStatus] = useState<"initializing" | "ready" | "failed">("initializing");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [showAlignment, setShowAlignment] = useState(false);

  // ── Cross-hook reset coordination ─────────────────────────────────────────────
  // useAudioSession's onWillReset fires at the top of initSession (before any
  // awaits). resetDrag and resetPhysics aren't available until after their hooks
  // are called, so we indirectly call them through stable refs that we populate
  // immediately after each hook returns.
  const resetDragRef = useRef<() => void>(() => {});
  const resetPhysicsRef = useRef<() => void>(() => {});

  // ── Audio / session hook ──────────────────────────────────────────────────────
  const {
    sessionToken, sessionSize, sessionDegraded, sessionLabel, sessionInitError,
    cells, setCells,
    audioPhase, preloadProgress, bgLoad,
    handleUnlock, initSession,
    audioEngineRef, hoverStartTimeRef, prevHoverIdRef, sessionTokenRef, cellsRef,
  } = useAudioSession({
    onWillReset: () => {
      // Calling through refs means we always invoke the real reset functions,
      // even though they're defined later in this render sequence.
      resetDragRef.current();
      resetPhysicsRef.current();
      setHoveredCellId(null);
    },
    setStatusMessage,
  });

  // ── Derived cell maps ─────────────────────────────────────────────────────────
  const cellById = useMemo(() => {
    const map: Record<number, (typeof cells)[number]> = {};
    for (const cell of cells) map[cell.index] = cell;
    return map;
  }, [cells]);

  // All cell IDs regardless of placement state. Passed to useDragAndDrop for
  // hit testing — the hook's pointer-down handler skips already-placed cells
  // via an explicit placed-bins check, so passing the unfiltered list is safe.
  const allCellIds = useMemo(() => cells.map((c) => c.index), [cells]);

  // layout ref shared between usePhysics (writer) and useDragAndDrop (reader).
  // Updated below after usePhysics runs; always holds the most recent layout.
  const displayLayoutRef = useRef<Record<number, CellLayout>>({});

  // ── Drag / drop hook ──────────────────────────────────────────────────────────
  // Called before usePhysics so we can get placedBins to compute activeCellIds.
  const {
    dragState, throwState, activeBinPulse,
    placedBins, setPlacedBins,
    dragRef, cellLeaveTimeoutRef,
    handleGridPointerDown, resetDrag,
  } = useDragAndDrop({
    activeCellIds: allCellIds,           // unfiltered; placed cells are skipped inside
    displayLayoutByCell: displayLayoutRef.current, // starts {}; correct after first render
    hoveredCellId,
    gridViewport,
    frameRef,
    binRefs,
    audioEngineRef,
    cellsRef,
    sessionTokenRef,
    hoverStartTimeRef,
    prevHoverIdRef,
    setHoveredCellId,
    setStatusMessage,
    cellById,
  });
  resetDragRef.current = resetDrag; // keep reset ref current every render

  // ── Filtered active cell IDs ──────────────────────────────────────────────────
  // Now that placedBins is available we can correctly exclude placed cells.
  // This is the list usePhysics simulates and the JSX renders.
  const activeCellIds = useMemo(
    () =>
      allCellIds
        .filter((id) => placedBins[id] === undefined)
        .sort((a, b) => a - b),
    [allCellIds, placedBins],
  );

  // ── Physics hook ──────────────────────────────────────────────────────────────
  const isDragging = dragState !== null;
  const {
    displayLayoutByCell,
    resetPhysics,
  } = usePhysics({
    activeCellIds,
    gridSize,
    cells,
    placedBins,
    hoveredCellId,
    pointerInGrid,
    dragCellId: dragState?.cellId ?? null,
    throwCellId: throwState?.cellId ?? null,
    isDragging,
  });
  resetPhysicsRef.current = resetPhysics; // keep reset ref current every render

  // Propagate the latest layout into the shared ref so useDragAndDrop's hit
  // testing always reads current positions on the next interaction.
  displayLayoutRef.current = displayLayoutByCell;

  // ── Grid resize observer ──────────────────────────────────────────────────────
  useEffect(() => {
    const element = gridRef.current;
    if (!element) return;
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
    return () => observer.disconnect();
  }, []);

  // ── Auto-clear status message ─────────────────────────────────────────────────
  useEffect(() => {
    if (!statusMessage) return;
    const id = window.setTimeout(() => setStatusMessage(null), 4200);
    return () => window.clearTimeout(id);
  }, [statusMessage]);

  // ── Reset hoveredButton when visible interactive elements change ───────────────
  // Clicking a button can unmount it before onPointerLeave fires, leaving the
  // cursor permanently stuck on "pointer".
  const placedCount = Object.keys(placedBins).length;
  const isComplete = cells.length > 0 && placedCount >= sessionSize;
  useEffect(() => {
    setHoveredButton(false);
  }, [audioPhase, isComplete]);

  // ── Computed UI values ─────────────────────────────────────────────────────────
  const inGatePhase = audioPhase === "locked" || audioPhase === "preloading";

  const cursorType: CursorType = inGatePhase
    ? hoveredButton ? "pointer" : "default"
    : isDragging
      ? "grabbing"
      : hoveredCellId !== null
        ? "grab"
        : hoveredBinPlaylist !== null || hoveredButton
          ? "pointer"
          : "default";

  const meterValues = useMemo(() => {
    const counts = new Array(BIN_CODES.length).fill(0);
    for (const binIndex of Object.values(placedBins)) counts[binIndex] += 1;
    return BIN_METERS.map((base, index) => clamp(base + counts[index] * 2, 8, 98));
  }, [placedBins]);

  // Cells passed to the CRT surface — only unplaced cells with current layout.
  const surfaceCells = useMemo(
    () =>
      activeCellIds
        .map((cellId) => {
          const cell = cellById[cellId];
          const layout = displayLayoutByCell[cellId];
          if (!cell || !layout) return null;
          const isDragOrigin =
            dragState?.cellId === cell.index || throwState?.cellId === cell.index;
          return {
            id: cell.index,
            code: cell.code,
            x: layout.x,
            y: layout.y,
            width: layout.width,
            height: layout.height,
            scale: getCellScale(cell.index, hoveredCellId, displayLayoutByCell, isDragging),
            isDragOrigin,
          };
        })
        .filter((c): c is NonNullable<typeof c> => c !== null),
    [activeCellIds, cellById, displayLayoutByCell, dragState?.cellId, hoveredCellId, isDragging, throwState?.cellId],
  );

  // Footer values — also passed to the CRT canvas so it shows real session data
  // rather than the placeholder strings baked into the original draw code.
  const footerCenter =
    audioPhase === "locked"
      ? "AUDIO: LOCKED"
      : audioPhase === "preloading"
        ? "AUDIO: LOADING"
        : "AUDIO: ARMED";

  const footerRight = statusMessage
    ? statusMessage
    : bgLoad
      ? `AUDIO ${String(bgLoad.upgraded).padStart(2, "0")}/${String(bgLoad.total).padStart(2, "0")}`
      : sessionDegraded
        ? "POOL: DEGRADED"
        : "LATENCY: OK";

  const resetFile = async () => initSession(true, null);

  // ── Render ─────────────────────────────────────────────────────────────────────
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
              if (!rect) return;
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
                if (!layout) return null;
                const isDragOrigin =
                  dragState?.cellId === cell.index || throwState?.cellId === cell.index;
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
                      // Cancel any pending leave-clear before processing enter.
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
                      // the timeout fires, that enter handler cancels this one,
                      // avoiding a "default" cursor flash when crossing between cells.
                      const leavingId = cell.index;
                      const leavingTrackId = cell.trackId;
                      cellLeaveTimeoutRef.current = setTimeout(() => {
                        cellLeaveTimeoutRef.current = null;
                        setHoveredCellId((current) => (current === leavingId ? null : current));
                        // During a drag the pointer exits toward a bin — audio must
                        // keep playing until drop/cancel.
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
                  ref={(element) => { binRefs.current[index] = element; }}
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
                    <div
                      className={`bin-meter-fill accent-bg-${index % 4}`}
                      style={{ width: `${meterValues[index]}%` }}
                    />
                  </div>
                </article>
              );
            })}
          </section>

          <footer className="frame-row frame-status">
            <span>SESSION: {sessionLabel}</span>
            <span>{footerCenter}</span>
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
          click layer so buttons fire normally. When CRT fails: fully visible DOM fallback. */}
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
                  START REFINING
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
        sessionLabel={`SESSION: ${sessionLabel}`}
        footerCenter={footerCenter}
        footerRight={footerRight}
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
