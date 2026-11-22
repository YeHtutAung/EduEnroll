-- ============================================================================
-- Account-bound tickets, Plan 3: the leader's phone (mode A)
--
-- Design: docs/superpowers/specs/2026-11-20-account-bound-tickets-design.md
-- (sections 3, 4.7, 6.1, 9, 10). Plan: docs/superpowers/plans/2026-11-22-leaders-phone.md
--
--   1. intakes.ticket_protection, the per-event switch. Only on jwt intakes,
--      and fixed once the intake has any order.
--   2. enrollments.buyer_id, who bought the order (decision 1 of the plan).
--   3. submit_enrollment and submit_cart_enrollment take p_buyer_id. A
--      protected order without a live buyer profile is refused with
--      BUYER_REQUIRED; the same idempotency key from another buyer is
--      IDEMPOTENCY_CONFLICT; the buyer's profile email lands on the order.
--      The bodies are copied verbatim from 20261022120000 (single) and
--      20261022130000 (cart) and changed only in those places.
--   4. ticket_devices and bind_ticket_device(): one active phone per ticket.
--   5. order_moves and move_order_buyer(): the owner's order move.
--   6. revoke_buyer_ticket_devices(): the account-deletion step.
--
-- Every new table and function is service-role only: RLS on with no
-- policies, functions revoked from PUBLIC, anon and authenticated.
--
-- Adding a parameter makes a new overload, so both submit functions are
-- DROPPED and recreated; a fresh CREATE takes the default ACL (EXECUTE to
-- PUBLIC), so the REVOKE/GRANT pairs below are load-bearing, and asserted.
--
-- DEPLOY ORDER: apply this BEFORE the code that passes p_buyer_id.
-- Rollback: supabase/rollbacks/20261122130000_leaders_phone.down.sql
-- ============================================================================

BEGIN;

-- ── 1. Scope switch (design 3) ──────────────────────────────────────────────

ALTER TABLE public.intakes
  ADD COLUMN ticket_protection boolean NOT NULL DEFAULT false;

ALTER TABLE public.intakes
  ADD CONSTRAINT intakes_ticket_protection_needs_jwt
  CHECK (NOT ticket_protection OR ticket_qr_format = 'jwt');

-- The flag can change only while the intake has no orders, single or cart.
-- SECURITY DEFINER: PATCH /api/intakes/[id] updates through the owner's RLS
-- client; the lock must see every order whatever that client can read.
CREATE FUNCTION public.intakes_lock_ticket_protection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.ticket_protection IS DISTINCT FROM OLD.ticket_protection AND (
       EXISTS (SELECT 1 FROM public.enrollments e
                 JOIN public.classes c ON c.id = e.class_id
                WHERE c.intake_id = NEW.id)
    OR EXISTS (SELECT 1 FROM public.enrollment_items ei
                 JOIN public.classes c ON c.id = ei.class_id
                WHERE c.intake_id = NEW.id)
  ) THEN
    RAISE EXCEPTION 'ticket_protection_locked' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- A trigger function; nobody calls it directly.
REVOKE ALL ON FUNCTION public.intakes_lock_ticket_protection() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER intakes_lock_ticket_protection
  BEFORE UPDATE OF ticket_protection ON public.intakes
  FOR EACH ROW EXECUTE FUNCTION public.intakes_lock_ticket_protection();

-- ── 2. The order's buyer (plan decision 1) ──────────────────────────────────

ALTER TABLE public.enrollments
  ADD COLUMN buyer_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX enrollments_buyer_id_enrolled_at_idx
  ON public.enrollments (buyer_id, enrolled_at DESC)
  WHERE buyer_id IS NOT NULL;

-- ── 3. submit_enrollment takes p_buyer_id ───────────────────────────────────

DROP FUNCTION public.submit_enrollment(uuid, text, integer, text);

