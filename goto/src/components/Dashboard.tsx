import type { Session } from '@supabase/supabase-js';
import { useCallback, useEffect, useState } from 'react';
import { supabase, type Link } from '../lib/supabase';
import { AccountPanel } from './AccountPanel';
import { ClickFeed } from './ClickFeed';
import { LinkForm } from './LinkForm';
import { LinkTable } from './LinkTable';

export function Dashboard({ session }: { session: Session }) {
  const uid = session.user.id;
  const [links, setLinks] = useState<Link[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState('connecting');

  const load = useCallback(async () => {
    const res = query.trim()
      ? await supabase.rpc('search_links', { p_query: query.trim() })
      : await supabase.from('links').select('*').eq('owner_id', uid).order('created_at', { ascending: false });
    if (res.error) setError(res.error.message);
    else {
      setError(null);
      setLinks(res.data as Link[]);
    }
  }, [query, uid]);

  useEffect(() => {
    load();
  }, [load]);

  // Live click counts and edits from other tabs via postgres_changes.
  useEffect(() => {
    const channel = supabase
      .channel(`links:${uid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'links', filter: `owner_id=eq.${uid}` }, (p) => {
        setLinks((prev) => {
          if (p.eventType === 'DELETE') return prev.filter((l) => l.id !== (p.old as Link).id);
          const row = p.new as Link;
          const exists = prev.some((l) => l.id === row.id);
          return exists ? prev.map((l) => (l.id === row.id ? row : l)) : [row, ...prev];
        });
      })
      .subscribe((status, err) => setLiveStatus(err ? `${status}: ${err.message}` : status));
    return () => {
      supabase.removeChannel(channel);
    };
  }, [uid]);

  return (
    <div className="dashboard">
      <AccountPanel session={session} />
      <section className="card">
        <h2>New link</h2>
        <LinkForm isAnonymous={!!session.user.is_anonymous} onCreated={load} />
      </section>
      <section className="card">
        <div className="row spread">
          <h2>Links</h2>
          <span className="muted">live: {liveStatus}</span>
        </div>
        <input placeholder="Search slugs and titles (pg_trgm)" value={query} onChange={(e) => setQuery(e.target.value)} />
        {error && <p className="message">Error: {error}</p>}
        <LinkTable links={links} uid={uid} onChanged={load} />
      </section>
      <ClickFeed uid={uid} />
    </div>
  );
}
