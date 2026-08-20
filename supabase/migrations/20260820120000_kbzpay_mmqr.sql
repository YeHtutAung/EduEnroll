-- ─── KBZPay MMQR support ────────────────────────────────────────────────────
-- Design: docs/superpowers/specs/2026-08-20-kbzpay-mmqr-integration-design.md
--
-- Adds KBZPay as a third mmqr_provider. tenants.mmqr_provider is plain TEXT
-- with no CHECK constraint (055), so 'kbzpay' is already a legal value and only
-- the column comment needs updating.
--
-- NO `CREATE INDEX CONCURRENTLY`: Postgres forbids it inside a transaction
-- block, and no migration in this repo uses it (spec R6). Built normally, the
-- unique index takes a SHARE lock on payments for the duration — milliseconds
-- at this table size, and enrollment writes retry.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS public.idx_payments_one_live_kbzpay_order;
--   DROP INDEX IF EXISTS public.idx_payments_payment_ref_unique;
--   CREATE INDEX idx_payments_payment_ref ON public.payments (payment_ref);
--   DROP FUNCTION IF EXISTS public.claim_kbzpay_order_slot(uuid,uuid,text,integer,timestamptz);
--   DROP FUNCTION IF EXISTS public.complete_kbzpay_supersede(uuid,uuid,text,text,text,integer,timestamptz);
-- The two new columns may be left in place; they are nullable and unused by
-- other providers. No data is altered by this migration or its rollback.
--
-- PRE-FLIGHT (spec §11, gate G6) — must return ZERO rows on dev AND production
-- before this is promoted, or the unique index cannot be created:
--   SELECT payment_ref, count(*) FROM public.payments
--    WHERE payment_ref IS NOT NULL GROUP BY 1 HAVING count(*) > 1;

BEGIN;

-- ── 1. Documentation: keep the recorded legal values honest ────────────────

COMMENT ON COLUMN public.tenants.mmqr_provider IS
  'abank | mmpay | kbzpay — only used when payment_mode = mmqr';

-- ── 2. Unique payment_ref (spec R1) ────────────────────────────────────────
-- The webhooks and status routes resolve payment_ref with .single(), so a
-- duplicate does not merely create a stray row — it breaks settlement for BOTH
-- payments. Uniqueness is a correctness requirement here, not tidiness.
--
-- Partial because manual-upload payments leave payment_ref NULL. Postgres
-- permits many NULLs in a unique index anyway; the predicate states the intent.
-- This is the ONE place this migration touches rows written by ABank, MMPay and
-- PayPay, which is why gate G6 above covers production as well as dev.

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_payment_ref_unique
  ON public.payments (payment_ref)
  WHERE payment_ref IS NOT NULL;

DROP INDEX IF EXISTS public.idx_payments_payment_ref;

-- ── 3. Columns ─────────────────────────────────────────────────────────────

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS provider_qr text,
  ADD COLUMN IF NOT EXISTS provider_order_expires_at timestamptz;

COMMENT ON COLUMN public.payments.provider_qr IS
  'MMQR/EMVCo payload returned by the provider, re-served on repeat requests';

COMMENT ON COLUMN public.payments.provider_order_expires_at IS
  'Local ESTIMATE of provider order expiry. A hint that triggers a queryorder check — never authority to free the order slot (spec R8)';

-- ── 4. One live KBZPay order per enrollment (spec R4) ──────────────────────
-- Enforced by the database rather than by an application-level read, because a
-- read-then-insert has no atomicity: two concurrent requests both see no live
-- row and both insert. 'PENDING' is the liveness marker; every terminal
-- mmqr_status (SUCCESS / FAILED / EXPIRED / SUPERSEDED) frees the slot.
--
-- Scoped to payment_method = 'kbzpay_mmqr', so it cannot affect any existing
-- provider's rows.

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_live_kbzpay_order
  ON public.payments (enrollment_id)
  WHERE payment_method = 'kbzpay_mmqr'
    AND status = 'awaiting_payment'
    AND mmqr_status = 'PENDING';

-- ── 5. claim_kbzpay_order_slot ─────────────────────────────────────────────
-- Outcomes: 'invalid_enrollment' | 'reuse' | 'unresolved' | 'created'.
-- Only 'created' writes.
--
-- 'invalid_enrollment' is a PRECONDITION failure, not a fourth live-row state.
-- The design warns against splitting the live-row handling further, because
-- each split created a state that could fall between branches (R9, R13). This
-- guard sits ahead of that handling and narrows what reaches it; the live-row
-- branches below are unchanged.
--
-- 'reuse' is a NARROW allowlist — same amount AND non-null QR AND inside the
-- expiry hint. EVERY other live row is 'unresolved' and inserts nothing, so no
-- state can fall between branches. Revisions 4-6 of the design split this three
-- ways and a live row with a matching amount but a null provider_qr matched
-- none of them, fell through to the insert, and hit the unique index — a
-- repeatable 502 until expiry (spec R9, R13).

