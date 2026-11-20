-- ============================================================================
-- Sales analytics for one event (intake)
--
-- Two read-only functions behind the admin "Sales Analytics" page:
--
--   sales_analytics(...)         every aggregate the page draws, as one jsonb.
--                                No names, emails or phones leave the database.
--   sales_not_converted(...)     buyers whose orders were all rejected, one row
--                                per ticket line, WITH contact details. This is
--                                the only place the page shows PII.
--
-- A "line" is one row of the admin Attendees export:
--   cart order   (enrollments.class_id IS NULL): one line per enrollment_items
--                row; qty = items.quantity, fee = items.fee_amount * quantity
--                (the price saved at the time of sale).
--   single order (enrollments.class_id set): one line; qty = enrollments.quantity,
--                fee = classes.fee_amount * quantity (today's price; no saved
--                price exists for these).
-- Orders flagged internal_test_at (test / archived) are left out, as in the
-- export. All dates and hours are Asia/Yangon (MMT).
--
-- Buyer identity is lower(trim(email)) || phone. Each half is COALESCEd to ''
-- so a buyer without an email still counts; a buyer with neither is NULL and
-- is not counted.
--
-- SECURITY INVOKER: enrollments are read as the calling user, so the tenant
-- row-level security on enrollments applies. Each function also ties the
-- enrollment to the intake's own tenant.
--
-- Additive. Rollback: supabase/rollbacks/20261119144828_sales_analytics.down.sql
-- DEPLOY ORDER: apply BEFORE the code that calls it, or the Sales Analytics
-- page returns 500. Nothing else calls these functions.
-- ============================================================================

BEGIN;

-- Daily / status range scans over one tenant's visible orders.
CREATE INDEX IF NOT EXISTS idx_enrollments_tenant_status_enrolled_at
  ON public.enrollments (tenant_id, status, enrolled_at)
  WHERE internal_test_at IS NULL;

