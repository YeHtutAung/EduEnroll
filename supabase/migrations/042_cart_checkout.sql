-- ─── 042: Cart checkout — multi-type ticket orders ──────────────────────────
-- Allows a single enrollment to contain multiple ticket types (e.g., 2x GA + 1x VIP).
-- Adds enrollment_items table, makes enrollments.class_id nullable for cart orders,
-- and creates submit_cart_enrollment() RPC for atomic multi-item seat reservation.

-- 1. Create enrollment_items table
CREATE TABLE IF NOT EXISTS public.enrollment_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id  uuid NOT NULL REFERENCES public.enrollments(id) ON DELETE CASCADE,
  class_id       uuid NOT NULL REFERENCES public.classes(id),
  tenant_id      uuid NOT NULL REFERENCES public.tenants(id),
  quantity       integer NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  fee_mmk        integer NOT NULL CHECK (fee_mmk >= 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_enrollment_items_enrollment_id ON public.enrollment_items(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_enrollment_items_class_id ON public.enrollment_items(class_id);
CREATE INDEX IF NOT EXISTS idx_enrollment_items_tenant_id ON public.enrollment_items(tenant_id);

-- 2. RLS for enrollment_items
ALTER TABLE public.enrollment_items ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read their tenant's items
CREATE POLICY "enrollment_items_select" ON public.enrollment_items
  FOR SELECT TO authenticated
  USING (tenant_id = get_my_tenant_id());

-- Anon + authenticated can insert (public enrollment form)
CREATE POLICY "enrollment_items_insert_anon" ON public.enrollment_items
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "enrollment_items_insert_auth" ON public.enrollment_items
  FOR INSERT TO authenticated WITH CHECK (true);

-- Authenticated users can update their tenant's items
CREATE POLICY "enrollment_items_update" ON public.enrollment_items
  FOR UPDATE TO authenticated
  USING (tenant_id = get_my_tenant_id());

-- 3. Make enrollments.class_id nullable for cart orders
ALTER TABLE public.enrollments ALTER COLUMN class_id DROP NOT NULL;

-- 4. Create submit_cart_enrollment() RPC
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
  -- Validate input
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'EMPTY_CART');
  END IF;

  -- Resolve tenant from first class
  SELECT tenant_id INTO v_resolved_tenant
  FROM public.classes
  WHERE id = (p_items->0->>'class_id')::uuid;

  IF v_resolved_tenant IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'CLASS_NOT_FOUND');
  END IF;

  -- Phase 1: Lock and validate ALL class rows (deterministic order prevents deadlocks)
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

    -- Check enrollment window
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

  -- Phase 2: All validations passed. Create enrollment (class_id = NULL for cart).
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

    INSERT INTO public.enrollment_items (enrollment_id, class_id, quantity, fee_mmk, tenant_id)
    VALUES (v_enrollment_id, v_class.id, v_qty, v_class.fee_mmk, v_resolved_tenant);

    v_new_remaining := v_class.seat_remaining - v_qty;
    v_total_fee := v_total_fee + (v_class.fee_mmk * v_qty);
    v_total_qty := v_total_qty + v_qty;

    UPDATE public.classes
    SET seat_remaining = v_new_remaining,
        status = CASE WHEN v_new_remaining = 0 THEN 'full'::class_status ELSE status END
    WHERE id = v_class.id;

    v_items_out := v_items_out || jsonb_build_object(
      'class_id', v_class.id,
      'class_level', v_class.level,
      'quantity', v_qty,
      'fee_mmk', v_class.fee_mmk,
      'subtotal_mmk', v_class.fee_mmk * v_qty
    );
  END LOOP;

  -- Update enrollment with total quantity
  UPDATE public.enrollments
  SET quantity = v_total_qty
  WHERE id = v_enrollment_id;

  RETURN jsonb_build_object(
    'success', true,
    'enrollment_ref', v_enrollment_ref,
    'enrollment_id', v_enrollment_id,
    'tenant_id', v_resolved_tenant,
    'total_fee_mmk', v_total_fee,
    'quantity', v_total_qty,
    'items', v_items_out
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', 'INTERNAL_ERROR', 'detail', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_cart_enrollment(jsonb, uuid) TO authenticated, anon;
