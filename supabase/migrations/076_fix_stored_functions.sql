-- ─── 076: Force-recreate stored functions with currency-agnostic column names ──
--
-- Migration 074 renamed columns but the stored functions on the staging DB
-- may still reference the old names (amount_mmk, fee_mmk). This migration
-- recreates them explicitly to guarantee the correct column names are used.
--
-- Functions updated:
--   get_tenant_revenue         — amount_mmk  → amount
--   submit_enrollment          — fee_mmk     → fee_amount
--   submit_cart_enrollment     — fee_mmk     → fee_amount

BEGIN;

-- ── 1. get_tenant_revenue ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_tenant_revenue(p_tenant_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(amount), 0)
  FROM public.payments
  WHERE tenant_id = p_tenant_id
    AND status = 'verified';
$$;

GRANT EXECUTE ON FUNCTION public.get_tenant_revenue(uuid) TO authenticated;

-- ── 2. submit_enrollment ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.submit_enrollment(
  p_class_id        uuid,
  p_idempotency_key text    DEFAULT NULL,
  p_quantity        integer DEFAULT 1
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

  IF v_class.enrollment_open_at IS NOT NULL AND now() < v_class.enrollment_open_at THEN
    RETURN jsonb_build_object('success', false, 'error', 'ENROLLMENT_NOT_OPEN');
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

GRANT EXECUTE ON FUNCTION public.submit_enrollment(uuid, text, integer) TO authenticated, anon;

-- ── 3. submit_cart_enrollment ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.submit_cart_enrollment(
  p_items     jsonb,
  p_tenant_id uuid DEFAULT NULL
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

    IF v_class.enrollment_open_at IS NOT NULL AND now() < v_class.enrollment_open_at THEN
      RETURN jsonb_build_object('success', false, 'error', 'ENROLLMENT_NOT_OPEN',
        'class_id', v_class.id, 'class_level', v_class.level,
        'opens_at', v_class.enrollment_open_at);
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

GRANT EXECUTE ON FUNCTION public.submit_cart_enrollment(jsonb, uuid) TO authenticated, anon;

-- ── 4. Reload PostgREST schema cache ─────────────────────────────────────────

NOTIFY pgrst, 'reload schema';

COMMIT;
