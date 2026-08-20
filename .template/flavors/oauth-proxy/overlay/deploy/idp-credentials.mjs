#!/usr/bin/env node
// Reads .secrets/idp-credentials.json and prints the oauth2-proxy values derived from it,
// one KEY=VALUE per line. Two shapes are accepted:
//   - IBM App ID service credentials pasted verbatim from the App ID console
//     (detected by its oAuthServerUrl field; needs a "Regular web application" registration)
//   - any OIDC provider: {"issuer": "...", "clientId": "...", "clientSecret": "..."}
// Secrets go to stdout only; the deploy scripts pipe them straight into the env secret
// without logging them.
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: idp-credentials.mjs <credentials.json>");
  process.exit(2);
}

let credentials;
try {
  credentials = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
  console.error(`could not read ${path} as JSON: ${error.message}`);
  process.exit(1);
}

let clientId;
let clientSecret;
let issuer;

// An App ID "type" field marks App ID credentials even when other fields are missing.
// Single-page-app registrations have no client secret; oauth2-proxy cannot use them.
if (credentials.type && credentials.type !== "regularwebapp") {
  console.error(
    `App ID credentials have type "${credentials.type}"; oauth2-proxy needs a "Regular web application" registration.`,
  );
  process.exit(1);
}

if (credentials.oAuthServerUrl || credentials.secret) {
  // IBM App ID service credentials, pasted verbatim.
  clientId = credentials.clientId;
  clientSecret = credentials.secret;
  issuer = credentials.oAuthServerUrl;
} else {
  // Generic OIDC shape.
  clientId = credentials.clientId;
  clientSecret = credentials.clientSecret;
  issuer = credentials.issuer;
}

const missing = Object.entries({ clientId, clientSecret, issuer })
  .filter(([, value]) => !value)
  .map(([key]) => key);
if (missing.length > 0) {
  console.error(
    `IdP credentials are missing: ${missing.join(", ")}. Paste either the IBM App ID ` +
      `service credentials JSON verbatim, or {"issuer", "clientId", "clientSecret"} for ` +
      `any other OIDC provider.`,
  );
  process.exit(1);
}

process.stdout.write(
  `OAUTH2_PROXY_CLIENT_ID=${clientId}\n` +
    `OAUTH2_PROXY_CLIENT_SECRET=${clientSecret}\n` +
    `OAUTH2_PROXY_OIDC_ISSUER_URL=${issuer}\n`,
);
