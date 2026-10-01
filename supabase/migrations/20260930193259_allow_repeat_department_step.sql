-- Advancement is limited to once per actor per workflow step, not per request.
-- A department may legitimately appear more than once in the same workflow.
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
          and not exists (
            select 1
            from public.request_events as e
            where e.request_id = r.id
              and e.organization_id = r.organization_id
              and e.actor_id = auth.uid()
              and e.from_step_id = r.current_step_id
              and (e.event_type = 'forwarded' or e.to_status = 'completed')
          )
        )
      )
  );
$$;
