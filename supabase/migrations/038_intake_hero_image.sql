-- Add hero banner image URL to intakes (for event enrollment page branding)
ALTER TABLE intakes ADD COLUMN IF NOT EXISTS hero_image_url TEXT;

-- Create storage bucket for intake hero images
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('intake-images', 'intake-images', true, 10485760)   -- 10 MB
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users to upload intake images
CREATE POLICY "Authenticated users can upload intake images"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'intake-images');

-- Allow authenticated users to update/replace intake images
CREATE POLICY "Authenticated users can update intake images"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'intake-images');

-- Allow authenticated users to delete intake images
CREATE POLICY "Authenticated users can delete intake images"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'intake-images');

-- Public read access for intake images
CREATE POLICY "Public can read intake images"
ON storage.objects FOR SELECT TO anon, authenticated
USING (bucket_id = 'intake-images');
