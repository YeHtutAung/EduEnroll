-- ─── 075: Reload PostgREST schema cache ──────────────────────────────────────
--
-- Migration 074 renamed columns (fee_mmk → fee_amount, amount_mmk → amount, etc.)
-- This notification forces PostgREST to reload its schema cache so the renamed
-- columns are recognised immediately without waiting for the periodic auto-reload.

NOTIFY pgrst, 'reload schema';
