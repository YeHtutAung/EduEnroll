-- ─── Tighten payments read access ─────────────────────────────────────────
-- The `anon` role does not need to read public.payments. Every public page
-- that shows a payment (status pages, QR polling, Stripe return, upload)
-- reads it through a server route with the service-role client, and the
-- admin pages read it as `authenticated`, scoped by tenant.
--
-- `anon_read_payments` was not created by any migration in this repo. Drop it
-- if present, and remove the table privileges `anon` received from the
-- default grants so a future policy cannot reopen the table by accident.
--
-- Safe if the policy is absent (IF EXISTS) and if the privileges are already
-- gone (REVOKE of an ungranted privilege is a no-op).
-- Rollback: supabase/rollbacks/20261121120000_tighten_payments_read_access.down.sql

BEGIN;

DROP POLICY IF EXISTS "anon_read_payments" ON public.payments;

REVOKE ALL ON TABLE public.payments FROM anon;

COMMIT;
