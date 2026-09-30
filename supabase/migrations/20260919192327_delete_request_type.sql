create or replace function public.delete_request_type(
  target_organization_id uuid,
  target_request_type_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_type_name text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.has_org_role(
    target_organization_id,
    array['admin']::public.app_role[]
  ) then
    raise exception 'Administrator permission required';
  end if;

  select rt.name
    into request_type_name
  from public.request_types as rt
  where rt.id = target_request_type_id
    and rt.organization_id = target_organization_id
  for update;

  if request_type_name is null then
    raise exception 'Request type not found';
  end if;

  if exists (
    select 1
    from public.requests as r
    where r.organization_id = target_organization_id
      and r.request_type_id = target_request_type_id
  ) then
    raise exception using
      errcode = '23503',
      message = 'Request type has request history and cannot be deleted';
  end if;

  delete from public.request_types as rt
  where rt.id = target_request_type_id
    and rt.organization_id = target_organization_id;
exception
  when foreign_key_violation then
    raise exception using
      errcode = '23503',
      message = 'Request type has linked records and cannot be deleted';
end;
$$;

revoke all on function public.delete_request_type(uuid, uuid) from public, anon;
grant execute on function public.delete_request_type(uuid, uuid) to authenticated;
