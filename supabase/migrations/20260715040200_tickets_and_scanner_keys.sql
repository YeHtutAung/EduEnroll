-- Tickets: one row per admission.
create table if not exists public.tickets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  intake_id uuid not null references public.intakes(id) on delete cascade,
  enrollment_id uuid not null references public.enrollments(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  tier text not null,
  admits int not null default 1,
  seat_no int not null,
  exp timestamptz not null,
  kid text not null,
  status text not null default 'valid',
  first_scan_at timestamptz,
  first_scan_gate text,
  created_at timestamptz not null default now()
);
create index if not exists tickets_tenant_intake_idx on public.tickets (tenant_id, intake_id);
create index if not exists tickets_enrollment_idx on public.tickets (enrollment_id);
create unique index if not exists tickets_enrollment_class_seat_uniq
  on public.tickets (enrollment_id, class_id, seat_no);

-- scanner_api_keys: per-tenant bearer keys (hashed)
create table if not exists public.scanner_api_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  key_hash text not null unique,
  key_prefix text not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists scanner_api_keys_hash_idx on public.scanner_api_keys (key_hash);

alter table public.tickets enable row level security;
alter table public.scanner_api_keys enable row level security;
-- No policies: access is service-role only (createAdminClient bypasses RLS).
