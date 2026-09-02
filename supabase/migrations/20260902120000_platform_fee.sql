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

-- ── Why nothing is added to payments ────────────────────────────────────────
--
-- The fee could be recorded per transaction, but the payment row is created by
-- claim_kbzpay_order_slot() and complete_kbzpay_supersede(), so storing it
-- would mean changing both signatures — hash-guarded functions, changed for a
-- display detail.
--
-- It is not needed. enrollment_items snapshot fee_amount at purchase, so the
-- ticket subtotal of an order never moves, and the same calculator that priced
-- the order reproduces the split exactly.
--
-- The one gap: an organisation that changes its fee AFTER an order would see
-- the new split on that order''s confirmation screen, while payments.amount —
-- the money — stays correct. Acceptable for screens shown at purchase time; if
-- long-lived receipts are wanted later, add payments.platform_fee then and
-- change both RPCs deliberately.
