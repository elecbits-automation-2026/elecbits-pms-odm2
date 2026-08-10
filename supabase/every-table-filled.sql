-- ═══════════════════════════════════════════════════════════════════════════
-- ORGANISE THE DATA — every part of the app into its own table.
--
-- Today the whole workspace is two JSON strings in `app_kv`, and twelve tables
-- sit empty beside it. Those tables were well designed and match the app's own
-- shapes closely — they were simply never written to. This migration closes the
-- last gaps so each one can hold its data:
--
--   1. adds an `app_id` to every table — the app's own short id — so a save is
--      an upsert rather than a duplicate;
--   2. adds a `*_app_id` beside each `uuid references profiles(id)` column. The
--      seeded roster uses short ids like 'u-admin', which are NOT profile
--      uuids; writing one into the uuid column violates the foreign key and
--      fails the whole batch. The uuid column is still used when the id really
--      is a profile; otherwise the short id lands in the text column and
--      nothing is lost;
--   3. adds `tasks.stage_id`, so stage-grouped to-dos are a real column rather
--      than something re-derived from keywords on every render;
--   4. creates the four tables that never existed — brainstorming sessions
--      (MoMs), per-project chat, per-project intelligence, and the assistant
--      transcript — all of which are currently nested inside other objects.
--
-- Run once. Idempotent. Nothing here drops or rewrites data: `app_kv` stays
-- the source of truth and the app keeps working exactly as it does now.
-- Run supabase/projects-into-a-real-table.sql first (or alongside — order
-- does not matter).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Daily scrum ─────────────────────────────────────────────────────────
-- "Where is the daily scrum stored?" → today, the `notes` array inside
-- pms-v1-a. After this, one row per note, queryable by date.
alter table public.scrum_notes
  add column if not exists app_id     text,
  add column if not exists by_app_id  text,
  add column if not exists project_id text;          -- notes can name a project
create unique index if not exists scrum_notes_app_id_key on public.scrum_notes (app_id);
create index if not exists scrum_notes_project_idx on public.scrum_notes (project_id);

-- ── 2. Tasks ───────────────────────────────────────────────────────────────
alter table public.tasks
  add column if not exists app_id             text,
  add column if not exists stage_id           text,   -- the 11 audit stages
  add column if not exists assignee_app_id    text,
  add column if not exists created_by_app_id  text,
  add column if not exists note_app_id        text,
  add column if not exists parent_task_app_id text;
create unique index if not exists tasks_app_id_key on public.tasks (app_id);
create index if not exists tasks_stage_idx on public.tasks (stage_id);

-- `note_id` and `parent_task_id` are uuid columns pointing at rows whose ids
-- the app mints as short strings, so the app-side link travels in the *_app_id
-- columns. They are deliberately left un-constrained rather than dropped: once
-- the app moves onto real uuids the uuid columns become the live ones.

-- ── 3. Clients ─────────────────────────────────────────────────────────────
alter table public.clients
  add column if not exists app_id text;
create unique index if not exists clients_app_id_key on public.clients (app_id);

-- ── 4. Performance & training ──────────────────────────────────────────────
alter table public.kpi_log
  add column if not exists app_id    text,
  add column if not exists pm_app_id text;
create unique index if not exists kpi_log_app_id_key on public.kpi_log (app_id);

alter table public.work_updates
  add column if not exists app_id       text,
  add column if not exists user_app_id  text;
create unique index if not exists work_updates_app_id_key on public.work_updates (app_id);
-- The original unique (user_id, date) cannot hold while user_id is null for
-- roster-only people; app_id is the upsert key instead.
alter table public.work_updates drop constraint if exists work_updates_user_id_date_key;
create unique index if not exists work_updates_user_date_key
  on public.work_updates (coalesce(user_app_id, user_id::text), date);

alter table public.trainings
  add column if not exists app_id             text,
  add column if not exists user_app_id        text,
  add column if not exists assigned_by_app_id text;
create unique index if not exists trainings_app_id_key on public.trainings (app_id);

