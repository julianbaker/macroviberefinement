# Frontend Integration Handoff (Backend Frozen)

Project ref: `ukqfnoemsifeiotqlxcp`

## Required FE env vars

Use these names in FE:

- `VITE_FUNCTION_BASE_URL`
  - value: `https://ukqfnoemsifeiotqlxcp.supabase.co/functions/v1/api`
- `VITE_API_BASE_PATH`
  - value: `/api/v1`

If FE also initializes Supabase client directly, add:

- `VITE_SUPABASE_URL`
  - value: `https://ukqfnoemsifeiotqlxcp.supabase.co`
- `VITE_SUPABASE_ANON_KEY`
  - value: `<project anon key>`
  - fetch with:
    - `supabase projects api-keys --project-ref ukqfnoemsifeiotqlxcp`

## Base URL routing rule (avoid double-prefix errors)

Correct composition:
- base = `VITE_FUNCTION_BASE_URL`
- route = `/api/v1/...`
- final URL = `${base}${route}`

Example:
- base: `https://ukqfnoemsifeiotqlxcp.supabase.co/functions/v1/api`
- route: `/api/v1/session/init?device=mobile`
- final: `https://ukqfnoemsifeiotqlxcp.supabase.co/functions/v1/api/api/v1/session/init?device=mobile`

Do not set FE base URL to include `/api/v1` already, or routes will break.

## CORS behavior

Configured response headers from backend:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET,POST,OPTIONS`
- `Access-Control-Allow-Headers: authorization, x-client-info, apikey, content-type, x-session-token`

Implications:
- Local FE dev (`localhost`) is allowed.
- Preview deploy domains are allowed.
- Production domain is allowed.
- Preflight `OPTIONS` is handled with `204`.

## Backend mode

Backend is now in bugfix-only mode unless critical issues are found.
