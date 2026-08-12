-- ═══════════════════════════════════════════════════════════════════════════
-- ONE STRUCTURE — move the 19 tables out of `public` into core and pms.
--
-- Everything the ODM tool built lives in `public` with names that made sense
-- when there was one tool. There are about to be eight. `public.tasks` is
-- ambiguous the moment Box Build exists; `app_kv` says nothing at all; and
-- `projects`, `profiles` and `clients` are not the ODM tool's — they are the
-- company's, and five other tools are going to need them.
--
-- So: each table goes where it belongs, and gets the name it should have had.
--
--   core   people, orgs, projects, assignments, trainings, memory, sync_log
--   pms    the ODM tool's own — tasks, stages, meetings, messages, …
--
-- HOW THIS IS SAFE
--   ALTER TABLE … SET SCHEMA and RENAME are metadata-only. No row is copied,
--   no index is rebuilt, nothing runs for more than a millisecond, and there
--   is no half-migrated state to recover from. Row-level policies, grants,
--   indexes, constraints, triggers and owned sequences all travel with the
--   table. Views elsewhere follow it automatically — Postgres tracks the
--   object, not the name.
--
-- WHAT BREAKS, AND FOR HOW LONG
--   The deployed app addresses these tables by name. Between running this and
--   redeploying Vercel, it cannot save. Its data is not at risk — nothing is
--   deleted and nothing is copied — but do not run this mid-edit. Run it, then
--   redeploy immediately. Two minutes, not two hours.
--
-- RUN THIS FIRST, before sanction-gate.sql and 01–08. Everything downstream is
-- written against the names this file establishes.
--
-- Idempotent: a table already moved is skipped, so a re-run does nothing.
-- ═══════════════════════════════════════════════════════════════════════════

create schema if not exists core;
create schema if not exists pms;


-- ═══ THE MOVE ══════════════════════════════════════════════════════════════

do $$
declare
  m record;
  moved int := 0;
begin
  for m in
    select * from (values
      -- ── core: what the whole company shares ──────────────────────────────
      ('profiles',         'core', 'people'),       -- the roster
      ('clients',          'core', 'orgs'),         -- customers and vendors
      ('projects',         'core', 'projects'),     -- THE spine
      ('team_assignments', 'core', 'assignments'),  -- who is on what
      ('trainings',        'core', 'trainings'),    -- a people thing, not an ODM thing
      ('memory',           'core', 'memory'),       -- pgvector; company-wide
      ('drive_sync_log',   'core', 'sync_log'),

      -- ── pms: the ODM tool's own working data ─────────────────────────────
      ('app_kv',           'pms',  'workspace'),    -- the live workspace blob
      ('tasks',            'pms',  'tasks'),
      ('project_stages',   'pms',  'stages'),
      ('scrum_notes',      'pms',  'scrum_notes'),
      ('moms',             'pms',  'meetings'),     -- "mom" is minutes-of-meeting
      ('mom_ideas',        'pms',  'meeting_ideas'),
      ('mom_decisions',    'pms',  'meeting_decisions'),
      ('mom_challenges',   'pms',  'meeting_challenges'),
      ('messages',         'pms',  'messages'),
      ('project_intel',    'pms',  'intel'),
      ('work_updates',     'pms',  'work_updates'),
      ('kpi_log',          'pms',  'kpi_log')
    ) as t(old_name, new_schema, new_name)
  loop
    -- Already moved? Nothing to do.
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = m.old_name and c.relkind = 'r'
    ) then
      continue;
    end if;

    -- Something already sitting in the destination would be a collision, not
    -- an idempotent re-run. Stop rather than guess.
    if exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = m.new_schema and c.relname = m.new_name
    ) then
      raise exception '%.% already exists — cannot move public.% onto it',
        m.new_schema, m.new_name, m.old_name;
    end if;

    execute format('alter table public.%I set schema %I', m.old_name, m.new_schema);
    if m.old_name <> m.new_name then
      execute format('alter table %I.%I rename to %I', m.new_schema, m.old_name, m.new_name);
    end if;
    moved := moved + 1;
  end loop;

  raise notice 'Moved % table(s).', moved;
end $$;


-- ═══ THE THINGS THAT NAMED THEM ════════════════════════════════════════════
-- Policies, indexes and constraints followed the tables automatically because
-- they reference the object. These three name it in their body, so they do
-- not — they have to be rewritten.

-- 1. The trigger that creates a roster entry when someone signs up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = core, public as $$
declare cnt int;
begin
  select count(*) into cnt from core.people;
  insert into core.people (id, email, name, role, color)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
          case when cnt = 0 then 'superadmin' else 'engineer' end,
          '#2563eb')
  on conflict (id) do nothing;
  return new;
end $$;

-- 2. "Is the caller an admin?" — used by every hr and fin policy.
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = core, public as $$
  select exists (
    select 1 from core.people
    where (id = auth.uid() or auth_id = auth.uid())
      and role in ('superadmin', 'dept_head')
  );
$$;

-- 3. Semantic search over memory.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'vector') then
    execute $fn$
      create or replace function public.match_memory(
        query_embedding vector(1536), match_count int default 5, min_similarity float default 0.0)
      returns table (id uuid, type text, title text, content text, similarity float)
      language sql stable as $inner$
        select m.id, m.type, m.title, m.content,
               1 - (m.embedding <=> query_embedding) as similarity
        from core.memory m
        where m.embedding is not null
          and 1 - (m.embedding <=> query_embedding) >= min_similarity
        order by m.embedding <=> query_embedding
        limit match_count;
      $inner$;
    $fn$;
  end if;
end $$;


-- ═══ NAMES THAT ONLY MADE SENSE INSIDE ONE APP ═════════════════════════════
-- Two columns read as nonsense outside the tool that wrote them. Renaming a
-- column is not free — the app has to change with it — so this is deliberately
-- the whole list, not the start of one.

do $$
begin
  -- scrum_notes."by" — a bare preposition, and a reserved-ish word that has to
  -- be quoted in every query that touches it.
  if exists (select 1 from information_schema.columns
             where table_schema='pms' and table_name='scrum_notes' and column_name='by') then
    alter table pms.scrum_notes rename column "by" to author_id;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema='pms' and table_name='scrum_notes' and column_name='by_app_id') then
    alter table pms.scrum_notes rename column by_app_id to author_app_id;
  end if;
end $$;


-- ═══ GRANTS ON THE NEW HOMES ═══════════════════════════════════════════════
-- Per-object grants travelled with the tables. What does NOT travel is the
-- right to enter the schema at all, and the default for tables created later.

grant usage on schema core, pms to authenticated;
grant select, insert, update, delete on all tables in schema core to authenticated;
grant select, insert, update, delete on all tables in schema pms  to authenticated;
grant usage, select on all sequences in schema core to authenticated;
grant usage, select on all sequences in schema pms  to authenticated;

alter default privileges in schema core
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema pms
  grant select, insert, update, delete on tables to authenticated;

-- Row-level security still decides who sees which row; these grants only say
-- the role may reach the table at all. Nothing is granted to `anon` — the app
-- ships the anon key in the browser and signs in before it reads anything.


-- ═══ WHAT MOVED ════════════════════════════════════════════════════════════
select n.nspname as schema, c.relname as table_name,
       (select count(*) from pg_policies p
        where p.schemaname = n.nspname and p.tablename = c.relname) as policies
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('core','pms','public') and c.relkind = 'r'
order by n.nspname, c.relname;
