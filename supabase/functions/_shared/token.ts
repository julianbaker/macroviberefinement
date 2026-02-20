import type { ErrorCode } from "./errors.ts";

type TokenResolution =
  | { ok: true; token: string | null }
  | { ok: false; code: ErrorCode; message: string };

export function resolveSessionToken(
  headerTokenRaw: string | null,
  bodyTokenRaw: unknown,
): TokenResolution {
  const headerToken = headerTokenRaw?.trim() || null;
  const bodyToken = typeof bodyTokenRaw === "string" && bodyTokenRaw.trim() !== ""
    ? bodyTokenRaw.trim()
    : null;

  if (headerToken && bodyToken && headerToken !== bodyToken) {
    return {
      ok: false,
      code: "SESSION_TOKEN_MISMATCH",
      message: "X-Session-Token header must match body sessionToken when both are present.",
    };
  }

  if (headerToken) {
    return { ok: true, token: headerToken };
  }

  if (bodyToken) {
    return { ok: true, token: bodyToken };
  }

  return { ok: true, token: null };
}
