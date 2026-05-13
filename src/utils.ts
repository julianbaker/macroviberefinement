// ── Shared constants and pure utilities ───────────────────────────────────────
// All values here are side-effect-free: safe to import from hooks, components,
// and scripts without introducing dependency cycles.

import type { Cell, CellLayout } from "./types";
import type { SessionTrack } from "./api";

// ── Bin definitions ───────────────────────────────────────────────────────────

export const BIN_CODES = ["VELLUM", "BRINE", "HEAT", "STATIC", "HALO", "GRIT"] as const;

export const BIN_PLAYLIST_URLS: Record<string, string> = {
  VELLUM: "https://audius.co/MacroVibeRefinement/playlist/vellum",
  BRINE:  "https://audius.co/MacroVibeRefinement/playlist/brine",
  HEAT:   "https://audius.co/MacroVibeRefinement/playlist/heat",
  STATIC: "https://audius.co/MacroVibeRefinement/playlist/static",
  HALO:   "https://audius.co/MacroVibeRefinement/playlist/halo",
  GRIT:   "https://audius.co/MacroVibeRefinement/playlist/grit",
};

// Baseline meter readings for each bin (augmented by live placement counts).
export const BIN_METERS = [26, 53, 47, 64, 16, 38] as const;

// ── Session constants ─────────────────────────────────────────────────────────

export const SESSION_SIZE_MAX = 64;

// ── CRT constants ─────────────────────────────────────────────────────────────

export const CRT_CURVATURE = 0.27;

// ── Throw animation constants ─────────────────────────────────────────────────

export const THROW_X_MS = 280;
export const THROW_Y_MS = 340;
export const THROW_TARGET_SCALE = 0.44;

// ── Grid slot layout ──────────────────────────────────────────────────────────

const FLUID_ROW_COUNTS = [7, 8, 6, 8, 7, 8, 6, 7, 7] as const;

// Pre-computed fractional slot positions (range 0–1). Each entry represents one
// cell's home position within the grid. Deterministic wobble prevents grid-like
// uniformity without requiring per-render calculation.
export const FLUID_SLOTS = (() => {
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

// ── Math helpers ──────────────────────────────────────────────────────────────

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export const lerp = (from: number, to: number, progress: number): number =>
  from + (to - from) * progress;

export const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);

// ── Cell code generation ──────────────────────────────────────────────────────

// FNV-1a hash of a seed string → deterministic 4-char alphanumeric code.
// The code is opaque by design: it identifies a cell without revealing track metadata.
const makeCode = (seed: string): string => {
  let hash = 2166136261;
  for (const ch of seed) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash).toString(36).toUpperCase().slice(0, 4).padEnd(4, "0");
};

// ── Cell builders ─────────────────────────────────────────────────────────────

export const buildCellFromTrack = (track: SessionTrack, index: number): Cell => ({
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

export const buildCellsFromTracks = (tracks: SessionTrack[]): Cell[] =>
  tracks.map((track, index) => buildCellFromTrack(track, index));

// ── Layout helpers ────────────────────────────────────────────────────────────

// Compute home positions for all cells given the current grid dimensions.
export const buildHomeLayout = (
  width: number,
  height: number,
  cells: Cell[],
): Record<number, CellLayout> => {
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

// Scale factor for a cell based on its proximity to the currently hovered cell.
// Returns 1.35 for the hovered cell, 1.12 / 1.06 for the two adjacent rings,
// and 1 otherwise. Returns 1 unconditionally while dragging.
export const getCellScale = (
  cellId: number,
  hoveredCellId: number | null,
  layoutByCell: Record<number, CellLayout>,
  isDragging: boolean,
): number => {
  if (isDragging || hoveredCellId === null) return 1;
  if (cellId === hoveredCellId) return 1.35;

  const cellLayout = layoutByCell[cellId];
  const hoveredLayout = layoutByCell[hoveredCellId];
  if (!cellLayout || !hoveredLayout) return 1;

  const dx = cellLayout.x - hoveredLayout.x;
  const dy = cellLayout.y - hoveredLayout.y;
  const dist = Math.hypot(dx, dy);
  const base = (hoveredLayout.width + hoveredLayout.height) * 0.5;
  if (dist <= base * 0.92) return 1.12;
  if (dist <= base * 1.45) return 1.06;
  return 1;
};

// Returns the index of the first bin element whose bounding rect contains the
// given client point (with a small vertical tolerance), or null if none.
export const getBinFromPoint = (
  binElements: Array<HTMLElement | null>,
  clientX: number,
  clientY: number,
): number | null => {
  for (let index = 0; index < binElements.length; index += 1) {
    const element = binElements[index];
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top - 18 &&
      clientY <= rect.bottom + 12
    ) {
      return index;
    }
  }
  return null;
};
