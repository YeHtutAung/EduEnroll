-- ============================================================================
-- Stripe settlement contract (Plan v18, approved 2026-07-22)
--
-- Browser-independent Stripe settlement: conflicts table with durable cleanup
-- state, per-payment contract snapshot (provider_amount_minor/currency),
-- attempt identity + integration_flow with bidirectional row contracts,
-- unique provider-object indexes, and finalize_stripe_payment_attempt() —
-- predecessor-bound attempt derivation, ST001-ST004 typed errors,
-- service_role-only execution.
--
-- Assembled verbatim from the reviewed plan's SQL blocks
-- (docs/superpowers/plans/2026-07-22-stripe-payment-intent-webhook.md §1a-1c)
-- by scripts extraction — not retyped. Settlement core approved at v14;
-- SQL unchanged since.
--
-- PRE-FLIGHT (deployment order steps 5-6 / 9-10): Stripe creation must be
-- contained and the three historical zeros verified BEFORE this runs on any
-- shared database — the new constraints make the OLD routes' inserts fail
-- AFTER Stripe object creation.
-- ============================================================================

BEGIN;

-- No IF NOT EXISTS on the table OR its index: an unexpected same-named object
-- must stop the deployment, not silently skip a required uniqueness control.
create table public.payment_settlement_conflicts (
  id                      uuid primary key default gen_random_uuid(),
  provider                text not null,
  provider_object_id      text not null,
  -- Origin-neutral: webhook conflicts carry a Stripe event id, creation-route
  -- conflicts carry a generated request correlation id. All four are NOT NULL —
  -- a conflict nobody can trace to its origin is not a record, and inventing
  -- fake event ids to satisfy an event-only schema would be worse. First and
  -- last each carry their OWN type: an incident first seen at creation and
  -- later observed by a webhook must not describe an event id as a creation
  -- request.
  first_source_type       text not null,
  first_source_id         text not null,
  last_source_type        text not null,
  last_source_id          text not null,
  payment_id              uuid references public.payments(id)    on delete set null,
  enrollment_id           uuid references public.enrollments(id) on delete set null,
  conflict_type           text not null,
  expected_amount_minor   bigint,
  actual_amount_minor     bigint,
  expected_currency       text,
  actual_currency         text,
  status                  text not null default 'open',
  -- Durable cleanup state for unowned provider objects (§3a). 'none' when the
  -- conflict involves no object needing cleanup; 'pending' from the moment an
  -- unowned payable object is known to exist; 'done' only after the provider
  -- confirmed cancellation/expiry. Reopening sales requires zero 'pending'.
  cleanup_status          text not null default 'none',
  occurrence_count        integer not null default 1,
  created_at              timestamptz not null default now(),
  resolved_at             timestamptz,
  resolution_note         text,
  constraint pscf_provider_chk check (provider in ('stripe')),
  constraint pscf_source_chk check (
    first_source_type in ('webhook_event','creation_request')
    and last_source_type in ('webhook_event','creation_request')),
  constraint pscf_type_chk check (conflict_type in (
    'rejected_enrollment','amount_mismatch','currency_mismatch',
    'payment_already_rejected','missing_contract_snapshot',
    'unexpected_payment_state','unexpected_enrollment_state',
    'unknown_integration_flow','attempt_contract_mismatch',
    'provider_object_owned','failure_after_verified',
    'replacement_after_verified','unexpected_no_payment_required')),
  constraint pscf_status_chk check (status in ('open','resolved')),
  constraint pscf_resolved_chk check ((status = 'resolved') = (resolved_at is not null)),
  constraint pscf_cleanup_chk check (cleanup_status in ('none','pending','done')),
  -- A conflict cannot be closed while its object is still payable.
  constraint pscf_cleanup_resolved_chk check (not (status = 'resolved' and cleanup_status = 'pending'))
);

create unique index payment_settlement_conflicts_object_uniq
  on public.payment_settlement_conflicts (provider, provider_object_id, conflict_type);

alter table public.payment_settlement_conflicts enable row level security;
revoke all on public.payment_settlement_conflicts from public, anon, authenticated;
grant select, insert, update on public.payment_settlement_conflicts to service_role;
-- No DELETE: conflicts are resolved, never erased.

