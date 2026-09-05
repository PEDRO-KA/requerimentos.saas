-- Requerimentos IPE: modelo relacional principal.
-- Senhas e tokens pertencem exclusivamente ao schema auth do Supabase.

create extension if not exists pgcrypto with schema extensions;

create type public.app_role as enum (
  'admin',
  'coordinator',
  'attendant',
  'student'
);

create type public.request_status as enum (
  'open',
  'in_review',
  'awaiting_requester',
  'forwarded',
  'completed',
  'rejected',
  'canceled'
);

create type public.request_event_type as enum (
  'created',
  'status_changed',
  'forwarded',
  'note',
  'attachment_added',
  'attachment_removed',
  'assigned'
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 120),
  purpose text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name),
  unique (id, organization_id)
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null check (char_length(trim(full_name)) between 2 and 160),
  cpf_digits varchar(11),
  email text not null,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_cpf_format check (cpf_digits is null or cpf_digits ~ '^[0-9]{11}$')
);

create unique index profiles_cpf_digits_unique
  on public.profiles (cpf_digits)
  where cpf_digits is not null;
create unique index profiles_email_lower_unique
  on public.profiles (lower(email));

create table public.memberships (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  department_id uuid,
  role public.app_role not null default 'student',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id),
  foreign key (department_id, organization_id)
    references public.departments(id, organization_id)
    on delete set null (department_id)
);

create table public.request_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 160),
  description text not null default '',
  default_deadline_business_days integer not null default 5
    check (default_deadline_business_days between 0 and 365),
  allow_attachments boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name),
  unique (id, organization_id)
);

create table public.workflow_steps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  request_type_id uuid not null,
  position integer not null check (position > 0),
  label text not null check (char_length(trim(label)) between 2 and 120),
  department_id uuid,
  is_terminal boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (request_type_id, organization_id)
    references public.request_types(id, organization_id)
    on delete cascade,
  foreign key (department_id, organization_id)
    references public.departments(id, organization_id)
    on delete restrict,
  unique (request_type_id, position),
  unique (id, organization_id)
);

create table public.protocol_counters (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  protocol_year integer not null check (protocol_year between 2020 and 9999),
  last_value bigint not null default 0 check (last_value >= 0),
  primary key (organization_id, protocol_year)
);

create table public.requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  protocol text not null,
  request_type_id uuid not null,
  requester_id uuid not null references auth.users(id) on delete restrict,
  description text not null default '',
  status public.request_status not null default 'open',
  current_step_id uuid,
  current_department_id uuid,
  assigned_to uuid references auth.users(id) on delete set null,
  opened_at timestamptz not null default now(),
  due_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (request_type_id, organization_id)
    references public.request_types(id, organization_id)
    on delete restrict,
  foreign key (current_step_id, organization_id)
    references public.workflow_steps(id, organization_id)
    on delete restrict,
  foreign key (current_department_id, organization_id)
    references public.departments(id, organization_id)
    on delete restrict,
  unique (organization_id, protocol),
  unique (id, organization_id)
);

create table public.request_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  request_id uuid not null,
  actor_id uuid references auth.users(id) on delete set null,
  event_type public.request_event_type not null,
  note text not null default '',
  from_status public.request_status,
  to_status public.request_status,
  from_step_id uuid,
  to_step_id uuid,
  from_department_id uuid,
  to_department_id uuid,
  from_assignee_id uuid references auth.users(id) on delete set null,
  to_assignee_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (request_id, organization_id)
    references public.requests(id, organization_id)
    on delete cascade,
  foreign key (from_step_id, organization_id)
    references public.workflow_steps(id, organization_id)
    on delete set null (from_step_id),
  foreign key (to_step_id, organization_id)
    references public.workflow_steps(id, organization_id)
    on delete set null (to_step_id),
  foreign key (from_department_id, organization_id)
    references public.departments(id, organization_id)
    on delete set null (from_department_id),
  foreign key (to_department_id, organization_id)
    references public.departments(id, organization_id)
    on delete set null (to_department_id)
);

