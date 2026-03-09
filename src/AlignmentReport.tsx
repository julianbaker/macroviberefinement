import { useCallback, useEffect, useRef, useState } from "react";
import { CrtWebglOverlay } from "./CrtWebglOverlay";
import type { CursorType } from "./CrtWebglOverlay";
import { api } from "./api";
import type { SessionResultTrack } from "./api";
import logoUrl from "./assets/MVRLogo.svg?url";

const BIN_CODES = ["VELLUM", "BRINE", "HEAT", "STATIC", "HALO", "GRIT"] as const;
const ACCENT = ["#77DB70", "#F1EB5A", "#FE7BD9", "#1A3DF5"];
const LOGO_ASPECT = 1197 / 625;

type AlignmentCell = { index: number; trackId: string };

type BinStat = {
  code: string;
  accent: string;
  userCount: number;
  matchCount: number;
  noConsensusCount: number;
};

type ButtonLayout = {
  newFileX: number;
  newFileY: number;
  newFileW: number;
  newFileH: number;
};

type AlignmentReportProps = {
  cells: AlignmentCell[];
  placedBins: Record<number, number>;
  sessionToken: string;
  onNewFile: () => void;
  /** Dev/preview only — skips the API fetch and uses this data directly. */
  overrideResults?: SessionResultTrack[];
};

function computeBinStats(
  cells: AlignmentCell[],
  placedBins: Record<number, number>,
  consensusMap: Map<string, string | null>,
): BinStat[] {
  return BIN_CODES.map((code, binIndex) => {
    let userCount = 0;
    let matchCount = 0;
    let noConsensusCount = 0;

    for (const cell of cells) {
      if (placedBins[cell.index] !== binIndex) continue;
      userCount++;
      const consensus = consensusMap.get(cell.trackId) ?? null;
      if (consensus === null) {
        noConsensusCount++;
      } else if (consensus === code) {
        matchCount++;
      }
    }

    return {
      code,
      accent: ACCENT[binIndex % 4],
      userCount,
      matchCount,
      noConsensusCount,
    };
  });
}

