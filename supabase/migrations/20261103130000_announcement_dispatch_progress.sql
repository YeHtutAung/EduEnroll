-- Records how far a Telegram announcement got.
--
-- dispatched_at now means the send was claimed, not that it finished. A row with
-- dispatched_at set and dispatch_completed_at null was cut off or is still running,
-- and telegram_recipient_count shows how many it was meant to reach.
ALTER TABLE public.announcements
  ADD COLUMN telegram_recipient_count integer NOT NULL DEFAULT 0,
  ADD COLUMN dispatch_completed_at    timestamptz;

-- Rows from before this were written once, at the end of the send.
UPDATE public.announcements
SET dispatch_completed_at    = dispatched_at,
    telegram_recipient_count = telegram_sent_count + telegram_failed_count
WHERE dispatched_at IS NOT NULL;
