-- ─── Server-side purchase conversions ───────────────────────────────────────
--
-- See docs/superpowers/specs/2026-11-02-purchase-conversion-design.md.
--
--   tenant_conversion_settings  which tenants send, and to which pixels
--   enrollment_ad_context       click data, IP and user agent, kept briefly
--   conversion_events           one queued purchase event per platform
--
-- Additive. No tenant sends anything until a settings row is added by SQL.
--
-- DEPLOY ORDER: apply this BEFORE the code that reads it.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_payments_enqueue_conversions ON public.payments;
--   DROP FUNCTION IF EXISTS public.fn_payments_enqueue_conversions();
--   DROP FUNCTION IF EXISTS public.cleanup_conversion_data();
--   DROP TABLE IF EXISTS public.conversion_events;
--   DROP TABLE IF EXISTS public.enrollment_ad_context;
--   DROP TABLE IF EXISTS public.tenant_conversion_settings;

CREATE TABLE public.tenant_conversion_settings (
  tenant_id         uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  config_id         text NOT NULL CHECK (config_id ~ '^[A-Z0-9_]+$'),
  meta_pixel_id     text,
  tiktok_pixel_code text,
  report_currency   text NOT NULL DEFAULT 'USD' CHECK (report_currency ~ '^[A-Z]{3}$'),
  report_rate       numeric NOT NULL CHECK (report_rate > 0),
  enabled           boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER tenant_conversion_settings_updated_at
  BEFORE UPDATE ON public.tenant_conversion_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.enrollment_ad_context (
  enrollment_id uuid PRIMARY KEY REFERENCES public.enrollments(id) ON DELETE CASCADE,
  fbp           text,
  fbc           text,
  ttp           text,
  ttclid        text,
  client_ip     text,
  user_agent    text,
  source_url    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_enrollment_ad_context_created_at
  ON public.enrollment_ad_context (created_at);

CREATE TABLE public.conversion_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id   uuid NOT NULL REFERENCES public.enrollments(id) ON DELETE CASCADE,
  tenant_id       uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  platform        text NOT NULL CHECK (platform IN ('meta', 'tiktok')),
  event_id        text NOT NULL,
  value           numeric NOT NULL CHECK (value > 0),
  currency        text NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts        integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_error      text,
  UNIQUE (enrollment_id, platform)
);

CREATE INDEX idx_conversion_events_pending
  ON public.conversion_events (occurred_at)
  WHERE status = 'pending';

-- No policies: anon and authenticated can neither read nor write.
ALTER TABLE public.tenant_conversion_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enrollment_ad_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversion_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tenant_conversion_settings FROM public, anon, authenticated;
REVOKE ALL ON public.enrollment_ad_context FROM public, anon, authenticated;
REVOKE ALL ON public.conversion_events FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_conversion_settings TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.enrollment_ad_context TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversion_events TO service_role;

-- A conversion bug must never roll back a settlement, so the whole body is
-- wrapped and an error only raises a warning.
CREATE FUNCTION public.fn_payments_enqueue_conversions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settings public.tenant_conversion_settings%ROWTYPE;
  v_tenant_currency text;
  v_value    numeric;
  v_event_id text;
BEGIN
  BEGIN
    SELECT * INTO v_settings
      FROM public.tenant_conversion_settings
     WHERE tenant_id = NEW.tenant_id AND enabled;
    IF NOT FOUND THEN RETURN NEW; END IF;

    SELECT upper(currency) INTO v_tenant_currency FROM public.tenants WHERE id = NEW.tenant_id;

    -- The rate is for the tenant's currency, so it can't apply to another one.
    IF NEW.provider_currency IS NOT NULL AND upper(NEW.provider_currency) <> v_tenant_currency THEN
      RETURN NEW;
    END IF;

    -- A top-up row holds only the remainder. The earlier row that recorded the
    -- partial payment holds the full ticket total.
    SELECT p.amount - p.platform_fee INTO v_value
      FROM public.payments p
     WHERE p.enrollment_id = NEW.enrollment_id
       AND p.id <> NEW.id
       AND p.received_amount IS NOT NULL
     ORDER BY p.created_at DESC
     LIMIT 1;
    v_value := round(COALESCE(v_value, NEW.amount - NEW.platform_fee) * v_settings.report_rate, 2);
    IF v_value <= 0 THEN RETURN NEW; END IF;

    v_event_id := encode(sha256(convert_to('purchase:' || NEW.enrollment_id::text, 'UTF8')), 'hex');

    IF v_settings.meta_pixel_id IS NOT NULL THEN
      INSERT INTO public.conversion_events (enrollment_id, tenant_id, platform, event_id, value, currency)
      VALUES (NEW.enrollment_id, NEW.tenant_id, 'meta', v_event_id, v_value, v_settings.report_currency)
      ON CONFLICT (enrollment_id, platform) DO NOTHING;
    END IF;
    IF v_settings.tiktok_pixel_code IS NOT NULL THEN
      INSERT INTO public.conversion_events (enrollment_id, tenant_id, platform, event_id, value, currency)
      VALUES (NEW.enrollment_id, NEW.tenant_id, 'tiktok', v_event_id, v_value, v_settings.report_currency)
      ON CONFLICT (enrollment_id, platform) DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'purchase conversion enqueue failed: %', SQLSTATE;
  END;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_payments_enqueue_conversions() FROM public, anon, authenticated;

CREATE TRIGGER trg_payments_enqueue_conversions
  AFTER UPDATE OF status ON public.payments
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'verified')
  EXECUTE FUNCTION public.fn_payments_enqueue_conversions();

-- Called first by the daily cron, so a sending backlog can't block deletion of
-- IP data. Order matters: expiring rows first lets their context go in this run.
CREATE FUNCTION public.cleanup_conversion_data()
RETURNS TABLE (expired integer, context_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expired integer;
  v_finished integer;
  v_unpaid integer;
BEGIN
  UPDATE public.conversion_events
     SET status = 'failed', last_error = 'expired'
   WHERE status = 'pending' AND occurred_at < now() - interval '7 days';
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  -- Every queue row finished: the data has done its job.
  DELETE FROM public.enrollment_ad_context c
   WHERE EXISTS (SELECT 1 FROM public.conversion_events e WHERE e.enrollment_id = c.enrollment_id)
     AND NOT EXISTS (SELECT 1 FROM public.conversion_events e
                      WHERE e.enrollment_id = c.enrollment_id AND e.status = 'pending');
  GET DIAGNOSTICS v_finished = ROW_COUNT;

  -- No queue rows after 8 days: an order that was never paid.
  DELETE FROM public.enrollment_ad_context c
   WHERE c.created_at < now() - interval '8 days'
     AND NOT EXISTS (SELECT 1 FROM public.conversion_events e WHERE e.enrollment_id = c.enrollment_id);
  GET DIAGNOSTICS v_unpaid = ROW_COUNT;

  RETURN QUERY SELECT v_expired, v_finished + v_unpaid;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_conversion_data() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_conversion_data() TO service_role;
