# KBZPay MMQR Integration — Design

**Date:** 2026-08-20
**Status:** Revision 7 — **approved** from a design-review perspective, subject to the
external gates in §11 and the tests in §10 passing. Review findings R1–R13 all addressed,
no open blockers (see §13).

---

## 1. Context

EduEnroll already supports MMQR payments through two providers, selected per tenant via
`tenants.mmqr_provider` (`abank` | `mmpay`). This design adds **KBZPay** as a third
provider.

KBZPay's MMQR product is materially different from ABank's A+ wallet QR: `precreate`
returns a **national MMQR / EMVCo-format string**, so the QR can be scanned by *any*
Myanmar bank app (off-us, routed via DPS), not only by KBZPay users. That reach is the
reason to add it.

Source: KBZPay Payment Gateway UAT docs, `https://wap.kbzpay.com/pgw/uat/api/`
(MMQR Payment section), read 2026-08-20.

---

## 2. Decisions taken during brainstorming

| Question | Decision |
|---|---|
| Onboarding status | Credentials **applied for, not yet issued**. Build to the documented contract with mocked tests; wire real credentials on arrival. |
| Provider role | **Third option**; tenants pick `abank` \| `mmpay` \| `kbzpay`. No change to existing tenants. |
| API scope | `precreate` + callback + `queryorder` + **`closeorder`**. **No** refund. `closeorder` was initially excluded and brought back in to resolve R5 — without it a superseded QR stays payable and can over-collect. |
| Credential scope | **Platform-wide env vars**, exactly like `ABANK_*` / `MMPAY_*`. |
| Settlement architecture | **Approach B** — new provider settles through a new shared `settleMmqrPayment()` operation. ABank and MMPay stay on their current path. |

---

## 3. KBZPay API contract

### 3.1 Endpoints

| Operation | Method name | UAT | Production |
|---|---|---|---|
| Create order | `kbz.payment.precreate` | `api-uat.kbzpay.com/payment/gateway/uat/precreate` | `api.kbzpay.com/payment/gateway/precreate` |
| Query order | `kbz.payment.queryorder` | `api-uat.kbzpay.com/payment/gateway/uat/queryorder` | `api.kbzpay.com/payment/gateway/queryorder` |
| Close order | `kbz.payment.closeorder` | `api-uat.kbzpay.com/payment/gateway/uat/closeorder` | `api.kbzpay.com/payment/gateway/closeorder` |

Transport: POST, JSON, UTF-8.

**Scheme differs per endpoint in UAT, and the docs are right about it.** Revision 7 said
"we will always use HTTPS". That was wrong, and it would have failed on the first live
call. Probing all six host/scheme pairs on 2026-09-01 gave:

| Endpoint | `http://` | `https://` |
|---|---|---|
| `precreate` | **200** (gateway) | 404 (bare nginx) |
| `queryorder` | **200** (gateway) | 404 (bare nginx) |
| `closeorder` | 404 | **200** (gateway) |

Port 443 on `api-uat.kbzpay.com` exists but routes `closeorder` alone, so an all-HTTPS
client cannot create an order at all. **Production is uniformly HTTPS** — `api.kbzpay.com`
answered 200 on all three.

`endpointUrl()` therefore resolves the scheme per endpoint, and only for UAT: the
production branch is taken first and unconditionally, so no entry in the UAT table can
downgrade it. The app key never travels — it is the trailing term of a SHA256 preimage, so
only the derived signature is sent — but `appid`, `merch_code`, the order reference and the
amount cross in the clear and without integrity, which also means an on-path attacker could
forge the `queryorder` response this design treats as the settlement authority. Accepted for
UAT against test money; production never asks for it. See §11, gate G2.

Interface `version` differs per call: `precreate` uses `"1.0"`, `queryorder` and `closeorder`
use `"3.0"`.

