---
name: debug-code-engine
description: Triage a broken IBM Cloud Code Engine deployment of this app with the ibmcloud CLI — revisions, logs, builds, and CE-specific gotchas.
---

# Debug a Code Engine deployment

Runbook for a broken/unreachable Code Engine app. Code Engine is driven through the IBM Cloud
CLI with the Code Engine plugin (`ibmcloud plugin install code-engine`).

## Get oriented

```bash
ibmcloud login [--sso]
ibmcloud target -g <resource-group>
ibmcloud ce project select --name <project>
ibmcloud ce app get --name <app>          # status, URL, current revision, env refs
ibmcloud ce app logs --name <app> [--follow]
ibmcloud ce app events --name <app>
ibmcloud ce revision list --app <app>     # is the latest revision Ready or stuck?
```

## Failure modes, most likely first

- **Revision never becomes Ready** — almost always the container not listening on the expected
  port. Code Engine sends traffic to `$PORT` (default **8080**); this app reads `PORT` from env,
  so don't override it with a dev value like 3000. Second suspect: env validation — this app
  prints the exact missing/malformed variable on boot (`app logs` shows it); fix the secret
  (`ibmcloud ce secret update`) and `ibmcloud ce app update` to roll a new revision.
- **Build fails** (when building via CE): `ibmcloud ce buildrun list` →
  `ibmcloud ce buildrun logs --name <run>`. Check Dockerfile path, registry access, and that
  `.ceignore` excludes pnpm workspace symlinks and local dependencies. `--build-source .`
  uploads a filtered local archive; it does not clone the Git remote.
- **oauth2-proxy authenticates, then returns 502** — keep the main app project-only and inspect
  the proxy revision arguments plus its upstream mapping. The generated deployment must use
  the cluster-local URL with a trailing slash and `--pass-host-header=false`; do not make the
  main app public as a workaround.
- **App works, then 502s after idle** — min-scale 0 cold starts; check
  `ibmcloud ce app get` for `minScale` and raise to 1 if cold starts are unacceptable.
- **Crashes under load** — memory/CPU too low; CE only allows certain CPU-memory combos
  (`ibmcloud ce app update --cpu … --memory …`).
- **Secrets/config not arriving** — confirm the app references them:
  `app get` shows `--env-from-secret` bindings; a secret updated *after* the revision was
  created needs an `app update` to take effect. Prefer correcting `.env.production` and
  rerunning `deploy/ce-deploy.sh`; do not upload the raw file directly because deployment-only
  credentials are filtered by the script.

## Discipline

State the root cause in one sentence → apply the smallest fix → verify with the same command
that showed the failure → summarize for the user. Prefer `app update` (new revision, easy
rollback via `revision list`) over deleting anything.
