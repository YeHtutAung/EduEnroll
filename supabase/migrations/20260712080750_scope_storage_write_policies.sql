-- ─── Migration 090: scope storage write policies to tenant folders ─────────
-- Security fix (audit #7).
--
-- The school-logos, class-images, intake-images, and qr-codes buckets granted
-- INSERT/UPDATE/DELETE to ANY authenticated user with only a `bucket_id` check.
-- Any tenant's staff could therefore overwrite or delete another tenant's logo,
-- class/hero images, and payment QR codes.
--
-- Fix: require the first path segment to equal the caller's tenant_id, mirroring
-- the tenant-assets bucket (migration 078). SELECT stays public — these buckets
-- are public so getPublicUrl keeps working. The client upload code is updated in
-- the same change to write tenant-prefixed paths for class-images and qr-codes
-- (school-logos and intake-images were already tenant-prefixed).
--
-- Note on legacy objects: pre-existing class-images (intake-prefixed) and
-- qr-codes (flat) files stay publicly readable but are no longer writable from
-- the client. This is not a used flow — class-image edits upload a fresh path
-- (an INSERT, not an overwrite) and qr-code deletion runs through a service-role
-- admin route — so nothing breaks.

BEGIN;

-- ── school-logos ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Authenticated users can upload school logos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update school logos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete school logos" ON storage.objects;

CREATE POLICY "school_logos_insert_own_tenant" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'school-logos'
    AND (storage.foldername(name))[1] = get_my_tenant_id()::text
  );
CREATE POLICY "school_logos_update_own_tenant" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'school-logos'
    AND (storage.foldername(name))[1] = get_my_tenant_id()::text
  );
CREATE POLICY "school_logos_delete_own_tenant" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'school-logos'
    AND (storage.foldername(name))[1] = get_my_tenant_id()::text
  );

-- ── class-images ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Authenticated users can upload class images" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update class images" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete class images" ON storage.objects;

CREATE POLICY "class_images_insert_own_tenant" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'class-images'
    AND (storage.foldername(name))[1] = get_my_tenant_id()::text
  );
CREATE POLICY "class_images_update_own_tenant" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'class-images'
    AND (storage.foldername(name))[1] = get_my_tenant_id()::text
  );
CREATE POLICY "class_images_delete_own_tenant" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'class-images'
    AND (storage.foldername(name))[1] = get_my_tenant_id()::text
  );

-- ── intake-images ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Authenticated users can upload intake images" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update intake images" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete intake images" ON storage.objects;

CREATE POLICY "intake_images_insert_own_tenant" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'intake-images'
    AND (storage.foldername(name))[1] = get_my_tenant_id()::text
  );
CREATE POLICY "intake_images_update_own_tenant" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'intake-images'
    AND (storage.foldername(name))[1] = get_my_tenant_id()::text
  );
CREATE POLICY "intake_images_delete_own_tenant" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'intake-images'
    AND (storage.foldername(name))[1] = get_my_tenant_id()::text
  );

-- ── qr-codes ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Authenticated users can upload QR codes" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update QR codes" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete QR codes" ON storage.objects;

CREATE POLICY "qr_codes_insert_own_tenant" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'qr-codes'
    AND (storage.foldername(name))[1] = get_my_tenant_id()::text
  );
CREATE POLICY "qr_codes_update_own_tenant" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'qr-codes'
    AND (storage.foldername(name))[1] = get_my_tenant_id()::text
  );
CREATE POLICY "qr_codes_delete_own_tenant" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'qr-codes'
    AND (storage.foldername(name))[1] = get_my_tenant_id()::text
  );

COMMIT;
