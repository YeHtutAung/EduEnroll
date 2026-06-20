-- Migration 083: PayPay payment gateway support
-- Adds PayPay-specific columns to payments table.

-- 1. Add paypay columns to payments table
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS paypay_code_id TEXT,
  ADD COLUMN IF NOT EXISTS paypay_status TEXT;

COMMENT ON COLUMN public.payments.paypay_code_id IS 'PayPay codeId returned from POST /v2/codes';
COMMENT ON COLUMN public.payments.paypay_status IS 'CREATED | COMPLETED | EXPIRED | CANCELED | FAILED';

-- 2. Add index for webhook lookups by paypay_code_id
CREATE INDEX IF NOT EXISTS idx_payments_paypay_code_id ON public.payments (paypay_code_id) WHERE paypay_code_id IS NOT NULL;

-- 3. Update payment_mode comment to include paypay
COMMENT ON COLUMN public.tenants.payment_mode IS 'bank_transfer | mmqr | stripe | paypay';
