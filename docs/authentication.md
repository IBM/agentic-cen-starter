# Choosing authentication

Two setups, one decision, made once at bootstrap.

| | Base (local auth) | `oauth-proxy` flavor |
|---|---|---|
| Who owns identity | the app | your company IdP, via OAuth2 Proxy |
| Sign-in | email + password (better-auth) | redirect to the IdP |
| Local development | seeded admin | bundled Dex test IdP, no registration needed |
| App URL in dev | http://localhost:5173 | http://localhost:4180 |

Both start with the same development admin: **admin@example.com** / **changethis**.

## Default: the OAuth proxy

For a browser app with human users, choose `oauth-proxy` when company SSO is required **or
the pilot could plausibly become production**:

```bash
pnpm bootstrap --name my-app --flavors oauth-proxy
```

Local development needs no external IdP and no client registration — `pnpm dev` starts a
bundled Dex test identity provider alongside OAuth2 Proxy. Dex and proxy ports are ordinary
`.env` settings if 4180 is occupied.

## When to keep local auth

Keep the base setup when:

- the product itself must own accounts and credentials — for example public self-sign-up
  across customers with no shared IdP; or
- it's a deliberately throwaway demo where production identity is out of scope.

The amount of app data attached to a user is **not** a reason to choose local auth. The proxy
flavor keeps a local user row for roles, ownership, preferences, and other product data, while
the IdP owns identity.

## Production caveats

The proxy makes changing OIDC providers *mostly* an infrastructure concern, but not a
guaranteed zero-code swap. A new provider still needs:

- a client registration, and
- a compatible claim contract.

If the provider's stable user identifier changes, existing user-owned data must be migrated or
relinked. Plan for that before switching providers in a live deployment.

Working with an agent? The guided setup skill walks through this decision with you.
