-- ============================================================
-- 064: Add payer_institution to payments table
-- Stores the bank/wallet name (e.g. KBZPay, Wave, AYA) from
-- ABank MMQR callback/enquiry institutionName field.
-- ============================================================

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS payer_institution text;

COMMENT ON COLUMN public.payments.payer_institution
  IS 'Payer bank/wallet name from ABank MMQR (institutionName)';
