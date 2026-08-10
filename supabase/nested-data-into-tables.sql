-- ═══════════════════════════════════════════════════════════════════════════
-- THE NESTED DATA — brainstorming sessions, chat, intelligence, assistant log.
--
-- These four are the only parts of the workspace with no table at all. Three of
-- them are arrays nested *inside* a project object, which is why none of it can
-- be seen across projects: a decision taken in a session on 1752 is invisible
-- unless you open 1752 and scroll.
--
-- This file supersedes the four tables sketched in every-table-filled.sql. Those
-- were written against guessed shapes; these are written against what App.jsx
-- actually stores. Two changes follow from that:
--
--   • `project_chat` and `assistant_log` are ONE table. They are the same
--     record — who said it, what, when, to which project — differing only in
--     whether a project is named. Two tables would mean two queries, two
--     policies and two embedding sources for the same question.
--   • A MoM's `ai` object holds four lists that are worth asking questions of
--     across every session: who contributed ideas and how they scored, what
--     was decided and by whom, and which challenges are still open. Those get
--     real child tables. `actions` and `lessons` do not — they already become
--     rows in `tasks` and `memory`, so they are linked, not copied.
--
-- Run once, after the other two migrations. Idempotent.
--
-- The drops below are safe even if the mirror has already written rows into
-- those tables. `app_kv` is still the source of truth and the mirror is
-- one-way: the next save rebuilds every row from the app's own state. Nothing
-- here is anybody's only copy.
-- ═══════════════════════════════════════════════════════════════════════════

drop table if exists public.project_chat;
drop table if exists public.assistant_log;
drop table if exists public.project_intel;
drop table if exists public.moms cascade;

-- ═══ 1. BRAINSTORMING SESSIONS ═════════════════════════════════════════════
-- App shape: { id, date, time, by, byName, attendees, raw, ai, at, title,
--              savedTo }
-- `attendees` really is a free-text string the user types ("Jerom, Rahul"), not
-- a list of ids — it is stored as written rather than pretended into an array.
create table public.moms (
  id          uuid primary key default gen_random_uuid(),
  app_id      text unique not null,
  project_id  text not null,                    -- the Eb- code
  date        date,
  time        text,                             -- "10:39" as typed
  at          timestamptz not null default now(),
  by_app_id   text,                             -- who wrote it up
  by_id       uuid references public.profiles(id),
  by_name     text,
  attendees   text,                             -- free text, as typed
  title       text,
  raw         text not null default '',         -- the notes as written
  summary     text,                             -- ai.summary, lifted out
  saved_to    text,                             -- Drive folder it was filed in
  ai          jsonb,                            -- the whole analysis, verbatim
  created_at  timestamptz not null default now()
);
create index on public.moms (project_id, at desc);
create index on public.moms (date);

-- Who moved things forward. The AI already scores each idea for impact and
-- value; across a year of sessions this is the only honest record of who
-- contributes, and it is the one thing a Performance page cannot fake.
--
-- The three child tables key on `app_id` = '<mom app_id>:<seq>'. The app never
-- sees the generated uuid, so a synthetic key is what lets a save upsert them
-- and drop the ones that are gone using exactly the same path as every other
-- table — no special case, no second code path to get wrong.
create table public.mom_ideas (
  app_id     text primary key,
  mom_app_id text not null references public.moms(app_id) on delete cascade,
  seq        int  not null,
  by_name    text,
  idea       text,
  impact     text,                              -- as classified
  value      int,                               -- 1-5
  why        text,
  unique (mom_app_id, seq)
);
create index on public.mom_ideas (by_name);

create table public.mom_decisions (
  app_id     text primary key,
  mom_app_id text not null references public.moms(app_id) on delete cascade,
  seq        int  not null,
  what       text,
  owner      text,
  unique (mom_app_id, seq)
);

-- "What is still open across every session we have ever had" is a question
-- worth being able to ask on a Monday morning.
create table public.mom_challenges (
  app_id     text primary key,
  mom_app_id text not null references public.moms(app_id) on delete cascade,
  seq        int  not null,
  problem    text,
  status     text,                              -- solved | open | watching
  solution   text,
  unique (mom_app_id, seq)
);
create index on public.mom_challenges (status);

