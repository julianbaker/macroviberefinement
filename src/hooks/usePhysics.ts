import { useCallback, useEffect, useRef, useState } from "react";
import type { Cell, CellLayout, CellNode, PointerState } from "../types";
import { clamp, buildHomeLayout } from "../utils";

type UsePhysicsParams = {
  activeCellIds: number[];
  gridSize: { width: number; height: number };
  cells: Cell[];
  placedBins: Record<number, number>;
  hoveredCellId: number | null;
  pointerInGrid: PointerState | null;
  dragCellId: number | null;
  throwCellId: number | null;
  isDragging: boolean;
};

type UsePhysicsResult = {
  displayLayoutByCell: Record<number, CellLayout>;
  physicsRef: React.MutableRefObject<Record<number, CellNode>>;
  homeLayoutRef: React.MutableRefObject<Record<number, CellLayout>>;
  resetPhysics: () => void;
};

export function usePhysics({
  activeCellIds,
  gridSize,
  cells,
  placedBins,
  hoveredCellId,
  pointerInGrid,
  dragCellId,
  throwCellId,
  isDragging,
}: UsePhysicsParams): UsePhysicsResult {
  const physicsRef = useRef<Record<number, CellNode>>({});
  const homeLayoutRef = useRef<Record<number, CellLayout>>({});
  const [displayLayoutByCell, setDisplayLayoutByCell] = useState<Record<number, CellLayout>>({});

  // Mirror frequently-changing inputs into refs so the rAF loop can read the
  // latest values without being restarted on every hover/pointer change.
  const hoveredCellIdRef = useRef(hoveredCellId);
  hoveredCellIdRef.current = hoveredCellId;
  const pointerInGridRef = useRef(pointerInGrid);
  pointerInGridRef.current = pointerInGrid;
  const dragCellIdRef = useRef(dragCellId);
  dragCellIdRef.current = dragCellId;
  const throwCellIdRef = useRef(throwCellId);
  throwCellIdRef.current = throwCellId;
  const isDraggingRef = useRef(isDragging);
  isDraggingRef.current = isDragging;
  const gridSizeRef = useRef(gridSize);
  gridSizeRef.current = gridSize;

  // Called by useAudioSession at the start of initSession to wipe stale state.
  const resetPhysics = useCallback(() => {
    physicsRef.current = {};
    setDisplayLayoutByCell({});
  }, []);

  // Rebuild home positions and physics nodes whenever the grid or cell list changes.
  useEffect(() => {
    if (gridSize.width <= 0 || gridSize.height <= 0 || cells.length === 0) return;

    const home = buildHomeLayout(gridSize.width, gridSize.height, cells);
    homeLayoutRef.current = home;

    const rebuilt: Record<number, CellNode> = {};
    for (const cell of cells) {
      if (placedBins[cell.index] !== undefined) continue;
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

  // Physics rAF loop — runs continuously, reads live values through refs so it
  // only needs to restart when the cell set or grid size actually changes.
  useEffect(() => {
    let lastTickMs = 0;
    let lastLayoutCommitMs = 0;
    let rafId: number;

    const tick = () => {
      const nowMs = performance.now();
      const previousMs = lastTickMs || nowMs;
      const dt = clamp((nowMs - previousMs) / 16.666, 0.68, 1.6);
      const now = nowMs * 0.001;
      lastTickMs = nowMs;

      const ids = activeCellIds;
      const { width: gWidth, height: gHeight } = gridSizeRef.current;
      const hoveredCellId = hoveredCellIdRef.current;
      const pointerInGrid = pointerInGridRef.current;
      const dragCellId = dragCellIdRef.current;
      const throwCellId = throwCellIdRef.current;
      const isDragging = isDraggingRef.current;

      if (ids.length > 0) {
        const nodes = physicsRef.current;
        const forceById: Record<number, { fx: number; fy: number }> = {};
        const centerX = gWidth * 0.5;
        const centerY = gHeight * 0.5;
        const repelRadius = Math.min(246, Math.max(142, (gWidth + gHeight) * 0.105));
        const repelRadiusSq = repelRadius * repelRadius;

        // ── Per-cell orbit + flow forces ──────────────────────────────────────
        ids.forEach((id) => {
          const node = nodes[id];
          if (!node) return;
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

        // ── O(n²) pairwise cell repulsion ─────────────────────────────────────
        // At SESSION_SIZE_MAX = 64 this is at most 2 016 distance checks per
        // frame — well within budget. Spatial partitioning would add complexity
        // with no meaningful gain at this session size.
        for (let i = 0; i < ids.length; i += 1) {
          const idA = ids[i];
          const a = nodes[idA];
          if (!a) continue;
          for (let j = i + 1; j < ids.length; j += 1) {
            const idB = ids[j];
            const b = nodes[idB];
            if (!b) continue;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dSq = dx * dx + dy * dy;
            if (dSq <= 0.0001 || dSq > repelRadiusSq) continue;
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

        // ── Pointer repulsion ─────────────────────────────────────────────────
        if (pointerInGrid && !isDragging) {
          const pointerRadius = Math.min(250, Math.max(146, (gWidth + gHeight) * 0.11));
          const pointerRadiusSq = pointerRadius * pointerRadius;
          ids.forEach((id) => {
            const node = nodes[id];
            if (!node) return;
            const dx = node.x - pointerInGrid.x;
            const dy = node.y - pointerInGrid.y;
            const dSq = dx * dx + dy * dy;
            if (dSq <= 0.0001 || dSq > pointerRadiusSq) return;
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

        // ── Hovered-cell push ─────────────────────────────────────────────────
        if (hoveredCellId !== null && nodes[hoveredCellId] && !isDragging) {
          const hovered = nodes[hoveredCellId];
          const pushRadius = Math.min(238, Math.max(134, (gWidth + gHeight) * 0.098));
          const pushRadiusSq = pushRadius * pushRadius;
          ids.forEach((id) => {
            if (id === hoveredCellId) return;
            const node = nodes[id];
            if (!node) return;
            const dx = node.x - hovered.x;
            const dy = node.y - hovered.y;
            const dSq = dx * dx + dy * dy;
            if (dSq <= 0.0001 || dSq > pushRadiusSq) return;
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

        // ── Integrate velocities and enforce boundaries ───────────────────────
        const minX = Math.max(36, gWidth * 0.05);
        const maxX = Math.max(minX + 1, gWidth - minX);
        const minY = Math.max(34, gHeight * 0.06);
        const maxY = Math.max(minY + 1, gHeight - minY);

        ids.forEach((id) => {
          const node = nodes[id];
          if (!node) return;
          if (dragCellId === id || throwCellId === id) return;

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

          if (node.x < minX) { node.x = minX; node.vx *= -0.26; }
          else if (node.x > maxX) { node.x = maxX; node.vx *= -0.26; }
          if (node.y < minY) { node.y = minY; node.vy *= -0.24; }
          else if (node.y > maxY) { node.y = maxY; node.vy *= -0.24; }
        });

        // Commit layout to React state at ~30 fps; always commit during active
        // drag or throw so the ghost cell tracks the pointer without lag.
        if (nowMs - lastLayoutCommitMs >= 33.3 || isDragging || throwCellId !== null) {
          setDisplayLayoutByCell(
            Object.fromEntries(
              ids.map((id) => {
                const node = nodes[id];
                return [id, { x: node.x, y: node.y, width: node.width, height: node.height }];
              }),
            ),
          );
          lastLayoutCommitMs = nowMs;
        }
      } else {
        setDisplayLayoutByCell({});
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
    // hoveredCellId, pointerInGrid, isDragging, drag/throwCellId are intentionally
    // excluded — they are read from refs above, avoiding needless loop restarts.
  }, [activeCellIds, gridSize.height, gridSize.width]);

  return { displayLayoutByCell, physicsRef, homeLayoutRef, resetPhysics };
}
