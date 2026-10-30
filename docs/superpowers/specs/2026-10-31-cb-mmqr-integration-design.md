# CB Bank MMQR Integration — Design

Status: design, revision 3 (after two Codex reviews, §13). Not implemented.
Tenant: `beatsrun` (The Beats Run). Client notes: `docs/clients/beatsrun.md`.

## 1. Context

The Beats Run will take MMQR payments through CB Bank, into the organiser's own CB merchant
account (YOUNG MONEY CO.,LTD), not the platform's. No CB code exists. The KBZPay
integration is the model, and every protection its reviews added is carried over:

- `docs/superpowers/specs/2026-08-20-kbzpay-mmqr-integration-design.md` (base spec, review
  findings R1–R13)
- `docs/superpowers/specs/2026-10-30-kbzpay-per-tenant-merchants-design.md` (PR #328)
- `src/lib/kbzpay.ts`, `src/app/api/public/payments/kbzpay/**`,
  `src/app/api/webhooks/kbzmmqr/route.ts`, `src/server/payments/settleMmqrPayment.ts`,
  `src/server/payments/kbzpayOrderWindow.ts`, `src/server/payments/resolveKbzpayOrder.ts`
- `supabase/migrations/20260820120000_kbzpay_mmqr.sql`,
  `20260903090000_payments_platform_fee.sql`, `20261030120000_kbzpay_per_tenant_merchants.sql`

The single biggest difference from KBZPay: **CB has no close/cancel call.** KBZPay's R5/R12
protection against a superseded QR still being paid relies on `closeorder`; for CB a QR
stays payable until CB's own expiry, so replacement has to wait for proof that the old QR is
dead.

## 2. Decisions taken during brainstorming

| Question | Decision |
|---|---|
| Merchant scope | **Per-tenant**, mirroring PR #328: operator-only assignment table, per-merchant env vars, a per-payment merchant pin, no fallback between merchants. Only `beatsrun` is assigned. |
| A live QR when a new one is requested | Same amount → re-serve the same QR. Different amount → **wait**: the student is told the previous QR is still active; a new QR is issued only once the old one is proven dead (§5.0). No double collection. |
| Proof that a QR is dead | **Go-live gate.** Replacement is built, but the set of status responses that prove death starts empty, so a displayed QR is never replaced until CB confirms in writing which response proves it **final** — no in-flight or later payment can still settle — and UAT reproduces it (gate G1). If CB cannot give that guarantee, the set stays empty for good and a changed amount is resolved by an operator. |
| Refunds | **Out of scope** for v1, as for KBZPay. |
| Amounts below CB's 1,000 minimum | The create route refuses before calling CB; the modal says so. No fallback to bank transfer. |
| Code structure | **Mirror KBZPay** module for module. No change to merged KBZPay, ABank or MMPay code or SQL. |

## 3. CB QR Gateway API (v1.0.10, 30 Jul 2026)

Source: CB's PDF (not in the repo) and CB's email of 2026-10-29.

| Call | Request | Response |
|---|---|---|
| `POST /auth/token` | `userId`, `password` | `token`, `returnCode`, `message`, `expiredDateTime` |
| `POST /dynamicqr` | `token`, `sourceId`, `transCurrency` (104 = MMK), `transAmount` (number), `purposeOfTransaction`, `referenceNo` (ours, ≤ 25), `merchantId`, `terminalId` | `returnCode`, `message`, `referenceNo`, `qrCodeInfo` (EMVCo string), `qrReferenceNo` (CB's), `qrIssuedDateTime`, `qrExpiredDateTime` |
| `PATCH /dynamicqr/{qrReferenceNo}/status` | `token`, `sourceId` | `referenceNo`, `returnCode`, `transactionId`, `transCurrency`, `transDateTime`, `transAmount`, `qrReferenceNo`, `institutionId`, `institutionName`, `merchantId`, `message`, `remark` |
| `POST /payment/refund` | — | out of scope |

- Timestamps look like `20201117 10:14:14`, with no timezone. The spec's example expiry is
  3 minutes after issue.
- **Callback:** CB POSTs to the URL we register, exactly as given (confirmed 2026-10-29). Body:
  `apiKey` (a static shared secret), `referenceNo`, `transactionId`, `transCurrency`,
  `transAmount`, `transDateTime`, `transStatusCode`, `transStatusDescription`
  (`SUCCESS` | `FAIL`), `qrReferenceNo`, `institutionId`, `institutionName`, `merchantId`,
  `remark`, `terminalId`. **No signature.** We reply `qrReferenceNo`, `returnCode`, `message`.
- **Return codes** (§4.2; the duplicates are in CB's spec): `0000` succeeded; `0003`
  reference already exists; `0006` both "Invalid Reference No." and "Waiting for payment";
  `0007` failed; `0008` in progress; `0009` refunded; `0012` token expired; `0017` and `0018`
  each have two meanings; `0026` reference doesn't exist; `0051` amount below 1,000; `0052`
  amount above the maximum (value not given). **There is no "expired" code.**
- CB on `0006`: the reference only exists once the payment completes; use the status check.
- CB whitelists caller IPs. UAT: the app runs locally on the office IP and the callback goes
  through a Cloudflare tunnel. Live egress is undecided (gate G3).

## 4. Architecture

### 4.1 New modules

| File | Responsibility |
|---|---|
| `src/lib/cbmmqr.ts` | Pure client, no Supabase or Next.js imports: token, `createDynamicQr()`, `checkStatus()`, `buildReferenceNo()`, timestamp parsing, return-code mapping, currency `104` ↔ `MMK`. Same call timeout, IPv4 agent and optional `CBMMQR_PROXY_URL` hook as `kbzpay.ts`. |
| `src/server/payments/cbmmqrMerchant.ts` | Per-merchant config lookup and validation (§6). |
| `src/server/payments/cbmmqrOrderWindow.ts` | "The QR must not outlive the enrollment" — pre-check and post-check (§5.1). |
| `src/server/payments/resolveCbmmqrOrder.ts` | `isConfirmedDead()` and the unresolved-row procedure (§5.2), shared by the create and status routes. |
| `src/server/payments/settleCbmmqrPayment.ts` | Settlement wrapper (§5.5): field checks, then the `bind_cbmmqr_settlement` RPC, then `settleMmqrPayment()` unchanged. |
| `src/app/api/public/payments/cbmmqr/route.ts` | `POST` — create the QR. |
| `src/app/api/public/payments/cbmmqr/status/route.ts` | `GET` — browser poller. |
| `src/app/api/webhooks/cbmmqr/route.ts` | `POST` — callback receiver. |
| `src/components/payments/CbMmqrCard.tsx` | CB's WebFrame card (§7.1). |

### 4.2 Modified files

Every place that lists MMQR providers learns `cbmmqr` **in the same change**. Two of them
currently map any unknown provider to MMPay, so a partial change would silently show
BeatsRun buyers an MMPay QR.

- `src/types/database.ts:131` — `mmqr_provider` is still `"abank" | "mmpay"` (it never
  gained `kbzpay`); it becomes `"abank" | "mmpay" | "kbzpay" | "cbmmqr"`.
- `src/components/payments/QRPaymentModal.tsx` — `QRProvider`, endpoint map (today an
  unknown provider falls to `/api/public/payments/mmpay`), CB card, no centre logo, the new
  states (§7.2).
- `src/app/(public)/enroll/[slug]/checkout/payment/page.tsx:698-701` — the provider mapping
  sends anything other than `abank`/`kbzpay` to `mmpay`; add `cbmmqr`.
- `src/app/(public)/enroll/payment/[ref]/page.tsx:58` — provider union.
- `src/app/admin/settings/page.tsx` — provider union and option.
- Regression tests (§9) prove `cbmmqr` reaches the CB endpoint from both payment pages and
  never falls through to MMPay.
- `src/mocks/handlers.ts` — MSW handlers for the CB calls.
- `.env.local.example` — the variables in §6.

### 4.3 Data model — one migration

- **`public.cbmmqr_merchant_assignments`** `(tenant_id uuid PK → tenants, merchant_id text
  CHECK '^[A-Z][A-Z0-9_]{1,31}$', created_at, updated_at)`. RLS on, no policies, `REVOKE ALL`
  from `public`, `anon`, `authenticated`, and an explicit `GRANT SELECT, INSERT, UPDATE,
  DELETE … TO service_role` so the operator can add, rotate and remove assignments (the RPCs
  run as owner and do not need it). Same shape as
  `kbzpay_merchant_assignments`, including its `BEFORE UPDATE … EXECUTE FUNCTION
  public.set_updated_at()` trigger (`cbmmqr_merchant_assignments_updated_at`), so a
  reassignment keeps `updated_at` truthful. Seeded with `beatsrun` → `YOUNGMONEY` if that
  tenant exists (a `NOTICE`, not an error, if it does not).
- **`payments.cbmmqr_merchant text`** — the merchant pin.
  - Two-way CHECK: `(payment_method IS NOT DISTINCT FROM 'cb_mmqr') = (cbmmqr_merchant IS NOT
    NULL)`.
  - A **new** trigger `protect_payment_cbmmqr_fields()` (KBZPay's trigger is not reused or
    changed): on insert of a `cb_mmqr` row the pin must equal the tenant's current
    assignment; on update neither the pin nor `tenant_id` may change.
  - Status checks and callback key checks always use the **pin**, never the tenant's current
    assignment.
- **`payments.provider_order_ref text`** — CB's `qrReferenceNo`. Partial unique index `WHERE
  provider_order_ref IS NOT NULL`. The same trigger allows it only on `cb_mmqr` rows and only
  NULL → value; any later change is rejected. Writers use the compare-and-set predicate
  `provider_order_ref IS NULL OR provider_order_ref = <incoming>`.
- **`bank_reference`** on `cb_mmqr` rows (CB `transactionId`) follows the same NULL → value
  rule in that trigger.
- **Partial unique index on `bank_reference`** `WHERE payment_method = 'cb_mmqr' AND
  bank_reference IS NOT NULL` — CB's `transactionId` cannot settle two payments.
- **One live CB order per enrollment:** partial unique index on `(enrollment_id)` `WHERE
  payment_method = 'cb_mmqr' AND status = 'awaiting_payment' AND mmqr_status = 'PENDING'`.
- **`claim_cbmmqr_order_slot(p_enrollment_id, p_tenant_id, p_payment_ref, p_amount,
  p_platform_fee, p_expires_at)`** → `(outcome, payment_ref, merchant)` with outcome
  `created | reuse | unresolved`.
  - `SECURITY DEFINER`, `SET search_path = public`, `EXECUTE` to `service_role` only.
  - Locks the enrollment `FOR UPDATE`, then the tenant's assignment `FOR SHARE` (same order
    as the KBZPay functions); no assignment → raises.
  - Re-checks tenant ownership and that the enrollment is `pending_payment` or
    `partial_payment` under the lock.
  - `reuse` only when the live row has the same amount and platform fee, a non-null
    `provider_qr`, and `now()` is before its `provider_order_expires_at`.
  - Any other live row → `unresolved` with its `payment_ref`; inserts nothing.
  - Otherwise inserts `status = 'awaiting_payment'` (never `pending`, which would fire the
    INSERT branch of `trg_payments_sync_enrollment`), `mmqr_status = 'PENDING'`,
    `payment_method = 'cb_mmqr'`, the pin, `provider_order_expires_at = p_expires_at`.
- **`complete_cbmmqr_replace(p_enrollment_id, p_tenant_id, p_expected_old_ref, p_reason,
  p_new_ref, p_amount, p_platform_fee, p_expires_at)`** → `(outcome, payment_id, merchant)`.
  - Same security, grants and lock order as the claim; selects the enrollment by both
    `p_enrollment_id` and `p_tenant_id` (as `complete_kbzpay_supersede` does).
  - `p_reason IN ('EXPIRED', 'FAILED')` only — there is no `SUPERSEDED` for CB, because
    nothing can be superseded while still payable.
  - Outcomes, checked in this order: `invalid_enrollment` (no such enrollment for that
    tenant); `already_settled` (old row `verified`); `not_live` (old row is not the live
    `PENDING` order); `not_payable` (enrollment no longer `pending_payment` /
    `partial_payment`); `no_merchant` (assignment missing); `replaced` — the old row's
    `mmqr_status` set to `p_reason` and the replacement inserted, atomically.
- **`bind_cbmmqr_settlement(p_payment_ref, p_qr_reference_no, p_transaction_id,
  p_merchant)`** → `bound | duplicate_transaction | mismatch | not_found`. Same security and
  grants. Locks the payment `FOR UPDATE`; requires `payment_method = 'cb_mmqr'`, the pin
  equal to `p_merchant`, and a non-empty `p_transaction_id`; then compare-and-sets
  `provider_order_ref` and `bank_reference` (NULL → value, or equal to the incoming value).
  A different existing value → `mismatch`; a unique violation on `bank_reference` →
  `duplicate_transaction`. This is what binds a CB transaction to this CB QR before any
  status transition (§5.5).
- `COMMENT ON COLUMN tenants.mmqr_provider` gains `cbmmqr` (the column has no CHECK).

The function bodies follow `20260903090000_payments_platform_fee.sql` (platform fee
columns) and `20261030120000_kbzpay_per_tenant_merchants.sql` (pin, locking, grants).

## 5. Flows

### 5.0 Shared rules

- **Time.** CB timestamps are parsed in `CBMMQR_TIMEZONE` (default `Asia/Yangon`, to be
  confirmed — gate G2). An unparseable timestamp makes the QR non-displayable.
- **Constants.** `CB_MAX_QR_MINUTES` — CB's maximum QR validity (3 until CB answers question
  2) — and `CB_EXPIRY_MARGIN_MINUTES` = 2.
- **`isConfirmedDead(statusResponse, row, now)`** — the only code allowed to free the slot of a
  QR that was displayed. True only when `now` is past the row's `provider_order_expires_at`
  plus the margin **and** the status response's return code is in
  `CB_CONFIRMED_DEAD_CODES`. **That set is empty** until gate G1, so until then a displayed QR
  is never replaced. A code may only enter the set if CB guarantees it is final: no
  already-authorised or in-flight payment can settle afterwards, and the status can never
  change to success.
- **Token.** One cache entry per merchant, single-flight, expiring 60 s before
  `expiredDateTime`. On `0012` drop it and retry the call once; `0012` is a rejection, so the
  retry cannot create a second QR.
- **Reference.** `payment_ref` = `CB` + 23 characters of cryptographically random base32
  (≥ 110 bits): 25 characters, distinct from every other provider's format, backed by the
  existing `idx_payments_payment_ref_unique`. A unique violation retries the claim with a new
  reference before any CB call.

### 5.1 Create — `POST /api/public/payments/cbmmqr` `{ enrollmentRef }`

1. Resolve the tenant; load the enrollment scoped to it (404); it must be `pending_payment` or
   `partial_payment` (409).
2. Compute the fee exactly as the KBZPay route (cart items or class × quantity, minus
   `received_amount`, plus the platform fee). **Below 1,000 → 422 `below_minimum`**, no row,
   no CB call.
3. Load the merchant config for the tenant's assignment (§6). Missing or invalid → 503, no
   row, no CB call.
4. **Pre-check.** The enrollment deadline (from `auto_cancel_hours`, which holds minutes,
   as in `kbzpayOrderWindow.ts`) is closer than `CB_MAX_QR_MINUTES` + margin → 409
   `deadline`, no row.
5. Claim the slot with a new reference and `p_expires_at` = now + `CB_MAX_QR_MINUTES` +
   margin (a provisional hint):
   - `reuse` → return the stored QR and expiry. No CB call.
   - `unresolved` → §5.2.
   - `created` → the row exists **before** any CB call (R2).
6. `createDynamicQr` with our reference, the amount, currency 104, and the pinned merchant's
   ids.
   - Transport error, timeout, `0003`, or any code not listed below → **ambiguous**: leave the
     row `PENDING` with no QR and return 502 (R13). It is recovered by §5.2.
   - Definite rejections, where CB created nothing: `0051` → 422 `below_minimum`; `0052` →
     422 `above_maximum`; invalid merchant, terminal, authentication or password codes → 503.
     The row is marked `mmqr_status = 'FAILED'`, which frees the slot.
   - `0000` → require a non-empty `qrCodeInfo` and `qrReferenceNo` (else ambiguous) and parse
     `qrExpiredDateTime`.
7. **Post-check.** CB's expiry at or after the enrollment deadline minus the margin, or
   unparseable → store `provider_order_ref` and the expiry but **not** `provider_qr`, and
   return 409 `deadline`. The QR was never displayed, so it cannot be paid.
8. Store `provider_qr`, `provider_order_ref` and `provider_order_expires_at` = CB's expiry in
   one conditional update that also requires the row to be live and its enrollment still
   `pending_payment` / `partial_payment` (re-checked in the same statement). Zero rows → do
   not return the QR: 409 `deadline` if the enrollment was cancelled or rejected meanwhile,
   else 502; the row stays `PENDING` (R13).
9. Return `{ qr, orderId, amount, expiresAt }`.

**Cancellation or rejection while a QR is displayed.** Auto-cancel and admin rejection are
not changed by this spec. A CB QR is displayed for at most `CB_MAX_QR_MINUTES` (about 3
minutes, against KBZPay's 120), the pre-check keeps auto-cancel outside that window, and step
8 refuses to display a QR for an enrollment that is no longer payable. What remains is an
admin rejecting the enrollment during those minutes and the buyer paying anyway: the payment
settles but cannot re-confirm a rejected enrollment (`fn_block_reconfirm_rejected`), which is
logged loudly and refunded by hand — the same exposure KBZPay already has, over a far shorter
window. Making rejection wait on live provider orders would change shared code for every
provider and is out of scope.

### 5.2 Unresolved — a live row we cannot serve

Reached when the amount changed, the QR is missing, or the stored expiry has passed.

- **The row has `provider_order_ref`** → status check with the **pinned** merchant:
  - success → §5.5 → `{ status: 'already_paid' }` (R10, R11);
  - `isConfirmedDead` → `complete_cbmmqr_replace(reason 'EXPIRED')`, then §5.1 step 6 for the
    new row; `already_settled` → `{ status: 'already_paid' }`;
  - anything else, including a failed status check → 409 `qr_active` with `retryAt` = stored
    expiry + margin. Nothing is replaced.
- **The row has no `provider_order_ref`** — CB's create response was lost or never arrived.
  CB may hold a QR for this reference, but we never received `qrCodeInfo`: the payable
  artefact never reached our server, so it was never displayed and no buyer can scan it.
  - If CB confirms that `referenceNo` is idempotent (question 3), recover by calling
    `createDynamicQr` again with the **same** reference: a returned QR and `qrReferenceNo`
    are stored and served (§5.1 steps 7–8); `0003` without them stays ambiguous.
  - Otherwise, once now is past the row's `created_at` + `CB_MAX_QR_MINUTES` + margin →
    `complete_cbmmqr_replace(reason 'FAILED')`; before that → 409 `qr_active`.

  This branch frees a slot on elapsed time, which KBZPay's R13 forbids. It is accepted here
  because the R13 hazard — a provider order someone can still pay — needs a QR that was shown
  to a buyer, and this one never was. Holding the slot instead would leave the buyer unable
  to pay at all after a single network failure. See §13 (second review, #5).

**Residual risk.** A replaced row can only be paid if CB accepted payment on a QR whose
"final" status was not final (a breach of G1), or on a QR that never left CB. The callback
still carries our `referenceNo` and the status check proves the money arrived, so §5.5
settles it — refusing would lose a real payment. If the replacement is also paid, both are
logged loudly and one is refunded by hand.

### 5.3 Callback — `POST /api/webhooks/cbmmqr`

1. Body ≤ 8 KB, valid JSON, required fields present with the expected types and lengths →
   else 400.
2. Find the payment by `referenceNo`; it must be `cb_mmqr` → else 404.
3. Compare `apiKey` in constant time with the API key of the merchant **pinned on that
   payment** → else 403. That merchant's config missing → 500.
4. `transStatusDescription = FAIL` → 200 acknowledged; change nothing (the QR may still be
   paid).
5. `SUCCESS` → status check with the callback's `qrReferenceNo` and the pinned merchant's
   credentials → §5.5. **No callback field is used to settle.**
6. Replies:
   - settled or already settled → 200 `{ qrReferenceNo, returnCode: "0000", message }`;
   - §5.5 refuses on a mismatch → logged loudly, 200 acknowledged, no settlement (KBZPay
     parity);
   - status check, configuration or database failure → 500, so CB retries (CB's retry policy
     is question 5).
7. Nothing is derived from the request `Host`.

### 5.4 Status — `GET /api/public/payments/cbmmqr/status?ref=`

Same response shape and time budget as KBZPay's: `{ mmqr_status: PENDING | SUCCESS |
FAILED, expiresAt }`. There is no `EXPIRED` status: local time never says a QR is dead.

- Local `verified` → `SUCCESS`.
- Otherwise, if the row has `provider_order_ref`, one status check; success → §5.5.
- Anything else → `PENDING`, even past `expiresAt`.
- The modal hides the QR once `expiresAt` passes and shows "This QR has expired. If you
  already paid, we are still confirming it." with a "Get a new QR" button. The button calls
  the create route, which serves a new QR only through §5.2 and otherwise answers
  `qr_active`.
- The status route never replaces an order.

### 5.5 Settlement — `settleCbmmqrPayment(statusResponse, payment)`

Input is **always a status-check response** obtained with the pinned merchant's credentials,
never callback fields. It refuses — returning a mismatch outcome and logging the merchant id
and our reference only — unless all of these hold:

- `payment.payment_method = 'cb_mmqr'`;
- the response's `returnCode` is the success code;
- the response's `referenceNo` equals `payment.payment_ref`;
- the response's `merchantId` equals the pinned merchant's configured `merchantId`;
- the response's currency is `104`;
- the response's amount is a whole number;
- the response's `transactionId` is non-empty.

Then, in this order:

1. **`bind_cbmmqr_settlement(payment_ref, qrReferenceNo, transactionId, pin)`** (§4.3)
   atomically binds CB's QR reference and transaction id to this payment, under a lock on
   the payment row. `mismatch`, `duplicate_transaction` or `not_found` → refuse (logged
   loudly; the callback acknowledges). A replay with the same values returns `bound`.
2. **`settleMmqrPayment()`, unchanged** (`paymentRef`, `observedAmount`,
   `observedCurrency: "MMK"`, `mmOrderId` = `transactionId`, `walletIdentifier` =
   `institutionName`). It checks the amount against the snapshot and performs the
   conditional transition and fulfilment. Its write of `bank_reference` writes the value
   step 1 already bound, so the trigger accepts it; a different value cannot reach it.

Because step 1 has already compared `bank_reference`, a later replay that
`settleMmqrPayment()` reports as `already_settled` is known to be the same transaction.

## 6. Configuration

Per deployment:

```
CBMMQR_MODE=uat|production   # production is required on VERCEL_ENV=production, and only there
CBMMQR_BASE_URL=             # CB will send the UAT and Live URLs
CBMMQR_PROXY_URL=            # optional fixed-IP egress; unset for UAT
CBMMQR_TIMEZONE=Asia/Yangon  # until confirmed (G2)
```

Per merchant, where `<ID>` matches `^[A-Z][A-Z0-9_]{1,31}$` (e.g. `YOUNGMONEY`):

```
CBMMQR_<ID>_USER_ID=
CBMMQR_<ID>_PASSWORD=        # secret
CBMMQR_<ID>_SOURCE_ID=
CBMMQR_<ID>_MERCHANT_ID=
CBMMQR_<ID>_TERMINAL_ID=
CBMMQR_<ID>_API_KEY=         # secret; expected on callbacks
CBMMQR_<ID>_NOTIFY_ORIGIN=   # UAT: the tunnel host; Live: https://beatsrun.kuunyi.com
```

- A missing or invalid value is a configuration error. There is no fallback to another
  merchant and no unprefixed set.
- `NOTIFY_ORIGIN` keeps KBZPay's rules (https only, normalised to an origin) and is what is
  registered with CB. The callback path is `/api/webhooks/cbmmqr`.
- Values go in `.env.local` for dev and in Vercel env vars for deployed environments, set with
  `printf`, never `echo`. Secrets are never logged.

## 7. UI

### 7.1 `CbMmqrCard`

CB requires its WebFrame layout (email of 2026-10-29). From CB's sample page and UI guideline:

- full-width MyanmarPay banner (yellow rule, logo and "MyanmarPay" wordmark), not cropped;
- receiver name and amount left-aligned at a 12.5% inset, currency after the amount, amount
  with two decimals (`100,000.00`);
- yellow `#FBD913` dotted rule across the full width;
- "MMQR" centred, **black**;
- QR at 80% of the card width; CB Bank logo at 20% width, centred below it;
- solid `#264EA1` rule at the bottom, 1px grey border;
- Arial (the sample uses Calibri; CB's guideline says Arial);
- 20:29 (the guideline) with its own vertical layout — `MmqrCard`'s spacing does not fit an
  80% QR;
- no mark in the centre of the QR; QR at least 0.6 inches; no account numbers on the card.

`MmqrCard` is unchanged.

### 7.2 `QRPaymentModal`

- Countdown under the card from `expiresAt` ("QR will expire in m:ss"), never a fixed 3
  minutes.
- New states: `below_minimum` ("CB Bank QR needs at least 1,000 MMK"); `above_maximum`;
  `qr_active` ("Your previous QR is still active — try again in m:ss"); QR display time over
  (from `expiresAt`, §5.4: "This QR has expired. If you already paid, we are still confirming
  it." plus "Get a new QR"); `deadline` ("This booking expires too soon for a QR payment");
  plus the existing `already_paid`. Polling continues after the QR is hidden, so a late
  payment still turns into `SUCCESS`.

### 7.3 Admin settings

New option "CB Bank (MMQR — any Myanmar bank app)". As with KBZPay, a tenant that picks it
without an operator assignment gets 503 at checkout, never another merchant's QR; the admin
page cannot read assignments. Assigning a tenant is an operator step recorded in
`docs/clients/<slug>.md`.

## 8. Error handling

| Situation | Response | Payment row |
|---|---|---|
| Amount below 1,000, or CB `0051` | 422 `below_minimum` | none, or `FAILED` |
| CB `0052` | 422 `above_maximum` | `FAILED` |
| No assignment, bad config, CB credential/merchant/terminal codes | 503 | none, or `FAILED` |
| Deadline too close (pre- or post-check) | 409 `deadline` | none, or kept without a QR |
| Transport error, timeout, `0003`, unknown code, missing QR fields | 502 | kept `PENDING` |
| QR store failed after CB success | 502 | kept `PENDING` |
| Previous QR live and not proven dead | 409 `qr_active` + `retryAt` | unchanged |
| Callback malformed / unknown reference / bad key | 400 / 404 / 403 | unchanged |
| Callback that §5.5 refuses | 200, logged loudly | unchanged |
| Callback status-check or database failure | 500 | unchanged |

Log lines carry the merchant id and our reference, never passwords, API keys or tokens.

## 9. Testing

Mirrors the KBZPay suites in `src/__tests__/payments/` and `src/__tests__/db/`:

- `cbmmqr-client.test.ts` — request shapes; timestamp parsing in `Asia/Yangon`; token cache
  (single-flight, refresh on `0012`, one retry only); return-code mapping including the
  duplicated `0006`, `0017` and `0018`; currency `104` ↔ `MMK`; reference format, length and
  entropy.
- `cbmmqr-merchant.test.ts` — per-merchant config, no fallback, invalid `<ID>`, notify origin
  rules.
- `cbmmqr-order-window.test.ts` — pre- and post-checks at the boundaries; unparseable expiry.
- `cbmmqr-create-route.test.ts` — every row of §8; row written before the CB call; reuse;
  definite vs ambiguous rejections; lost response.
- `cbmmqr-resolve.test.ts` — with `CB_CONFIRMED_DEAD_CODES` empty, a displayed QR is never
  freed; the no-`provider_order_ref` branch frees only after the window.
- `cbmmqr-settle.test.ts` — the wrapper refuses on each condition of §5.5 and on each
  non-`bound` outcome of the binding RPC; a replay with the same transaction is
  `already_settled`; a second, different transaction for the same payment is refused.
- `cbmmqr-status-route.test.ts` — never reports a QR dead from local time; `PENDING` past
  `expiresAt`.
- `cbmmqr-provider-dispatch.test.tsx` — `cbmmqr` reaches `/api/public/payments/cbmmqr` from
  both payment pages and the modal, and never falls through to MMPay.
- `cbmmqr-webhook-route.test.ts` — size and shape limits; constant-time key check against the
  pinned merchant; `FAIL` changes nothing; settlement only through the status check; replies.
- `cbmmqr-modal.test.ts`, `cbMmqrCard.test.tsx`.
- `cbmmqr-create-route.test.ts` also covers: enrollment rejected or cancelled between the CB
  call and step 8 → the QR is not returned.
- `src/__tests__/db/cbmmqr-order-slot.db.test.ts` — concurrent claims, one live order;
  every `complete_cbmmqr_replace` outcome including the wrong tenant; replace vs settlement
  race (`already_settled`); the trigger (pin, `tenant_id`, NULL → value only for
  `provider_order_ref` and `bank_reference`); `bind_cbmmqr_settlement` outcomes and two
  concurrent binds with different transaction ids; reassigning a tenant in
  `cbmmqr_merchant_assignments` advances `updated_at`; grants: `service_role` can select,
  insert, update and delete assignments, `anon` and `authenticated` can do none of these, and
  only `service_role` can execute the three RPCs.
- The existing KBZPay, ABank and MMPay suites pass unchanged.

## 10. Rollout and gates

1. Code and migration go to **dev** only, through a PR to `dev`. The migration is applied to
   the dev DB after its diff is shown. Production receives nothing from this spec.
2. UAT runs locally on the office IP behind the tunnel, with `CBMMQR_<ID>_NOTIFY_ORIGIN` set to
   the tunnel host.
3. **Go-live gates** — all required before any production use:
   - **G1** CB confirms in writing which status response is a **final** unpaid state (no
     in-flight or later payment can settle) and UAT reproduces it; only then is
     `CB_CONFIRMED_DEAD_CODES` filled. If CB cannot, the set stays empty and changed amounts
     are resolved by an operator — launch is still possible, without automatic replacement.
   - **G2** `qrExpiredDateTime` timezone and maximum validity confirmed (question 2).
   - **G3** Live egress decided and its IP whitelisted by CB.
   - **G4** Central Bank of Myanmar approves the CB card mockup (required by CB's UI
     guideline).
   - **G5** One real end-to-end UAT payment of at least 1,000 MMK: callback, status check,
     settlement, ticket.
   - **G6** The production migration is applied **before** the code reaches main.

## 11. Questions for CB

To send with the office IP and the tunnel callback URL:

1. Which status-check response proves an expired QR can never be paid? (G1)
2. Is `qrExpiredDateTime` authoritative, in which timezone, what is the maximum validity, and
   can the merchant set it? (G2)
3. Is `referenceNo` idempotent on `/dynamicqr` (does a repeat return the same QR and
   `qrReferenceNo`, or `0003`)? Can the status be looked up by our `referenceNo`?
4. Which status-response fields are authoritative for amount, currency, merchant and
   transaction id?
5. How does CB retry a callback — how often, for how long — and which reply counts as
   acknowledged?
6. Callback source IP ranges, and is a signed callback available?
7. The maximum amount per transaction (`0052`), and does the 1,000 minimum apply in UAT?

## 12. Out of scope

Refunds; a durable exception queue (KBZPay parity: log loudly and acknowledge); a
tenant-visible merchant UI; any change to KBZPay, ABank or MMPay; signed callbacks unless CB
offers them.

## 13. Review history

**Codex, revision 1 (Part 1 draft), 2026-10-31** — 10 findings:

| # | Finding | Outcome |
|---|---|---|
| 1 | P0 — "expired + unpaid → replace" is not provable without a close call or an expired code | Accepted as gate G1 (§5.0, `CB_CONFIRMED_DEAD_CODES` starts empty). |
| 2 | P0 — a lost create response leaves no `qrReferenceNo` to query | **Downgraded to P2.** The QR was never displayed, so it cannot be paid; recovery after the window (§5.2); residual risk stated. |
| 3 | P0 — a static callback `apiKey` is not enough to settle | Accepted: the callback only triggers our own status check (§5.3, §5.5). |
| 4 | P0 — the QR could outlive the enrollment | Accepted: pre-check and post-check; an over-long QR is never displayed (§5.1). |
| 5 | P1 — the pin needs a trigger, not only a CHECK | Accepted (§4.3). |
| 6 | P1 — `settleMmqrPayment()` alone does not prove the payment is this CB QR | Accepted: wrapper (§5.5). |
| 7 | P1 — transaction id uniqueness and mismatch handling | Unique index accepted; durable exception queue out of scope. |
| 8 | P1 — RPC contracts underspecified | Accepted (§4.3). |
| 9 | P1 — reference format must be collision-safe | Accepted (§5.0). |
| 10 | P2 — every provider touch point must be listed | Accepted (§4.2). |

**Codex, revision 2 (full spec), 2026-10-31** — 9 findings:

| # | Finding | Outcome |
|---|---|---|
| 1 | P0 — a QR can be displayed after the enrollment is cancelled or rejected | **Partly accepted.** Step 8 now re-checks the enrollment in the same statement and withholds the QR (§5.1). Making rejection wait on live provider orders is out of scope; the remaining exposure is the same as KBZPay's over a ~3-minute window, stated in §5.1. |
| 2 | P0 — a "dead" code is not enough without a finality guarantee | Accepted: G1 and `isConfirmedDead` require finality; without it, no automatic replacement (§2, §5.0, §10). |
| 3 | P1 — duplicate `transactionId` cannot be a mismatch through `settleMmqrPayment()` | Accepted: `bind_cbmmqr_settlement` RPC (§4.3, §5.5). |
| 4 | P1 — binding the QR reference is not atomic with settlement | Accepted: same RPC binds under a row lock before the transition. |
| 5 | P1 — freeing a lost-response slot on elapsed time breaks R13 | **Disagreed in part.** R13 protects against a payable provider order; a QR whose payload never reached us cannot be scanned by anyone, and holding the slot would leave the buyer unable to pay after one network failure. Added: recovery by idempotent re-create if CB confirms it (question 3), and the reasoning in §5.2. |
| 6 | P1 — replace function lacks `p_tenant_id` and full outcomes | Accepted (§4.3). |
| 7 | P2 — status route called a QR `EXPIRED` from local time | Accepted: no `EXPIRED` status; the modal hides an expired QR and keeps polling (§5.4, §7.2). |
| 8 | P2 — the KBZPay trigger does not cover `provider_order_ref` | Accepted: a new CB trigger with NULL → value rules (§4.3). |
| 9 | P3 — touch points not precise; `database.ts` lacks `kbzpay` | Accepted: exact lines and a dispatch regression test (§4.2, §9). |

**Codex, revision 3 (PR review), 2026-10-31** — 1 finding:

| # | Finding | Outcome |
|---|---|---|
| 1 | P2 — `cbmmqr_merchant_assignments` has `updated_at` but no `set_updated_at()` trigger, unlike the KBZPay table | Accepted: trigger added to §4.3 and covered in the database test (§9). |

**Codex, revision 4 (PR review), 2026-10-31** — 1 finding:

| # | Finding | Outcome |
|---|---|---|
| 1 | P1 — the assignment table is "service_role only" but the design only revokes; it never grants `service_role`, so the operator could not manage assignments | Accepted: explicit `GRANT SELECT, INSERT, UPDATE, DELETE … TO service_role` (§4.3), as the KBZPay migration does; grants tested for `service_role`, `anon` and `authenticated` (§9). |
