-- ============================================================================
-- Per-ticket form answers ("runner details")
--
-- One order can buy several tickets. Some questions belong to each ticket's
-- holder rather than to the buyer -- for The Beats Run, the runner's name and
-- jersey size. Until now every answer was stored once per order in
-- enrollments.form_data, which is why the organiser had to cap orders at one
-- ticket.
--
-- intake_form_fields.per_attendee -- the field is asked once per ticket, not
--   once per order. Never on a default (contact) field: those are the buyer.
--   Only types whose answer is one short string: a checkbox's "false" would
--   pass "required", and a file has no per-ticket upload path.
-- enrollments.attendees -- one entry per admission:
--   {"class_id": uuid, "seat_no": int, "answers": {field_key: text}, "label": text}
--   keyed exactly like tickets (class_id, seat_no), seats 1..N per class.
--   label is fixed at purchase, so editing the form later can't change a ticket.
-- tickets.attendee -- {label, answers} copied from that entry when the ticket
--   is issued. NULL for a ticket with no runner.
--
-- Additive. Existing rows get false / '[]' / NULL and behave as before. The
-- constraints are dropped first so a re-run does not abort the transaction
-- (Postgres has no ADD CONSTRAINT IF NOT EXISTS).
--
-- DEPLOY ORDER: apply BEFORE the code that selects these columns. Without it
-- every order fails and paid orders get no tickets.
-- Rollback: supabase/rollbacks/20261115120000_per_attendee_fields.down.sql
-- ============================================================================

BEGIN;

ALTER TABLE public.intake_form_fields
  ADD COLUMN IF NOT EXISTS per_attendee boolean NOT NULL DEFAULT false;

ALTER TABLE public.intake_form_fields
  DROP CONSTRAINT IF EXISTS intake_form_fields_per_attendee_not_default;
ALTER TABLE public.intake_form_fields
  ADD CONSTRAINT intake_form_fields_per_attendee_not_default
  CHECK (NOT (per_attendee AND is_default));

ALTER TABLE public.intake_form_fields
  DROP CONSTRAINT IF EXISTS intake_form_fields_per_attendee_type;
ALTER TABLE public.intake_form_fields
  ADD CONSTRAINT intake_form_fields_per_attendee_type
  CHECK (NOT per_attendee OR field_type IN ('text', 'select', 'radio', 'date', 'phone'));

ALTER TABLE public.enrollments
  ADD COLUMN IF NOT EXISTS attendees jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.enrollments
  DROP CONSTRAINT IF EXISTS enrollments_attendees_is_array;
ALTER TABLE public.enrollments
  ADD CONSTRAINT enrollments_attendees_is_array
  CHECK (jsonb_typeof(attendees) = 'array');

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS attendee jsonb;

ALTER TABLE public.tickets
  DROP CONSTRAINT IF EXISTS tickets_attendee_is_object;
ALTER TABLE public.tickets
  ADD CONSTRAINT tickets_attendee_is_object
  CHECK (attendee IS NULL OR jsonb_typeof(attendee) = 'object');

COMMENT ON COLUMN public.intake_form_fields.per_attendee IS
  'Asked once per ticket (runner), not once per order.';
COMMENT ON COLUMN public.enrollments.attendees IS
  'Per-ticket answers: [{class_id, seat_no, answers, label}], seats 1..N per class like tickets.';
COMMENT ON COLUMN public.tickets.attendee IS
  'This ticket''s runner: {label, answers}. Copied from enrollments.attendees at issue.';

NOTIFY pgrst, 'reload schema';

COMMIT;
