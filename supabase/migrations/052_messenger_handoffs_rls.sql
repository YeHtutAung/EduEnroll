-- ─── Migration 052: Enable RLS on messenger_handoffs ────────────────────────
-- Table is only accessed via service-role client (bypasses RLS),
-- so no policies are needed — just lock it down.

ALTER TABLE public.messenger_handoffs ENABLE ROW LEVEL SECURITY;
