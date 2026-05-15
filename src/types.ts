// ── Shared domain types ───────────────────────────────────────────────────────
// Kept in one place so hooks and components import from a single source of truth.

export type AudioPhase = "locked" | "preloading" | "ready";

export type Cell = {
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

export type CellLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CellNode = CellLayout & {
  vx: number;
  vy: number;
  homeX: number;
  homeY: number;
};

export type DragState = {
  cellId: number;
  trackId: string;
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

export type ThrowState = {
  cellId: number;
  code: string;
  width: number;
  height: number;
  scale: number;
  x: number;
  y: number;
  opacity: number;
};

export type PointerState = {
  x: number;
  y: number;
};
