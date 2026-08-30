-- ============================================================================
-- The interest signup cutoff is enforced by the database, not by the route
--
-- Signup closes the moment the priority window opens. Otherwise anyone could
-- mint themselves a token at that instant and the head start would be
-- available to the general public, which is the whole feature.
--
-- Until now that rule lived only in src/app/api/public/interest/route.ts,
-- which reads the intake, compares now() against priority_open_at, and then
-- awaits a rate-limiter RPC and a lookup before it inserts. Those awaits are
-- not free, and the cutoff is a moment in time: a request admitted just before
-- the window can create its row after it. Nothing in the database said no.
--
-- A BEFORE INSERT trigger on event_interest re-reads the intake and raises
-- once the window has opened. The check and the write become one operation,
-- and the rule now holds for every writer rather than for one route.
--
-- INSERT ONLY. Rotation is an UPDATE, and someone already on the list must
-- still be able to recover a lost link during the window — they are not
-- signing up, they are re-reading something they were already owed. A trigger
-- that also fired on UPDATE would break resend precisely when it matters most.
-- The tgtype assertion at the bottom of this file pins that down structurally,
-- because "BEFORE INSERT" is one word away from "BEFORE INSERT OR UPDATE" and
-- nothing else in the schema would notice the difference.
--
-- The route keeps its own check. It turns the ordinary case into a clean 409
-- instead of an opaque write failure; the trigger is the guarantee, not the
-- user experience.
--
-- New migration, not an edit to 20260827120000_event_interest_priority_window.sql:
-- that file is applied, and an applied migration that changes silently does
-- not re-run.
--
-- See docs/superpowers/specs/2026-08-26-event-interest-priority-window-design.md
-- (v14), section "Eligibility is validated server-side before anything is
-- written".
-- ============================================================================

BEGIN;

CREATE FUNCTION public.trg_event_interest_signup_cutoff()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v_priority timestamptz;
BEGIN
  -- A plain read, deliberately NOT SELECT ... FOR UPDATE. This trigger only
  -- has to observe the window; it does not maintain a cross-table invariant
  -- the way assert_priority_window_valid() does, so it needs no serialisation
  -- of its own. Locking the intake row on every signup would also funnel every
  -- concurrent signup for one event through a single row lock, which is the
  -- one moment this feature is guaranteed to see a burst. Under READ COMMITTED
  -- the read still sees the latest committed priority_open_at, so an admin who
  -- moves the window earlier is respected by the very next insert.
  SELECT priority_open_at INTO v_priority
    FROM public.intakes
   WHERE id = NEW.intake_id;

  -- Fail closed. The composite FK on event_interest makes a missing intake
  -- unreachable in practice — but FK checks run as internal AFTER triggers,
  -- so at this point in the statement it has not been enforced yet, and a
  -- trigger that silently admitted a row whose intake it could not read would
  -- be the wrong kind of surprise to discover later.
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'event interest signup refused: intake % does not exist', NEW.intake_id;
  END IF;

  -- A null priority_open_at means no window is scheduled, and the insert is
  -- refused.
  --
  -- The reasoning is not "the route already rejects it" — it does (409
  -- PRIORITY_WINDOW_UNSET), which is why this branch is defence in depth and
  -- changes no behaviour on the route path. It is that the row would be inert
  -- and actively harmful. Its only purpose is to hold a credential, and the
  -- gate (priority_access_granted) requires priority_open_at IS NOT NULL
  -- before it will honour one, so a row created here can never grant
  -- anything. Worse, it takes the (intake_id, email) unique slot: if a window
  -- is scheduled later, that person's real signup collides with the stale row
  -- and takes the repeat path, which never returns a token — so they would be
  -- locked out of the head start by a row they cannot see. Refusing is the
  -- conservative direction, and the permissive one is only ever recoverable
  -- by hand.
  IF v_priority IS NULL THEN
    RAISE EXCEPTION
      'event interest signup refused: intake % has no priority window', NEW.intake_id;
  END IF;

  -- clock_timestamp(), NOT now(). now() is the transaction's start time, so a
  -- writer that opens a transaction before the window and inserts after it
  -- would still be admitted — which is the exact shape of the gap this
  -- trigger exists to close, moved one layer down. clock_timestamp() is read
  -- at the instant of the write, so the check and the write really are one
  -- operation. It is not immutable and not snapshot-stable, and neither
  -- matters here: it is evaluated once, per row, in a BEFORE trigger.
  --
  -- priority_access_granted() still uses now(), correctly: it is a STABLE
  -- read gate that must give one answer for the whole enrollment transaction.
  -- Opposite requirement, opposite function.
  IF clock_timestamp() >= v_priority THEN
    RAISE EXCEPTION
      'event interest signup refused: the priority window for intake % has already opened',
      NEW.intake_id;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_event_interest_signup_cutoff
  BEFORE INSERT ON public.event_interest
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_event_interest_signup_cutoff();

