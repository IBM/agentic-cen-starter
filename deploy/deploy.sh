#!/usr/bin/env bash
set -euo pipefail

APP_NAME="cen-starter"
APP_CONTAINER="cen-starter"
APP_SECRET="app-env"
ENV_FILE=".env.production"
OPENSHIFT_DIR="deploy/openshift"
POSTGRES_MANIFEST="$OPENSHIFT_DIR/postgres.yaml"
POSTGRES_SECRET="postgres-env"
GITHUB_SOURCE_SECRET="github-source"
GITHUB_WEBHOOK_SECRET="github-webhook-secret"
GITHUB_WEBHOOK_KEY="WebHookSecretKey"
GITHUB_WEBHOOK_ROLE_BINDING="${APP_NAME}-webhook"

namespace=""
image=""
autodeploy=false
deployment_branch="main"
webhook_rbac_available=true
webhook_rbac_reason=""
in_cluster_db_used=false
external_db_used=false
database_url=""
route_url=""
derived_env_summary=()

tmp_files=()
tmp_dirs=()

cleanup() {
  if ((${#tmp_files[@]} > 0)); then
    rm -f -- "${tmp_files[@]}"
  fi
  if ((${#tmp_dirs[@]} > 0)); then
    rm -rf -- "${tmp_dirs[@]}"
  fi
}
trap cleanup EXIT

usage() {
  cat <<EOF
Usage: $0 -n <namespace> [-i <image>] [-a|--autodeploy] [--branch <branch>]

Options:
  -n <namespace>   OpenShift namespace/project to deploy into (required)
  -i <image>       Image reference to set on the Deployment
  -a, --autodeploy Configure OpenShift BuildConfig + GitHub webhook automation
  --branch <branch> Git branch built by auto-deploy (default: main)
  -h, --help       Show this help
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
  local variable_name="$1"
  local temp_file

  temp_file=$(mktemp)
  tmp_files+=("$temp_file")
  printf -v "$variable_name" '%s' "$temp_file"
}

make_temp_dir() {
  local variable_name="$1"
  local temp_dir

  temp_dir=$(mktemp -d)
  tmp_dirs+=("$temp_dir")
  printf -v "$variable_name" '%s' "$temp_dir"
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

read_secret_key() {
  local secret_name="$1"
  local key="$2"
  local encoded_value=""

  encoded_value=$(oc get secret "$secret_name" -n "$namespace" -o "jsonpath={.data.$key}")
  if [[ -z "$encoded_value" ]]; then
    error "secret '$secret_name' does not contain key '$key'"
    exit 1
  fi

  printf '%s' "$encoded_value" | base64_decode
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      -n)
        if (($# < 2)); then
          error "-n requires a namespace"
          usage >&2
          exit 2
        fi
        namespace="$2"
        shift 2
        ;;
      -i)
        if (($# < 2)); then
          error "-i requires an image"
          usage >&2
          exit 2
        fi
        image="$2"
        shift 2
        ;;
      -a | --autodeploy)
        autodeploy=true
        shift
        ;;
      --branch)
        if (($# < 2)); then
          error "--branch requires a branch name"
          usage >&2
          exit 2
        fi
        deployment_branch="$2"
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

  if [[ -z "$namespace" ]]; then
    error "-n <namespace> is required"
    usage >&2
    exit 2
  fi

  if [[ "$deployment_branch" == -* \
    || "$deployment_branch" == *..* \
    || "$deployment_branch" == *~* \
    || "$deployment_branch" == *^* \
    || "$deployment_branch" == *:* \
    || "$deployment_branch" == *' '* \
    || "$deployment_branch" == */ \
    || "$deployment_branch" == .* ]]; then
    error "invalid deployment branch: '$deployment_branch'"
    exit 2
  fi
}

check_preconditions() {
  need_command oc

  if ! oc whoami >/dev/null 2>&1; then
    error "oc whoami failed; log in with 'oc login' and try again"
    exit 1
  fi

  if ! oc get namespace "$namespace" >/dev/null 2>&1; then
    error "namespace '$namespace' does not exist or is not accessible"
    exit 1
  fi

  if [[ ! -f "$ENV_FILE" ]]; then
    error "$ENV_FILE is missing; create it from .env.production.example"
    exit 1
  fi
}

ensure_postgres_secret() {
  local postgres_password=""

  need_command openssl
  need_command base64

  if oc get secret "$POSTGRES_SECRET" -n "$namespace" >/dev/null 2>&1; then
    postgres_password=$(read_secret_key "$POSTGRES_SECRET" POSTGRES_PASSWORD)
  else
    postgres_password=$(openssl rand -hex 16)
    # stdout of this function is captured as the password — keep oc output away from it
    oc create secret generic "$POSTGRES_SECRET" \
      -n "$namespace" \
      --from-literal=POSTGRES_USER=app \
      --from-literal=POSTGRES_PASSWORD="$postgres_password" \
      --from-literal=POSTGRES_DB=app \
      --dry-run=client \
      -o yaml \
      | oc apply -n "$namespace" -f - >&2
  fi

  printf '%s' "$postgres_password"
}

configure_database() {
  local postgres_password=""

  if database_url=$(env_file_value DATABASE_URL "$ENV_FILE"); then
    if [[ -n "$database_url" ]]; then
      external_db_used=true
      info "DATABASE_URL found in $ENV_FILE; using the external database."
      return
    fi
  else
    database_url=""
  fi

  if [[ ! -f "$POSTGRES_MANIFEST" ]]; then
    return
  fi

  info "no DATABASE_URL found -> deploying in-cluster PostgreSQL (pilot/demo grade; set DATABASE_URL in $ENV_FILE for a managed database)."

  postgres_password=$(ensure_postgres_secret)
  oc apply -n "$namespace" -f "$POSTGRES_MANIFEST"
  oc rollout status -n "$namespace" deploy/postgresql

  database_url="postgres://app:${postgres_password}@postgresql:5432/app"
  in_cluster_db_used=true
}

ensure_route() {
  oc apply -n "$namespace" -f "$OPENSHIFT_DIR/route.yaml"
}

derive_env_values() {
  local env_secret_file="$1"
  local auth_url=""
  local derived_env_file="${env_secret_file}.derived"

  auth_url=$(env_file_value BETTER_AUTH_URL "$env_secret_file" || true)
  if [[ -n "$auth_url" && "$auth_url" != "https://cen-starter.example.com" ]]; then
    return
  fi

  if [[ -z "$route_url" ]]; then
    warning "could not derive BETTER_AUTH_URL because the OpenShift route URL is unavailable"
    return
  fi

  tmp_files+=("$derived_env_file")
  sed '/^BETTER_AUTH_URL=/d;/^export BETTER_AUTH_URL=/d' "$env_secret_file" > "$derived_env_file"
  printf '\nBETTER_AUTH_URL=%s\n' "$route_url" >> "$derived_env_file"
  mv "$derived_env_file" "$env_secret_file"

  derived_env_summary+=("BETTER_AUTH_URL=$route_url")
  info "derived BETTER_AUTH_URL=$route_url (set it in $ENV_FILE to override)"
}

create_app_secret() {
  local env_secret_file

  make_temp_file env_secret_file

  if [[ "$in_cluster_db_used" == "true" ]]; then
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
      -e '/^[[:space:]]*#/d' \
      -e '/^[[:space:]]*$/d' \
      -e '/^[A-Za-z_][A-Za-z0-9_]*=[[:space:]]*$/d' \
      -e '/^DATABASE_URL=/d' \
      "$ENV_FILE" > "$env_secret_file"
    printf '\nDATABASE_URL=%s\n' "$database_url" >> "$env_secret_file"
  else
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
      -e '/^[[:space:]]*#/d' \
      -e '/^[[:space:]]*$/d' \
      -e '/^[A-Za-z_][A-Za-z0-9_]*=[[:space:]]*$/d' \
      "$ENV_FILE" > "$env_secret_file"
  fi

  derive_env_values "$env_secret_file"

  oc create secret generic "$APP_SECRET" \
    --from-env-file="$env_secret_file" \
    --dry-run=client \
    -o yaml \
    | oc apply -n "$namespace" -f -
}

parse_git_origin() {
  local remote_url=""
  local without_scheme=""
  local path=""
  local host=""
  local owner=""
  local repo=""

  if ! remote_url=$(git remote get-url origin 2>/dev/null); then
    error "--autodeploy requires a git remote named 'origin'"
    exit 1
  fi

  if [[ "$remote_url" == git@*:* ]]; then
    without_scheme="${remote_url#git@}"
    host="${without_scheme%%:*}"
    path="${without_scheme#*:}"
  elif [[ "$remote_url" == ssh://git@*/*/* ]]; then
    without_scheme="${remote_url#ssh://git@}"
    host="${without_scheme%%/*}"
    path="${without_scheme#*/}"
  elif [[ "$remote_url" == https://*/*/* ]]; then
    without_scheme="${remote_url#https://}"
    host="${without_scheme%%/*}"
    path="${without_scheme#*/}"
  else
    error "unsupported origin URL '$remote_url'; expected git@HOST:OWNER/REPO.git or https://HOST/OWNER/REPO.git"
    exit 1
  fi

  path="${path%.git}"
  if [[ "$path" != */* ]]; then
    error "could not derive git host/owner/repo from origin URL '$remote_url'"
    exit 1
  fi

  owner="${path%%/*}"
  repo="${path#*/}"

  if [[ -z "$host" || -z "$owner" || -z "$repo" || "$repo" == */* ]]; then
    error "could not derive git host/owner/repo from origin URL '$remote_url'"
    exit 1
  fi

  GIT_HOST="$host"
  GIT_OWNER="$owner"
  GIT_REPO="$repo"
  GIT_SSH_URL="git@${host}:${owner}/${repo}.git"
  GITHUB_REPO_API_PATH="repos/${owner}/${repo}"
}

check_github_preconditions() {
  need_command gh
  need_command ssh-keygen

  if ! gh auth status --hostname "$GIT_HOST" >/dev/null 2>&1; then
    error "GitHub CLI is not logged in to $GIT_HOST"
    printf 'Log in without pasting a token into chat:\n  gh auth login --hostname %s --web\n' \
      "$GIT_HOST" >&2
    exit 1
  fi

  if ! git ls-remote --exit-code origin "refs/heads/$deployment_branch" >/dev/null 2>&1; then
    error "origin has no reachable '$deployment_branch' branch; push it before deploying"
    exit 1
  fi
}

prepare_autodeploy() {
  [[ "$autodeploy" == "true" ]] || return

  parse_git_origin
  check_github_preconditions
}

github_deploy_key_present() {
  local public_key="$1"
  local public_key_material=""

  public_key_material=$(printf '%s\n' "$public_key" | awk '{print $2}')

  gh api \
    --hostname "$GIT_HOST" \
    --paginate \
    "$GITHUB_REPO_API_PATH/keys" \
    --jq '.[].key' 2>/dev/null \
    | awk '{print $2}' \
    | grep -Fqx "$public_key_material"
}

add_github_deploy_key() {
  local public_key="$1"

  gh api \
    --hostname "$GIT_HOST" \
    --method POST \
    "$GITHUB_REPO_API_PATH/keys" \
    -f "title=OpenShift ${namespace}" \
    -f "key=$public_key" \
    -F read_only=true >/dev/null
}

ensure_github_source_secret() {
  local key_dir=""
  local private_key=""
  local public_key_file=""
  local public_key=""
  local existing_private_key=""

  make_temp_dir key_dir
  private_key="${key_dir}/id_ed25519"
  public_key_file="${private_key}.pub"

  existing_private_key=$(oc get secret "$GITHUB_SOURCE_SECRET" \
    -n "$namespace" \
    -o 'jsonpath={.data.ssh-privatekey}' 2>/dev/null || true)

  if [[ -n "$existing_private_key" ]]; then
    printf '%s' "$existing_private_key" | base64_decode > "$private_key"
    chmod 600 "$private_key"
    ssh-keygen -y -f "$private_key" > "$public_key_file"
  else
    ssh-keygen -q -t ed25519 -N '' -C "openshift-${namespace}" -f "$private_key"
  fi

  public_key=$(<"$public_key_file")

  if ! github_deploy_key_present "$public_key"; then
    if ! add_github_deploy_key "$public_key"; then
      error "could not add the read-only deploy key to $GIT_HOST/$GIT_OWNER/$GIT_REPO"
      printf 'Your GitHub account needs repository administration permission.\n' >&2
      exit 1
    fi
    info "Added a read-only OpenShift deploy key to $GIT_HOST/$GIT_OWNER/$GIT_REPO."
  fi

  oc create secret generic "$GITHUB_SOURCE_SECRET" \
    -n "$namespace" \
    --type=kubernetes.io/ssh-auth \
    --from-file=ssh-privatekey="$private_key" \
    --dry-run=client \
    -o yaml \
    | oc apply -n "$namespace" -f -
}

ensure_github_webhook_secret() {
  local webhook_secret_value=""

  need_command openssl
  need_command base64

  if oc get secret "$GITHUB_WEBHOOK_SECRET" -n "$namespace" >/dev/null 2>&1; then
    webhook_secret_value=$(read_secret_key "$GITHUB_WEBHOOK_SECRET" "$GITHUB_WEBHOOK_KEY")
  else
    webhook_secret_value=$(openssl rand -hex 16)
    # stdout of this function is captured as the secret — keep oc output away from it
    oc create secret generic "$GITHUB_WEBHOOK_SECRET" \
      -n "$namespace" \
      --from-literal="$GITHUB_WEBHOOK_KEY=$webhook_secret_value" \
      --dry-run=client \
      -o yaml \
      | oc apply -n "$namespace" -f - >&2
  fi

  printf '%s' "$webhook_secret_value"
}

apply_build_resources() {
  cat <<EOF | oc apply -n "$namespace" -f -
apiVersion: image.openshift.io/v1
kind: ImageStream
metadata:
  name: $APP_NAME
  labels:
    app.kubernetes.io/name: $APP_NAME
---
apiVersion: build.openshift.io/v1
kind: BuildConfig
metadata:
  name: $APP_NAME
  labels:
    app.kubernetes.io/name: $APP_NAME
spec:
  runPolicy: SerialLatestOnly
  source:
    type: Git
    git:
      uri: "$GIT_SSH_URL"
      ref: "$deployment_branch"
    sourceSecret:
      name: $GITHUB_SOURCE_SECRET
  strategy:
    type: Docker
    dockerStrategy:
      dockerfilePath: deploy/Dockerfile
  output:
    to:
      kind: ImageStreamTag
      name: $APP_NAME:latest
  triggers:
    - type: GitHub
      github:
        secretReference:
          name: $GITHUB_WEBHOOK_SECRET
EOF
}

webhook_role_binding_manifest() {
  cat <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: $GITHUB_WEBHOOK_ROLE_BINDING
  labels:
    app.kubernetes.io/name: $APP_NAME
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: system:webhook
subjects:
  - apiGroup: rbac.authorization.k8s.io
    kind: Group
    name: system:unauthenticated
EOF
}

webhook_rbac_apply_was_forbidden() {
  case "$1" in
    *'Error from server (Forbidden)'* | *'reason: Forbidden'* | *'is forbidden:'* | *'not permitted'* | *'cannot bind'*)
      return 0
      ;;
    *) return 1 ;;
  esac
}

disable_webhook_rbac() {
  webhook_rbac_available=false
  webhook_rbac_reason="$1"
  warning "GitHub push automation is inactive: $webhook_rbac_reason."
  warning "Ask a project administrator to grant access to ClusterRole system:webhook, then rerun this command."
}

ensure_webhook_rbac() {
  local allowed=""
  local apply_output=""

  if ! oc get rolebinding "$GITHUB_WEBHOOK_ROLE_BINDING" -n "$namespace" >/dev/null 2>&1; then
    if ! allowed=$(oc auth can-i create rolebindings.rbac.authorization.k8s.io -n "$namespace"); then
      error "could not check permission to create the webhook RoleBinding"
      exit 1
    fi
    if [[ "$allowed" != "yes" ]]; then
      if [[ "$allowed" == "no" ]]; then
        disable_webhook_rbac "current user cannot create RoleBindings in namespace '$namespace'"
        return
      fi
      error "unexpected response while checking RoleBinding permission: '$allowed'"
      exit 1
    fi

    if ! allowed=$(oc auth can-i bind clusterroles.rbac.authorization.k8s.io/system:webhook -n "$namespace"); then
      error "could not check permission to bind ClusterRole system:webhook"
      exit 1
    fi
    if [[ "$allowed" != "yes" ]]; then
      if [[ "$allowed" == "no" ]]; then
        disable_webhook_rbac "current user cannot bind ClusterRole system:webhook in namespace '$namespace'"
        return
      fi
      error "unexpected response while checking ClusterRole binding permission: '$allowed'"
      exit 1
    fi
  fi

  if apply_output=$(webhook_role_binding_manifest | oc apply -n "$namespace" -f - 2>&1); then
    printf '%s\n' "$apply_output"
  else
    printf '%s\n' "$apply_output" >&2
    if webhook_rbac_apply_was_forbidden "$apply_output"; then
      disable_webhook_rbac "OpenShift rejected the webhook RoleBinding as forbidden"
      return
    fi
    exit 1
  fi
}

create_github_webhook() {
  local webhook_url="$1"
  local hooks_json=""
  local hook_id=""

  hooks_json=$(gh api \
    --hostname "$GIT_HOST" \
    --paginate \
    --slurp \
    "$GITHUB_REPO_API_PATH/hooks") || {
      error "could not inspect webhooks for $GIT_HOST/$GIT_OWNER/$GIT_REPO"
      exit 1
    }

  hook_id=$(printf '%s' "$hooks_json" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const hooks = JSON.parse(input || "[]").flat();
      const hook = hooks.find((candidate) => candidate.config?.url === process.argv[1]);
      if (hook) process.stdout.write(String(hook.id));
    });
  ' "$webhook_url")

  if [[ -z "$hook_id" ]]; then
    hook_id=$(gh api \
      --hostname "$GIT_HOST" \
      --method POST \
      "$GITHUB_REPO_API_PATH/hooks" \
      -f name=web \
      -F active=true \
      -f 'events[]=push' \
      -f "config[url]=$webhook_url" \
      -f 'config[content_type]=json' \
      -f 'config[insecure_ssl]=0' \
      --jq '.id') || {
        error "could not create the GitHub webhook; repository administration permission is required"
        exit 1
      }
    info "Created the GitHub webhook for $APP_NAME." >&2
  else
    info "GitHub webhook already exists for $APP_NAME." >&2
  fi

  printf '%s' "$hook_id"
}

verify_github_webhook() {
  local hook_id="$1"
  local delivery=""
  local delivery_id=""
  local status_code=""
  local previous_delivery_id=""
  local deadline=$((SECONDS + 45))

  previous_delivery_id=$(gh api \
    --hostname "$GIT_HOST" \
    "$GITHUB_REPO_API_PATH/hooks/$hook_id/deliveries?per_page=10" \
    --jq '[.[] | select(.event == "ping")][0].id // empty' \
    2>/dev/null || true)

  gh api \
    --hostname "$GIT_HOST" \
    --method POST \
    "$GITHUB_REPO_API_PATH/hooks/$hook_id/pings" >/dev/null || {
      error "could not request a GitHub webhook ping"
      exit 1
    }

  while ((SECONDS < deadline)); do
    delivery=$(gh api \
      --hostname "$GIT_HOST" \
      "$GITHUB_REPO_API_PATH/hooks/$hook_id/deliveries?per_page=10" \
      --jq '[.[] | select(.event == "ping")][0] | [.id, .status_code] | @tsv' \
      2>/dev/null || true)
    IFS=$'\t' read -r delivery_id status_code <<< "$delivery"

    if [[ -n "$delivery_id" \
      && "$delivery_id" != "$previous_delivery_id" \
      && "$status_code" =~ ^2[0-9][0-9]$ ]]; then
      info "Verified GitHub can reach the OpenShift webhook endpoint (HTTP $status_code)."
      return
    fi

    sleep 3
  done

  error "GitHub could not successfully deliver to the OpenShift webhook endpoint"
  if [[ -n "$status_code" ]]; then
    printf 'Latest ping returned HTTP %s. Inspect GitHub repository Settings → Webhooks.\n' \
      "$status_code" >&2
  fi
  exit 1
}

wait_for_build() {
  local build_ref="$1"
  local phase=""
  local deadline=$((SECONDS + 900))

  while true; do
    phase=$(oc get -n "$namespace" "$build_ref" -o jsonpath='{.status.phase}' 2>/dev/null || true)

    case "$phase" in
      Complete)
        info "Build $build_ref completed."
        return 0
        ;;
      Failed | Error | Cancelled)
        error "Build $build_ref ended with phase '$phase'."
        printf 'Inspect logs with: oc logs -n %s %s\n' "$namespace" "$build_ref" >&2
        oc logs -n "$namespace" "$build_ref" --tail=80 >&2 || true
        exit 1
        ;;
    esac

    if ((SECONDS >= deadline)); then
      error "timed out waiting for build $build_ref to complete"
      printf 'Inspect logs with: oc logs -n %s %s\n' "$namespace" "$build_ref" >&2
      exit 1
    fi

    sleep 5
  done
}

wait_for_autodeploy_image() {
  local current_image=""
  local deadline=$((SECONDS + 60))

  while ((SECONDS < deadline)); do
    current_image=$(oc get deployment "$APP_NAME" -n "$namespace" \
      -o "jsonpath={.spec.template.spec.containers[?(@.name=='$APP_CONTAINER')].image}" \
      2>/dev/null || true)
    if [[ "$current_image" == *"/${namespace}/${APP_NAME}@sha256:"* ]]; then
      info "Deployment observed the completed ImageStream build."
      return
    fi
    sleep 2
  done

  error "timed out waiting for the Deployment image trigger to observe the completed build"
  printf 'Inspect with: oc get deploy/%s istag/%s:latest -n %s -o yaml\n' \
    "$APP_NAME" "$APP_NAME" "$namespace" >&2
  exit 1
}

verify_service_endpoint() {
  local endpoint=""
  local deadline=$((SECONDS + 60))

  while ((SECONDS < deadline)); do
    endpoint=$(oc get endpoints "$APP_NAME" -n "$namespace" \
      -o 'jsonpath={.subsets[0].addresses[0].ip}' 2>/dev/null || true)
    if [[ -n "$endpoint" ]]; then
      info "Verified service '$APP_NAME' has a Ready endpoint."
      return
    fi
    sleep 2
  done

  error "service '$APP_NAME' has no Ready endpoint after rollout"
  oc get pods -n "$namespace" -l "app.kubernetes.io/name=$APP_NAME" >&2 || true
  exit 1
}

configure_autodeploy() {
  local webhook_secret_value=""
  local server_url=""
  local webhook_url=""
  local hook_id=""
  local started_build=""
  local build_ref=""

  need_command git
  need_command node

  if [[ -n "$image" ]]; then
    warning "--autodeploy uses the ImageStream build output; ignoring -i '$image'"
  fi

  ensure_github_source_secret
  webhook_secret_value=$(ensure_github_webhook_secret)

  apply_build_resources
  oc set build-secret -n "$namespace" --source "bc/$APP_NAME" "$GITHUB_SOURCE_SECRET"
  oc set triggers -n "$namespace" "deploy/$APP_NAME" --from-image="$APP_NAME:latest" -c "$APP_CONTAINER"

  ensure_webhook_rbac
  if [[ "$webhook_rbac_available" == "true" ]]; then
    server_url=$(oc whoami --show-server)
    server_url="${server_url%/}"
    webhook_url="${server_url}/apis/build.openshift.io/v1/namespaces/${namespace}/buildconfigs/${APP_NAME}/webhooks/${webhook_secret_value}/github"
    hook_id=$(create_github_webhook "$webhook_url")
    verify_github_webhook "$hook_id"
  fi

  started_build=$(oc start-build -n "$namespace" "$APP_NAME" -o name)
  build_ref="build/${started_build##*/}"
  info "Started $build_ref."
  wait_for_build "$build_ref"
  wait_for_autodeploy_image
}

capture_route_url() {
  local host=""
  local tls_termination=""
  local scheme="http"

  host=$(oc get route "$APP_NAME" -n "$namespace" -o jsonpath='{.spec.host}' 2>/dev/null || true)
  if [[ -z "$host" ]]; then
    route_url=""
    return
  fi

  tls_termination=$(oc get route "$APP_NAME" -n "$namespace" -o jsonpath='{.spec.tls.termination}' 2>/dev/null || true)
  if [[ -n "$tls_termination" ]]; then
    scheme="https"
  fi

  route_url="${scheme}://${host}"
}

print_summary() {
  local derived_value=""

  capture_route_url

  info ""
  info "Deployment summary"
  if [[ -n "$route_url" ]]; then
    info "Route: $route_url"
  else
    info "Route: not found"
  fi

  if [[ "$in_cluster_db_used" == "true" ]]; then
    info "Database: in-cluster PostgreSQL"
  elif [[ "$external_db_used" == "true" ]]; then
    info "Database: external DATABASE_URL from $ENV_FILE"
  else
    info "Database: not configured by this script"
  fi

  if [[ "$autodeploy" == "true" ]]; then
    if [[ "$webhook_rbac_available" == "true" ]]; then
      info "Autodeploy: git push to $deployment_branch now builds and deploys automatically"
    else
      info "Autodeploy: inactive ($webhook_rbac_reason)"
    fi
  fi

  if ((${#derived_env_summary[@]} > 0)); then
    for derived_value in "${derived_env_summary[@]}"; do
      info "Derived env: $derived_value"
    done
  fi
}

parse_args "$@"
check_preconditions
prepare_autodeploy
configure_database
ensure_route
capture_route_url
create_app_secret

oc apply -n "$namespace" -k "$OPENSHIFT_DIR"

if [[ "$autodeploy" == "true" ]]; then
  configure_autodeploy
elif [[ -n "$image" ]]; then
  oc set image -n "$namespace" "deploy/$APP_NAME" "$APP_CONTAINER=$image"
fi

# Secret-only changes do not alter the pod template. Restart deliberately so every rerun
# deploys the just-synchronized environment, even when the image digest is unchanged.
oc rollout restart -n "$namespace" "deploy/$APP_NAME"
oc rollout status -n "$namespace" "deploy/$APP_NAME" --timeout=15m
verify_service_endpoint
print_summary
