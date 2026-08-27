-- ============================================================================
-- Enrollment RPCs consult the priority-window gate
--
-- The two enrollment RPCs are the sole enforcer of classes.enrollment_open_at
-- — no API route checks it — so the priority-window gate has to live inside
-- them, in the same transaction as the seat decrement. Both gain a trailing
-- `p_priority_token_hash text DEFAULT NULL`, and both replace the bare
-- open-window rejection with a call to public.priority_access_granted().
--
-- The bodies are otherwise copied verbatim from 076_fix_stored_functions.sql.
-- In particular submit_cart_enrollment's Phase 1 keeps returning on the first
-- failure, before Phase 2 creates anything: the cart is all-or-nothing by
-- design, and that is deliberate, not an oversight to be "fixed" here.
--
-- ── The redemption transition, and why it is locked ─────────────────────────
--
-- priority_access_granted is STABLE and takes no lock, so on its own it leaves
-- a window: an admin can revoke a token AFTER the gate reads it and BEFORE the
-- enrollment is inserted, and both transactions commit. The revoked token gets
-- one enrollment through. Separately, the gate alone never records that a token
-- was redeemed, so first_used_at / first_converted_enrollment_id would stay
-- null forever and — the consequential half — a superseded token would stay
-- valid for its whole grace period even after the current token had been used,
-- contradicting the rotation guarantee that the superseded hash is cleared on
-- first use of the new token.
--
-- Both have one fix. Where the gate admitted a class on the strength of a
-- token, and before any enrollment row is inserted or any seat decremented,
-- the RPC locks the matching event_interest row FOR UPDATE, re-checks
-- revoked_at under that lock, and after the insert stamps the transition:
-- first_used_at and first_converted_enrollment_id via COALESCE so an earlier
-- redemption is never overwritten, and superseded_token_hash /
-- superseded_expires_at cleared to NULL together (the
-- event_interest_superseded_paired CHECK requires them to move as a pair).
-- The row lock is held to commit, so no revocation can interleave.
--
-- What closes the race is the FOR UPDATE, not the shape of the predicate.
--
-- revoked_at is nonetheless deliberately NOT part of the locking WHERE clause.
-- The plan is Limit -> LockRows -> Sort -> scan, so LockRows sits BELOW Limit:
-- when READ COMMITTED re-evaluates a locked row against its new version and
-- rejects it, the node does not yield empty, it pulls the next row from the
-- sort. With revoked_at in the predicate a just-revoked row is rejected and the
-- scan falls through to any other row matching the same hash, which is then
-- returned unrevoked and granted. Matching on the token alone always returns
-- the row itself, and revocation is judged afterwards.
--
-- With one matching row the two predicates are equivalent — both deny, both
-- fail closed, no seat moves — and one matching row is all that token_hash's
-- UNIQUE constraint permits without a SHA-256 collision. So this is a
-- robustness choice for a case that should not be reachable, not the thing
-- that makes the reachable case correct.
--
-- A row that is gone entirely (NOT FOUND) is treated as denied, and the denial
-- reuses the payload an unauthorised caller gets, so nothing leaks about
-- whether the token existed.
--
-- Lock order is classes then event_interest, in both functions. The admin
-- revoke path touches event_interest alone, so it cannot invert this.
--
-- The cart's token is intake-level: exactly one interest row is locked and
-- stamped once, against the cart's enrollment id, not once per tier. Only one
-- intake can ever be admitted through a single token — priority_access_granted
-- joins event_interest on the class's own intake_id, so a cart spanning two
-- intakes that both need the gate fails on the second, and Phase 1 is
-- all-or-nothing. The admitted intake is tracked rather than assumed.
--
-- Nothing above happens when the gate was not exercised. A tier already on
-- public sale involves no token, and no interest row is touched.
--
-- ── Why DROP, and why the grants are repaired by hand ───────────────────────
--
-- Adding a parameter — even a defaulted one — makes a NEW overload. It does
-- not replace the old function: CREATE OR REPLACE only replaces a function of
-- the *same* signature. Left alone, the three-argument submit_enrollment and
-- the two-argument submit_cart_enrollment would both survive alongside the new
-- ones, still SECURITY DEFINER and still enforcing the pre-gate rules. That is
-- exactly how the overload pile-up in
-- 20260719100000_restrict_enrollment_rpc_privileges.sql accumulated, so the
-- old signatures are dropped explicitly.
--
-- The drop has a second consequence that is easy to miss. CREATE OR REPLACE
-- preserves existing privileges; a fresh CREATE after a DROP does not — it
-- takes the PostgreSQL default, which is EXECUTE TO PUBLIC. Without the
-- REVOKE/GRANT block below, this migration would silently hand `anon` two
-- SECURITY DEFINER functions that bypass RLS, raising no error anywhere. The
-- revokes here are not decoration; they restore the posture 20260719100000
-- established, which the drop would otherwise undo.
--
-- The assertions at the end fail the migration closed if either new signature
-- is missing or either old one survived, following the same style as
-- 20260719100000.
--
-- priority_access_granted is SECURITY INVOKER and revoked from every
-- application role. It is reachable here only because these callers are
-- SECURITY DEFINER owned by postgres, which owns the gate too and so retains
-- EXECUTE implicitly. It therefore needs no grant of its own.
-- ============================================================================

