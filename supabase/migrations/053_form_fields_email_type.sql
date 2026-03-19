-- ─── Migration 053: Add 'email' to intake_form_fields field_type check ───────

ALTER TABLE intake_form_fields
  DROP CONSTRAINT intake_form_fields_field_type_check;

ALTER TABLE intake_form_fields
  ADD CONSTRAINT intake_form_fields_field_type_check
  CHECK (field_type IN ('text', 'email', 'select', 'radio', 'file', 'date', 'checkbox', 'phone', 'address'));
