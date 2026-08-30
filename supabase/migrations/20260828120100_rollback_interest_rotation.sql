-- ============================================================================
-- rollback_interest_rotation, and a null guard on rotate_interest_token
--
-- Two changes, both closing holes found reviewing the module that calls them.
--
-- 1. A rotation whose email never went out has to be UNDONE, not merely
--    un-cooled. Clearing last_link_attempt_at lets the caller retry at once —
--    the point — but it also disables the cooldown that is the stated
--    mitigation for a second rotation inside a grace window. Two failed sends
--    then walk the token forward twice:
--
--        start        token_hash = A, superseded = null
--        rotate 1     token_hash = B, superseded = A     send fails
--        rotate 2     token_hash = C, superseded = B     send fails
--
--    A is now in neither slot. The link already sitting in the recipient's
--    inbox is dead, and neither replacement was ever delivered. Because
--    sendEmail() returns false rather than throwing whenever the provider is
--    unreachable or RESEND_API_KEY is unset, a mail outage makes this the
--    NORMAL path, not a rare one. Dropping the clear instead would only make
--    the loss less frequent — the original still dies at the next rotation.
--
--    Same principle as persist-then-send: an operation that did not complete
--    leaves no durable effect.
--
-- 2. rotate_interest_token failed OPEN on a null cooldown. `v_last_attempt >
--    now() - NULL` is NULL, never true, so the guard never fired and every
--    call rotated. A null grace fails closed by contrast (the paired CHECK
--    rejects the write), which is why only one of the two was noticeable.
--    Both are now refused explicitly.
--
-- Companion to 20260828120000_rotate_interest_token.sql, which is applied and
-- is NOT edited here: an applied migration that changes silently does not
-- re-run, so environments that already have it would keep the open guard. The
-- hardened body is installed with CREATE OR REPLACE instead, which reaches
-- every environment regardless of what it has already applied. Same precedent
-- as 076_fix_stored_functions.sql and 20260827120100.
--
-- See docs/superpowers/specs/2026-08-26-event-interest-priority-window-design.md
-- (v11), section "Rotation is serialized before the send, not after".
-- ============================================================================

BEGIN;

-- ── 1. rotate_interest_token: refuse a null interval ────────────────────────
--
-- CREATE OR REPLACE, not DROP + CREATE: replacing preserves the function's
-- ownership and its ACL, so the service_role-only grant made by
-- 20260828120000 survives. The privilege block is re-asserted below rather
-- than relied upon, and the smoke call checks it.
--
-- Body is otherwise identical to 20260828120000; only the guard is new.

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
BEGIN
  -- Fail closed on a missing interval. A null cooldown would otherwise make
  -- the comparison below NULL for every row, so the cooldown would never fire
  -- and this function would rotate on every call — the opposite of what a
  -- caller passing a null by accident would expect.
  IF p_cooldown IS NULL OR p_grace IS NULL THEN
    RAISE EXCEPTION
      'rotate_interest_token: p_grace and p_cooldown must not be null';
  END IF;

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
  -- the send has not happened yet when this is read.
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

-- ── 2. rollback_interest_rotation ───────────────────────────────────────────
--
-- Returns true when it undid a rotation, false when it left the row alone.
--
-- p_expected_hash is a compare-and-swap, not decoration. Between the rotation
-- committing and the send failing, another request can rotate again; that
-- request's credential is live and may already have been emailed. Restoring
-- unconditionally would destroy it. Guarding on the hash THIS attempt wrote
-- means a caller that lost the race changes nothing and is told so.

CREATE FUNCTION public.rollback_interest_rotation(
  p_interest_id    uuid,
  p_expected_hash  text,
  p_restore_prefix text
) RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_current    text;
  v_superseded text;
BEGIN
  -- token_prefix is NOT NULL, so a null here would fail the UPDATE with a
  -- constraint error from inside a rollback path — the worst place to learn
  -- about it. Refused up front instead.
  IF p_restore_prefix IS NULL THEN
    RAISE EXCEPTION
      'rollback_interest_rotation: p_restore_prefix must not be null';
  END IF;

  SELECT token_hash, superseded_token_hash
    INTO v_current, v_superseded
    FROM public.event_interest
   WHERE id = p_interest_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Someone else has rotated since. Their token is current and may be in an
  -- inbox already; it is not ours to roll back.
  IF v_current IS DISTINCT FROM p_expected_hash THEN
    RETURN false;
  END IF;

  -- Nothing to restore to. Reachable if the grace slot was cleared between the
  -- rotation and this call — redemption clears it the first time the new token
  -- is used. Refuse rather than write a null into a NOT NULL column: the
  -- current token works, so the caller is no worse off.
  IF v_superseded IS NULL THEN
    RETURN false;
  END IF;

  -- token_prefix is restored alongside the hash, and it has to be PASSED IN.
  -- It cannot be derived here: the prefix is the first 8 characters of the raw
  -- token, and the raw token is unrecoverable from its hash. left(hash, 8)
  -- would write a plausible-looking string that matches nothing the recipient
  -- holds, which is worse than leaving the stale one. The schema keeps no
  -- superseded_token_prefix column, so the caller supplies the value it read
  -- from this row before rotating — and the compare-and-swap above is what
  -- makes that read still valid: if no one else has rotated, the prefix the
  -- caller saw belongs to exactly the hash being restored.
  UPDATE public.event_interest
     SET token_hash            = superseded_token_hash,
         token_prefix          = p_restore_prefix,
         superseded_token_hash = NULL,
         superseded_expires_at = NULL,
         last_link_attempt_at  = NULL
   WHERE id = p_interest_id;

  RETURN true;
END $$;

-- ── 3. Privileges ───────────────────────────────────────────────────────────
-- PostgreSQL grants EXECUTE to PUBLIC by default on every new function; this
-- repository has already been burned by that default once
-- (20260719100000_restrict_enrollment_rpc_privileges.sql). Rolling back a
-- rotation is a credential-restoring operation, so an anon caller reaching it
-- could revive a superseded link by id. service_role only, matching the two
-- functions the same module calls.
--
-- rotate_interest_token's grants are re-asserted rather than assumed to have
-- survived the CREATE OR REPLACE above.

REVOKE ALL ON FUNCTION public.rotate_interest_token(uuid, text, text, interval, interval)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_interest_token(uuid, text, text, interval, interval)
  TO service_role;

REVOKE ALL ON FUNCTION public.rollback_interest_rotation(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rollback_interest_rotation(uuid, text, text)
  TO service_role;

-- ── 4. Fail closed on the signatures ────────────────────────────────────────
-- Asserted, not assumed. The application calls both by name through PostgREST
-- with named arguments; a signature that does not match resolves to nothing
-- and surfaces as a runtime resend failure, not as a migration error.

DO $$
BEGIN
  IF to_regprocedure(
    'public.rollback_interest_rotation(uuid,text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'rollback_interest_rotation(uuid,text,text) is missing';
  END IF;

  IF to_regprocedure(
    'public.rotate_interest_token(uuid,text,text,interval,interval)'
  ) IS NULL THEN
    RAISE EXCEPTION 'rotate_interest_token(uuid,text,text,interval,interval) is missing';
  END IF;
END $$;

-- ── 5. Reload PostgREST schema cache ────────────────────────────────────────
-- A new RPC is invisible to PostgREST until the cache reloads; without this,
-- the first rollback after deployment gets a "function not found" error
-- against a correctly migrated database.

NOTIFY pgrst, 'reload schema';

COMMIT;
