# add-wxo-chat skill

Scaffolds a [watsonx Orchestrate](https://www.ibm.com/products/watsonx-orchestrate) embedded web chat into an agentic-cen-starter project.

## What it does

When activated, this skill walks through the following steps:

1. **Setup check** — confirms the project is finalized. If not, drives the `setup` skill automatically before continuing.
2. **Layout selection** — asks which of four layout flavours to use:
   - `float` — draggable, minimizable chat bubble
   - `custom` — two-column layout with a branding/guide panel alongside the chat
   - `fullscreen` — chat fills the entire viewport
   - `docview` — chat on the left, document viewer panel on the right
3. **Component scaffolding** — creates `frontend/src/components/watsonx/` with TypeScript types, lifecycle utilities, event handlers, custom header items, and the core React components.
4. **Route** — adds `/wxo` via TanStack Router.
5. **Navigation** — adds a "Chat" link to the app nav bar.
6. **Environment variables** — adds the four required `VITE_WXO_*` variables to `frontend/.env` and `frontend/.env.example`.
7. **Verification** — runs `pnpm typecheck` inside `frontend/` to confirm no new errors.

## When to use

Use this skill when asked to:
- Embed watsonx Orchestrate into a CEN Starter app
- Add a WXO chat interface or agent to the frontend
- Integrate a watsonx Orchestrate agent via the embedded web chat widget

## Requirements

- The project must be (or become) a finalized CEN Starter with the Carbon flavour.
- No additional npm packages are needed — the skill uses only `@carbon/react` and `@carbon/icons-react`, which are already present in `frontend/package.json`.
- Fill in the four `VITE_WXO_*` environment variables from the WXO agent builder (**Channels → Embedded agent**) before the widget will load.
