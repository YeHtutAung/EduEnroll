-- ─── Per-tenant Google Tag Manager container ────────────────────────────────
--
-- A tenant can have one GTM container loaded on its public enrollment pages:
--
--   tenants.gtm_container_id — e.g. GTM-ABC1234, or NULL for none
--
-- The value is injected into a public page, so the format is pinned here
-- (GTM-, then 4-12 upper-case letters or digits). src/lib/tagManager.ts
-- enforces the same rule first with a 400; this CHECK is the backstop.
--
-- Only the platform may change it. Owners can UPDATE their own tenants row
-- through RLS (tenants_update), so a policy alone cannot protect one column;
-- the trigger below rejects any change by a role other than service_role
-- (the superadmin API uses the service-role client) or the database owners
-- (migrations, SQL editor).
--
-- Additive. Existing tenants get NULL and behave exactly as before.
--
-- DEPLOY ORDER: apply this BEFORE the code that reads it. Without it, the
-- code selects a column that does not exist and fails.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS gtm_container_id TEXT;

ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_gtm_container_id_format;
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_gtm_container_id_format
  CHECK (gtm_container_id IS NULL OR gtm_container_id ~ '^GTM-[A-Z0-9]{4,12}$');

-- Only the platform may change it. Owners can UPDATE their own tenants row
-- through RLS (tenants_update), so a policy alone cannot protect one column.
CREATE OR REPLACE FUNCTION public.guard_tenant_gtm_container()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.gtm_container_id IS DISTINCT FROM OLD.gtm_container_id
     AND coalesce(auth.role(), '') <> 'service_role'
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'gtm_container_id can only be changed by the platform'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenants_guard_gtm ON public.tenants;
CREATE TRIGGER trg_tenants_guard_gtm
  BEFORE UPDATE OF gtm_container_id ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.guard_tenant_gtm_container();

COMMENT ON COLUMN public.tenants.gtm_container_id IS
  'Google Tag Manager container (GTM-XXXXXXX) loaded on the tenant''s public enrollment pages; NULL for none. Platform-set only.';
