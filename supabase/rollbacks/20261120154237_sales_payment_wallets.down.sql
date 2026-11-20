-- Rollback for 20261120154237_sales_payment_wallets.sql
-- Deploy the code that no longer calls sales_payment_wallets() first.
BEGIN;
DROP FUNCTION IF EXISTS public.sales_payment_wallets(uuid, date, date, uuid);
NOTIFY pgrst, 'reload schema';
COMMIT;
