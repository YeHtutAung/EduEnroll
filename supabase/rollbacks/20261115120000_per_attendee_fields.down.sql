-- Rollback for 20261115120000_per_attendee_fields.sql
--
-- Roll the CODE back first: order creation, the order page and ticket issuing
-- select these columns.
--
-- This drops every runner's details (names, sizes) stored on orders and
-- tickets. Export them first if any order has them:
--   select id, attendees from enrollments where attendees <> '[]'::jsonb;

BEGIN;
ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_attendee_is_object;
ALTER TABLE public.tickets DROP COLUMN IF EXISTS attendee;
ALTER TABLE public.enrollments DROP CONSTRAINT IF EXISTS enrollments_attendees_is_array;
ALTER TABLE public.enrollments DROP COLUMN IF EXISTS attendees;
ALTER TABLE public.intake_form_fields DROP CONSTRAINT IF EXISTS intake_form_fields_per_attendee_type;
ALTER TABLE public.intake_form_fields DROP CONSTRAINT IF EXISTS intake_form_fields_per_attendee_not_default;
ALTER TABLE public.intake_form_fields DROP COLUMN IF EXISTS per_attendee;
NOTIFY pgrst, 'reload schema';
COMMIT;
