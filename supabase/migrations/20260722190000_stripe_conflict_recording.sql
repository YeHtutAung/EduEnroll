-- ============================================================================
-- Conflict-recording functions (Plan v18 §1a's two upsert shapes + the
-- conditional pending→done transition)
--
-- The plan mandates "a single atomic upsert — never select-then-write", and
-- the upserts need `occurrence_count + 1` and the atomic resolved→reopen
-- transition — neither expressible through PostgREST. These functions wrap
-- the plan's reviewed statements verbatim; the application calls them via
-- rpc() and never touches the table directly for recording.
--
--   record_stripe_conflict          — shape (i): generic sighting. Touches NO
--                                     cleanup or resolution field.
--   record_stripe_cleanup_conflict  — shape (ii): an unowned payable object
--                                     exists NOW; atomically (re)opens with
--                                     cleanup_status='pending'.
--   complete_stripe_cleanup         — conditional pending→done; returns
--                                     whether THIS call won the transition.
-- ============================================================================

BEGIN;

-- Refuse to run out of order: plpgsql bodies bind late, so without this a
-- missing conflicts table would surface at first call, in production, at
-- settlement time — not at deployment.
DO $guard$
BEGIN
  IF to_regclass('public.payment_settlement_conflicts') IS NULL THEN
    RAISE EXCEPTION 'payment_settlement_conflicts does not exist; run 20260722180000 first';
  END IF;
END $guard$;

-- ── Shape (i): generic sighting ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_stripe_conflict(
  p_object_id             text,
  p_conflict_type         text,
  p_source_type           text,
  p_source_id             text,
  p_payment_id            uuid,
  p_enrollment_id         uuid,
  p_expected_amount_minor bigint,
  p_actual_amount_minor   bigint,
  p_expected_currency     text,
  p_actual_currency       text
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.payment_settlement_conflicts
    (provider, provider_object_id, conflict_type,
     first_source_type, first_source_id, last_source_type, last_source_id,
     payment_id, enrollment_id,
     expected_amount_minor, actual_amount_minor,
     expected_currency, actual_currency)
  VALUES
    ('stripe', p_object_id, p_conflict_type,
     p_source_type, p_source_id, p_source_type, p_source_id,
     p_payment_id, p_enrollment_id,
     p_expected_amount_minor, p_actual_amount_minor,
     p_expected_currency, p_actual_currency)
  ON CONFLICT (provider, provider_object_id, conflict_type) DO UPDATE
     SET last_source_type    = excluded.last_source_type,
         last_source_id      = excluded.last_source_id,
         actual_amount_minor = excluded.actual_amount_minor,
         actual_currency     = excluded.actual_currency,
         occurrence_count    = payment_settlement_conflicts.occurrence_count + 1;
$$;

-- ── Shape (ii): cleanup-requiring sighting ───────────────────────────────────
-- Whatever the row said before ('none', 'done', even 'resolved') is superseded
-- in ONE atomic statement — a two-step "set pending, then reopen" would
-- violate pscf_cleanup_resolved_chk in between. resolution_note is PRESERVED:
-- it documents the prior resolution; status='open' signals the reopen.
CREATE OR REPLACE FUNCTION public.record_stripe_cleanup_conflict(
  p_object_id             text,
  p_conflict_type         text,
  p_source_type           text,
  p_source_id             text,
  p_payment_id            uuid,
  p_enrollment_id         uuid,
  p_expected_amount_minor bigint,
  p_actual_amount_minor   bigint,
  p_expected_currency     text,
  p_actual_currency       text
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.payment_settlement_conflicts
    (provider, provider_object_id, conflict_type,
     first_source_type, first_source_id, last_source_type, last_source_id,
     payment_id, enrollment_id,
     expected_amount_minor, actual_amount_minor,
     expected_currency, actual_currency, cleanup_status)
  VALUES
    ('stripe', p_object_id, p_conflict_type,
     p_source_type, p_source_id, p_source_type, p_source_id,
     p_payment_id, p_enrollment_id,
     p_expected_amount_minor, p_actual_amount_minor,
     p_expected_currency, p_actual_currency, 'pending')
  ON CONFLICT (provider, provider_object_id, conflict_type) DO UPDATE
     SET last_source_type    = excluded.last_source_type,
         last_source_id      = excluded.last_source_id,
         actual_amount_minor = excluded.actual_amount_minor,
         actual_currency     = excluded.actual_currency,
         occurrence_count    = payment_settlement_conflicts.occurrence_count + 1,
         cleanup_status      = 'pending',
         status              = 'open',
         resolved_at         = null;
$$;

-- ── Conditional pending→done ─────────────────────────────────────────────────
-- Returns true iff THIS call performed the transition. Zero rows means
-- another worker already moved it (or a new sighting re-pended it) — the
-- caller re-reads, never assumes.
CREATE OR REPLACE FUNCTION public.complete_stripe_cleanup(
  p_object_id     text,
  p_conflict_type text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.payment_settlement_conflicts
     SET cleanup_status = 'done'
   WHERE provider = 'stripe'
     AND provider_object_id = p_object_id
     AND conflict_type = p_conflict_type
     AND cleanup_status = 'pending';
  RETURN FOUND;
END $$;

-- ── Least privilege: service_role only, same as the finalizer ────────────────
REVOKE ALL ON FUNCTION public.record_stripe_conflict(text,text,text,text,uuid,uuid,bigint,bigint,text,text)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_stripe_conflict(text,text,text,text,uuid,uuid,bigint,bigint,text,text)
  TO service_role;

REVOKE ALL ON FUNCTION public.record_stripe_cleanup_conflict(text,text,text,text,uuid,uuid,bigint,bigint,text,text)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_stripe_cleanup_conflict(text,text,text,text,uuid,uuid,bigint,bigint,text,text)
  TO service_role;

REVOKE ALL ON FUNCTION public.complete_stripe_cleanup(text,text)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_stripe_cleanup(text,text)
  TO service_role;

COMMIT;
