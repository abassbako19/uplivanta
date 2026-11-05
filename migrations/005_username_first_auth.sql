-- UPLIVANTA username sign-in and reliable profile creation. Additive migration.
alter table public.profiles add column if not exists username text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='profiles_username_format_check' and conrelid='public.profiles'::regclass) then
    alter table public.profiles add constraint profiles_username_format_check check (username is null or username ~ '^[a-z0-9_]{3,20}$');
  end if;
end $$;
create unique index if not exists profiles_username_lower_uidx on public.profiles (lower(username)) where username is not null;
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path='' as $$
declare chosen_username text; chosen_display text; begin
 chosen_username := nullif(lower(trim(coalesce(new.raw_user_meta_data->>'username',''))),'');
 if chosen_username !~ '^[a-z0-9_]{3,20}$' then chosen_username := null; end if;
 chosen_display := coalesce(nullif(trim(coalesce(new.raw_user_meta_data->>'display_name','')),''),split_part(coalesce(new.email,''),'@',1),'Member');
 insert into public.profiles(id,display_name,username) values(new.id,left(chosen_display,50),chosen_username)
 on conflict(id) do update set display_name=excluded.display_name, username=coalesce(public.profiles.username,excluded.username);
 return new; end; $$;
revoke all on function public.handle_new_user() from public, anon, authenticated;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
insert into public.profiles(id,display_name) select u.id,left(coalesce(nullif(trim(coalesce(u.raw_user_meta_data->>'display_name','')),''),nullif(split_part(coalesce(u.email,''),'@',1),''),'Member'),50) from auth.users u on conflict(id) do nothing;
