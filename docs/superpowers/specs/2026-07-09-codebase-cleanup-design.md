# Codebase Cleanup Design

**Date:** 2026-07-09
**Author:** Claude (with full project context)
**Status:** Reviewed

---

## Background

EduEnroll / KuuNyi has grown through 10+ sprints into a feature-rich product: multi-tenancy,
Stripe + PayPay + ABank + MMPay, Telegram bots, Messenger bots, SMS, PDF e-tickets, and a full
admin portal. The codebase works. The problem is that the product grew faster than its internal
structure.

**Current rating: 6.5 / 10**

A previous Codex-generated cleanup plan (CLEANUP_PLAN.md) identified the structural problems
correctly. This spec builds on that plan with two critical corrections:

1. Tests must come **before** refactoring, not after.
2. A data integrity issue from migration 058 must be audited **before anything else**.

---

## Principles

- **No rewrites.** The codebase contains working domain knowledge. Preserve behavior, extract
  structure.
- **Tests before touch.** Never refactor a business-critical flow without a regression baseline.
- **Data before code.** A production data issue outranks any code quality concern.
- **Incremental.** Each phase should be independently mergeable and deployable.
- **Scope discipline.** Phases 0-5 are must-do. Phases 6-8 are improvement, not required.

---

## Phase 0: Data Integrity Audit

**Priority: Immediate. Do before any code changes.**

### Problem

Migration `058_auto_cancel_minutes.sql` converted `auto_cancel_hours` from hours to minutes by
running:

```sql
UPDATE public.tenants SET auto_cancel_hours = auto_cancel_hours * 60 WHERE auto_cancel_hours > 0;
```

If any tenant had a value already stored in minutes before this migration ran (e.g., from a prior
test or misconfiguration), the migration would have multiplied it by 60 again. There is no guard
against running this data transformation twice.

### Task

Run a diagnostic query against the dev DB and compare with expected ranges:

```sql
SELECT id, subdomain, auto_cancel_hours,
       auto_cancel_hours / 60.0 AS hours_if_treated_as_minutes
FROM public.tenants
ORDER BY auto_cancel_hours DESC;
```

Expected ranges after migration 058:
- Minimum legitimate value: `60` (representing 1 hour post-migration — any tenant set to 1 hour
  before migration now stores 60).
- Default: `4320` (72 hours × 60).
- Reasonable maximum: `10080` (1 week in minutes).
- Suspicious: anything above `20160` (2 weeks). A value of `259200` would indicate the default
  of `4320` was itself multiplied again, meaning the migration ran twice.

### Remediation

If any tenant has a suspiciously large value, write a targeted correction migration with explicit
`WHERE id = '...'` clauses. Never bulk-correct without per-row verification.

### Outcome

Confidence that auto-cancellation is expiring enrollments at the correct time in production.

---

## Phase 1: Repo Hygiene

### Tasks

**Untracked files** — decide commit or ignore for each:
- `KuuNyi_Analysis.md` — commit to `docs/` or delete
- `ci-cd-diagram.html` — commit to `docs/` or delete
- `docs/superpowers/` — commit (specs written by Claude Code)
- `docs/ui/` — commit if relevant, otherwise delete

**Stale structure cleanup:**
- `src/lib/telegram.ts` coexists with `src/lib/telegram/` directory. The top-level file is a
  remnant from before the module was expanded into a directory. It is still actively imported by
  two routes:
  - `src/app/api/telegram/admin-requests/route.ts`
  - `src/app/api/webhook/route.ts`
  Both importers must be updated to import from `src/lib/telegram/` (the appropriate submodule)
  before `src/lib/telegram.ts` can be safely deleted. Do not delete the file without first
  migrating both import sites and confirming the build passes.
- Confirm `eduenroll/` nested scaffold directory is excluded from `tsconfig.json` and add it to
  `.gitignore` if not already present.

