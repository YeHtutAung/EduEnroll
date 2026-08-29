# Stripe E-Ticket Issuance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A paid Stripe order always ends up with e-tickets — including when the buyer closes the tab, when Stripe retries a webhook, and when a database call fails mid-fulfilment.

**Architecture:** Three concerns are separated: **state transition** (atomic, exactly one winner), **fulfilment assurance** (runs on every trusted paid signal, including already-verified payments, so it self-heals), and **notifications** (only the transition winner). Fulfilment failures propagate so Stripe retries, rather than being swallowed.

**Tech Stack:** Next.js route handlers, Stripe SDK, Supabase, TypeScript, Vitest.

---

## Revision history

**v3 (this document)** — revised after the v2 review. All six findings accepted, and investigating the first one surfaced a **worse variant the review did not reach**.

| v2 said | Reality (verified) | v3 does |
|---|---|---|
| Zero updated rows ⇒ "someone else transitioned it, or already verified" | Also true when the payment is `rejected` or in an unexpected state. `rejected` is reached from abank/status, paypay/status, hitpay webhook and admin rejection. v2 would leave it rejected, confirm the enrollment, and **issue valid admission tickets**. | Explicit state machine; unexpected states return `conflict` and issue nothing. |
| Guard on `payments.status` | **`check_expired_enrollments()` updates `enrollments` and `classes` but NEVER `payments`.** After auto-cancel the payment is still `awaiting_payment` while the enrollment is `rejected` and **its seats have been resold**. So v2's conditional update would *succeed*, `wonTransition: true`, flip the enrollment back to `confirmed`, issue gate tickets and email the customer — **overselling the venue.** Re-reading the payment does not catch this, because the payment write wins. | Guard on the **enrollment** state too. A `rejected` enrollment is a reconciliation case, never an automatic confirm. |
| Task 6 fixes the PaymentIntent insert | `stripe/route.ts:207` has the identical unchecked insert and returns `session.url` anyway — a paid Checkout with no local row, which the webhook then discards as `not-found` with a 2xx. | Task 6 covers **both** creation routes. |
| Keep `if (count > 0) return` | Proves *one* ticket exists, not all of them. With v3's stricter validation, a partial set would never be completed. | Compare against the **expected** count; reconstruct and upsert when short. |
| `{ outcome: "failed" }` drops `wonTransition` | Winner transitions → ticket failure → returns `failed` → no notification → Stripe retries → now `wonTransition: false` → **notifications lost forever**. Regresses today's webhook, which notifies even after a ticket failure. | `wonTransition` is preserved on every outcome; notification policy is explicit. |
| Task 4 mocks `settleStripePayment` but asserts on `issueTicketsMock` | Incoherent — a mocked helper never calls the real one. The tests would pass only by reproducing the implementation in the mock. | Route tests assert the helper was called with the right identifier; ticket assertions live in the settlement suite. |
| Poll returns `{ status: "succeeded" }` on fulfilment failure | UI reads as complete while the ticket is missing. | Adds `fulfillment: "pending"`. |

**v2** — rewritten after the first review. v1 was **not safe to implement**; it would have replaced a visible bug with a rarer silent one.

