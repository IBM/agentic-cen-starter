---
name: update-from-template
description: Pull improvements from the CEN Starter template into a project created from it — fetch upstream, review the changelog, merge, repair flavor-deleted files and the lockfile.
---

# Update from the template

Projects keep the template reachable as the `upstream` remote (`pnpm bootstrap` set that up).
It is fetch-only: never push project commits to it. The project's repository is `origin`.
Template releases are documented in its CHANGELOG.md — read it before merging anything.

## Preflight

```bash
git remote get-url upstream || git remote add upstream <template repo url>
git fetch upstream
git log --oneline HEAD..upstream/main            # what's new
git diff HEAD...upstream/main -- CHANGELOG.md    # what it means
```

Tell your user what the update contains and confirm they want it — don't merge silently.
Clean working tree required.

## Merge

```bash
git merge upstream/main
```

Expected conflict types, in order of likelihood:

- **`pnpm-lock.yaml`** — never hand-merge and don't trust `--theirs`/`--ours`. Resolve the
  package manifests (`package.json`, `pnpm-workspace.yaml`) first, then regenerate the
  lockfile: `pnpm install`, `git add pnpm-lock.yaml`.
- **Files the project customized** — normal conflict resolution; project intent wins, then
  re-apply the template's idea by hand if it still makes sense.
- **Resurrected files** — the merge can re-add files your flavors deleted (check
  `package.json` → `cen.flavors` for what was applied). Delete them again; the template's
  `.agents/skills/setup/references/<flavor>.md` (visible in the upstream repo) lists what
  each flavor removes.
- **Regenerated template migrations** — the template occasionally regenerates its *initial*
  migration for new clones. Your project's applied migration history wins: keep your
  `backend/src/db/migrations/` exactly as-is and change your database forward-only with new
  migrations. Never adopt upstream's rewritten migration history, and never delete a
  resource's table just because the template no longer ships an example — what your project
  built, your project keeps.

## Verify — before telling the user it's done

```bash
pnpm install && pnpm check && pnpm test
pnpm dev   # boot it; a green typecheck does not prove a working merge
```

If the update brought new migrations, they arrive with the merge — never regenerate them.
Just apply: `pnpm db:migrate`, then exercise the affected features against dev data.

## When merging is wrong

For a single fix, cherry-pick instead: `git cherry-pick <sha>` of the specific upstream
commit — smaller blast radius than a full merge.