**Build baseline:**
- Confirm `npm run build` passes cleanly with zero TypeScript errors.
- Confirm `npm run lint` passes.
- Document both commands in README if not already present.

### Outcome

Clean repo state. No ambiguity about what is tracked, what is excluded, and what the baseline is.

---

## Phase 2: Regression Tests (Before Any Refactoring)

**This phase must complete before Phase 3 begins.**

The Codex plan put tests at Phase 7, after six phases of refactoring. That is backwards for a
live production system. Tests are the safety net that make refactoring safe.

### Test targets (in priority order)

**Seat reservation (highest risk):**
- Single enrollment reserves exactly one seat per class.
- Cart enrollment reserves the correct number of seats across multiple classes.
- Duplicate idempotency key does not double-reserve seats.
- Rejected payment restores exactly the seats it took, not more.

**Payment state transitions:**
- `pending → verified` marks enrollment as confirmed.
- `pending → rejected` restores seats and updates enrollment status.
- `pending → partial_payment` records remaining amount correctly.
- Duplicate webhook delivery does not double-confirm or double-reject.

**Tenant isolation:**
- Public enrollment route cannot read another tenant's intake.
- Admin route cannot read another tenant's enrollments.
- Agent-signed payment verification cannot cross tenant boundaries.

**Payment provider guards:**
- Stripe is rejected for MMK-currency tenants.
- PayPay is rejected for non-JPY tenants.

### Approach

Phase 2 has two layers of tests written at different times:

**Layer 1 (write now, before Phase 3):** Route-level integration tests that verify the full HTTP
path returns correct status codes and payloads. These confirm existing behavior before any
extraction begins.

**Layer 2 (write after Phase 3, before Phase 4):** Unit tests against the extracted service
functions (`createEnrollment.ts`, `verifyPayment.ts`, etc.). These test business logic directly
without HTTP overhead. Do not proceed to Phase 4 until Layer 2 tests exist for everything
extracted in Phase 3.

Use Vitest for both layers. Mock the DB client at the service boundary for Layer 2.

### Outcome

A regression baseline that lets Phases 3-5 proceed with confidence.

---

## Phase 3: Extract Enrollment Domain Logic

### Problem

`src/app/api/public/enroll/route.ts` handles all of the following in one file:

- Request parsing and validation
- Single enrollment creation
- Cart enrollment creation
- Dynamic form field mapping
- Legacy field mapping (backwards compat)
- Tenant and currency lookup
- Bank account lookup
- Confirmation email trigger
- API response construction

This means a bug in any one area requires reading the entire file to understand the blast radius.

### Target structure

```
src/server/enrollment/
  createEnrollment.ts       — single-class enrollment logic
  createCartEnrollment.ts   — multi-class cart enrollment logic
  formDataMapper.ts         — dynamic form field → DB field mapping
  enrollmentResponses.ts    — shape API responses
  enrollmentEmails.ts       — trigger confirmation emails
```

### Route goal

After extraction, the route handler becomes:

```ts
export async function POST(request: NextRequest) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  const result = await createEnrollmentFromRequest(request, tenantId);
  return toEnrollmentResponse(result);
}
```

### Important: tenantId is a resolved UUID

`resolveTenantId()` returns a UUID (not a slug). All extracted service functions receive a UUID
and must not call `resolveTenantId()` internally — that would perform a second DB lookup for the
same data. Pass `tenantId` down through the call chain.

### Rules

- Preserve all existing behavior exactly.
- Write Layer 2 unit tests (from Phase 2) against the extracted functions before proceeding to
  Phase 4.
- Do not change the public API shape.

### Outcome

Enrollment behavior is testable in isolation. Bugs are easier to locate.

---

## Phase 4: Extract Payment Verification

### Problem

`src/app/api/admin/payments/[id]/verify/route.ts` mixes:

