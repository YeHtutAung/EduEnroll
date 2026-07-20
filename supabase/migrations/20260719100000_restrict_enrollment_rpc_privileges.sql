-- ============================================================================
-- Enrollment RPCs: remove superseded overloads, restrict execution
--
-- `submit_enrollment` accumulated overloads across the migration history.
-- CREATE OR REPLACE FUNCTION only replaces a function of the *same* signature,
-- so each signature change left its predecessor in place rather than
-- superseding it. All are SECURITY DEFINER and all carried the PostgreSQL
-- default EXECUTE for PUBLIC, which no migration ever revoked.
--
-- Only one signature is used by the application, and only ever through the
-- service-role client:
--
--   src/server/enrollment/createEnrollment.ts      submit_enrollment(uuid,text,integer)
--   src/server/enrollment/createCartEnrollment.ts  submit_cart_enrollment(jsonb,uuid)
--
-- The superseded overloads predate guards that were added later, so they do
-- not enforce the same rules as the current one. They are removed rather than
-- repaired: keeping them would mean maintaining several enrollment paths in
-- parallel, which is how this situation arose.
--
-- The environments disagree on which overloads exist — some databases had
-- these versions marked applied without their bodies ever running. Every drop
-- is therefore IF EXISTS with an explicit signature, and the functions the
-- application requires are asserted rather than assumed.
-- ============================================================================

BEGIN;

-- ── 1. Fail closed if a required function is missing ────────────────────────
-- Legacy drops tolerate absence; the survivors must not. Skipping the grant
-- repair silently would leave a deployment that succeeds with no usable
-- enrollment RPC.
DO $$
BEGIN
  IF to_regprocedure('public.submit_enrollment(uuid,text,integer)') IS NULL THEN
    RAISE EXCEPTION 'Required function submit_enrollment(uuid,text,integer) is missing';
  END IF;

  IF to_regprocedure('public.submit_cart_enrollment(jsonb,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Required function submit_cart_enrollment(jsonb,uuid) is missing';
  END IF;
END $$;

-- ── 2. Drop the superseded overloads ────────────────────────────────────────
-- Explicit signatures: a bare DROP FUNCTION submit_enrollment is ambiguous
-- while overloads exist. IF EXISTS: not every database has every one.
DROP FUNCTION IF EXISTS public.submit_enrollment(uuid);
DROP FUNCTION IF EXISTS public.submit_enrollment(uuid, text);
DROP FUNCTION IF EXISTS public.submit_enrollment(uuid, text, text, text, text, text);

-- ── 3. Restrict execution to the roles that need it ─────────────────────────
-- Both callers use the service-role client, so no application flow depends on
-- anon or authenticated. PostgreSQL grants EXECUTE to PUBLIC by default on
-- functions, and CREATE OR REPLACE preserves privileges — so preserving them
-- preserves the default. These are SECURITY DEFINER and bypass RLS.
--
-- `postgres` owns them and retains EXECUTE implicitly; it needs no grant.
REVOKE ALL ON FUNCTION public.submit_enrollment(uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_enrollment(uuid, text, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.submit_cart_enrollment(jsonb, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_cart_enrollment(jsonb, uuid)
  TO service_role;

-- ── 4. Reload the PostgREST schema cache ────────────────────────────────────
-- Both the overload set and the executable roles changed. Without this,
-- PostgREST can keep serving a stale schema and return overload-resolution
-- errors to legitimate service-role calls — an enrollment outage over a
-- correctly configured database.
--
-- Same treatment as 075_reload_pgrst_schema_cache.sql and
-- 076_fix_stored_functions.sql, which reload after touching these functions.
NOTIFY pgrst, 'reload schema';

COMMIT;
