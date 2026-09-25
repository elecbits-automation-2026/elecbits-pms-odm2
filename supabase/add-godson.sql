-- ═══════════════════════════════════════════════════════════════════════════
-- ADD GODSON V — Soldering Engineer, ODM.  godson.v@elecbits.in
--
-- If a profile already matches him (by email, or a name starting "Godson"),
-- it is UPDATED to this role/title and keeps its id, colour and any attached
-- login. Only if nothing matches is a new row INSERTED. Superadmins are never
-- touched. Idempotent: a second run changes nothing.
--
-- He signs in the same way as everyone else: either set him a password from
-- Add Resource → Edit, or he signs up himself with EXACTLY this email.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.profiles add column if not exists auth_id uuid;  -- no-op if migrated

do $$
declare
  hit int;
begin
  update public.profiles p set
    role          = 'engineer',
    resource_role = 'soldering',
    dept          = 'ODM',
    title         = 'Soldering Engineer',
    email         = coalesce(nullif(p.email, ''), 'godson.v@elecbits.in'),
    skills        = case when coalesce(p.skills, '[]'::jsonb) = '[]'::jsonb
                         then '["Soldering","Rework","PCB Assembly","Bring-up Testing"]'::jsonb
                         else p.skills end,
    project_tags  = coalesce(p.project_tags, '["engineering"]'::jsonb),
    max_projects  = coalesce(p.max_projects, 3)
  where p.role is distinct from 'superadmin'
    and (lower(coalesce(p.email, '')) = 'godson.v@elecbits.in'
         or lower(p.name) like 'godson%');
  get diagnostics hit = row_count;

  if hit = 0 then
    insert into public.profiles (id, name, email, role, title, resource_role, dept,
                                 skills, project_tags, max_projects, color)
    values (gen_random_uuid(), 'Godson V', 'godson.v@elecbits.in', 'engineer',
            'Soldering Engineer', 'soldering', 'ODM',
            '["Soldering","Rework","PCB Assembly","Bring-up Testing"]'::jsonb,
            '["engineering"]'::jsonb, 3, '#0d9488');
  end if;
end $$;

-- The report: his row as it stands now, and whether he can already sign in.
select name, email, role, resource_role as "role/function", dept, title,
       case when auth_id is not null then 'can sign in' else 'no login yet' end as login
from public.profiles
where lower(coalesce(email, '')) = 'godson.v@elecbits.in' or lower(name) like 'godson%';
