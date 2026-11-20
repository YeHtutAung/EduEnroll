-- ─── Staff database access only from a password sign-in ─────────────────────
-- Buyers will sign in with an email code (account-bound tickets spec §4.1).
-- Email codes work for every account in the project, staff included, so the
-- staff helpers must not answer for a session that was not a password sign-in.
-- Supabase puts the sign-in method in the JWT's amr claim, normally
-- [{"method":"password","timestamp":…}]; the plain-string form is accepted too.

CREATE OR REPLACE FUNCTION public.is_password_session()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(
    (auth.jwt() -> 'amr') @> '[{"method":"password"}]'::jsonb
    OR (auth.jwt() -> 'amr') @> '["password"]'::jsonb,
    false
  );
$$;

-- Called directly by intake_form_fields_manage (no TO clause), so every API
-- role runs it with its own rights. Grant explicitly rather than rely on
-- default privileges.
GRANT EXECUTE ON FUNCTION public.is_password_session() TO anon, authenticated, service_role;

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
    AND  public.is_password_session()
  LIMIT  1;
$$;

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
    AND  public.is_password_session()
  LIMIT  1;
$$;

-- These four read public.users directly instead of using the helpers.
DROP POLICY IF EXISTS "class_channels_select" ON public.class_channels;
DROP POLICY IF EXISTS "class_channels_insert" ON public.class_channels;
DROP POLICY IF EXISTS "class_channels_update" ON public.class_channels;
DROP POLICY IF EXISTS "class_channels_delete" ON public.class_channels;

CREATE POLICY "class_channels_select" ON public.class_channels
  FOR SELECT USING (tenant_id = public.get_my_tenant_id());
CREATE POLICY "class_channels_insert" ON public.class_channels
  FOR INSERT WITH CHECK (tenant_id = public.get_my_tenant_id());
CREATE POLICY "class_channels_update" ON public.class_channels
  FOR UPDATE USING (tenant_id = public.get_my_tenant_id());
CREATE POLICY "class_channels_delete" ON public.class_channels
  FOR DELETE USING (tenant_id = public.get_my_tenant_id());

DROP POLICY IF EXISTS "intake_form_fields_manage" ON public.intake_form_fields;
CREATE POLICY "intake_form_fields_manage"
  ON public.intake_form_fields FOR ALL
  USING (
    public.is_password_session()
    AND EXISTS (
      SELECT 1 FROM public.intakes i
      JOIN public.tenants t ON t.id = i.tenant_id
      JOIN public.users u ON u.tenant_id = t.id
      WHERE i.id = intake_form_fields.intake_id
        AND u.id = auth.uid()
        AND u.role IN ('owner', 'staff')
    )
  )
  WITH CHECK (
    public.is_password_session()
    AND EXISTS (
      SELECT 1 FROM public.intakes i
      JOIN public.tenants t ON t.id = i.tenant_id
      JOIN public.users u ON u.tenant_id = t.id
      WHERE i.id = intake_form_fields.intake_id
        AND u.id = auth.uid()
        AND u.role IN ('owner', 'staff')
    )
  );
