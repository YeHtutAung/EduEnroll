-- ─── Rollback for 20260910120000_wider_enrollment_ref.sql ───────────────────
--
-- NOT PART OF THE MIGRATION SEQUENCE. This file deliberately lives outside
-- supabase/migrations/: a later-timestamped file in that directory would be
-- applied in order and would immediately undo the migration it exists to
-- reverse. Run it by hand, against one database, only when reverting.
--
--     psql "$DATABASE_URL" -f supabase/rollbacks/20260910120000_wider_enrollment_ref.down.sql
--
-- ── What this restores ──────────────────────────────────────────────────────
--
-- The OBSERVABLE change only: the random part goes back to four characters,
-- so new references look like LM-0902-3SJQ again rather than LM-0902-3SJQK7.
-- The prefix cap becomes 10, which is what a four-character random part allows
-- inside varchar(20) and matches the effective limit before the migration.
--
-- ── What this deliberately does NOT restore ─────────────────────────────────
--
-- This is not a byte-revert to migration 056, because two things in 056 were
-- defects rather than decisions, and reintroducing them would be a downgrade:
--
--   1. 056 drew the random part from a seeded PRNG. The reference is an access
--      token, so it keeps drawing from gen_random_uuid() / pg_strong_random
--      here. The source is invisible to every consumer; only the width is not.
--
--   2. 056's collision fallback emitted a slice of a UUID — lowercase hex,
--      which reintroduces the I/O/0/1 ambiguity the alphabet exists to exclude
--      and produces a reference the application's own parsers reject. This
--      keeps retrying with fresh randomness and raises instead.
--
-- If a true byte-for-byte 056 is ever genuinely needed, take it from
-- supabase/migrations/056_random_enrollment_ref.sql rather than from here.
--
-- ── Existing data ───────────────────────────────────────────────────────────
--
-- Nothing is rewritten. References already issued with a six-character random
-- part stay exactly as they are and remain valid: every parser accepts
-- [A-Z0-9]{3,6}, so four- and six-character references coexist. Collision
-- checking scans the whole table, so mixing widths is safe.

CREATE OR REPLACE FUNCTION public.generate_enrollment_ref()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  -- Reverted to the pre-migration width.
  v_len    constant int := 4;
  -- Must satisfy v_prefix_max + v_len + 6 <= the enrollment_ref column width.
  -- With a 4-character random part that allows 10, the effective limit before
  -- the migration.
  v_prefix_max constant int := 10;
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

  v_prefix := left(v_prefix, v_prefix_max);

  LOOP
    -- Strong randomness is kept, see the note above. 256 is an exact multiple
    -- of 32, so the modulo maps bytes onto the alphabet without bias.
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

    -- 32^4 is ~1.05e6 per prefix and date, so collisions are plausible here in
    -- a way they are not at six characters. Twenty retries is ample; raising
    -- beats emitting a reference that violates the format contract, and the
    -- column is UNIQUE so a genuine race fails the insert rather than
    -- duplicating.
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
