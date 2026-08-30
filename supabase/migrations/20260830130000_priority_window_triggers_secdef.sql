-- ============================================================================
-- The priority-window triggers must run as their owner
--
-- 20260827120000_event_interest_priority_window.sql closed the door on
-- assert_priority_window_valid(uuid):
--
--   REVOKE ALL ON FUNCTION public.assert_priority_window_valid(uuid)
--     FROM PUBLIC, anon, authenticated, service_role;
--
-- That was the right instinct — the function takes FOR UPDATE on an arbitrary
-- intake row, and nothing outside the two triggers has any business calling
-- it. But the two trigger functions that DO call it were left SECURITY
-- INVOKER, so the nested call is privilege-checked against whichever role is
-- doing the write. No client role has EXECUTE. Every one of them fails:
--
--   INSERT INTO public.intakes ... -> 42501 permission denied for function
--                                     assert_priority_window_valid
--   INSERT INTO public.classes ... -> 42501 (same)
--
-- Which is to say: creating an event, and creating a ticket tier, have been
-- impossible for every caller since that migration landed. The admin screen
-- for the window cannot save either, because setting priority_open_at is an
-- UPDATE that reaches the same PERFORM. Only writes that change neither
-- priority_open_at nor enrollment_open_at/intake_id survive, because the two
-- trigger functions early-return before the call.
--
-- Why this was not caught: the invariant itself is sound and its tests pass —
-- they run as an owner-privileged role, which is the one role that can make
-- the call. The defect lives entirely in the privilege boundary between the
-- trigger and the function it delegates to, which no test crossed.
--
-- ── The fix, and the road not taken ─────────────────────────────────────────
--
-- The obvious repair is to grant EXECUTE back to authenticated and
-- service_role. That works and is rejected: it restores exactly the reachable
-- surface the REVOKE was written to remove, handing any authenticated user a
-- function that takes and holds a row lock on any intake id they care to
-- name. The lockdown was correct; only the trigger side was wrong.
--
-- So the trigger functions become SECURITY DEFINER. Their bodies then execute
-- as the owner, the nested call is checked against the owner, and
-- assert_priority_window_valid stays unreachable from anon, authenticated and
-- service_role alike.
--
-- This is safe specifically because PostgreSQL does not re-check EXECUTE on a
-- trigger function when the trigger fires — that check happens once, at
-- CREATE TRIGGER. The proof is in the error itself: the failure above names
-- assert_priority_window_valid, not trg_assert_priority_window_from_intake,
-- even though both are revoked from service_role identically. Only the inner
-- call is gated at runtime, so moving the privilege boundary one level out is
-- sufficient, and no grant on the trigger functions is needed or wanted.
--
-- SECURITY DEFINER also means the invariant's reads of intakes and classes
-- run as the owner and are not filtered by RLS. That is required, not
-- incidental: a check that can only see the rows the writer is allowed to see
-- is a check that passes by being blindfolded. It must see every tier in the
-- intake to compare enrollment_open_at against priority_open_at.
--
-- Both bodies are reproduced verbatim from the migration that created them.
-- CREATE OR REPLACE preserves the existing ACL, so the revokes on these two
-- functions survive untouched; they are re-asserted below anyway, because a
-- privilege this migration depends on should not be left to inference.
-- ============================================================================

BEGIN;

-- ── 1. The two trigger functions, now SECURITY DEFINER ──────────────────────
--
-- search_path is pinned on both. It was pinned before and would be pinned
-- either way, but on a SECURITY DEFINER function it stops being hygiene and
-- becomes the control that prevents a caller-supplied search_path from
-- resolving `public.assert_priority_window_valid` to something else while
-- running as the owner.

CREATE OR REPLACE FUNCTION public.trg_assert_priority_window_from_intake()
RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.priority_open_at IS NOT DISTINCT FROM OLD.priority_open_at THEN
    RETURN NEW;
  END IF;
  PERFORM public.assert_priority_window_valid(NEW.id);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.trg_assert_priority_window_from_class()
RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.enrollment_open_at IS NOT DISTINCT FROM OLD.enrollment_open_at
     AND NEW.intake_id IS NOT DISTINCT FROM OLD.intake_id THEN
    RETURN NEW;
  END IF;
  PERFORM public.assert_priority_window_valid(NEW.intake_id);
  RETURN NEW;
END $$;

-- ── 2. Re-assert the lockdown ───────────────────────────────────────────────
--
-- Idempotent restatement of the revokes from 20260827120000. CREATE OR
-- REPLACE above did not disturb them; this makes the intended end state
-- explicit rather than depending on a reader knowing that.

