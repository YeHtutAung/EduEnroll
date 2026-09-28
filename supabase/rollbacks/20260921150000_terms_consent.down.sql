-- ─── Rollback for 20260921150000_terms_consent.sql ──────────────────────────
--
-- NOT PART OF THE MIGRATION SEQUENCE. This file deliberately lives outside
-- supabase/migrations/: a later-timestamped file in that directory would be
-- applied in order and would immediately undo the migration it exists to
-- reverse. Run it by hand, against one database, only when reverting.
--
--     psql "$DATABASE_URL" -f supabase/rollbacks/20260921150000_terms_consent.down.sql
--
-- Revert the CODE first: the order route reads organiser_terms and refuses
-- every order with 503 when it cannot.
--
-- DESTROYS EVIDENCE: every order's record of what the buyer accepted and when
-- is dropped, and so is every event's organiser rules text. Export them first
-- if they may ever be needed.

alter table public.enrollments
  drop column if exists organiser_terms_sha256,
  drop column if exists terms_version,
  drop column if exists terms_accepted_at;

alter table public.intakes
  drop constraint if exists intakes_organiser_terms_length_check;

alter table public.intakes
  drop column if exists organiser_terms;
