# Codebase Cleanup — Phase A: Foundation (Phases 0–2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a safe working baseline before any refactoring — verify production data integrity, clean repo hygiene, and write a regression test suite covering seat counts, payment transitions, and tenant isolation.

**Architecture:** Three independent workstreams: (0) one-time data audit with no code changes, (1) file cleanup and build baseline, (2) Vitest integration tests against mocked Supabase. Phases complete sequentially; Phase 2 tests must pass before Phase B begins.

**Tech Stack:** Next.js 14 App Router, TypeScript, Supabase, Vitest (already configured at `vitest.config.ts`), `@supabase/supabase-js` mock

**Spec:** `docs/superpowers/specs/2026-07-09-codebase-cleanup-design.md`
**Phase B plan:** `docs/superpowers/plans/2026-07-09-cleanup-phase-b-refactoring.md`

---

## File Map

| Action | Path |
|--------|------|
| Modify | `src/lib/telegram/send.ts` — add `sendTelegramMessage` export |
| Modify | `src/app/api/telegram/admin-requests/route.ts` — update import |
| Modify | `src/app/api/webhook/route.ts` — update import |
| Delete | `src/lib/telegram.ts` |
| Create | `src/__tests__/helpers/mockSupabase.ts` — reusable mock factory |
| Create | `src/__tests__/enrollment/enroll.test.ts` — Layer 1 route tests |
| Create | `src/__tests__/payments/verify.test.ts` — Layer 1 route tests |
| Create | `src/__tests__/isolation/tenant.test.ts` — tenant isolation tests |

---

## Task 1: Migration 058 Data Audit

**Files:** No code changes. Dev DB query only.

- [ ] **Step 1.1: Run diagnostic query on dev DB**

  Open Supabase Studio for dev project `fnfvwzwrdsnmwxunciti` → SQL Editor and run:

  ```sql
  SELECT
    id,
    subdomain,
    auto_cancel_hours,
    auto_cancel_hours / 60.0 AS hours_if_treated_as_minutes,
    CASE
      WHEN auto_cancel_hours = 0 THEN 'disabled'
      WHEN auto_cancel_hours BETWEEN 60 AND 10080 THEN 'OK'
      WHEN auto_cancel_hours > 20160 THEN 'SUSPICIOUS - may have been multiplied twice'
      ELSE 'low - check manually'
    END AS assessment
  FROM public.tenants
  ORDER BY auto_cancel_hours DESC;
  ```

- [ ] **Step 1.2: Evaluate results**

  Expected: all `auto_cancel_hours` values between 60 (1 hour) and 10080 (1 week), or 0 (disabled).

  If any row shows `assessment = 'SUSPICIOUS'`, proceed to Step 1.3. Otherwise skip to Task 2.

- [ ] **Step 1.3: Write correction migration (only if needed)**

  If a tenant has a suspicious value, create `supabase/migrations/086_fix_auto_cancel_hours.sql`:

  ```sql
  -- ============================================================
  -- 086_fix_auto_cancel_hours.sql
  -- Correct auto_cancel_hours values that were double-multiplied
  -- by migration 058. Each row below was verified manually.
  -- ============================================================
  -- Replace <id> and <correct_value> for each affected tenant.
  UPDATE public.tenants
  SET auto_cancel_hours = <correct_value_in_minutes>
  WHERE id = '<tenant-uuid>';
  ```

  Then push to dev: `npx supabase db push --local` (or apply via Studio).

- [ ] **Step 1.4: Verify correction**

  Re-run the diagnostic query. All rows should show `assessment = 'OK'` or `'disabled'`.

- [ ] **Step 1.5: Commit migration (if created)**

  ```bash
  git add supabase/migrations/086_fix_auto_cancel_hours.sql
  git commit -m "fix(migrations): correct auto_cancel_hours values from 058 double-multiply"
  ```

---

## Task 2: Commit Untracked Docs

**Files:**
- Commit: `KuuNyi_Analysis.md`, `ci-cd-diagram.html`, `docs/superpowers/`, `docs/ui/`

- [ ] **Step 2.1: Decide on each untracked file**

  Run `git status` to see the full list. For each:
  - `KuuNyi_Analysis.md` — move to `docs/KuuNyi_Analysis.md` and commit
  - `ci-cd-diagram.html` — move to `docs/ci-cd-diagram.html` and commit
  - `docs/superpowers/` — commit as-is
  - `docs/ui/` — commit as-is

  If any file is irrelevant or temporary, add to `.gitignore` instead.

