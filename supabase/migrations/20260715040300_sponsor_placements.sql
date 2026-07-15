-- Configurable sponsor placements for the Trusted Official event flow.
-- The JSON shape is { presenting, partners, supported_by }; each sponsor accepts
-- name, optional logo_url, optional url, and optional placeholder mark styling.

ALTER TABLE public.tenant_appearance
  ADD COLUMN IF NOT EXISTS sponsor_config jsonb;

COMMENT ON COLUMN public.tenant_appearance.sponsor_config IS
  'Trusted Official sponsor placements: presenting sponsor, partner wall, and supported-by sponsors.';
