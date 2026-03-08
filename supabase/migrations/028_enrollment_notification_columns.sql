-- ─── Migration 028: Add notification + rejection columns ─────────────────────
-- status_notified_at: tracks when the student was last notified of status change
-- rejection_reason:   optional reason for enrollment rejection

ALTER TABLE public.enrollments
  ADD COLUMN IF NOT EXISTS status_notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason   text;
