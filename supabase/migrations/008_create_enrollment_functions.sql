-- ============================================================
-- 008_create_enrollment_functions.sql
-- Atomic enrollment submission for Nihon Moment
--
-- submit_enrollment() uses SELECT ... FOR UPDATE to lock the
-- class row for the duration of the transaction, preventing
-- race conditions when multiple students enroll concurrently.
-- ============================================================

CREATE OR REPLACE FUNCTION public.submit_enrollment(
  p_class_id         uuid,
  p_student_name_en  text,
  p_phone            text,
  p_student_name_mm  text    DEFAULT NULL,
  p_nrc_number       text    DEFAULT NULL,
  p_email            text    DEFAULT NULL
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
  -- ── 1. Lock the class row for this transaction ──────────────
  -- FOR UPDATE prevents concurrent enrollments from reading a
  -- stale seat_remaining value before we decrement it.
  SELECT *
  INTO   v_class
  FROM   public.classes
  WHERE  id = p_class_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success',  false,
      'error',    'CLASS_NOT_FOUND'
    );
  END IF;

  -- ── 2. Guard: class must be open ────────────────────────────
  IF v_class.status <> 'open' THEN
    RETURN jsonb_build_object(
      'success',       false,
      'error',         'CLASS_NOT_OPEN',
      'class_status',  v_class.status
    );
  END IF;

  -- ── 3. Guard: seats must be available ───────────────────────
  IF v_class.seat_remaining <= 0 THEN
    RETURN jsonb_build_object(
      'success',  false,
      'error',    'CLASS_FULL'
    );
  END IF;

  -- ── 4. Insert enrollment ─────────────────────────────────────
  -- enrollment_ref is set to '' so trg_enrollments_ref fires
  -- and auto-generates the NM-YYYY-NNNNN reference via sequence.
  INSERT INTO public.enrollments (
    class_id,
    tenant_id,
    student_name_en,
    student_name_mm,
    nrc_number,
    phone,
    email,
    status,
    enrollment_ref
  ) VALUES (
    p_class_id,
    v_class.tenant_id,
    p_student_name_en,
    NULLIF(TRIM(COALESCE(p_student_name_mm, '')), ''),
    NULLIF(TRIM(COALESCE(p_nrc_number,      '')), ''),
    p_phone,
    NULLIF(TRIM(COALESCE(p_email,           '')), ''),
    'pending_payment',
    ''   -- trigger replaces this with NM-YYYY-NNNNN
  )
  RETURNING id, enrollment_ref
  INTO v_enrollment_id, v_enrollment_ref;

  -- ── 5. Decrement seat_remaining atomically ───────────────────
  v_new_remaining := v_class.seat_remaining - 1;

  UPDATE public.classes
  SET
    seat_remaining = v_new_remaining,
    -- Mark full the moment the last seat is taken
    status = CASE
               WHEN v_new_remaining = 0 THEN 'full'::class_status
               ELSE status
             END
  WHERE id = p_class_id;

  -- ── 6. Return success payload ────────────────────────────────
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
    RETURN jsonb_build_object(
      'success',  false,
      'error',    'INTERNAL_ERROR',
      'detail',   SQLERRM
    );
END;
$$;

-- Allow the service-role API to call this from public endpoints.
-- Anon grant is intentionally omitted — callers go through the
-- Next.js API route which uses the service role key.
GRANT EXECUTE ON FUNCTION public.submit_enrollment(uuid, text, text, text, text, text)
  TO authenticated;
