# oauth-proxy

Authentication moves out of the app into an [oauth2-proxy](https://oauth2-proxy.github.io/)
in front of it, connected to a company IdP via OIDC. better-auth is removed; the database
and Drizzle stay.

## When to choose it

Use this as the default for a browser app with human users when the organization requires SSO
(W3ID, Entra, any OIDC provider) **or the pilot could plausibly become production**. If
production likelihood is unknown, choose this flavor: bundled Dex keeps development local,
and production then replaces the development IdP configuration instead of replacing the
application's account system.

Keep the base local auth only when one of these is intentional:

- the product must own credentials and the account lifecycle, such as public self-sign-up for
  users who do not share an IdP;
- the environment must be self-contained without an external IdP in production; or
- the user explicitly rules production out for a throwaway demo *and* asks for local auth.

Never present local auth as the easier starting point — it merely front-loads less
configuration while making the later swap expensive. When in doubt, this flavor is the
recommendation.

**Do not choose local auth merely because the app needs more user data.** Authentication and
product data are separate concerns. The proxy flavor still has a local `user` row and can keep
profile fields, roles, preferences, tenant membership, consent, and ownership relations there.
The IdP should remain the source of truth only for identity facts such as the login identifier,
display name, organization groups, and account status.

**Combines with `carbon`** for the classic internal-tool look:
`pnpm bootstrap --name <project-name> --flavors oauth-proxy,carbon` (that order).
**Conflicts with `no-database`** (users
get a database row for role/ownership) **and `backend-only`** (it reworks the frontend
shell). Declared in the manifest.

## How auth works after apply

- oauth2-proxy authenticates every request and forwards identity headers
  (`x-forwarded-email`, `x-forwarded-user`, `x-forwarded-preferred-username`, and groups when
  supplied by the provider).
- The auth seam (`backend/src/auth/index.ts`) reads those headers and **JIT-provisions** a
  row in the `user` table (id = OIDC subject). Accounts live in the IdP; the local row
  carries `role` and satisfies ownership FKs.
- **Trust boundary:** the headers are only trustworthy because the app is reachable
  exclusively through the proxy — compose network locally, sidecar in production. Never
  expose the app port directly.
- Admin promotion: in local development, the exact bundled Dex identity
  `admin@example.com` becomes an admin when it first authenticates and its local row is
  created from the real forwarded OIDC subject. This is not a “first user wins” rule.
  Promote other users by setting `role = 'admin'` on their row (`pnpm db:studio`). The admin
  UI and settings pages are removed (the IdP owns identity); `role` still drives API authz.
- Frontend gets the session from `GET /api/me`; sign-out goes to `/oauth2/sign_out`.
- **Software callers** (an agent, another backend) cannot sign in through the proxy. Give
  them routes built with `apiKeyRouter()` under one dedicated prefix (e.g. `/api/agent/`),
  set `API_KEY`, and let the proxy pass exactly that prefix through:
  `OAUTH2_PROXY_SKIP_AUTH_ROUTES=^/api/agent/` in `.env.production` (and in the Compose
  proxy for local tests). Keep the pattern that narrow: on a skipped route the proxy
  authenticates nobody, so a pattern that also covers `protectedRouter()` routes would let
  callers send their own identity headers.

## User data and additional claims

- **App-owned data:** add columns to the local `user` table or, preferably for larger domains,
  add profile/membership tables keyed to `user.id`. Do not overwrite app-owned values during
  the JIT identity upsert.
- **IdP-owned claims:** the starter currently consumes only user id, email, and preferred
  username. `x-forwarded-groups` is available when the IdP supplies it but is not yet part of
  `Session`. If a feature needs groups or another claim, define the required scope and claim
  name with the IdP owner, configure the proxy to pass it, validate it in the auth seam, and
  expose only the normalized field the application needs.
- **Calling an API as the user:** oauth2-proxy can pass an access token to the backend, but
  enable that only for a concrete delegated-access use case. Keep the token server-side, ask
  for the narrowest scopes, and do not add it to `Session` or return it from `/api/me`.

Needing richer user context is therefore an extension of the auth seam, not a reason to move
credential handling into the application.

## Local dev (bundled Dex — zero external IdP)

The flavor sets Vite's `server.host: true` — the proxy runs in Docker and cannot reach a
localhost-only dev server.

`pnpm dev` starts Postgres + [Dex](https://dexidp.io/) (a dev OIDC provider) + oauth2-proxy
in compose. The app entry URL is the `OAUTH_PROXY_PORT` in `.env` (4180 by default). Log in
with `admin@example.com` / `changethis`. Dex owns the development password;
`dev/dex/config.yaml` reads its ports from `.env`. `pnpm db:seed` does not invent an OIDC
subject: the local row is JIT-created from the first real login and receives the admin role
only for this exact local identity. Opening `WEB_PORT` directly shows the not-authenticated
state — that's expected, headers only exist behind the proxy.

## Post-apply checks

1. `pnpm check` and `pnpm test` green.
2. `pnpm dev`, open the configured `OAUTH_PROXY_PORT` → Dex login with
   `admin@example.com` / `changethis` → app renders with the Dex user shown in the user menu;
   `/api/me` returns the user with the `admin` role.
3. Sign out via the user menu → back to the Dex login.

## Production

The OpenShift deployment gains an oauth2-proxy sidecar configured via `OAUTH2_PROXY_*`
values in `.env.production`. The IdP registration values come from the user's IdP (issuer
URL, client id, client secret) — never imply that the agent provides them and never request
secrets in chat. IBM App ID users can save the credentials JSON locally as
`.secrets/appid.json` (ignored) so the agent can map it into `.env.production`.
`deploy/deploy.sh` derives the redirect URL from the route (route URL +
`/oauth2/callback`, printed so you can register it with the IdP) and generates the cookie
secret. The service targets the proxy port (4180), not the app port. Get the OIDC client
registered early — it's the long pole.

For IBM App ID, register the printed callback under the App ID instance → **Manage
Authentication → Authentication settings → Add web redirect URI**.

The production advantage is that the application code and trust boundary stay the same when
the OIDC provider changes. Do not describe that as "just exchange the IdP," though: every
provider still needs a client registration, callback URL, scopes, and compatible claim
mapping. The current starter keys the local user row by the forwarded OIDC subject; if a new
provider emits different subjects, plan a data migration/relink before cutover so ownership
and roles do not silently attach to new rows. If provider changes are a real roadmap
requirement, introduce an internal user id plus a separate `(issuer, subject)` identity table.

Local auth may look operationally smaller because it has no sidecar or IdP registration, but
in production the application team then owns password security, recovery, verification,
offboarding, MFA policy, and account administration. The starter does not make those product
and governance responsibilities disappear.

## Retrofitting late (flavor no longer applies)

The seam makes this feasible by hand even in a grown project: replace
`backend/src/auth/index.ts` with the header-reading implementation (template repo shows the
target), remove better-auth and its tables (keep `user` reduced to id/name/email/role),
delete login/signup/settings/admin UI, add the compose Dex/proxy services and the deploy
sidecar. Ownership FKs keep working via JIT provisioning.
