import type { Provider } from '@supabase/supabase-js';
import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';

const PROVIDERS: Array<{ id: Provider; label: string }> = [
  { id: 'github', label: 'GitHub' },
  { id: 'google', label: 'Google' },
];

export function AuthPanel() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<{ error: Error | null }>, ok?: string) {
    setBusy(true);
    setMessage(null);
    const { error } = await action();
    setBusy(false);
    setMessage(error ? `Error: ${error.message}` : (ok ?? null));
  }

  const onSubmit = (e: FormEvent, mode: 'signin' | 'signup') => {
    e.preventDefault();
    if (mode === 'signin') return run(() => supabase.auth.signInWithPassword({ email, password }));
    return run(
      () => supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } }),
      'Check your inbox if email confirmation is enabled.',
    );
  };

  return (
    <section className="card auth">
      <h2>Sign in</h2>
      <form onSubmit={(e) => onSubmit(e, 'signin')}>
        <input type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input
          type="password"
          placeholder="password (min 8)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          required
        />
        <div className="row">
          <button type="submit" disabled={busy}>
            Sign in
          </button>
          <button type="button" disabled={busy} onClick={(e) => onSubmit(e, 'signup')}>
            Sign up
          </button>
        </div>
      </form>
      <div className="row">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            disabled={busy}
            onClick={() =>
              run(() => supabase.auth.signInWithOAuth({ provider: p.id, options: { redirectTo: window.location.origin } }))
            }
          >
            Continue with {p.label}
          </button>
        ))}
      </div>
      <button className="secondary" disabled={busy} onClick={() => run(() => supabase.auth.signInAnonymously())}>
        Continue anonymously
      </button>
      {message && <p className="message">{message}</p>}
    </section>
  );
}
