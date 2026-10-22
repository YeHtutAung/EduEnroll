-- ============================================================================
-- One purchase per priority link
--
-- A pre-registration (interest) link unlocked tiers that were not on public
-- sale yet, and nothing stopped it being used again: the redemption
-- transition only stamped the FIRST order (first_converted_enrollment_id via
-- COALESCE), and max_tickets_per_person is checked per order. So one link
-- could buy any number of priority-priced tickets, and it is not tied to the
-- buyer -- forwarding it handed the price to anyone.
--
-- The rule now, applied only when an order is admitted ON a link (the gate
-- ran because a tier is not on public sale yet):
--
--   link has no order                         -> allowed
--   link has an order in progress             -> refused, PRIORITY_LINK_IN_PROGRESS
--     (pending_payment / payment_submitted / partial_payment)
--   link has a confirmed order                -> refused, PRIORITY_LINK_USED
--   link's only orders are rejected           -> allowed again
--     (payment failed, cancelled by the organiser, or auto-expired unpaid)
--
-- Holding the link while an order is in progress -- not just once paid -- is
-- what stops "open three checkouts, then pay all three". An abandoned
-- checkout frees the link when check_expired_enrollments() rejects it, or
-- sooner if the organiser rejects it.
--
-- Orders archived as internal tests (internal_test_at) are ignored, the same
-- way they are excluded from revenue and attendee views.
--
-- -- Which order belongs to which link -----------------------------------------
--
-- New column enrollments.priority_interest_id, set by both RPCs on the order
-- they create when, and only when, the gate admitted it. Backfilled from
-- event_interest.first_converted_enrollment_id, which is the only record of
-- earlier link orders; the check also reads that column directly, so an order
-- placed before this migration still counts even if the backfill missed it.
--
-- -- Why it is race-free --------------------------------------------------------
--
-- The check runs inside the existing redemption block, AFTER the event_interest
-- row has been locked FOR UPDATE and before anything is inserted. Two checkouts
-- on one link serialise on that lock; the second's check is a new statement
-- under READ COMMITTED, so it sees the first's committed order and is refused.
-- Lock order is unchanged (classes, then event_interest).
--
-- -- What is deliberately left alone --------------------------------------------
--
-- Both bodies are copied verbatim from their current definitions --
-- submit_enrollment from 20260827120100_enrollment_rpc_priority_token.sql,
-- submit_cart_enrollment from 20260830120200_cart_aggregates_duplicate_classes.sql
-- -- and changed only in: two declared variables, first_converted_enrollment_id
-- added to the locked SELECT, the check block, and priority_interest_id on the
-- INSERT. Signatures are unchanged, so CREATE OR REPLACE keeps the ACLs; they
-- are restated and asserted below anyway. Purchases of tiers already on public
-- sale never touch any of this.
--
-- Rollback: supabase/rollbacks/20261022120000_priority_link_single_purchase.down.sql
-- ============================================================================

BEGIN;

-- ── 1. Which link an order used ─────────────────────────────────────────────

