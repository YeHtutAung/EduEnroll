-- ─── Drop anon policies that no migration created ─────────────────────────
-- The dev database carried anon policies on enrollments, classes, tenants and
-- support_tickets that were added by hand for an outside prototype and never
-- went through a migration. Production does not have them, and the app does
-- not need them: public pages read these tables through server routes with
-- the service-role client, and admin pages read them as `authenticated`.
--
-- Dropping them brings the dev database in line with production. On
-- production every statement here is a no-op (IF EXISTS; support_tickets is
-- guarded because that table exists only on dev).
--
-- Table privileges are left as they are, matching production.
-- Rollback: supabase/rollbacks/20261121130000_drop_unmigrated_anon_policies.down.sql

BEGIN;

DROP POLICY IF EXISTS "anon_read_enrollments"   ON public.enrollments;
DROP POLICY IF EXISTS "anon_read_classes"       ON public.classes;
DROP POLICY IF EXISTS "anon_read_tenants"       ON public.tenants;
DROP POLICY IF EXISTS "Allow anon read tenants" ON public.tenants;

DO $$
BEGIN
  IF to_regclass('public.support_tickets') IS NOT NULL THEN
    DROP POLICY IF EXISTS "anon_read_support_tickets"   ON public.support_tickets;
    DROP POLICY IF EXISTS "anon_insert_support_tickets" ON public.support_tickets;
  END IF;
END
$$;

COMMIT;
