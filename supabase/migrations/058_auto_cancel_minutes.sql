-- ============================================================
-- 058_auto_cancel_minutes.sql
-- Change auto_cancel_hours from hour-based to minute-based.
-- Column name stays the same, but value is now interpreted as minutes.
-- Default changes from 72 (hours) to 4320 (72 hours in minutes).
-- ============================================================

-- ── 1. Convert existing hour values to minutes ───────────────
UPDATE public.tenants
SET auto_cancel_hours = auto_cancel_hours * 60
WHERE auto_cancel_hours > 0;

-- ── 2. Update default ────────────────────────────────────────
ALTER TABLE public.tenants
  ALTER COLUMN auto_cancel_hours SET DEFAULT 4320;

-- ── 3. Replace expiry function to use minutes instead of hours
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
    AND  e.enrolled_at < now() - (t.auto_cancel_hours * interval '1 minute');

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
      AND  e.enrolled_at < now() - (t.auto_cancel_hours * interval '1 minute')
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
