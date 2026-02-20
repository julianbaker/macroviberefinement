import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

import { getRuntimeConfig } from "../_shared/env.ts";
import { errorResponse, jsonResponse, preflightResponse } from "../_shared/http.ts";

type JsonObject = Record<string, unknown>;

type SnapshotEntry = {
  playlist_id: string;
  playlist_name: string;
  track_id: string;
};

type TrackRow = {
  track_id: string;
  title: string | null;
  artist_name: string | null;
  artwork_url: string | null;
  duration_sec: number | null;
};

function logEvent(name: string, payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: name, ...payload }));
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

function unwrapAudiusData(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  const obj = value as JsonObject;
  if ("data" in obj) {
    return obj.data;
  }
  return value;
}

async function fetchAudiusJson(
  baseUrl: string,
  path: string,
  params?: URLSearchParams,
): Promise<unknown> {
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const url = new URL(normalizedPath, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (params) {
    url.search = params.toString();
  }

  const response = await fetch(url.toString(), {
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`AUDIUS_HTTP_${response.status}`);
  }

  const json = await response.json();
  return unwrapAudiusData(json);
}

async function fetchFirstSuccessful(
  baseUrl: string,
  attempts: Array<{ path: string; params?: URLSearchParams }>,
): Promise<unknown> {
  let lastError: unknown = null;

  for (const attempt of attempts) {
    try {
      return await fetchAudiusJson(baseUrl, attempt.path, attempt.params);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("AUDIUS_REQUEST_FAILED");
}

function valueAsString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function valueAsInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }
  return null;
}

function isAudiusStatus(error: unknown, statusCode: number): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.startsWith(`AUDIUS_HTTP_${statusCode}`);
}

function trackIdFromUnknown(track: unknown): string | null {
  if (typeof track === "string" || typeof track === "number") {
    return valueAsString(track);
  }

  if (!track || typeof track !== "object") {
    return null;
  }

  const trackObj = track as JsonObject;
  return valueAsString(trackObj.id ?? trackObj.track_id);
}

function parseTrackRow(track: unknown): TrackRow | null {
  if (!track || typeof track !== "object") {
    return null;
  }

  const trackObj = track as JsonObject;
  const trackId = valueAsString(trackObj.id ?? trackObj.track_id);
  if (!trackId) {
    return null;
  }

  const user = (trackObj.user && typeof trackObj.user === "object")
    ? (trackObj.user as JsonObject)
    : null;

  let artworkUrl: string | null = null;
  if (trackObj.artwork && typeof trackObj.artwork === "object") {
    const artworkObj = trackObj.artwork as JsonObject;
    artworkUrl =
      valueAsString(artworkObj["150x150"]) ??
      valueAsString(artworkObj["480x480"]) ??
      valueAsString(artworkObj["1000x1000"]);
  }

  return {
    track_id: trackId,
    title: valueAsString(trackObj.title),
    artist_name:
      valueAsString(trackObj.artist_name) ??
      valueAsString(trackObj.user_name) ??
      valueAsString(user?.name) ??
      valueAsString(user?.handle),
    artwork_url: artworkUrl,
    duration_sec: valueAsInteger(trackObj.duration),
  };
}

async function resolveSourceUserId(baseUrl: string, sourceHandle: string): Promise<string | null> {
  const data = await fetchFirstSuccessful(baseUrl, [
    { path: `users/handle/${encodeURIComponent(sourceHandle)}` },
    { path: `full/users/handle/${encodeURIComponent(sourceHandle)}` },
  ]);

  const candidates = asArray(data).length > 0 ? asArray(data) : [data];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const userObj = candidate as JsonObject;
    const id = valueAsString(userObj.id ?? userObj.user_id);
    if (id) {
      return id;
    }
  }

  return null;
}

async function fetchPlaylistsPage(
  baseUrl: string,
  userId: string,
  limit: number,
  offset: number,
): Promise<unknown[]> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });

  const data = await fetchFirstSuccessful(baseUrl, [
    { path: `users/${encodeURIComponent(userId)}/playlists`, params },
    { path: `full/users/${encodeURIComponent(userId)}/playlists`, params },
  ]);

  return asArray(data);
}

async function fetchTracksByIds(baseUrl: string, trackIds: string[]): Promise<TrackRow[]> {
  if (trackIds.length === 0) {
    return [];
  }

  const params = new URLSearchParams();
  params.set("limit", String(trackIds.length));
  for (const trackId of trackIds) {
    params.append("id", trackId);
  }

  let lastError: unknown = null;
  for (const path of ["tracks", "full/tracks"]) {
    try {
      const data = await fetchAudiusJson(baseUrl, path, params);
      const items = asArray(data).length > 0 ? asArray(data) : [data];
      return items
        .map((track) => parseTrackRow(track))
        .filter((track): track is TrackRow => track !== null);
    } catch (error) {
      lastError = error;
    }
  }

  if (
    isAudiusStatus(lastError, 403) ||
    isAudiusStatus(lastError, 404) ||
    isAudiusStatus(lastError, 429)
  ) {
    return [];
  }
  throw lastError;
}

