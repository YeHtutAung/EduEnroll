# HitPay Embedded Payments Integration — Design Spec

**Date:** 2026-07-09
**Status:** Approved for implementation
**Currency:** SGD (Singapore only)
**Integration type:** Embedded Payments — QR Code (PayNow) + Hosted Checkout (Card)

---

## 1. Overview

Add HitPay as a new `payment_mode` option alongside the existing `bank_transfer | mmqr | stripe | paypay` modes. When a tenant selects HitPay, students on the payment page see two sub-options: a PayNow QR code embedded directly in the UI, or a Visa/Mastercard card payment via HitPay's hosted checkout.

HitPay's API requires one payment method per request. PayNow and Card are therefore separate requests, presented as tabs in the UI. Both are confirmed by webhook only — the redirect and QR scan only update the UI state.

---

## 2. Data Layer

### 2.1 Migration — `supabase/migrations/087_hitpay_support.sql`

```sql
-- 1. Add hitpay_payment_id to payments
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS hitpay_payment_id text;

-- 2. Update payment_mode comment
COMMENT ON COLUMN public.tenants.payment_mode IS
  'bank_transfer | mmqr | stripe | paypay | hitpay';

-- 3. Update payment_method comment
COMMENT ON COLUMN public.payments.payment_method IS
  'manual_upload | abank_mmqr | mmqr | stripe | paypay | hitpay';
```

### 2.2 TypeScript — `src/types/database.ts`

Add to the `Payment` interface:

```ts
hitpay_payment_id: string | null;  // HitPay payment request ID
```

### 2.3 Environment Variables

```
HITPAY_API_KEY=        # from HitPay dashboard → API Keys
HITPAY_SALT=           # from HitPay dashboard → Webhook salt (for HMAC verification)
HITPAY_MODE=sandbox    # sandbox | production
```

Keys stay in env vars only — never stored in the database or exposed to the client.

---

## 3. HitPay API Client — `src/lib/hitpay.ts`

Follows the same pattern as `src/lib/paypay.ts`.

### 3.1 Constants

```ts
const API_KEY  = () => process.env.HITPAY_API_KEY!;
const SALT     = () => process.env.HITPAY_SALT!;
const BASE_URL = () =>
  process.env.HITPAY_MODE === "production"
    ? "https://api.hit-pay.com/v1"
    : "https://api.sandbox.hit-pay.com/v1";
```

Auth header: `X-BUSINESS-API-KEY: <key>` on all requests.

### 3.2 `createPaymentRequest(params)`

`POST /v1/payment-requests`

**PayNow (QR) params:**
```ts
{
  amount: string,           // e.g. "50.00"
  currency: "SGD",
  payment_methods: ["paynow_online"],
  generate_qr: true,
  reference_number: string, // enrollmentRef
  name?: string,
  email?: string,
}
```
Returns: `qr_code_data.qr_code` (raw PayNow EMV string) + `id` (payment request ID).

**Card params:**
```ts
{
  amount: string,
  currency: "SGD",
  payment_methods: ["card"],
  redirect_url: string,     // back to payment page with ?hitpay=success&reference=<id>
  reference_number: string,
  name?: string,
  email?: string,
}
```
Returns: `url` (HitPay hosted checkout URL) + `id`.

### 3.3 `verifyWebhook(bodyText, signature)`

HMAC-SHA256 of raw body using `HITPAY_SALT`. Timing-safe compare. Returns `boolean`.

```ts
const computed = crypto.createHmac("sha256", SALT()).update(bodyText).digest("hex");
return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
```

### 3.4 `parseWebhookPayload(bodyText)`

Parses raw JSON. Key fields:
- `id` — payment request ID (matches `hitpay_payment_id` on `payments` row)
- `status` — `"completed"` | `"pending"` | `"failed"`
- `payments[0].payment_type` — e.g. `"paynow_online"` | `"card"`

---

## 4. API Routes

### 4.1 `POST /api/public/payments/hitpay`

**Body:** `{ enrollmentRef: string, method: "paynow_online" | "card" }`

**Flow:**
1. Resolve `tenantId` via `resolveTenantId()`
2. Look up enrollment — select class fee, enrollment items, status
3. Guard: only allow `pending_payment` or `partial_payment`
4. Calculate total fee (single class or cart; subtract `received_amount` for partial)
5. Build `redirectUrl` for card: `${proto}://${host}/enroll/payment/${enrollmentRef}?hitpay=success`
6. Call `hitpay.createPaymentRequest()` with the resolved params
7. Insert `payments` row:
   ```ts
   {
     enrollment_id, tenant_id,
     amount: totalFee,
     payment_method: "hitpay",
     hitpay_payment_id: result.id,
     status: "awaiting_payment",
   }
   ```
