-- Uplivanta initial Supabase schema
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Member',
  country text,
  created_at timestamptz not null default now()
);

create table if not exists public.bill_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null,
  country text not null,
  currency text not null check (currency in ('NGN','USD','GBP','EUR','GHS','KES','CAD','AUD')),
  amount_minor bigint not null check (amount_minor >= 100),
  raised_minor bigint not null default 0 check (raised_minor >= 0),
  category text not null default 'Other',
  title text not null,
  story text not null,
  deadline date,
  status text not null default 'pending_review'
    check (status in ('pending_review','needs_more_info','published','rejected','funded','closed')),
  moderation_note text,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  bill_document_path text,
  biller_name text,
  biller_reference_last4 text,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id),
  request_id uuid references public.bill_requests(id),
  event_type text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.bill_requests enable row level security;
alter table public.audit_events enable row level security;

create policy "members read own profile" on public.profiles for select to authenticated using (id = auth.uid());
create policy "members insert own profile" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "members update own profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Public sees approved requests only; owners can see their own pending requests.
create policy "read published or own requests" on public.bill_requests for select to authenticated
using (status = 'published' or owner_id = auth.uid());
create policy "owner create pending requests" on public.bill_requests for insert to authenticated
with check (owner_id = auth.uid() and status = 'pending_review');
-- No client update/delete policy: moderation changes go through the trusted server only.
-- Admin server uses the service-role key; keep it secret and server-side only.

create policy "audit owners cannot read audit log" on public.audit_events for select to authenticated using (false);

-- Create a private Storage bucket named "bill-evidence" in Supabase.
-- Keep it private. Generate short-lived signed URLs only after staff authorization.
-- Never expose raw bill scans in public request pages.


create table if not exists public.supporter_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  display_name text not null,
  country text,
  bio text,
  public_opt_in boolean not null default false,
  status text not null default 'active' check (status in ('active','suspended')),
  created_at timestamptz not null default now()
);
alter table public.supporter_profiles enable row level security;
create policy "public reads only opted-in active supporters" on public.supporter_profiles
for select using (public_opt_in = true and status = 'active');
create policy "users manage own supporter profile" on public.supporter_profiles
for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
