-- ─── 068: Split Telegram config into tenant_telegram_configs ──────────────────
-- Moves telegram_* columns off the tenants table into a dedicated config table.
-- Also replaces the tenant_bot_admins table (067) with the allowed_chat_ids array.

-- ── 1. Create the new table ───────────────────────────────────────────────────

CREATE TABLE public.tenant_telegram_configs (
  tenant_id        uuid        PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  bot_token        text,                   -- AES-256-GCM encrypted
  bot_username     text,
  webhook_secret   text,
  allowed_chat_ids bigint[],              -- whitelist of admin Telegram chat IDs
  enabled          boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ── 2. Migrate existing data from tenants ─────────────────────────────────────

INSERT INTO public.tenant_telegram_configs (tenant_id, bot_token, bot_username, webhook_secret, enabled)
SELECT
  id,
  telegram_bot_token,
  telegram_bot_username,
  telegram_webhook_secret,
  telegram_enabled
FROM public.tenants
WHERE telegram_bot_token     IS NOT NULL
   OR telegram_bot_username   IS NOT NULL
   OR telegram_webhook_secret IS NOT NULL
   OR telegram_enabled        = true;

-- ── 3. Drop old telegram columns from tenants ─────────────────────────────────

ALTER TABLE public.tenants
  DROP COLUMN IF EXISTS telegram_enabled,
  DROP COLUMN IF EXISTS telegram_bot_token,
  DROP COLUMN IF EXISTS telegram_bot_username,
  DROP COLUMN IF EXISTS telegram_webhook_secret;

-- ── 4. Drop tenant_bot_admins (superseded by allowed_chat_ids array) ──────────

DROP TABLE IF EXISTS public.tenant_bot_admins;

-- ── 5. updated_at trigger ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_telegram_configs_updated_at
  BEFORE UPDATE ON public.tenant_telegram_configs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 6. RLS ────────────────────────────────────────────────────────────────────

ALTER TABLE public.tenant_telegram_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "telegram_configs: members can read own"
  ON public.tenant_telegram_configs FOR SELECT
  USING (tenant_id = get_my_tenant_id());

CREATE POLICY "telegram_configs: members can insert own"
  ON public.tenant_telegram_configs FOR INSERT
  WITH CHECK (tenant_id = get_my_tenant_id());

CREATE POLICY "telegram_configs: members can update own"
  ON public.tenant_telegram_configs FOR UPDATE
  USING (tenant_id = get_my_tenant_id());

CREATE POLICY "telegram_configs: members can delete own"
  ON public.tenant_telegram_configs FOR DELETE
  USING (tenant_id = get_my_tenant_id());
