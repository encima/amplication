import { assert, ok, type Ctx, type Runner } from '../lib';

// 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export async function storageChecks(r: Runner, ctx: Ctx) {
  const { a, b } = ctx.users;
  const iconPath = `${a?.id}/${ctx.links.aPublic}.png`;
  const avatarPath = `${a?.id}/avatar.png`;

  const uploaded = await r.check(
    'storage.linkIcons.uploadOwnFolder',
    async () => {
      ok(await a!.client.storage.from('link-icons').upload(iconPath, PNG, { contentType: 'image/png', upsert: true }));
      ctx.cleanup.push(() => ctx.admin.storage.from('link-icons').remove([iconPath]));
      ok(await a!.client.from('links').update({ icon_path: iconPath }).eq('id', ctx.links.aPublic!));
    },
    { needs: [a, ctx.links.aPublic] },
  );

  await r.check(
    'storage.linkIcons.publicUrl',
    async () => {
      const { publicUrl } = ctx.anon.storage.from('link-icons').getPublicUrl(iconPath).data;
      const res = await fetch(publicUrl);
      assert(res.ok, `GET public URL → HTTP ${res.status}`);
      assert((res.headers.get('content-type') ?? '').startsWith('image/png'), `content-type ${res.headers.get('content-type')}`);
    },
    { needs: [uploaded] },
  );

  await r.check(
    'storage.linkIcons.otherFolderDenied',
    async () => {
      const { error } = await b!.client.storage.from('link-icons').upload(`${a!.id}/intruder.png`, PNG, { contentType: 'image/png' });
      assert(error, "B uploaded into A's folder");
      return { error: error.message };
    },
    { needs: [a, b] },
  );

  await r.check(
    'storage.mimeTypeRestricted',
    async () => {
      const { error } = await a!.client.storage.from('link-icons').upload(`${a!.id}/note.txt`, Buffer.from('hi'), { contentType: 'text/plain' });
      assert(error, 'text/plain accepted by an image-only bucket');
    },
    { needs: [a] },
  );

  const avatar = await r.check(
    'storage.avatars.privateUpload',
    async () => {
      ok(await a!.client.storage.from('avatars').upload(avatarPath, PNG, { contentType: 'image/png', upsert: true }));
      ctx.cleanup.push(() => ctx.admin.storage.from('avatars').remove([avatarPath]));
      ok(await a!.client.from('profiles').update({ avatar_path: avatarPath }).eq('id', a!.id));
    },
    { needs: [a] },
  );

  await r.check(
    'storage.avatars.signedUrl',
    async () => {
      const { signedUrl } = ok(await a!.client.storage.from('avatars').createSignedUrl(avatarPath, 60));
      const res = await fetch(signedUrl);
      assert(res.ok, `signed URL → HTTP ${res.status}`);
      const pub = await fetch(ctx.anon.storage.from('avatars').getPublicUrl(avatarPath).data.publicUrl);
      assert(!pub.ok, `private avatar served publicly (HTTP ${pub.status})`);
    },
    { needs: [avatar] },
  );

  await r.check(
    'storage.avatars.otherUserDenied',
    async () => {
      const { data, error } = await b!.client.storage.from('avatars').download(avatarPath);
      assert(error || !data, "B downloaded A's private avatar");
    },
    { needs: [avatar, b] },
  );
}
