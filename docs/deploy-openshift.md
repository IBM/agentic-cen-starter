# Deploy to OpenShift

> 🤖 **With your agent:** "Deploy this to OpenShift, namespace `<name>`, auto-deploy." —
> the `deploy-openshift` skill runs this whole guide and verifies the result. The rest of
> this page is the same work by hand — worth doing once so you know what exists in the
> cluster afterwards.

One container: the API serves the built SPA on port 8080, and the image applies its own
database migrations at boot. `deploy/deploy.sh` does the heavy lifting and is safe to
rerun. Reference details live in [deploy/README.md](../deploy/README.md).

## Before you start

1. **Cluster access.** You need an OpenShift namespace you may deploy to — for CE
   engagements, ask your engagement or tech lead which cluster/namespace to use. The starter
   does not provision a cluster.
2. **`oc` CLI** — `brew install openshift-cli`.
3. **Log in:** open the OpenShift web console → your name (top right) → **Copy login
   command** → paste the `oc login --token=… --server=…` line into your terminal. Check
   with `oc whoami`.

## Configure production values

```bash
cp .env.production.example .env.production    # never commit this file
```

- `BETTER_AUTH_SECRET` — generate one: `openssl rand -hex 32`
- `BETTER_AUTH_URL` — **leave it on the example value.** The script reserves the route
  hostname before the first deploy and injects the real URL into the app secret itself
  (it prints what it derived). Set it only to override, e.g. for a custom domain.
- `DATABASE_URL` — **leave it unset** to get an in-cluster PostgreSQL (pilot/demo grade),
  deployed and wired up automatically. For real engagements, set it to a managed
  PostgreSQL and nothing extra is deployed.

## Path A — auto-deploy (recommended for internal tools and pilots)

One-time setup; afterwards **`git push` to `main` is the deploy**. The cluster builds the
image itself — no local Docker needed.

The repository must be pushed, and GitHub CLI must be logged in to its host. IBM project
repositories normally use `github.ibm.com`, but an existing `origin` is respected:

```bash
gh auth status --hostname github.ibm.com
# If needed: gh auth login --hostname github.ibm.com --web
./deploy/deploy.sh -n <namespace> --autodeploy
# To deploy another branch instead of main:
./deploy/deploy.sh -n <namespace> --autodeploy --branch <branch>
```

The script generates and registers a read-only SSH deploy key, creates the build pipeline,
grants the namespace-scoped webhook role, registers the webhook through `gh`, verifies GitHub
can reach it, starts the first build, and waits for rollout. No GitHub token goes in chat or
`.env.production`.

Some project roles cannot bind OpenShift's `system:webhook` ClusterRole. In that case the
script still completes the initial build and verified rollout, but clearly reports push
automation as inactive; ask a project administrator to grant the named permission and rerun.

## Path B — explicit image deploys (client projects, release gates)

Build and push yourself, deploy a specific tag:

```bash
docker build --platform linux/amd64 -f deploy/Dockerfile -t <registry>/<repo>/my-app:v1 .
docker push <registry>/<repo>/my-app:v1
./deploy/deploy.sh -n <namespace> -i <registry>/<repo>/my-app:v1
```

`--platform linux/amd64` matters on Apple Silicon — clusters run amd64.

## Verify

```bash
oc get route -n <namespace>              # note the host
curl https://<route-host>/api/health     # {"status":"ok"}
```

Open the route in the browser and log in end-to-end. If auth requests fail, the usual
cause is an overridden `BETTER_AUTH_URL` that doesn't match the route URL exactly — the
deploy summary prints the derived value it actually used. Promote the first admin by
setting `role = 'admin'` on that user's row in the database.

With IBM App ID, add the printed `/oauth2/callback` URL under the App ID instance →
**Manage Authentication → Authentication settings → Add web redirect URI**.

## Updating

- **Auto-deploy:** `git push`. Build, rollout, and schema migration happen on their own.
- **Explicit:** build + push a new tag, rerun `deploy.sh -i <new-tag>`.
- **Env change:** edit `.env.production` and rerun `deploy.sh`; the script restarts and
  verifies the rollout so the new secret is loaded.

Something broken? Ask your agent — the `debug-openshift` skill exists for exactly that.
