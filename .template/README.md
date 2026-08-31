# Template machinery

Everything in this directory exists only while the template is in setup mode and is deleted
in one piece by `pnpm flavor finalize`. Nothing here ships into a finished project.

- `flavors/` — subtractive configuration recipes (see [flavors/README.md](flavors/README.md))
- `scaffold/` — the project's post-setup `AGENTS.md` and staged feature skills, promoted at
  finalization
- `scripts/` — bootstrap, the flavor engine, the setup guard, and flavor verification
- `presets.json` — the versioned, machine-readable set of supported bootstrap configurations

Setting up a project? Your agent should read `.agents/skills/setup/SKILL.md` at the repo
root and take it from there.
