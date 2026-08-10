-- ═══════════════════════════════════════════════════════════════════════════
-- HARDENING — remove the constraints that can freeze a table's mirror forever.
--
-- PostgREST rejects an entire upsert batch if one row violates a constraint.
-- Because the mirror re-sends the same state on every save, one bad row does
-- not fail once — it fails permanently, and the table silently stops updating
-- while the app carries on as if nothing is wrong. Two such traps exist today.
--
-- Run after the other four migrations. Idempotent. Nothing is dropped.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Person references must not be able to fail a batch ──────────────────
-- Every `uuid references profiles(id)` column is a landmine. `removeUser`
-- (App.jsx) deletes the profile row but leaves that person's uuid on every
-- task they were assigned, every scrum note they wrote and every training
-- they were given. The mirror then sends a real, correctly-shaped uuid that no
-- longer exists in `profiles` — a foreign-key violation that kills the whole
-- `tasks` batch, and every subsequent one, until the history is edited.
--
-- The constraint is dropped, not the column. The `*_app_id` text twin already
-- carries the authoritative link, and a uuid pointing at someone who has left
-- is exactly the history we want to keep. Referential integrity here buys
-- nothing and costs the entire mirror.
do $$
declare r record;
begin
  for r in
    select con.conname, cl.relname
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_class ref on ref.oid = con.confrelid
    where con.contype = 'f'
      and cl.relnamespace = 'public'::regnamespace
      and ref.relname = 'profiles'
      and cl.relname <> 'profiles'
  loop
    execute format('alter table public.%I drop constraint %I', r.relname, r.conname);
    raise notice 'dropped % on %', r.conname, r.relname;
  end loop;
end $$;

-- ── 2. A missing date must not fail a batch either ─────────────────────────
-- `date not null` on three tables, fed by a converter that yields null for
-- anything not exactly YYYY-MM-DD. One note without a valid date and the whole
-- table stops mirroring. A row with an unknown date is worth more than no
-- rows at all.
alter table public.scrum_notes  alter column date drop not null;
alter table public.kpi_log      alter column date drop not null;
alter table public.work_updates alter column date drop not null;

-- ── 3. The work_updates uniqueness rethink ─────────────────────────────────
-- (user, date) uniqueness cannot hold while a person's identity changes
-- mid-session — the app starts as 'u-admin' and is replaced by a profile uuid
-- once auth resolves, so the same person on the same day can legitimately
-- arrive under two ids. The upsert targets app_id; a conflict on any OTHER
-- unique index raises instead of merging and takes the batch with it.
drop index if exists public.work_updates_user_date_key;

-- ── 4. Scores are nullable, and mean it ────────────────────────────────────
-- When Claude is unreachable the app stores score: null and shows "unscored".
-- Anything that turns that into a 0 is inventing a performance record. These
-- columns are already nullable; this is a comment for whoever adds a default.
comment on column public.work_updates.score is
  'null means UNSCORED (AI unreachable), not zero. Never default this.';
comment on column public.mom_ideas.value is
  'null means the model did not score this idea. Not zero.';

-- ── 5. What is left that could still fail a batch ──────────────────────────
select cl.relname as table_name, con.conname as constraint_name,
       pg_get_constraintdef(con.oid) as definition
from pg_constraint con
join pg_class cl on cl.oid = con.conrelid
where cl.relnamespace = 'public'::regnamespace
  and con.contype in ('f', 'c')
  and cl.relname in ('projects','tasks','scrum_notes','clients','moms','mom_ideas',
                     'mom_decisions','mom_challenges','messages','project_intel',
                     'kpi_log','work_updates','trainings','memory','drive_sync_log',
                     'team_assignments','project_stages')
order by 1, 2;
