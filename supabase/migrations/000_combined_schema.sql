-- ============================================================
-- 000_combined_schema.sql
-- Nihon Moment — Japanese Language School Enrollment System
--
-- Run this single file against a fresh Supabase project to
-- initialise the complete schema.
--
-- Dependency-safe execution order:
--   1. Enum types
--   2. tenants table   (no FK deps)
--   3. users table     (FK → tenants, auth.users)
--   4. Helper function get_my_tenant_id()   ← needs users to exist
--   5. RLS on tenants + users
--   6. intakes         (FK → tenants)
--   7. classes         (FK → intakes, tenants)
--   8. enrollments     (FK → classes, tenants)
--   9. payments        (FK → enrollments, tenants, users)
--  10. bank_accounts   (FK → tenants)
-- ============================================================


-- ============================================================
-- SECTION 1 — Enum types
-- All enums declared upfront so every table definition can
-- reference them without ordering constraints.
-- ============================================================

CREATE TYPE plan_type         AS ENUM ('starter', 'pro');
CREATE TYPE user_role         AS ENUM ('owner', 'admin', 'student');
CREATE TYPE intake_status     AS ENUM ('draft', 'open', 'closed');
CREATE TYPE jlpt_level        AS ENUM ('N5', 'N4', 'N3', 'N2', 'N1');
CREATE TYPE class_status      AS ENUM ('draft', 'open', 'full', 'closed');
CREATE TYPE enrollment_status AS ENUM (
  'pending_payment',
  'payment_submitted',
  'confirmed',
  'rejected'
);
CREATE TYPE payment_status    AS ENUM ('pending', 'verified', 'rejected');
CREATE TYPE myanmar_bank      AS ENUM ('KBZ', 'AYA', 'CB', 'UAB', 'Yoma', 'Other');