create table public.request_attachments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  request_id uuid not null,
  uploaded_by uuid not null references auth.users(id) on delete restrict,
  storage_path text not null unique,
  file_name text not null check (char_length(file_name) between 1 and 255),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes between 1 and 10485760),
  created_at timestamptz not null default now(),
  foreign key (request_id, organization_id)
    references public.requests(id, organization_id)
    on delete cascade
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  department_id uuid,
  request_id uuid,
  title text not null check (char_length(trim(title)) between 2 and 160),
  body text not null default '',
  read_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (department_id, organization_id)
    references public.departments(id, organization_id)
    on delete cascade,
  foreign key (request_id, organization_id)
    references public.requests(id, organization_id)
    on delete cascade,
  constraint notifications_audience_check
    check (user_id is not null or department_id is not null)
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  entity_table text not null,
  entity_id text not null,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);

create index memberships_user_idx on public.memberships (user_id, organization_id);
create index memberships_department_idx on public.memberships (organization_id, department_id);
create index departments_org_active_idx on public.departments (organization_id, is_active);
create index request_types_org_active_idx on public.request_types (organization_id, is_active);
create index workflow_steps_type_position_idx on public.workflow_steps (request_type_id, position);
create index requests_requester_idx on public.requests (requester_id, created_at desc);
create index requests_department_idx on public.requests (organization_id, current_department_id, status);
create index requests_assigned_idx on public.requests (assigned_to, status);
create index requests_created_idx on public.requests (organization_id, created_at desc);
create index request_events_request_idx on public.request_events (request_id, created_at);
create index request_attachments_request_idx on public.request_attachments (request_id, created_at);
create index notifications_user_unread_idx on public.notifications (user_id, read_at, created_at desc);
create index notifications_department_unread_idx on public.notifications (department_id, read_at, created_at desc);
create index audit_logs_org_created_idx on public.audit_logs (organization_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger organizations_set_updated_at before update on public.organizations
for each row execute function public.set_updated_at();
create trigger departments_set_updated_at before update on public.departments
for each row execute function public.set_updated_at();
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger memberships_set_updated_at before update on public.memberships
for each row execute function public.set_updated_at();
create trigger request_types_set_updated_at before update on public.request_types
for each row execute function public.set_updated_at();
create trigger workflow_steps_set_updated_at before update on public.workflow_steps
for each row execute function public.set_updated_at();
create trigger requests_set_updated_at before update on public.requests
for each row execute function public.set_updated_at();

insert into public.organizations (id, name, slug)
values ('00000000-0000-0000-0000-000000000001', 'Instituto IPE', 'ipe')
on conflict (id) do update set name = excluded.name, slug = excluded.slug;

insert into public.departments (id, organization_id, name, purpose)
values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Secretaria Acadêmica', 'Recebimento e análise documental'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Coordenação de Curso', 'Validação e decisões acadêmicas'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'Financeiro', 'Taxas e pendências financeiras')
on conflict (id) do update
set name = excluded.name, purpose = excluded.purpose;

insert into public.request_types (
  id, organization_id, name, description, default_deadline_business_days
)
values
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Histórico escolar', 'Emissão do histórico acadêmico do aluno.', 5),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Aproveitamento de estudos', 'Análise de disciplinas cursadas para possível aproveitamento.', 10),
  ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'Declaração de matrícula', 'Emissão de declaração de vínculo acadêmico.', 2)
on conflict (id) do update
set name = excluded.name,
    description = excluded.description,
    default_deadline_business_days = excluded.default_deadline_business_days;

insert into public.workflow_steps (
  id, organization_id, request_type_id, position, label, department_id, is_terminal
)
values
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 1, 'Secretaria Acadêmica', '10000000-0000-0000-0000-000000000001', false),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 2, 'Coordenação de Curso', '10000000-0000-0000-0000-000000000002', false),
  ('30000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 3, 'Conclusão', null, true),
  ('30000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 1, 'Secretaria Acadêmica', '10000000-0000-0000-0000-000000000001', false),
  ('30000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 2, 'Coordenação de Curso', '10000000-0000-0000-0000-000000000002', false),
  ('30000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 3, 'Conclusão', null, true),
  ('30000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', 1, 'Secretaria Acadêmica', '10000000-0000-0000-0000-000000000001', false),
  ('30000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', 2, 'Conclusão', null, true)
on conflict (id) do update
set position = excluded.position,
    label = excluded.label,
    department_id = excluded.department_id,
    is_terminal = excluded.is_terminal;
