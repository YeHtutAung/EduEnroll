-- Rollback for 20261024120000_ticket_packs.sql
--
-- Roll the CODE back first: the public event endpoint selects these columns.
-- Orders already placed on a pack tier stay valid; their tickets already exist.
-- After this, re-running issuance on such an order would issue one ticket per
-- pack, but the unique key leaves existing tickets alone, so nobody loses one.

drop trigger if exists classes_guard_pack_size on public.classes;
drop function if exists public.guard_class_pack_size();

alter table public.classes
  drop constraint if exists classes_compare_at_amount_positive,
  drop constraint if exists classes_pack_size_range,
  drop column if exists compare_at_amount,
  drop column if exists pack_size;

notify pgrst, 'reload schema';