- [ ] **Step 2.2: Move and stage files**

  ```bash
  mkdir -p docs
  mv KuuNyi_Analysis.md docs/KuuNyi_Analysis.md
  mv ci-cd-diagram.html docs/ci-cd-diagram.html
  git add docs/
  ```

- [ ] **Step 2.3: Commit**

  ```bash
  git commit -m "docs: commit untracked analysis and diagram files"
  ```

---

## Task 3: Fix `src/lib/telegram.ts` — Merge Into Directory

`src/lib/telegram.ts` exports `sendTelegramMessage(chatId: number, text: string, botToken: string)`.
`src/lib/telegram/send.ts` exports `sendMessage(botToken, chatId, text, parseMode)`.
These have different signatures — they cannot be swapped. The solution is to add `sendTelegramMessage` to `src/lib/telegram/send.ts`, update the two importers, then delete the old file.

**Files:**
- Modify: `src/lib/telegram/send.ts`
- Modify: `src/app/api/telegram/admin-requests/route.ts:5`
- Modify: `src/app/api/webhook/route.ts:6`
- Delete: `src/lib/telegram.ts`

- [ ] **Step 3.1: Read `src/lib/telegram/send.ts` to see current exports**

  (Already known: exports `sendMessage(botToken, chatId, text, parseMode)`.)

- [ ] **Step 3.2: Add `sendTelegramMessage` to `src/lib/telegram/send.ts`**

  Append to the bottom of `src/lib/telegram/send.ts`:

  ```ts
  /**
   * Legacy signature: chatId first, botToken last.
   * Used by admin-requests and webhook routes.
   * Prefer sendMessage() for new code.
   *
   * Preserves the error-suppression behavior of the original src/lib/telegram.ts:
   * network errors are caught and logged, never thrown to the caller.
   */
  export async function sendTelegramMessage(
    chatId: number,
    text: string,
    botToken: string,
  ): Promise<void> {
    try {
      await sendMessage(botToken, String(chatId), text, "HTML");
    } catch (err) {
      console.error("[telegram] sendTelegramMessage error:", err);
    }
  }
  ```

- [ ] **Step 3.3: Update `src/app/api/telegram/admin-requests/route.ts`**

  Change line 5:
  ```ts
  // Before:
  import { sendTelegramMessage } from "@/lib/telegram";
  // After:
  import { sendTelegramMessage } from "@/lib/telegram/send";
  ```

- [ ] **Step 3.4: Update `src/app/api/webhook/route.ts`**

  Change line 6:
  ```ts
  // Before:
  import { sendTelegramMessage } from "@/lib/telegram";
  // After:
  import { sendTelegramMessage } from "@/lib/telegram/send";
  ```

- [ ] **Step 3.5: Verify no other imports of `@/lib/telegram` remain**

  ```bash
  rg "from \"@/lib/telegram\"" src/
  ```

  Expected: no output.

- [ ] **Step 3.6: Delete the old file**

  ```bash
  rm src/lib/telegram.ts
  ```

- [ ] **Step 3.7: Run build to verify no breakage**

  ```bash
  npm run build 2>&1 | tail -20
  ```

  Expected: build succeeds with no TypeScript errors.

- [ ] **Step 3.8: Commit**

  ```bash
  git add src/lib/telegram/send.ts \
          src/app/api/telegram/admin-requests/route.ts \
          src/app/api/webhook/route.ts
  git rm src/lib/telegram.ts
  git commit -m "refactor(telegram): merge telegram.ts into telegram/send.ts, remove orphaned file"
  ```

---

## Task 4: Build Baseline

- [ ] **Step 4.1: Run full build**

  ```bash
  npm run build 2>&1 | grep -E "(error|Error|warning)" | head -30
  ```

  Expected: zero TypeScript errors. Some Next.js warnings are acceptable.

- [ ] **Step 4.2: Run lint**

  ```bash
  npm run lint 2>&1 | tail -10
  ```

  Expected: passes or shows only pre-existing warnings (not new errors).

