-- Rollback for 20261024120000_ticket_packs.sql
--
-- Roll the CODE back first: the public event endpoint selects these columns.
--
-- Dropping pack_size makes every package tier issue one ticket per unit, so
-- this refuses to run while doing so would short anyone. Two guards, checked
-- under a lock that keeps new orders out between the check and the drop:
--
--   1. A package tier still on sale (status 'open'). After the rollback it
--      would sell ONE ticket at the package price. Close it first.
--
--   2. A package order still owed tickets: any order that is not rejected and
--      not archived as an internal test, holding fewer tickets for a package
--      line than quantity x pack_size. That is every pending order (it has
--      none yet and would get one per pack on settling) and any confirmed order
--      whose issuance failed part-way (the repair could no longer fill it).
--      Settle or reject those orders, or issue their tickets, first.
--
-- Fully issued confirmed orders are safe: their tickets exist, and the
-- repair's ignoreDuplicates upsert never removes one.
--
-- Atomic: a refusal leaves the schema exactly as it was.

begin;

-- submit_enrollment / submit_cart_enrollment take FOR UPDATE row locks on
-- classes; EXCLUSIVE conflicts with those, so no order can be placed on a
-- package tier between the checks below and the drop.
lock table public.classes in exclusive mode;

do $$
declare
  v_on_sale integer;
  v_owed    integer;
begin
  select count(*) into v_on_sale
  from   public.classes
  where  pack_size > 1 and status = 'open';

  if v_on_sale > 0 then
    raise exception 'ticket_packs rollback refused: % package ticket type(s) still on sale; close them first', v_on_sale;
  end if;

  with lines as (
    -- Single-class orders carry their line on the enrollment; cart orders
    -- (class_id null) on enrollment_items. The two never overlap.
    select e.id as enrollment_id, e.class_id, coalesce(e.quantity, 1) as qty
    from   public.enrollments e
    where  e.class_id is not null
    union all
    select ei.enrollment_id, ei.class_id, coalesce(ei.quantity, 1)
    from   public.enrollment_items ei
  ),
  owed as (
    select l.enrollment_id, l.class_id, sum(l.qty) * c.pack_size as admissions
    from   lines l
    join   public.classes c     on c.id = l.class_id
    join   public.enrollments e on e.id = l.enrollment_id
    where  c.pack_size > 1
      and  e.status <> 'rejected'
      and  e.internal_test_at is null
    group by l.enrollment_id, l.class_id, c.pack_size
  )
  select count(*) into v_owed
  from   owed o
  where  (select count(*) from public.tickets t
          where t.enrollment_id = o.enrollment_id and t.class_id = o.class_id) < o.admissions;

  if v_owed > 0 then
    raise exception 'ticket_packs rollback refused: % package order line(s) are still owed tickets', v_owed;
  end if;
end $$;

drop trigger if exists classes_guard_pack_size on public.classes;
drop function if exists public.guard_class_pack_size();

alter table public.classes
  drop constraint if exists classes_compare_at_amount_positive,
  drop constraint if exists classes_pack_size_range,
  drop column if exists compare_at_amount,
  drop column if exists pack_size;

notify pgrst, 'reload schema';

commit;
