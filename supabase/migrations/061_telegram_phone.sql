-- ─── Sprint 9: Store Telegram phone number on enrollment ─────────────────────

ALTER TABLE public.enrollments
  ADD COLUMN IF NOT EXISTS telegram_phone text;
