-- ═══════════════════════════════════════════════════════════════════════════
-- Host the Sales & Partnership tool in THIS database, alongside the PMS.
--
-- Run once, in this project's SQL editor. It does three things:
--   1. creates the `collections` table the Sales OS stores everything in;
--   2. closes a door the PMS schema left ajar — `anon` had SELECT on every
--      table in public. No rows ever came back, because every table has RLS
--      with authenticated-only policies, so nothing was exposed. But the
--      sales tool hands its anon key to every visitor, and the day somebody
--      adds a table and forgets to switch RLS on, that grant turns into a
--      full read of whatever is in it. It is removed and re-granted only
--      where it is actually needed;
--   3. prints what `anon` can reach afterwards, so you can see it is only
--      `collections`.
--
-- Nothing in the PMS is touched. Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The Sales OS store ──────────────────────────────────────────────────
-- One row per collection: 'sales:users', 'sales:companies', 'sales:deals',
-- 'sales:kpis', 'sales:trainings', 'sales:worklogs', 'sales:knowledge',
-- 'sales:expenses', 'sales:gates'. Its keys are namespaced, so it cannot
-- collide with the PMS's own key/value table (`app_kv`).
create table if not exists public.collections (
  key        text primary key,
  data       jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.collections enable row level security;

-- The sales app signs people in itself, against rows inside `sales:users`, so
-- the browser talks to PostgREST as `anon`. That is the tool's own design
-- decision and this migration honours it — but only for this one table.
drop policy if exists "authenticated read"   on public.collections;
drop policy if exists "authenticated insert" on public.collections;
drop policy if exists "authenticated update" on public.collections;
drop policy if exists "authenticated delete" on public.collections;
drop policy if exists "public read"   on public.collections;
drop policy if exists "public insert" on public.collections;
drop policy if exists "public update" on public.collections;
drop policy if exists "public delete" on public.collections;

create policy "public read"   on public.collections for select to anon, authenticated using (true);
create policy "public insert" on public.collections for insert to anon, authenticated with check (true);
create policy "public update" on public.collections for update to anon, authenticated using (true) with check (true);
create policy "public delete" on public.collections for delete to anon, authenticated using (true);

-- ── 2. Give anon exactly one table, not all of them ────────────────────────
revoke select, insert, update, delete on all tables in schema public from anon;
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.collections to anon, authenticated, service_role;
-- the PMS keeps working as it always has: signed-in users, every table
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;

-- ── 3. Show what anon can actually reach ───────────────────────────────────
-- Privileges are checked by OID, not by name: a WHERE clause is not evaluated
-- in the order it is written, so a name-based check can be run against a table
-- in another schema before the schema filter has excluded it.
select
  c.relname                                                 as table,
  case when c.relrowsecurity then 'on' else 'OFF — FIX' end as row_security,
  case when has_table_privilege('anon', c.oid, 'SELECT')
       then 'anon can read' else '—' end                     as anon
from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
order by has_table_privilege('anon', c.oid, 'SELECT') desc, c.relname;

-- Expect exactly one row saying "anon can read", and it must be `collections`.
-- Every other table should show row_security = on and anon = "—".
