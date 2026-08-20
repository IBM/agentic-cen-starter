---
name: deploy-openshift
description: Deploy this app to OpenShift — auto-deploy pipeline (git push = deploy) or explicit image deploys, optional in-cluster PostgreSQL, deploy.sh, verification. For broken deployments use debug-openshift instead.
---

# Deploy to OpenShift

**Execute, don't instruct.** Run every command yourself; never print a numbered plan of
commands for the user to run. The only things the user ever does by hand: paste secret values
into the local env/credentials files, and any IdP-console step. Everything else is yours to
run. Executing yourself does not skip approvals (e.g. ask before creating commits) — but ask
by offering the prepared action, never by handing the user commands to run themselves.

One container: the API serves the built SPA on port 8080. Manifests live in
`deploy/openshift/` (kustomize), the entry point is `deploy/deploy.sh` — idempotent, safe to
rerun. Details: `deploy/README.md`.

Two things happen automatically so you don't handle them:

- **Database**: if `.env.production` has no `DATABASE_URL`, `deploy.sh` deploys an in-cluster
  PostgreSQL (pilot/demo grade) and wires the URL into the app secret itself. For real
  engagements, set `DATABASE_URL` to a managed PostgreSQL — then nothing extra is deployed.
- **Migrations**: the image migrates its own schema at boot (`MIGRATE_ON_START`, default on
  in production, guarded by an advisory lock). There is no manual migration step. Teams that
  want manual control set `MIGRATE_ON_START=false` in `.env.production`.

## Ask only for unresolved decisions

Inspect `git`, `gh`, and `oc` state before asking. When meaningful fixed choices remain, use
the question tool if available, one decision at a time, with the recommendation first.
Typical choices are an existing versus new repository, repository owner and visibility,
one of the user's available namespaces, identity provider, and auto-deploy versus explicit
deploy when the user's context has not already settled it. Use free-form only for values
that cannot sensibly be choices, such as a new name or URL. Never ask for credentials in chat.

## Preconditions

- `oc` CLI logged in (`oc whoami`) and a namespace the user may deploy to. If login is
  missing, tell them: OpenShift web console → user menu in the top-right → **Copy login
  command**, then run that command in their terminal — never paste its token into chat. If
  they have no cluster or namespace, ask their engagement or tech lead for the assigned
  target; do not invent or provision one.
- **Auto-deploy path**: inspect `origin`, its remote heads, and the current upstream first.
  Respect an existing GitHub host and repository. If there is no project repository, offer
  to create it and explicitly confirm host, owner, name, and visibility; recommend
  `github.ibm.com` + private for IBM work. Check `gh --version` and
  `gh auth status --hostname <host>` before saying creation or administration is unavailable.
  Browser login is `gh auth login --hostname <host> --web`; never request a GitHub token.
- **Explicit path**: a registry the cluster can pull from (and you can push to)

Create `.env.production` from the example and put application runtime secrets there. Do not
ask users to paste secrets into chat or expose them in shell command text. Never print or
read `.env.production` or anything under `.secrets/` — no cat, grep, or head, not even to
check whether they are filled in; the deploy script reports what is missing without exposing
values. IdP credentials go
into gitignored `.secrets/idp-credentials.json` (the deploy script creates it empty when
missing and refuses to run until it is filled in — relay its message): for IBM App ID the
user pastes the instance's **Service credentials** JSON verbatim, for any other OIDC provider
`{"issuer": ..., "clientId": ..., "clientSecret": ...}` — the deploy script derives the
issuer/client values from it at deploy time. Never read that file back into the conversation.

## Recommended: auto-deploy (internal tools, pilots)

One-time setup; afterwards **`git push` to `main` is the deploy** — the cluster builds the
image itself (BuildConfig + webhook), no local Docker needed:

```bash
# 1. Production env — never commit this file
cp .env.production.example .env.production   # fill in the values only you can know (secrets,
                                             # IdP client config); leave DATABASE_URL unset for
                                             # the in-cluster db. URL-dependent values
                                             # (BETTER_AUTH_URL — or OAUTH2_PROXY_REDIRECT_URL
                                             # and the cookie secret on the oauth-proxy flavor)
                                             # are derived by deploy.sh; set them only to override.

# 2. One command — deploy.sh uses the existing gh login to install a read-only
#    SSH deploy key and the GitHub webhook; no GitHub token is requested.
./deploy/deploy.sh -n <namespace> --autodeploy
# Add --branch <branch> when the deploy source is not main.
```

This sets up ImageStream + BuildConfig (from `deploy/Dockerfile`), grants the namespace-scoped
OpenShift webhook role, installs a generated read-only SSH deploy key, registers the webhook,
verifies a GitHub ping reaches OpenShift, starts the first build, and waits for rollout. Do
not replace this flow with ad-hoc `oc` patches; switch to `debug-openshift` if it fails.
If webhook-role binding is forbidden, the script finishes and verifies the initial deploy but
reports push automation inactive; relay its exact permission guidance to the user.

## Alternative: explicit deploys (client projects, release gates)

```bash
cp .env.production.example .env.production   # as above; set DATABASE_URL for managed Postgres

docker build -f deploy/Dockerfile -t <registry>/<repo>/cen-starter:<tag> .
docker push <registry>/<repo>/cen-starter:<tag>

./deploy/deploy.sh -n <namespace> -i <registry>/<repo>/cen-starter:<tag>
```

## Verify — before telling the user it's live

```bash
oc get route -n <namespace>                       # note the host
curl -s https://<route-host>/api/health           # {"status":"ok"}
```

Then open the route in a browser: sign-in must work end-to-end. The deploy summary prints
every derived value (`Derived env: …`) — if auth fails, compare those against the route URL
first; an explicit override in `.env.production` that drifted from the route is the usual
cause. Check the pod log for the migration line on first boot. Promote the first admin: set
`role = 'admin'` on the user's row in the database.

For IBM App ID, give the user the exact callback printed by the deployer and this location:
App ID instance → **Manage Authentication → Authentication settings → Add web redirect URI**.
The callback ends in `/oauth2/callback`.

## Update an existing deployment

- **Auto-deploy**: `git push`. That's it — build, rollout, and schema migration happen alone.
- **Explicit**: build + push a new tag, rerun `deploy.sh -i <new tag>`.
- **Env change**: edit `.env.production` and rerun `deploy.sh`; it re-applies the secret,
  restarts the workload, and verifies the service endpoint.
- **Pilot db → managed db**: set `DATABASE_URL` in `.env.production`, rerun `deploy.sh`,
  restart. The schema is recreated by migrate-on-start; moving existing *data* is a manual
  `pg_dump`/`pg_restore`. Remove the pilot db with
  `oc delete -f deploy/openshift/postgres.yaml` and `oc delete secret postgres-env` when done.

## When something is broken

Switch to `.agents/skills/debug-openshift/` — don't debug ad hoc.
