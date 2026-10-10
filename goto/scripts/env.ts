import { existsSync, readdirSync } from 'node:fs';
import { config } from 'dotenv';

export interface TargetEnv {
  name: string;
  url: string;
  publishableKey: string;
  secretKey: string;
  databaseUrl: string;
}

/** Targets that have a .env.<name>.local file. */
export function availableTargets(): string[] {
  return readdirSync('.')
    .map((f) => f.match(/^\.env\.(.+)\.local$/)?.[1])
    .filter((n): n is string => !!n);
}

/** Load .env.<name>.local without leaking values between targets. */
export function loadTarget(name: string): TargetEnv {
  const path = `.env.${name}.local`;
  if (!existsSync(path)) {
    throw new Error(`No ${path}. Copy .env.example to ${path} and fill it in. Found: ${availableTargets().join(', ') || 'none'}`);
  }
  const env: Record<string, string> = {};
  config({ path, processEnv: env, quiet: true });
  const required = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY'];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new Error(`${path} is missing ${missing.join(', ')}`);
  return {
    name,
    url: env.VITE_SUPABASE_URL.replace(/\/$/, ''),
    publishableKey: env.VITE_SUPABASE_PUBLISHABLE_KEY,
    secretKey: env.SUPABASE_SECRET_KEY,
    databaseUrl: env.DATABASE_URL ?? '',
  };
}

export function targetFromArgs(): TargetEnv {
  const name = process.argv[2];
  if (!name) throw new Error(`Usage: <script> <target>. Available: ${availableTargets().join(', ') || 'none'}`);
  return loadTarget(name);
}
