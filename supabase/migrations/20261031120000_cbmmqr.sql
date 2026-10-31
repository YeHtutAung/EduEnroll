-- ─── CB Bank MMQR ───────────────────────────────────────────────────────────
-- Spec: docs/superpowers/specs/2026-10-31-cb-mmqr-integration-design.md §4.3
--
-- Mirrors 20261030120000_kbzpay_per_tenant_merchants.sql. Nothing here touches
-- a KBZPay, ABank or MMPay row: every constraint and index is scoped to
-- payment_method = 'cb_mmqr', and the trigger ignores other rows.
--
-- Lock order: every function that locks an existing payment takes the payment
-- row first, then its enrollment. That matches settleMmqrPayment (UPDATE
-- payments, then trg_payments_sync_enrollment updates the enrollment).
-- claim_cbmmqr_order_slot locks only the enrollment and never locks an existing
-- payment. Any future function must follow this order.
--
-- ROLLBACK (safe only while no cb_mmqr payment exists):
--   DROP FUNCTION IF EXISTS public.bind_cbmmqr_settlement(text, text, text, text);
--   DROP FUNCTION IF EXISTS public.store_cbmmqr_qr(text, text, text, timestamptz);
--   DROP FUNCTION IF EXISTS public.complete_cbmmqr_replace(uuid, uuid, text, text, text, integer, timestamptz, integer);
--   DROP FUNCTION IF EXISTS public.claim_cbmmqr_order_slot(uuid, uuid, text, integer, timestamptz, integer);
--   DROP TRIGGER IF EXISTS trg_protect_payment_cbmmqr_fields ON public.payments;
--   DROP FUNCTION IF EXISTS public.protect_payment_cbmmqr_fields();
--   DROP INDEX IF EXISTS public.idx_payments_one_live_cbmmqr_order;
--   DROP INDEX IF EXISTS public.idx_payments_cbmmqr_transaction_unique;
--   DROP INDEX IF EXISTS public.idx_payments_provider_order_ref_unique;
--   ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_cbmmqr_merchant_required;
--   ALTER TABLE public.payments DROP COLUMN IF EXISTS provider_order_ref;
--   ALTER TABLE public.payments DROP COLUMN IF EXISTS cbmmqr_merchant;
--   DROP TABLE IF EXISTS public.cbmmqr_merchant_assignments;

-- Fail fast rather than queue every payment read behind ADD COLUMN's lock.
SET LOCAL lock_timeout = '5s';

-- Preflight: this migration adds a CHECK that requires every cb_mmqr row to
-- carry a pin; rows created before it cannot be pinned retroactively.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.payments WHERE payment_method = 'cb_mmqr') THEN
    RAISE EXCEPTION 'cbmmqr: payments rows with payment_method = cb_mmqr already exist; resolve them before applying this migration';
  END IF;
END;
$$;

