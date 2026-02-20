export type ErrorCode =
  | "BAD_REQUEST"
  | "SESSION_TOKEN_MISMATCH"
  | "INVALID_BIN"
  | "INVALID_TRACK"
  | "DUPLICATE_PLACEMENT"
  | "TOO_FAST"
  | "RATE_LIMITED"
  | "INSUFFICIENT_POOL"
  | "PLACEMENTS_DISABLED"
  | "NOT_FOUND"
  | "SERVER_ERROR";

const ERROR_MESSAGES: Record<ErrorCode, string> = {
  BAD_REQUEST: "Request validation failed.",
  SESSION_TOKEN_MISMATCH: "Header X-Session-Token does not match body sessionToken.",
  INVALID_BIN: "binCode is invalid.",
  INVALID_TRACK: "trackId is invalid for this session.",
  DUPLICATE_PLACEMENT: "Placement already exists for this track and session.",
  TOO_FAST: "Placements are happening too fast.",
  RATE_LIMITED: "Rate limit exceeded.",
  INSUFFICIENT_POOL: "Not enough active allowlisted tracks.",
  PLACEMENTS_DISABLED: "Placements are currently disabled.",
  NOT_FOUND: "Endpoint not found.",
  SERVER_ERROR: "Unexpected server error.",
};

export function getErrorMessage(code: ErrorCode): string {
  return ERROR_MESSAGES[code];
}

export function statusForError(code: ErrorCode): number {
  switch (code) {
    case "BAD_REQUEST":
    case "SESSION_TOKEN_MISMATCH":
      return 400;
    case "INVALID_BIN":
    case "INVALID_TRACK":
    case "NOT_FOUND":
      return 404;
    case "DUPLICATE_PLACEMENT":
      return 409;
    case "TOO_FAST":
    case "RATE_LIMITED":
      return 429;
    case "INSUFFICIENT_POOL":
    case "PLACEMENTS_DISABLED":
      return 503;
    case "SERVER_ERROR":
      return 500;
  }
}
