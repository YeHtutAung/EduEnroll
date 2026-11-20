-- ============================================================================
-- Sales analytics: how confirmed orders were paid
--
-- sales_payment_wallets(...) groups the VERIFIED payments of an event's
-- confirmed orders by payment method and by the wallet / bank the payer used.
--
--   method  payments.payment_method ('' when the row has none: older manual
--           uploads). 'none' is a separate row for confirmed orders that have
--           no verified payment at all, so the order counts reconcile.
--   wallet  trim(payments.payer_institution) exactly as the gateway reported
--           it (KBZPay Wallet_identifier, ABank/CB institutionName). NULL when
--           the gateway sent nothing — the page shows "Not reported" and never
--           guesses a wallet.
--   orders  distinct orders; an order paid in two methods counts in both rows.
--   amount  sum(payments.amount), the whole order's payment (platform fee
--           included), even when a ticket-type filter is set.
--
-- Same order scope as sales_analytics: confirmed, not internal_test_at, the
-- intake's own tenant, MMT order date, optional ticket type. No buyer PII.
-- SECURITY INVOKER: enrollments and payments row-level security apply.
--
-- Additive. Rollback: supabase/rollbacks/20261120154237_sales_payment_wallets.down.sql
-- DEPLOY ORDER: apply BEFORE the code that calls it, or the Analytics page
-- returns 500. Nothing else calls this function.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.sales_payment_wallets(
  p_intake_id uuid,
  p_from      date DEFAULT NULL,   -- MMT date, inclusive
  p_to        date DEFAULT NULL,   -- MMT date, inclusive
  p_class_id  uuid DEFAULT NULL    -- ticket type
)
RETURNS TABLE (
  method   text,
  wallet   text,
  orders   bigint,
  payments bigint,
  amount   bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
WITH orders AS (
  SELECT DISTINCT e.id, e.tenant_id
  FROM public.enrollments e
  JOIN public.intakes i ON i.id = p_intake_id
  LEFT JOIN public.enrollment_items ei
         ON e.class_id IS NULL AND ei.enrollment_id = e.id
  JOIN public.classes c ON c.id = coalesce(e.class_id, ei.class_id)
  WHERE c.intake_id = p_intake_id
    AND e.tenant_id = i.tenant_id
    AND e.internal_test_at IS NULL
    AND e.status = 'confirmed'
    AND (p_from IS NULL OR (e.enrolled_at AT TIME ZONE 'Asia/Yangon')::date >= p_from)
    AND (p_to   IS NULL OR (e.enrolled_at AT TIME ZONE 'Asia/Yangon')::date <= p_to)
    AND (p_class_id IS NULL OR c.id = p_class_id)
),
paid AS (
  SELECT o.id AS order_id,
         coalesce(p.payment_method, '')            AS method,
         NULLIF(trim(p.payer_institution), '')     AS wallet,
         p.amount::bigint                          AS amount
  FROM orders o
  JOIN public.payments p
    ON p.enrollment_id = o.id
   AND p.tenant_id = o.tenant_id
   AND p.status = 'verified'
)
SELECT method, wallet, count(DISTINCT order_id), count(*), coalesce(sum(amount), 0)::bigint
FROM paid
GROUP BY method, wallet
UNION ALL
SELECT 'none', NULL, count(*), 0, 0
FROM orders o
WHERE NOT EXISTS (SELECT 1 FROM paid WHERE paid.order_id = o.id)
HAVING count(*) > 0
ORDER BY 5 DESC, 3 DESC, 1, 2;
$$;

REVOKE ALL ON FUNCTION public.sales_payment_wallets(uuid, date, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sales_payment_wallets(uuid, date, date, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.sales_payment_wallets(uuid, date, date, uuid) IS
  'Admin Sales Analytics: verified payments of confirmed orders for one intake, by payment method and payer wallet. No buyer PII.';

NOTIFY pgrst, 'reload schema';

COMMIT;
