-- ─── Migration 054: Add 'awaiting_payment' to payment_status enum ────────────
-- When a QR code is generated (ABank/MMPay), we create a payment record to track
-- the orderId, but the student hasn't paid yet. Using 'pending' triggers
-- fn_payments_sync_enrollment() which prematurely sets enrollment to
-- 'payment_submitted'. The new 'awaiting_payment' status avoids this.

ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'awaiting_payment' BEFORE 'pending';