-- ── 1. Tenant → merchant mapping ────────────────────────────────────────────
-- Not a tenants column: tenant owners can update their own tenant row, and the
-- mapping is the operator's alone.
CREATE TABLE public.cbmmqr_merchant_assignments (
  tenant_id   uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE RESTRICT,
  merchant_id text NOT NULL CHECK (merchant_id ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Keeps updated_at truthful when the operator reassigns a tenant.
CREATE TRIGGER cbmmqr_merchant_assignments_updated_at
  BEFORE UPDATE ON public.cbmmqr_merchant_assignments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.cbmmqr_merchant_assignments ENABLE ROW LEVEL SECURITY;
-- No policies: anon and authenticated can neither read nor write.
REVOKE ALL ON public.cbmmqr_merchant_assignments FROM public, anon, authenticated;
-- The operator manages assignments as service_role. The RPCs run as owner and
-- do not need this; without it the operator could not manage assignments.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cbmmqr_merchant_assignments TO service_role;

INSERT INTO public.cbmmqr_merchant_assignments (tenant_id, merchant_id)
SELECT id, 'YOUNGMONEY' FROM public.tenants WHERE subdomain = 'beatsrun'
ON CONFLICT (tenant_id) DO NOTHING;

-- A NOTICE, not an exception: an environment without BeatsRun is legitimate.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE subdomain = 'beatsrun') THEN
    RAISE NOTICE 'cbmmqr: no tenant with subdomain beatsrun; no YOUNGMONEY assignment inserted';
  END IF;
END;
$$;

-- ── 2. Columns, CHECK, indexes ──────────────────────────────────────────────
ALTER TABLE public.payments ADD COLUMN cbmmqr_merchant text;
ALTER TABLE public.payments ADD COLUMN provider_order_ref text;

COMMENT ON COLUMN public.payments.cbmmqr_merchant IS
  'CB merchant id (CBMMQR_<ID>_*) that created this order. Written once at insert by claim_cbmmqr_order_slot / complete_cbmmqr_replace; immutable (trg_protect_payment_cbmmqr_fields). NULL for every other payment method.';
COMMENT ON COLUMN public.payments.provider_order_ref IS
  'CB qrReferenceNo, used for the status check. cb_mmqr rows only; NULL -> value once, never changed (trg_protect_payment_cbmmqr_fields).';

-- No backfill: no cb_mmqr row exists yet.
ALTER TABLE public.payments
  ADD CONSTRAINT payments_cbmmqr_merchant_required
  -- Both directions, null-safe: a CB row must carry a pin, and no other row may.
  CHECK ((payment_method IS NOT DISTINCT FROM 'cb_mmqr') = (cbmmqr_merchant IS NOT NULL));

CREATE UNIQUE INDEX idx_payments_provider_order_ref_unique
  ON public.payments (provider_order_ref)
  WHERE provider_order_ref IS NOT NULL;

-- One CB transaction can settle one payment.
CREATE UNIQUE INDEX idx_payments_cbmmqr_transaction_unique
  ON public.payments (bank_reference)
  WHERE payment_method = 'cb_mmqr' AND bank_reference IS NOT NULL;

-- At most ONE live CB order per enrollment, enforced by the database.
CREATE UNIQUE INDEX idx_payments_one_live_cbmmqr_order
  ON public.payments (enrollment_id)
  WHERE payment_method = 'cb_mmqr'
    AND status = 'awaiting_payment'
    AND mmqr_status = 'PENDING';

-- ── 3. Trigger: pin, tenant, provider_order_ref, bank_reference ─────────────
-- A NEW function; protect_payment_kbzpay_merchant() is not reused or changed.
-- SECURITY INVOKER: inside the SECURITY DEFINER RPCs it runs as their owner and
-- can read the assignments table; a direct PostgREST insert carrying a pin
-- fails on the revoked table.
CREATE OR REPLACE FUNCTION public.protect_payment_cbmmqr_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_assigned text;
BEGIN
  -- provider_order_ref belongs to CB rows only.
  IF new.provider_order_ref IS NOT NULL
     AND new.payment_method IS DISTINCT FROM 'cb_mmqr' THEN
    RAISE EXCEPTION 'provider_order_ref is only valid on cb_mmqr payments' USING errcode = '42501';
  END IF;

  IF tg_op = 'UPDATE' THEN
    IF new.cbmmqr_merchant IS DISTINCT FROM old.cbmmqr_merchant THEN
      RAISE EXCEPTION 'payments.cbmmqr_merchant is immutable' USING errcode = '42501';
    END IF;
    IF new.tenant_id IS DISTINCT FROM old.tenant_id AND old.cbmmqr_merchant IS NOT NULL THEN
      RAISE EXCEPTION 'a pinned CB payment cannot move tenant' USING errcode = '42501';
    END IF;
    -- NULL -> value once; never changed or cleared afterwards.
    IF old.provider_order_ref IS NOT NULL
       AND new.provider_order_ref IS DISTINCT FROM old.provider_order_ref THEN
      RAISE EXCEPTION 'payments.provider_order_ref is write-once' USING errcode = '42501';
    END IF;
    IF old.payment_method = 'cb_mmqr'
       AND old.bank_reference IS NOT NULL
       AND new.bank_reference IS DISTINCT FROM old.bank_reference THEN
      RAISE EXCEPTION 'bank_reference on a cb_mmqr payment is write-once' USING errcode = '42501';
    END IF;
    RETURN new;
  END IF;

  IF new.cbmmqr_merchant IS NOT NULL THEN
    SELECT a.merchant_id INTO v_assigned
      FROM public.cbmmqr_merchant_assignments a
     WHERE a.tenant_id = new.tenant_id;

    IF v_assigned IS DISTINCT FROM new.cbmmqr_merchant THEN
      RAISE EXCEPTION 'cbmmqr_merchant does not match the tenant assignment' USING errcode = '42501';
    END IF;
  END IF;

  RETURN new;
END;
$$;

CREATE TRIGGER trg_protect_payment_cbmmqr_fields
  BEFORE INSERT OR UPDATE OF cbmmqr_merchant, tenant_id, provider_order_ref, bank_reference, payment_method
  ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.protect_payment_cbmmqr_fields();

-- ── 4. claim_cbmmqr_order_slot ──────────────────────────────────────────────
-- Same contract as claim_kbzpay_order_slot (20261030120000), plus three output
-- columns the CB route needs to decide an unresolved row (spec §5.2).
CREATE FUNCTION public.claim_cbmmqr_order_slot(
  p_enrollment_id uuid,
  p_tenant_id     uuid,
  p_payment_ref   text,
  p_amount        integer,
  p_expires_at    timestamptz,
  p_platform_fee  integer DEFAULT 0
)
RETURNS TABLE (
  outcome    text,
  payment_id uuid,
  ref        text,
  qr         text,
  merchant   text,
  expires_at timestamptz,
  order_ref  text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_live     public.payments%ROWTYPE;
  v_tenant   uuid;
  v_new_id   uuid;
  v_merchant text;
BEGIN
  -- Serialise creators AND re-prove ownership and status under the lock: the
  -- route's earlier check is a TOCTOU read (same reasoning as KBZPay's claim).
  SELECT e.tenant_id INTO v_tenant
    FROM public.enrollments e
   WHERE e.id        = p_enrollment_id
     AND e.tenant_id = p_tenant_id
     AND e.status IN ('pending_payment', 'partial_payment')
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid_enrollment'::text, NULL::uuid, NULL::text, NULL::text,
                        NULL::text, NULL::timestamptz, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT * INTO v_live
    FROM public.payments
   WHERE enrollment_id  = p_enrollment_id
     AND payment_method = 'cb_mmqr'
     AND status         = 'awaiting_payment'
     AND mmqr_status    = 'PENDING'
   LIMIT 1;

  -- reuse / unresolved return the EXISTING row's pin, never the current
  -- assignment: removing an assignment must not strand an order already live.
  -- unresolved also returns the stored QR (NULL when none): a row whose QR was
  -- never stored was never displayed, which decides how §5.2 may free it. The
  -- route must not hand an unresolved row's QR to the browser.
  IF FOUND THEN
    IF v_live.amount = p_amount
       AND v_live.platform_fee = p_platform_fee
       AND v_live.provider_qr IS NOT NULL
       AND v_live.provider_order_expires_at IS NOT NULL
       AND v_live.provider_order_expires_at > now()
    THEN
      RETURN QUERY SELECT 'reuse'::text, v_live.id, v_live.payment_ref, v_live.provider_qr,
                          v_live.cbmmqr_merchant, v_live.provider_order_expires_at,
                          v_live.provider_order_ref, v_live.created_at;
    ELSE
      RETURN QUERY SELECT 'unresolved'::text, v_live.id, v_live.payment_ref, v_live.provider_qr,
                          v_live.cbmmqr_merchant, v_live.provider_order_expires_at,
                          v_live.provider_order_ref, v_live.created_at;
    END IF;
    RETURN;
  END IF;

  -- FOR SHARE holds the assignment until commit, so a concurrent reassignment
  -- cannot make the trigger's re-read disagree.
  SELECT a.merchant_id INTO v_merchant
    FROM public.cbmmqr_merchant_assignments a
   WHERE a.tenant_id = v_tenant
     FOR SHARE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_merchant'::text, NULL::uuid, NULL::text, NULL::text,
                        NULL::text, NULL::timestamptz, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  -- 'awaiting_payment', never 'pending': the INSERT branch of
  -- trg_payments_sync_enrollment fires on 'pending' (migration 054).
  INSERT INTO public.payments (
    enrollment_id, tenant_id, amount, platform_fee, payment_ref, payment_method,
    mmqr_status, status, provider_order_expires_at, cbmmqr_merchant
  ) VALUES (
    p_enrollment_id, v_tenant, p_amount, p_platform_fee, p_payment_ref, 'cb_mmqr',
    'PENDING', 'awaiting_payment', p_expires_at, v_merchant
  )
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT 'created'::text, v_new_id, p_payment_ref, NULL::text,
                      v_merchant, p_expires_at, NULL::text, now();
END;
$$;

REVOKE ALL ON FUNCTION public.claim_cbmmqr_order_slot(uuid, uuid, text, integer, timestamptz, integer)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_cbmmqr_order_slot(uuid, uuid, text, integer, timestamptz, integer)
  TO service_role;

-- ── 5. store_cbmmqr_qr ──────────────────────────────────────────────────────
-- Spec §5.1 steps 7-8. Stores CB's answer for a live row, re-checking the
-- enrollment under its lock. CB's reference and expiry are ALWAYS stored for a
-- live row (they are what lets §5.2 resolve it later); the QR only when p_qr is
-- non-null AND the enrollment is still payable.
--   stored       — written (with the QR if one was given)
--   not_payable  — reference and expiry written, QR withheld
--   not_live     — the row is no longer the live order; nothing written
--   ref_conflict — a different provider_order_ref is already stored
--   not_found    — no such cb_mmqr payment
CREATE FUNCTION public.store_cbmmqr_qr(
  p_payment_ref text,
  p_qr          text,
  p_order_ref   text,
  p_expires_at  timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status        public.enrollments.status%TYPE;
  v_pay           public.payments%ROWTYPE;
BEGIN
  IF coalesce(p_order_ref, '') = '' THEN
    RAISE EXCEPTION 'p_order_ref is required';
  END IF;

  -- Lock order: payment first, then its enrollment (see the header).
  SELECT * INTO v_pay
    FROM public.payments
   WHERE payment_ref = p_payment_ref AND payment_method = 'cb_mmqr'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  SELECT e.status INTO v_status
    FROM public.enrollments e
   WHERE e.id = v_pay.enrollment_id
   FOR UPDATE;

  IF v_pay.status <> 'awaiting_payment' OR v_pay.mmqr_status IS DISTINCT FROM 'PENDING' THEN
    RETURN 'not_live';
  END IF;

  IF v_pay.provider_order_ref IS NOT NULL AND v_pay.provider_order_ref <> p_order_ref THEN
    RETURN 'ref_conflict';
  END IF;

  BEGIN
    IF v_status IN ('pending_payment', 'partial_payment') AND p_qr IS NOT NULL THEN
      UPDATE public.payments
         SET provider_qr = p_qr,
             provider_order_ref = p_order_ref,
             provider_order_expires_at = p_expires_at
       WHERE id = v_pay.id;
      RETURN 'stored';
    END IF;

    UPDATE public.payments
       SET provider_order_ref = p_order_ref,
           provider_order_expires_at = p_expires_at
     WHERE id = v_pay.id;
  EXCEPTION WHEN unique_violation THEN
    RETURN 'ref_conflict';
  END;
  RETURN CASE WHEN p_qr IS NULL THEN 'stored' ELSE 'not_payable' END;
END;
$$;

REVOKE ALL ON FUNCTION public.store_cbmmqr_qr(text, text, text, timestamptz)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_cbmmqr_qr(text, text, text, timestamptz)
  TO service_role;

-- ── 6. complete_cbmmqr_replace ──────────────────────────────────────────────
-- Spec §4.3. Only called after the route has PROVEN the old QR dead (§5.2).
-- No SUPERSEDED: nothing can be superseded while it is still payable.
CREATE FUNCTION public.complete_cbmmqr_replace(
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
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old               public.payments%ROWTYPE;
  v_tenant            uuid;
  v_enrollment_status public.enrollments.status%TYPE;
  v_new_id            uuid;
  v_merchant          text;
BEGIN
  IF p_reason NOT IN ('EXPIRED', 'FAILED') THEN
    RAISE EXCEPTION 'invalid reason: %', p_reason;
  END IF;

  -- Lock order: OLD PAYMENT FIRST, then the enrollment. settleMmqrPayment
  -- locks the payment and then (via trg_payments_sync_enrollment's UPDATE
  -- enrollments) the enrollment; taking them in the opposite order here would
  -- deadlock against it. Taking the payment lock also makes a replace that
  -- races bind_cbmmqr_settlement wait for the bind to commit, and then see its
  -- bank_reference below (plan review #1).
  SELECT * INTO v_old
    FROM public.payments
   WHERE enrollment_id  = p_enrollment_id
     AND payment_ref    = p_expected_old_ref
     AND payment_method = 'cb_mmqr'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  -- Ownership on every path; status checked only just before the write, so the
  -- 'already_settled' case (enrollment now confirmed) is reported, not refused
  -- (KBZPay R11).
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

  IF v_old.status = 'verified' THEN
    RETURN QUERY SELECT 'already_settled'::text, v_old.id, NULL::text;
    RETURN;
  END IF;

  -- A bound transaction means CB has reported this order PAID and settlement
  -- is under way (bind commits before settleMmqrPayment transitions the row).
  -- Retiring it now would issue a second payable QR for a paid enrollment.
  IF v_old.bank_reference IS NOT NULL THEN
    RETURN QUERY SELECT 'settling'::text, v_old.id, NULL::text;
    RETURN;
  END IF;

  IF v_old.status <> 'awaiting_payment' OR v_old.mmqr_status IS DISTINCT FROM 'PENDING' THEN
    RETURN QUERY SELECT 'not_live'::text, v_old.id, NULL::text;
    RETURN;
  END IF;

  IF v_enrollment_status NOT IN ('pending_payment', 'partial_payment') THEN
    RETURN QUERY SELECT 'not_payable'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  SELECT a.merchant_id INTO v_merchant
    FROM public.cbmmqr_merchant_assignments a
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
    mmqr_status, status, provider_order_expires_at, cbmmqr_merchant
  ) VALUES (
    p_enrollment_id, v_tenant, p_amount, p_platform_fee, p_new_ref, 'cb_mmqr',
    'PENDING', 'awaiting_payment', p_expires_at, v_merchant
  )
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT 'replaced'::text, v_new_id, v_merchant;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_cbmmqr_replace(uuid, uuid, text, text, text, integer, timestamptz, integer)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_cbmmqr_replace(uuid, uuid, text, text, text, integer, timestamptz, integer)
  TO service_role;

-- ── 7. bind_cbmmqr_settlement ───────────────────────────────────────────────
-- Spec §5.5 step 1. Binds CB's qrReferenceNo and transactionId to this payment
-- under a row lock, BEFORE settleMmqrPayment() transitions it. A replay with
-- the same values is 'bound'; anything different is refused, and so is a
-- row that is no longer the live order ('not_live').
CREATE FUNCTION public.bind_cbmmqr_settlement(
  p_payment_ref     text,
  p_qr_reference_no text,
  p_transaction_id  text,
  p_merchant        text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pay        public.payments%ROWTYPE;
  v_constraint text;
BEGIN
  SELECT * INTO v_pay
    FROM public.payments
   WHERE payment_ref = p_payment_ref AND payment_method = 'cb_mmqr'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  IF v_pay.cbmmqr_merchant IS DISTINCT FROM p_merchant
     OR coalesce(p_transaction_id, '') = ''
     OR coalesce(p_qr_reference_no, '') = ''
     OR (v_pay.provider_order_ref IS NOT NULL AND v_pay.provider_order_ref <> p_qr_reference_no)
     OR (v_pay.bank_reference IS NOT NULL AND v_pay.bank_reference <> p_transaction_id)
  THEN
    RETURN 'mismatch';
  END IF;

  -- Only the live order binds. A row retired by complete_cbmmqr_replace or
  -- marked FAILED stays awaiting_payment, and settleMmqrPayment() would
  -- otherwise settle it beside its replacement. A replay of the transaction
  -- already bound here, or a row already verified, still binds.
  IF NOT (
       (v_pay.status = 'awaiting_payment' AND v_pay.mmqr_status IS NOT DISTINCT FROM 'PENDING')
    OR v_pay.status = 'verified'
    OR v_pay.bank_reference IS NOT DISTINCT FROM p_transaction_id
  ) THEN
    RETURN 'not_live';
  END IF;

  BEGIN
    UPDATE public.payments
       SET provider_order_ref = p_qr_reference_no,
           bank_reference     = p_transaction_id
     WHERE id = v_pay.id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    RETURN CASE v_constraint
             WHEN 'idx_payments_cbmmqr_transaction_unique' THEN 'duplicate_transaction'
             WHEN 'idx_payments_provider_order_ref_unique' THEN 'duplicate_order_ref'
             ELSE 'mismatch' END;
  END;

  RETURN 'bound';
END;
$$;

REVOKE ALL ON FUNCTION public.bind_cbmmqr_settlement(text, text, text, text)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_cbmmqr_settlement(text, text, text, text)
  TO service_role;

-- ── 8. Documentation ────────────────────────────────────────────────────────
COMMENT ON COLUMN public.tenants.mmqr_provider IS
  'abank | mmpay | kbzpay | cbmmqr — only used when payment_mode = mmqr';
