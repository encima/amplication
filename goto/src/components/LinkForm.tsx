import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';

export function LinkForm({ isAnonymous, onCreated }: { isAnonymous: boolean; onCreated: () => void }) {
  const [slug, setSlug] = useState('');
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [expires, setExpires] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const { error } = await supabase.from('links').insert({
      slug,
      url,
      title: title || null,
      is_public: isPublic,
      expires_at: expires ? new Date(expires).toISOString() : null,
    });
    if (error) return setError(error.message);
    setError(null);
    setSlug('');
    setUrl('');
    setTitle('');
    onCreated();
  }

  return (
    <form onSubmit={submit} className="link-form">
      <input placeholder="slug" value={slug} onChange={(e) => setSlug(e.target.value)} required pattern="[a-zA-Z0-9][a-zA-Z0-9_\-]{0,63}" />
      <input placeholder="https://…" type="url" value={url} onChange={(e) => setUrl(e.target.value)} required />
      <input placeholder="title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
      <label title={isAnonymous ? 'Anonymous users can only create private links' : ''}>
        <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} /> public
      </label>
      <label>
        expires <input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
      </label>
      <button type="submit">Create</button>
      {error && <p className="message">Error: {error}</p>}
    </form>
  );
}
