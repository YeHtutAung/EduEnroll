-- ============================================================
-- 066_create_get_tenant_revenue.sql
-- RPC: get_tenant_revenue(p_tenant_id)
-- Returns total verified payment amount (MMK) for a tenant.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_tenant_revenue(p_tenant_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(amount_mmk), 0)
  FROM public.payments
  WHERE tenant_id = p_tenant_id
    AND status = 'verified';
$$;

GRANT EXECUTE ON FUNCTION public.get_tenant_revenue(uuid) TO authenticated;
