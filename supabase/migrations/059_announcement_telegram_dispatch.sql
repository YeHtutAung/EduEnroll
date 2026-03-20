-- Add Telegram dispatch tracking columns to announcements
ALTER TABLE announcements
  ADD COLUMN telegram_sent_count   integer NOT NULL DEFAULT 0,
  ADD COLUMN telegram_failed_count integer NOT NULL DEFAULT 0,
  ADD COLUMN dispatched_at         timestamptz;
