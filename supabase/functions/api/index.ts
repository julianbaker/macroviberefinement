import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

import { getRuntimeConfig, RuntimeConfig } from "../_shared/env.ts";
import { ErrorCode } from "../_shared/errors.ts";
import { hmacSha256Hex } from "../_shared/hash.ts";
import { errorResponse, jsonResponse, preflightResponse } from "../_shared/http.ts";
import { resolveSessionToken } from "../_shared/token.ts";

type InitRow = {
  track_id: string;
  artwork_url: string | null;
  seed: string;
  session_size: number;
  degraded: boolean;
};

type ReplaceTrackRow = {
  track_id: string;
  artwork_url: string | null;
  seed: string;
};

type PlacementRow = {
  status: string;
  error_code: string | null;
};

type ArchiveBinRow = {
  code_name: string;
  display_name: string;
  sort_order: number;
  track_count: number;
};

type ArchiveTrackRow = {
  track_id: string;
  title: string | null;
  artist_name: string | null;
  artwork_url: string | null;
  current_count: number;
  assigned_at: string;
};

type PlacementBody = {
  sessionToken?: unknown;
  trackId?: unknown;
  binCode?: unknown;
  clientTs?: unknown;
  latencyMs?: unknown;
};

type ResultsRow = {
  track_id: string;
  consensus_bin_code: string | null;
};

function logEvent(name: string, payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: name, ...payload }));
}

function buildStreamUrl(audiusApiBaseUrl: string, trackId: string): string {
  const normalized = audiusApiBaseUrl.endsWith("/")
    ? audiusApiBaseUrl.slice(0, -1)
    : audiusApiBaseUrl;
  return `${normalized}/tracks/${encodeURIComponent(trackId)}/stream`;
}

function extractApiPath(pathname: string): string {
  const marker = "/api/v1";
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex === -1) {
    return pathname;
  }
  return pathname.slice(markerIndex);
}

function httpStatusForPlacementError(code: string): ErrorCode {
  switch (code) {
    case "INVALID_BIN":
      return "INVALID_BIN";
    case "INVALID_TRACK":
      return "INVALID_TRACK";
    case "DUPLICATE_PLACEMENT":
      return "DUPLICATE_PLACEMENT";
    case "TOO_FAST":
      return "TOO_FAST";
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    default:
      return "SERVER_ERROR";
  }
}

function parseDevice(device: string | null): "desktop" | "mobile" | null {
  if (device === "desktop" || device === "mobile") {
    return device;
  }
  return null;
}

function isResetRequested(reset: string | null): boolean {
  return reset === "1";
}

function mintSessionToken(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function readClientIp(req: Request): string {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }
  const cfConnectingIp = req.headers.get("cf-connecting-ip");
  return cfConnectingIp?.trim() || "unknown";
}

function readUserAgent(req: Request): string {
  return req.headers.get("user-agent")?.trim() || "unknown";
}

async function handleSessionInit(
  req: Request,
  config: RuntimeConfig,
  supabase: ReturnType<typeof createClient>,
): Promise<Response> {
  const url = new URL(req.url);
  const device = parseDevice(url.searchParams.get("device"));
  if (!device) {
    return errorResponse("BAD_REQUEST", "Query parameter device must be desktop or mobile.");
  }

  const reset = isResetRequested(url.searchParams.get("reset"));
  const headerToken = req.headers.get("x-session-token")?.trim() || null;

  const targetSize = device === "desktop" ? 64 : 30;
  const floorSize = device === "desktop" ? 24 : 12;
  let sessionToken = !reset && headerToken ? headerToken : mintSessionToken();

  let rpcResult = await supabase.rpc("api_v1_init_session_batch", {
    p_session_token: sessionToken,
    p_device: device,
    p_target_size: targetSize,
    p_floor_size: floorSize,
    p_source_owner_handle: config.audiusSourceHandle,
  });

  if (
    rpcResult.error &&
    (rpcResult.error.message.includes("duplicate key") ||
      rpcResult.error.message.includes("already exists")) &&
    (!headerToken || reset)
  ) {
    sessionToken = mintSessionToken();
    rpcResult = await supabase.rpc("api_v1_init_session_batch", {
      p_session_token: sessionToken,
      p_device: device,
      p_target_size: targetSize,
      p_floor_size: floorSize,
      p_source_owner_handle: config.audiusSourceHandle,
    });
  }

  if (rpcResult.error) {
    if (rpcResult.error.message.includes("INSUFFICIENT_POOL")) {
      logEvent("session_init_error", {
        code: "INSUFFICIENT_POOL",
        device,
      });
      return errorResponse("INSUFFICIENT_POOL");
    }

    console.error("session init rpc error", rpcResult.error);
    logEvent("session_init_error", { code: "SERVER_ERROR", device });
    return errorResponse("SERVER_ERROR");
  }

  const rows = (rpcResult.data ?? []) as InitRow[];
  const sessionSize = rows[0]?.session_size ?? rows.length;
  const degraded = rows[0]?.degraded ?? false;

  logEvent("session_init_success", {
    device,
    sessionSize,
    degraded,
  });

  return jsonResponse({
    sessionToken,
    sessionSize,
    degraded,
    tracks: rows.map((row) => ({
      trackId: row.track_id,
      streamUrl: buildStreamUrl(config.audiusApiBaseUrl, row.track_id),
      artworkUrl: row.artwork_url,
      seed: row.seed,
    })),
  });
}

