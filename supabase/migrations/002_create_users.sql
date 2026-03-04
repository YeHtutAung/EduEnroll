-- ============================================================
-- 002_create_users.sql
-- Application users — linked to Supabase auth.users
-- ============================================================

-- Enum -------------------------------------------------------
CREATE TYPE user_role AS ENUM ('owner', 'admin', 'student');

-- Table ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.users (
  id          uuid        PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  tenant_id   uuid        NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  email       varchar     NOT NULL,
  role        user_role   NOT NULL DEFAULT 'student',
  full_name   varchar,
  phone       varchar,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Indexes ----------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON public.users (tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_email     ON public.users (email);

-- ============================================================
-- Row Level Security
-- ============================================================
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- SELECT: see only users in the same tenant
CREATE POLICY "users_select"
  ON public.users
  FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_my_tenant_id());

-- INSERT: may only insert users into own tenant
CREATE POLICY "users_insert"
  ON public.users
  FOR INSERT
  TO authenticated
  WITH CHECK (tenant_id = public.get_my_tenant_id());

-- UPDATE: may only update users in own tenant
CREATE POLICY "users_update"
  ON public.users
  FOR UPDATE
  TO authenticated
  USING   (tenant_id = public.get_my_tenant_id())
  WITH CHECK (tenant_id = public.get_my_tenant_id());
