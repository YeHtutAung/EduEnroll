-- ============================================================================
-- rotate_interest_token: the serialized half of an interest-link resend
--
-- A resend has to do four things as one indivisible decision — evaluate the
-- cooldown, mint into the current slot, move the old hash into the grace slot,
-- and stamp the attempt. The application cannot do this: a Supabase client
-- cannot hold a transaction open across statements, so a lock taken for the
-- write alone would not span the decision. Two concurrent resends would then
-- both read the old row, both decide to rotate, and both send — duplicate
-- mail, the cooldown bypassed, and the first freshly-emailed link demoted to
-- nothing but the superseded token of the second. The two-slot model holds
-- exactly one superseded credential, so the loser's grace period is simply
-- gone.
--
-- Everything below therefore happens under one SELECT ... FOR UPDATE, and the
-- caller sends mail only after this function has committed.
--
-- Contract: returns 'ROTATED' | 'COOLDOWN' | 'NOT_FOUND'. On 'COOLDOWN' and
-- 'NOT_FOUND' nothing is written.
--
-- Companion to 20260827120000_event_interest_priority_window.sql, which is
-- applied and unchanged. See
-- docs/superpowers/specs/2026-08-26-event-interest-priority-window-design.md
-- sections "Ordering: persist, then send" and "Rotation is serialized before
-- the send, not after".
-- ============================================================================

BEGIN;

-- No IF NOT EXISTS / CREATE OR REPLACE: an unexpected same-named function must
-- stop the deployment rather than be silently overwritten. Same precedent as
-- the companion migration.

CREATE FUNCTION public.rotate_interest_token(
  p_interest_id uuid,
  p_new_hash    text,
  p_new_prefix  text,
  p_grace       interval,
  p_cooldown    interval
) RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_last_attempt timestamptz;
BEGIN
  -- The lock is the whole point of this function existing. It is taken before
  -- the cooldown is read, and held to commit, so a second concurrent resend
  -- blocks here and then sees the attempt the first one stamped.
  SELECT last_link_attempt_at INTO v_last_attempt
    FROM public.event_interest
   WHERE id = p_interest_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'NOT_FOUND';
  END IF;

  -- Evaluated against the *attempt*, not the successful send. That is what
  -- makes a concurrent second request back off instead of sending a duplicate:
  -- the send has not happened yet when this is read. The caller clears
  -- last_link_attempt_at when the send fails, so a retry is immediate.
  IF v_last_attempt IS NOT NULL AND v_last_attempt > now() - p_cooldown THEN
    RETURN 'COOLDOWN';
  END IF;

  -- One statement, so token_hash on the right-hand side is the pre-update
  -- value: the outgoing credential moves into the grace slot as the new one
  -- takes its place. The paired CHECK on (superseded_token_hash,
  -- superseded_expires_at) is satisfied because both are set together.
  --
  -- A prior superseded hash still inside its grace window is overwritten here.
  -- That is the stated guarantee, not an oversight: only the token immediately
  -- prior to the most recent rotation survives, never every token ever issued.
  UPDATE public.event_interest
     SET superseded_token_hash = token_hash,
         superseded_expires_at = now() + p_grace,
         token_hash            = p_new_hash,
         token_prefix          = p_new_prefix,
         last_link_attempt_at  = now()
   WHERE id = p_interest_id;

  RETURN 'ROTATED';
END $$;

-- ── Privileges ──────────────────────────────────────────────────────────────
-- PostgreSQL grants EXECUTE to PUBLIC by default on every new function; this
-- repository has already been burned by that default once
-- (20260719100000_restrict_enrollment_rpc_privileges.sql). Rotation is a
-- credential-issuing operation, so an anon caller reaching it would be able to
-- invalidate anyone's live link by id. service_role only, matching
-- consume_interest_signup_slot, which the same module calls.

REVOKE ALL ON FUNCTION public.rotate_interest_token(uuid, text, text, interval, interval)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_interest_token(uuid, text, text, interval, interval)
  TO service_role;

-- ── Fail closed on the signature ────────────────────────────────────────────
-- Asserted, not assumed. The application calls this by name through PostgREST
-- with five named arguments; a signature that does not match resolves to
-- nothing and surfaces as a runtime resend failure, not as a migration error.

DO $$
BEGIN
  IF to_regprocedure(
    'public.rotate_interest_token(uuid,text,text,interval,interval)'
  ) IS NULL THEN
    RAISE EXCEPTION 'rotate_interest_token(uuid,text,text,interval,interval) is missing';
  END IF;
END $$;

-- ── Reload PostgREST schema cache ───────────────────────────────────────────
-- A new RPC is invisible to PostgREST until the cache reloads; without this,
-- the first resend after deployment gets a "function not found" error against
-- a correctly migrated database.

NOTIFY pgrst, 'reload schema';

COMMIT;
