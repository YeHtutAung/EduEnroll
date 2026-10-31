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
-- Only the platform may set it, including on insert. The trigger below
-- rejects any set or change unless it comes from the platform (service-role
-- client) or a migration / SQL-editor session.
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
  CHECK (gtm_container_id IS NULL OR gtm_container_id ~ '^GTM-[0-9A-Z]{4,12}$');

-- Only the platform may set it, including on insert. Owners can UPDATE their
-- own tenants row through RLS (tenants_update), so a policy alone cannot
-- protect one column; this trigger checks who is making the change.
CREATE OR REPLACE FUNCTION public.guard_tenant_gtm_container()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.gtm_container_id IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND NEW.gtm_container_id IS DISTINCT FROM OLD.gtm_container_id) THEN
    -- Allowed in exactly two cases:
    --   1. the request carries the service_role claim (the platform's API), or
    --   2. there is no request at all (no claims) and the session is a
    --      database owner, i.e. a migration or the SQL editor.
    -- Anything else is rejected.
    IF coalesce(auth.role(), '') = 'service_role'
       OR (coalesce(auth.role(), '') = ''
           AND current_user IN ('postgres', 'supabase_admin')) THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'gtm_container_id can only be set by the platform'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenants_guard_gtm ON public.tenants;
CREATE TRIGGER trg_tenants_guard_gtm
  BEFORE INSERT OR UPDATE OF gtm_container_id ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.guard_tenant_gtm_container();

COMMENT ON COLUMN public.tenants.gtm_container_id IS
  'Google Tag Manager container (GTM-XXXXXXX) loaded on the tenant''s public enrollment pages; NULL for none. Platform-set only.';