-- Close the loop the other way: a task raised by a session already carries
-- origin='mom', but not *which* session.
alter table public.tasks add column if not exists mom_app_id text;
create index if not exists tasks_mom_idx on public.tasks (mom_app_id);

-- ═══ 2. EVERY CONVERSATION, ONE TABLE ══════════════════════════════════════
-- Project chat:   { id, who: 'me'|'ai', text, by, at, files?, docs? }
-- Assistant log:  { id, who, text, date, time, by, byName, ok?, confirm?, ... }
-- The same record. `scope` says which surface it belongs to and `project_id`
-- is null for the global assistant.
create table public.messages (
  id          uuid primary key default gen_random_uuid(),
  app_id      text unique not null,
  scope       text not null check (scope in ('project', 'assistant')),
  project_id  text,                             -- null for the global assistant
  day         date,                             -- the assistant is day-bucketed
  at          timestamptz not null default now(),
  time        text,
  who         text not null,                    -- 'me' | 'user' | 'ai' | 'sys'
  by_app_id   text,
  by_id       uuid references public.profiles(id),
  by_name     text,
  text        text,
  ok          boolean,                          -- sys lines: did the action work
  files       jsonb not null default '[]'::jsonb,   -- what was attached
  docs        jsonb not null default '[]'::jsonb,   -- what the AI cited
  created_at  timestamptz not null default now(),
  -- A project message must name its project; an assistant message must not.
  constraint messages_scope_project check (
    (scope = 'project'   and project_id is not null) or
    (scope = 'assistant' and project_id is null))
);
create index on public.messages (scope, project_id, at);
create index on public.messages (day, at);
create index on public.messages (by_app_id);

-- A pending confirmation ("Delete 7 projects?") is transient UI state, not a
-- message, and is deliberately not stored — the app already strips it before
-- saving. Nothing is lost by leaving it out.

-- ═══ 3. PROJECT INTELLIGENCE ═══════════════════════════════════════════════
-- App shape: { id, at, by, text, raw } — a note the user wrote, plus the
-- AI-tidied version. Both are kept: `raw` is what a person actually said, and
-- that is the version worth embedding later.
create table public.project_intel (
  id         uuid primary key default gen_random_uuid(),
  app_id     text unique not null,
  project_id text not null,
  at         timestamptz not null default now(),
  by_app_id  text,
  by_id      uuid references public.profiles(id),
  raw        text,                              -- as written
  text       text,                              -- as organised by the AI
  created_at timestamptz not null default now()
);
create index on public.project_intel (project_id, at desc);

-- The last Drive analysis is one object per project, not a list, so it belongs
-- on the project rather than in a table of its own.
alter table public.projects
  add column if not exists drive_analysis      text,
  add column if not exists drive_analysis_at   timestamptz,
  add column if not exists drive_analysis_live boolean;

-- ═══ 4. Same policy as every other table here ══════════════════════════════
do $$
declare t text;
begin
  foreach t in array array['moms','mom_ideas','mom_decisions','mom_challenges',
                           'messages','project_intel'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "authenticated all" on public.%I', t);
    execute format(
      'create policy "authenticated all" on public.%I for all to authenticated using (true) with check (true)', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated, service_role', t);
  end loop;
end $$;
grant usage, select on all sequences in schema public to authenticated, service_role;

-- ═══ 5. The questions this makes askable ═══════════════════════════════════
-- Each of these is impossible against a JSON string, and impossible against
-- data nested inside a project.
--
--   who moves things forward, across every session:
--     select by_name, count(*), round(avg(value),1) as avg_value
--     from public.mom_ideas group by by_name order by 2 desc;
--
--   what is still open, anywhere:
--     select m.project_id, m.date, c.problem
--     from public.mom_challenges c join public.moms m on m.app_id = c.mom_app_id
--     where c.status = 'open' order by m.date;
--
--   everything ever said about one project, chat and assistant together:
--     select at, who, by_name, text from public.messages
--     where project_id = 'Eb-09-ML-432-01-1752' order by at;
--
--   which session raised this task:
--     select t.title, m.title, m.date from public.tasks t
--     join public.moms m on m.app_id = t.mom_app_id where t.origin = 'mom';
