/**
 * Audius Playlist Sync
 *
 * Diffs the crowd-sourced bin assignments in Supabase (archive_tracks view)
 * against the current Audius playlist state (audius_published_tracks table)
 * and applies add / remove / move operations to the managed Audius playlists.
 *
 * Modes:
 *   RUN_SETUP=true  — one-time setup: creates 6 Audius playlists, one per bin.
 *   (default)       — hourly sync: diff and apply changes.
 *
 * Required env vars:
 *   AUDIUS_API_KEY, AUDIUS_API_SECRET, AUDIUS_MANAGED_USER_ID
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { sdk } from "@audius/sdk";
import { createClient } from "@supabase/supabase-js";

const BIN_CODES = ["VELLUM", "BRINE", "HEAT", "STATIC", "HALO", "GRIT"];

// ── Config ────────────────────────────────────────────────────────────────────

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const config = {
  audiusApiKey: required("AUDIUS_API_KEY"),
  audiusApiSecret: required("AUDIUS_API_SECRET"),
  audiusManagedUserId: required("AUDIUS_MANAGED_USER_ID"),
  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  runSetup: process.env.RUN_SETUP === "true",
};

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false },
});

const audiusSdk = sdk({
  appName: "MacroVibe Refinement",
  apiKey: config.audiusApiKey,
  apiSecret: config.audiusApiSecret,
});

function logEvent(name, payload = {}) {
  console.log(JSON.stringify({ event: name, ts: new Date().toISOString(), ...payload }));
}

/**
 * Retry an async operation with exponential backoff.
 * Attempts: 1 initial + up to maxRetries more.
 * Delays:   baseDelayMs, baseDelayMs*2, baseDelayMs*4, …
 */