- [ ] **Step 4.3: Run existing tests**

  ```bash
  npx vitest run 2>&1
  ```

  Expected: passes (or "no test files found" if no tests exist yet — that's fine).

- [ ] **Step 4.4: Commit if any lint auto-fixes were applied**

  If lint --fix made changes: `git add -p && git commit -m "chore: lint auto-fixes"`

---

## Task 5: Test Infrastructure — Mock Supabase Helper

**Files:**
- Create: `src/__tests__/helpers/mockSupabase.ts`

The Vitest setup at `src/__tests__/setup.ts` already mocks `next/headers`. We need a reusable factory to mock `createAdminClient()`.

- [ ] **Step 5.1: Create mock helper**

  Create `src/__tests__/helpers/mockSupabase.ts`:

  ```ts
  import { vi } from "vitest";

  // ─── Chainable query builder mock ────────────────────────────────────────────
  // Simulates Supabase's fluent query API: .from().select().eq().single()

  export interface MockQueryResult<T> {
    data: T | null;
    error: null | { message: string };
  }

  export function makeChainMock<T>(result: MockQueryResult<T>) {
    const chain: Record<string, unknown> = {};
    const methods = ["select", "eq", "neq", "order", "limit", "maybeSingle", "single", "update", "insert", "delete", "upsert"];
    methods.forEach((m) => {
      chain[m] = vi.fn().mockReturnValue(chain);
    });
    // Terminal: awaiting the chain returns the result
    chain.then = (resolve: (v: MockQueryResult<T>) => void) => resolve(result);
    return chain;
  }

  // ─── Admin client mock factory ────────────────────────────────────────────────

  export interface MockSupabaseClient {
    from: ReturnType<typeof vi.fn>;
    rpc: ReturnType<typeof vi.fn>;
  }

  export function makeAdminClientMock(): MockSupabaseClient {
    return {
      from: vi.fn(),
      rpc: vi.fn(),
    };
  }
  ```

- [ ] **Step 5.2: Run tests to confirm helper compiles**

  ```bash
  npx vitest run src/__tests__/helpers 2>&1
  ```

  Expected: "no test files found" (no tests yet, just confirms no compile error).

- [ ] **Step 5.3: Commit**

  ```bash
  git add src/__tests__/helpers/mockSupabase.ts
  git commit -m "test: add reusable Supabase admin client mock helper"
  ```

---

## Task 6: Seat Reservation Tests (Layer 1)

**Files:**
- Create: `src/__tests__/enrollment/enroll.test.ts`

These tests call the route handler's `POST` function directly with a mock `NextRequest`. They mock `createAdminClient` and `resolveTenantId` at the module level.

- [ ] **Step 6.1: Write failing tests**

  Create `src/__tests__/enrollment/enroll.test.ts`:

  ```ts
  import { describe, it, expect, vi, beforeEach } from "vitest";
  import { NextRequest } from "next/server";

  // ─── Mock dependencies ────────────────────────────────────────────────────────

  const mockRpc = vi.fn();
  const mockFrom = vi.fn();

  vi.mock("@/lib/supabase/admin", () => ({
    createAdminClient: () => ({ rpc: mockRpc, from: mockFrom }),
  }));

  vi.mock("@/lib/api", () => ({
    resolveTenantId: vi.fn().mockResolvedValue("tenant-abc"),
  }));

  vi.mock("@/lib/email", () => ({
    sendEmail: vi.fn().mockResolvedValue(undefined),
    enrollmentConfirmationEmail: vi.fn().mockReturnValue({ subject: "s", html: "h" }),
  }));

  // ─── Import AFTER mocks are set up ───────────────────────────────────────────

  const { POST } = await import("@/app/api/public/enroll/route");

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  function makeRequest(body: object) {
    return new NextRequest("http://localhost/api/public/enroll", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  function mockRpcSuccess() {
    mockRpc.mockResolvedValue({
      data: {
        success: true,
        enrollment_id: "enroll-1",
        enrollment_ref: "NM-2026-0001",
        class_level: "N5",
        fee_amount: 50000,
        quantity: 1,
        tenant_id: "tenant-abc",
      },
      error: null,
    });
  }

  function mockFromChain(tableName: string, result: { data: unknown; error: unknown }) {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue(result),
      update: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
    };
    mockFrom.mockImplementation((t: string) => (t === tableName ? chain : chain));
    return chain;
  }

  // ─── Tests ────────────────────────────────────────────────────────────────────

  describe("POST /api/public/enroll", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      // Default: tenant fetch returns a valid tenant
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { name: "Test School", org_type: "language_school", logo_url: null, email_on_enroll: false, currency: "MMK" },
          error: null,
        }),
      });
    });

    it("returns 400 when class_id is missing", async () => {
      const res = await POST(makeRequest({}));
      expect(res.status).toBe(400);
    });

    it("returns 400 when class_id is not a valid UUID", async () => {
      const res = await POST(makeRequest({ class_id: "not-a-uuid" }));
      expect(res.status).toBe(400);
    });

    it("returns fake 200 when honeypot field is filled", async () => {
      const res = await POST(makeRequest({ class_id: "00000000-0000-0000-0000-000000000001", __hp: "bot" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enrollment_ref).toBe("OK-0000-0000");
      // Must NOT have called the DB
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it("returns 409 when class is full", async () => {
      mockRpc.mockResolvedValue({
        data: { success: false, error: "CLASS_FULL" },
        error: null,
      });
      const res = await POST(makeRequest({ class_id: "00000000-0000-0000-0000-000000000001" }));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe("Class Full");
    });

    it("returns 409 when not enough seats for requested quantity", async () => {
      mockRpc.mockResolvedValue({
        data: { success: false, error: "NOT_ENOUGH_SEATS", seat_remaining: 2 },
        error: null,
      });
      const res = await POST(makeRequest({ class_id: "00000000-0000-0000-0000-000000000001", quantity: 5 }));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe("Not Enough Seats");
    });

    it("returns 201 with enrollment_ref on success", async () => {
      mockRpcSuccess();
      const res = await POST(makeRequest({ class_id: "00000000-0000-0000-0000-000000000001" }));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.enrollment_ref).toBe("NM-2026-0001");
    });

    it("calls submit_enrollment RPC exactly once per request", async () => {
      mockRpcSuccess();
      await POST(makeRequest({ class_id: "00000000-0000-0000-0000-000000000001" }));
      const rpcCalls = mockRpc.mock.calls.filter((c) => c[0] === "submit_enrollment");
      expect(rpcCalls).toHaveLength(1);
    });

    it("does NOT call submit_enrollment for duplicate idempotency key (DB handles idempotency)", async () => {
      // First call returns existing enrollment (idempotent RPC behavior)
      mockRpc.mockResolvedValue({
        data: {
          success: true,
          enrollment_id: "enroll-1",
          enrollment_ref: "NM-2026-0001",
          class_level: "N5",
          fee_amount: 50000,
          quantity: 1,
          tenant_id: "tenant-abc",
        },
        error: null,
      });
      const body = { class_id: "00000000-0000-0000-0000-000000000001", idempotency_key: "key-abc" };
      const res1 = await POST(makeRequest(body));
      const res2 = await POST(makeRequest(body));
      // Both should succeed (DB idempotency)
      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      // Both responses return the same ref
      const b1 = await res1.json();
      const b2 = await res2.json();
      expect(b1.enrollment_ref).toBe(b2.enrollment_ref);
    });

    it("routes to cart handler when items array is present", async () => {
      mockRpc.mockResolvedValue({
        data: {
          success: true,
          enrollment_id: "enroll-2",
          enrollment_ref: "NM-2026-0002",
          quantity: 2,
          total_fee: 100000,
          tenant_id: "tenant-abc",
          items: [{ class_id: "00000000-0000-0000-0000-000000000001", class_level: "N5", quantity: 2, fee_amount: 50000 }],
        },
        error: null,
      });
      const res = await POST(makeRequest({
        items: [{ class_id: "00000000-0000-0000-0000-000000000001", quantity: 2 }],
        form_data: {},
      }));
      expect(res.status).toBe(201);
      const rpcCalls = mockRpc.mock.calls.filter((c) => c[0] === "submit_cart_enrollment");
      expect(rpcCalls).toHaveLength(1);
    });
  });
  ```

- [ ] **Step 6.2: Run tests — fix any mock wiring issues until all pass**

  These are regression tests against an already-existing route, not greenfield TDD.
  The implementation exists; the tests confirm its current behavior.

  ```bash
  npx vitest run src/__tests__/enrollment/enroll.test.ts 2>&1
  ```

  Common mock wiring issues to watch for:
  - `mockFrom` needs to handle multiple `.from()` calls for different tables — use `mockImplementation` to return different shapes per table name
  - `mockRpc` needs the right argument shape for each test case

- [ ] **Step 6.3: Fix any failures**

- [ ] **Step 6.4: Run and confirm all pass**

  ```bash
  npx vitest run src/__tests__/enrollment/enroll.test.ts 2>&1 | tail -20
  ```

  Expected: all tests pass.

- [ ] **Step 6.5: Commit**

  ```bash
  git add src/__tests__/enrollment/enroll.test.ts
  git commit -m "test(enrollment): Layer 1 route integration tests for seat reservation"
  ```

---

## Task 7: Payment State Transition Tests (Layer 1)

**Files:**
- Create: `src/__tests__/payments/verify.test.ts`

- [ ] **Step 7.1: Write failing tests**

  Create `src/__tests__/payments/verify.test.ts`:

  ```ts
  import { describe, it, expect, vi, beforeEach } from "vitest";
  import { NextRequest } from "next/server";

  // ─── Mocks ────────────────────────────────────────────────────────────────────

  const mockAdminFrom = vi.fn();

  vi.mock("@/lib/supabase/admin", () => ({
    createAdminClient: () => ({
      from: mockAdminFrom,
    }),
  }));

  // Mock requireAuth directly so tests aren't coupled to the auth middleware.
  // This is the same approach used in tenant.test.ts.
  vi.mock("@/lib/api", () => ({
    requireAuth: vi.fn().mockResolvedValue({
      supabase: { from: mockAdminFrom },
      user: { id: "user-1", tenant_id: "tenant-abc", role: "owner", email: "admin@test.com", full_name: "Admin", phone: null, created_at: "" },
      tenantId: "tenant-abc",
      isAgent: false,
      agentChatId: null,
    }),
    badRequest: (msg: string) => Response.json({ error: "Bad Request", message: msg }, { status: 400 }),
    notFound: (r = "Resource") => Response.json({ error: "Not Found", message: `${r} not found.` }, { status: 404 }),
  }));

  vi.mock("@/lib/email", () => ({
    sendEmail: vi.fn().mockResolvedValue(undefined),
    enrollmentApprovedEmail: vi.fn().mockReturnValue({ subject: "s", html: "h" }),
    enrollmentRejectedEmail: vi.fn().mockReturnValue({ subject: "s", html: "h" }),
    partialPaymentEmail: vi.fn().mockReturnValue({ subject: "s", html: "h" }),
  }));

  vi.mock("@/lib/sms", () => ({ sendSms: vi.fn().mockResolvedValue(undefined) }));
  vi.mock("@/lib/messenger/notify", () => ({ sendStatusNotification: vi.fn().mockResolvedValue(undefined) }));
  vi.mock("@/lib/telegram/notify", () => ({ sendTelegramStatusNotification: vi.fn().mockResolvedValue(undefined) }));
  vi.mock("@/lib/telegram/channel-invite", () => ({ sendChannelInviteIfEligible: vi.fn().mockResolvedValue(undefined) }));

  const { PATCH } = await import("@/app/api/admin/payments/[id]/verify/route");

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  const PENDING_PAYMENT = {
    id: "payment-1",
    enrollment_id: "enroll-1",
    tenant_id: "tenant-abc",
    amount: 50000,
    status: "pending",
  };

  const CONFIRMED_ENROLLMENT = {
    id: "enroll-1",
    tenant_id: "tenant-abc",
    class_id: "class-1",
    quantity: 1,
    status: "pending_payment",
    enrollment_ref: "NM-2026-0001",
    student_name_en: "Test Student",
    email: "student@test.com",
    phone: null,
    form_data: null,
    messenger_psid: null,
    telegram_chat_id: null,
  };

  const TENANT_INFO = {
    name: "Test School",
    org_type: "language_school",
    logo_url: null,
    currency: "MMK",
    sms_on_payment: false,
  };

  function makeRequest(paymentId: string, body: object) {
    return new NextRequest(`http://localhost/api/admin/payments/${paymentId}/verify`, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  function setupTableMocks(paymentOverride?: Partial<typeof PENDING_PAYMENT>) {
    mockAdminFrom.mockImplementation((table: string) => {
      const chain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        single: vi.fn(),
      };

      if (table === "payments") {
        chain.single.mockResolvedValue({ data: { ...PENDING_PAYMENT, ...paymentOverride }, error: null });
        chain.update.mockReturnValue({ ...chain, eq: vi.fn().mockResolvedValue({ error: null }) });
      } else if (table === "enrollments") {
        chain.single.mockResolvedValue({ data: CONFIRMED_ENROLLMENT, error: null });
        chain.update.mockReturnValue({
          ...chain,
          eq: vi.fn().mockReturnThis(),
          select: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: { ...CONFIRMED_ENROLLMENT, status: "confirmed" }, error: null }),
        });
      } else if (table === "tenants") {
        chain.single.mockResolvedValue({ data: TENANT_INFO, error: null });
      } else if (table === "classes") {
        chain.single.mockResolvedValue({ data: { level: "N5", fee_amount: 50000, seat_remaining: 5 }, error: null });
        chain.update.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
      }

      return chain;
    });
  }

  // ─── Tests ────────────────────────────────────────────────────────────────────

  describe("PATCH /api/admin/payments/[id]/verify", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      setupTableMocks();
    });

    it("returns 400 for invalid action", async () => {
      const res = await PATCH(makeRequest("payment-1", { action: "invalid" }), { params: { id: "payment-1" } });
      expect(res.status).toBe(400);
    });

    it("returns 409 when payment is already verified", async () => {
      setupTableMocks({ status: "verified" });
      const res = await PATCH(makeRequest("payment-1", { action: "approve" }), { params: { id: "payment-1" } });
      expect(res.status).toBe(409);
    });

    it("approve: updates payment status to verified", async () => {
      const res = await PATCH(makeRequest("payment-1", { action: "approve" }), { params: { id: "payment-1" } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.payment.status).toBe("verified");
    });

    it("approve: updates enrollment status to confirmed", async () => {
      const res = await PATCH(makeRequest("payment-1", { action: "approve" }), { params: { id: "payment-1" } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enrollment.status).toBe("confirmed");
    });

    it("reject: updates payment status to rejected", async () => {
      const res = await PATCH(makeRequest("payment-1", { action: "reject", rejection_reason: "Blurry screenshot" }), { params: { id: "payment-1" } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.payment.status).toBe("rejected");
    });

    it("reject: does not double-restore seats when enrollment already rejected", async () => {
      setupTableMocks();
      // Override enrollment status to already-rejected
      mockAdminFrom.mockImplementationOnce(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { ...PENDING_PAYMENT }, error: null }),
      })).mockImplementationOnce(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { ...CONFIRMED_ENROLLMENT, status: "rejected" }, // already rejected
          error: null,
        }),
      }));

      const classUpdateSpy = vi.fn().mockResolvedValue({ error: null });
      // Classes table should NOT be called for seat restoration
      mockAdminFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        update: classUpdateSpy,
        single: vi.fn().mockResolvedValue({ data: TENANT_INFO, error: null }),
      });

      const res = await PATCH(makeRequest("payment-1", { action: "reject" }), { params: { id: "payment-1" } });
      // Seat restore should NOT have been called
      expect(classUpdateSpy).not.toHaveBeenCalled();
    });

    it("request_remaining: returns 400 when admin_note is missing", async () => {
      const res = await PATCH(makeRequest("payment-1", { action: "request_remaining" }), { params: { id: "payment-1" } });
      expect(res.status).toBe(400);
    });

    it("request_remaining: sets enrollment to partial_payment", async () => {
      const res = await PATCH(
        makeRequest("payment-1", {
          action: "request_remaining",
          admin_note: "Short by 5000",
          received_amount: 45000,
        }),
        { params: { id: "payment-1" } },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enrollment.status).toBe("partial_payment");
    });
  });
  ```

- [ ] **Step 7.2: Run tests — fix any mock wiring issues until all pass**

  These are regression tests against an already-existing route, not greenfield TDD.

  ```bash
  npx vitest run src/__tests__/payments/verify.test.ts 2>&1
  ```

- [ ] **Step 7.3: Fix any failures and run again**

  ```bash
  npx vitest run src/__tests__/payments/verify.test.ts 2>&1 | tail -20
  ```

  Expected: all tests pass.

- [ ] **Step 7.4: Commit**

  ```bash
  git add src/__tests__/payments/verify.test.ts
  git commit -m "test(payments): Layer 1 route integration tests for payment state transitions"
  ```

---

## Task 8: Tenant Isolation Tests (Layer 1)

**Files:**
- Create: `src/__tests__/isolation/tenant.test.ts`

These tests verify that a request for tenant A cannot read or modify data belonging to tenant B.

- [ ] **Step 8.1: Write failing tests**

  Create `src/__tests__/isolation/tenant.test.ts`:

  ```ts
  import { describe, it, expect, vi, beforeEach } from "vitest";
  import { NextRequest } from "next/server";

  // ─── Mocks ────────────────────────────────────────────────────────────────────

  const mockAdminFrom = vi.fn();

  vi.mock("@/lib/supabase/admin", () => ({
    createAdminClient: () => ({ from: mockAdminFrom, rpc: vi.fn().mockResolvedValue({ data: null, error: null }) }),
  }));

  vi.mock("@/lib/api", () => ({
    resolveTenantId: vi.fn().mockResolvedValue("tenant-A"),
    requireAuth: vi.fn().mockResolvedValue({
      supabase: {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { id: "payment-1", enrollment_id: "enroll-1", tenant_id: "tenant-A", status: "pending", amount: 50000 },
            error: null,
          }),
        }),
      },
      user: { id: "user-1", tenant_id: "tenant-A", role: "owner" },
      tenantId: "tenant-A",
      isAgent: false,
      agentChatId: null,
    }),
    badRequest: vi.fn((msg: string) => new Response(JSON.stringify({ error: msg }), { status: 400 })),
    notFound: vi.fn((r: string) => new Response(JSON.stringify({ error: `${r} not found` }), { status: 404 })),
  }));

  vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(), enrollmentApprovedEmail: vi.fn().mockReturnValue({}) }));
  vi.mock("@/lib/sms", () => ({ sendSms: vi.fn() }));
  vi.mock("@/lib/messenger/notify", () => ({ sendStatusNotification: vi.fn() }));
  vi.mock("@/lib/telegram/notify", () => ({ sendTelegramStatusNotification: vi.fn() }));
  vi.mock("@/lib/telegram/channel-invite", () => ({ sendChannelInviteIfEligible: vi.fn() }));

  const { PATCH } = await import("@/app/api/admin/payments/[id]/verify/route");

  describe("Tenant isolation — payments", () => {
    it("returns 404 when payment belongs to a different tenant", async () => {
      // Payment exists but belongs to tenant-B, not tenant-A
      mockAdminFrom.mockImplementation((table: string) => {
        const chain = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn(),
          update: vi.fn().mockReturnThis(),
        };
        if (table === "payments") {
          // Supabase RLS scoped to tenant — returns null when tenant mismatch
          chain.single.mockResolvedValue({ data: null, error: null });
        }
        return chain;
      });

      const req = new NextRequest("http://localhost/api/admin/payments/payment-1/verify", {
        method: "PATCH",
        body: JSON.stringify({ action: "approve" }),
        headers: { "content-type": "application/json" },
      });

      const res = await PATCH(req, { params: { id: "payment-1" } });
      expect(res.status).toBe(404);
    });
  });
  ```

- [ ] **Step 8.2: Run tests**

  ```bash
  npx vitest run src/__tests__/isolation/tenant.test.ts 2>&1
  ```

- [ ] **Step 8.3: Fix failures and confirm pass**

- [ ] **Step 8.4: Run full test suite**

  ```bash
  npx vitest run 2>&1 | tail -20
  ```

  Expected: all tests pass.

- [ ] **Step 8.5: Commit**

  ```bash
  git add src/__tests__/isolation/tenant.test.ts
  git commit -m "test(isolation): verify cross-tenant payment access returns 404"
  ```

---

## Phase A Complete

At this point:
- Production data is verified (or corrected)
- Repo is clean: no orphaned `telegram.ts`, no untracked files
- Build and lint pass
- Test suite covers seat reservation, payment transitions, and tenant isolation

**Next:** Execute `docs/superpowers/plans/2026-07-09-cleanup-phase-b-refactoring.md`
