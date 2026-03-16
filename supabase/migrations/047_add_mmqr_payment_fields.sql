-- ============================================================
-- 047: Add MMQR payment fields to payments table
-- Supports MyanMyanPay MMQR integration alongside manual upload
-- ============================================================

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS payment_ref      text,
  ADD COLUMN IF NOT EXISTS payment_method   text,
  ADD COLUMN IF NOT EXISTS mmqr_status      text DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS paid_at          timestamptz;

CREATE INDEX IF NOT EXISTS idx_payments_payment_ref ON public.payments (payment_ref);

COMMENT ON COLUMN public.payments.payment_ref    IS 'MyanMyanPay order ID (e.g. KNY-{tenant}-{enrollment}-{ts})';
COMMENT ON COLUMN public.payments.payment_method IS 'Payment method: manual_upload | mmqr';
COMMENT ON COLUMN public.payments.mmqr_status    IS 'MMQR status from webhook: PENDING | SUCCESS | FAILED | REFUNDED';
COMMENT ON COLUMN public.payments.paid_at        IS 'Timestamp when MMQR payment was confirmed via webhook';
