-- ─── Migration 055: Payment mode toggle ─────────────────────────────────────
-- Allows tenants to choose between bank transfer (receipt upload) or MMQR payment.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS payment_mode TEXT NOT NULL DEFAULT 'bank_transfer',
  ADD COLUMN IF NOT EXISTS mmqr_provider TEXT NOT NULL DEFAULT 'abank';

COMMENT ON COLUMN public.tenants.payment_mode IS 'bank_transfer | mmqr';
COMMENT ON COLUMN public.tenants.mmqr_provider IS 'abank | mmpay — only used when payment_mode = mmqr';
