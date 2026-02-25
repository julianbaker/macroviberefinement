import { useCallback, useEffect, useRef, useState } from "react";
import { CrtWebglOverlay } from "./CrtWebglOverlay";
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

const LOGO_ASPECT = 1197 / 625;
const ACCENT = ["#77DB70", "#F1EB5A", "#FE7BD9", "#1A3DF5"];

const MESSAGE_LINES = [
  "Mobile devices are not permitted",
  "on the severed floor.",
  "",
  "Please use your assigned desktop",
  "workstation to begin refining.",
];

type BinArea = {
  code: (typeof BIN_CODES)[number];
  x: number;
  y: number;
  width: number;
  height: number;
};

function getBinAreas(frameWidth: number, frameHeight: number, topY?: number): BinArea[] {
  const pad = Math.max(12, frameWidth * 0.04);
  const gapX = 8;
  const gapY = 8;
  const cols = 2;
  const rows = 3;
  const binTopY = topY ?? frameHeight * 0.52;
  const gridW = frameWidth - pad * 2;
  const availH = frameHeight - binTopY - pad;
  const binW = (gridW - gapX * (cols - 1)) / cols;
  const binH = (availH - gapY * (rows - 1)) / rows;

  return BIN_CODES.map((code, i) => ({
    code,
    x: pad + (i % cols) * (binW + gapX),
    y: binTopY + Math.floor(i / cols) * (binH + gapY),
    width: binW,
    height: binH,
  }));
}