async function handleSessionReplaceTrack(
  req: Request,
  config: RuntimeConfig,
  supabase: ReturnType<typeof createClient>,
): Promise<Response> {
  const tokenResolution = await resolveSessionToken(req);
  if (!tokenResolution.ok) {
    return errorResponse(tokenResolution.code, tokenResolution.message);
  }
  const sessionToken = tokenResolution.sessionToken;

  const url = new URL(req.url);
  const positionParam = url.searchParams.get("position");
  // Reject floats and other non-integer strings; parseInt("3.5", 10) => 3 would otherwise be accepted
  const position =
    positionParam !== null && /^\d+$/.test(positionParam)
      ? parseInt(positionParam, 10)
      : NaN;
  if (Number.isNaN(position) || position < 0) {
    return errorResponse("BAD_REQUEST", "Query parameter position must be a non-negative integer.");
  }

  const excludeParam = url.searchParams.get("exclude");
  const excludeTrackIds: string[] =
    excludeParam !== null && excludeParam !== ""
      ? excludeParam.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

  const rpcResult = await supabase.rpc("api_v1_session_replace_track", {
    p_session_token: sessionToken,
    p_position: position,
    p_exclude_track_ids: excludeTrackIds,
  });

  if (rpcResult.error) {
    if (rpcResult.error.message.includes("SESSION_NOT_FOUND")) {
      return errorResponse("BAD_REQUEST", "Session not found.");
    }
    if (rpcResult.error.message.includes("NO_REPLACEMENT_AVAILABLE")) {
      return errorResponse("NO_REPLACEMENT_AVAILABLE", "No replacement track available.");
    }
    if (rpcResult.error.message.includes("INVALID_POSITION")) {
      return errorResponse("BAD_REQUEST", "Invalid position.");
    }
    console.error("session replace track rpc error", rpcResult.error);
    return errorResponse("SERVER_ERROR");
  }

  const rows = (rpcResult.data ?? []) as ReplaceTrackRow[];
  const row = rows[0];
  if (!row) {
    return errorResponse("SERVER_ERROR");
  }

  return jsonResponse({
    trackId: row.track_id,
    streamUrl: buildStreamUrl(config.audiusApiBaseUrl, row.track_id),
    artworkUrl: row.artwork_url,
    seed: row.seed,
  });
}

