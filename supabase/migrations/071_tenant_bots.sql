-- ─── 071: tenant_bots — unified bot registry ─────────────────────────────────
-- Each row is one Telegram bot for a tenant. bot_type identifies the purpose.
-- Replaces bot_token, bot_username, webhook_secret columns on tenant_telegram_configs.

-- ── 1. Create tenant_bots ─────────────────────────────────────────────────────

CREATE TABLE public.tenant_bots (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  bot_type        text        NOT NULL,  -- 'enrollment' | 'support'
  bot_token       text,                  -- AES-256-GCM encrypted
  bot_username    text,
  webhook_secret  text,
  enabled         boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, bot_type)
);

-- ── 2. Migrate existing enrollment bot data ───────────────────────────────────

INSERT INTO public.tenant_bots (tenant_id, bot_type, bot_token, bot_username, webhook_secret, enabled)
SELECT tenant_id, 'enrollment', bot_token, bot_username, webhook_secret, enabled
FROM public.tenant_telegram_configs
WHERE bot_token IS NOT NULL OR bot_username IS NOT NULL OR webhook_secret IS NOT NULL;

-- ── 3. Drop migrated columns from tenant_telegram_configs ─────────────────────

ALTER TABLE public.tenant_telegram_configs
  DROP COLUMN IF EXISTS bot_token,
  DROP COLUMN IF EXISTS bot_username,
  DROP COLUMN IF EXISTS webhook_secret;

-- ── 4. updated_at trigger ─────────────────────────────────────────────────────

CREATE TRIGGER tenant_bots_updated_at
  BEFORE UPDATE ON public.tenant_bots
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 5. RLS ────────────────────────────────────────────────────────────────────

ALTER TABLE public.tenant_bots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_bots: members can read own"
  ON public.tenant_bots FOR SELECT
  USING (tenant_id = get_my_tenant_id());

CREATE POLICY "tenant_bots: members can insert own"
  ON public.tenant_bots FOR INSERT
  WITH CHECK (tenant_id = get_my_tenant_id());

CREATE POLICY "tenant_bots: members can update own"
  ON public.tenant_bots FOR UPDATE
  USING (tenant_id = get_my_tenant_id());

CREATE POLICY "tenant_bots: members can delete own"
  ON public.tenant_bots FOR DELETE
  USING (tenant_id = get_my_tenant_id());

-- ── 6. Index ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS tenant_bots_webhook_secret
  ON public.tenant_bots (webhook_secret)
  WHERE webhook_secret IS NOT NULL;