BEGIN;

-- ── 1. Remove the superseded signatures ─────────────────────────────────────
-- Explicit signatures: a bare DROP FUNCTION is ambiguous while both the old
-- and the new overload exist.
DROP FUNCTION IF EXISTS public.submit_enrollment(uuid, text, integer);
DROP FUNCTION IF EXISTS public.submit_cart_enrollment(jsonb, uuid);

-- ── 2. submit_enrollment ────────────────────────────────────────────────────

CREATE FUNCTION public.submit_enrollment(
  p_class_id             uuid,
  p_idempotency_key      text    DEFAULT NULL,
  p_quantity             integer DEFAULT 1,
  p_priority_token_hash  text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_class            public.classes%ROWTYPE;
  v_existing         public.enrollments%ROWTYPE;
  v_enrollment_id    uuid;
  v_enrollment_ref   text;
  v_new_remaining    integer;
  v_qty              integer;
  v_gate_used        boolean := false;
  v_interest_id      uuid;
  v_revoked_at       timestamptz;
BEGIN
  v_qty := GREATEST(COALESCE(p_quantity, 1), 1);

  IF p_idempotency_key IS NOT NULL AND p_idempotency_key <> '' THEN
    SELECT *
    INTO   v_existing
    FROM   public.enrollments
    WHERE  idempotency_key = p_idempotency_key;

    IF FOUND THEN
      SELECT * INTO v_class FROM public.classes WHERE id = v_existing.class_id;
      RETURN jsonb_build_object(
        'success',         true,
        'enrollment_ref',  v_existing.enrollment_ref,
        'enrollment_id',   v_existing.id,
        'class_level',     v_class.level,
        'fee_amount',      v_class.fee_amount,
        'tenant_id',       v_class.tenant_id,
        'seat_remaining',  v_class.seat_remaining,
        'quantity',        v_existing.quantity
      );
    END IF;
  END IF;

  SELECT *
  INTO   v_class
  FROM   public.classes
  WHERE  id = p_class_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'CLASS_NOT_FOUND');
  END IF;

  IF v_class.status <> 'open' THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'CLASS_NOT_OPEN', 'class_status', v_class.status
    );
  END IF;

  -- The public sale has not opened. A valid, unrevoked interest token for this
  -- tier's intake, once the intake's priority_open_at has passed, is the only
  -- thing that gets through.
  IF v_class.enrollment_open_at IS NOT NULL AND now() < v_class.enrollment_open_at THEN
    IF NOT public.priority_access_granted(v_class.id, p_priority_token_hash) THEN
      RETURN jsonb_build_object('success', false, 'error', 'ENROLLMENT_NOT_OPEN');
    END IF;
    -- Admitted on a token: the redemption transition below is owed.
    v_gate_used := true;
  END IF;
  IF v_class.enrollment_close_at IS NOT NULL AND now() > v_class.enrollment_close_at THEN
    RETURN jsonb_build_object('success', false, 'error', 'ENROLLMENT_CLOSED');
  END IF;

  IF v_qty > v_class.max_tickets_per_person THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   'EXCEEDS_MAX_TICKETS',
      'max',     v_class.max_tickets_per_person
    );
  END IF;

  IF v_class.seat_remaining < v_qty THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   CASE WHEN v_class.seat_remaining <= 0 THEN 'CLASS_FULL' ELSE 'NOT_ENOUGH_SEATS' END,
      'seat_remaining', v_class.seat_remaining
    );
  END IF;

  -- Redemption transition, step 1-2: lock the interest row and re-check
  -- revocation under that lock, before anything is created or decremented.
  IF v_gate_used THEN
    SELECT ei.id, ei.revoked_at
    INTO   v_interest_id, v_revoked_at
    FROM   public.event_interest ei
    WHERE  ei.intake_id = v_class.intake_id
      AND (
            ei.token_hash = p_priority_token_hash
        OR (ei.superseded_token_hash = p_priority_token_hash
            AND now() < ei.superseded_expires_at)
      )
    -- token_hash is UNIQUE table-wide, so the live-token branch matches at most
    -- one row; superseded_token_hash carries no such constraint. Ordering the
    -- live match first and taking one row makes the choice deterministic
    -- instead of leaving SELECT INTO to pick a row arbitrarily and silently.
    ORDER BY (ei.token_hash = p_priority_token_hash) DESC, ei.id
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND OR v_revoked_at IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'ENROLLMENT_NOT_OPEN');
    END IF;
  END IF;

  INSERT INTO public.enrollments (
    class_id, tenant_id, student_name_en, phone, status, enrollment_ref, idempotency_key, quantity
  ) VALUES (
    p_class_id, v_class.tenant_id, '', '', 'pending_payment', '',
    CASE WHEN p_idempotency_key = '' THEN NULL ELSE p_idempotency_key END,
    v_qty
  )
  RETURNING id, enrollment_ref
  INTO v_enrollment_id, v_enrollment_ref;

  v_new_remaining := v_class.seat_remaining - v_qty;

  UPDATE public.classes
  SET seat_remaining = v_new_remaining,
      status = CASE WHEN v_new_remaining <= 0 THEN 'full'::class_status ELSE status END
  WHERE id = p_class_id;

  -- Redemption transition, step 4. COALESCE: a later redemption must not
  -- overwrite the first one. Clearing the superseded pair is what actually
  -- retires a rotated-away token at first use of the new one.
  IF v_interest_id IS NOT NULL THEN
    UPDATE public.event_interest
    SET first_used_at                 = COALESCE(first_used_at, now()),
        first_converted_enrollment_id = COALESCE(first_converted_enrollment_id, v_enrollment_id),
        superseded_token_hash         = NULL,
        superseded_expires_at         = NULL
    WHERE id = v_interest_id;
  END IF;

  RETURN jsonb_build_object(
    'success',         true,
    'enrollment_ref',  v_enrollment_ref,
    'enrollment_id',   v_enrollment_id,
    'class_level',     v_class.level,
    'fee_amount',      v_class.fee_amount,
    'tenant_id',       v_class.tenant_id,
    'seat_remaining',  v_new_remaining,
    'quantity',        v_qty
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', 'INTERNAL_ERROR', 'detail', SQLERRM);
END;
$$;

-- ── 3. submit_cart_enrollment ───────────────────────────────────────────────

CREATE FUNCTION public.submit_cart_enrollment(
  p_items                jsonb,
  p_tenant_id            uuid DEFAULT NULL,
  p_priority_token_hash  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item           jsonb;
  v_class          public.classes%ROWTYPE;
  v_enrollment_id  uuid;
  v_enrollment_ref text;
  v_total_fee      integer := 0;
  v_total_qty      integer := 0;
  v_items_out      jsonb := '[]'::jsonb;
  v_resolved_tenant uuid;
  v_qty            integer;
  v_new_remaining  integer;
  v_gate_intake_id uuid;
  v_gate_class     public.classes%ROWTYPE;
  v_interest_id    uuid;
  v_revoked_at     timestamptz;
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'EMPTY_CART');
  END IF;

  SELECT tenant_id INTO v_resolved_tenant
  FROM public.classes
  WHERE id = (p_items->0->>'class_id')::uuid;

  IF v_resolved_tenant IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'CLASS_NOT_FOUND');
  END IF;

  -- Phase 1: Lock and validate all class rows
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) ORDER BY value->>'class_id'
  LOOP
    SELECT * INTO v_class
    FROM public.classes
    WHERE id = (v_item->>'class_id')::uuid
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'CLASS_NOT_FOUND',
        'class_id', v_item->>'class_id');
    END IF;

    IF v_class.tenant_id <> v_resolved_tenant THEN
      RETURN jsonb_build_object('success', false, 'error', 'CROSS_TENANT');
    END IF;

    IF v_class.status <> 'open' THEN
      RETURN jsonb_build_object('success', false, 'error', 'CLASS_NOT_OPEN',
        'class_id', v_class.id, 'class_level', v_class.level);
    END IF;

    -- One intake-level token covers every tier of that intake, so the same
    -- hash is checked per class inside the loop.
    IF v_class.enrollment_open_at IS NOT NULL AND now() < v_class.enrollment_open_at THEN
      IF NOT public.priority_access_granted(v_class.id, p_priority_token_hash) THEN
        RETURN jsonb_build_object('success', false, 'error', 'ENROLLMENT_NOT_OPEN',
          'class_id', v_class.id, 'class_level', v_class.level,
          'opens_at', v_class.enrollment_open_at);
      END IF;
      -- Record which intake the gate admitted, and on which tier, so the
      -- transition below locks the right row and can deny with the same
      -- payload shape this branch produces. Re-assigned on every gated tier,
      -- but always to the same intake: the gate matches the token against the
      -- class's own intake, so a second intake needing the gate would have
      -- returned above.
      --
      -- v_gate_class therefore ends up naming whichever gated tier Phase 1 saw
      -- last, which need not be the tier a later revocation has anything to do
      -- with. That is intended: the denial below must be indistinguishable from
      -- this branch's, or the payload itself would reveal that the token
      -- existed and was revoked mid-flight. Worth knowing when reading logs —
      -- on a revoked-under-lock denial the tier named is arbitrary, and the
      -- interest row, not that tier, is where the cause lives.
      v_gate_intake_id := v_class.intake_id;
      v_gate_class     := v_class;
    END IF;

    IF v_class.enrollment_close_at IS NOT NULL AND now() > v_class.enrollment_close_at THEN
      RETURN jsonb_build_object('success', false, 'error', 'ENROLLMENT_CLOSED',
        'class_id', v_class.id, 'class_level', v_class.level);
    END IF;

    v_qty := COALESCE((v_item->>'quantity')::integer, 1);

    IF v_class.max_tickets_per_person > 0 AND v_qty > v_class.max_tickets_per_person THEN
      RETURN jsonb_build_object('success', false, 'error', 'EXCEEDS_MAX_TICKETS',
        'class_id', v_class.id, 'class_level', v_class.level,
        'max', v_class.max_tickets_per_person);
    END IF;

    IF v_class.seat_remaining < v_qty THEN
      RETURN jsonb_build_object('success', false, 'error', 'NOT_ENOUGH_SEATS',
        'class_id', v_class.id, 'class_level', v_class.level,
        'seat_remaining', v_class.seat_remaining);
    END IF;
  END LOOP;

  -- Redemption transition, step 1-2. Once for the cart, not once per tier,
  -- and still before Phase 2 creates anything or Phase 3 decrements a seat.
  IF v_gate_intake_id IS NOT NULL THEN
    SELECT ei.id, ei.revoked_at
    INTO   v_interest_id, v_revoked_at
    FROM   public.event_interest ei
    WHERE  ei.intake_id = v_gate_intake_id
      AND (
            ei.token_hash = p_priority_token_hash
        OR (ei.superseded_token_hash = p_priority_token_hash
            AND now() < ei.superseded_expires_at)
      )
    -- Ordering rationale: see submit_enrollment above.
    ORDER BY (ei.token_hash = p_priority_token_hash) DESC, ei.id
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND OR v_revoked_at IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'ENROLLMENT_NOT_OPEN',
        'class_id', v_gate_class.id, 'class_level', v_gate_class.level,
        'opens_at', v_gate_class.enrollment_open_at);
    END IF;
  END IF;

  -- Phase 2: Create enrollment (class_id = NULL for cart)
  INSERT INTO public.enrollments (
    class_id, tenant_id, student_name_en, phone, status, enrollment_ref, quantity
  ) VALUES (
    NULL, v_resolved_tenant, '', '', 'pending_payment', '', 0
  )
  RETURNING id, enrollment_ref
  INTO v_enrollment_id, v_enrollment_ref;

  -- Phase 3: Insert items and decrement seats
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) ORDER BY value->>'class_id'
  LOOP
    SELECT * INTO v_class
    FROM public.classes WHERE id = (v_item->>'class_id')::uuid FOR UPDATE;

    v_qty := COALESCE((v_item->>'quantity')::integer, 1);

    INSERT INTO public.enrollment_items (enrollment_id, class_id, quantity, fee_amount, tenant_id)
    VALUES (v_enrollment_id, v_class.id, v_qty, v_class.fee_amount, v_resolved_tenant);

    v_new_remaining := v_class.seat_remaining - v_qty;
    v_total_fee := v_total_fee + (v_class.fee_amount * v_qty);
    v_total_qty := v_total_qty + v_qty;

    UPDATE public.classes
    SET seat_remaining = v_new_remaining,
        status = CASE WHEN v_new_remaining = 0 THEN 'full'::class_status ELSE status END
    WHERE id = v_class.id;

    v_items_out := v_items_out || jsonb_build_object(
      'class_id',    v_class.id,
      'class_level', v_class.level,
      'quantity',    v_qty,
      'fee_amount',  v_class.fee_amount,
      'subtotal',    v_class.fee_amount * v_qty
    );
  END LOOP;

  UPDATE public.enrollments
  SET quantity = v_total_qty
  WHERE id = v_enrollment_id;

  -- Redemption transition, step 4. Stamped against the cart's enrollment id.
  IF v_interest_id IS NOT NULL THEN
    UPDATE public.event_interest
    SET first_used_at                 = COALESCE(first_used_at, now()),
        first_converted_enrollment_id = COALESCE(first_converted_enrollment_id, v_enrollment_id),
        superseded_token_hash         = NULL,
        superseded_expires_at         = NULL
    WHERE id = v_interest_id;
  END IF;

  RETURN jsonb_build_object(
    'success',      true,
    'enrollment_ref', v_enrollment_ref,
    'enrollment_id',  v_enrollment_id,
    'tenant_id',      v_resolved_tenant,
    'total_fee',      v_total_fee,
    'quantity',       v_total_qty,
    'items',          v_items_out
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', 'INTERNAL_ERROR', 'detail', SQLERRM);
END;
$$;

-- ── 4. Restore the execute posture the DROP discarded ───────────────────────
-- See the header: these are fresh CREATEs, so they carry PostgreSQL's default
-- EXECUTE TO PUBLIC until revoked. Both callers
-- (src/server/enrollment/createEnrollment.ts,
--  src/server/enrollment/createCartEnrollment.ts) use the service-role client,
-- so no application flow needs anon or authenticated. `postgres` owns them and
-- retains EXECUTE implicitly; it needs no grant.

REVOKE ALL ON FUNCTION public.submit_enrollment(uuid, text, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_enrollment(uuid, text, integer, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.submit_cart_enrollment(jsonb, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_cart_enrollment(jsonb, uuid, text)
  TO service_role;

-- ── 5. Fail closed on the overload set ──────────────────────────────────────
-- Asserted, not assumed: a surviving old overload is a SECURITY DEFINER
-- enrollment path that skips the gate, and it would raise nothing on its own.

DO $$
BEGIN
  IF to_regprocedure('public.submit_enrollment(uuid,text,integer,text)') IS NULL THEN
    RAISE EXCEPTION 'submit_enrollment(uuid,text,integer,text) is missing';
  END IF;

  IF to_regprocedure('public.submit_cart_enrollment(jsonb,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'submit_cart_enrollment(jsonb,uuid,text) is missing';
  END IF;

  IF to_regprocedure('public.submit_enrollment(uuid,text,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'old submit_enrollment overload survived the drop';
  END IF;

  IF to_regprocedure('public.submit_cart_enrollment(jsonb,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'old submit_cart_enrollment overload survived the drop';
  END IF;
END $$;

-- ── 6. Reload the PostgREST schema cache ────────────────────────────────────
-- Both the signatures and the executable roles changed. A stale cache serves
-- overload-resolution errors to legitimate service-role calls — an enrollment
-- outage over a correctly migrated database.

NOTIFY pgrst, 'reload schema';

COMMIT;
