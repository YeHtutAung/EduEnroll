-- ─── Rollback for 20261019120000_interest_form_data.sql ─────────────────────
--
-- NOT PART OF THE MIGRATION SEQUENCE. This file deliberately lives outside
-- supabase/migrations/: a later-timestamped file in that directory would be
-- applied in order and would immediately undo the migration it exists to
-- reverse. Run it by hand, against one database, only when reverting.
--
--     psql "$DATABASE_URL" -f supabase/rollbacks/20261019120000_interest_form_data.down.sql
--
-- Revert the CODE first: the interest signup writes form_data and the
-- organiser's interest list reads it.
--
-- DESTROYS DATA: every interest signup's custom-field answers are dropped.
-- Export the interest lists (CSV) first if they may ever be needed.

alter table public.event_interest
  drop constraint if exists event_interest_form_data_size,
  drop constraint if exists event_interest_form_data_object;

alter table public.event_interest
  drop column if exists form_data;
