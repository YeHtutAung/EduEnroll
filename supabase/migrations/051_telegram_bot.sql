-- ─── 051: Telegram bot integration ───────────────────────────────────────────
-- Adds Telegram bot support per tenant + chat_id linking on enrollments.

-- 1. Tenant-level Telegram config
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS telegram_enabled        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS telegram_bot_token       text,
  ADD COLUMN IF NOT EXISTS telegram_bot_username    text,
  ADD COLUMN IF NOT EXISTS telegram_webhook_secret  text;

-- 2. Link Telegram chat_id to enrollments
ALTER TABLE public.enrollments
  ADD COLUMN IF NOT EXISTS telegram_chat_id text;
