-- ─── Wider, strongly-random enrollment_ref ──────────────────────────────────
--
-- `enrollment_ref` is the access token for GET/PATCH /api/public/enrollment/[ref],
-- so it has to resist guessing. Two problems with the previous generator
-- (migration 056):
--
--   1. Four characters from a 32-symbol alphabet is a small space for a value
--      that acts as a credential, and the other two components are guessable —
--      the prefix comes from the tenant name and MMDD from the sale window.
--   2. It drew on `random()`, a seeded PRNG. Observing a handful of issued
--      references should not help predict the next one; that property needs a
--      strong source.
--
-- This widens the random part to six characters (32^6 ~ 1.07e9, a 1024x
-- increase) and switches to `gen_random_uuid()`, which draws on
-- pg_strong_random.
--
-- SIX IS A CEILING, NOT A PREFERENCE. Three application parsers accept a
-- reference back from users in chat and pin the random part to [A-Z0-9]{3,6}:
--   - src/lib/messenger/processor.ts
--   - src/lib/telegram/processor.ts
--   - src/lib/telegram/language-school-processor.ts
-- Widening past six requires changing those first, or the bots will silently
-- stop recognising newly issued references.
-- src/__tests__/migrations/enrollmentRefWidth.test.ts asserts that contract.
--
-- Existing references are NOT rewritten: they are live links in customer
-- emails, Telegram messages and printed tickets. Only newly created
-- enrollments get the wider form, so the short ones stay valid — which is why
-- the per-address throttle on the route is the control that covers them.
--
-- `enrollments.enrollment_ref` is varchar(20) and the reference is
-- prefix + 1 + 4 + 1 + v_len, so the prefix must be capped at 8 characters.
-- Verified by executing this migration against PostgreSQL 16: without a cap a
-- nine-word tenant name emitted 21 characters and the insert failed with
-- "value too long for type character varying(20)". The previous 4-character
-- random part tolerated a 10-character prefix, so widening without the cap
-- would have broken enrollment creation for long tenant names. Truncating is
-- safe because uniqueness rests on the random part, not the prefix.

CREATE OR REPLACE FUNCTION public.generate_enrollment_ref()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  -- Width of the random part. Declared as a constant so the cross-side
  -- contract test can read it.
  v_len    constant int := 6;
  -- Must satisfy v_prefix_max + v_len + 6 <= the enrollment_ref column width.
  v_prefix_max constant int := 8;
  v_chars  text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- 32 symbols, no I/O/0/1
  v_tenant_name text;
  v_prefix text := '';
  v_word   text;
  v_random text;
  v_hex    text;
  v_byte   int;
  v_ref    text;
  v_exists boolean;
  v_attempts int := 0;
BEGIN
  -- Prefix from tenant name initials (unchanged from 056).
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

  -- Bound the prefix so no tenant name can overflow the column.
  v_prefix := left(v_prefix, v_prefix_max);

  LOOP
    -- gen_random_uuid() draws on pg_strong_random, unlike the seeded PRNG this
    -- replaces. The first six bytes of a v4 UUID carry none of the version or
    -- variant bits, so all six are fully random. 256 is an exact multiple of
    -- 32, so the modulo maps bytes onto the alphabet without bias.
    v_hex := replace(gen_random_uuid()::text, '-', '');
    v_random := '';
    FOR i IN 0..(v_len - 1) LOOP
      v_byte := ('x' || substr(v_hex, i * 2 + 1, 2))::bit(8)::int;
      v_random := v_random || substr(v_chars, (v_byte % 32) + 1, 1);
    END LOOP;

    v_ref := v_prefix || '-' || to_char(now(), 'MMDD') || '-' || v_random;

    SELECT EXISTS(
      SELECT 1 FROM public.enrollments WHERE enrollment_ref = v_ref
    ) INTO v_exists;

    EXIT WHEN NOT v_exists;

    v_attempts := v_attempts + 1;

    -- Twenty collisions in a row against a ~1.07e9 space means the randomness
    -- is broken, not that the space is full. Migration 056 fell back to a slice
    -- of a UUID here, which emitted lowercase hex and reintroduced the very
    -- characters the alphabet exists to exclude. Failing loudly beats issuing a
    -- reference that violates the format contract; the column is also UNIQUE,
    -- so a genuine race fails the insert rather than duplicating.
    IF v_attempts >= 20 THEN
      RAISE EXCEPTION
        'generate_enrollment_ref: 20 consecutive collisions for prefix % — check randomness',
        v_prefix;
    END IF;
  END LOOP;

  NEW.enrollment_ref := v_ref;
  RETURN NEW;
END;
$$;
