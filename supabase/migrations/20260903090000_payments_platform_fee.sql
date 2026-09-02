-- ─── payments.platform_fee — persist the split, stop deriving it ────────────
--
-- 20260902120000 added the fee to the TENANT and deliberately stored nothing on
-- the payment, on the reasoning that `payments.amount` is immutable and the fee
-- could therefore be recovered as `amount - ticket_subtotal` wherever it was
-- needed. That reasoning was wrong in a way review made plain: six defects on
-- one branch, four of them the same defect in different call sites.
--
-- The subtraction is only valid when the amount charged IS the order total.
-- It is not, in three real cases:
--
--   1. A partial-payment top-up row's amount is a REMAINDER, so the difference
--      is negative and the "fee" is nonsense.
--   2. An enrollment's items can be read at display time from a different set
--      than the one priced at charge time; the subtrahend moves, the fee moves
--      with it, and the receipt silently changes after the fact.
--   3. Every new display site has to rediscover both rules. Five already
--      existed. Each was a place to get it wrong, and most of them did.
--
-- Storing the fee alongside the amount removes the derivation entirely: the row
-- records what was charged AND what it was made of, decided once at creation by
-- the same calculator that priced the gateway call. A reader adds no logic.
--
-- Every path that creates a payment row is updated here, because a path that is
-- missed does not fail loudly — it records a fee of zero against a fee-bearing
-- amount, and the receipt understates the fee rather than erroring.
--
--   direct INSERT  abank, hitpay, mmpay, paypay, upload   (route code)
--   RPC            claim_kbzpay_order_slot                (below)
--   RPC            complete_kbzpay_supersede              (below)
--   RPC            finalize_stripe_payment_attempt        (below)
--
-- ROLLBACK
--   The three functions are reproduced here verbatim from their defining
--   migrations with only the parameter and the INSERT changed, so reverting
--   means re-running 20260820120000 (kbzpay) and 20260722180000 (stripe)
--   function bodies and dropping the column:
--     DROP FUNCTION IF EXISTS public.claim_kbzpay_order_slot(uuid,uuid,text,integer,timestamptz,integer);
--     DROP FUNCTION IF EXISTS public.complete_kbzpay_supersede(uuid,uuid,text,text,text,integer,timestamptz,integer);
--     DROP FUNCTION IF EXISTS public.finalize_stripe_payment_attempt(uuid,uuid,text,integer,text,text,numeric,bigint,text,uuid,integer);
--     ALTER TABLE public.payments DROP COLUMN platform_fee;

-- ── 1. The column ───────────────────────────────────────────────────────────
--
-- NOT NULL DEFAULT 0 is right for the backfill: every row that predates this
-- migration was charged before any platform fee existed, so its amount is the
-- ticket subtotal and its fee genuinely is zero. No backfill query is needed
-- and none would be correct — there is no record of a fee that was never
-- charged.
--
-- No CHECK against `amount`: a top-up row's amount is a remainder, legitimately
-- smaller than a fee charged on the original row, so `platform_fee <= amount`
-- would reject valid data.

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS platform_fee integer NOT NULL DEFAULT 0;

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_platform_fee_nonneg;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_platform_fee_nonneg CHECK (platform_fee >= 0);

COMMENT ON COLUMN public.payments.platform_fee IS
  'Online platform fee included in `amount`, as computed at creation. Tickets = amount - platform_fee. 0 for bank transfers, free orders, partial-payment top-ups, and every row predating the fee.';

-- ── 2. claim_kbzpay_order_slot ──────────────────────────────────────────────
--
-- The parameter is appended with DEFAULT 0 so the migration can be applied
-- before the code that passes it, and both arities cannot coexist: leaving the
-- 5-argument function in place would make every existing call ambiguous, so the
-- old signature is dropped first.
--
-- The reuse test gains `v_live.platform_fee = p_platform_fee`. It already
-- refused to hand back a live QR whose amount disagreed with the current quote;
-- an equal amount split differently is the same kind of disagreement, and
-- reusing that row would attach a stale breakdown to a current order.

DROP FUNCTION IF EXISTS public.claim_kbzpay_order_slot(uuid, uuid, text, integer, timestamptz);
DROP FUNCTION IF EXISTS public.claim_kbzpay_order_slot(uuid, uuid, text, integer, timestamptz, integer);

