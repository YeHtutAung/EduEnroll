-- ============================================================================
-- A failed payment must not reject an enrollment another payment paid for
--
-- fn_payments_sync_enrollment()'s rejection branch had no predicate: rejecting
-- ANY payment rejected the enrollment. So a stale Payment B failing after
-- Payment A had verified would reject a CONFIRMED enrollment, seat restoration
-- released the seat, and it was resold — while A's buyer held a valid ticket.
-- Reachable today from any payment rejection (admin, provider callback); not
-- specific to Stripe.
--
-- The fix is a predicate inside the trigger's own UPDATE, never an application
-- read-then-write:
--
--   1. Ownership: a payment failure may only reject a PRE-CONFIRMATION
--      enrollment. Cancelling a confirmed enrollment is a different operation
--      (tickets, capacity, refund) and must not be a side effect of a payment
--      status change. NOTE: this is a deliberate behaviour change — rejecting
--      a payment on a confirmed enrollment no longer rejects the enrollment.
--   2. Concurrency: no OTHER payment may be verified OR STILL ACTIVE. Under
--      READ COMMITTED a rejecting transaction sees a concurrently-verifying
--      payment at its committed pre-update state — awaiting_payment/pending —
--      so testing for 'verified' alone misses exactly the race that matters.
-- ============================================================================

BEGIN;

-- ── Baseline guard ───────────────────────────────────────────────────────────
-- This migration replaces an entire SECURITY DEFINER function, so it refuses
-- to run unless the installed function is byte-identical to the reviewed #187
-- baseline. ANY drift — even cosmetic — stops the deployment for a human.
--
-- The hash is md5(prosrc) captured from a fresh disposable local database
-- rebuilt through 20260721120000 (#187), BEFORE this file existed, so the
-- rebuild could not have included this migration. No normalisation: earlier
-- drafts tried substring checks (a drifted branch with a different predicate
-- passes) and normalised comparison (it broke on the baseline's own comments,
-- and lower()/whitespace-collapse can hide changes inside string literals).
--
-- If this raises on production: do NOT force it. Diff the installed prosrc
-- against 20260721120000 and decide deliberately. The guard stopping IS it
-- working.
DO $guard$
DECLARE
  fn_oid      oid;
  actual_hash text;
  n_overloads int;
BEGIN
  -- Exact resolution: schema-qualified, zero-argument. A same-named function
  -- in another schema cannot satisfy this.
  fn_oid := to_regprocedure('public.fn_payments_sync_enrollment()');
  IF fn_oid IS NULL THEN
    RAISE EXCEPTION 'baseline: public.fn_payments_sync_enrollment() does not exist';
  END IF;

  -- No overloads: a second signature means an ambiguous baseline.
  SELECT count(*) INTO n_overloads
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'fn_payments_sync_enrollment';
  IF n_overloads <> 1 THEN
    RAISE EXCEPTION 'baseline: expected exactly 1 overload of fn_payments_sync_enrollment, found %', n_overloads;
  END IF;

  -- Signature, return type, security mode, search_path.
  PERFORM 1
     FROM pg_proc p
    WHERE p.oid = fn_oid
      AND p.pronargs   = 0
      AND p.prorettype = 'pg_catalog.trigger'::regtype
      AND p.prosecdef  IS TRUE
      AND p.proconfig @> ARRAY['search_path=public'];
  IF NOT FOUND THEN
    RAISE EXCEPTION 'baseline: fn_payments_sync_enrollment has unexpected signature, return type, security mode or search_path';
  END IF;

  SELECT md5(p.prosrc) INTO actual_hash FROM pg_proc p WHERE p.oid = fn_oid;

  IF actual_hash <> '96fb0ce17455c36a2128e33585d994ea' THEN
    RAISE EXCEPTION 'baseline: fn_payments_sync_enrollment differs from the reviewed #187 baseline (got %); refusing to replace it', actual_hash;
  END IF;
END $guard$;

-- ── Replacement ──────────────────────────────────────────────────────────────
-- INSERT and confirm branches are VERBATIM from 20260721120000 (#187). Only
-- the rejection branch gains its predicate, so the two controls cannot
-- disagree about which enrollments are eligible.
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

  -- A payment failure may only reject a pre-confirmation enrollment, and only
  -- when no OTHER payment is verified or still active. 'verified' alone is not
  -- enough: under READ COMMITTED, a concurrently-verifying payment is visible
  -- at its pre-update state (awaiting_payment/pending), so those states are
  -- part of the guard. An operator who must cancel a CONFIRMED enrollment does
  -- so through a deliberate, audited operation — never as a side effect here.
  IF TG_OP = 'UPDATE' AND OLD.status != 'rejected' AND NEW.status = 'rejected' THEN
    UPDATE enrollments
      SET status = 'rejected'
      WHERE id = NEW.enrollment_id
        AND status IN ('pending_payment', 'payment_submitted', 'partial_payment')
        AND NOT EXISTS (
          SELECT 1 FROM payments p
           WHERE p.enrollment_id = NEW.enrollment_id
             AND p.id <> NEW.id
             AND p.status IN ('verified', 'awaiting_payment', 'pending')
        );
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