-- ────────────────────────────────────────────────────────────────────────────

alter table public.payments
  add column if not exists provider_amount_minor bigint,
  add column if not exists provider_currency     text,
  add column if not exists integration_flow      text,
  add column if not exists attempt_seq           integer;

-- The backfill only reaches rows that carry a provider id. A
-- `payment_method = 'stripe'` row with NEITHER id — creation that failed
-- between the row insert and the provider call — would keep a null attempt and
-- **fail the bidirectional constraint**, aborting the migration. Phase 0b audit
-- 5 finds those rows first; they are resolved deliberately (they represent no
-- provider object, so rejecting them is usually correct) rather than by
-- weakening the permanent contract to accommodate them.
--
-- Deterministic backfill BEFORE the constraints. Existing enrollments can have
-- several Stripe rows; a blanket 1 would violate the uniqueness added below, so
-- number within each enrollment by creation order.
with numbered as (
  select id,
         row_number() over (partition by enrollment_id order by created_at, id) as n
    from public.payments
   where stripe_payment_intent_id is not null
      or stripe_session_id is not null
)
update public.payments p
   set attempt_seq = numbered.n,
       -- SESSION FIRST. The Checkout webhook writes the Session's PaymentIntent
       -- id onto the same payment row (webhooks/stripe/route.ts:86), so a
       -- COMPLETED hosted payment carries BOTH ids. Testing the intent id first
       -- would label it direct_payment_intent and let a future
       -- payment_intent.succeeded settle a Checkout-owned payment — exactly what
       -- §4 exists to prevent.
       integration_flow = coalesce(p.integration_flow,
         case when p.stripe_session_id        is not null then 'hosted_checkout'
              when p.stripe_payment_intent_id is not null then 'direct_payment_intent'
         end)
  from numbered
 where p.id = numbered.id;

-- The Stripe-attempt row contract, enforced rather than described. Without
-- these, the schema still permits: a Stripe row with a null attempt, a
-- non-Stripe row with an attempt, a direct row with no intent id, a hosted row
-- with no session id, and an attempt with no flow.
alter table public.payments
  add constraint payments_attempt_seq_chk
  check (attempt_seq is null or attempt_seq > 0);

alter table public.payments
  add constraint payments_integration_flow_chk
  check (integration_flow is null
         or integration_flow in ('direct_payment_intent','hosted_checkout'));

-- attempt_seq and integration_flow travel together.
alter table public.payments
  add constraint payments_attempt_flow_chk
  check ((attempt_seq is null) = (integration_flow is null));

-- A Stripe row has an attempt and a non-Stripe row does not — BOTH directions.
-- The one-directional form (`attempt_seq is null or payment_method = 'stripe'`)
-- accepts a Stripe row with a null attempt and a null flow, so M4's "Stripe row
-- with null attempt" case could never fail: the contract would have been
-- described in a comment rather than enforced.
--
-- `payment_method` is nullable `text` (047 added it without NOT NULL), and a
-- CHECK passes when it evaluates to NULL — so `payment_method = 'stripe'` alone
-- would let a null-method row carry an attempt. coalesce makes the predicate
-- total.
alter table public.payments
  add constraint payments_attempt_is_stripe_chk
  check ((coalesce(payment_method, '') = 'stripe') = (attempt_seq is not null));

-- Provider ids belong only to Stripe rows. Without this a bank_transfer row
-- could carry a session id, own the unique index, and block the real payment.
alter table public.payments
  add constraint payments_provider_ids_are_stripe_chk
  check (coalesce(payment_method, '') = 'stripe'
         or (stripe_payment_intent_id is null and stripe_session_id is null));

-- Each flow requires its own provider id. Hosted rows may ALSO carry an intent
-- id once settled, which is why this is a presence rule, not exclusivity.
alter table public.payments
  add constraint payments_flow_ids_chk
  check (
    integration_flow is null
    or (integration_flow = 'hosted_checkout'        and stripe_session_id is not null)
    or (integration_flow = 'direct_payment_intent'  and stripe_payment_intent_id is not null
                                                    and stripe_session_id is null)
  );