CREATE OR REPLACE FUNCTION public.claim_kbzpay_order_slot(
  p_enrollment_id uuid,
  p_tenant_id     uuid,
  p_payment_ref   text,
  p_amount        integer,
  p_expires_at    timestamptz,
  p_platform_fee  integer DEFAULT 0
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
       AND v_live.platform_fee = p_platform_fee
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
    enrollment_id, tenant_id, amount, platform_fee, payment_ref, payment_method,
    mmqr_status, status, provider_order_expires_at
  ) VALUES (
    p_enrollment_id, v_tenant, p_amount, p_platform_fee, p_payment_ref, 'kbzpay_mmqr',
    'PENDING', 'awaiting_payment', p_expires_at
  )
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT 'created'::text, v_new_id, p_payment_ref, NULL::text;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_kbzpay_order_slot(uuid, uuid, text, integer, timestamptz, integer)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_kbzpay_order_slot(uuid, uuid, text, integer, timestamptz, integer)
  TO service_role;

-- ── 3. complete_kbzpay_supersede ────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.complete_kbzpay_supersede(uuid, uuid, text, text, text, integer, timestamptz);
DROP FUNCTION IF EXISTS public.complete_kbzpay_supersede(uuid, uuid, text, text, text, integer, timestamptz, integer);

CREATE OR REPLACE FUNCTION public.complete_kbzpay_supersede(
  p_enrollment_id    uuid,
  p_tenant_id        uuid,
  p_expected_old_ref text,
  p_reason           text,
  p_new_ref          text,
  p_amount           integer,
  p_expires_at       timestamptz,
  p_platform_fee     integer DEFAULT 0
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
    enrollment_id, tenant_id, amount, platform_fee, payment_ref, payment_method,
    mmqr_status, status, provider_order_expires_at
  ) VALUES (
    p_enrollment_id, v_tenant, p_amount, p_platform_fee, p_new_ref, 'kbzpay_mmqr',
    'PENDING', 'awaiting_payment', p_expires_at
  )
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT 'replaced'::text, v_new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_kbzpay_supersede(uuid, uuid, text, text, text, integer, timestamptz, integer)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_kbzpay_supersede(uuid, uuid, text, text, text, integer, timestamptz, integer)
  TO service_role;

-- ── 4. finalize_stripe_payment_attempt ──────────────────────────────────────
--
-- p_platform_fee is integer while p_amount is numeric, matching the amount
-- model this function's own migration settled on: whole major units only, since
-- every fee column feeding it is INTEGER.

DROP FUNCTION IF EXISTS public.finalize_stripe_payment_attempt(uuid,uuid,text,integer,text,text,numeric,bigint,text,uuid);
DROP FUNCTION IF EXISTS public.finalize_stripe_payment_attempt(uuid,uuid,text,integer,text,text,numeric,bigint,text,uuid,integer);

create or replace function public.finalize_stripe_payment_attempt(
  p_enrollment_id          uuid,
  p_tenant_id              uuid,
  p_flow                   text,
  p_attempt_seq            integer,
  p_intent_id              text,
  p_session_id             text,
  p_amount                 numeric,
  p_amount_minor           bigint,
  p_currency               text,
  p_predecessor_payment_id uuid,
  p_platform_fee           integer default 0
) returns public.payments
language plpgsql security definer set search_path = public as $$
declare
  v_row         public.payments;
  v_pred        public.payments;
  v_owner       public.payments;
  v_owner_count integer;
  v_constraint  text;
  v_currency    text;
