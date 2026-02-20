# MacroVibe API v1 Contract Freeze

Status: **FROZEN for FE integration**

Freeze date: **February 19, 2026**

External JSON naming: `camelCase`

API base path: `/api/v1`

Function base URL (current project):
- `https://ukqfnoemsifeiotqlxcp.supabase.co/functions/v1/api`

Base URL usage rule:
- FE must use function base URL, then append route paths that start with `/api/v1/...`.
- Example final URL: `https://ukqfnoemsifeiotqlxcp.supabase.co/functions/v1/api/api/v1/session/init?device=mobile`

Error envelope:
```json
{
  "error": {
    "code": "STRING",
    "message": "STRING"
  }
}
```

## Endpoint List
- `GET /api/v1/session/init`
- `POST /api/v1/placements`
- `GET /api/v1/archive/bins`
- `GET /api/v1/archive/bin/:binCode`

## 1) GET /api/v1/session/init
### Query
- `device=desktop|mobile` (required)
- `reset=0|1` (optional, default `0`)

### Request example
```bash
curl -sS "${FUNCTION_BASE_URL}/api/v1/session/init?device=desktop&reset=1"
```

### 200 response example
```json
{
  "sessionToken": "f0d6f5e6b2f6484ba55e22eb20df9f10",
  "sessionSize": 64,
  "degraded": false,
  "tracks": [
    {
      "trackId": "123456",
      "streamUrl": "https://api.audius.co/v1/tracks/123456/stream",
      "artworkUrl": "https://.../art.jpg",
      "seed": "A1B2"
    }
  ]
}
```

### 503 response example
```json
{
  "error": {
    "code": "INSUFFICIENT_POOL",
    "message": "Not enough active allowlisted tracks."
  }
}
```

## 2) POST /api/v1/placements
### Request body
```json
{
  "sessionToken": "optional when header is present",
  "trackId": "123456",
  "binCode": "VELLUM",
  "clientTs": 1739985225000,
  "latencyMs": 182
}
```

### Token precedence behavior (frozen)
1. `X-Session-Token` header is authoritative.
2. Body `sessionToken` is used only if header is missing.
3. Header/body mismatch returns `400 SESSION_TOKEN_MISMATCH`.

### Request examples
```bash
curl -sS -X POST "${FUNCTION_BASE_URL}/api/v1/placements" \
  -H "Content-Type: application/json" \
  -H "X-Session-Token: f0d6f5e6b2f6484ba55e22eb20df9f10" \
  -d '{"trackId":"123456","binCode":"VELLUM","clientTs":1739985225000,"latencyMs":182}'
```

```bash
curl -sS -X POST "${FUNCTION_BASE_URL}/api/v1/placements" \
  -H "Content-Type: application/json" \
  -H "X-Session-Token: header-token" \
  -d '{"sessionToken":"body-token","trackId":"123456","binCode":"VELLUM","clientTs":1739985225000}'
```

### 200 response example
```json
{
  "ok": true
}
```

### 503 placements paused example
```json
{
  "error": {
    "code": "PLACEMENTS_DISABLED",
    "message": "Placements are currently disabled."
  }
}
```

## 3) GET /api/v1/archive/bins
### Request example
```bash
curl -sS "${FUNCTION_BASE_URL}/api/v1/archive/bins"
```

### 200 response example
```json
{
  "bins": [
    {
      "binCode": "VELLUM",
      "displayName": "Vellum",
      "sortOrder": 1,
      "trackCount": 341
    }
  ]
}
```

## 4) GET /api/v1/archive/bin/:binCode
### Request example
```bash
curl -sS "${FUNCTION_BASE_URL}/api/v1/archive/bin/VELLUM"
```

### 200 response example
```json
{
  "binCode": "VELLUM",
  "tracks": [
    {
      "trackId": "123456",
      "title": "Track Title",
      "artistName": "Artist",
      "artworkUrl": "https://.../art.jpg",
      "streamUrl": "https://api.audius.co/v1/tracks/123456/stream",
      "currentCount": 29,
      "assignedAt": "2026-02-19T22:11:45.932Z"
    }
  ]
}
```

## HTTP Status + Error Code Map
- `400 BAD_REQUEST`
- `400 SESSION_TOKEN_MISMATCH`
- `404 INVALID_BIN`
- `404 INVALID_TRACK`
- `409 DUPLICATE_PLACEMENT`
- `429 TOO_FAST`
- `429 RATE_LIMITED`
- `503 INSUFFICIENT_POOL`
- `503 PLACEMENTS_DISABLED`
- `500 SERVER_ERROR`

## Ordering + Assignment Notes
- Archive list ordering is deterministic: `assignedAt DESC`, then `trackId ASC`.
- `assignedAt` is sourced from winning-bin placement timestamp (`track_current_bin.assigned_at`).
