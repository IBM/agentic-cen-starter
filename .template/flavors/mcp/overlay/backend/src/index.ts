// @ts-nocheck — template overlay; this line is stripped when `pnpm flavor apply` copies the file into place
import { serve } from "@hono/node-server";
import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { migrateOnStart } from "./db/migrate-on-start";
import { env } from "./env";
import { mcpRoute } from "./mcp/route";
import { healthRoute } from "./routes/health";

// Chained so AppType captures every route registered on the API.
const api = new OpenAPIHono().route("/health", healthRoute);

export type AppType = typeof api;

const app = new OpenAPIHono();
app.route("/api", api);
// The MCP endpoint agents connect to (Streamable HTTP, API-key protected).
app.route("/mcp", mcpRoute);

// Swagger UI and the OpenAPI schema are dev tooling — not registered in production.
if (env.NODE_ENV !== "production") {
  app.doc31("/api/openapi.json", {
    openapi: "3.1.0",
    info: { title: "CEN Starter API", version: "0.1.0" },
  });
  app.get("/api/docs", swaggerUI({ url: "/api/openapi.json" }));
}

await migrateOnStart();
serve({ fetch: app.fetch, port: env.API_PORT ?? env.PORT ?? 3000 }, (info) => {
  const docsHint = env.NODE_ENV === "production" ? "" : "  (Swagger UI: /api/docs)";
  console.log(`api ready on http://localhost:${info.port}${docsHint}`);
});
