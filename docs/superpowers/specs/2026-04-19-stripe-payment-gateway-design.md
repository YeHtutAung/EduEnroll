# Stripe Payment Gateway Integration — Design Spec

**Date:** 2026-04-19
**Status:** Approved
**Author:** Claude + YHA

## Summary

Add Stripe as a tenant-level payment option alongside existing MMK methods (bank transfer, MMQR). Stripe Checkout Sessions with dynamic pricing, auto-confirmation via webhook.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Payment method | New option alongside MMK | International tenants (e.g., Singapore) need card payments |
| Currency | Per-tenant (SGD, MMK, etc.) | `tenants.currency` determines the currency; `fee_mmk` is the generic fee column |
| Stripe flow | Checkout Session (hosted) | Simplest integration, Stripe handles UI and PCI compliance |
| Scope | Per-tenant toggle | `payment_mode: 'stripe'` in tenant settings |
| Confirmation | Auto-confirm via webhook | Stripe confirms payment instantly, no admin review needed |
| Pricing | Dynamic `price_data` | No pre-created Stripe Products; line items built per checkout |
| Account model | Single platform account | One Stripe account for all tenants; `metadata.tenant_id` set on sessions for filtering |
| Mode | Test (initially) | `sk_test_` / `pk_test_` keys |

## Architecture

### Flow

```
Student enrolls → POST /api/public/enroll → enrollment (pending_payment)
                                               ↓
                        Payment page detects payment_mode = 'stripe'
                                               ↓
                        "Pay Now" button → POST /api/public/payments/stripe
                                               ↓
                        Creates Stripe Checkout Session (dynamic line items)
                        Returns checkout URL → redirect to Stripe
                                               ↓
                        Student pays on Stripe → success_url back to payment page
                                               ↓
                        Stripe webhook (checkout.session.completed)
                        → POST /api/stripe/webhook
                        → Auto-confirms: payment → verified, enrollment → confirmed
                        → Sends notifications (email/Telegram)
```

### Database Changes (Migration 072)

```sql
-- Extend payment_mode to support 'stripe'
COMMENT ON COLUMN public.tenants.payment_mode IS 'bank_transfer | mmqr | stripe';

-- Add Stripe fields to payments table
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS stripe_session_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;

CREATE INDEX idx_payments_stripe_session
  ON public.payments (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;
```

### TypeScript Type Updates

All locations narrowing `payment_mode` must be updated to include `'stripe'`:

- `src/types/database.ts` — `Tenant.payment_mode` union type
- `src/types/database.ts` — `Payment` interface (add `stripe_session_id`, `stripe_payment_intent_id`)
- `src/app/(public)/enroll/payment/[ref]/page.tsx` — `EnrollmentInfo.payment_mode` type
- `src/app/admin/settings/page.tsx` — payment mode cast on line 578

### API Routes

#### 1. `POST /api/public/payments/stripe`

Creates a Stripe Checkout Session.

- **Auth:** Public (no authentication, uses `createAdminClient()`)
- **Input:** `{ enrollmentRef: string }`
- **Idempotency:** Check for existing `awaiting_payment` Stripe payment before creating a new session. If one exists and the session is still valid, return its URL.
- **Process:**
  1. Look up enrollment by ref
  2. Validate status is `pending_payment` or `partial_payment`
  3. Fetch class fee and tenant currency
  4. **Cart enrollments:** If `enrollment.class_id` is null, fetch `enrollment_items` and create multiple `line_items` (one per class)
  5. **Partial payments:** Subtract `received_amount_mmk` from total to get remaining amount
  6. Create Stripe Checkout Session with dynamic `price_data`:
     - Product name: class level / intake name
     - Currency: tenant's currency (e.g., `sgd`)
     - Amount: fee in smallest unit (cents)
     - `metadata`: `{ tenant_id, enrollment_id, enrollment_ref }`
  7. Create payment record: `payment_method: 'stripe'`, `status: 'awaiting_payment'`, `stripe_session_id`, `amount_mmk` (generic fee in tenant currency)
  8. Return `{ url: string }` (Stripe Checkout URL)
- **Success URL:** `/enroll/payment/{ref}?stripe=success`
- **Cancel URL:** `/enroll/payment/{ref}?stripe=cancelled`

#### 2. `POST /api/stripe/webhook`

Handles Stripe webhook events. This route is outside `/api/public/` since Stripe sends events directly — tenant context is resolved from the payment record's `tenant_id`.

- **Auth:** Stripe signature verification (`STRIPE_WEBHOOK_SECRET`)
- **Events handled:**
  - `checkout.session.completed`:
    1. Look up payment by `stripe_session_id`
    2. Skip if payment already `verified` (idempotency)
    3. Update payment: `status → 'verified'`, `stripe_payment_intent_id`, `paid_at`
    4. Update enrollment: `status → 'confirmed'`
    5. Send notifications (email, Telegram — extract shared logic from existing webhook handlers)
  - `checkout.session.expired`:
    1. Look up payment by `stripe_session_id`
    2. Update payment status to reflect expiry

### Environment Variables

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Note: No `NEXT_PUBLIC_` prefix needed — the flow is server-side redirect only (no client-side Stripe.js).

### Frontend Changes

#### Payment Page (`enroll/payment/[ref]/page.tsx`)

When `payment_mode === 'stripe'`:
- Show "Pay with Card" button (styled with Stripe branding colors)
- On click: `POST /api/public/payments/stripe` → redirect to `session.url`
- On return with `?stripe=success`: show "Payment processing..." state, poll `/api/public/status` until enrollment is `confirmed` (webhook may arrive after redirect)
- On return with `?stripe=cancelled`: show retry option
- Hide bank transfer UI and MMQR UI

#### Admin Settings (`admin/settings/page.tsx`)

- Add `'stripe'` to payment mode radio/dropdown options
- Label: "Stripe (Card Payment)"

#### Admin Payments List

- Stripe payments appear with "Auto-verified by Stripe" badge instead of manual verify/reject buttons
- Display `stripe_payment_intent_id` as reference (instead of proof images)

#### Status API (`api/public/status`)

- Include `payment_mode: 'stripe'` in enrollment info response

### Package

- Install `stripe` npm package

## Column Naming Note

The `amount_mmk` and `received_amount_mmk` columns are named for MMK but will store amounts in the tenant's actual currency (e.g., SGD cents). The `tenants.currency` field determines the real currency. This is a known naming mismatch accepted to avoid a large refactor. The `payment_method: 'stripe'` field disambiguates context.

## Out of Scope

- Stripe Connect (per-tenant Stripe accounts) — single platform account; all tenants' payments visible via `metadata.tenant_id` in Stripe dashboard
- Refund handling (manual via Stripe dashboard)
- Subscription/recurring billing
- Pre-created Stripe Products
- Currency conversion (fee is stored in tenant's native currency)
- Renaming `_mmk` columns (accepted naming mismatch)
