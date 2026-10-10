import { assert, waitFor, type Ctx, type Runner } from '../lib';

export async function cronChecks(r: Runner, ctx: Ctx) {
  const sql = ctx.sql;

  await r.check(
    'cron.workerRunsJobs',
    async () => {
      // pg_cron >= 1.5 supports second-level schedules; the scheduler must actually execute it.
      const name = `goto-test-${ctx.stamp}`;
      const [{ jobid }] = await sql!`select cron.schedule(${name}, '1 seconds', 'select 1') as jobid`;
      ctx.cleanup.push(() => sql!`select cron.unschedule(${name})`);
      const run = await waitFor(async () => {
        const [row] = await sql!`select status, return_message from cron.job_run_details where jobid = ${jobid} order by start_time desc limit 1`;
        return row?.status === 'succeeded' || row?.status === 'failed' ? row : undefined;
      }, 15_000);
      assert(run, 'scheduled job never ran within 15s');
      assert(run.status === 'succeeded', `job ${run.status}: ${run.return_message}`);
    },
    { needs: [sql], timeoutMs: 25_000 },
  );

  await r.check(
    'cron.rollupLinkStats',
    async () => {
      const [{ n }] = await sql!`select public.rollup_link_stats() as n`;
      const [row] = await sql!`select clicks from public.link_stats_daily where link_id = ${ctx.links.aPublic!} and day = current_date`;
      assert(row && Number(row.clicks) >= 1, `no daily stats for link ${ctx.links.aPublic}`);
      return { upserted: n, clicksToday: Number(row.clicks) };
    },
    { needs: [sql, ctx.links.aPublic] },
  );

  await r.check(
    'cron.purgeExpiredLinks',
    async () => {
      const [owner] = await sql!`select owner_id from public.links where id = ${ctx.links.aPublic!}`;
      const [{ id }] = await sql!`insert into public.links (owner_id, slug, url, expires_at)
        values (${owner.owner_id}, ${`expired-${ctx.stamp}`}, 'https://example.com/', now() - interval '2 days') returning id`;
      const [{ n }] = await sql!`select public.purge_expired_links() as n`;
      const left = await sql!`select 1 from public.links where id = ${id}`;
      assert(left.length === 0, 'expired link not purged');
      return { purged: n };
    },
    { needs: [sql, ctx.links.aPublic] },
  );

  await r.check(
    'cron.checkLinks.pgNet',
    async () => {
      // The real goto-check-links job may already have checked this link; make it due again.
      await sql!`update public.links set last_checked_at = null, last_check_request_id = null where id = ${ctx.links.aPublic!}`;
      const [{ queued }] = await sql!`select public.check_links() as queued`;
      assert(queued >= 1, 'check_links queued no requests');
      const [{ last_check_request_id: reqId }] = await sql!`select last_check_request_id from public.links where id = ${ctx.links.aPublic!}`;
      assert(reqId, 'no pg_net request id recorded');
      const resp = await waitFor(async () => {
        const [row] = await sql!`select status_code, error_msg from net._http_response where id = ${reqId}`;
        return row;
      }, 20_000);
      assert(resp, `pg_net response ${reqId} never arrived`);
      await sql!`select public.check_links()`;
      const [link] = await sql!`select last_status from public.links where id = ${ctx.links.aPublic!}`;
      assert(link.last_status !== null, 'last_status not collected');
      return { status: resp.status_code, error: resp.error_msg, lastStatus: link.last_status };
    },
    { needs: [sql, ctx.links.aPublic], timeoutMs: 30_000 },
  );
}
