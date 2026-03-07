-- ─── Migration 022: Fix intake_form_fields RLS policy ────────────────────────
-- The FOR ALL policy needs WITH CHECK for INSERT/UPDATE to work.

DROP POLICY IF EXISTS "intake_form_fields_manage" ON intake_form_fields;

CREATE POLICY "intake_form_fields_manage"
  ON intake_form_fields FOR ALL
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
