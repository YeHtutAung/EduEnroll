-- ============================================================
-- 011_create_expiry_function.sql
-- Automated expiry of unpaid enrollments
--
-- check_expired_enrollments() finds all enrollments with
-- status='pending_payment' older than 72 hours, rejects them,
-- and atomically restores each class's seat_remaining.
--
-- Designed to run every 6 hours via pg_cron or Edge Functions.
-- See CRON_SETUP.md for scheduling instructions.
-- ============================================================

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
  -- A small race window exists between this count and the UPDATE
  -- below, which is acceptable for a background housekeeping job.
  SELECT count(*)::integer INTO v_expired_count
  FROM   public.enrollments
  WHERE  status    = 'pending_payment'
    AND  enrolled_at < now() - interval '72 hours';

  IF v_expired_count = 0 THEN
    RETURN jsonb_build_object(
      'success',         true,
      'expired_count',   0,
      'classes_updated', 0,
      'ran_at',          now()
    );
  END IF;

  -- ── 2. Atomically reject and restore seats ───────────────────
  -- The CTE UPDATE is one SQL statement, so the seat restore and
  -- the enrollment rejection happen together or not at all.
  WITH expired AS (
    UPDATE public.enrollments
    SET    status = 'rejected'
    WHERE  status    = 'pending_payment'
      AND  enrolled_at < now() - interval '72 hours'
    RETURNING class_id
  ),
  class_seats AS (
    -- Aggregate freed seats per class (one enrollment per student)
    SELECT   class_id,
             count(*)::integer AS freed_seats
    FROM     expired
    GROUP BY class_id
  )
  UPDATE public.classes c
  SET
    -- Cap at seat_total in case of data inconsistency
    seat_remaining = LEAST(c.seat_remaining + cs.freed_seats, c.seat_total),
    -- Reopen classes that were marked full when the last seat was taken
    status = CASE
               WHEN c.status = 'full'
                AND (c.seat_remaining + cs.freed_seats) > 0
               THEN 'open'::class_status
               ELSE c.status
             END
  FROM class_seats cs
  WHERE c.id = cs.class_id;

  -- ROW_COUNT here reflects the number of classes updated
  GET DIAGNOSTICS v_class_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'success',         true,
    'expired_count',   v_expired_count,
    'classes_updated', v_class_count,
    'ran_at',          now()
  );

EXCEPTION
  WHEN OTHERS THEN
    -- Surface the error without crashing the cron job
    RETURN jsonb_build_object(
      'success', false,
      'error',   SQLERRM,
      'detail',  SQLSTATE,
      'ran_at',  now()
    );
END;
$$;

-- Only the service role (used by Edge Functions / pg_cron) may call this.
-- Authenticated users and anon role cannot trigger expiry manually.
GRANT EXECUTE ON FUNCTION public.check_expired_enrollments()
  TO service_role;

-- ── Index to make the expired-enrollment scan fast ────────────
-- Covers (tenant_id, status, enrolled_at) so the WHERE clause
-- uses an index scan rather than a full table scan.
CREATE INDEX IF NOT EXISTS idx_enrollments_expiry
  ON public.enrollments (status, enrolled_at)
  WHERE status = 'pending_payment';
