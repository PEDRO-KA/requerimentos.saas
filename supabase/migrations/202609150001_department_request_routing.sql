-- Isolamento operacional por setor, histórico de passagem e fila de e-mail.

create table public.request_department_history (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  request_id uuid not null,
  department_id uuid not null,
  workflow_step_id uuid not null,
  entered_by uuid references auth.users(id) on delete set null,
  entered_at timestamptz not null default now(),
  primary key (request_id, workflow_step_id),
  foreign key (request_id, organization_id)
    references public.requests(id, organization_id)
    on delete cascade,
  foreign key (department_id, organization_id)
    references public.departments(id, organization_id)
    on delete restrict,
  foreign key (workflow_step_id, organization_id)
    references public.workflow_steps(id, organization_id)
    on delete restrict
);

create index request_department_history_access_idx
on public.request_department_history (organization_id, department_id, request_id);

alter table public.request_department_history enable row level security;
revoke all on table public.request_department_history from public, anon, authenticated;

alter table public.request_events
  add column actor_name_snapshot text,
  add column from_department_name_snapshot text,
  add column to_department_name_snapshot text;

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

create trigger request_events_snapshot_insert
before insert on public.request_events
for each row execute function public.snapshot_request_event();

update public.request_events as e
set actor_name_snapshot = p.full_name
from public.profiles as p
where p.id = e.actor_id
  and e.actor_name_snapshot is null;

update public.request_events as e
set from_department_name_snapshot = d.name
from public.departments as d
where d.id = e.from_department_id
  and d.organization_id = e.organization_id
  and e.from_department_name_snapshot is null;

update public.request_events as e
set to_department_name_snapshot = d.name
from public.departments as d
where d.id = e.to_department_id
  and d.organization_id = e.organization_id
  and e.to_department_name_snapshot is null;

insert into public.request_department_history (
  organization_id,
  request_id,
  department_id,
  workflow_step_id,
  entered_by,
  entered_at
)
select distinct on (e.request_id, e.to_step_id)
  e.organization_id,
  e.request_id,
  e.to_department_id,
  e.to_step_id,
  e.actor_id,
  e.created_at
from public.request_events as e
where e.to_department_id is not null
  and e.to_step_id is not null
order by e.request_id, e.to_step_id, e.created_at
on conflict (request_id, workflow_step_id) do nothing;

insert into public.request_department_history (
  organization_id,
  request_id,
  department_id,
  workflow_step_id,
  entered_by,
  entered_at
)
select
  r.organization_id,
  r.id,
  r.current_department_id,
  r.current_step_id,
  r.requester_id,
  r.opened_at
from public.requests as r
where r.current_department_id is not null
  and r.current_step_id is not null
on conflict (request_id, workflow_step_id) do nothing;

create or replace function public.track_request_department_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.current_department_id is null or new.current_step_id is null then
    return new;
  end if;

  insert into public.request_department_history (
    organization_id,
    request_id,
    department_id,
    workflow_step_id,
    entered_by,
    entered_at
  )
  values (
    new.organization_id,
    new.id,
    new.current_department_id,
    new.current_step_id,
    coalesce(auth.uid(), new.requester_id),
    now()
  )
  on conflict (request_id, workflow_step_id) do nothing;

  return new;
end;
$$;

create trigger requests_track_department_insert
after insert on public.requests
for each row execute function public.track_request_department_entry();

create trigger requests_track_department_update
after update of current_step_id, current_department_id on public.requests
for each row
when (
  old.current_step_id is distinct from new.current_step_id
  or old.current_department_id is distinct from new.current_department_id
)
execute function public.track_request_department_entry();

create or replace function public.can_access_request(target_request_id uuid)
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
      and public.is_org_member(r.organization_id)
      and (
        r.requester_id = auth.uid()
        or public.has_org_role(
          r.organization_id,
          array['admin']::public.app_role[]
        )
        or (
          public.has_org_role(
            r.organization_id,
            array['coordinator', 'attendant']::public.app_role[]
          )
          and (
            r.current_department_id = public.current_department(r.organization_id)
            or exists (
              select 1
              from public.request_department_history as h
              where h.request_id = r.id
                and h.organization_id = r.organization_id
                and h.department_id = public.current_department(r.organization_id)
            )
          )
        )
      )
  );
