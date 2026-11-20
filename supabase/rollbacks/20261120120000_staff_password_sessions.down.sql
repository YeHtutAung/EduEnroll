-- Run by hand only (see MIGRATIONS.md). Restores the pre-20261120120000 state.

CREATE OR REPLACE FUNCTION public.get_my_tenant_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT tenant_id FROM public.users WHERE id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS user_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM public.users WHERE id = auth.uid() LIMIT 1;
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

DROP FUNCTION IF EXISTS public.is_password_session();
