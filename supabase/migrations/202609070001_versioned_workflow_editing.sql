-- Versiona fluxos para que alterações afetem somente novos requerimentos.

alter table public.request_types
add column current_workflow_version integer not null default 1
check (current_workflow_version > 0);

alter table public.workflow_steps
add column workflow_version integer not null default 1
check (workflow_version > 0);

alter table public.requests
add column workflow_version integer not null default 1
check (workflow_version > 0);

alter table public.workflow_steps
drop constraint workflow_steps_request_type_id_position_key;

alter table public.workflow_steps
add constraint workflow_steps_type_version_position_key
unique (request_type_id, workflow_version, position);

create index workflow_steps_current_version_idx
on public.workflow_steps (request_type_id, workflow_version, position);

create or replace function public.prepare_new_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  first_step public.workflow_steps%rowtype;
  deadline_days integer;
  selected_workflow_version integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  new.requester_id := coalesce(new.requester_id, auth.uid());

  if new.organization_id is null then
    select m.organization_id into new.organization_id
    from public.memberships m
    where m.user_id = auth.uid()
    order by m.created_at
    limit 1;
  end if;

  if new.organization_id is null
    or not exists (
      select 1
      from public.memberships m
      where m.organization_id = new.organization_id
        and m.user_id = new.requester_id
    )
  then
    raise exception 'Requester is not a member of this organization';
  end if;

  select
    rt.default_deadline_business_days,
    rt.current_workflow_version
  into deadline_days, selected_workflow_version
  from public.request_types rt
  where rt.id = new.request_type_id
    and rt.organization_id = new.organization_id
    and rt.is_active;

  if not found then
    raise exception 'Invalid or inactive request type';
  end if;

  select ws.* into first_step
  from public.workflow_steps ws
  where ws.request_type_id = new.request_type_id
    and ws.organization_id = new.organization_id
    and ws.workflow_version = selected_workflow_version
  order by ws.position
  limit 1;

  if first_step.id is null then
    raise exception 'Request type has no configured workflow';
  end if;

  new.workflow_version := selected_workflow_version;
  new.protocol := public.generate_protocol(new.organization_id);
  new.status := 'open';
  new.current_step_id := first_step.id;
  new.current_department_id := first_step.department_id;
  new.assigned_to := null;
  new.opened_at := now();
  new.due_at := public.add_business_days(now(), deadline_days);
  new.completed_at := null;
  return new;
end;
$$;

create or replace function public.advance_request(
  target_request_id uuid,
  observation text default ''
)
returns public.requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_request public.requests%rowtype;
  current_position integer;
  next_step public.workflow_steps%rowtype;
  updated_request public.requests%rowtype;
  permitted boolean;
