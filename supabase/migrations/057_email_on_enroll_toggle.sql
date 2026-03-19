-- ─── Migration 057: Add email_on_enroll toggle to tenants ───────────────────
-- Allows tenants to disable the enrollment confirmation email (email #1).
-- Default false to conserve email quota on free Resend plans.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS email_on_enroll BOOLEAN NOT NULL DEFAULT false;