-- ─── Aggregates ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sales_analytics(
  p_intake_id uuid,
  p_from      date DEFAULT NULL,   -- MMT date, inclusive
  p_to        date DEFAULT NULL,   -- MMT date, inclusive
  p_class_id  uuid DEFAULT NULL    -- ticket type
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
WITH
-- Every confirmed/rejected line of the event, before date and type filters.
event_lines AS (
  SELECT
    e.id                                                     AS enrollment_id,
    e.enrollment_ref                                         AS ref,
    e.status::text                                           AS status,
    (e.enrolled_at AT TIME ZONE 'Asia/Yangon')::date         AS d,
    extract(hour FROM e.enrolled_at AT TIME ZONE 'Asia/Yangon')::int AS h,
    NULLIF(lower(trim(coalesce(e.email, ''))) || coalesce(e.phone, ''), '') AS buyer,
    c.id                                                     AS class_id,
    c.level                                                  AS ticket_type,
    CASE WHEN ei.id IS NOT NULL THEN ei.quantity
         ELSE coalesce(e.quantity, 1) END                    AS qty,
    CASE WHEN ei.id IS NOT NULL THEN ei.fee_amount::bigint * ei.quantity
         ELSE c.fee_amount::bigint * coalesce(e.quantity, 1) END AS fee
  FROM public.enrollments e
  JOIN public.intakes i ON i.id = p_intake_id
  LEFT JOIN public.enrollment_items ei
         ON e.class_id IS NULL AND ei.enrollment_id = e.id
  JOIN public.classes c ON c.id = coalesce(e.class_id, ei.class_id)
  WHERE c.intake_id = p_intake_id
    AND e.tenant_id = i.tenant_id
    AND e.internal_test_at IS NULL
    AND e.status IN ('confirmed', 'rejected')
),
lines AS (
  SELECT * FROM event_lines
  WHERE (p_from IS NULL OR d >= p_from)
    AND (p_to   IS NULL OR d <= p_to)
    AND (p_class_id IS NULL OR class_id = p_class_id)
),
conf AS (SELECT * FROM lines WHERE status = 'confirmed'),
rej  AS (SELECT * FROM lines WHERE status = 'rejected'),
today AS (SELECT (now() AT TIME ZONE 'Asia/Yangon')::date AS t),
-- Launch = first MMT day with a confirmed sale for the event (filters ignored).
launch AS (SELECT min(d) AS l FROM event_lines WHERE status = 'confirmed'),
anchor AS (
  SELECT least(coalesce(p_to, (SELECT t FROM today)), (SELECT t FROM today)) AS a
),
-- The two 7-day windows, minus days before launch+2 (launch days and the
-- quiet days before sales opened are not "normal" days).
win AS (
  SELECT g::date AS d,
         CASE WHEN g::date > (SELECT a FROM anchor) - 7 THEN 'last' ELSE 'prev' END AS w
  FROM generate_series((SELECT a FROM anchor) - 13, (SELECT a FROM anchor), interval '1 day') g
  WHERE (SELECT l FROM launch) IS NOT NULL
    AND g::date >= (SELECT l FROM launch) + 2
),
win_stats AS (
  SELECT w,
         count(*)                                                    AS days,
         coalesce(sum((SELECT sum(qty) FROM conf c WHERE c.d = win.d)), 0) AS tickets
  FROM win GROUP BY w
),
days AS (
  SELECT g::date AS d
  FROM generate_series(
         coalesce(p_from, (SELECT min(d) FROM lines)),
         coalesce(p_to,   (SELECT max(d) FROM lines)),
         interval '1 day') g
  WHERE (SELECT count(*) FROM lines) > 0
),
order_sizes AS (
  SELECT ref, sum(qty) AS n FROM conf GROUP BY ref
),
rej_buyers  AS (SELECT DISTINCT buyer FROM rej  WHERE buyer IS NOT NULL),
conf_buyers AS (SELECT DISTINCT buyer FROM conf WHERE buyer IS NOT NULL)
SELECT jsonb_build_object(
  'kpis', jsonb_build_object(
    'revenue',          (SELECT coalesce(sum(fee), 0) FROM conf),
    'tickets',          (SELECT coalesce(sum(qty), 0) FROM conf),
    'confirmed_orders', (SELECT count(DISTINCT ref) FROM conf),
    'unique_buyers',    (SELECT count(DISTINCT buyer) FROM conf),
    'rejected_orders',  (SELECT count(DISTINCT ref) FROM rej),
    'rejected_value',   (SELECT coalesce(sum(fee), 0) FROM rej),
    'last7', jsonb_build_object(
      'anchor',        (SELECT a FROM anchor),
      'launch',        (SELECT l FROM launch),
      'last_days',     (SELECT days    FROM win_stats WHERE w = 'last'),
      'last_tickets',  (SELECT tickets FROM win_stats WHERE w = 'last'),
      'prev_days',     (SELECT days    FROM win_stats WHERE w = 'prev'),
      'prev_tickets',  (SELECT tickets FROM win_stats WHERE w = 'prev')
    )
  ),
  'daily', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'date', days.d,
             'types', coalesce((
               SELECT jsonb_agg(jsonb_build_object(
                        'type', ticket_type, 'tickets', t, 'revenue', r)
                        ORDER BY ticket_type)
               FROM (SELECT ticket_type, sum(qty) AS t, sum(fee) AS r
                     FROM conf WHERE conf.d = days.d GROUP BY ticket_type) x
             ), '[]'::jsonb),
             'confirmed_orders', (SELECT count(DISTINCT ref) FROM conf WHERE conf.d = days.d),
             'rejected_orders',  (SELECT count(DISTINCT ref) FROM rej  WHERE rej.d  = days.d)
           ) ORDER BY days.d)
    FROM days
  ), '[]'::jsonb),
  'mix', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'type', ticket_type, 'tickets', t, 'revenue', r) ORDER BY r DESC, ticket_type)
    FROM (SELECT ticket_type, sum(qty) AS t, sum(fee) AS r FROM conf GROUP BY ticket_type) x
  ), '[]'::jsonb),
  'price_tiers', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'type', ticket_type, 'unit_price', unit_price, 'tickets', t,
             'first_date', f, 'last_date', l) ORDER BY ticket_type, unit_price)
    FROM (SELECT ticket_type, fee / qty AS unit_price, sum(qty) AS t, min(d) AS f, max(d) AS l
          FROM conf GROUP BY ticket_type, fee / qty) x
  ), '[]'::jsonb),
  'by_hour', (
    SELECT jsonb_agg(jsonb_build_object(
             'hour', hr, 'tickets', coalesce((SELECT sum(qty) FROM conf WHERE conf.h = hr), 0))
             ORDER BY hr)
    FROM generate_series(0, 23) hr
  ),
  'order_sizes', (
    SELECT jsonb_agg(jsonb_build_object(
             'bucket', CASE WHEN b = 10 THEN '10+' ELSE b::text END,
             'orders', (SELECT count(*) FROM order_sizes
                        WHERE CASE WHEN b = 10 THEN n >= 10 ELSE n = b END))
             ORDER BY b)
    FROM generate_series(1, 10) b
  ),
  'recovery', jsonb_build_object(
    'rejected_buyers',  (SELECT count(*) FROM rej_buyers),
    'recovered_buyers', (SELECT count(*) FROM rej_buyers r JOIN conf_buyers c USING (buyer))
  )
);
$$;