function parsePlaylistMeta(playlist: unknown): { playlistId: string | null; playlistName: string | null; tracks: unknown[] } {
  if (!playlist || typeof playlist !== "object") {
    return { playlistId: null, playlistName: null, tracks: [] };
  }

  const playlistObj = playlist as JsonObject;
  const playlistId = valueAsString(playlistObj.id ?? playlistObj.playlist_id);
  const playlistName =
    valueAsString(playlistObj.playlist_name) ??
    valueAsString(playlistObj.playlist_title) ??
    valueAsString(playlistObj.title) ??
    valueAsString(playlistObj.name) ??
    "Untitled Playlist";

  const tracks = [
    ...asArray(playlistObj.tracks),
    ...asArray(playlistObj.playlist_contents),
    ...asArray(playlistObj.added_timestamps),
    ...asArray(playlistObj.track_ids),
  ];

  return { playlistId, playlistName, tracks };
}

async function runIngest(): Promise<Response> {
  const config = getRuntimeConfig();
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

  const startedAt = new Date().toISOString();
  const sourceHandle = config.audiusSourceHandle;

  let sourceResolved = false;
  let paginationComplete = false;
  let playlistCount = 0;

  const snapshotMap = new Map<string, SnapshotEntry>();
  const trackMap = new Map<string, TrackRow>();

  try {
    const userId = await resolveSourceUserId(config.audiusApiBaseUrl, sourceHandle);
    sourceResolved = Boolean(userId);
    if (!userId) {
      throw new Error("SOURCE_NOT_FOUND");
    }

    const pageSize = 100;
    let offset = 0;

    for (;;) {
      const playlists = await fetchPlaylistsPage(config.audiusApiBaseUrl, userId, pageSize, offset);
      if (playlists.length === 0) {
        paginationComplete = true;
        break;
      }

      playlistCount += playlists.length;
      offset += pageSize;

      for (const playlist of playlists) {
        const { playlistId, playlistName, tracks } = parsePlaylistMeta(playlist);
        if (!playlistId) {
          continue;
        }

        for (const track of tracks) {
          const trackId = trackIdFromUnknown(track);
          if (!trackId) {
            continue;
          }

          const key = `${playlistId}:${trackId}`;
          snapshotMap.set(key, {
            playlist_id: playlistId,
            playlist_name: playlistName ?? "Untitled Playlist",
            track_id: trackId,
          });

          const maybeTrack = parseTrackRow(track);
          if (maybeTrack) {
            trackMap.set(maybeTrack.track_id, maybeTrack);
          }
        }
      }
    }

    const missingMetadataIds = Array.from(
      new Set(Array.from(snapshotMap.values()).map((entry) => entry.track_id)),
    ).filter((trackId) => !trackMap.has(trackId));

    const batchSize = 50;
    for (let index = 0; index < missingMetadataIds.length; index += batchSize) {
      const batch = missingMetadataIds.slice(index, index + batchSize);
      const tracks = await fetchTracksByIds(config.audiusApiBaseUrl, batch);
      for (const track of tracks) {
        trackMap.set(track.track_id, track);
      }
    }

    const snapshotEntries = Array.from(snapshotMap.values());
    const trackRows = Array.from(trackMap.values());

    const healthy =
      sourceResolved &&
      paginationComplete &&
      playlistCount >= config.minPlaylistsFloor;

    const applyResult = await supabase.rpc("api_v1_apply_allowlist_snapshot", {
      p_source_owner_handle: sourceHandle,
      p_snapshot_entries: snapshotEntries,
      p_track_rows: trackRows,
      p_missing_run_threshold: config.missingRunThreshold,
      p_run_healthy: healthy,
    });

    if (applyResult.error) {
      throw applyResult.error;
    }

    const applyRow = applyResult.data?.[0] as
      | { applied_snapshot: boolean; upserted_tracks: number; deactivated_tracks: number }
      | undefined;

    const appliedSnapshot = applyRow?.applied_snapshot ?? false;
    const upsertedTracks = applyRow?.upserted_tracks ?? 0;
    const deactivatedTracks = applyRow?.deactivated_tracks ?? 0;

    await supabase.from("ingest_runs").insert({
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      source_owner_handle: sourceHandle,
      healthy,
      source_resolved: sourceResolved,
      pagination_complete: paginationComplete,
      playlist_count: playlistCount,
      track_count: trackRows.length,
      applied_snapshot: appliedSnapshot,
      metadata: {
        snapshotRows: snapshotEntries.length,
        upsertedTracks,
        deactivatedTracks,
      },
    });

    logEvent("ingest_run_summary", {
      sourceHandle,
      healthy,
      playlistCount,
      trackCount: trackRows.length,
      appliedSnapshot,
      upsertedTracks,
      deactivatedTracks,
    });

    return jsonResponse({
      ok: true,
      sourceHandle,
      healthy,
      sourceResolved,
      paginationComplete,
      playlistCount,
      trackCount: trackRows.length,
      appliedSnapshot,
      upsertedTracks,
      deactivatedTracks,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "INGEST_FAILED";
    console.error("ingest error", error);

    await supabase.from("ingest_runs").insert({
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      source_owner_handle: sourceHandle,
      healthy: false,
      source_resolved: sourceResolved,
      pagination_complete: paginationComplete,
      playlist_count: playlistCount,
      track_count: trackMap.size,
      applied_snapshot: false,
      error_code: "INGEST_FAILED",
      error_message: errorMessage,
      metadata: {
        safeMode: true,
      },
    });

    logEvent("ingest_run_error", {
      sourceHandle,
      error: errorMessage,
      sourceResolved,
      paginationComplete,
      playlistCount,
    });

    return errorResponse("SERVER_ERROR", `Ingest run failed: ${errorMessage}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return preflightResponse();
  }

  if (req.method !== "POST" && req.method !== "GET") {
    return errorResponse("BAD_REQUEST", "Method not allowed.");
  }

  return await runIngest();
});
