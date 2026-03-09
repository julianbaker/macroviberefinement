import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import logoUrl from "./assets/MVRLogo.svg?url";
import cursorDefaultUrl from "./assets/cursors/cursor-default.svg?url";
import cursorPointerUrl from "./assets/cursors/cursor-pointer.svg?url";
import cursorGrabUrl from "./assets/cursors/cursor-grab.svg?url";
import cursorGrabbingUrl from "./assets/cursors/cursor-grabbing.svg?url";

export type CursorType = "default" | "pointer" | "grab" | "grabbing";

export type SurfaceCellRender = {
  id: number;
  code: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  isDragOrigin: boolean;
};

export type SurfaceDragRender = {
  code: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  opacity?: number;
  offsetX?: number;
  offsetY?: number;
};

export type SurfaceDragLiveRender = SurfaceDragRender & { overBin: number | null };

type CrtWebglOverlayProps = {
  frameRef: RefObject<HTMLElement | null>;
  // Main refine-UI props (not needed when drawContent is provided)
  gridViewport?: { x: number; y: number; width: number; height: number };
  cells?: SurfaceCellRender[];
  meterValues?: readonly number[];
  binCodes?: readonly string[];
  placedCount?: number;
  sessionSize?: number;
  activeBin?: number | null;
  pulseBin?: number | null;
  hoveredBinPlaylist?: number | null;
  dragState?: SurfaceDragLiveRender | null;
  throwState?: SurfaceDragRender | null;
  // Gate / preloading state
  audioPhase?: "locked" | "preloading" | "ready";
  preloadProgress?: { loaded: number; total: number };
  sessionInitError?: string | null;
  // Custom draw override — when provided, replaces the built-in draw entirely
  drawContent?: (ctx: CanvasRenderingContext2D, frameWidth: number, frameHeight: number) => void;
  onStatusChange?: (status: "initializing" | "ready" | "failed") => void;
  /** Pass a CursorType to show the custom cursor, or null to disable it entirely. */
  cursorType?: CursorType | null;
};

export const CRT_CURVATURE = 0.27;

const CRT_PARAMS = {
  scanlineIntensity: 0.5,
  scanlineCount: 256,
  adaptiveIntensity: 0.3,
  brightness: 1.54,
  contrast: 1.05,
  saturation: 1.09,
  bloomIntensity: 0.72,
  bloomThreshold: 0.42,
  rgbShift: 1.0,
  vignetteStrength: 0.67,
  curvature: 0.27,
  flickerStrength: 0.015,
} as const;

const SOURCE_SCALE = 0.72;
const SOURCE_FPS = 30;

const CURSOR_SIZE = 48;

const CURSOR_HOTSPOTS: Record<CursorType, readonly [number, number]> = {
  default: [10, 10],
  pointer: [13, 6],
  grab: [16, 13],
  grabbing: [15, 13],
};

// Applies the same forward UV mapping the CRT shader uses so the cursor
// drawn in source-canvas space appears at the real pointer position on screen.
const drawCursor = (
  ctx: CanvasRenderingContext2D,
  mousePos: { x: number; y: number } | null,
  cursorType: CursorType,
  frameRect: DOMRect,
  cursorImages: Record<CursorType, HTMLImageElement | null>,
) => {
  if (!mousePos) return;
  if (
    mousePos.x < frameRect.left ||
    mousePos.x > frameRect.right ||
    mousePos.y < frameRect.top ||
    mousePos.y > frameRect.bottom
  ) {
    return;
  }

  const img = cursorImages[cursorType];
  if (!img || !img.complete) return;

  // Normalised position within the frame (Y goes down, matching frameUv in shader)
  const frameUvX = (mousePos.x - frameRect.left) / frameRect.width;
  const frameUvY = (mousePos.y - frameRect.top) / frameRect.height;

  // Match the shader's Y-flip (uv.y = 1.0 - frameUv.y) then apply curveRemapUV
  const cx = frameUvX * 2.0 - 1.0;
  const cy = (1.0 - frameUvY) * 2.0 - 1.0;
  const dist = cx * cx + cy * cy;
  const s = 1.0 + dist * (CRT_PARAMS.curvature * 0.25);

  // Convert curved UV back to source-canvas draw coordinates (frame-space units)
  const drawX = (cx * s * 0.5 + 0.5) * frameRect.width;
  const drawY = (1.0 - (cy * s * 0.5 + 0.5)) * frameRect.height;

  const [hx, hy] = CURSOR_HOTSPOTS[cursorType];
  ctx.drawImage(img, drawX - hx, drawY - hy, CURSOR_SIZE, CURSOR_SIZE);
};

