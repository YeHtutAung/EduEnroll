-- ============================================================================
-- submit_cart_enrollment aggregates duplicate class_ids before validating
--
-- Phase 1 validated each submitted item independently, so a cart that named
-- the same tier more than once was measured one item at a time and never as a
-- whole. Two consequences, one cause:
--
--   1. max_tickets_per_person was bypassed, silently. Measured against the
--      local stack, max_tickets_per_person = 2, seat_remaining = 100:
--
--        one item, quantity 5             -> EXCEEDS_MAX_TICKETS   (correct)
--        three items, quantity 2 each     -> success, quantity 6   (wrong)
--
--      No error, no rollback: seats decremented, the enrollment was created,
--      and for an event tenant that cap is the anti-scalping control. This is
--      the consequential half.
--
--   2. Seats produced a confusing error rather than a wrong outcome. With
--      seat_remaining = 6 and a cart of [quantity 5, quantity 5], each item
--      passed its own `seat_remaining < v_qty` check, then Phase 3's second
--      decrement drove the column negative and classes_seats_check aborted the
--      whole transaction. Nothing oversells -- the constraint catches the
--      aggregate and the rollback is total -- but the caller got
--      INTERNAL_ERROR carrying the constraint name instead of the
--      NOT_ENOUGH_SEATS its contract promises, and a constraint name is not
--      something a public payment path should hand out.
--
-- The fix is one change: collapse the submitted items to one entry per
-- distinct class_id, with the quantities summed, BEFORE Phase 1 runs. Both
-- phases then iterate that collapsed array, so every per-item rule is applied
-- to the cart's real demand on that class and every class is locked, checked
-- and decremented exactly once.
--
-- Aggregating rather than rejecting. Refusing a cart that repeats a class_id
-- would also close the bypass, but it converts a request the client is
-- entitled to make -- "two of this tier, and two more" -- into an error the
-- client cannot act on, and it changes the request contract. Summing keeps the
-- contract exactly as it was and answers the question the cart actually asked.
--
-- -- The one observable change ------------------------------------------------
--
-- The `items` array in a successful response now carries one entry per
-- DISTINCT class, not one per submitted item. A cart of three items naming one
-- class returns a single entry with quantity 3, where it used to return three
-- entries of quantity 1. Callers that count entries rather than summing
-- quantities will see a different number; `quantity` and `total_fee` at the
-- top level are unchanged, as are enrollment_items -- which now genuinely
-- match the response, since the table gets one row per distinct class too.
-- For any cart with no repeated class_id -- every cart the UI produces -- the
-- response is identical to before.
--
-- -- What is deliberately left alone -----------------------------------------
--
-- This is the live payment path, so the diff is confined to the aggregation
-- and the two loop sources. Preserved verbatim from
-- 20260827120100_enrollment_rpc_priority_token.sql:
--
--   * The (jsonb, uuid, text) signature. CREATE OR REPLACE, not DROP: it
--     preserves the ACL that 20260827120100 installed, and there is no new
--     overload to create. The posture is asserted at the end regardless.
--   * Phase 1's all-or-nothing behaviour -- it returns on the first failure,
--     before Phase 2 creates anything. That is the cart's design, not a bug.
--   * The priority gate, the locked redemption transition, and the
--     v_gate_intake_id / v_gate_class tracking the transition depends on.
--   * Every error's payload shape and keys, including which keys each branch
--     omits.
--   * Same-tenant enforcement, and the resolution of the cart's tenant from
--     p_items->0 specifically. Resolving it from the collapsed array instead
--     would reorder which item is "first" and could change a CLASS_NOT_FOUND
--     between its two shapes (the bare one here, the one carrying 'class_id'
--     inside the loop) for a cart with a missing class somewhere other than
--     position 0. Nothing is gained by moving it, so it does not move.
--
-- -- Why the grouping key is the uuid, not the text --------------------------
--
-- The items are cast to uuid before grouping. Grouping on the raw JSON string
-- would let '7CDCE6D3-...' and '7cdce6d3-...' -- the same class, two spellings
-- Postgres treats as equal the moment either is cast -- land in separate
-- groups and reopen the exact bypass this file closes. A malformed uuid still
-- raises, and is still caught by the function's own handler as INTERNAL_ERROR,
-- exactly as it was when the cast happened inside the loop.
--
-- Ordering by that uuid also preserves the deadlock-avoidance property the
-- previous ORDER BY provided: both phases still take their FOR UPDATE locks on
-- classes in one consistent order across concurrent carts. Element expansion
-- yields array order, so building the array ordered is enough -- the loops
-- need no ORDER BY of their own.
-- ============================================================================

BEGIN;

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
    SELECT ei.id, ei.revoked_at
    INTO   v_interest_id, v_revoked_at
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