-- ─── Not converted: the follow-up list (contains PII) ──────────────────────
-- A buyer is "not converted" when every order they placed for the event was
-- rejected: at least one rejected order and no order in any other status
-- (confirmed or still pending). That test looks at the whole event so a date
-- or type filter can't hide the buyer's confirmed order; the filters then
-- choose which of their lines are listed.
CREATE OR REPLACE FUNCTION public.sales_not_converted(
  p_intake_id uuid,
  p_from      date DEFAULT NULL,
  p_to        date DEFAULT NULL,
  p_class_id  uuid DEFAULT NULL
)
RETURNS TABLE (
  ref         text,
  name        text,
  email       text,
  phone       text,
  ticket_type text,
  qty         int,
  fee         bigint,
  enrolled_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
WITH event_orders AS (
  SELECT DISTINCT
    e.id, e.status::text AS status,
    NULLIF(lower(trim(coalesce(e.email, ''))) || coalesce(e.phone, ''), '') AS buyer
  FROM public.enrollments e
  JOIN public.intakes i ON i.id = p_intake_id
  LEFT JOIN public.enrollment_items ei
         ON e.class_id IS NULL AND ei.enrollment_id = e.id
  JOIN public.classes c ON c.id = coalesce(e.class_id, ei.class_id)
  WHERE c.intake_id = p_intake_id
    AND e.tenant_id = i.tenant_id
    AND e.internal_test_at IS NULL
),
lost AS (
  SELECT buyer FROM event_orders WHERE buyer IS NOT NULL
  GROUP BY buyer
  HAVING bool_and(status = 'rejected')
)
SELECT
  e.enrollment_ref::text,
  e.student_name_en::text,
  e.email::text,
  e.phone::text,
  c.level,
  (CASE WHEN ei.id IS NOT NULL THEN ei.quantity ELSE coalesce(e.quantity, 1) END)::int,
  CASE WHEN ei.id IS NOT NULL THEN ei.fee_amount::bigint * ei.quantity
       ELSE c.fee_amount::bigint * coalesce(e.quantity, 1) END,
  e.enrolled_at
FROM public.enrollments e
JOIN public.intakes i ON i.id = p_intake_id
LEFT JOIN public.enrollment_items ei
       ON e.class_id IS NULL AND ei.enrollment_id = e.id
JOIN public.classes c ON c.id = coalesce(e.class_id, ei.class_id)
JOIN lost l
  ON l.buyer = NULLIF(lower(trim(coalesce(e.email, ''))) || coalesce(e.phone, ''), '')
WHERE c.intake_id = p_intake_id
  AND e.tenant_id = i.tenant_id
  AND e.internal_test_at IS NULL
  AND e.status = 'rejected'
  AND (p_from IS NULL OR (e.enrolled_at AT TIME ZONE 'Asia/Yangon')::date >= p_from)
  AND (p_to   IS NULL OR (e.enrolled_at AT TIME ZONE 'Asia/Yangon')::date <= p_to)
  AND (p_class_id IS NULL OR c.id = p_class_id)
ORDER BY e.enrolled_at DESC, e.enrollment_ref, c.level;
$$;

REVOKE ALL ON FUNCTION public.sales_analytics(uuid, date, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sales_analytics(uuid, date, date, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.sales_not_converted(uuid, date, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sales_not_converted(uuid, date, date, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.sales_analytics(uuid, date, date, uuid) IS
  'Admin Sales Analytics aggregates for one intake (event). No buyer PII. Dates/hours in Asia/Yangon.';
COMMENT ON FUNCTION public.sales_not_converted(uuid, date, date, uuid) IS
  'Admin Sales Analytics follow-up list: rejected lines of buyers with no non-rejected order for the intake. Contains contact details.';

NOTIFY pgrst, 'reload schema';

COMMIT;