async function handlePlacements(
  req: Request,
  config: RuntimeConfig,
  supabase: ReturnType<typeof createClient>,
): Promise<Response> {
  let payload: PlacementBody;
  try {
    payload = (await req.json()) as PlacementBody;
  } catch {
    return errorResponse("BAD_REQUEST", "Request body must be valid JSON.");
  }

  const trackId = typeof payload.trackId === "string" ? payload.trackId.trim() : "";
  const binCode = typeof payload.binCode === "string" ? payload.binCode.trim() : "";
  const clientTsPresent = payload.clientTs !== undefined && payload.clientTs !== null;

  if (!trackId || !binCode || !clientTsPresent) {
    return errorResponse(
      "BAD_REQUEST",
      "trackId, binCode, and clientTs are required.",
    );
  }

  if (
    payload.latencyMs !== undefined &&
    (typeof payload.latencyMs !== "number" || !Number.isFinite(payload.latencyMs) || payload.latencyMs < 0)
  ) {
    return errorResponse("BAD_REQUEST", "latencyMs must be a non-negative number when provided.");
  }

  const tokenResolution = resolveSessionToken(
    req.headers.get("x-session-token"),
    payload.sessionToken,
  );

  if (!tokenResolution.ok) {
    return errorResponse(tokenResolution.code, tokenResolution.message);
  }

  const resolvedSessionToken = tokenResolution.token;
  if (!resolvedSessionToken) {
    return errorResponse("BAD_REQUEST", "sessionToken is required (header or body)." );
  }

  if (!config.placementsEnabled) {
    return errorResponse("PLACEMENTS_DISABLED");
  }

  const ipHash = await hmacSha256Hex(config.requestHashSecret, readClientIp(req));
  const uaHash = await hmacSha256Hex(config.requestHashSecret, readUserAgent(req));

  const rpcResult = await supabase.rpc("api_v1_submit_placement", {
    p_session_token: resolvedSessionToken,
    p_track_id: trackId,
    p_bin_code: binCode.toUpperCase(),
    p_ip_hash: ipHash,
    p_ua_hash: uaHash,
    p_latency_ms: typeof payload.latencyMs === "number" ? Math.round(payload.latencyMs) : null,
    p_rate_limit_session_per_min: config.rateLimitSessionPerMin,
    p_rate_limit_ip_per_min: config.rateLimitIpPerMin,
    p_rate_limit_min_interval_ms: config.rateLimitMinIntervalMs,
    p_source_owner_handle: config.audiusSourceHandle,
  });

  if (rpcResult.error) {
    console.error("placement rpc error", rpcResult.error);
    return errorResponse("SERVER_ERROR");
  }

  const row = (rpcResult.data?.[0] ?? null) as PlacementRow | null;
  if (!row) {
    return errorResponse("SERVER_ERROR");
  }

  if (row.status === "accepted") {
    logEvent("placement_accept", {
      sessionToken: resolvedSessionToken,
      trackId,
      binCode: binCode.toUpperCase(),
    });

    return jsonResponse({ ok: true });
  }

  const errorCode = row.error_code ? httpStatusForPlacementError(row.error_code) : "SERVER_ERROR";
  if (errorCode === "TOO_FAST" || errorCode === "RATE_LIMITED") {
    logEvent("rate_limit_triggered", {
      sessionToken: resolvedSessionToken,
      trackId,
      errorCode,
    });
  }

  logEvent("placement_reject", {
    sessionToken: resolvedSessionToken,
    trackId,
    errorCode,
  });

  return errorResponse(errorCode);
}

async function handleSessionResults(
  req: Request,
  supabase: ReturnType<typeof createClient>,
): Promise<Response> {
  const url = new URL(req.url);
  const sessionToken =
    req.headers.get("x-session-token")?.trim() ||
    url.searchParams.get("session_token")?.trim() ||
    null;

  if (!sessionToken) {
    return errorResponse("BAD_REQUEST", "session_token is required (header X-Session-Token or query param).");
  }

  const { data, error } = await supabase.rpc("api_v1_session_results", {
    p_session_token: sessionToken,
  });

  if (error) {
    console.error("session results rpc error", error);
    return errorResponse("SERVER_ERROR");
  }

  const rows = (data ?? []) as ResultsRow[];

  return jsonResponse({
    tracks: rows.map((row) => ({
      trackId: row.track_id,
      consensusBin: row.consensus_bin_code,
    })),
  });
}

async function handleArchiveBins(
  config: RuntimeConfig,
  supabase: ReturnType<typeof createClient>,
): Promise<Response> {
  const { data, error } = await supabase
    .from("archive_bin_counts")
    .select("code_name, display_name, sort_order, track_count")
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("archive bins error", error);
    return errorResponse("SERVER_ERROR");
  }

  const rows = (data ?? []) as ArchiveBinRow[];
  return jsonResponse({
    bins: rows.map((row) => ({
      binCode: row.code_name,
      displayName: row.display_name,
      sortOrder: row.sort_order,
      trackCount: row.track_count,
    })),
  });
}

