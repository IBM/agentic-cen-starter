// @ts-nocheck — template overlay; this line is stripped when `pnpm flavor apply` copies the file into place
import type { Context, MiddlewareHandler } from "hono";
import { getClient } from "./api-key";

export { type Client, type ClientEnv, getClient, requireApiKey } from "./api-key";

// The auth seam, API key only: without persistence there are no user accounts. A request
// carrying API_KEY (see ./api-key) gets a synthetic admin session, so code written against
// getSession/requireAuth keeps working; new machine routes use apiKeyRouter() instead.

export type Session = {
  user: {
    id: string;
    email: string;
    name: string;
    role: "user" | "admin";
  };
};

export type AuthEnv = {
  Variables: {
    session: Session;
  };
};

const apiSession: Session = {
  user: {
    id: "api",
    email: "api@local",
    name: "API client",
    role: "admin",
  },
};

export async function getSession(c: Context): Promise<Session | null> {
  return getClient(c) ? apiSession : null;
}

export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const session = await getSession(c);
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("session", session);
  await next();
};
