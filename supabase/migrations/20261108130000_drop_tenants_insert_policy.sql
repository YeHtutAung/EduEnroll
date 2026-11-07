-- Remove the tenants_insert RLS policy (GHSA-m7fp-v37m-f92j).
--
-- 000_combined_schema.sql gave every signed-in user an INSERT policy on
-- public.tenants with WITH CHECK (true). No later migration narrowed it.
--
-- Nothing in the app needs it. Every path that creates a tenant row uses the
-- service-role key, which bypasses RLS:
--   - POST /api/saas/register  (createAdminClient)
--   - scripts/seed-e2e.ts      (service-role client, dev only)
-- The superadmin school routes read and update tenants but never insert.
--
-- With the policy gone, RLS on tenants has no INSERT policy, so anon and
-- authenticated cannot insert at all. SELECT and UPDATE policies are unchanged.
--
-- Safe to apply before or after the code: no code depends on the policy.

drop policy if exists "tenants_insert" on public.tenants;