- Auth + agent signature verification
- Payment record loading
- Enrollment record loading
- Payment state transitions (`pending → verified`, `→ rejected`, `→ partial_payment`)
- Seat restoration logic
- Cart vs single-class amount calculations
- Email, SMS, Messenger, and Telegram notification triggers
- Audit field writes
- API response shaping

Payment state transitions are the highest-risk logic in the system. Errors here cause real money
and real seat count problems.

### Target structure

```
src/server/payments/
  verifyPayment.ts          — orchestrates the full verification flow
  paymentTransitions.ts     — state machine: pending → verified/rejected/partial
  seatRestoration.ts        — restore seats on rejection (exactly once)
  paymentNotifications.ts   — trigger all channels after a transition
  paymentAmounts.ts         — cart vs single-class amount calculations
```

### State machine

Each transition must be explicit:

| From | To | Side effects |
|------|----|-------------|
| `pending` | `verified` | enrollment confirmed, notify all channels |
| `pending` | `rejected` | seats restored, notify student |
| `pending` | `partial_payment` | remaining amount calculated, notify student |

The transition function must be idempotent — calling it twice for the same payment must produce
the same result without double-side-effects.

### Outcome

Payment state changes are safe, auditable, and testable without an HTTP request.

---

## Phase 5: Centralize Notification Dispatch

### Problem

After Phases 3 and 4, notification calls are extracted but still duplicated across enrollment and
payment services. Both places manually know which channels exist (email, SMS, Messenger, Telegram,
Telegram channel invite) and must be kept in sync when channels are added or removed.

### Target structure

```
src/server/notifications/
  dispatchEnrollmentCreated.ts    — after new enrollment
  dispatchPaymentApproved.ts      — after pending → verified
  dispatchPaymentRejected.ts      — after pending → rejected
  dispatchPartialPaymentRequested.ts
```

Each dispatch function:
1. Loads tenant notification settings (email_on_enroll, sms_on_payment, etc.)
2. Calls only the enabled channels.
3. Catches per-channel errors without failing the whole dispatch.

### Stripe success-page flow audit (do this first)

PR #118 (`f94f03f`) added Stripe intent/status verification on the checkout success page. Before
absorbing `src/lib/payment-notifications.ts` into the dispatch functions, audit this flow to
confirm that `dispatchPaymentApproved` will cover the Stripe confirmation path introduced in that
PR. If it does not, add explicit coverage before deleting `payment-notifications.ts`.

### Existing lib files stay as-is

These remain as provider-specific helpers, called by the dispatch functions:

```
src/lib/email.ts
src/lib/sms.ts
src/lib/messenger/
src/lib/telegram/
src/lib/payment-notifications.ts  ← audit first, then absorb into dispatch functions and delete
```

### Outcome

Adding a new notification channel (e.g., WhatsApp) requires touching one file, not searching
every route handler.

---

## Phase 6: TypeScript Health

### Problem

Two recurring code quality issues accumulate throughout the codebase:

**Type casts:** The `as { data: X | null; error: unknown }` pattern appears throughout `api.ts`
and route handlers. This suppresses TypeScript's ability to catch type mismatches at Supabase
query boundaries. The root cause is Supabase's generated types not always matching the inferred
return type for complex queries.

**Hard navigation:** `window.location.href = "/path"` is used in several places. These fall into
two categories that must be treated differently:

- **Legitimate workaround:** Some hard navigations exist because `router.push()` +
  `router.refresh()` has a documented race condition in Next.js 14 App Router (confirmed in
  project memory). These should be kept as-is and annotated with a comment explaining why
  (`// hard redirect: router.push + router.refresh race condition, see MEMORY.md`).
- **Lazy substitution:** Some hard navigations may have been written as a convenience rather than
  to address a real race condition. These should be converted to `router.push()`.

Do not treat all hard navigation sites as the same. Audit each one individually.

### Tasks

