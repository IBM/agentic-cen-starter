# mcp

Turns the `backend-only` API into an **MCP server**: the shape for tools that an AI agent
calls — watsonx Orchestrate (remote MCP toolkit), or any other MCP client. Only exists on
top of `backend-only`: pass `--flavors backend-only,mcp` to bootstrap, in that order.

## When to choose it

The consumer is an agent, not a person and not a typed client: "tools for our watsonx
Orchestrate agent", "an MCP server for …". The service keeps PostgreSQL for data of its own
(cases, orders, call notes). If the agent should call a plain REST API instead, or people
also need to sign in, keep `backend-only` or the base and use `apiKeyRouter()` for the
machine routes.

**Conflicts with `no-database`, `carbon`, and `oauth-proxy`.**

## What it changes

- **Auth seam: API key only.** better-auth, its tables, the initial auth migration, the
  development seed, and `/api/auth/*` are removed. `backend/src/auth/index.ts` exports only
  the API-key guard (`requireApiKey`, `Client`, `ClientEnv`); `API_KEY` (>= 32 characters)
  is required, sent as `x-api-key` or `Authorization: Bearer`, and compared in constant
  time. `routes/lib.ts` keeps `apiKeyRouter()`, not `protectedRouter()`.
- **`/mcp`** (`backend/src/mcp/route.ts`): MCP Streamable HTTP, **stateless** — a fresh
  server per request with JSON responses, so Code Engine can scale out without sticky
  sessions.
- **Reference tools** `create_note`, `get_note`, `list_notes`: inputs as zod schemas in
  `shared/src/schemas/notes.ts`, a `note` table with its migration, persistence in
  `backend/src/mcp/notes.ts` (`ToolError` → `isError: true`), registration in
  `backend/src/mcp/server.ts`, and an end-to-end test (`mcp.test.ts`) with a real MCP client
  wired to the app in-process and PGlite — no network, no Docker.
- **Skills:** the staged `add-resource` skill is replaced by `add-tool`.
- **Deploy:** `deploy/ce-deploy.sh` refuses to run without a real `API_KEY`, derives no
  URL-dependent values, and prints the `/mcp` URL plus the
  `orchestrate toolkits add -k mcp … --transport streamable_http` command.
  The Code Engine app stays **public** by default — a SaaS caller such as watsonx
  Orchestrate generally cannot reach a private or project-only endpoint, and the API key
  protects `/mcp`. Set `CE_APP_VISIBILITY=private` only when every caller has been
  confirmed to reach private Code Engine endpoints.

## Post-apply checks

1. `pnpm check` and `pnpm test` are green (apply runs them).
2. `pnpm dev` (Postgres + migrations + API), then with `API_KEY` from `.env`:

   ```bash
   curl -s localhost:3000/mcp -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
     -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

   lists the three note tools; the same request without the header answers 401.
3. Tell your user: there is no login — agents authenticate with the API key. In watsonx
   Orchestrate the key goes into a connection, never into the agent's instructions.

## Retrofitting late (flavor no longer applies)

Adding MCP to a grown `backend-only` project: copy `backend/src/mcp/route.ts` and
`server.ts` from the pristine template's `.template/flavors/mcp/overlay/`, add
`@modelcontextprotocol/sdk` to the catalog and the backend, set `API_KEY`, and mount
`app.route("/mcp", mcpRoute)` in `backend/src/index.ts`. better-auth can stay alongside if
the project also has human users.
