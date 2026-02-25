export type TrackMeta = {
  trackId: string;
  streamUrl: string | null;
  durationSec: number;
};

type Voice = {
  trackId: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
};

const RAMP_IN_SEC = 0.12;
const RAMP_OUT_SEC = 0.15;
const MAX_VOICES = 2;
const PRELOAD_CONCURRENCY = 8;

// First 512 KB → ~30 s of real audio at 128 kbps MP3.
// Gate blocks until all 64 partials are decoded; full audio upgrades in background.
const PARTIAL_BYTES = 524287;

// Retry a fetch on transient failures (network errors, 429, 5xx).
// 4xx errors other than 429 are not retried (URL expired / bad request).
async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  maxRetries = 3,
  baseDelayMs = 800,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((r) => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)));
    }
    try {
      const res = await fetch(url, options);
      // Retry on rate-limiting or server errors; accept everything else as-is
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export class AudioEngine {
  private ctx: AudioContext;
  private buffers = new Map<string, AudioBuffer>();
  private voices: Voice[] = [];
  private fadingVoices: Voice[] = [];
  private masterGain: GainNode;
  private sessionStartMs = 0;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.masterGain = ctx.createGain();
    this.masterGain.gain.setValueAtTime(0.88, 0);
    this.masterGain.connect(ctx.destination);
  }

  startSession(): void {
    this.sessionStartMs = performance.now();
  }

  getElapsedSec(): number {
    return this.sessionStartMs > 0 ? (performance.now() - this.sessionStartMs) / 1000 : 0;
  }

  private getTrackOffset(trackId: string): number {
    const buffer = this.buffers.get(trackId);
    if (!buffer || buffer.duration <= 0) return 0;
    return this.getElapsedSec() % buffer.duration;
  }

  async preload(
    tracks: TrackMeta[],
    onProgress: (loaded: number, total: number) => void,
    onUpgradeProgress?: (upgraded: number, upgradeTotal: number) => void,
    concurrency = PRELOAD_CONCURRENCY,
  ): Promise<void> {
    const tracksWithUrls = tracks.filter((t) => t.streamUrl);
    const total = tracksWithUrls.length;
    if (total === 0) return;

    let loaded = 0;

    // ── Phase 1 (gate blocks): partial fetch, first 512 KB per track ─────────
    // Retries: 2 attempts with 800 ms / 1.6 s back-off to stay gate-friendly.
    const loadPartial = async (track: TrackMeta): Promise<void> => {
      let decoded = false;

      // Attempt A: Range request with retry
      try {
        const res = await fetchWithRetry(
          track.streamUrl!,
          { headers: { Range: `bytes=0-${PARTIAL_BYTES}` } },
          2,    // max retries
          800,  // base delay ms
        );
        if (res.status === 206 || res.status === 200) {
          const ab = await res.arrayBuffer();
          const buffer = await this.ctx.decodeAudioData(ab);
          this.buffers.set(track.trackId, buffer);
          decoded = true;
        }
      } catch {
        // Range request exhausted retries — fall through to full fetch
      }

      // Attempt B: full fetch with retry (handles Range-unsupported servers too)
      if (!decoded) {
        try {
          const res = await fetchWithRetry(track.streamUrl!, undefined, 2, 800);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const ab = await res.arrayBuffer();
          const buffer = await this.ctx.decodeAudioData(ab);
          this.buffers.set(track.trackId, buffer);
        } catch {
          // All retries exhausted — hover will be silent for this cell only
        }
      }

      loaded++;
      onProgress(loaded, total);
    };

    const queue = [...tracksWithUrls];
    await Promise.all(
      Array.from({ length: Math.min(concurrency, total) }, async () => {
        let item: TrackMeta | undefined;
        while ((item = queue.shift()) !== undefined) {
          await loadPartial(item);
        }
      }),
    );

    // ── Phase 2 (background): upgrade each partial to full audio ─────────────
    // Fire-and-forget — gate is already open. Buffers swap in-place; next
    // hoverIn after an upgrade gets the full track automatically.
    if (!onUpgradeProgress) return;

    let upgraded = 0;
    const upgradeTotal = tracksWithUrls.length;
    const upgradeQueue = [...tracksWithUrls];

    void Promise.all(
      Array.from({ length: Math.min(concurrency, upgradeQueue.length) }, async () => {
        let item: TrackMeta | undefined;
        while ((item = upgradeQueue.shift()) !== undefined) {
          try {
            const res = await fetchWithRetry(item.streamUrl!, undefined, 3, 1000);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const ab = await res.arrayBuffer();
            const buffer = await this.ctx.decodeAudioData(ab);
            this.buffers.set(item.trackId, buffer);
          } catch {
            // Keep partial buffer on upgrade failure
          }
          upgraded++;
          onUpgradeProgress(upgraded, upgradeTotal);
        }
      }),
    );
  }

  hoverIn(trackId: string): void {
    if (!this.sessionStartMs) return;
    if (!this.buffers.has(trackId)) return;
    if (this.voices.some((v) => v.trackId === trackId)) return;

    // Cancel all orphaned fading voices immediately to prevent accumulation
    // during rapid cursor movement. A short micro-fade avoids a hard click.
    if (this.fadingVoices.length > 0) {
      const now = this.ctx.currentTime;
      const MICRO_FADE = 0.02;
      for (const v of this.fadingVoices) {
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setValueAtTime(v.gain.gain.value, now);
        v.gain.gain.linearRampToValueAtTime(0, now + MICRO_FADE);
        v.source.stop(now + MICRO_FADE + 0.005);
      }
      this.fadingVoices = [];
    }

    while (this.voices.length >= MAX_VOICES) {
      const oldest = this.voices.shift()!;
      this._fadeStop(oldest, RAMP_OUT_SEC * 0.5);
    }

    const buffer = this.buffers.get(trackId)!;
    const offset = this.getTrackOffset(trackId);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(1, this.ctx.currentTime + RAMP_IN_SEC);
    gain.connect(this.masterGain);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain);
    source.start(0, offset);

    this.voices.push({ trackId, source, gain });
  }

  hoverOut(trackId: string): void {
    const idx = this.voices.findIndex((v) => v.trackId === trackId);
    if (idx < 0) return;
    const [voice] = this.voices.splice(idx, 1);
    this.fadingVoices.push(voice);
    this._fadeStop(voice, RAMP_OUT_SEC);
  }

  stopAll(): void {
    const snapshot = this.voices.splice(0);
    for (const voice of snapshot) {
      this.fadingVoices.push(voice);
      this._fadeStop(voice, RAMP_OUT_SEC);
    }
  }

  private _fadeStop(voice: Voice, durationSec: number): void {
    const now = this.ctx.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + durationSec);
    voice.source.stop(now + durationSec + 0.02);
    voice.source.onended = () => {
      const idx = this.fadingVoices.indexOf(voice);
      if (idx >= 0) this.fadingVoices.splice(idx, 1);
    };
  }
}