CREATE FUNCTION public.submit_enrollment(
  p_class_id             uuid,
  p_idempotency_key      text    DEFAULT NULL,
  p_quantity             integer DEFAULT 1,
  p_priority_token_hash  text    DEFAULT NULL,
  p_buyer_id             uuid    DEFAULT NULL
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
  v_protected        boolean;
  v_buyer_email      text;
BEGIN
  v_qty := GREATEST(COALESCE(p_quantity, 1), 1);

  -- Account-bound tickets (20261122130000_leaders_phone). Lock first, in its
  -- own statement: Postgres refuses FOR SHARE together with an aggregate. The
  -- share lock stops an owner switching protection on while a guest order is
  -- in flight (the lock trigger's UPDATE waits for it). Side effect: during an
  -- on-sale, an admin edit of the intake waits for in-flight checkouts.
  PERFORM 1
    FROM public.intakes i JOIN public.classes c ON c.intake_id = i.id
   WHERE c.id = p_class_id
     FOR SHARE OF i;

  SELECT coalesce(bool_or(i.ticket_protection), false) INTO v_protected
    FROM public.classes c JOIN public.intakes i ON i.id = c.intake_id
   WHERE c.id = p_class_id;

  IF v_protected AND p_buyer_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'BUYER_REQUIRED');
  END IF;

  IF p_buyer_id IS NOT NULL THEN
    SELECT bp.email INTO v_buyer_email
      FROM public.buyer_profiles bp
     WHERE bp.id = p_buyer_id AND bp.deleted_at IS NULL;
    IF v_buyer_email IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'BUYER_REQUIRED');
    END IF;
  END IF;

  IF p_idempotency_key IS NOT NULL AND p_idempotency_key <> '' THEN
    SELECT *
    INTO   v_existing
    FROM   public.enrollments
    WHERE  idempotency_key = p_idempotency_key;

    IF FOUND THEN
      -- The same key from a different buyer (or a guest) is not a replay.
      IF v_existing.buyer_id IS DISTINCT FROM p_buyer_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'IDEMPOTENCY_CONFLICT');
      END IF;
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
    priority_interest_id, buyer_id, email
  ) VALUES (
    p_class_id, v_class.tenant_id, '', '', 'pending_payment', '',
    CASE WHEN p_idempotency_key = '' THEN NULL ELSE p_idempotency_key END,
    v_qty,
    v_interest_id,  -- null unless admitted on a priority link
    p_buyer_id,
    -- The draft path (checkout/new) posts no form_data, so the RPC is the only
    -- place the account email is guaranteed to land on the order.
    v_buyer_email   -- NULL for a guest, as before
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

REVOKE ALL ON FUNCTION public.submit_enrollment(uuid, text, integer, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_enrollment(uuid, text, integer, text, uuid) TO service_role;

-- ── 4. submit_cart_enrollment takes p_buyer_id ──────────────────────────────

DROP FUNCTION public.submit_cart_enrollment(jsonb, uuid, text, text);

CREATE FUNCTION public.submit_cart_enrollment(
  p_items                jsonb,
  p_tenant_id            uuid DEFAULT NULL,
  p_priority_token_hash  text DEFAULT NULL,
  p_idempotency_key      text DEFAULT NULL,
  p_buyer_id             uuid DEFAULT NULL
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
  v_protected      boolean;
  v_buyer_email    text;
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

  -- Account-bound tickets (20261122130000_leaders_phone). The cart is
  -- protected if any of its tiers sits on a protected intake. The class ids
  -- are read with jsonb_to_recordset, not by walking the array element by
  -- element: the fail-closed check below counts that call and requires
  -- exactly one, the duplicate-class aggregation's. Lock first, in its own
  -- statement: Postgres refuses FOR SHARE together with an aggregate.
  PERFORM 1
    FROM public.intakes i JOIN public.classes c ON c.intake_id = i.id
   WHERE c.id IN (SELECT x.class_id FROM jsonb_to_recordset(p_items) AS x(class_id uuid))
     FOR SHARE OF i;

  SELECT coalesce(bool_or(i.ticket_protection), false) INTO v_protected
    FROM public.classes c JOIN public.intakes i ON i.id = c.intake_id
   WHERE c.id IN (SELECT x.class_id FROM jsonb_to_recordset(p_items) AS x(class_id uuid));

  IF v_protected AND p_buyer_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'BUYER_REQUIRED');
  END IF;

  IF p_buyer_id IS NOT NULL THEN
    SELECT bp.email INTO v_buyer_email
      FROM public.buyer_profiles bp
     WHERE bp.id = p_buyer_id AND bp.deleted_at IS NULL;
    IF v_buyer_email IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'BUYER_REQUIRED');
    END IF;
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
      -- The same key from a different buyer (or a guest) is not a replay.
      IF v_existing.buyer_id IS DISTINCT FROM p_buyer_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'IDEMPOTENCY_CONFLICT');
      END IF;
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
    priority_interest_id, idempotency_key, buyer_id, email
  ) VALUES (
    NULL, v_resolved_tenant, '', '', 'pending_payment', '', 0,
    v_interest_id,  -- null unless admitted on a priority link
    CASE WHEN p_idempotency_key = '' THEN NULL ELSE p_idempotency_key END,
    p_buyer_id,
    v_buyer_email   -- NULL for a guest, as before; see submit_enrollment
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

REVOKE ALL ON FUNCTION public.submit_cart_enrollment(jsonb, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_cart_enrollment(jsonb, uuid, text, text, uuid) TO service_role;

-- ── 5. ticket_devices and the bind function (design 6.1) ────────────────────

CREATE TABLE public.ticket_devices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  buyer_id    uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  -- raw uncompressed P-256 point, 65 bytes, base64url without padding = 87 chars
  public_key  text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9_-]{87}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz NULL,
  revoked_by  text NULL CHECK (revoked_by IN ('rebind', 'holder_changed', 'account_deleted', 'order_moved')),
  CONSTRAINT ticket_devices_revoked_pair CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX ticket_devices_one_active ON public.ticket_devices (ticket_id) WHERE revoked_at IS NULL;
CREATE INDEX ticket_devices_active_by_buyer ON public.ticket_devices (buyer_id) WHERE revoked_at IS NULL;
ALTER TABLE public.ticket_devices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ticket_devices FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.ticket_devices FROM service_role;   -- Supabase default privileges grant ALL
GRANT SELECT, INSERT, UPDATE ON public.ticket_devices TO service_role;   -- never DELETE: the audit trail

-- 'bound_first' | 'bound_again' | 'unchanged' | 'refused'. One generic refusal.
CREATE FUNCTION public.bind_ticket_device(
  p_ticket_id uuid, p_tenant_id uuid, p_buyer_id uuid, p_public_key text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_t       record;
  v_active  text;
  v_first   boolean;
BEGIN
  IF p_ticket_id IS NULL OR p_tenant_id IS NULL OR p_buyer_id IS NULL
     OR p_public_key IS NULL OR p_public_key !~ '^[A-Za-z0-9_-]{87}$' THEN
    RETURN 'refused';
  END IF;

  -- Same lock order as move_order_buyer (enrollment, then ticket), so a bind
  -- queued behind a move wakes up after it and reads the new buyer.
  PERFORM 1 FROM public.enrollments e
    JOIN public.tickets t ON t.enrollment_id = e.id
   WHERE t.id = p_ticket_id
     FOR SHARE OF e;   -- waits behind a move's FOR UPDATE; doesn't block inserts referencing the order
  PERFORM 1 FROM public.tickets WHERE id = p_ticket_id FOR UPDATE;   -- serialises two binds

  -- Account deletion sets buyer_profiles.deleted_at, then revokes the buyer's
  -- phones (revoke_buyer_ticket_devices). The share lock makes a bind and a
  -- deletion take turns: a bind waiting behind the deletion's UPDATE wakes
  -- up to a deleted profile and is refused; a deletion waiting behind a bind
  -- revokes the row the bind just wrote. Without it a bind could commit after
  -- the revoke, and deleteUser would leave an active row nobody can find.
  PERFORM 1 FROM public.buyer_profiles
   WHERE id = p_buyer_id AND deleted_at IS NULL
     FOR SHARE;
  IF NOT FOUND THEN
    RETURN 'refused';
  END IF;

  -- A separate statement after the locks: a fresh READ COMMITTED snapshot.
  SELECT t.tenant_id, t.status, e.buyer_id, e.status::text AS order_status, i.ticket_protection
    INTO v_t
    FROM public.tickets t
    JOIN public.enrollments e ON e.id = t.enrollment_id
    JOIN public.intakes i ON i.id = t.intake_id
   WHERE t.id = p_ticket_id;

  IF NOT FOUND
     OR v_t.tenant_id <> p_tenant_id
     OR v_t.status <> 'valid'
     OR v_t.order_status <> 'confirmed'
     OR NOT v_t.ticket_protection
     OR v_t.buyer_id IS DISTINCT FROM p_buyer_id
  THEN
    RETURN 'refused';
  END IF;

  SELECT public_key INTO v_active
    FROM public.ticket_devices
   WHERE ticket_id = p_ticket_id AND revoked_at IS NULL;

  IF v_active = p_public_key THEN
    RETURN 'unchanged';
  END IF;

  v_first := NOT EXISTS (
    SELECT 1 FROM public.ticket_devices WHERE ticket_id = p_ticket_id AND buyer_id = p_buyer_id);

  UPDATE public.ticket_devices
     SET revoked_at = now(), revoked_by = 'rebind'
   WHERE ticket_id = p_ticket_id AND revoked_at IS NULL;

  INSERT INTO public.ticket_devices (ticket_id, buyer_id, public_key)
  VALUES (p_ticket_id, p_buyer_id, p_public_key);

  RETURN CASE WHEN v_first THEN 'bound_first' ELSE 'bound_again' END;
END;
$$;

-- ── 6. Order moves (design 4.7) ─────────────────────────────────────────────

CREATE TABLE public.order_moves (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id  uuid NOT NULL REFERENCES public.enrollments(id) ON DELETE CASCADE,
  tenant_id      uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  from_buyer_id  uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  to_buyer_id    uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  moved_by       uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  reason         text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_moves_enrollment_idx ON public.order_moves (enrollment_id, created_at DESC);
ALTER TABLE public.order_moves ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_moves FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.order_moves FROM service_role;   -- Supabase default privileges grant ALL
GRANT SELECT, INSERT ON public.order_moves TO service_role;   -- never updated or deleted

-- Returns ('moved', old buyer) or ('refused', NULL). One generic refusal.
CREATE FUNCTION public.move_order_buyer(
  p_enrollment_id uuid, p_tenant_id uuid, p_staff_user_id uuid, p_to_buyer_id uuid, p_reason text)
RETURNS TABLE (result text, from_buyer_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_e     record;
  v_last  date;
BEGIN
  IF p_enrollment_id IS NULL OR p_tenant_id IS NULL OR p_staff_user_id IS NULL OR p_to_buyer_id IS NULL
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RETURN QUERY SELECT 'refused'::text, NULL::uuid; RETURN;
  END IF;

  SELECT e.id, e.tenant_id, e.status::text AS status, e.buyer_id, e.class_id
    INTO v_e
    FROM public.enrollments e
   WHERE e.id = p_enrollment_id
     FOR UPDATE;

  IF NOT FOUND
     OR v_e.tenant_id <> p_tenant_id
     OR v_e.status <> 'confirmed'
     OR v_e.buyer_id IS NULL
     OR v_e.buyer_id = p_to_buyer_id
     OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_staff_user_id AND u.tenant_id = p_tenant_id)
     OR NOT EXISTS (SELECT 1 FROM public.buyer_profiles bp WHERE bp.id = p_to_buyer_id AND bp.deleted_at IS NULL)
     OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_to_buyer_id)
  THEN
    RETURN QUERY SELECT 'refused'::text, NULL::uuid; RETURN;
  END IF;

  -- Hold the target's profile live until this move commits, so a deletion
  -- of the target can't slip in between the check above and the commit: a
  -- deletion waiting behind the move then sees the moved order, and a move
  -- waiting behind a deletion wakes up to a deleted profile and is refused.
  -- Placed after the refusal check so the FOUND that check reads is still
  -- the enrollment read's, not this statement's.
  PERFORM 1 FROM public.buyer_profiles
   WHERE id = p_to_buyer_id AND deleted_at IS NULL
     FOR SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'refused'::text, NULL::uuid; RETURN;
  END IF;

  -- Last day across the order's classes (single or cart). end_time is the END DATE.
  SELECT max(greatest(c.event_date, coalesce(c.end_time, c.event_date)))
    INTO v_last
    FROM public.classes c
   WHERE c.id = v_e.class_id
      OR c.id IN (SELECT ei.class_id FROM public.enrollment_items ei WHERE ei.enrollment_id = v_e.id);

  -- The zone must equal the app's TICKET_TZ default (DEFAULT_TICKET_TZ in
  -- src/lib/tickets/exp.ts); a database test compares them.
  IF v_last IS NOT NULL AND v_last < (now() AT TIME ZONE 'Asia/Yangon')::date THEN
    RETURN QUERY SELECT 'refused'::text, NULL::uuid; RETURN;
  END IF;

  PERFORM 1 FROM public.tickets t WHERE t.enrollment_id = v_e.id FOR UPDATE;

  UPDATE public.ticket_devices d
     SET revoked_at = now(), revoked_by = 'order_moved'
    FROM public.tickets t
   WHERE t.enrollment_id = v_e.id AND d.ticket_id = t.id AND d.revoked_at IS NULL;

  UPDATE public.enrollments SET buyer_id = p_to_buyer_id WHERE id = v_e.id;

  INSERT INTO public.order_moves (enrollment_id, tenant_id, from_buyer_id, to_buyer_id, moved_by, reason)
  VALUES (v_e.id, p_tenant_id, v_e.buyer_id, p_to_buyer_id, p_staff_user_id, btrim(p_reason));

  RETURN QUERY SELECT 'moved'::text, v_e.buyer_id;
END;
$$;

-- ── 7. Deletion step (design 9, plan decision 2) ────────────────────────────

-- Idempotent. Returns the number of rows revoked.
CREATE FUNCTION public.revoke_buyer_ticket_devices(p_buyer_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_n integer;
BEGIN
  UPDATE public.ticket_devices
     SET revoked_at = now(), revoked_by = 'account_deleted'
   WHERE buyer_id = p_buyer_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- ── 8. Grants ───────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.bind_ticket_device(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_ticket_device(uuid, uuid, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.move_order_buyer(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.move_order_buyer(uuid, uuid, uuid, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.revoke_buyer_ticket_devices(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_buyer_ticket_devices(uuid) TO service_role;

-- ── 9. Fail closed on the bodies and ACLs ───────────────────────────────────
-- CRLF-tolerant, like this repository's other prosrc guards.

DO $$
DECLARE
  v_fn    text;
  v_src   text;
  v_probe text := 'jsonb_array_elements(p_' || 'items)';
  v_hits  integer;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.submit_enrollment(uuid,text,integer,text,uuid)',
    'public.submit_cart_enrollment(jsonb,uuid,text,text,uuid)',
    'public.bind_ticket_device(uuid,uuid,uuid,text)',
    'public.move_order_buyer(uuid,uuid,uuid,uuid,text)',
    'public.revoke_buyer_ticket_devices(uuid)'
  ] LOOP
    IF to_regprocedure(v_fn) IS NULL THEN
      RAISE EXCEPTION '% is missing', v_fn;
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

  -- The old overloads must be gone.
  IF to_regprocedure('public.submit_enrollment(uuid,text,integer,text)') IS NOT NULL
     OR to_regprocedure('public.submit_enrollment(uuid,text,integer)') IS NOT NULL
     OR to_regprocedure('public.submit_cart_enrollment(jsonb,uuid,text,text)') IS NOT NULL
     OR to_regprocedure('public.submit_cart_enrollment(jsonb,uuid,text)') IS NOT NULL
     OR to_regprocedure('public.submit_cart_enrollment(jsonb,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'an older submit_enrollment or submit_cart_enrollment overload is still present';
  END IF;

  SELECT replace(prosrc, chr(13), '') INTO v_src
    FROM pg_proc WHERE oid = 'public.submit_enrollment(uuid,text,integer,text,uuid)'::regprocedure;
  IF v_src NOT LIKE '%p_buyer_id%'
     OR v_src NOT LIKE '%BUYER_REQUIRED%'
     OR v_src NOT LIKE '%IDEMPOTENCY_CONFLICT%'
     OR v_src NOT LIKE '%PRIORITY_LINK_USED%'
     OR v_src NOT LIKE '%priority_access_granted%' THEN
    RAISE EXCEPTION 'submit_enrollment body is not the expected one';
  END IF;

  -- The cart migration's guard (20261022130000), extended to p_buyer_id. The
  -- raw item array is still walked exactly once, by the aggregation.
  SELECT replace(prosrc, chr(13), '') INTO v_src
    FROM pg_proc WHERE oid = 'public.submit_cart_enrollment(jsonb,uuid,text,text,uuid)'::regprocedure;
  IF v_src NOT LIKE '%p_idempotency_key%'
     OR v_src NOT LIKE '%p_buyer_id%'
     OR v_src NOT LIKE '%BUYER_REQUIRED%'
     OR v_src NOT LIKE '%IDEMPOTENCY_CONFLICT%'
     OR v_src NOT LIKE '%PRIORITY_LINK_IN_PROGRESS%'
     OR v_src NOT LIKE '%priority_access_granted%'
     OR v_src NOT LIKE '%v_agg_items%' THEN
    RAISE EXCEPTION 'submit_cart_enrollment body is not the expected one';
  END IF;
  v_hits := (length(v_src) - length(replace(v_src, v_probe, ''))) / length(v_probe);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'submit_cart_enrollment walks the raw item array % time(s), expected 1', v_hits;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
