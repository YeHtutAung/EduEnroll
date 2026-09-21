-- ─── Per-event e-ticket QR format ───────────────────────────────────────────
--
-- An event can now choose what its e-ticket QR encodes:
--
--   'jwt'  — the signed ticket token, read by the kuunyi-scanner app. Existing
--            behaviour, and the default.
--   'uuid' — the bare ticket id, for an event scanned by a third party that
--            loads a ticket list into its own system.
--
-- Additive and inert: every existing event gets 'jwt', so no ticket changes
-- until an event is switched explicitly.
--
-- DEPLOY ORDER: apply this BEFORE the code that reads it. The code fails
-- closed (503 on ticket display, no email attachment) when it cannot read the
-- column, so the reverse order breaks ticket delivery until this is applied.

alter table public.intakes
  add column if not exists ticket_qr_format text not null default 'jwt';

-- Text with a check, the same pattern as tenants.platform_fee_mode.
alter table public.intakes
  drop constraint if exists intakes_ticket_qr_format_check;
alter table public.intakes
  add constraint intakes_ticket_qr_format_check
  check (ticket_qr_format in ('jwt', 'uuid'));

comment on column public.intakes.ticket_qr_format is
  'What the e-ticket QR encodes: jwt (signed token, kuunyi-scanner) or uuid (bare tickets.id, third-party scanner).';
