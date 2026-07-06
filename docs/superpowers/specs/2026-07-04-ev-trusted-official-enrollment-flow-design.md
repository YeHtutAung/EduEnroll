# Design Spec: EvTrustedOfficial Enrollment Flow

**Date:** 2026-07-04
**Status:** Approved for implementation
**Reference designs:** `docs/ui/EduEnroll UI design exploration/`

---

## Overview

A new "Trusted Official" event ticketing flow for EduEnroll's **event** tenant type. Visual direction: navy + gold, structured, high-trust (matches option 3a/3b in the wireframes file). Covers 4 screens: ticket selection, attendee details, payment (Card + PayNow via Stripe Elements), and success/e-ticket.

This is an **additive** implementation — existing templates and shared enrollment routes remain untouched.

---

## Scope

- **In scope:** `Ev*` template family only. Language-school (`Ls*`) templates are not affected.
- **Out of scope:** MMQR/bank transfer flow, existing shared enrollment routes.

---

## Template ID

The new template uses `template_id = "ev-trusted-official"` in the `tenant_appearance` table.

**Code change in `/enroll/[slug]/page.tsx`:** Add a redirect check **before** line 297 (before the `newStyleIds` block):

```ts
// Redirect ev-trusted-official to its dedicated ticket-selection page
if (appearance.template_id === "ev-trusted-official") {
  router.replace(`/enroll/${params.slug}/tickets/`);
  return null;
}
```

Do **not** add `"ev-trusted-official"` to the `newStyleIds` array — that array is for templates that render inline. The new template has its own dedicated route.

No DB migration needed for the template ID itself — `template_id` is a plain text column.

---

## Route Structure

New dedicated routes under the existing `(public)` route group. The existing `/enroll/form/` and `/enroll/payment/[ref]/` shared routes are **not modified**.

```
src/app/(public)/enroll/[slug]/
  tickets/
    page.tsx          # Screen 1: Ticket selection
  checkout/
    page.tsx          # Screen 2: Attendee details
    payment/
      page.tsx        # Screen 3: Card / PayNow (Stripe Elements)
    success/
      page.tsx        # Screen 4: E-ticket confirmation

src/components/enrollment/templates/
  EvTrustedOfficialTemplate.tsx   # New template component

src/app/api/public/
  enrollment/
    [ref]/
      route.ts        # GET — fetch enrollment summary by ref
                      # PATCH — update attendee details on pending enrollment

  payments/stripe/
    intent/
      route.ts        # POST — create PaymentIntent (card + paynow)
      status/
        route.ts      # GET  — poll PaymentIntent status (for PayNow)
```

**Note:** New enrollment-by-ref routes are under `/api/public/enrollment/[ref]/` (singular "enrollment") — not `/api/public/enroll/[ref]/`. This avoids any collision with the existing `/api/public/enroll/[slug]/route.ts` which returns intake + class data.

---

## DB Migration Required

### 1. Add `stripe_payment_intent_id` to `payments` table

```sql
ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text;
CREATE INDEX IF NOT EXISTS payments_stripe_payment_intent_id_idx
  ON payments(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
```

The existing `stripe_session_id` column is **not repurposed** — it continues to store Checkout Session IDs for the existing Stripe Checkout flow.

### 2. Add `card_brand` and `card_last4` to `payments` table

```sql
ALTER TABLE payments ADD COLUMN IF NOT EXISTS card_brand text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS card_last4 text;
```

These are populated by the `GET /api/public/payments/stripe/intent/status` route when payment succeeds (retrieved from `paymentIntent.payment_method_details.card`). Screen 4 uses them to display `"Visa ••4242"`. If null (e.g. PayNow), Screen 4 shows `"PayNow"`.

---

## Data Flow

### Screen 1 → Screen 2 (Cart submit)

1. User selects ticket quantities in `EvTrustedOfficialTemplate`.
2. On "Continue", client calls `POST /api/public/enroll` (existing endpoint, reused as-is).
   - **Important:** `EvTrustedOfficialTemplate` must pass `form_data: {}` (empty object) or omit it entirely. Do NOT pass an email in `form_data` at this step — the existing endpoint sends a confirmation email if an email is present, which would reference the old payment URL. Email is collected on Screen 2.
   - Client reads only `data.enrollment_ref` from the response and ignores all bank-transfer fields.
3. Client redirects to `/enroll/[slug]/checkout/?ref={enrollment_ref}`.

### Screen 2 (Attendee details page load)

- Page reads `?ref=` from URL.
- Calls `GET /api/public/enrollment/{ref}` to fetch the enrollment summary.
- Error states:
  - `404`: show full-page error — "Order not found" + "Return to event" link → `/enroll/[slug]/tickets/`.
  - `410 Gone` (status `cancelled`): show — "This order has expired" + "Return to event" link.
  - `409` from PATCH or intent POST (auto-cancel fired between steps): show inline error — "This order has expired. Please start again." + link back to `/enroll/[slug]/tickets/`.

