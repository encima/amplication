import { iconUrl, supabase, type Link } from '../lib/supabase';

export function LinkTable({ links, uid, onChanged }: { links: Link[]; uid: string; onChanged: () => void }) {
  async function uploadIcon(link: Link, file: File) {
    const ext = file.name.split('.').pop() ?? 'png';
    const path = `${uid}/${link.id}.${ext}`;
    const up = await supabase.storage.from('link-icons').upload(path, file, { upsert: true, contentType: file.type });
    if (up.error) return alert(`Upload failed: ${up.error.message}`);
    const { error } = await supabase.from('links').update({ icon_path: path }).eq('id', link.id);
    if (error) alert(error.message);
    onChanged();
  }

  async function togglePublic(link: Link) {
    const { error } = await supabase.from('links').update({ is_public: !link.is_public }).eq('id', link.id);
    if (error) alert(error.message);
    onChanged();
  }

  async function remove(link: Link) {
    if (link.icon_path) await supabase.storage.from('link-icons').remove([link.icon_path]);
    const { error } = await supabase.from('links').delete().eq('id', link.id);
    if (error) alert(error.message);
    onChanged();
  }

  if (!links.length) return <p className="muted">No links yet.</p>;

  return (
    <table>
      <thead>
        <tr>
          <th />
          <th>slug</th>
          <th>url</th>
          <th>clicks</th>
          <th>health</th>
          <th>public</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {links.map((l) => {
          const mine = l.owner_id === uid;
          const icon = iconUrl(l.icon_path);
          return (
            <tr key={l.id}>
              <td>
                <label className="icon" title={mine ? 'Upload icon' : ''}>
                  {icon ? <img src={icon} alt="" /> : <span>＋</span>}
                  {mine && (
                    <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden onChange={(e) => e.target.files?.[0] && uploadIcon(l, e.target.files[0])} />
                  )}
                </label>
              </td>
              <td>
                <a href={`/go/${l.slug}`} target="_blank" rel="noreferrer">
                  /go/{l.slug}
                </a>
                {l.title && <div className="muted">{l.title}</div>}
                {l.expires_at && <div className="muted">expires {new Date(l.expires_at).toLocaleString()}</div>}
              </td>
              <td className="url">{l.url}</td>
              <td>{l.click_count}</td>
              <td title={l.last_checked_at ?? 'not checked yet'}>{l.last_status ?? '–'}</td>
              <td>{mine ? <input type="checkbox" checked={l.is_public} onChange={() => togglePublic(l)} /> : l.is_public ? 'yes' : 'no'}</td>
              <td>{mine && <button onClick={() => remove(l)}>Delete</button>}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