$$;

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
        )
      )
  );
$$;

create or replace function public.can_add_request_content(target_request_id uuid)
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
        and r.requester_id = auth.uid()
        and r.status not in ('completed', 'rejected', 'canceled')
        and public.has_org_role(
          r.organization_id,
          array['student']::public.app_role[]
        )
    );
$$;

revoke all on function public.can_act_on_request(uuid) from public, anon;
revoke all on function public.can_add_request_content(uuid) from public, anon;
grant execute on function public.can_act_on_request(uuid) to authenticated;
grant execute on function public.can_add_request_content(uuid) to authenticated;

drop policy if exists request_attachments_insert_authorized
on public.request_attachments;
create policy request_attachments_insert_authorized
on public.request_attachments for insert
to authenticated
with check (
  uploaded_by = auth.uid()
  and public.can_add_request_content(request_id)
);

drop policy if exists request_attachments_delete_authorized
on public.request_attachments;
create policy request_attachments_delete_authorized
on public.request_attachments for delete
to authenticated
using (
  public.has_org_role(organization_id, array['admin']::public.app_role[])
  or (
    uploaded_by = auth.uid()
    and public.can_add_request_content(request_id)
  )
);

drop policy if exists request_documents_insert on storage.objects;
create policy request_documents_insert
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'request-documents'
  and public.is_org_member(((storage.foldername(name))[1])::uuid)
  and public.can_add_request_content(((storage.foldername(name))[2])::uuid)
  and (storage.foldername(name))[3] = auth.uid()::text
);

drop policy if exists request_documents_delete on storage.objects;
create policy request_documents_delete
on storage.objects for delete
to authenticated
using (
  bucket_id = 'request-documents'
  and exists (
    select 1
    from public.request_attachments as a
    where a.storage_path = storage.objects.name
      and (
        public.has_org_role(
          a.organization_id,
          array['admin']::public.app_role[]
        )
        or (
          a.uploaded_by = auth.uid()
          and public.can_add_request_content(a.request_id)
        )
      )
  )
);

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
begin
  select * into current_request
  from public.requests as r
  where r.id = target_request_id
  for update;

  if current_request.id is null then
    raise exception 'Request not found';
  end if;

  if not public.can_act_on_request(current_request.id) then
    raise exception 'Not authorized to advance this request';
  end if;

  select ws.position into current_position
  from public.workflow_steps as ws
  where ws.id = current_request.current_step_id
    and ws.workflow_version = current_request.workflow_version;

  select ws.* into next_step
  from public.workflow_steps as ws
  where ws.request_type_id = current_request.request_type_id
    and ws.organization_id = current_request.organization_id
    and ws.workflow_version = current_request.workflow_version
    and ws.position > current_position
  order by ws.position
  limit 1;

  if next_step.id is null or next_step.is_terminal then
    update public.requests as r
    set
      current_step_id = coalesce(next_step.id, r.current_step_id),
      current_department_id = null,
      assigned_to = null,
      status = 'completed',
      completed_at = now()
    where r.id = current_request.id
    returning r.* into updated_request;
  else
    update public.requests as r
    set
      current_step_id = next_step.id,
      current_department_id = next_step.department_id,
      assigned_to = null,
      status = 'forwarded'
    where r.id = current_request.id
    returning r.* into updated_request;
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
  from public.requests as r
  where r.id = target_request_id
  for update;

  if current_request.id is null
    or not public.can_act_on_request(current_request.id)
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
  if not public.can_add_request_content(target_request_id) then
    raise exception 'Not authorized';
  end if;

  if char_length(trim(coalesce(note_text, ''))) < 2 then
    raise exception 'A note is required';
  end if;

  select * into target_request
  from public.requests as r
  where r.id = target_request_id;

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