export function AlignmentReport({
  cells,
  placedBins,
  sessionToken,
  onNewFile,
  overrideResults,
}: AlignmentReportProps) {
  const frameRef = useRef<HTMLElement | null>(null);
  const logoCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const [crtStatus, setCrtStatus] = useState<"initializing" | "ready" | "failed">("initializing");

  type LoadState = "loading" | "ready" | "error";
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [binStats, setBinStats] = useState<BinStat[]>([]);
  const [overallPct, setOverallPct] = useState<number | null>(null);

  // Button layout computed by drawContent, stored for DOM overlay positioning
  const buttonLayoutRef = useRef<ButtonLayout | null>(null);
  const [buttonLayout, setButtonLayout] = useState<ButtonLayout | null>(null);

  const [hoveredButton, setHoveredButton] = useState(false);
  const cursorType: CursorType = hoveredButton ? "pointer" : "default";

  // Pre-colorize logo
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const offCtx = canvas.getContext("2d");
      if (!offCtx) return;
      offCtx.drawImage(img, 0, 0);
      offCtx.globalCompositeOperation = "source-atop";
      offCtx.fillStyle = "rgba(190,238,255,0.9)";
      offCtx.fillRect(0, 0, canvas.width, canvas.height);
      logoCanvasRef.current = canvas;
    };
    img.src = logoUrl;
  }, []);

  // Track frame dimensions
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setFrameSize({ width: rect.width, height: rect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fetch session results on mount (or use overrideResults for dev preview)
  useEffect(() => {
    if (overrideResults) {
      const consensusMap = new Map<string, string | null>(
        overrideResults.map((t) => [t.trackId, t.consensusBin]),
      );
      const stats = computeBinStats(cells, placedBins, consensusMap);
      const totalWithConsensus = stats.reduce(
        (acc, b) => acc + b.userCount - b.noConsensusCount,
        0,
      );
      const totalMatched = stats.reduce((acc, b) => acc + b.matchCount, 0);
      const pct = totalWithConsensus > 0
        ? Math.round((totalMatched / totalWithConsensus) * 100)
        : null;
      setBinStats(stats);
      setOverallPct(pct);
      setLoadState("ready");
      return;
    }

    let cancelled = false;
    api.sessionResults(sessionToken).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setLoadState("error");
        return;
      }
      const consensusMap = new Map<string, string | null>(
        result.data.tracks.map((t: SessionResultTrack) => [t.trackId, t.consensusBin]),
      );
      const stats = computeBinStats(cells, placedBins, consensusMap);
      const totalWithConsensus = stats.reduce(
        (acc, b) => acc + b.userCount - b.noConsensusCount,
        0,
      );
      const totalMatched = stats.reduce((acc, b) => acc + b.matchCount, 0);
      const pct = totalWithConsensus > 0
        ? Math.round((totalMatched / totalWithConsensus) * 100)
        : null;
      setBinStats(stats);
      setOverallPct(pct);
      setLoadState("ready");
    });
    return () => { cancelled = true; };
  }, [sessionToken, cells, placedBins, overrideResults]);

  const drawContent = useCallback(
    (ctx: CanvasRenderingContext2D, frameWidth: number, frameHeight: number) => {
      // ── Background ────────────────────────────────────────────────────────
      ctx.clearRect(0, 0, frameWidth, frameHeight);
      ctx.fillStyle = "#051021";
      ctx.fillRect(0, 0, frameWidth, frameHeight);

      const colW = frameWidth / 18;
      for (let i = 0; i < 18; i++) {
        ctx.fillStyle = i % 2 === 0 ? "rgba(5,16,33,0.92)" : "rgba(5,16,33,0.76)";
        ctx.fillRect(i * colW, 0, colW + 1, frameHeight);
      }

      const pad = Math.max(14, frameWidth * 0.045);
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";

      // ── Logo + title ──────────────────────────────────────────────────────
      const logoCanvas = logoCanvasRef.current;
      const logoTopY = Math.round(frameHeight * 0.045);
      const logoW = Math.min(130, frameWidth * 0.26);
      const logoH = logoW / LOGO_ASPECT;
      const logoX = pad;
      if (logoCanvas) {
        ctx.drawImage(logoCanvas, logoX, logoTopY, logoW, logoH);
      }

      const titleFontSize = Math.max(16, Math.min(22, frameHeight * 0.034));
      ctx.font = `600 ${titleFontSize}px "IBM Plex Mono", monospace`;
      ctx.fillStyle = "rgba(190,238,255,0.72)";
      ctx.textAlign = "right";
      ctx.fillText("ALIGNMENT REPORT", frameWidth - pad, logoTopY + logoH * 0.5);

      // ── Divider 1 ─────────────────────────────────────────────────────────
      const div1Y = logoTopY + logoH + 10;
      ctx.strokeStyle = "rgba(190,238,255,0.18)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad, div1Y);
      ctx.lineTo(frameWidth - pad, div1Y);
      ctx.stroke();

      // ── Score ─────────────────────────────────────────────────────────────
      const scoreFontSize = Math.max(40, Math.min(72, frameHeight * 0.11));
      const scoreY = div1Y + 16 + scoreFontSize * 0.5;

      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      if (loadState === "loading") {
        ctx.font = `400 ${Math.max(16, scoreFontSize * 0.38)}px "IBM Plex Mono", monospace`;
        ctx.fillStyle = "rgba(190,238,255,0.56)";
        ctx.fillText("FETCHING ALIGNMENT DATA", frameWidth * 0.5, scoreY);
      } else if (loadState === "error") {
        ctx.font = `500 ${Math.max(16, scoreFontSize * 0.38)}px "IBM Plex Mono", monospace`;
        ctx.fillStyle = "rgba(254,123,217,0.8)";
        ctx.fillText("ALIGNMENT DATA UNAVAILABLE", frameWidth * 0.5, scoreY);
      } else if (overallPct === null) {
        ctx.font = `500 ${Math.max(18, scoreFontSize * 0.42)}px "IBM Plex Mono", monospace`;
        ctx.fillStyle = "rgba(190,238,255,0.46)";
        ctx.fillText("— NO CONSENSUS YET —", frameWidth * 0.5, scoreY);
      } else {
        ctx.font = `600 ${scoreFontSize}px "IBM Plex Mono", monospace`;
        ctx.fillStyle = "rgba(190,238,255,0.94)";
        ctx.fillText(`${overallPct}%`, frameWidth * 0.5, scoreY);

        const labelFontSize = Math.max(13, scoreFontSize * 0.32);
        ctx.font = `500 ${labelFontSize}px "IBM Plex Mono", monospace`;
        ctx.fillStyle = "rgba(190,238,255,0.46)";
        ctx.fillText("CONSENSUS ALIGNMENT", frameWidth * 0.5, scoreY + scoreFontSize * 0.64);
      }

      // ── Divider 2 ─────────────────────────────────────────────────────────
      const div2Y = div1Y + 14 + scoreFontSize * 1.4 + 10;
      ctx.strokeStyle = "rgba(190,238,255,0.18)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad, div2Y);
      ctx.lineTo(frameWidth - pad, div2Y);
      ctx.stroke();

      // ── Bin rows ──────────────────────────────────────────────────────────
      // Font and bar sizes are fixed to the frame — independent of row height.
      // Row height is calculated from content + minimal inner padding.
      // The gap between adjacent rows is kept small; leftover space goes above
      // and below the block for breathing room.
      const buttonAreaH = Math.max(50, frameHeight * 0.12);
      const div3Y = frameHeight - buttonAreaH - 10;
      const availForBins = div3Y - div2Y - 20;

      const rowFontSize = Math.max(18, Math.min(26, frameHeight * 0.034));
      const barH = Math.max(22, frameHeight * 0.038);
      const rowInnerPad = Math.max(8, frameHeight * 0.010);
      const rowContentH = Math.max(rowFontSize, barH) + rowInnerPad * 4
      const rowGap = 0.5;
      const totalBinsH = rowContentH * 6 + rowGap * 5;
      const binBlockTop = div2Y + 10 + Math.max(0, (availForBins - 20 - totalBinsH) * 0.5);

      const codeLabelW = Math.max(72, frameWidth * 0.14);
      const countLabelW = Math.max(100, frameWidth * 0.18);
      const barX = pad + codeLabelW + 10;
      const barMaxW = frameWidth - pad - countLabelW - barX - 10;

      if (loadState === "ready") {
        for (let i = 0; i < binStats.length; i++) {
          const stat = binStats[i];
          if (stat.userCount === 0) continue;

          const rowMidY = binBlockTop + i * (rowContentH + rowGap) + rowContentH * 0.5;
          const trackableCount = stat.userCount - stat.noConsensusCount;
          const matchPct = trackableCount > 0 ? stat.matchCount / trackableCount : 0;

          // Bin code label
          ctx.font = `600 ${rowFontSize}px "IBM Plex Mono", monospace`;
          ctx.fillStyle = stat.accent;
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(stat.code, pad, rowMidY);

          // Progress bar background (barH is computed above)
          const barY = rowMidY - barH * 0.5;
          ctx.fillStyle = "rgba(190,238,255,0.10)";
          ctx.fillRect(barX, barY, barMaxW, barH);

          // Progress bar fill (accent color)
          if (matchPct > 0) {
            ctx.fillStyle = stat.accent;
            ctx.globalAlpha = 0.72;
            ctx.fillRect(barX, barY, barMaxW * matchPct, barH);
            ctx.globalAlpha = 1;
          }

          // Percentage-only label (right-aligned). We intentionally hide raw counts.
          ctx.textAlign = "right";
          ctx.font = `500 ${Math.max(13, rowFontSize - 2)}px "IBM Plex Mono", monospace`;

          if (trackableCount > 0) {
            const pctLabel = `${Math.round(matchPct * 100)}% ALIGNED`;
            ctx.fillStyle = "rgba(190,238,255,0.72)";
            ctx.fillText(pctLabel, frameWidth - pad, rowMidY);
          } else {
            // All tracks in this bin have no consensus yet.
            ctx.fillStyle = "rgba(190,238,255,0.34)";
            ctx.fillText("NO CONSENSUS YET", frameWidth - pad, rowMidY);
          }
        }
      } else if (loadState === "loading") {
        // Skeleton rows while loading
        for (let i = 0; i < 6; i++) {
          const rowMidY = binBlockTop + i * (rowContentH + rowGap) + rowContentH * 0.5;
          ctx.fillStyle = "rgba(190,238,255,0.08)";
          const skeletonBarH = Math.max(6, rowContentH * 0.4);
          ctx.fillRect(barX, rowMidY - skeletonBarH * 0.5, barMaxW * 0.6, skeletonBarH);
        }
      }

      // ── Divider 3 ─────────────────────────────────────────────────────────
      ctx.strokeStyle = "rgba(190,238,255,0.18)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad, div3Y);
      ctx.lineTo(frameWidth - pad, div3Y);
      ctx.stroke();

      // ── Button (single, centred) ───────────────────────────────────────────
      const btnFontSize = Math.max(14, Math.min(18, frameHeight * 0.030));
      const btnH = Math.max(36, buttonAreaH * 0.60);
      const btnY = div3Y + (frameHeight - div3Y) * 0.5 - btnH * 0.5;
      const btnW = Math.min(280, frameWidth * 0.38);
      const newFileX = frameWidth * 0.5 - btnW * 0.5;

      ctx.strokeStyle = "rgba(190,238,255,0.44)";
      ctx.lineWidth = 1;
      ctx.strokeRect(newFileX + 0.5, btnY + 0.5, btnW - 1, btnH - 1);
      ctx.fillStyle = "rgba(5,16,33,0.88)";
      ctx.fillRect(newFileX + 1, btnY + 1, btnW - 2, btnH - 2);
      ctx.font = `600 ${btnFontSize}px "IBM Plex Mono", monospace`;
      ctx.fillStyle = "rgba(190,238,255,0.94)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Continue Refining", newFileX + btnW * 0.5, btnY + btnH * 0.5);

      // Store layout for DOM overlay alignment
      const layout: ButtonLayout = {
        newFileX,
        newFileY: btnY,
        newFileW: btnW,
        newFileH: btnH,
      };
      if (
        !buttonLayoutRef.current ||
        buttonLayoutRef.current.newFileX !== layout.newFileX ||
        buttonLayoutRef.current.newFileY !== layout.newFileY ||
        buttonLayoutRef.current.newFileW !== layout.newFileW
      ) {
        buttonLayoutRef.current = layout;
        Promise.resolve().then(() => setButtonLayout({ ...layout }));
      }
    },
    [loadState, binStats, overallPct],
  );

  return (
    <main className={`app-shell${crtStatus === "ready" ? " crt-active" : ""}`}>
      <div className="crt-scene">
        <section
          ref={frameRef}
          className={`refine-frame${crtStatus === "ready" ? " refine-frame-proxy" : ""}`}
          aria-label="Alignment Report"
        >
          {/* Invisible button tap anchor — aligned to CRT-drawn button position */}
          {buttonLayout && frameSize.width > 0 && (
            <button
              type="button"
              aria-label="Continue Refining"
              onClick={onNewFile}
              onPointerEnter={() => setHoveredButton(true)}
              onPointerLeave={() => setHoveredButton(false)}
              style={{
                position: "absolute",
                left: buttonLayout.newFileX,
                top: buttonLayout.newFileY,
                width: buttonLayout.newFileW,
                height: buttonLayout.newFileH,
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
              }}
            />
          )}

          {/* DOM fallback when WebGL hasn't initialised or failed */}
          {crtStatus !== "ready" && (
            <div className="alignment-report-fallback">
              <p className="alignment-report-fallback-title">ALIGNMENT REPORT</p>
              {loadState === "loading" && (
                <p className="alignment-report-fallback-status">FETCHING ALIGNMENT DATA…</p>
              )}
              {loadState === "error" && (
                <p className="alignment-report-fallback-status">ALIGNMENT DATA UNAVAILABLE</p>
              )}
              {loadState === "ready" && overallPct !== null && (
                <p className="alignment-report-fallback-score">{overallPct}% ALIGNED</p>
              )}
              <div className="alignment-report-fallback-buttons">
                <button
                  type="button"
                  className="completion-button"
                  onClick={onNewFile}
                  onPointerEnter={() => setHoveredButton(true)}
                  onPointerLeave={() => setHoveredButton(false)}
                >
                  Continue Refining
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      <CrtWebglOverlay
        frameRef={frameRef}
        drawContent={drawContent}
        onStatusChange={setCrtStatus}
        cursorType={cursorType}
      />
    </main>
  );
}
