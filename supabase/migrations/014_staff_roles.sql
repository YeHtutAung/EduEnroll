-- ============================================================
-- 014_staff_roles.sql
-- Add 'superadmin' and 'staff' to user_role enum.
-- Must be in its own migration so the values are committed
-- before 015 references them in policies.
-- ============================================================

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'superadmin';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'staff';
