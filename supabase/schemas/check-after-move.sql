-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT IS THE APP ACTUALLY SEEING? — run this if the app hangs on
-- "Loading the ODM system…" after the move.
--
-- That screen means the browser asked for pms.workspace and did not get an
-- answer it could use. There are only four things that can cause it, and this
-- tells you which one in about a second. Read only — changes nothing.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Are the tables where they should be, and do they still hold rows? ───
select 'A. tables' as check, n.nspname as schema, c.relname as table,
       c.reltuples::bigint as approx_rows,
       c.relrowsecurity as rls_on,
       (select count(*) from pg_policies p
        where p.schemaname = n.nspname and p.tablename = c.relname) as policies
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('core','pms') and c.relkind = 'r'
  and c.relname in ('workspace','people','projects')
order by n.nspname, c.relname;

-- The workspace blob is the one the boot read needs. Two rows expected.
select 'B. workspace rows' as check, key, length(value) as bytes, updated_at
from pms.workspace order by key;

-- ── 2. May the signed-in role reach them at all? ──────────────────────────
-- `authenticated` needs USAGE on the schema and SELECT on the table. Grants
-- travel with a table; USAGE on a new schema does not, and is the single most
-- common thing missed.
select 'C. schema usage' as check, nspname as schema,
       has_schema_privilege('authenticated', nspname, 'USAGE') as authenticated_may_enter
from pg_namespace where nspname in ('core','pms');

select 'D. table grants' as check,
       table_schema || '.' || table_name as table,
       has_table_privilege('authenticated', table_schema || '.' || table_name, 'SELECT') as can_select,
       has_table_privilege('authenticated', table_schema || '.' || table_name, 'INSERT') as can_insert
from information_schema.tables
where table_schema in ('core','pms') and table_type = 'BASE TABLE'
  and table_name in ('workspace','people','projects')
order by 2;

-- ── 3. Does row-level security let a real person read the blob? ───────────
-- Grants say "you may reach the table". Policies say "you may see this row".
-- A table with RLS on and no matching policy returns ZERO rows and no error —
-- which looks exactly like an empty database to the app.
select 'E. policies on the tables the app reads' as check,
       schemaname || '.' || tablename as table, policyname, cmd, roles::text
from pg_policies
where schemaname in ('core','pms') and tablename in ('workspace','people')
order by 1, 2;

-- The real test: read it AS the signed-in role, with RLS enforced.
do $$
declare n int;
begin
  set local role authenticated;
  select count(*) into n from pms.workspace;
  reset role;
  raise notice 'F. as `authenticated`, pms.workspace returns % row(s) — 2 is healthy, 0 means RLS is blocking it.', n;
exception when others then
  reset role;
  raise notice 'F. as `authenticated`, reading pms.workspace FAILED: %', sqlerrm;
end $$;

-- ── 4. Has the API noticed the move? ──────────────────────────────────────
-- PostgREST caches the schema. It reloads itself after DDL, but if it has not,
-- every request 404s no matter how correct the grants are. This is free and
-- safe to run whether or not it is the problem.
notify pgrst, 'reload schema';
select 'G. asked PostgREST to reload its schema cache' as check;
