# EduEnroll / KuuNyi Cleanup Plan

## Current Assessment

**Rating:** 6.5/10

The codebase is not a throwaway mess. It has real product depth, working multi-tenancy, payment integrations, Supabase auth/RLS, migrations, admin flows, public enrollment flows, and some tests.

The main issue is that the product has grown faster than the internal structure. Large route files now contain too much business logic, payment logic, notification logic, DB access, and response formatting.

## Main Cleanup Goals

1. Reduce duplication.
2. Make enrollment and payment flows safer.
3. Move business logic out of route handlers.
4. Centralize notification behavior.
5. Improve test coverage around high-risk flows.
6. Clean generated files, docs, and encoding issues.
7. Avoid a full rewrite.

---

## Phase 1: Repo Hygiene and Baseline

### Tasks

- Confirm `.env.local` and secrets are ignored.
- Review untracked files and decide what should be committed:
  - `KuuNyi_Analysis.md`
  - `ci-cd-diagram.html`
  - `docs/ui/`
  - `docs/superpowers/`
- Ignore or clean generated folders:
  - `.next`
  - `playwright-report`
  - `test-results`
- Fix mojibake/encoding issues in docs and source comments.
- Confirm baseline commands work:
  - `npm run build`
  - `npm run test`
  - `npm run test:e2e` where appropriate

### Outcome

The repo becomes easier to reason about before deeper refactoring begins.

---

## Phase 2: Extract Enrollment Domain Logic

### Main Target

`src/app/api/public/enroll/route.ts`

This file currently handles too many responsibilities:

- Request parsing
- Validation
- Single enrollment
- Cart enrollment
- Dynamic form mapping
- Legacy field mapping
- Tenant/currency lookup
- Bank account lookup
- Confirmation email logic
- API response construction

### Proposed Structure

```txt
src/server/enrollment/
  createEnrollment.ts
  createCartEnrollment.ts
  formDataMapper.ts
  enrollmentResponses.ts
  enrollmentEmails.ts
```

### Route Goal

The route should become thin:

```ts
export async function POST(request: NextRequest) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  const result = await createEnrollmentFromRequest(request, tenantId);
  return toEnrollmentResponse(result);
}
```

### Outcome

Enrollment behavior becomes easier to test, change, and debug.

---

## Phase 3: Extract Payment Workflow

### Main Target

`src/app/api/admin/payments/[id]/verify/route.ts`

This route currently mixes:

- Auth
- Agent verification
- Payment loading
- Enrollment loading
- Payment state transitions
- Seat restoration
- Cart/single-class calculations
- Email/SMS/Messenger/Telegram notifications
- Audit fields
- API response shaping

### Proposed Structure

```txt
src/server/payments/
  verifyPayment.ts
  paymentTransitions.ts
  seatRestoration.ts
  paymentNotifications.ts
  paymentAmounts.ts
```

### Centralize These Transitions

- `pending -> verified`
- `pending -> rejected`
- `pending -> partial_payment`
- Restore seats only once on rejection
- Track verifier:
  - human admin
  - signed agent request

### Outcome

Payment state changes become explicit and safer.

---

## Phase 4: Centralize Notifications

### Current Problem

Notifications are spread across enrollment and payment routes.

Channels include:

- Email
- SMS
- Messenger
- Telegram
- Telegram channel invite

### Proposed Structure

```txt
src/server/notifications/
  dispatchEnrollmentCreated.ts
  dispatchPaymentApproved.ts
  dispatchPaymentRejected.ts
  dispatchPartialPaymentRequested.ts
```

### Existing Low-Level Modules Can Stay

These can remain as provider-specific helpers:

```txt
src/lib/email.ts
src/lib/sms.ts
src/lib/messenger/
src/lib/telegram/
```

### Goal

Business services should call:

```ts
await dispatchPaymentApproved(...)
```

Instead of manually knowing every channel.

### Outcome

Notification behavior becomes consistent and easier to modify.

---

## Phase 5: Clean Up Payment Providers

### Current Problem

Payment provider logic is scattered across API routes and helper files.

Providers include:

- Bank transfer
- Stripe
- PayPay
- ABank/MMQR
- MMPay

### Proposed Structure

```txt
src/server/payment-providers/
  stripe.ts
  paypay.ts
  abank.ts
  mmpay.ts
  bankTransfer.ts
```

### Normalize Provider Concepts

Each provider should clearly handle:

- Create payment session/intent/order
- Check status
- Handle webhook/callback
- Map provider status to internal status
- Idempotency behavior

### Outcome

Adding or changing providers becomes less risky.

---

## Phase 6: Centralize Tenant Configuration

### Current Problem

Tenant settings are fetched repeatedly in many places.

Examples:

- Currency
- Organization type
- Payment mode
- MMQR provider
- Logo
- Brand color
- SMS enabled
- Email-on-enroll enabled

### Proposed Structure

```txt
src/server/tenants/
  getTenantConfig.ts
  getTenantAppearance.ts
  getTenantPaymentSettings.ts
```

### Outcome

Defaults become consistent across the app.

Examples:

- `MMK`
- `bank_transfer`
- default appearance
- default notification settings

---

## Phase 7: Add High-Value Regression Tests

### Priority Tests

Add tests for:

- Single enrollment reserves the correct number of seats.
- Cart enrollment reserves the correct number of seats.
- Duplicate idempotency key does not double reserve seats.
- Rejected payment restores seats once only.
- Partial payment calculates remaining amount correctly.
- Stripe is unavailable for `MMK`.
- Duplicate webhook delivery does not double-confirm payment.
- Public routes cannot leak data across tenants.
- Admin routes cannot access another tenant.
- Agent-signed payment verification cannot cross tenant.

### Testing Focus

Prioritize business logic tests over UI snapshot tests.

The riskiest areas are:

- Seat counts
- Payment status transitions
- Webhook idempotency
- Tenant isolation
- Partial payment behavior

---

## Phase 8: UI Organization

Do this after backend/domain cleanup.

### Proposed Feature Structure

```txt
src/features/
  admin-dashboard/
  intakes/
  enrollment-public/
  checkout/
  payments/
```

### Goals

- Keep App Router pages thin.
- Move page-local helper logic into hooks or feature modules.
- Keep reusable UI components in `src/components/ui`.
- Keep domain-specific UI inside feature folders.

### Outcome

Large page files become easier to maintain.

---

## Recommended Execution Order

1. Clean repo hygiene and encoding issues.
2. Confirm baseline tests/build.
3. Extract enrollment form mapping and response logic.
4. Extract single/cart enrollment services.
5. Extract payment verification workflow.
6. Centralize notification dispatch.
7. Add regression tests around payments and seats.
8. Clean payment provider modules.
9. Centralize tenant config access.
10. Reorganize large UI areas.

---

## Expected Improvement

### Current

**6.5/10**

Feature-rich, working, but too much business logic lives inside large route files.

### After Phases 1-4

**7.5/10**

Core flows become easier to reason about and safer to change.

### After Phases 5-8

**8/10+**

Provider logic, tenant config, tests, and UI organization become much cleaner.

---

## Important Guidance

Do **not** rewrite the app.

The codebase contains a lot of working domain knowledge. The cleanup should preserve behavior while extracting high-risk logic into smaller, testable modules.

The best cleanup strategy is:

> Refactor around the enrollment and payment workflows first, because those are the business-critical paths.
