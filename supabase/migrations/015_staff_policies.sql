-- ============================================================
-- 015_staff_policies.sql
-- Role-based RLS restrictions, staff invites table, and
-- get_my_role() helper. Runs after 014 commits the new enum values.
-- ============================================================

-- ── 0. Ensure pgcrypto is available for gen_random_bytes() ───
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ── 1. Helper function: get caller's role ────────────────────
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS user_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role
  FROM   public.users
  WHERE  id = auth.uid()
  LIMIT  1;
$$;

-- ── 2. Staff invite tokens table ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.staff_invites (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  email       varchar     NOT NULL,
  token       varchar     NOT NULL UNIQUE DEFAULT encode(extensions.gen_random_bytes(32), 'hex'),
  invited_by  uuid        REFERENCES public.users (id) ON DELETE SET NULL,
  accepted_at timestamptz,
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_staff_invites_token     ON public.staff_invites (token);
CREATE INDEX IF NOT EXISTS idx_staff_invites_tenant_id ON public.staff_invites (tenant_id);

ALTER TABLE public.staff_invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "staff_invites_select"
  ON public.staff_invites FOR SELECT TO authenticated
  USING (tenant_id = public.get_my_tenant_id());

CREATE POLICY "staff_invites_insert"
  ON public.staff_invites FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = public.get_my_tenant_id()
    AND public.get_my_role() IN ('superadmin', 'owner')
  );

-- ── 3. Restrict bank_accounts for staff ──────────────────────
DROP POLICY IF EXISTS "bank_accounts_insert" ON public.bank_accounts;
CREATE POLICY "bank_accounts_insert"
  ON public.bank_accounts FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = public.get_my_tenant_id()
    AND public.get_my_role() IN ('superadmin', 'owner')
  );

DROP POLICY IF EXISTS "bank_accounts_update" ON public.bank_accounts;
CREATE POLICY "bank_accounts_update"
  ON public.bank_accounts FOR UPDATE TO authenticated
  USING (
    tenant_id = public.get_my_tenant_id()
    AND public.get_my_role() IN ('superadmin', 'owner')
  )
  WITH CHECK (
    tenant_id = public.get_my_tenant_id()
    AND public.get_my_role() IN ('superadmin', 'owner')
  );

DROP POLICY IF EXISTS "bank_accounts_delete" ON public.bank_accounts;
CREATE POLICY "bank_accounts_delete"
  ON public.bank_accounts FOR DELETE TO authenticated
  USING (
    tenant_id = public.get_my_tenant_id()
    AND public.get_my_role() IN ('superadmin', 'owner')
  );

-- ── 4. Restrict tenants UPDATE for staff ─────────────────────
DROP POLICY IF EXISTS "tenants_update" ON public.tenants;
CREATE POLICY "tenants_update"
  ON public.tenants FOR UPDATE TO authenticated
  USING (
    id = public.get_my_tenant_id()
    AND public.get_my_role() IN ('superadmin', 'owner')
  )
  WITH CHECK (
    id = public.get_my_tenant_id()
    AND public.get_my_role() IN ('superadmin', 'owner')
  );

-- ── 5. Restrict users table for staff ────────────────────────
DROP POLICY IF EXISTS "users_select" ON public.users;
CREATE POLICY "users_select"
  ON public.users FOR SELECT TO authenticated
  USING (
    tenant_id = public.get_my_tenant_id()
    AND (
      public.get_my_role() IN ('superadmin', 'owner')
      OR id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "users_insert" ON public.users;
CREATE POLICY "users_insert"
  ON public.users FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = public.get_my_tenant_id()
    AND public.get_my_role() IN ('superadmin', 'owner')
  );

DROP POLICY IF EXISTS "users_update" ON public.users;
CREATE POLICY "users_update"
  ON public.users FOR UPDATE TO authenticated
  USING (
    tenant_id = public.get_my_tenant_id()
    AND (
      public.get_my_role() IN ('superadmin', 'owner')
      OR id = auth.uid()
    )
  )
  WITH CHECK (
    tenant_id = public.get_my_tenant_id()
    AND (
      public.get_my_role() IN ('superadmin', 'owner')
      OR id = auth.uid()
    )
  );
