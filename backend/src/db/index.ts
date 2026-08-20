import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../env";
import * as schema from "./schema";

// pg merges a parsed connection string *over* explicit options, so URL-level SSL parameters
// would silently win against the CA we pass here. Strip them and let this config decide.
function poolConfig(): pg.PoolConfig {
  if (!env.DATABASE_CA_CERT) return { connectionString: env.DATABASE_URL };

  const ca = Buffer.from(env.DATABASE_CA_CERT, "base64").toString("utf8");
  if (!ca.includes("-----BEGIN CERTIFICATE-----")) {
    throw new Error("DATABASE_CA_CERT is not a base64-encoded PEM certificate");
  }

  const url = new URL(env.DATABASE_URL);
  for (const key of ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert"]) {
    url.searchParams.delete(key);
  }
  return { connectionString: url.toString(), ssl: { ca, rejectUnauthorized: true } };
}

const pool = new pg.Pool(poolConfig());

export const db = drizzle(pool, { schema });
