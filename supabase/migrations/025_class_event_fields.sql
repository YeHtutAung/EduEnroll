-- ─── Migration 025: Optional date/time and venue per class ──────────────────
-- Hidden for language schools, shown for events/workshops.

ALTER TABLE classes
  ADD COLUMN event_date  DATE,
  ADD COLUMN start_time  TIME,
  ADD COLUMN end_time    TIME,
  ADD COLUMN venue       TEXT;
