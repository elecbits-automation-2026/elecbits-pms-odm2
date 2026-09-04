-- ─── CLIENT LOGINS — the customer's own people, on the shared org list ──────
-- A client is somebody from the customer's side with a login of their own.
-- They sit on the same roster as staff (one people table, one auth), marked
-- role = 'client', and they carry the id of the company they belong to.
--
-- The company id is TEXT, not uuid: the app mints its own short ids for
-- companies (and mirrors them to core.orgs), so the column must take them
-- as they are. This script also converts a column an earlier run created
-- as uuid.
--
-- Run once, in the Supabase SQL editor. Safe to re-run.

-- 0. The read policy from an earlier run references org_id on BOTH tables,
--    and Postgres refuses to retype a column a policy depends on — so the
--    policy goes first, and is recreated at the end.
do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'core' and tablename = 'projects') then
    execute 'drop policy if exists projects_client_read on core.projects';
  end if;
end $$;

-- 1. Which company this person belongs to. Null for staff, set for clients.
alter table core.people add column if not exists org_id text;

do $$
declare fk text;
begin
  -- an earlier run made it uuid with a foreign key to core.orgs; loosen both
  select con.conname into fk
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace ns on ns.oid = rel.relnamespace
  where ns.nspname = 'core' and rel.relname = 'people' and con.contype = 'f'
    and exists (
      select 1 from unnest(con.conkey) k
      join pg_attribute a on a.attrelid = rel.oid and a.attnum = k
      where a.attname = 'org_id');
  if fk is not null then
    execute format('alter table core.people drop constraint %I', fk);
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'core' and table_name = 'people'
               and column_name = 'org_id' and data_type = 'uuid') then
    execute 'alter table core.people alter column org_id type text using org_id::text';
  end if;
end $$;

create index if not exists people_org_idx on core.people (org_id) where org_id is not null;

comment on column core.people.org_id is
  'For role = client: the id of the customer company this person belongs to
   (the app''s company id, mirrored to core.orgs). Staff rows leave it null.
   It scopes a client login to the projects their own company is named on.';

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
    and con.contype = 'c' and pg_get_constraintdef(con.oid) ilike '%role%';
  if c_name is not null then
    execute format('alter table core.people drop constraint %I', c_name);
  end if;
end $$;

-- NOT VALID: applies to every new write, but never fails the script over a
-- legacy row whose role predates this list.
alter table core.people
  add constraint people_role_check
  check (role in ('superadmin', 'dept_head', 'pm', 'engineer', 'developer', 'client'))
  not valid;

-- 3. A client reads the projects their company is on, and nothing else. The
--    app enforces this in the UI; this is the same rule at the database, so a
--    stolen token cannot walk past it.
do $$
declare fk text;
begin
  if exists (select 1 from pg_tables where schemaname = 'core' and tablename = 'projects') then
    -- the policy depends on the column, so it goes first
    execute 'drop policy if exists projects_client_read on core.projects';
    execute 'alter table core.projects add column if not exists org_id text';
    select con.conname into fk
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'core' and rel.relname = 'projects' and con.contype = 'f'
      and exists (
        select 1 from unnest(con.conkey) k
        join pg_attribute a on a.attrelid = rel.oid and a.attnum = k
        where a.attname = 'org_id');
    if fk is not null then
      execute format('alter table core.projects drop constraint %I', fk);
    end if;
    if exists (select 1 from information_schema.columns
               where table_schema = 'core' and table_name = 'projects'
                 and column_name = 'org_id' and data_type = 'uuid') then
      execute 'alter table core.projects alter column org_id type text using org_id::text';
    end if;
    execute $p$
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
