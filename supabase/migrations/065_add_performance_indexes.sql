-- 065_add_performance_indexes.sql
--
-- Adds missing indexes to improve query performance on frequently filtered columns.
-- All indexes use IF NOT EXISTS — safe to run on live databases.
-- Non-blocking: Supabase/Postgres builds these without locking reads or writes.

-- 1. enrollments: partial index for Telegram dispatch and stats queries
--    Covers: WHERE telegram_chat_id IS NOT NULL (filters linked students only)
CREATE INDEX IF NOT EXISTS idx_enrollments_tenant_telegram
  ON public.enrollments(tenant_id)
  WHERE telegram_chat_id IS NOT NULL;

-- 2. announcements: composite index for dispatch recipient query
--    Covers: WHERE tenant_id = ? AND intake_id = ? AND class_level = ?
CREATE INDEX IF NOT EXISTS idx_announcements_tenant_intake_level
  ON public.announcements(tenant_id, intake_id, class_level);