begin
  select * into current_request
  from public.requests
  where id = target_request_id
  for update;

  if current_request.id is null then
    raise exception 'Request not found';
  end if;

  permitted :=
    public.has_org_role(
      current_request.organization_id,
      array['admin']::public.app_role[]
    )
    or (
      public.has_org_role(
        current_request.organization_id,
        array['coordinator', 'attendant']::public.app_role[]
      )
      and (
        current_request.assigned_to = auth.uid()
        or current_request.current_department_id =
          public.current_department(current_request.organization_id)
      )
    );

  if not permitted then
    raise exception 'Not authorized to advance this request';
  end if;

  if current_request.status in ('completed', 'rejected', 'canceled') then
    raise exception 'Request is already closed';
  end if;

  select position into current_position
  from public.workflow_steps
  where id = current_request.current_step_id
    and workflow_version = current_request.workflow_version;

  select ws.* into next_step
  from public.workflow_steps ws
  where ws.request_type_id = current_request.request_type_id
    and ws.workflow_version = current_request.workflow_version
    and ws.position > current_position
  order by ws.position
  limit 1;

  if next_step.id is null or next_step.is_terminal then
    update public.requests
    set
      current_step_id = coalesce(next_step.id, current_step_id),
      current_department_id = null,
      assigned_to = null,
      status = 'completed',
      completed_at = now()
    where id = current_request.id
    returning * into updated_request;
  else
    update public.requests
    set
      current_step_id = next_step.id,
      current_department_id = next_step.department_id,
      assigned_to = null,
      status = 'forwarded'
    where id = current_request.id
    returning * into updated_request;
  end if;

  insert into public.request_events (
    organization_id,
    request_id,
    actor_id,
    event_type,
    note,
    from_status,
    to_status,
    from_step_id,
    to_step_id,
    from_department_id,
    to_department_id,
    from_assignee_id,
    to_assignee_id
  )
  values (
    current_request.organization_id,
    current_request.id,
    auth.uid(),
    case when updated_request.status = 'completed'
      then 'status_changed'::public.request_event_type
      else 'forwarded'::public.request_event_type
    end,
    coalesce(observation, ''),
    current_request.status,
    updated_request.status,
    current_request.current_step_id,
    updated_request.current_step_id,
    current_request.current_department_id,
    updated_request.current_department_id,
    current_request.assigned_to,
    updated_request.assigned_to
  );

  if updated_request.status = 'completed' then
    insert into public.notifications (
      organization_id, user_id, request_id, title, body
    )
    values (
      updated_request.organization_id,
      updated_request.requester_id,
      updated_request.id,
      'Requerimento concluído',
      updated_request.protocol || ' foi concluído.'
    );
  elsif updated_request.current_department_id is not null then
    insert into public.notifications (
      organization_id, department_id, request_id, title, body
    )
    values (
      updated_request.organization_id,
      updated_request.current_department_id,
      updated_request.id,
      'Requerimento encaminhado',
      updated_request.protocol || ' aguarda a próxima etapa.'
    );
  end if;

  return updated_request;
end;
$$;

create or replace function public.save_workflow_steps(
  target_request_type_id uuid,
  expected_workflow_version integer,
  ordered_department_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_type public.request_types%rowtype;
  next_workflow_version integer;
  step_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into target_type
  from public.request_types
  where id = target_request_type_id
  for update;

  if target_type.id is null then
    raise exception 'Request type not found';
  end if;

  if not public.has_org_role(
    target_type.organization_id,
    array['admin']::public.app_role[]
  ) then
    raise exception 'Not authorized to edit this workflow';
  end if;

  if target_type.current_workflow_version <> expected_workflow_version then
    raise exception 'O fluxo foi alterado por outro administrador. Reabra o editor.';
  end if;

  step_count := coalesce(array_length(ordered_department_ids, 1), 0);
  if step_count < 1 or step_count > 20 then
    raise exception 'O fluxo deve ter entre 1 e 20 etapas departamentais.';
  end if;

  if exists (
    select 1
    from unnest(ordered_department_ids) as selected(department_id)
    where selected.department_id is null
      or not exists (
        select 1
        from public.departments d
        where d.id = selected.department_id
          and d.organization_id = target_type.organization_id
          and d.is_active
      )
  ) then
    raise exception 'O fluxo contém um departamento inválido ou inativo.';
  end if;

  next_workflow_version := target_type.current_workflow_version + 1;

  insert into public.workflow_steps (
    organization_id,
    request_type_id,
    workflow_version,
    position,
    label,
    department_id,
    is_terminal
  )
  select
    target_type.organization_id,
    target_type.id,
    next_workflow_version,
    selected.position::integer,
    d.name,
    d.id,
    false
  from unnest(ordered_department_ids) with ordinality
    as selected(department_id, position)
  join public.departments d on d.id = selected.department_id;

  insert into public.workflow_steps (
    organization_id,
    request_type_id,
    workflow_version,
    position,
    label,
    department_id,
    is_terminal
  )
  values (
    target_type.organization_id,
    target_type.id,
    next_workflow_version,
    step_count + 1,
    'Conclusão',
    null,
    true
  );

  update public.request_types
  set current_workflow_version = next_workflow_version
  where id = target_type.id;

  return next_workflow_version;
end;
$$;

revoke all on function public.save_workflow_steps(uuid, integer, uuid[])
from public, anon;
grant execute on function public.save_workflow_steps(uuid, integer, uuid[])
to authenticated;
