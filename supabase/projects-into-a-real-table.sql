-- ═══════════════════════════════════════════════════════════════════════════
-- Give `public.projects` the handful of columns the app actually carries, so
-- every project becomes a real, queryable row instead of living only inside a
-- JSON string in `app_kv`.
--
-- Run once, in this project's SQL editor.
--
-- This is the safest DDL there is: `public.projects` has ZERO rows and ZERO
-- readers — the app has never written to it. Nothing can break. The blob in
-- `app_kv` stays exactly as it is and remains the source of truth; the app
-- starts writing rows here *as well*, so if a row write ever fails the app
-- carries on untouched.
--
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The columns the app has and the table doesn't ───────────────────────
alter table public.projects
  add column if not exists app_id         text,            -- the app's own short id
  add column if not exists origin         text,            -- 'existing' | 'new' | 'assistant'
  add column if not exists start_date     date,
  add column if not exists linked_ids     text[] not null default '{}',
  add column if not exists team           jsonb  not null default '[]'::jsonb,
  add column if not exists known_status   text,
  add column if not exists drive_learning text;

-- `created_by` references public.profiles(id). The app's user ids are not all
-- profile uuids (the seeded roster uses short ids), so the sync writes null
-- rather than a broken reference. Nothing here needs changing for that — it is
-- noted so the null is not read as a bug.

-- ── 2. Index the things you will actually filter on ────────────────────────
create index if not exists projects_status_idx   on public.projects (status);
create index if not exists projects_deadline_idx on public.projects (deadline);
create index if not exists projects_app_id_idx   on public.projects (app_id);

-- ── 3. Keep updated_at honest ──────────────────────────────────────────────
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists projects_touch on public.projects;
create trigger projects_touch before update on public.projects
  for each row execute function public.touch_updated_at();

-- ── 4. Show what you have ──────────────────────────────────────────────────
-- After the app has saved once (open it, change anything, wait a second),
-- this should list your projects as real rows.
select project_id, name, status, deadline, start_date,
       array_length(linked_ids, 1) as linked, jsonb_array_length(team) as team_size
from public.projects
order by created_at desc;
