# Payment settlement and ticket fulfillment — plan v2

**Status:** PARKED — the larger redesign. Superseded in sequence by the
standalone oversell-guard fix (see `2026-07-21-oversell-trigger-guard.md`),
which the user chose to ship first. This document remains the reference for the
settlement/fulfillment program that follows it.

**Decisions locked (2026-07-21):**
- Oversell guard ships first as its own migration; this redesign follows.
- Notifications: **accept the gap** for this work, track a durable outbox as a
  separate issue (Open Question 3 → resolved to B).
- Eligibility predicate: `tenant.org_type === 'event'` (Open Question 2 → resolved).

**Supersedes:** v1 (naive "call issueTickets from more places" — unsafe).
**Reported as:** Stripe e-tickets have no QR. Investigation found a settlement
architecture gap, and review found a live oversell bug alongside it.

---

## What v1 got wrong

v1 proposed adding `issueTicketsForEnrollment()` to the client confirm paths.
Review showed that is unsafe, and verification confirmed every objection:

1. **The PaymentIntent flow has no durable settlement.** The Stripe webhook
   handles only `checkout.session.completed` (`webhooks/stripe/route.ts:39`),
   not `payment_intent.succeeded`. If a PayNow buyer pays and closes the tab, no
   poll runs and the payment is never recorded at all. Browser polling must
   *accelerate* settlement, not *own* it.

2. **A live oversell bug via the payment trigger — verified.**
   `049_fix_seat_restore_and_payment_trigger.sql:111` confirms the enrollment
   whenever a payment becomes `verified`, with **no guard on enrollment state**:

   ```sql
   IF OLD.status != 'verified' AND NEW.status = 'verified' THEN
     UPDATE enrollments SET status = 'confirmed' WHERE id = NEW.enrollment_id;
   END IF;
   ```

   So: enrollment expires → `rejected`, seats restored and possibly resold →
   late Stripe payment verifies → trigger silently re-confirms the rejected
   enrollment → tickets issued against capacity that is gone. This exists
   **today**, independent of the QR bug, and is the most serious finding.

3. **`issueTicketsForEnrollment()` is not reliably retryable.** It returns early
   if *any* ticket exists (`issueTickets.ts:29`), so a partial set is never
   completed, and it discards errors on the enrollment, items and classes
   queries — a database failure is indistinguishable from successful
   fulfillment. It cannot be the shared primitive as written.

4. **`verifyPayment()` is a sixth confirm writer** (`verifyPayment.ts:89`) —
   manual admin verification, which also confirms and issues tickets. v1's
   inventory missed it.

5. The `transitioned` boolean cannot gate one-time notifications: two callers
   can both read `awaiting_payment` and both believe they won.

The conclusion: this is not an app-only change. It needs a transactional
settlement primitive (a migration) and a hardened fulfillment primitive, with
every writer routed through both.

---

## Architecture: separate settlement from fulfillment

Two primitives, each with one job.

### 1. Settlement — transactional, one winner, state-guarded (migration)

A `SECURITY DEFINER` RPC `settle_payment(p_payment_id, p_verified_fields jsonb)`
that, in one transaction:

- `SELECT … FOR UPDATE` on the payment row, and the enrollment row
- confirms the two are related
- **guards enrollment state**: only an enrollment in a settle-eligible state
  (`pending_payment`, `payment_submitted`, `partial_payment`) may become
  `confirmed`. A `rejected` / `cancelled` / `expired` enrollment must **not** be
  re-confirmed.
- if the payment is already `verified` → return `won = false` (someone settled it)
- else set payment `verified` (+ allowlisted fields), enrollment `confirmed`,
  return `won = true`
- **late payment against an ineligible enrollment**: do not confirm. Record the
  conflict durably (a `payment_settlement_conflicts` row, or a status the ops
  process reads) for reconciliation/refund. Return a distinct outcome
  (`conflict`) so callers can respond correctly.

**This also requires fixing the trigger.** The `049` trigger's unguarded
re-confirm is the oversell vector. Options, to decide in review:

- **A (preferred):** narrow the trigger's confirm to the same eligible states,
  so trigger and RPC agree. Keeps the trigger as a safety net.
- **B:** remove the enrollment write from the trigger entirely and make the RPC
  the sole owner of the `→ confirmed` transition. Cleaner ownership, but the
  trigger currently also drives `payment_submitted` and `rejected`, so removing
  only the confirm branch is the smaller change.

Either way the fix ships in the same migration as `settle_payment`, because they
are the same invariant.

The RPC runs as `service_role` only (the #174 lesson — no `PUBLIC`/`anon`
EXECUTE), verified after apply.

### 2. Fulfillment — retryable, self-healing (application)

Rewrite `issueTicketsForEnrollment()` into a primitive that is safe to call
after *any* trusted paid signal, including an already-verified payment:

- **derive the full expected ticket set** (one row per seat per line), then
  upsert all of it — do not early-return on "a ticket exists", so a partial set
  is repaired
- **throw on every query error** (enrollment, items, classes) — a DB failure
  must not read as fulfilled. This is the error-discarding pattern flagged four
  times earlier this session
- **distinguish "not a ticketed enrollment" from "could not load"** — see Open
  Question 2 on the eligibility predicate
- remains duplicate-safe via the unique index

### 3. Caller posture — who does what on failure

