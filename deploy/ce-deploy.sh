#!/usr/bin/env bash
set -euo pipefail

APP_NAME="cen-starter"
APP_SECRET="app-env"
ENV_FILE=".env.production"
REGISTRY_SERVER="icr.io"
IMAGE_NAME="$APP_NAME"
REGISTRY_SECRET="${APP_NAME}-registry"
APP_VISIBILITY="public"

project=""
resource_group=""
region=""
registry_namespace=""
image=""
database_url=""
env_secret_file=""
app_url=""
finalizing_derived_urls=false
derived_env_summary=()
derived_app_names=("$APP_NAME")

tmp_files=()

cleanup() {
  if ((${#tmp_files[@]} > 0)); then
    rm -f -- "${tmp_files[@]}"
  fi
}
trap cleanup EXIT

usage() {
  cat <<EOF
Usage: $0 -p <project> [-g <resource-group>] [-l <region>] [-r <registry-namespace>]

Options:
  -p <project>             Code Engine project to deploy into (required)
  -g <resource-group>      IBM Cloud resource group to target
  -l, --region <region>    IBM Cloud region to target
  -r <registry-namespace>  ICR namespace (default: sanitized project name;
                           ICR namespaces are account-global)
  -h, --help               Show this help
EOF
}

error() {
  printf 'error: %s\n' "$*" >&2
}

warning() {
  printf 'warning: %s\n' "$*" >&2
}

info() {
  printf '%s\n' "$*"
}

need_command() {
  local command_name="$1"

  if ! command -v "$command_name" >/dev/null 2>&1; then
    error "$command_name is required but was not found in PATH"
    exit 1
  fi
}

make_temp_file() {
  local temp_file

  temp_file=$(mktemp)
  tmp_files+=("$temp_file")
  printf '%s' "$temp_file"
}

strip_matching_quotes() {
  local value="$1"
  local first_char=""
  local last_char=""

  if ((${#value} >= 2)); then
    first_char="${value:0:1}"
    last_char="${value: -1}"

    if [[ "$first_char" == "$last_char" && ( "$first_char" == '"' || "$first_char" == "'" ) ]]; then
      value="${value:1:${#value}-2}"
    fi
  fi

  printf '%s' "$value"
}

env_file_value() {
  local key="$1"
  local file="$2"
  local line=""
  local value=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue

    if [[ "$line" == export\ * ]]; then
      line="${line#export }"
    fi

    if [[ "$line" == "$key="* ]]; then
      value="${line#*=}"
      strip_matching_quotes "$value"
      return 0
    fi
  done < "$file"

  return 1
}

base64_decode() {
  if printf 'YQ==' | base64 -d >/dev/null 2>&1; then
    base64 -d
  else
    base64 -D
  fi
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      -p)
        if (($# < 2)); then
          error "-p requires a project"
          usage >&2
          exit 2
        fi
        project="$2"
        shift 2
        ;;
      -g)
        if (($# < 2)); then
          error "-g requires a resource group"
          usage >&2
          exit 2
        fi
        resource_group="$2"
        shift 2
        ;;
      -l | --region)
        if (($# < 2)); then
          error "$1 requires a region"
          usage >&2
          exit 2
        fi
        region="$2"
        shift 2
        ;;
      -r)
        if (($# < 2)); then
          error "-r requires a registry namespace"
          usage >&2
          exit 2
        fi
        registry_namespace="$2"
        shift 2
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      --)
        shift
        break
        ;;
      -*)
        error "unknown option: $1"
        usage >&2
        exit 2
        ;;
      *)
        error "unexpected argument: $1"
        usage >&2
        exit 2
        ;;
    esac
  done

  if (($# > 0)); then
    error "unexpected argument: $1"
    usage >&2
    exit 2
  fi

  if [[ -z "$project" ]]; then
    error "-p <project> is required"
    usage >&2
    exit 2
  fi

  if [[ -z "$registry_namespace" ]]; then
    registry_namespace=$(printf '%s' "$project" \
      | tr '[:upper:]' '[:lower:]' \
      | sed 's/[^a-z0-9-]/-/g; s/--*/-/g; s/^-//; s/-$//')
  fi

  if [[ -z "$registry_namespace" ]]; then
    error "could not derive an ICR namespace from project '$project'; pass one with -r"
    exit 2
  fi

  image="${REGISTRY_SERVER}/${registry_namespace}/${IMAGE_NAME}"
}

check_preconditions() {
  need_command ibmcloud

  if ! ibmcloud plugin show code-engine >/dev/null 2>&1; then
    error "the Code Engine plugin is required; install it with 'ibmcloud plugin install code-engine'"
    exit 1
  fi

  if ! ibmcloud plugin show container-registry >/dev/null 2>&1; then
    error "the Container Registry plugin is required; install it with 'ibmcloud plugin install container-registry'"
    exit 1
  fi

  if ! ibmcloud account show >/dev/null 2>&1; then
    if [[ -t 0 && -t 1 ]]; then
      info "No IBM Cloud session found; starting SSO login."
      ibmcloud login --sso
      if ! ibmcloud account show >/dev/null 2>&1; then
        error "IBM Cloud login did not establish an account session"
        exit 1
      fi
    else
      error "IBM Cloud login is required; run 'ibmcloud login --sso' yourself, then try again"
      exit 1
    fi
  fi

  if [[ ! -f "$ENV_FILE" ]]; then
    error "$ENV_FILE is missing; create it from .env.production.example"
    exit 1
  fi
}

target_resource_group() {
  if [[ -n "$resource_group" ]]; then
    ibmcloud target -g "$resource_group"
  fi
  if [[ -n "$region" ]]; then
    ibmcloud target -r "$region"
  fi
}

ensure_project() {
  if ibmcloud ce project get --name "$project" >/dev/null 2>&1; then
    info "Selecting Code Engine project '$project'."
  else
    info "Creating Code Engine project '$project'."
    ibmcloud ce project create --name "$project" --wait --wait-timeout 600
  fi

  # Be explicit even though project creation normally selects the new project. This also
  # protects the following mutations if CLI defaults or an existing context differ.
  ibmcloud ce project select --name "$project"
}

ensure_registry_namespace() {
  local namespaces=""

  ibmcloud cr region-set global
  namespaces=$(ibmcloud cr namespace-list)

  if printf '%s\n' "$namespaces" \
    | awk '{ for (field = 1; field <= NF; field++) print $field }' \
    | grep -Fxq "$registry_namespace"; then
    info "ICR namespace '$registry_namespace' already exists."
  else
    info "Creating account-global ICR namespace '$registry_namespace'."
    ibmcloud cr namespace-add "$registry_namespace"
  fi
}

configured_iam_api_key() {
  local api_key="${IBMCLOUD_API_KEY:-}"

  if [[ -z "$api_key" ]]; then
    if api_key=$(env_file_value IAM_API_KEY "$ENV_FILE"); then
      :
    else
      api_key=""
    fi
  fi

  [[ -n "$api_key" ]] || return 1
  printf '%s' "$api_key"
}

ensure_registry_secret() {
  local api_key=""

  if ibmcloud ce registry get --name "$REGISTRY_SECRET" >/dev/null 2>&1; then
    if ! api_key=$(configured_iam_api_key); then
      info "Reusing Code Engine registry secret '$REGISTRY_SECRET'; provide IBMCLOUD_API_KEY or IAM_API_KEY to rotate it."
      return
    fi
    info "Rotating Code Engine registry secret '$REGISTRY_SECRET'."
    ibmcloud ce registry update \
      --name "$REGISTRY_SECRET" \
      --server "$REGISTRY_SERVER" \
      --username iamapikey \
      --password "$api_key"
    return
  fi

  if ! api_key=$(configured_iam_api_key); then
    error "creating registry secret '$REGISTRY_SECRET' requires IBMCLOUD_API_KEY; set it in the environment or add IAM_API_KEY=... to $ENV_FILE"
    exit 1
  fi
  info "Creating Code Engine registry secret '$REGISTRY_SECRET'."
  ibmcloud ce registry create \
    --name "$REGISTRY_SECRET" \
    --server "$REGISTRY_SERVER" \
    --username iamapikey \
    --password "$api_key"
}

require_database_url() {
  database_url=$(env_file_value DATABASE_URL "$ENV_FILE" || true)

  if [[ -z "$database_url" ]]; then
    error "DATABASE_URL is missing or empty in $ENV_FILE; provision IBM Cloud Databases for PostgreSQL and add its connection string"
    exit 1
  fi
}

application_url() {
  local application_name="$1"
  local output=""
  local url=""

  output=$(ibmcloud ce application get --name "$application_name" --output url 2>/dev/null || true)
  url=$(printf '%s\n' "$output" | grep -Eo 'https?://[^[:space:]]+' | head -n 1 || true)

  if [[ -z "$url" ]]; then
    output=$(ibmcloud ce application get --name "$application_name" 2>/dev/null || true)
    url=$(printf '%s\n' "$output" | grep -Eo 'https?://[^[:space:]]+' | head -n 1 || true)
  fi

  printf '%s' "${url%,}"
}

derive_env_values() {
  local env_file="$1"
  local auth_url=""
  local derived_env_file="${env_file}.derived"

  auth_url=$(env_file_value BETTER_AUTH_URL "$env_file" || true)
  if [[ -n "$auth_url" && "$auth_url" != "https://cen-starter.example.com" && "$auth_url" != "https://pending.invalid" ]]; then
    return
  fi

  if [[ -z "$app_url" ]]; then
    app_url=$(application_url "$APP_NAME")
  fi

  if [[ -z "$app_url" ]]; then
    if [[ "$finalizing_derived_urls" == "true" ]]; then
      warning "could not derive BETTER_AUTH_URL because the Code Engine application URL is unavailable"
      return
    fi
    # First deploy: no application URL exists yet, but the backend refuses to boot without
    # a valid BETTER_AUTH_URL. Seed a placeholder so the first revision becomes ready;
    # finalize_derived_urls swaps in the real URL immediately after.
    tmp_files+=("$derived_env_file")
    sed '/^BETTER_AUTH_URL=/d;/^export BETTER_AUTH_URL=/d' "$env_file" > "$derived_env_file"
    printf '\nBETTER_AUTH_URL=%s\n' "https://pending.invalid" >> "$derived_env_file"
    mv "$derived_env_file" "$env_file"
    info "seeded placeholder BETTER_AUTH_URL for the first boot; the real URL is derived after the first deploy"
    return
  fi

  tmp_files+=("$derived_env_file")
  sed '/^BETTER_AUTH_URL=/d;/^export BETTER_AUTH_URL=/d' "$env_file" > "$derived_env_file"
  printf '\nBETTER_AUTH_URL=%s\n' "$app_url" >> "$derived_env_file"
  mv "$derived_env_file" "$env_file"

  derived_env_summary+=("BETTER_AUTH_URL=$app_url")
  info "derived BETTER_AUTH_URL=$app_url (set it in $ENV_FILE to override)"
}

update_app_secret() {
  if ibmcloud ce secret get --name "$APP_SECRET" >/dev/null 2>&1; then
    ibmcloud ce secret update --name "$APP_SECRET" --from-env-file "$env_secret_file"
  else
    ibmcloud ce secret create --name "$APP_SECRET" --from-env-file "$env_secret_file"
  fi
}

create_app_secret() {
  env_secret_file=$(make_temp_file)

  sed \
    -e '/^GITHUB_TOKEN=/d' \
    -e '/^export GITHUB_TOKEN=/d' \
    -e '/^GH_TOKEN=/d' \
    -e '/^export GH_TOKEN=/d' \
    -e '/^GITHUB_ENTERPRISE_TOKEN=/d' \
    -e '/^export GITHUB_ENTERPRISE_TOKEN=/d' \
    -e '/^GH_ENTERPRISE_TOKEN=/d' \
    -e '/^export GH_ENTERPRISE_TOKEN=/d' \
    -e '/^IAM_API_KEY=/d' \
    -e '/^export IAM_API_KEY=/d' \
    -e '/^IBMCLOUD_API_KEY=/d' \
    -e '/^export IBMCLOUD_API_KEY=/d' \
    "$ENV_FILE" > "$env_secret_file"

  derive_env_values "$env_secret_file"
  update_app_secret
}

ensure_application() {
  local action="create"
  local arguments=()

  if ibmcloud ce application get --name "$APP_NAME" >/dev/null 2>&1; then
    info "Updating Code Engine application '$APP_NAME' with a cloud-side source build."
    action="update"
  else
    info "Creating Code Engine application '$APP_NAME' with a cloud-side source build."
  fi

  arguments=(application "$action" --name "$APP_NAME" \
    --build-source . \
    --build-dockerfile deploy/Dockerfile \
    --registry-secret "$REGISTRY_SECRET" \
    --port http1:8080 \
    --env-from-secret "$APP_SECRET" \
    --min-scale 1 \
    --max-scale 4 \
    --scale-down-delay 600 \
    --cpu 0.5 \
    --memory 1G \
    --visibility "$APP_VISIBILITY" \
    --probe-live type=http \
    --probe-live path=/api/health \
    --probe-live port=8080 \
    --probe-live initial-delay=10 \
    --probe-live interval=10 \
    --probe-live failure-threshold=3 \
    --probe-ready type=http \
    --probe-ready path=/api/health \
    --probe-ready port=8080 \
    --wait \
    --wait-timeout 1200)

  if [[ "$action" == "create" ]]; then
    arguments+=(--image "$image")
  fi

  ibmcloud ce "${arguments[@]}"
}

finalize_derived_urls() {
  local application_name=""
  local previous_env_file=""

  previous_env_file=$(make_temp_file)
  cp "$env_secret_file" "$previous_env_file"

  app_url=$(application_url "$APP_NAME")
  finalizing_derived_urls=true
  derive_env_values "$env_secret_file"
  finalizing_derived_urls=false

  if cmp -s "$previous_env_file" "$env_secret_file"; then
    return
  fi

  update_app_secret
  for application_name in "${derived_app_names[@]}"; do
    info "Starting a new '$application_name' revision with the derived environment values."
    ibmcloud ce application update --name "$application_name"
  done
}

print_summary() {
  local derived_value=""

  if [[ -z "$app_url" ]]; then
    app_url=$(application_url "$APP_NAME")
  fi

  info ""
  info "Deployment summary"
  if [[ -n "$app_url" ]]; then
    info "Application: $app_url"
  else
    info "Application: URL not found"
  fi
  info "Database: external DATABASE_URL from $ENV_FILE"

  if ((${#derived_env_summary[@]} > 0)); then
    for derived_value in "${derived_env_summary[@]}"; do
      info "Derived env: $derived_value"
    done
  fi
}

parse_args "$@"
check_preconditions
target_resource_group
ensure_project
ensure_registry_namespace
ensure_registry_secret
require_database_url
create_app_secret
ensure_application
finalize_derived_urls
print_summary
