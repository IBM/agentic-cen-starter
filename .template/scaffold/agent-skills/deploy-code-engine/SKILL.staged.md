---
name: deploy-code-engine
description: Deploy this app to IBM Cloud Code Engine — one-command cloud-side build via deploy/ce-deploy.sh, derived URLs, verification. For broken deployments use debug-code-engine instead.
---

# Deploy to IBM Cloud Code Engine

Same single container as everywhere else (API + SPA, port 8080), run as a Code Engine app.
The entry point is `deploy/ce-deploy.sh` — idempotent, safe to rerun, builds the image in
the cloud from the working tree (no local Docker). Details: `deploy/README.md`.

Things that happen automatically so you don't handle them:

- **Project, registry namespace, registry secret**: created if missing. The registry secret
  needs an IAM API key the first time — `IBMCLOUD_API_KEY` in the environment or
  `IAM_API_KEY=` in `.env.production` (the script keeps it out of the app secret).
- **Migrations**: the image migrates its own schema at boot (`MIGRATE_ON_START`, production
  default, advisory-locked). No manual step.
- **URL-dependent env**: the script reads the real app URL from Code Engine and injects
  derived values into the `app-env` secret, then rolls a revision — `BETTER_AUTH_URL`, or on
  the oauth-proxy flavor `OAUTH2_PROXY_REDIRECT_URL` + `OAUTH2_PROXY_UPSTREAMS` + a
  generated-once cookie secret. `.env.production` is never modified; explicit values there
  override derivation.

## Preconditions (ask the user, don't guess)

- `ibmcloud` CLI with `code-engine` + `container-registry` plugins, logged in
  (`ibmcloud login --sso` is interactive — the user runs it, not you), resource group
  targeted (or pass `-g`)
- A reachable PostgreSQL — typically IBM Cloud Databases for PostgreSQL; its connection
  string in `DATABASE_URL`. Code Engine has no in-cluster database convention: the script
  refuses to deploy without `DATABASE_URL`.

## Deploy — first time and every time

```bash
# 1. Production env — never commit this file
cp .env.production.example .env.production   # fill in DATABASE_URL and the values only you
                                             # can know (secrets, IdP client config); leave
                                             # URL-dependent values on their example values

# 2. One command
./deploy/ce-deploy.sh -p <project>           # -g <resource-group>, --region <region>, -r <registry-namespace>
```

First run: expect the cloud-side build to take a few minutes, and on the base flavor a
placeholder `BETTER_AUTH_URL` is seeded so the first revision can boot — the script swaps in
the real URL and rolls a fresh revision before it exits. On the oauth-proxy flavor the
script also deploys an `oauth2-proxy` front app and makes the main app project-only
(identity headers can't be spoofed from the internet); the URL to share is the proxy's.
The deployer waits for project and application readiness, reconciles scaling and health
probes on every run, reuses an existing registry secret without an API key, and rotates that
secret when an API key is supplied.

## Verify — before telling the user it's live

The deploy summary prints the application URL and every `Derived env:` value.

```bash
ibmcloud ce app get --name cen-starter          # Ready
curl -s https://<app-url>/api/health            # {"status":"ok"}
```

Open the URL: sign-in must work end-to-end. If auth fails, compare the `Derived env:` lines
against the real URL — an explicit override in `.env.production` that drifted is the usual
cause. Promote the first admin by setting `role = 'admin'` on the user's row in the database.

## Update an existing deployment

Rerun `./deploy/ce-deploy.sh -p <project>` — new code gets a fresh cloud build, env changes
re-apply the secret, and every update is a new revision. Schema changes need nothing extra
(boot-time migration). Rollback is `ibmcloud ce app get` (list revisions) and routing
traffic back. To manage migrations manually instead: set `MIGRATE_ON_START=false` in
`.env.production` and run `DATABASE_URL='<production url>' pnpm --filter @cen/backend db:migrate`
from a checkout before deploying.

## When something is broken

Switch to `.agents/skills/debug-code-engine/` — don't debug ad hoc.
