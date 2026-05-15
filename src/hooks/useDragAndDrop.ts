import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { api } from "../api";
import type { AudioEngine } from "../AudioEngine";
import type { Cell, CellLayout, DragState, ThrowState } from "../types";
import {
  CRT_CURVATURE,
  BIN_CODES,
  THROW_X_MS,
  THROW_Y_MS,
  THROW_TARGET_SCALE,
  clamp,
  lerp,
  easeInOut,
  easeOut,
  getCellScale,
  getBinFromPoint,
} from "../utils";

type UseDragAndDropParams = {
  // Read-only inputs (mirrored into refs internally)
  activeCellIds: number[];
  cellById: Record<number, Cell>;
  displayLayoutByCell: Record<number, CellLayout>;
  hoveredCellId: number | null;
  gridViewport: { x: number; y: number; width: number; height: number };
  // DOM refs
  frameRef: RefObject<HTMLElement | null>;
  binRefs: RefObject<Array<HTMLElement | null>>;
  // Shared refs from useAudioSession
  audioEngineRef: RefObject<AudioEngine | null>;
  sessionTokenRef: RefObject<string | null>;
  hoverStartTimeRef: RefObject<number | null>;
  prevHoverIdRef: RefObject<number | null>;
  // Callbacks
  setHoveredCellId: (id: number | null) => void;
  setStatusMessage: (msg: string | null) => void;
};

export type UseDragAndDropResult = {
  dragState: DragState | null;
  throwState: ThrowState | null;
  activeBinPulse: number | null;
  placedBins: Record<number, number>;
  setPlacedBins: React.Dispatch<React.SetStateAction<Record<number, number>>>;
  dragRef: React.MutableRefObject<DragState | null>;
  cellLeaveTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  handleGridPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  resetDrag: () => void;
};

