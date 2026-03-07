-- ─── Migration 023: Change class level from ENUM to TEXT ─────────────────────
-- Allows custom class levels beyond the standard N5–N1.
-- No data loss — existing N5–N1 values remain valid.

ALTER TABLE classes ALTER COLUMN level TYPE TEXT USING level::TEXT;