| Caller | On fulfillment failure |
|---|---|
| Stripe/abank/paypay/hitpay webhook | return **non-2xx** so the provider retries |
| browser status/verify route | report **paid, fulfillment pending** — never tell a customer their payment failed after money moved |
| `verifyPayment()` (admin) | surface the failure to the operator |

Every one of these calls `settle_payment` then the fulfillment primitive.
`stripe/paynow-confirm` is unchanged (it only calls Stripe's confirm API, does
not touch enrollment state — verified).

### 4. Webhook coverage — provider-independent durability

Add `payment_intent.succeeded` to the Stripe webhook, settling and fulfilling
without any browser. Keep `checkout.session.completed`. Consider
`checkout.session.async_payment_succeeded` only if async Checkout methods are
enabled (confirm before adding).

---

## Notifications — decide the ownership model (blocking)

The webhooks send approval email / Telegram / SMS / channel invite; the client
paths deliberately do not. These are **not idempotent**, and the
`won` boolean cannot make them exactly-once (two callers can both think they
won; and when the client wins, the webhook returns early and they never fire —
so today a client-settled Stripe payment gets **no** confirmation email either).

Three honest options, for the user to choose:

- **A — outbox (correct, larger):** settlement records a
  `notification_pending` intent in the same transaction; a single dispatcher
  claims it atomically (`UPDATE … WHERE claimed_at IS NULL RETURNING`) and
  sends. Exactly-once regardless of who settles.
- **B — accept the gap:** notifications stay webhook-only, the plan states
  plainly that a client-settled payment may not notify, and K7 drops its
  notification assertion. Tracked as its own issue.
- **C — narrow now:** move notification dispatch behind an atomic
  `notified_at` claim on the enrollment/payment, without a full outbox table.

**Recommendation: B for this plan, A as a fast follow.** The reported bug is the
missing QR; bundling a notification-delivery redesign risks another long cycle.
But this must be a stated decision, not a silent omission.

---

## Phasing

Each phase is independently shippable and reviewable. The oversell fix does not
wait on the QR fix.

- **Phase 1 — settlement RPC + trigger guard (migration).** Fixes the live
  oversell bug. Ship first; it is the only safety-critical piece and is
  independent of tickets.
- **Phase 2 — harden fulfillment.** Rewrite `issueTicketsForEnrollment`
  self-healing and throw-on-error. No behaviour change for the happy path;
  pure robustness.
- **Phase 3 — route all writers through settle + fulfill**, and add
  `payment_intent.succeeded`. This is where the QR returns.
- **Phase 4 — notification decision** (A/B/C above).
- **Phase 5 — backfill**, eligibility- and partial-set-aware.

---

## Tests (database-backed suite; local stack)

Settlement and fulfillment both touch real rows, triggers and the signing key.

**Settlement (Phase 1):**
- two concurrent `settle_payment` calls → exactly one `won = true`
- late payment against a `rejected` enrollment → not confirmed, conflict
  recorded, no tickets
- the trigger no longer re-confirms a `rejected` enrollment on verify
- seats not resurrected for an already-restored expired enrollment

**Fulfillment (Phase 2):**
- partial ticket set (one seat pre-existing) → completed to the full set
- enrollment / items / classes query error → **throws**, not silent success
- already-verified but ticketless payment → tickets issued (K3: the reported bug)
- cart enrollment → one ticket per item-seat

**Integration (Phase 3):**
- `stripe/intent/status` on a succeeded PI → tickets exist, `/enrollment/[ref]`
  returns non-empty `tickets`
- `stripe/verify` on a paid session → same
- `payment_intent.succeeded` webhook with no browser poll → settled + fulfilled
- client settles, then webhook runs → tickets exact, one per seat
- webhook fulfillment failure → non-2xx, succeeds on retry
- `verifyPayment()` routes through the same contract

Red-first for the bug-exposing cases (K3, the two client-path cases, the
`payment_intent` case, the oversell case), each failing for its named reason,
counts stated and verified by identity.

---

## Backfill (Phase 5) — blocked on the eligibility rule

Do **not** backfill on "confirmed + verified + zero tickets" alone: language
enrollments may be legitimately ticketless (Open Question 2). Must also catch
**partial** sets, not only zero. Scope read-only per environment, then call the
hardened fulfillment primitive (never raw SQL — tickets carry `kid` and `exp`).
Production has no Stripe rows, so its backfill is abank/paypay if anything.

---

## Open questions

1. **Trigger fix A or B** — narrow the trigger's confirm to eligible states, or
   remove its enrollment write and make the RPC sole owner? Recommend A (smaller,
   keeps the safety net).
2. **The eligibility predicate — RESOLVED.** QR tickets are for
   `tenant.org_type === 'event'`. Verified against dev: event tenants show the
   bug (abank 27/27, stripe 19/19, hitpay 12/21 ticketless), while
   language-school confirmed enrollments are correctly ticketless (abank 13/13,
   null 3/3 — not a bug). So fulfillment gates on `org_type = 'event'`
   (an event enrollment with a load failure = error; a language-school
   enrollment with no tickets = fine), and the backfill scopes to event tenants
   only. This also shows the bug is **not Stripe-specific**: it hits every
   provider's event enrollments via the same settlement race.
3. **Notification model** A/B/C. Recommend B now, A as a fast follow.
4. **Should client confirm paths exist at all?** The HitPay model (webhook-only
   settlement, read-only client polling) has none of these bugs. Larger change;
   named, not proposed.
