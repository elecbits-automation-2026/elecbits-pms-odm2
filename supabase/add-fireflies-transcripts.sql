-- ═══════════════════════════════════════════════════════════════════════════
-- MEETING TRANSCRIPTS — one row per Google Meet call, captured by Fireflies.
--
-- The daily scrum stops being something someone remembers to type up. Fireflies
-- sits in the Meet call, and what was actually said lands here: the whole
-- transcript, who said it, the summary and the action items. The scrum note
-- gets the readable part as its text, so "Organise with AI" turns the meeting
-- into assigned, time-boxed tasks the same way a typed note does.
--
-- WHY ITS OWN TABLE, AND NOT THE WORKSPACE BLOB
--   A transcript of an hour-long call is 8,000–15,000 words. The workspace blob
--   is read and rewritten on every save by every open browser; putting a
--   transcript a day in it would make the whole tool slower every day forever.
--   Transcripts are written once by the server and read when asked for — which
--   is exactly what a table is for.
--
-- Run once, in the SQL editor. Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- The rest of this tool's tables live in `pms` after 00-one-structure.sql, and
-- in `public` before it. Put this one wherever the others actually are, so it
-- is reachable either way and moves with them if the migration runs later.
do $$
declare target text;
begin
  select case
    when exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'pms' and c.relname = 'workspace') then 'pms'
    else 'public'
  end into target;

  execute format($ddl$
    create table if not exists %I.transcripts (
      id            uuid primary key default gen_random_uuid(),

      -- Where it came from, and its id THERE. Together they are unique, so
      -- importing the same meeting twice updates the row instead of stacking
      -- duplicates — which matters because a webhook and a manual pull can
      -- both land on the same call.
      source        text not null default 'fireflies',
      external_id   text not null,

      title         text,
      meeting_date  date not null,
      started_at    timestamptz,
      duration_min  numeric(6,1),

      -- The Google Meet link the call happened on, kept so the transcript can
      -- always be traced back to the meeting it came from.
      meeting_link  text,
      organizer_email text,
      attendees     jsonb not null default '[]'::jsonb,
      speakers      jsonb not null default '[]'::jsonb,

      -- What Fireflies made of it: the part a person reads.
      overview      text,
      action_items  text,
      keywords      text[] not null default '{}',

      -- What was actually said: the part the AI reads, and the record that
      -- settles "who agreed to what" six months from now.
      transcript    text,
      sentences     jsonb,
      word_count    int,

      -- Where it landed in the tool.
      project_id    text,
      note_app_id   text,
      imported_by   uuid,
      created_at    timestamptz not null default now()
    )$ddl$, target);

  execute format('create unique index if not exists transcripts_source_ext_idx on %I.transcripts (source, external_id)', target);
  execute format('create index if not exists transcripts_day_idx on %I.transcripts (meeting_date desc)', target);
  execute format('create index if not exists transcripts_project_idx on %I.transcripts (project_id)', target);
  execute format('create index if not exists transcripts_note_idx on %I.transcripts (note_app_id)', target);

  execute format('alter table %I.transcripts enable row level security', target);
  if not exists (select 1 from pg_policies where schemaname = target and tablename = 'transcripts' and policyname = 'transcripts_auth_all') then
    execute format('create policy transcripts_auth_all on %I.transcripts for all to authenticated using (true) with check (true)', target);
  end if;
  execute format('grant select, insert, update, delete on %I.transcripts to authenticated', target);

  -- A scrum note that came out of a recorded call says which meetings it came
  -- from, so the note and the transcripts stay tied together.
  execute format('alter table %I.scrum_notes add column if not exists meeting_ids text[] not null default ''{}''', target);

  raise notice 'transcripts table ready in schema %, scrum_notes.meeting_ids added', target;
end $$;


-- ── What you have ──────────────────────────────────────────────────────────
-- Read through a temp table, because only one of pms/public holds the real one
-- and naming the other directly would fail before the query ever ran.
do $$
declare target text;
begin
  select case
    when exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'pms' and c.relname = 'transcripts') then 'pms' else 'public' end
  into target;
  drop table if exists _tx;
  execute format('create temp table _tx as select * from %I.transcripts', target);
end $$;

select meeting_date, title, duration_min, word_count,
       coalesce(array_length(keywords, 1), 0) as keywords,
       note_app_id is not null as seeded_a_scrum_note
from _tx
order by meeting_date desc, title
limit 50;

drop table if exists _tx;