const VERTEX_SHADER = `
  attribute vec2 aPosition;
  varying vec2 vUv;

  void main() {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision mediump float;

  uniform sampler2D tDiffuse;
  uniform vec2 uResolution;
  uniform vec4 uFrameRect;
  uniform float scanlineIntensity;
  uniform float scanlineCount;
  uniform float time;
  uniform float yOffset;
  uniform float brightness;
  uniform float contrast;
  uniform float saturation;
  uniform float bloomIntensity;
  uniform float bloomThreshold;
  uniform float rgbShift;
  uniform float adaptiveIntensity;
  uniform float vignetteStrength;
  uniform float curvature;
  uniform float flickerStrength;

  varying vec2 vUv;

  const float PI = 3.14159265;
  const vec3 LUMA = vec3(0.299, 0.587, 0.114);

  vec2 curveRemapUV(vec2 uv, float curve) {
    vec2 coords = uv * 2.0 - 1.0;
    float curveAmount = curve * 0.25;
    float dist = dot(coords, coords);
    coords = coords * (1.0 + dist * curveAmount);
    return coords * 0.5 + 0.5;
  }

  vec4 sampleBloom(sampler2D tex, vec2 uv, float radius, vec4 centerSample) {
    vec2 o = vec2(radius);
    vec4 c = centerSample * 0.4;
    vec4 cross = (
      texture2D(tex, uv + vec2(o.x, 0.0)) +
      texture2D(tex, uv - vec2(o.x, 0.0)) +
      texture2D(tex, uv + vec2(0.0, o.y)) +
      texture2D(tex, uv - vec2(0.0, o.y))
    ) * 0.15;
    return c + cross;
  }

  float vignetteApprox(vec2 uv, float strength) {
    vec2 vigCoord = uv * 2.0 - 1.0;
    float dist = max(abs(vigCoord.x), abs(vigCoord.y));
    return 1.0 - dist * dist * strength;
  }

  void main() {
    vec2 fragPx = vec2(vUv.x * uResolution.x, (1.0 - vUv.y) * uResolution.y);
    vec2 frameUv = (fragPx - uFrameRect.xy) / uFrameRect.zw;

    if (frameUv.x < 0.0 || frameUv.x > 1.0 || frameUv.y < 0.0 || frameUv.y > 1.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    vec2 uv = vec2(frameUv.x, 1.0 - frameUv.y);
    if (curvature > 0.001) {
      uv = curveRemapUV(uv, curvature);
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }
    }

    vec4 pixel = texture2D(tDiffuse, uv);

    if (bloomIntensity > 0.001) {
      float pixelLum = dot(pixel.rgb, LUMA);
      float bloomThresholdHalf = bloomThreshold * 0.5;
      if (pixelLum > bloomThresholdHalf) {
        vec4 bloomSample = sampleBloom(tDiffuse, uv, 0.005, pixel);
        bloomSample.rgb *= brightness;
        float bloomLum = dot(bloomSample.rgb, LUMA);
        float bloomFactor = bloomIntensity * max(0.0, (bloomLum - bloomThreshold) * 1.5);
        pixel.rgb += bloomSample.rgb * bloomFactor;
      }
    }

    if (rgbShift > 0.005) {
      float shift = rgbShift * 0.005;
      pixel.r += texture2D(tDiffuse, vec2(uv.x + shift, uv.y)).r * 0.08;
      pixel.b += texture2D(tDiffuse, vec2(uv.x - shift, uv.y)).b * 0.08;
    }

    pixel.rgb *= brightness;
    float luminance = dot(pixel.rgb, LUMA);
    pixel.rgb = (pixel.rgb - 0.5) * contrast + 0.5;
    pixel.rgb = mix(vec3(luminance), pixel.rgb, saturation);

    float lightingMask = 1.0;

    if (scanlineIntensity > 0.001) {
      float scanlineY = (uv.y + yOffset) * scanlineCount;
      float scanlinePattern = abs(sin(scanlineY * PI));
      float adaptiveFactor = 1.0;
      if (adaptiveIntensity > 0.001) {
        float yPattern = sin(uv.y * 30.0) * 0.5 + 0.5;
        adaptiveFactor = 1.0 - yPattern * adaptiveIntensity * 0.2;
      }
      lightingMask *= 1.0 - scanlinePattern * scanlineIntensity * adaptiveFactor;
    }

    if (flickerStrength > 0.001) {
      lightingMask *= 1.0 + sin(time * 110.0) * flickerStrength;
    }

    if (vignetteStrength > 0.001) {
      lightingMask *= vignetteApprox(uv, vignetteStrength);
    }

    pixel.rgb *= lightingMask;
    gl_FragColor = vec4(pixel.rgb, 1.0);
  }
`;

