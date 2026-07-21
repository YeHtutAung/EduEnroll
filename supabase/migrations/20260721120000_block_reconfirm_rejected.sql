-- ============================================================================
-- Oversell guard: a late payment must not re-admit a rejected enrollment
--
-- An enrollment expires (auto-cancel) → 'rejected', and update_seat_remaining()
-- restores its seat, which is then resold. If that enrollment's payment settles
-- late — a slow bank, a delayed webhook — the enrollment was silently
-- re-confirmed and a second customer held the same seat.
--
-- Two writers caused it and both are closed here:
--
--   1. fn_payments_sync_enrollment() confirmed on payment verification with no
--      predicate on the enrollment's own state.
--   2. Ten application routes set status = 'confirmed' directly, so guarding
--      only the trigger would have left every one of them able to re-confirm.
--
-- The BEFORE UPDATE guard below covers both, because every writer reaches
-- 'confirmed' through an UPDATE on enrollments.status.
-- ============================================================================

BEGIN;

-- ── 1. Rejection is terminal ────────────────────────────────────────────────
-- Blocks EVERY automatic transition out of 'rejected', not just
-- rejected → confirmed. Blocking only the direct hop is launderable:
-- verifyPayment()'s request_remaining sets 'partial_payment' with no state
-- guard, so rejected → partial_payment → confirmed walks around a narrower
-- rule — the second hop's OLD.status is 'partial_payment', not 'rejected'.
--
-- Keeps the row rejected rather than RAISE: the payment may already be
-- verified, so raising would error a customer after money moved. Because the
-- status does not actually change, the AFTER seat trigger never fires and the
-- resold seat is left alone. The result — a verified payment against a rejected
-- enrollment — is a refund case, detectable by query, and strictly better than
-- a silent double booking.
--
-- Reinstating a rejected enrollment, if ever needed, must be a separate audited
-- operation that re-checks capacity — never a bare status update.
CREATE OR REPLACE FUNCTION public.fn_block_reconfirm_rejected()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'rejected' AND NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status := OLD.status;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_reconfirm_rejected ON public.enrollments;

CREATE TRIGGER trg_block_reconfirm_rejected
  BEFORE UPDATE OF status ON public.enrollments
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_block_reconfirm_rejected();

-- ── 2. Defense in depth: the payment trigger agrees ─────────────────────────
-- Recreated verbatim from 049 apart from the confirm branch's new predicate,
-- so the two controls cannot disagree about which enrollments are eligible.
-- The INSERT and rejection branches are unchanged.
CREATE OR REPLACE FUNCTION public.fn_payments_sync_enrollment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
    UPDATE enrollments
      SET status = 'payment_submitted'
      WHERE id = NEW.enrollment_id
        AND status IN ('pending_payment', 'partial_payment');
  END IF;

  -- Only a seat-holding enrollment may be confirmed by a verifying payment.
  IF TG_OP = 'UPDATE' AND OLD.status != 'verified' AND NEW.status = 'verified' THEN
    UPDATE enrollments
      SET status = 'confirmed'
      WHERE id = NEW.enrollment_id
        AND status IN ('pending_payment', 'payment_submitted', 'partial_payment');
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status != 'rejected' AND NEW.status = 'rejected' THEN
    UPDATE enrollments
      SET status = 'rejected'
      WHERE id = NEW.enrollment_id;
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
