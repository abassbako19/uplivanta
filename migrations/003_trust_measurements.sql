-- UPLIVANTA v0.4: trust measurements (evidence rate, response rate). Additive.

-- Evidence rate: did a completed case have supporting evidence on file (checked by staff)?
alter table public.assistance_commitments
  add column if not exists has_evidence boolean not null default false;

-- Response rate: every time staff or the platform asks a person for something
-- (e.g. "needs more info"), a prompt is logged; responded_at is set when they reply.
create table if not exists public.contact_prompts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid references public.bill_requests(id) on delete set null,
  kind text not null default 'more_info' check (kind in ('more_info','follow_up','evidence_request')),
  prompted_at timestamptz not null default now(),
  responded_at timestamptz
);
create index if not exists contact_prompts_user_idx on public.contact_prompts(user_id, prompted_at desc);
alter table public.contact_prompts enable row level security;
drop policy if exists "members read own prompts" on public.contact_prompts;
create policy "members read own prompts" on public.contact_prompts
  for select to authenticated using (user_id = (select auth.uid()));
-- No client writes: the server records prompts and responses.
