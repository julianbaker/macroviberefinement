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

function getErrorMessage(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  if (err.message) return err.message;
  return JSON.stringify(err);
}

function valueAsBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return null;
}

function hasGateCondition(value) {
  if (!value) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

function isTrackGatedOrPremium(track) {
  const directSignals = [
    valueAsBoolean(track?.is_stream_gated),
    valueAsBoolean(track?.isStreamGated),
    valueAsBoolean(track?.is_premium),
    valueAsBoolean(track?.isPremium),
    valueAsBoolean(track?.is_download_gated),
    valueAsBoolean(track?.isDownloadGated),
  ];
  if (directSignals.some((signal) => signal === true)) return true;

  return (
    hasGateCondition(track?.stream_conditions) ||
    hasGateCondition(track?.streamConditions) ||
    hasGateCondition(track?.usdc_purchase_conditions) ||
    hasGateCondition(track?.usdcPurchaseConditions)
  );
}

function isAlreadySocialActionError(err) {
  const message = getErrorMessage(err).toLowerCase();
  return (
    message.includes("already") &&
    (message.includes("save") ||
      message.includes("favorite") ||
      message.includes("repost") ||
      message.includes("exists") ||
      message.includes("duplicate"))
  );
}

function isAlreadyFollowError(err) {
  const message = getErrorMessage(err).toLowerCase();
  return message.includes("already") && (message.includes("follow") || message.includes("relationship"));
}

function chunkArray(values, chunkSize = 200) {
  const chunks = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    chunks.push(values.slice(i, i + chunkSize));
  }
  return chunks;
}

async function loadEngagementMap(trackIds) {
  const byTrackId = new Map();
  for (const trackIdChunk of chunkArray(trackIds)) {
    const { data, error } = await supabase
      .from("audius_track_engagements")
      .select("track_id, favorited_at, reposted_at")
      .in("track_id", trackIdChunk);
    if (error) throw new Error(`Failed to load engagement state: ${error.message}`);
    for (const row of data ?? []) {
      byTrackId.set(row.track_id, row);
    }
  }
  return byTrackId;
}

