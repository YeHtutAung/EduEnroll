-- ─── Migration 089: revoke anonymous table inserts ─────────────────────────
-- Security fix (audit #1 / #2).
--
-- enrollments, payments, and enrollment_items each carried an INSERT policy of
-- `TO anon, authenticated WITH CHECK (true)`. Because the anon key is public
-- (shipped to the browser), anyone could POST directly to PostgREST and insert
-- arbitrary rows — forged `verified` payments (which inflate get_tenant_revenue),
-- fake enrollments, and cross-tenant rows — bypassing all application validation.
--
-- Every legitimate write to these tables goes through a server route using the
-- service-role client (which bypasses RLS) or a SECURITY DEFINER RPC, so no
-- application flow depends on anon inserts. Replace the permissive policies with
-- authenticated, tenant-scoped ones (matching the existing UPDATE policies).

BEGIN;

-- ── enrollments ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "enrollments_insert_anon" ON public.enrollments;

CREATE POLICY "enrollments_insert_own_tenant"
  ON public.enrollments
  FOR INSERT
  TO authenticated
  WITH CHECK (tenant_id = public.get_my_tenant_id());

-- ── payments ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "payments_insert_anon" ON public.payments;

CREATE POLICY "payments_insert_own_tenant"
  ON public.payments
  FOR INSERT
  TO authenticated
  WITH CHECK (tenant_id = public.get_my_tenant_id());

-- ── enrollment_items ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "enrollment_items_insert_anon" ON public.enrollment_items;
DROP POLICY IF EXISTS "enrollment_items_insert_auth" ON public.enrollment_items;

CREATE POLICY "enrollment_items_insert_own_tenant"
  ON public.enrollment_items
  FOR INSERT
  TO authenticated
  WITH CHECK (tenant_id = public.get_my_tenant_id());

COMMIT;
