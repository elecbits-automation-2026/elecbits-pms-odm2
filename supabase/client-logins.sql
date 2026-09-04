-- ─── CLIENT LOGINS — the customer's own people, on the shared org list ──────
-- A client is somebody from the customer's side with a login of their own.
-- They sit on the same roster as staff (one people table, one auth), marked
-- role = 'client', and they are tied to the company they belong to —
-- core.orgs, the list Sales, the PMS tools and Finance already share.
--
-- Run once, in the Supabase SQL editor. Safe to re-run.

-- 1. Which company this person belongs to. Null for staff, set for clients.
alter table core.people
  add column if not exists org_id uuid references core.orgs(id) on delete set null;

create index if not exists people_org_idx on core.people (org_id) where org_id is not null;

comment on column core.people.org_id is
  'For role = client: the customer organisation this person belongs to. Staff
   rows leave it null. Joins the login to core.orgs so a client sees only the
   projects their own company is named on.';

-- 2. The app writes 'client' as a role; whatever check constraint the column
--    carries must accept it. Rebuilt only if one exists.
do $$
declare c_name text;
begin
  select con.conname into c_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace ns on ns.oid = rel.relnamespace
  where ns.nspname = 'core' and rel.relname = 'people'
    and con.contype = 'c' and pg_get_constraintdef(con) ilike '%role%';
  if c_name is not null then
    execute format('alter table core.people drop constraint %I', c_name);
  end if;
end $$;

alter table core.people
  add constraint people_role_check
  check (role in ('superadmin', 'dept_head', 'pm', 'engineer', 'developer', 'client'));

-- 3. A client reads the projects their company is on, and nothing else. The
--    app enforces this in the UI; this is the same rule at the database, so a
--    stolen token cannot walk past it.
do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'core' and tablename = 'projects') then
    execute $p$
      drop policy if exists projects_client_read on core.projects;
      create policy projects_client_read on core.projects for select
      using (
        exists (
          select 1 from core.people me
          where me.auth_id = auth.uid()
            and me.role = 'client'
            and me.org_id is not null
            and me.org_id = core.projects.org_id
        )
        or exists (select 1 from core.people me where me.auth_id = auth.uid() and me.role <> 'client')
      );
    $p$;
  end if;
exception when others then
  raise notice 'projects policy skipped: %', sqlerrm;
end $$;
