-- ============================================================================
-- rotate_interest_token re-checks revocation under the row lock
--
-- The caller checked `revoked_at` before calling. That is a STALE READ, and
-- the window it leaves open is real: an admin can revoke between the caller's
-- SELECT and the rotation, and neither 20260828120000 nor 20260828120100
-- referenced `revoked_at` at all. The rotation would proceed, a fresh
-- credential would be minted and emailed, and the gate
-- (priority_access_granted, which DOES test revoked_at) would then refuse it —
-- so the recipient is urged to use a link that silently does not work, and the
-- revocation the admin performed appears not to have taken.
--
-- The check has to sit under the same lock that does the writing. It is added
-- here, immediately after the SELECT ... FOR UPDATE and before the cooldown is
-- evaluated, and reports 'NOT_FOUND' — the existing contract value for "there
-- is no rotatable row here", which every caller already handles as a
-- no-write, no-send outcome. No new return value, so no caller has to change
-- to be correct.
--
-- Callers should keep their own pre-check: it is a cheap early skip that
-- avoids a pointless round trip. It is simply no longer the guarantee.
--
-- CREATE OR REPLACE in a NEW migration, not an edit to 20260828120000 or
-- 20260828120100. Both are applied, and an applied migration that changes
-- silently does not re-run — environments that already have them would keep
-- the unchecked body for ever. Replacing also preserves the function's
-- ownership and ACL, so the service_role-only grant survives; it is
-- re-asserted below rather than assumed. Same precedent as
-- 20260828120100_rollback_interest_rotation.sql and 076_fix_stored_functions.sql.
--
-- The signature is unchanged (uuid, text, text, interval, interval), so
-- PostgREST callers are unaffected.
--
-- See docs/superpowers/specs/2026-08-26-event-interest-priority-window-design.md
-- (v13), section "Rotation is serialized before the send, not after".
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.rotate_interest_token(
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
  v_revoked_at   timestamptz;
BEGIN
  -- Fail closed on a missing interval. A null cooldown would otherwise make
  -- the comparison below NULL for every row, so the cooldown would never fire
  -- and this function would rotate on every call — the opposite of what a
  -- caller passing a null by accident would expect. Carried forward unchanged
  -- from 20260828120100.
  IF p_cooldown IS NULL OR p_grace IS NULL THEN
    RAISE EXCEPTION
      'rotate_interest_token: p_grace and p_cooldown must not be null';
  END IF;

  -- The lock is the whole point of this function existing. It is taken before
  -- revocation and the cooldown are read, and held to commit, so a second
  -- concurrent resend blocks here and then sees what the first one did.
  --
  -- revoked_at is now read under that same lock. A revoke committed before
  -- this SELECT is therefore visible to it, and a revoke attempted after it
  -- waits behind this transaction — so there is no interleaving in which a
  -- revoked row is rotated.
  SELECT last_link_attempt_at, revoked_at
    INTO v_last_attempt, v_revoked_at
    FROM public.event_interest
   WHERE id = p_interest_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'NOT_FOUND';
  END IF;

  -- Revoked. Deliberately reported as 'NOT_FOUND' rather than a new value:
  -- for a rotation there is no meaningful difference between "the row is gone"
  -- and "the row may not be rotated", every existing caller already treats
  -- NOT_FOUND as write-nothing-send-nothing, and adding a fourth return value
  -- would silently fall through the `!== 'ROTATED'` branches callers use today.
  IF v_revoked_at IS NOT NULL THEN
    RETURN 'NOT_FOUND';
  END IF;

  -- Evaluated against the *attempt*, not the successful send. That is what
  -- makes a concurrent second request back off instead of sending a duplicate.
  IF v_last_attempt IS NOT NULL AND v_last_attempt > now() - p_cooldown THEN
    RETURN 'COOLDOWN';
  END IF;

  -- One statement, so token_hash on the right-hand side is the pre-update
  -- value: the outgoing credential moves into the grace slot as the new one
  -- takes its place.
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
-- Re-asserted rather than assumed to have survived the CREATE OR REPLACE.
-- PostgreSQL grants EXECUTE to PUBLIC by default on every new function and
-- this repository has already been burned by that default once
-- (20260719100000_restrict_enrollment_rpc_privileges.sql). Rotation is a
-- credential-issuing operation, so an anon caller reaching it could invalidate
-- anyone's live link by id.

REVOKE ALL ON FUNCTION public.rotate_interest_token(uuid, text, text, interval, interval)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_interest_token(uuid, text, text, interval, interval)
  TO service_role;

-- ── Fail closed on the signature and on the new behaviour ───────────────────
--
-- The signature check is the same assertion the two prior migrations make: the
-- application calls this by name through PostgREST with five named arguments,
-- and a signature that does not match resolves to nothing and surfaces as a
-- runtime resend failure rather than as a migration error.
--
-- The body check is here because CREATE OR REPLACE is silent about WHICH body
-- it installed. A migration that applies cleanly while leaving the old body in
-- place is exactly the failure this file exists to prevent, and it would be
-- invisible until a revoked row was rotated in production.
--
-- Asserted against prosrc rather than by calling the function: exercising the
-- new rule for real needs a tenant, an intake and a revoked interest row, and
-- a migration that writes fixture tenants into a live database — even inside a
-- transaction, even cleaned up — is not a trade worth making for a check that
-- the behavioural test in src/__tests__/db/rotate-revocation.db.test.ts covers
-- properly against a real row.
--
-- CRLF-tolerant: `db push` sends LF and a paste into the SQL editor sends
-- CRLF, so a literal match on a multi-line fragment is compared against text
-- with the carriage returns stripped. Same treatment as this repository's
-- other prosrc guards.

DO $$
DECLARE v_src text;
BEGIN
  IF to_regprocedure(
    'public.rotate_interest_token(uuid,text,text,interval,interval)'
  ) IS NULL THEN
    RAISE EXCEPTION 'rotate_interest_token(uuid,text,text,interval,interval) is missing';
  END IF;

  SELECT replace(prosrc, chr(13), '') INTO v_src
    FROM pg_proc
   WHERE oid = 'public.rotate_interest_token(uuid,text,text,interval,interval)'::regprocedure;

  IF v_src NOT LIKE '%v_revoked_at IS NOT NULL%' THEN
    RAISE EXCEPTION
      'rotate_interest_token is missing the revocation re-check: the replaced body did not install';
  END IF;

  -- The re-check is worthless if it is not read under the lock, so assert the
  -- column is in the locking SELECT rather than merely mentioned somewhere.
  IF v_src NOT LIKE '%INTO v_last_attempt, v_revoked_at%' THEN
    RAISE EXCEPTION
      'rotate_interest_token does not read revoked_at under the FOR UPDATE lock';
  END IF;
END $$;

-- ── Reload PostgREST schema cache ───────────────────────────────────────────
-- The signature is unchanged, so PostgREST would keep routing calls either
-- way; the reload is here for consistency with the two migrations this one
-- replaces the body of, and costs nothing.

NOTIFY pgrst, 'reload schema';

COMMIT;
