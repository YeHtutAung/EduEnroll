# Ticket fulfilment — plan v9 (Phase A minimal)

**Status:** APPROVED for implementation.
**Supersedes:** v8 (duplicate cart lines defeated the invariant; F-matrix
baselines wrong), v7 (missed the PaymentIntent creation route — the live flow),
v6-minimal (webhook failure behaviour contradicted its own scope), v5 and earlier (grew into response contracts, client polling and
reconciliation — larger than the bug; that work stays in **#186**).
**Depends on:** #187 (merged). **Tracked in:** #186 item 4.

---

## What this fixes, precisely

**Deterministic missing issuance when an existing success path — or a verified
webhook replay — executes successfully.**

That is the whole claim. It does **not** fix:

- a customer closing the direct PaymentIntent flow before browser confirmation
- transient fulfilment failures anywhere — they are **logged and acknowledged**,
  not retried
- missing local payment reconciliation and attribution
- durable webhook retry for ticket errors
- notification loss or duplication
- existing ticketless enrollments — those need the backfill

All of that stays in #186, with its reasoning already recorded there.

**Response-shape promise, stated exactly:** no **successful payment or
verification** response shape changes. Creation-failure behaviour *does* change
deliberately — see §3.

## The defect

`issueTicketsForEnrollment` runs only *after* each webhook's replay guard, which
returns early when the payment is already `verified` — **before** issuance
(`webhooks/stripe/route.ts:68` vs 89; HitPay 83-84 vs 101). The Stripe browser
confirm paths settle but never issue at all, and they usually win the race
because the success page calls them on load.

Measured on dev, event tenants: **9 of 67 confirmed enrollments have tickets.**

---

## 1. Harden the shared helper

`src/server/tickets/issueTickets.ts`. Six callers — 5 webhooks and
`verifyPayment`. The helper now throws where it previously returned, so **run
the full existing suite** and add coverage for every caller this plan modifies.
(v7 claimed "six existing suites"; there are not six — HitPay, ABank and
`verifyPayment` have suites, the others do not. Untouched callers do not need
new route suites merely because the shared helper changed.)

- **Eligibility:** load the enrollment's tenant `org_type`; **return
  successfully** for non-event tenants; **throw** on tenant-query failure **and
  on a tenant that does not exist**. Only a real tenant whose `org_type !==
  'event'` is a legitimate no-op — "no answer" and "no tenant" are both
  failures. Without this, reliable fulfilment would
  start issuing admission tickets to language schools — measured **16 confirmed,
  0 with tickets**, ticketless only because the race prevented issuance, with no
  rule enforcing it.
- **Remove the any-ticket fast path** — a 1-of-3 partial set counts as complete
  today.
- **Repair missing rows:** derive the expected set and upsert it.
- **Throw** on the enrollment-items and classes query errors (#187 fixed only
  the enrollment load).
- **Validate each quantity before normalizing:**
  `Number.isInteger(q) && q >= 1`. Validating *before* the sum stops an invalid
  line (quantity `0`) being hidden by aggregation with a valid line for the same
  class.
- **Normalize lines by `class_id`, summing quantities, before assigning seat
  numbers.** Nothing enforces uniqueness on `(enrollment_id, class_id)` —
  verified: the only unique index on `enrollment_items` is its primary key — and
  seat numbering currently restarts at 1 per line. So two lines for class A
  (qty 1, qty 2) generate `A:1, A:1, A:2`; the tickets unique index
  `(enrollment_id, class_id, seat_no)` collapses the duplicate and **2 tickets
  persist for quantity 3**. Summing first gives A qty 3 → seats 1, 2, 3.
  Normalizing (rather than rejecting) matches the seats the cart RPC already
  reserved.
- **Completeness invariants**, because these currently "succeed" while producing
  nothing:

  ```
  loaded class ids                         == referenced class ids
  generated rows                           == sum(expected quantities)
  unique(enrollment_id, class_id, seat_no) == sum(expected quantities)
  ```

  The third is not redundant: without it the duplicate-line case above passes
  the row count while persisting fewer tickets than paid for.

- **Preserve void/scanned tickets.** The unique index is
  `(enrollment_id, class_id, seat_no)` — no status — so `ignoreDuplicates: true`
  skips an existing `void` row. This repairs **missing rows only**; it does not
  resurrect voided or scanned tickets.

## 2. Fulfil on existing successful paths

No new settlement logic. No new success-response fields. No client changes.

**Every fulfilment call is wrapped.** The scope says durable retry is not in
this change; an uncaught helper call would contradict that by turning a webhook
replay from 2xx into 5xx, introducing partial retry by accident. Exact flows:

```
# webhook, verified replay
try fulfilment; catch and log safely
return the existing 2xx response
never notify

# webhook, new transition
perform existing settlement
try fulfilment; catch and log safely
run existing notifications          (placement unchanged)
return the existing response
```

Signed-webhook verification is unchanged in both.

**The two Stripe browser routes** (`intent/status`, `verify`):

- fulfil **only after Stripe reports the payment successful**
- catch and log fulfilment failure
- **preserve each route's exact existing response shape**

The catch is not optional: the hardened helper throws where it used to return
silently, so without it a browser route would 500 where it previously succeeded.

The two shapes differ and must not be unified — verified: `intent/status`
returns a **Stripe payment** status (`succeeded` / `pending` / `cancelled`);
`stripe/verify` returns an **enrollment** status
(`{ status: enrollment.status }`, line 60), and its consumer at
`enroll/payment/[ref]/page.tsx:1032` maps that to labels keyed by enrollment
status. Returning `"succeeded"` there would render no label at all.

## 3. Check the payment-row insert — THREE creation routes

All three run `await supabase.from("payments").insert({...})` with **no error
check** and hand out payable credentials regardless:

| Route | Line | Returns despite a failed insert |
|---|---|---|
| `payments/stripe/route.ts` (Checkout) | 207 | checkout URL |
| `payments/hitpay/route.ts` | 218 | QR / URL |
| **`payments/stripe/intent/route.ts`** (PaymentIntent) | **102** | **`clientSecret` + `paymentIntentId`** |

A silent insert failure lets a customer pay against a session with no local
record — worse than the reported bug.

**The PaymentIntent route is the most severe**, and v7 missed it entirely while
it is the *live Trusted Official flow this bug was reported against*:
`payment_intent.succeeded` is deferred, and `intent/status` resolves payments by
`stripe_payment_intent_id` — so with no row, **neither the browser nor any
handled webhook can find the payment**. It is a total loss, not a missing QR.

**Never return a payment URL or QR after the local insert fails.** Return a
**local 500**, not the routes' provider `502 Payment Gateway Error` — the
provider succeeded; our database did not, and mislabelling that would send
someone debugging the wrong system:

```json
{
  "error": "Internal Server Error",
  "message": "Payment could not be recorded. No payment link was issued."
}
```

No Supabase errors, provider bodies, enrollment references or PII in the body.
HitPay's route currently returns `detail: errMsg`; a database error must not
reach it.

- **Stripe Checkout:** best-effort `checkout.sessions.expire(session.id)`; if
  cleanup fails, log a bounded session identifier only and return the same safe
  500 regardless.
- **Stripe PaymentIntent:** best-effort `paymentIntents.cancel(pi.id)`; never
  return `clientSecret` or `paymentIntentId`; same safe 500; on cleanup failure
  log a bounded PI identifier only.
- **HitPay:** cleanup deferred — the wrapper exposes create/verify/parse only,
  with no cancellation operation.

**Cleanup errors stay subordinate:** preserve the original safe local 500, never
replace it with the cleanup error; log a bounded `cs_…` / `pi_…` identifier only
— never client secrets, webhook secrets, database errors or provider bodies.

Missing-payment webhook reconciliation and attribution stay in **#186**.

---

## Tests — five suites, each with a reason

Notification transports (email, SMS, Telegram, Messenger) **mocked in every
route test**; no provider network calls; test-only webhook secrets; sequential
with FK-safe cleanup.

**A. Database suite — real issuance and state invariants**

| # | Case | Red today |
|---|---|---|
| H1 | confirmed **event** enrollment → tickets issued | pass (guard) |
| H2 | confirmed **language-school** enrollment → **no** tickets | **FAIL** — no guard exists |
| H3 | partial set (1 of 3) → repaired to 3 | **FAIL** |
| H4 | cart enrollment with **zero** items → throws | **FAIL** |
| H5 | existing **void** ticket → left untouched | pass (guard) |
| H6 | **rejected** enrollment → never a ticket | pass (**#187 guard**) |
| H7 | cart with **two lines for the same class** (qty 1 + qty 2) → tickets numbered 1..3, three rows persist | **FAIL** — seat numbers collide, 2 persist |

H2 is a **red**: called directly, the helper today issues for a language school.

**B. Unit suite, mocked client — failures a real database cannot construct**

Valid foreign keys and a service-role client cannot produce these; attempting
them against a real database would mean unsafe schema manipulation.

| # | Case | Red today |
|---|---|---|
| U1 | tenant query returns an **error** → rejects | **FAIL** |
| U2 | enrollment-items query returns an **error** → rejects | **FAIL** |
| U3 | classes query returns an **error** → rejects | **FAIL** |
| U4 | classes query succeeds with **incomplete** rows → rejects | **FAIL** |
| U5 | line with **quantity 0** → rejects, rather than manufacturing an admission | **FAIL** |

U5 tests the `generated rows == sum(expected quantities)` invariant directly.
Today `Math.max(1, quantity ?? 1)` turns a zero quantity into **one ticket** — a
silently manufactured admission. The hardened helper must reject the anomaly
instead.

U1–U3 exist because this codebase has repeatedly destructured `data` and dropped
`error`; "it succeeded" and "it never answered" must not look alike.

**C. Route integration — real helper, real database**

| # | Case | Red today |
|---|---|---|
| R1 | **Stripe verified replay** → signed webhook → real ticket rows | **FAIL** |
| R2 | **HitPay verified replay** → signed webhook → real ticket rows | **FAIL** |
| R3 | `intent/status` on success → real rows **and unchanged Stripe-status shape** | **FAIL** |
| R4 | `stripe/verify` on success → real rows **and unchanged enrollment-status shape** | **FAIL** |

R1/R2 isolate the replay branch: confirmed event enrollment, **zero** tickets,
payment already `verified`, so no other path can have repaired it.

**D. Route failure — helper mocked to throw**

| # | Case | Red today |
|---|---|---|
| F1a | Stripe **verified replay** → helper **invoked once** with the enrollment id; it throws → existing 2xx preserved, logged, **no notification** | **RED** |
| F1b | Stripe **new transition**, fulfilment throws → notification path still runs, response preserved | **guard** |
| F2a | HitPay **verified replay** → helper **invoked once**; it throws → existing response preserved, logged, **no `dispatchPaymentApproved`** | **RED** |
| F2b | HitPay **new transition**, fulfilment throws → notification path still runs, response preserved | **guard** |
| F3 | `intent/status`, Stripe reports success → helper **invoked once** with the enrollment id; it throws → existing Stripe-status shape, no 500, logged | **RED** |
| F4 | `stripe/verify`, session paid → helper **invoked once**; it throws → existing enrollment-status shape, no 500, logged | **RED** |
| F5a | Checkout webhook, `payment_status !== "paid"` → helper **not** called | **guard** |
| F5b | `intent/status`, PI `pending` / `cancelled` → helper **not** called | **guard** |
| F5c | `stripe/verify`, session not paid → helper **not** called | **guard** |

**F1b/F2b are guards, not reds.** The transition paths already wrap issuance in
try/catch, continue to notifications and return their existing response — so
they pass today. v8 marked them FAIL, which would have rejected a correct
baseline or invited a test that fails for an unrelated reason. Their job is to
prove §2 did not move notifications.

**The invocation assertion is what stops F3/F4 being hollow.** Neither browser
route calls the helper today, so "mock throws → response unchanged, no 500"
passes right now with the mock never invoked — proving nothing. Asserting
*invoked exactly once with the expected enrollment id* is what makes them
genuinely red. The same assertion belongs in F1a/F2a.

F5 is split across all three non-success paths because one generic case would
cover only one route.

**E. Creation routes — provider succeeds, insert fails**

| # | Case | Red today |
|---|---|---|
| C1 | Stripe **Checkout** → **no** checkout URL; local **500**; expire attempted | **FAIL** |
| C2 | Stripe Checkout, expire also fails → same safe 500, bounded id logged | **FAIL** |
| C3 | HitPay → **no** QR/URL; local **500**; **no** `detail` leaked | **FAIL** |
| C4 | **PaymentIntent** → **no** `clientSecret`/`paymentIntentId`; local **500**; cancel attempted | **FAIL** |
| C5 | **PaymentIntent**, cancel also fails → same safe 500, bounded PI id logged | **FAIL** |
| C6 | **PaymentIntent** insert succeeds → existing success response unchanged; cancel **not** called | **guard** |
| C7 | Checkout insert succeeds → existing checkout-URL response unchanged; expire **not** called | **guard** |
| C8 | HitPay PayNow insert succeeds → existing QR response unchanged | **guard** |
| C9 | HitPay card insert succeeds → existing card-URL response unchanged | **guard** |

C4-C6 are the route v7 missed — the live Trusted Official flow, where a missing
row means neither the browser nor any handled webhook can find the payment.

**Regression:** the full existing suite stays green; add coverage for each
caller this plan modifies.

Red-first, each failing for its named reason; counts observed, not predicted.

## Rollout

Feature branch → PR → review → merge → staging → main. **No migration.**
Verify on staging with a real Stripe sandbox purchase on an event tenant.

## Backfill

Forward-only. Existing ticketless confirmed **event** enrollments stay so until
backfilled with the hardened helper (repairs missing rows; scoped by its own
`org_type` guard). Separate reviewed step.
