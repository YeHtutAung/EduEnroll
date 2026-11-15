-- Rollback for 20261116120000_enrollments_for_classes.sql
--
-- Roll the CODE back first: the admin student list's event and tier filters
-- call this function. No data is touched.

BEGIN;
DROP FUNCTION IF EXISTS public.enrollments_for_classes(uuid[]);
NOTIFY pgrst, 'reload schema';
COMMIT;