-- ── Privileges ──────────────────────────────────────────────────────────────
--
-- PostgreSQL grants EXECUTE to PUBLIC by default on every new function, and
-- this repository has been burned by that default once already
-- (20260719100000_restrict_enrollment_rpc_privileges.sql). PostgreSQL refuses
-- to invoke a trigger-returning function directly through SELECT/PERFORM, so
-- the default grant is not a reachable hole here — the revoke is for the same
-- reason 20260827120000 revokes its two trigger wrappers: a reader scanning
-- the privilege block should not have to work out why one function is missing
-- from it. No grant back: the trigger mechanism invokes this as the table's
-- owner and needs none.

REVOKE ALL ON FUNCTION public.trg_event_interest_signup_cutoff()
  FROM PUBLIC, anon, authenticated, service_role;

-- ── Fail closed on the object and on its firing conditions ──────────────────
--
-- Asserted structurally, from the catalog, rather than by attempting a real
-- signup: exercising the rule needs a tenant and an intake, and a migration
-- that writes fixture rows into a live database — even inside a transaction,
-- even cleaned up — is not a trade worth making. Behaviour is covered against
-- real rows in src/__tests__/db/interest-signup-cutoff.db.test.ts. Same
-- separation as 20260829120000_rotate_checks_revocation.sql.
--
-- pg_trigger.tgtype is a bitmask: 1 = ROW, 2 = BEFORE, 4 = INSERT, 8 = DELETE,
-- 16 = UPDATE, 32 = TRUNCATE, 64 = INSTEAD OF.

DO $$
DECLARE v_tgtype smallint;
BEGIN
  IF to_regprocedure('public.trg_event_interest_signup_cutoff()') IS NULL THEN
    RAISE EXCEPTION 'trg_event_interest_signup_cutoff() is missing';
  END IF;

  SELECT tgtype INTO v_tgtype
    FROM pg_trigger
   WHERE tgrelid = 'public.event_interest'::regclass
     AND tgname  = 'trg_event_interest_signup_cutoff'
     AND NOT tgisinternal;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'trigger trg_event_interest_signup_cutoff is missing from public.event_interest';
  END IF;

  IF (v_tgtype & 1) = 0 THEN
    RAISE EXCEPTION 'trg_event_interest_signup_cutoff is not FOR EACH ROW';
  END IF;

  IF (v_tgtype & 2) = 0 THEN
    RAISE EXCEPTION
      'trg_event_interest_signup_cutoff does not fire BEFORE the write, so it cannot refuse it';
  END IF;

  IF (v_tgtype & 4) = 0 THEN
    RAISE EXCEPTION 'trg_event_interest_signup_cutoff does not fire on INSERT';
  END IF;

  -- The one that protects resend. A trigger that also fired on UPDATE would
  -- stop rotation dead once the window opened, which is exactly when someone
  -- who lost their link needs it.
  IF (v_tgtype & (8 | 16 | 32)) <> 0 THEN
    RAISE EXCEPTION
      'trg_event_interest_signup_cutoff fires on more than INSERT: rotation (an UPDATE) would be blocked during the window';
  END IF;
END $$;

-- ── Reload PostgREST schema cache ───────────────────────────────────────────
-- No RPC signature changes here, so PostgREST would route calls either way.
-- Included for consistency with the migrations this one builds on; it costs
-- nothing.

NOTIFY pgrst, 'reload schema';

COMMIT;
