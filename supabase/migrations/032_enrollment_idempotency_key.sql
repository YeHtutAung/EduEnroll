-- ─── Migration 032: Idempotency key for enrollment double-submit prevention ──
-- Adds an optional unique key to enrollments. The submit_enrollment RPC checks
-- this key and returns the existing enrollment instead of creating a duplicate.

ALTER TABLE public.enrollments
  ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX idx_enrollments_idempotency_key
  ON public.enrollments (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Recreate submit_enrollment with idempotency support
CREATE OR REPLACE FUNCTION public.submit_enrollment(
  p_class_id        uuid,
  p_idempotency_key text DEFAULT NULL
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
BEGIN
  -- 0. If idempotency_key provided, check for existing enrollment
  IF p_idempotency_key IS NOT NULL AND p_idempotency_key <> '' THEN
    SELECT *
    INTO   v_existing
    FROM   public.enrollments
    WHERE  idempotency_key = p_idempotency_key;

    IF FOUND THEN
      -- Return existing enrollment (idempotent replay)
      SELECT * INTO v_class FROM public.classes WHERE id = v_existing.class_id;
      RETURN jsonb_build_object(
        'success',         true,
        'enrollment_ref',  v_existing.enrollment_ref,
        'enrollment_id',   v_existing.id,
        'class_level',     v_class.level,
        'fee_mmk',         v_class.fee_mmk,
        'tenant_id',       v_class.tenant_id,
        'seat_remaining',  v_class.seat_remaining
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

  -- 4. Seats must be available
  IF v_class.seat_remaining <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'CLASS_FULL');
  END IF;

  -- 5. Insert enrollment with minimal defaults
  INSERT INTO public.enrollments (
    class_id, tenant_id, student_name_en, phone, status, enrollment_ref, idempotency_key
  ) VALUES (
    p_class_id, v_class.tenant_id, '', '', 'pending_payment', '',
    CASE WHEN p_idempotency_key = '' THEN NULL ELSE p_idempotency_key END
  )
  RETURNING id, enrollment_ref
  INTO v_enrollment_id, v_enrollment_ref;

  -- 6. Decrement seat_remaining atomically
  v_new_remaining := v_class.seat_remaining - 1;

  UPDATE public.classes
  SET seat_remaining = v_new_remaining,
      status = CASE WHEN v_new_remaining = 0 THEN 'full'::class_status ELSE status END
  WHERE id = p_class_id;

  -- 7. Return success
  RETURN jsonb_build_object(
    'success',         true,
    'enrollment_ref',  v_enrollment_ref,
    'enrollment_id',   v_enrollment_id,
    'class_level',     v_class.level,
    'fee_mmk',         v_class.fee_mmk,
    'tenant_id',       v_class.tenant_id,
    'seat_remaining',  v_new_remaining
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', 'INTERNAL_ERROR', 'detail', SQLERRM);
END;
$$;

-- Grant with new signature
GRANT EXECUTE ON FUNCTION public.submit_enrollment(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_enrollment(uuid, text) TO anon;
