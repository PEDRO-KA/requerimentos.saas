-- Cover tenant and composite foreign-key lookups without changing queue access.
drop index if exists public.request_creation_email_jobs_student_idx;

create index request_creation_email_jobs_organization_idx
on public.request_creation_email_jobs (organization_id);

create index request_creation_email_jobs_request_organization_idx
on public.request_creation_email_jobs (request_id, organization_id);

create index request_creation_email_jobs_student_organization_idx
on public.request_creation_email_jobs (student_id, organization_id);
