-- GA4 purchase events, sent from the server with the Meta and TikTok ones.
--
-- A tenant turns it on with ga4_measurement_id. The GA IDs sit with the rest of
-- the ad context, which is deleted on the same schedule, not on the order.
ALTER TABLE public.tenant_conversion_settings
  ADD COLUMN ga4_measurement_id text CHECK (ga4_measurement_id ~ '^G-[A-Z0-9]+$');

ALTER TABLE public.enrollment_ad_context
  ADD COLUMN ga_client_id  text,
  ADD COLUMN ga_session_id text;

ALTER TABLE public.conversion_events
  DROP CONSTRAINT conversion_events_platform_check,
  ADD CONSTRAINT conversion_events_platform_check
    CHECK (platform IN ('meta', 'tiktok', 'ga4'));

-- The same function as before, plus the GA4 row. GA4 reports the real value in
-- the tenant's own currency, so report_rate does not apply to it.
CREATE OR REPLACE FUNCTION public.fn_payments_enqueue_conversions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '1s'
AS $$
DECLARE
  v_settings record;
  v_tenant_currency text;
  v_total    numeric;
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

    -- A top-up row holds only the remainder. The FIRST row that recorded a
    -- partial payment holds the full ticket total; later partial rows hold less.
    SELECT p.amount - p.platform_fee INTO v_total
      FROM public.payments p
     WHERE p.enrollment_id = NEW.enrollment_id
       AND p.id <> NEW.id
       AND p.received_amount IS NOT NULL
       AND p.created_at < NEW.created_at
     ORDER BY p.created_at ASC, p.id ASC
     LIMIT 1;
    v_total := COALESCE(v_total, NEW.amount - NEW.platform_fee);
    v_value := round(v_total * v_settings.report_rate, 2);
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
    IF v_settings.ga4_measurement_id IS NOT NULL THEN
      INSERT INTO public.conversion_events (enrollment_id, tenant_id, platform, event_id, value, currency)
      VALUES (NEW.enrollment_id, NEW.tenant_id, 'ga4', v_event_id, v_total, v_tenant_currency)
      ON CONFLICT (enrollment_id, platform) DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'purchase conversion enqueue failed: %', SQLSTATE;
  END;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_payments_enqueue_conversions() FROM public, anon, authenticated;
