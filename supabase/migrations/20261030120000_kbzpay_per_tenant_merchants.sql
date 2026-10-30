-- ─── KBZPay per-tenant merchants ─────────────────────────────────────────────
-- Spec: docs/superpowers/specs/2026-10-30-kbzpay-per-tenant-merchants-design.md
--
-- Order is load-bearing (§4.2): column → backfill → CHECK → trigger. With the
-- immutability trigger in place first, the backfill (NULL → 'BRAVE') would be
-- rejected and this migration would abort.

-- Fail fast rather than queue every payment read behind a long-running
-- transaction while ADD COLUMN holds ACCESS EXCLUSIVE on payments.
SET LOCAL lock_timeout = '5s';

-- ── 1. Tenant → merchant mapping (§4.1) ─────────────────────────────────────
-- Not a tenants column: tenant owners can update their own tenant row, and the
-- mapping is the operator's alone.
CREATE TABLE public.kbzpay_merchant_assignments (
  tenant_id   uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE RESTRICT,
  merchant_id text NOT NULL CHECK (merchant_id ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Keeps updated_at truthful when the operator reassigns a tenant (same trigger as tenant_bots).
CREATE TRIGGER kbzpay_merchant_assignments_updated_at
  BEFORE UPDATE ON public.kbzpay_merchant_assignments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.kbzpay_merchant_assignments ENABLE ROW LEVEL SECURITY;
-- No policies: anon and authenticated can neither read nor write.
REVOKE ALL ON public.kbzpay_merchant_assignments FROM public, anon, authenticated;
-- The RPCs run as owner and don't need this; it documents intent and covers operator scripts.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.kbzpay_merchant_assignments TO service_role;

INSERT INTO public.kbzpay_merchant_assignments (tenant_id, merchant_id)
SELECT id, 'BRAVE' FROM public.tenants WHERE subdomain = 'brave'
ON CONFLICT (tenant_id) DO NOTHING;

-- A NOTICE, not an exception: an environment without Brave is legitimate.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE subdomain = 'brave') THEN
    RAISE NOTICE 'kbzpay: no tenant with subdomain brave; no BRAVE assignment inserted';
  END IF;
END;
$$;

-- ── 2. Pin column, backfill, CHECK (§4.2) ───────────────────────────────────
ALTER TABLE public.payments ADD COLUMN kbzpay_merchant text;

COMMENT ON COLUMN public.payments.kbzpay_merchant IS
  'KBZPay merchant id (KBZPAY_<ID>_*) that created this order. Written once at insert by claim_kbzpay_order_slot / complete_kbzpay_supersede; immutable (trg_protect_payment_kbzpay_merchant). NULL for every other payment method.';

-- The pin records which merchant CREATED an order, not which tenant owns it.
-- Before this migration there was exactly one KBZPay credential set, the
-- platform-wide KBZPAY_* vars, and it was Brave's merchant. So every existing
-- KBZPay order, whichever tenant it belongs to, lives under BRAVE at KBZPay and
-- can only be queried or closed there. Tenants other than Brave get no
-- assignment above, so this grants them nothing: they cannot create a new
-- KBZPay order until the operator assigns them their own merchant.
UPDATE public.payments
   SET kbzpay_merchant = 'BRAVE'
 WHERE payment_method = 'kbzpay_mmqr'
   AND kbzpay_merchant IS NULL;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_kbzpay_merchant_required
  -- Both directions, null-safe (payment_method is nullable): a KBZPay row must
  -- carry a pin, and no other row may. That also stops a pinned KBZPay row
  -- from being re-labelled as another method while keeping its pin.
  CHECK ((payment_method IS NOT DISTINCT FROM 'kbzpay_mmqr') = (kbzpay_merchant IS NOT NULL));

-- ── 3. Immutability trigger (§4.2) ──────────────────────────────────────────
-- SECURITY INVOKER, like protect_internal_test_fields(). Inside the
-- SECURITY DEFINER RPCs it runs as their owner and can read the assignments
-- table; a direct PostgREST insert carrying a pin fails on the revoked table.
CREATE OR REPLACE FUNCTION public.protect_payment_kbzpay_merchant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_assigned text;
BEGIN
  IF tg_op = 'UPDATE' THEN
    IF new.kbzpay_merchant IS DISTINCT FROM old.kbzpay_merchant THEN
      RAISE EXCEPTION 'payments.kbzpay_merchant is immutable' USING errcode = '42501';
    END IF;
    IF new.tenant_id IS DISTINCT FROM old.tenant_id AND old.kbzpay_merchant IS NOT NULL THEN
      RAISE EXCEPTION 'a pinned KBZPay payment cannot move tenant' USING errcode = '42501';
    END IF;
    RETURN new;
  END IF;

  IF new.kbzpay_merchant IS NOT NULL THEN
    SELECT a.merchant_id INTO v_assigned
      FROM public.kbzpay_merchant_assignments a
     WHERE a.tenant_id = new.tenant_id;

    IF v_assigned IS DISTINCT FROM new.kbzpay_merchant THEN
      RAISE EXCEPTION 'kbzpay_merchant does not match the tenant assignment' USING errcode = '42501';
    END IF;
  END IF;

  RETURN new;
END;
$$;

CREATE TRIGGER trg_protect_payment_kbzpay_merchant
  BEFORE INSERT OR UPDATE OF kbzpay_merchant, tenant_id ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.protect_payment_kbzpay_merchant();

-- ── 4. claim_kbzpay_order_slot (§4.3) ───────────────────────────────────────
-- Return type gains `merchant`. CREATE OR REPLACE cannot change a return type,
-- so drop first. Argument list unchanged.
DROP FUNCTION IF EXISTS public.claim_kbzpay_order_slot(uuid, uuid, text, integer, timestamptz, integer);

CREATE FUNCTION public.claim_kbzpay_order_slot(
  p_enrollment_id uuid,
  p_tenant_id     uuid,
  p_payment_ref   text,
  p_amount        integer,
  p_expires_at    timestamptz,
  p_platform_fee  integer DEFAULT 0
)
RETURNS TABLE (outcome text, payment_id uuid, ref text, qr text, merchant text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_live     public.payments%ROWTYPE;
  v_tenant   uuid;
  v_new_id   uuid;
  v_merchant text;
BEGIN
  -- Serialise concurrent creators for this enrollment (spec R4) AND re-prove,
  -- under that same lock, that the enrollment is a legal target for a new
  -- payment.
  --
  -- The route's earlier scoped lookup is a TOCTOU check: an admin rejection, an
  -- auto-cancellation, or a mismatched tenant id can land between it and this
  -- function. Since this is SECURITY DEFINER and inserts payments rows, the
  -- ownership and status test must happen HERE, holding the lock — otherwise an
  -- awaiting-payment KBZPay row can be created against a rejected enrollment,
  -- or attributed to a tenant unrelated to it.
  --
  -- Under READ COMMITTED, FOR UPDATE re-evaluates the WHERE clause once the
  -- lock is granted, so a concurrent transition to 'rejected' makes this row
  -- stop matching and the function fails closed rather than racing it.
  SELECT e.tenant_id INTO v_tenant
    FROM public.enrollments e
   WHERE e.id        = p_enrollment_id
     AND e.tenant_id = p_tenant_id
     AND e.status IN ('pending_payment', 'partial_payment')
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid_enrollment'::text, NULL::uuid, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT * INTO v_live
    FROM public.payments
   WHERE enrollment_id  = p_enrollment_id
     AND payment_method = 'kbzpay_mmqr'
     AND status         = 'awaiting_payment'
     AND mmqr_status    = 'PENDING'
   LIMIT 1;

  -- reuse / unresolved return the EXISTING row's pin, never the current
  -- assignment: removing an assignment must not strand an order already live.
  IF FOUND THEN
    IF v_live.amount = p_amount
       AND v_live.platform_fee = p_platform_fee
       AND v_live.provider_qr IS NOT NULL
       AND v_live.provider_order_expires_at IS NOT NULL
       AND v_live.provider_order_expires_at > now()
    THEN
      RETURN QUERY SELECT 'reuse'::text, v_live.id, v_live.payment_ref, v_live.provider_qr, v_live.kbzpay_merchant;
    ELSE
      RETURN QUERY SELECT 'unresolved'::text, v_live.id, v_live.payment_ref, NULL::text, v_live.kbzpay_merchant;
    END IF;
    RETURN;
  END IF;

  -- No assignment → no new order. Checked only on the insert path (§4.3).
  -- FOR SHARE holds the assignment until commit, so a concurrent reassignment
  -- cannot make the trigger's re-read disagree.
  SELECT a.merchant_id INTO v_merchant
    FROM public.kbzpay_merchant_assignments a
   WHERE a.tenant_id = v_tenant
     FOR SHARE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_merchant'::text, NULL::uuid, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- status MUST be 'awaiting_payment', never 'pending': the INSERT branch of
  -- trg_payments_sync_enrollment fires on 'pending' and would advance the
  -- enrollment to payment_submitted before any QR exists. That is the exact
  -- hazard migration 054 was written to fix.
  -- v_tenant, read from the locked enrollment row, rather than the p_tenant_id
  -- argument: the payment can then never be attributed to a tenant other than
  -- the one that owns its enrollment, even if the guard above is later loosened.
  INSERT INTO public.payments (
    enrollment_id, tenant_id, amount, platform_fee, payment_ref, payment_method,
    mmqr_status, status, provider_order_expires_at, kbzpay_merchant
  ) VALUES (
    p_enrollment_id, v_tenant, p_amount, p_platform_fee, p_payment_ref, 'kbzpay_mmqr',
    'PENDING', 'awaiting_payment', p_expires_at, v_merchant
  )
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT 'created'::text, v_new_id, p_payment_ref, NULL::text, v_merchant;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_kbzpay_order_slot(uuid, uuid, text, integer, timestamptz, integer)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_kbzpay_order_slot(uuid, uuid, text, integer, timestamptz, integer)
  TO service_role;

-- ── 5. complete_kbzpay_supersede (§4.3) ─────────────────────────────────────
DROP FUNCTION IF EXISTS public.complete_kbzpay_supersede(uuid, uuid, text, text, text, integer, timestamptz, integer);

CREATE FUNCTION public.complete_kbzpay_supersede(
  p_enrollment_id    uuid,
  p_tenant_id        uuid,
  p_expected_old_ref text,
  p_reason           text,
  p_new_ref          text,
  p_amount           integer,
  p_expires_at       timestamptz,
  p_platform_fee     integer DEFAULT 0
)
RETURNS TABLE (outcome text, payment_id uuid, merchant text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old               public.payments%ROWTYPE;
  v_tenant            uuid;
  v_enrollment_status public.enrollments.status%TYPE;
  v_new_id            uuid;
  v_merchant          text;
BEGIN
  IF p_reason NOT IN ('FAILED', 'EXPIRED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'invalid reason: %', p_reason;
  END IF;

  -- Lock the enrollment and prove TENANT OWNERSHIP on every path. Ownership is
  -- unconditional: no outcome of this function may be reported to a caller that
  -- does not own the enrollment.
  --
  -- The enrollment STATUS is deliberately NOT tested here — see the guard
  -- further down, immediately before the write.
  SELECT e.tenant_id, e.status
    INTO v_tenant, v_enrollment_status
    FROM public.enrollments e
   WHERE e.id        = p_enrollment_id
     AND e.tenant_id = p_tenant_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid_enrollment'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  SELECT * INTO v_old
    FROM public.payments
   WHERE enrollment_id  = p_enrollment_id
     AND payment_ref    = p_expected_old_ref
     AND payment_method = 'kbzpay_mmqr'
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  -- A callback settled it between the provider query and this transition. The
  -- caller must return the settled outcome, NOT a fresh QR for an enrollment
  -- that has just been paid (spec R7, R11).
  IF v_old.status = 'verified' THEN
    RETURN QUERY SELECT 'already_settled'::text, v_old.id, NULL::text;
    RETURN;
  END IF;

  -- Someone else already retired it. The caller re-claims rather than assuming
  -- anything about why.
  IF v_old.mmqr_status IS DISTINCT FROM 'PENDING' THEN
    RETURN QUERY SELECT 'not_live'::text, v_old.id, NULL::text;
    RETURN;
  END IF;

  -- Enrollment status is validated HERE, and only here: this guard protects the
  -- write below, and nothing above it writes anything.
  --
  -- Position is load-bearing. Placed with the ownership check, it shadowed the
  -- 'already_settled' branch: settling the old payment fires
  -- trg_payments_sync_enrollment, which sets the enrollment to 'confirmed', so
  -- the status test rejected the very case R11 requires be reported as paid.
  -- The route would then return 409 to a student who had just paid successfully.
  -- A confirmed enrollment is not an invalid state here — it is the expected
  -- consequence of settlement, and it must be reported, not refused.
  --
  -- Reaching this point means the old order is genuinely live and unpaid, so an
  -- ineligible enrollment (rejected or auto-cancelled while the route was
  -- talking to KBZPay) really does mean there is nothing to replace it with.
  -- Failing closed leaves the old row untouched and PENDING.
  IF v_enrollment_status NOT IN ('pending_payment', 'partial_payment') THEN
    RETURN QUERY SELECT 'invalid_enrollment'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  -- Before the write below, so no_merchant changes nothing (§4.3).
  -- FOR SHARE holds the assignment until commit, so a concurrent reassignment
  -- cannot make the trigger's re-read disagree.
  SELECT a.merchant_id INTO v_merchant
    FROM public.kbzpay_merchant_assignments a
   WHERE a.tenant_id = v_tenant
     FOR SHARE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_merchant'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  UPDATE public.payments
     SET mmqr_status = p_reason
   WHERE id = v_old.id;

  INSERT INTO public.payments (
    enrollment_id, tenant_id, amount, platform_fee, payment_ref, payment_method,
    mmqr_status, status, provider_order_expires_at, kbzpay_merchant
  ) VALUES (
    p_enrollment_id, v_tenant, p_amount, p_platform_fee, p_new_ref, 'kbzpay_mmqr',
    'PENDING', 'awaiting_payment', p_expires_at, v_merchant
  )
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT 'replaced'::text, v_new_id, v_merchant;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_kbzpay_supersede(uuid, uuid, text, text, text, integer, timestamptz, integer)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_kbzpay_supersede(uuid, uuid, text, text, text, integer, timestamptz, integer)
  TO service_role;
