-- ═══════════════════════════════════════════════════════════════════════════
-- THE PROJECT PLAN AND ITS STAGES.
--
-- The largest remaining gap. Every task already carries a `stage_id`, but the
-- stages themselves live only inside `project.plan` in the JSON blob — so
-- `tasks.stage_id` is a dangling reference. You can GROUP BY it and get an
-- opaque string ('design'), but nothing tells you the stage's name, its order,
-- who owns it, whether it is done, or what evidence backs it.
--
-- The plan is also where the eleven audit stages live, which is the feature the
-- whole stage-grouped to-do list depends on.
--
-- Run after the other three migrations. Idempotent.
-- Safe: nothing here holds anyone's only copy — `app_kv` is still the source of
-- truth and the mirror rebuilds these rows on the next save.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The stages ──────────────────────────────────────────────────────────
-- App shape (PLAN_SHAPE, App.jsx:1131):
--   { id, name, status, track, start, end, owner, note, evidence[] }
-- `start` and `end` are renamed on the way in: `end` is a reserved word in SQL
-- and quoting it forever is a worse tax than a clear name.
create table if not exists public.project_stages (
  app_id     text primary key,               -- '<project_id>:<stage id>'
  project_id text not null,                  -- the Eb- code
  stage_id   text not null,                  -- what tasks.stage_id points at
  seq        int  not null,                  -- the order they are shown in
  name       text,
  status     text,                           -- done | active | blocked | pending
  track      text,                           -- workstream
  start_on   date,
  end_on     date,
  owner_name text,                           -- a person's NAME, not an id
  note       text,
  evidence   jsonb not null default '[]'::jsonb,   -- Drive file names
  unique (project_id, stage_id)
);
create index if not exists project_stages_project_idx on public.project_stages (project_id, seq);
create index if not exists project_stages_status_idx  on public.project_stages (status);

-- ── 2. The plan's own fields ───────────────────────────────────────────────
-- One plan per project, so these belong on the project rather than in a table.
alter table public.projects
  add column if not exists plan_summary    text,
  add column if not exists plan_updated_at timestamptz,
  add column if not exists plan_source     text,        -- uploaded checklist name
  add column if not exists plan_log        jsonb not null default '[]'::jsonb;

-- ── 3. Fields the app adds only after a task is created ────────────────────
-- These never appear in any task constructor — they are written by later
-- partial updates, which is exactly why they were missed the first time.
alter table public.tasks
  add column if not exists started_at    timestamptz,
  add column if not exists steps_done    jsonb not null default '[]'::jsonb,
  add column if not exists block_note    text,
  add column if not exists last_feedback text;

alter table public.memory
  add column if not exists updated_at timestamptz;

-- `workUpdates` and `trainings` carry `at`, not `createdAt`; the mirror was
-- reading a field the app never sets.
alter table public.work_updates add column if not exists at timestamptz;
alter table public.trainings    add column if not exists at timestamptz;

-- An assistant message with who='doc' carries the document it produced.
alter table public.messages add column if not exists doc jsonb;

-- ── 4. Policy, as everywhere else ──────────────────────────────────────────
alter table public.project_stages enable row level security;
drop policy if exists "authenticated all" on public.project_stages;
create policy "authenticated all" on public.project_stages
  for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.project_stages to authenticated, service_role;

-- ── 5. What this makes askable ─────────────────────────────────────────────
-- The stage-grouped to-do list, as a query rather than something re-derived
-- from keywords on every render:
--
--   select s.seq, s.name, s.status, count(t.*) filter (where t.status <> 'done') as open
--   from public.project_stages s
--   left join public.tasks t
--     on t.project_id = s.project_id and t.stage_id = s.stage_id
--   where s.project_id = 'Eb-09-ML-432-01-1752'
--   group by s.seq, s.name, s.status order by s.seq;
--
-- And the one that was impossible before — which stage is blocked, anywhere:
--
--   select project_id, name, note from public.project_stages
--   where status = 'blocked' order by project_id, seq;
