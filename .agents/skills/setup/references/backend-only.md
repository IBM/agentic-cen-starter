# backend-only

Removes the React frontend entirely. What remains is an API-only service: Hono +
zod-openapi, Swagger UI at `/api/docs`, better-auth (email/password endpoints under
`/api/auth/*`), and PostgreSQL/Drizzle — all unchanged.

## When to choose it

The consumer is not a browser you own: tools/APIs for **watsonx Orchestrate**, an agent
backend, another team's frontend, a mobile app, or service-to-service calls. If the user
"might add a UI later", keep the base — re-adding the frontend package by hand is far more
work than ignoring it.

**Combines with `no-database`** for fully stateless services (Orchestrate tools, pure
orchestration/proxying): pass `--flavors backend-only,no-database` to bootstrap, in that
order. What
remains is Hono + Swagger + the API-key auth stub — zero Docker, single tiny container.
**Conflicts with `carbon` and `oauth-proxy`** (both rework the frontend this flavor deletes).

## What it changes

- Deletes `frontend/` and removes it from the pnpm workspace.
- `backend/src/index.ts`: no static-SPA serving in production; the container serves only the
  API (root path 404s — that's correct for an API service). `AppType` stays exported, so a
  TypeScript consumer can still get a fully typed client via Hono RPC.
- Removes `WEB_PORT` and the dev-only Vite-proxy `trustedOrigins` from the auth config.
- `deploy/Dockerfile`: no frontend build stage; smaller image, same port 8080 and deploy flow.
- Prevents the staged `add-page` skill from being activated at finalization (there are no
  frontend pages to add).

## Post-apply checks

1. `pnpm check`, `pnpm test`, `pnpm build` green (apply runs the first two).
2. `pnpm dev` (db + development seed + API, no web server), then
   `curl localhost:3000/api/health` and open `/api/docs`.
3. Verify a better-auth cookie session through `/api/auth/*` with the seeded development
   admin `admin@example.com` / `changethis`. Tell your user that other clients authenticate
   through the same REST endpoints, and that software callers (agents, other backends) use
   routes built with `apiKeyRouter()` and `API_KEY` instead. Tools for an AI agent are the
   `mcp` flavor (`--flavors backend-only,mcp`).

## Retrofitting late (flavor no longer applies)

Removing a grown frontend by hand is the same list as "What it changes" above. Re-adding a
frontend to a backend-only project: copy `frontend/` from the pristine template, re-add it to
`pnpm-workspace.yaml`, restore `WEB_PORT` + `trustedOrigins` + the static-serving block in
`backend/src/index.ts` and Dockerfile from the template's git history.
