-- ─── Migration 077: tenant_appearance ────────────────────────────────────────
-- Stores per-tenant enrollment page appearance: template choice + customizations.
-- One row per tenant (UNIQUE constraint). Anon SELECT for public enrollment pages.

BEGIN;

CREATE TABLE tenant_appearance (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id     text        NOT NULL DEFAULT 'minimal'
                              CHECK (template_id IN ('minimal', 'bold', 'warm', 'professional')),
  primary_color   text        NOT NULL DEFAULT '#2563eb',
  tagline         text,
  cta_button_text text        NOT NULL DEFAULT 'Enroll Now',
  logo_url        text,
  hero_url        text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id)
);

ALTER TABLE tenant_appearance ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_manage_appearance" ON tenant_appearance
  FOR ALL TO authenticated
  USING  (tenant_id = get_my_tenant_id())
  WITH CHECK (tenant_id = get_my_tenant_id());

CREATE POLICY "public_read_appearance" ON tenant_appearance
  FOR SELECT TO anon
  USING (true);

GRANT SELECT ON tenant_appearance TO anon;
GRANT ALL    ON tenant_appearance TO authenticated;

COMMIT;
