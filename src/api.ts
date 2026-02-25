const FUNCTION_BASE_URL = (import.meta.env.VITE_FUNCTION_BASE_URL as string) ?? "";
const API_BASE_PATH = (import.meta.env.VITE_API_BASE_PATH as string) ?? "/api/v1";

export type ApiError = {
  code: string;
  message: string;
};

export type SessionTrack = {
  trackId: string;
  streamUrl: string;
  artworkUrl: string;
  seed: string;
};

export type SessionInitResponse = {
  sessionToken: string;
  sessionSize: number;
  degraded: boolean;
  tracks: SessionTrack[];
};

export type PlacementRequest = {
  sessionToken: string;
  trackId: string;
  binCode: string;
  clientTs: number;
  latencyMs?: number;
};

export type ArchiveBin = {
  binCode: string;
  displayName: string;
  sortOrder: number;
  trackCount: number;
};

export type ArchiveBinsResponse = {
  bins: ArchiveBin[];
};

export type ArchiveTrack = {
  trackId: string;
  title: string;
  artistName: string;
  artworkUrl: string;
  streamUrl: string;
  currentCount: number;
  assignedAt: string;
};

export type ArchiveBinDetailResponse = {
  binCode: string;
  tracks: ArchiveTrack[];
};

export type SessionResultTrack = {
  trackId: string;
  consensusBin: string | null;
};

export type SessionResultsResponse = {
  tracks: SessionResultTrack[];
};

type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; statusCode: number; error: ApiError };

async function apiFetch<T>(
  path: string,
  options?: RequestInit,
  sessionToken?: string,
): Promise<ApiResult<T>> {
  const url = `${FUNCTION_BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(sessionToken ? { "X-Session-Token": sessionToken } : {}),
  };

  try {
    const response = await fetch(url, { ...options, headers, cache: "no-store" });
    const json = await response.json().catch(() => ({}));

    if (!response.ok) {
      return {
        ok: false,
        statusCode: response.status,
        error: (json as { error?: ApiError }).error ?? {
          code: "SERVER_ERROR",
          message: `HTTP ${response.status}`,
        },
      };
    }

    return { ok: true, data: json as T };
  } catch (err) {
    return {
      ok: false,
      statusCode: 0,
      error: {
        code: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : "Network error",
      },
    };
  }
}

export const api = {
  sessionInit(
    device: "desktop" | "mobile",
    reset = false,
  ): Promise<ApiResult<SessionInitResponse>> {
    return apiFetch<SessionInitResponse>(
      `${API_BASE_PATH}/session/init?device=${device}&reset=${reset ? 1 : 0}`,
    );
  },

  submitPlacement(request: PlacementRequest): Promise<ApiResult<{ ok: boolean }>> {
    return apiFetch<{ ok: boolean }>(
      `${API_BASE_PATH}/placements`,
      { method: "POST", body: JSON.stringify(request) },
      request.sessionToken,
    );
  },

  archiveBins(): Promise<ApiResult<ArchiveBinsResponse>> {
    return apiFetch<ArchiveBinsResponse>(`${API_BASE_PATH}/archive/bins`);
  },

  archiveBinDetail(binCode: string): Promise<ApiResult<ArchiveBinDetailResponse>> {
    return apiFetch<ArchiveBinDetailResponse>(`${API_BASE_PATH}/archive/bin/${encodeURIComponent(binCode)}`);
  },

  sessionResults(sessionToken: string): Promise<ApiResult<SessionResultsResponse>> {
    return apiFetch<SessionResultsResponse>(
      `${API_BASE_PATH}/session/results`,
      undefined,
      sessionToken,
    );
  },
};
