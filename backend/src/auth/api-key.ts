import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { env } from "../env";

// Machine access: software (watsonx Orchestrate, another backend, a script) calling with
// the shared API_KEY as `x-api-key` or `Authorization: Bearer <key>`. A principal of its
// own — machine routes read `c.get("client")`, never a user session. Without API_KEY set,
// every machine route answers 401.

export type Client = {
  kind: "api-key";
};

export type ClientEnv = {
  Variables: {
    client: Client;
  };
};

const apiKeyClient: Client = { kind: "api-key" };

// Hash both sides so timingSafeEqual always compares equal-length buffers.
const digest = (value: string) => createHash("sha256").update(value).digest();
const expectedKey = env.API_KEY ? digest(env.API_KEY) : null;

function presentedKey(c: Context): string | undefined {
  const header = c.req.header("x-api-key");
  if (header) return header;
  return c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
}

export function getClient(c: Context): Client | null {
  const key = presentedKey(c);
  if (!key || !expectedKey) return null;
  return timingSafeEqual(digest(key), expectedKey) ? apiKeyClient : null;
}

export const requireApiKey: MiddlewareHandler<ClientEnv> = async (c, next) => {
  const client = getClient(c);
  if (!client) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("client", client);
  await next();
};
