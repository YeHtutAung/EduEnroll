-- ============================================================
-- 005_create_enrollments.sql
-- Enrollments — one row per student application
-- ============================================================

-- Enum -------------------------------------------------------
CREATE TYPE enrollment_status AS ENUM (
  'pending_payment',
  'payment_submitted',
  'confirmed',
  'rejected'
);

-- Table ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.enrollments (
  id               uuid               PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_ref   varchar(20)        NOT NULL UNIQUE,  -- e.g. "NM-2026-00042"
  class_id         uuid               NOT NULL REFERENCES public.classes (id),
  tenant_id        uuid               NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  student_name_en  varchar            NOT NULL,   -- name in English
  student_name_mm  varchar,                       -- name in Myanmar script
  nrc_number       varchar,                       -- National Registration Card
  phone            varchar            NOT NULL,
  email            varchar,
  status           enrollment_status  NOT NULL DEFAULT 'pending_payment',
  enrolled_at      timestamptz        NOT NULL DEFAULT now()
);

-- Indexes ----------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_enrollments_tenant_id       ON public.enrollments (tenant_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_class_id        ON public.enrollments (class_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_enrollment_ref  ON public.enrollments (enrollment_ref);
CREATE INDEX IF NOT EXISTS idx_enrollments_status          ON public.enrollments (tenant_id, status);

-- ============================================================
-- Auto-generate enrollment_ref: NM-YYYY-NNNNN
-- ============================================================
CREATE SEQUENCE IF NOT EXISTS enrollment_ref_seq START 1;

CREATE OR REPLACE FUNCTION public.generate_enrollment_ref()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.enrollment_ref := 'NM-' || to_char(now(), 'YYYY') || '-'
                        || lpad(nextval('enrollment_ref_seq')::text, 5, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enrollments_ref
  BEFORE INSERT ON public.enrollments
  FOR EACH ROW
  WHEN (NEW.enrollment_ref IS NULL OR NEW.enrollment_ref = '')
  EXECUTE FUNCTION public.generate_enrollment_ref();

-- ============================================================
-- Decrement seat_remaining when enrollment is confirmed
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_seat_remaining()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Confirmed → decrement
  IF NEW.status = 'confirmed' AND OLD.status <> 'confirmed' THEN
    UPDATE public.classes
    SET seat_remaining = seat_remaining - 1
    WHERE id = NEW.class_id AND seat_remaining > 0;

  -- Un-confirmed (e.g. rejected after confirmed) → restore
  ELSIF OLD.status = 'confirmed' AND NEW.status = 'rejected' THEN
    UPDATE public.classes
    SET seat_remaining = seat_remaining + 1
    WHERE id = NEW.class_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enrollments_seats
  AFTER UPDATE OF status ON public.enrollments
  FOR EACH ROW
  EXECUTE FUNCTION public.update_seat_remaining();

-- ============================================================
-- Row Level Security
-- ============================================================
ALTER TABLE public.enrollments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "enrollments_select"
  ON public.enrollments
  FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_my_tenant_id());

-- Public (anon) students may INSERT their own enrollment
CREATE POLICY "enrollments_insert_anon"
  ON public.enrollments
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "enrollments_update"
  ON public.enrollments
  FOR UPDATE
  TO authenticated
  USING   (tenant_id = public.get_my_tenant_id())
  WITH CHECK (tenant_id = public.get_my_tenant_id());
