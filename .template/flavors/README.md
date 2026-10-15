# Flavors

**If this folder exists, the template has not been configured yet.** Agent? Stop and read
`.agents/skills/setup/SKILL.md` first: interview your user (database? design system?
frontend? auth?), apply the matching flavors, and only then start building features.

Post-setup feature skills live in `.template/scaffold/agent-skills/` as inert
`SKILL.staged.md` files while this directory exists, so agents cannot discover and invoke
them before setup is complete. Flavors delete incompatible staged skills. Finalization
promotes the remainder into `.agents/skills/`, restores their `SKILL.md` names, installs
`.template/scaffold/AGENTS.md` as the project's working `AGENTS.md`, and deletes all of
`.template/` — all in one operation.

## What this is

The base app is maximal; each flavor is a one-time, subtractive transformation applied at
project setup:

- `<flavor>/manifest.json` — declarative recipe: `delete` globs, exact-match `edits`,
  `packageJson` dependency removals, `verify` commands
- `<flavor>/overlay/` — files copied over the tree (mirrors repo paths); `.ts`/`.tsx` overlay
  files start with a `// @ts-nocheck` line that is stripped on apply (exception: overlaid
  `routeTree.gen.ts` keeps its own generated `@ts-nocheck` and carries no template header)

```bash
pnpm flavor list                     # what's available
pnpm flavor apply <name> [<name>...] # invalid requests are rejected before any file changes
pnpm flavor finalize                 # verifies, activates compatible skills, deletes setup machinery
```

Supported combinations are declared per manifest (`combinesWith`) and are order-sensitive —
the combining flavor goes last: `oauth-proxy carbon`, `backend-only no-database`,
`backend-only mcp`. A flavor that `requires` another (`mcp`) exists only in that combination. Colliding
files for a combination live in `<flavor>/combo/<other>/`. Flavor decision guidance lives in
`.agents/skills/setup/references/<flavor>.md`.

## Maintaining flavors (template repo only)

If you change the base app or a flavor, verify every supported result from the current working
tree:

```bash
pnpm verify:flavors
```

The command derives standalone flavors and supported combinations from the manifests, copies
the repository into disposable workspaces, and applies, checks, tests, and builds each result.
A failing workspace is retained under the printed temporary path for inspection.

A broken edit anchor fails the apply step loudly (every `find` must match exactly once). When
touching manifests, prefer `delete` + `overlay` over `edits` — anchors are the fragile part.
If a flavor makes a feature workflow inapplicable, delete it from
`.template/scaffold/agent-skills/<skill>/**` in the manifest. New flavor? Declare its supported
combinations in `combinesWith`, write its `references/<flavor>.md`, and run
`pnpm verify:flavors`.
