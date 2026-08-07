-- ═══════════════════════════════════════════════════════════════════════════
-- OPTIONAL — close the workspace to people nobody invited.
--
-- Sign-up is self-serve: anyone who finds the URL can create an account with
-- any email and lands inside as an engineer. That is fine while you are
-- setting up. It is not fine in production.
--
-- After this runs, an account can only be created for an email that is
-- ALREADY on the roster — i.e. somebody a PM added in Resources, or the setup
-- script created. Everyone else is turned away at sign-up with a message
-- telling them to ask a PM. Google sign-in goes through the same gate.
--
-- Two doors stay open on purpose:
--   • the very first account in an empty workspace, so you can bootstrap;
--   • supabase/create-users.sql, which announces itself and is trusted.
--
-- Prereq: supabase/fix-resource-creation.sql.
-- Reversible: run supabase/invite-only-off.sql.
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  existing public.profiles%rowtype;
  cnt int;
begin
  -- Somebody already put this person on the roster: this sign-up is their
  -- login arriving. Keep their id, their role and everything filled in.
  select * into existing
    from public.profiles
   where auth_id is null
     and lower(email) = lower(new.email)
   limit 1;

  if found then
    update public.profiles
       set auth_id = new.id,
           name    = coalesce(nullif(name, ''), new.raw_user_meta_data->>'name', split_part(new.email, '@', 1))
     where id = existing.id;
    return new;
  end if;

  -- Nobody was expecting them.
  select count(*) into cnt from public.profiles;

  if cnt > 0 and coalesce(current_setting('app.allow_new_signups', true), '') <> 'on' then
    raise exception 'not_invited'
      using hint = 'Ask a project manager to add you under Resources first, then sign in with that same email.';
  end if;

  insert into public.profiles (id, auth_id, email, name, role, color)
  values (
    new.id, new.id, new.email,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
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

select 'Invite-only is ON. Only people already on the roster can create an account.' as result;
