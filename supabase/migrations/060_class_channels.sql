-- ─── Sprint 9: Class channels for Telegram auto-approve (language_school only) ───

-- 1. class_channels — one Telegram channel per class per tenant
CREATE TABLE IF NOT EXISTS public.class_channels (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  intake_id             uuid NOT NULL REFERENCES public.intakes(id) ON DELETE CASCADE,
  class_id              uuid NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  telegram_channel_id   text NOT NULL,
  telegram_channel_name text,
  telegram_invite_link  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, class_id)
);

-- RLS
ALTER TABLE public.class_channels ENABLE ROW LEVEL SECURITY;

CREATE POLICY "class_channels_select" ON public.class_channels
  FOR SELECT USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));

CREATE POLICY "class_channels_insert" ON public.class_channels
  FOR INSERT WITH CHECK (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));

CREATE POLICY "class_channels_update" ON public.class_channels
  FOR UPDATE USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));

CREATE POLICY "class_channels_delete" ON public.class_channels
  FOR DELETE USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));

-- 2. Auto-send invite toggle on tenants
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS telegram_auto_send_invite boolean NOT NULL DEFAULT false;

-- 3. Pending chat_id for phone verification flow
ALTER TABLE public.enrollments
  ADD COLUMN IF NOT EXISTS telegram_link_pending_chat_id text;
