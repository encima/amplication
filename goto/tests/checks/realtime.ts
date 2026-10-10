import { assert, RT_WAIT_MS, sleep, subscribe, waitFor, type Ctx, type Runner } from '../lib';

export async function realtimeChecks(r: Runner, ctx: Ctx) {
  const { a, b } = ctx.users;
  const slug = `a-public-${ctx.stamp}`;

  await r.check('realtime.broadcast', async () => {
    const topic = `goto-public-${ctx.stamp}`;
    const got: unknown[] = [];
    const rx = ctx.anon.channel(topic).on('broadcast', { event: 'ping' }, (m) => got.push(m));
    const tx = ctx.admin.channel(topic);
    await subscribe(rx);
    await subscribe(tx);
    ctx.cleanup.push(() => Promise.all([rx.unsubscribe(), tx.unsubscribe()]));
    await tx.send({ type: 'broadcast', event: 'ping', payload: { n: 1 } });
    assert(await waitFor(() => got[0], RT_WAIT_MS), 'no broadcast received');
  });

  await r.check('realtime.presence', async () => {
    const ch = ctx.admin.channel(`goto-presence-${ctx.stamp}`, { config: { presence: { key: 'tester' } } });
    let synced = false;
    ch.on('presence', { event: 'sync' }, () => (synced = 'tester' in ch.presenceState()));
    await subscribe(ch);
    ctx.cleanup.push(() => ch.unsubscribe());
    await ch.track({ at: Date.now() });
    assert(await waitFor(() => synced || undefined, RT_WAIT_MS), 'presence never synced');
  });

  // postgres_changes and the DB-triggered private broadcast are both driven by one click.
  const changes: Array<{ eventType: string; new: { id: number; click_count: number } }> = [];
  const clicks: Array<{ slug: string }> = [];
  const foreignClicks: unknown[] = [];

  const ready = await r.check(
    'realtime.subscribe.userChannels',
    async () => {
      await a!.client.realtime.setAuth(a!.token);
      const pg = a!.client
        .channel(`links-${ctx.stamp}`)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'links', filter: `owner_id=eq.${a!.id}` }, (p) =>
          changes.push(p as never),
        );
      const priv = a!.client
        .channel(`user:${a!.id}`, { config: { private: true } })
        .on('broadcast', { event: 'click' }, ({ payload }) => clicks.push(payload as never));
      await subscribe(pg);
      await subscribe(priv);
      ctx.cleanup.push(() => Promise.all([pg.unsubscribe(), priv.unsubscribe()]));
      await sleep(1000);
    },
    { needs: [a, ctx.links.aPublic] },
  );

  await r.check(
    'realtime.privateChannel.deniedForOtherUser',
    async () => {
      await b!.client.realtime.setAuth(b!.token);
      const spy = b!.client
        .channel(`user:${a!.id}`, { config: { private: true } })
        .on('broadcast', { event: 'click' }, (m) => foreignClicks.push(m));
      try {
        await subscribe(spy, 8000);
        ctx.cleanup.push(() => spy.unsubscribe());
        return { note: 'join allowed; checking that no messages arrive' };
      } catch (e) {
        return { joinRejected: String(e).slice(0, 120) };
      }
    },
    { needs: [ready, b] },
  );

  if (ready) {
    // Trigger: one anonymous click on A's public link.
    await ctx.anon.rpc('resolve_link', { p_slug: slug });
  }

  await r.check(
    'realtime.postgresChanges.clickCount',
    async () => {
      const hit = await waitFor(() => changes.find((c) => c.new.id === ctx.links.aPublic), RT_WAIT_MS);
      assert(hit, `no UPDATE for link ${ctx.links.aPublic} within ${RT_WAIT_MS}ms`);
      return { click_count: hit.new.click_count };
    },
    { needs: [ready] },
  );

  await r.check(
    'realtime.privateBroadcast.fromTrigger',
    async () => {
      const hit = await waitFor(() => clicks.find((c) => c.slug === slug), RT_WAIT_MS);
      assert(hit, 'realtime.send() click broadcast not received on private channel');
    },
    { needs: [ready] },
  );

  await r.check(
    'realtime.privateChannel.noLeak',
    async () => {
      await sleep(500);
      assert(foreignClicks.length === 0, `user B received ${foreignClicks.length} of A's private messages`);
    },
    { needs: [ready, b] },
  );
}