8. Return:
   - PayNow: `{ qrCode: result.qr_code_data.qr_code, paymentRequestId: result.id, amount }`
   - Card: `{ url: result.url, paymentRequestId: result.id, amount }`

### 4.2 `GET /api/public/payments/hitpay/status?ref=<enrollmentRef>`

Polls enrollment status for the QR polling loop.

Returns: `{ enrollmentStatus: string }` — client polls every 3s, redirects to success when `enrollmentStatus === "confirmed"`.

Same pattern as `GET /api/public/payments/paypay/status`.

### 4.3 `POST /api/webhooks/hitpay`

Webhook handler for `payment_request.completed` events.

**Flow:**
1. Read raw body text (`request.text()`) + `Hitpay-Signature` header
2. Verify signature — return `403` if invalid or missing
3. Parse payload — return `200` immediately if `status !== "completed"` (idempotent)
4. Find `payments` row by `hitpay_payment_id = payload.id`
5. Return `200` if payment not found (may be from another system) or already `verified`
6. Update payment: `status → "verified"`, `verified_at → now`
7. Update enrollment: `status → "confirmed"`
8. Call `dispatchPaymentApproved(...)` — reuses existing notification fan-out (email, SMS, Messenger, Telegram, channel invite)

Always return `200` — HitPay retries on non-200.

---

## 5. Payment UI — `src/app/(public)/enroll/payment/[ref]/page.tsx`

When `enrollment.payment_mode === "hitpay"` and enrollment status is `pending_payment` or `partial_payment`:

### 5.1 Tab Selector

Two pills: **PayNow** | **Card**. Default: PayNow tab.

### 5.2 PayNow Tab

1. "Generate QR" button → `POST /api/public/payments/hitpay` `{ enrollmentRef, method: "paynow_online" }`
2. On response: render `qrCode` string as image via `QRCode.toDataURL()` (same as `QRPaymentModal.tsx`)
3. Show QR image with instruction: "Scan with your banking app (PayNow)"
4. Start polling `GET /api/public/payments/hitpay/status?ref=` every 3s
5. On `enrollmentStatus === "confirmed"` → redirect to success page
6. "Cancel" button → clears QR, stops polling

### 5.3 Card Tab

1. "Pay by Card" button → `POST /api/public/payments/hitpay` `{ enrollmentRef, method: "card" }`
2. On response: `window.location.href = url` (full-page redirect to HitPay hosted checkout)
3. HitPay redirects back to payment page with `?hitpay=success&reference=<id>`
4. Page detects `?hitpay=success` on load → shows "Payment processing…" banner
5. Webhook confirms enrollment asynchronously — student sees status update when page polls or refreshes

### 5.4 URL Parameter Handling

On page load, check for `?hitpay=success`:
- Set `hitpayReturn = "success"` state
- Show info banner: "Payment received — confirming your enrollment…"
- Do not mark enrollment as paid based on redirect alone (webhook is authoritative)

---

## 6. Admin Settings — `src/app/admin/settings/page.tsx`

- Add `"hitpay"` to `paymentMode` type: `"bank_transfer" | "mmqr" | "stripe" | "paypay" | "hitpay"`
- Add button to payment mode selector grid:
  - Label: **HitPay**
  - Subtitle: `PayNow QR + Card (SGD)`
- Add info card when `paymentMode === "hitpay"`:
  > Students can pay via PayNow QR or Visa/Mastercard. Auto-confirmed via webhook — no manual verification needed. Set `HITPAY_API_KEY` and `HITPAY_SALT` in your environment variables.

---

## 7. Webhook Registration

Register in HitPay Dashboard → Developers → Webhook Endpoints:
- **URL:** `https://kuunyi.com/api/webhooks/hitpay`
- **Event:** `payment_request.completed`

---

## 8. Files Changed

| File | Change |
|---|---|
| `supabase/migrations/087_hitpay_support.sql` | New — DB migration |
| `src/lib/hitpay.ts` | New — API client |
| `src/app/api/public/payments/hitpay/route.ts` | New — create payment request |
| `src/app/api/public/payments/hitpay/status/route.ts` | New — QR polling status |
| `src/app/api/webhooks/hitpay/route.ts` | New — webhook handler |
| `src/types/database.ts` | Add `hitpay_payment_id` to `Payment` |
| `src/app/admin/settings/page.tsx` | Add HitPay payment mode option |
| `src/app/(public)/enroll/payment/[ref]/page.tsx` | Add HitPay payment UI (tabs) |

---

## 9. Out of Scope

- Other HitPay payment methods (GrabPay, DuitNow, etc.) — SGD/PayNow + Card only for now
- Recurring billing or saved payment methods
- Borderless QR (cross-border currency conversion)
- Refund flow via HitPay API
