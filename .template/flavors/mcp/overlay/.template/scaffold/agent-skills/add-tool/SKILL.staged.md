---
name: add-tool
description: Add an MCP tool for agents (watsonx Orchestrate) — shared zod input schema, persistence, tool registration, and an end-to-end test — following the note tools in backend/src/mcp/.
---

# Add an MCP tool

Use this when the user asks for something an agent should be able to do ("let the agent
look up an order", "save the caller's details"). The note tools are the complete, verified
reference — copy their structure, don't invent a second one:

| Reference                          | What it shows                                              |
| ---------------------------------- | ---------------------------------------------------------- |
| `shared/src/schemas/notes.ts`      | Tool inputs as zod schemas; `.describe()` texts for the LLM |
| `backend/src/db/schema/notes.ts`   | The table behind the tools                                 |
| `backend/src/mcp/notes.ts`         | Persistence, free of MCP types; `ToolError` for expected failures |
| `backend/src/mcp/server.ts`        | `registerTool` with name, description, schema, annotations |
| `backend/src/mcp/mcp.test.ts`      | Real MCP client against the app in-process, PGlite database |

## Decide first

Collect only what is genuinely missing from the request:

1. Tool names — `snake_case`, verb first (`get_order`, `save_caller`). watsonx Orchestrate
   rejects names with spaces or dashes, and agents import tools by name: a rename later
   breaks every agent using the tool.
2. Inputs and their constraints. Every field gets a `.describe()` written for the model:
   what it is, its format, when to leave it out.
3. Whether it reads or changes data (sets `readOnlyHint`), and whether it calls an outside
   system (`openWorldHint: true`).

## Steps

1. Add the input schemas to `shared/src/schemas/<domain>.ts` and export them from
   `shared/src/index.ts`.
2. Need a table? Add `backend/src/db/schema/<domain>.ts`, export it from `schema/index.ts`,
   then follow the `db-migrations` skill (`pnpm db:generate`, read the SQL, `pnpm db:migrate`).
3. Write the logic in `backend/src/mcp/<domain>.ts`. Throw `ToolError` for anything the
   agent should react to (not found, invalid combination); it becomes `isError: true` with
   your message. Any other exception is a bug and surfaces as a JSON-RPC error.
4. Register the tool in `createMcpServer()` in `backend/src/mcp/server.ts`. The description
   tells the agent *when* to call it and what comes back; keep it to one or two sentences.
5. Extend `backend/src/mcp/mcp.test.ts`: update the tool list assertion, add a happy path
   and one `isError` case. Tests stay hermetic — stub `fetch` if the tool calls out.
6. `pnpm check && pnpm test`, then try it live: `pnpm dev`, then

   ```bash
   curl -s localhost:3000/mcp -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
     -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

   (`API_KEY` and the port are in `.env`), or point the MCP Inspector
   (`npx @modelcontextprotocol/inspector`) at `http://localhost:3000/mcp` with the
   `x-api-key` header.

Delete the note tools (schema, table via a new migration, `mcp/notes.ts`, registrations,
tests) once the project has tools of its own — they are a reference, not a feature.

## Rules

- Tool inputs live in `shared/` only; never restate a shape in the backend.
- Never trust the model for identifiers or validation: re-check on the server, inside the tool.
- The endpoint is stateless (fresh server per request). Keep no state in memory between
  calls; anything that must survive goes to the database.
