-- ============================================================
-- 009_create_storage_bucket.sql
-- Supabase Storage bucket for payment proof images
--
-- Private bucket — files are never publicly accessible.
-- Access is controlled via signed URLs generated server-side.
-- ============================================================

-- ── Create bucket ─────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'payment-proofs',
  'payment-proofs',
  false,                                               -- private
  5242880,                                             -- 5 MB
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
  SET
    public             = false,
    file_size_limit    = 5242880,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

-- ── Storage RLS policies ──────────────────────────────────────
-- The Next.js upload API uses the service-role key, which bypasses
-- RLS entirely.  These policies are for the Supabase dashboard and
-- any future admin tooling that uses the anon/authenticated key.

-- Authenticated admin staff may read proofs for their own tenant.
-- Path structure: {tenant_id}/{enrollment_ref}/{timestamp}.ext
-- → first path segment is the tenant_id.
CREATE POLICY "admins_read_payment_proofs"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'payment-proofs'
    AND (string_to_array(name, '/'))[1] = public.get_my_tenant_id()::text
  );

-- Authenticated admin staff may delete proofs for their own tenant
-- (e.g. to remove fraudulent uploads).
CREATE POLICY "admins_delete_payment_proofs"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'payment-proofs'
    AND (string_to_array(name, '/'))[1] = public.get_my_tenant_id()::text
  );
