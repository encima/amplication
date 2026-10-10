# Supabase + Drizzle compatibility harness (Multigres vs Postgres)

Runs the same Drizzle/Supabase workload against a Multigres-backed project and a regular
Postgres project, then writes a side-by-side report to `reports/report.md` (and raw
results to `reports/results.json`).

## What it tests

| Area | Checks |
| --- | --- |
| Auth | health, settings, admin createUser, password sign-in, JWKS verification of the access token (`jose`), `getClaims`, `getUser`, refresh, anonymous sign-in |
| Tables (Drizzle) | `drizzle-orm` migrator applies `drizzle/` (table + FK to `auth.users` + RLS + 4 `pgPolicy`s + realtime publication), named prepared statements, `drizzle-kit pull` introspection |
| RLS | Drizzle queries as `authenticated` with `request.jwt.claims` (own rows only, spoofed insert rejected with 42501, `anon` sees nothing); PostgREST insert/select/update isolation via supabase-js |
| Realtime | broadcast (websocket + HTTP send), presence, `postgres_changes` INSERT/UPDATE/DELETE with RLS filtering of other users' rows |

All objects are created fresh (`compat_todos`, `drizzle.__compat_migrations`, `compat-*@example.com` users) and removed at the end.

## Running

```sh
cp .env.example .env   # fill in both projects
npm install
npm test                    # postgres-js driver
npm run test:node-postgres  # same run over node-postgres
TARGETS=multigres npm test  # one project only
```

The direct DB host for a regular project is IPv6-only. On an IPv4-only network, use the
session pooler URI for `NORMAL_DATABASE_URL` instead.

See [FINDINGS.md](./FINDINGS.md) for the results of the first run.
