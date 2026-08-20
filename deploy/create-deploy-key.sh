#!/usr/bin/env bash
# Creates a dedicated IBM Cloud API key for deployments and stores it in .env.production
# without ever printing it: the key goes to a temp file (--file), is moved into the env file
# by node, and the temp file is deleted. Safe for agents — no credential reaches the log.
set -euo pipefail

ENV_FILE=".env.production"
rotate="false"
key_name=""
for arg in "$@"; do
  case "$arg" in
    --rotate) rotate="true" ;;
    *) key_name="$arg" ;;
  esac
done
if [[ -z "$key_name" ]]; then
  key_name="$(basename "$PWD")-deploy"
fi
temp_file=""

# One key is enough: rerunning this script must not mint another one. IBM Cloud allows
# duplicate key names, so every extra run would create an extra key that nobody tracks.
existing_key=$(sed -n 's/^\(export \)\{0,1\}IAM_API_KEY=//p' "$ENV_FILE" 2>/dev/null | head -n 1 || true)
if [[ "$rotate" != "true" ]]; then
  if [[ -n "$existing_key" ]]; then
    printf 'A deployment API key is already stored in %s - not creating another one.\n' "$ENV_FILE"
    printf 'The deploy script will use it as is. To replace it, rerun with --rotate\n'
    printf '(then delete the old key: ibmcloud iam api-keys / ibmcloud iam api-key-delete NAME).\n'
    exit 0
  fi
  if [[ -n "${IBMCLOUD_API_KEY:-}" ]]; then
    printf 'IBMCLOUD_API_KEY is already exported in this shell - not creating another key.\n'
    printf 'The deploy script will use it as is. To create a stored key anyway, rerun with --rotate.\n'
    exit 0
  fi
fi

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

# Seed the env file from the example first: writing the key into a fresh file would
# otherwise leave the user without the template, and the deploy script skips its own
# create-from-example step once the file exists.
if [[ ! -f "$ENV_FILE" && -f .env.production.example ]]; then
  cp .env.production.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"
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
  // no .env.production.example to seed from - start the file with just the key
}
const lines = env.split("\n").filter((line) => !/^(export )?IAM_API_KEY=/.test(line));
while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
lines.push(`IAM_API_KEY=${apikey}`, "");
fs.writeFileSync(envFile, lines.join("\n"), { mode: 0o600 });
NODE
chmod 600 "$ENV_FILE"

printf "Created IBM Cloud API key '%s' and stored it in %s without displaying it.\n" "$key_name" "$ENV_FILE"