const compileShader = (gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null => {
  const shader = gl.createShader(type);
  if (!shader) {
    return null;
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
};

const createProgram = (gl: WebGLRenderingContext): WebGLProgram | null => {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);

  if (!vertexShader || !fragmentShader) {
    if (vertexShader) gl.deleteShader(vertexShader);
    if (fragmentShader) gl.deleteShader(fragmentShader);
    return null;
  }

  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return null;
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  return program;
};

// ── Shared background (column stripes + border) ───────────────────────────────
const drawBackground = (
  ctx: CanvasRenderingContext2D,
  frameWidth: number,
  frameHeight: number,
) => {
  ctx.clearRect(0, 0, frameWidth, frameHeight);
  ctx.fillStyle = "#051021";
  ctx.fillRect(0, 0, frameWidth, frameHeight);

  const colW = frameWidth / 18;
  for (let i = 0; i < 18; i += 1) {
    ctx.fillStyle = i % 2 === 0 ? "rgba(5,16,33,0.92)" : "rgba(5,16,33,0.76)";
    ctx.fillRect(i * colW, 0, colW + 1, frameHeight);
  }
};

// Logo aspect: 1197 × 625 (natural SVG dimensions)
const LOGO_ASPECT = 1197 / 625;

// Draw the pre-colorized logo canvas centred horizontally at the given top-Y.
const drawLogo = (
  ctx: CanvasRenderingContext2D,
  logoCanvas: HTMLCanvasElement | null,
  cx: number,
  topY: number,
  desiredWidth: number,
) => {
  if (!logoCanvas) return;
  const h = desiredWidth / LOGO_ASPECT;
  ctx.drawImage(logoCanvas, cx - desiredWidth * 0.5, topY, desiredWidth, h);
};

// ── Gate (locked) screen ──────────────────────────────────────────────────────
const drawGateScreen = (
  ctx: CanvasRenderingContext2D,
  frameWidth: number,
  frameHeight: number,
  sessionInitError: string | null,
  logoCanvas: HTMLCanvasElement | null,
) => {
  drawBackground(ctx, frameWidth, frameHeight);

  const cx = frameWidth * 0.5;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Keep logo + button as a centered lockup.
  const logoW = Math.min(260, frameWidth * 0.42);
  const logoH = logoW / LOGO_ASPECT;
  const btnW = Math.max(200, Math.min(360, frameWidth * 0.54));
  const btnH = 52;
  const stackGap = 80;
  const stackH = logoH + stackGap + btnH;
  const stackTopY = (frameHeight - stackH) * 0.5;
  const logoTopY = stackTopY;
  drawLogo(ctx, logoCanvas, cx, logoTopY, logoW);

  const btnX = cx - btnW * 0.5;
  const btnY = stackTopY + logoH + stackGap;

  // Keep the error line between logo and button when present.
  if (sessionInitError) {
    ctx.fillStyle = "rgba(254,123,217,0.82)";
    ctx.font = '500 15px "IBM Plex Mono", monospace';
    ctx.fillText(`ERROR: ${sessionInitError}`, cx, logoTopY + logoH + stackGap * 0.5);
  }

  ctx.strokeStyle = "rgba(190,238,255,0.78)";
  ctx.lineWidth = 1;
  ctx.strokeRect(btnX + 0.5, btnY + 0.5, btnW - 1, btnH - 1);
  ctx.fillStyle = "rgba(5,16,33,0.72)";
  ctx.fillRect(btnX + 1, btnY + 1, btnW - 2, btnH - 2);

  ctx.fillStyle = "rgba(190,238,255,0.94)";
  ctx.font = '600 18px "IBM Plex Mono", monospace';
  ctx.fillText("BEGIN REFINEMENT", cx, btnY + btnH * 0.5);

  ctx.fillStyle = "rgba(190,238,255,0.5)";
  ctx.font = '500 12px "IBM Plex Mono", monospace';
  ctx.fillText("a collective curation experiment", cx, frameHeight - Math.max(24, frameHeight * 0.055));

};

// ── Preloading screen ─────────────────────────────────────────────────────────
const drawPreloadScreen = (
  ctx: CanvasRenderingContext2D,
  frameWidth: number,
  frameHeight: number,
  loaded: number,
  total: number,
  logoCanvas: HTMLCanvasElement | null,
) => {
  drawBackground(ctx, frameWidth, frameHeight);

  const cx = frameWidth * 0.5;
  const barW = Math.min(400, frameWidth * 0.54);
  const barH = 12;
  const progress = total > 0 ? loaded / total : 0;

  // Keep preload as a centered lockup, matching the gate treatment.
  const logoW = Math.min(260, frameWidth * 0.42);
  const logoH = logoW / LOGO_ASPECT;
  const stackGap = 40;
  const preloadBlockH = 72;
  const stackH = logoH + stackGap + preloadBlockH;
  const stackTopY = (frameHeight - stackH) * 0.5;
  const logoTopY = stackTopY;
  drawLogo(ctx, logoCanvas, cx, logoTopY, logoW);
  const labelY = stackTopY + logoH + stackGap + 9;
  const barY = labelY + 24;
  const countY = labelY + 56;

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.fillStyle = "rgba(190,238,255,0.58)";
  ctx.font = '500 17px "IBM Plex Mono", monospace';
  ctx.fillText("LOADING SESSION AUDIO", cx, labelY);

  const barX = cx - barW * 0.5;
  ctx.strokeStyle = "rgba(190,238,255,0.36)";
  ctx.lineWidth = 1;
  ctx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, barH - 1);

  if (progress > 0) {
    ctx.fillStyle = "rgba(190,238,255,0.68)";
    ctx.fillRect(barX + 1, barY + 1, (barW - 2) * progress, barH - 2);
  }

  ctx.fillStyle = "rgba(190,238,255,0.4)";
  ctx.font = '500 15px "IBM Plex Mono", monospace';
  ctx.fillText(
    `${String(loaded).padStart(3, "0")} / ${String(total).padStart(3, "0")}`,
    cx,
    countY,
  );
};

