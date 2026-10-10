import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { AuthPanel } from './components/AuthPanel';
import { Dashboard } from './components/Dashboard';
import { Redirect } from './components/Redirect';
import { StatusPanel } from './components/StatusPanel';
import { supabase, target } from './lib/supabase';

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  const goSlug = window.location.pathname.match(/^\/go\/([^/]+)/)?.[1];
  if (goSlug) return <Redirect slug={decodeURIComponent(goSlug)} ready={ready} />;

  return (
    <div className="app">
      <header>
        <h1>GoTo</h1>
        <span className={`badge badge-${target.mode}`} title={target.url}>
          {target.mode} · {new URL(target.url).host}
        </span>
        {session && (
          <span className="user">
            {session.user.is_anonymous ? 'anonymous' : (session.user.email ?? session.user.id)}
            <button onClick={() => supabase.auth.signOut()}>Sign out</button>
          </span>
        )}
      </header>
      <main>
        {!ready ? <p>Loading…</p> : session ? <Dashboard session={session} /> : <AuthPanel />}
        <StatusPanel session={session} />
      </main>
    </div>
  );
}
