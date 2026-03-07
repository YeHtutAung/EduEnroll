-- ─── Migration 026: Simplify submit_enrollment RPC ────────────────────────────
-- Strip down to only p_class_id. Form data is saved by the API after the RPC.
-- Legacy columns (student_name_en, phone, etc.) get defaults; API updates them.

CREATE OR REPLACE FUNCTION public.submit_enrollment(
  p_class_id  uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_class            public.classes%ROWTYPE;
  v_enrollment_id    uuid;
  v_enrollment_ref   text;
  v_new_remaining    integer;
BEGIN
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

  -- 3. Seats must be available
  IF v_class.seat_remaining <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'CLASS_FULL');
  END IF;

  -- 4. Insert enrollment with minimal defaults
  INSERT INTO public.enrollments (
    class_id, tenant_id, student_name_en, phone, status, enrollment_ref
  ) VALUES (
    p_class_id, v_class.tenant_id, '', '', 'pending_payment', ''
  )
  RETURNING id, enrollment_ref
  INTO v_enrollment_id, v_enrollment_ref;

  -- 5. Decrement seat_remaining atomically
  v_new_remaining := v_class.seat_remaining - 1;

  UPDATE public.classes
  SET seat_remaining = v_new_remaining,
      status = CASE WHEN v_new_remaining = 0 THEN 'full'::class_status ELSE status END
  WHERE id = p_class_id;

  -- 6. Return success
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

-- Update grant (new signature has only 1 param)
GRANT EXECUTE ON FUNCTION public.submit_enrollment(uuid) TO authenticated;
