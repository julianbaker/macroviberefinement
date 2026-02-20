import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { ArchiveBin, ArchiveTrack } from "./api";
import { CrtWebglOverlay } from "./CrtWebglOverlay";

const makeCode = (seed: string): string => {
  let hash = 2166136261;
  for (const ch of seed) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash).toString(36).toUpperCase().slice(0, 4).padEnd(4, "0");
};

const formatDate = (iso: string): string => {
  try {
    const d = new Date(iso);
    return d.toISOString().slice(0, 10);
  } catch {
    return iso.slice(0, 10);
  }
};

// Canvas layout constants — CSS heights must match for click-target alignment
const HEADER_H = 60;
const ROW_H = 42;
const PAD = 20;

const drawArchiveContent = (
  ctx: CanvasRenderingContext2D,
  frameWidth: number,
  frameHeight: number,
  title: string,
  hasBinNav: boolean,
  isLoading: boolean,
  error: string | null,
  rows: string[][],
) => {
  ctx.clearRect(0, 0, frameWidth, frameHeight);
  ctx.fillStyle = "#051021";
  ctx.fillRect(0, 0, frameWidth, frameHeight);

  const colW = frameWidth / 18;
  for (let i = 0; i < 18; i += 1) {
    ctx.fillStyle = i % 2 === 0 ? "rgba(5,16,33,0.92)" : "rgba(5,16,33,0.76)";
    ctx.fillRect(i * colW, 0, colW + 1, frameHeight);
  }

  ctx.strokeStyle = "rgba(190,238,255,0.55)";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, frameWidth - 1, frameHeight - 1);

  // Header
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(190,238,255,0.9)";
  ctx.font = '600 20px "IBM Plex Mono", monospace';
  ctx.textAlign = "left";
  ctx.fillText(title, PAD, HEADER_H * 0.5);

  ctx.fillStyle = "rgba(190,238,255,0.46)";
  ctx.font = '500 15px "IBM Plex Mono", monospace';
  ctx.textAlign = "right";
  ctx.fillText(hasBinNav ? "← BINS   REFINE" : "← REFINE", frameWidth - PAD, HEADER_H * 0.5);

  // Header divider
  ctx.strokeStyle = "rgba(190,238,255,0.24)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, HEADER_H + 0.5);
  ctx.lineTo(frameWidth, HEADER_H + 0.5);
  ctx.stroke();

  if (isLoading) {
    ctx.fillStyle = "rgba(190,238,255,0.38)";
    ctx.font = '500 17px "IBM Plex Mono", monospace';
    ctx.textAlign = "center";
    ctx.fillText("LOADING...", frameWidth * 0.5, frameHeight * 0.5);
    return;
  }

  if (error) {
    ctx.fillStyle = "rgba(254,123,217,0.74)";
    ctx.font = '500 17px "IBM Plex Mono", monospace';
    ctx.textAlign = "center";
    ctx.fillText(`ERROR: ${error}`, frameWidth * 0.5, frameHeight * 0.5);
    return;
  }

  if (rows.length === 0) {
    ctx.fillStyle = "rgba(190,238,255,0.30)";
    ctx.font = '500 17px "IBM Plex Mono", monospace';
    ctx.textAlign = "center";
    ctx.fillText("NO ENTRIES", frameWidth * 0.5, frameHeight * 0.5);
    return;
  }

  const maxRows = Math.floor((frameHeight - HEADER_H) / ROW_H);
  const visibleRows = rows.slice(0, maxRows);

  const col0 = 96;
  const col3 = hasBinNav ? 120 : 60;
  const col2 = hasBinNav ? 170 : 72;
  const col1 = Math.max(120, frameWidth - PAD * 2 - col0 - col2 - col3 - 20);

  for (let i = 0; i < visibleRows.length; i += 1) {
    const rowCenterY = HEADER_H + i * ROW_H + ROW_H * 0.5;
    const row = visibleRows[i];

    if (i > 0) {
      ctx.strokeStyle = "rgba(190,238,255,0.08)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD, HEADER_H + i * ROW_H);
      ctx.lineTo(frameWidth - PAD, HEADER_H + i * ROW_H);
      ctx.stroke();
    }

    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    // code
    ctx.fillStyle = "rgba(190,238,255,0.60)";
    ctx.font = '600 16px "IBM Plex Mono", monospace';
    ctx.fillText(row[0] ?? "", PAD, rowCenterY);

    // name / title
    ctx.fillStyle = "rgba(190,238,255,0.88)";
    ctx.font = '500 16px "IBM Plex Mono", monospace';
    const maxTitle = Math.floor(col1 / 9.6);
    ctx.fillText((row[1] ?? "").slice(0, maxTitle), PAD + col0, rowCenterY);

    // count / artist
    ctx.fillStyle = "rgba(190,238,255,0.56)";
    ctx.font = '500 15px "IBM Plex Mono", monospace';
    const maxMid = Math.floor(col2 / 9.2);
    ctx.fillText((row[2] ?? "").slice(0, maxMid), PAD + col0 + col1, rowCenterY);

    // date / arrow
    ctx.fillStyle = "rgba(190,238,255,0.40)";
    ctx.font = '500 15px "IBM Plex Mono", monospace';
    ctx.textAlign = "right";
    ctx.fillText(row[3] ?? "", frameWidth - PAD, rowCenterY);
  }
};

