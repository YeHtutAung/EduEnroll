# Design Spec: EvTrustedOfficial Enrollment Flow

**Date:** 2026-07-04
**Status:** Approved for implementation
**Reference designs:** `docs/ui/EduEnroll UI design exploration/`

---

## Overview

A new "Trusted Official" event ticketing flow for EduEnroll's **event** tenant type. Visual direction: navy + gold, structured, high-trust (matches option 3a/3b in the wireframes file). Covers 4 screens: ticket selection, attendee details, payment (Card + PayNow), and success/e-ticket.

This is an **additive** implementation — existing templates and shared enrollment routes remain untouched.

---

## Scope

- **In scope:** `Ev*` template family only. Language-school (`Ls*`) templates are not affected.
- **Out of scope:** MMQR/bank transfer flow, existing shared enrollment routes.

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

src/app/api/public/payments/stripe/
  intent/
    route.ts          # POST — create PaymentIntent (card + paynow)
    status/
      route.ts        # GET  — poll PaymentIntent status (for PayNow)
```

**Template detection:** The existing `/enroll/[slug]/page.tsx` detects the `trusted_official` template value in the tenant appearance and redirects to `/enroll/[slug]/tickets/` instead of rendering inline. All other template values continue to render inline as before.

---

## Data Flow

### Screen 1 → Screen 2 (Cart submit)
1. User selects ticket quantities in `EvTrustedOfficialTemplate`.
2. On "Continue", `POST /api/public/enroll` creates a **pending enrollment** record with cart items (reuses existing endpoint).
3. Backend returns `enrollment_ref`.
4. Client redirects to `/enroll/[slug]/checkout/?ref={enrollment_ref}`.

### Screen 2 → Screen 3 (Attendee details submit)
1. Page reads `?ref=` and fetches enrollment to show order summary card.
2. User fills name, company, email.
3. On "Continue to Payment":
   - `PATCH /api/public/enroll/{ref}` updates attendee details on the enrollment record.
   - `POST /api/public/payments/stripe/intent` creates a Stripe PaymentIntent with `payment_method_types: ["card", "paynow"]`, returns `{ clientSecret, paymentIntentId }`.
4. Client redirects to `/enroll/[slug]/checkout/payment/?ref={ref}&pi={paymentIntentId}`.

### Screen 3 — Payment
- **Card tab:** Stripe `PaymentElement` renders card fields. On "Pay", `stripe.confirmCardPayment(clientSecret)` is called. On success → redirect to `/enroll/[slug]/checkout/success/?ref={ref}`.
- **PayNow tab:** PayNow QR image URL fetched from Stripe's `next_action.paynow_display_qr_code.image_url_svg`. Page polls `GET /api/public/payments/stripe/intent/status?pi={paymentIntentId}` every 3 seconds. On `status: "succeeded"` → auto-redirect to success page.

### Screen 4 — Success
- Reads `?ref=` from URL.
- Fetches enrollment + most recent payment record from DB (no Stripe client needed).
- Displays ticket stub, amount paid, payment method.

### Abandoned sessions
Pending enrollments without payment are cleaned up by the existing `auto_cancel_minutes` mechanism — no new cleanup logic needed.

---

## Stripe Integration

**Mode:** Stripe Elements (embedded, PaymentIntent API) — not Stripe Checkout Sessions.

**New API routes:**

`POST /api/public/payments/stripe/intent`
- Validates enrollment ref, checks status is `pending_payment`.
- Creates `stripe.paymentIntents.create({ amount, currency, payment_method_types: ["card", "paynow"] })`.
- Inserts a `payments` record with `status: "awaiting_payment"`, `payment_method: "stripe"`.
- Returns `{ clientSecret, paymentIntentId }`.
- Idempotent: returns existing open PaymentIntent if one exists for this enrollment.

`GET /api/public/payments/stripe/intent/status?pi={paymentIntentId}`
- Retrieves PaymentIntent from Stripe.
- If `status: "succeeded"`: updates `payments` record to `verified`, updates `enrollments` to `confirmed`. Returns `{ status: "succeeded" }`.
- If not yet succeeded: returns `{ status: "pending" }`.
- Idempotent — safe to call on every poll tick.

**Client packages to install:** `@stripe/react-stripe-js`, `@stripe/stripe-js`

**Existing routes untouched:** `/api/public/payments/stripe` (Checkout Session) and `/api/public/payments/stripe/verify` remain unchanged.

---

## Component Breakdown

### `EvTrustedOfficialTemplate.tsx`
- Extends `EventTemplateProps` (existing type, no changes).
- Ticket cards: standard variant (white bg, neutral border) and featured/VIP variant (cream bg, gold border, "POPULAR" badge).
- Quantity stepper: bordered pill with −/qty/+ segments, live subtotal text.
- Sticky bottom cart bar: ticket count + running total + "CONTINUE →" CTA button.
- On checkout: calls `POST /api/public/enroll` → redirects to `/enroll/[slug]/checkout/?ref=...`.

### `TrustedOfficialShell` (shared wrapper, used in Screens 2–4)
- Brand row: 30×30px rounded-square logo mark + org name.
- Step label row ("STEP N OF 2") + 2-segment gold progress bar.
- Cream page background (`#f7f5ef`).
- Keeps Screens 2–4 consistent without repeating markup.

### Screen 2 — `/enroll/[slug]/checkout/page.tsx`
- Fetches enrollment by `?ref=` to populate order summary card.
- Order summary card: cream bg, gold border, ticket line items + event name/dates.
- Form fields: Full Name (focused/navy border), Company, Email (with helper text).
- On submit: PATCH attendee details → create PaymentIntent → redirect to payment.

### Screen 3 — `/enroll/[slug]/checkout/payment/page.tsx`
- Card/PayNow toggle: two equal-width segments, active = navy fill + white text.
- **Card tab:** `<Elements stripe={...} options={{ clientSecret }}><PaymentElement /></Elements>` + "PAY SGD X.XX" button + Stripe security note.
- **PayNow tab:** QR image (from Stripe `next_action`), UEN row, amber "Waiting for payment" chip with mm:ss countdown, 3s polling → auto-redirect on success.
- Loading/error states: spinner on pay button, red error banner on failure (English only).

### Screen 4 — `/enroll/[slug]/checkout/success/page.tsx`
- 42×42px checkmark badge (navy circle, gold checkmark).
- Heading: "Payment successful" (card) or "PayNow payment received" (PayNow).
- Navy ticket stub card with right-edge perforation effect, order ref, small QR placeholder.
- Payment summary card: amount paid + payment method.
- "DOWNLOAD E-TICKET" outlined button (wired to existing e-ticket PDF generation if available, otherwise placeholder).

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

**Typography:** Inter (400/600/700/800). No Myanmar text in this flow (SGD/English-only event context).

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

## Open Questions / Deferred

- **E-ticket PDF download:** Wire to existing PDF generation if available; placeholder button otherwise. Confirm at implementation time.
- **PayNow QR expiry:** Stripe PayNow QR codes expire after ~10 minutes. The amber countdown chip should reflect this (10:00 countdown). Confirm expiry duration with Stripe docs at implementation time.
- **`auto_cancel_minutes` value:** Ensure the tenant's `auto_cancel_minutes` is set to a value >= 10 minutes for PayNow tenants, so the enrollment isn't cancelled before the PayNow QR expires.
