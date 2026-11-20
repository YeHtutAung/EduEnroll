-- Run by hand only (see MIGRATIONS.md). Restores the pre-20261120120000 state.

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

DROP POLICY IF EXISTS "class_channels_select" ON public.class_channels;
DROP POLICY IF EXISTS "class_channels_insert" ON public.class_channels;
DROP POLICY IF EXISTS "class_channels_update" ON public.class_channels;
DROP POLICY IF EXISTS "class_channels_delete" ON public.class_channels;
CREATE POLICY "class_channels_select" ON public.class_channels
  FOR SELECT USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));
CREATE POLICY "class_channels_insert" ON public.class_channels
  FOR INSERT WITH CHECK (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));
CREATE POLICY "class_channels_update" ON public.class_channels
  FOR UPDATE USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));
CREATE POLICY "class_channels_delete" ON public.class_channels
  FOR DELETE USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));

DROP POLICY IF EXISTS "intake_form_fields_manage" ON public.intake_form_fields;
CREATE POLICY "intake_form_fields_manage"
  ON public.intake_form_fields FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM intakes i
      JOIN tenants t ON t.id = i.tenant_id
      JOIN users u ON u.tenant_id = t.id
      WHERE i.id = intake_form_fields.intake_id
        AND u.id = auth.uid()
        AND u.role IN ('owner', 'staff')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM intakes i
      JOIN tenants t ON t.id = i.tenant_id
      JOIN users u ON u.tenant_id = t.id
      WHERE i.id = intake_form_fields.intake_id
        AND u.id = auth.uid()
        AND u.role IN ('owner', 'staff')
    )
  );

-- Original get_tenant_revenue guard (as in 20260723120000).
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
  if public.get_my_role() <> 'superadmin'
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

DROP FUNCTION IF EXISTS public.is_password_session();
