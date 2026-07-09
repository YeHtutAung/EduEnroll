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
-- 1. Add hitpay_payment_id to payments + index for webhook lookups
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS hitpay_payment_id text;

CREATE INDEX IF NOT EXISTS payments_hitpay_payment_id_idx
  ON public.payments (hitpay_payment_id)
  WHERE hitpay_payment_id IS NOT NULL;

-- 2. Update payment_mode comment
COMMENT ON COLUMN public.tenants.payment_mode IS
  'bank_transfer | mmqr | stripe | paypay | hitpay';

-- 3. Update payment_method comment
-- Both PayNow and Card sub-flows share the same "hitpay" value.
-- The payment sub-type (paynow_online vs card) is available in the
-- webhook payload (payments[0].payment_type) but is not stored separately.
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
                       # If absent or any value other than "production", falls back to
                       # sandbox URLs — this is intentional safe-default behaviour.
```

Keys stay in env vars only — never stored in the database or exposed to the client.

### 2.4 NPM Dependencies

`qrcode` is already installed (used by `src/components/payments/QRPaymentModal.tsx`). No new packages needed.

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

Auth header: `X-BUSINESS-API-KEY: <key>` + `X-Requested-With: XMLHttpRequest` on all requests.

### 3.2 `createPaymentRequest(params)`

`POST /v1/payment-requests`

**PayNow (QR) params:**
```ts
{
  amount: string,           // e.g. "50.00" — decimal string, not integer
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
  redirect_url: string,     // back to payment page with ?hitpay=success
  reference_number: string,
  name?: string,
  email?: string,
}
```
Returns: `url` (HitPay hosted checkout URL) + `id`.

### 3.3 `verifyWebhook(bodyText, signature)`

HMAC-SHA256 of raw body using `HITPAY_SALT`. Guards buffer length mismatch before calling `timingSafeEqual` (same pattern as paypay client):

```ts
function verifyWebhook(bodyText: string, signature: string): boolean {
  const computed = crypto.createHmac("sha256", SALT()).update(bodyText).digest("hex");
  const computedBuf = Buffer.from(computed);
  const signatureBuf = Buffer.from(signature);
  if (computedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(computedBuf, signatureBuf);
}
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
5. **Duplicate guard:** check for existing `payments` row where `enrollment_id = enrollment.id` AND `hitpay_payment_id IS NOT NULL` AND `status = "awaiting_payment"`. If found, return the existing `hitpay_payment_id` to the client without calling HitPay again. This prevents double-charging when a student taps the button twice.
6. Build `redirectUrl` for card: `${proto}://${host}/enroll/payment/${enrollmentRef}?hitpay=success`
7. Format amount as decimal string: `(totalFee / 100).toFixed(2)` if stored in minor units, or `String(totalFee)` if already in SGD — confirm against how fee is stored for MMK tenants. (For SGD tenants, fee is stored in cents; divide by 100.)
8. Call `hitpay.createPaymentRequest()` with the resolved params
9. Insert `payments` row:
   ```ts
   {
     enrollment_id, tenant_id,
     amount: totalFee,
     payment_method: "hitpay",   // same value for both paynow and card sub-flows
     hitpay_payment_id: result.id,
     status: "awaiting_payment",
   }
   ```
10. Return:
    - PayNow: `{ qrCode: result.qr_code_data.qr_code, paymentRequestId: result.id, amount }`
    - Card: `{ url: result.url, paymentRequestId: result.id, amount }`

### 4.2 `GET /api/public/payments/hitpay/status?ref=<enrollmentRef>`

**Purpose:** Local DB poll for QR payment completion. No call to HitPay's API — the webhook is the sole source of truth. This route reads the current enrollment status from Supabase.

**Note:** This differs from the paypay/status route which polls the PayPay API directly. HitPay has no equivalent polling endpoint, so this route is purely a DB read.

**Query:** Look up enrollment by `enrollment_ref + tenant_id`, return its `status`.

**Response:**
```ts
{ enrollmentStatus: "pending_payment" | "confirmed" | "rejected" | "cancelled" }
```

**Client behaviour:**
- Poll every 3 seconds while `enrollmentStatus === "pending_payment"`
- Redirect to success page when `enrollmentStatus === "confirmed"`
- Show error and stop polling when `enrollmentStatus === "rejected"` (payment failed — see Section 4.3)
- Stop polling on any other terminal status

### 4.3 `POST /api/webhooks/hitpay`

Webhook handler for HitPay events.

**Flow:**
1. Read raw body text (`request.text()`) + `Hitpay-Signature` header
2. Reject missing signature with `403`
3. Verify signature with `hitpay.verifyWebhook()` — reject with `403` if invalid
4. Parse payload with `hitpay.parseWebhookPayload()`
5. **Handle `failed` status:** if `payload.status === "failed"`, find the `payments` row by `.eq("hitpay_payment_id", payload.id)` and update `status → "rejected"`. This lets the QR polling loop terminate gracefully. Return `200`.
6. If `payload.status !== "completed"` (and not `"failed"`), return `200` immediately (idempotent)
7. Find `payments` row: `.from("payments").select(...).eq("hitpay_payment_id", payload.id).single()`
8. Return `200` if not found (may belong to another system) or already `verified` (replay guard)
9. Update payment: `status → "verified"`, `verified_at → now`
10. Update enrollment: `status → "confirmed"`
11. Fetch notification data (same pattern as paypay webhook):
    - Enrollment: `enrollment_ref`, `student_name_en`, `email`, `phone`, `form_data`, `messenger_psid`, `telegram_chat_id`, `class_id`
    - Class: `level` (for `classLevel`)
    - Tenant: `name`, `org_type`, `logo_url`, `currency`, `sms_on_payment`
    - Resolve `email` and `phone` from `form_data` fallbacks using `resolveEmailFromFormData` / `resolvePhoneFromFormData`
12. Call `dispatchPaymentApproved({ tenantId, enrollmentId, enrollmentRef, studentName, classLevel, feeFormatted, statusUrl, paymentUrl, currency, email, phone, messengerPsid, telegramChatId, classId, tenantName, orgType, logoUrl, smsOnPayment })`
13. Always return `200` — HitPay retries on non-200

---

## 5. Payment UI — `src/app/(public)/enroll/payment/[ref]/page.tsx`

When `enrollment.payment_mode === "hitpay"` and enrollment status is `pending_payment` or `partial_payment`:

### 5.1 Tab Selector

Two pills: **PayNow** | **Card**. Default: PayNow tab.

### 5.2 PayNow Tab

1. "Generate QR" button → `POST /api/public/payments/hitpay` `{ enrollmentRef, method: "paynow_online" }`
2. On response: render `qrCode` string as image via `QRCode.toDataURL()` (same as `QRPaymentModal.tsx`, width 280, margin 2)
3. Show QR image with instruction: "Scan with your banking app (PayNow)"
4. Start polling `GET /api/public/payments/hitpay/status?ref=` every 3s
5. On `enrollmentStatus === "confirmed"` → redirect to success page
6. On `enrollmentStatus === "rejected"` → show error: "Payment failed. Please try again." Stop polling, hide QR
7. "Cancel" button → clears QR, stops polling

### 5.3 Card Tab

1. "Pay by Card" button → `POST /api/public/payments/hitpay` `{ enrollmentRef, method: "card" }`
2. On response: `window.location.href = url` (full-page redirect to HitPay hosted checkout)
3. HitPay redirects back to payment page with `?hitpay=success&reference=<id>`
4. The `reference` query param (HitPay payment request ID) is **ignored** — the webhook is the sole authority for confirming payment. Do not use `reference` to query status.
5. Page detects `?hitpay=success` on load → shows "Payment received — confirming your enrollment…" banner
6. Webhook confirms enrollment asynchronously — student sees confirmed status on page refresh or via existing enrollment status polling

### 5.4 URL Parameter Handling

On page load, check `?hitpay=success`:
- Set `hitpayReturn = "success"` state
- Show info banner: "Payment received — confirming your enrollment…"
- Do not mark enrollment as paid based on this redirect alone

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
| `supabase/migrations/087_hitpay_support.sql` | New — DB migration + index |
| `src/lib/hitpay.ts` | New — API client |
| `src/app/api/public/payments/hitpay/route.ts` | New — create payment request |
| `src/app/api/public/payments/hitpay/status/route.ts` | New — QR polling (DB read only) |
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
