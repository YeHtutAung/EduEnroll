-- ─── 069: Telegram per-tenant feature flags ───────────────────────────────────
-- Replaces org_type === "language_school" hardcoding with configurable flags.

ALTER TABLE public.tenant_telegram_configs
  ADD COLUMN IF NOT EXISTS enable_join_requests  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS enable_phone_flow     boolean NOT NULL DEFAULT false;

-- Backfill: existing language_school tenants keep identical behaviour
UPDATE public.tenant_telegram_configs tc
SET
  enable_join_requests = true,
  enable_phone_flow    = true
FROM public.tenants t
WHERE tc.tenant_id = t.id
  AND t.org_type = 'language_school';