-- ── 5. System memory ───────────────────────────────────────────────────────
-- The table already carries a vector(1536) column and an ivfflat index from
-- schema.sql. Nothing embeds into it yet, so it stays null — that is a feature
-- waiting to be switched on, not a missing table.
alter table public.memory
  add column if not exists app_id     text,
  add column if not exists created_by text;
create unique index if not exists memory_app_id_key on public.memory (app_id);

-- ── 6. Drive sync log ──────────────────────────────────────────────────────
alter table public.drive_sync_log
  add column if not exists app_id text;
create unique index if not exists drive_sync_log_app_id_key on public.drive_sync_log (app_id);

-- ── 7. Team assignments ────────────────────────────────────────────────────
alter table public.team_assignments
  add column if not exists app_id          text,
  add column if not exists user_app_id     text,
  add column if not exists project_app_id  text;
create unique index if not exists team_assignments_app_id_key
  on public.team_assignments (app_id);

-- ═══ THE FOUR TABLES THAT NEVER EXISTED ════════════════════════════════════
-- Each of these is currently an array nested inside a project or a blob, which
-- is why none of it can be searched, joined, or shown across projects.

-- ── 8. Brainstorming sessions (MoMs) ───────────────────────────────────────
-- Today: project.moms — invisible unless you open that one project.
create table if not exists public.moms (
  id          uuid primary key default gen_random_uuid(),
  app_id      text unique,
  project_id  text,                       -- the Eb- code
  title       text,
  at          timestamptz,
  body        text,
  attendees   jsonb not null default '[]'::jsonb,
  decisions   jsonb not null default '[]'::jsonb,
  created_by  text,
  created_at  timestamptz not null default now()
);
create index if not exists moms_project_idx on public.moms (project_id);
create index if not exists moms_at_idx on public.moms (at desc);

-- ── 9. Per-project chat ────────────────────────────────────────────────────
create table if not exists public.project_chat (
  id         uuid primary key default gen_random_uuid(),
  app_id     text unique,
  project_id text not null,
  at         timestamptz not null default now(),
  who        text,                        -- 'user' | 'ai' | 'sys'
  author     text,
  text       text,
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists project_chat_project_idx on public.project_chat (project_id, at);

-- ── 10. Per-project intelligence ───────────────────────────────────────────
create table if not exists public.project_intel (
  id         uuid primary key default gen_random_uuid(),
  app_id     text unique,
  project_id text not null,
  at         timestamptz not null default now(),
  kind       text,
  title      text,
  body       text,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists project_intel_project_idx on public.project_intel (project_id, at desc);

-- ── 11. Assistant transcript ───────────────────────────────────────────────
-- Today: the last 200 messages, inside pms-v1-b. One row each instead, so the
-- history is not silently truncated and can be searched.
create table if not exists public.assistant_log (
  id         uuid primary key default gen_random_uuid(),
  app_id     text unique,
  date       date,
  at         timestamptz not null default now(),
  who        text,                        -- 'user' | 'ai' | 'sys'
  author     text,
  text       text,
  ok         boolean,
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists assistant_log_date_idx on public.assistant_log (date, at);

-- ── 12. Same policy as every other table in this schema ────────────────────
alter table public.moms          enable row level security;
alter table public.project_chat  enable row level security;
alter table public.project_intel enable row level security;
alter table public.assistant_log enable row level security;

do $$
declare t text;
begin
  foreach t in array array['moms','project_chat','project_intel','assistant_log'] loop
    execute format('drop policy if exists "authenticated all" on public.%I', t);
    execute format(
      'create policy "authenticated all" on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

grant select, insert, update, delete
  on public.moms, public.project_chat, public.project_intel, public.assistant_log
  to authenticated, service_role;

-- ── 13. What you should see ────────────────────────────────────────────────
-- Open the app, change anything, wait a second, then run this. Every row count
-- that is currently zero should start filling.
select c.relname as table_name,
       (xpath('/row/c/text()', query_to_xml(
          format('select count(*) as c from public.%I', c.relname), false, true, '')))[1]::text::int as rows
from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
order by 2 desc, 1;