ALTER TABLE public.enrollments
  ADD COLUMN IF NOT EXISTS priority_interest_id uuid
    REFERENCES public.event_interest(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS enrollments_priority_interest_idx
  ON public.enrollments (priority_interest_id)
  WHERE priority_interest_id IS NOT NULL;

COMMENT ON COLUMN public.enrollments.priority_interest_id IS
  'The pre-registration link (event_interest row) this order was admitted on; null for public-sale orders.';

UPDATE public.enrollments e
SET    priority_interest_id = ei.id
FROM   public.event_interest ei
WHERE  ei.first_converted_enrollment_id = e.id
  AND  e.priority_interest_id IS NULL;

-- ── 2. submit_enrollment ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.submit_enrollment(
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
  v_first_conv_id    uuid;
  v_link_status      public.enrollment_status;
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
    SELECT ei.id, ei.revoked_at, ei.first_converted_enrollment_id
    INTO   v_interest_id, v_revoked_at, v_first_conv_id
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

    -- One purchase per link (20261022120000_priority_link_single_purchase).
    -- Checked under the row lock taken just above, so two checkouts on the
    -- same link queue here and the second sees the first one's order. An
    -- order holds the link while it is in progress and uses it up once
    -- confirmed; a rejected order (payment failed, cancelled, or auto-expired
    -- when unpaid) frees it again. Orders archived as internal tests are
    -- ignored. first_converted_enrollment_id covers an order placed before
    -- priority_interest_id existed.
    SELECT e.status INTO v_link_status
    FROM   public.enrollments e
    WHERE  (e.priority_interest_id = v_interest_id OR e.id = v_first_conv_id)
      AND  e.status <> 'rejected'
      AND  e.internal_test_at IS NULL
    ORDER BY (e.status = 'confirmed') DESC
    LIMIT 1;

    IF FOUND THEN
      RETURN jsonb_build_object('success', false, 'error',
        CASE WHEN v_link_status = 'confirmed' THEN 'PRIORITY_LINK_USED'
             ELSE 'PRIORITY_LINK_IN_PROGRESS' END);
    END IF;
  END IF;

  INSERT INTO public.enrollments (
    class_id, tenant_id, student_name_en, phone, status, enrollment_ref, idempotency_key, quantity,
    priority_interest_id
  ) VALUES (
    p_class_id, v_class.tenant_id, '', '', 'pending_payment', '',
    CASE WHEN p_idempotency_key = '' THEN NULL ELSE p_idempotency_key END,
    v_qty,
    v_interest_id  -- null unless admitted on a priority link
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

CREATE OR REPLACE FUNCTION public.submit_cart_enrollment(
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
  v_agg_items      jsonb;
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
  v_first_conv_id  uuid;
  v_link_status    public.enrollment_status;
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'EMPTY_CART');
  END IF;

  -- Resolved from the FIRST SUBMITTED item, before any collapsing, so this
  -- keeps naming the same class it always did. See the file header.
  SELECT tenant_id INTO v_resolved_tenant
  FROM public.classes
  WHERE id = (p_items->0->>'class_id')::uuid;

  IF v_resolved_tenant IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'CLASS_NOT_FOUND');
  END IF;

  -- Phase 0: collapse to one entry per distinct class, quantities summed.
  --
  -- This is the whole fix. Everything below it is unchanged except that both
  -- loops read v_agg_items instead of the raw argument, which is what makes
  -- max_tickets_per_person and seat_remaining see the cart's real demand on a
  -- class rather than one slice of it.
  --
  -- COALESCE per element, matching what the loops did with a missing or null
  -- quantity. The SUM therefore cannot be null, and ordering by the uuid gives
  -- both phases the consistent lock order they had before.
  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object('class_id', s.class_id, 'quantity', s.quantity)
             ORDER BY s.class_id
           ),
           '[]'::jsonb
         )
  INTO v_agg_items
  FROM (
         SELECT (elem.value->>'class_id')::uuid                               AS class_id,
                SUM(COALESCE((elem.value->>'quantity')::integer, 1))::integer AS quantity
         FROM   jsonb_array_elements(p_items) AS elem
         GROUP BY 1
       ) s;

  -- Phase 1: Lock and validate all class rows
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_agg_items)
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
      -- existed and was revoked mid-flight. Worth knowing when reading logs --
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
    SELECT ei.id, ei.revoked_at, ei.first_converted_enrollment_id
    INTO   v_interest_id, v_revoked_at, v_first_conv_id
    FROM   public.event_interest ei
    WHERE  ei.intake_id = v_gate_intake_id
      AND (
            ei.token_hash = p_priority_token_hash
        OR (ei.superseded_token_hash = p_priority_token_hash
            AND now() < ei.superseded_expires_at)
      )
    -- Ordering rationale: see submit_enrollment in 20260827120100.
    ORDER BY (ei.token_hash = p_priority_token_hash) DESC, ei.id
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND OR v_revoked_at IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'ENROLLMENT_NOT_OPEN',
        'class_id', v_gate_class.id, 'class_level', v_gate_class.level,
        'opens_at', v_gate_class.enrollment_open_at);
    END IF;

    -- One purchase per link (20261022120000_priority_link_single_purchase).
    -- Checked under the row lock taken just above, so two checkouts on the
    -- same link queue here and the second sees the first one's order. An
    -- order holds the link while it is in progress and uses it up once
    -- confirmed; a rejected order (payment failed, cancelled, or auto-expired
    -- when unpaid) frees it again. Orders archived as internal tests are
    -- ignored. first_converted_enrollment_id covers an order placed before
    -- priority_interest_id existed.
    SELECT e.status INTO v_link_status
    FROM   public.enrollments e
    WHERE  (e.priority_interest_id = v_interest_id OR e.id = v_first_conv_id)
      AND  e.status <> 'rejected'
      AND  e.internal_test_at IS NULL
    ORDER BY (e.status = 'confirmed') DESC
    LIMIT 1;

    IF FOUND THEN
      RETURN jsonb_build_object('success', false, 'error',
        CASE WHEN v_link_status = 'confirmed' THEN 'PRIORITY_LINK_USED'
             ELSE 'PRIORITY_LINK_IN_PROGRESS' END);
    END IF;
  END IF;

  -- Phase 2: Create enrollment (class_id = NULL for cart)
  INSERT INTO public.enrollments (
    class_id, tenant_id, student_name_en, phone, status, enrollment_ref, quantity,
    priority_interest_id
  ) VALUES (
    NULL, v_resolved_tenant, '', '', 'pending_payment', '', 0,
    v_interest_id  -- null unless admitted on a priority link
  )
  RETURNING id, enrollment_ref
  INTO v_enrollment_id, v_enrollment_ref;

  -- Phase 3: Insert items and decrement seats
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_agg_items)
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

