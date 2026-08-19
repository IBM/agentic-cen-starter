# Deploy to IBM Cloud Code Engine

> 🤖 **With your agent:** "Deploy this to Code Engine, project `<name>`." — the
> `deploy-code-engine` skill runs this guide and verifies the result. The rest of this
> page is the same work by hand.

One container (API + built SPA, port 8080, migrations applied at boot), run as a
serverless Code Engine app. `deploy/ce-deploy.sh` does the heavy lifting and is safe to
rerun — it builds the image **in the cloud** from your working tree, so you don't need
Docker locally. Reference details: [deploy/README.md](../deploy/README.md).

## Before you start

1. **IBM Cloud CLI + plugins:**

   ```bash
   curl -fsSL https://clis.cloud.ibm.com/install/osx | sh   # or /linux
   ibmcloud plugin install code-engine container-registry
   ibmcloud login --sso
   ibmcloud target -g <resource-group>     # or pass -g to the script
   ibmcloud target -r <region>             # or pass --region to the script
   ```

2. **A PostgreSQL database** reachable from IBM Cloud — typically
   [Databases for PostgreSQL](https://cloud.ibm.com/databases/databases-for-postgresql/create).
   Grab its connection string for `DATABASE_URL`. (Code Engine has no in-cluster database
   option — the script requires `DATABASE_URL` and tells you if it's missing.)

   Use an **empty** database. Migrations run at boot, so an instance that already holds the
   app's tables fails with `relation "..." already exists`.

You do **not** need to create the Code Engine project, the registry namespace, or the
registry secret — the script creates whatever is missing.

### Database TLS

IBM Cloud Databases issues certificates from its own private CA (`CN=IBM Cloud Databases`),
not a public one. `pg` verifies certificates by default, so the connection string ICD gives
you fails at boot with `SELF_SIGNED_CERT_IN_CHAIN`. Export the CA and keep verification on:

```bash
ibmcloud cdb deployment-cacert <deployment-name> > icd-ca.pem
base64 -i icd-ca.pem | tr -d '\n'      # paste into DATABASE_CA_CERT
```

Keep `sslmode=verify-full` in `DATABASE_URL`; the CA in `DATABASE_CA_CERT` takes precedence
over any SSL parameters in the URL. The certificate's SANs include the connection hostname, so
full verification succeeds.

The alternative is `sslmode=no-verify`, which encrypts the connection but does not authenticate
the server, leaving it open to interception between Code Engine and the database. It's a demo
shortcut, not a default. The deploy script refuses to run against an ICD host with neither
configured, and prints both options.

## Configure production values

Run `./deploy/ce-deploy.sh -p <project-name>` once. When `.env.production` is absent, the
command creates it from the example with mode `0600` and exits before changing IBM Cloud.
Fill it locally and rerun; never commit it or paste its contents into chat.

- `DATABASE_URL` — the connection string from above.
- `DATABASE_CA_CERT` — see [Database TLS](#database-tls) above.
- Secrets you own — `BETTER_AUTH_SECRET` (`openssl rand -hex 32`), or on the oauth-proxy
  flavor the IdP client values (`OAUTH2_PROXY_OIDC_ISSUER_URL`, `OAUTH2_PROXY_CLIENT_ID`,
  `OAUTH2_PROXY_CLIENT_SECRET`). The IdP is normally IBM App ID: the issuer is
  `https://<region>.appid.cloud.ibm.com/oauth/v4/<tenantId>` and `OAUTH2_PROXY_PROVIDER` stays
  `oidc` — oauth2-proxy has no `ibm`/`appid` provider. The Dex setup in `docker-compose.yml` is
  local development only. Register the printed `/oauth2/callback` URL in App ID under Manage
  Authentication → redirect URIs.
- URL-dependent values — **leave them on the example values.** The script reads the real
  app URL from Code Engine and injects them into the app secret itself (`BETTER_AUTH_URL`;
  on the oauth-proxy flavor `OAUTH2_PROXY_REDIRECT_URL`, `OAUTH2_PROXY_UPSTREAMS`, and a
  generated-once `OAUTH2_PROXY_COOKIE_SECRET`). Every derived value is printed in the
  deploy summary.
- `IAM_API_KEY` — only needed the very first time, so the script can create the registry
  secret. Use an existing key from [API keys](https://cloud.ibm.com/iam/apikeys), or ask your
  agent to create a clearly named, dedicated deployment key. The agent must ask before creating
  it and save it locally without displaying it. Put an existing key in `.env.production` (it
  never reaches the app) or export `IBMCLOUD_API_KEY` instead.

## Deploy

```bash
./deploy/ce-deploy.sh -p <project-name>
```

One command, first time and every time after. It selects or creates the project, ensures
the registry namespace and secret, uploads your working tree for a cloud-side image build,
creates or updates the `app-env` secret and the app, then derives the URL-dependent values
and rolls a fresh revision with them. On the oauth-proxy flavor it also deploys the
`oauth2-proxy` front app and switches the main app to project-only visibility, so identity
headers can't be spoofed from the internet — the URL you share is the proxy's.

Flags: `-g <resource-group>` to target one, `-r <registry-namespace>` to override the
default (derived from the project name; ICR namespaces are account-global), and
`--region <region>` to select the Code Engine region explicitly.

The command waits for new projects and application revisions, applies HTTP readiness and
liveness probes against `/api/health`, and reconciles runtime settings on updates as well as
creates. If the registry secret already exists, omit the API key to reuse it or provide one
to rotate its credentials.

## Verify

The summary prints the application URL (on oauth-proxy: the proxy URL — the main app is
project-only by design).

```bash
curl https://<app-url>/api/health        # {"status":"ok"}
```

Open the URL and log in end-to-end. If auth fails, compare the `Derived env:` lines from
the summary — an explicit override in `.env.production` that drifted from the real URL is
the usual cause. Promote the first admin by setting `role = 'admin'` on that user's row in
the database.

## Updating

- **New code:** rerun `./deploy/ce-deploy.sh -p <project>`. It rebuilds from your working
  tree and rolls a new revision. Schema changes need nothing extra — the new image migrates
  at boot before serving.
- **Env change:** edit `.env.production`, rerun the script — it re-applies the secret and
  rolls a new revision.
- Every update is a new revision; rollback means routing traffic back to the previous one.

Something broken? Ask your agent — the `debug-code-engine` skill exists for exactly that.
