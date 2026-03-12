-- ─── 040: Multi-ticket support for events ────────────────────────────────────
-- 1. Add max_tickets_per_person to classes (default 1 = current behavior)
-- 2. Add quantity to enrollments (default 1 = current behavior)
-- 3. Update submit_enrollment() to accept quantity
-- 4. Update update_seat_remaining() to restore by quantity

BEGIN;

-- ── 1. Classes: max tickets per person ──────────────────────────────────────
ALTER TABLE public.classes
  ADD COLUMN IF NOT EXISTS max_tickets_per_person integer NOT NULL DEFAULT 1;

-- ── 2. Enrollments: quantity purchased ──────────────────────────────────────
ALTER TABLE public.enrollments
  ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 1;

-- ── 3. Updated submit_enrollment() with quantity support ────────────────────
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
  -- Clamp quantity to at least 1
  v_qty := GREATEST(COALESCE(p_quantity, 1), 1);

  -- 0. If idempotency_key provided, check for existing enrollment
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
        'fee_mmk',         v_class.fee_mmk,
        'tenant_id',       v_class.tenant_id,
        'seat_remaining',  v_class.seat_remaining,
        'quantity',         v_existing.quantity
      );
    END IF;
  END IF;

  -- 1. Lock the class row
  SELECT *
  INTO   v_class
  FROM   public.classes
  WHERE  id = p_class_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'CLASS_NOT_FOUND');
  END IF;

  -- 2. Class must be open
  IF v_class.status <> 'open' THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'CLASS_NOT_OPEN', 'class_status', v_class.status
    );
  END IF;

  -- 3. Check enrollment window
  IF v_class.enrollment_open_at IS NOT NULL AND now() < v_class.enrollment_open_at THEN
    RETURN jsonb_build_object('success', false, 'error', 'ENROLLMENT_NOT_OPEN');
  END IF;
  IF v_class.enrollment_close_at IS NOT NULL AND now() > v_class.enrollment_close_at THEN
    RETURN jsonb_build_object('success', false, 'error', 'ENROLLMENT_CLOSED');
  END IF;

  -- 4. Validate quantity against max_tickets_per_person
  IF v_qty > v_class.max_tickets_per_person THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   'EXCEEDS_MAX_TICKETS',
      'max',     v_class.max_tickets_per_person
    );
  END IF;

  -- 5. Seats must be available (enough for requested quantity)
  IF v_class.seat_remaining < v_qty THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   CASE WHEN v_class.seat_remaining <= 0 THEN 'CLASS_FULL' ELSE 'NOT_ENOUGH_SEATS' END,
      'seat_remaining', v_class.seat_remaining
    );
  END IF;

  -- 6. Insert enrollment with quantity
  INSERT INTO public.enrollments (
    class_id, tenant_id, student_name_en, phone, status, enrollment_ref, idempotency_key, quantity
  ) VALUES (
    p_class_id, v_class.tenant_id, '', '', 'pending_payment', '',
    CASE WHEN p_idempotency_key = '' THEN NULL ELSE p_idempotency_key END,
    v_qty
  )
  RETURNING id, enrollment_ref
  INTO v_enrollment_id, v_enrollment_ref;

  -- 7. Decrement seat_remaining by quantity
  v_new_remaining := v_class.seat_remaining - v_qty;

  UPDATE public.classes
  SET seat_remaining = v_new_remaining,
      status = CASE WHEN v_new_remaining <= 0 THEN 'full'::class_status ELSE status END
  WHERE id = p_class_id;

  -- 8. Return success
  RETURN jsonb_build_object(
    'success',         true,
    'enrollment_ref',  v_enrollment_ref,
    'enrollment_id',   v_enrollment_id,
    'class_level',     v_class.level,
    'fee_mmk',         v_class.fee_mmk,
    'tenant_id',       v_class.tenant_id,
    'seat_remaining',  v_new_remaining,
    'quantity',         v_qty
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', 'INTERNAL_ERROR', 'detail', SQLERRM);
END;
$$;

-- Grant to both old signature (2 args) and new signature (3 args)
GRANT EXECUTE ON FUNCTION public.submit_enrollment(uuid, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_enrollment(uuid, text, integer) TO anon;

-- ── 4. Updated seat restore trigger — restore by quantity ───────────────────
CREATE OR REPLACE FUNCTION public.update_seat_remaining()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Rejected after being active → restore seats by quantity
  IF NEW.status = 'rejected' AND OLD.status IN ('pending_payment', 'payment_submitted', 'confirmed') THEN
    UPDATE public.classes
    SET seat_remaining = LEAST(seat_remaining + NEW.quantity, seat_total)
    WHERE id = NEW.class_id;
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
