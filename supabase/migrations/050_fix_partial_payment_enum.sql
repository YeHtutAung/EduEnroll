-- ─── 050: Fix partial_payment enum value ─────────────────────────────────────
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction.
-- Supabase CLI runs migrations in transactions by default, so 041's ADD VALUE
-- silently failed on some environments. This migration re-adds it.
-- The IF NOT EXISTS clause makes this safe to run even if 041 succeeded.

ALTER TYPE enrollment_status ADD VALUE IF NOT EXISTS 'partial_payment' AFTER 'payment_submitted';