-- ============================================================
-- SECTION 2 — tenants
-- Root of the multi-tenant hierarchy; no FK dependencies.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.tenants (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        varchar     NOT NULL,
  subdomain   varchar     NOT NULL UNIQUE,
  logo_url    text,
  currency    varchar     NOT NULL DEFAULT 'MMK',
  language    varchar     NOT NULL DEFAULT 'my+en',
  plan        plan_type   NOT NULL DEFAULT 'starter',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenants_subdomain ON public.tenants (subdomain);


-- ============================================================
-- SECTION 3 — users
-- Application users linked to Supabase auth.users.
-- Must exist before get_my_tenant_id() is created.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.users (
  id          uuid        PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  tenant_id   uuid        NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  email       varchar     NOT NULL,
  role        user_role   NOT NULL DEFAULT 'student',
  full_name   varchar,
  phone       varchar,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON public.users (tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_email     ON public.users (email);


-- ============================================================
-- SECTION 4 — Helper function: get_my_tenant_id()
-- LANGUAGE sql bodies are type-checked at CREATE time, so
-- this must come after public.users is created.
-- SECURITY DEFINER lets it bypass RLS on users to avoid a
-- circular dependency when policies call it.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_my_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id
  FROM   public.users
  WHERE  id = auth.uid()
  LIMIT  1;
$$;


-- ============================================================
-- SECTION 5 — Row Level Security: tenants + users
-- Policies that call get_my_tenant_id() must come after
-- that function exists (section 4).
-- ============================================================

-- tenants ---------------------------------------------------
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenants_select"
  ON public.tenants
  FOR SELECT
  TO authenticated
  USING (id = public.get_my_tenant_id());

CREATE POLICY "tenants_insert"
  ON public.tenants
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "tenants_update"
  ON public.tenants
  FOR UPDATE
  TO authenticated
  USING     (id = public.get_my_tenant_id())
  WITH CHECK (id = public.get_my_tenant_id());

-- users -----------------------------------------------------
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_select"
  ON public.users
  FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_my_tenant_id());

CREATE POLICY "users_insert"
  ON public.users
  FOR INSERT
  TO authenticated
  WITH CHECK (tenant_id = public.get_my_tenant_id());

CREATE POLICY "users_update"
  ON public.users
  FOR UPDATE
  TO authenticated
  USING     (tenant_id = public.get_my_tenant_id())
  WITH CHECK (tenant_id = public.get_my_tenant_id());


-- ============================================================
-- SECTION 6 — intakes
-- FK → tenants
-- ============================================================

CREATE TABLE IF NOT EXISTS public.intakes (
  id          uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid           NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  name        varchar        NOT NULL,  -- bilingual label stored as-is
  year        integer        NOT NULL,
  status      intake_status  NOT NULL DEFAULT 'draft',
  created_at  timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_intakes_tenant_id ON public.intakes (tenant_id);
CREATE INDEX IF NOT EXISTS idx_intakes_year      ON public.intakes (tenant_id, year);

ALTER TABLE public.intakes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "intakes_select"
  ON public.intakes
  FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_my_tenant_id());

CREATE POLICY "intakes_insert"
  ON public.intakes
  FOR INSERT
  TO authenticated
  WITH CHECK (tenant_id = public.get_my_tenant_id());

CREATE POLICY "intakes_update"
  ON public.intakes
  FOR UPDATE
  TO authenticated
  USING     (tenant_id = public.get_my_tenant_id())
  WITH CHECK (tenant_id = public.get_my_tenant_id());


-- ============================================================
-- SECTION 7 — classes
-- FK → intakes, tenants
-- Default fees (MMK): N5=300,000 | N4=350,000 | N3=400,000
--                     N2=450,000 | N1=500,000
-- ============================================================

CREATE TABLE IF NOT EXISTS public.classes (
  id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_id            uuid          NOT NULL REFERENCES public.intakes (id) ON DELETE CASCADE,
  tenant_id            uuid          NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  level                jlpt_level    NOT NULL,
  fee_mmk              integer       NOT NULL,
  seat_total           integer       NOT NULL,
  seat_remaining       integer       NOT NULL,
  enrollment_open_at   timestamptz,
  enrollment_close_at  timestamptz,
  status               class_status  NOT NULL DEFAULT 'draft',
  created_at           timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT classes_seats_check CHECK (seat_remaining >= 0 AND seat_remaining <= seat_total),
  UNIQUE (intake_id, level)  -- one class per level per intake
);

CREATE INDEX IF NOT EXISTS idx_classes_intake_id ON public.classes (intake_id);
CREATE INDEX IF NOT EXISTS idx_classes_tenant_id ON public.classes (tenant_id);
CREATE INDEX IF NOT EXISTS idx_classes_level     ON public.classes (level);

-- Seed helper: inserts all 5 JLPT levels with default fees
-- Usage: SELECT public.seed_default_classes('<intake_id>', '<tenant_id>', 30);
CREATE OR REPLACE FUNCTION public.seed_default_classes(
  p_intake_id   uuid,
  p_tenant_id   uuid,
  p_seat_total  integer DEFAULT 30
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.classes
    (intake_id, tenant_id, level, fee_mmk, seat_total, seat_remaining)
  VALUES
    (p_intake_id, p_tenant_id, 'N5', 300000, p_seat_total, p_seat_total),
    (p_intake_id, p_tenant_id, 'N4', 350000, p_seat_total, p_seat_total),
    (p_intake_id, p_tenant_id, 'N3', 400000, p_seat_total, p_seat_total),
    (p_intake_id, p_tenant_id, 'N2', 450000, p_seat_total, p_seat_total),
    (p_intake_id, p_tenant_id, 'N1', 500000, p_seat_total, p_seat_total)
  ON CONFLICT (intake_id, level) DO NOTHING;
$$;

ALTER TABLE public.classes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "classes_select"
  ON public.classes
  FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_my_tenant_id());

CREATE POLICY "classes_insert"
  ON public.classes
  FOR INSERT
  TO authenticated
  WITH CHECK (tenant_id = public.get_my_tenant_id());

CREATE POLICY "classes_update"
  ON public.classes
  FOR UPDATE
  TO authenticated
  USING     (tenant_id = public.get_my_tenant_id())
  WITH CHECK (tenant_id = public.get_my_tenant_id());


-- ============================================================
-- SECTION 8 — enrollments
-- FK → classes, tenants
-- ============================================================

CREATE TABLE IF NOT EXISTS public.enrollments (
  id               uuid               PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_ref   varchar(20)        NOT NULL UNIQUE,  -- e.g. "NM-2026-00042"
  class_id         uuid               NOT NULL REFERENCES public.classes (id),
  tenant_id        uuid               NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  student_name_en  varchar            NOT NULL,   -- name in English
  student_name_mm  varchar,                       -- name in Myanmar script
  nrc_number       varchar,                       -- National Registration Card
  phone            varchar            NOT NULL,
  email            varchar,
  status           enrollment_status  NOT NULL DEFAULT 'pending_payment',
  enrolled_at      timestamptz        NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_enrollments_tenant_id      ON public.enrollments (tenant_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_class_id       ON public.enrollments (class_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_enrollment_ref ON public.enrollments (enrollment_ref);
CREATE INDEX IF NOT EXISTS idx_enrollments_status         ON public.enrollments (tenant_id, status);

-- Auto-generate enrollment_ref: NM-YYYY-NNNNN
CREATE SEQUENCE IF NOT EXISTS enrollment_ref_seq START 1;

CREATE OR REPLACE FUNCTION public.generate_enrollment_ref()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.enrollment_ref := 'NM-' || to_char(now(), 'YYYY') || '-'
                        || lpad(nextval('enrollment_ref_seq')::text, 5, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enrollments_ref
  BEFORE INSERT ON public.enrollments
  FOR EACH ROW
  WHEN (NEW.enrollment_ref IS NULL OR NEW.enrollment_ref = '')
  EXECUTE FUNCTION public.generate_enrollment_ref();

-- Decrement seat_remaining when an enrollment is confirmed;
-- restore it if a confirmed enrollment is later rejected.
CREATE OR REPLACE FUNCTION public.update_seat_remaining()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'confirmed' AND OLD.status <> 'confirmed' THEN
    UPDATE public.classes
    SET seat_remaining = seat_remaining - 1
    WHERE id = NEW.class_id AND seat_remaining > 0;

  ELSIF OLD.status = 'confirmed' AND NEW.status = 'rejected' THEN
    UPDATE public.classes
    SET seat_remaining = seat_remaining + 1
    WHERE id = NEW.class_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enrollments_seats
  AFTER UPDATE OF status ON public.enrollments
  FOR EACH ROW
  EXECUTE FUNCTION public.update_seat_remaining();

ALTER TABLE public.enrollments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "enrollments_select"
  ON public.enrollments
  FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_my_tenant_id());

-- Anonymous students may submit their own enrollment
CREATE POLICY "enrollments_insert_anon"
  ON public.enrollments
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "enrollments_update"
  ON public.enrollments
  FOR UPDATE
  TO authenticated
  USING     (tenant_id = public.get_my_tenant_id())
  WITH CHECK (tenant_id = public.get_my_tenant_id());


-- ============================================================
-- SECTION 9 — payments
-- FK → enrollments, tenants, users
-- ============================================================

CREATE TABLE IF NOT EXISTS public.payments (
  id               uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id    uuid            NOT NULL REFERENCES public.enrollments (id) ON DELETE CASCADE,
  tenant_id        uuid            NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  amount_mmk       integer         NOT NULL,
  proof_image_url  text,
  bank_reference   varchar,
  status           payment_status  NOT NULL DEFAULT 'pending',
  verified_by      uuid            REFERENCES public.users (id),
  verified_at      timestamptz,
  created_at       timestamptz     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_tenant_id     ON public.payments (tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_enrollment_id ON public.payments (enrollment_id);
CREATE INDEX IF NOT EXISTS idx_payments_status        ON public.payments (tenant_id, status);

-- Sync enrollment status when a payment is verified or rejected
CREATE OR REPLACE FUNCTION public.sync_enrollment_on_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'verified' AND OLD.status <> 'verified' THEN
    UPDATE public.enrollments
    SET status = 'confirmed'
    WHERE id = NEW.enrollment_id;

  ELSIF NEW.status = 'rejected' AND OLD.status <> 'rejected' THEN
    UPDATE public.enrollments
    SET status = 'rejected'
    WHERE id = NEW.enrollment_id;

  -- Student submits proof → move enrollment to payment_submitted
  ELSIF NEW.status = 'pending' AND OLD.status IS DISTINCT FROM 'pending' THEN
    UPDATE public.enrollments
    SET status = 'payment_submitted'
    WHERE id = NEW.enrollment_id AND status = 'pending_payment';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_payments_sync_enrollment
  AFTER INSERT OR UPDATE OF status ON public.payments
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_enrollment_on_payment();

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payments_select"
  ON public.payments
  FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_my_tenant_id());

-- Anonymous students may submit payment proof
CREATE POLICY "payments_insert_anon"
  ON public.payments
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "payments_update"
  ON public.payments
  FOR UPDATE
  TO authenticated
  USING     (tenant_id = public.get_my_tenant_id())
  WITH CHECK (tenant_id = public.get_my_tenant_id());


-- ============================================================
-- SECTION 10 — bank_accounts
-- FK → tenants
-- Anonymous SELECT allowed so students can see payment details
-- ============================================================

CREATE TABLE IF NOT EXISTS public.bank_accounts (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid          NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  bank_name        myanmar_bank  NOT NULL,
  account_number   varchar       NOT NULL,
  account_holder   varchar       NOT NULL,
  is_active        boolean       NOT NULL DEFAULT true,
  created_at       timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bank_accounts_tenant_id ON public.bank_accounts (tenant_id);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_active    ON public.bank_accounts (tenant_id, is_active);

ALTER TABLE public.bank_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bank_accounts_select_authenticated"
  ON public.bank_accounts
  FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_my_tenant_id());

CREATE POLICY "bank_accounts_select_anon"
  ON public.bank_accounts
  FOR SELECT
  TO anon
  USING (is_active = true);

CREATE POLICY "bank_accounts_insert"
  ON public.bank_accounts
  FOR INSERT
  TO authenticated
  WITH CHECK (tenant_id = public.get_my_tenant_id());

CREATE POLICY "bank_accounts_update"
  ON public.bank_accounts
  FOR UPDATE
  TO authenticated
  USING     (tenant_id = public.get_my_tenant_id())
  WITH CHECK (tenant_id = public.get_my_tenant_id());
