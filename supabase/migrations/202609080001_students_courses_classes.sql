-- Cadastro acadêmico separado das contas de acesso, com histórico de vínculo.

create or replace function public.is_valid_cpf(input_value text)
returns boolean
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  digits text := regexp_replace(input_value, '[^0-9]', '', 'g');
  total integer := 0;
  expected_digit integer;
  digit_position integer;
begin
  if char_length(digits) <> 11 or digits ~ '^([0-9])\1{10}$' then
    return false;
  end if;

  for digit_position in 1..9 loop
    total := total + substring(digits, digit_position, 1)::integer * (11 - digit_position);
  end loop;
  expected_digit := 11 - (total % 11);
  if expected_digit >= 10 then expected_digit := 0; end if;
  if expected_digit <> substring(digits, 10, 1)::integer then return false; end if;

  total := 0;
  for digit_position in 1..10 loop
    total := total + substring(digits, digit_position, 1)::integer * (12 - digit_position);
  end loop;
  expected_digit := 11 - (total % 11);
  if expected_digit >= 10 then expected_digit := 0; end if;
  return expected_digit = substring(digits, 11, 1)::integer;
end;
$$;

create table public.courses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 160),
  is_active boolean not null default true,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id)
);

create unique index courses_name_lower_unique
on public.courses (organization_id, lower(trim(name)));

create table public.course_classes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  course_id uuid not null,
  name text not null check (char_length(trim(name)) between 1 and 120),
  is_active boolean not null default true,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (course_id, organization_id)
    references public.courses(id, organization_id)
    on delete restrict,
  unique (id, organization_id, course_id)
);

create unique index course_classes_name_lower_unique
on public.course_classes (organization_id, course_id, lower(trim(name)));

create table public.students (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  full_name text not null check (char_length(trim(full_name)) between 2 and 160),
  cpf_digits varchar(11) not null,
  email text not null check (char_length(trim(email)) between 5 and 254),
  mobile_digits varchar(11) not null,
  birth_date date not null check (birth_date <= current_date),
  sex text not null check (sex in ('female', 'male', 'other', 'prefer_not_to_say')),
  is_active boolean not null default true,
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint students_cpf_valid check (public.is_valid_cpf(cpf_digits)),
  constraint students_mobile_valid check (mobile_digits ~ '^[1-9][0-9]9[0-9]{8}$'),
  unique (id, organization_id),
  unique (organization_id, cpf_digits)
);

create index students_name_lower_idx
on public.students (organization_id, lower(full_name));

create table public.student_enrollments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  student_id uuid not null,
  course_id uuid not null,
  class_id uuid not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (student_id, organization_id)
    references public.students(id, organization_id)
    on delete cascade,
  foreign key (class_id, organization_id, course_id)
    references public.course_classes(id, organization_id, course_id)
    on delete restrict,
  constraint student_enrollments_dates check (ended_at is null or ended_at >= started_at),
  unique (id, student_id, organization_id)
);

create unique index student_enrollments_one_active_unique
on public.student_enrollments (organization_id, student_id)
where ended_at is null;

alter table public.requests
  add column student_id uuid,
  add column student_enrollment_id uuid,
  add constraint requests_student_pair_check check (
    (student_id is null and student_enrollment_id is null)
    or (student_id is not null and student_enrollment_id is not null)
  ),
  add constraint requests_student_fk
    foreign key (student_id, organization_id)
    references public.students(id, organization_id)
    on delete restrict,
  add constraint requests_student_enrollment_fk
    foreign key (student_enrollment_id, student_id, organization_id)
    references public.student_enrollments(id, student_id, organization_id)
    on delete restrict;

create index requests_student_idx
on public.requests (organization_id, student_id, created_at desc);

create trigger courses_set_updated_at before update on public.courses
for each row execute function public.set_updated_at();
create trigger course_classes_set_updated_at before update on public.course_classes
for each row execute function public.set_updated_at();
create trigger students_set_updated_at before update on public.students
for each row execute function public.set_updated_at();
create trigger student_enrollments_set_updated_at before update on public.student_enrollments
for each row execute function public.set_updated_at();

alter table public.courses enable row level security;
alter table public.course_classes enable row level security;
alter table public.students enable row level security;
alter table public.student_enrollments enable row level security;

revoke all on table public.courses from public, anon, authenticated;
revoke all on table public.course_classes from public, anon, authenticated;
revoke all on table public.students from public, anon, authenticated;
revoke all on table public.student_enrollments from public, anon, authenticated;