### Screen 2 → Screen 3 (Attendee details submit)

1. Call `PATCH /api/public/enrollment/{ref}` with `{ student_name_en, company, email }`. This call is idempotent — calling it multiple times with the same data is safe.
2. On PATCH success: call `POST /api/public/payments/stripe/intent` with `{ enrollmentRef }`.
   - On intent POST failure (e.g. Stripe API down): display inline error below the submit button — "Payment setup failed. Please try again." Retry is safe (PATCH is idempotent; intent POST is idempotent).
3. Store `clientSecret` in `sessionStorage` keyed by `enrollment_ref`.
4. Redirect to `/enroll/[slug]/checkout/payment/?ref={ref}&pi={paymentIntentId}`.

### Screen 3 — Payment (page load)

- Read `?ref=` and `?pi=` from URL.
- Read `clientSecret` from `sessionStorage[ref]`. If missing (page refresh): call `GET /api/public/enrollment/{ref}` and use returned `stripe_client_secret`.
- Initialise Stripe: `const stripe = await loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY)`.

### Screen 3 — Card tab

1. Render `<Elements stripe={stripe} options={{ clientSecret }}>` wrapping `<PaymentElement />`.
2. On "Pay": call `stripe.confirmPayment({ elements, confirmParams: { return_url: "{origin}/enroll/{slug}/checkout/success/?ref={ref}" } })`.
   - Stripe handles the redirect to `return_url` on success.
   - On error: display Stripe's `error.message` in a red error banner. Keep the form active for retry.
3. Show spinner + disabled pay button while `confirmPayment` is in flight.

### Screen 3 — PayNow tab

PayNow requires no card-field input from the user — do **not** use `<PaymentElement>` for this tab. Instead:

1. Render a "Pay via PayNow" button.
2. On button click: call `stripe.confirmPayment({ clientSecret, confirmParams: { return_url: "{origin}/enroll/{slug}/checkout/success/?ref={ref}" }, redirect: "if_required" })`.
   - `redirect: "if_required"` prevents a page redirect for PayNow (which stays in-app).
   - Result: `{ paymentIntent, error }` (no redirect).
3. From `paymentIntent.next_action.paynow_display_qr_code`:
   - `image_url_svg` → render as `<img>` (130×130px).
   - `hosted_instructions_url` → fetch to get the UEN for the UEN row display.
4. Display: QR image + UEN row + amber "Waiting for payment" chip with 10:00 countdown.
5. Poll `GET /api/public/payments/stripe/intent/status?pi={paymentIntentId}` every 3 seconds.
6. On `{ status: "succeeded" }`: redirect to `/enroll/[slug]/checkout/success/?ref={ref}`.
7. On `{ status: "cancelled" }` (auto-cancel fired): show "Payment expired" error + "Return to event" link.
8. On countdown expiry (10 minutes, QR expired): show "QR code expired" message + "Generate new QR" button that calls `confirmPayment` again to get a fresh QR.

### Screen 4 — Success

- Reads `?ref=` from URL.
- Calls `GET /api/public/enrollment/{ref}` to fetch enrollment summary.
- Displays ticket stub, amount paid, payment method:
  - Card: `"{card_brand} ••{card_last4}"` (from `payments` table). If null, fall back to "Credit Card".
  - PayNow: `"PayNow"`.
- "DOWNLOAD E-TICKET" button: rendered as **disabled** with `title="Coming soon"` tooltip.
- No Stripe client needed on this screen.

---

## API Routes

### Existing (reused, no changes)
`POST /api/public/enroll` — creates pending enrollment with cart items. Returns `{ enrollment_ref, ... }`. Client uses only `enrollment_ref`.

### New: `GET /api/public/enrollment/[ref]`
- Public, no auth. Tenant-scoped.
- Returns:
  ```json
  {
    "enrollment_ref": "TS-2026-3381",
    "status": "pending_payment",
    "student_name_en": "John Doe",
    "company": "Acme Corp",
    "email": "john@example.com",
    "total_amount": 360,
    "currency": "sgd",
    "items": [{ "level": "General Admission", "quantity": 2, "fee_amount": 180 }],
    "event_name": "TechSummit 2026",
    "event_dates": "14–15 Nov",
    "stripe_client_secret": "pi_xxx_secret_xxx"
  }
  ```
- `stripe_client_secret`: **only included if** a `payments` row exists for this enrollment with `payment_method: "stripe"`, `status: "awaiting_payment"`, and a non-null `stripe_payment_intent_id`. If no such row exists, omit the field entirely (no Stripe API call is made in that case). If the row exists, retrieve the PI from Stripe and return its `client_secret`.
- Error responses: `404` if not found or wrong tenant; `410` if status is `cancelled`.

