-- ─── Sprint 9: One-time token for secure Telegram linking ────────────────────

ALTER TABLE public.enrollments
  ADD COLUMN IF NOT EXISTS telegram_link_token text,
  ADD COLUMN IF NOT EXISTS telegram_link_token_expires_at timestamptz;

-- Index for fast token lookup
CREATE INDEX IF NOT EXISTS idx_enrollments_telegram_link_token
  ON public.enrollments (telegram_link_token)
  WHERE telegram_link_token IS NOT NULL;