async function ensureTrackEngagement(trackIds) {
  const targetTrackIds = [...new Set(trackIds)].filter(Boolean);
  if (targetTrackIds.length === 0) {
    return { favorited: 0, reposted: 0, failed: 0 };
  }

  const engagementMap = await loadEngagementMap(targetTrackIds);
  let favorited = 0;
  let reposted = 0;
  let failed = 0;

  for (const trackId of targetTrackIds) {
    const engagementRow = engagementMap.get(trackId);
    let favoritedAt = engagementRow?.favorited_at ?? null;
    let repostedAt = engagementRow?.reposted_at ?? null;
    const hadFavoritedAt = Boolean(favoritedAt);
    const hadRepostedAt = Boolean(repostedAt);
    let attemptedSocialAction = false;

    if (!hadFavoritedAt) {
      attemptedSocialAction = true;
      try {
        await withRetry(`favorite:${trackId}`, () =>
          audiusSdk.tracks.favoriteTrack({
            userId: config.audiusManagedUserId,
            trackId,
          })
        );
        favoritedAt = new Date().toISOString();
        favorited++;
        logEvent("audius_track_favorited", { trackId });
      } catch (err) {
        if (isAlreadySocialActionError(err)) {
          favoritedAt = new Date().toISOString();
          logEvent("audius_track_favorite_exists", { trackId, error: getErrorMessage(err) });
        } else {
          logEvent("audius_track_favorite_fail", { trackId, error: getErrorMessage(err) });
          failed++;
        }
      }
    }

    if (!hadRepostedAt) {
      attemptedSocialAction = true;
      try {
        await withRetry(`repost:${trackId}`, () =>
          audiusSdk.tracks.repostTrack({
            userId: config.audiusManagedUserId,
            trackId,
          })
        );
        repostedAt = new Date().toISOString();
        reposted++;
        logEvent("audius_track_reposted", { trackId });
      } catch (err) {
        if (isAlreadySocialActionError(err)) {
          repostedAt = new Date().toISOString();
          logEvent("audius_track_repost_exists", { trackId, error: getErrorMessage(err) });
        } else {
          logEvent("audius_track_repost_fail", { trackId, error: getErrorMessage(err) });
          failed++;
        }
      }
    }

    if ((favoritedAt && !hadFavoritedAt) || (repostedAt && !hadRepostedAt)) {
      const { error: engagementUpsertError } = await supabase.from("audius_track_engagements").upsert({
        track_id: trackId,
        favorited_at: favoritedAt,
        reposted_at: repostedAt,
      });
      if (engagementUpsertError) {
        logEvent("audius_track_engagement_upsert_fail", { trackId, error: engagementUpsertError.message });
        failed++;
      }
    }

    if (attemptedSocialAction) {
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  return { favorited, reposted, failed };
}

function extractTrackArtistUserId(track) {
  if (!track || typeof track !== "object") return null;
  const direct = track.user_id ?? track.owner_id ?? track.userId ?? track.ownerId;
  if (direct !== undefined && direct !== null && direct !== "") return String(direct);
  const nestedUser = track.user;
  if (nestedUser && typeof nestedUser === "object") {
    const nestedId = nestedUser.id ?? nestedUser.user_id ?? nestedUser.userId;
    if (nestedId !== undefined && nestedId !== null && nestedId !== "") return String(nestedId);
  }
  return null;
}

async function loadFollowMap(artistUserIds) {
  const followedArtistIds = new Set();
  for (const artistChunk of chunkArray(artistUserIds)) {
    const { data, error } = await supabase
      .from("audius_followed_artists")
      .select("artist_user_id")
      .in("artist_user_id", artistChunk);
    if (error) throw new Error(`Failed to load followed artists: ${error.message}`);
    for (const row of data ?? []) {
      followedArtistIds.add(row.artist_user_id);
    }
  }
  return followedArtistIds;
}

async function fetchTrackSnapshot(trackId) {
  const resp = await fetch(
    `https://api.audius.co/v1/tracks/${encodeURIComponent(trackId)}?app_name=MacroVibe+Refinement`,
    { headers: { "X-API-KEY": config.audiusApiKey } }
  );
  if (resp.status === 404) return { status: "missing" };
  if (!resp.ok) return { status: "error", error: `HTTP ${resp.status}` };
  const json = await resp.json();
  const track = json?.data;
  if (!track) return { status: "error", error: "Missing data payload" };
  if (isTrackGatedOrPremium(track)) {
    return { status: "ineligible", reason: "gated_or_premium" };
  }
  if (track.is_delete || track.is_unlisted || track.is_available === false) {
    return {
      status: "ineligible",
      reason: track.is_delete ? "is_delete" : track.is_unlisted ? "is_unlisted" : "unavailable",
    };
  }
  return { status: "ok", track };
}

async function resolveTrackArtistUserId(trackId, trackArtistMap) {
  const cached = trackArtistMap.get(trackId);
  if (cached) return cached;
  try {
    const snapshot = await fetchTrackSnapshot(trackId);
    if (snapshot.status !== "ok") return null;
    const artistUserId = extractTrackArtistUserId(snapshot.track);
    if (artistUserId) {
      trackArtistMap.set(trackId, artistUserId);
      return artistUserId;
    }
  } catch (err) {
    logEvent("audius_track_artist_lookup_fail", { trackId, error: getErrorMessage(err) });
  }
  return null;
}

async function ensureArtistFollows(trackIds, trackArtistMap) {
  const targetTrackIds = [...new Set(trackIds)].filter(Boolean);
  if (targetTrackIds.length === 0) {
    return { artistsFollowed: 0, failed: 0, uniqueArtists: 0, unresolvedTracks: 0 };
  }

  const artistUserIds = new Set();
  let unresolvedTracks = 0;
  for (const trackId of targetTrackIds) {
    const artistUserId = await resolveTrackArtistUserId(trackId, trackArtistMap);
    if (!artistUserId) {
      unresolvedTracks++;
      logEvent("audius_track_artist_missing", { trackId });
      continue;
    }
    if (artistUserId === config.audiusManagedUserId) continue;
    artistUserIds.add(artistUserId);
  }

  if (artistUserIds.size === 0) {
    return { artistsFollowed: 0, failed: 0, uniqueArtists: 0, unresolvedTracks };
  }

  const followedArtistIds = await loadFollowMap([...artistUserIds]);
  let artistsFollowed = 0;
  let failed = 0;

  for (const artistUserId of artistUserIds) {
    if (followedArtistIds.has(artistUserId)) continue;

    let attemptedFollow = false;
    let followedAt = null;

    try {
      attemptedFollow = true;
      await withRetry(`follow:${artistUserId}`, () =>
        audiusSdk.users.followUser({
          userId: config.audiusManagedUserId,
          followeeUserId: artistUserId,
        })
      );
      followedAt = new Date().toISOString();
      artistsFollowed++;
      logEvent("audius_artist_followed", { artistUserId });
    } catch (err) {
      if (isAlreadyFollowError(err)) {
        followedAt = new Date().toISOString();
        logEvent("audius_artist_follow_exists", { artistUserId, error: getErrorMessage(err) });
      } else {
        logEvent("audius_artist_follow_fail", { artistUserId, error: getErrorMessage(err) });
        failed++;
      }
    }

    if (followedAt) {
      const { error: followUpsertError } = await supabase.from("audius_followed_artists").upsert({
        artist_user_id: artistUserId,
        followed_at: followedAt,
      });
      if (followUpsertError) {
        logEvent("audius_artist_follow_upsert_fail", { artistUserId, error: followUpsertError.message });
        failed++;
      } else {
        followedArtistIds.add(artistUserId);
      }
    }

    if (attemptedFollow) {
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  return { artistsFollowed, failed, uniqueArtists: artistUserIds.size, unresolvedTracks };
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
  let tracksFavorited = 0;
  let tracksReposted = 0;
  let artistsFollowed = 0;
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
    const publishedFinal = new Map(published);
    const trackArtistMap = new Map();

    // Evict tracks that are no longer eligible on Audius (deleted/unlisted/unavailable/gated).
    // Check both desired AND published tracks:
    //   - published: catch tracks already in playlists that were deleted after being added
    //   - desired:   catch tracks deleted on Audius before they've been published, so we
    //                don't try to re-add them and instead deactivate them in Supabase
    // Uses the REST API directly; the SDK (initialised with write credentials) rejects read calls.
    // Requests are sequential with a small delay to avoid 429 rate-limiting from api.audius.co.
    const allTrackIds = new Set([...desired.keys(), ...published.keys()]);
    const ineligibleOnAudius = new Map();
    const gatedOnAudius = new Set();

    for (const trackId of allTrackIds) {
      try {
        const snapshot = await fetchTrackSnapshot(trackId);
        if (snapshot.status === "missing") {
          ineligibleOnAudius.set(trackId, "404");
          logEvent("audius_track_ineligible_on_platform", { trackId, reason: "404" });
        } else if (snapshot.status === "ineligible") {
          ineligibleOnAudius.set(trackId, snapshot.reason ?? "ineligible");
          if (snapshot.reason === "gated_or_premium") {
            gatedOnAudius.add(trackId);
          }
          logEvent("audius_track_ineligible_on_platform", {
            trackId,
            reason: snapshot.reason ?? "ineligible",
          });
        } else if (snapshot.status === "ok") {
          const artistUserId = extractTrackArtistUserId(snapshot.track);
          if (artistUserId) {
            trackArtistMap.set(trackId, artistUserId);
          }
        } else {
          // Transient error (e.g. 429, 5xx) — log but don't assume deleted
          logEvent("audius_track_status_unknown", { trackId, error: snapshot.error ?? "unknown" });
        }
      } catch (err) {
        logEvent("audius_track_status_unknown", { trackId, error: err.message });
      }
      // 150 ms pause keeps us well under the rate limit across 100+ tracks
      await new Promise((r) => setTimeout(r, 150));
    }

    // Pull ineligible tracks out of desired so the diff sends them to toRemove.
    for (const trackId of ineligibleOnAudius.keys()) {
      desired.delete(trackId);
    }

    // Deactivate ineligible tracks in Supabase so they stop being served for refinement.
    if (ineligibleOnAudius.size > 0) {
      const ineligibleTrackIds = [...ineligibleOnAudius.keys()];
      const { error: deactivateError } = await supabase
        .from("track_pool")
        .update({ is_active: false })
        .in("track_id", ineligibleTrackIds);
      if (deactivateError) {
        logEvent("audius_deactivate_fail", { error: deactivateError.message, count: ineligibleTrackIds.length });
      } else {
        logEvent("audius_tracks_deactivated", { count: ineligibleTrackIds.length });
      }
    }

    // Persist explicit gated state for premium/stream-gated tracks.
    if (gatedOnAudius.size > 0) {
      const gatedTrackIds = [...gatedOnAudius];
      const { error: gatedFlagError } = await supabase
        .from("track_pool")
        .update({ is_gated: true, is_active: false })
        .in("track_id", gatedTrackIds);
      if (gatedFlagError) {
        logEvent("audius_gated_flag_update_fail", { error: gatedFlagError.message, count: gatedTrackIds.length });
      } else {
        logEvent("audius_gated_flag_updated", { count: gatedTrackIds.length });
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

    // Evictions (removals + move-froms) — grouped by playlist and applied via updatePlaylist.
    // removeTrackFromPlaylist requires a positional trackIndex which is fragile and broken for
    // deleted tracks (which don't appear in the /tracks API response). updatePlaylist with a
    // full playlistContents array is atomic, handles duplicates, and works for deleted tracks
    // because we read playlist_contents from the playlist object (not the filtered /tracks endpoint).
    const evictByBin = new Map(); // binCode -> Set<trackId>
    for (const { trackId, binCode } of toRemove) {
      (evictByBin.get(binCode) ?? evictByBin.set(binCode, new Set()).get(binCode)).add(trackId);
    }
    for (const { trackId, oldBinCode } of toMove) {
      (evictByBin.get(oldBinCode) ?? evictByBin.set(oldBinCode, new Set()).get(oldBinCode)).add(trackId);
    }

    const successfullyEvicted = new Set(); // trackIds confirmed evicted on Audius

    for (const [binCode, trackIds] of evictByBin) {
      const playlistId = playlistMap[binCode];
      if (!playlistId) continue;
      try {
        // Fetch raw playlist_contents — includes deleted tracks invisible to /tracks endpoint
        const resp = await fetch(
          `https://api.audius.co/v1/playlists/${playlistId}?app_name=MacroVibe+Refinement`,
          { headers: { "X-API-KEY": config.audiusApiKey } }
        );
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching playlist ${playlistId}`);
        const json = await resp.json();
        const rawContents = json?.data?.[0]?.playlist_contents ?? [];

        // Filter out all occurrences of the tracks being evicted
        const newContents = rawContents
          .filter((e) => !trackIds.has(e.track_id))
          .map((e) => ({ timestamp: e.timestamp, trackId: e.track_id }));

        await withRetry(`updatePlaylist:${binCode}`, () =>
          audiusSdk.playlists.updatePlaylist({
            userId: config.audiusManagedUserId,
            playlistId,
            metadata: { playlistContents: newContents },
          })
        );

        for (const trackId of trackIds) successfullyEvicted.add(trackId);
        logEvent("audius_playlist_evicted", { binCode, count: trackIds.size, newSize: newContents.length });
      } catch (err) {
        logEvent("audius_playlist_evict_fail", { binCode, error: err.message });
        failedOps += trackIds.size;
      }
    }

    // Update Supabase for pure removals that succeeded on Audius
    for (const { trackId, binCode } of toRemove) {
      if (successfullyEvicted.has(trackId)) {
        await supabase.from("audius_published_tracks").delete().eq("track_id", trackId);
        publishedFinal.delete(trackId);
        tracksRemoved++;
      }
    }

    // Moves-in: add to new playlist for tracks that were successfully evicted from the old one
    for (const { trackId, oldBinCode, newBinCode } of toMove) {
      if (!successfullyEvicted.has(trackId)) {
        logEvent("audius_track_move_skip", { trackId, reason: "eviction_failed", oldBinCode, newBinCode });
        failedOps++;
        continue;
      }
      const newPlaylistId = playlistMap[newBinCode];
      if (!newPlaylistId) continue;
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
        publishedFinal.set(trackId, newBinCode);
        tracksMoved++;
      } catch (err) {
        // Eviction succeeded but add failed — clear published record so next run retries the add
        await supabase.from("audius_published_tracks").delete().eq("track_id", trackId);
        publishedFinal.delete(trackId);
        logEvent("audius_track_add_fail", { trackId, binCode: newBinCode, error: err.message });
        failedOps++;
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
        publishedFinal.set(trackId, binCode);
        tracksAdded++;
      } catch (err) {
        logEvent("audius_track_add_fail", { trackId, binCode, error: err.message });
        failedOps++;
      }
    }

    // Ensure managed account favorites + reposts every track currently in managed playlists.
    const engagement = await ensureTrackEngagement([...publishedFinal.keys()]);
    tracksFavorited = engagement.favorited;
    tracksReposted = engagement.reposted;
    failedOps += engagement.failed;

    // Ensure managed account follows artists for tracks currently in managed playlists.
    const followSync = await ensureArtistFollows([...publishedFinal.keys()], trackArtistMap);
    artistsFollowed = followSync.artistsFollowed;
    failedOps += followSync.failed;

    const healthy = failedOps === 0;

    await supabase.from("audius_sync_runs").insert({
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      healthy,
      tracks_added: tracksAdded,
      tracks_removed: tracksRemoved,
      tracks_moved: tracksMoved,
      metadata: {
        failedOps,
        desiredCount: desired.size,
        publishedCount: published.size,
        publishedFinalCount: publishedFinal.size,
        tracksFavorited,
        tracksReposted,
        artistsFollowed,
        followCandidates: followSync.uniqueArtists,
        unresolvedArtistTracks: followSync.unresolvedTracks,
        ineligibleOnAudius: ineligibleOnAudius.size,
        gatedOnAudius: gatedOnAudius.size,
      },
    });

    logEvent("audius_sync_complete", {
      healthy,
      tracksAdded,
      tracksRemoved,
      tracksMoved,
      tracksFavorited,
      tracksReposted,
      artistsFollowed,
      failedOps,
    });

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
      metadata: { failedOps, tracksFavorited, tracksReposted, artistsFollowed },
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