grant select on table public.courses to authenticated;
grant select on table public.course_classes to authenticated;
grant select on table public.students to authenticated;
grant select on table public.student_enrollments to authenticated;

create policy courses_select_member
on public.courses for select
to authenticated
using (public.is_org_member(organization_id));

create policy course_classes_select_member
on public.course_classes for select
to authenticated
using (public.is_org_member(organization_id));

create policy students_select_staff
on public.students for select
to authenticated
using (
  public.has_org_role(
    organization_id,
    array['admin', 'coordinator', 'attendant']::public.app_role[]
  )
);

create policy student_enrollments_select_staff
on public.student_enrollments for select
to authenticated
using (
  public.has_org_role(
    organization_id,
    array['admin', 'coordinator', 'attendant']::public.app_role[]
  )
);

create or replace function public.search_students(
  target_organization_id uuid,
  search_term text default '',
  result_limit integer default 20
)
returns table (
  student_id uuid,
  full_name text,
  cpf_digits varchar(11),
  enrollment_id uuid,
  course_id uuid,
  class_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_cpf text := regexp_replace(coalesce(search_term, ''), '[^0-9]', '', 'g');
  normalized_name text := translate(
    lower(trim(coalesce(search_term, ''))),
    'áàâãäéèêëíìîïóòôõöúùûüç',
    'aaaaaeeeeiiiiooooouuuuc'
  );
begin
  if not public.has_org_role(
    target_organization_id,
    array['admin', 'coordinator', 'attendant']::public.app_role[]
  ) then
    raise exception 'Not authorized';
  end if;

  return query
  select s.id, s.full_name, s.cpf_digits, e.id, e.course_id, e.class_id
  from public.students s
  join public.student_enrollments e
    on e.organization_id = s.organization_id
   and e.student_id = s.id
   and e.ended_at is null
  join public.courses c
    on c.id = e.course_id
   and c.organization_id = e.organization_id
   and c.is_active
  join public.course_classes cc
    on cc.id = e.class_id
   and cc.course_id = e.course_id
   and cc.organization_id = e.organization_id
   and cc.is_active
  where s.organization_id = target_organization_id
    and s.is_active
    and (
      trim(coalesce(search_term, '')) = ''
      or position(
        normalized_name in translate(
          lower(s.full_name),
          'áàâãäéèêëíìîïóòôõöúùûüç',
          'aaaaaeeeeiiiiooooouuuuc'
        )
      ) > 0
      or (normalized_cpf <> '' and s.cpf_digits like normalized_cpf || '%')
    )
  order by s.full_name
  limit least(greatest(coalesce(result_limit, 20), 1), 20);
end;
$$;

create or replace function public.create_student_with_enrollment(
  target_organization_id uuid,
  student_full_name text,
  student_cpf text,
  student_email text,
  student_mobile text,
  student_birth_date date,
  student_sex text,
  target_course_id uuid,
  target_class_id uuid
)
returns table (
  student_id uuid,
  full_name text,
  cpf_digits varchar(11),
  enrollment_id uuid,
  course_id uuid,
  class_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_name text := regexp_replace(trim(coalesce(student_full_name, '')), '[[:space:]]+', ' ', 'g');
  normalized_cpf text := regexp_replace(coalesce(student_cpf, ''), '[^0-9]', '', 'g');
  normalized_email text := lower(trim(coalesce(student_email, '')));
  normalized_mobile text := regexp_replace(coalesce(student_mobile, ''), '[^0-9]', '', 'g');
  created_student public.students%rowtype;
  created_enrollment public.student_enrollments%rowtype;
begin
  if not public.has_org_role(
    target_organization_id,
    array['admin', 'coordinator', 'attendant']::public.app_role[]
  ) then
    raise exception 'Not authorized';
  end if;
  if char_length(normalized_mobile) = 13 and left(normalized_mobile, 2) = '55' then
    normalized_mobile := substring(normalized_mobile from 3);
  end if;
  if char_length(normalized_name) not between 2 and 160 then raise exception 'Invalid student name'; end if;
  if not public.is_valid_cpf(normalized_cpf) then raise exception 'Invalid CPF'; end if;
  if normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Invalid email'; end if;
  if normalized_mobile !~ '^[1-9][0-9]9[0-9]{8}$' then raise exception 'Invalid mobile phone'; end if;
  if student_birth_date is null or student_birth_date > current_date then raise exception 'Invalid birth date'; end if;
  if student_sex not in ('female', 'male', 'other', 'prefer_not_to_say') then raise exception 'Invalid sex'; end if;
  if not exists (
    select 1
    from public.course_classes cc
    join public.courses c
      on c.id = cc.course_id and c.organization_id = cc.organization_id
    where cc.id = target_class_id
      and cc.course_id = target_course_id
      and cc.organization_id = target_organization_id
      and cc.is_active and c.is_active
  ) then raise exception 'Invalid or inactive course/class'; end if;

  insert into public.students (
    organization_id, full_name, cpf_digits, email, mobile_digits,
    birth_date, sex, created_by, updated_by
  ) values (
    target_organization_id, normalized_name, normalized_cpf, normalized_email,
    normalized_mobile, student_birth_date, student_sex, auth.uid(), auth.uid()
  ) returning * into created_student;

  insert into public.student_enrollments (
    organization_id, student_id, course_id, class_id, created_by
  ) values (
    target_organization_id, created_student.id, target_course_id,
    target_class_id, auth.uid()
  ) returning * into created_enrollment;

  return query select created_student.id, created_student.full_name,
    created_student.cpf_digits, created_enrollment.id,
    created_enrollment.course_id, created_enrollment.class_id;
end;
$$;

create or replace function public.update_student_with_enrollment(
  target_organization_id uuid,
  target_student_id uuid,
  student_full_name text,
  student_cpf text,
  student_email text,
  student_mobile text,
  student_birth_date date,
  student_sex text,
  target_course_id uuid,
  target_class_id uuid
)
returns table (
  student_id uuid,
  full_name text,
  cpf_digits varchar(11),
  enrollment_id uuid,
  course_id uuid,
  class_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_name text := regexp_replace(trim(coalesce(student_full_name, '')), '[[:space:]]+', ' ', 'g');
  normalized_cpf text := regexp_replace(coalesce(student_cpf, ''), '[^0-9]', '', 'g');
  normalized_email text := lower(trim(coalesce(student_email, '')));
  normalized_mobile text := regexp_replace(coalesce(student_mobile, ''), '[^0-9]', '', 'g');
  updated_student public.students%rowtype;
  current_enrollment public.student_enrollments%rowtype;
begin
  if not public.has_org_role(
    target_organization_id,
    array['admin', 'coordinator', 'attendant']::public.app_role[]
  ) then
    raise exception 'Not authorized';
  end if;
  if char_length(normalized_mobile) = 13 and left(normalized_mobile, 2) = '55' then
    normalized_mobile := substring(normalized_mobile from 3);
  end if;
  if char_length(normalized_name) not between 2 and 160 then raise exception 'Invalid student name'; end if;
  if not public.is_valid_cpf(normalized_cpf) then raise exception 'Invalid CPF'; end if;
  if normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Invalid email'; end if;
  if normalized_mobile !~ '^[1-9][0-9]9[0-9]{8}$' then raise exception 'Invalid mobile phone'; end if;
  if student_birth_date is null or student_birth_date > current_date then raise exception 'Invalid birth date'; end if;
  if student_sex not in ('female', 'male', 'other', 'prefer_not_to_say') then raise exception 'Invalid sex'; end if;
  if not exists (
    select 1
    from public.course_classes cc
    join public.courses c
      on c.id = cc.course_id and c.organization_id = cc.organization_id
    where cc.id = target_class_id
      and cc.course_id = target_course_id
      and cc.organization_id = target_organization_id
      and cc.is_active and c.is_active
  ) then raise exception 'Invalid or inactive course/class'; end if;

  select * into updated_student
  from public.students
  where id = target_student_id and organization_id = target_organization_id
  for update;
  if not found then raise exception 'Student not found'; end if;

  update public.students
  set full_name = normalized_name,
      cpf_digits = normalized_cpf,
      email = normalized_email,
      mobile_digits = normalized_mobile,
      birth_date = student_birth_date,
      sex = student_sex,
      updated_by = auth.uid()
  where id = target_student_id and organization_id = target_organization_id
  returning * into updated_student;

  select * into current_enrollment
  from public.student_enrollments
  where organization_id = target_organization_id
    and student_id = target_student_id
    and ended_at is null
  for update;
  if not found then raise exception 'Active enrollment not found'; end if;

  if current_enrollment.course_id <> target_course_id
    or current_enrollment.class_id <> target_class_id
  then
    update public.student_enrollments
    set ended_at = clock_timestamp()
    where id = current_enrollment.id;
    insert into public.student_enrollments (
      organization_id, student_id, course_id, class_id, created_by
    ) values (
      target_organization_id, target_student_id, target_course_id,
      target_class_id, auth.uid()
    ) returning * into current_enrollment;
  end if;

  return query select updated_student.id, updated_student.full_name,
    updated_student.cpf_digits, current_enrollment.id,
    current_enrollment.course_id, current_enrollment.class_id;
end;
$$;

create or replace function public.delete_student(
  target_organization_id uuid,
  target_student_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_org_role(
    target_organization_id,
    array['admin']::public.app_role[]
  ) then raise exception 'Administrator permission required'; end if;

  delete from public.students
  where id = target_student_id and organization_id = target_organization_id;
  if not found then raise exception 'Student not found'; end if;
exception
  when foreign_key_violation then
    raise exception 'Student has request history and cannot be deleted';
end;
$$;

create or replace function public.save_course(
  target_organization_id uuid,
  target_course_id uuid,
  course_name text,
  course_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_id uuid;
  normalized_name text := regexp_replace(trim(coalesce(course_name, '')), '[[:space:]]+', ' ', 'g');
begin
  if not public.has_org_role(target_organization_id, array['admin']::public.app_role[]) then
    raise exception 'Administrator permission required';
  end if;
  if char_length(normalized_name) not between 2 and 160 then raise exception 'Invalid course name'; end if;
  if target_course_id is null then
    insert into public.courses (organization_id, name, is_active, created_by)
    values (target_organization_id, normalized_name, coalesce(course_active, true), auth.uid())
    returning id into saved_id;
  else
    update public.courses
    set name = normalized_name, is_active = coalesce(course_active, true)
    where id = target_course_id and organization_id = target_organization_id
    returning id into saved_id;
    if saved_id is null then raise exception 'Course not found'; end if;
  end if;
  return saved_id;
end;
$$;

create or replace function public.save_course_class(
  target_organization_id uuid,
  target_class_id uuid,
  target_course_id uuid,
  class_name text,
  class_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_id uuid;
  normalized_name text := regexp_replace(trim(coalesce(class_name, '')), '[[:space:]]+', ' ', 'g');
begin
  if not public.has_org_role(target_organization_id, array['admin']::public.app_role[]) then
    raise exception 'Administrator permission required';
  end if;
  if char_length(normalized_name) not between 1 and 120 then raise exception 'Invalid class name'; end if;
  if not exists (
    select 1 from public.courses
    where id = target_course_id and organization_id = target_organization_id
  ) then raise exception 'Course not found'; end if;

  if target_class_id is null then
    insert into public.course_classes (organization_id, course_id, name, is_active, created_by)
    values (target_organization_id, target_course_id, normalized_name, coalesce(class_active, true), auth.uid())
    returning id into saved_id;
  else
    update public.course_classes
    set course_id = target_course_id, name = normalized_name,
        is_active = coalesce(class_active, true)
    where id = target_class_id and organization_id = target_organization_id
    returning id into saved_id;
    if saved_id is null then raise exception 'Class not found'; end if;
  end if;
  return saved_id;
end;
$$;

create or replace function public.create_request_for_student(
  target_organization_id uuid,
  target_request_type_id uuid,
  target_student_id uuid,
  target_enrollment_id uuid,
  request_description text
)
returns public.requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_request public.requests%rowtype;
begin
  if not public.has_org_role(
    target_organization_id,
    array['admin', 'coordinator', 'attendant']::public.app_role[]
  ) then raise exception 'Not authorized'; end if;
  if char_length(trim(coalesce(request_description, ''))) < 2 then raise exception 'Description is required'; end if;
  if not exists (
    select 1
    from public.students s
    join public.student_enrollments e
      on e.student_id = s.id and e.organization_id = s.organization_id
    join public.courses c
      on c.id = e.course_id and c.organization_id = e.organization_id
    join public.course_classes cc
      on cc.id = e.class_id and cc.course_id = e.course_id
     and cc.organization_id = e.organization_id
    where s.id = target_student_id
      and s.organization_id = target_organization_id
      and e.id = target_enrollment_id
      and e.ended_at is null
      and s.is_active and c.is_active and cc.is_active
  ) then raise exception 'Invalid or inactive student enrollment'; end if;

  insert into public.requests (
    organization_id, request_type_id, requester_id, student_id,
    student_enrollment_id, description
  ) values (
    target_organization_id, target_request_type_id, auth.uid(),
    target_student_id, target_enrollment_id, trim(request_description)
  ) returning * into created_request;
  return created_request;
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
  selected_workflow_version integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  new.requester_id := auth.uid();

  if new.organization_id is null then
    select m.organization_id into new.organization_id
    from public.memberships m
    where m.user_id = auth.uid()
    order by m.created_at
    limit 1;
  end if;
  if new.organization_id is null or not exists (
    select 1 from public.memberships m
    where m.organization_id = new.organization_id and m.user_id = new.requester_id
  ) then raise exception 'Requester is not a member of this organization'; end if;

  if (new.student_id is null) <> (new.student_enrollment_id is null) then
    raise exception 'Student and enrollment must be provided together';
  end if;
  if new.student_id is not null then
    if not public.has_org_role(
      new.organization_id,
      array['admin', 'coordinator', 'attendant']::public.app_role[]
    ) then raise exception 'Only staff can create requests for students'; end if;
    if not exists (
      select 1
      from public.students s
      join public.student_enrollments e
        on e.student_id = s.id and e.organization_id = s.organization_id
      where s.id = new.student_id
        and s.organization_id = new.organization_id
        and e.id = new.student_enrollment_id
        and e.ended_at is null and s.is_active
    ) then raise exception 'Invalid or inactive student enrollment'; end if;
  elsif public.has_org_role(
    new.organization_id,
    array['admin', 'coordinator', 'attendant']::public.app_role[]
  ) then
    raise exception 'Student is required for staff-created requests';
  end if;

  select rt.default_deadline_business_days, rt.current_workflow_version
  into deadline_days, selected_workflow_version
  from public.request_types rt
  where rt.id = new.request_type_id
    and rt.organization_id = new.organization_id and rt.is_active;
  if not found then raise exception 'Invalid or inactive request type'; end if;

  select ws.* into first_step
  from public.workflow_steps ws
  where ws.request_type_id = new.request_type_id
    and ws.organization_id = new.organization_id
    and ws.workflow_version = selected_workflow_version
  order by ws.position
  limit 1;
  if first_step.id is null then raise exception 'Request type has no configured workflow'; end if;

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

create or replace function public.audit_student_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  record_data jsonb := coalesce(to_jsonb(new), to_jsonb(old));
begin
  insert into public.audit_logs (
    organization_id, actor_id, entity_table, entity_id,
    action, before_data, after_data
  ) values (
    (record_data ->> 'organization_id')::uuid,
    auth.uid(),
    tg_table_name,
    record_data ->> 'id',
    tg_op,
    case when tg_op in ('UPDATE', 'DELETE') then jsonb_build_object(
      'is_active', old.is_active
    ) end,
    case when tg_op in ('INSERT', 'UPDATE') then jsonb_build_object(
      'is_active', new.is_active
    ) end
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger students_audit
after insert or update or delete on public.students
for each row execute function public.audit_student_change();
create trigger courses_audit
after insert or update or delete on public.courses
for each row execute function public.audit_row_change();
create trigger course_classes_audit
after insert or update or delete on public.course_classes
for each row execute function public.audit_row_change();
create trigger student_enrollments_audit
after insert or update or delete on public.student_enrollments
for each row execute function public.audit_row_change();

revoke all on function public.is_valid_cpf(text) from public, anon, authenticated;
revoke all on function public.search_students(uuid, text, integer) from public, anon;
revoke all on function public.create_student_with_enrollment(uuid, text, text, text, text, date, text, uuid, uuid) from public, anon;
revoke all on function public.update_student_with_enrollment(uuid, uuid, text, text, text, text, date, text, uuid, uuid) from public, anon;
revoke all on function public.delete_student(uuid, uuid) from public, anon;
revoke all on function public.save_course(uuid, uuid, text, boolean) from public, anon;
revoke all on function public.save_course_class(uuid, uuid, uuid, text, boolean) from public, anon;
revoke all on function public.create_request_for_student(uuid, uuid, uuid, uuid, text) from public, anon;
revoke all on function public.audit_student_change() from public, anon, authenticated;

grant execute on function public.search_students(uuid, text, integer) to authenticated;
grant execute on function public.create_student_with_enrollment(uuid, text, text, text, text, date, text, uuid, uuid) to authenticated;
grant execute on function public.update_student_with_enrollment(uuid, uuid, text, text, text, text, date, text, uuid, uuid) to authenticated;
grant execute on function public.delete_student(uuid, uuid) to authenticated;
grant execute on function public.save_course(uuid, uuid, text, boolean) to authenticated;
grant execute on function public.save_course_class(uuid, uuid, uuid, text, boolean) to authenticated;
grant execute on function public.create_request_for_student(uuid, uuid, uuid, uuid, text) to authenticated;
