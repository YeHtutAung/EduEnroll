-- ─── 070: Telegram admin bot access requests ──────────────────────────────────
-- Stores /start requests from users who want admin bot access.
-- Approved users get added to allowed_chat_ids in tenant_telegram_configs.

CREATE TABLE public.telegram_admin_requests (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  chat_id     bigint      NOT NULL,
  name        text        NOT NULL,
  username    text,
  status      text        NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, chat_id)
);

-- ─── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.telegram_admin_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "telegram_admin_requests: members can read own"
  ON public.telegram_admin_requests FOR SELECT
  USING (tenant_id = get_my_tenant_id());

CREATE POLICY "telegram_admin_requests: members can update own"
  ON public.telegram_admin_requests FOR UPDATE
  USING (tenant_id = get_my_tenant_id());

CREATE POLICY "telegram_admin_requests: members can delete own"
  ON public.telegram_admin_requests FOR DELETE
  USING (tenant_id = get_my_tenant_id());

-- ─── Index ────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS telegram_admin_requests_tenant_status
  ON public.telegram_admin_requests (tenant_id, status);
