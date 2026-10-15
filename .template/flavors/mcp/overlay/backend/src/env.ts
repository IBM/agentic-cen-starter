// @ts-nocheck — template overlay; this line is stripped when `pnpm flavor apply` copies the file into place
import { z } from "zod";

// Fail-fast environment validation: the server refuses to boot on bad config,
// with an error that names the exact variable. Add every new env var here.

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  // API_PORT is the explicit dev setting; PORT is what PaaS platforms (Code Engine)
  // inject in production. API_PORT wins so stray PORT vars can't hijack local dev.
  API_PORT: z.coerce.number().int().optional(),
  PORT: z.coerce.number().int().optional(),
  DATABASE_URL: z.url(),
  DATABASE_CA_CERT: z.string().optional(),
  MIGRATE_ON_START: z.enum(["true", "false"]).optional(),
  // The shared key agents send to /mcp; see backend/src/auth/api-key.ts.
  API_KEY: z.string().min(32),
});

// In dev, .env lives at the repo root; in production, real env vars are set by the platform.
for (const file of ["../.env", ".env"]) {
  try {
    process.loadEnvFile(file);
    break;
  } catch {
    // file not present — fine
  }
}

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}

export const env = parsed.data;
