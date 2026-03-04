-- ============================================================
-- 010_seed_bank_accounts.sql
-- Seed Nihon Moment's default bank accounts.
-- Account numbers are placeholders — update via Settings.
-- ============================================================

-- Insert only if no bank accounts exist for Nihon Moment's tenant.
-- We look up the tenant by subdomain so this is idempotent.

DO $$
DECLARE
  v_tenant_id uuid;
BEGIN
  SELECT id INTO v_tenant_id
  FROM   public.tenants
  WHERE  subdomain = 'nihon-moment'
  LIMIT  1;

  IF v_tenant_id IS NULL THEN
    RAISE NOTICE '010_seed_bank_accounts: tenant "nihon-moment" not found — skipping seed.';
    RETURN;
  END IF;

  -- Only seed if the tenant has no bank accounts yet (idempotent)
  IF EXISTS (SELECT 1 FROM public.bank_accounts WHERE tenant_id = v_tenant_id) THEN
    RAISE NOTICE '010_seed_bank_accounts: bank accounts already exist — skipping seed.';
    RETURN;
  END IF;

  INSERT INTO public.bank_accounts (tenant_id, bank_name, account_number, account_holder, is_active)
  VALUES
    (v_tenant_id, 'KBZ', '0000000000000',  'Nihon Moment Language School', true),
    (v_tenant_id, 'AYA', '00000000000000', 'Nihon Moment Language School', true);

  RAISE NOTICE '010_seed_bank_accounts: inserted KBZ and AYA accounts for tenant %.', v_tenant_id;
END;
$$;
