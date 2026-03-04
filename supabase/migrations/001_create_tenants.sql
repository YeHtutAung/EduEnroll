-- ============================================================
-- 001_create_tenants.sql
-- Tenants (schools / organisations using this platform)
-- ============================================================

-- Enum -------------------------------------------------------
CREATE TYPE plan_type AS ENUM ('starter', 'pro');

-- Table ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenants (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        varchar     NOT NULL,
  subdomain   varchar     NOT NULL UNIQUE,
  logo_url    text,
  currency    varchar     NOT NULL DEFAULT 'MMK',
  language    varchar     NOT NULL DEFAULT 'my+en',
  plan        plan_type   NOT NULL DEFAULT 'starter',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Indexes ----------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_tenants_subdomain ON public.tenants (subdomain);

-- ============================================================
-- Helper: resolve the calling user's tenant
-- SECURITY DEFINER so it can bypass RLS on users table during
-- the lookup without creating a circular dependency.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_my_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id
  FROM   public.users
  WHERE  id = auth.uid()
  LIMIT  1;
$$;

-- ============================================================
-- Row Level Security
-- ============================================================
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

-- SELECT: authenticated users may see only their own tenant row
CREATE POLICY "tenants_select"
  ON public.tenants
  FOR SELECT
  TO authenticated
  USING (id = public.get_my_tenant_id());

-- INSERT: any authenticated user may create a tenant (onboarding)
CREATE POLICY "tenants_insert"
  ON public.tenants
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- UPDATE: users may update only their own tenant
CREATE POLICY "tenants_update"
  ON public.tenants
  FOR UPDATE
  TO authenticated
  USING (id = public.get_my_tenant_id())
  WITH CHECK (id = public.get_my_tenant_id());
