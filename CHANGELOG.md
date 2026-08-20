# Changelog

Template releases. Projects created from this template can pull updates from the `upstream`
remote (set up by `pnpm bootstrap`); this file tells you what you're pulling.
Format: [Keep a Changelog](https://keepachangelog.com), semver on `cen.templateVersion`.

## [Unreleased]

- Database TLS works against IBM Cloud Databases out of the box: the example `DATABASE_URL`
  uses `sslmode=no-verify` (ICD's private CA fails node-postgres verification), with optional
  `DATABASE_CA_CERT` for real verification. `ce-deploy.sh` preflights the broken combination.
- Duplicate-object migration failures at boot now explain the cause (a non-empty database or
  regenerated migrations) instead of a bare stack trace.
- App ID credentials are collected as a file, not field by field: paste the instance's Service
  credentials JSON into gitignored `.secrets/appid-credentials.json` and the deploy scripts
  derive the oauth2-proxy client values from it (wrong registration types are rejected).
- The oauth-proxy flavor documents IBM App ID (provider stays `oidc`; Dex is dev-only) and adds
  the `SKIP_PROVIDER_BUTTON` / `INSECURE_OIDC_ALLOW_UNVERIFIED_EMAIL` settings App ID needs.

- Hardened Code Engine deployment using the lessons from the maintained full-stack CEN
  template: explicit region targeting, deterministic project readiness and selection,
  reusable or rotatable registry credentials, full create/update reconciliation, valid
  readiness and liveness probes, bounded waits, and a digest-pinned oauth2-proxy.
- Hardened OpenShift deployment with configurable source branches, webhook-RBAC fallback,
  explicit secret-change rollouts, ImageStream trigger coordination, final Ready-endpoint
  verification, rollout timeouts, and stronger deployment regression tests. Deployment-only
  credentials are now filtered from runtime secrets on both platforms.

## [0.4.0] — 2026-07-29

**Breaking: the starter no longer ships the `items` example resource.** A fresh finalized
project contains infrastructure, authentication, and the application shell — no placeholder
domain. The canonical CRUD pattern now lives inside the `add-resource` skill as a complete,
executable reference implementation.

- `add-resource` is self-contained: `assets/projects/` holds real, compilable files (shared
  zod schema, Drizzle table, Hono route, hermetic test, frontend page) plus `references/`
  explaining the cross-stack patterns and page anatomy. Agents and humans copy and adapt —
  the skill never points at app files that may not exist.
- The carbon flavor swaps the skill's frontend material to Carbon (DataTable/Modal page +
  Carbon anatomy reference); backend-only strips the frontend material; no-database still
  removes the skill entirely.
- `verify:flavors` now materializes the skill's reference resource in every compatible
  finalized variant — copy map, registration edits, migration generation, route-tree
  regeneration, full verify — so skill drift fails the matrix instead of shipping. New
  `--only <variant,...>` flag runs a subset.
- The Drizzle schema is split by domain: `backend/src/db/schema/` with `auth.ts` and one
  file per resource, exported through `schema/index.ts`. Skills, docs, and AGENTS.md teach
  the one-file-per-resource rule.
- The dashboard now shows the one-sentence prompt that creates the first real resource;
  README screenshots show the page that prompt produces, captioned honestly.
- `docs/add-a-feature.md` walks the skill's copy map by hand instead of maintaining a
  second CRUD implementation.
- The template's initial migrations were regenerated for new clones (base: auth tables
  only; oauth-proxy: reduced user table).

**Existing projects:** pulling this release does not delete anything you built — project
intent wins in every conflict. If you kept the old `items` example, it remains yours (or
delete its files and drop the table with a forward migration). Never adopt the regenerated
initial migrations: your applied migration history stays as-is, forward-only.

Also in this release:

- OpenShift auto-deploy no longer asks for or stores a GitHub token. It uses the existing
  `gh` login to register a generated read-only SSH deploy key and webhook, restores the
  namespace `system:webhook` RoleBinding required for external deliveries, and verifies a
  live GitHub ping before declaring auto-deploy configured. Setup now offers repository
  publication only after inspecting existing remotes and confirming host, owner, name, and
  visibility; IBM work defaults to `github.ibm.com` without overriding an existing origin.
