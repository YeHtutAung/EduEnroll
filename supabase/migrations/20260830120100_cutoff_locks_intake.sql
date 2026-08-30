-- ============================================================================
-- The signup cutoff must LOCK the intake row it reads
--
-- 20260830120000_interest_signup_cutoff.sql moved the cutoff into the
-- database, which was right, but it read the intake without a lock and said
-- so in a comment: "Under READ COMMITTED the read still sees the latest
-- committed priority_open_at, so an admin who moves the window earlier is
-- respected by the very next insert."
--
-- True, and not enough. It answers a change that has ALREADY committed. It
-- says nothing about one that commits while the insert is in flight, and the
-- race survives one step further out:
--
--   1. An organiser's transaction updates intakes.priority_open_at to a moment
--      in the past. Not yet committed.
--   2. A signup arrives. The trigger reads the intake and sees the last
--      committed value — the OLD one, still in the future — and admits it.
--   3. The organiser commits.
--   4. The signup commits.
--
-- The row is now on the list, holding a valid priority token, created against
-- a window that had already been moved past by the time it landed. Nothing
-- was violated at any single instant; the two transactions simply never saw
-- each other. That is the whole shape of the bug the original migration set
-- out to fix, displaced by one layer — a stale read instead of a stale
-- in-process clock.
--
-- FOR SHARE closes it. The lock is taken on the intake before the check and
-- held to commit, so step 1 and step 2 can no longer overlap invisibly:
-- whichever transaction reaches the intake first, the other waits, and the
-- waiter re-reads the row it was blocked on. If the organiser goes first the
-- signup wakes to the NEW priority_open_at and is refused; if the signup goes
-- first the organiser waits behind a transaction measured in milliseconds and
-- the signup was legitimate when it committed. Both orderings are correct,
-- which is the point of a lock: not to pick a winner, but to stop there from
-- being an ordering in which nobody is wrong and the invariant still breaks.
--
-- ── FOR SHARE, not FOR UPDATE, and the distinction is the design ────────────
--
-- This trigger only READS the intake. It never writes it, and it never needs
-- to be the only reader.
--
-- Share locks coexist. Two hundred people signing up for the same event take
-- two hundred share locks on one intake row and none of them waits for any
-- other. FOR UPDATE is exclusive and would queue every one of them behind the
-- last — and a priority window opening is precisely the moment this feature is
-- guaranteed to see a burst, so serialising signups against each other would
-- turn the fix into the outage. The original migration's instinct on that
-- point was correct; its mistake was concluding that no lock was therefore
-- needed at all.
--
-- What FOR SHARE does block is an UPDATE of that intake, which is the only
-- writer that can invalidate this check. Exactly the conflict we want, and
-- nothing else.
--
-- FOR KEY SHARE would NOT be enough, which is worth stating because the row is
-- already key-share locked here for another reason. event_interest's composite
-- FK to intakes takes FOR KEY SHARE on the parent during this same insert.
-- But priority_open_at is not a key column, so an UPDATE of it takes only FOR
-- NO KEY UPDATE — which does not conflict with FOR KEY SHARE. The FK's lock
-- therefore lets the organiser's UPDATE straight through. FOR SHARE is the
-- weakest mode that conflicts with FOR NO KEY UPDATE, so it is the weakest
-- mode that actually holds the window still.
--
-- ── Lock ordering: no inversion, checked rather than assumed ────────────────
--
-- assert_priority_window_valid() already takes FOR UPDATE on intakes, so
-- adding a second lock-taker to the same table is exactly where a deadlock
-- would be introduced if one were going to be. The three paths that reach
-- these rows:
--
--   signup   (here)  intakes FOR SHARE  →  event_interest (the insert itself)
--   intake   editor  intakes (UPDATE's own row lock, then FOR UPDATE from the
--                    AFTER trigger — an upgrade inside the same transaction,
--                    which never waits)  →  classes (read, unlocked)
--   rotation         event_interest FOR UPDATE, and nothing else — the cutoff
--                    trigger is INSERT-only, so rotation's UPDATE does not
--                    fire it and never reaches intakes at all
--
-- Signup and the intake editor both take intakes FIRST and reach for their
-- second table only afterwards, so the two cannot hold what the other wants:
-- signup waits on intakes while holding nothing, the editor waits on nothing
-- while holding intakes. No cycle.
--
-- Rotation is the path that would close a cycle if it existed, since it holds
-- an event_interest row lock while signup wants to insert into that table.
-- It does not: rotation never acquires an intakes lock, so it can never be
-- the transaction signup is queued behind on intakes.
--
-- The one pre-existing hazard is unchanged and untouched: the class editor
-- takes classes THEN intakes, which is the inversion 20260827120000 already
-- documents and accepts ("a future bulk writer over classes must iterate in
-- stable intake_id order"). This migration adds no participant to it — the
-- signup path never touches classes.
--
-- ── Everything else is deliberately identical ───────────────────────────────
--
-- Same signature, so CREATE OR REPLACE; the trigger is unchanged and is not
-- recreated. clock_timestamp(), the fail-closed NOT FOUND branch and the null
-- window branch are carried over verbatim, with their reasoning — see
-- 20260830120000 for the full argument on each. The only change is the lock.
--
-- New migration, not an edit to 20260830120000: that file is applied, and an
-- applied migration that changes silently does not re-run.
--
-- See docs/superpowers/specs/2026-08-26-event-interest-priority-window-design.md
-- (v15), section "Signup and resend".
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.trg_event_interest_signup_cutoff()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v_priority timestamptz;
BEGIN
  -- The locking read. See this migration's header for why the mode is what it
  -- is: shared so that concurrent signups to one event do not queue behind
  -- each other, but strong enough to conflict with an organiser moving the
  -- window, which is the only write that can make this check wrong after it
  -- has been made. Held to commit, so the answer cannot go stale between the
  -- check and the write.
  SELECT priority_open_at INTO v_priority
    FROM public.intakes
   WHERE id = NEW.intake_id
   FOR SHARE;

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

-- ── Privileges ──────────────────────────────────────────────────────────────
--
-- CREATE OR REPLACE preserves the existing ACL, so 20260830120000's revoke
-- still stands and this is a no-op. Restated anyway: a reader comparing the
-- two files should not have to know that rule to be sure the replacement did
-- not quietly hand EXECUTE back to PUBLIC.

REVOKE ALL ON FUNCTION public.trg_event_interest_signup_cutoff()
  FROM PUBLIC, anon, authenticated, service_role;

-- ── Fail closed on the object, its body, and its firing conditions ──────────
--
-- CREATE OR REPLACE is silent about WHICH body it installed. A migration that
-- applies cleanly while leaving the unlocked body in place is precisely the
-- failure this file exists to prevent, and it would be invisible until two
-- transactions raced in production. Asserted from the catalog rather than by
-- attempting a real signup: exercising the rule needs a tenant and an intake,
-- and a migration that writes fixture rows into a live database — even inside
-- a transaction, even cleaned up — is not a trade worth making. The race
-- itself is covered against real rows, on two connections, in
-- src/__tests__/db/interest-signup-cutoff.db.test.ts (S7).
--
-- CRLF-tolerant: `db push` sends LF and a paste into the SQL editor sends
-- CRLF, so the match is made against text with the carriage returns stripped.
-- Same treatment as this repository's other prosrc guards.

DO $$
DECLARE
  v_src    text;
  v_tgtype smallint;
BEGIN
  IF to_regprocedure('public.trg_event_interest_signup_cutoff()') IS NULL THEN
    RAISE EXCEPTION 'trg_event_interest_signup_cutoff() is missing';
  END IF;

  SELECT replace(prosrc, chr(13), '') INTO v_src
    FROM pg_proc
   WHERE oid = 'public.trg_event_interest_signup_cutoff()'::regprocedure;

  -- Ordered, not merely present. The pattern requires FOR SHARE to appear
  -- AFTER the read of intakes on NEW.intake_id, so prose above the statement
  -- mentioning the mode cannot satisfy it — only the clause on that SELECT
  -- can. A body that talks about locking without locking fails here.
  IF v_src NOT LIKE '%FROM public.intakes%NEW.intake_id%FOR SHARE%' THEN
    RAISE EXCEPTION
      'trg_event_interest_signup_cutoff does not read the intake FOR SHARE: the replaced body did not install';
  END IF;

  -- The lock is worthless without the comparison it protects, and the
  -- comparison is worthless if it drifts back to now().
  IF v_src NOT LIKE '%clock_timestamp() >= v_priority%' THEN
    RAISE EXCEPTION
      'trg_event_interest_signup_cutoff lost its clock_timestamp() cutoff comparison';
  END IF;

  -- ── Firing conditions, re-pinned ──────────────────────────────────────────
  --
  -- The trigger is not recreated by this migration, so these re-assert an
  -- unchanged object rather than a new one. Kept anyway: "BEFORE INSERT" is
  -- one word away from "BEFORE INSERT OR UPDATE", nothing else in the schema
  -- would notice, and a guarantee that is only checked in the migration that
  -- first made it is a guarantee that decays. pg_trigger.tgtype is a bitmask:
  -- 1 = ROW, 2 = BEFORE, 4 = INSERT, 8 = DELETE, 16 = UPDATE, 32 = TRUNCATE.
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
  -- who lost their link needs it — and it would now do so while holding a
  -- lock on the intake, making the regression worse than before.
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
