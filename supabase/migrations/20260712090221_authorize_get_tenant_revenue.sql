-- ─── Migration 091: authorize get_tenant_revenue ───────────────────────────
-- Security fix (audit #6).
--
-- get_tenant_revenue(p_tenant_id) is SECURITY DEFINER and granted to
-- `authenticated`, but it never checked that the caller is entitled to the
-- tenant they pass. Any authenticated user could `.rpc('get_tenant_revenue',
-- { p_tenant_id: <any tenant> })` directly via PostgREST and read another
-- tenant's revenue.
--
-- Fix: enforce that the requested tenant is the caller's own tenant, unless the
-- caller is a superadmin. Signature is unchanged; the sole app caller
-- (/api/admin/stats) already passes the caller's own tenant_id.

CREATE OR REPLACE FUNCTION public.get_tenant_revenue(p_tenant_id uuid)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total bigint;
BEGIN
  IF public.get_my_role() <> 'superadmin'
     AND p_tenant_id IS DISTINCT FROM public.get_my_tenant_id() THEN
    RAISE EXCEPTION 'not authorized to read revenue for this tenant'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(SUM(amount), 0)
  INTO   v_total
  FROM   public.payments
  WHERE  tenant_id = p_tenant_id
    AND  status = 'verified';

  RETURN v_total;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_tenant_revenue(uuid) TO authenticated;
