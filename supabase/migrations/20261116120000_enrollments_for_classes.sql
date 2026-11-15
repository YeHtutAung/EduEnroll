-- ============================================================================
-- Orders for a set of ticket types, single or cart
--
-- A single-ticket order carries its ticket type in enrollments.class_id. A cart
-- order has class_id NULL and its ticket types in enrollment_items. The admin
-- student list filtered by event (or tier) with class_id IN (...), so every
-- cart order of that event was missing from the list and its Excel export,
-- including the per-ticket Runners and Sizes sheets.
--
-- This function returns the enrollments rows that hold any of the given
-- ticket types either way. GET /api/admin/students calls it in place of the
-- table when an event or tier filter is set; PostgREST still applies the
-- route's embeds, filters, ordering, range and count on top of it. The ids
-- travel in the POST body, so an event with many tiers can't make the request
-- address too long.
--
-- SECURITY INVOKER: it reads enrollments and enrollment_items as the calling
-- user, so the same row-level security as the table query applies. The route
-- also keeps its own tenant filter.
--
-- Additive. Rollback: supabase/rollbacks/20261116120000_enrollments_for_classes.down.sql
-- DEPLOY ORDER: apply BEFORE the code that calls it, or the student list's
-- event and tier filters return 500.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.enrollments_for_classes(p_class_ids uuid[])
RETURNS SETOF public.enrollments
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT e.*
  FROM public.enrollments e
  WHERE e.class_id = ANY (p_class_ids)
     OR EXISTS (
          SELECT 1
          FROM public.enrollment_items i
          WHERE i.enrollment_id = e.id
            AND i.class_id = ANY (p_class_ids)
        );
$$;

REVOKE ALL ON FUNCTION public.enrollments_for_classes(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enrollments_for_classes(uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.enrollments_for_classes(uuid[]) IS
  'Enrollments holding any of the given classes, as a single order (class_id) or a cart (enrollment_items). Admin student list filter.';

NOTIFY pgrst, 'reload schema';

COMMIT;
