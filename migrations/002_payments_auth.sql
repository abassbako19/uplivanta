-- UPLIVANTA v0.3: contributions ledger (Paystack), automatic profile creation, safe settlement function.
-- Additive. Run once in the Supabase SQL Editor.

-- 1) Contributions: one row per Paystack checkout attempt.
create table if not exists public.contributions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.bill_requests(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  reference text not null unique,
  amount_minor bigint not null check (amount_minor >= 100),
  currency text not null default 'NGN',
  status text not null default 'pending' check (status in ('pending','success','failed','abandoned')),
  channel text,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists contributions_request_idx on public.contributions(request_id, status);
create index if not exists contributions_user_idx on public.contributions(user_id, created_at desc);
alter table public.contributions enable row level security;
drop policy if exists "members read own contributions" on public.contributions;
create policy "members read own contributions" on public.contributions
  for select to authenticated using (user_id = (select auth.uid()));
-- No client writes: only the server (service role) creates and settles contributions.

-- 2) Settlement: idempotent, row-locked. Called by the server only after Paystack confirms the charge.
create or replace function public.settle_contribution(p_reference text, p_channel text default null)
returns table(settled boolean, request_id uuid, raised_minor bigint, request_status text)
language plpgsql security definer set search_path = '' as $$
declare c public.contributions; b public.bill_requests;
begin
  select * into c from public.contributions where reference = p_reference for update;
  if not found then return; end if;
  if c.status = 'success' then
    select * into b from public.bill_requests where id = c.request_id;
    return query select false, b.id, b.raised_minor, b.status; return;
  end if;
  update public.contributions set status = 'success', paid_at = now(), channel = coalesce(p_channel, channel) where id = c.id;
  update public.bill_requests
     set raised_minor = raised_minor + c.amount_minor,
         status = case when raised_minor + c.amount_minor >= amount_minor and status = 'published' then 'funded' else status end
   where id = c.request_id returning * into b;
  insert into public.audit_events(actor_id, request_id, event_type, details)
  values (c.user_id, c.request_id, 'contribution_settled', jsonb_build_object('reference', p_reference, 'amount_minor', c.amount_minor));
  return query select true, b.id, b.raised_minor, b.status;
end $$;
revoke all on function public.settle_contribution(text, text) from public, anon, authenticated;
grant execute on function public.settle_contribution(text, text) to service_role;

-- 3) Create a profile row automatically when someone signs up (fixes "profile missing" errors).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id, display_name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'display_name',''), split_part(new.email,'@',1), 'Member'))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Back-fill profiles for people who already signed up.
insert into public.profiles(id, display_name)
select u.id, coalesce(nullif(u.raw_user_meta_data->>'display_name',''), split_part(u.email,'@',1), 'Member')
from auth.users u on conflict (id) do nothing;

-- 4) Identity: make provider references unique so a webhook can find the right user.
create unique index if not exists identity_provider_reference_idx
  on public.identity_verifications(provider_reference) where provider_reference is not null;
