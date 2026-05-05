-- ─── Migration 078: tenant-assets storage bucket ─────────────────────────────
-- Public bucket for tenant-uploaded images: logos and hero images.
-- Files are stored under {tenant_id}/logo/ and {tenant_id}/hero/.
-- 5 MB limit per file, JPEG/PNG/WebP only.

BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'tenant-assets',
  'tenant-assets',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;

-- Authenticated owners can upload under their own tenant_id prefix
CREATE POLICY "owner_insert_tenant_assets" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'tenant-assets'
    AND (storage.foldername(name))[1] = get_my_tenant_id()::text
  );

-- Authenticated owners can update their own assets
CREATE POLICY "owner_update_tenant_assets" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'tenant-assets'
    AND (storage.foldername(name))[1] = get_my_tenant_id()::text
  );

-- Authenticated owners can delete their own assets
CREATE POLICY "owner_delete_tenant_assets" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'tenant-assets'
    AND (storage.foldername(name))[1] = get_my_tenant_id()::text
  );

-- Public can read all assets (bucket is public)
CREATE POLICY "public_read_tenant_assets" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'tenant-assets');

COMMIT;
