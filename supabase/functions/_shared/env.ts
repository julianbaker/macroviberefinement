function readInt(name: string, fallback: number): number {
  const value = Deno.env.get(name);
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export type RuntimeConfig = {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  apiBasePath: string;
  audiusApiBaseUrl: string;
  audiusSourceHandle: string;
  missingRunThreshold: number;
  minPlaylistsFloor: number;
  rateLimitSessionPerMin: number;
  rateLimitIpPerMin: number;
  rateLimitMinIntervalMs: number;
  placementsEnabled: boolean;
  requestHashSecret: string;
};

export type AudiusSyncConfig = RuntimeConfig & {
  audiusApiKey: string;
  audiusApiSecret: string;
  audiusManagedUserId: string;
  audiusSyncEnabled: boolean;
};

let cachedConfig: RuntimeConfig | null = null;

export function getRuntimeConfig(): RuntimeConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const placementsEnabledRaw = (Deno.env.get("PLACEMENTS_ENABLED") ?? "true").toLowerCase();

  cachedConfig = {
    supabaseUrl: required("SUPABASE_URL"),
    supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    apiBasePath: "/api/v1",
    audiusApiBaseUrl: Deno.env.get("AUDIUS_API_BASE_URL") ?? "https://api.audius.co/v1",
    audiusSourceHandle: (Deno.env.get("AUDIUS_SOURCE_HANDLE") ?? "hotandnew").toLowerCase(),
    missingRunThreshold: readInt("MISSING_RUN_THRESHOLD", 2),
    minPlaylistsFloor: readInt("MIN_PLAYLISTS_FLOOR", 20),
    rateLimitSessionPerMin: readInt("RATE_LIMIT_SESSION_PER_MIN", 40),
    rateLimitIpPerMin: readInt("RATE_LIMIT_IP_PER_MIN", 120),
    rateLimitMinIntervalMs: readInt("RATE_LIMIT_MIN_INTERVAL_MS", 300),
    placementsEnabled: placementsEnabledRaw !== "false",
    requestHashSecret: required("REQUEST_HASH_SECRET"),
  };

  return cachedConfig;
}

export function getAudiusSyncConfig(): AudiusSyncConfig {
  const base = getRuntimeConfig();
  const syncEnabledRaw = (Deno.env.get("AUDIUS_SYNC_ENABLED") ?? "false").toLowerCase();
  return {
    ...base,
    audiusApiKey: required("AUDIUS_API_KEY"),
    audiusApiSecret: required("AUDIUS_API_SECRET"),
    audiusManagedUserId: required("AUDIUS_MANAGED_USER_ID"),
    audiusSyncEnabled: syncEnabledRaw !== "false",
  };
}
