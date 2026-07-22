# Plan v18 — browser-independent Stripe settlement

**Status:** v18, for review
**Settlement core:** approved at v14 — v15–v18 change audit/deployment tooling only
**Plan A:** shipped — merged (#201), applied and verified on dev, staging and **production**
**Closes:** the urgent portion of #186
**Blocks:** reopening public Stripe sales
**Launch scope:** SGD only, FlashTic

---

## Problem

Two Stripe flows; only one is webhook-covered.

| Flow | Page | Coverage |
|---|---|---|
| **PaymentIntent** (card + PayNow) | `/enroll/[slug]/checkout/payment` — FlashTic | **none** |
| Hosted Checkout | `/enroll/payment/[ref]` — language school | `checkout.session.completed` |

The event flow settles only if the buyer's browser returns to poll
`/intent/status`. Close the tab and Stripe has the money while the enrollment
stays `pending_payment`, ticketless, with no server-side recovery.

Checkout sessions are created without `payment_method_types`, so delayed methods
depend on Dashboard config: `completed` arrives `unpaid` (correctly skipped),
settlement arrives as `async_payment_succeeded`, failure as
`async_payment_failed` — neither handled.

### Live defect this plan also fixes

Both creation routes hardcode `fee_amount * 100`. Only **MMK** is blocked;
**JPY is not**, and `walmal` is a JPY event tenant — a ¥5,000 ticket would be
sent as `500000`, a **100× overcharge**. Latent only because Stripe is currently
disabled in production. §2 replaces the "not MMK" gate with an allow-list.

---

## 1. Migration — executable

Additive, applied strictly before any code that writes the new columns.

### 1a. Settlement conflicts

```sql
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
```

Recording is a single atomic upsert — never select-then-write. There are
**two** upsert shapes, because sighting an incident again and discovering that
an object needs cleanup are different transitions:

```sql
-- (i) Generic sighting — webhooks, and creation conflicts with nothing to
-- clean up. Deliberately touches NO cleanup or resolution field: a replayed
-- webhook must not reset a 'pending' cleanup or reopen a resolved incident.
insert into public.payment_settlement_conflicts (...) values (...)
on conflict (provider, provider_object_id, conflict_type) do update
   set last_source_type    = excluded.last_source_type,
       last_source_id      = excluded.last_source_id,
       actual_amount_minor = excluded.actual_amount_minor,
       actual_currency     = excluded.actual_currency,
       occurrence_count    = payment_settlement_conflicts.occurrence_count + 1;

-- (ii) Cleanup-requiring sighting — an unowned payable object exists NOW, so
-- whatever the row said before ('none' from an earlier sighting, 'done' from
-- an earlier cancelled object, even 'resolved') is superseded in the SAME
-- atomic statement. Reopening resolved-in-one-statement is what keeps the
-- resolved+pending CHECK satisfiable; a two-step "set pending, then reopen"
-- would violate it in between.
insert into public.payment_settlement_conflicts (..., cleanup_status)
values (..., 'pending')
on conflict (provider, provider_object_id, conflict_type) do update
   set last_source_type    = excluded.last_source_type,
       last_source_id      = excluded.last_source_id,
       actual_amount_minor = excluded.actual_amount_minor,
       actual_currency     = excluded.actual_currency,
       occurrence_count    = payment_settlement_conflicts.occurrence_count + 1,
       cleanup_status      = 'pending',
       status              = 'open',
       resolved_at         = null;
-- resolution_note is deliberately PRESERVED: it documents the prior
-- resolution, and status='open' + a fresh occurrence already signal the
-- reopen. Erasing an operator's note would destroy the only narrative of
-- what happened last time.
```

The `pending → done` transition is **conditional**, so concurrent cleanup
attempts cannot falsely complete each other:

```sql
update public.payment_settlement_conflicts
   set cleanup_status = 'done'
 where provider = 'stripe' and provider_object_id = $1 and conflict_type = $2
   and cleanup_status = 'pending';
```

Zero rows updated means another worker already moved it (or a new sighting
re-pended it) — re-read, never assume.

`first_source_type` and `first_source_id` are never overwritten: the first
sighting identifies the incident. Both **last** fields move together, so a
webhook replay of a conflict first seen at creation is recorded as exactly
that — creation origin, webhook latest sighting.

**Outcome → conflict type, exact, so no implementer guesses and no insert can
fail its own CHECK:**

| Outcome | `conflict_type` |
|---|---|
| `ST002` (predecessor already verified) | `replacement_after_verified` |
| `ST003` (winner fails the attempt contract) | `attempt_contract_mismatch` |
| `ST004` (provider object owned elsewhere) | `provider_object_owned` |
| retrieval `complete + no_payment_required` | `unexpected_no_payment_required` |
| stale `async_payment_failed` on a verified payment | `failure_after_verified` |

### 1b. Contract snapshot and attempt identity

```sql
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
```

Shape assertions afterwards, because `ADD COLUMN IF NOT EXISTS` silently accepts
a wrong-typed existing column:

```sql
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
```

> If a future revision adds a **function** baseline guard, hash the CR-stripped
> source — `md5(replace(prosrc, chr(13), ''))`. Plan A learned this in
> production: `db push` sends LF, pasting the same file from a Windows working
> copy sends CRLF, and the raw hash then differs for an identical function
> (raw `bf79c0e604…`, CR-stripped `aff0ae3477…` matching dev, length 1600 vs 1562).

### 1c. Replacement finalisation

**One** `SECURITY DEFINER` function. A crash between "insert replacement" and
"retire superseded" would leave a dead row shielding the enrollment — exactly
the invariant Plan A's T9 documents — so both happen in one transaction.

**There is no allocator function.** v6 proposed
`allocate_stripe_attempt()` returning `max(attempt_seq) + 1`, and that does not
converge:

| | Request A | Request B |
|---|---|---|
| t1 | decides the old payment needs replacing | decides the same |
| t2 | allocates `2`, creates + finalises attempt 2 | |
| t3 | | allocates — now reads `max = 2`, gets **3** |
| t4 | | different idempotency key → **second payable object** |

The read and the decision are separate operations, so a later `MAX()` can move
between them. Stripe's idempotency contract requires the key to identify the
same *logical operation*; keying off a value that another request can advance
breaks exactly that.

The attempt is therefore derived from the **predecessor that was selected**, not
from a fresh aggregate:

```
no predecessor        -> attempt_seq = 1
                         key = stripe:{flow}:{enrollment_id}:initial

predecessor P         -> attempt_seq = P.attempt_seq + 1
                         key = stripe:{flow}:{enrollment_id}:after:{P.id}
```

Both requests above selected the *same* predecessor, so both derive the same
attempt and the same key, and Stripe returns the same object — whether or not
one of them finalised first. The predecessor's identity is stable; a `MAX()` is
not.

**Sequence identity and retirement are separate concerns.** v7 conflated them
in one `p_supersede_payment_id`, and the conflation was reachable two ways:

| Call | v7 behaviour | Why it is wrong |
|---|---|---|
| `attempt_seq = 2`, predecessor null | inserts attempt 2, leaves attempt 1 **active** | recreates the dead shield Plan A exists to remove |
| predecessor already `rejected` | update matches 0 rows, `exists` check **raises** | a terminal predecessor is a legitimate identity anchor; it simply has nothing to retire |

So the parameter is renamed `p_predecessor_payment_id` and the two rules are
enforced independently:

```
attempt 1   <->  no predecessor, and no other Stripe attempt on the enrollment
attempt > 1 <->  predecessor REQUIRED, validated as exactly attempt_seq - 1
retirement  ->   performed only if that validated predecessor is still active
verified predecessor -> replacement REFUSED; the money is already taken
```

Identity is validated for every attempt above 1; retirement is conditional. A
`rejected` predecessor anchors the attempt and the key without being rejected
again.

Errors carry distinct SQLSTATEs so the route can map permanent contract
failures to a conflict and everything else to 500 — a text-matched error message
is not a control.

| SQLSTATE | Meaning | Route |
|---|---|---|
| `ST001` | attempt/predecessor identity violated | **500** — caller bug, never a buyer-visible conflict |
| `ST002` | predecessor already `verified` | `settlement_conflict` |
| `ST003` | resolved winner fails the attempt contract | `settlement_conflict` |
| `ST004` | provider object already owned by another row | `settlement_conflict` |

```sql
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
```

Retirement rides in the same transaction as the insert, so the crash window is
gone. A caller that dies mid-flight leaves a state the next call completes.

---

## 2. Currency — one helper, explicit allow-list, whole units only

```ts
// src/lib/payments/currency.ts
export const STRIPE_LAUNCH_CURRENCIES = ["sgd"] as const;
export function toMinorUnits(major: number, currency: string): number;
export function isStripeSupported(currency: string): boolean;
```

Both creation routes call `toMinorUnits()`; the `* 100` literals are deleted;
both gate on `isStripeSupported()` rather than `!== "mmk"`.

**The launch contract is whole major units** (§1c's amount-model note: every
fee column and `payments.amount` is integer). That contract is enforced at the
first layer, not discovered at the last: `toMinorUnits()` rejects **any**
fractional major amount — `SGD 12 → 1200`, `SGD 12.34 → thrown, before Stripe
is ever called`. The finalizer's ST001 check is the backstop for a caller that
bypassed the helper, never the primary gate; a contract violation that reaches
the database after a provider object exists has already cost a cleanup.

Also rejects zero, negative, `NaN`, `Infinity`, and any currency outside the
allow-list. Output is always an integer, asserted. The exponent logic (zero-
decimal 0, two-decimal 2) stays generic so widening the allow-list later is a
data change plus a deliberate review of the whole-unit restriction — not a
rewrite.

---

## 3. Creation — idempotent, fail-closed, explicit responses

### 3a. Idempotency, and why the loser must not clean up

1. Select the predecessor as part of the replacement decision, and derive
   `attempt_seq` **from it** — `P.attempt_seq + 1`, or `1` when there is none.
   Never from a fresh `MAX()`. The lookup selects **all** active Stripe rows
   for the enrollment, not the newest with a `LIMIT 1`: exactly one is the
   predecessor; zero means a first attempt; **more than one fails closed with
   500** and is reconciled by hand. Silently picking the newest would retire
   one shield and leave the other — the finalizer independently enforces the
   same invariant (ST001), so even a buggy caller cannot create that state.
2. Stripe **idempotency key** bound to that predecessor's identity —
   `stripe:{flow}:{enrollment_id}:after:{P.id}`, or `:initial` for a first
   attempt. Two requests replacing the **same predecessor** derive the same key
   and receive the **same** Stripe object, even if one finalises first.
3. `finalize_stripe_payment_attempt()` validates identity, inserts or
   resolves, and retires the predecessor if it is still active.

**A unique violation is evidence of convergence, not failure.** The loser
resolves the winning row, validates the contract, and returns it. It must
**never** cancel or expire the shared object — the winner has recorded it and
may already be returning its client secret to a buyer.

Cleanup is decided by **ownership**, and for typed failures it is *required*,
not merely permitted — idempotency prevents duplicate creation, it does not
neutralise an unowned payable object left behind by a refused replacement:

| Finalise outcome | Owner lookup by provider id | Action on the new object |
|---|---|---|
| `ST004` | another row owns it | **never** cancel — it is someone's live payment |
| `ST002` / `ST003` | **no row owns it** | record `cleanup_status='pending'` **first**, then cancel/expire, mark `done`, then `settlement_conflict` |
| `ST002` / `ST003` | a row owns it | leave it; record (`cleanup_status='none'`); return `settlement_conflict` |
| untyped database error | unknowable | leave it, **500** — ambiguity is "may be owned" |

The ST002 case is concrete: eligibility passes, Stripe creates the replacement
intent, a concurrent settlement verifies the predecessor, the finalizer raises
ST002 — and without cleanup a payable object for an **already-paid** enrollment
survives, reachable by anyone holding its client secret.

**The creation request's own retry cannot be the cleanup mechanism.** In
exactly that ST002 race, the enrollment is now `confirmed` — so the retry stops
at the eligibility gate with 409 and **never reaches cleanup**. Any design that
says "the retry re-attempts the cancellation" has a dead path precisely in its
motivating scenario. Cleanup state is therefore **durable, recorded before the
cancel attempt**:

1. **Record first**: upsert the conflict row with `cleanup_status = 'pending'`
   and the provider object id (upsert shape ii) — before touching the
   provider. The incident is now durable even if everything after this fails.
2. **If that write itself fails** — the one case record-first cannot cover —
   **the cancel is attempted anyway**, as an emergency action: ownership has
   already conclusively returned zero rows, so the only argument for not
   cancelling (someone may own it) is disproved, and the object is otherwise
   both payable **and unrecorded** — invisible to every reconciliation query.
   Return **500** and emit a sanitized high-severity operational log (object
   id and conflict type; never amounts-with-PII or secrets). Recording stays
   the preferred path; it cannot be the *only* path when recording is what
   failed.
3. Attempt the cancel/expire.
4. On provider confirmation: conditional `pending → done`; return
   `settlement_conflict`.
5. On failure: leave `pending`, return **500**. The route retry may or may not
   ever come back — `pending` does not depend on it.
6. `pending` rows are worked off by an operator (or a future reconciliation
   job, out of scope): query open conflicts with `cleanup_status = 'pending'`,
   cancel via the Stripe dashboard/API, mark `done`. **Reopening sales requires
   this query to return zero rows** — deployment step 17.

Both mechanisms failing at once — no record AND a failed emergency cancel — is
the residual case, and it is covered by **audit H**: the §4 metadata contract
(`integration_namespace = eduenroll`) is on every object we create, so an
object carrying it with no owning payment row and no conflict row is findable
from the Stripe side alone.

A conflict is never `resolved` while cleanup is `pending` (CHECK-enforced), and
`settlement_conflict` is never returned while cleanup is `pending` — a support
state that says "handled" while a payable object exists would be a lie.

### 3b. Fail closed on every lookup

Enrollment, tenant/currency, existing Stripe payment, previous-payment balance,
and the finalise call. Today `const { data: existing }` discards its error, so a
failed lookup reads as "no existing payment" and mints a second payable object.
"No row" and "the database did not answer" stay distinct.

### 3b-2. Enrollment eligibility, before any Stripe call

**This gate already exists and must survive the rewrite** — it is a
preservation requirement, not a new control. Verified in current code:

| Route | Line | Rule |
|---|---|---|
| `payments/stripe/intent/route.ts` | 40 | `status !== 'pending_payment'` → **409** |
| `payments/stripe/route.ts` | 65 | not in (`pending_payment`, `partial_payment`) → **409** |

Both are already allow-lists, so `rejected` and `confirmed` are already refused
and no Stripe object is created for them. The risk is that this plan rewrites
both routes substantially and the gate is dropped in the rewrite — so it is
stated here explicitly and pinned by test rather than left implicit.

The rule, unchanged: **only the listed payable states proceed**, checked
*before* the provider call, and any unrecognised state fails closed with 409.
The two routes deliberately differ — `partial_payment` is payable through
Checkout (which computes a remaining balance) and not through the direct intent
route, which has no balance contract. Widening the intent route to
`partial_payment` would require that contract first, and is out of scope.

Creation tests prove a `rejected` and a `confirmed` enrollment can neither
create nor retrieve a payable object, and that **Stripe is never called** — the
assertion is on the mock, because returning 409 after minting a PaymentIntent
would still leave a payable object behind.

An eligible state is also not the same as a settled one: idempotency makes a
repeated operation safe, it does not make an ineligible payment legitimate.
That is why the gate precedes Stripe rather than reconciling after it.

### 3c. Provider-state contract

Discriminated results, so the client cannot mistake one shape for another:

```ts
export type SettlementConflict = {
  kind: "settlement_conflict";
  paymentIntentId?: string;
  sessionId?: string;
  /** Enrollment ref — what the buyer quotes to support. */
  reference: string;
};

export type IntentCreationResult =
  | { kind: "requires_payment"; clientSecret: string; paymentIntentId: string }
  | { kind: "processing";  paymentIntentId: string }
  | { kind: "succeeded";   paymentIntentId: string }
  | SettlementConflict;

export type CheckoutCreationResult =
  | { kind: "redirect";   url: string;  sessionId: string }
  | { kind: "processing"; sessionId: string }
  | { kind: "succeeded";  sessionId: string }
  | SettlementConflict;
```

`settled: boolean` is gone. It collapsed self-healing and terminal outcomes into
one shape, so a client polled forever on states that can never resolve
themselves: rejected enrollment, amount or currency mismatch, missing snapshot,
unexpected enrollment state.

Those now return **`settlement_conflict`** — the client stops polling and shows
a support/reconciliation state quoting the enrollment ref, which is also the key
into `payment_settlement_conflicts`.

**A conflict is recorded before it is returned, from creation as well as from
webhooks.** The support state is only useful if an operator can find the
incident, so the order is fixed:

1. catch the typed permanent failure (`ST002`/`ST003`/`ST004`, or
   `complete + no_payment_required` on retrieval);
2. resolve ownership per §3a's table;
3. record, by the shape the situation requires:
   - **nothing to clean up** → generic upsert (shape i), `cleanup_status`
     untouched. Write failure: on a **webhook** request, non-2xx — Stripe's
     retry schedule re-records, that is the designed durability. On a
     **browser creation** request, **500 and a safe log** — the client's
     retry is *not guaranteed* and must not be counted as the recovery
     mechanism; the log line and the next legitimate sighting are;
   - **unowned payable object** → cleanup upsert (shape ii),
     `cleanup_status = 'pending'`. **Recording precedes cleanup** — §3a
     explains why the creation retry cannot be relied on to come back.
     **If this write fails**, the emergency branch runs: cancel the object
     anyway (ownership already conclusively returned zero rows), return
     **500**, emit the sanitized high-severity log. **This branch has no
     durable conflict row** — its recovery evidence is that log plus the
     audit-H sweep, and nothing else; do not describe it as having a
     reconciliation hook it does not have.
   Both source types `'creation_request'`, a generated request correlation id
   as both source ids — creation has no Stripe event id, and fabricating one
   would poison the webhook namespace;
4. attempt the cancel for `pending`; conditional `pending → done` on provider
   confirmation;
5. return `settlement_conflict` only with cleanup `done` or `none`. Cancel
   failure or a failed `done` update → **500** with the `pending` row as the
   reconciliation hook — that hook exists only on this branch, where the
   recording succeeded.

`ST001` never takes this path: it is a caller bug, returns 500, and is a log
line for us, not an incident record for an operator. `processing` remains the only polling
state, and it needs a defined client-side timeout after which it too surfaces
support rather than spinning.

| PaymentIntent state | Result | Client |
|---|---|---|
| `requires_payment_method` / `requires_confirmation` | `requires_payment` | open payment UI |
| `requires_action` | `requires_payment` | resume authentication |
| `requires_capture` | `processing` | "payment authorised", poll |
| `processing` | `processing` | "payment in progress", poll |
| `succeeded` | `succeeded`, or `settlement_conflict` if settlement is terminal | status screen — **not** "ticket ready" |
| `canceled` / `resource_missing` | replacement (§3a) | open payment UI |
| null / unrecognised | **502**, create nothing | error state |

| Checkout Session state | Result | Client |
|---|---|---|
| `open` | `redirect` | redirect |
| `complete` + `paid` | `succeeded` | status screen |
| `complete` + `unpaid` | `processing` | "awaiting payment", poll |
| `complete` + `no_payment_required` | **`settlement_conflict`** | support state, no polling |
| `expired` | replacement | redirect to the new URL |
| null / unrecognised | **502**, create nothing | error state |

**`succeeded` invokes the shared settlement operation synchronously.** It never
implies a ticket exists: the client routes to a status screen that polls until
the database confirms, because settlement can fail and tickets are issued after
it. If settlement returns a terminal conflict, the result is
`settlement_conflict` instead and the client stops.

`complete + no_payment_required` is deliberately a conflict rather than a
success: the creation contract rejects zero amounts, so a zero-amount Session
cannot satisfy the expected positive-payment contract. Calling it `succeeded`
would hide an anomaly behind a success screen.

Retrieval failures never authorise a replacement — connection error, 401, 429,
unexpected shape → **502, create nothing**. Only a definitively terminal state
does.

---

## 4. Event ownership: direct vs Checkout PaymentIntents

Hosted Checkout creates its **own** PaymentIntent, and Checkout payments record
`stripe_session_id`, never `stripe_payment_intent_id`. Without a discriminator a
Checkout payment reaches the direct handler, finds no row, returns 500, and is
retried on Stripe's full backoff **forever** while the Session events settle it
correctly.

**One shared metadata contract for every object this plan creates** — the
ownership discriminator is one field of it, not the whole of it. Audit H's
orphan sweep attributes objects from the Stripe side alone, so every
newly-created PaymentIntent must carry the full contract **on itself**, not on
a parent object:

```
integration_namespace = eduenroll     ← stable sweep key, never reused
integration_version   = 1             ← contract revisions are explicit
integration_flow      = direct_payment_intent | hosted_checkout
tenant_id
enrollment_id
enrollment_ref
```

| Object | How it gets the contract |
|---|---|
| Direct PaymentIntent | `metadata` on the create call |
| Checkout Session | `metadata` on the create call (kept — Session events read it) |
| Checkout Session's **underlying PI** | the same fields copied into `payment_intent_data.metadata`, with `integration_flow = hosted_checkout` |

The Checkout route currently sets metadata on the **Session only**, so its PI
has none — the exact gap that would make a PaymentIntent-side sweep unable to
attribute hosted objects. Tests assert the contract on the **resulting
underlying PaymentIntent** (retrieved after creation), not merely on the
parameters passed to Session creation — the parameter being sent is not proof
the object carries it.

| Marker | `payment_intent.succeeded` |
|---|---|
| `direct_payment_intent` | settle |
| `hosted_checkout` | **200, no settlement** — Session events own it |
| missing / unrecognised | no settlement; `unknown_integration_flow` conflict; 200 |

Missing is never assumed-direct: pre-existing PaymentIntents carry no marker and
guessing wrong means a double settlement or a retry loop. Those historical
objects are classified by the **Phase 0b audit**, not by this fallback.

---

## 5. Settlement operation

`settlePaidPayment()` is behind the three **paid** events —
`payment_intent.succeeded`, `checkout.session.completed`, and
`checkout.session.async_payment_succeeded`. The existing `completed` branch is
refactored onto it; two settlement paths that drift apart is how earlier bugs in
this series happened.

**`checkout.session.async_payment_failed` does NOT go here.** v7 listed it under
an operation whose every step is a paid path — validate the paid amount, mark
`verified`, confirm the enrollment, issue tickets. Feeding a failure into that
would settle a payment that never arrived. It gets its own operation, §5b.

1. **Validate the contract** against the snapshot — never recomputed from
   current class/tenant config. A null snapshot does **not** settle: it records
   `missing_contract_snapshot` and returns 200.
2. **Conditional UPDATE** `payments` from `('awaiting_payment','pending')` to
   `verified`. Not `payment_submitted` — that is an *enrollment* status
   (`PaymentStatus = awaiting_payment | pending | verified | rejected`).
3. `trg_payments_sync_enrollment` confirms the enrollment in the same statement.
   The helper **never** writes `enrollments.status`.
4. **Zero rows → fail-closed reload**, never an assumed replay:

   | Reloaded | Outcome |
   |---|---|
   | `verified` | `already_settled` — **falls through to step 5** |
   | `rejected` | `payment_already_rejected` conflict → 200 |
   | absent | `not_found` → **500** (creation inserts after the provider call) |
   | other | `unexpected_payment_state` conflict → 200 |
   | query error | **500** |

5. **Post-settlement classification — `settled` and `already_settled` take the
   same path.** Re-read the enrollment:

   | Enrollment | Outcome |
   |---|---|
   | `confirmed` | fulfil (retryable → 500) |
   | `rejected` | `rejected_enrollment` conflict, no ticket, no notification, 200 |
   | absent / query error | **500** |
   | other | `unexpected_enrollment_state` conflict, 200 |

   Only the notification decision differs: `settled` may notify,
   `already_settled` never does.

Fulfilment reuses `issueTicketsForEnrollment()`, which already repairs partial
sets and declines non-`confirmed` enrollments.

### Failure boundaries

| Failure | Payment | Enrollment | Tickets | HTTP |
|---|---|---|---|---|
| Settlement statement fails | unchanged | unchanged | none | 500 |
| Fulfilment fails **after** settlement | verified | confirmed | missing | **500** |

Once settlement commits the money is recorded; the retry repairs tickets.

---

## 5b. Failure operation

`handleStripePaymentFailure()`, for `checkout.session.async_payment_failed` —
a delayed method (PayNow, bank debit) that did not clear.

1. **Locate the row** by `stripe_session_id` from the event object. It is a
   Session event, so the session id is the only identifier guaranteed present.
2. **Conditional UPDATE** `payments` from `('awaiting_payment','pending')` to
   `rejected`. Never touches `enrollments` — Plan A's trigger owns that
   decision, and duplicating it in the application is precisely the
   read-then-write Plan A removed.
3. **Zero rows → fail-closed reload**, never an assumed replay:

| Reloaded | Outcome | HTTP |
|---|---|---|
| `rejected` | idempotent replay, no conflict, no notification | 200 |
| `verified` | **stale failure** — the payment is paid. No status change, no ticket revocation. `failure_after_verified` conflict | 200 |
| absent | `not_found` → creation inserts after the provider call, so this is a real anomaly | **500** |
| other | `unexpected_payment_state` conflict | 200 |
| query error | — | **500** |

4. **The enrollment is not re-read and not written.** Plan A's predicate already
   decides: the trigger rejects the enrollment only if it is pre-confirmation
   **and** no other payment is verified or still active. So:

| Enrollment situation | Result after step 2 |
|---|---|
| pre-confirmation, this was the only active payment | `rejected`, seat released |
| pre-confirmation, another payment active or verified | **unchanged** — the other attempt still owns it |
| already `confirmed` by another payment | **stays confirmed** — this is Plan A's whole purpose |

A `verified` predecessor cannot reach step 2 at all, because the conditional
UPDATE only matches `awaiting_payment`/`pending`.

5. **Conflict write failure → 500**, as everywhere else.

Failures are **not** notified in this plan: a "your payment failed" message is a
buyer-facing decision with its own copy and retry semantics, and #186 owns the
durable channel. The rejected row and the released seat are the observable
outcome.

---

## 6. Notifications outside the retry boundary

Under 500-and-retry, an SMS failure after a successful email would resend the
email on redelivery. So: settlement and fulfilment may return 500; notification
failures are caught, logged, and never change the status code; only the
transition winner notifies; order is settle → fulfil → notify.

**Notifications can still be lost.** This plan does not make them durable; #186
owns the outbox.

---

## 7. Response policy

| Outcome | HTTP |
|---|---|
| settled / already_settled | 200 |
| any conflict **successfully recorded** | 200 |
| invalid signature / malformed | **400** |
| payment row not found (paid **or** failed event) | **500** |
| `ST002` / `ST003` / `ST004` from finalise | `settlement_conflict`, 200 |
| `ST001` from finalise | **500** — caller bug, not a buyer conflict |
| conflict write fails | **500** |
| database failure / fulfilment failure | **500** |

Diverges from the house "always 200 and log" pattern deliberately: Stripe's
retry schedule is the durability mechanism.

---

## Files

| File | Change |
|---|---|
| `supabase/migrations/2026072x_stripe_settlement_contract.sql` | **new** — §1a–1c |
| `src/lib/payments/currency.ts` | **new** |
| `scripts/stripe-orphan-audit.mjs` | **new** — audit H's executable, three commands: `legacy-detect` (one-time historical inventory: starts from exported payment provider ids + sweeps legacy tenant/enrollment metadata without namespace), `detect` (recurring namespace-based sweep, post-v14 objects), both read-only with account+mode verification, exhaustive pagination, Session+PI object graph, state-aware classification incl. conflict `cleanup_status`, sanitized JSON report; exits per-mode — `legacy-detect` nonzero while payable/processing/unreconciled-paid historical work remains (backlog loop), `detect` nonzero on any such orphan (incident); and `remediate` (reviewed report file + **fresh second ownership export** consumed before any mutation, explicit account/mode/count confirmation, ids from the report only, Stripe re-fetch before every mutation, refuses on any drift; **batch mode on `legacy-detect` reports only** — `detect` reports get per-object review + root-cause note). DB data from operator-exported files — no DB connection. Key from env, never argv |
| `scripts/migration-gate.mjs` | **new** — applies a named migration file to the local database in a rolled-back transaction, then runs the 0b-G catalog assertions; deployment step 4. **Mechanically local-only, enforced before any connection**: target host must be `localhost`/`127.0.0.1` (hard-coded default, no `DATABASE_URL`/env fallback and no `--linked` mode — a linked-project fallback is how a "local" tool touches production); the migration path must resolve inside `supabase/migrations/`; exactly one migration may be named; connection strings and credentials are never printed. Tests: a hosted-looking URL exits **before any connection attempt** (asserted — no socket opened); a path outside `supabase/migrations/` refused; two migrations refused |
| `src/server/payments/settlePaidPayment.ts` | **new** — paid events only |
| `src/server/payments/handleStripePaymentFailure.ts` | **new** — §5b |
| `src/types/database.ts` | `payments` gains `provider_amount_minor`, `provider_currency`, `integration_flow`, `attempt_seq`; conflict row type; creation result unions |
| `src/app/api/webhooks/stripe/route.ts` | 3 new events; refactor `completed`; outcome → status mapping |
| `src/app/api/public/payments/stripe/intent/route.ts` | idempotency, snapshot, allow-list, discriminated result, fail-closed, `STRIPE_SALES_OPEN` launch gate (503 before any Stripe call; `STRIPE_SMOKE_REFS` exception; pinned parsing: only raw-exact `true` opens (no trimming), exact full-ref match only) |
| `src/app/api/public/payments/stripe/route.ts` | same, Checkout variant + `payment_intent_data.metadata` + the same launch gate |
| `src/app/(public)/enroll/[slug]/checkout/payment/page.tsx` | **client** — handle all `IntentCreationResult` kinds; poll on the non-secret kinds |
| `src/app/(public)/enroll/payment/[ref]/page.tsx` | **client** — handle all `CheckoutCreationResult` kinds |
| `src/app/api/public/payments/stripe/intent/status/route.ts` | reuse the shared settlement operation |
| `src/__tests__/payments/currency.test.ts` | **new** |
| `src/__tests__/payments/stripeSettlement.test.ts` | **new** — mocked control flow, status mapping |
| `src/__tests__/payments/stripeCreation.test.ts` | **new** — idempotency, provider states, client contract |
| `src/__tests__/db/stripe-settlement.db.test.ts` | **new** — route-level, signed events, real DB |
| `src/__tests__/db/stripe-attempt-lifecycle.db.test.ts` | **new** — RPC atomicity, replacement, Plan A invariant |

---

## Tests

**Route-level, signed event → real database**

| # | Case |
|---|---|
| R1 | direct `payment_intent.succeeded`, card, browser never polls → verified, confirmed, full ticket set, brand/last4 |
| R2 | same, PayNow → card fields null |
| R3 | Checkout's underlying PI emits `payment_intent.succeeded` → **200, no settlement** |
| R4 | PI with **no** marker → `unknown_integration_flow` conflict, no settlement |
| R5 | `async_payment_succeeded` after unpaid `completed` |
| R6 | `checkout.session.completed` regression after refactor |
| R7 | duplicate delivery → no second ticket or notification |
| R8 | **concurrent** duplicate deliveries → exactly one winner |
| R9 | invalid signature → 400, **no database access** |
| R10 | `async_payment_failed` on an unsettled payment → rejected, seat released |
| R11 | `async_payment_failed` **duplicate** → idempotent, no second conflict, 200 |
| R12 | `async_payment_failed` on an **already verified** payment → stays verified, tickets intact, `failure_after_verified` conflict, 200 |
| R13 | `async_payment_failed` while **another** payment already confirmed the enrollment → enrollment stays `confirmed` (Plan A predicate) |
| R14 | `async_payment_failed` with **no matching row** → 500 |
| R15 | `async_payment_failed` never invokes `settlePaidPayment()` — asserted on the module, since a shared entry point is how the paid path would be reached |

**Settlement contract**

| # | Case |
|---|---|
| S1 | settlement statement fails → both unchanged, 500 |
| S2 | fulfilment fails after settlement → settled, 500, retry completes tickets |
| S3 | already-verified + tickets missing → fulfilment re-runs |
| S4 | zero rows + reloaded `rejected` → conflict, not "already settled" |
| S5 | zero rows + absent → **500** |
| S6 | **already-verified + rejected enrollment** → conflict, no silent 200 |
| S7 | amount mismatch → no settlement, conflict |
| S8 | currency mismatch → as S7 |
| S9 | null snapshot → no settlement, `missing_contract_snapshot` |
| S10 | conflict insert fails → **500** |
| S11 | notification throws → 200, tickets intact |
| S12 | repeat conflict → upsert bumps `occurrence_count`, moves both `last_source_*` fields together, keeps both `first_source_*` fields |

**Attempt lifecycle — real database, real RPC**

| # | Case |
|---|---|
| L1 | **concurrent creation**: both get the same provider object, **exactly one** payment row, **neither cancels it**, both return compatible results |
| L2 | crash/retry after provider creation → second call finalises; no duplicate row |
| L3 | duplicate RPC call → idempotent no-op |
| L4 | concurrent replacement requests → one active replacement |
| L5 | provider id belonging to **another enrollment** → `attempt_contract_mismatch`, no reuse |
| L6 | superseded row **never** retired unless the replacement is durably active |
| L7 | replacement succeeds → old row retired → **Plan A's T9 shield is gone**, so a later failure does release the seat |
| L8 | insert failure with provably no owning row → replacement object cancelled, **old row unchanged** |
| L9 | ambiguous database error → object **not** cancelled, 500 |
| L10 | **adverse interleaving**: A and B both select predecessor P; A finalises attempt P+1 first; B derives the SAME attempt and key from P and converges — **no second payable object** |
| L11 | first attempt (no predecessor) → attempt 1, `:initial` key |
| L12 | **cross-tenant predecessor** → raises; the other tenant's payment is untouched |
| L13 | predecessor with the wrong `attempt_seq` → raises, not silently skipped |
| L14 | predecessor that is not a Stripe row → raises |
| L15 | resolved winner belonging to another tenant, or a different major amount → `ST003` |
| L16 | **attempt 2 with no predecessor** → `ST001`, nothing inserted, attempt 1 still active |
| L17 | **attempt 1 when a later attempt exists** → `ST001` |
| L18 | attempt 1 retried when only attempt 1 exists → idempotent resolve, **not** `ST001` |
| L19 | **`rejected` predecessor**, no other active Stripe row → accepted as identity anchor, attempt inserted, **no** raise, nothing re-rejected |
| L19b | `rejected` predecessor while an **older row is still active** → `ST001`; the anchor and the retirement target being distinct rows is a reconcile-first state, never silently absorbed |
| L20 | **`verified` predecessor** → `ST002`, no replacement object recorded |
| L21 | provider id owned by another enrollment → `ST004` naming the owning row (this is L5's mechanism, now reachable) |
| L22a | *(route/helper)* fractional SGD → rejected **and the Stripe mock is never called** — the primary gate; only a route test can prove Stripe non-involvement, because the finalizer normally runs after provider creation |
| L22b | *(RPC)* direct invocation with fractional `p_amount` → `ST001`, nothing inserted — the backstop |
| L26 | `p_amount_minor <> p_amount * 100` → `ST001`, nothing inserted |
| L27 | `p_currency` outside the launch allow-list → `ST001`, nothing inserted |
| L28 | `p_currency = 'SGD'` (uppercase) → accepted, row persists **`'sgd'`**, and an identical retry resolves rather than raising a false mismatch — canonicalise-once, asserted on the stored value |
| L23 | replacement finalises while a second active Stripe row exists → `ST001`, **neither** active row retired, nothing inserted |
| L24 | after a successful replacement, **zero** other active Stripe rows remain for the enrollment — asserted by query, not implied |
| L25 | unique violation from a **non-provider** constraint → re-raised as-is (500), never `ST004` |

**Migration**

| # | Case |
|---|---|
| M1 | historical row carrying **both** provider ids → backfilled `hosted_checkout`, not direct |
| M2 | row with only an intent id → `direct_payment_intent` |
| M3 | multi-payment enrollment → attempts numbered 1..n by creation order, unique index holds |
| M4 | row-contract constraints reject: **Stripe row with null attempt** · non-Stripe row with an attempt · **null-`payment_method` row with an attempt** · direct row with no intent id · hosted row with no session id · attempt without a flow · **non-Stripe row carrying a provider id** |
| M7 | a pre-existing `payment_method='stripe'` row with **no provider id** makes the migration fail loudly (audit 5 exists to find these first) |
| M5 | `has_function_privilege`: `anon` and `authenticated` **cannot** execute `finalize_stripe_payment_attempt`; `service_role` can |
| M6 | shape assertion fails when any of the four columns has the wrong type |

**Currency**: SGD 12 → 1200 · **SGD 12.34 → thrown (whole-unit contract)** ·
JPY 5000 → 5000 (not 500000, exponent logic) · MMK refused ·
JPY refused by the allow-list · no `!== "mmk"` remains · zero/negative ·
NaN/Infinity · excessive precision · unsupported currency · float edges ·
integer output asserted.

**Creation conflict recording and cleanup**: ST002 with no owning row →
conflict row written with `cleanup_status='pending'` **before** the provider
mock sees the cancel call, cancel succeeds → `done`, then the response — order
asserted on the mock/spy sequence, not implied · ST003 → same with
`attempt_contract_mismatch` · ST004 → conflict recorded with
`cleanup_status='none'` and **cancel is never called** (mock asserts zero
invocations) · cancel fails → **500**, row stays `pending`, and a
**subsequent creation request that now hits the eligibility 409 does NOT erase
or resolve it** — the durable-state property itself · the `done` update fails →
500, row stays `pending` · conflict write fails after a zero-row ownership lookup → **500** and the
provider mock **saw the emergency cancel anyway** — the write failing is not
permission for the object to stay payable · concurrent cleanup: two workers
race `pending → done`, exactly one conditional update wins, the loser re-reads
and does not falsely complete · generic sighting (shape i) against a `pending`
row leaves `cleanup_status` untouched · cleanup sighting (shape ii) against a
`none` row → `pending` · against a `done` row → re-pended · against a
**resolved** row → atomically `open` + `pending` + `resolved_at` null, note
preserved, no intermediate state violating the CHECK · `complete + no_payment_required` →
`unexpected_no_payment_required` · a webhook replay of a creation-first
incident updates `last_source_type` **and** `last_source_id` together and never
rewrites either `first_*` field · a `resolved` + `pending` row is
CHECK-rejected.

**Creation eligibility** (§3b-2): `rejected` enrollment → 409 and **Stripe not
called** · `confirmed` enrollment → 409 and Stripe not called · unrecognised
status → 409 · intent route refuses `partial_payment` · Checkout route accepts
it · each asserted on the Stripe mock, not only on the status code.

**Client**: each discriminated kind renders the right state; `processing` and
`succeeded` never attempt to mount Stripe Elements without a secret;
`succeeded` shows a polling status screen rather than claiming a ticket;
**`settlement_conflict` stops polling** and shows a support state quoting the
reference; `processing` honours its polling timeout and then surfaces support.

> **Red phase is an implementation requirement, not a claim.** Nothing is
> implemented and no run has happened. Each test that can fail against current
> behaviour must be verified red before the fix, and the **observed** counts
> recorded in the PR.

---

## Phase 0 — prove containment

Stripe keys were removed from production and a redeploy started, but the live
server-side path was never re-tested. Record, without exposing values:

- [ ] `vercel env ls production` — are `STRIPE_SECRET_KEY` /
      `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` absent?
- [ ] Latest production deployment timestamp is **after** the removal
- [ ] The mechanism keeping sales closed is written down — note that
      `payment_mode` and closing the intake do **not** close the endpoint
      (verified: the intent route checks neither)

**No live POST probe.** An earlier draft proposed POSTing a real enrollment and
expecting 502. That is a mutating production test disguised as a read-only
check: if containment has failed — the only case worth detecting — it creates a
real PaymentIntent and payment row. Use `vercel env ls`, the deployment
timestamp, and a **GET** (405, never reaches Stripe). Any real payment probe
needs explicit authorisation, a designated throwaway enrollment, and an agreed
cleanup procedure.

## Phase 0b — audits and remediations, split by when they can run

**This phase is NOT read-only, and calling it that was a safety mislabel**: it
cancels Stripe objects, rejects payment rows, writes snapshots, and updates
provider metadata. Every item below therefore runs as three separated stages —
mislabelling mutation as audit is how an "audit" ends up run casually against
production:

1. **Detect** — read-only queries/API listing, producing a *reviewed
   disposition list* of exact object/row ids;
2. **Remediate** — mutating, requires explicit authorization of that reviewed
   list, exact ids and commands stated up front, environment and Stripe
   mode/account verified before the first mutation, results recorded;
3. **Verify** — read-only re-run proving the remediation landed.

Run on **dev first, then production**. v9 listed these as one pre-flight
block, but audits 1 and 3 reference columns **created by the migration**
(`provider_amount_minor`, `provider_currency`, `attempt_seq`) and would fail
with "column does not exist" on an unmigrated database. Each item therefore
states when it runs.

### Pre-migration — findings block the migration itself

**A. Duplicate provider objects** — would make the unique indexes fail:

```sql
select stripe_payment_intent_id, count(*) from payments
 where stripe_payment_intent_id is not null group by 1 having count(*) > 1;

select stripe_session_id, count(*) from payments
 where stripe_session_id is not null group by 1 having count(*) > 1;
```

**B. Stripe rows with no provider id** — fail the bidirectional constraint:

```sql
select id, enrollment_id, status, amount, created_at
  from payments
 where payment_method = 'stripe'
   and stripe_payment_intent_id is null
   and stripe_session_id is null;
```

**C. Provider ids on non-Stripe rows** — fail `payments_provider_ids_are_stripe_chk`:

```sql
select id, enrollment_id, payment_method, status
  from payments
 where coalesce(payment_method, '') <> 'stripe'
   and (stripe_payment_intent_id is not null or stripe_session_id is not null);
```

**D. Multiple active Stripe attempts per enrollment** — each is a Plan A
shield; the replacement lifecycle fails closed (ST001) on this state:

```sql
select enrollment_id, count(*) as active_stripe_payments
  from payments
 where payment_method = 'stripe'
   and status in ('awaiting_payment', 'pending')
 group by enrollment_id
having count(*) > 1;
```

**E. Historical Stripe objects — made terminal, not preserved.** Pre-existing
PaymentIntents carry no `integration_flow` and their rows will have null
snapshots — so if a buyer completes one after launch, `payment_intent.succeeded`
records `unknown_integration_flow`, browser settlement records
`missing_contract_snapshot`, and **Stripe holds money for an enrollment nothing
can settle**.

Earlier revisions tried to *preserve* legitimate still-payable objects with a
post-migration backfill on both the database and Stripe sides (v13's "E2").
v14 deletes that path deliberately: the launch must not depend on faithfully
reconstructing uncertain historical state, and every preserved payable is a
migration-window race carrier. The policy is the simplest safe one — **no old
payable attempt survives to launch**:

| Stripe state | Action (pre-migration, detect → authorize → remediate → verify) |
|---|---|
| payable (PI not in `succeeded`/`canceled`/`processing`; Session `open`) | **cancel/expire via Stripe**, reconcile the row (reject it; Plan A's trigger applies its own predicate). Legitimacy of the enrollment does not matter — the buyer creates a fresh, correctly-marked attempt through the new flow once sales reopen |
| `processing` | **wait or stop** — money may be in flight; do not cancel, do not migrate past it until it resolves to succeeded or failed, then handle per that state |
| `succeeded` / paid | **individual reconciliation, one by one**: payment status, enrollment status, tickets, and an explicit refund decision. Money was taken; nothing bulk applies |
| `canceled` / `expired` | verify the row's state matches; reconcile if not |

Hosted objects are classified through the **Session relationship** — a
PaymentIntent reached from a Session is `hosted_checkout` regardless of what
its own metadata says today. Attempt identity is never assigned by hand; the
migration's deterministic numbering owns whatever rows remain.

**F's acceptance criterion follows from E** and is now brutally simple —
the three historical zeros hold when the migration runs: **zero payable, zero
`processing`, zero unreconciled paid** historical objects. Null
snapshots survive only on rows tied to terminal objects — they can never
settle, and their `missing_contract_snapshot` handling is the designed
backstop, not an expected steady state.

### Inside the migration

The attempt-collision assert (§1b) runs after the backfill and before the
unique index, so a collision fails with the reconciliation query named rather
than a bare 23505.

### Post-migration — before code deploy or any new payment traffic

**F. Null contract snapshots** — rows settlement cannot validate (columns exist
only now):

```sql
select id, enrollment_id, status, stripe_payment_intent_id, stripe_session_id
  from payments
 where (stripe_payment_intent_id is not null or stripe_session_id is not null)
   and (provider_amount_minor is null or provider_currency is null);
```

Historical rows will all appear here — that is the expected finding, and it is
why settlement treats a null snapshot as `missing_contract_snapshot` rather
than an error. The audit's job is a **count and a decision**, not silence.

**H. EduEnroll-tagged Stripe objects, state-aware (recurring).** The sweep
covers **every** object carrying the §4 contract
(`metadata.integration_namespace = 'eduenroll'`) — terminal ones included,
because a succeeded orphan is the worst case, not an ignorable one. Each object
is classified by Stripe state × database owner, and **presence in the conflict
table is never automatically safe** — a conflict row with
`cleanup_status = 'pending'` describes an object still payable:

| Stripe state | Database owner | Action |
|---|---|---|
| payable | none | cancel/expire (remediate stage) |
| `processing` | none | **launch stop; monitor** — money may be in flight |
| succeeded / paid | none | **critical**: individual reconciliation / refund decision |
| canceled / expired | none | record only |
| any | payment row | validate metadata and contract against the row |
| any | conflict row only | evaluate `cleanup_status` — `pending` means still-open cleanup, `done`/`none` means evaluated; existence alone proves nothing |

**Checkout is one object graph.** A Session and its underlying PaymentIntent
are audited together: if a payment row owns the Session, its PaymentIntent is
accounted for **even when `stripe_payment_intent_id` was never saved** (the
pre-settlement state of every hosted payment). If Session and PI metadata
disagree, the tool **reports a conflict and stops — it never cancels
automatically on a disagreement**, because a mismatch means the model is wrong
somewhere and mutation on a wrong model compounds it.

It is a **launch gate**, so it is an executable, reviewed tool with two
separate commands:

**Discovery has two modes, because the namespace filter is blind to exactly
the objects the historical inventory exists to find** — pre-contract objects
carry no `integration_namespace` at all (audit E's premise), so a
namespace-only sweep would report a clean slate over a field of legacy
payables:

```bash
node scripts/stripe-orphan-audit.mjs legacy-detect --report legacy.json
```

- for deployment steps 6 and 9 — the one-time historical inventory;
- starts from **every Stripe provider id exported from existing payment
  rows** and retrieves those objects directly, traversing Session →
  PaymentIntent for each;
- additionally sweeps for objects carrying the legacy `tenant_id` /
  `enrollment_id` metadata **without** the namespace — the residue of
  provider-creation-then-failed-insert under the old routes, which no
  database export can name;
- classifies per audit E's table for terminalization.

```bash
node scripts/stripe-orphan-audit.mjs detect --report out.json
```

- the recurring post-launch sweep; selects by
  `metadata.integration_namespace = 'eduenroll'`, correct **only** for
  objects created after v14+ code deploys.

**The two modes have different exit and remediation semantics, because a
payable object means opposite things to them.** To `legacy-detect`, payables
are the *expected workload* — the inventory exists to terminalize them; its
nonzero exit means "work remains", it drives the step 9→10 loop, and
`remediate` accepts its reviewed report for **batch** terminalization. To the
recurring `detect`, after launch, any payable / `processing` / paid orphan is
an **anomaly the new code should have made impossible**; its nonzero exit is
an incident signal, and `remediate` refuses batch mode on a `detect` report —
each object gets individual review plus a root-cause note before any mutation,
because cancelling the symptom without understanding the writer that failed
just schedules the next orphan.

Both modes share the same guarantees:

- never mutate, and verify the Stripe **account id** and **mode** (live vs
  test) against what the operator stated before listing anything — refuse on
  mismatch;
- **paginate exhaustively** through PaymentIntents *and* Checkout Sessions;
- database ids arrive as a file: **you** export the provider-id columns and
  the conflict rows — **object id, conflict type, status, and
  `cleanup_status`**, not bare ids, since classification depends on them —
  via the Supabase dashboard (the tool prints the exact SQL); the tool has no
  database connection of its own, by construction;
- produce a **sanitized JSON report** — object ids, states, classifications,
  created timestamps; never client secrets or customer data;
- exit codes are **per-mode**, as above: `legacy-detect` exits nonzero
  while any payable, `processing`, or **unreconciled** paid historical object
  remains — work remaining, loop until zero; `detect` exits nonzero when any
  payable, `processing`, or paid orphan exists — an incident, not a backlog.

```bash
node scripts/stripe-orphan-audit.mjs remediate --report out.json --confirm ...
```

- requires the reviewed report file; acts **only** on ids present in it;
- requires explicit account, mode, and object-count confirmation before the
  first mutation, and requires the fresh export (below) to match that same
  account, mode, and object set;
- **re-fetches every object immediately before mutating it** and refuses to
  cancel if its Stripe state changed since the report;
- **requires a fresh database ownership export for the batch** — a Stripe
  re-fetch cannot see that a payment or conflict row appeared *after* the
  first export, and a stale report would then cancel a legitimately owned
  object. Before any mutation: the tool prints ownership-check SQL scoped to
  exactly the reviewed ids → **you** export the fresh result through the
  Supabase dashboard → the tool consumes that second export. For periodic
  operation while sales are live this second check is mandatory, not
  optional — the window between export and mutation is precisely when live
  traffic writes rows;
- **what the fresh export must show is per report mode** — a single shared
  "refuse any owned id" rule would forbid exactly the cancellations audit E
  requires, because most historical payables *have* payment-row owners and
  must be terminalized anyway:

  | Report | Object | Fresh export shows | Mutation |
  |---|---|---|---|
  | `legacy-detect` | owned payable, explicitly reviewed | **same** payment-row owner as recorded in the report | **allowed**; the owning row is reconciled after cancellation (rejected; Plan A's trigger applies its own predicate) |
  | `legacy-detect` | owned payable | any ownership change — new owner, removed owner, or a *different* payment row | **refused** |
  | `legacy-detect` | unowned payable | still unowned | allowed |
  | `legacy-detect` | unowned payable | gained an owner | refused |
  | `detect` | payable orphan | still unowned, conflict state unchanged | allowed (individually, with root-cause note) |
  | `detect` | any | any payment owner appears, or conflict status changed | **refused** |

  In both modes `processing`/paid objects are never remediated by this tool —
  they are escalations;
- **runs only under route containment, every time — including periodic
  post-launch runs**: `STRIPE_SALES_OPEN=false` (verified by the operator
  before the batch, stated in the confirmation) for the whole
  export → confirm → mutate window. The fresh ownership export closes the
  gap between exports; containment closes the gap between the fresh export
  and the mutation itself, which is otherwise exactly where live traffic
  writes the row that makes a cancellation wrong. Periodic operation
  therefore happens in a maintenance window, not silently alongside open
  sales.

The key comes from the environment, **never a CLI argument** (argv leaks into
shell history and process lists); a restricted key is used where available.

Tests: multi-page pagination (the orphan on page 2 is found); direct and
hosted objects both attributed; Session-owned graph accounts for its unsaved
PI; metadata disagreement → reported, no mutation; account/mode mismatch
refuses before any listing; **conflict-export classification is by state,
never by presence** — id in the payment provider-id list → owned; id only in
the conflict export with `pending` → unresolved cleanup, still counts against
the gate; with `done` → verify the Stripe object is terminal, flag if not;
with `none` → classify from Stripe state, not assumed safe; conflict id
**plus** payment owner → validate the two agree, flag disagreement;
`legacy-detect` finds a payable object with legacy metadata and no namespace
(the namespace-only sweep must miss it — asserted both ways); remediation
with a stale first export and a fresh second export showing a new owner →
mutation refused for that id; re-fetch state drift → mutation refused;
exit semantics per mode — `legacy-detect` nonzero while backlog remains and
zero once the three historical zeros hold, `detect` nonzero on any
payable/processing/paid orphan; `remediate` accepts batch on a `legacy-detect`
report and **refuses batch on a `detect` report**; ownership revalidation per
mode — legacy owned payable with the **same** owner in the fresh export →
cancelled then reconciled; legacy owned payable whose owner changed → refused;
legacy unowned payable still unowned → cancelled; recurring orphan that gained
an owner → refused; report contains no secret-shaped strings.

Runs before reopening sales (step 17) and periodically thereafter; it is the
only audit that cannot be a SQL query by construction.

**G. Catalog assertions** — constraints, unique indexes, and function
privileges all present, i.e. the M-suite's checks executed once against the
real target:

```sql
select conname from pg_constraint
 where conrelid = 'public.payments'::regclass and conname like 'payments_%chk';
select indexname from pg_indexes
 where tablename = 'payments' and indexname like '%_uniq';
select has_function_privilege('anon',
  'public.finalize_stripe_payment_attempt(uuid,uuid,text,integer,text,text,numeric,bigint,text,uuid)',
  'execute');  -- must be false
```

---

## Deployment order

Production Stripe keys are already removed; **sales stay closed throughout**.
The old E2 preserve-and-backfill step is gone: historical payables are made
terminal *before* the migration, so no migration-window race carrier survives.

1. **Plan A live in production** — done
2. Branch from `dev`
3. **Mechanical gate on the artifact**: the actual migration file — not plan
   text — applies to the local database inside a rolled-back transaction,
   followed by the 0b-G catalog assertions, via the reviewed utility in the
   Files table. (Why it exists: v8 shipped a finalizer whose INSERT could not
   parse; prose review missed it, execution caught it.)
4. Apply the migration locally; full suite; red/green recorded
5. **Contain dev + staging** — both deployed apps read the DEV database, and
   the currently deployed routes insert Stripe rows with no `attempt_seq` /
   `integration_flow`: after the migration those inserts violate the new
   constraints **after Stripe has created the object**. Remove/disable the
   test-mode Stripe keys (or block both creation endpoints) on dev **and**
   staging first.
6. **Dev historical inventory (0b A–E, via `legacy-detect`)**: reconcile
   succeeded/processing test objects, cancel/expire all remaining payable
   test objects, verify the same three historical zeros required of
   production in step 10: zero payable, zero `processing`, zero unreconciled
   paid
7. Apply the migration to **dev**; post-migration checks (0b F–G)
8. PR → `dev`, deploy compatible code to dev **immediately**; verify; promote
   to `staging`; validate; **only then** restore the test-mode keys
9. **Production historical inventory (0b A–E)**: run **`legacy-detect`** —
   the namespace-based `detect` cannot see pre-contract objects; reconcile
   every `succeeded`/paid object individually (payment, enrollment, tickets,
   refund decision); wait out or stop on `processing`; then cancel/expire
   **all** remaining payable objects (authorized `remediate` on the reviewed
   report, with its fresh second ownership export)
10. **Verify the historical slate is clean** — re-run **`legacy-detect`**,
    exit code zero required, meaning all three simultaneously:
    - zero **payable** historical objects,
    - zero **`processing`** historical objects (each resolved to a terminal
      state and handled per that state — never cancelled mid-flight),
    - zero **unreconciled paid** historical objects (each has its recorded
      payment/enrollment/ticket/refund decision from step 9)
11. **You** apply the migration to production
12. Post-migration checks (0b F–G) against production
13. Deploy production code
14. **Enforce route containment BEFORE keys return.** Restoring
    `STRIPE_SECRET_KEY` reopens object creation in fact — `payment_mode` and
    intake closure do not close the endpoints (Phase 0 verified this), and an
    unpublished payment page is obscurity, not a control. The control is a
    server-side launch gate checked in **both** creation routes before any
    Stripe call: gate closed → **503** for everyone, except enrollment refs
    explicitly named in `STRIPE_SMOKE_REFS`. Parsing is pinned, not left to
    an implementer's judgement:

    - `STRIPE_SALES_OPEN`: open **iff** the raw value is exactly the
      lowercase string `true` — **no trimming, no normalisation**. Absent,
      empty, `TRUE`, `1`, `yes`, `open`, ` true `, `true<LF>` — all
      **closed**.
      Raw equality means a value malformed by a bad set procedure fails
      closed instead of being rescued into an open gate.
    - `STRIPE_SMOKE_REFS`: comma-split, each entry trimmed of ASCII
      whitespace; a request's enrollment ref passes **iff** it equals an
      entry exactly — case-sensitive, full-string, no prefix/substring/glob
      matching. Empty entries ignored; unset or empty variable = no smoke
      path at all.

    **Operator procedure for setting both values** (this machine is Windows;
    `echo`-style pipes append a newline that survives into the value and the
    trim rule must not be the thing rescuing a malformed secret): set them in
    the **Vercel dashboard** (paste the value, visually confirm no trailing
    whitespace), or from **Git Bash only**:
    `printf '%s' 'true' | vercel env add STRIPE_SALES_OPEN production`.
    Never via PowerShell `echo`/pipes.

    Deploy the gate, verify both routes 503, **then**:
15. Subscribe the live endpoint — `https://www.kuunyi.com/api/webhooks/stripe`,
    the apex 307s and Stripe does not follow redirects — to
    `payment_intent.succeeded`, `checkout.session.async_payment_succeeded`,
    `checkout.session.async_payment_failed`; restore `STRIPE_SECRET_KEY` /
    `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`; redeploy; verify webhook deliveries;
    verify non-smoke creation still 503s
16. **One real card and one real PayNow payment through the smoke refs,
    browser closed after paying**: confirm settlement, enrollment
    confirmation, and ticket creation from the webhook path alone; replay a
    delivered event; confirm 2xx
17. **Run the state-aware audit H** (`detect`), then — only when **all four
    are zero** —
    - `pending` cleanup conflicts
    - unowned **payable** objects
    - unowned **processing** objects
    - unowned **paid** objects

    flip `STRIPE_SALES_OPEN=true` and redeploy. **That flip is the reopening
    action** — a deliberate, single, auditable change; nothing earlier in
    this sequence opened sales as a side effect.

    Route-gate tests ship with the code and pin the parsing table above:
    closed → both routes 503 before any Stripe/mock call; smoke ref passes
    while others 503; flag absent → closed; `TRUE`, `1`, ` true `,
    `true<LF>` (the `echo` failure mode), empty string → all closed under raw
    equality; exactly `true` → open; smoke-ref matching rejects prefixes,
    substrings, and case variants of a listed ref.

**Sales stay closed throughout.**

---

## Out of scope

Durable notification outbox and reconciliation job (#186) · operator UI for
conflicts · historical ticket backfill · seat-capacity reconciliation · an
audited "cancel a confirmed enrollment" operation (needed, tracked by Plan A) ·
widening `STRIPE_LAUNCH_CURRENCIES`
