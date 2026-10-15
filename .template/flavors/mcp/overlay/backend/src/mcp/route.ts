// @ts-nocheck — template overlay; this line is stripped when `pnpm flavor apply` copies the file into place
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { type ClientEnv, requireApiKey } from "../auth";
import { createMcpServer } from "./server";

// MCP over Streamable HTTP, stateless: every request gets a fresh server + transport, so
// any Code Engine instance can serve any request (no sticky sessions, scale-out safe).
// JSON responses instead of SSE streams — the tools are request/response only.
export const mcpRoute = new Hono<ClientEnv>().use(requireApiKey).all("/", async (c) => {
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw);
  } finally {
    await server.close();
  }
});
