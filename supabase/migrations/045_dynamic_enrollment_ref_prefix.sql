-- Dynamic enrollment reference prefix based on tenant name
-- e.g. "Thingyan Music Festival" → TMF, "Nihon Moment" → NM, "IGM" → IGM

CREATE OR REPLACE FUNCTION public.generate_enrollment_ref()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant_name text;
  v_prefix text := '';
  v_word text;
BEGIN
  -- Look up tenant name
  SELECT name INTO v_tenant_name
  FROM public.tenants
  WHERE id = NEW.tenant_id;

  IF v_tenant_name IS NOT NULL AND v_tenant_name <> '' THEN
    -- Take the first letter of each word, uppercase
    FOREACH v_word IN ARRAY string_to_array(trim(v_tenant_name), ' ')
    LOOP
      IF v_word <> '' THEN
        v_prefix := v_prefix || upper(left(v_word, 1));
      END IF;
    END LOOP;
  END IF;

  -- Fallback if somehow empty
  IF v_prefix = '' THEN
    v_prefix := 'EN';
  END IF;

  NEW.enrollment_ref := v_prefix || '-' || to_char(now(), 'YYYY') || '-'
                        || lpad(nextval('enrollment_ref_seq')::text, 5, '0');
  RETURN NEW;
END;
$$;
