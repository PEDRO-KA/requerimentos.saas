-- Preserve the actor's sector at event time and allow each non-admin to advance once.

alter table public.request_events
  add column actor_department_name_snapshot text;

create or replace function public.snapshot_request_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.actor_id is not null and new.actor_name_snapshot is null then
    select p.full_name into new.actor_name_snapshot
    from public.profiles as p
    where p.id = new.actor_id;
  end if;

  if new.actor_id is not null
    and new.actor_department_name_snapshot is null
  then
    select coalesce(
      d.name,
      case when m.role = 'admin' then 'Administração' end
    )
    into new.actor_department_name_snapshot
    from public.memberships as m
    left join public.departments as d
      on d.id = m.department_id
      and d.organization_id = m.organization_id
    where m.organization_id = new.organization_id
      and m.user_id = new.actor_id;
  end if;

  if new.from_department_id is not null
    and new.from_department_name_snapshot is null
  then
    select d.name into new.from_department_name_snapshot
    from public.departments as d
    where d.id = new.from_department_id
      and d.organization_id = new.organization_id;
  end if;

  if new.to_department_id is not null
    and new.to_department_name_snapshot is null
  then
    select d.name into new.to_department_name_snapshot
    from public.departments as d
    where d.id = new.to_department_id
      and d.organization_id = new.organization_id;
  end if;

  return new;
end;
$$;

-- Historical membership at the time of older events is unknown. Leave their
-- snapshot null rather than presenting today's department as historical fact.

create or replace function public.has_advanced_request(target_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.request_events as e
    join public.requests as r
      on r.id = e.request_id
      and r.organization_id = e.organization_id
    where e.request_id = target_request_id
      and e.actor_id = auth.uid()
      and (
        e.event_type = 'forwarded'
        or e.to_status = 'completed'
      )
      and public.is_org_member(r.organization_id)
  );
$$;

revoke all on function public.has_advanced_request(uuid)
from public, anon, authenticated;

create or replace function public.can_act_on_request(target_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.requests as r
    where r.id = target_request_id
      and public.current_user_is_active()
      and r.status not in ('completed', 'rejected', 'canceled')
      and (
        public.has_org_role(
          r.organization_id,
          array['admin']::public.app_role[]
        )
        or (
          public.has_org_role(
            r.organization_id,
            array['coordinator', 'attendant']::public.app_role[]
          )
          and r.current_department_id = public.current_department(r.organization_id)
          and not public.has_advanced_request(r.id)
        )
      )
  );
$$;

-- Share the request-row lock with advance_request so a note or attachment
-- cannot commit using permission checked before a concurrent advance.
create or replace function public.can_add_request_content(target_request_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  locked_request_id uuid;
begin
  select r.id into locked_request_id
  from public.requests as r
  where r.id = target_request_id
  for update;

  if locked_request_id is null then
    return false;
  end if;

  return public.can_act_on_request(target_request_id)
    or exists (
      select 1
      from public.requests as r
      where r.id = target_request_id
        and r.requester_id = auth.uid()
        and r.status not in ('completed', 'rejected', 'canceled')
        and public.has_org_role(
          r.organization_id,
          array['student']::public.app_role[]
        )
    );
end;
$$;

create or replace function public.can_request_complement(target_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.can_act_on_request(target_request_id)
    or exists (
      select 1
      from public.requests as r
      where r.id = target_request_id
        and r.status not in ('completed', 'rejected', 'canceled')
        and public.has_org_role(
          r.organization_id,
          array['coordinator', 'attendant']::public.app_role[]
        )
        and public.can_access_request(r.id)
        and public.has_advanced_request(r.id)
    );
$$;

revoke all on function public.can_request_complement(uuid)
from public, anon;
grant execute on function public.can_request_complement(uuid)
to authenticated;

create or replace function public.request_complement(
  target_request_id uuid,
  message text
)
returns public.requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_request public.requests%rowtype;
  updated_request public.requests%rowtype;
begin
  select * into current_request
  from public.requests as r
  where r.id = target_request_id
  for update;

  if current_request.id is null
    or not public.can_request_complement(current_request.id)
  then
    raise exception 'Not authorized';
  end if;

  if char_length(trim(coalesce(message, ''))) < 3 then
    raise exception 'A message is required';
  end if;

  update public.requests as r
  set status = 'awaiting_requester'
  where r.id = current_request.id
  returning r.* into updated_request;

  insert into public.request_events (
    organization_id, request_id, actor_id, event_type, note,
    from_status, to_status, from_step_id, to_step_id,
    from_department_id, to_department_id
  )
  values (
    current_request.organization_id,
    current_request.id,
    auth.uid(),
    'status_changed',
    trim(message),
    current_request.status,
    updated_request.status,
    current_request.current_step_id,
    updated_request.current_step_id,
    current_request.current_department_id,
    updated_request.current_department_id
  );

  insert into public.notifications (
    organization_id, user_id, request_id, title, body
  )
  values (
    current_request.organization_id,
    current_request.requester_id,
    current_request.id,
    'Complemento solicitado',
    trim(message)
  );

  return updated_request;
end;
$$;
