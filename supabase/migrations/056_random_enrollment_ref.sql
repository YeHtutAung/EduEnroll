-- ─── Migration 056: Non-sequential enrollment ref ────────────────────────────
-- Changes format from PREFIX-YYYY-00001 (sequential) to PREFIX-MMDD-XXXX (random)
-- e.g. TMF-0318-K7M9, NM-0318-A3X2

CREATE OR REPLACE FUNCTION public.generate_enrollment_ref()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant_name text;
  v_prefix text := '';
  v_word text;
  v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- no I/O/0/1 to avoid confusion
  v_random text := '';
  v_ref text;
  v_exists boolean;
  v_attempts int := 0;
BEGIN
  -- Build prefix from tenant name initials
  SELECT name INTO v_tenant_name
  FROM public.tenants
  WHERE id = NEW.tenant_id;

  IF v_tenant_name IS NOT NULL AND v_tenant_name <> '' THEN
    FOREACH v_word IN ARRAY string_to_array(trim(v_tenant_name), ' ')
    LOOP
      IF v_word <> '' THEN
        v_prefix := v_prefix || upper(left(v_word, 1));
      END IF;
    END LOOP;
  END IF;

  IF v_prefix = '' THEN
    v_prefix := 'EN';
  END IF;

  -- Generate unique ref with retry loop (collision-safe)
  LOOP
    v_random := '';
    FOR i IN 1..4 LOOP
      v_random := v_random || substr(v_chars, floor(random() * length(v_chars) + 1)::int, 1);
    END LOOP;

    v_ref := v_prefix || '-' || to_char(now(), 'MMDD') || '-' || v_random;

    -- Check for collision
    SELECT EXISTS(
      SELECT 1 FROM public.enrollments WHERE enrollment_ref = v_ref
    ) INTO v_exists;

    EXIT WHEN NOT v_exists;

    v_attempts := v_attempts + 1;
    IF v_attempts > 10 THEN
      -- Extremely unlikely; fall back to longer random
      v_ref := v_prefix || '-' || to_char(now(), 'MMDD') || '-' || substr(gen_random_uuid()::text, 1, 6);
      EXIT;
    END IF;
  END LOOP;

  NEW.enrollment_ref := v_ref;
  RETURN NEW;
END;
$$;
