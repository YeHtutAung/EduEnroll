-- ─── Migration 021: Backfill form_data from legacy columns ──────────────────
-- Maps existing enrollment columns into the new form_data JSONB field.

UPDATE enrollments
SET form_data = jsonb_strip_nulls(jsonb_build_object(
  'name_en', student_name_en,
  'name_mm', student_name_mm,
  'nrc',     nrc_number,
  'phone',   phone,
  'email',   email
))
WHERE form_data IS NULL OR form_data = '{}'::jsonb;
