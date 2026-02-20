// NOTE: This Edge Function cannot be deployed — @audius/sdk@11 exceeds the
// Supabase bundler size limit and times out. The sync logic has been ported
// to scripts/audius-sync.mjs (Node.js) and is run via GitHub Actions on an
// hourly cron. See .github/workflows/audius-sync.yml and docs/plans/audius-sync-plan.md.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { sdk } from "npm:@audius/sdk@11";

import { getAudiusSyncConfig } from "../_shared/env.ts";
import { errorResponse, jsonResponse, preflightResponse } from "../_shared/http.ts";

const BIN_CODES = ["VELLUM", "BRINE", "HEAT", "STATIC", "HALO", "GRIT"] as const;

type PlaylistMap = Record<string, string>; // bin_code → audius playlist_id

type ArchiveTrackRow = {
  track_id: string;
  bin_code: string;
};

type PublishedTrackRow = {
  track_id: string;
  bin_code: string;
};

type BinPlaylistRow = {
  bin_code: string;
  playlist_id: string;
};

function logEvent(name: string, payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: name, ...payload }));
}

// ── Setup mode ────────────────────────────────────────────────────────────────
// Creates one Audius playlist per bin on the managed account.
// Idempotent: skips bins that already have a row in audius_bin_playlists.

