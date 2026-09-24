# Getting started

Human-paced setup, from empty machine to signed-in app. Working with an AI agent instead?
Just tell it what you want to build — it walks you through all of this. This guide is for
doing it yourself, and for understanding what the agent does.

## What you need

| Tool | Why | macOS install |
|---|---|---|
| Node.js ≥ 22 | runs everything | `brew install nvm && nvm install 22` |
| pnpm | package manager (never npm/yarn) | `corepack enable` |
| Container engine | dev database (and Dex/proxy with OAuth) | Docker or Podman with Compose; use the company software portal on managed machines |
| Git | you know why | `brew install git` |

> 🤖 **With your agent:** "Check my machine for Agentic CEN Starter development and install what's
> missing." — it audits and fixes one tool at a time (the `prepare-workstation` skill).

On IBM-managed machines, don't install Docker Desktop. Use an approved Docker-compatible
runtime or Podman. `CEN_CONTAINER_ENGINE=auto` in `.env` selects the first ready engine; set
it to `docker` or `podman` when both are installed.

## Set up the project

```bash
git clone https://github.com/IBM/agentic-cen-starter.git my-app   # folder = your project name
cd my-app
pnpm install
pnpm bootstrap    # asks for the app's name, then a numbered menu of valid setups
```

Bootstrap reserves `origin` for this project and configures the starter as a fetch-only
`upstream`. If the project has no repository yet, `origin` remains absent and a normal push
fails safely. After setup is finalized, your agent offers to create a repository or connect
an existing one before pushing.

The menu is the whole configuration decision — pick by what your project is, not by
technology. Unsure? Option 1 (OAuth proxy + shadcn/ui) is the production-ready default.

## Run it

```bash
pnpm dev
```

This checks that all ports are free, starts the dev containers, applies database
migrations, seeds the development admin, and starts API + frontend with hot reload.
First run downloads container images — give it a couple of minutes. Ctrl-C stops everything;
your data stays in the database volume.

| URL | What |
|---|---|
| http://localhost:5173 | the app (base setups) |
| http://localhost:4180 | the app **behind the OAuth proxy** — use this one with the proxy flavor |
| http://localhost:3000/api/health | API health check |
| http://localhost:3000/api/docs | Swagger UI, generated from the zod schemas |

Sign in with the development admin: **admin@example.com** / **changethis**. It exists only in
local development. With the OAuth proxy you'll land on the bundled Dex login page first —
same credentials, no IdP registration needed locally.

Look around: the **Admin** page manages users, and `pnpm db:studio` opens a database
browser. The dashboard shows the one-sentence prompt that creates your first resource;
[add-a-feature.md](add-a-feature.md) walks through the same thing by hand.

## Everyday commands

```bash
pnpm dev          # everything, hot reload; Ctrl-C stops it
pnpm check        # typecheck + lint — green means done
pnpm test         # backend tests (in-memory Postgres, real migrations)
pnpm verify       # check + test + production build
pnpm db:studio    # browse the database
```

## Finish setup

When the configuration is settled (app runs, you've signed in):

```bash
git add -A && git commit -m "Configure Agentic CEN Starter"
pnpm flavor finalize    # reruns pnpm verify, strips the template machinery
git add -A && git commit -m "Finalize template setup"
```

After finalization the template is out of your way: what's left is exactly your app, plus
agent skills for the everyday workflows (add a resource, add a page, migrations, deploy).

## Troubleshooting

- **Port conflict at `pnpm dev`** — it names every conflicting port and who owns it. Change
  the values in `.env` (change `DB_PORT` together with the port inside `DATABASE_URL`).
  Never stop containers you don't recognize; they belong to other projects.
- **`db:migrate` hangs silently** — the database volume probably belongs to an old project
  with the same name. Reset it with `<docker|podman> compose down -v` (destroys only *this*
  project's local data), then run `pnpm dev` again.
- **API won't start** — it validates every env var at boot and tells you which one is
  missing or malformed. Fix `.env`, don't fight the validation.
- **Container storage fills up over time** — `<docker|podman> system prune` clears unused
  images and containers from old projects.
- **Something else** — paste the exact error to your agent; the debug skills know this
  stack.
