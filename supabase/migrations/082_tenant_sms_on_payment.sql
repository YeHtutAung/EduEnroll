-- ─── Migration 082: Tenant SMS toggle ────────────────────────────────────────
-- Adds a per-tenant flag to enable/disable SMS on payment verification.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS sms_on_payment BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.tenants.sms_on_payment IS 'Send SMS to student when payment is verified';