async function runSetup(
  supabase: ReturnType<typeof createClient>,
  audiusSdk: ReturnType<typeof sdk>,
  userId: string,
): Promise<Response> {
  const { data: existing, error: existingError } = await supabase
    .from("audius_bin_playlists")
    .select("bin_code");

  if (existingError) {
    console.error("setup: failed to load existing playlists", existingError);
    return errorResponse("SERVER_ERROR", "Failed to load existing playlists.");
  }

  const existingCodes = new Set((existing ?? []).map((r: { bin_code: string }) => r.bin_code));
  const created: string[] = [];
  const skipped: string[] = [];

  for (const binCode of BIN_CODES) {
    if (existingCodes.has(binCode)) {
      skipped.push(binCode);
      continue;
    }

    try {
      const result = await audiusSdk.playlists.createPlaylist({
        userId,
        metadata: {
          playlistName: binCode,
          isPrivate: false,
        },
        trackIds: [],
      });

      const { error: insertError } = await supabase
        .from("audius_bin_playlists")
        .insert({
          bin_code: binCode,
          playlist_id: result.playlistId,
          playlist_name: binCode,
        });

      if (insertError) {
        console.error(`setup: failed to record playlist for ${binCode}`, insertError);
        return errorResponse("SERVER_ERROR", `Failed to record playlist for ${binCode}.`);
      }

      created.push(binCode);
      logEvent("audius_playlist_created", { binCode, playlistId: result.playlistId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logEvent("audius_playlist_create_fail", { binCode, error: message });
      return errorResponse("SERVER_ERROR", `Failed to create Audius playlist for ${binCode}: ${message}`);
    }
  }

  logEvent("audius_setup_complete", { created, skipped });
  return jsonResponse({ ok: true, created, skipped });
}

// ── Sync mode ─────────────────────────────────────────────────────────────────
// Diffs archive_tracks (desired) against audius_published_tracks (current) and
// applies add / remove / move operations to the Audius playlists.

async function runSync(
  supabase: ReturnType<typeof createClient>,
  audiusSdk: ReturnType<typeof sdk>,
  userId: string,
): Promise<Response> {
  const startedAt = new Date().toISOString();
  let tracksAdded = 0;
  let tracksRemoved = 0;
  let tracksMoved = 0;
  let failedOps = 0;

  logEvent("audius_sync_start", { startedAt });

  try {
    // 1. Load playlist ID map — abort early if setup hasn't been run
    const { data: playlistRows, error: playlistError } = await supabase
      .from("audius_bin_playlists")
      .select("bin_code, playlist_id");

    if (playlistError) {
      throw new Error(`Failed to load playlist map: ${playlistError.message}`);
    }
    if (!playlistRows || playlistRows.length === 0) {
      return errorResponse("SERVER_ERROR", "Playlist map is empty. Run ?setup=1 first.");
    }

    const playlistMap: PlaylistMap = {};
    for (const row of playlistRows as BinPlaylistRow[]) {
      playlistMap[row.bin_code] = row.playlist_id;
    }

    // 2. Desired state: every track with a majority-vote bin assignment.
    //    archive_tracks already applies: is_active, podcast exclusion, majority tie-break.
    const { data: archiveRows, error: archiveError } = await supabase
      .from("archive_tracks")
      .select("track_id, bin_code");

    if (archiveError) {
      throw new Error(`Failed to load archive_tracks: ${archiveError.message}`);
    }

    const desired = new Map<string, string>(); // track_id → bin_code
    for (const row of (archiveRows ?? []) as ArchiveTrackRow[]) {
      desired.set(row.track_id, row.bin_code);
    }

    // 3. Current published state
    const { data: publishedRows, error: publishedError } = await supabase
      .from("audius_published_tracks")
      .select("track_id, bin_code");

    if (publishedError) {
      throw new Error(`Failed to load audius_published_tracks: ${publishedError.message}`);
    }

    const published = new Map<string, string>(); // track_id → bin_code
    for (const row of (publishedRows ?? []) as PublishedTrackRow[]) {
      published.set(row.track_id, row.bin_code);
    }

    // 4. Compute diff
    const toRemove: Array<{ trackId: string; binCode: string }> = [];
    const toAdd: Array<{ trackId: string; binCode: string }> = [];
    const toMove: Array<{ trackId: string; oldBinCode: string; newBinCode: string }> = [];

    for (const [trackId, binCode] of desired) {
      const currentBin = published.get(trackId);
      if (currentBin === undefined) {
        toAdd.push({ trackId, binCode });
      } else if (currentBin !== binCode) {
        toMove.push({ trackId, oldBinCode: currentBin, newBinCode: binCode });
      }
    }

    for (const [trackId, binCode] of published) {
      if (!desired.has(trackId)) {
        toRemove.push({ trackId, binCode });
      }
    }

    logEvent("audius_sync_diff", {
      toAdd: toAdd.length,
      toRemove: toRemove.length,
      toMove: toMove.length,
    });

    // 5a. Removals
    for (const { trackId, binCode } of toRemove) {
      const playlistId = playlistMap[binCode];
      if (!playlistId) continue;

      try {
        await audiusSdk.playlists.removeTrackFromPlaylist({ userId, playlistId, trackId });
        await supabase.from("audius_published_tracks").delete().eq("track_id", trackId);
        tracksRemoved++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logEvent("audius_track_remove_fail", { trackId, binCode, error: message });
        failedOps++;
      }
    }

    // 5b. Moves: remove from old playlist, add to new
    for (const { trackId, oldBinCode, newBinCode } of toMove) {
      const oldPlaylistId = playlistMap[oldBinCode];
      const newPlaylistId = playlistMap[newBinCode];
      if (!oldPlaylistId || !newPlaylistId) continue;

      let removeOk = false;
      try {
        await audiusSdk.playlists.removeTrackFromPlaylist({
          userId,
          playlistId: oldPlaylistId,
          trackId,
        });
        removeOk = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logEvent("audius_track_remove_fail", { trackId, binCode: oldBinCode, error: message });
        failedOps++;
      }

      if (removeOk) {
        try {
          await audiusSdk.playlists.addTrackToPlaylist({
            userId,
            playlistId: newPlaylistId,
            trackId,
          });
          await supabase.from("audius_published_tracks").upsert({
            track_id: trackId,
            bin_code: newBinCode,
            published_at: new Date().toISOString(),
          });
          tracksMoved++;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logEvent("audius_track_add_fail", { trackId, binCode: newBinCode, error: message });
          failedOps++;
        }
      }
    }

    // 5c. Additions
    for (const { trackId, binCode } of toAdd) {
      const playlistId = playlistMap[binCode];
      if (!playlistId) continue;

      try {
        await audiusSdk.playlists.addTrackToPlaylist({ userId, playlistId, trackId });
        await supabase.from("audius_published_tracks").upsert({
          track_id: trackId,
          bin_code: binCode,
          published_at: new Date().toISOString(),
        });
        tracksAdded++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logEvent("audius_track_add_fail", { trackId, binCode, error: message });
        failedOps++;
      }
    }

    const healthy = failedOps === 0;
    const finishedAt = new Date().toISOString();

    await supabase.from("audius_sync_runs").insert({
      started_at: startedAt,
      finished_at: finishedAt,
      healthy,
      tracks_added: tracksAdded,
      tracks_removed: tracksRemoved,
      tracks_moved: tracksMoved,
      metadata: {
        failedOps,
        desiredCount: desired.size,
        publishedCount: published.size,
      },
    });

    logEvent("audius_sync_complete", {
      healthy,
      tracksAdded,
      tracksRemoved,
      tracksMoved,
      failedOps,
    });

    return jsonResponse({
      ok: true,
      healthy,
      tracksAdded,
      tracksRemoved,
      tracksMoved,
      failedOps,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "SYNC_FAILED";
    console.error("audius sync error", error);

    await supabase.from("audius_sync_runs").insert({
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      healthy: false,
      tracks_added: tracksAdded,
      tracks_removed: tracksRemoved,
      tracks_moved: tracksMoved,
      error_code: "SYNC_FAILED",
      error_message: errorMessage,
      metadata: { failedOps },
    });

    logEvent("audius_sync_error", { error: errorMessage });
    return errorResponse("SERVER_ERROR", `Sync failed: ${errorMessage}`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return preflightResponse();
  }

  let config;
  try {
    config = getAudiusSyncConfig();
  } catch (error) {
    console.error("audius sync config error", error);
    return errorResponse("SERVER_ERROR", "Missing required configuration.");
  }

  if (!config.audiusSyncEnabled) {
    return errorResponse("SYNC_DISABLED");
  }

  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

  const audiusSdkInstance = sdk({
    appName: "MacroVibe Refinement",
    apiKey: config.audiusApiKey,
    apiSecret: config.audiusApiSecret,
  });

  const url = new URL(req.url);
  const isSetup = url.searchParams.get("setup") === "1";

  try {
    if (isSetup) {
      return await runSetup(supabase, audiusSdkInstance, config.audiusManagedUserId);
    }
    return await runSync(supabase, audiusSdkInstance, config.audiusManagedUserId);
  } catch (error) {
    console.error("unhandled audius sync error", error);
    return errorResponse("SERVER_ERROR");
  }
});
