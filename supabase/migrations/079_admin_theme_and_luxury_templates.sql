-- ============================================================
-- 079_admin_theme_and_luxury_templates.sql
-- 1. Add admin_theme column to tenant_appearance
-- 2. Update template_id CHECK constraint to luxury template IDs
-- ============================================================

-- Step 1: Add admin_theme column (controls admin portal look)
ALTER TABLE public.tenant_appearance
  ADD COLUMN IF NOT EXISTS admin_theme varchar NOT NULL DEFAULT 'professional';

ALTER TABLE public.tenant_appearance
  DROP CONSTRAINT IF EXISTS tenant_appearance_admin_theme_check;

ALTER TABLE public.tenant_appearance
  ADD CONSTRAINT tenant_appearance_admin_theme_check
  CHECK (admin_theme IN ('minimal', 'bold', 'warm', 'professional'));

-- Step 2: Drop old template_id CHECK constraint
ALTER TABLE public.tenant_appearance
  DROP CONSTRAINT IF EXISTS tenant_appearance_template_id_check;

-- Step 3: Backfill existing rows to a valid new template_id before adding constraint
UPDATE public.tenant_appearance
  SET template_id = 'ls-classic'
  WHERE template_id IN ('minimal', 'bold', 'warm', 'professional');

-- Step 4: Add new CHECK constraint for luxury template IDs
ALTER TABLE public.tenant_appearance
  ADD CONSTRAINT tenant_appearance_template_id_check
  CHECK (template_id IN ('ls-classic', 'ls-modern', 'ls-warm', 'ev-luxury', 'ev-festival', 'ev-corporate'));