-- ── 4. Privilege posture, restated ──────────────────────────────────────────

REVOKE ALL ON FUNCTION public.submit_enrollment(uuid, text, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_enrollment(uuid, text, integer, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.submit_cart_enrollment(jsonb, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_cart_enrollment(jsonb, uuid, text)
  TO service_role;

-- ── 5. Fail closed on the bodies and ACLs ───────────────────────────────────
-- CRLF-tolerant, like this repository's other prosrc guards.

DO $$
DECLARE
  v_fn    text;
  v_src   text;
  v_probe text := 'jsonb_array_elements(p_' || 'items)';
  v_hits  integer;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.submit_enrollment(uuid,text,integer,text)',
    'public.submit_cart_enrollment(jsonb,uuid,text)'
  ] LOOP
    IF to_regprocedure(v_fn) IS NULL THEN
      RAISE EXCEPTION '% is missing', v_fn;
    END IF;

    SELECT replace(prosrc, chr(13), '') INTO v_src
      FROM pg_proc WHERE oid = v_fn::regprocedure;

    IF v_src NOT LIKE '%PRIORITY_LINK_USED%'
       OR v_src NOT LIKE '%PRIORITY_LINK_IN_PROGRESS%'
       OR v_src NOT LIKE '%priority_interest_id%' THEN
      RAISE EXCEPTION '% does not carry the one-purchase-per-link check: the new body did not install', v_fn;
    END IF;

    IF v_src NOT LIKE '%priority_access_granted%' OR v_src NOT LIKE '%FOR UPDATE%' THEN
      RAISE EXCEPTION '% lost the priority gate or its row lock', v_fn;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
      WHERE p.oid = v_fn::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION '% is executable by PUBLIC', v_fn;
    END IF;

    IF to_regrole('anon') IS NOT NULL
       AND has_function_privilege('anon', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable by anon', v_fn;
    END IF;

    IF to_regrole('authenticated') IS NOT NULL
       AND has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable by authenticated', v_fn;
    END IF;

    IF to_regrole('service_role') IS NOT NULL
       AND NOT has_function_privilege('service_role', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '% is not executable by service_role', v_fn;
    END IF;
  END LOOP;

  -- The cart's duplicate-class aggregation (20260830120200) must survive: the
  -- raw item array is walked exactly once, by the aggregation.
  SELECT replace(prosrc, chr(13), '') INTO v_src
    FROM pg_proc WHERE oid = 'public.submit_cart_enrollment(jsonb,uuid,text)'::regprocedure;
  v_hits := (length(v_src) - length(replace(v_src, v_probe, ''))) / length(v_probe);
  IF v_src NOT LIKE '%v_agg_items%' OR v_hits <> 1 THEN
    RAISE EXCEPTION 'submit_cart_enrollment lost its duplicate-class aggregation (raw walks: %)', v_hits;
  END IF;

  -- The pre-gate overloads must still be absent.
  IF to_regprocedure('public.submit_enrollment(uuid,text,integer)') IS NOT NULL
     OR to_regprocedure('public.submit_cart_enrollment(jsonb,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'a pre-gate enrollment overload is present';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
