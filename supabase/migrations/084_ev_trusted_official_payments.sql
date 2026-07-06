-- 084_ev_trusted_official_payments.sql
-- Adds Stripe PaymentIntent tracking + card details to payments table

ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS card_brand text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS card_last4 text;

CREATE INDEX IF NOT EXISTS payments_stripe_payment_intent_id_idx
  ON payments(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
