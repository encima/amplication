# Findings: first run (2026-10-10)

Projects: Multigres `bmnpsxdvhhqludeqpmwl`, normal `bioachdfvrtohvdvoaby` (both `*.supabase.red`).

The first run was from a sandbox that only allows outbound HTTPS. Postgres on 5432 was
unreachable, so every Drizzle, RLS, PostgREST and `postgres_changes` check was skipped.
Run `npm test` from a machine with direct DB access to fill those in.

| check | multigres | normal |
| --- | --- | --- |
| auth.health | ✅ GoTrue v2.196.0 | ✅ GoTrue v2.198.0-rc.21 |
| auth.settings | ✅ | ✅ |
| auth.admin.createUser | ✅ | ✅ |
| auth.signInWithPassword | ✅ | ❌ 500 `Database error granting user` |
| auth.jwks.verify (ES256) | ✅ | ⏭️ (no session) |
| auth.getClaims / getUser / refreshSession | ✅ | ⏭️ (no session) |
| auth.signInAnonymously | ❌ disabled (config) | ❌ disabled (config) |
| realtime.broadcast (ws) | ❌ `Tenant not found` | ✅ |
| realtime.broadcast (HTTP send) | ❌ `Tenant not found` | ✅ |
| realtime.presence | ❌ `Tenant not found` | ✅ |
| db.* / rest.* / realtime.postgresChanges.* | ⏭️ not reachable from sandbox | ⏭️ not reachable from sandbox |

## Issues

1. **Multigres: Realtime is not provisioned.** The websocket upgrade to
   `/realtime/v1/websocket` returns `404 {"error":"Tenant not found"}`, so supabase-js
   reports `CHANNEL_ERROR: transport failure`. Broadcast, presence and `postgres_changes`
   all fail. The same client code works against the normal project. This blocks the
   realtime part of the test until the Realtime tenant exists for the project.
2. **Normal project: password sign-in fails with 500.** `POST /auth/v1/token?grant_type=password`
   returns `{"code":500,"error_code":"unexpected_failure","msg":"Database error granting user"}`
   for a confirmed user created with the admin API. It reproduces every time (error_ids
   `01a12437-6321-7daf-ba6c-922915f3283d`, `01a12437-649f-7839-ba35-305f650020f5`).
   The same flow works on Multigres. Admin `generate_link` and `createUser` work, so the
   failure is in creating the session/refresh token. This project runs an RC GoTrue
   (v2.198.0-rc.21), so it's worth checking the auth logs, any custom access-token hook,
   and whether the `auth` schema migrations finished. This isn't a Multigres problem, but
   it does block the baseline comparison for anything that needs a session (RLS via
   PostgREST, `postgres_changes` with a user JWT).

## Other differences

- **GoTrue versions differ:** v2.196.0 (Multigres) vs v2.198.0-rc.21 (normal).
- **DB networking differs:** the Multigres host `db.<ref>` is a CNAME to an Envoy gateway
  NLB with IPv4 and IPv6 addresses, and needs `sslmode=require&sslnegotiation=direct`. The
  normal host is a single AAAA record (IPv6 only), as is usual for direct connections.
  `postgres` (v3.4.9) and `pg` (v8.23) both accept `sslnegotiation=direct`. Older driver
  versions may not, so pin at least these when targeting Multigres.
- **Signup rejects `@example.com` addresses** (`email_address_invalid`) on the normal
  project, so the harness creates users with the admin API instead.
- **Anonymous sign-ins are disabled on both projects.** That's a config difference from
  the defaults, not a Multigres incompatibility.

## Still to verify with DB access

The harness already covers these, so run it from a machine with DB access:

- Drizzle migrator on Multigres: `CREATE TABLE … GENERATED ALWAYS AS IDENTITY`, FK to `auth.users`,
  `ENABLE ROW LEVEL SECURITY`, `CREATE POLICY … (select auth.uid())`, `ALTER PUBLICATION supabase_realtime`.
- `SET LOCAL ROLE` + `set_config('request.jwt.claims', …, true)` inside a transaction
  (the Drizzle Supabase RLS pattern) through the Multigres gateway.
- Named server-side prepared statements (`.prepare()`), which commonly break behind poolers.
- `drizzle-kit pull` catalog introspection.
- `NOTIFY pgrst, 'reload schema'` reaching PostgREST.
