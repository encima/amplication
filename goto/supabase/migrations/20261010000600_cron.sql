-- Scheduled maintenance with pg_cron (and pg_net for link health checks).

-- Delete links that expired more than a day ago.
create function public.purge_expired_links()
returns integer
language sql
security definer
set search_path = ''
as $$
  with deleted as (
    delete from public.links where expires_at < now() - interval '1 day' returning 1
  )
  select count(*)::integer from deleted;
$$;

-- Roll raw clicks up into per-day counts for today and yesterday.
create function public.rollup_link_stats()
returns integer
language sql
security definer
set search_path = ''
as $$
  with upserted as (
    insert into public.link_stats_daily (link_id, day, clicks)
    select link_id, clicked_at::date, count(*)
      from public.clicks
     where clicked_at >= current_date - 1
     group by link_id, clicked_at::date
    on conflict (link_id, day) do update set clicks = excluded.clicks
    returning 1
  )
  select count(*)::integer from upserted;
$$;

-- Drop raw clicks after 90 days; daily stats are kept.
create function public.prune_clicks()
returns integer
language sql
security definer
set search_path = ''
as $$
  with deleted as (
    delete from public.clicks where clicked_at < now() - interval '90 days' returning 1
  )
  select count(*)::integer from deleted;
$$;

-- Health-check public links: collect responses from the previous run, then queue new requests.
create function public.check_links(p_batch integer default 50)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_queued integer;
begin
  update public.links l
     set last_status = coalesce(r.status_code, 0),
         last_check_request_id = null
    from net._http_response r
   where r.id = l.last_check_request_id;

  with due as (
    select id, url from public.links
     where is_public
       and last_check_request_id is null
       and (last_checked_at is null or last_checked_at < now() - interval '1 day')
     order by last_checked_at nulls first
     limit p_batch
  )
  update public.links l
     set last_check_request_id = net.http_get(url := due.url, timeout_milliseconds := 5000),
         last_checked_at = now()
    from due
   where l.id = due.id;

  get diagnostics v_queued = row_count;
  return v_queued;
end;
$$;

revoke execute on function public.purge_expired_links() from public, anon, authenticated;
revoke execute on function public.rollup_link_stats() from public, anon, authenticated;
revoke execute on function public.prune_clicks() from public, anon, authenticated;
revoke execute on function public.check_links(integer) from public, anon, authenticated;

-- cron.schedule upserts by job name, so re-running is safe.
select cron.schedule('goto-purge-expired-links', '*/5 * * * *', 'select public.purge_expired_links()');
select cron.schedule('goto-rollup-link-stats', '*/15 * * * *', 'select public.rollup_link_stats()');
select cron.schedule('goto-prune-clicks', '30 3 * * *', 'select public.prune_clicks()');
select cron.schedule('goto-check-links', '*/10 * * * *', 'select public.check_links()');
