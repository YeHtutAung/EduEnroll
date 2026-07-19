-- ============================================================================
-- Seat restoration: one owner per event
--
-- Five separate writers restored seats, disagreeing about who owns the write.
-- Measured against this schema before the fix:
--
--   expiry, single-class qty 1   7 -> 9   (2x: trigger + direct increment)
--   expiry, single-class qty 3   7 -> 11  (trigger +3, direct +1)
--   manual payment rejection     7 -> 11  (2x: trigger + application code)
--   delete an ACTIVE cart        7 -> 7   (nothing restored — capacity lost)
--   delete a REJECTED single     7 -> 9   (phantom seats from nothing)
--
-- The rule this migration establishes:
--
--   Seat restoration is owned by database triggers. Nothing else restores.
--
-- "Seat-holding" means the enrollment currently occupies seats:
--   pending_payment, payment_submitted, confirmed, partial_payment
-- rejected / cancelled / expired do not. This is already the guard
-- update_seat_remaining() uses; the other writers now agree with it.
--
-- update_seat_remaining() is deliberately untouched — it was the only correct
-- writer and is the reference behaviour.
-- ============================================================================

-- ── 1. Delete-restore: move to BEFORE DELETE, and only if seats were held ───
--
-- Two defects in one function.
--
-- (a) Cart-blind. The old comment claimed enrollment_items are CASCADE-deleted
--     *after* the trigger, so they are still readable. Measured, that is false:
--
--       AFTER  DELETE sees 0 enrollment_items
--       BEFORE DELETE sees 1
--
--     The cascade wins, so cart deletions restored nothing at all and capacity
--     was permanently lost. Timing cannot be altered in place, hence the drop
--     and recreate below.
--
-- (b) No status guard. Deleting an already-rejected enrollment — whose seats
--     were returned when it was rejected — returned them a second time,
--     creating seats from nothing.

CREATE OR REPLACE FUNCTION public.restore_seat_on_enrollment_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_item RECORD;
BEGIN
  -- Only an enrollment that still holds seats has anything to give back.
  IF OLD.status NOT IN ('pending_payment', 'payment_submitted', 'confirmed', 'partial_payment') THEN
    RETURN OLD;
  END IF;

  IF OLD.class_id IS NOT NULL THEN
    UPDATE public.classes
    SET seat_remaining = LEAST(seat_remaining + COALESCE(OLD.quantity, 1), seat_total)
    WHERE id = OLD.class_id;
  ELSE
    -- Readable only because this now runs BEFORE the cascade.
    FOR v_item IN
      SELECT class_id, quantity
      FROM   public.enrollment_items
      WHERE  enrollment_id = OLD.id
    LOOP
      UPDATE public.classes
      SET seat_remaining = LEAST(seat_remaining + v_item.quantity, seat_total)
      WHERE id = v_item.class_id;
    END LOOP;
  END IF;

  RETURN OLD;
END;
$$;

-- Reopening a full class is owned by trg_auto_reopen_class (063), which fires
-- on the classes UPDATE above. This function no longer sets status itself.
DROP TRIGGER IF EXISTS trg_restore_seat_on_enrollment_delete ON public.enrollments;

CREATE TRIGGER trg_restore_seat_on_enrollment_delete
  BEFORE DELETE ON public.enrollments
  FOR EACH ROW
  EXECUTE FUNCTION public.restore_seat_on_enrollment_delete();


-- ── 2. Expiry sweep: stop restoring directly ────────────────────────────────
--
-- The sweep set enrollments to 'rejected' — which fires update_seat_remaining()
-- — and then incremented seat_remaining itself, restoring twice.
--
-- Its own increment was also wrong twice over:
--   * count(*) counts ENROLLMENTS, not seats, so quantity 3 restored 1
--   * WHERE class_id IS NOT NULL excluded carts entirely
--
-- Removing it fixes all three: the trigger is already quantity-aware and
-- cart-aware.
--
-- classes_updated is preserved and made cart-aware. Carts have class_id NULL,
-- so counting the UPDATE's row count reported 0 for a cart-only expiry. It is
-- now the distinct union of direct classes and cart-item classes, which
-- requires returning both id and class_id from the CTE.

CREATE OR REPLACE FUNCTION public.check_expired_enrollments()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
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

  -- ── 2. Reject. The status trigger restores the seats. ────────
  WITH expired AS (
    UPDATE public.enrollments e
    SET    status = 'rejected'
    FROM   public.tenants t
    WHERE  t.id = e.tenant_id
      AND  e.status = 'pending_payment'
      AND  t.auto_cancel_hours > 0
      AND  e.enrolled_at < now() - (t.auto_cancel_hours * interval '1 minute')
    RETURNING e.id, e.class_id
  )
  SELECT count(DISTINCT class_id)::integer INTO v_class_count
  FROM (
    SELECT class_id FROM expired WHERE class_id IS NOT NULL
    UNION
    SELECT ei.class_id
    FROM   public.enrollment_items ei
    JOIN   expired x ON x.id = ei.enrollment_id
  ) u;

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


-- ── 3. Execute privileges on the expiry sweep ───────────────────────────────
--
-- A security correction, not a redundant grant.
--
-- Migration 011 granted EXECUTE to service_role and commented "Authenticated
-- users and anon role cannot trigger expiry manually." The code never
-- implemented that: PostgreSQL grants EXECUTE to PUBLIC by default and no
-- migration ever revoked it. The function is SECURITY DEFINER, so it runs with
-- the owner's privileges and bypasses RLS — any anonymous caller could sweep
-- every tenant's enrollments. Confirmed reachable by both anon and
-- authenticated before this change.
--
-- CREATE OR REPLACE preserves privileges, so preserving them preserves the
-- hole. Safe to revoke: the scheduled job (expire-pending-enrollments) runs as
-- postgres, the function owner, which is unaffected.

REVOKE ALL ON FUNCTION public.check_expired_enrollments() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_expired_enrollments() FROM anon;
REVOKE ALL ON FUNCTION public.check_expired_enrollments() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_expired_enrollments() TO service_role;