| v1 said | Reality (verified) | v2 does |
|---|---|---|
| Call `issueTicketsForEnrollment()` inside `if (payment.status !== "verified")`, swallow failures | **Idempotent is not retryable.** Verified → issuance fails → swallowed → every later call skips the block → **permanently no tickets, no error, no retry**. v1 would have converted a visible bug into a silent, unrecoverable one. | Fulfilment runs on **every** trusted paid signal, including already-verified payments. Self-healing. |
| "No change to `issueTicketsForEnrollment` — it is already idempotent" | Idempotent **only at the final upsert**. Before it, four queries discard `error` (`:31`, `:50`, `:61`) and three silent returns (`:43`, `:58`, `:73`) make a DB failure indistinguishable from "nothing to issue". **A blip returns success having issued nothing.** So even a retrying webhook would not help — failures already look like success. | Task 2 hardens it to throw on query failure. |
| Swallow ticket errors so the customer still sees success | Correct for the *polling* route (money is taken; don't show an error). **Wrong for the webhook** — swallowing returns 2xx and Stripe never retries. | Polling swallows; **webhook returns non-2xx** so Stripe retries. |
| `if (status === "verified") return;` then update | Not concurrency-safe. Duplicate webhook deliveries or webhook-vs-poll races can both read `awaiting_payment` and both send email/SMS/Telegram. Tickets are protected by `tickets_enrollment_class_seat_uniq`; **notifications are not**. | Atomic conditional update picks the winner; only the winner notifies. |
| Task 4 changes handler code | Handler code alone does nothing if the Stripe endpoint is not **subscribed** to `payment_intent.succeeded`. | Explicit deployment gate to verify subscription + signing secret + a real delivered event. |
| "No production payment has ever used Stripe" | Absence of `STRIPE_*` today proves Stripe cannot be used **now** — not that keys were never configured before. | Narrowed; confirm via an approved admin/reporting surface before concluding no backfill. |

**Task 4 stays in this PR.** Confirmed by the review and by Stripe's own guidance: fulfilment should be driven from `payment_intent.succeeded`, because browser polling is unreliable when the customer leaves the page.

---

## The defect, with evidence

Reported as "HitPay e-tickets have a QR code, Stripe ones don't". Every Stripe payment in staging is confirmed with **zero** tickets:

```
F-0718-959Z | stripe:verified | tickets=0
F-0718-ZEB7 | stripe:verified | tickets=0
F-0718-RW63 | stripe:verified | tickets=0
F-0718-FCS5 | stripe:verified | tickets=0
F-0718-4ZUY | stripe:verified | tickets=0
```

## Root cause

**Three paths mark a Stripe payment `verified`. Only one issues tickets.**

| Path | Used by | Verifies | Issues tickets |
|---|---|---|---|
| `webhooks/stripe` — `checkout.session.completed` | hosted checkout | ✅ | ✅ |
| `stripe/intent/status` — browser polling | **Payment Element** | ✅ | ❌ |
| `stripe/verify` — redirect return | hosted checkout | ✅ | ❌ |

The Trusted Official checkout uses the **Payment Element / PaymentIntent** flow, which never emits `checkout.session.completed`. The webhook listens only for `checkout.session.completed` and `checkout.session.expired` (verified by grep), so the ticket-issuing branch never runs. Polling confirms instead — and issues nothing.

The polling route carries:

```ts
// Notifications intentionally omitted: Stripe checkout is browser-driven.
// The user is already on the success page. No push notification is needed.
```

Sound reasoning **for notifications**; tickets were dropped by association. A ticket is not a notification — it is the thing the customer bought.

**Contrast:** HitPay, ABank, MMQR and PayPay each confirm in exactly one place and issue tickets there. Stripe is the only provider with three confirmation paths, which is why it is the only one that drifted.

## The failure model (what v1 got wrong)

Fixing the symptom is not enough. The system must survive:

- **Fulfilment failure after confirmation** — must retry, not be stranded
- **Duplicate / out-of-order webhook deliveries** — Stripe guarantees neither uniqueness nor order
- **Concurrency** — poll and webhook racing on the same payment
- **Database failures at any step** — must not read as success

## Architecture

```
Signed Stripe event  /  verified Stripe API response
                    │
                    ▼
        Locate payment   (query error ≠ missing row)
                    │
                    ▼
     Atomic conditional transition → winner?
                    │
    ┌───────────────┼────────────────────────────┐
    │               │                            │
    ▼               ▼                            ▼
Ensure enrollment   ALWAYS ensure tickets    Notify ONLY
  confirmed         (even if already          the winner
                     verified — self-heals)
```

**Fulfilment is unconditional; notification is exclusive.** That split is what makes the system self-healing without spamming customers.

---

## File Structure

- **Modify** `src/server/tickets/issueTickets.ts` — throw on query failure (Task 2)
- **Create** `src/server/payments/settleStripePayment.ts` — the shared settlement helper (Task 3)
- **Modify** `src/app/api/public/payments/stripe/intent/status/route.ts` (Task 4)
- **Modify** `src/app/api/public/payments/stripe/verify/route.ts` (Task 4)
- **Modify** `src/app/api/webhooks/stripe/route.ts` — `payment_intent.succeeded` + retry semantics (Task 5)
- **Modify** `src/app/api/public/payments/stripe/intent/route.ts` — payment-insert error (Task 6)
- **Create** `src/__tests__/payments/issueTickets-failures.test.ts` (Task 2)
- **Create** `src/__tests__/payments/settleStripePayment.test.ts` (Task 3)
- **Create** `src/__tests__/payments/stripe-settlement-routes.test.ts` (Tasks 4–6)

---

## Task 1: Branch from dev — DO THIS FIRST

**No edits before this completes.**

- [ ] **Step 1: Preserve unrelated state**

```powershell
git status --short
```

Expect only known untracked docs / `AGENTS.md` / `design_handoff_sponsor_placements/` and modified `.claude/settings.local.json`. **Not ours.** If tracked `src/` files are modified, stop.

- [ ] **Step 2: Branch**

```powershell
git fetch origin dev
git rev-list --left-right --count origin/dev...dev
```

The **right-hand** count must be `0`. A non-zero left count only means dev moved ahead; `pull --ff-only` resolves it — not a stop condition.

```powershell
git checkout dev
git pull --ff-only origin dev
git checkout -b fix/stripe-ticket-issuance
git branch --show-current
```

- [ ] **Step 3: Record the baseline**

```powershell
npm test
```

Expect **exactly 1 failure — `src/__tests__/scanner/events.test.ts`** (pre-existing). Note the pass count. The bar is **no new failures**.

---

## Task 2: Make ticket issuance fail loudly

**Everything else depends on this.** A retrying webhook is useless while failures already look like success.

**Files:**
- Modify: `src/server/tickets/issueTickets.ts`
- Test: `src/__tests__/payments/issueTickets-failures.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// A DB failure must NOT look like "nothing to issue". Today every one of these
// returns normally having issued nothing, and the caller sees success.
it("throws when the enrollment lookup fails", async () => {
  enrollmentResult = { data: null, error: { message: "connection refused" } };
  await expect(issueTicketsForEnrollment("enroll-1")).rejects.toThrow();
});

it("throws when the cart-item lookup fails", async () => {
  itemsResult = { data: null, error: { message: "timeout" } };
  await expect(issueTicketsForEnrollment("enroll-1")).rejects.toThrow();
});

it("throws when the classes lookup fails", async () => {
  classesResult = { data: null, error: { message: "timeout" } };
  await expect(issueTicketsForEnrollment("enroll-1")).rejects.toThrow();
});

// A confirmed payment whose enrollment has vanished is a fulfilment failure,
// not a no-op — it must surface, not be swallowed.
it("throws when a confirmed enrollment does not exist", async () => {
  enrollmentResult = { data: null, error: null };
  await expect(issueTicketsForEnrollment("enroll-1")).rejects.toThrow();
});

it("throws when the enrollment has no ticketable lines", async () => {
  // class_id null and no enrollment_items
  await expect(issueTicketsForEnrollment("enroll-1")).rejects.toThrow();
});

// Data that is present but inconsistent must not silently issue fewer tickets.
it("throws when a referenced class is missing", async () => {
  classesResult = { data: [], error: null }; // line references a class that isn't there
  await expect(issueTicketsForEnrollment("enroll-1")).rejects.toThrow();
});

// Existing behaviour that must survive.
it("returns without issuing when tickets already exist", async () => {
  ticketCount = 3;
  await issueTicketsForEnrollment("enroll-1");
  expect(upsertMock).not.toHaveBeenCalled();
});

it("still upserts with ignoreDuplicates for concurrent callers", async () => {
  await issueTicketsForEnrollment("enroll-1");
  expect(upsertMock).toHaveBeenCalledWith(expect.anything(), {
    onConflict: "enrollment_id,class_id,seat_no",
    ignoreDuplicates: true,
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```powershell
npx vitest run src/__tests__/payments/issueTickets-failures.test.ts
```

Expected: the six `throws` tests FAIL (current code returns normally). The two behaviour-preservation tests pass already.

- [ ] **Step 3: Implement**

Capture `error` on all three queries and throw. Distinguish the cases in the message so logs are diagnosable:

```ts
const { data: enrollment, error: enrollmentError } = ...
if (enrollmentError) throw new Error(`issueTickets: enrollment lookup failed: ${JSON.stringify(enrollmentError)}`);
if (!enrollment) throw new Error(`issueTickets: enrollment ${enrollmentId} not found`);
```

Same shape for `enrollment_items` and `classes`. Replace `if (!c) continue;` with a throw naming the missing class id — silently issuing fewer tickets than paid for is worse than failing.

**Replace the count fast-path.** `if ((count ?? 0) > 0) return;` proves *one* ticket exists, not all of them — and with the stricter validation above, a partially-issued enrollment could never be completed. Build the expected rows first, then skip only when `existingCount >= expectedRows.length`; otherwise fall through to the upsert, which `ignoreDuplicates` makes safe. Keep the count query itself **non-fatal** (its comment is right: the unique index is authoritative, so a count failure should fall through rather than block fulfilment).

**Keep the upsert exactly as-is** — `onConflict` + `ignoreDuplicates` + throw on error is what makes concurrent callers safe.

- [ ] **Step 4: Run to verify they pass**

- [ ] **Step 5: Full suite** — other providers call this helper; a new throw could surface elsewhere.

```powershell
npm test
```

**If another provider's test now fails, do not soften this helper.** It means that caller was relying on silent failure; fix the caller.

- [ ] **Step 6: Commit**

```powershell
git status --short
git add src/server/tickets/issueTickets.ts src/__tests__/payments/issueTickets-failures.test.ts
git diff --cached -- src/server/tickets/issueTickets.ts src/__tests__/payments/issueTickets-failures.test.ts
git commit -m "fix: make ticket issuance fail loudly instead of silently issuing nothing"
```

---

## Task 3: The shared settlement helper

**Files:**
- Create: `src/server/payments/settleStripePayment.ts`
- Test: `src/__tests__/payments/settleStripePayment.test.ts`

**Contract:**

```ts
type SettleResult =
  | { outcome: "settled";  wonTransition: boolean; enrollmentId: string }
  // wonTransition is preserved here too — see step 6.
  | { outcome: "failed";   wonTransition: boolean; enrollmentId?: string; reason: string }
  | { outcome: "conflict"; reason: string }   // needs a human; never auto-confirm
  | { outcome: "not-found" };

settleStripePayment(lookup: { sessionId?: string; paymentIntentId?: string }, details?: {...}): Promise<SettleResult>
```

Behaviour, in order:

1. **Locate the payment**, capturing `error`. A query failure returns `failed` — **never** `not-found`. ("No answer" ≠ "the answer is no": the same defect as ABank, the custom-domain preflight, the enrolment index and `issueTickets`.)

2. **Read the enrollment state before writing anything.** This guard is not optional:

   > `check_expired_enrollments()` sets `enrollments.status = 'rejected'` and **restores the seats**, but never touches `payments`. So an expired order leaves the payment at `awaiting_payment` while the enrollment is rejected and its seats have been resold. Without this check the conditional update below *succeeds*, and the helper would un-reject the enrollment, issue valid gate tickets, and email the buyer — **overselling the venue.**

   If the enrollment is not `pending_payment` or `confirmed` → return `conflict`. Do not transition, do not confirm, do not issue tickets. A late Stripe success against a cancelled order is a **refund/reconciliation** decision, not something to auto-resolve.

3. **Branch on payment status, explicitly:**

   | Status | Action |
   |---|---|
   | `awaiting_payment` | attempt the conditional transition (step 4) |
   | `verified` | skip the transition; still ensure enrollment + tickets (self-heal) |
   | `rejected` or anything else | return `conflict` — issue nothing |

4. **Atomic conditional transition.** One statement decides the winner:
   ```ts
   const { data: won, error } = await supabase
     .from("payments")
     .update({ status: "verified", paid_at: ..., ...details })
     .eq("id", payment.id)
     .eq("status", "awaiting_payment")
     .select("id");
   ```
   `won.length === 1` → this caller transitioned it. **`0` proves nothing on its own** — re-read the payment and continue only if it is now `verified`; any other state is `conflict`. A read-then-write cannot do this safely.

5. **Ensure the enrollment is confirmed** — idempotent; capture the error.

6. **Always ensure tickets exist** — call `issueTicketsForEnrollment` *including* when `wonTransition` is false. **This is the self-healing property.** A throw returns `failed` — **carrying `wonTransition` through**, so a winner that later fails does not lose its notification claim.

7. **Return.** The helper never notifies; the caller decides from `wonTransition`.

**Notification policy — chosen deliberately.** A winner whose fulfilment then fails returns `{ outcome: "failed", wonTransition: true }`. The webhook **notifies anyway** before returning non-2xx, matching today's behaviour (the current webhook proceeds to notifications after a ticket failure). The alternative — withholding until fulfilment succeeds — loses the notification entirely on retry, because the retry is no longer the winner. Accepting a possible "your payment succeeded" email slightly ahead of the ticket is better than silence. **This is a deliberate trade, not an oversight; a durable outbox is the real fix and is out of scope.**

- [ ] **Step 1: Write the failing tests**

```ts
it("returns failed, not not-found, when the payment lookup errors", async () => {
  paymentResult = { data: null, error: { message: "boom" } };
  expect(await settle({ paymentIntentId: "pi_1" })).toMatchObject({ outcome: "failed" });
});

it("returns not-found only for a genuinely absent payment", async () => {
  paymentResult = { data: null, error: null };
  expect(await settle({ paymentIntentId: "pi_1" })).toEqual({ outcome: "not-found" });
});

it("reports wonTransition true for the caller that flips awaiting -> verified", async () => {
  updateResult = { data: [{ id: "pay-1" }], error: null };
  expect(await settle({ paymentIntentId: "pi_1" })).toMatchObject({ wonTransition: true });
});

it("reports wonTransition false when another caller already transitioned it", async () => {
  updateResult = { data: [], error: null };   // conditional update matched nothing
  expect(await settle({ paymentIntentId: "pi_1" })).toMatchObject({ wonTransition: false });
});

// THE SELF-HEALING PROPERTY — the whole point of this rewrite.
it("still ensures tickets for an already-verified payment", async () => {
  updateResult = { data: [], error: null };   // already verified, lost the race
  await settle({ paymentIntentId: "pi_1" });
  expect(issueTicketsMock).toHaveBeenCalledWith("enroll-1");
});

it("returns failed when ticket issuance throws", async () => {
  issueTicketsMock.mockRejectedValue(new Error("db down"));
  expect(await settle({ paymentIntentId: "pi_1" })).toMatchObject({ outcome: "failed" });
});

it("returns failed when the payment update errors", async () => {
  updateResult = { data: null, error: { message: "boom" } };
  expect(await settle({ paymentIntentId: "pi_1" })).toMatchObject({ outcome: "failed" });
});

it("returns failed when the enrollment update errors", async () => {
  enrollmentUpdateResult = { error: { message: "boom" } };
  expect(await settle({ paymentIntentId: "pi_1" })).toMatchObject({ outcome: "failed" });
});

it("never sends notifications itself", async () => {
  await settle({ paymentIntentId: "pi_1" });
  expect(sendEmailMock).not.toHaveBeenCalled();
});

// ── The overselling guard. These are the security-relevant cases. ──────────

// Auto-cancel rejects the ENROLLMENT and restores seats without touching the
// payment, so the conditional update would otherwise succeed and un-reject it.
it("issues nothing when the enrollment was already rejected", async () => {
  enrollmentStatus = "rejected";
  const r = await settle({ paymentIntentId: "pi_1" });
  expect(r).toMatchObject({ outcome: "conflict" });
  expect(issueTicketsMock).not.toHaveBeenCalled();
  expect(enrollmentUpdateMock).not.toHaveBeenCalled();  // must not un-reject
});

it("issues nothing when the payment itself is rejected", async () => {
  paymentStatus = "rejected";
  const r = await settle({ paymentIntentId: "pi_1" });
  expect(r).toMatchObject({ outcome: "conflict" });
  expect(issueTicketsMock).not.toHaveBeenCalled();
});

it("returns conflict for an unexpected payment status", async () => {
  paymentStatus = "pending";
  expect(await settle({ paymentIntentId: "pi_1" })).toMatchObject({ outcome: "conflict" });
});

// Zero updated rows proves nothing by itself — re-read and decide.
it("continues when the conditional update loses to a concurrent verification", async () => {
  updateResult = { data: [], error: null };
  rereadStatus = "verified";
  const r = await settle({ paymentIntentId: "pi_1" });
  expect(r).toMatchObject({ outcome: "settled", wonTransition: false });
  expect(issueTicketsMock).toHaveBeenCalled();
});

it("conflicts when the conditional update loses to a concurrent rejection", async () => {
  updateResult = { data: [], error: null };
  rereadStatus = "rejected";
  const r = await settle({ paymentIntentId: "pi_1" });
  expect(r).toMatchObject({ outcome: "conflict" });
  expect(issueTicketsMock).not.toHaveBeenCalled();
});

// ── Notification ownership survives partial failure ───────────────────────
// Without this the winner returns `failed`, the retry is no longer the winner,
// and the customer is never told at all.
it("preserves wonTransition when ticket issuance fails", async () => {
  issueTicketsMock.mockRejectedValue(new Error("db down"));
  expect(await settle({ paymentIntentId: "pi_1" }))
    .toMatchObject({ outcome: "failed", wonTransition: true });
});

it("preserves wonTransition when the enrollment update fails", async () => {
  enrollmentUpdateResult = { error: { message: "boom" } };
  expect(await settle({ paymentIntentId: "pi_1" }))
    .toMatchObject({ outcome: "failed", wonTransition: true });
});
```

- [ ] **Step 2–4: Red, implement, green**

- [ ] **Step 5: Commit**

```powershell
git status --short
git add src/server/payments/settleStripePayment.ts src/__tests__/payments/settleStripePayment.test.ts
git diff --cached -- src/server/payments/settleStripePayment.ts src/__tests__/payments/settleStripePayment.test.ts
git commit -m "feat: add an atomic, self-healing Stripe settlement helper"
```

---

## Task 4: Route the two client-driven paths through it

**Files:**
- Modify: `src/app/api/public/payments/stripe/intent/status/route.ts`
- Modify: `src/app/api/public/payments/stripe/verify/route.ts`
- Test: `src/__tests__/payments/stripe-settlement-routes.test.ts`

**Error posture differs from the webhook by design.** These are browser-facing: the money is taken and the customer is on the success page, so a fulfilment failure must **not** render an error. It is logged, and the webhook (Task 5) retries. Do **not** copy the webhook's non-2xx behaviour here.

- [ ] **Step 1: Write the failing tests**

```ts
it("issues tickets when the intent poll confirms", async () => {
  await GET(pollReq("pi_1"));
  expect(issueTicketsMock).toHaveBeenCalledWith("enroll-1");
});

// Self-healing: a verified payment with no tickets must recover on the next poll.
it("issues tickets for an already-verified payment with none", async () => {
  paymentStatus = "verified";
  await GET(pollReq("pi_1"));
  expect(issueTicketsMock).toHaveBeenCalledWith("enroll-1");
});

it("still reports succeeded when fulfilment fails", async () => {
  settleMock.mockResolvedValue({ outcome: "failed", reason: "db" });
  const res = await GET(pollReq("pi_1"));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ status: "succeeded" });
});

