-- Importação pontual das turmas informadas pelo IPE.
-- TE 259 já existe com matrículas e deve permanecer inalterada.
-- Em bancos locais sem os cursos cadastrados, esta migração não importa dados.
do $import_ipe_classes$
declare
  target_organization_id uuid;
  available_courses integer;
  matched_classes integer;
  conflicting_class text;
  class_names text[] := array[
    '242 TE Manhã',
    '243 TE Noite',
    '244 TE Manhã',
    '245 TE Sábado',
    '246 TE Noite',
    '247 TE Sábado',
    '248 TE Tarde',
    '249 TE Noite',
    '250 TE Sábado',
    '251 TE Noite',
    '252 TE Manhã',
    '253 TE Sábado',
    '254 TE Noite',
    '255 TE Manhã',
    '256 TE Tarde',
    '257 TE Noite',
    '258 TE Sábado',
    '260 TE Tarde',
    '261 TE Sábado',
    '262 TE Noite',
    '263 TE Noite',
    '264 TE Sábado',
    '265 TE Noite',
    '266 TE Manhã',
    '267 TE Tarde',
    '268 TE Noite',
    '269 TE Sábado',
    '270 TE Noite',
    '271 TE Manhã',
    '272 TE Sábado',
    '273 TE Tarde',
    '46 RX Tarde',
    '63 RX Tarde',
    '64 RX Manhã',
    '66 RX Sábado',
    '67 RX Noite',
    '69 RX Manhã',
    '70 RX Sábado',
    '49 TST Noite',
    '50 TST Manhã',
    '51 TST Noite',
    '52 TST Sábado',
    '53 TST Noite',
    '54 TST Manhã',
    '55 TST Sábado',
    '56 TST Noite',
    '57 TST Manhã',
    '58 TST Sábado',
    '59 TST Noite',
    '60 TST Noite',
    '24 TF Tarde',
    '27 TF Manhã',
    '28 TF Noite',
    '29 TF Sábado',
    '30 TF Noite',
    '63 TET Tarde',
    '64 TET Noite',
    '65 TET Sábado',
    '66 TET Noite',
    '67 TET Manhã',
    '68 TET Noite',
    '69 TET Noite',
    '70 TET Sábado',
    '71 TET Manhã',
    '72 TET Noite',
    '73 TET Tarde',
    '74 TET Manhã'
  ];
begin
  if cardinality(class_names) <> 67 then
    raise exception 'Expected 67 IPE classes, found %', cardinality(class_names);
  end if;

  if exists (
    select 1
    from unnest(class_names) as item(name)
    where item.name !~ '^[0-9]{1,3} (TE|RX|TST|TF|TET) (Manhã|Tarde|Noite|Sábado)$'
       or item.name = '259 TE Manhã'
  ) then
    raise exception 'Invalid class label or protected TE 259 in import';
  end if;

  if exists (
    select 1
    from unnest(class_names) as item(name)
    group by lower(item.name)
    having count(*) > 1
  ) then
    raise exception 'Repeated class label in import';
  end if;

  select o.id into target_organization_id
  from public.organizations as o
  where o.slug = 'ipe' and o.name = 'Instituto IPE';
  if target_organization_id is null then
    raise exception 'IPE organization not found';
  end if;

  select count(*) into available_courses
  from public.courses as c
  where c.organization_id = target_organization_id
    and c.is_active
    and c.name in (
      'Enfermagem', 'Radiologia', 'Segurança do Trabalho',
      'Farmácia', 'Enfermagem do Trabalho'
    );
  if available_courses = 0 then
    return;
  end if;
  if available_courses <> 5 then
    raise exception 'Expected 5 active IPE courses, found %', available_courses;
  end if;

  select count(*) into matched_classes
  from unnest(class_names) as item(name)
  join public.courses as c
    on c.organization_id = target_organization_id
   and c.is_active
   and c.name = case split_part(item.name, ' ', 2)
     when 'TE' then 'Enfermagem'
     when 'RX' then 'Radiologia'
     when 'TST' then 'Segurança do Trabalho'
     when 'TF' then 'Farmácia'
     when 'TET' then 'Enfermagem do Trabalho'
   end;
  if matched_classes <> 67 then
    raise exception 'Could not map all 67 classes to IPE courses';
  end if;

  -- Impede duplicação semântica se um número já existir com outra grafia ou turno.
  select cc.name into conflicting_class
  from unnest(class_names) as item(name)
  join public.courses as c
    on c.organization_id = target_organization_id
   and c.name = case split_part(item.name, ' ', 2)
     when 'TE' then 'Enfermagem'
     when 'RX' then 'Radiologia'
     when 'TST' then 'Segurança do Trabalho'
     when 'TF' then 'Farmácia'
     when 'TET' then 'Enfermagem do Trabalho'
   end
  join public.course_classes as cc
    on cc.organization_id = target_organization_id
   and cc.course_id = c.id
  where (
    upper(trim(cc.name)) = upper(split_part(item.name, ' ', 1) || ' ' || split_part(item.name, ' ', 2))
    or upper(trim(cc.name)) like upper(split_part(item.name, ' ', 1) || ' ' || split_part(item.name, ' ', 2) || ' %')
    or upper(trim(cc.name)) = upper(split_part(item.name, ' ', 2) || ' ' || split_part(item.name, ' ', 1))
    or upper(trim(cc.name)) like upper(split_part(item.name, ' ', 2) || ' ' || split_part(item.name, ' ', 1) || ' %')
  )
    and lower(trim(cc.name)) <> lower(item.name)
  limit 1;
  if conflicting_class is not null then
    raise exception 'Existing class with conflicting label: %', conflicting_class;
  end if;

  insert into public.course_classes (
    organization_id, course_id, name, is_active, created_by
  )
  select target_organization_id, c.id, item.name, true, c.created_by
  from unnest(class_names) as item(name)
  join public.courses as c
    on c.organization_id = target_organization_id
   and c.name = case split_part(item.name, ' ', 2)
     when 'TE' then 'Enfermagem'
     when 'RX' then 'Radiologia'
     when 'TST' then 'Segurança do Trabalho'
     when 'TF' then 'Farmácia'
     when 'TET' then 'Enfermagem do Trabalho'
   end
  on conflict do nothing;

  select count(*) into matched_classes
  from unnest(class_names) as item(name)
  join public.courses as c
    on c.organization_id = target_organization_id
   and c.name = case split_part(item.name, ' ', 2)
     when 'TE' then 'Enfermagem'
     when 'RX' then 'Radiologia'
     when 'TST' then 'Segurança do Trabalho'
     when 'TF' then 'Farmácia'
     when 'TET' then 'Enfermagem do Trabalho'
   end
  join public.course_classes as cc
    on cc.organization_id = target_organization_id
   and cc.course_id = c.id
   and lower(trim(cc.name)) = lower(item.name)
   and cc.is_active;
  if matched_classes <> 67 then
    raise exception 'IPE class import incomplete: % of 67 active classes found', matched_classes;
  end if;
end;
$import_ipe_classes$;
