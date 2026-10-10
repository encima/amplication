import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { assert, newClient, ok, waitFor, type Ctx, type Runner, type TestUser } from '../lib';

export async function authChecks(r: Runner, ctx: Ctx) {
  const t = ctx.target;

  await r.check('auth.health', async () => {
    const res = await fetch(`${t.url}/auth/v1/health`, { headers: { apikey: t.publishableKey } });
    const body = await res.json();
    assert(res.ok, `HTTP ${res.status} ${JSON.stringify(body)}`);
    return { version: body.version };
  });

  await r.check('auth.config.anonymousEnabled', async () => {
    const s = await (await fetch(`${t.url}/auth/v1/settings`, { headers: { apikey: t.publishableKey } })).json();
    assert(s.external?.anonymous_users === true, 'anonymous sign-ins are disabled (run `supabase config push`)');
  });

  for (const [provider, host] of [
    ['github', 'github.com'],
    ['google', 'accounts.google.com'],
  ] as const) {
    await r.check(`auth.provider.${provider}`, async () => {
      const s = await (await fetch(`${t.url}/auth/v1/settings`, { headers: { apikey: t.publishableKey } })).json();
      assert(s.external?.[provider] === true, `${provider} provider is not enabled`);
      const res = await fetch(`${t.url}/auth/v1/authorize?provider=${provider}&redirect_to=http://127.0.0.1:5173`, {
        headers: { apikey: t.publishableKey },
        redirect: 'manual',
      });
      const location = res.headers.get('location') ?? '';
      assert(res.status === 302 && location.includes(host), `expected 302 to ${host}, got ${res.status} ${location || (await res.text()).slice(0, 200)}`);
      const clientId = new URL(location).searchParams.get('client_id');
      assert(clientId, 'authorize redirect has no client_id (provider credentials missing)');
      return { clientId: `${clientId.slice(0, 6)}…` };
    });
  }

  const created = await r.check('auth.admin.createUsers', async () => {
    for (const label of ['a', 'b'] as const) {
      const email = `goto-${t.name}-${ctx.stamp}-${label}@example.com`;
      const password = `GoTo-${ctx.stamp}-${label}!`;
      const { user } = ok(await ctx.admin.auth.admin.createUser({ email, password, email_confirm: true }));
      ctx.cleanup.push(() => ctx.admin.auth.admin.deleteUser(user.id));
      ctx.users[label] = { label, id: user.id, email, password, token: '', client: newClient(t, t.publishableKey) };
    }
  });

  const signedIn = await r.check(
    'auth.signInWithPassword',
    async () => {
      for (const u of [ctx.users.a!, ctx.users.b!]) {
        const { session } = ok(await u.client.auth.signInWithPassword({ email: u.email!, password: u.password! }));
        u.token = session.access_token;
      }
    },
    { needs: [created] },
  );
  if (!signedIn) {
    ctx.users.a = ctx.users.b = undefined;
  }

  await r.check(
    'auth.jwks.verify',
    async () => {
      const token = ctx.users.a!.token;
      const header = decodeProtectedHeader(token);
      const jwks = createRemoteJWKSet(new URL(`${t.url}/auth/v1/.well-known/jwks.json`));
      try {
        const { payload } = await jwtVerify(token, jwks);
        assert(payload.sub === ctx.users.a!.id, 'sub mismatch');
        return { alg: header.alg, kid: header.kid };
      } catch (e) {
        // Symmetric (HS256) projects publish no key; getClaims falls back to the Auth server.
        if (header.alg === 'HS256') return { alg: 'HS256', note: 'symmetric key, not in JWKS' };
        throw e;
      }
    },
    { needs: [signedIn] },
  );

  await r.check(
    'auth.getClaims',
    async () => {
      const data = ok(await ctx.users.a!.client.auth.getClaims());
      assert(data?.claims.sub === ctx.users.a!.id, 'sub mismatch');
    },
    { needs: [signedIn] },
  );

  const anonOk = await r.check('auth.signInAnonymously', async () => {
    const client = newClient(t, t.publishableKey);
    const { session, user } = ok(await client.auth.signInAnonymously());
    assert(user?.is_anonymous, 'user.is_anonymous is not true');
    ctx.cleanup.push(() => ctx.admin.auth.admin.deleteUser(user!.id));
    ctx.users.anonymous = { label: 'anonymous', id: user!.id, token: session!.access_token, client } satisfies TestUser;
  });

  await r.check(
    'auth.profileTrigger',
    async () => {
      const own = await waitFor(async () => {
        const { data } = await ctx.users.a!.client.from('profiles').select('*').eq('id', ctx.users.a!.id).maybeSingle();
        return data ?? undefined;
      }, 5000);
      assert(own, 'no profile row created by on_auth_user_created');
      const { data: anonProfile } = await ctx.users.anonymous!.client.from('profiles').select('is_anonymous').single();
      assert(anonProfile?.is_anonymous === true, 'anonymous profile not flagged is_anonymous');
      const { data: others } = await ctx.users.a!.client.from('profiles').select('id');
      assert(others?.length === 1, `user A can read ${others?.length} profiles`);
    },
    { needs: [signedIn, anonOk] },
  );
}