begin
  -- Canonicalise ONCE, then store and compare only the canonical form. An
  -- accept-lower/store-raw split would pass 'SGD' here, persist 'SGD', and
  -- later record a false currency_mismatch against Stripe's lowercase 'sgd'.
  v_currency := lower(p_currency);

  -- Launch contract: whole-major-unit amounts only (see the amount-model note
  -- below). A fractional amount is a caller bug, not a storable value.
  if p_amount is null or p_amount <= 0 or p_amount <> trunc(p_amount) then
    raise exception 'amount % is not a positive whole major unit', p_amount
      using errcode = 'ST001';
  end if;

  -- Snapshot coherence: the three amount fields must describe ONE contract.
  -- Settlement treats provider_amount_minor as authoritative, so accepting
  -- p_amount = 12 with p_amount_minor = 999 would let a 9.99 payment settle a
  -- row displaying 12. For the SGD-only launch this check IS the database-level
  -- allow-list; widening currencies is a deliberate change to this function,
  -- not a data tweak.
  if v_currency is null or v_currency <> 'sgd'
     or p_amount_minor is null or p_amount_minor <= 0
     or p_amount_minor <> p_amount * 100 then
    raise exception 'amount snapshot (%, %, %) is not a coherent SGD contract',
      p_amount, p_amount_minor, p_currency using errcode = 'ST001';
  end if;

  -- ── Identity, before any write ────────────────────────────────────────────
  if p_attempt_seq = 1 then
    if p_predecessor_payment_id is not null then
      raise exception 'attempt 1 on enrollment % supplied a predecessor', p_enrollment_id
        using errcode = 'ST001';
    end if;
    -- Attempt 1 is only legitimate when no LATER attempt exists. Attempt 1
    -- itself may exist: that is the idempotent retry, absorbed below.
    perform 1 from public.payments
      where enrollment_id = p_enrollment_id and attempt_seq is not null and attempt_seq <> 1;
    if found then
      raise exception 'attempt 1 requested on enrollment % which already has later Stripe attempts',
        p_enrollment_id using errcode = 'ST001';
    end if;
  else
    if p_predecessor_payment_id is null then
      raise exception 'attempt % on enrollment % requires a predecessor',
        p_attempt_seq, p_enrollment_id using errcode = 'ST001';
    end if;

    -- Lock it: the predecessor must not change state between validation and
    -- retirement.
    select * into v_pred from public.payments
     where id = p_predecessor_payment_id for update;

    if not found
       or v_pred.enrollment_id  is distinct from p_enrollment_id
       or v_pred.tenant_id      is distinct from p_tenant_id
       or v_pred.payment_method is distinct from 'stripe'
       or v_pred.attempt_seq    is distinct from p_attempt_seq - 1 then
      raise exception 'predecessor % is not attempt % of enrollment %',
        p_predecessor_payment_id, p_attempt_seq - 1, p_enrollment_id
        using errcode = 'ST001';
    end if;

    -- A verified predecessor has been PAID. Replacing it would create a second
    -- payable object for an enrollment that already settled.
    if v_pred.status = 'verified' then
      raise exception 'predecessor % is already verified; enrollment % is paid',
        p_predecessor_payment_id, p_enrollment_id using errcode = 'ST002';
    end if;
  end if;

  -- ── No shield may survive this call ───────────────────────────────────────
  -- Plan A treats ANY other active payment as protection against rejection.
  -- Retiring only the named predecessor while an OLDER Stripe row is still
  -- active would leave that row shielding the enrollment forever — the exact
  -- state Plan A's T9 documents. So the invariant is checked, not assumed:
  -- besides the predecessor and the attempt being finalised, no active Stripe
  -- row may exist. Historical violations are found by Phase 0b audit 7 and
  -- reconciled BEFORE launch; hitting this in flight is fail-closed, never
  -- silent narrowing to the newest row.
  perform 1 from public.payments
    where enrollment_id  = p_enrollment_id
      and payment_method = 'stripe'
      and status in ('awaiting_payment', 'pending')
      and id is distinct from p_predecessor_payment_id
      and (attempt_seq is distinct from p_attempt_seq);
  if found then
    raise exception 'enrollment % has other active Stripe attempts; reconcile before replacing',
      p_enrollment_id using errcode = 'ST001';
  end if;

  -- ── Insert or resolve ─────────────────────────────────────────────────────
  -- ON CONFLICT absorbs the (enrollment_id, attempt_seq) index ONLY. A provider
  -- id owned by a DIFFERENT row raises 23505 from
  -- payments_stripe_payment_intent_id_uniq / _session_id_uniq before any of the
  -- validation below runs, so it is caught here and re-raised as a typed
  -- permanent conflict. v7 left this uncaught, which meant L5 could not
  -- produce the outcome it asserted.
  begin
    insert into public.payments (
      enrollment_id, tenant_id, amount, platform_fee, payment_method, status,
      stripe_payment_intent_id, stripe_session_id,
      provider_amount_minor, provider_currency, integration_flow, attempt_seq)
    values (
      p_enrollment_id, p_tenant_id, p_amount, p_platform_fee, 'stripe', 'awaiting_payment',
      p_intent_id, p_session_id,
      p_amount_minor, v_currency, p_flow, p_attempt_seq)
    on conflict (enrollment_id, attempt_seq) where attempt_seq is not null
    do nothing
    returning * into v_row;
  exception when unique_violation then
    -- Only the two PROVIDER-ID constraints mean "another row owns this Stripe
    -- object". Any other unique violation — including one added by a future
    -- migration — is an unexpected database error and must surface as such,
    -- not be mislabelled a buyer-facing ownership conflict.
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint not in ('payments_stripe_payment_intent_id_uniq',
                            'payments_stripe_session_id_uniq') then
      raise;
    end if;

    -- Exactly one owner, or the database is in a state this function must not
    -- narrate: zero matches means the violating row vanished mid-flight,
    -- several means the unique indexes themselves are not holding.
    select count(*) into v_owner_count from public.payments
     where (p_intent_id  is not null and stripe_payment_intent_id = p_intent_id)
        or (p_session_id is not null and stripe_session_id        = p_session_id);
    if v_owner_count <> 1 then
      raise exception 'provider-id conflict on % but % owning rows found',
        v_constraint, v_owner_count;  -- no ST code: route returns 500
    end if;

    select * into v_owner from public.payments
     where (p_intent_id  is not null and stripe_payment_intent_id = p_intent_id)
        or (p_session_id is not null and stripe_session_id        = p_session_id);
    raise exception 'provider object is owned by payment % on enrollment %, not enrollment %',
      v_owner.id, v_owner.enrollment_id, p_enrollment_id using errcode = 'ST004';
  end;

  -- Lost the race, or this is a retry: resolve the winner rather than fail.
  if v_row.id is null then
    select * into v_row from public.payments
     where enrollment_id = p_enrollment_id and attempt_seq = p_attempt_seq;

    if v_row.id is null then
      raise exception 'no row for attempt % on enrollment %',
        p_attempt_seq, p_enrollment_id using errcode = 'ST003';
    end if;

    -- The winner must be the SAME contract. A provider object belonging to a
    -- different tenant/enrollment/amount/currency/flow is a conflict, never a
    -- reuse. tenant_id and the major amount are checked too: this is a
    -- SECURITY DEFINER function, so the boundary is enforced here rather than
    -- trusted from application wiring.
    if v_row.tenant_id             is distinct from p_tenant_id
    or v_row.amount                is distinct from p_amount
    or v_row.integration_flow      is distinct from p_flow
    or v_row.provider_amount_minor is distinct from p_amount_minor
    or v_row.provider_currency     is distinct from v_currency
    or coalesce(v_row.stripe_payment_intent_id, '') is distinct from coalesce(p_intent_id, '')
    or coalesce(v_row.stripe_session_id, '')        is distinct from coalesce(p_session_id, '') then
      raise exception 'attempt contract mismatch for attempt % on enrollment %',
        p_attempt_seq, p_enrollment_id using errcode = 'ST003';
    end if;
  end if;

  -- ── Retirement, only now that the replacement is durably active ──────────
  -- The predecessor was already validated and locked above, so this is a pure
  -- state transition with no contract check left to fail. A predecessor that is
  -- already terminal is skipped, not treated as an error: it anchored the
  -- attempt number and the idempotency key, and there is nothing left to retire.
  if v_pred.id is not null
     and v_pred.status in ('awaiting_payment', 'pending')
     and v_row.status  in ('awaiting_payment', 'pending')
     and v_pred.id <> v_row.id then
    update public.payments
       set status = 'rejected'
     where id = v_pred.id
       and status in ('awaiting_payment', 'pending');
  end if;

  return v_row;
end $$;

-- DROP removed the grants with the function; PostgreSQL then grants EXECUTE to
-- PUBLIC on the replacement, which would expose it through PostgREST.
REVOKE ALL ON FUNCTION public.finalize_stripe_payment_attempt(
  uuid,uuid,text,integer,text,text,numeric,bigint,text,uuid,integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_stripe_payment_attempt(
  uuid,uuid,text,integer,text,text,numeric,bigint,text,uuid,integer) TO service_role;
