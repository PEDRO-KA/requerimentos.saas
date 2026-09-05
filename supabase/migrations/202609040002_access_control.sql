-- Autenticação fechada, autorização por papel e isolamento por instituição.

create or replace function public.current_user_is_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.is_active from public.profiles p where p.id = auth.uid()),
    false
  );
$$;

create or replace function public.is_org_member(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_user_is_active()
    and exists (
      select 1
      from public.memberships m
      where m.organization_id = target_organization_id
        and m.user_id = auth.uid()
    );
$$;

create or replace function public.has_org_role(
  target_organization_id uuid,
  allowed_roles public.app_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_user_is_active()
    and exists (
      select 1
      from public.memberships m
      where m.organization_id = target_organization_id
        and m.user_id = auth.uid()
        and m.role = any(allowed_roles)
    );
$$;

create or replace function public.current_department(target_organization_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.department_id
  from public.memberships m
  where m.organization_id = target_organization_id
    and m.user_id = auth.uid()
  limit 1;
$$;

create or replace function public.shares_org_with_user(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_user_is_active()
    and exists (
      select 1
      from public.memberships mine
      join public.memberships theirs
        on theirs.organization_id = mine.organization_id
      where mine.user_id = auth.uid()
        and theirs.user_id = target_user_id
    );
$$;

create or replace function public.can_access_request(target_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.requests r
    where r.id = target_request_id
      and public.current_user_is_active()
      and (
        r.requester_id = auth.uid()
        or r.assigned_to = auth.uid()
        or public.has_org_role(r.organization_id, array['admin']::public.app_role[])
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

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_org uuid;
  selected_department uuid;
  selected_role public.app_role := 'student';
  creator uuid;
  normalized_cpf text;
begin
  select o.id into selected_org
  from public.organizations o
  where o.id = case
    when coalesce(new.raw_app_meta_data ->> 'organization_id', '') ~
      '^[0-9a-fA-F-]{36}$'
    then (new.raw_app_meta_data ->> 'organization_id')::uuid
    else '00000000-0000-0000-0000-000000000001'::uuid
  end
    and o.is_active;

  if selected_org is null then
    raise exception 'Invalid organization for new user';
  end if;

  if coalesce(new.raw_app_meta_data ->> 'department_id', '') ~
    '^[0-9a-fA-F-]{36}$'
  then
    selected_department := (new.raw_app_meta_data ->> 'department_id')::uuid;
  end if;

  if new.raw_app_meta_data ->> 'role' in
    ('admin', 'coordinator', 'attendant', 'student')
  then
    selected_role := (new.raw_app_meta_data ->> 'role')::public.app_role;
  end if;

  if coalesce(new.raw_app_meta_data ->> 'created_by', '') ~
    '^[0-9a-fA-F-]{36}$'
  then
    creator := (new.raw_app_meta_data ->> 'created_by')::uuid;
  end if;

  normalized_cpf := nullif(
    regexp_replace(coalesce(new.raw_user_meta_data ->> 'cpf', ''), '[^0-9]', '', 'g'),
    ''
  );

  insert into public.profiles (
    id, full_name, cpf_digits, email, is_active, created_by
  )
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      split_part(new.email, '@', 1)
    ),
    normalized_cpf,
    new.email,
    true,
    creator
  );

  insert into public.memberships (
    organization_id, user_id, department_id, role, created_by
  )
  values (
    selected_org, new.id, selected_department, selected_role, creator
  );

  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

create or replace function public.handle_auth_user_email_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is distinct from old.email then
    update public.profiles
    set email = new.email
    where id = new.id;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_email_updated
after update of email on auth.users
for each row execute function public.handle_auth_user_email_update();

alter table public.organizations enable row level security;
alter table public.departments enable row level security;
alter table public.profiles enable row level security;
alter table public.memberships enable row level security;
alter table public.request_types enable row level security;
alter table public.workflow_steps enable row level security;
alter table public.protocol_counters enable row level security;
alter table public.requests enable row level security;
alter table public.request_events enable row level security;
alter table public.request_attachments enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_logs enable row level security;

revoke all on table public.organizations from anon, authenticated;
revoke all on table public.departments from anon, authenticated;
revoke all on table public.profiles from anon, authenticated;
revoke all on table public.memberships from anon, authenticated;
revoke all on table public.request_types from anon, authenticated;
revoke all on table public.workflow_steps from anon, authenticated;
revoke all on table public.protocol_counters from anon, authenticated;
revoke all on table public.requests from anon, authenticated;
revoke all on table public.request_events from anon, authenticated;
revoke all on table public.request_attachments from anon, authenticated;
revoke all on table public.notifications from anon, authenticated;
revoke all on table public.audit_logs from anon, authenticated;

grant select on table public.organizations to authenticated;
grant select, insert, update, delete on table public.departments to authenticated;
grant select (id, full_name, is_active, created_at, updated_at)
  on table public.profiles to authenticated;
grant select on table public.memberships to authenticated;
grant select, insert, update, delete on table public.request_types to authenticated;
grant select, insert, update, delete on table public.workflow_steps to authenticated;
grant select, insert, delete on table public.requests to authenticated;
grant select on table public.request_events to authenticated;
grant select, insert, delete on table public.request_attachments to authenticated;
grant select, update on table public.notifications to authenticated;
grant select on table public.audit_logs to authenticated;

create policy organizations_select_member
on public.organizations for select
to authenticated
using (public.is_org_member(id));

create policy departments_select_member
on public.departments for select
to authenticated
using (public.is_org_member(organization_id));

create policy departments_insert_admin
on public.departments for insert
to authenticated
with check (
  public.has_org_role(organization_id, array['admin']::public.app_role[])
);

create policy departments_update_admin
on public.departments for update
to authenticated
using (
  public.has_org_role(organization_id, array['admin']::public.app_role[])
)
with check (
  public.has_org_role(organization_id, array['admin']::public.app_role[])
);

create policy departments_delete_admin
on public.departments for delete
to authenticated
using (
  public.has_org_role(organization_id, array['admin']::public.app_role[])
);

create policy profiles_select_same_org
on public.profiles for select
to authenticated
using (
  id = auth.uid()
  or public.shares_org_with_user(id)
);

create policy memberships_select_scoped
on public.memberships for select
to authenticated
using (
  user_id = auth.uid()
  or public.has_org_role(
    organization_id,
    array['admin', 'coordinator', 'attendant']::public.app_role[]
  )
);

create policy request_types_select_member
on public.request_types for select
to authenticated
using (public.is_org_member(organization_id));

create policy request_types_insert_admin
on public.request_types for insert
to authenticated
with check (
  public.has_org_role(organization_id, array['admin']::public.app_role[])
);

create policy request_types_update_admin
on public.request_types for update
to authenticated
using (
  public.has_org_role(organization_id, array['admin']::public.app_role[])
)
with check (
  public.has_org_role(organization_id, array['admin']::public.app_role[])
);

create policy request_types_delete_admin
on public.request_types for delete
to authenticated
using (
  public.has_org_role(organization_id, array['admin']::public.app_role[])
);

create policy workflow_steps_select_member
on public.workflow_steps for select
to authenticated
using (public.is_org_member(organization_id));

create policy workflow_steps_insert_admin
on public.workflow_steps for insert
to authenticated
with check (
  public.has_org_role(organization_id, array['admin']::public.app_role[])
);

create policy workflow_steps_update_admin
on public.workflow_steps for update
to authenticated
using (
  public.has_org_role(organization_id, array['admin']::public.app_role[])
)
with check (
  public.has_org_role(organization_id, array['admin']::public.app_role[])
);

create policy workflow_steps_delete_admin
on public.workflow_steps for delete
to authenticated
using (
  public.has_org_role(organization_id, array['admin']::public.app_role[])
);

create policy requests_select_authorized
on public.requests for select
to authenticated
using (public.can_access_request(id));

create policy requests_insert_authorized
on public.requests for insert
to authenticated
with check (
  public.is_org_member(organization_id)
  and (
    requester_id = auth.uid()
    or public.has_org_role(organization_id, array['admin']::public.app_role[])
  )
);

create policy requests_delete_admin
on public.requests for delete
to authenticated
using (
  public.has_org_role(organization_id, array['admin']::public.app_role[])
);

create policy request_events_select_authorized
on public.request_events for select
to authenticated
using (public.can_access_request(request_id));

create policy request_attachments_select_authorized
on public.request_attachments for select
to authenticated
using (public.can_access_request(request_id));

create policy request_attachments_insert_authorized
on public.request_attachments for insert
to authenticated
with check (
  uploaded_by = auth.uid()
  and public.can_access_request(request_id)
);

create policy request_attachments_delete_authorized
on public.request_attachments for delete
to authenticated
using (
  uploaded_by = auth.uid()
  or public.has_org_role(organization_id, array['admin']::public.app_role[])
);

create policy notifications_select_audience
on public.notifications for select
to authenticated
using (
  user_id = auth.uid()
  or (
    department_id = public.current_department(organization_id)
    and public.has_org_role(
      organization_id,
      array['admin', 'coordinator', 'attendant']::public.app_role[]
    )
  )
);

create policy notifications_update_own
on public.notifications for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy audit_logs_select_admin
on public.audit_logs for select
to authenticated
using (
  public.has_org_role(organization_id, array['admin']::public.app_role[])
);

create policy request_documents_insert
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'request-documents'
  and public.is_org_member(((storage.foldername(name))[1])::uuid)
  and public.can_access_request(((storage.foldername(name))[2])::uuid)
  and (storage.foldername(name))[3] = auth.uid()::text
);

create policy request_documents_select
on storage.objects for select
to authenticated
using (
  bucket_id = 'request-documents'
  and exists (
    select 1
    from public.request_attachments a
    where a.storage_path = storage.objects.name
      and public.can_access_request(a.request_id)
  )
);

create policy request_documents_delete
on storage.objects for delete
to authenticated
using (
  bucket_id = 'request-documents'
  and exists (
    select 1
    from public.request_attachments a
    where a.storage_path = storage.objects.name
      and (
        a.uploaded_by = auth.uid()
        or public.has_org_role(
          a.organization_id,
          array['admin']::public.app_role[]
        )
      )
  )
);

revoke all on function public.current_user_is_active() from public, anon;
revoke all on function public.is_org_member(uuid) from public, anon;
revoke all on function public.has_org_role(uuid, public.app_role[]) from public, anon;
revoke all on function public.current_department(uuid) from public, anon;
revoke all on function public.shares_org_with_user(uuid) from public, anon;
revoke all on function public.can_access_request(uuid) from public, anon;
grant execute on function public.current_user_is_active() to authenticated;
grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.has_org_role(uuid, public.app_role[]) to authenticated;
grant execute on function public.current_department(uuid) to authenticated;
grant execute on function public.shares_org_with_user(uuid) to authenticated;
grant execute on function public.can_access_request(uuid) to authenticated;
