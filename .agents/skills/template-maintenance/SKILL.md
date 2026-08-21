---
name: template-maintenance
description: Maintain the CEN Starter template repository itself — keep flavors applying, add flavors, release versions. Template repo only; not for projects created from it (deleted at finalize).
---

# Template maintenance

Only applies in the **template repository** (`cen-starter` itself). If this is a project created
from the template, stop — this skill is not for you (finalize removes it).

The template repository never finalizes, so the root `AGENTS.md` stays the setup gate
permanently. All setup-only machinery (flavors, staged skills, setup scripts) lives under
`.template/`, which finalize deletes wholesale. The working conventions for finished
projects live in `.template/scaffold/AGENTS.md`
(installed as the project's `AGENTS.md` at finalization) — keep that file accurate when the
base changes. The root `pnpm db:generate` is guarded while `cen.finalized` is false; for
base-schema work run `CEN_TEMPLATE_MAINTENANCE=1 pnpm db:generate`.

## Changing the base app

Every base change can break flavors — their edit anchors match exact strings, their overlays
assume the base's shape. After any change, verify every standalone flavor and supported
combination in disposable copies of the current working tree:

```bash
pnpm test:template   # template-only tests: deploy scripts against mocked CLIs, dev tooling
pnpm verify:flavors
```

Template-only tests live in `.template/tests/` and run via `pnpm test:template` — never
through the project-facing `pnpm test`, which stays the project's own suite (finalize
deletes `.template/` and the script with it). Change a deploy script, run `test:template`.
`verify:flavors` derives its variants from the manifests, then applies, checks, tests
(including `test:template`), and builds each one. A broken anchor fails loudly at the apply step, naming the anchor. When fixing
manifests, prefer converting fragile `edits` into `delete` + `overlay` — anchors are the
maintenance cost.

Keep the `add-resource` skill's reference implementation
(`.template/scaffold/agent-skills/add-resource/assets/projects/`, plus the Carbon variant in
the carbon flavor overlay) exemplary: it gets copied into every project resource, flaws
included. `verify:flavors` materializes it in every compatible variant, so drift fails the
matrix instead of shipping.

## Adding a flavor

1. `.template/flavors/<name>/manifest.json` — bias delete+overlay over edits; declare `conflicts` in
   BOTH directions (this manifest and the conflicting ones).
2. Overlay `.ts`/`.tsx` files start with the `// @ts-nocheck — template overlay; …` line
   (stripped on apply). Exception: files that already carry their own `@ts-nocheck` (e.g.
   generated `routeTree.gen.ts`) get NO template header — stripping would remove theirs.
3. Declare supported combinations with `combinesWith`; `pnpm verify:flavors` discovers them.
4. Write `.agents/skills/setup/references/<name>.md`: when to choose it, what it changes,
   post-apply checks, late-retrofit notes.
5. If the flavor makes a feature skill inapplicable, delete
   `.template/scaffold/agent-skills/<skill>/**` in its manifest. Feature skills stay staged there as
   `SKILL.staged.md` files until finalization renames them back; do not put them directly
   in `.agents/skills/`, and do not name a staged file `SKILL.md` (skill scanners glob for
   that exact name).
6. Run `pnpm verify:flavors`; it verifies bootstrap, the configured app, finalization, and
   promotion of every compatible staged skill.

## Releasing

1. Update `CHANGELOG.md` (Unreleased → version + date, human-readable — projects read this
   when pulling updates).
2. Bump `cen.templateVersion` in package.json (semver: breaking = flavor/manifest/seam
   changes projects must react to).
3. Tag: `git tag v<version> && git push --tags`.

## No git hooks — deliberate

The template ships no git hooks (lefthook was removed 2026-07): IBM-managed machines set a
global `core.hooksPath` for Vault Radar secret scanning, which breaks hook managers on
`pnpm install` and silently disables repo-managed hooks anyway. Quality gates are
`pnpm check` / `pnpm verify` (agents run them; finalize enforces them) — don't reintroduce
a hook manager without solving the hooksPath conflict.

## Dependency bumps

Versions are pinned once in the `pnpm-workspace.yaml` catalog. Bump there, `pnpm install`,
`pnpm verify`, then `pnpm verify:flavors` — dependency changes break overlays too (they
reference package APIs).
