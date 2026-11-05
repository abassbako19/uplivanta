-- UPLIVANTA trust, safety, assistance tracking and Impact Points foundation.
-- Additive migration: does not replace or delete existing tables.
create extension if not exists pgcrypto;

create table if not exists public.impact_points_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  points integer not null check (points between -500 and 500 and points <> 0),
  event_type text not null check (event_type in ('verified_participation','completed_assistance','volunteering','community_contribution','correction')),
  event_key text not null unique,
  note text not null default '',
  awarded_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.impact_points_ledger enable row level security;
create policy "members read own impact points" on public.impact_points_ledger for select to authenticated using (user_id = (select auth.uid()));
-- No client insert/update/delete policy. Awards are server-side and admin-only.

create table if not exists public.identity_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  provider text not null default 'pending_provider_selection',
  provider_reference text,
  status text not null default 'not_started' check (status in ('not_started','pending','verified','manual_review','failed','expired')),
  consent_at timestamptz,
  verified_at timestamptz,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.identity_verifications enable row level security;
create policy "members read own identity status" on public.identity_verifications for select to authenticated using (user_id = (select auth.uid()));
-- Store provider references/status only. Never store raw NIN, BVN, selfies or ID scans here.

create table if not exists public.risk_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  target_user_id uuid references auth.users(id) on delete set null,
  request_id uuid references public.bill_requests(id) on delete set null,
  reason text not null check (reason in ('suspected_fraud','duplicate_request','misleading_evidence','harassment','impersonation','other')),
  details text not null check (char_length(details) between 15 and 1500),
  status text not null default 'open' check (status in ('open','investigating','substantiated','unsubstantiated','dismissed')),
  review_note text,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint risk_report_one_target check ((target_user_id is not null) <> (request_id is not null))
);
create index if not exists risk_reports_status_created_idx on public.risk_reports(status, created_at);
alter table public.risk_reports enable row level security;
create policy "reporters read own submitted reports" on public.risk_reports for select to authenticated using (reporter_id = (select auth.uid()));
-- No client update/delete policy. Reports are private to reporter and authorized staff.

create table if not exists public.assistance_commitments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid references public.bill_requests(id) on delete set null,
  status text not null default 'accepted' check (status in ('accepted','in_progress','completed','cancelled','disputed')),
  verified_outcome boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists assistance_commitments_user_status_idx on public.assistance_commitments(user_id, status);
alter table public.assistance_commitments enable row level security;
create policy "members read own assistance commitments" on public.assistance_commitments for select to authenticated using (user_id = (select auth.uid()));
-- No client writes: only trusted admin/provider workflows may record outcomes.

create table if not exists public.assistance_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.bill_requests(id) on delete cascade,
  actor_id uuid references auth.users(id),
  event_type text not null check (event_type in ('evidence_reviewed','contribution_confirmed','assistance_delivered','request_completed','request_updated')),
  public_note text not null default '' check (char_length(public_note) <= 500),
  is_public boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists assistance_events_request_created_idx on public.assistance_events(request_id, created_at);
alter table public.assistance_events enable row level security;
create policy "public can read published public timeline events" on public.assistance_events for select to anon, authenticated using (is_public = true and exists (select 1 from public.bill_requests b where b.id = request_id and b.status = 'published'));
-- No client writes: timeline events must come from trusted workflows.
