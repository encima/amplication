import type { Session } from '@supabase/supabase-js';
import { useEffect, useState, type FormEvent } from 'react';
import { supabase, type Profile } from '../lib/supabase';

export function AccountPanel({ session }: { session: Session }) {
  const uid = session.user.id;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    const { data, error } = await supabase.from('profiles').select('*').eq('id', uid).maybeSingle();
    if (error) return setMessage(`Profile: ${error.message}`);
    setProfile(data as Profile | null);
    if (data?.avatar_path) {
      const signed = await supabase.storage.from('avatars').createSignedUrl(data.avatar_path, 3600);
      setAvatarUrl(signed.data?.signedUrl ?? null);
    }
  }

  useEffect(() => {
    load();
  }, [uid]);

  async function uploadAvatar(file: File) {
    const path = `${uid}/avatar.${file.name.split('.').pop() ?? 'png'}`;
    const up = await supabase.storage.from('avatars').upload(path, file, { upsert: true, contentType: file.type });
    if (up.error) return setMessage(`Avatar: ${up.error.message}`);
    const { error } = await supabase.from('profiles').update({ avatar_path: path }).eq('id', uid);
    setMessage(error ? error.message : 'Avatar updated');
    load();
  }

  async function saveAccount(e: FormEvent) {
    e.preventDefault();
    const { error } = await supabase.auth.updateUser({ email, password });
    setMessage(error ? error.message : 'Account saved. Confirm the email if confirmations are enabled.');
  }

  return (
    <section className="card account">
      <div className="row">
        <label className="avatar" title="Upload avatar (private bucket, signed URL)">
          {avatarUrl ? <img src={avatarUrl} alt="" /> : <span>{(profile?.display_name ?? session.user.email ?? 'A')[0].toUpperCase()}</span>}
          <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => e.target.files?.[0] && uploadAvatar(e.target.files[0])} />
        </label>
        <div>
          <strong>{profile?.display_name ?? session.user.email ?? 'Anonymous user'}</strong>
          <div className="muted">
            {profile?.is_anonymous ? 'anonymous' : session.user.app_metadata.provider} · {uid.slice(0, 8)}
          </div>
        </div>
      </div>
      {session.user.is_anonymous && (
        <div className="anon">
          <p>You are signed in anonymously. Anonymous users can only create private links. Save your account to keep them:</p>
          <form onSubmit={saveAccount} className="row">
            <input type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <input type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
            <button type="submit">Save account</button>
          </form>
          <button
            className="secondary"
            onClick={async () => {
              const { error } = await supabase.auth.linkIdentity({ provider: 'github', options: { redirectTo: window.location.origin } });
              if (error) setMessage(error.message);
            }}
          >
            Link GitHub instead
          </button>
        </div>
      )}
      {message && <p className="message">{message}</p>}
    </section>
  );
}