- Agent guidance keeps secrets out of chat, points OpenShift users to **Copy login command**,
  and names the IBM App ID redirect-URI location.
- Guided setup and deployment use structured questions for meaningful choices after first
  inspecting available state; genuinely open-ended values remain free-form.
- The default shadcn theme now matches IBM's refreshed design language: pill-shaped buttons,
  generously rounded cards (~16px) and inputs, white cards on a near-white page in light
  mode, deep blue `#0043CE` primary, and a near-black dark mode whose focus rings are blue
  (previously white, per classic Carbon). The stock shadcn look remains available by
  swapping `themes/neutral.css` in `frontend/src/styles/index.css`. The `carbon` flavor
  (`@carbon/react`) keeps the classic Carbon look until IBM ships the refresh in the
  component library itself.
- All setup-only machinery now lives in a single `.template/` directory: flavors, the staged
  project `AGENTS.md` + feature skills (formerly `scaffold/`), and the setup scripts
  (bootstrap, flavor engine, setup guard, flavor verification). A fresh clone's visible tree
  now contains only files that survive finalization, and `pnpm flavor finalize` deletes
  `.template/` wholesale. Command entry points (`pnpm bootstrap`, `pnpm flavor …`,
  `pnpm verify:flavors`) are unchanged.
- Deploy scripts now derive URL-dependent configuration themselves: `deploy/deploy.sh`
  reserves the OpenShift route hostname before the first deploy and injects
  `BETTER_AUTH_URL` — or, on the oauth-proxy flavor, `OAUTH2_PROXY_REDIRECT_URL` plus a
  generated-once `OAUTH2_PROXY_COOKIE_SECRET` — directly into the `app-env` secret. No more
  deploy-once-then-fix-the-URL dance; `.env.production` is never modified, derived values
  are printed in the summary, and explicit values always override.
- Added `deploy/ce-deploy.sh`: one-command, idempotent IBM Cloud Code Engine deployment
  with cloud-side image builds (no local Docker). It creates the project, ICR namespace,
  and registry secret as needed, requires an external `DATABASE_URL`, and derives
  URL-dependent values from the real app URL. On the oauth-proxy flavor it deploys
  oauth2-proxy as a public front app and makes the main app project-only so identity
  headers cannot be spoofed from the internet.
- `pnpm dev` now owns the complete local lifecycle: Ctrl-C or termination stops the native
  app processes and runs `docker compose down`, while preserving database data in its volume.
- Added the same ready-to-use development admin (`admin@example.com` / `changethis`) to every
  database-backed auth variant. Local auth uses an idempotent `pnpm db:seed`; OAuth assigns
  the role when that exact Dex identity first authenticates, using its real OIDC subject.
  `no-database` retains API-key auth.
- `pnpm dev` now validates every selected stack port together and rejects silent Vite port
  shifts. OAuth development ports are configurable through `DEX_PORT` and
  `OAUTH_PROXY_PORT`.
- Added a structural setup gate for agents: post-setup feature skills remain staged and
  undiscoverable until a successfully bootstrapped, clean, verified project is finalized.
  Flavor finalization promotes only compatible skills; the flavor matrix now tests the full
  bootstrap-to-finalize lifecycle.
- Made guided setup outcome-focused for beginners, clarified the OAuth proxy decision and
  self-contained local IdP, and required agents starting from empty workspaces to choose a
  user-named project in a durable visible location before cloning. Interactive bootstrap no
  longer silently inherits `cen-starter`, while an explicit `--name cen-starter` remains valid
  for template work or intentionally named projects.
- Added a concise workstation-preparation skill covering Git, NVM, pnpm, Rancher Desktop,
  IBM Bob, editor support, and the OpenShift and IBM Cloud deployment CLIs.
- Removed skill-discovery instructions from `AGENTS.md`; coding harnesses discover skills.
- Replaced the GitHub Actions workflow with local `pnpm verify` and
  `pnpm verify:flavors` commands. Flavor verification derives all standalone flavors and
  supported combinations from their manifests and checks disposable copies of the current
  working tree.