### New: `PATCH /api/public/enrollment/[ref]`
- Public, no auth (enrollment ref acts as access token). Tenant-scoped.
- Body: `{ student_name_en: string, company?: string, email: string }`.
- Updates `student_name_en`, `company`, `email` on the enrollment record. Idempotent.
- Only allowed if status is `pending_payment`.
- Returns: `{ enrollment_ref, status }`.
- Error responses: `404` not found; `409` if status is not `pending_payment` (expired/already confirmed).

### New: `POST /api/public/payments/stripe/intent`
- Body: `{ enrollmentRef: string }`.
- Guards:
  - Enrollment must exist and belong to tenant → `404`.
  - Status must be `pending_payment` → `409`.
  - Currency must not be `mmk` → `400` (same guard as existing Stripe Checkout route).
- Idempotency: check for existing `payments` row with `payment_method: "stripe"`, `status: "awaiting_payment"`, non-null `stripe_payment_intent_id`. If found and PI is still `requires_payment_method` or `requires_confirmation` on Stripe, return the existing `clientSecret`. Otherwise create a new PI.
- Creates: `stripe.paymentIntents.create({ amount: totalCents, currency, payment_method_types: ["card", "paynow"], metadata: { tenant_id, enrollment_id, enrollment_ref } })`.
- Inserts `payments` row: `{ enrollment_id, tenant_id, amount, payment_method: "stripe", status: "awaiting_payment", stripe_payment_intent_id: pi.id }`.
- Returns: `{ clientSecret: pi.client_secret, paymentIntentId: pi.id }`.

### New: `GET /api/public/payments/stripe/intent/status?pi={paymentIntentId}`
- Public, no auth. PaymentIntent IDs are already client-side; no PII is returned — only status. This is consistent with Stripe's own client-side `retrievePaymentIntent` API.
- Retrieves PaymentIntent from Stripe by ID.
- If `status === "succeeded"`:
  - Finds `payments` row by `stripe_payment_intent_id`.
  - Idempotency guard: if `payments.status !== "verified"`:
    - Update `payments`: `{ status: "verified", paid_at: now(), card_brand: pi.payment_method_details?.card?.brand ?? null, card_last4: pi.payment_method_details?.card?.last4 ?? null }`.
    - Update `enrollments`: `{ status: "confirmed" }`.
  - Returns `{ status: "succeeded" }`.
- If `status === "canceled"` or enrollment is `cancelled` (auto-cancel fired): returns `{ status: "cancelled" }`.
- Otherwise: returns `{ status: "pending" }`.
- Webhook/polling race: Stripe webhooks may also update the enrollment. The idempotency guard prevents double-writes — both paths are safe.

---

## Stripe Integration

**Mode:** Stripe Elements (embedded, PaymentIntent API) — not Stripe Checkout Sessions.
**Client packages to install:** `@stripe/react-stripe-js`, `@stripe/stripe-js`

**Card tab:** use `<Elements>` + `<PaymentElement>` + `stripe.confirmPayment()`.

**PayNow tab:** do NOT use `<PaymentElement>` (PayNow requires no card fields). Call `stripe.confirmPayment({ clientSecret, confirmParams: { return_url }, redirect: "if_required" })` directly. Read `next_action.paynow_display_qr_code` from the result.

**`confirmPayment` (not `confirmCardPayment`):** always use `stripe.confirmPayment()` — this is the current API compatible with both `PaymentElement` and direct PaymentIntent confirmation. `confirmCardPayment` is the legacy API and must not be used.

**Existing routes untouched:**
- `/api/public/payments/stripe` (Checkout Session route)
- `/api/public/payments/stripe/verify` (Checkout Session verify route)

---

## Component Breakdown

### `EvTrustedOfficialTemplate.tsx`
- Defines its own props interface (does NOT extend `EventTemplateProps` — that type is coupled to the `onCartCheckout` callback designed for the old shared flow):
  ```ts
  interface EvTrustedOfficialTemplateProps {
    appearance: Omit<TenantAppearance, "id" | "tenant_id" | "updated_at">;
    intake: TemplateIntake;
    classes: TemplateClass[];
    labels: TemplateLabels;
    slug: string;
    currency: string;
  }
  ```
- Internally manages cart state.
- On checkout: calls `POST /api/public/enroll` (omitting `form_data`) → on success, `router.push(\`/enroll/${slug}/checkout/?ref=${enrollmentRef}\`)`.
- Ticket cards: standard variant (white bg, neutral border) and featured/VIP variant (cream bg, gold border, "POPULAR" badge).
- Quantity stepper: bordered pill with −/qty/+ segments, live subtotal.
- Sticky bottom cart bar: ticket count + running total + "CONTINUE →" CTA.

