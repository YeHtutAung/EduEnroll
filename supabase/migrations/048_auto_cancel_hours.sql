-- ============================================================
-- 048_auto_cancel_hours.sql
-- Make enrollment auto-cancel policy configurable per tenant.
--
-- Adds auto_cancel_hours column to tenants (default 72).
-- Rewrites check_expired_enrollments() to read per-tenant value
-- instead of hardcoded 72-hour interval.
-- Setting auto_cancel_hours = 0 disables auto-cancel.
-- ============================================================

-- ── 1. Add column ──────────────────────────────────────────────
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS auto_cancel_hours integer NOT NULL DEFAULT 72;

-- ── 2. Replace expiry function with per-tenant version ─────────
CREATE OR REPLACE FUNCTION public.check_expired_enrollments()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expired_count integer := 0;
  v_class_count   integer := 0;
BEGIN

  -- ── 1. Pre-count for the return payload ─────────────────────
  SELECT count(*)::integer INTO v_expired_count
  FROM   public.enrollments e
  JOIN   public.tenants t ON t.id = e.tenant_id
  WHERE  e.status = 'pending_payment'
    AND  t.auto_cancel_hours > 0
    AND  e.enrolled_at < now() - (t.auto_cancel_hours * interval '1 hour');

  IF v_expired_count = 0 THEN
    RETURN jsonb_build_object(
      'success',         true,
      'expired_count',   0,
      'classes_updated', 0,
      'ran_at',          now()
    );
  END IF;

  -- ── 2. Atomically reject and restore seats ───────────────────
  WITH expired AS (
    UPDATE public.enrollments e
    SET    status = 'rejected'
    FROM   public.tenants t
    WHERE  t.id = e.tenant_id
      AND  e.status = 'pending_payment'
      AND  t.auto_cancel_hours > 0
      AND  e.enrolled_at < now() - (t.auto_cancel_hours * interval '1 hour')
    RETURNING e.class_id
  ),
  class_seats AS (
    SELECT   class_id,
             count(*)::integer AS freed_seats
    FROM     expired
    WHERE    class_id IS NOT NULL
    GROUP BY class_id
  )
  UPDATE public.classes c
  SET
    seat_remaining = LEAST(c.seat_remaining + cs.freed_seats, c.seat_total),
    status = CASE
               WHEN c.status = 'full'
                AND (c.seat_remaining + cs.freed_seats) > 0
               THEN 'open'::class_status
               ELSE c.status
             END
  FROM class_seats cs
  WHERE c.id = cs.class_id;

  GET DIAGNOSTICS v_class_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'success',         true,
    'expired_count',   v_expired_count,
    'classes_updated', v_class_count,
    'ran_at',          now()
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   SQLERRM,
      'detail',  SQLSTATE,
      'ran_at',  now()
    );
END;
$$;
