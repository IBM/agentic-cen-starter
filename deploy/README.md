# Deployment

## Build

Build from the repository root:

```bash
docker build -f deploy/Dockerfile -t cen-starter:latest .
```

The image builds the full pnpm workspace, prunes production backend dependencies with `pnpm deploy`, then runs the Hono API and serves the built SPA from `./static`.

## Run Locally

The container listens on port 8080. `DATABASE_URL` must point to a PostgreSQL server reachable from inside the container.

```bash
docker run --rm -p 8080:8080 \
  -e DATABASE_URL='postgres://USER:PASSWORD@host.docker.internal:5432/DATABASE' \
  -e BETTER_AUTH_SECRET='replace-with-at-least-32-random-characters' \
  -e BETTER_AUTH_URL='http://localhost:8080' \
  cen-starter:latest
```

Verify:

```bash
curl http://localhost:8080/api/health
```

## OpenShift

Create `.env.production` from `.env.production.example` and set production values. Two modes:

```bash
# Auto-deploy (recommended for internal tools/pilots): one-time setup, then git push = deploy.
# The cluster builds the image itself (ImageStream + BuildConfig + GitHub webhook).
# Uses the existing gh login; deploy.sh installs a scoped read-only SSH deploy key.
./deploy/deploy.sh -n <namespace> --autodeploy

# Non-main deployment branch:
./deploy/deploy.sh -n <namespace> --autodeploy --branch <branch>

# Explicit: build/push yourself, deploy a specific image.
./deploy/deploy.sh -n <namespace> -i <registry>/<repo>/cen-starter:<tag>
```

Either way the script creates/updates the `app-env` secret from `.env.production`, applies the
kustomize base in `deploy/openshift`, and waits for rollout. Auto-deploy uses the existing
GitHub CLI login to register a generated read-only SSH deploy key and webhook; no GitHub token
belongs in `.env.production`. If the current user cannot bind OpenShift's `system:webhook`
role, the initial build and deployment still complete, but the summary marks push automation
inactive and identifies the permission an administrator must grant.

**Derived values**: the script applies the route first to reserve the hostname, then fills in
what depends on it — `BETTER_AUTH_URL` (or, on the oauth-proxy flavor,
`OAUTH2_PROXY_REDIRECT_URL` plus a generated-once `OAUTH2_PROXY_COOKIE_SECRET`) — directly in
the `app-env` secret. `.env.production` is never modified; every derived value is printed in
the deploy summary, and setting one explicitly in `.env.production` overrides derivation.

**Database convention**: if `.env.production` contains no `DATABASE_URL`, the script deploys
an in-cluster PostgreSQL (`deploy/openshift/postgres.yaml`, pilot/demo grade) and injects the
generated `DATABASE_URL` into `app-env`. Set `DATABASE_URL` to use a managed PostgreSQL
instead — recommended for production engagements.

## Code Engine

Create `.env.production` from `.env.production.example` (requires `DATABASE_URL` — Code
Engine has no in-cluster database convention), then:

```bash
./deploy/ce-deploy.sh -p <project>    # -g <resource-group>, --region <region>, -r <registry-namespace>
```

Idempotent, first time and every time after. The script selects or creates the Code Engine
project, ensures the ICR namespace and registry secret (first run needs `IBMCLOUD_API_KEY`
in the environment or `IAM_API_KEY=` in `.env.production` — filtered out of the app
secret), builds the image cloud-side from the working tree (`--build-source`, no local
Docker), creates/updates the `app-env` secret and fully reconciles the app's scaling,
visibility, resources, wait timeout, and `/api/health` probes (`--min-scale 1` — cold starts
hurt an app with auth sessions). Existing registry credentials are reused when no API key is
provided, or rotated when one is present. The script applies the same derived-values convention as the
OpenShift script: the real app URL is read from Code Engine and injected into the secret
(`BETTER_AUTH_URL`; on the oauth-proxy flavor `OAUTH2_PROXY_REDIRECT_URL` +
`OAUTH2_PROXY_UPSTREAMS` + a generated-once cookie secret), followed by a fresh revision.

On the oauth-proxy flavor the script additionally runs oauth2-proxy as its own public Code
Engine app in front, and deploys the main app with `--visibility project` so the forwarded
identity headers cannot be spoofed from the internet. The proxy image is version-and-digest
pinned, and both proxy creates and updates wait for readiness.

## Migrations

The image migrates its own schema at boot: in production the backend applies pending
migrations (shipped as SQL in the image, applied via drizzle-orm under a Postgres advisory
lock) before it starts serving. No manual step, and deploying a new image is always
schema-safe — including webhook-triggered auto-deploys.

To manage migrations manually instead, set `MIGRATE_ON_START=false` in the environment and
run them from a source checkout with `DATABASE_URL` set:

```bash
pnpm --filter @cen/backend db:migrate
```

The runtime image intentionally does not contain `drizzle-kit`; the boot-time migrator uses
drizzle-orm's runtime migrator over the bundled SQL files.
