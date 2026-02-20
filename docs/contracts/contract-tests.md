# API v1 Contract Tests

## Prerequisites
- Node.js 22+
- Backend deployed and reachable at a base URL that exposes `/api/v1/*`.

## Environment
Set `CONTRACT_BASE_URL` to the base URL prefix before `/api/v1`.

Examples:
- Supabase edge function direct: `https://<project-ref>.supabase.co/functions/v1/api`
- Local function serve + proxy path: `http://127.0.0.1:54321/functions/v1/api`

## Run
```bash
CONTRACT_BASE_URL="http://127.0.0.1:54321/functions/v1/api" npm run test:contract
```

## What the suite validates
- `/api/v1/session/init` success shape and `INSUFFICIENT_POOL` behavior.
- `/api/v1/placements` token precedence mismatch (`SESSION_TOKEN_MISMATCH`).
- `/api/v1/placements` success + duplicate handling (`DUPLICATE_PLACEMENT`).
- `/api/v1/archive/bins` fixed bin list contract.
- `/api/v1/archive/bin/:binCode` payload shape and camelCase fields.

## Notes
- The suite is environment-dependent and may exercise live data.
- When `PLACEMENTS_ENABLED=false`, placement success assertions are replaced with `503 PLACEMENTS_DISABLED` assertions.
