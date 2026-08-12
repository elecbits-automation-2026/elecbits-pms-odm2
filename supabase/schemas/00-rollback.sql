-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK — put every table back in `public`, exactly as it was.
--
-- Only needed if something goes wrong between running 00-one-structure.sql and
-- getting the new app deployed. Run this and the OLD app works again
-- immediately; you can retry the cutover whenever you like.
--
-- This is the precise inverse of the move. Because SET SCHEMA and RENAME are
-- metadata-only, there is nothing to reconcile: no row was copied on the way
-- out, so no row can be lost on the way back. Policies, grants, indexes,
-- constraints, triggers and owned sequences come back with their tables.
--
-- THIS IS FOR THE CUTOVER WINDOW ONLY — steps 3 to 5.
--   Once 01-core.sql and the tool schemas have run, `core` holds tables of its
--   own and six other schemas hold foreign keys into it. There is no clean way
--   back from there, and this file will refuse rather than half-do it: undoing
--   that state means restoring a Supabase backup (Database → Backups), not
--   running a script.
--
--   That is not a gap. Rollback matters in the two minutes when the tables
--   have moved and the app has not caught up; by the time the other tools
--   exist, the cutover has long since succeeded.
--
-- Idempotent: a table already back in `public` is skipped.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Refuse if anything has been built on top ───────────────────────────────
-- Two ways the window has closed: a tool schema now holds tables, or 01-core
-- has given `core` tables of its own. Either way this is no longer a rollback,
-- it is a restore.
do $$
declare built text[];
begin
  select array_agg(nspname order by nspname) into built
  from pg_namespace
  where nspname in ('sales','ulm','bb','prod','hr','fin')
    and exists (select 1 from pg_class c where c.relnamespace = pg_namespace.oid and c.relkind = 'r');

  if built is not null then
    raise exception
      'Too late to roll back: % already hold tables built on core. '
      'Restore a backup instead (Database → Backups).', array_to_string(built, ', ');
  end if;

  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'core' and c.relname = 'tools' and c.relkind = 'r') then
    raise exception
      'Too late to roll back: 01-core.sql has run and core owns tables of its own. '
      'Restore a backup instead (Database → Backups).';
  end if;
end $$;


-- ── The inverse move ───────────────────────────────────────────────────────
do $$
declare
  m record;
  moved int := 0;
begin
  for m in
    select * from (values
      ('core', 'people',             'profiles'),
      ('core', 'orgs',               'clients'),
      ('core', 'projects',           'projects'),
      ('core', 'assignments',        'team_assignments'),
      ('core', 'trainings',          'trainings'),
      ('core', 'memory',             'memory'),
      ('core', 'sync_log',           'drive_sync_log'),
      ('pms',  'workspace',          'app_kv'),
      ('pms',  'tasks',              'tasks'),
      ('pms',  'stages',             'project_stages'),
      ('pms',  'scrum_notes',        'scrum_notes'),
      ('pms',  'meetings',           'moms'),
      ('pms',  'meeting_ideas',      'mom_ideas'),
      ('pms',  'meeting_decisions',  'mom_decisions'),
      ('pms',  'meeting_challenges', 'mom_challenges'),
      ('pms',  'messages',           'messages'),
      ('pms',  'intel',              'project_intel'),
      ('pms',  'work_updates',       'work_updates'),
      ('pms',  'kpi_log',            'kpi_log')
    ) as t(cur_schema, cur_name, old_name)
  loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = m.cur_schema and c.relname = m.cur_name and c.relkind = 'r'
    ) then
      continue;
    end if;

    -- Rename back FIRST, then move: renaming inside the source schema cannot
    -- collide with anything still sitting in public under the old name.
    if m.cur_name <> m.old_name then
      execute format('alter table %I.%I rename to %I', m.cur_schema, m.cur_name, m.old_name);
    end if;
    execute format('alter table %I.%I set schema public', m.cur_schema, m.old_name);
    moved := moved + 1;
  end loop;

  raise notice 'Moved % table(s) back to public.', moved;
end $$;


-- ── The columns that were renamed with them ────────────────────────────────
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='scrum_notes' and column_name='author_id') then
    alter table public.scrum_notes rename column author_id to "by";
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='scrum_notes' and column_name='author_app_id') then
    alter table public.scrum_notes rename column author_app_id to by_app_id;
  end if;
end $$;


-- ── The three functions that name tables in their body ─────────────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare cnt int;
begin
  select count(*) into cnt from public.profiles;
  insert into public.profiles (id, email, name, role, color)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
          case when cnt = 0 then 'superadmin' else 'engineer' end,
          '#2563eb')
  on conflict (id) do nothing;
  return new;
end $$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where (id = auth.uid() or auth_id = auth.uid())
      and role in ('superadmin', 'dept_head')
  );
$$;

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
        from public.memory m
        where m.embedding is not null
          and 1 - (m.embedding <=> query_embedding) >= min_similarity
        order by m.embedding <=> query_embedding
        limit match_count;
      $inner$;
    $fn$;
  end if;
end $$;


-- ── The empty schemas can go ───────────────────────────────────────────────
-- Not CASCADE: if anything unexpected is still in there, this fails loudly
-- rather than dropping it.
drop schema if exists pms  restrict;
drop schema if exists core restrict;


-- ── Where everything is now ────────────────────────────────────────────────
select n.nspname as schema, c.relname as table_name
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public','core','pms') and c.relkind = 'r'
order by n.nspname, c.relname;
