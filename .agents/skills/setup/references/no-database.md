# no-database

Removes PostgreSQL, Drizzle, and Better Auth persistence. The app boots with zero Docker:
Hono API, Swagger UI, frontend shell, and shared package remain.

## When to choose it

The app is stateless — a proxy, an integration service, a demo without persistence, or the
data lives entirely in external systems. If the user is unsure whether they'll need their own
tables, keep the base instead: subtracting later means redoing this flavor's changes by hand.

**Combines with `backend-only`** for stateless API services such as watsonx Orchestrate
tools: pass `--flavors backend-only,no-database` to bootstrap (that order — backend-only
first).
**Conflicts with `carbon` and `oauth-proxy`** (Carbon reworks pages this flavor deletes;
oauth-proxy needs the user table).

## What it changes

- Deletes `backend/src/db/`, `drizzle.config.ts`, `docker-compose.yml`, the
  login/signup/settings/admin routes, and the Drizzle-based `add-resource` and
  `db-migrations` skills (their canonical workflow assumes a database).
- **Auth seam swap**: `backend/src/auth/index.ts` becomes an API-key implementation with the
  identical exported interface (`getSession`, `requireAuth`, `Session`). A request carrying
  `API_KEY` (>= 32 characters; `x-api-key` or `Authorization: Bearer`, compared in constant
  time by the shared guard in `backend/src/auth/api-key.ts`) gets a synthetic admin session
  for `api@local`; everything else is unauthenticated. Without persistence, local accounts can't be durable — an API key reflects
  the real constraint.
- Frontend keeps a shell without auth guard or user menu; `frontend/src/lib/auth.ts` stays as
  a stub with the same exports so future code doesn't pull better-auth back into the bundle.
- `pnpm dev` no longer starts Docker; env needs `API_KEY` instead of `DATABASE_URL`/auth vars.
- `pnpm db:seed` is removed. This is the deliberate exception to the starter admin convention:
  without persistent accounts there is no `admin@example.com` user to create or log in as.
- Production: `deploy/Dockerfile` loses its copy-migrations step and `.env.production.example`
  asks for `API_KEY` — skip the migrations step in the deploy skills.
- Prevents the staged `db-migrations` and `add-resource` skills from being activated at
  finalization (the canonical resource pattern assumes Drizzle; new endpoints follow
  `backend/src/routes/health.ts`).

## Post-apply checks

1. `pnpm check` and `pnpm test` are green (apply runs them; rerun if in doubt).
2. Boot without Docker and verify:

   ```bash
   API_KEY=dev-only-api-key-change-me-please-really pnpm --filter @cen/backend dev
   curl http://localhost:3000/api/health   # {"status":"ok"}
   ```

3. Verify a protected route with `x-api-key: $API_KEY`; do not look for or promise the normal
   seeded development login. Tell your user that this variant authenticates by API key.

## Retrofitting late (flavor no longer applies)

Once the project has its own code, `flavor apply` will refuse (anchors drift by design). To
remove the database from a grown project, do the same changes manually: this list under "What
it changes" is your checklist, and the pristine template repo shows the target state of the
auth seam and frontend shell.
