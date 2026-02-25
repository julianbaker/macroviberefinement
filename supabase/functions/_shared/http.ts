import { ErrorCode, getErrorMessage, statusForError } from "./errors.ts";

const CORS_HEADERS: HeadersInit = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-session-token",
};

const NO_CACHE_HEADERS: HeadersInit = {
  "cache-control": "no-store",
};

export function preflightResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS_HEADERS,
      ...NO_CACHE_HEADERS,
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function errorResponse(code: ErrorCode, message?: string): Response {
  return jsonResponse(
    {
      error: {
        code,
        message: message ?? getErrorMessage(code),
      },
    },
    statusForError(code),
  );
}
