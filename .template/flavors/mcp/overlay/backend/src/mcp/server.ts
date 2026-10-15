// @ts-nocheck — template overlay; this line is stripped when `pnpm flavor apply` copies the file into place
import { NoteCreateSchema, NoteGetSchema, NoteListSchema } from "@cen/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createNote, getNote, listNotes, ToolError } from "./notes";

// Tool registration. Tool names are the contract with the agent platform (watsonx
// Orchestrate imports tools by name; snake_case, no spaces) — renaming one breaks agents.
// Add tools with the add-tool skill; the note tools are the reference to copy.

const ok = (data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data,
});

const fail = (message: string): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: message }) }],
  isError: true,
});

/** Expected failures become tool errors the agent can react to; anything else is a bug. */
async function run(action: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    return ok(await action());
  } catch (error) {
    if (error instanceof ToolError) return fail(error.message);
    throw error;
  }
}

export function createMcpServer() {
  const server = new McpServer(
    { name: "CEN Starter MCP", version: "0.1.0" },
    { instructions: "Notes: create them with create_note, find them with list_notes." },
  );

  server.registerTool(
    "create_note",
    {
      title: "Create note",
      description: "Save a new note. Returns the note including its id.",
      inputSchema: NoteCreateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => run(async () => ({ note: await createNote(input) })),
  );

  server.registerTool(
    "get_note",
    {
      title: "Get note",
      description: "Load one note by its id.",
      inputSchema: NoteGetSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => run(async () => ({ note: await getNote(id) })),
  );

  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description: "List notes, newest first, optionally filtered by title.",
      inputSchema: NoteListSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (filters) => run(async () => ({ notes: await listNotes(filters) })),
  );

  return server;
}
