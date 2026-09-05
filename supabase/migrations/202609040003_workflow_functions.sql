-- Funções transacionais usadas pelas telas do aplicativo.

create or replace function public.add_business_days(
  start_at timestamptz,
  business_days integer
)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  result_at timestamptz := start_at;
  remaining integer := greatest(business_days, 0);
begin
  while remaining > 0 loop
    result_at := result_at + interval '1 day';
    if extract(isodow from result_at) < 6 then
      remaining := remaining - 1;
    end if;
  end loop;
  return result_at;
end;
$$;

create or replace function public.generate_protocol(target_organization_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_year integer := extract(year from current_date)::integer;
  next_value bigint;
begin
  insert into public.protocol_counters (
    organization_id, protocol_year, last_value
  )
  values (target_organization_id, target_year, 1)
  on conflict (organization_id, protocol_year)
  do update set last_value = public.protocol_counters.last_value + 1
  returning last_value into next_value;

  return format('#%s-%s', target_year, lpad(next_value::text, 4, '0'));
end;
$$;

create or replace function public.prepare_new_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  first_step public.workflow_steps%rowtype;
  deadline_days integer;
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

  select rt.default_deadline_business_days
  into deadline_days
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
  order by ws.position
  limit 1;

  if first_step.id is null then
    raise exception 'Request type has no configured workflow';
  end if;

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

create trigger requests_prepare_insert
before insert on public.requests
for each row execute function public.prepare_new_request();

create or replace function public.record_request_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.request_events (
    organization_id,
    request_id,
    actor_id,
    event_type,
    note,
    to_status,
    to_step_id,
    to_department_id
  )
  values (
    new.organization_id,
    new.id,
    auth.uid(),
    'created',
    'Requerimento criado.',
    new.status,
    new.current_step_id,
    new.current_department_id
  );

  if new.current_department_id is not null then
    insert into public.notifications (
      organization_id,
      department_id,
      request_id,
      title,
      body
    )
    values (
      new.organization_id,
      new.current_department_id,
      new.id,
      'Novo requerimento',
      new.protocol || ' aguarda análise.'
    );
  end if;
  return new;
end;
$$;

create trigger requests_record_created
after insert on public.requests
for each row execute function public.record_request_created();

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
  where id = current_request.current_step_id;

  select ws.* into next_step
  from public.workflow_steps ws
  where ws.request_type_id = current_request.request_type_id
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
  from public.requests
  where id = target_request_id
  for update;

  if current_request.id is null
    or not (
      public.has_org_role(
        current_request.organization_id,
        array['admin']::public.app_role[]
      )
      or (
        public.has_org_role(
          current_request.organization_id,
          array['coordinator', 'attendant']::public.app_role[]
        )
        and current_request.current_department_id =
          public.current_department(current_request.organization_id)
      )
    )
  then
    raise exception 'Not authorized';
  end if;

  if char_length(trim(coalesce(message, ''))) < 3 then
    raise exception 'A message is required';
  end if;

  update public.requests
  set status = 'awaiting_requester'
  where id = current_request.id
  returning * into updated_request;

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

create or replace function public.add_request_note(
  target_request_id uuid,
  note_text text
)
returns public.request_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_request public.requests%rowtype;
  created_event public.request_events%rowtype;
begin
  if not public.can_access_request(target_request_id) then
    raise exception 'Not authorized';
  end if;
  if char_length(trim(coalesce(note_text, ''))) < 2 then
    raise exception 'A note is required';
  end if;

  select * into target_request
  from public.requests
  where id = target_request_id;

  insert into public.request_events (
    organization_id, request_id, actor_id, event_type, note
  )
  values (
    target_request.organization_id,
    target_request.id,
    auth.uid(),
    'note',
    trim(note_text)
  )
  returning * into created_event;

  return created_event;
end;
$$;

create or replace function public.record_attachment_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1
    from public.requests r
    where r.id = old.request_id
  ) then
    return old;
  end if;

  insert into public.request_events (
    organization_id, request_id, actor_id, event_type, note
  )
  values (
    coalesce(new.organization_id, old.organization_id),
    coalesce(new.request_id, old.request_id),
    auth.uid(),
    case when tg_op = 'INSERT'
      then 'attachment_added'::public.request_event_type
      else 'attachment_removed'::public.request_event_type
    end,
    case when tg_op = 'INSERT'
      then 'Documento anexado: ' || new.file_name
      else 'Documento removido: ' || old.file_name
    end
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger request_attachments_record_insert
after insert on public.request_attachments
for each row execute function public.record_attachment_event();
create trigger request_attachments_record_delete
after delete on public.request_attachments
for each row execute function public.record_attachment_event();

insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
)
values (
  'request-documents',
  'request-documents',
  false,
  10485760,
  array['application/pdf', 'image/jpeg', 'image/png']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_data jsonb;
  new_data jsonb;
  record_data jsonb;
  target_org uuid;
  target_id text;
begin
  old_data := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  new_data := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  record_data := coalesce(new_data, old_data);
  target_org := nullif(record_data ->> 'organization_id', '')::uuid;
  target_id := coalesce(
    record_data ->> 'id',
    record_data ->> 'user_id',
    'unknown'
  );

  insert into public.audit_logs (
    organization_id, actor_id, entity_table, entity_id,
    action, before_data, after_data
  )
  values (
    target_org, auth.uid(), tg_table_name, target_id,
    tg_op, old_data, new_data
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger departments_audit
after insert or update or delete on public.departments
for each row execute function public.audit_row_change();
create trigger memberships_audit
after insert or update or delete on public.memberships
for each row execute function public.audit_row_change();
create trigger request_types_audit
after insert or update or delete on public.request_types
for each row execute function public.audit_row_change();
create trigger workflow_steps_audit
after insert or update or delete on public.workflow_steps
for each row execute function public.audit_row_change();
create trigger requests_audit
after insert or update or delete on public.requests
for each row execute function public.audit_row_change();

revoke all on function public.generate_protocol(uuid) from public, anon, authenticated;
revoke all on function public.prepare_new_request() from public, anon, authenticated;
revoke all on function public.record_request_created() from public, anon, authenticated;
revoke all on function public.record_attachment_event() from public, anon, authenticated;
revoke all on function public.audit_row_change() from public, anon, authenticated;
revoke all on function public.advance_request(uuid, text) from public, anon;
revoke all on function public.request_complement(uuid, text) from public, anon;
revoke all on function public.add_request_note(uuid, text) from public, anon;
grant execute on function public.advance_request(uuid, text) to authenticated;
grant execute on function public.request_complement(uuid, text) to authenticated;
grant execute on function public.add_request_note(uuid, text) to authenticated;
