-- ─── Terms of Sale consent ──────────────────────────────────────────────────
--
-- Buyers now accept the KuuNyi Terms of Sale and the organiser's event rules
-- before an order is created (the Privacy Policy is linked as information),
-- and the order records what was accepted and when.
--
--   intakes.organiser_terms       — the organiser's own rules for the event,
--                                    shown to buyers; null = none.
--   enrollments.terms_accepted_at — when the buyer accepted.
--   enrollments.terms_version     — which KuuNyi terms version (TERMS_VERSION).
--   enrollments.organiser_terms_sha256
--                                 — fingerprint of the organiser rules shown,
--                                    null when the event had none.
--
-- Additive. Existing orders stay null: they were placed before consent existed.
--
-- DEPLOY ORDER: apply this BEFORE the code that reads it. Without it, the
-- order route cannot read organiser_terms and refuses every order with 503.

alter table public.intakes
  add column if not exists organiser_terms text;

alter table public.intakes
  drop constraint if exists intakes_organiser_terms_length_check;
alter table public.intakes
  add constraint intakes_organiser_terms_length_check
  check (organiser_terms is null or char_length(organiser_terms) <= 5000);

alter table public.enrollments
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists terms_version text,
  add column if not exists organiser_terms_sha256 text;

comment on column public.intakes.organiser_terms is
  'Organiser''s event rules shown to buyers before ordering; null = none. Max 5000 chars.';
comment on column public.enrollments.terms_accepted_at is
  'When the buyer accepted the Terms of Sale and event rules. Null for orders placed before consent existed.';
comment on column public.enrollments.terms_version is
  'KuuNyi Terms of Sale version accepted (TERMS_VERSION in src/lib/legal/terms.ts).';
comment on column public.enrollments.organiser_terms_sha256 is
  'sha256 fingerprint of the organiser rules the buyer was shown; null when the event had none.';