it("does not settle while the intent is pending", async () => {
  intentStatus = "requires_action";
  await GET(pollReq("pi_1"));
  expect(settleMock).not.toHaveBeenCalled();
});

it("issues tickets when the redirect return confirms", async () => {
  await GET(verifyReq("cs_1"));
  expect(issueTicketsMock).toHaveBeenCalledWith("enroll-1");
});

it("does not settle an unpaid session", async () => {
  sessionPaymentStatus = "unpaid";
  await GET(verifyReq("cs_1"));
  expect(settleMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 2–4: Red, implement, green**

Replace each route's inline confirm block with a `settleStripePayment(...)` call. Both ignore `wonTransition` — neither notifies today, and the polling route's comment explaining why remains correct.

- [ ] **Step 5: Commit**

---

## Task 5: `payment_intent.succeeded` + retry semantics

**Not optional cleanup.** Without it, a PayNow buyer who pays and closes the tab is never confirmed at all — Stripe holds the money, the database never learns.

**Files:**
- Modify: `src/app/api/webhooks/stripe/route.ts`
- Test: `src/__tests__/payments/stripe-settlement-routes.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("settles on payment_intent.succeeded", async () => {
  await POST(hookReq(piSucceeded));
  expect(settleMock).toHaveBeenCalledWith(
    expect.objectContaining({ paymentIntentId: "pi_1" }), expect.anything(),
  );
});

// Stripe retries on non-2xx. Swallowing a fulfilment failure would strand it.
it("returns non-2xx when settlement fails, so Stripe retries", async () => {
  settleMock.mockResolvedValue({ outcome: "failed", reason: "db down" });
  const res = await POST(hookReq(piSucceeded));
  expect(res.status).toBeGreaterThanOrEqual(500);
});

// A genuinely unknown payment is NOT retryable — 2xx, or Stripe retries forever.
it("returns 2xx for a payment that does not exist", async () => {
  settleMock.mockResolvedValue({ outcome: "not-found" });
  const res = await POST(hookReq(piSucceeded));
  expect(res.status).toBe(200);
});

it("notifies only when it won the transition", async () => {
  settleMock.mockResolvedValue({ outcome: "settled", wonTransition: false, enrollmentId: "e1" });
  await POST(hookReq(piSucceeded));
  expect(sendEmailMock).not.toHaveBeenCalled();
});

it("notifies when it did win", async () => {
  settleMock.mockResolvedValue({ outcome: "settled", wonTransition: true, enrollmentId: "e1" });
  await POST(hookReq(piSucceeded));
  expect(sendEmailMock).toHaveBeenCalled();
});

// Duplicate delivery — Stripe does not guarantee uniqueness.
it("does not double-notify on a duplicate delivery", async () => {
  settleMock.mockResolvedValueOnce({ outcome: "settled", wonTransition: true, enrollmentId: "e1" })
            .mockResolvedValueOnce({ outcome: "settled", wonTransition: false, enrollmentId: "e1" });
  await POST(hookReq(piSucceeded));
  await POST(hookReq(piSucceeded));
  expect(sendEmailMock).toHaveBeenCalledTimes(1);
});

// Regression guard: signature verification stays in front of everything.
it("rejects an invalid signature", async () => {
  constructEventMock.mockImplementation(() => { throw new Error("bad sig"); });
  expect((await POST(hookReq(piSucceeded, "bad"))).status).toBe(400);
});
```

- [ ] **Step 2–4: Red, implement, green**

Route `checkout.session.completed` through the same helper so both branches share one settlement path. Extract the notification block into a function called only when `wonTransition` is true — **do not duplicate it**; three near-identical paths drifting is why this bug exists.

- [ ] **Step 5: Commit**

---

## Task 6: Don't hand out a client secret with no payment row

`intent/route.ts:102` inserts the payment record and ignores the error. If that insert fails, the client gets a `clientSecret`, the customer pays, and **no confirmation path can find the payment** — every settlement returns `not-found`.

**Files:**
- Modify: `src/app/api/public/payments/stripe/intent/route.ts`
- Test: `src/__tests__/payments/stripe-settlement-routes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("does not return a client secret when the payment row cannot be saved", async () => {
  insertResult = { error: { message: "db down" } };
  const res = await POST(intentReq());
  expect(res.status).toBeGreaterThanOrEqual(500);
  expect(await res.json()).not.toHaveProperty("clientSecret");
});
```

- [ ] **Steps 2–4: Red, implement, green.** Capture the insert error and return 502/500 rather than a secret. The orphaned PaymentIntent is harmless — uncharged, and it expires.

- [ ] **Step 5: Commit**

---

## Task 7: Verify and open the PR

- [ ] **Step 1: Gates — separately, never chained**

`dev` has a known baseline failure, so `&&` would stop at `npm test`. PowerShell has no `&&` anyway.

```powershell
npm test
npm run lint
npm run build
```

**`npm run build`: judge by exit code.** `next build` prints "Compiled successfully" *then* type-checks — that line is not the verdict.

- [ ] **Step 2: Review the complete diff**

```powershell
git branch --show-current
git status --short
git fetch origin dev
git rev-list --left-right --count origin/dev...HEAD
git diff --stat origin/dev...HEAD
```

Expected exactly: `issueTickets.ts`, `settleStripePayment.ts`, three Stripe routes, the webhook, three test files. Anything else is a stop condition.

- [ ] **Step 3: Open the PR** — base `dev`, **never self-merge**. Public repo: describe behaviour, not exploit recipes.

---

## Deployment gates

**Code alone does not make Task 5 work.** The Stripe endpoint must be *subscribed* to the event.

- [ ] **Confirm the webhook endpoint URL** in the Stripe dashboard for that environment
- [ ] **Confirm `payment_intent.succeeded` is enabled** on it — if it only sends Checkout events, the new branch never runs and will look broken while being correct
- [ ] **Confirm the signing secret belongs to that exact endpoint and environment.** `STRIPE_WEBHOOK_SECRET` is currently scoped to plain `Preview` (not `Preview (staging)`) and is **82 days old** — it likely predates the current sandbox. A mismatch means 400 on every delivery.
- [ ] **Deliver a real sandbox event** and confirm success in the Stripe dashboard
- [ ] Do all of the above **before** live Stripe keys are added to production

### Functional verification on staging

- [ ] Stripe **card** payment → ticket with QR appears
- [ ] Stripe **PayNow** payment → same
- [ ] **Pay by PayNow, then close the tab before the success page.** The webhook must still confirm and issue tickets. **This is the case that fails today.**
- [ ] HitPay still issues exactly one ticket per enrollment — no double-issue
- [ ] A verified payment with no tickets self-heals on the next poll or webhook delivery

The 5 existing staging enrollments are already `verified`. Under v2 they **should** self-heal on the next trusted signal — worth confirming, as it exercises the property directly.

---

## Production backfill — confirm, don't assume

Production has no `STRIPE_*` variables today, so Stripe cannot currently be used. That does **not** prove keys were never configured previously.

- [ ] Before concluding no backfill is needed, confirm via an **approved admin/reporting surface** (not direct database access — `CLAUDE.md`: production DB is off limits) that no production Stripe payment exists without tickets.

---

## Out of Scope

| Item | Why |
|---|---|
| Notifications from the polling route | Correct as-is — the buyer is on the success page. Tickets are not notifications. |
| Other providers | Each confirms in exactly one place and already issues tickets there. Task 2's stricter helper may surface latent issues in them — that is a feature; fix the caller, don't soften the helper. |
| A durable job queue for fulfilment | Stripe's own retries provide this for the webhook path. A queue is the right answer at higher volume, not now. |
| Collapsing the three confirmation paths into one | The real root cause, but a refactor of live payment code. The shared helper gets most of the benefit; revisit later. |
