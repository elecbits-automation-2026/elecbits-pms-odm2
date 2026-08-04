-- ═══════════════════════════════════════════════════════════════════════════
-- Elecbits ODM PMS — full schema (auth, pgvector, all tables)
-- Run once in the Supabase SQL editor (Dashboard → SQL editor → New query).
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Extensions ─────────────────────────────────────────────────────────────
create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "vector";      -- pgvector (semantic memory)

-- ═══ AUTH / PEOPLE ═════════════════════════════════════════════════════════
-- profiles: one row per auth user, auto-created on sign-up (trigger below).
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text,
  name          text,
  role          text not null default 'engineer'
                  check (role in ('superadmin','dept_head','pm','engineer')),
  title         text,
  resource_role text,
  color         text default '#2563eb',
  created_at    timestamptz not null default now()
);

-- Create a profile automatically for every new auth user.
-- The very first user to sign up becomes the superadmin; everyone else an engineer.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare cnt int;
begin
  select count(*) into cnt from public.profiles;
  insert into public.profiles (id, email, name, role, color)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)),
    case when cnt = 0 then 'superadmin' else 'engineer' end,
    '#2563eb'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ═══ CLIENTS & PROJECTS ════════════════════════════════════════════════════
create table if not exists public.clients (
  id         uuid primary key default gen_random_uuid(),
  client_id  text unique,
  name       text not null,
  industry   text,
  org_size   text,
  created_at timestamptz not null default now()
);

create table if not exists public.projects (
  id            uuid primary key default gen_random_uuid(),
  project_id    text unique not null,
  id_mode       text default 'auto',
  name          text not null,
  description   text,
  client_name   text,
  client_id     text,
  industry      text,
  org_size      text,
  contact       jsonb default '{}'::jsonb,
  deadline      date,
  status        text default 'Planning',
  sanctioned    boolean default false,
  lld_customer  jsonb,
  lld_designer  jsonb,
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.team_assignments (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references public.projects(id) on delete cascade,
  user_id     uuid references public.profiles(id) on delete cascade,
  slot        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists team_assignments_project_idx on public.team_assignments(project_id);

-- ═══ DAILY SCRUM & TASKS ═══════════════════════════════════════════════════
create table if not exists public.scrum_notes (
  id          uuid primary key default gen_random_uuid(),
  date        date not null,
  note_no     int,
  time        text,
  raw         text,
  organized   jsonb,
  origin      text default 'manual',
  by          uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
create index if not exists scrum_notes_date_idx on public.scrum_notes(date);

create table if not exists public.tasks (
  id               uuid primary key default gen_random_uuid(),
  project_id       text,
  linked           boolean default true,
  title            text not null,
  assignee_id      uuid references public.profiles(id),
  assignee_name    text,
  date             date,
  start_time       text,
  end_time         text,
  steps            jsonb default '[]'::jsonb,
  conditions       jsonb default '[]'::jsonb,
  status           text default 'pending'
                     check (status in ('pending','in-progress','blocked','done')),
  origin           text default 'scrum',
  note_id          uuid,
  parent_task_id   uuid,
  work             jsonb default '{}'::jsonb,
  ai_verification  jsonb,
  escalated        jsonb,
  created_by       uuid references public.profiles(id),
  completed_at     timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists tasks_project_idx on public.tasks(project_id);
create index if not exists tasks_assignee_idx on public.tasks(assignee_id);
create index if not exists tasks_date_idx on public.tasks(date);

-- ═══ PERFORMANCE & TRAINING ════════════════════════════════════════════════
create table if not exists public.kpi_log (
  id      uuid primary key default gen_random_uuid(),
  pm_id   uuid references public.profiles(id),
  date    date not null,
  type    text,
  at      timestamptz not null default now()
);

create table if not exists public.work_updates (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.profiles(id) on delete cascade,
  date       date not null,
  note       text,
  score      int,
  feedback   text,
  kpi_hits   jsonb default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, date)
);

create table if not exists public.trainings (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.profiles(id) on delete cascade,
  title       text not null,
  resource    text,
  due         date,
  status      text default 'Assigned',
  assigned_by uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);

-- ═══ SYSTEM MEMORY (pgvector) ══════════════════════════════════════════════
-- content is injected into every AI call; embedding enables semantic recall.
create table if not exists public.memory (
  id         uuid primary key default gen_random_uuid(),
  type       text default 'note',
  title      text,
  content    text,
  file_name  text,
  embedding  vector(1536),           -- OpenAI/Voyage-style 1536-dim; adjust to your embedder
  created_at timestamptz not null default now()
);
-- Approximate-nearest-neighbour index (cosine). Build after you have some rows.
create index if not exists memory_embedding_idx
  on public.memory using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- Semantic search over memory. Call from an Edge Function after embedding the query.
create or replace function public.match_memory(
  query_embedding vector(1536),
  match_count int default 5,
  min_similarity float default 0.0
)
returns table (id uuid, type text, title text, content text, similarity float)
language sql stable
as $$
  select m.id, m.type, m.title, m.content,
         1 - (m.embedding <=> query_embedding) as similarity
  from public.memory m
  where m.embedding is not null
    and 1 - (m.embedding <=> query_embedding) >= min_similarity
  order by m.embedding <=> query_embedding
  limit match_count;
$$;

-- ═══ KV STORE + SYNC LOG ═══════════════════════════════════════════════════
create table if not exists public.app_kv (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.drive_sync_log (
  id     bigint generated always as identity primary key,
  target text,
  detail text,
  at     timestamptz not null default now()
);

-- ═══ ROW LEVEL SECURITY ════════════════════════════════════════════════════
-- Internal team tool: any signed-in user may read/write shared state; anon is
-- blocked. profiles: everyone reads the roster, you may edit only your own row.
-- Tighten per-table (e.g. scope tasks to assignee/PM) as your policy matures.
do $$
declare t text;
begin
  foreach t in array array[
    'clients','projects','team_assignments','scrum_notes','tasks',
    'kpi_log','work_updates','trainings','memory','app_kv','drive_sync_log'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_auth_all on public.%I', t, t);
    execute format(
      'create policy %I_auth_all on public.%I for all to authenticated using (true) with check (true)',
      t, t);
  end loop;
end $$;

-- Table-level grants. RLS policies decide WHICH rows a role may touch, but
-- PostgREST also needs the underlying privilege — without this you get a 401
-- ("permission denied") on /rest/v1/<table> even while auth works fine.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;
grant usage, select on all sequences in schema public to authenticated;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;

-- Is the caller an admin? SECURITY DEFINER so a policy on `profiles` can read
-- `profiles` without recursing through RLS.
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('superadmin', 'dept_head')
  );
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

alter table public.profiles enable row level security;
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (true);
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles for insert to authenticated
  with check (id = auth.uid());
-- Admins manage the whole roster (Resources → add / edit / remove).
drop policy if exists profiles_admin_insert on public.profiles;
create policy profiles_admin_insert on public.profiles for insert to authenticated
  with check (public.is_admin());
drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists profiles_admin_delete on public.profiles;
create policy profiles_admin_delete on public.profiles for delete to authenticated
  using (public.is_admin());