## [0.3.0] — 2026-07-09

Deployment convenience restored from the old template, adapted to the single-image model.

- **Migrate-on-start**: the production image applies pending migrations at boot
  (drizzle-orm runtime migrator over the bundled SQL, under a Postgres advisory lock;
  `MIGRATE_ON_START=false` opts out). The manual pre-deploy migration step is gone.
- **In-cluster PostgreSQL by convention**: `deploy.sh` deploys a pilot-grade Postgres
  (`deploy/openshift/postgres.yaml`) and wires `DATABASE_URL` automatically whenever
  `.env.production` doesn't provide one; set `DATABASE_URL` for a managed database.
- **`deploy.sh --autodeploy`**: one-time setup of ImageStream + Docker-strategy BuildConfig
  + GitHub (Enterprise) webhook + image trigger — afterwards `git push` to `main` builds
  in-cluster and rolls out automatically. `GITHUB_TOKEN` is filtered out of the app secret.
- deploy-openshift / deploy-code-engine skills and `deploy/README.md` rewritten around the
  two modes; `no-database` strips the Postgres manifest and boot migrator.
- Root `tsconfig.json` covering `scripts/` — the flavor/bootstrap scripts are now typechecked
  by `pnpm check`, lefthook, and the editor (they previously ran type-stripped and unchecked);
  `pnpm flavor finalize` removes it along with the scripts.

## [0.2.0] — 2026-07-09

Flavor composition: two flavors can now be applied together when the manifests declare it.

- Engine: `pnpm flavor apply <name> [<name>...]` applies flavors in order; `combinesWith`
  in a manifest whitelists a combination; overlays skip files an earlier flavor deleted;
  colliding files resolve via `flavors/<name>/combo/<other>/`; install + verify run once
  per invocation. Wrong order or untested pairs fail with an explanatory error.
- `oauth-proxy carbon` — the classic IBM-internal setup: Carbon UI behind company SSO
- `backend-only no-database` — stateless API services (e.g. watsonx Orchestrate tools)
- Setup skill interview is now scenario-driven: it recommends a configuration from what the
  project is (client-branded app, IBM-internal asset, SSO requirement, headless service)
- CI flavor matrix covers both combinations
- Verified against real agents: three setup scenarios run by weaker models on fresh clones;
  fixes from that exercise — flavor apply preserves a bootstrap-renamed compose project
  name, warns when a flavor changes `.env.example` under an existing `.env`,
  `cen.setupDone` renamed to `cen.bootstrapped`, placeholder favicon
- Release-audit fixes: `no-database` now also fixes the production Dockerfile and
  `.env.production.example`, removes inapplicable skills (as does `backend-only`), and
  `pnpm bootstrap` writes `.env` after flavors so flavored env examples land in it;
  invalid flavor sequences are rejected before any file changes

## [0.1.0] — 2026-07-09

Initial release of the single-branch template (successor to `full-stack-cen-template`).

- Base app: Hono + zod-openapi backend (Swagger UI from the zod schemas), React/Vite/TanStack
  frontend with shadcn/ui and a Carbon-flavored theme, better-auth (email/password + admin),
  Drizzle + PostgreSQL, end-to-end types via Hono RPC (no codegen)
- Flavor engine: `pnpm flavor list/apply/finalize` with four flavors: `no-database`,
  `backend-only`, `oauth-proxy` (oauth2-proxy + bundled Dex for local dev), and `carbon`
  (full @carbon/react UI with Carbon-token Tailwind bridge)
- Agent surface: AGENTS.md (setup mode + runbook), `.agents/skills/` (setup, add-resource,
  add-page, db-migrations, deploy + debug for OpenShift and Code Engine)
- Backend test setup: vitest + in-memory PGlite running the real migrations
- Production: single container (API serves the SPA), kustomize manifests, idempotent
  `deploy/deploy.sh`, CI with a flavor matrix and a Postgres smoke job
- `pnpm bootstrap`: post-clone naming, remotes, `.env`, optional flavor apply
