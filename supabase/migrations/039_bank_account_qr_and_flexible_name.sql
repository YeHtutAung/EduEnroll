-- ─── 039: Bank account QR codes + flexible bank names ───────────────────────
-- 1. Convert bank_name from myanmar_bank enum to free-text
-- 2. Add qr_code_url column for QR code images
-- 3. Create qr-codes storage bucket (public, for anonymous access)

BEGIN;

-- ── 1. Convert bank_name to text ─────────────────────────────────────────────
ALTER TABLE bank_accounts ALTER COLUMN bank_name TYPE text USING bank_name::text;
DROP TYPE IF EXISTS myanmar_bank;

-- ── 2. Add qr_code_url column ────────────────────────────────────────────────
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS qr_code_url text;

-- ── 3. Storage bucket for QR code images ─────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('qr-codes', 'qr-codes', true)
ON CONFLICT (id) DO NOTHING;

-- Authenticated users can upload/update/delete QR codes
CREATE POLICY "Authenticated users can upload QR codes"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'qr-codes');

CREATE POLICY "Authenticated users can update QR codes"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'qr-codes');

CREATE POLICY "Authenticated users can delete QR codes"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'qr-codes');

-- Anyone can view QR codes (students on payment page)
CREATE POLICY "Public can view QR codes"
  ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'qr-codes');

COMMIT;
