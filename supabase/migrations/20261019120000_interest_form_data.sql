-- ─── Custom form fields on the interest signup ──────────────────────────────
--
-- The interest (pre-registration) form now also shows the organiser's custom
-- Enrolment Form fields. Their answers are stored here, keyed by field_key:
--
--   event_interest.form_data — {"tshirt_size": "M", ...}; '{}' when none.
--
-- Written on the FIRST signup only. A repeat signup for the same email only
-- resends the link and never overwrites answers: anyone can type someone
-- else's address into the public form.
--
-- Additive. Existing rows get '{}'.
--
-- DEPLOY ORDER: apply this BEFORE the code that reads it. Without it, the
-- signup insert and the organiser's interest list both fail.

alter table public.event_interest
  add column if not exists form_data jsonb not null default '{}'::jsonb;

alter table public.event_interest
  drop constraint if exists event_interest_form_data_object;
alter table public.event_interest
  add constraint event_interest_form_data_object
  check (jsonb_typeof(form_data) = 'object');

-- Mirrors FORM_DATA_MAX_BYTES in src/lib/interest/interestFields.ts, measured
-- the same way (bytes of the JSON text). The route enforces it first with a
-- 400; this is the backstop.
alter table public.event_interest
  drop constraint if exists event_interest_form_data_size;
alter table public.event_interest
  add constraint event_interest_form_data_size
  check (octet_length(form_data::text) <= 16384);

comment on column public.event_interest.form_data is
  'Answers to the event''s custom Enrolment Form fields, keyed by field_key. Set on first signup only.';
