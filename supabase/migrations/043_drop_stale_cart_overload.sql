-- Drop the stale submit_cart_enrollment overload that has p_idempotency_key parameter.
-- This was left behind from a previous reverted migration attempt.
-- The correct version (p_items jsonb, p_tenant_id uuid DEFAULT NULL) is in 042.
DROP FUNCTION IF EXISTS public.submit_cart_enrollment(jsonb, text);
