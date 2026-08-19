import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../env";
import { readCaCert } from "./ca-cert";
import * as schema from "./schema";

// pg merges a parsed connection string *over* explicit options, so URL-level SSL parameters
// would silently win against the CA we pass here. Strip them and let this config decide.
function poolConfig(): pg.PoolConfig {
  const ca = readCaCert(env.DATABASE_CA_CERT);
  if (!ca) return { connectionString: env.DATABASE_URL };

  const url = new URL(env.DATABASE_URL);
  for (const key of ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert"]) {
    url.searchParams.delete(key);
  }

  return { connectionString: url.toString(), ssl: { ca, rejectUnauthorized: true } };
}

const pool = new pg.Pool(poolConfig());

export const db = drizzle(pool, { schema });