// ── Main refine-UI surface ────────────────────────────────────────────────────
const drawSourceSurface = (
  ctx: CanvasRenderingContext2D,
  frameWidth: number,
  frameHeight: number,
  gridViewport: { x: number; y: number; width: number; height: number },
  cells: SurfaceCellRender[],
  meterValues: readonly number[],
  binCodes: readonly string[],
  placedCount: number,
  sessionSize: number,
  binOpenAmounts: readonly number[],
  pulseBin: number | null,
  hoveredBinPlaylist: number | null,
  dragState: SurfaceDragRender | null,
  throwState: SurfaceDragRender | null,
  frameLeft: number,
  frameTop: number,
  logoCanvas: HTMLCanvasElement | null,
) => {
  const pad = 16;
  const headerH = 80; // matches .frame-header { height: 80px }
  const binsH = 82;
  const statusH = 30;
  const headerMidY = headerH * 0.5;

  drawBackground(ctx, frameWidth, frameHeight);

  ctx.strokeStyle = "rgba(190,238,255,0.24)";
  ctx.beginPath();
  ctx.moveTo(0, headerH + 0.5);
  ctx.lineTo(frameWidth, headerH + 0.5);
  ctx.moveTo(0, frameHeight - binsH - statusH + 0.5);
  ctx.lineTo(frameWidth, frameHeight - binsH - statusH + 0.5);
  ctx.moveTo(0, frameHeight - statusH + 0.5);
  ctx.lineTo(frameWidth, frameHeight - statusH + 0.5);
  ctx.stroke();

  // Header — title left, progress far right
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  ctx.fillStyle = "rgba(190,238,255,0.9)";
  ctx.font = '600 22px "IBM Plex Mono", monospace';
  ctx.fillText("MacroVibe Refinement", pad, headerMidY);

  void logoCanvas; // unused in refiner view

  const progressStr = `PROGRESS: ${String(placedCount).padStart(3, "0")} / ${String(sessionSize).padStart(3, "0")}`;
  ctx.font = '600 16px "IBM Plex Mono", monospace';
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(190,238,255,0.72)";
  ctx.fillText(progressStr, frameWidth - pad, headerMidY);

  for (const cell of cells) {
    const x = gridViewport.x + cell.x;
    const y = gridViewport.y + cell.y;
    const size = Math.max(11, cell.height * 0.42 * cell.scale);
    ctx.globalAlpha = cell.isDragOrigin ? 0.22 : 1;
    ctx.fillStyle = "rgba(190,238,255,0.74)";
    ctx.font = `600 ${size}px "IBM Plex Mono", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(cell.code, x, y);
  }
  ctx.globalAlpha = 1;

  const binY = frameHeight - statusH - binsH + 10;
  const binGap = 7;
  const binW = (frameWidth - pad * 2 - binGap * (binCodes.length - 1)) / binCodes.length;
  const labelH = 38;
  const meterH = 22;
  const accent = ["#77DB70", "#F1EB5A", "#FE7BD9", "#1A3DF5"];

  for (let i = 0; i < binCodes.length; i += 1) {
    const x = pad + i * (binW + binGap);
    const open = Math.max(0, Math.min(1, binOpenAmounts[i] ?? 0));
    const isOpen = open > 0.02;
    const isPulse = pulseBin === i;
    const lift = open * 2.25;
    const rowY = binY - lift;
    const lidY = rowY - 7.5;
    const mouthW = binW * (0.1 + open * 0.12);
    const flapOpenAngle = open * 0.58;
    const flapHeight = 9;
    const flapWidth = Math.max(16, binW * 0.42);
    const leftHingeX = x + 1.5;
    const rightHingeX = x + binW - 1.5;
    const hingeY = lidY + flapHeight;
    const mouthX = x + binW * 0.5 - mouthW * 0.5;
    const mouthY = lidY + 1 - open * 1.5;

    ctx.strokeStyle = isOpen ? "rgba(190,238,255,0.68)" : "rgba(190,238,255,0.36)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 1, lidY + flapHeight + 0.5);
    ctx.lineTo(x + binW - 1, lidY + flapHeight + 0.5);
    ctx.stroke();

    ctx.fillStyle = "rgba(5,16,33,0.84)";
    ctx.strokeStyle = isOpen ? "rgba(190,238,255,0.6)" : "rgba(190,238,255,0.42)";
    ctx.lineWidth = 1;
    ctx.strokeRect(mouthX + 0.5, mouthY + 0.5, mouthW - 1, 3);
    ctx.fillRect(mouthX + 1, mouthY + 1, mouthW - 2, 2);

    ctx.fillStyle = "rgba(5,16,33,0.86)";
    ctx.strokeStyle = isOpen ? "rgba(190,238,255,0.72)" : "rgba(190,238,255,0.48)";

    ctx.save();
    ctx.translate(leftHingeX, hingeY);
    ctx.rotate(-flapOpenAngle);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -flapHeight);
    ctx.lineTo(flapWidth, -flapHeight * 0.72);
    ctx.lineTo(flapWidth, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.translate(rightHingeX, hingeY);
    ctx.rotate(flapOpenAngle);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -flapHeight);
    ctx.lineTo(-flapWidth, -flapHeight * 0.72);
    ctx.lineTo(-flapWidth, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = isOpen ? "rgba(190,238,255,0.72)" : "rgba(190,238,255,0.52)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, rowY + 0.5, binW - 1, labelH - 1);

    ctx.fillStyle = "rgba(5,16,33,0.72)";
    ctx.fillRect(x + 1, rowY + 1, binW - 2, labelH - 2);

    ctx.fillStyle = accent[i % 4];
    ctx.font = '600 14px "IBM Plex Mono", monospace';
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), x + 8, rowY + 19);

    ctx.fillStyle = isPulse ? "rgba(190,238,255,0.95)" : "rgba(190,238,255,0.82)";
    ctx.font = '600 24px "IBM Plex Mono", monospace';
    ctx.textAlign = "center";
    ctx.fillText(binCodes[i], x + binW * 0.56, rowY + 20);

    const meterY = rowY + labelH + 3;
    ctx.strokeStyle = "rgba(190,238,255,0.52)";
    ctx.strokeRect(x + 0.5, meterY + 0.5, binW - 1, meterH - 1);
    ctx.fillStyle = "rgba(5,16,33,0.72)";
    ctx.fillRect(x + 1, meterY + 1, binW - 2, meterH - 2);

    const fillW = (binW - 2) * (meterValues[i] / 100);
    ctx.fillStyle = `${accent[i % 4]}AA`;
    ctx.fillRect(x + 1, meterY + 1, fillW, meterH - 2);

    // "OPEN" label — drawn on canvas so it's visible through CRT
    if (hoveredBinPlaylist === i) {
      ctx.fillStyle = "rgba(5,16,33,0.78)";
      ctx.fillRect(x + binW - 44, meterY + 1, 42, meterH - 2);
      ctx.fillStyle = "rgba(190,238,255,0.92)";
      ctx.font = '600 14px "IBM Plex Mono", monospace';
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText("OPEN ↗", x + binW - 5, meterY + meterH * 0.5);
    }
  }

  const footerY = frameHeight - 10;
  ctx.fillStyle = "rgba(190,238,255,0.66)";
  ctx.font = '500 16px "IBM Plex Mono", monospace';
  ctx.textAlign = "left";
  ctx.fillText("SESSION: 8F0C-42DA", pad, footerY);
  ctx.textAlign = "center";
  ctx.fillText("AUDIO: ARMED", frameWidth * 0.5, footerY);
  ctx.textAlign = "right";
  ctx.fillText("LATENCY: 182MS", frameWidth - pad, footerY);

  const activeDrag = dragState ?? throwState;
  if (activeDrag) {
    const w = activeDrag.width * activeDrag.scale;
    const h = activeDrag.height * activeDrag.scale;

    // Apply forward CRT mapping to keep the drag item visually anchored to
    // the real mouse/throw position after curvature distortion. Without this
    // the item drifts toward the edges relative to the cursor.
    const hotspotFrameX = activeDrag.x - frameLeft + (activeDrag.offsetX ?? w / activeDrag.scale * 0.5) * activeDrag.scale;
    const hotspotFrameY = activeDrag.y - frameTop + (activeDrag.offsetY ?? h / activeDrag.scale * 0.5) * activeDrag.scale;
    const uvX = hotspotFrameX / frameWidth;
    const uvY = 1.0 - hotspotFrameY / frameHeight;
    const cxc = uvX * 2.0 - 1.0;
    const cyc = uvY * 2.0 - 1.0;
    const distc = cxc * cxc + cyc * cyc;
    const sc = 1.0 + distc * (CRT_CURVATURE * 0.25);
    const mappedHotX = (cxc * sc * 0.5 + 0.5) * frameWidth;
    const mappedHotY = (1.0 - (cyc * sc * 0.5 + 0.5)) * frameHeight;
    const drawCenterX = mappedHotX - (activeDrag.offsetX ?? w / activeDrag.scale * 0.5) * activeDrag.scale + w * 0.5;
    const drawCenterY = mappedHotY - (activeDrag.offsetY ?? h / activeDrag.scale * 0.5) * activeDrag.scale + h * 0.5;

    const size = Math.max(11, activeDrag.height * 0.44 * activeDrag.scale);
    ctx.globalAlpha = Math.max(0, Math.min(1, activeDrag.opacity ?? 1));
    ctx.fillStyle = "rgba(190,238,255,0.94)";
    ctx.font = `600 ${size}px "IBM Plex Mono", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(activeDrag.code, drawCenterX, drawCenterY);
    ctx.globalAlpha = 1;
  }
};

