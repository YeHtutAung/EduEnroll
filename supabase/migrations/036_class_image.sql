-- Add optional image_url column to classes table (for ticket type images)
ALTER TABLE classes ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Create public storage bucket for class/ticket images
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'class-images',
  'class-images',
  true,
  5242880,  -- 5 MB
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users to upload class images
CREATE POLICY "Authenticated users can upload class images"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'class-images');

-- Allow authenticated users to update class images
CREATE POLICY "Authenticated users can update class images"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'class-images');

-- Allow authenticated users to delete class images
CREATE POLICY "Authenticated users can delete class images"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'class-images');

-- Allow public read access to class images
CREATE POLICY "Public can read class images"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'class-images');
