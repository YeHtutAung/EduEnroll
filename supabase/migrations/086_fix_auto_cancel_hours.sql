-- ============================================================
-- 086_fix_auto_cancel_hours.sql
-- Correct auto_cancel_hours values that were double-multiplied
-- by migration 058. Each row was verified manually via audit query.
-- Column stores minutes (despite name). Correct values confirmed by user.
-- ============================================================

-- nihon-moment: align with real tenants (15 minutes)
UPDATE public.tenants
SET auto_cancel_hours = 15
WHERE id = '7f1367a5-55af-4a2c-ac56-87742f8902ba';

-- Test school tenants: correct to 4320 minutes (72 hours = 3 days)
UPDATE public.tenants
SET auto_cancel_hours = 4320
WHERE id IN (
  '4597fbd6-e922-4ad5-a862-4cf369bd7ada', -- school-a-1773296581
  '7bc56600-120f-4793-ab08-578ffb0033b3', -- school-b-1773296581
  '84f9bfbe-be60-4d5a-a68f-3e82e23ec00a', -- school-a-1773290552
  'aa6ee5e9-c3b2-4512-8f5e-0bb8893e5362', -- school-b-1773290552
  '6ac7d5fd-4608-461e-800f-ce78a64ac6dd', -- school-a-1773291269
  'a1fda3b0-8bba-439f-9a5e-7223c3e526d7'  -- school-b-1773291269
);