CREATE OR REPLACE FUNCTION public.claim_kbzpay_order_slot(
  p_enrollment_id uuid,
  p_tenant_id     uuid,
  p_payment_ref   text,
  p_amount        integer,
  p_expires_at    timestamptz
)
RETURNS TABLE (outcome text, payment_id uuid, ref text, qr text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_live     public.payments%ROWTYPE;
  v_tenant   uuid;
  v_new_id   uuid;
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
    RETURN QUERY SELECT 'invalid_enrollment'::text, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT * INTO v_live
    FROM public.payments
   WHERE enrollment_id  = p_enrollment_id
     AND payment_method = 'kbzpay_mmqr'
     AND status         = 'awaiting_payment'
     AND mmqr_status    = 'PENDING'
   LIMIT 1;

  IF FOUND THEN
    IF v_live.amount = p_amount
       AND v_live.provider_qr IS NOT NULL
       AND v_live.provider_order_expires_at IS NOT NULL
       AND v_live.provider_order_expires_at > now()
    THEN
      RETURN QUERY SELECT 'reuse'::text, v_live.id, v_live.payment_ref, v_live.provider_qr;
    ELSE
      RETURN QUERY SELECT 'unresolved'::text, v_live.id, v_live.payment_ref, NULL::text;
    END IF;
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
    enrollment_id, tenant_id, amount, payment_ref, payment_method,
    mmqr_status, status, provider_order_expires_at
  ) VALUES (
    p_enrollment_id, v_tenant, p_amount, p_payment_ref, 'kbzpay_mmqr',
    'PENDING', 'awaiting_payment', p_expires_at
  )
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT 'created'::text, v_new_id, p_payment_ref, NULL::text;
END;
$$;

-- ── 6. complete_kbzpay_supersede ───────────────────────────────────────────
-- Outcomes: 'invalid_enrollment' | 'replaced' | 'already_settled' | 'not_live'
--         | 'not_found'.
--
-- Retires an order the CALLER has already proven dead against KBZPay, and
-- inserts its replacement, atomically (spec R7). This function never decides
-- that an order is dead — that decision requires a queryorder answer and is
-- made in resolveKbzpayOrder() before this is called.

CREATE OR REPLACE FUNCTION public.complete_kbzpay_supersede(
  p_enrollment_id    uuid,
  p_tenant_id        uuid,
  p_expected_old_ref text,
  p_reason           text,
  p_new_ref          text,
  p_amount           integer,
  p_expires_at       timestamptz
)
RETURNS TABLE (outcome text, payment_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old               public.payments%ROWTYPE;
  v_tenant            uuid;
  v_enrollment_status public.enrollments.status%TYPE;
  v_new_id            uuid;
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
    RETURN QUERY SELECT 'invalid_enrollment'::text, NULL::uuid;
    RETURN;
  END IF;

  SELECT * INTO v_old
    FROM public.payments
   WHERE enrollment_id  = p_enrollment_id
     AND payment_ref    = p_expected_old_ref
     AND payment_method = 'kbzpay_mmqr'
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid;
    RETURN;
  END IF;

  -- A callback settled it between the provider query and this transition. The
  -- caller must return the settled outcome, NOT a fresh QR for an enrollment
  -- that has just been paid (spec R7, R11).
  IF v_old.status = 'verified' THEN
    RETURN QUERY SELECT 'already_settled'::text, v_old.id;
    RETURN;
  END IF;

  -- Someone else already retired it. The caller re-claims rather than assuming
  -- anything about why.
  IF v_old.mmqr_status IS DISTINCT FROM 'PENDING' THEN
    RETURN QUERY SELECT 'not_live'::text, v_old.id;
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
    RETURN QUERY SELECT 'invalid_enrollment'::text, NULL::uuid;
    RETURN;
  END IF;

  UPDATE public.payments
     SET mmqr_status = p_reason
   WHERE id = v_old.id;

  INSERT INTO public.payments (
    enrollment_id, tenant_id, amount, payment_ref, payment_method,
    mmqr_status, status, provider_order_expires_at
  ) VALUES (
    p_enrollment_id, v_tenant, p_amount, p_new_ref, 'kbzpay_mmqr',
    'PENDING', 'awaiting_payment', p_expires_at
  )
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT 'replaced'::text, v_new_id;
END;
$$;

-- ── 7. Privileges ──────────────────────────────────────────────────────────
-- service_role only, matching the precedent in
-- 20260719100000_restrict_enrollment_rpc_privileges.sql. Both functions are
-- SECURITY DEFINER and insert payments rows; anon and authenticated must never
-- be able to reach them.

REVOKE ALL ON FUNCTION public.claim_kbzpay_order_slot(uuid, uuid, text, integer, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_kbzpay_order_slot(uuid, uuid, text, integer, timestamptz)
  TO service_role;

REVOKE ALL ON FUNCTION public.complete_kbzpay_supersede(uuid, uuid, text, text, text, integer, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_kbzpay_supersede(uuid, uuid, text, text, text, integer, timestamptz)
  TO service_role;

COMMIT;

-- PostgREST caches the schema; migration 075 established this pattern after 074
-- renamed columns. New RPCs must be visible to the client immediately.
NOTIFY pgrst, 'reload schema';
