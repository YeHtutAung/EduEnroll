-- Add stable slug column to intakes (set once on creation, survives name edits)
ALTER TABLE intakes ADD COLUMN IF NOT EXISTS slug TEXT;

-- Populate existing rows: first word of name (lowercased) + year
UPDATE intakes SET slug = LOWER(SPLIT_PART(name, ' ', 1)) || '-' || year WHERE slug IS NULL;

-- Unique per tenant so public lookup is unambiguous
CREATE UNIQUE INDEX IF NOT EXISTS idx_intakes_tenant_slug ON intakes(tenant_id, slug);
