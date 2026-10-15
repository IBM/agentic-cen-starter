// @ts-nocheck — template overlay; this line is stripped when `pnpm flavor apply` copies the file into place
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema";

// End to end without network or Docker: a real MCP client talks to the Hono app
// in-process, the tools run against in-memory PostgreSQL with the real migrations.

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const store = vi.hoisted((): { db: TestDb | null } => ({ db: null }));

vi.mock("../db", () => {
  if (!store.db) throw new Error("test db was not initialized");
  return { db: store.db };
});

// Set before env.ts loads (.env never overrides variables that are already set).
const API_KEY = vi.hoisted(() => {
  process.env.API_KEY = "test-api-key-with-at-least-32-characters";
  process.env.DATABASE_URL ??= "postgres://unused@localhost:5432/test";
  return process.env.API_KEY;
});

let pg: PGlite;
let app: Hono;

beforeAll(async () => {
  pg = new PGlite();
  store.db = drizzle(pg, { schema });
  await migrate(store.db, {
    migrationsFolder: fileURLToPath(new URL("../db/migrations", import.meta.url)),
  });

  const { mcpRoute } = await import("./route");
  app = new Hono().route("/mcp", mcpRoute);
});

beforeEach(async () => {
  await store.db?.delete(schema.notes);
});

afterAll(async () => {
  await pg.close();
});

/** A real MCP client, wired to the Hono app in-process instead of over the network. */
async function connect(apiKey = API_KEY) {
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://test/mcp"), {
    requestInit: { headers: { "x-api-key": apiKey } },
    fetch: async (url, init) => app.request(url.toString(), init),
  });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

describe("mcp endpoint", () => {
  it("rejects requests without the API key", async () => {
    const response = await app.request("/mcp", { method: "POST" });
    expect(response.status).toBe(401);
  });

  it("rejects a wrong API key", async () => {
    await expect(connect("wrong-key")).rejects.toThrow();
  });

  it("lists the note tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "create_note",
      "get_note",
      "list_notes",
    ]);
  });
});

describe("note tools", () => {
  it("creates a note and reads it back", async () => {
    const client = await connect();
    const created = await call(client, "create_note", { title: "Call back", body: "Re: VIN" });
    const id = (created.structuredContent?.note as { id: string } | undefined)?.id;
    expect(id).toBeTruthy();

    const fetched = await call(client, "get_note", { id });
    expect(fetched.structuredContent?.note).toMatchObject({ title: "Call back", body: "Re: VIN" });
  });

  it("filters the list by title, matching wildcards literally", async () => {
    const client = await connect();
    await call(client, "create_note", { title: "100% done" });
    await call(client, "create_note", { title: "100 items" });

    const result = await call(client, "list_notes", { search: "0%" });
    const found = result.structuredContent?.notes as { title: string }[];
    expect(found.map((note) => note.title)).toEqual(["100% done"]);
  });

  it("returns a tool error for an unknown note", async () => {
    const client = await connect();
    const result = await call(client, "get_note", { id: "00000000-0000-4000-8000-000000000000" });
    expect(result.isError).toBe(true);
  });

  it("rejects invalid input before it reaches the database", async () => {
    const client = await connect();
    const result = await call(client, "create_note", { title: "" });
    expect(result.isError).toBe(true);
  });
});
