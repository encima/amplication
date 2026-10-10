# Findings

## Local Supabase stack (baseline)

`supabase start` (CLI 2.120, Postgres 17.11.0.004, Realtime v2.140.10, Storage v1.79.36):
all six migrations apply, and `npm run test:target -- localstack` passes **45 of 46** checks.
The one failure, `auth.provider.google`, came from the sandbox the run was made in: the
local Auth container could not verify Google's TLS certificate through that network's
proxy. It's unrelated to GoTo.

Issues found while building GoTo:

- **citext with `search_path = ''`.** In a `security definer` function with an empty
  search path, `slug = p_slug::extensions.citext` silently uses case-sensitive `text`
  equality, because citext's `=` lives in `extensions`. Use `operator(extensions.=)`.
  `resolve_link` does this.
- **React StrictMode double effects.** In dev, the redirect page called `resolve_link`
  twice, counting two clicks. A private-channel subscription made after an async
  `setAuth()` also leaked a second channel. Both are fixed in the app.

## Multigres vs normal project (2026-10-10, HTTP-only run)

From the earlier compatibility harness. Direct Postgres was unreachable from the sandbox,
so these cover Auth and Realtime only.

| check | multigres | normal |
| --- | --- | --- |
| Auth server | GoTrue v2.196.0 | GoTrue v2.198.0-rc.21 |
| password sign-in | ✅ | ❌ 500 `Database error granting user` |
| JWKS verification (ES256), getClaims, refresh | ✅ | not run (no session) |
| anonymous sign-in | disabled in settings | disabled in settings |
| Realtime broadcast / presence | ❌ `Tenant not found` (404 on websocket upgrade) | ✅ |

- **Multigres: Realtime tenant not provisioned.** Every Realtime feature in GoTo
  (live counts, click feed) needs it.
- **Normal project: password grant returns 500** for confirmed users (error ids
  `01a12437-6321-7daf-ba6c-922915f3283d`, `01a12437-649f-7839-ba35-305f650020f5`).
- **Anonymous sign-ins and the GitHub/Google providers are off on both projects.** Run
  `supabase config push` or set them in the dashboard before testing GoTo.
- **DB networking:** the Multigres DB host is an IPv4+IPv6 gateway that needs
  `sslnegotiation=direct` (supported by `postgres` ≥ 3.4.9 and `pg` ≥ 8.23). The normal
  project's direct host is IPv6-only.

Next: deploy GoTo to both projects (`npm run db:push -- <target>` plus auth config), then
`npm run test:compare`, and record the results here.
