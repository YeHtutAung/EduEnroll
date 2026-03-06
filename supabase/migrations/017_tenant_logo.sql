-- Add logo_url column to tenants table
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS logo_url TEXT;

-- Create public storage bucket for school logos
INSERT INTO storage.buckets (id, name, public)
VALUES ('school-logos', 'school-logos', true)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users to upload to school-logos bucket
CREATE POLICY "Authenticated users can upload school logos"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'school-logos');

-- Allow authenticated users to update their uploads
CREATE POLICY "Authenticated users can update school logos"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'school-logos');

-- Allow authenticated users to delete their uploads
CREATE POLICY "Authenticated users can delete school logos"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'school-logos');

-- Allow public read access to school logos
CREATE POLICY "Public can read school logos"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'school-logos');
