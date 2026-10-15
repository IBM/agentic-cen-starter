import type { Context, MiddlewareHandler } from "hono";
import { auth } from "./better-auth";

export { type Client, type ClientEnv, getClient, requireApiKey } from "./api-key";

// The auth seam. Routes only ever touch getSession/requireAuth (people) and
// getClient/requireApiKey (software) — never the implementation behind them.
// Swapping auth (e.g. the oauth-proxy flavor) replaces better-auth.ts and this
// file's internals, nothing else.

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

export async function getSession(c: Context): Promise<Session | null> {
  const result = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!result) return null;
  const { user } = result;
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role === "admin" ? "admin" : "user",
    },
  };
}

export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const session = await getSession(c);
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("session", session);
  await next();
};
