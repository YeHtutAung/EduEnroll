-- ─── 067: Tenant bot admins ───────────────────────────────────────────────────
-- Allowlist of Telegram chat IDs that are permitted to interact with the
-- AI agent via /api/webhook. Only chats listed here get a response.

CREATE TABLE IF NOT EXISTS public.tenant_bot_admins (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  telegram_chat_id text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, telegram_chat_id)
);

-- ─── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.tenant_bot_admins ENABLE ROW LEVEL SECURITY;

-- Tenant members can view the allowlist for their own tenant.
CREATE POLICY "tenant_bot_admins: members can read own"
  ON public.tenant_bot_admins FOR SELECT
  USING (tenant_id = get_my_tenant_id());

-- Tenant members can add entries to the allowlist.
CREATE POLICY "tenant_bot_admins: members can insert own"
  ON public.tenant_bot_admins FOR INSERT
  WITH CHECK (tenant_id = get_my_tenant_id());

-- Tenant members can remove entries from the allowlist.
CREATE POLICY "tenant_bot_admins: members can delete own"
  ON public.tenant_bot_admins FOR DELETE
  USING (tenant_id = get_my_tenant_id());

-- ─── Index ────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS tenant_bot_admins_lookup
  ON public.tenant_bot_admins (tenant_id, telegram_chat_id);
