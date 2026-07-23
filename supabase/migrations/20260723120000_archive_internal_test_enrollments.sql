-- Preserve production smoke-payment history without presenting it as customer
-- activity. Archiving is an operational action, not deletion: provider ids,
-- payments, conflicts, and enrollment rows remain available for webhook replay
-- and reconciliation.

begin;

alter table public.enrollments
  add column internal_test_at timestamptz,
  add column internal_test_reason text;

alter table public.enrollments
  add constraint enrollments_internal_test_reason_chk
  check (
    (internal_test_at is null and internal_test_reason is null)
    or
    (internal_test_at is not null and nullif(btrim(internal_test_reason), '') is not null)
  );

create index enrollments_tenant_visible_idx
  on public.enrollments (tenant_id, status)
  where internal_test_at is null;

-- RLS limits rows, not columns. Without this guard an authenticated tenant
-- user with ordinary enrollment UPDATE permission could set internal_test_at
-- directly, hiding a real customer without returning capacity or voiding the
-- ticket. Only the transactional archive function may change these fields.
create or replace function public.protect_internal_test_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (
    (tg_op = 'INSERT' and (new.internal_test_at is not null or new.internal_test_reason is not null))
    or
    (tg_op = 'UPDATE' and (
      new.internal_test_at is distinct from old.internal_test_at
      or new.internal_test_reason is distinct from old.internal_test_reason
    ))
  ) and coalesce(current_setting('app.archive_internal_test', true), '') <> 'allowed' then
    raise exception 'internal test fields are function-owned' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger trg_protect_internal_test_fields
  before insert or update of internal_test_at, internal_test_reason
  on public.enrollments
  for each row
  execute function public.protect_internal_test_fields();

-- Rejection restores seats only while the enrollment still owns them. An
-- archived test enrollment has already returned its capacity atomically in
-- archive_internal_test_enrollment().
create or replace function public.update_seat_remaining()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
begin
  if new.status = 'rejected'
     and old.status in ('pending_payment', 'payment_submitted', 'confirmed', 'partial_payment')
     and old.internal_test_at is null then
    if new.class_id is not null then
      update public.classes
      set seat_remaining = least(seat_remaining + coalesce(new.quantity, 1), seat_total)
      where id = new.class_id;
    else
      for v_item in
        select class_id, quantity
        from public.enrollment_items
        where enrollment_id = new.id
      loop
        update public.classes
        set seat_remaining = least(seat_remaining + v_item.quantity, seat_total)
        where id = v_item.class_id;
      end loop;
    end if;
  end if;

  return new;
end;
$$;

-- Deleting an archived row must not return the same capacity a second time.
create or replace function public.restore_seat_on_enrollment_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
begin
  if old.internal_test_at is not null
     or old.status not in ('pending_payment', 'payment_submitted', 'confirmed', 'partial_payment') then
    return old;
  end if;

  if old.class_id is not null then
    update public.classes
    set seat_remaining = least(seat_remaining + coalesce(old.quantity, 1), seat_total)
    where id = old.class_id;
  else
    for v_item in
      select class_id, quantity
      from public.enrollment_items
      where enrollment_id = old.id
    loop
      update public.classes
      set seat_remaining = least(seat_remaining + v_item.quantity, seat_total)
      where id = v_item.class_id;
    end loop;
  end if;

  return old;
end;
$$;

create or replace function public.archive_internal_test_enrollment(
  p_enrollment_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enrollment public.enrollments%rowtype;
  v_item record;
  v_archived_at timestamptz;
begin
  if nullif(btrim(p_reason), '') is null then
    raise exception 'archive reason is required' using errcode = '22023';
  end if;

  select * into v_enrollment
  from public.enrollments
  where id = p_enrollment_id
  for update;

  if not found then
    raise exception 'enrollment not found' using errcode = 'P0002';
  end if;

  if v_enrollment.internal_test_at is not null then
    return jsonb_build_object(
      'archived', true,
      'already_archived', true,
      'enrollment_id', v_enrollment.id,
      'archived_at', v_enrollment.internal_test_at
    );
  end if;

  -- A payable attempt must be cancelled/reconciled first. Archiving it would
  -- hide a payment that can still move money and would make later settlement
  -- collide with capacity already returned here.
  if v_enrollment.status not in ('confirmed', 'rejected') then
    raise exception 'only confirmed or rejected enrollments can be archived; current status is %',
      v_enrollment.status using errcode = '55000';
  end if;

  if v_enrollment.status = 'confirmed'
     and not exists (
       select 1 from public.payments
       where enrollment_id = v_enrollment.id and status = 'verified'
     ) then
    raise exception 'confirmed enrollment has no verified payment; reconcile before archiving'
      using errcode = '55000';
  end if;

  if exists (
    select 1 from public.payment_settlement_conflicts
    where enrollment_id = v_enrollment.id
      and (status = 'open' or cleanup_status = 'pending')
  ) then
    raise exception 'enrollment has an unresolved settlement conflict'
      using errcode = '55000';
  end if;

  v_archived_at := clock_timestamp();

  perform set_config('app.archive_internal_test', 'allowed', true);

  update public.enrollments
  set internal_test_at = v_archived_at,
      internal_test_reason = btrim(p_reason)
  where id = v_enrollment.id;

  -- confirmed is the only allowed state here that still owns capacity.
  if v_enrollment.status = 'confirmed' then
    if v_enrollment.class_id is not null then
      update public.classes
      set seat_remaining = least(
        seat_remaining + coalesce(v_enrollment.quantity, 1),
        seat_total
      )
      where id = v_enrollment.class_id;
    else
      for v_item in
        select class_id, quantity
        from public.enrollment_items
        where enrollment_id = v_enrollment.id
      loop
        update public.classes
        set seat_remaining = least(seat_remaining + v_item.quantity, seat_total)
        where id = v_item.class_id;
      end loop;
    end if;
  end if;

  update public.tickets
  set status = 'void'
  where enrollment_id = v_enrollment.id
    and status <> 'void';

  return jsonb_build_object(
    'archived', true,
    'already_archived', false,
    'enrollment_id', v_enrollment.id,
    'archived_at', v_archived_at
  );
end;
$$;

revoke all on function public.archive_internal_test_enrollment(uuid, text) from public;
revoke all on function public.archive_internal_test_enrollment(uuid, text) from anon;
revoke all on function public.archive_internal_test_enrollment(uuid, text) from authenticated;
grant execute on function public.archive_internal_test_enrollment(uuid, text) to service_role;

-- Revenue is recognized only for visible, confirmed enrollments. This also
-- removes verified payments that were refunded after the enrollment was
-- rejected; payment.status remains verified because the original charge did
-- settle, but it is no longer business revenue.
create or replace function public.get_tenant_revenue(p_tenant_id uuid)
returns bigint
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_total bigint;
begin
  if public.get_my_role() <> 'superadmin'
     and p_tenant_id is distinct from public.get_my_tenant_id() then
    raise exception 'not authorized to read revenue for this tenant'
      using errcode = '42501';
  end if;

  select coalesce(sum(p.amount), 0)
  into v_total
  from public.payments p
  join public.enrollments e on e.id = p.enrollment_id
  where p.tenant_id = p_tenant_id
    and p.status = 'verified'
    and e.status = 'confirmed'
    and e.internal_test_at is null;

  return v_total;
end;
$$;

grant execute on function public.get_tenant_revenue(uuid) to authenticated;

commit;
