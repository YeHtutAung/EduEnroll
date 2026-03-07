-- ─── Migration 020: Dynamic Form Fields ─────────────────────────────────────
-- Allows each intake to have customizable enrollment form fields.

-- Clean up partial state from failed run
DROP TABLE IF EXISTS intake_form_fields CASCADE;

-- 1) Create intake_form_fields table
CREATE TABLE intake_form_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_id UUID NOT NULL REFERENCES intakes(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  field_label TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK (field_type IN ('text', 'select', 'radio', 'file', 'date', 'checkbox', 'phone', 'address')),
  is_required BOOLEAN NOT NULL DEFAULT true,
  options JSONB,
  sort_order INT NOT NULL DEFAULT 0,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (intake_id, field_key)
);

-- RLS
ALTER TABLE intake_form_fields ENABLE ROW LEVEL SECURITY;

-- Public read (enrollment forms need to read fields)
CREATE POLICY "intake_form_fields_public_read"
  ON intake_form_fields FOR SELECT
  USING (true);

-- Owners/staff can manage form fields for their tenant's intakes
CREATE POLICY "intake_form_fields_manage"
  ON intake_form_fields FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM intakes i
      JOIN tenants t ON t.id = i.tenant_id
      JOIN users u ON u.tenant_id = t.id
      WHERE i.id = intake_form_fields.intake_id
        AND u.id = auth.uid()
        AND u.role IN ('owner', 'staff')
    )
  );

-- 2) Add form_data column to enrollments
ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS form_data JSONB DEFAULT '{}';

-- 3) Insert 5 default fields for all existing intakes
INSERT INTO intake_form_fields (intake_id, field_key, field_label, field_type, is_required, sort_order, is_default)
SELECT
  i.id,
  f.field_key,
  f.field_label,
  f.field_type,
  f.is_required,
  f.sort_order,
  true
FROM intakes i
CROSS JOIN (
  VALUES
    ('name_en',  'Name (English)',  'text',  true,  1),
    ('name_mm',  'Name (Myanmar)',  'text',  true,  2),
    ('nrc',      'NRC Number',      'text',  true,  3),
    ('phone',    'Phone Number',    'phone', true,  4),
    ('email',    'Email Address',   'text',  false, 5)
) AS f(field_key, field_label, field_type, is_required, sort_order)
ON CONFLICT (intake_id, field_key) DO NOTHING;
