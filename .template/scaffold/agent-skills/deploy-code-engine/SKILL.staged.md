---
name: deploy-code-engine
description: Deploy this app to IBM Cloud Code Engine — one-command cloud-side build via deploy/ce-deploy.sh, derived URLs, verification. For broken deployments use debug-code-engine instead.
---

# Deploy to IBM Cloud Code Engine

**Execute, don't instruct.** Run every command yourself; never print a numbered plan of
commands for the user to run, and don't interview them up front. Start by running the deploy
script once — its preflight creates `.env.production` and `.secrets/idp-credentials.json` and
prints the complete list of what's missing. Relay that list in one short message. The only
things the user ever does by hand: paste secret values into those two local files, and
register the callback URL in the IdP console. Everything else is yours to run.

Executing yourself does not skip approvals. Creating the IBM Cloud API key (and committing
code) still needs the user's yes first — but ask by offering the prepared, ready-to-run
action ("Shall I create the deploy key? It's stored without being displayed."), never by
handing the user commands to run themselves.

Same single container as everywhere else (API + SPA, port 8080), run as a Code Engine app.
The entry point is `deploy/ce-deploy.sh` — idempotent, safe to rerun, and builds the image in
Code Engine from a filtered archive of the local working tree (no Git remote and no local
Docker). Details: `deploy/README.md`.

Things that happen automatically so you don't handle them:

- **Project, registry namespace, registry secret**: created if missing. The registry secret
  needs an IAM API key the first time. Ask for approval, then run
  `./deploy/create-deploy-key.sh` — it creates a dedicated key and stores it in the ignored
  mode-`0600` `.env.production` without ever printing it. Run it at most once: it refuses to
  mint another key while one is stored (`--rotate` replaces it deliberately). Never create a
  key another way — in particular never run `ibmcloud iam api-key-create` yourself — never
  ask the user to paste a key into chat, and never read the stored value back. The script
  keeps it out of the app secret.
- **Migrations**: the image migrates its own schema at boot (`MIGRATE_ON_START`, production
  default, advisory-locked). No manual step.
- **URL-dependent env**: the script reads the real app URL from Code Engine and injects
  derived values into the `app-env` secret, then rolls a revision — `BETTER_AUTH_URL`, or on
  the oauth-proxy flavor `OAUTH2_PROXY_REDIRECT_URL` + `OAUTH2_PROXY_UPSTREAMS` + a
  generated-once cookie secret. `.env.production` is never modified; explicit values there
  override derivation.

## Preconditions (inspect safely; never collect secrets in chat)

- `ibmcloud` CLI with `code-engine` + `container-registry` plugins, logged in
  (`ibmcloud login --sso` is interactive — the user runs it, not you), resource group
  targeted (or pass `-g`)
- A reachable PostgreSQL — typically IBM Cloud Databases for PostgreSQL; its connection
  string in `DATABASE_URL`. Code Engine has no in-cluster database convention: the script
  refuses to deploy without `DATABASE_URL`.
- **Database TLS.** IBM Cloud Databases uses a private CA, so its copy-paste connection string
  (`sslmode=verify-full`) fails at boot with `SELF_SIGNED_CERT_IN_CHAIN`. The example default is
  `sslmode=no-verify` (encrypted, server not verified); to verify instead, set `DATABASE_CA_CERT`
  — see `docs/deploy-code-engine.md#database-tls`. The deploy script preflights this.
- **An empty database.** Migrations run at boot; a database that already contains the app's
  tables fails with `relation "..." already exists`. Ask for an empty database or schema — never
  hand-edit `drizzle.__drizzle_migrations` to silence it (guessed rows fail again on the next
  boot; Drizzle keys on the journal's `when` timestamp, and the table lives in the `drizzle`
  schema, not `public`).

If `.env.production` is absent, the deploy command creates it from the example with mode
`0600` and continues straight into validation: every run validates the whole file up front
and lists every missing or example value in one error, before any cloud mutation — relay the
complete list to the user in a single message instead of fixing one item per run. Tell the
user which placeholder keys to replace in that local file. Do not ask them to send values to
you, print the file, or read secret values back into the conversation. Never print or read
`.env.production` or anything under `.secrets/` — no cat, grep, or head, not even to check
whether they are filled in. The deploy script's preflight is the only readiness check: run it
and relay its report; it names exactly what is missing without exposing any value.

Before the first registry-secret creation, check for a configured key without printing its
value. If it is absent, offer to create one; on approval run `./deploy/create-deploy-key.sh`
(it never emits the credential, and rerunning it will not create duplicates). Otherwise let
the user configure an existing key locally. Reuse an existing Code Engine registry secret on
later deployments rather than creating another key, and never call
`ibmcloud iam api-key-create` directly — every direct call mints a new untracked key.

Before publishing, run `pnpm verify` and inspect `git status --short`. The cloud build archives
local files rather than cloning Git, so commit the intended code first as normal release
hygiene. Ask before creating the commit. Refuse an accidental dirty-tree deploy; allow it only
when the user explicitly requests a diagnostic deployment of uncommitted work.

## Deploy — first time and every time

```bash
# 1. Production env — never commit or paste this file into chat. Running the deploy command
#    creates it and stops when it is absent; fill in DATABASE_URL and IdP secrets locally.

# 2. One command
./deploy/ce-deploy.sh -p <project>           # -g <resource-group>, --region <region>, -r <registry-namespace>
```

The repository's `.ceignore` excludes dependencies, build output, local environment files,
agent metadata, and template internals from the source archive. First run: expect the
cloud-side build to take a few minutes, and on the base flavor a
placeholder `BETTER_AUTH_URL` is seeded so the first revision can boot — the script swaps in
the real URL and rolls a fresh revision before it exits. On the oauth-proxy flavor the
script also deploys an `oauth2-proxy` front app and makes the main app project-only
(identity headers can't be spoofed from the internet); the URL to share is the proxy's.

The IdP is IBM App ID unless the user says otherwise. Collect its credentials through a file,
never through chat. The deploy preflight creates empty, gitignored `.secrets/idp-credentials.json`
and refuses to run until it is filled in — relay its message and wait for the user to paste
**either** their App ID instance's **Service credentials** JSON verbatim (a "Regular web
application" registration — single-page apps have no secret) **or**, for any other OIDC
provider, `{"issuer": ..., "clientId": ..., "clientSecret": ...}`. The deploy scripts derive
`OAUTH2_PROXY_CLIENT_ID` / `OAUTH2_PROXY_CLIENT_SECRET` / `OAUTH2_PROXY_OIDC_ISSUER_URL` from it.
Never read that file back into the conversation. `OAUTH2_PROXY_PROVIDER` is **always `oidc`** —
oauth2-proxy has no `ibm` or `appid` provider, so do not invent one. The Dex issuer in
`docker-compose.yml` is local development only — never put it in `.env.production` or suggest it
"for a demo". After deploying, the printed `/oauth2/callback` URL must be registered in App ID
under Manage Authentication → redirect URIs, or login fails at the redirect.

The deployer waits for project and application readiness, reconciles scaling and health
probes on every run, reuses an existing registry secret without an API key, and rotates that
secret when an API key is supplied.

## Verify — before telling the user it's live

The deploy summary prints the application URL and every `Derived env:` value.

```bash
# The app is named after package.json "name" (dots/underscores become hyphens).
ibmcloud ce app get --name "$(node -p 'require("./package.json").name' | tr '._' '--')"   # Ready
curl -s "$APP_URL/api/health"                   # {"status":"ok"} — use the printed app URL
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
