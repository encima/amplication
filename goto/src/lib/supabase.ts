import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error(
    `Missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY for mode "${import.meta.env.MODE}". ` +
      `Create .env.${import.meta.env.MODE}.local from .env.example.`,
  );
}

export const supabase = createClient(url, key);
export const target = { mode: import.meta.env.MODE, url };

export interface Link {
  id: number;
  owner_id: string;
  slug: string;
  url: string;
  title: string | null;
  is_public: boolean;
  expires_at: string | null;
  icon_path: string | null;
  click_count: number;
  last_checked_at: string | null;
  last_status: number | null;
  created_at: string;
}

export interface Profile {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_path: string | null;
  is_anonymous: boolean;
}

export function iconUrl(path: string | null): string | null {
  return path ? supabase.storage.from('link-icons').getPublicUrl(path).data.publicUrl : null;
}
