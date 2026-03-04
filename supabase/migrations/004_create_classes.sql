-- ============================================================
-- 004_create_classes.sql
-- Classes — one row per JLPT level per intake
-- Default fees (MMK): N5=300,000 | N4=350,000 | N3=400,000
--                     N2=450,000 | N1=500,000
-- ============================================================

-- Enums ------------------------------------------------------
CREATE TYPE jlpt_level   AS ENUM ('N5', 'N4', 'N3', 'N2', 'N1');
CREATE TYPE class_status  AS ENUM ('draft', 'open', 'full', 'closed');

-- Table ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.classes (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_id             uuid          NOT NULL REFERENCES public.intakes (id) ON DELETE CASCADE,
  tenant_id             uuid          NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  level                 jlpt_level    NOT NULL,
  fee_mmk               integer       NOT NULL,
  seat_total            integer       NOT NULL,
  seat_remaining        integer       NOT NULL,
  enrollment_open_at    timestamptz,
  enrollment_close_at   timestamptz,
  status                class_status  NOT NULL DEFAULT 'draft',
  created_at            timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT classes_seats_check CHECK (seat_remaining >= 0 AND seat_remaining <= seat_total),
  UNIQUE (intake_id, level)   -- one class per level per intake
);

-- Indexes ----------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_classes_intake_id  ON public.classes (intake_id);
CREATE INDEX IF NOT EXISTS idx_classes_tenant_id  ON public.classes (tenant_id);
CREATE INDEX IF NOT EXISTS idx_classes_level      ON public.classes (level);

-- ============================================================
-- Helper: seed all 5 default JLPT classes for a given intake
-- Usage: SELECT public.seed_default_classes('<intake_id>', '<tenant_id>', 30);
-- ============================================================
CREATE OR REPLACE FUNCTION public.seed_default_classes(
  p_intake_id   uuid,
  p_tenant_id   uuid,
  p_seat_total  integer DEFAULT 30
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.classes
    (intake_id, tenant_id, level, fee_mmk, seat_total, seat_remaining)
  VALUES
    (p_intake_id, p_tenant_id, 'N5', 300000, p_seat_total, p_seat_total),
    (p_intake_id, p_tenant_id, 'N4', 350000, p_seat_total, p_seat_total),
    (p_intake_id, p_tenant_id, 'N3', 400000, p_seat_total, p_seat_total),
    (p_intake_id, p_tenant_id, 'N2', 450000, p_seat_total, p_seat_total),
    (p_intake_id, p_tenant_id, 'N1', 500000, p_seat_total, p_seat_total)
  ON CONFLICT (intake_id, level) DO NOTHING;
$$;

-- ============================================================
-- Row Level Security
-- ============================================================
ALTER TABLE public.classes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "classes_select"
  ON public.classes
  FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_my_tenant_id());

CREATE POLICY "classes_insert"
  ON public.classes
  FOR INSERT
  TO authenticated
  WITH CHECK (tenant_id = public.get_my_tenant_id());

CREATE POLICY "classes_update"
  ON public.classes
  FOR UPDATE
  TO authenticated
  USING   (tenant_id = public.get_my_tenant_id())
  WITH CHECK (tenant_id = public.get_my_tenant_id());
