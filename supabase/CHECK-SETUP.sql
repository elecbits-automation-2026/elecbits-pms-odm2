-- ═══════════════════════════════════════════════════════════════════════════
-- "Can we add users yet?" — paste this into the Supabase SQL editor and run.
-- It changes nothing. It reads the shape of your database and tells you which
-- scripts have landed and which are still to run.
-- ═══════════════════════════════════════════════════════════════════════════
with checks as (
  select
    'profiles table exists' as item,
    to_regclass('public.profiles') is not null as ok,
    'Run supabase/schema.sql first — nothing works without it.' as fix,
    1 as ord

  union all
  select
    'a person can exist before their login does',
    not exists (
      select 1 from pg_constraint
       where conrelid = 'public.profiles'::regclass
         and contype = 'f'
         and conname = 'profiles_id_fkey'
    ),
    'Run supabase/fix-resource-creation.sql. Until then, adding a resource in the app is rejected because profiles.id still demands a matching auth.users row.',
    2

  union all
  select
    'profiles.auth_id column',
    exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'profiles' and column_name = 'auth_id'
    ),
    'Run supabase/fix-resource-creation.sql — without this column a login cannot be told apart from a roster id.',
    3

  union all
  select
    'signing up adopts an existing roster entry',
    exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'handle_new_user'
         and pg_get_functiondef(p.oid) ilike '%auth_id is null%'
    ),
    'Run supabase/fix-resource-creation.sql — sign-up still creates a second, empty profile instead of claiming the one a PM filled in.',
    4

  union all
  select
    'admins are recognised through their login',
    exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'is_admin'
         and pg_get_functiondef(p.oid) ilike '%auth_id%'
    ),
    'Run supabase/fix-resource-creation.sql.',
    5

  union all
  select
    'an admin may add somebody who has no login',
    exists (
      select 1 from pg_policies
       where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_admin_insert'
    ),
    'Run supabase/RUN-THIS-FIX-ALL.sql, then supabase/fix-resource-creation.sql.',
    6

  union all
  select
    'nobody is on the roster twice',
    not exists (
      select 1 from public.profiles
       where email is not null and email <> ''
       group by lower(email) having count(*) > 1
    ),
    'Two rows share an email. See the second result below and delete the one with no auth_id, or re-run supabase/fix-resource-creation.sql to fold them.',
    7
)
select
  case when ok then '✅' else '❌' end as ok,
  item as what,
  case when ok then 'ready' else fix end as status
from checks order by ord;

-- Who is on the roster, and can they get in?
select
  coalesce(p.name, '—')  as person,
  coalesce(p.email, '—') as email,
  p.role,
  coalesce(p.title, '—') as title,
  case
    when to_jsonb(p) ->> 'auth_id' is not null then 'can sign in'
    else 'awaiting sign-up — they get in by signing up with this email'
  end as login
from public.profiles p
order by (to_jsonb(p) ->> 'auth_id' is null) desc, p.role, p.name;
