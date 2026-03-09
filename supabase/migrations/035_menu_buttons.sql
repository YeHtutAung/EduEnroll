-- 035: Add menu_buttons JSONB column to tenants
-- Shape: [{ "key": "OPEN_INTAKES", "title": "📚 Open Intakes", "visible": true }, ...]
-- NULL = use hard-coded ORG_LABELS defaults from responses.ts

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS menu_buttons jsonb DEFAULT NULL;
