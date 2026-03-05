-- ============================================================
-- 016_add_suspended_plan.sql
-- Add 'suspended' to plan_type enum so superadmins can
-- suspend/activate schools.
-- ============================================================

ALTER TYPE plan_type ADD VALUE IF NOT EXISTS 'suspended';
