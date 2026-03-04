-- ============================================================
-- 003_create_intakes.sql
-- Intakes — enrolment cohorts (e.g. "April 2026 Intake" /
-- "ဧပြီ ၂၀၂၆ စာရင်းသွင်းမှု")
-- ============================================================

-- Enum -------------------------------------------------------
CREATE TYPE intake_status AS ENUM ('draft', 'open', 'closed');

-- Table ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.intakes (
  id          uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid           NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  name        varchar        NOT NULL,   -- bilingual label stored as-is
  year        integer        NOT NULL,
  status      intake_status  NOT NULL DEFAULT 'draft',
  created_at  timestamptz    NOT NULL DEFAULT now()
);

-- Indexes ----------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_intakes_tenant_id ON public.intakes (tenant_id);
CREATE INDEX IF NOT EXISTS idx_intakes_year      ON public.intakes (tenant_id, year);

-- ============================================================
-- Row Level Security
-- ============================================================
ALTER TABLE public.intakes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "intakes_select"
  ON public.intakes
  FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_my_tenant_id());

CREATE POLICY "intakes_insert"
  ON public.intakes
  FOR INSERT
  TO authenticated
  WITH CHECK (tenant_id = public.get_my_tenant_id());

CREATE POLICY "intakes_update"
  ON public.intakes
  FOR UPDATE
  TO authenticated
  USING   (tenant_id = public.get_my_tenant_id())
  WITH CHECK (tenant_id = public.get_my_tenant_id());