-- -- Privilege posture, restated ---------------------------------------------
-- CREATE OR REPLACE preserves the existing ACL, so 20260827120100's revoke
-- still stands and these are no-ops. Restated anyway: a reader comparing the
-- two files should not have to know that rule to be sure the replacement did
-- not quietly hand EXECUTE back to PUBLIC on a SECURITY DEFINER function that
-- bypasses RLS. Asserted below as well, because a comment is not a control.

REVOKE ALL ON FUNCTION public.submit_cart_enrollment(jsonb, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_cart_enrollment(jsonb, uuid, text)
  TO service_role;

-- -- Fail closed on the object, its body, and its ACL -------------------------
--
-- CREATE OR REPLACE is silent about WHICH body it installed. A migration that
-- applies cleanly while leaving the per-item body in place is exactly the
-- failure this file exists to prevent, and it would be invisible until an
-- event tenant's ticket cap was quietly exceeded in production.
--
-- CRLF-tolerant: `db push` sends LF and a paste into the SQL editor sends
-- CRLF, so the match is made against text with the carriage returns stripped.
-- Same treatment as this repository's other prosrc guards.

DO $$
DECLARE
  v_src   text;
  v_probe text := 'jsonb_array_elements(p_' || 'items)';
  v_hits  integer;
BEGIN
  IF to_regprocedure('public.submit_cart_enrollment(jsonb,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'submit_cart_enrollment(jsonb,uuid,text) is missing';
  END IF;

  -- The pre-gate two-argument overload must still be absent. It is a
  -- SECURITY DEFINER enrollment path that skips both the priority gate and
  -- this aggregation, and its presence would raise nothing on its own.
  IF to_regprocedure('public.submit_cart_enrollment(jsonb,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'the pre-gate submit_cart_enrollment(jsonb,uuid) overload is present';
  END IF;

  SELECT replace(prosrc, chr(13), '') INTO v_src
    FROM pg_proc
   WHERE oid = 'public.submit_cart_enrollment(jsonb,uuid,text)'::regprocedure;

  IF v_src NOT LIKE '%v_agg_items%' THEN
    RAISE EXCEPTION
      'submit_cart_enrollment has no collapsed item array: the replaced body did not install';
  END IF;

  -- The load-bearing assertion. Presence of the aggregation is not enough --
  -- what makes the cap enforceable is that NEITHER phase iterates the raw
  -- argument any more. So the raw argument may be walked exactly once, by the
  -- aggregation itself. Two occurrences means a loop was left behind, and that
  -- loop is the bug.
  --
  -- v_probe is assembled at runtime so this counting guard cannot count
  -- itself: the literal must not appear in the body it is measuring, and the
  -- prose above is part of that body.
  v_hits := (length(v_src) - length(replace(v_src, v_probe, ''))) / length(v_probe);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION
      'submit_cart_enrollment walks the raw item array % time(s), expected exactly 1 (the aggregation)',
      v_hits;
  END IF;

  -- -- ACL ------------------------------------------------------------------
  -- grantee 0 is PUBLIC. anon and authenticated inherit PUBLIC, so the PUBLIC
  -- check covers them transitively; they are checked directly too, because a
  -- direct grant would not show up as a PUBLIC entry.
  IF EXISTS (
    SELECT 1
    FROM   pg_proc p, aclexplode(p.proacl) a
    WHERE  p.oid = 'public.submit_cart_enrollment(jsonb,uuid,text)'::regprocedure
      AND  a.grantee = 0
      AND  a.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'submit_cart_enrollment(jsonb,uuid,text) is executable by PUBLIC';
  END IF;

  IF to_regrole('anon') IS NOT NULL
     AND has_function_privilege('anon',
           'public.submit_cart_enrollment(jsonb,uuid,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'submit_cart_enrollment(jsonb,uuid,text) is executable by anon';
  END IF;

  IF to_regrole('authenticated') IS NOT NULL
     AND has_function_privilege('authenticated',
           'public.submit_cart_enrollment(jsonb,uuid,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'submit_cart_enrollment(jsonb,uuid,text) is executable by authenticated';
  END IF;

  -- The application's only caller (src/server/enrollment/createCartEnrollment.ts)
  -- uses the service-role client. Losing this grant is an enrollment outage.
  IF to_regrole('service_role') IS NOT NULL
     AND NOT has_function_privilege('service_role',
           'public.submit_cart_enrollment(jsonb,uuid,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'submit_cart_enrollment(jsonb,uuid,text) is not executable by service_role';
  END IF;
END $$;

-- -- Reload the PostgREST schema cache ----------------------------------------
-- The signature is unchanged, so this is defensive rather than required. Kept
-- for the same reason every other migration touching these functions keeps it:
-- a stale cache serves overload-resolution errors to legitimate service-role
-- calls, which is an enrollment outage over a correctly migrated database.

NOTIFY pgrst, 'reload schema';

COMMIT;
