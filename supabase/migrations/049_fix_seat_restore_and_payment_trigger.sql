-- ─── 049: Fix 3 critical bugs ────────────────────────────────────────────────
-- Bug 1: restore_seat_on_enrollment_delete() ignores cart enrollments (class_id=NULL)
-- Bug 2: restore_seat_on_enrollment_delete() always restores 1 seat, ignoring quantity
-- Bug 3: trg_payments_sync_enrollment still calls old sync_enrollment_on_payment()
--         instead of fn_payments_sync_enrollment() from migration 041

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Fix 1 & 2: Rewrite restore_seat_on_enrollment_delete()
-- - For single-class enrollments (class_id IS NOT NULL): restore by quantity
-- - For cart enrollments (class_id IS NULL): restore from enrollment_items
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.restore_seat_on_enrollment_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item RECORD;
BEGIN
  IF OLD.class_id IS NOT NULL THEN
    -- Single-class enrollment: restore by quantity
    UPDATE public.classes
    SET seat_remaining = LEAST(seat_remaining + COALESCE(OLD.quantity, 1), seat_total),
        status = CASE
          WHEN status = 'full' THEN 'open'::class_status
          ELSE status
        END
    WHERE id = OLD.class_id;
  ELSE
    -- Cart enrollment: restore seats from each enrollment_item
    -- (enrollment_items are CASCADE-deleted AFTER this trigger, so they still exist here)
    FOR v_item IN
      SELECT class_id, quantity
      FROM public.enrollment_items
      WHERE enrollment_id = OLD.id
    LOOP
      UPDATE public.classes
      SET seat_remaining = LEAST(seat_remaining + v_item.quantity, seat_total),
          status = CASE
            WHEN status = 'full' THEN 'open'::class_status
            ELSE status
          END
      WHERE id = v_item.class_id;
    END LOOP;
  END IF;

  RETURN OLD;
END;
$$;

-- Also fix update_seat_remaining() for cart enrollments (status change to 'rejected')
CREATE OR REPLACE FUNCTION public.update_seat_remaining()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item RECORD;
BEGIN
  -- Rejected after being active → restore seats
  IF NEW.status = 'rejected' AND OLD.status IN ('pending_payment', 'payment_submitted', 'confirmed', 'partial_payment') THEN
    IF NEW.class_id IS NOT NULL THEN
      -- Single-class enrollment
      UPDATE public.classes
      SET seat_remaining = LEAST(seat_remaining + COALESCE(NEW.quantity, 1), seat_total)
      WHERE id = NEW.class_id;
    ELSE
      -- Cart enrollment: restore from enrollment_items
      FOR v_item IN
        SELECT class_id, quantity
        FROM public.enrollment_items
        WHERE enrollment_id = NEW.id
      LOOP
        UPDATE public.classes
        SET seat_remaining = LEAST(seat_remaining + v_item.quantity, seat_total)
        WHERE id = v_item.class_id;
      END LOOP;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Fix 3: Recreate payment sync trigger with updated function
-- Migration 041 created fn_payments_sync_enrollment() but never updated the trigger,
-- AND the function may not exist in production. Re-create both function and trigger.
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_payments_sync_enrollment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- When a payment is inserted with status='pending',
  -- advance enrollment to 'payment_submitted'
  IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
    UPDATE enrollments
      SET status = 'payment_submitted'
      WHERE id = NEW.enrollment_id
        AND status IN ('pending_payment', 'partial_payment');
  END IF;

  -- When payment status changes to 'verified', confirm enrollment
  IF TG_OP = 'UPDATE' AND OLD.status != 'verified' AND NEW.status = 'verified' THEN
    UPDATE enrollments
      SET status = 'confirmed'
      WHERE id = NEW.enrollment_id;
  END IF;

  -- When payment status changes to 'rejected', reject enrollment
  IF TG_OP = 'UPDATE' AND OLD.status != 'rejected' AND NEW.status = 'rejected' THEN
    UPDATE enrollments
      SET status = 'rejected'
      WHERE id = NEW.enrollment_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payments_sync_enrollment ON public.payments;

CREATE TRIGGER trg_payments_sync_enrollment
  AFTER INSERT OR UPDATE OF status ON public.payments
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_payments_sync_enrollment();

COMMIT;