-- One row per provider object. These were PLAIN indexes, so two rows could
-- reference one Stripe object. AUDIT FOR DUPLICATES FIRST (Phase 0b) — a
-- duplicate makes this fail, which is correct but must be known in advance.
drop index if exists payments_stripe_payment_intent_id_idx;
create unique index payments_stripe_payment_intent_id_uniq
  on public.payments (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

create unique index payments_stripe_session_id_uniq
  on public.payments (stripe_session_id)
  where stripe_session_id is not null;

-- In-migration assert: name the collision instead of leaving a bare
-- unique-index error to be diagnosed mid-deployment. The index below would
-- fail anyway; this fails FIRST, with the query the operator needs.
do $$
begin
  if exists (select 1 from public.payments
              where attempt_seq is not null
              group by enrollment_id, attempt_seq
             having count(*) > 1) then
    raise exception 'attempt_seq collision after backfill; run the pre-migration audits and reconcile';
  end if;
end $$;

-- One row per (enrollment, attempt) for Stripe. Flow is deliberately NOT part
-- of the key: an enrollment switching direct <-> Checkout is a NEW attempt, so
-- the sequence already separates them. Including flow would let one attempt
-- exist twice under two flows.
create unique index payments_enrollment_attempt_uniq
  on public.payments (enrollment_id, attempt_seq)
  where attempt_seq is not null;

-- ────────────────────────────────────────────────────────────────────────────

do $$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public'
         and table_name = 'payments'
         and (column_name, data_type) in (
           ('provider_amount_minor','bigint'),
           ('provider_currency','text'),
           ('integration_flow','text'),
           ('attempt_seq','integer'))) <> 4 then
    raise exception 'payments contract columns are not the expected shape';
  end if;
end $$;

-- ────────────────────────────────────────────────────────────────────────────

-- Finalisation: validate identity, insert-or-resolve the replacement, and
-- retire the superseded row in ONE transaction. Idempotent, so a second caller
-- can complete a retirement the first abandoned.
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
  p_predecessor_payment_id uuid
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
      enrollment_id, tenant_id, amount, payment_method, status,
      stripe_payment_intent_id, stripe_session_id,
      provider_amount_minor, provider_currency, integration_flow, attempt_seq)
    values (
      p_enrollment_id, p_tenant_id, p_amount, 'stripe', 'awaiting_payment',
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

-- PostgreSQL grants EXECUTE to PUBLIC by default, which would expose this
-- through PostgREST. Explicit revoke, then service_role only.
revoke all on function public.finalize_stripe_payment_attempt(
  uuid,uuid,text,integer,text,text,numeric,bigint,text,uuid) from public, anon, authenticated;
grant execute on function public.finalize_stripe_payment_attempt(
  uuid,uuid,text,integer,text,text,numeric,bigint,text,uuid) to service_role;

-- AMOUNT MODEL — whole major units only, decided, not deferred.
--
-- `payments.amount` is INTEGER (000, renamed by 074) and so are the fee
-- columns feeding it (`classes.fee_amount`, `enrollment_items.fee_amount`,
-- both fee_mmk INTEGER at 000). A fractional SGD price cannot be configured,
-- cannot be stored, and every reader (admin payments, student detail, public
-- status) would display it wrong after silent rounding. v8 papered over this
-- with round(p_amount) in the winner validation, which made retries consistent
-- while persisting a WRONG amount — claiming a capability the data model does
-- not have.
--
-- The launch contract is therefore: SGD amounts are whole major units.
--   * toMinorUnits() rejects fractional major amounts (creation-side gate);
--   * this function raises ST001 on any non-integral p_amount (top of body);
--   * the winner validation compares plain equality — no rounding anywhere.
-- Widening `amount` to numeric is the real fix for fractional currencies and
-- is explicitly out of scope: it is a type change under every payment surface.

-- v6 also proposed allocate_stripe_attempt() and revoked nothing on it, leaving
-- a SECURITY DEFINER function executable by PUBLIC — callers could have probed
-- payment-attempt counts for arbitrary enrollment UUIDs. That function is gone
-- (see above), which removes the exposure rather than patching it. Any function
-- added later must carry the same revoke/grant pair, asserted by test.

COMMIT;
