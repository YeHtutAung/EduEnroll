-- ─── Migration 072: Stripe payment fields ──────────────────────────────────────
-- Adds Stripe session tracking columns to payments table.
-- Extends payment_mode to support 'stripe'.

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS stripe_session_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;

CREATE INDEX IF NOT EXISTS idx_payments_stripe_session
  ON public.payments (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;

COMMENT ON COLUMN public.tenants.payment_mode IS 'bank_transfer | mmqr | stripe';
COMMENT ON COLUMN public.payments.stripe_session_id IS 'Stripe Checkout Session ID';
COMMENT ON COLUMN public.payments.stripe_payment_intent_id IS 'Stripe Payment Intent ID (set by webhook)';
