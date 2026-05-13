import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { MobileGate } from "./MobileGate";
import { AlignmentReport } from "./AlignmentReport";
import "./styles.css";

// ── Dev preview ──────────────────────────────────────────────────────────────
// Navigate to /?preview=alignment to render the AlignmentReport with mock data.
// No backend required. Stripped from production builds by Vite's dead-code elimination.
const previewParam = import.meta.env.DEV
  ? new URLSearchParams(location.search).get("preview")
  : null;

if (previewParam === "alignment") {
  const BIN_CODES = ["VELLUM", "BRINE", "HEAT", "STATIC", "HALO", "GRIT"];
  // 64 mock tracks distributed across bins: 12, 8, 14, 4, 16, 10
  const distribution = [12, 8, 14, 4, 16, 10];
  const mockCells: Array<{ index: number; trackId: string }> = [];
  const mockPlacedBins: Record<number, number> = {};
  let cellIndex = 0;
  for (let binIdx = 0; binIdx < distribution.length; binIdx++) {
    for (let i = 0; i < distribution[binIdx]; i++) {
      mockCells.push({ index: cellIndex, trackId: `mock-track-${cellIndex}` });
      mockPlacedBins[cellIndex] = binIdx;
      cellIndex++;
    }
  }

  // Consensus data: varied agreement rates per bin and a few null (no consensus)
  // VELLUM: 10/12 match, BRINE: 6/8 match, HEAT: 13/14 match,
  // STATIC: 2/4 match (2 null), HALO: 11/16 match (3 null), GRIT: 7/10 match
  const matchCounts = [10, 6, 13, 2, 11, 7];
  const nullCounts = [0, 0, 0, 2, 3, 0];
  const mockResults = mockCells.map((cell) => {
    const binIdx = mockPlacedBins[cell.index];
    const binCode = BIN_CODES[binIdx];
    const trackPosInBin = mockCells
      .filter((c) => mockPlacedBins[c.index] === binIdx)
      .indexOf(cell);
    const totalInBin = distribution[binIdx];
    const nullCount = nullCounts[binIdx];
    const matchCount = matchCounts[binIdx];

    if (trackPosInBin < nullCount) return { trackId: cell.trackId, consensusBin: null };
    if (trackPosInBin < nullCount + matchCount) return { trackId: cell.trackId, consensusBin: binCode };
    // remaining tracks get a "wrong" bin (next bin in rotation)
    return { trackId: cell.trackId, consensusBin: BIN_CODES[(binIdx + 1) % BIN_CODES.length] };
  });

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <AlignmentReport
        cells={mockCells}
        placedBins={mockPlacedBins}
        sessionToken="preview"
        overrideResults={mockResults}
        onNewFile={() => location.assign("/")}
      />
    </StrictMode>,
  );
} else {
  // Normal flow
  const isMobile = window.innerWidth <= 700;

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      {isMobile ? <MobileGate /> : <App />}
    </StrictMode>,
  );
}
