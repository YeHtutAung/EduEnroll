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

-- Revenue guard: refuse callers that have no staff role (for example an email-code session).
create or replace function public.get_tenant_revenue(p_tenant_id uuid)
returns bigint
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_total bigint;
begin
  -- The service role (server-side callers such as the bot path of requireAuth)
  -- is trusted as before; any other caller without a staff role is refused.
  -- With <> a NULL role would have skipped the check.
  if coalesce(auth.role(), '') <> 'service_role'
     and public.get_my_role() is distinct from 'superadmin'
     and p_tenant_id is distinct from public.get_my_tenant_id() then
    raise exception 'not authorized to read revenue for this tenant'
      using errcode = '42501';
  end if;

  select coalesce(sum(p.amount), 0)
  into v_total
  from public.payments p
  join public.enrollments e on e.id = p.enrollment_id
  where p.tenant_id = p_tenant_id
    and p.status = 'verified'
    and e.status = 'confirmed'
    and e.internal_test_at is null;

  return v_total;
end;
$$;

grant execute on function public.get_tenant_revenue(uuid) to authenticated;
