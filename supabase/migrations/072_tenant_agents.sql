-- ─── 072: tenant_agents — per-agent API keys for approved Telegram admin users ─
-- Each approved Telegram admin chat_id gets a unique agent_key they use to call
-- admin API endpoints. Revoked when the admin revokes their access.
-- payments.verified_by_agent records which agent (by chat_id) approved a payment.

-- ── 1. Create tenant_agents ───────────────────────────────────────────────────

CREATE TABLE public.tenant_agents (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  chat_id     bigint      NOT NULL,
  agent_key   text        NOT NULL,
  name        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, chat_id),
  UNIQUE (agent_key)
);

-- ── 2. RLS ────────────────────────────────────────────────────────────────────

ALTER TABLE public.tenant_agents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_agents: members can read own"
  ON public.tenant_agents FOR SELECT
  USING (tenant_id = get_my_tenant_id());

-- Insert / update / delete done exclusively via service-role (admin client)

-- ── 3. Add verified_by_agent to payments ──────────────────────────────────────

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS verified_by_agent bigint;

COMMENT ON COLUMN public.payments.verified_by_agent IS
  'Telegram chat_id of the agent that verified this payment (null when verified by a human admin)';