export function MobileGate() {
  const frameRef = useRef<HTMLElement | null>(null);
  const logoCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const [crtStatus, setCrtStatus] = useState<"initializing" | "ready" | "failed">("initializing");

  // Pre-colorize logo to accent color once on mount
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

  // Track frame dimensions so DOM tap areas match CRT-drawn bins
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

  // CRT source canvas draw — called every source frame by CrtWebglOverlay
  const drawContent = useCallback(
    (ctx: CanvasRenderingContext2D, frameWidth: number, frameHeight: number) => {
      // Background
      ctx.clearRect(0, 0, frameWidth, frameHeight);
      ctx.fillStyle = "#051021";
      ctx.fillRect(0, 0, frameWidth, frameHeight);

      // Column stripes
      const colW = frameWidth / 18;
      for (let i = 0; i < 18; i++) {
        ctx.fillStyle = i % 2 === 0 ? "rgba(5,16,33,0.92)" : "rgba(5,16,33,0.76)";
        ctx.fillRect(i * colW, 0, colW + 1, frameHeight);
      }

      // ── Adaptive layout: anchor each section to the previous one's bottom ───
      // This guarantees nothing overflows regardless of frame height.

      // Logo
      const logoCanvas = logoCanvasRef.current;
      const logoTopY = Math.round(frameHeight * 0.045);
      const logoW = Math.min(190, frameWidth * 0.5);
      const logoH = logoW / LOGO_ASPECT;
      if (logoCanvas) {
        ctx.drawImage(logoCanvas, frameWidth * 0.5 - logoW * 0.5, logoTopY, logoW, logoH);
      }

      // Divider line — 14px below logo bottom
      const dividerY = logoTopY + logoH + 14;
      ctx.strokeStyle = "rgba(190,238,255,0.18)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(frameWidth * 0.08, dividerY);
      ctx.lineTo(frameWidth * 0.92, dividerY);
      ctx.stroke();

      // Message block — 14px below divider
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      // Scale font to leave at least 52% of height for the bin grid
      const maxMsgAreaH = frameHeight * 0.26;
      const fontSize = Math.max(12, Math.min(15, maxMsgAreaH / (MESSAGE_LINES.length * 1.75)));
      const lineH = Math.round(fontSize * 1.75);
      const msgStartY = dividerY + 14 + fontSize * 0.5;

      MESSAGE_LINES.forEach((line, i) => {
        if (!line) return;
        ctx.fillStyle = "rgba(190,238,255,0.82)";
        ctx.font = `500 ${fontSize}px "IBM Plex Mono", monospace`;
        ctx.fillText(line, frameWidth * 0.5, msgStartY + i * lineH);
      });

      // Pin bin area 16px below last message line
      const msgBottomY = msgStartY + (MESSAGE_LINES.length - 1) * lineH + fontSize * 0.5;

      // Bin grid — starts 16px below the last message line
      if (frameWidth === 0 || frameHeight === 0) return;
      const binTopY = msgBottomY + 16;
      const bins = getBinAreas(frameWidth, frameHeight, binTopY);

      bins.forEach(({ code, x, y, width, height }, i) => {
        // Box background + border
        ctx.strokeStyle = "rgba(190,238,255,0.44)";
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
        ctx.fillStyle = "rgba(5,16,33,0.76)";
        ctx.fillRect(x + 1, y + 1, width - 2, height - 2);

        // Index number (accent color, top-left)
        ctx.fillStyle = ACCENT[i % 4];
        ctx.font = `600 ${Math.max(10, fontSize - 1)}px "IBM Plex Mono", monospace`;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(String(i + 1), x + 8, y + 7);

        // Bin code (centred)
        const codeSize = Math.max(16, Math.min(22, width * 0.26));
        ctx.fillStyle = "rgba(190,238,255,0.92)";
        ctx.font = `600 ${codeSize}px "IBM Plex Mono", monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(code, x + width * 0.5, y + height * 0.5);

        // "OPEN ↗" hint (bottom-right, dim)
        ctx.fillStyle = "rgba(190,238,255,0.34)";
        ctx.font = `500 9px "IBM Plex Mono", monospace`;
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        ctx.fillText("OPEN ↗", x + width - 7, y + height - 6);
      });
    },
    [],
  );

  // Mirror the canvas layout calculation so DOM tap areas align with drawn bins.
  const binAreas = (() => {
    const { width: fw, height: fh } = frameSize;
    if (fw <= 0 || fh <= 0) return [];

    const logoW = Math.min(190, fw * 0.5);
    const logoH = logoW / LOGO_ASPECT;
    const logoTopY = Math.round(fh * 0.045);
    const dividerY = logoTopY + logoH + 14;
    const maxMsgAreaH = fh * 0.26;
    const fontSize = Math.max(12, Math.min(15, maxMsgAreaH / (MESSAGE_LINES.length * 1.75)));
    const lineH = Math.round(fontSize * 1.75);
    const msgStartY = dividerY + 14 + fontSize * 0.5;
    const msgBottomY = msgStartY + (MESSAGE_LINES.length - 1) * lineH + fontSize * 0.5;
    const binTopY = msgBottomY + 16;

    return getBinAreas(fw, fh, binTopY);
  })();

  return (
    <main className="app-shell">
      <div className="crt-scene">
        {/*
          The frame is the CRT's layout reference.
          When CRT is ready it becomes opacity:0 (refine-frame-proxy), but the
          absolutely-positioned tap anchors inside remain pointer-event-active
          because opacity:0 does not disable pointer events.
        */}
        <section
          ref={frameRef}
          className={`refine-frame${crtStatus === "ready" ? " refine-frame-proxy" : " mobile-gate-fallback"}`}
          aria-label="Mobile Gate"
        >
          {/* Fallback content — visible only when WebGL fails or hasn't loaded yet */}
          {crtStatus !== "ready" && (
            <div className="mobile-gate-dom-fallback">
              <img src={logoUrl} className="gate-logo" alt="MacroVibe Refinement" />
              <p className="mobile-gate-message">
                Mobile devices are not permitted<br />
                on the severed floor.<br />
                <br />
                Please use your assigned desktop<br />
                workstation to begin refining.
              </p>
              <div className="mobile-gate-bins-fallback">
                {BIN_CODES.map((code, i) => (
                  <a
                    key={code}
                    href={BIN_PLAYLIST_URLS[code]}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mobile-gate-bin-fallback"
                    style={{ "--accent": ACCENT[i % 4] } as React.CSSProperties}
                  >
                    <span className="mobile-gate-bin-num">{i + 1}</span>
                    <span className="mobile-gate-bin-code">{code}</span>
                    <span className="mobile-gate-bin-open">OPEN ↗</span>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Invisible tap anchors — aligned to CRT-drawn bin positions */}
          {binAreas.map((bin) => (
            <a
              key={bin.code}
              href={BIN_PLAYLIST_URLS[bin.code]}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${bin.code} playlist on Audius`}
              style={{
                position: "absolute",
                left: bin.x,
                top: bin.y,
                width: bin.width,
                height: bin.height,
                display: "block",
              }}
            />
          ))}
        </section>
      </div>

      <CrtWebglOverlay
        frameRef={frameRef}
        drawContent={drawContent}
        onStatusChange={setCrtStatus}
        cursorType={null}
      />
    </main>
  );
}