export function useDragAndDrop({
  activeCellIds,
  cellById,
  displayLayoutByCell,
  hoveredCellId,
  gridViewport,
  frameRef,
  binRefs,
  audioEngineRef,
  sessionTokenRef,
  hoverStartTimeRef,
  prevHoverIdRef,
  setHoveredCellId,
  setStatusMessage,
}: UseDragAndDropParams): UseDragAndDropResult {
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [throwState, setThrowState] = useState<ThrowState | null>(null);
  const [activeBinPulse, setActiveBinPulse] = useState<number | null>(null);
  const [placedBins, setPlacedBins] = useState<Record<number, number>>({});

  // Synchronous ref kept in step with dragState so rapid re-grabs read the
  // latest value without waiting for a React re-render.
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = dragState;

  // Debounce ref for clearing hoveredCellId on cell leave so moving directly
  // between adjacent cells doesn't flash the cursor to "default".
  const cellLeaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mirror frequently-changing inputs into refs so stable callbacks don't need
  // to be recreated on every render.
  const activeCellIdsRef = useRef(activeCellIds);
  activeCellIdsRef.current = activeCellIds;
  const cellByIdRef = useRef(cellById);
  cellByIdRef.current = cellById;
  const displayLayoutByCellRef = useRef(displayLayoutByCell);
  displayLayoutByCellRef.current = displayLayoutByCell;
  const hoveredCellIdRef = useRef(hoveredCellId);
  hoveredCellIdRef.current = hoveredCellId;
  const gridViewportRef = useRef(gridViewport);
  gridViewportRef.current = gridViewport;
  const throwStateRef = useRef(throwState);
  throwStateRef.current = throwState;
  const placedBinsRef = useRef(placedBins);
  placedBinsRef.current = placedBins;
  const setStatusMessageRef = useRef(setStatusMessage);
  setStatusMessageRef.current = setStatusMessage;
  const setHoveredCellIdRef = useRef(setHoveredCellId);
  setHoveredCellIdRef.current = setHoveredCellId;

  // Clear placedBins/drag/throw state at the start of each new session.
  const resetDrag = useCallback(() => {
    setPlacedBins({});
    dragRef.current = null;
    setDragState(null);
    setThrowState(null);
    setActiveBinPulse(null);
  }, []);

  // Clear the pulse CSS class after the animation completes.
  useEffect(() => {
    if (activeBinPulse === null) return;
    const timeout = window.setTimeout(() => setActiveBinPulse(null), 260);
    return () => window.clearTimeout(timeout);
  }, [activeBinPulse]);

  // ── Throw animation ─────────────────────────────────────────────────────────
  // Parabolic arc: X eases out over THROW_X_MS, Y eases in-out over THROW_Y_MS.
  // The cell scales from its pickup size down to THROW_TARGET_SCALE and fades
  // out in the final quarter of the Y travel. Placement is optimistic — the cell
  // is sealed immediately and the API call confirms or reverts asynchronously.
  const startThrowAnimation = useCallback((source: DragState) => {
    if (source.overBin === null) return;
    const binElement = binRefs.current[source.overBin];
    if (!binElement) return;

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
      const centerY =
        lerp(startCenterY, targetCenterY, easedY) + Math.sin(Math.PI * yProgress) * 6;
      const opacityFadeProgress = clamp((yProgress - 0.74) / 0.26, 0, 1);
      const opacity = lerp(1, 0.16, easeInOut(opacityFadeProgress));

      setThrowState((current) => {
        if (!current) return null;
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

      // ── Animation complete — optimistically seal the cell ─────────────────
      setThrowState(null);
      setPlacedBins((current) => ({ ...current, [source.cellId]: source.overBin as number }));
      setActiveBinPulse(source.overBin);

      // Fade out audio. Only clear prevHoverIdRef if it still points to this
      // cell — the user may have moved to another cell during the throw.
      audioEngineRef.current?.hoverOut(source.trackId);
      if (prevHoverIdRef.current === source.cellId) prevHoverIdRef.current = null;

      // ── Async API placement ───────────────────────────────────────────────
      const token = sessionTokenRef.current;
      const binCode = BIN_CODES[source.overBin as number];
      const latencyMs =
        hoverStartTimeRef.current != null ? clientTs - hoverStartTimeRef.current : undefined;
      hoverStartTimeRef.current = null;

      if (token) {
        api
          .submitPlacement({ sessionToken: token, trackId: source.trackId, binCode, clientTs, latencyMs })
          .then((result) => {
            if (!result.ok && result.error.code !== "DUPLICATE_PLACEMENT") {
              // API rejected — unseal and surface the error.
              setPlacedBins((current) => {
                const next = { ...current };
                delete next[source.cellId];
                return next;
              });
              setStatusMessageRef.current(`PLACEMENT: ${result.error.code}`);
            }
          });
      }
    };

    requestAnimationFrame(run);
  }, [audioEngineRef, binRefs, hoverStartTimeRef, prevHoverIdRef, sessionTokenRef]);

  // ── Global pointer listeners during active drag ─────────────────────────────
  const isDragging = dragState !== null;
  useEffect(() => {
    if (!isDragging) return;

    const handlePointerMove = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
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
        // Released over empty space — kill audio and clear hover tracking.
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
  }, [isDragging, startThrowAnimation, audioEngineRef, binRefs, prevHoverIdRef]);

  // ── Grid pointer-down with CRT-corrected hit testing ───────────────────────
  // The CRT shader barrel-distorts the image, visually shifting cells toward
  // the screen centre by up to ~20 px at the edges. Applying the forward CRT
  // mapping to the click position converts it to the equivalent source-canvas
  // coordinate, which aligns with the layout data produced by usePhysics.
  const handleGridPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (dragRef.current !== null) return; // guard against rapid re-grab

      const frameRect = frameRef.current?.getBoundingClientRect();
      if (!frameRect) return;

      // Forward CRT mapping: real screen click → source-canvas equivalent.
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

      const gv = gridViewportRef.current;
      const gridSrcX = srcFrameX - gv.x;
      const gridSrcY = srcFrameY - gv.y;

      // Find the closest cell whose bounds contain the corrected click point.
      const displayLayout = displayLayoutByCellRef.current;
      const cells = cellByIdRef.current;
      const hoveredId = hoveredCellIdRef.current;
      const throwSt = throwStateRef.current;
      const placed = placedBinsRef.current;

      let bestCell: Cell | null = null;
      let bestDist = Infinity;
      const HIT_PAD = 8;

      for (const cellId of activeCellIdsRef.current) {
        const cell = cells[cellId];
        const layout = displayLayout[cellId];
        if (!cell || !layout) continue;
        if (throwSt !== null && throwSt.cellId === cell.index) continue;
        if (placed[cell.index] !== undefined) continue;

        const scale = getCellScale(cell.index, hoveredId, displayLayout, false);
        const halfW = layout.width * scale * 0.5 + HIT_PAD;
        const halfH = layout.height * scale * 0.5 + HIT_PAD;

        if (
          Math.abs(gridSrcX - layout.x) <= halfW &&
          Math.abs(gridSrcY - layout.y) <= halfH
        ) {
          const d = Math.hypot(gridSrcX - layout.x, gridSrcY - layout.y);
          if (d < bestDist) {
            bestDist = d;
            bestCell = cell;
          }
        }
      }

      if (!bestCell) return;

      // Audio intentionally continues while dragging — hoverOut fires only on
      // confirmed placement or release over empty space.
      const cell = bestCell;
      const pickupScale = getCellScale(cell.index, hoveredId, displayLayout, false);
      const layout = displayLayout[cell.index];
      if (!layout) return;

      const baseWidth = layout.width;
      const baseHeight = layout.height;

      // Offset = where in the cell (source-canvas space) the pointer clicked.
      // Using CRT-corrected source coords keeps the hotspot stable after the
      // item is rendered back through the forward CRT mapping in drawSourceSurface.
      const cellOriginSrcX = gv.x + layout.x - baseWidth * pickupScale * 0.5;
      const cellOriginSrcY = gv.y + layout.y - baseHeight * pickupScale * 0.5;
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
        trackId: cell.trackId,
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
      setHoveredCellIdRef.current(null);
      event.preventDefault();
    },
    [frameRef, binRefs],
  );

  return {
    dragState,
    throwState,
    activeBinPulse,
    placedBins,
    setPlacedBins,
    dragRef,
    cellLeaveTimeoutRef,
    handleGridPointerDown,
    resetDrag,
  };
}