### `TrustedOfficialShell` (shared wrapper for Screens 2–4)
- Brand row: 30×30px rounded-square logo mark + org name.
- Step label + progress bar:
  - Screen 2: "STEP 1 OF 2" / "Attendee details" — first segment gold, second track color.
  - Screen 3: "STEP 2 OF 2" / "Payment" — both segments gold.
  - Screen 4: No step label — both segments gold (completion state).
- Cream page background `#f7f5ef`.

### Screen 2 — `/enroll/[slug]/checkout/page.tsx`
- Fetches enrollment via `GET /api/public/enrollment/{ref}`.
- Error handling: `404` or `410` → full-page error with "Return to event" link.
- Order summary card: cream bg, gold border, ticket line items + event name/dates.
- Form fields: Full Name (focused/navy border), Company (optional), Email + helper text.
- 409 from PATCH or intent POST → inline error: "This order has expired." + link to `/enroll/[slug]/tickets/`.
- On submit: PATCH → intent POST → store `clientSecret` in `sessionStorage` → redirect.

### Screen 3 — `/enroll/[slug]/checkout/payment/page.tsx`
- On load: read `clientSecret` from `sessionStorage`. If missing: call `GET /api/public/enrollment/{ref}` → use `stripe_client_secret`.
- Card/PayNow toggle: visual custom toggle (not Stripe's UI).
- Card tab: `<Elements>` + `<PaymentElement>` + pay button + Stripe security note.
- PayNow tab: static layout (no Stripe element). "Pay via PayNow" button triggers `confirmPayment` → renders QR + UEN + amber countdown + 3s polling.
- Error banner: red-bordered card, English only, with retry action.
- Spinner + disabled button while `confirmPayment` is in flight.

### Screen 4 — `/enroll/[slug]/checkout/success/page.tsx`
- Fetches enrollment via `GET /api/public/enrollment/{ref}`.
- 42×42px checkmark badge (navy circle, gold checkmark).
- Heading: "Payment successful" (card) or "PayNow payment received" (PayNow).
- Navy ticket stub card with right-edge perforation effect, order ref, QR placeholder.
- Payment summary: amount paid + payment method (`card_brand ••card_last4` or `"PayNow"`).
- "DOWNLOAD E-TICKET" button: `disabled` + `title="Coming soon"`.

---

## Design Tokens

| Token | Value |
|---|---|
| Navy primary | `#0f1f42` |
| Gold accent (deep) | `#b7912b` |
| Gold accent (light) | `#d4af5a` |
| Page background | `#f7f5ef` |
| Card cream | `#fbf8ee` |
| Card border | `#e3e0d6` |
| Input border (inactive) | `#d8d5c9` |
| Body secondary text | `#8b8f9a` |
| Field label text | `#43485a` |
| Amber chip bg | `#fdf3e0` |
| Amber chip border | `#eed9a3` |
| Amber chip text | `#8a6a1f` |
| Stripe purple (wordmark only) | `#635bff` |

**Typography:** Inter (400/600/700/800). No Myanmar text in this flow.

**Radius:** Cards 9–12px, buttons 6–8px, small badges 4–6px.

---

## What Is NOT Changed

- `src/app/(public)/enroll/form/` — untouched
- `src/app/(public)/enroll/payment/[ref]/` — untouched
- `src/app/api/public/payments/stripe/route.ts` — untouched
- `src/app/api/public/payments/stripe/verify/route.ts` — untouched
- All `Ls*` templates — untouched
- Existing `Ev*` templates (`EvCorporateTemplate`, `EvFestivalTemplate`, `EvLuxuryTemplate`) — untouched

---

## Implementation Order

1. DB migration: add `stripe_payment_intent_id`, `card_brand`, `card_last4` to `payments`.
2. New API routes: `GET+PATCH /api/public/enrollment/[ref]`, `POST /api/public/payments/stripe/intent`, `GET /api/public/payments/stripe/intent/status`.
3. Install `@stripe/react-stripe-js` and `@stripe/stripe-js`.
4. `EvTrustedOfficialTemplate.tsx` component.
5. `TrustedOfficialShell` wrapper component.
6. Screen 2: `/enroll/[slug]/checkout/page.tsx`.
7. Screen 3: `/enroll/[slug]/checkout/payment/page.tsx`.
8. Screen 4: `/enroll/[slug]/checkout/success/page.tsx`.
9. Screen 1: `/enroll/[slug]/tickets/page.tsx` (renders `EvTrustedOfficialTemplate`).
10. Update `/enroll/[slug]/page.tsx`: add `"ev-trusted-official"` redirect check before the `newStyleIds` block.
