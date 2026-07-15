-- ─── Migration 092: drop unused staff_invites table ────────────────────────
-- Security audit finding #15.
--
-- The token-based staff-invite flow was never wired up: nothing created
-- staff_invites rows or emailed accept links, and the accept endpoint (which
-- created an auth user with an undisclosed random password — so an invited
-- person could never sign in) has been removed. Staff are added through the
-- owner-set-password flow (POST /api/admin/staff).
--
-- The table is empty and unreferenced, so drop it. Its RLS policies drop with
-- it; nothing has a foreign key into it.

DROP TABLE IF EXISTS public.staff_invites;
