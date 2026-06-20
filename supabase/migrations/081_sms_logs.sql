-- ─── Migration 081: SMS delivery logs ────────────────────────────────────────
-- Stores SmsPoh delivery receipt callbacks for audit and debugging.
-- Upserted on message_id — SmsPoh may send multiple status updates per message.

CREATE TABLE IF NOT EXISTS public.sms_logs (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id        text        NOT NULL UNIQUE,   -- SmsPoh messageId
  client_reference  text,                          -- enrollment_ref (NM-YYYY-NNNNN)
  tenant_id         uuid        REFERENCES public.tenants(id) ON DELETE CASCADE,
  enrollment_id     uuid        REFERENCES public.enrollments(id) ON DELETE SET NULL,
  to_number         text        NOT NULL,
  status            text        NOT NULL,          -- Accepted/Sent/Delivered/Failed/etc.
  raw_payload       jsonb,                         -- full webhook payload for debugging
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_sms_logs_client_reference
  ON public.sms_logs (client_reference)
  WHERE client_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sms_logs_enrollment_id
  ON public.sms_logs (enrollment_id)
  WHERE enrollment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sms_logs_tenant_id
  ON public.sms_logs (tenant_id)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sms_logs_status
  ON public.sms_logs (status);

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE public.sms_logs ENABLE ROW LEVEL SECURITY;

-- Authenticated tenant members can read their own logs.
-- All writes go through the service-role admin client (bypasses RLS).
CREATE POLICY "sms_logs: members can read own"
  ON public.sms_logs FOR SELECT
  USING (tenant_id = get_my_tenant_id());

-- ── Comments ──────────────────────────────────────────────────────────────────

COMMENT ON TABLE  public.sms_logs                   IS 'SmsPoh delivery receipt log. Upserted on message_id.';
COMMENT ON COLUMN public.sms_logs.message_id        IS 'SmsPoh messageId UUID — unique per outbound SMS';
COMMENT ON COLUMN public.sms_logs.client_reference  IS 'Enrollment ref passed as clientReference when sending';
COMMENT ON COLUMN public.sms_logs.status            IS 'Accepted | Sent | Delivered | Pending | Rejected | Failed | Undelivered | Error | Expired | Unknown';
COMMENT ON COLUMN public.sms_logs.raw_payload       IS 'Full SmsPoh webhook payload stored for debugging';
