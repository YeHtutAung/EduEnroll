-- ─── Ticket packages (e.g. "3 GA tickets for 125,000") ──────────────────────
--
-- A package is its own ticket type (a classes row) with its own price, stock
-- and sale window. Two new columns:
--
--   classes.pack_size         — admissions per unit sold. 1 for an ordinary
--                               tier. A "GA 3-Pack" is 3: buying one issues
--                               three QR tickets, one per person.
--   classes.compare_at_amount — display only: what the package would cost
--                               bought as single tickets (3 x 45,000 = 135,000),
--                               so the storefront can show "Save 10,000".
--                               NULL shows no saving.
--
-- Pricing is untouched on purpose. A pack's fee_amount is the package price,
-- an order line is "1 x GA 3-Pack", and fee_amount * quantity is still the
-- line total every payment route, webhook and settlement check relies on.
-- seat_total / seat_remaining count PACKS for a pack tier.
--
-- pack_size is frozen once the tier has sold anything. issueTickets() reads
-- the CURRENT pack_size and also runs as a repair on already-paid orders, so
-- changing it after a sale would issue the wrong number of tickets for that
-- order. "Sold anything" is seat_remaining < seat_total: confirmed and pending
-- orders hold stock, rejected ones have given it back. The PATCH route returns
-- a 409 first; this trigger is the backstop.
--
-- Additive. Existing tiers get pack_size 1 and behave exactly as before.
--
-- DEPLOY ORDER: apply this BEFORE the code that reads it. Without it, the
-- public event endpoint selects columns that do not exist and fails.
-- Rollback: supabase/rollbacks/20261024120000_ticket_packs.down.sql

alter table public.classes
  add column if not exists pack_size integer not null default 1,
  add column if not exists compare_at_amount integer;

alter table public.classes
  drop constraint if exists classes_pack_size_range;
alter table public.classes
  add constraint classes_pack_size_range
  check (pack_size between 1 and 20);

alter table public.classes
  drop constraint if exists classes_compare_at_amount_positive;
alter table public.classes
  add constraint classes_compare_at_amount_positive
  check (compare_at_amount is null or compare_at_amount > 0);

comment on column public.classes.pack_size is
  'Admissions (QR tickets) issued per unit sold; 1 for an ordinary tier. Frozen once the tier has sold.';
comment on column public.classes.compare_at_amount is
  'Display only: regular price of the package bought as single tickets, for a "Save X" label. NULL = none.';

create or replace function public.guard_class_pack_size()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.pack_size is distinct from old.pack_size
     and old.seat_remaining < old.seat_total then
    raise exception 'pack_size cannot change after tickets of this type have been sold'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists classes_guard_pack_size on public.classes;
create trigger classes_guard_pack_size
  before update of pack_size on public.classes
  for each row
  execute function public.guard_class_pack_size();

notify pgrst, 'reload schema';