async function withRetry(label, fn, { maxRetries = 3, baseDelayMs = 2000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * 2 ** attempt;
        logEvent("audius_op_retry", { label, attempt: attempt + 1, maxRetries, delayMs: delay, error: err.message });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

async function runSetup() {
  const { data: existing, error } = await supabase
    .from("audius_bin_playlists")
    .select("bin_code");

  if (error) throw new Error(`Failed to load existing playlists: ${error.message}`);

  const existingCodes = new Set((existing ?? []).map((r) => r.bin_code));
  const created = [];
  const skipped = [];

  for (const binCode of BIN_CODES) {
    if (existingCodes.has(binCode)) {
      skipped.push(binCode);
      continue;
    }

    const result = await audiusSdk.playlists.createPlaylist({
      userId: config.audiusManagedUserId,
      metadata: { playlistName: binCode, isPrivate: false },
      trackIds: [],
    });

    const { error: insertError } = await supabase.from("audius_bin_playlists").insert({
      bin_code: binCode,
      playlist_id: result.playlistId,
      playlist_name: binCode,
    });

    if (insertError) throw new Error(`Failed to record playlist for ${binCode}: ${insertError.message}`);

    created.push(binCode);
    logEvent("audius_playlist_created", { binCode, playlistId: result.playlistId });
  }

  logEvent("audius_setup_complete", { created, skipped });
}

// ── Sync ──────────────────────────────────────────────────────────────────────

async function runSync() {
  const startedAt = new Date().toISOString();
  let tracksAdded = 0;
  let tracksRemoved = 0;
  let tracksMoved = 0;
  let failedOps = 0;

  logEvent("audius_sync_start", { startedAt });

  try {
    // Load playlist ID map
    const { data: playlistRows, error: playlistError } = await supabase
      .from("audius_bin_playlists")
      .select("bin_code, playlist_id");

    if (playlistError) throw new Error(`Failed to load playlist map: ${playlistError.message}`);
    if (!playlistRows?.length) throw new Error("Playlist map is empty — run with RUN_SETUP=true first.");

    const playlistMap = Object.fromEntries(playlistRows.map((r) => [r.bin_code, r.playlist_id]));

    // Desired state: tracks with majority-vote bin assignments
    const { data: archiveRows, error: archiveError } = await supabase
      .from("archive_tracks")
      .select("track_id, bin_code");

    if (archiveError) throw new Error(`Failed to load archive_tracks: ${archiveError.message}`);

    const desired = new Map((archiveRows ?? []).map((r) => [r.track_id, r.bin_code]));

    // Current published state
    const { data: publishedRows, error: publishedError } = await supabase
      .from("audius_published_tracks")
      .select("track_id, bin_code");

    if (publishedError) throw new Error(`Failed to load published tracks: ${publishedError.message}`);

    const published = new Map((publishedRows ?? []).map((r) => [r.track_id, r.bin_code]));

    // Evict tracks that have been deleted on Audius.
    // Only check published tracks — those are the ones currently sitting in playlists.
    // Uses the REST API directly; the SDK (initialised with write credentials) rejects read calls.
    const publishedIds = [...published.keys()];
    const BATCH_SIZE = 10;
    const deletedOnAudius = new Set();

    for (let i = 0; i < publishedIds.length; i += BATCH_SIZE) {
      const chunk = publishedIds.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        chunk.map(async (id) => {
          const resp = await fetch(
            `https://api.audius.co/v1/tracks/${encodeURIComponent(id)}?app_name=MacroVibe+Refinement`,
            { headers: { "X-API-KEY": config.audiusApiKey } }
          );
          if (resp.status === 404) return { id, deleted: true };
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const json = await resp.json();
          return { id, deleted: json?.data?.is_delete === true };
        })
      );
      for (let j = 0; j < chunk.length; j++) {
        const trackId = chunk[j];
        const result = results[j];
        if (result.status === "fulfilled") {
          if (result.value.deleted) {
            deletedOnAudius.add(trackId);
            logEvent("audius_track_deleted_on_platform", { trackId });
          }
        } else {
          // Transient API error — log but don't assume deleted
          logEvent("audius_track_status_unknown", { trackId, error: result.reason?.message });
        }
      }
    }

    // Pull deleted tracks out of desired so the diff sends them to toRemove
    for (const trackId of deletedOnAudius) {
      desired.delete(trackId);
    }

    // Deactivate deleted tracks in Supabase so they stop being served for refinement
    if (deletedOnAudius.size > 0) {
      const deletedArr = [...deletedOnAudius];
      const { error: deactivateError } = await supabase
        .from("track_pool")
        .update({ is_active: false })
        .in("track_id", deletedArr);
      if (deactivateError) {
        logEvent("audius_deactivate_fail", { error: deactivateError.message, count: deletedArr.length });
      } else {
        logEvent("audius_tracks_deactivated", { count: deletedArr.length });
      }
    }

    // Compute diff
    const toRemove = [];
    const toAdd = [];
    const toMove = [];

    for (const [trackId, binCode] of desired) {
      const currentBin = published.get(trackId);
      if (currentBin === undefined) {
        toAdd.push({ trackId, binCode });
      } else if (currentBin !== binCode) {
        toMove.push({ trackId, oldBinCode: currentBin, newBinCode: binCode });
      }
    }

    for (const [trackId, binCode] of published) {
      if (!desired.has(trackId)) toRemove.push({ trackId, binCode });
    }

    logEvent("audius_sync_diff", {
      toAdd: toAdd.length,
      toRemove: toRemove.length,
      toMove: toMove.length,
    });

    // Removals
    for (const { trackId, binCode } of toRemove) {
      const playlistId = playlistMap[binCode];
      if (!playlistId) continue;
      try {
        await withRetry(`remove:${trackId}`, () =>
          audiusSdk.playlists.removeTrackFromPlaylist({
            userId: config.audiusManagedUserId,
            playlistId,
            trackId,
          })
        );
        await supabase.from("audius_published_tracks").delete().eq("track_id", trackId);
        tracksRemoved++;
      } catch (err) {
        logEvent("audius_track_remove_fail", { trackId, binCode, error: err.message });
        failedOps++;
      }
    }

    // Moves: remove from old, add to new
    for (const { trackId, oldBinCode, newBinCode } of toMove) {
      const oldPlaylistId = playlistMap[oldBinCode];
      const newPlaylistId = playlistMap[newBinCode];
      if (!oldPlaylistId || !newPlaylistId) continue;

      let removeOk = false;
      try {
        await withRetry(`move-remove:${trackId}`, () =>
          audiusSdk.playlists.removeTrackFromPlaylist({
            userId: config.audiusManagedUserId,
            playlistId: oldPlaylistId,
            trackId,
          })
        );
        removeOk = true;
      } catch (err) {
        logEvent("audius_track_remove_fail", { trackId, binCode: oldBinCode, error: err.message });
        failedOps++;
      }

      if (removeOk) {
        try {
          await withRetry(`move-add:${trackId}`, () =>
            audiusSdk.playlists.addTrackToPlaylist({
              userId: config.audiusManagedUserId,
              playlistId: newPlaylistId,
              trackId,
            })
          );
          await supabase.from("audius_published_tracks").upsert({
            track_id: trackId,
            bin_code: newBinCode,
            published_at: new Date().toISOString(),
          });
          tracksMoved++;
        } catch (err) {
          logEvent("audius_track_add_fail", { trackId, binCode: newBinCode, error: err.message });
          failedOps++;
        }
      }
    }

    // Additions
    for (const { trackId, binCode } of toAdd) {
      const playlistId = playlistMap[binCode];
      if (!playlistId) continue;
      try {
        await withRetry(`add:${trackId}`, () =>
          audiusSdk.playlists.addTrackToPlaylist({
            userId: config.audiusManagedUserId,
            playlistId,
            trackId,
          })
        );
        await supabase.from("audius_published_tracks").upsert({
          track_id: trackId,
          bin_code: binCode,
          published_at: new Date().toISOString(),
        });
        tracksAdded++;
      } catch (err) {
        logEvent("audius_track_add_fail", { trackId, binCode, error: err.message });
        failedOps++;
      }
    }

    const healthy = failedOps === 0;

    await supabase.from("audius_sync_runs").insert({
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      healthy,
      tracks_added: tracksAdded,
      tracks_removed: tracksRemoved,
      tracks_moved: tracksMoved,
      metadata: { failedOps, desiredCount: desired.size, publishedCount: published.size, deletedOnAudius: deletedOnAudius.size },
    });

    logEvent("audius_sync_complete", { healthy, tracksAdded, tracksRemoved, tracksMoved, failedOps });

    if (!healthy) process.exit(1);
  } catch (err) {
    console.error("Sync failed:", err);

    await supabase.from("audius_sync_runs").insert({
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      healthy: false,
      tracks_added: tracksAdded,
      tracks_removed: tracksRemoved,
      tracks_moved: tracksMoved,
      error_code: "SYNC_FAILED",
      error_message: err.message,
      metadata: { failedOps },
    });

    logEvent("audius_sync_error", { error: err.message });
    process.exit(1);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

if (config.runSetup) {
  await runSetup().catch((err) => { console.error("Setup failed:", err); process.exit(1); });
} else {
  await runSync();
}
