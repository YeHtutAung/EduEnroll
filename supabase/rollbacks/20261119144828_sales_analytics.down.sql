-- Rollback for 20261119144828_sales_analytics.sql
-- Remove the code that calls these functions first (the Sales Analytics page).
BEGIN;

DROP FUNCTION IF EXISTS public.sales_not_converted(uuid, date, date, uuid);
DROP FUNCTION IF EXISTS public.sales_analytics(uuid, date, date, uuid);
DROP INDEX IF EXISTS public.idx_enrollments_tenant_status_enrolled_at;

NOTIFY pgrst, 'reload schema';

COMMIT;