`closeorder` is **idempotent** — `ORDER_ALREADY_CLOSED` and `QUERYORDER_FAIL` ("the order does
not exist") are not transport-level failures and do not need retrying. A transport failure,
`SYSTEM_ERROR`, `FLOW_CONTROL` or `AOP03028` ("close order failed") do.

**But a non-erroring close is not proof the order went unpaid (R12).** Revision 5 claimed
those two codes "both mean the order is not payable, which is the outcome we want". They mean
it is not payable *now* — they do not say whether it was cancelled or **completed**. A payer
who settles between our status query and our close call produces exactly that ambiguity.
`closeorder`'s return code is therefore never the authority on retirement: the authority is a
fresh `queryorder` afterwards (§5.1 step 7b).

### 3.2 Request envelope

```json
{
  "Request": {
    "timestamp": "1535166225",
    "notify_url": "https://…/api/webhooks/kbzmmqr",
    "method": "kbz.payment.precreate",
    "nonce_str": "5K8264ILTKCH16CQ2502SI8ZNMTM67VS",
    "sign_type": "SHA256",
    "sign": "…",
    "version": "1.0",
    "biz_content": {
      "appid": "…",
      "merch_code": "…",
      "merch_order_id": "KBZ_1a2b3c4d_9f3c7b21d0e4a856",
      "trade_type": "PAY_BY_QRCODE",
      "title": "…",
      "total_amount": "40000",
      "trans_currency": "MMK",
      "timeout_express": "120m"
    }
  }
}
```

Success response carries `Response.qrCode` (the MMQR string to render) and
`Response.prepay_id`.

### 3.3 Signature algorithm — SHA256, **not** HMAC

This is the crux of the integration and gets its own isolated, unit-tested function.

1. Build one flat map from the common params **and** the flattened `biz_content`.
2. Remove `sign` and `sign_type`.
3. Remove entries whose value is empty/null.
4. Remove entries whose value is a JSON array or object (e.g. `refund_info`).
5. Sort keys **ascending by ASCII**, join as `k=v&k=v…` → `stringA`.
6. `stringToSign = stringA + "&key=" + APP_KEY`.
7. `sign = SHA256(stringToSign)` rendered as **uppercase hex**.

Two rules that are easy to get wrong and must be encoded deliberately:

- **ASCII sort, not locale sort.** The callback contains `Wallet_identifier` with a
  capital `W`, which sorts *before* every lowercase key. JavaScript's default
  `Array.prototype.sort()` compares UTF-16 code units and is correct here;
  `localeCompare` is not. The implementation must not use `localeCompare`.
- **Verification must be generic over received keys.** The docs state that the API may
  add fields and that the extended extension field must be supported when verifying the
  signature. So `verifySign()` signs *whatever keys arrived*, never a hardcoded list —
  otherwise a future KBZPay field silently breaks every callback in production.

### 3.4 Callback

KBZPay POSTs to `notify_url`. The notify URL must be publicly reachable and **must not
contain query parameters**.

Fields: `appid`, `notify_time`, `merch_code`, `merch_order_id`, `mm_order_id`,
`total_amount`, `trans_currency`, `trade_status`, `trans_end_time`, `callback_info`,
`nonce_str`, `sign`, `sign_type`, plus the undocumented-but-present `mmqr_ref` and
`Wallet_identifier`.

The merchant must respond with the literal body `success` (case-insensitive, no quotes).
Anything else is treated as non-receipt and KBZPay retries — **twice, at 60s and 600s**,
then stops. Retries mean callbacks must be idempotent.

The docs explicitly instruct merchants to verify the signature *and* re-check that the
notified amount matches the merchant's own order.

### 3.5 Order statuses

`PAY_SUCCESS`, `PAY_FAILED`, `WAIT_PAY`, `PAYING`, `ORDER_EXPIRED`, `ORDER_CLOSED`.

Response-level result handling: check `result` (`SUCCESS`/`FAIL`) first, then `code`
(`0` = success), then business fields.

---

## 4. Architecture

### 4.1 New modules

| File | Responsibility |
|---|---|
| `src/lib/kbzpay.ts` | Pure client: `sign()`, `verifySign()`, `precreate()`, `queryOrder()`, `closeOrder()`, plus `buildMerchOrderId()`. No Supabase, no Next.js imports — unit-testable in isolation. |
| `src/server/payments/settleMmqrPayment.ts` | The settlement operation. Locates a payment by `payment_ref`, performs the conditional status transition, then fulfilment. |
| `src/app/api/public/payments/kbzpay/route.ts` | `POST` — creates the KBZPay order, inserts the payment row, returns the QR string. |
| `src/app/api/public/payments/kbzpay/status/route.ts` | `GET` — browser poller; also self-heals a missed callback. |
| `src/app/api/webhooks/kbzmmqr/route.ts` | `POST` — callback receiver. |

Splitting the client from the settlement operation from the routes means the signature
algorithm can be tested against the published vectors without any HTTP or database
involvement, and the settlement contract can be tested without KBZPay.

### 4.2 Modified files

- `src/app/admin/settings/page.tsx` — add `"kbzpay"` to the `mmqrProvider` union and a
  third option in the provider selector.
- `src/components/payments/QRPaymentModal.tsx` — add `"kbzpay"` to `QRProvider` and to the
  endpoint map; KBZPay branding in the header and instruction copy ("scan with any
  Myanmar banking app"); and handle the `already_paid` response before the `qr`/`url` branch
  (§5.1a, R10). The last of these is the only behavioural change to a shared component —
  ABank, MMPay and PayPay never send `status`, so their path is untouched.
- `src/app/(public)/enroll/[slug]/checkout/payment/page.tsx` — pass the provider through.
- `src/mocks/handlers.ts` — MSW handlers for `precreate` and `queryorder`.

### 4.3 Data model

`tenants.mmqr_provider` is plain `TEXT NOT NULL DEFAULT 'abank'` with no CHECK constraint
(`supabase/migrations/055_payment_mode.sql`), so `'kbzpay'` is already a legal value and
needs no migration of its own.

Schema changes are required, driven by review findings R1, R2, R4 and R6. All of it runs as
**one ordinary transactional migration** — no `CONCURRENTLY` anywhere (R6):

```sql
-- 1. Documentation only: keep the recorded legal values honest.
COMMENT ON COLUMN public.tenants.mmqr_provider IS
  'abank | mmpay | kbzpay — only used when payment_mode = mmqr';

-- 2. R1: make settlement lookup unambiguous. Partial, because manual-upload
--    payments leave payment_ref NULL and Postgres permits many NULLs anyway —
--    the predicate states the intent rather than relying on that.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_payment_ref_unique
  ON public.payments (payment_ref)
  WHERE payment_ref IS NOT NULL;
DROP INDEX IF EXISTS idx_payments_payment_ref;

-- 3. R1: store the issued QR so a repeat request can re-serve the SAME order
--    instead of creating a second payable one.
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS provider_qr text,
-- 4. R4: an explicit, stored expiry so "is this order still live?" is a column
--    comparison and not a guess from created_at.
  ADD COLUMN IF NOT EXISTS provider_order_expires_at timestamptz;

COMMENT ON COLUMN public.payments.provider_qr IS
  'MMQR/EMVCo payload returned by the provider, re-served on repeat requests';
COMMENT ON COLUMN public.payments.provider_order_expires_at IS
  'Local estimate of provider order expiry. A HINT that triggers a queryorder '
  'check — never authority to free the slot on its own (R8)';

-- 5. R4: at most ONE live KBZPay order per enrollment, enforced by the database
--    rather than by an application-level read. 'PENDING' is the liveness marker:
--    the EXPIRED / SUPERSEDED / FAILED transitions all free the slot.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_live_kbzpay_order
  ON public.payments (enrollment_id)
  WHERE payment_method = 'kbzpay_mmqr'
    AND status = 'awaiting_payment'
    AND mmqr_status = 'PENDING';

-- 6. R4 + R7: the two transactional entry points. Both take FOR UPDATE on the
--    enrollment. Full bodies belong in the implementation plan; their contracts
--    are specified in section 5.1.
--
--    claim_kbzpay_order_slot(enrollment_id, tenant_id, payment_ref, amount,
--                            expires_at)
--      -> 'reuse' | 'unresolved' | 'created'
--      Only 'created' writes. 'reuse' is a narrow allowlist: same amount AND
--      non-null provider_qr AND inside the expiry hint. EVERY other live row is
--      'unresolved' and inserts nothing — the old provider order must be proven
--      dead by queryorder first (R8, R13).
--
--    complete_kbzpay_supersede(enrollment_id, expected_old_ref, reason,
--                              new_ref, amount, expires_at)
--      -> 'replaced' | 'already_settled'
--      Verifies expected_old_ref is STILL the live PENDING order, transitions it
--      to EXPIRED or SUPERSEDED, and inserts the replacement — atomically. If a
--      callback settled it first, inserts nothing and reports already_settled.
```

**R6 — why not `CONCURRENTLY`.** Postgres forbids `CREATE INDEX CONCURRENTLY` inside a
transaction block, and no migration in this repo uses it, so it would be off-pattern as well
as unrunnable through the normal `supabase db push` path. Built non-concurrently, the index
takes a `SHARE` lock that blocks writes to `payments` for the duration. On a table of this
size that is milliseconds, and enrollment writes retry; the trade is deliberate and preferred
over introducing a bespoke out-of-band migration step. **Rollback** is
`DROP INDEX idx_payments_payment_ref_unique;` plus recreating the original non-unique
`idx_payments_payment_ref` — both non-destructive, no data is altered.

> **The unique index on `payment_ref` is a cross-provider change.** That column is shared with
> ABank, MMPay and PayPay rows. The migration will fail if duplicates already exist, so a
> read-only duplicate check must pass on **both** dev and production first — see §11, G6.
> This is the one place this design touches data written by the existing providers.
> `idx_payments_one_live_kbzpay_order` is scoped by `payment_method = 'kbzpay_mmqr'` and
> therefore cannot affect any existing provider's rows.

Everything else KBZPay returns fits existing `payments` columns:

| Column | KBZPay field |
|---|---|
| `payment_ref` | `merch_order_id` |
| `payment_method` | literal `'kbzpay_mmqr'` |
| `mmqr_status` | order lifecycle — see below |
| `bank_reference` | `mm_order_id` |
| `payer_institution` | `Wallet_identifier` (the payer's bank) |
| `amount` | the authoritative amount snapshot, written at order-create time |
| `paid_at` | derived from `pay_success_time` / settlement time |

**`mmqr_status` lifecycle (R4).** This column, not `payments.status`, carries the KBZPay
order's own state — `payments.status` cannot express failure without the `'rejected'`
cascade described in §5.1. `PENDING` is what the live-order index keys on, so every terminal
value frees the slot:

| Value | Meaning | Slot |
|---|---|---|
| `PENDING` | Order is live and payable | **held** |
| `SUCCESS` | Settled | freed |
| `FAILED` | **Provider confirmed** no order exists under this reference | freed |
| `EXPIRED` | **Provider confirmed** terminal — `ORDER_EXPIRED`, `ORDER_CLOSED` or `PAY_FAILED` | freed |
| `SUPERSEDED` | Retired via a successful `closeorder` | freed |

**The governing invariant — no terminal transition is ever applied from local state
(R8, R12, R13).** Every one of `SUCCESS`, `FAILED`, `EXPIRED` and `SUPERSEDED` requires a
`queryorder` answer from KBZPay. Not a local clock (`provider_order_expires_at` only decides
*when to go and ask*), not a `closeorder` return code, and not a failed outbound request. Four
separate findings arrived at this rule from four directions:

| Local signal | Wrongly treated as | Actually means |
|---|---|---|
| Local expiry passed (R8) | Order is dead | Time to go and ask |
| Cached QR exists (R9) | Safe to re-serve | Nothing about provider state |
| `closeorder` returned OK (R12) | Order went unpaid | Not payable *now* — cancelled *or* completed |
| `precreate` call failed (R13) | No order was created | Our request failed; KBZPay may still hold the order |

A row stays `PENDING` — holding its slot — until KBZPay says otherwise.

**Order-id constraint.** KBZPay requires `merch_order_id` to be **letters, digits and
underscores only** (max 40). The existing ABank format `AB-{short}-{ts}` uses hyphens and
would be rejected.

A timestamp suffix is also not collision-safe (R1): two concurrent requests for the same
enrollment in the same millisecond produce the same reference, and since the webhooks and
status routes locate payments by `payment_ref` with `.single()`, a duplicate does not merely
create a stray row — it breaks settlement for both. The suffix is therefore **cryptographic
randomness, not a timestamp**:

```
KBZ_{first 8 hex of enrollment id}_{16 hex chars from crypto.randomBytes(8)}
```

29 characters, 64 bits of entropy, matches `/^[A-Za-z0-9_]{1,40}$/`. The enrollment prefix
is retained purely so a reference is recognisable during support and log triage.

---

## 5. Flows

### 5.1 QR creation — `POST /api/public/payments/kbzpay`

1. `resolveTenantId()`; parse and validate `enrollmentRef`.
2. Look up the enrollment scoped to the tenant; 404 if absent.
3. Guard: status must be `pending_payment` or `partial_payment`, else 409.
4. Compute the fee (cart items or class × quantity), minus any `received_amount` on a
   partial payment. Identical logic to the ABank route.
5. **Claim the order slot atomically (R4).** A single SQL function,
   `claim_kbzpay_order_slot(enrollment_id, tenant_id, payment_ref, amount, expires_at)`,
   does all of the following in **one transaction** — following the precedent set by
   `record_stripe_conflict` / `complete_stripe_cleanup` in
   `supabase/migrations/20260722190000_stripe_conflict_recording.sql`:

   a. `SELECT … FOR UPDATE` on the enrollment row, which serialises concurrent creators.
   b. If a live row exists whose `amount` equals the fee just computed, whose `provider_qr`
      is **non-null**, and which is **inside** `provider_order_expires_at` → return `reuse`.
   c. If a live row exists and **any** of those conditions fails → return **`unresolved`**
      with its `payment_ref`. Insert nothing.
   d. Otherwise insert the new row and return `created`.

   `idx_payments_one_live_kbzpay_order` is the backstop: if two callers somehow reach the
   insert, the second gets a unique violation and retries the claim rather than creating a
   second payable order. The read-then-insert in revision 2 had no such guarantee.

   **Why `unresolved` is one outcome and not three.** Revisions 4–6 split this into `stale`,
   `supersede_required` and an unhandled fourth case, and every split produced a defect: reuse
   was tested before staleness so an expired QR was re-served (R9), and a live row with a
   matching amount but a **null `provider_qr`** — the result of a failed QR write — matched no
   branch at all, fell through to the insert, and hit the unique index, giving the student a
   repeatable 502 until expiry (R13). Collapsing to a single "we cannot serve this locally"
   outcome removes the possibility of a gap: `reuse` is a narrow allowlist, and *everything
   else* with a live row goes and asks KBZPay.

6. **`reuse`** → return the stored `provider_qr` and stop. No KBZPay call at all.

7. **`unresolved`** → we hold a live row we cannot serve. **Resolve the reference against
   KBZPay** — one procedure, whatever the local reason (stale hint, changed amount, or missing
   QR):

   a. **`queryOrder(oldRef)`.** Branch on the provider's answer:

      | Provider says | Meaning | Action |
      |---|---|---|
      | `PAY_SUCCESS` | Already paid | Settle the old reference; return `{ status: 'already_paid' }` (§5.1a). **No replacement.** |
      | order does not exist (`QUERYORDER_FAIL`) | `precreate` never landed | Proceed to (c) with reason `FAILED`. |
      | `ORDER_EXPIRED`, `ORDER_CLOSED`, `PAY_FAILED` | Confirmed dead, unpaid | Proceed to (c) with reason `EXPIRED`. |
      | `WAIT_PAY`, `PAYING` | **Still payable** | Go to (b). |

   b. **Still payable → close it, then ask again (R12).** Call `closeOrder(oldRef)`. On a
      transport error, `SYSTEM_ERROR`, `FLOW_CONTROL` or `AOP03028` → **502, change nothing**;
      the old order stays live and reusable.

      Then **re-query, always.** A close that did not error is *not* proof the order went
      unpaid: the payer can complete payment between (a) and (b), and `ORDER_ALREADY_CLOSED`
      or `QUERYORDER_FAIL` then mean "no longer payable" without saying *why* — cancelled or
      completed. Revision 5 treated those codes as proof of retirement, which re-opens R5's
      over-collection, because the settling callback need not have arrived yet and the local
      row still reads `PENDING`. So re-run (a) and branch on the provider's answer, never on
      the close return code. If it still reports `WAIT_PAY`/`PAYING`, the close did not take
      effect: **502, change nothing.** Otherwise proceed to (c) with reason `SUPERSEDED`.

   c. **Complete the swap atomically (R7)** via a second SQL function,
      `complete_kbzpay_supersede(enrollment_id, expected_old_ref, reason, new_ref, amount,
      expires_at)`. In one transaction it locks the enrollment, verifies that
      `expected_old_ref` is *still* this enrollment's live `PENDING` order, transitions it to
      `FAILED`, `EXPIRED` or `SUPERSEDED` per `reason`, and inserts the replacement row.

      **If the old row is no longer `PENDING`** — a callback settled it between the provider
      query and this transition — the function inserts nothing and reports `already_settled`.
      The route then reloads, confirms the payment is `verified`, and returns
      **`{ status: 'already_paid' }`** (§5.1a) — *not* the settlement object (R11). Revision 5
      mapped only the (a) branch to that contract and left this one returning an internal
      result the modal cannot render; both branches mean the same thing to a student, so both
      return the same shape. Without this branch a student could be handed a fresh QR for an
      enrollment that had just been paid.

      Revision 3 wrongly re-invoked the claim function here. The claim function has no branch
      authorising a still-live row to become `SUPERSEDED`, so it would have returned
      `supersede_required` forever and never created the replacement (R7).

8. **The row is inserted before any `precreate` call (R2)**, by step 5d or 7c:
   `payment_ref`, `payment_method: 'kbzpay_mmqr'`, `mmqr_status: 'PENDING'`,
   `status: 'awaiting_payment'`, `amount` = the computed fee, `provider_qr` still null, and
   a **provisional** `provider_order_expires_at` (see step 11).
   **This insert is the amount snapshot** that settlement later validates against.
   The status must be `awaiting_payment` and **not** `pending`: the INSERT branch of
   `trg_payments_sync_enrollment` fires on `pending` and would advance the enrollment to
   `payment_submitted` before any QR exists — the exact hazard migration 054 was added to
   avoid. If the claim fails, return 502 and never call KBZPay.
9. Build `notify_url` as `notifyOrigin() + "/api/webhooks/kbzmmqr"`.
   **Never** derived from the inbound `Host` header — see §7.
10. Call `precreate` with `trade_type: "PAY_BY_QRCODE"`, `trans_currency: "MMK"`,
    `timeout_express: "120m"`.
11. On success, update the row with `provider_qr` and refine
    `provider_order_expires_at` to *the time this response was received* + 120 minutes.
    Revision 3 claimed the local and provider windows "cannot drift apart" because both are
    120 minutes. **That was wrong (R8):** ours is anchored before the request, KBZPay's when
    it accepts, so KBZPay's window always ends *later* by at least the round trip, and clock
    skew is unbounded in either direction. Re-anchoring to the response time removes the
    network-delay component; step 7 removes the rest by never trusting the local clock alone.
    If **this** update fails, return 502 without the QR and **leave the row `PENDING`**: the
    order is live at KBZPay but we could not store its QR, so the slot must stay held. The
    student's next request sees a live row with a null `provider_qr`, claims `unresolved`, and
    step 7 recovers it (R13). Revision 6 had no branch for this state at all: the row matched
    neither reuse nor supersede, fell through to the insert, and hit the unique index — a
    repeatable 502 for two hours.
12. Return `{ qr, orderId, amount }`.

**Ordering rationale (R2).** Calling `precreate` first leaves a window in which KBZPay holds
a payable order that EduEnroll has no row for; money arriving in that window hits a callback
that 404s forever, and the student has paid for nothing. Inserting first inverts the failure
mode: the worst case becomes a local row with no QR, which no one can pay.

**A failed `precreate` does not mark the row terminal (R13).** Leave it `PENDING`, holding
the slot, and return 502. The next request claims `unresolved` and step 7 asks KBZPay what
actually happened.

Revisions 2–6 set `mmqr_status = 'FAILED'` here, which freed the slot immediately — and the
spec contradicted itself in the process, since the same paragraph noted that "`precreate` may
have succeeded at KBZPay and only the response was lost" while nonetheless permitting a second
order to be created alongside that possibly-live first one. A transport failure, a non-2xx, or
a malformed body tell us **our request failed**, not that **KBZPay created nothing**. Only
`queryorder` can distinguish those, so `FAILED` now means one specific thing: *the provider
confirmed no order exists under this reference* (§4.3).

When the row is eventually marked terminal it must still never be set to `'rejected'` — the
UPDATE branch of `trg_payments_sync_enrollment` cascades that to
`enrollments.status = 'rejected'`, rejecting a student's enrollment because *our* outbound HTTP
call failed. `payment_status` has no failure value
(`awaiting_payment | pending | verified | rejected`), so `mmqr_status` carries it and
`status` stays `awaiting_payment` throughout. The row is also deliberately left findable by
`payment_ref`, so if money does arrive against a lost-response order, the callback settles it.

**Cost of holding the slot.** A student whose `precreate` failed cannot get a new QR until
their next request resolves the old reference — one extra `queryorder` round trip on retry.
That is the deliberate trade: an extra API call on a rare path, versus the possibility of two
simultaneously payable orders on the same enrollment.

`timeout_express` is derived from the tenant's own auto-cancel window, clamped to KBZPay's
accepted 1-120 minutes. **The QR must not outlive the enrollment.**
`check_expired_enrollments()` rejects an unpaid enrollment after that window and does NOT
touch the payment row, so a QR still payable afterwards lets a student pay for an enrollment
that no longer exists: the money settles, but `fn_block_reconfirm_rejected` and the sync
trigger's status predicate both refuse to re-confirm a rejected enrollment, so no ticket is
issued and the seat is already gone — a manual refund or reinstatement every time.

A 15-minute tenant setting against the previously hardcoded `120m` left a 105-minute window
in which this was reachable in normal use.

NOTE `tenants.auto_cancel_hours` holds **minutes**, not hours, since migration 058. A value
of 0 disables auto-cancel, in which case KBZPay's 120-minute maximum is correct: there is no
enrollment deadline to outlive.

### 5.1a Creation-route response contract (R10)

The route has **two** success shapes, discriminated by `status`. Revision 4 said the
already-paid path "returns its outcome", which is not a response shape at all — and the
consequence in the browser is concrete, not cosmetic. On a 200 carrying no `qr` and no
`orderId`, `QRPaymentModal` sets `qrData`/`orderId` to `undefined`, skips QR rendering
because the source is falsy, sets state to `"qr"` anyway — rendering an empty QR panel — and
then calls `startPolling(undefined)`, which polls `/status?ref=undefined` every 5 seconds for
10 minutes before declaring the QR expired. A student who has already paid would be shown a
blank code and told it expired.

| Shape | HTTP | When |
|---|---|---|
| `{ status: 'created', qr, orderId, amount }` | 200 | Normal issuance, and reuse |
| `{ status: 'already_paid' }` | 200 | The previous order turned out to be paid. **Three branches reach this**: step 7a (query says `PAY_SUCCESS`), step 7b (the re-query after close says `PAY_SUCCESS`, R12), and step 7c (`complete_kbzpay_supersede` reports `already_settled` because a callback won the race, R11). |

`settleMmqrPayment()` outcomes map onto this as follows: `settled` and `already_settled` both
produce `already_paid` — from the student's point of view the money has arrived either way,
and the distinction only governs whether *we* send notifications (§6). `amount_mismatch` and
`currency_mismatch` are **not** success: they return `409` with a neutral message, because a
prior payment needs admin review before this enrollment can proceed. `not_found` and
`retryable` return `502`.

`status` is added to the normal shape too, rather than leaving it implicit, so the modal
branches on one discriminant instead of inferring intent from a missing field.

**Every path that discovers a prior payment returns this same shape.** Revisions 5 and 6 each
mapped one branch and missed a sibling — R10 fixed step 7a while 7d still returned an internal
object, and R11 fixed the supersede-completion branch just as R12 added a third one after the
close. The invariant to hold
during implementation is: *no `settleMmqrPayment()` result object ever reaches the browser.*
The route translates, always.

**`QRPaymentModal` changes.** Check `data.status === 'already_paid'` **before** touching
`data.qr`; on that branch set state to `success`, call `onSuccess()`, and return without
starting a poller. The existing `success` state already renders correctly, so no new modal
state is needed. The `qr`/`url` handling below it is unchanged, which keeps ABank, MMPay and
PayPay on exactly their current path — none of them ever sends `status`.

### 5.2 Callback settlement — `POST /api/webhooks/kbzmmqr`

1. Read the raw body; parse the `Request` envelope.
2. **Verify the signature.** Invalid → log and return `403`. (Not `success`, but a forged
   callback retrying is harmless.)
3. Locate the payment by `payment_ref = merch_order_id`. Not found → `404`, so KBZPay
   retries; a genuine race between order creation and the callback resolves on retry.
4. **Confirm server-to-server** via `queryOrder(merch_order_id)`. Only KBZPay's own query
   response decides whether money arrived — see §7.
5. On `PAY_SUCCESS`, call `settleMmqrPayment()`.
6. Return per §8.

### 5.3 Status polling — `GET /api/public/payments/kbzpay/status`

Mirrors the existing ABank status route. Calls `queryOrder`, maps `trade_status` to the
modal's view state, and — like the Stripe status route — calls `settleMmqrPayment()` on
`PAY_SUCCESS`. This makes the poller a genuine recovery path when a callback never
arrives, rather than a read-only display.

---

## 6. Settlement contract — `settleMmqrPayment()`

Modelled on `settlePaidPayment` (the Stripe operation), narrowed to what MMQR needs.

**Input:** `{ paymentRef, observedAmount, observedCurrency, observedStatus, mmOrderId, walletIdentifier, source }`

**Contract:**

0. **Require `observedCurrency === 'MMK'` (R3).** An amount is meaningless without its
   currency: `total_amount: "45000"` settles a 45,000 MMK enrollment only if the currency is
   MMK. Any other value — a misconfigured merchant account, a future multi-currency change
   at KBZPay — must refuse to settle rather than compare a foreign figure against an MMK
   snapshot. This is a runtime guard and is independent of the onboarding question in G5.
1. **Validate against the snapshot.** Compare the observed amount to the recorded
   `payments.amount` written at order-create time — never a figure recomputed from current
   class or tenant configuration, which may have changed since the QR was generated.
2. **Conditional transition.** `UPDATE payments SET status='verified' … WHERE id=$1 AND
   status IN ('awaiting_payment','pending')`. Zero rows affected means someone else won
   the race; reload and report `already_settled` rather than assuming a replay.
3. **Never write `enrollments.status`.** `trg_payments_sync_enrollment` confirms the
   enrollment in the same statement (`supabase/migrations/049_fix_seat_restore_and_payment_trigger.sql`).
   The existing ABank and MMPay webhooks write it directly, which is redundant; the new
   path does not repeat that.
4. **`settled` and `already_settled` share the post-settlement path**; only the
   notification decision differs — we notify only on `settled`.
5. Fulfilment reuses the existing helpers: `issueTicketsForEnrollment(enrollmentId)` then
   `notifyEnrollmentConfirmed(enrollmentId)`. **No fulfilment logic is copied.** This is
   why the module is roughly 100 lines rather than the ~250 duplicated in each existing
   MMQR webhook.
6. Fulfilment failure *after* settlement is **retryable**: the money is recorded, and a
   retry repairs the tickets.

**Output:** `{ kind: 'settled' | 'already_settled' | 'amount_mismatch' | 'currency_mismatch' | 'not_found' | 'retryable' }`

---

## 7. Trust model and security

**The callback alone never settles a payment.** Even though KBZPay signs its callbacks,
settlement is decided by a server-to-server `queryorder` response. Rationale: the
signature check is our own code, and the flatten/sort/exclude rules have several ways to
be subtly wrong. Confirming through an authenticated outbound call makes a signature
implementation bug a nuisance rather than a route to free enrollments. This also matches
the precedent already documented in `src/lib/abank.ts`, where the callback is
attacker-controlled and only the enquiry may confirm.

**Amount is re-checked at settlement** against the stored snapshot, as the KBZPay docs
instruct. A short payment never confirms a full enrollment.

**`notify_url` is built from `platformOrigin()`, never the inbound `Host` header.** On a
tenant custom domain, a Host-derived callback URL would aim settlement at a domain the
tenant controls and could remove, stranding in-flight payments — and would require every
custom domain to be added to KBZPay's allowlist. This reasoning is already recorded in the
ABank route and applies identically here.

**Signature comparison is timing-safe** (`crypto.timingSafeEqual` on equal-length buffers).

**The app key is never logged.** Error logs carry `code`/`msg` and `merch_order_id` only.
Signing input is never logged, since it ends with `&key=<APP_KEY>`.

**Replay is inert** by construction: the conditional transition in §6 makes a replayed
`PAY_SUCCESS` callback a no-op that still returns `success`.

---

## 8. Error handling

### QR creation

| Condition | Response |
|---|---|
| Slot claim / row insert fails (before `precreate`) | `502`. KBZPay is never called, so no payable order exists. |
| `precreate` fails in any way (transport, non-2xx, `result: FAIL`) | `502`. Row stays **`PENDING`**, slot held (R13). Never marked `FAILED` — that would permit a second order beside one KBZPay may already hold. The next request resolves it via step 7. |
| `provider_qr` write fails after a successful `precreate` | `502`, no QR. Row stays **`PENDING`** with a null `provider_qr`; the next request claims `unresolved` and step 7 closes and replaces it (R13). |
| Resolve finds the provider has no such order | Mark `FAILED`, free the slot, insert the replacement — the only path on which `FAILED` is ever set. |
| Slot claim loses the unique-index race | Retry the claim once; the winner's row is then reused. Only a second failure returns `502`. |
| Old order reports `PAY_SUCCESS` while superseding | Not an error: settle the old reference and return `{ status: 'already_paid' }` (§5.1a). No replacement QR is issued. |
| Settling that old order returns `amount_mismatch` / `currency_mismatch` | `409` with a neutral message. A prior payment needs admin review before this enrollment can proceed; do not issue a QR over the top of it. |
| `closeOrder` genuinely fails while superseding | `502`, nothing changed. The old order stays live and reusable — never two payable QRs. |
| Re-query after close returns `PAY_SUCCESS` (R12) | Settle the old reference, return `{ status: 'already_paid' }`. No replacement — the payer won the race against our close. |
| Re-query after close still returns `WAIT_PAY`/`PAYING` (R12) | The close did not take effect. `502`, nothing changed — do not free the slot. |
| Local expiry passed, provider reports `WAIT_PAY`/`PAYING` (R8) | Not expired. `closeOrder` first; the slot is freed only on success. Never treat the local clock as authority. |
| Old row settled between the provider close and the local transition (R7) | `complete_kbzpay_supersede` inserts nothing and reports `already_settled`; return `{ status: 'already_paid' }`, not a new QR (R11). |
| Enrollment not awaiting payment | `409` |
| Enrollment not found for tenant | `404` |

### Callback

| Condition | HTTP | Body | Why |
|---|---|---|---|
| Invalid signature | 403 | — | Forgery or a signing bug; must not settle. |
| Payment ref unknown | 404 | — | Retry at 60s/600s may resolve a creation race. |
| `queryorder` unreachable | 500 | — | Retry is the durability mechanism. |
| `queryorder` not `PAY_SUCCESS` | 500 | — | Not yet settled; a retry may catch it. |
| Amount mismatch | 200 | `success` | Retrying will never reconcile it. Logged loudly and left `awaiting_payment` for admin review. |
| Currency not `MMK` | 200 | `success` | Same reasoning as amount mismatch: a retry sends the identical currency. Logged loudly, never settled. |
| Settled / already settled | 200 | `success` | Done. Stop retries. |
| Fulfilment failed post-settlement | 500 | — | Money is recorded; retry repairs tickets. |

Note the asymmetry: `success` is returned **only** when there is nothing further KBZPay can
usefully do. Everything transient stays non-`success` to buy the two retries.

---

## 9. Configuration

```
KBZPAY_APPID=          # 32-char application id
KBZPAY_MERCH_CODE=     # merchant short code
KBZPAY_APP_KEY=        # signing key — secret
KBZPAY_MODE=           # 'production' | anything else → UAT
KBZPAY_NOTIFY_ORIGIN=  # e.g. https://brave.kuunyi.com — origin KBZPay calls back
```

`KBZPAY_NOTIFY_ORIGIN` exists because the callback host must be **registered with
KBZPay per environment**, and the host they register has to match what we send with each
order. It is operator-set and fixed per deployment — never derived from the request or from
whichever tenant is checking out, which is the §7 rule it must not break.

It is validated before use, and every rejection falls back to `platformOrigin()` with a log
rather than being sent to KBZPay:

- **Unset** → fallback, so a missing variable is safe rather than broken.
- **Malformed** → fallback, so a typo cannot become a relative or empty callback URL.
- **Not `https:`** → fallback. `new URL()` accepts `http:`, `ftp:` and `file:` without
  complaint and `.origin` returns them unchanged, so without an explicit scheme check the
  callback could be delivered over plaintext. `file:` is the worst case: its `.origin` is the
  literal string `"null"`, which would have produced a `notify_url` of
  `null/api/webhooks/kbzmmqr`.
- **Path or query present** → normalised to the origin, since KBZPay rejects a `notify_url`
  carrying query parameters.

`platformOrigin()` itself is deliberately not scheme-checked: it is the app's own configured
origin, is `http://localhost` in local development, and no provider can reach that host.

DEV values in `.env.local`; production values as Vercel Production env vars set with
`printf` (never `echo`, which appends a newline and breaks signatures).

---

## 10. Testing

**Unit — `src/lib/kbzpay.ts` (the highest-value tests here):**

- `stringA` construction asserted against the **two worked examples published in the KBZPay
  docs** — the `precreate` example and the `orderinfo` example. Both publish the exact
  expected concatenation, so these are real vectors, not self-authored ones.
- SHA256 + uppercase-hex output against a key we choose.
- `sign` and `sign_type` excluded; empty values excluded; array values (`refund_info`)
  excluded.
- ASCII ordering: a payload containing `Wallet_identifier` sorts it ahead of lowercase keys.
- `verifySign()` accepts a payload containing an **unknown extension field**, and rejects
  one whose `total_amount` was tampered with.
- `buildMerchOrderId()` output matches `/^[A-Za-z0-9_]{1,40}$/`, and 10,000 successive calls
  for the *same* enrollment id yield 10,000 distinct references (R1).

**Unit — `settleMmqrPayment()`:** settled, already_settled (zero-row transition),
amount mismatch, **currency other than MMK → `currency_mismatch`, never settled (R3)**,
unknown ref, fulfilment failure → retryable.

**Route tests — order creation (R1, R2):**

- A second request inside the order window with an unchanged amount returns the **same**
  `orderId` and QR, and inserts no second row.
- A second request after the amount changed does **not** reuse; it issues a fresh order.
- `precreate` failure leaves the row at `status='awaiting_payment'` with
  `mmqr_status='FAILED'`, and leaves `enrollments.status` **untouched** — the regression
  guard for the `'rejected'` cascade.
- Row insert is observably ordered before the `precreate` call, and a failed insert results
  in no outbound KBZPay request at all.

**Concurrency and lifecycle tests (R4, R5) — these are the ones that would have caught the
revision-2 defects:**

- **Two simultaneous creation requests for one enrollment produce exactly one provider
  order** and one live row (R4). Run against a real database, not mocks — the guarantee is
  the row lock plus `idx_payments_one_live_kbzpay_order`, and neither exists in a mock.
- A live order past `provider_order_expires_at` whose provider status is terminal
  (`ORDER_EXPIRED`) is transitioned to `EXPIRED` and no longer blocks a replacement.
- **Boundary test (R8): local expiry has passed but `queryOrder` still returns `WAIT_PAY`.**
  Assert the row is *not* freed, `closeOrder` is called, and no replacement QR is issued
  until that close succeeds. This is the case where trusting the local clock would produce
  two payable QRs.
- **Callback race (R7): the old row is settled between the provider close and the local
  transition.** Assert `complete_kbzpay_supersede` inserts nothing, reports
  `already_settled`, and the route returns the settled outcome rather than a fresh QR.
- Normal close-and-replace: old row ends `SUPERSEDED`, exactly one new `PENDING` row exists,
  and `closeOrder` was called before `precreate`.
- **Stale-before-reuse (R9): a same-amount request after local expiry.** Assert `queryOrder`
  is called and the stored `provider_qr` is *not* returned. Without the branch ordering in
  step 5 this test passes a stale QR straight back to the student, so it is the direct
  regression guard for R9.

**Creation-route response and modal tests (R10):**

- The already-paid path returns `{ status: 'already_paid' }` with no `qr` and no `orderId`,
  for both `settled` and `already_settled` settlement outcomes.
- **All three already-paid branches return the identical shape (R10, R11, R12):** first query
  says `PAY_SUCCESS`; re-query after close says `PAY_SUCCESS`; and
  `complete_kbzpay_supersede` reports `already_settled`. Parameterise one test over the three
  so a future branch cannot quietly skip the translation.
- **`WAIT_PAY → PAY_SUCCESS` between the first query and the close response (R12).** Assert
  no replacement row is created, no new QR is returned, the old reference is settled, and the
  response is `already_paid`. This is the race that re-opens R5's over-collection, so it is
  the direct regression guard for R12.
- Re-query returning `WAIT_PAY` after a non-erroring close yields `502` and leaves the old row
  `PENDING`.

**Ambiguous-creation recovery tests (R13):**

- **Lost `precreate` response:** the call fails, but KBZPay did create the order. Assert the
  row stays `PENDING` and the slot stays held; then assert the *next* request resolves it via
  `queryOrder` rather than creating a second order. The pre-fix behaviour marks it `FAILED`
  and issues a second QR alongside a live one, so asserting on the absence of a second
  provider order is what makes this test meaningful.
- **`provider_qr` write failure:** `precreate` succeeds, the update fails. Assert the next
  request does **not** 502 — it must claim `unresolved` and recover. This is the R13 lock-up
  where revision 6 returned a repeatable 502 for two hours.
- `FAILED` is reachable **only** when `queryOrder` reports the order does not exist. Assert no
  other path sets it — this is the guard for the whole R13 class.
- A live row with a null `provider_qr` and a *matching* amount claims `unresolved`, not
  `reuse` and not `created`. That combination matched no branch at all in revision 6.
- `amount_mismatch` / `currency_mismatch` on that path return `409`, not a QR.
- **Component test:** given `{ status: 'already_paid' }`, `QRPaymentModal` renders the success
  state, calls `onSuccess()`, and starts **no** poller. Assert no `/status` request is issued —
  the pre-fix behaviour polls `ref=undefined`, so asserting on the absence of that request is
  what makes the test meaningful.
- **Regression:** an ABank/MMPay/PayPay response carrying no `status` field still renders the
  QR and starts polling exactly as before.
- **The R5 sequence end to end:** issue a 40,000 QR → record a 10,000 manual partial → request
  a new QR → assert the 40,000 order was closed at KBZPay before the 30,000 QR was issued,
  and that paying the *old* reference afterwards does not confirm the enrollment.
- When the old order already reads `PAY_SUCCESS`, requesting a replacement settles the old
  reference instead of issuing a new QR.
- When `closeOrder` fails, no new row is created, no new QR is returned, and the old row is
  still live and reusable.
- Each terminal `mmqr_status` (`SUCCESS`, `FAILED`, `EXPIRED`, `SUPERSEDED`) frees the slot;
  `PENDING` holds it.

**Route tests** mirroring `src/__tests__/payments/abank-callback-route.test.ts`: valid
callback settles once and returns `success`; duplicate callback returns `success` without
re-notifying; bad signature returns 403 and does not settle; `queryorder` reporting
`WAIT_PAY` does not settle.

**MSW handlers** for `precreate` and `queryorder` added to `src/mocks/handlers.ts`.

**E2E:** extend `e2e/checkout.spec.ts` with a `kbzpay` tenant, asserting the QR renders and
the modal reaches the confirmed state.

**Live UAT verification** is deferred to credential arrival (§11, G1) and is the one thing
mocks cannot prove.

---

## 11. Gates and open questions

| # | Gate | Owner |
|---|---|---|
| G1 | KBZPay UAT credentials (`appid`, `merch_code`, app key) issued. Blocks live verification, not implementation. | KBZPay onboarding |
| G2 | **CLOSED 2026-09-01 by measurement, not by asking.** UAT serves `precreate` and `queryorder` over HTTP only and `closeorder` over HTTPS only; production is HTTPS throughout. `endpointUrl()` encodes exactly that, with production hard-guarded. Plaintext accepted for UAT only — see §3.1. | Us |
| G3 | Register the production `notify_url` with KBZPay and confirm whether they require IP allowlisting. | KBZPay onboarding |
| G4 | `KBZPAY_NOTIFY_ORIGIN` must be set per environment — `https://brave.kuunyi.com` in production, `https://brave.staging.kuunyi.com` on staging — and **must match the URL registered with KBZPay**. The apex 307-redirects and a redirected POST is not followed, so an apex value fails silently. Confirm both hosts resolve; staging subdomains are not wildcard. | Us |
| G5 | Confirm the `total_amount` decimal convention for MMK (docs allow up to 2 decimals; MMK is normally whole-kyat). Affects the amount comparison. | Us → KBZPay |
| G6 | **Before the unique-index migration**, confirm zero existing duplicate `payment_ref` values on dev *and* production: `select payment_ref, count(*) from payments where payment_ref is not null group by 1 having count(*) > 1;`. Read-only, and the production run is a query only — no schema change is applied there outside the normal dev → staging → main pipeline. If duplicates exist, they must be reconciled before the index can be created. | Us |

---

## 12. Out of scope

- The refund API (it requires a client certificate, a separate onboarding artefact, and
  EduEnroll has no refund flow today).

  `kbz.payment.closeorder` **is now in scope** — it was excluded in the original scoping and
  brought back in to resolve R5. Revision 2 claimed here that a late payment against a
  superseded order "fails the amount-snapshot check". **That was wrong.** The snapshot is
  stored per payment row, so a 40,000 MMK payment against the old row matches the old row's
  own 40,000 snapshot and settles cleanly, while a replacement 30,000 QR sits alongside it —
  collecting 50,000 against a 40,000 enrollment. Superseding is therefore an active
  operation (§5.1 step 7), not something the amount check can be relied on to catch.
- KBZPay's other trade types: `APP`, `APPH5`, `PWAAPP`, `QRCODE_H5`, `MINIAPP`,
  `MICROPAY`, guarantee, mandate, CrossApp, enterprise payment.
- Per-tenant KBZPay merchant credentials.
- Migrating ABank and MMPay onto `settleMmqrPayment()`. Deliberately deferred to its own
  reviewable change so a new, untested integration and two live payment paths are not
  rewritten together.

---

## 13. Review findings — 2026-08-20

These findings were recorded during design review: R1–R3 from the revision-1 review, R4–R6
from revision 2, R7–R8 from revision 3, R9–R10 from revision 4, R11–R12 from revision 5,
and R13 from revision 6. All thirteen were verified against the codebase and accepted, and
each is folded into the sections above with its resolution noted inline below.
Status: **no open blockers.**

**Read this before implementing.** Eight of the thirteen (R5, R7, R8, R9, R10, R11, R12, R13)
corrected statements that were actively wrong rather than merely incomplete, and all eight sit
in the order lifecycle — §5.1 step 7 and its response contract. Two failure patterns account
for every one of them:

1. **Treating local state as authoritative over provider state** (R5, R8, R9, R12, R13). Each
   time, something we held locally — an amount snapshot, an expiry timestamp, a cached QR, a
   close return code, a failed outbound call — was assumed to describe KBZPay's state. Each
   time it did not. The invariant the design converged on, now stated in §4.3: **no terminal
   transition and no slot release without a `queryorder` answer.**
2. **Fixing one branch and not its sibling** (R7, R10, R11, R13). The already-paid outcome grew
   from one branch to three, each revision mapping the branch under discussion and leaving its
   twin returning an internal object; and the claim contract grew branches until one state —
   a live row with a matching amount and a null `provider_qr` — matched none of them. The
   invariants: *no `settleMmqrPayment()` result object ever reaches the browser*, and *`reuse`
   is a narrow allowlist while everything else with a live row goes and asks KBZPay.*

Both are invariants to hold during implementation, not history. R9, R11, R12 and R13 were each
defects introduced by the fix for an earlier finding, so this area warrants slower work,
real-database tests, and live UAT verification before it is trusted (G1).

**On the shape of the fixes.** Revision 7 stopped adding branches and removed them instead:
three claim outcomes collapsed to one `unresolved`, and the stale/supersede/recover paths
collapsed to one resolve procedure. Six revisions of patching produced a defect each time
precisely because each patch added another branch that a later state could fall between. If
further findings arrive in this area, prefer removing a distinction over adding a case.

### R1 — Make order references collision-safe and enforce one active order

The proposed `KBZ_{first 8 hex of enrollment id}_{base36 timestamp}` reference is based
only on the enrollment ID and millisecond timestamp. Concurrent requests for the same
enrollment can therefore generate the same reference. In addition, `payments.payment_ref`
currently has a non-unique index, so duplicate references or multiple live QR orders can
make settlement lookup ambiguous; a second QR could also be paid after the enrollment is
already confirmed.

**Required change:** generate `merch_order_id` using cryptographically secure randomness
while retaining KBZPay's letters/digits/underscores/max-40 constraint; add a unique
constraint/index on `payments.payment_ref`; and define a single-active-order policy per
enrollment (reuse an unexpired pending order or explicitly retire it before issuing a new
one).

**Resolution — accepted, verified.** `payment_ref` was confirmed to carry only a non-unique
index (047:12), and because the webhooks and status routes resolve it with `.single()`, a
collision breaks settlement rather than merely duplicating a row. Applied: crypto-random
reference (§4.3), partial unique index (§4.3), and the single-active-order policy (§5.1).

Two consequences the finding did not name: the reuse policy requires a new `provider_qr`
column, so §4.3's original "no schema change required" claim no longer holds; and the unique
index touches rows written by ABank, MMPay and PayPay, so it is gated on a duplicate check
against dev *and* production (G6).

**Superseded by later findings.** Revision 2 implemented only the *reuse* branch of this
finding and deferred "explicitly retire it", on the grounds that retiring needed `closeorder`.
R4 then showed the reuse check was not atomic, and R5 showed the deferral was unsafe rather
than merely incomplete. Both halves of R1 are now implemented: reuse **and** active retirement
via `closeorder`, which is back in scope. See the R4 and R5 resolutions.

### R2 — Remove the precreate-to-insert durability gap

The current flow calls KBZPay `precreate` before inserting the local payment row. If the
database insert fails, or payment and callback happen before the insert commits, KBZPay has
a payable order that EduEnroll cannot reliably locate or settle. Returning a QR without a
durable local payment snapshot is not acceptable.

**Required change:** create the local payment row before `precreate`, then update it with
the KBZPay prepay/QR details after a successful response. If `precreate` fails, mark the
row as a creation failure (or otherwise make it unpayable). Check every database write and
never return a QR for an order whose local row was not durably recorded.

**Resolution — accepted, with one correction.** The reordering is applied in §5.1, together
with per-write failure handling in §8. The correction concerns "mark the row as a creation
failure": `payment_status` is an enum of `awaiting_payment | pending | verified | rejected`
with **no failure value**, and setting `'rejected'` would fire the UPDATE branch of
`trg_payments_sync_enrollment`, cascading to `enrollments.status = 'rejected'` — rejecting a
student's enrollment because our own outbound call failed. The failure is therefore recorded
on `mmqr_status` while `status` stays `awaiting_payment`. Deliberately, this also does not
make the row "unpayable" as the finding suggested: if `precreate` in fact succeeded at KBZPay
and only the response was lost, the row must stay findable by `payment_ref` so a later
callback can still settle it. Related: the insert must use `awaiting_payment` rather than
`pending`, or the trigger's INSERT branch advances the enrollment before a QR exists — the
hazard migration 054 was written to fix.

### R3 — Validate currency during settlement

Settlement currently receives and checks an amount only. `total_amount` is meaningful only
together with `trans_currency`; an unexpected or misconfigured query response could settle
an MMK enrollment using an amount in another currency.

**Required change:** include `observedCurrency` in `settleMmqrPayment()` input and require
it to be `MMK` before the conditional verified transition. This is a runtime settlement
guard, separate from the onboarding confirmation in G5.

**Resolution — accepted as written.** Added as step 0 of the §6 contract, ahead of the
amount comparison, with a `currency_mismatch` outcome (§6), a callback response row (§8),
and a unit test (§10).

### R4 — Make the single-active-order policy atomic

The reuse lookup in §5.1 is an application-level read. Two concurrent requests can both
find no reusable row, insert different crypto-random `payment_ref` values, and call
`precreate`, leaving two live QR orders. The unique index on `payment_ref` prevents only
reference collisions; it cannot enforce one live KBZPay order for an enrollment.

**Required change:** enforce one active KBZPay order per enrollment with a database-backed
concurrency strategy. The design must also define an explicit expiry transition, so an
expired row ceases to be active and does not permanently block issuance of a replacement
QR. Add a concurrency route test that sends two creation requests simultaneously and proves
that only one provider order is created.

**Resolution — accepted as written.** The read-then-insert had no atomicity, as stated.
Replaced by a `claim_kbzpay_order_slot()` SQL function that takes a `FOR UPDATE` lock on the
enrollment and inserts in one transaction (§5.1 step 5), backed by a partial unique index
`idx_payments_one_live_kbzpay_order` on `enrollment_id` (§4.3). The requested explicit expiry
is a stored `provider_order_expires_at` column plus an `EXPIRED` transition, with the full
`mmqr_status` lifecycle and which values free the slot documented in §4.3. Concurrency test
added in §10, and it must run against a real database — the guarantee is the lock and the
index, neither of which exists in a mock.

**Partly amended by R7 and R8.** Revision 3 had the claim function perform the expiry
transition itself and asserted that the local and provider expiry windows "cannot drift
apart". R8 showed that assertion is false, so expiry moved out of the claim function and
behind a provider check; R7 showed the supersede completion had no defined transition at all.
See those resolutions.

### R5 — Prevent payment of a superseded QR from over-collecting

Section 12 currently states that a late payment of a superseded QR fails the
amount-snapshot check. That is not true: the old provider amount matches the old payment
row's stored snapshot, so `settleMmqrPayment()` can verify it while the enrollment remains
eligible. For example, an outstanding 40,000-MMK QR followed by a 10,000-MMK manual partial
payment can produce a new 30,000-MMK QR; payment of the original QR can still confirm the
old 40,000 MMK amount.

**Required change:** either close/supersede the old provider order, refuse a changed-amount
replacement while an old QR remains live, or implement a durable outstanding-balance rule
that makes settlement safe across multiple payment attempts. Update §12 and add an
integration test for this partial-payment sequence.

**Resolution — accepted; the finding corrects an error in revision 2.** The §12 claim that a
superseded QR "fails the amount-snapshot check" was false: the snapshot is per row, so the
old row's stored 40,000 legitimately matches a 40,000 payment and settles, and the worked
sequence does collect 50,000 against a 40,000 enrollment. §12 has been corrected rather than
softened. Fix chosen: **close/supersede the old provider order**, which meant bringing
`kbz.payment.closeorder` back into scope (§2, §3.1, §4.1). §5.1 step 7 queries the old order
*before* closing it — if it already reads `PAY_SUCCESS` the student has paid, so the old
reference is settled and no replacement QR is issued at all, which removes the
over-collection at its source; the KBZPay docs recommend this ordering independently. A
close failure is fail-closed: 502, nothing changes, and the old order stays live rather than
a second payable QR being issued. Integration test for the exact partial-payment sequence
added in §10.

### R6 — Make the unique-index migration executable in the deployment path

PostgreSQL does not permit `CREATE INDEX CONCURRENTLY` inside a transaction block, while
normal migration runners commonly execute migrations transactionally. The DDL in §4.3
therefore needs an explicit deployment sequence rather than being treated as an ordinary
single migration.

**Required change:** either create the index non-concurrently through the normal migration
path, with its locking impact planned, or use a separately approved non-transactional
operational step to build the concurrent index before a follow-up migration removes the old
index. Document the chosen sequence and its rollback plan.

**Resolution — accepted, first option taken.** Confirmed: no migration in this repo uses
`CONCURRENTLY`, so it would be off-pattern as well as unrunnable inside the transactional
`supabase db push` path. `CONCURRENTLY` is dropped and the index is created through the
normal migration path (§4.3). Locking impact is stated rather than assumed — a non-concurrent
build takes a `SHARE` lock blocking writes to `payments` for the duration, which on a table
of this size is milliseconds, and the trade is preferred over a bespoke out-of-band step.
Rollback is documented in §4.3: drop the unique index and recreate the original non-unique
one, altering no data.

### R7 — Specify the atomic local transition after a successful close

Step 7d says that re-invoking `claim_kbzpay_order_slot()` marks the old row
`SUPERSEDED` and inserts the replacement. However, the function specified in step 5 only
expires rows past `provider_order_expires_at`, reuses a matching live row, returns
`supersede_required` for a different live row, or inserts when no live row exists. It has no
input or branch authorising a still-live old row to become `SUPERSEDED`. As written, the
second claim returns `supersede_required` again forever and never creates the replacement.

**Required change:** define a separate transactional `complete_kbzpay_supersede()` function,
or extend the claim function with an explicit expected-old-reference/close-confirmed mode.
It must lock the enrollment, verify that the named old row is still this enrollment's live
`PENDING` order, transition it to `SUPERSEDED`, and insert the replacement atomically. If a
callback has settled the old order between the provider close and this local transition, it
must reload and return the settled outcome rather than create a new QR. Add route tests for
both the normal close-and-replace path and this callback race.

**Resolution — accepted as written; the finding identifies a dead end in revision 3.** The
diagnosis is exact: the claim function had no branch authorising a still-live row to become
`SUPERSEDED`, so the supersede-completion branch would have returned that outcome on every retry and never
issued the replacement. Fixed with the separate function option: `complete_kbzpay_supersede
(enrollment_id, expected_old_ref, reason, new_ref, amount, expires_at)` (§4.3, §5.1 step 7c).
It locks the enrollment, verifies `expected_old_ref` is still the live `PENDING` order,
transitions it to `EXPIRED` or `SUPERSEDED` according to why it is being retired, and inserts
the replacement in the same transaction. The callback race is handled as required: if the old
row is no longer `PENDING`, it inserts nothing and reports `already_settled`, and the route
returns that outcome instead of handing a fresh QR to a student whose enrollment was just
paid. Both paths are tested in §10 and appear in the §8 error table.

### R8 — Do not expire a provider order solely from the application clock

The claim function releases the active-order slot whenever the locally calculated
`provider_order_expires_at` has passed. That timestamp is written before `precreate`, while
KBZPay starts its own 120-minute timeout when it accepts the request and uses its own clock.
Network delay and clock skew mean the two windows can differ. In the overlap, this design
marks an order `EXPIRED` locally and issues a replacement even though KBZPay can still accept
the original QR, recreating the multiple-payable-order risk R4 was meant to remove.

**Required change:** before freeing an order because of local expiry, query KBZPay and treat
it as expired only when the provider reports a terminal non-payable status; if it remains
payable, close it successfully before releasing the slot. Store the provider-confirmed expiry
time if the API supplies one, and add a boundary test for a local expiry with the provider
still reporting `WAIT_PAY`.

**Resolution — accepted; the finding corrects a false claim in revision 3.** Step 10 asserted
that because both windows are 120 minutes they "cannot drift apart". That is wrong: ours is
anchored *before* the request is sent and KBZPay's when it *accepts*, so KBZPay's window
always ends later by at least the round trip, and clock skew is unbounded besides. Applied:

- `provider_order_expires_at` is demoted to a **hint** that triggers a `queryOrder` check, and
  is never authority to free the slot. This is stated in the column comment, in the
  `mmqr_status` lifecycle table (§4.3) and in the claim contract, which returns a
  non-serviceable outcome rather than silently expiring the row.
- A locally-stale order is released only when the provider reports a terminal non-payable
  status; if it reports `WAIT_PAY` or `PAYING` it is **still payable** and must be closed
  successfully first (§5.1 step 7). The stale and changed-amount cases therefore collapse
  into one path — both ask the same question. (R13 later collapsed the missing-QR case in
  alongside them, and renamed the combined outcome `unresolved`.)
- The expiry timestamp is re-anchored to the `precreate` *response* time (§5.1 step 11),
  removing the network-delay component of the skew.
- Boundary test added in §10.

**On storing a provider-confirmed expiry:** the documented `queryorder` response carries no
expiry field — only `trade_status`, amounts, `mm_order_id` and `pay_success_time` — so there
is nothing to store. Rather than invent one, liveness is resolved by `trade_status` at the
moment it matters. If KBZPay later exposes an expiry, storing it becomes a cheap refinement.

### R9 — Check local staleness before reusing a QR

The claim contract checks for a matching live row with a non-null `provider_qr` before it
checks whether the row is past `provider_order_expires_at`. Therefore a same-amount QR that
is locally stale satisfies the reuse branch and is returned to the student without the
`queryOrder` validation required by R8. This does not create a second QR, but it can keep
serving an expired or otherwise terminal QR indefinitely.

**Required change:** classify local staleness before the reuse branch. A row past the local
expiry hint must always return `stale` and enter the provider-status path; only a row still
inside that hint window may be reused directly. Add a route test for a same-amount request
after local expiry which proves `queryOrder` runs instead of returning the stored QR.

**Resolution — accepted as written.** The branch ordering was wrong exactly as described:
reuse was tested before staleness, so a same-amount row past its local expiry took the reuse
branch and was re-served from `provider_qr` with no provider check. The consequence is worse
than the missed validation — since reuse never advances the row, a QR that KBZPay had already
expired could be handed back to students indefinitely. Fixed by classifying staleness **first**
(§5.1 step 5), regardless of amount, so staleness shadows `reuse` and only a row inside the hint
window is served directly. (R13 later hardened this further by making `reuse` a narrow
allowlist, so no state can fall between the branches at all.) The step now carries an explicit note that the ordering is
load-bearing, since it is the kind of thing a later edit would casually reorder. Regression
test added in §10.

This finding also shows R8's fix was incomplete rather than wrong: demoting the local clock to
a hint only helps on paths that consult it, and the reuse path bypassed it entirely.

### R10 — Define the creation-route response when an old QR has already paid

In the supersede/stale path, a `PAY_SUCCESS` query settles the old payment and the route
"returns its outcome." That outcome is not the creation endpoint's documented response
shape (`{ qr, orderId, amount }`), and `QRPaymentModal` currently expects an `orderId` to
start polling. Returning a settlement object leaves the modal unable to show confirmation
and may start a request with an undefined reference.

**Required change:** add an explicit, typed response for this path (for example
`{ status: 'already_paid' }`) and update `QRPaymentModal` to render success immediately and
call its existing success handler without creating a poller. Cover both `settled` and
`already_settled` outcomes in route/component tests.

**Resolution — accepted as written, and the consequence is worse than described.** Confirmed
by reading `QRPaymentModal.tsx`: on a 200 with no `qr` and no `orderId` it does not merely fail
to show confirmation. It sets both values to `undefined`, skips QR rendering because the source
is falsy, sets state to `"qr"` regardless — rendering an **empty QR panel** — and then calls
`startPolling(undefined)`, polling `/status?ref=undefined` every 5 seconds for 10 minutes before
telling the student the QR expired. A student who had already paid would be shown a blank code
and then an expiry error.

Applied: a new §5.1a defines the route's two success shapes discriminated by `status`, with
`{ status: 'already_paid' }` for this path and `status` added to the normal shape too so the
modal branches on one discriminant rather than inferring intent from a missing field. Both
`settled` and `already_settled` map to `already_paid` — the money has arrived either way, and
the distinction only governs whether *we* notify. Beyond the finding, the mismatch outcomes are
also pinned down: `amount_mismatch` / `currency_mismatch` return `409` rather than a QR, since a
prior payment needs review before the enrollment proceeds. The modal check goes **before** the
`qr`/`url` branch; ABank, MMPay and PayPay never send `status`, so their path is untouched, and
§10 carries a regression test asserting exactly that.

### R11 — Apply the already-paid response contract to the callback race

The R7 callback-race path says `complete_kbzpay_supersede()` reports `already_settled` and
the route returns that outcome. This is the same response-shape problem R10 fixed for the
earlier `queryOrder(PAY_SUCCESS)` branch: `already_settled` is a settlement result, not a
creation-route response, and the modal cannot render it. The design explicitly maps the R10
branch to `{ status: 'already_paid' }`, but omits that mapping for the R7 branch.

**Required change:** map the `complete_kbzpay_supersede()` `already_settled` result to
`{ status: 'already_paid' }` too, after reloading confirms the payment is verified. Do not
return an internal settlement object to the browser. Add it to the R10 response table and the
component/route test matrix.

**Resolution — accepted as written.** The diagnosis is exact: R10 fixed the response shape for
the first-query branch and left the supersede-completion branch returning `already_settled`,
which the modal cannot render. Both
branches now return `{ status: 'already_paid' }` after the reload confirms the payment is
verified (§5.1 step 7c), and the §5.1a table names every branch that reaches that shape.

R12, raised in the same round, added a *third* such branch — so the response table now lists
three and §10 parameterises one test across all of them. §5.1a also carries the invariant
explicitly: no `settleMmqrPayment()` result object ever reaches the browser. Two consecutive
revisions each mapped the branch under discussion and missed its sibling, which is a sign the
rule needed writing down rather than re-deriving.

### R12 — Re-query after a close result before freeing the order slot

There is a payment race between the initial `queryOrder(oldRef)` and `closeOrder(oldRef)`: the
first query can return `WAIT_PAY`, then the payer completes payment just before the close call.
The design treats `ORDER_ALREADY_CLOSED` and `QUERYORDER_FAIL` as successful retirement and
immediately transitions the local row to `SUPERSEDED`. Either result can mean the old order is
no longer payable because it has already completed, not necessarily because it was cancelled.
Issuing a replacement in that case recreates the over-collection path R5 was intended to stop.

**Required change:** after every close result treated as successful, query the old order again
before `complete_kbzpay_supersede()`. If it is `PAY_SUCCESS`, settle it and return
`{ status: 'already_paid' }`; only a provider-confirmed terminal unpaid status may transition
the row to `SUPERSEDED`/`EXPIRED` and free the slot. Add an integration test for
`WAIT_PAY → PAY_SUCCESS` between the first query and close response.

**Resolution — accepted as written; it invalidates a claim in §3.1.** Revision 5 asserted that
`ORDER_ALREADY_CLOSED` and `QUERYORDER_FAIL` "both mean the order is not payable, which is the
outcome we want". They mean it is not payable *now*, and say nothing about whether it was
cancelled or **completed** — and a payer settling between our query in (a) and our close in (c)
produces exactly that ambiguity. Because the settling callback need not have arrived yet, the
local row is still `PENDING` and looks perfectly retirable, so superseding on the close code
alone re-opens R5's over-collection.

Applied: a mandatory re-query step (§5.1 step 7b) after **every** non-erroring close, with
the branch decided by the provider's answer rather than the close return code —
`PAY_SUCCESS` → settle and return `already_paid`; a terminal unpaid status → supersede;
`WAIT_PAY`/`PAYING` → the close did not take effect, so `502` and free nothing. §3.1's
idempotency note is corrected in place rather than deleted, since the mistaken reading is an
easy one to make again from the KBZPay error table. Integration test for the
`WAIT_PAY → PAY_SUCCESS` race added in §10.

This is the fourth finding in the family "a local value was treated as authoritative over
provider state" (with R5, R8, R9). The close return code was the last such value in the flow;
after this change every retirement decision is made from a fresh `queryorder`.

### R13 — Recover an ambiguous `precreate` result before releasing the live-order slot

The design still marks a row `FAILED` and frees the unique live-order slot whenever
`precreate` has a transport failure, non-2xx response, or malformed/error response. That
does not prove KBZPay did not create the order: the request may have reached KBZPay and its
response may have been lost. A later request can then create a second order while the first
provider-side order remains live. Conversely, a successful `precreate` whose subsequent
`provider_qr` database update fails leaves a `PENDING` row with no stored QR; the claim
function cannot reuse it and the unique index blocks a replacement, leaving the student at a
repeatable 502 until expiry.

**Required change:** treat both cases as an ambiguous creation state, not as an immediate
failure. Before marking the row terminal or freeing its slot, call `queryOrder(payment_ref)`:
`PAY_SUCCESS` must settle; `WAIT_PAY`/`PAYING` must remain live and enter an explicit recovery
path (retry the durable QR write if recoverable, or close the order successfully before
replacement); only a provider-confirmed nonexistent/terminal-unpaid order may become
`FAILED`/`EXPIRED`. Add a `provider_qr IS NULL` creation-in-progress/recovery outcome to the
claim contract so repeat requests do not fall through to a unique-violation 502. Test a lost
`precreate` response and a QR-update write failure.

**Resolution — accepted; both halves confirmed, and the spec was self-contradictory.** On the
first half, revision 6's own text noted that "`precreate` may have succeeded at KBZPay and only
the response was lost" and then freed the slot two sentences later, permitting a second order
beside a possibly-live first. A failed request tells us *our call* failed, never that KBZPay
created nothing. On the second half, a live row with a matching amount and a null `provider_qr`
genuinely matched no branch: not `reuse` (needs a non-null QR), not `supersede_required` (needs
a different amount), so it fell to the insert and hit the unique index — a repeatable 502 until
the two-hour expiry, exactly as described.

Rather than add a seventh branch, §5.1 was restructured:

- The claim contract now returns **`reuse` | `unresolved` | `created`**. `reuse` is a narrow
  allowlist (same amount **and** non-null QR **and** inside the expiry hint); *every* other
  live row is `unresolved`. The null-`provider_qr` state cannot fall through a gap because
  there is no longer a gap to fall through.
- `stale`, `supersede_required` and the missing-QR case all enter **one** resolve procedure
  (step 7), since all three ask the provider the same question.
- A failed `precreate` and a failed `provider_qr` write both leave the row `PENDING` with the
  slot held; recovery happens on the next request through that same procedure.
- `FAILED` now means one thing only: **`queryorder` confirmed no order exists** under that
  reference. §4.3 states the governing invariant — no terminal transition and no slot release
  without a provider answer — with a table of the four local signals that were each wrongly
  treated as authoritative (R8, R9, R12, R13).

The cost is stated rather than hidden: a student whose `precreate` failed needs one extra
`queryorder` round trip on retry. That is the deliberate trade against two simultaneously
payable orders.
