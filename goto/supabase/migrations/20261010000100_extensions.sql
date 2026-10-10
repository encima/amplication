-- Extensions used by GoTo.
--   citext       case-insensitive slugs and usernames
--   pg_trgm      fuzzy search over slugs and titles
--   moddatetime  keeps updated_at current
--   pg_cron      scheduled maintenance jobs
--   pg_net       async HTTP from the database (link health checks)
create extension if not exists citext with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists moddatetime with schema extensions;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
