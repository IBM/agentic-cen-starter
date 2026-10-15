// @ts-nocheck — template overlay; this line is stripped when `pnpm flavor apply` copies the file into place
import { OpenAPIHono, z } from "@hono/zod-openapi";
import { type ClientEnv, requireApiKey } from "../auth";

/**
 * Sub-router for routes software calls with `API_KEY` (agents, other backends) —
 * handlers can rely on `c.get("client")`, never on a user session.
 */
export function apiKeyRouter() {
  const app = new OpenAPIHono<ClientEnv>();
  app.use(requireApiKey);
  return app;
}

export const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

export const notFound = (resource: string) => ({
  description: `${resource} not found`,
  content: { "application/json": { schema: z.object({ error: z.string() }) } },
});