async function handleArchiveBinDetail(
  binCodeRaw: string,
  config: RuntimeConfig,
  supabase: ReturnType<typeof createClient>,
): Promise<Response> {
  const binCode = decodeURIComponent(binCodeRaw).trim().toUpperCase();
  if (!binCode) {
    return errorResponse("BAD_REQUEST", "binCode path parameter is required.");
  }

  const { data: binData, error: binError } = await supabase
    .from("bins")
    .select("code_name")
    .eq("code_name", binCode)
    .eq("is_active", true)
    .maybeSingle();

  if (binError) {
    console.error("archive bin lookup error", binError);
    return errorResponse("SERVER_ERROR");
  }

  if (!binData) {
    return errorResponse("INVALID_BIN");
  }

  const { data, error } = await supabase
    .from("archive_tracks")
    .select("track_id, title, artist_name, artwork_url, current_count, assigned_at")
    .eq("bin_code", binCode)
    .order("assigned_at", { ascending: false })
    .order("track_id", { ascending: true });

  if (error) {
    console.error("archive bin detail error", error);
    return errorResponse("SERVER_ERROR");
  }

  const rows = (data ?? []) as ArchiveTrackRow[];
  return jsonResponse({
    binCode,
    tracks: rows.map((row) => ({
      trackId: row.track_id,
      title: row.title,
      artistName: row.artist_name,
      artworkUrl: row.artwork_url,
      streamUrl: buildStreamUrl(config.audiusApiBaseUrl, row.track_id),
      currentCount: row.current_count,
      assignedAt: row.assigned_at,
    })),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return preflightResponse();
  }

  let config: RuntimeConfig;
  try {
    config = getRuntimeConfig();
  } catch (error) {
    console.error("runtime config error", error);
    return errorResponse("SERVER_ERROR", "Missing runtime configuration.");
  }

  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

  const apiPath = extractApiPath(new URL(req.url).pathname);

  try {
    if (apiPath === `${config.apiBasePath}/session/init`) {
      if (req.method !== "GET") {
        return errorResponse("BAD_REQUEST", "Method not allowed.");
      }
      return await handleSessionInit(req, config, supabase);
    }

    if (apiPath.startsWith(`${config.apiBasePath}/session/replace`)) {
      const replacePath = `${config.apiBasePath}/session/replace`;
      if (apiPath !== replacePath && apiPath !== `${replacePath}/`) {
        return errorResponse("NOT_FOUND");
      }
      if (req.method !== "GET") {
        return errorResponse("BAD_REQUEST", "Method not allowed.");
      }
      return await handleSessionReplaceTrack(req, config, supabase);
    }

    if (apiPath === `${config.apiBasePath}/placements`) {
      if (req.method !== "POST") {
        return errorResponse("BAD_REQUEST", "Method not allowed.");
      }
      return await handlePlacements(req, config, supabase);
    }

    if (apiPath === `${config.apiBasePath}/session/results`) {
      if (req.method !== "GET") {
        return errorResponse("BAD_REQUEST", "Method not allowed.");
      }
      return await handleSessionResults(req, supabase);
    }

    if (apiPath === `${config.apiBasePath}/archive/bins`) {
      if (req.method !== "GET") {
        return errorResponse("BAD_REQUEST", "Method not allowed.");
      }
      return await handleArchiveBins(config, supabase);
    }

    const archiveBinPrefix = `${config.apiBasePath}/archive/bin/`;
    if (apiPath.startsWith(archiveBinPrefix)) {
      if (req.method !== "GET") {
        return errorResponse("BAD_REQUEST", "Method not allowed.");
      }
      const binCode = apiPath.slice(archiveBinPrefix.length);
      return await handleArchiveBinDetail(binCode, config, supabase);
    }

    return errorResponse("NOT_FOUND");
  } catch (error) {
    console.error("unhandled api error", error);
    return errorResponse("SERVER_ERROR");
  }
});
