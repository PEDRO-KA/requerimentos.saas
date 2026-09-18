-- Comprovantes imutáveis e acesso restrito à equipe.
alter table public.requests
  add column discipline text
  constraint requests_discipline_length check (char_length(discipline) <= 160);

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.request_receipts (
  request_id uuid primary key,
  organization_id uuid not null,
  snapshot jsonb not null,
  source text not null check (source in ('completion', 'legacy')),
  captured_at timestamptz not null default now(),
  foreign key (request_id, organization_id)
    references public.requests(id, organization_id) on delete restrict
);

create index request_receipts_organization_idx
on public.request_receipts (organization_id);

alter table public.request_receipts enable row level security;
revoke all on table public.request_receipts from public, anon, authenticated;
grant select on table public.request_receipts to authenticated;

create policy request_receipts_select_staff
on public.request_receipts for select
to authenticated
using (
  public.has_org_role(
    organization_id,
    array['admin', 'coordinator', 'attendant']::public.app_role[]
  )
  and public.can_access_request(request_id)
);

create or replace function private.capture_request_receipt(
  target_request_id uuid,
  receipt_source text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if receipt_source not in ('completion', 'legacy') then
    raise exception 'Invalid receipt source';
  end if;

  insert into public.request_receipts (
    request_id, organization_id, snapshot, source
  )
  select
    r.id,
    r.organization_id,
    jsonb_build_object(
      'institution', o.name,
      'protocol', r.protocol,
      'student', jsonb_build_object(
        'name', case
          when s.id is not null then s.full_name
          when requester_membership.role = 'student' then creator.full_name
        end,
        'cpf', case
          when s.id is not null then s.cpf_digits
          when requester_membership.role = 'student' then creator.cpf_digits
        end,
        'email', case
          when s.id is not null then s.email
          when requester_membership.role = 'student' then creator.email
        end,
        'mobile', s.mobile_digits,
        'birth_date', s.birth_date,
        'sex', s.sex,
        'course', c.name,
        'class', cc.name
      ),
      'type', rt.name,
      'discipline', r.discipline,
      'description', r.description,
      'creator', coalesce(
        (select e.actor_name_snapshot
         from public.request_events as e
         where e.request_id = r.id and e.event_type = 'created'
         order by e.created_at, e.id limit 1),
        creator.full_name
      ),
      'opened_at', r.created_at,
      'completed_at', r.completed_at,
      'route', coalesce(
        (select jsonb_agg(
          jsonb_build_object(
            'department', coalesce(e.to_department_name_snapshot, d.name),
            'at', e.created_at
          ) order by e.created_at, e.id
        )
         from public.request_events as e
         left join public.departments as d
           on d.id = e.to_department_id
          and d.organization_id = e.organization_id
         where e.request_id = r.id
           and e.to_department_id is not null
           and e.event_type in ('created', 'forwarded')),
        '[]'::jsonb
      ),
      'observations', coalesce(
        (select jsonb_agg(
          jsonb_build_object(
            'text', e.note,
            'actor', coalesce(e.actor_name_snapshot, p.full_name),
            'at', e.created_at
          ) order by e.created_at, e.id
        )
         from public.request_events as e
         left join public.profiles as p on p.id = e.actor_id
         where e.request_id = r.id
           and e.event_type <> 'created'
           and nullif(trim(e.note), '') is not null),
        '[]'::jsonb
      )
    ),
    receipt_source
  from public.requests as r
  join public.organizations as o on o.id = r.organization_id
  join public.request_types as rt on rt.id = r.request_type_id
  left join public.students as s on s.id = r.student_id
  left join public.student_enrollments as se on se.id = r.student_enrollment_id
  left join public.courses as c on c.id = se.course_id
  left join public.course_classes as cc on cc.id = se.class_id
  left join public.profiles as creator on creator.id = r.requester_id
  left join public.memberships as requester_membership
    on requester_membership.organization_id = r.organization_id
   and requester_membership.user_id = r.requester_id
  where r.id = target_request_id and r.status = 'completed'
  on conflict (request_id) do nothing;
end;
$$;

revoke all on function private.capture_request_receipt(uuid, text)
from public, anon, authenticated;

create or replace function private.capture_completed_request_receipt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.to_status = 'completed' then
    perform private.capture_request_receipt(new.request_id, 'completion');
  end if;
  return new;
end;
$$;

revoke all on function private.capture_completed_request_receipt()
from public, anon, authenticated;

create trigger request_events_capture_receipt
after insert on public.request_events
for each row execute function private.capture_completed_request_receipt();

-- Os registros anteriores refletem os dados disponíveis nesta migração.
select private.capture_request_receipt(r.id, 'legacy')
from public.requests as r
where r.status = 'completed';

create or replace function public.create_request_for_student_with_discipline(
  target_organization_id uuid,
  target_request_type_id uuid,
  target_student_id uuid,
  target_enrollment_id uuid,
  request_description text,
  request_discipline text
)
returns public.requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_request public.requests%rowtype;
begin
  if char_length(trim(coalesce(request_discipline, ''))) > 160 then
    raise exception 'Discipline is too long';
  end if;

  created_request := public.create_request_for_student(
    target_organization_id,
    target_request_type_id,
    target_student_id,
    target_enrollment_id,
    request_description
  );

  update public.requests as r
  set discipline = nullif(trim(coalesce(request_discipline, '')), '')
  where r.id = created_request.id
  returning r.* into created_request;

  return created_request;
end;
$$;

revoke all on function public.create_request_for_student_with_discipline(
  uuid, uuid, uuid, uuid, text, text
) from public, anon;
grant execute on function public.create_request_for_student_with_discipline(
  uuid, uuid, uuid, uuid, text, text
) to authenticated;

-- O portal do aluno foi descontinuado: bloquear também o acesso direto à API.
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
      and public.has_org_role(
        r.organization_id,
        array['admin', 'coordinator', 'attendant']::public.app_role[]
      )
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

drop policy if exists requests_insert_authorized on public.requests;
create policy requests_insert_authorized
on public.requests for insert
to authenticated
with check (
  requester_id = auth.uid()
  and public.has_org_role(
    organization_id,
    array['admin', 'coordinator', 'attendant']::public.app_role[]
  )
);

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

  return public.can_act_on_request(target_request_id);
end;
$$;

drop policy if exists notifications_select_audience on public.notifications;
create policy notifications_select_audience
on public.notifications for select
to authenticated
using (
  public.has_org_role(
    organization_id,
    array['admin', 'coordinator', 'attendant']::public.app_role[]
  )
  and (
    user_id = auth.uid()
    or department_id = public.current_department(organization_id)
  )
);

drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own
on public.notifications for update
to authenticated
using (
  user_id = auth.uid()
  and public.has_org_role(
    organization_id,
    array['admin', 'coordinator', 'attendant']::public.app_role[]
  )
)
with check (
  user_id = auth.uid()
  and public.has_org_role(
    organization_id,
    array['admin', 'coordinator', 'attendant']::public.app_role[]
  )
);
