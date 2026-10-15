// @ts-nocheck — template overlay; this line is stripped when `pnpm flavor apply` copies the file into place
import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { db } from "../db";
import { user } from "../db/schema";
import { env } from "../env";

export { type Client, type ClientEnv, getClient, requireApiKey } from "./api-key";

// The auth seam. Routes only ever touch getSession/requireAuth (people) and
// getClient/requireApiKey (software) — never the implementation behind them.
// In this flavor, oauth2-proxy owns the login flow.

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
  // These headers are trusted only because the app is reachable exclusively through
  // oauth2-proxy: docker compose locally, and a sidecar in production.
  const forwardedEmail = c.req.header("x-forwarded-email");
  if (!forwardedEmail) return null;
  const email = forwardedEmail.trim().toLowerCase();

  const subject = c.req.header("x-forwarded-user");
  if (!subject) return null;

  const name = c.req.header("x-forwarded-preferred-username") ?? email;

  const localAdmin = isLocalDevelopment() && email === "admin@example.com";
  const [sameEmail] = await db
    .select({ id: user.id, role: user.role })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);

  // Compatibility for projects briefly created with the old seed, which stored Dex's
  // configured userID instead of the effective OIDC subject. This exception is limited to
  // the known local development identity; production identities are never linked by email.
  if (localAdmin && sameEmail && sameEmail.id !== subject) {
    await db
      .update(user)
      .set({ name, role: "admin", updatedAt: new Date() })
      .where(eq(user.id, sameEmail.id));
    return { user: { id: sameEmail.id, email, name, role: "admin" } };
  }

  if (sameEmail && sameEmail.id !== subject) {
    throw new Error(`OIDC subject mismatch for existing user ${email}; manual relink required.`);
  }

  const [row] = await db
    .insert(user)
    .values({ id: subject, email, name, role: localAdmin ? "admin" : "user" })
    .onConflictDoUpdate({
      target: user.id,
      set: { email, name, updatedAt: new Date() },
    })
    .returning({ id: user.id, role: user.role });
  if (!row) throw new Error("user upsert returned no row");

  return {
    user: {
      id: row.id,
      email,
      name,
      role: row.role === "admin" ? "admin" : "user",
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

function isLocalDevelopment() {
  const databaseHost = new URL(env.DATABASE_URL).hostname;
  return (
    env.NODE_ENV === "development" && ["localhost", "127.0.0.1", "[::1]"].includes(databaseHost)
  );
}
