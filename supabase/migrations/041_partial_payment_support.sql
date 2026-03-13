-- ─── 041: Partial payment support ──────────────────────────────────────────
-- Adds 'partial_payment' enrollment status, multiple proof images per payment,
-- and admin note / received amount fields for partial payment workflow.

-- 1. Add 'partial_payment' to enrollment_status enum
ALTER TYPE enrollment_status ADD VALUE IF NOT EXISTS 'partial_payment' AFTER 'payment_submitted';

-- 2. Add proof_image_urls array column (replaces single proof_image_url)
ALTER TABLE payments ADD COLUMN IF NOT EXISTS proof_image_urls text[] DEFAULT '{}';

-- 3. Migrate existing proof_image_url data into the array
UPDATE payments
  SET proof_image_urls = ARRAY[proof_image_url]
  WHERE proof_image_url IS NOT NULL
    AND (proof_image_urls IS NULL OR proof_image_urls = '{}');

-- 4. Add admin_note for partial payment communication
ALTER TABLE payments ADD COLUMN IF NOT EXISTS admin_note text;

-- 5. Add received_amount for tracking partial payment
ALTER TABLE payments ADD COLUMN IF NOT EXISTS received_amount_mmk integer;

-- 6. Update the trigger function to also handle 'partial_payment' → 'payment_submitted'
-- when a new proof image is uploaded for a partial payment enrollment
CREATE OR REPLACE FUNCTION fn_payments_sync_enrollment()
RETURNS trigger AS $$
BEGIN
  -- When a payment is inserted with status='pending',
  -- advance enrollment to 'payment_submitted'
  IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
    UPDATE enrollments
      SET status = 'payment_submitted'
      WHERE id = NEW.enrollment_id
        AND status IN ('pending_payment', 'partial_payment');
  END IF;

  -- When payment status changes to 'verified', confirm enrollment
  IF TG_OP = 'UPDATE' AND OLD.status != 'verified' AND NEW.status = 'verified' THEN
    UPDATE enrollments
      SET status = 'confirmed'
      WHERE id = NEW.enrollment_id;
  END IF;

  -- When payment status changes to 'rejected', reject enrollment
  IF TG_OP = 'UPDATE' AND OLD.status != 'rejected' AND NEW.status = 'rejected' THEN
    UPDATE enrollments
      SET status = 'rejected'
      WHERE id = NEW.enrollment_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
