-- ─── Migration 030: Allow custom class levels in announcements ───────────────
-- Change class_level from jlpt_level enum to TEXT to support custom ticket types.

ALTER TABLE public.announcements
  ALTER COLUMN class_level TYPE TEXT USING class_level::TEXT;