**Type casts:**
- Audit all `as unknown as` and `as { data: ... }` cast sites.
- For each, determine if the generated type is wrong (fix the query) or if the type genuinely
  needs a cast (add an explanatory comment).
- Replace silent suppressions with explicit typed helper wrappers where possible.

**Hard navigation:**
- Audit all `window.location.href` usages.
- Categorize each: legitimate race-condition workaround or unnecessary hard redirect.
- For unnecessary ones, fix the underlying cause and convert to `router.push()`.
- For legitimate ones, add an explanatory comment.

### Outcome

TypeScript catches real type errors at Supabase boundaries. Navigation behavior is intentional
and documented.

---

## Phase 7: Payment Provider Consolidation

### Problem

Payment provider logic is split between `src/lib/` helper files and the API routes. The routes
contain provider-specific session creation, status checking, and webhook handling that should live
with the provider.

### Target structure

```
src/server/payment-providers/
  stripe.ts      — intent creation, verification, webhook handling
  paypay.ts      — order creation, status check, webhook handling
  abank.ts       — MMQR session, callback handling
  mmpay.ts       — payment initiation, status polling, webhook
  bankTransfer.ts — manual upload flow
```

Each provider module exports a consistent interface:
- `createSession(params)` → payment URL or QR data
- `checkStatus(ref)` → normalized status
- `handleWebhook(payload)` → normalized event

The existing `src/lib/stripe.ts`, `src/lib/paypay.ts`, etc. either get absorbed into the server
modules or remain as thin HTTP wrappers called by them.

### Outcome

Adding a new payment provider means creating one new file with a known interface.

---

## Phase 8: Tenant Config Centralization

### Problem

Tenant configuration fields (currency, payment mode, MMQR provider, brand color, SMS enabled,
email-on-enroll, etc.) are fetched in many different route handlers, each selecting slightly
different columns. There is no single place that owns "what is the full config for this tenant."

### Target structure

```
src/server/tenants/
  getTenantConfig.ts       — payment settings, notification flags, currency
  getTenantAppearance.ts   — logo, brand color, template
```

Each function takes `tenantId` and returns a typed config object with explicit defaults.

### Outcome

Tenant config defaults are consistent. A new config field is added in one place.

---

## Migration Cleanup (Ongoing)

This is not a phase — it runs in parallel with all phases.

### Tasks

- Document that `000_combined_schema.sql` is a historical reference, not a valid replay baseline.
  `supabase db reset` on a fresh project should use a consolidated single baseline migration.
- Create `100_baseline_schema.sql` from the current prod schema dump as the new canonical baseline.
  Mark 000-010 as deprecated in a comment at the top of each file.
- Note: migrations `072_tenant_agents.sql` and `073_drop_tenant_agents.sql` are already in the
  correct order on disk (072 sorts before 073 alphanumerically). Do not rename them.

---

## What This Does Not Cover

- UI/component reorganization into `src/features/` — this is valid but low risk and low priority.
  Defer until Phases 0-5 are complete.
- Switching to a different ORM or query builder.
- Changing the Supabase auth model.
- Database schema redesign.

---

## Expected Outcome

| After | Rating | What changed |
|-------|--------|-------------|
| Phase 0 | 6.5 → 6.5 | Data is confirmed correct (or fixed) |
| Phases 1-2 | 6.5 → 7.0 | Clean repo, test safety net |
| Phases 3-5 | 7.0 → 7.8 | Core business logic is extracted and tested |
| Phases 6-8 | 7.8 → 8.5 | Type safety, providers, tenant config |

---

## Key Difference From Codex Plan

The Codex plan (`CLEANUP_PLAN.md`) is structurally correct but has two significant gaps:

1. **Tests at Phase 7** — after six phases of refactoring a production app. This spec moves tests
   to Phase 2, before any extraction begins.
2. **Missing Phase 0** — the migration 058 data integrity issue is a live production concern that
   the Codex plan does not mention at all.

Everything else is aligned.
