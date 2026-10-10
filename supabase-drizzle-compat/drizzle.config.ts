import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// TARGET selects which project drizzle-kit talks to (MULTIGRES or NORMAL).
const target = (process.env.TARGET ?? 'NORMAL').toUpperCase();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  entities: { roles: { provider: 'supabase' } },
  tablesFilter: ['compat_todos'],
  schemaFilter: ['public'],
  dbCredentials: { url: process.env[`${target}_DATABASE_URL`] ?? '' },
});