REVOKE ALL ON FUNCTION public.trg_assert_priority_window_from_intake()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.trg_assert_priority_window_from_class()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.assert_priority_window_valid(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ── 3. Guards ───────────────────────────────────────────────────────────────
--
-- CRLF-tolerant prosrc matching, as in this repository's other prosrc guards:
-- `db push` sends LF and a paste into the SQL editor sends CRLF.

DO $$
DECLARE
  v_src    text;
  v_owner  name;
  v_tgtype smallint;
  r        record;
BEGIN
  -- 3a. Both trigger functions must be SECURITY DEFINER, with search_path
  --     pinned. Without prosecdef this migration has changed nothing and the
  --     42501 is still there; without the search_path pin, prosecdef is a
  --     liability rather than a fix.
  FOR r IN
    SELECT unnest(ARRAY[
      'public.trg_assert_priority_window_from_intake()',
      'public.trg_assert_priority_window_from_class()'
    ]) AS sig
  LOOP
    IF to_regprocedure(r.sig) IS NULL THEN
      RAISE EXCEPTION '% is missing', r.sig;
    END IF;

    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = r.sig::regprocedure) THEN
      RAISE EXCEPTION
        '% is not SECURITY DEFINER: writes to intakes and classes would still fail with 42501', r.sig;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc
       WHERE oid = r.sig::regprocedure
         AND proconfig @> ARRAY['search_path=public']
    ) THEN
      RAISE EXCEPTION
        '% is SECURITY DEFINER without a pinned search_path', r.sig;
    END IF;
  END LOOP;

  -- 3b. Each body must still delegate to the invariant. A SECURITY DEFINER
  --     trigger that no longer calls the check would install cleanly, pass
  --     3a, and silently stop enforcing the window.
  SELECT replace(prosrc, chr(13), '') INTO v_src
    FROM pg_proc WHERE oid = 'public.trg_assert_priority_window_from_intake()'::regprocedure;
  IF v_src NOT LIKE '%assert_priority_window_valid(NEW.id)%' THEN
    RAISE EXCEPTION
      'trg_assert_priority_window_from_intake no longer calls assert_priority_window_valid';
  END IF;
  IF v_src NOT LIKE '%NEW.priority_open_at IS NOT DISTINCT FROM OLD.priority_open_at%' THEN
    RAISE EXCEPTION
      'trg_assert_priority_window_from_intake lost its unchanged-column early return';
  END IF;

  SELECT replace(prosrc, chr(13), '') INTO v_src
    FROM pg_proc WHERE oid = 'public.trg_assert_priority_window_from_class()'::regprocedure;
  IF v_src NOT LIKE '%assert_priority_window_valid(NEW.intake_id)%' THEN
    RAISE EXCEPTION
      'trg_assert_priority_window_from_class no longer calls assert_priority_window_valid';
  END IF;

  -- 3c. The owner must actually be able to make the nested call. This is the
  --     whole mechanism: if the owner were ever changed to a role without
  --     EXECUTE, SECURITY DEFINER would buy nothing and the 42501 would
  --     return wearing a different role name.
  SELECT pg_get_userbyid(proowner) INTO v_owner
    FROM pg_proc WHERE oid = 'public.trg_assert_priority_window_from_intake()'::regprocedure;

  IF NOT has_function_privilege(
       v_owner, 'public.assert_priority_window_valid(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION
      'owner % cannot execute assert_priority_window_valid: SECURITY DEFINER does not fix the 42501', v_owner;
  END IF;

  -- 3d. And the client roles must still NOT be able to make it. This is the
  --     property the REVOKE existed for; repairing the triggers must not have
  --     bought availability back with reach.
  FOR r IN SELECT unnest(ARRAY['anon','authenticated','service_role']) AS rolname
  LOOP
    IF has_function_privilege(
         r.rolname, 'public.assert_priority_window_valid(uuid)', 'EXECUTE') THEN
      RAISE EXCEPTION
        'role % can execute assert_priority_window_valid directly: the lockdown from 20260827120000 has been undone', r.rolname;
    END IF;
  END LOOP;

  -- 3e. Firing conditions, re-pinned. Neither trigger is recreated here, so
  --     these re-assert unchanged objects — kept for the same reason
  --     20260830120100 keeps its own: a guarantee checked only in the
  --     migration that first made it is a guarantee that decays.
  --     tgtype bitmask: 1 = ROW, 2 = BEFORE, 4 = INSERT, 8 = DELETE,
  --     16 = UPDATE, 32 = TRUNCATE.
  FOR r IN
    SELECT * FROM (VALUES
      ('public.intakes'::regclass, 'trg_intakes_assert_priority_window'),
      ('public.classes'::regclass, 'trg_classes_assert_priority_window')
    ) AS t(rel, tg)
  LOOP
    SELECT tgtype INTO v_tgtype
      FROM pg_trigger
     WHERE tgrelid = r.rel AND tgname = r.tg AND NOT tgisinternal;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'trigger % is missing from %', r.tg, r.rel;
    END IF;

    IF (v_tgtype & 1) = 0 THEN
      RAISE EXCEPTION '% is not FOR EACH ROW', r.tg;
    END IF;

    -- AFTER, not BEFORE: the invariant spans both tables, and the check must
    -- see the row as it will be committed.
    IF (v_tgtype & 2) <> 0 THEN
      RAISE EXCEPTION '% fires BEFORE the write, not AFTER it', r.tg;
    END IF;

    IF (v_tgtype & 4) = 0 OR (v_tgtype & 16) = 0 THEN
      RAISE EXCEPTION '% must fire on both INSERT and UPDATE', r.tg;
    END IF;
  END LOOP;
END $$;

-- ── 4. Reload PostgREST schema cache ────────────────────────────────────────
-- No signature changes, so routing is unaffected either way. Included for
-- consistency with the migrations this one repairs; it costs nothing.

NOTIFY pgrst, 'reload schema';

COMMIT;
