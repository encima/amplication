import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { supabase, target } from '../lib/supabase';

type State = 'checking' | 'ok' | string;

// Quick health view of each Supabase service for the selected target.
export function StatusPanel({ session }: { session: Session | null }) {
  const [status, setStatus] = useState<Record<string, State>>({});

  useEffect(() => {
    const set = (k: string, v: State) => setStatus((s) => ({ ...s, [k]: v }));
    const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

    set('auth', 'checking');
    fetch(`${target.url}/auth/v1/health`, { headers: { apikey: key } })
      .then(async (r) => set('auth', r.ok ? 'ok' : `HTTP ${r.status}`))
      .catch((e) => set('auth', String(e)));

    set('database (REST)', 'checking');
    supabase
      .from('links')
      .select('id', { head: true, count: 'exact' })
      .then(({ error }) => set('database (REST)', error ? error.message : 'ok'));

    set('storage', 'checking');
    supabase.storage
      .from('link-icons')
      .list('', { limit: 1 })
      .then(({ error }) => set('storage', error ? error.message : 'ok'));

    set('realtime', 'checking');
    const channel = supabase.channel(`status-${Math.random().toString(36).slice(2)}`).subscribe((s, err) => {
      if (s === 'SUBSCRIBED') set('realtime', 'ok');
      else if (s !== 'CLOSED') set('realtime', err ? `${s}: ${err.message}` : s);
    });
    return () => {
      supabase.removeChannel(channel);
    };
  }, [session?.user.id]);

  return (
    <aside className="card status">
      <h2>Services</h2>
      <ul>
        {Object.entries(status).map(([k, v]) => (
          <li key={k}>
            <span className={v === 'ok' ? 'dot ok' : v === 'checking' ? 'dot' : 'dot bad'} /> {k}
            {v !== 'ok' && v !== 'checking' && <div className="muted">{v}</div>}
          </li>
        ))}
      </ul>
    </aside>
  );
}
