-- ═══════════════════════════════════════════════════════════════════════════
-- Re-open sign-up to anybody with the URL — the state before
-- supabase/invite-only.sql. Just restores the ordinary trigger.
-- ═══════════════════════════════════════════════════════════════════════════
-- (This is exactly the trigger shipped in fix-resource-creation.sql.)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  existing public.profiles%rowtype;
  cnt int;
begin
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

  select count(*) into cnt from public.profiles;
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

select 'Invite-only is OFF. Anybody with the URL can create an account.' as result;
