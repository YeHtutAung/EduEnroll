-- ─── Migration 024: Org type and custom label columns ────────────────────────
-- Labels default to language school terminology.

ALTER TABLE tenants
  ADD COLUMN org_type      TEXT NOT NULL DEFAULT 'language_school',
  ADD COLUMN label_intake  TEXT NOT NULL DEFAULT 'Intake',
  ADD COLUMN label_class   TEXT NOT NULL DEFAULT 'Class Type',
  ADD COLUMN label_student TEXT NOT NULL DEFAULT 'Student',
  ADD COLUMN label_seat    TEXT NOT NULL DEFAULT 'Seat',
  ADD COLUMN label_fee     TEXT NOT NULL DEFAULT 'Fee';
