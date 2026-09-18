-- Corrige avisos e ambiguidade PL/pgSQL identificados após o lint remoto.

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
    from public.course_classes as cc
    join public.courses as c
      on c.id = cc.course_id and c.organization_id = cc.organization_id
    where cc.id = target_class_id
      and cc.course_id = target_course_id
      and cc.organization_id = target_organization_id
      and cc.is_active and c.is_active
  ) then raise exception 'Invalid or inactive course/class'; end if;

  select s.* into updated_student
  from public.students as s
  where s.id = target_student_id
    and s.organization_id = target_organization_id
  for update;
  if not found then raise exception 'Student not found'; end if;

  update public.students as s
  set full_name = normalized_name,
      cpf_digits = normalized_cpf,
      email = normalized_email,
      mobile_digits = normalized_mobile,
      birth_date = student_birth_date,
      sex = student_sex,
      updated_by = auth.uid()
  where s.id = target_student_id
    and s.organization_id = target_organization_id
  returning s.* into updated_student;

  select e.* into current_enrollment
  from public.student_enrollments as e
  where e.organization_id = target_organization_id
    and e.student_id = target_student_id
    and e.ended_at is null
  for update;
  if not found then raise exception 'Active enrollment not found'; end if;

  if current_enrollment.course_id <> target_course_id
    or current_enrollment.class_id <> target_class_id
  then
    update public.student_enrollments as e
    set ended_at = clock_timestamp()
    where e.id = current_enrollment.id;
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

revoke all on function public.is_valid_cpf(text) from public, anon, authenticated;
revoke all on function public.update_student_with_enrollment(uuid, uuid, text, text, text, text, date, text, uuid, uuid) from public, anon;
grant execute on function public.update_student_with_enrollment(uuid, uuid, text, text, text, text, date, text, uuid, uuid) to authenticated;
