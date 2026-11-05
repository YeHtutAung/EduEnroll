-- Lets an admin correct a buyer's mistyped email, and records who changed it.
--
-- The address decides where a paid e-ticket is sent, so a change must never
-- happen without its record. Both are written in one function so neither can
-- exist without the other.

create table if not exists public.enrollment_email_changes (
  id            uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.enrollments(id) on delete cascade,
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  old_email     text,
  new_email     text not null,
  changed_by    uuid not null,
  changed_at    timestamptz not null default now()
);

create index if not exists enrollment_email_changes_enrollment_idx
  on public.enrollment_email_changes (enrollment_id, changed_at desc);

-- No policies: only the service role reads or writes this table.
alter table public.enrollment_email_changes enable row level security;

-- Returns false, and changes nothing, when the order is not this tenant's or its
-- address is no longer the one the admin was looking at.
create or replace function public.change_enrollment_email(
  p_enrollment_id uuid,
  p_tenant_id     uuid,
  p_old_email     text,
  p_new_email     text,
  p_form_data     jsonb,
  p_changed_by    uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changed integer;
begin
  update public.enrollments
     set email = p_new_email,
         form_data = p_form_data
   where id = p_enrollment_id
     and tenant_id = p_tenant_id
     and email is not distinct from p_old_email;

  get diagnostics v_changed = row_count;
  if v_changed = 0 then
    return false;
  end if;

  insert into public.enrollment_email_changes
    (enrollment_id, tenant_id, old_email, new_email, changed_by)
  values
    (p_enrollment_id, p_tenant_id, p_old_email, p_new_email, p_changed_by);

  return true;
end;
$$;

revoke all on function public.change_enrollment_email(uuid, uuid, text, text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.change_enrollment_email(uuid, uuid, text, text, jsonb, uuid)
  to service_role;