type Route = { view: "refine" } | { view: "archive" } | { view: "archive-bin"; binCode: string };

type ArchiveDrawState = {
  title: string;
  hasBinNav: boolean;
  isLoading: boolean;
  error: string | null;
  rows: string[][];
};

export function ArchiveView({
  binCode,
  navigate,
}: {
  binCode?: string;
  navigate: (r: Route) => void;
}) {
  const frameRef = useRef<HTMLElement | null>(null);
  const [crtStatus, setCrtStatus] = useState<"initializing" | "ready" | "failed">("initializing");

  const [bins, setBins] = useState<ArchiveBin[] | null>(null);
  const [tracks, setTracks] = useState<ArchiveTrack[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIsLoading(true);
    setError(null);
    setBins(null);
    setTracks(null);

    if (binCode) {
      api.archiveBinDetail(binCode).then((result) => {
        setIsLoading(false);
        if (result.ok) setTracks(result.data.tracks);
        else setError(result.error.code);
      });
    } else {
      api.archiveBins().then((result) => {
        setIsLoading(false);
        if (result.ok) setBins(result.data.bins);
        else setError(result.error.code);
      });
    }
  }, [binCode]);

  const title = binCode ? `ARCHIVE / ${binCode}` : "ARCHIVE / ALL BINS";
  const rows: string[][] = binCode
    ? (tracks ?? []).map((t) => [
        makeCode(t.trackId),
        (t.title || "—").toUpperCase(),
        (t.artistName || "—").toUpperCase(),
        formatDate(t.assignedAt),
      ])
    : (bins ?? []).map((b) => [
        b.binCode,
        b.displayName.toUpperCase(),
        b.trackCount.toString().padStart(4, "0"),
        "→",
      ]);

  const drawStateRef = useRef<ArchiveDrawState>({ title, hasBinNav: !!binCode, isLoading, error, rows });
  drawStateRef.current = { title, hasBinNav: !!binCode, isLoading, error, rows };

  const drawContent = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      const s = drawStateRef.current;
      drawArchiveContent(ctx, w, h, s.title, s.hasBinNav, s.isLoading, s.error, s.rows);
    },
    [],
  );

  // Nav callbacks — state-based, no URL change, reliable regardless of CRT opacity
  const goBack = useCallback(() => navigate({ view: "refine" }), [navigate]);
  const goBins = useCallback(() => navigate({ view: "archive" }), [navigate]);
  const goBin = useCallback(
    (code: string) => navigate({ view: "archive-bin", binCode: code }),
    [navigate],
  );

  return (
    <main className="app-shell">
      <div className="crt-scene">
        <section
          ref={frameRef}
          className={`archive-frame${crtStatus === "ready" ? " archive-frame-proxy" : ""}`}
          aria-label="Archive"
        >
          {/* Header — height matches HEADER_H=60 canvas constant */}
          <header className="archive-frame-header">
            <span className="archive-frame-title">{title}</span>
            <nav className="archive-frame-nav">
              {binCode && (
                <button type="button" className="archive-nav-btn" onClick={goBins}>
                  ← BINS
                </button>
              )}
              <button type="button" className="archive-nav-btn" onClick={goBack}>
                {binCode ? "REFINE" : "← REFINE"}
              </button>
            </nav>
          </header>

          {/* Content — row heights match ROW_H=42 canvas constant */}
          <div className="archive-frame-body">
            {isLoading && <p className="archive-frame-status">LOADING...</p>}
            {error && <p className="archive-frame-status archive-frame-status--error">ERROR: {error}</p>}

            {!isLoading && !error && binCode && tracks && (
              <ol className="archive-frame-list">
                {tracks.map((t) => (
                  <li key={t.trackId} className="archive-frame-row">
                    <span className="archive-col-code">{makeCode(t.trackId)}</span>
                    <span className="archive-col-main">{(t.title || "—").toUpperCase()}</span>
                    <span className="archive-col-mid">{(t.artistName || "—").toUpperCase()}</span>
                    <span className="archive-col-end">{formatDate(t.assignedAt)}</span>
                  </li>
                ))}
              </ol>
            )}

            {!isLoading && !error && !binCode && bins && (
              <ol className="archive-frame-list">
                {bins.map((b) => (
                  <li key={b.binCode} className="archive-frame-row archive-frame-row--link">
                    <button
                      type="button"
                      className="archive-row-btn"
                      onClick={() => goBin(b.binCode)}
                    >
                      <span className="archive-col-code">{b.binCode}</span>
                      <span className="archive-col-main">{b.displayName.toUpperCase()}</span>
                      <span className="archive-col-mid">{b.trackCount.toString().padStart(4, "0")}</span>
                      <span className="archive-col-end">→</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>

        <CrtWebglOverlay
          frameRef={frameRef}
          drawContent={drawContent}
          onStatusChange={setCrtStatus}
        />
      </div>
    </main>
  );
}
