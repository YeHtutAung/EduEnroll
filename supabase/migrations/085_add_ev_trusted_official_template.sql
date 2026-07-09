-- ─── Migration 085: Add ev-trusted-official to template_id CHECK constraint ──

ALTER TABLE public.tenant_appearance
  DROP CONSTRAINT IF EXISTS tenant_appearance_template_id_check;

ALTER TABLE public.tenant_appearance
  ADD CONSTRAINT tenant_appearance_template_id_check
  CHECK (template_id IN (
    'ls-classic', 'ls-modern', 'ls-warm',
    'ev-luxury', 'ev-festival', 'ev-corporate',
    'ev-trusted-official'
  ));
