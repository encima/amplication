import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

interface ClickEvent {
  link_id: number;
  slug: string;
  clicked_at: string;
  referrer: string | null;
}

// Private broadcast channel fed by the clicks_broadcast trigger (realtime.send).
export function ClickFeed({ uid }: { uid: string }) {
  const [events, setEvents] = useState<ClickEvent[]>([]);
  const [status, setStatus] = useState('connecting');

  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | undefined;
    let cancelled = false;
    // Private channels need the user's JWT on the socket before joining.
    supabase.realtime.setAuth().then(() => {
      if (cancelled) return;
      channel = supabase
        .channel(`user:${uid}`, { config: { private: true } })
        .on('broadcast', { event: 'click' }, ({ payload }) => setEvents((prev) => [payload as ClickEvent, ...prev].slice(0, 20)))
        .subscribe((s, err) => setStatus(err ? `${s}: ${err.message}` : s));
    });
    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [uid]);

  return (
    <section className="card">
      <div className="row spread">
        <h2>Live clicks</h2>
        <span className="muted">private channel: {status}</span>
      </div>
      {events.length === 0 ? (
        <p className="muted">Open one of your links to see clicks arrive here.</p>
      ) : (
        <ul>
          {events.map((e, i) => (
            <li key={i}>
              <code>/go/{e.slug}</code> at {new Date(e.clicked_at).toLocaleTimeString()}
              {e.referrer && <span className="muted"> from {e.referrer}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
