-- ─── Rollback for 20260921120000_intake_ticket_qr_format.sql ────────────────
--
-- NOT PART OF THE MIGRATION SEQUENCE. This file deliberately lives outside
-- supabase/migrations/: a later-timestamped file in that directory would be
-- applied in order and would immediately undo the migration it exists to
-- reverse. Run it by hand, against one database, only when reverting.
--
--     psql "$DATABASE_URL" -f supabase/rollbacks/20260921120000_intake_ticket_qr_format.down.sql
--
-- Revert the CODE first. Code that reads ticket_qr_format fails closed without
-- the column, so dropping it under running code stops ticket delivery.
--
-- Any event switched to 'uuid' loses that setting; its tickets go back to the
-- signed-token QR, which a third-party scanner holding UUIDs cannot read.

alter table public.intakes
  drop constraint if exists intakes_ticket_qr_format_check;

alter table public.intakes
  drop column if exists ticket_qr_format;
