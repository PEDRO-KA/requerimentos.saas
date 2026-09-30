-- A stale, never-dispatched job must not be sent after its retention window,
-- even before the daily purge has run.
create or replace function public.claim_request_creation_email_jobs(p_limit integer default 10)
returns table (
  delivery_id uuid,
  target_request_id uuid,
  recipient_email text,
  request_protocol text,
  opened_at timestamptz,
  delivery_attempt_count integer
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.request_creation_email_jobs as expired
  set next_attempt_at = null,
      last_error_code = 'retry_window_expired'
  where expired.status = 'failed'
    and expired.next_attempt_at is not null
    and expired.first_attempt_at <= now() - interval '23 hours';

  update public.request_creation_email_jobs as stale
  set status = 'failed',
      locked_at = null,
      next_attempt_at = case
        when stale.attempt_count < 5
          and stale.first_attempt_at > now() - interval '23 hours'
        then now()
        else null
      end,
      last_error_code = 'stale_processing'
  where stale.status = 'processing'
    and stale.locked_at < now() - interval '15 minutes';

  return query
  with candidates as (
    select queued.id
    from public.request_creation_email_jobs as queued
    where queued.status in ('pending', 'failed')
      and queued.created_at > now() - interval '30 days'
      and queued.next_attempt_at <= now()
      and queued.attempt_count < 5
      and (queued.first_attempt_at is null
        or queued.first_attempt_at > now() - interval '23 hours')
    order by queued.created_at
    for update of queued skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  ), claimed as (
    update public.request_creation_email_jobs as queued
    set status = 'processing',
        attempt_count = queued.attempt_count + 1,
        first_attempt_at = coalesce(queued.first_attempt_at, now()),
        locked_at = now(),
        next_attempt_at = null,
        last_error_code = null
    from candidates
    where queued.id = candidates.id
    returning queued.*
  )
  select
    claimed.id, claimed.request_id, claimed.recipient_email,
    claimed.request_protocol, claimed.opened_at, claimed.attempt_count
  from claimed;
end;
$$;
