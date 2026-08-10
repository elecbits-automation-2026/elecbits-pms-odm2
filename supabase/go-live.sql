-- ═══════════════════════════════════════════════════════════════════════════
-- GO-LIVE CLEANUP — the last migration before the tool is live for the team.
--
-- Run after the other five. Idempotent. Nothing here holds anyone's only copy.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Dead columns out ────────────────────────────────────────────────────
-- `tasks.note_id` and `tasks.parent_task_id` are uuid columns that can never
-- be written: the app's own ids are 8-char strings, which travel in
-- `note_app_id` / `parent_task_app_id`. Leaving a permanently-null column is
-- how someone six months from now writes a join against nothing.
alter table public.tasks drop column if exists note_id;
alter table public.tasks drop column if exists parent_task_id;

-- `projects.sanctioned` is now maintained by the mirror (derived from status,
-- exactly as the app derives it), so it stays — and works in a WHERE clause.
comment on column public.projects.sanctioned is
  'Derived: status <> ''Planning''. Maintained by the mirror on every save.';

-- ── 2. Superseded tables stay gone ─────────────────────────────────────────
-- every-table-filled.sql advertises "safe to re-run", but re-running it after
-- nested-data-into-tables.sql would recreate `project_chat` and
-- `assistant_log` as permanently-empty tables beside `messages`, which
-- replaced them. Make gone mean gone.
drop table if exists public.project_chat;
drop table if exists public.assistant_log;

-- ── 3. The one thing to check before telling the team ──────────────────────
-- Open the app, change anything, wait two seconds, then run this. Every table
-- the app writes should show rows; the three named exceptions should not.
select c.relname as table_name,
       (xpath('/row/c/text()', query_to_xml(
          format('select count(*) as c from public.%I', c.relname), false, true, '')))[1]::text::int as rows,
       case c.relname
         when 'app_kv'   then 'the blob itself'
         when 'profiles' then 'written by auth, not the mirror'
         else '' end as note
from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
order by 2 desc, 1;
