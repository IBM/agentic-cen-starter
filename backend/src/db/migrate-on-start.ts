import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { env } from "../env";
import { db } from ".";
import * as schema from "./schema";

const MIGRATION_LOCK_KEY = 7461001n;

function isDuplicateObjectError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "42P07" || code === "42710";
}

function shouldMigrateOnStart() {
  return (
    env.MIGRATE_ON_START === "true" ||
    (env.MIGRATE_ON_START === undefined && env.NODE_ENV === "production")
  );
}

async function runMigrationsWithLock() {
  const client = await db.$client.connect();
  let lockAcquired = false;

  try {
    await client.query("select pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_KEY.toString()]);
    lockAcquired = true;

    const migrationDb = drizzle(client, { schema });
    await migrate(migrationDb, { migrationsFolder: "src/db/migrations" });
  } finally {
    if (lockAcquired) {
      await client.query("select pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_KEY.toString()]);
    }
    client.release();
  }
}

export async function migrateOnStart(): Promise<void> {
  if (!shouldMigrateOnStart()) {
    console.log("database migrations skipped");
    return;
  }

  console.log("database migrations starting");
  try {
    await runMigrationsWithLock();
  } catch (error) {
    console.error("database migrations failed", error);
    if (isDuplicateObjectError(error)) {
      console.error(
        "The database already contains objects this migration creates — it is not empty, or its " +
          "migrations were regenerated after being applied. Use an empty database; do not " +
          "hand-edit drizzle.__drizzle_migrations.",
      );
    }
    process.exit(1);
  }
  console.log("database migrations done");
}
