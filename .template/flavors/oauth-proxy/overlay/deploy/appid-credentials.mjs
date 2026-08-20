#!/usr/bin/env node
// Reads an IBM App ID service-credentials JSON (pasted verbatim from the App ID console) and
// prints the oauth2-proxy values derived from it, one KEY=VALUE per line. Secrets go to stdout
// only; the deploy scripts pipe them straight into the env secret without logging them.
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: appid-credentials.mjs <credentials.json>");
  process.exit(2);
}

let credentials;
try {
  credentials = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
  console.error(`could not read ${path} as JSON: ${error.message}`);
  process.exit(1);
}

const { clientId, secret, oAuthServerUrl, type } = credentials;

// Single-page-app registrations have no client secret; oauth2-proxy cannot use them.
if (type && type !== "regularwebapp") {
  console.error(
    `App ID credentials have type "${type}"; oauth2-proxy needs a "Regular web application" registration.`,
  );
  process.exit(1);
}

const missing = Object.entries({ clientId, secret, oAuthServerUrl })
  .filter(([, value]) => !value)
  .map(([key]) => key);
if (missing.length > 0) {
  console.error(`App ID credentials are missing: ${missing.join(", ")}`);
  process.exit(1);
}

process.stdout.write(
  `OAUTH2_PROXY_CLIENT_ID=${clientId}\n` +
    `OAUTH2_PROXY_CLIENT_SECRET=${secret}\n` +
    `OAUTH2_PROXY_OIDC_ISSUER_URL=${oAuthServerUrl}\n`,
);
