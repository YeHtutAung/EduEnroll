-- ─── Event terms in the confirmation email ─────────────────────────────────
--
--   intakes.email_terms — an organiser's terms, printed in the email a buyer
--                          gets once their order is confirmed; null = none.
--
-- Separate from intakes.organiser_terms on purpose: those are shown at checkout
-- and the buyer must accept them. This text is only printed in the email, and
-- editing it does not ask anyone to reload the order page.
--
-- Additive. Every existing event stays null, so no email changes until an
-- organiser fills this in.
--
-- DEPLOY ORDER: apply this BEFORE the code that reads it. Without the column
-- the email still goes out, but with no terms, and saving a filled-in value
-- from the admin event page fails.

alter table public.intakes
  add column if not exists email_terms text;

alter table public.intakes
  drop constraint if exists intakes_email_terms_length_check;
alter table public.intakes
  add constraint intakes_email_terms_length_check
  check (email_terms is null or char_length(email_terms) <= 5000);
