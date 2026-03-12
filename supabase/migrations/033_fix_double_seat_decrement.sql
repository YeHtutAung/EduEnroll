-- ─── Migration 033: Fix double seat decrement ────────────────────────────────
-- The submit_enrollment RPC already decrements seat_remaining on enrollment
-- creation. The trg_enrollments_seats trigger was ALSO decrementing when
-- enrollment status changed to 'confirmed' (after admin payment approval).
-- This caused seats to be counted twice.
--
-- Fix: remove the decrement from the trigger. Keep only the restore logic
-- for rejections (restore seat when enrollment moves away from an active state).

CREATE OR REPLACE FUNCTION public.update_seat_remaining()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Rejected after being active → restore the seat
  IF NEW.status = 'rejected' AND OLD.status IN ('pending_payment', 'payment_submitted', 'confirmed') THEN
    UPDATE public.classes
    SET seat_remaining = LEAST(seat_remaining + 1, seat_total)
    WHERE id = NEW.class_id;
  END IF;

  RETURN NEW;
END;
$$;