export function CrtWebglOverlay({
  frameRef,
  gridViewport,
  cells,
  meterValues,
  binCodes,
  placedCount,
  sessionSize,
  activeBin,
  pulseBin,
  hoveredBinPlaylist,
  dragState,
  throwState,
  audioPhase,
  preloadProgress,
  sessionInitError,
  drawContent,
  onStatusChange,
  cursorType,
}: CrtWebglOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<"initializing" | "ready" | "failed">("initializing");
  const statusCallbackRef = useRef(onStatusChange);
  statusCallbackRef.current = onStatusChange;

  // Stable draw-override ref — updated every render, no useEffect re-run needed
  const drawContentRef = useRef(drawContent);
  drawContentRef.current = drawContent;

  // Mirror cursorType prop into a ref so the rAF loop always reads the latest value.
  // null means cursor drawing is disabled for this overlay (e.g. MobileGate).
  const cursorTypeRef = useRef<CursorType | null>("default");
  cursorTypeRef.current = cursorType === undefined ? "default" : cursorType;

  // Mouse position tracking — updated by pointermove, read each source canvas draw
  const mousePosRef = useRef<{ x: number; y: number } | null>(null);

  // Pre-loaded cursor images — populated once on mount
  const cursorImagesRef = useRef<Record<CursorType, HTMLImageElement | null>>({
    default: null,
    pointer: null,
    grab: null,
    grabbing: null,
  });
  useEffect(() => {
    const entries: Array<[CursorType, string]> = [
      ["default", cursorDefaultUrl],
      ["pointer", cursorPointerUrl],
      ["grab", cursorGrabUrl],
      ["grabbing", cursorGrabbingUrl],
    ];
    for (const [type, url] of entries) {
      const img = new Image();
      img.onload = () => {
        cursorImagesRef.current[type] = img;
      };
      img.src = url;
    }
  }, []);

  // Pre-colorized logo canvas — built once on mount, passed into draw functions
  const logoCanvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const offCtx = canvas.getContext("2d");
      if (!offCtx) return;
      // Draw the black SVG paths, then tint them to the UI accent colour
      offCtx.drawImage(img, 0, 0);
      offCtx.globalCompositeOperation = "source-atop";
      offCtx.fillStyle = "rgba(190,238,255,0.9)";
      offCtx.fillRect(0, 0, canvas.width, canvas.height);
      logoCanvasRef.current = canvas;
    };
    img.src = logoUrl;
  }, []);

  const latestRef = useRef({
    gridViewport: gridViewport ?? { x: 0, y: 0, width: 0, height: 0 },
    cells: cells ?? [],
    meterValues: meterValues ?? [],
    binCodes: binCodes ?? [],
    placedCount: placedCount ?? 0,
    sessionSize: sessionSize ?? 0,
    activeBin: activeBin ?? null,
    pulseBin: pulseBin ?? null,
    hoveredBinPlaylist: hoveredBinPlaylist ?? null,
    dragState: dragState ?? null,
    throwState: throwState ?? null,
    audioPhase: audioPhase ?? "ready",
    preloadProgress: preloadProgress ?? { loaded: 0, total: 1 },
    sessionInitError: sessionInitError ?? null,
  });

  latestRef.current = {
    gridViewport: gridViewport ?? { x: 0, y: 0, width: 0, height: 0 },
    cells: cells ?? [],
    meterValues: meterValues ?? [],
    binCodes: binCodes ?? [],
    placedCount: placedCount ?? 0,
    sessionSize: sessionSize ?? 0,
    activeBin: activeBin ?? null,
    pulseBin: pulseBin ?? null,
    hoveredBinPlaylist: hoveredBinPlaylist ?? null,
    dragState: dragState ?? null,
    throwState: throwState ?? null,
    audioPhase: audioPhase ?? "ready",
    preloadProgress: preloadProgress ?? { loaded: 0, total: 1 },
    sessionInitError: sessionInitError ?? null,
  };

  const commitStatus = useCallback((next: "initializing" | "ready" | "failed") => {
    setStatus((current) => (current === next ? current : next));
    statusCallbackRef.current?.(next);
  }, []);

  useEffect(() => {
    commitStatus("initializing");
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!gl) {
      commitStatus("failed");
      return;
    }

    const sourceCanvas = document.createElement("canvas");
    const sourceCtx = sourceCanvas.getContext("2d");
    if (!sourceCtx) {
      commitStatus("failed");
      return;
    }

    const program = createProgram(gl);
    if (!program) {
      commitStatus("failed");
      return;
    }

    const positionLocation = gl.getAttribLocation(program, "aPosition");
    const resolutionLocation = gl.getUniformLocation(program, "uResolution");
    const frameRectLocation = gl.getUniformLocation(program, "uFrameRect");
    const textureLocation = gl.getUniformLocation(program, "tDiffuse");
    const scanlineIntensityLocation = gl.getUniformLocation(program, "scanlineIntensity");
    const scanlineCountLocation = gl.getUniformLocation(program, "scanlineCount");
    const timeLocation = gl.getUniformLocation(program, "time");
    const yOffsetLocation = gl.getUniformLocation(program, "yOffset");
    const brightnessLocation = gl.getUniformLocation(program, "brightness");
    const contrastLocation = gl.getUniformLocation(program, "contrast");
    const saturationLocation = gl.getUniformLocation(program, "saturation");
    const bloomIntensityLocation = gl.getUniformLocation(program, "bloomIntensity");
    const bloomThresholdLocation = gl.getUniformLocation(program, "bloomThreshold");
    const rgbShiftLocation = gl.getUniformLocation(program, "rgbShift");
    const adaptiveIntensityLocation = gl.getUniformLocation(program, "adaptiveIntensity");
    const vignetteStrengthLocation = gl.getUniformLocation(program, "vignetteStrength");
    const curvatureLocation = gl.getUniformLocation(program, "curvature");
    const flickerStrengthLocation = gl.getUniformLocation(program, "flickerStrength");

    const quadBuffer = gl.createBuffer();
    if (!quadBuffer) {
      gl.deleteProgram(program);
      commitStatus("failed");
      return;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const texture = gl.createTexture();
    if (!texture) {
      gl.deleteBuffer(quadBuffer);
      gl.deleteProgram(program);
      commitStatus("failed");
      return;
    }

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    let frameRect = frameRef.current?.getBoundingClientRect() ?? null;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.0);
      const width = Math.max(2, Math.floor(window.innerWidth * dpr));
      const height = Math.max(2, Math.floor(window.innerHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
      gl.useProgram(program);
      gl.uniform2f(resolutionLocation, width, height);
      frameRect = frameRef.current?.getBoundingClientRect() ?? null;
    };

    const observer = new ResizeObserver(() => {
      frameRect = frameRef.current?.getBoundingClientRect() ?? null;
    });
    if (frameRef.current) {
      observer.observe(frameRef.current);
    }
    window.addEventListener("resize", resize);
    resize();

    let cursorNeedsRedraw = false;
    const handlePointerMove = (event: PointerEvent) => {
      mousePosRef.current = { x: event.clientX, y: event.clientY };
      cursorNeedsRedraw = true;
    };
    const handlePointerLeave = () => {
      mousePosRef.current = null;
      cursorNeedsRedraw = true;
    };
    window.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerleave", handlePointerLeave);

    let lastSourceDraw = 0;
    const binOpenAmounts = Array.from({ length: latestRef.current.binCodes.length }, () => 0);
    let lastTick = performance.now();
    let rafId = 0;
    let alive = true;
    let readyReported = false;

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      commitStatus("failed");
      alive = false;
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
    };
    canvas.addEventListener("webglcontextlost", handleContextLost, false);

    const draw = (timeMs: number) => {
      if (!alive) {
        return;
      }

      const latest = latestRef.current;
      if (binOpenAmounts.length !== latest.binCodes.length) {
        binOpenAmounts.length = latest.binCodes.length;
        for (let i = 0; i < binOpenAmounts.length; i += 1) {
          if (!Number.isFinite(binOpenAmounts[i])) {
            binOpenAmounts[i] = 0;
          }
        }
      }

      const dt = Math.max(0.001, Math.min(0.1, (timeMs - lastTick) * 0.001));
      lastTick = timeMs;
      const follow = 1 - Math.exp(-dt * 24);
      for (let i = 0; i < binOpenAmounts.length; i += 1) {
        const target = latest.activeBin === i ? 1 : 0;
        binOpenAmounts[i] += (target - binOpenAmounts[i]) * follow;
      }

      if (!frameRect) {
        frameRect = frameRef.current?.getBoundingClientRect() ?? null;
      }

      if (frameRect && (timeMs - lastSourceDraw >= 1000 / SOURCE_FPS || cursorNeedsRedraw)) {
        cursorNeedsRedraw = false;
        const srcW = Math.max(2, Math.floor(frameRect.width * SOURCE_SCALE));
        const srcH = Math.max(2, Math.floor(frameRect.height * SOURCE_SCALE));

        if (sourceCanvas.width !== srcW || sourceCanvas.height !== srcH) {
          sourceCanvas.width = srcW;
          sourceCanvas.height = srcH;
        }

        sourceCtx.setTransform(1, 0, 0, 1, 0, 0);
        sourceCtx.clearRect(0, 0, srcW, srcH);
        sourceCtx.scale(srcW / frameRect.width, srcH / frameRect.height);

        if (drawContentRef.current) {
          // Custom draw override (used by archive and any future views)
          drawContentRef.current(sourceCtx, frameRect.width, frameRect.height);
        } else {
          // Built-in dispatch: gate, preloading, or main refine UI
          const phase = latest.audioPhase;
          if (phase === "locked") {
            drawGateScreen(sourceCtx, frameRect.width, frameRect.height, latest.sessionInitError, logoCanvasRef.current);
          } else if (phase === "preloading") {
            drawPreloadScreen(
              sourceCtx,
              frameRect.width,
              frameRect.height,
              latest.preloadProgress.loaded,
              latest.preloadProgress.total,
              logoCanvasRef.current,
            );
          } else {
            drawSourceSurface(
              sourceCtx,
              frameRect.width,
              frameRect.height,
              latest.gridViewport,
              latest.cells,
              latest.meterValues,
              latest.binCodes,
              latest.placedCount,
              latest.sessionSize,
              binOpenAmounts,
              latest.pulseBin,
              latest.hoveredBinPlaylist,
              latest.dragState,
              latest.throwState,
              frameRect.left,
              frameRect.top,
              logoCanvasRef.current,
            );
          }
        }

        // Draw cursor on top of all content before uploading to WebGL texture
        // so it inherits the full CRT effect (scanlines, bloom, curvature).
        // cursorTypeRef.current === null means cursor is disabled for this overlay.
        if (cursorTypeRef.current !== null) {
          drawCursor(sourceCtx, mousePosRef.current, cursorTypeRef.current, frameRect, cursorImagesRef.current);
        }

        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);

        lastSourceDraw = timeMs;
      }

      gl.useProgram(program);
      gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(textureLocation, 0);

      const dpr = Math.min(window.devicePixelRatio || 1, 1.0);
      if (frameRect) {
        gl.uniform4f(
          frameRectLocation,
          frameRect.left * dpr,
          frameRect.top * dpr,
          frameRect.width * dpr,
          frameRect.height * dpr,
        );
      } else {
        gl.uniform4f(frameRectLocation, 0, 0, 0, 0);
      }

      gl.uniform1f(scanlineIntensityLocation, CRT_PARAMS.scanlineIntensity);
      gl.uniform1f(scanlineCountLocation, CRT_PARAMS.scanlineCount);
      gl.uniform1f(timeLocation, timeMs * 0.001);
      gl.uniform1f(yOffsetLocation, 0.0);
      gl.uniform1f(brightnessLocation, CRT_PARAMS.brightness);
      gl.uniform1f(contrastLocation, CRT_PARAMS.contrast);
      gl.uniform1f(saturationLocation, CRT_PARAMS.saturation);
      gl.uniform1f(bloomIntensityLocation, CRT_PARAMS.bloomIntensity);
      gl.uniform1f(bloomThresholdLocation, CRT_PARAMS.bloomThreshold);
      gl.uniform1f(rgbShiftLocation, CRT_PARAMS.rgbShift);
      gl.uniform1f(adaptiveIntensityLocation, CRT_PARAMS.adaptiveIntensity);
      gl.uniform1f(vignetteStrengthLocation, CRT_PARAMS.vignetteStrength);
      gl.uniform1f(curvatureLocation, CRT_PARAMS.curvature);
      gl.uniform1f(flickerStrengthLocation, CRT_PARAMS.flickerStrength);

      gl.clearColor(0.0, 0.0, 0.0, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (!readyReported) {
        readyReported = true;
        commitStatus("ready");
      }

      rafId = requestAnimationFrame(draw);
    };

    rafId = requestAnimationFrame(draw);

    return () => {
      alive = false;
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      canvas.removeEventListener("webglcontextlost", handleContextLost, false);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerleave", handlePointerLeave);
      observer.disconnect();
      gl.deleteTexture(texture);
      gl.deleteBuffer(quadBuffer);
      gl.deleteProgram(program);
    };
  }, [frameRef, commitStatus]);

  return (
    <div className={`crt-overlay is-${status}`} aria-hidden="true">
      <canvas ref={canvasRef} className="crt-webgl-canvas" />
    </div>
  );
}
