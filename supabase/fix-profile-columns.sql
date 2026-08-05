-- ═══════════════════════════════════════════════════════════════════════════
-- FIX: Department (and role/function, skills, capacity) lost on refresh
--
-- Symptom: you set a resource's Department in Resources → Edit, it shows
-- correctly, then reverts to "—" after a page refresh.
--
-- Cause: the profiles table had no columns for these fields, so they were
-- never persisted — only name/role/title/colour round-tripped.
--
-- Safe to re-run. Paste into the Supabase SQL editor and press Run.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.profiles add column if not exists dept          text;
alter table public.profiles add column if not exists resource_role text;
alter table public.profiles add column if not exists skills        jsonb default '[]'::jsonb;
alter table public.profiles add column if not exists max_projects  int;
alter table public.profiles add column if not exists project_tags  jsonb default '[]'::jsonb;

grant select, insert, update, delete on public.profiles to authenticated;

-- Verify: the new columns should be listed.
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles'
order by ordinal_position;
