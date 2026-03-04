-- ============================================================
-- 006_create_payments.sql
-- Payments — proof-of-payment submissions per enrollment
-- ============================================================

-- Enum -------------------------------------------------------
CREATE TYPE payment_status AS ENUM ('pending', 'verified', 'rejected');

-- Table ------------------------------------------------------
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

-- Indexes ----------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_payments_tenant_id     ON public.payments (tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_enrollment_id ON public.payments (enrollment_id);
CREATE INDEX IF NOT EXISTS idx_payments_status        ON public.payments (tenant_id, status);

-- ============================================================
-- Sync enrollment status when payment is verified / rejected
-- ============================================================
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

-- ============================================================
-- Row Level Security
-- ============================================================
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payments_select"
  ON public.payments
  FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_my_tenant_id());

-- Anon students may submit payment proof
CREATE POLICY "payments_insert_anon"
  ON public.payments
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "payments_update"
  ON public.payments
  FOR UPDATE
  TO authenticated
  USING   (tenant_id = public.get_my_tenant_id())
  WITH CHECK (tenant_id = public.get_my_tenant_id());
