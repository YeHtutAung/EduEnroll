-- ─── Online platform fee ────────────────────────────────────────────────────
--
-- An organisation may add a platform fee on top of the ticket subtotal, either
-- once per order or per ticket. The buyer pays one combined amount: the fee is
-- never a second transaction.
--
-- Defaults are deliberately inert. Every existing tenant gets mode 'none' and
-- amount 0, so no live checkout changes price until someone opts in.

alter table public.tenants
  add column if not exists platform_fee_mode text not null default 'none',
  add column if not exists platform_fee_amount integer not null default 0;

-- Text with a check, matching how mmqr_provider is stored on this table. An
-- enum would need ALTER TYPE ordering care for a value this likely to grow.
alter table public.tenants
  drop constraint if exists tenants_platform_fee_mode_check;
alter table public.tenants
  add constraint tenants_platform_fee_mode_check
  check (platform_fee_mode in ('none', 'per_transaction', 'per_ticket'));

-- A negative fee would discount the order, which no caller expects and which
-- the amount comparison at settlement would have no way to distinguish from a
-- miscalculation.
alter table public.tenants
  drop constraint if exists tenants_platform_fee_amount_check;
alter table public.tenants
  add constraint tenants_platform_fee_amount_check
  check (platform_fee_amount >= 0);

comment on column public.tenants.platform_fee_mode is
  'How the online platform fee is charged: none, per_transaction (flat, once '
  'per order) or per_ticket (flat, multiplied by ticket count). Applies only '
  'to online gateways — a bank_transfer tenant never charges it.';

comment on column public.tenants.platform_fee_amount is
  'Flat fee in the tenant currency''s whole units. Meaningless when '
  'platform_fee_mode is none.';

-- ── The fee is also recorded per payment ────────────────────────────────────
--
-- This migration originally stored the fee on the TENANT only, arguing that
-- `amount - ticket_subtotal` could recover it wherever the split was needed and
-- that changing the two kbzpay RPCs for a display detail was not worth it.
--
-- That was wrong, and review found it six times over. The subtraction is only
-- valid when the amount charged IS the order total — not for a partial-payment
-- remainder, and not once a display site is free to read a different item set
-- than the one that was priced. Each new reader had to rediscover both rules.
--
-- 20260903090000 adds `payments.platform_fee` and threads it through every
-- creation path, so the split is decided once and read, never re-derived.
