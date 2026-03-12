-- ─── Migration 034: Messenger live-agent handoff ─────────────────────────────
-- Allows users to request a live agent; bot goes silent until timeout or "bot".

-- 1. Handoff sessions table
CREATE TABLE IF NOT EXISTS public.messenger_handoffs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  sender_psid text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  UNIQUE (tenant_id, sender_psid)
);

CREATE INDEX idx_messenger_handoffs_lookup
  ON public.messenger_handoffs (tenant_id, sender_psid);

-- 2. Configurable timeout (default 15 minutes)
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS handoff_timeout_min integer NOT NULL DEFAULT 15;
