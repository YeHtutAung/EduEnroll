-- ============================================================================
-- Idempotent cart checkout
--
-- 20261022120000_priority_link_single_purchase made a priority link hold while
-- its order is in progress. submit_enrollment always had an idempotency key,
-- but submit_cart_enrollment never did -- the route even dropped the key the
-- form page sends for carts. So a cart order created on a link whose response
-- was lost (a dropped mobile connection, a timeout) left the buyer refused
-- with PRIORITY_LINK_IN_PROGRESS by their own order on retry, with no way to
-- resume it: the trusted-official template creates the order before it
-- collects an email, so there was no confirmation to fall back on either.
--
-- The cart RPC now takes p_idempotency_key, stores it on the order, and a
-- retry with the same key returns the original order (same reference, items
-- and total) before any lock, gate or seat is touched -- the contract
-- submit_enrollment already has. Callers send a key per cart attempt.
--
-- -- Signature ------------------------------------------------------------------
--
-- Adding a parameter makes a new overload, so the (jsonb, uuid, text) function
-- is DROPPED and (jsonb, uuid, text, text) created. A fresh CREATE takes the
-- PostgreSQL default ACL (EXECUTE to PUBLIC), so the REVOKE/GRANT below is
-- load-bearing, and asserted. Positional three-argument calls still resolve to
-- the new function through the default.
--
-- The body is the one 20261022120000 installed, changed only in: the new
-- parameter, one variable, the replay block, and idempotency_key on the
-- INSERT. The existing unique index on enrollments.idempotency_key covers it.
--
-- DEPLOY ORDER: apply this BEFORE the code that passes p_idempotency_key.
-- Rollback: supabase/rollbacks/20261022130000_cart_idempotency.down.sql
-- ============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.submit_cart_enrollment(jsonb, uuid, text);

CREATE FUNCTION public.submit_cart_enrollment(
  p_items                jsonb,
  p_tenant_id            uuid DEFAULT NULL,
  p_priority_token_hash  text DEFAULT NULL,
  p_idempotency_key      text DEFAULT NULL
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
  v_existing       public.enrollments%ROWTYPE;
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

  -- Idempotent retry (20261022130000_cart_idempotency). A retry carrying the
  -- key of an order this cart already created gets that order back, before
  -- any lock, gate or seat is touched -- the same contract submit_enrollment
  -- has always had. Without it a lost response left a priority-link buyer
  -- refused with PRIORITY_LINK_IN_PROGRESS by their own order. Scoped to the
  -- cart's tenant.
  IF p_idempotency_key IS NOT NULL AND p_idempotency_key <> '' THEN
    SELECT * INTO v_existing
    FROM   public.enrollments
    WHERE  idempotency_key = p_idempotency_key
      AND  tenant_id = v_resolved_tenant;

    IF FOUND THEN
      SELECT COALESCE(
               jsonb_agg(
                 jsonb_build_object(
                   'class_id',    c.id,
                   'class_level', c.level,
                   'quantity',    ei.quantity,
                   'fee_amount',  ei.fee_amount,
                   'subtotal',    ei.fee_amount * ei.quantity
                 ) ORDER BY c.id
               ),
               '[]'::jsonb
             ),
             COALESCE(SUM(ei.fee_amount * ei.quantity), 0)::integer
      INTO   v_items_out, v_total_fee
      FROM   public.enrollment_items ei
      JOIN   public.classes c ON c.id = ei.class_id
      WHERE  ei.enrollment_id = v_existing.id;

      RETURN jsonb_build_object(
        'success',        true,
        'enrollment_ref', v_existing.enrollment_ref,
        'enrollment_id',  v_existing.id,
        'tenant_id',      v_existing.tenant_id,
        'total_fee',      v_total_fee,
        'quantity',       v_existing.quantity,
        'items',          v_items_out
      );
    END IF;
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
    priority_interest_id, idempotency_key
  ) VALUES (
    NULL, v_resolved_tenant, '', '', 'pending_payment', '', 0,
    v_interest_id,  -- null unless admitted on a priority link
    CASE WHEN p_idempotency_key = '' THEN NULL ELSE p_idempotency_key END
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

REVOKE ALL ON FUNCTION public.submit_cart_enrollment(jsonb, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_cart_enrollment(jsonb, uuid, text, text)
  TO service_role;

-- Fail closed on the object, its body and its ACL. CRLF-tolerant.
DO $$
DECLARE
  v_fn    text := 'public.submit_cart_enrollment(jsonb,uuid,text,text)';
  v_src   text;
  v_probe text := 'jsonb_array_elements(p_' || 'items)';
  v_hits  integer;
BEGIN
  IF to_regprocedure(v_fn) IS NULL THEN
    RAISE EXCEPTION '% is missing', v_fn;
  END IF;
  IF to_regprocedure('public.submit_cart_enrollment(jsonb,uuid,text)') IS NOT NULL
     OR to_regprocedure('public.submit_cart_enrollment(jsonb,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'an older submit_cart_enrollment overload is still present';
  END IF;

  SELECT replace(prosrc, chr(13), '') INTO v_src FROM pg_proc WHERE oid = v_fn::regprocedure;

  IF v_src NOT LIKE '%p_idempotency_key%'
     OR v_src NOT LIKE '%PRIORITY_LINK_IN_PROGRESS%'
     OR v_src NOT LIKE '%priority_access_granted%'
     OR v_src NOT LIKE '%v_agg_items%' THEN
    RAISE EXCEPTION 'submit_cart_enrollment body is not the expected one';
  END IF;

  v_hits := (length(v_src) - length(replace(v_src, v_probe, ''))) / length(v_probe);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'submit_cart_enrollment walks the raw item array % time(s), expected 1', v_hits;
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
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
