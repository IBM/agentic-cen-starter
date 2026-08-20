#!/usr/bin/env bash
# Creates a dedicated IBM Cloud API key for deployments and stores it in .env.production
# without ever printing it: the key goes to a temp file (--file), is moved into the env file
# by node, and the temp file is deleted. Safe for agents — no credential reaches the log.
set -euo pipefail

ENV_FILE=".env.production"
key_name="${1:-$(basename "$PWD")-deploy}"
temp_file=""

cleanup() {
  if [[ -n "$temp_file" ]]; then
    rm -f -- "$temp_file"
  fi
}
trap cleanup EXIT

if ! command -v ibmcloud >/dev/null 2>&1; then
  printf 'error: ibmcloud is required but was not found in PATH\n' >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  printf 'error: node is required but was not found in PATH\n' >&2
  exit 1
fi
if ! ibmcloud account show >/dev/null 2>&1; then
  printf 'error: no IBM Cloud session; run "ibmcloud login --sso" first\n' >&2
  exit 1
fi

temp_file=$(mktemp)
ibmcloud iam api-key-create "$key_name" \
  -d "Deployment key for $key_name (created by deploy/create-deploy-key.sh)" \
  --file "$temp_file" -q

node - "$temp_file" "$ENV_FILE" <<'NODE'
const fs = require("node:fs");
const [keyFile, envFile] = process.argv.slice(2);
const apikey = JSON.parse(fs.readFileSync(keyFile, "utf8")).apikey;
if (!apikey) {
  console.error("error: the created key file has no apikey field");
  process.exit(1);
}
let env = "";
try {
  env = fs.readFileSync(envFile, "utf8");
} catch {
  // absent: the deploy script creates it from the example later; start it here
}
const lines = env.split("\n").filter((line) => !/^(export )?IAM_API_KEY=/.test(line));
while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
lines.push(`IAM_API_KEY=${apikey}`, "");
fs.writeFileSync(envFile, lines.join("\n"), { mode: 0o600 });
NODE
chmod 600 "$ENV_FILE"

printf "Created IBM Cloud API key '%s' and stored it in %s without displaying it.\n" "$key_name" "$ENV_FILE"
