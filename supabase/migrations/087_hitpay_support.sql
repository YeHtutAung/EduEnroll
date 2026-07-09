-- supabase/migrations/087_hitpay_support.sql

-- 1. Add hitpay_payment_id to payments + index for fast webhook lookups
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS hitpay_payment_id text;

CREATE INDEX IF NOT EXISTS payments_hitpay_payment_id_idx
  ON public.payments (hitpay_payment_id)
  WHERE hitpay_payment_id IS NOT NULL;

-- 2. Update comments
COMMENT ON COLUMN public.tenants.payment_mode IS
  'bank_transfer | mmqr | stripe | paypay | hitpay';

-- Both PayNow and Card sub-flows share the "hitpay" payment_method value.
COMMENT ON COLUMN public.payments.payment_method IS
  'manual_upload | abank_mmqr | mmqr | stripe | paypay | hitpay';
