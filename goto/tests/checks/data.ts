import { eq, sql as dsql } from 'drizzle-orm';
import { assert, ok, type Ctx, type Runner } from '../lib';
import { links } from '../schema';

export async function dataChecks(r: Runner, ctx: Ctx) {
  const { a, b, anonymous } = ctx.users;
  const users = [a, b];
  const slug = (s: string) => `${s}-${ctx.stamp}`;

  const inserted = await r.check(
    'rest.links.insertOwn',
    async () => {
      const ins = async (u: typeof a, s: string, isPublic: boolean) =>
        ok(await u!.client.from('links').insert({ slug: slug(s), url: 'https://example.com/', title: `GoTo ${s}`, is_public: isPublic }).select().single());
      const aPriv = await ins(a, 'a-private', false);
      const aPub = await ins(a, 'a-public', true);
      const bPub = await ins(b, 'b-public', true);
      assert(aPriv.owner_id === a!.id, 'owner_id default auth.uid() not applied');
      ctx.links = { aPrivate: aPriv.id, aPublic: aPub.id, bPublic: bPub.id };
    },
    { needs: users },
  );

  await r.check(
    'rest.links.visibility',
    async () => {
      const seen = (rows: { id: number }[]) => new Set(rows.map((x) => x.id));
      const forA = seen(ok(await a!.client.from('links').select('id')));
      const forB = seen(ok(await b!.client.from('links').select('id')));
      const forAnon = seen(ok(await ctx.anon.from('links').select('id')));
      const { aPrivate, aPublic, bPublic } = ctx.links;
      assert(forA.has(aPrivate!) && forA.has(aPublic!) && forA.has(bPublic!), 'A should see own + public');
      assert(!forB.has(aPrivate!) && forB.has(aPublic!), "B should see A's public link only");
      assert(!forAnon.has(aPrivate!) && forAnon.has(bPublic!), 'anon should see public links only');
    },
    { needs: [inserted] },
  );

  await r.check(
    'rest.links.crossUserUpdateBlocked',
    async () => {
      const rows = ok(await b!.client.from('links').update({ title: 'hijack' }).eq('id', ctx.links.aPublic!).select());
      assert(rows.length === 0, "B updated A's link");
    },
    { needs: [inserted] },
  );

  await r.check(
    'rest.links.clickCountNotWritable',
    async () => {
      const { error } = await a!.client.from('links').update({ click_count: 999 }).eq('id', ctx.links.aPublic!);
      assert(error?.code === '42501', `expected 42501 permission denied, got ${error?.code ?? 'success'}`);
    },
    { needs: [inserted] },
  );

  await r.check(
    'rest.anonymousUser.privateOnly',
    async () => {
      const pub = await anonymous!.client.from('links').insert({ slug: slug('anon-public'), url: 'https://example.com/', is_public: true });
      assert(pub.error?.code === '42501', `public insert should be blocked by RLS, got ${pub.error?.code ?? 'success'}`);
      ok(await anonymous!.client.from('links').insert({ slug: slug('anon-private'), url: 'https://example.com/' }));
    },
    { needs: [anonymous] },
  );

  await r.check(
    'rpc.search_links',
    async () => {
      const rows = ok(await a!.client.rpc('search_links', { p_query: `a-publik-${ctx.stamp}` }));
      assert((rows as { id: number }[]).some((x) => x.id === ctx.links.aPublic), 'fuzzy search did not find a-public');
      const anonRows = ok(await ctx.anon.rpc('search_links', { p_query: `a-private-${ctx.stamp}` }));
      assert(!(anonRows as { id: number }[]).some((x) => x.id === ctx.links.aPrivate), 'search leaked a private link to anon');
    },
    { needs: [inserted] },
  );

  await r.check(
    'rpc.resolve_link',
    async () => {
      const pub = ok(await ctx.anon.rpc('resolve_link', { p_slug: slug('A-PUBLIC') }));
      assert(pub === 'https://example.com/', `anon resolve of public link (case-insensitive) returned ${pub}`);
      const privAnon = ok(await ctx.anon.rpc('resolve_link', { p_slug: slug('a-private') }));
      assert(privAnon === null, 'anon resolved a private link');
      const privOwner = ok(await a!.client.rpc('resolve_link', { p_slug: slug('a-private') }));
      assert(privOwner === 'https://example.com/', 'owner could not resolve own private link');
      const [link] = ok(await a!.client.from('links').select('click_count').eq('id', ctx.links.aPublic!));
      assert(link.click_count >= 1, `click_count=${link.click_count}`);
    },
    { needs: [inserted] },
  );

  await r.check(
    'rest.clicks.ownerOnly',
    async () => {
      const own = ok(await a!.client.from('clicks').select('id, referrer, user_agent').eq('link_id', ctx.links.aPublic!));
      assert(own.length >= 1, 'owner cannot see clicks on own link');
      const foreign = ok(await b!.client.from('clicks').select('id').eq('link_id', ctx.links.aPublic!));
      assert(foreign.length === 0, "B can see clicks on A's link");
      const insert = await a!.client.from('clicks').insert({ link_id: ctx.links.aPublic! });
      assert(insert.error, 'clients must not insert clicks directly');
      return { userAgentRecorded: !!own[0].user_agent };
    },
    { needs: [inserted] },
  );

  // ---- Drizzle over a direct connection ----
  const db = ctx.db;
  await r.check(
    'drizzle.rlsAsUser',
    async () => {
      // The Drizzle + Supabase RLS pattern: set the JWT claims and role inside a transaction.
      const rows = await db!.transaction(async (tx) => {
        await tx.execute(dsql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: b!.id, role: 'authenticated' })}, true)`);
        await tx.execute(dsql`set local role authenticated`);
        return tx.select({ id: links.id, ownerId: links.ownerId }).from(links);
      });
      assert(!rows.some((x) => x.id === ctx.links.aPrivate), "B saw A's private link through Drizzle");
      assert(rows.some((x) => x.id === ctx.links.bPublic), 'B cannot see own link through Drizzle');
      return { rows: rows.length };
    },
    { needs: [db, inserted] },
  );

  await r.check(
    'drizzle.preparedStatement',
    async () => {
      const q = db!.select({ slug: links.slug }).from(links).where(eq(links.id, dsql.placeholder('id'))).prepare('goto_link_by_id');
      for (const id of [ctx.links.aPublic!, ctx.links.bPublic!, ctx.links.aPublic!]) {
        const [row] = await q.execute({ id });
        assert(row?.slug, `prepared statement returned nothing for ${id}`);
      }
    },
    { needs: [db, inserted] },
  );

  await r.check(
    'drizzle.typedUpdate',
    async () => {
      const [row] = await db!.update(links).set({ title: 'updated by drizzle' }).where(eq(links.id, ctx.links.bPublic!)).returning();
      assert(row.title === 'updated by drizzle', 'update did not return the new row');
      assert(row.updatedAt > row.createdAt, 'moddatetime trigger did not bump updated_at');
    },
    { needs: [db, inserted] },
  );
}

