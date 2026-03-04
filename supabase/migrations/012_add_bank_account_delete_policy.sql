-- ============================================================
-- 012_add_bank_account_delete_policy.sql
-- Adds the missing DELETE RLS policy to bank_accounts.
--
-- Migration 007 defined SELECT / INSERT / UPDATE policies but
-- omitted DELETE, so authenticated deletes were silently blocked
-- by Postgres RLS.  The API route works around this by using the
-- service-role client, but the policy should exist for correctness.
-- ============================================================

CREATE POLICY "bank_accounts_delete"
  ON public.bank_accounts
  FOR DELETE
  TO authenticated
  USING (tenant_id = public.get_my_tenant_id());
