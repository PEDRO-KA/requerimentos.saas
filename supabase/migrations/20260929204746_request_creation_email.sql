create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.request_creation_email_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  request_id uuid not null unique,
  student_id uuid not null,
  recipient_email text not null,
  request_protocol text not null,
  opened_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'accepted', 'failed')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  first_attempt_at timestamptz,
  next_attempt_at timestamptz default now(),
  locked_at timestamptz,
  provider_message_id text,
  last_error_code text,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (request_id, organization_id)
    references public.requests(id, organization_id) on delete cascade,
  foreign key (student_id, organization_id)
    references public.students(id, organization_id) on delete restrict
);

create index request_creation_email_jobs_due_idx
on public.request_creation_email_jobs (next_attempt_at, created_at)
where status in ('pending', 'failed');
create index request_creation_email_jobs_student_idx
on public.request_creation_email_jobs (student_id);

create trigger request_creation_email_jobs_set_updated_at
before update on public.request_creation_email_jobs
for each row execute function public.set_updated_at();

alter table public.request_creation_email_jobs enable row level security;
revoke all on table public.request_creation_email_jobs from public, anon, authenticated;
grant select, update on table public.request_creation_email_jobs to service_role;

create or replace function private.invoke_request_creation_email_dispatch()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  project_url text;
  dispatch_secret text;
  network_request_id bigint;
begin
  select secret.decrypted_secret into project_url
  from vault.decrypted_secrets as secret
  where secret.name = 'project_url'
  limit 1;

  select secret.decrypted_secret into dispatch_secret
  from vault.decrypted_secrets as secret
  where secret.name = 'request_creation_email_dispatch_secret'
  limit 1;

  if nullif(project_url, '') is null or nullif(dispatch_secret, '') is null then
    return null;
  end if;

  select net.http_post(
    url := rtrim(project_url, '/') || '/functions/v1/dispatch-request-creation-emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Email-Dispatch-Secret', dispatch_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  ) into network_request_id;
  return network_request_id;
exception when others then
  return null;
end;
$$;

create or replace function private.queue_request_creation_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.student_id is null then return new; end if;

  insert into public.request_creation_email_jobs (
    organization_id, request_id, student_id, recipient_email,
    request_protocol, opened_at
  )
  select
    new.organization_id, new.id, student.id, lower(trim(student.email)),
    new.protocol, new.opened_at
  from public.students as student
  where student.id = new.student_id
    and student.organization_id = new.organization_id
  on conflict (request_id) do nothing;

  if found then perform private.invoke_request_creation_email_dispatch(); end if;
  return new;
end;
$$;

create trigger requests_queue_creation_email
after insert on public.requests
for each row execute function private.queue_request_creation_email();

create or replace function public.get_request_creation_email_credentials()
returns table (resend_api_key text, dispatch_secret text)
language sql
security definer
set search_path = ''
as $$
  select
    (select secret.decrypted_secret from vault.decrypted_secrets as secret
      where secret.name = 'resend_request_creation_api_key' limit 1),
    (select secret.decrypted_secret from vault.decrypted_secrets as secret
      where secret.name = 'request_creation_email_dispatch_secret' limit 1);
$$;

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

create or replace function public.mark_request_creation_email_accepted(
  p_delivery_id uuid,
  p_provider_message_id text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.request_creation_email_jobs as delivery
  set status = 'accepted',
      provider_message_id = left(p_provider_message_id, 160),
      last_error_code = null,
      locked_at = null,
      next_attempt_at = null,
      accepted_at = now()
  where delivery.id = p_delivery_id
    and delivery.status = 'processing';
  return found;
end;
$$;

create or replace function public.mark_request_creation_email_failed(
  p_delivery_id uuid,
  p_error_code text,
  p_retryable boolean
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.request_creation_email_jobs as delivery
  set status = 'failed',
      last_error_code = left(coalesce(p_error_code, 'delivery_failed'), 120),
      locked_at = null,
      next_attempt_at = case
        when p_retryable and delivery.attempt_count < 5
          and delivery.first_attempt_at > now() - interval '23 hours'
        then now() + case delivery.attempt_count
          when 1 then interval '1 minute'
          when 2 then interval '5 minutes'
          when 3 then interval '15 minutes'
          else interval '1 hour'
        end
        else null
      end
  where delivery.id = p_delivery_id
    and delivery.status = 'processing';
  return found;
end;
$$;

-- Keep delivery diagnostics for at most 30 days. Jobs that never reached the
-- dispatcher also expire, so an outage cannot retain student contact data
-- indefinitely or trigger a very late confirmation.
create or replace function private.purge_request_creation_email_jobs()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed_count integer;
begin
  delete from public.request_creation_email_jobs as delivery
  where delivery.created_at < now() - interval '30 days';
  get diagnostics removed_count = row_count;
  return removed_count;
end;
$$;

revoke all on function private.invoke_request_creation_email_dispatch()
from public, anon, authenticated;
revoke all on function private.queue_request_creation_email()
from public, anon, authenticated;
revoke all on function private.purge_request_creation_email_jobs()
from public, anon, authenticated;
revoke all on function public.get_request_creation_email_credentials()
from public, anon, authenticated;
revoke all on function public.claim_request_creation_email_jobs(integer)
from public, anon, authenticated;
revoke all on function public.mark_request_creation_email_accepted(uuid, text)
from public, anon, authenticated;
revoke all on function public.mark_request_creation_email_failed(uuid, text, boolean)
from public, anon, authenticated;

grant execute on function public.claim_request_creation_email_jobs(integer) to service_role;
grant execute on function public.get_request_creation_email_credentials() to service_role;
grant execute on function public.mark_request_creation_email_accepted(uuid, text) to service_role;
grant execute on function public.mark_request_creation_email_failed(uuid, text, boolean) to service_role;

select cron.schedule(
  'request-creation-email-every-minute',
  '* * * * *',
  'select private.invoke_request_creation_email_dispatch();'
);

select cron.schedule(
  'request-creation-email-purge-daily',
  '17 3 * * *',
  'select private.purge_request_creation_email_jobs();'
);
