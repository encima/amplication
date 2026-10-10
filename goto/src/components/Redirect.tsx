import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';

// /go/<slug>: resolve via RPC (records the click) and redirect.
export function Redirect({ slug, ready }: { slug: string; ready: boolean }) {
  const [error, setError] = useState<string | null>(null);
  // resolve_link records a click, so call it once even when StrictMode re-runs effects.
  const started = useRef(false);

  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    supabase.rpc('resolve_link', { p_slug: slug }).then(({ data, error }) => {
      if (error) setError(error.message);
      else if (!data) setError(`No link named "${slug}" (or it is private or expired).`);
      else window.location.replace(data as string);
    });
  }, [slug, ready]);

  return (
    <div className="app">
      <section className="card">
        {error ? (
          <>
            <p>{error}</p>
            <a href="/">Back to GoTo</a>
          </>
        ) : (
          <p>Going to {slug}…</p>
        )}
      </section>
    </div>
  );
}
