-- ─── Migration 031: Change start_time / end_time from TIME to DATE ───────────
-- The UI now uses date pickers (Start Date / End Date) instead of time inputs.
-- Existing TIME values (if any) are dropped; there are none in production.

ALTER TABLE public.classes
  ALTER COLUMN start_time TYPE DATE USING NULL,
  ALTER COLUMN end_time   TYPE DATE USING NULL;
