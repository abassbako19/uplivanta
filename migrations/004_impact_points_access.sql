-- UPLIVANTA Impact Points: tighten Data API privileges.
-- Reads are performed through the authenticated server summary endpoint.
-- Direct client writes are never permitted; server-side service_role performs awards.
revoke all on table public.impact_points_ledger from anon, authenticated;
grant select on table public.impact_points_ledger to authenticated;
grant select, insert, update, delete on table public.impact_points_ledger to service_role;
