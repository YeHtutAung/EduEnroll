-- ============================================================
-- 007_create_bank_accounts.sql
-- Bank accounts — payment destinations shown to students
-- Supported Myanmar banks: KBZ, AYA, CB, UAB, Yoma, Other
-- ============================================================

-- Enum -------------------------------------------------------
CREATE TYPE myanmar_bank AS ENUM ('KBZ', 'AYA', 'CB', 'UAB', 'Yoma', 'Other');

-- Table ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bank_accounts (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid          NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  bank_name        myanmar_bank  NOT NULL,
  account_number   varchar       NOT NULL,
  account_holder   varchar       NOT NULL,
  is_active        boolean       NOT NULL DEFAULT true,
  created_at       timestamptz   NOT NULL DEFAULT now()
);

-- Indexes ----------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_bank_accounts_tenant_id  ON public.bank_accounts (tenant_id);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_active     ON public.bank_accounts (tenant_id, is_active);

-- ============================================================
-- Row Level Security
-- ============================================================
ALTER TABLE public.bank_accounts ENABLE ROW LEVEL SECURITY;

-- SELECT: authenticated staff AND anonymous public (students need to see bank details)
CREATE POLICY "bank_accounts_select_authenticated"
  ON public.bank_accounts
  FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_my_tenant_id());

CREATE POLICY "bank_accounts_select_anon"
  ON public.bank_accounts
  FOR SELECT
  TO anon
  USING (is_active = true);

CREATE POLICY "bank_accounts_insert"
  ON public.bank_accounts
  FOR INSERT
  TO authenticated
  WITH CHECK (tenant_id = public.get_my_tenant_id());

CREATE POLICY "bank_accounts_update"
  ON public.bank_accounts
  FOR UPDATE
  TO authenticated
  USING   (tenant_id = public.get_my_tenant_id())
  WITH CHECK (tenant_id = public.get_my_tenant_id());
