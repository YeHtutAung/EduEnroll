# Codebase Cleanup — Phase B: Core Refactoring (Phases 3–5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract enrollment and payment business logic from fat route handlers into focused service modules, add unit tests for extracted code, and centralize all notification dispatch into a single layer.

**Architecture:** Three phases of extraction — each route handler gets slimmed down by pulling logic into `src/server/enrollment/`, `src/server/payments/`, and `src/server/notifications/`. The route handlers become thin orchestrators. Existing behavior is preserved exactly; regression tests from Phase A verify this.

**Tech Stack:** Next.js 14 App Router, TypeScript, Supabase, Vitest

**Spec:** `docs/superpowers/specs/2026-07-09-codebase-cleanup-design.md`
**Prerequisite:** `docs/superpowers/plans/2026-07-09-cleanup-phase-a-foundation.md` must be complete and all tests passing.

---

## File Map

### Created

| Path | Purpose |
|------|---------|
| `src/server/enrollment/formDataMapper.ts` | Maps `form_data` fields to DB columns (extracted from enroll route) |
| `src/server/enrollment/enrollmentEmails.ts` | Sends post-enrollment confirmation email |
| `src/server/enrollment/createEnrollment.ts` | Orchestrates single-class enrollment via RPC |
| `src/server/enrollment/createCartEnrollment.ts` | Orchestrates cart enrollment via RPC |
| `src/server/payments/seatRestoration.ts` | Restores seats on payment rejection |
| `src/server/payments/paymentTransitions.ts` | State machine: pending → verified/rejected/partial |
| `src/server/payments/verifyPayment.ts` | Orchestrates full payment verification |
| `src/server/notifications/dispatchPaymentApproved.ts` | Fan-out: email + SMS + Telegram + channel invite |
| `src/server/notifications/dispatchPaymentRejected.ts` | Fan-out: email + Messenger + Telegram |
| `src/server/notifications/dispatchPartialPaymentRequested.ts` | Fan-out: email + Messenger + Telegram |
| `src/server/notifications/dispatchEnrollmentCreated.ts` | Fan-out: confirmation email on new enrollment |

### Modified

| Path | Change |
|------|--------|
| `src/app/api/public/enroll/route.ts` | Becomes thin orchestrator calling server modules |
| `src/app/api/admin/payments/[id]/verify/route.ts` | Becomes thin orchestrator calling server modules |

### Deleted

| Path | Why |
|------|-----|
| `src/lib/payment-notifications.ts` | Absorbed into `dispatchPaymentApproved.ts` |

---

## Task 9: Extract `formDataMapper.ts`

The form_data → DB column mapping logic is duplicated in both `POST` (single) and `handleCartEnrollment` (cart). Extract it once.

**Files:**
- Create: `src/server/enrollment/formDataMapper.ts`

- [ ] **Step 9.1: Create the module**

  Create `src/server/enrollment/formDataMapper.ts`:

  ```ts
  import { resolveEmailFromFormData, resolvePhoneFromFormData } from "@/lib/utils";

  export interface FormDataUpdatePayload {
    form_data: Record<string, string>;
    student_name_en?: string;
    student_name_mm?: string;
    phone?: string;
    email?: string;
    nrc_number?: string;
    messenger_psid?: string;
  }

  /**
   * Maps dynamic form_data fields to legacy DB columns.
   * Only populates a column when the field type matches expectations.
   * Includes fallback resolvers for non-standard field names.
   */
  export function buildEnrollmentUpdatePayload(
    fd: Record<string, string>,
    fieldTypeMap: Map<string, string>,
    messengerPsid?: string | null,
  ): FormDataUpdatePayload {
    const payload: FormDataUpdatePayload = { form_data: fd };

    if (fd.name_en && fieldTypeMap.get("name_en") === "text")
      payload.student_name_en = fd.name_en.trim();
    if (fd.name_mm && fieldTypeMap.get("name_mm") === "text")
      payload.student_name_mm = fd.name_mm.trim();
    if (fd.phone && (fieldTypeMap.get("phone") === "phone" || fieldTypeMap.get("phone") === "text"))
      payload.phone = fd.phone.trim();
    if (fd.email && (fieldTypeMap.get("email") === "text" || fieldTypeMap.get("email") === "email"))
      payload.email = fd.email.trim();
    if (fd.nrc && fieldTypeMap.get("nrc") === "text")
      payload.nrc_number = fd.nrc.trim();

    // Fallback: non-standard phone / email field names
    if (!payload.phone) {
      const resolved = resolvePhoneFromFormData(fd);
      if (resolved) payload.phone = resolved;
    }
    if (!payload.email) {
      const resolved = resolveEmailFromFormData(fd);
      if (resolved) payload.email = resolved;
    }

    if (typeof messengerPsid === "string" && messengerPsid.trim()) {
      payload.messenger_psid = messengerPsid.trim();
    }

    return payload;
  }

  /**
   * Fetches field type definitions for an intake from Supabase.
   * Returns a Map of field_key → field_type.
   */
  export async function fetchFieldTypeMap(
    supabase: { from: (t: string) => any },
    intakeId: string,
  ): Promise<Map<string, string>> {
    const { data: fieldDefs } = await supabase
      .from("intake_form_fields")
      .select("field_key, field_type")
      .eq("intake_id", intakeId) as {
      data: { field_key: string; field_type: string }[] | null;
      error: unknown;
    };
    return new Map((fieldDefs ?? []).map((f) => [f.field_key, f.field_type]));
  }
  ```

- [ ] **Step 9.2: Write unit tests**

  Create `src/__tests__/enrollment/formDataMapper.test.ts`:

  ```ts
  import { describe, it, expect } from "vitest";
  import { buildEnrollmentUpdatePayload } from "@/server/enrollment/formDataMapper";

  describe("buildEnrollmentUpdatePayload", () => {
    it("maps name_en when field type is text", () => {
      const result = buildEnrollmentUpdatePayload(
        { name_en: "  Aung Ko  " },
        new Map([["name_en", "text"]]),
      );
      expect(result.student_name_en).toBe("Aung Ko");
    });

    it("does not map name_en when field type does not match", () => {
      const result = buildEnrollmentUpdatePayload(
        { name_en: "Aung Ko" },
        new Map([["name_en", "select"]]),
      );
      expect(result.student_name_en).toBeUndefined();
    });

    it("falls back to resolvePhoneFromFormData for non-standard phone field", () => {
      const result = buildEnrollmentUpdatePayload(
        { phone_number: "09123456789" },
        new Map(),
      );
      // resolvePhoneFromFormData handles phone_number key
      expect(result.phone).toBeTruthy();
    });

    it("sets messenger_psid when provided", () => {
      const result = buildEnrollmentUpdatePayload(
        { name_en: "Test" },
        new Map([["name_en", "text"]]),
        "psid-123",
      );
      expect(result.messenger_psid).toBe("psid-123");
    });

    it("does not set messenger_psid when empty string", () => {
      const result = buildEnrollmentUpdatePayload({ name_en: "Test" }, new Map(), "  ");
      expect(result.messenger_psid).toBeUndefined();
    });

    it("always includes form_data", () => {
      const fd = { name_en: "Test" };
      const result = buildEnrollmentUpdatePayload(fd, new Map());
      expect(result.form_data).toBe(fd);
    });
  });
  ```

- [ ] **Step 9.3: Run tests**

  ```bash
  npx vitest run src/__tests__/enrollment/formDataMapper.test.ts 2>&1
  ```

  Expected: all pass.

- [ ] **Step 9.4: Commit**

  ```bash
  git add src/server/enrollment/formDataMapper.ts src/__tests__/enrollment/formDataMapper.test.ts
  git commit -m "feat(enrollment): extract form data mapper with unit tests"
  ```

---

## Task 10: Extract `enrollmentEmails.ts`

**Files:**
- Create: `src/server/enrollment/enrollmentEmails.ts`

- [ ] **Step 10.1: Create the module**

  Create `src/server/enrollment/enrollmentEmails.ts`:

  ```ts
  import { sendEmail, enrollmentConfirmationEmail } from "@/lib/email";
  import { formatCurrencySimple, resolveEmailFromFormData } from "@/lib/utils";

  interface TenantEmailConfig {
    name: string;
    org_type: string;
    logo_url: string | null;
    email_on_enroll: boolean;
    currency: string;
  }

  interface EnrollmentEmailParams {
    fd: Record<string, string> | null;
    enrollmentRef: string;
    classLevel: string;
    feeAmount: number;
    baseUrl: string;
    tenant: TenantEmailConfig;
  }

  /**
   * Sends enrollment confirmation email if:
   * - a recipient email can be resolved from form_data
   * - tenant has email_on_enroll enabled
   *
   * Fire-and-forget — errors are logged, not thrown.
   */
  export function sendEnrollmentConfirmationEmail(params: EnrollmentEmailParams): void {
    const { fd, enrollmentRef, classLevel, feeAmount, baseUrl, tenant } = params;

    if (!tenant.email_on_enroll) return;

    const recipientEmail = resolveEmailFromFormData(fd);
    if (!recipientEmail) return;

    const emailData = enrollmentConfirmationEmail({
      studentName: fd?.name_en?.trim() || "Student",
      enrollmentRef,
      classLevel,
      feeAmount,
      feeFormatted: formatCurrencySimple(feeAmount, tenant.currency),
      paymentUrl: `${baseUrl}/enroll/payment/${enrollmentRef}`,
      statusUrl: `${baseUrl}/status?ref=${enrollmentRef}`,
      orgType: tenant.org_type,
      tenantName: tenant.name,
      logoUrl: tenant.logo_url ?? undefined,
    });

    sendEmail({ to: recipientEmail, ...emailData }).catch((err) => {
      console.error("[enrollment] Confirmation email failed:", err);
    });
  }
  ```

- [ ] **Step 10.2: Write unit tests**

  Create `src/__tests__/enrollment/enrollmentEmails.test.ts`:

  ```ts
  import { describe, it, expect, vi, beforeEach } from "vitest";

  const mockSendEmail = vi.fn();
  vi.mock("@/lib/email", () => ({
    sendEmail: mockSendEmail,
    enrollmentConfirmationEmail: vi.fn().mockReturnValue({ subject: "s", html: "h" }),
  }));

  const { sendEnrollmentConfirmationEmail } = await import("@/server/enrollment/enrollmentEmails");

  const BASE_TENANT = {
    name: "Test School",
    org_type: "language_school",
    logo_url: null,
    email_on_enroll: true,
    currency: "MMK",
  };

  describe("sendEnrollmentConfirmationEmail", () => {
    beforeEach(() => vi.clearAllMocks());

    it("sends email when email_on_enroll is true and email is in form_data", async () => {
      sendEnrollmentConfirmationEmail({
        fd: { email: "student@test.com" },
        enrollmentRef: "NM-2026-0001",
        classLevel: "N5",
        feeAmount: 50000,
        baseUrl: "https://test.kuunyi.com",
        tenant: BASE_TENANT,
      });
      await new Promise((r) => setTimeout(r, 10)); // let fire-and-forget run
      expect(mockSendEmail).toHaveBeenCalledOnce();
      expect(mockSendEmail.mock.calls[0][0].to).toBe("student@test.com");
    });

    it("does NOT send email when email_on_enroll is false", () => {
      sendEnrollmentConfirmationEmail({
        fd: { email: "student@test.com" },
        enrollmentRef: "NM-2026-0001",
        classLevel: "N5",
        feeAmount: 50000,
        baseUrl: "https://test.kuunyi.com",
        tenant: { ...BASE_TENANT, email_on_enroll: false },
      });
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it("does NOT send email when no email in form_data", () => {
      sendEnrollmentConfirmationEmail({
        fd: { name_en: "Test Student" }, // no email field
        enrollmentRef: "NM-2026-0001",
        classLevel: "N5",
        feeAmount: 50000,
        baseUrl: "https://test.kuunyi.com",
        tenant: BASE_TENANT,
      });
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it("does NOT send email when fd is null", () => {
      sendEnrollmentConfirmationEmail({
        fd: null,
        enrollmentRef: "NM-2026-0001",
        classLevel: "N5",
        feeAmount: 50000,
        baseUrl: "https://test.kuunyi.com",
        tenant: BASE_TENANT,
      });
      expect(mockSendEmail).not.toHaveBeenCalled();
    });
  });
  ```

- [ ] **Step 10.3: Run tests**

  ```bash
  npx vitest run src/__tests__/enrollment/enrollmentEmails.test.ts 2>&1
  ```

  Expected: all pass.

- [ ] **Step 10.4: Commit**

  ```bash
  git add src/server/enrollment/enrollmentEmails.ts src/__tests__/enrollment/enrollmentEmails.test.ts
  git commit -m "feat(enrollment): extract enrollment email helper with unit tests"
  ```

---

## Task 11: Extract `createEnrollment.ts`

**Files:**
- Create: `src/server/enrollment/createEnrollment.ts`

- [ ] **Step 11.1: Create the module**

  Create `src/server/enrollment/createEnrollment.ts`:

  ```ts
  import { createAdminClient } from "@/lib/supabase/admin";
  import { buildEnrollmentUpdatePayload, fetchFieldTypeMap } from "./formDataMapper";
  import type { SubmitEnrollmentResult } from "@/types/database";

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  export interface SingleEnrollmentInput {
    class_id: string;
    form_data?: Record<string, string> | null;
    idempotency_key?: string | null;
    quantity?: number;
    messenger_psid?: string | null;
  }

  // Use Extract to narrow to the success branch — accessing .enrollment_ref etc. is only
  // valid on the success side of the SubmitEnrollmentResult discriminated union.
  export type SubmitEnrollmentSuccess = Extract<SubmitEnrollmentResult, { success: true }>;

  export interface SingleEnrollmentSuccess {
    ok: true;
    result: SubmitEnrollmentSuccess;
  }

  export interface SingleEnrollmentError {
    ok: false;
    status: number;
    error: string;
    message: string;
    message_mm?: string;
    extra?: Record<string, unknown>;
  }

  export type SingleEnrollmentOutcome = SingleEnrollmentSuccess | SingleEnrollmentError;

  /**
   * Orchestrates single-class enrollment:
   * 1. Validates class_id
   * 2. Calls submit_enrollment RPC (atomic seat reservation)
   * 3. Updates enrollment with form_data + legacy columns
   *
   * Does NOT send emails — caller handles notifications.
   * tenantId is a resolved UUID — do not re-resolve inside this function.
   */
  export async function createEnrollment(
    input: SingleEnrollmentInput,
  ): Promise<SingleEnrollmentOutcome> {
    const { class_id, form_data, idempotency_key, quantity, messenger_psid } = input;

    if (!class_id || !UUID_RE.test(class_id)) {
      return { ok: false, status: 400, error: "Validation Error", message: "class_id must be a valid UUID." };
    }

    const supabase = createAdminClient();
    const idemKey = typeof idempotency_key === "string" ? idempotency_key : null;
    const qty = typeof quantity === "number" && quantity >= 1 ? Math.floor(quantity) : 1;

    const { data: result, error: rpcError } = await supabase.rpc(
      "submit_enrollment",
      { p_class_id: class_id, p_idempotency_key: idemKey, p_quantity: qty } as never,
    );

    if (rpcError) {
      console.error("[createEnrollment] RPC error:", rpcError.message);
      return { ok: false, status: 500, error: "Internal Server Error", message: "Enrollment failed. Please try again." };
    }

    const payload = result as SubmitEnrollmentResult;

    if (!payload.success) {
      return mapEnrollmentError(payload);
    }

    // TypeScript: narrow to the success branch so callers can access .enrollment_ref etc.
    const successPayload = payload as SubmitEnrollmentSuccess;

    // Update enrollment with form_data + legacy columns
    const fd = form_data && typeof form_data === "object" ? form_data : null;
    if (fd) {
      const { data: classRow } = await supabase
        .from("classes")
        .select("intake_id")
        .eq("id", class_id)
        .single() as { data: { intake_id: string } | null; error: unknown };

      const fieldTypeMap = classRow?.intake_id
        ? await fetchFieldTypeMap(supabase, classRow.intake_id)
        : new Map<string, string>();

      const updatePayload = buildEnrollmentUpdatePayload(fd, fieldTypeMap, messenger_psid);

      await supabase
        .from("enrollments")
        .update(updatePayload as never)
        .eq("id", successPayload.enrollment_id);
    }

    return { ok: true, result: successPayload };
  }

  function mapEnrollmentError(payload: SubmitEnrollmentResult): SingleEnrollmentError {
    switch (payload.error) {
      case "CLASS_NOT_FOUND":
        return { ok: false, status: 404, error: "Not Found", message: "Class not found." };
      case "CLASS_NOT_OPEN":
        return {
          ok: false, status: 409, error: "Class Unavailable",
          message: "This class is no longer accepting enrollments.",
          message_mm: "ဤသင်တန်းအတွက် စာရင်းသွင်းမှု ပိတ်သိမ်းပြီးဖြစ်သည်။",
        };
      case "CLASS_FULL":
        return {
          ok: false, status: 409, error: "Class Full",
          message: "Sorry, this class is now full. Please choose another level.",
          message_mm: "ဝမ်းနည်းပါသည်။ ဤသင်တန်းတွင် နေရာပြည့်သွားပြီဖြစ်သည်။ အခြားအဆင့်ကို ရွေးချယ်ပါ။",
        };
      case "NOT_ENOUGH_SEATS":
        return {
          ok: false, status: 409, error: "Not Enough Seats",
          message: `Only ${payload.seat_remaining} ticket(s) remaining. Please reduce your quantity.`,
          message_mm: `လက်ကျန်လက်မှတ် ${payload.seat_remaining} ခုသာ ကျန်ပါသည်။ အရေအတွက် လျှော့ပါ။`,
          extra: { seat_remaining: payload.seat_remaining },
        };
      case "EXCEEDS_MAX_TICKETS":
        return {
          ok: false, status: 409, error: "Exceeds Limit",
          message: `Maximum ${payload.max} ticket(s) per person.`,
          message_mm: `တစ်ဦးလျှင် အများဆုံး လက်မှတ် ${payload.max} ခုသာ ဝယ်ယူနိုင်ပါသည်။`,
        };
      case "ENROLLMENT_NOT_OPEN":
        return {
          ok: false, status: 409, error: "Enrollment Not Open",
          message: "Enrollment for this class has not opened yet.",
          message_mm: "ဤသင်တန်းအတွက် စာရင်းသွင်းချိန် မရောက်သေးပါ။",
        };
      case "ENROLLMENT_CLOSED":
        return {
          ok: false, status: 409, error: "Enrollment Closed",
          message: "Enrollment for this class has closed.",
          message_mm: "ဤသင်တန်းအတွက် စာရင်းသွင်းချိန် ကုန်ဆုံးသွားပြီဖြစ်သည်။",
        };
      default:
        console.error("[createEnrollment] DB error:", payload.detail);
        return { ok: false, status: 500, error: "Internal Server Error", message: "Enrollment failed. Please try again." };
    }
  }
  ```

- [ ] **Step 11.2: Write unit tests**

  Create `src/__tests__/enrollment/createEnrollment.test.ts`:

  ```ts
  import { describe, it, expect, vi, beforeEach } from "vitest";

  const mockRpc = vi.fn();
  const mockFrom = vi.fn();

  vi.mock("@/lib/supabase/admin", () => ({
    createAdminClient: () => ({ rpc: mockRpc, from: mockFrom }),
  }));

  const { createEnrollment } = await import("@/server/enrollment/createEnrollment");

  describe("createEnrollment", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { intake_id: "intake-1" }, error: null }),
      });
    });

    it("returns validation error for invalid class_id", async () => {
      const result = await createEnrollment({ class_id: "not-a-uuid" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(400);
    });

    it("returns error for missing class_id", async () => {
      const result = await createEnrollment({ class_id: "" });
      expect(result.ok).toBe(false);
    });

    it("returns CLASS_FULL error when DB says full", async () => {
      mockRpc.mockResolvedValue({ data: { success: false, error: "CLASS_FULL" }, error: null });
      const result = await createEnrollment({ class_id: "00000000-0000-0000-0000-000000000001" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(409);
        expect(result.error).toBe("Class Full");
      }
    });

    it("returns success with enrollment result on valid input", async () => {
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
      const result = await createEnrollment({ class_id: "00000000-0000-0000-0000-000000000001" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.result.enrollment_ref).toBe("NM-2026-0001");
    });

    it("calls submit_enrollment RPC with correct params", async () => {
      mockRpc.mockResolvedValue({ data: { success: false, error: "CLASS_NOT_FOUND" }, error: null });
      await createEnrollment({
        class_id: "00000000-0000-0000-0000-000000000001",
        idempotency_key: "key-abc",
        quantity: 2,
      });
      expect(mockRpc).toHaveBeenCalledWith("submit_enrollment", {
        p_class_id: "00000000-0000-0000-0000-000000000001",
        p_idempotency_key: "key-abc",
        p_quantity: 2,
      });
    });
  });
  ```

- [ ] **Step 11.3: Run tests**

  ```bash
  npx vitest run src/__tests__/enrollment/createEnrollment.test.ts 2>&1
  ```

  Expected: all pass.

- [ ] **Step 11.4: Commit**

  ```bash
  git add src/server/enrollment/createEnrollment.ts src/__tests__/enrollment/createEnrollment.test.ts
  git commit -m "feat(enrollment): extract createEnrollment service with unit tests"
  ```

---

## Task 12: Extract `createCartEnrollment.ts`

**Files:**
- Create: `src/server/enrollment/createCartEnrollment.ts`

- [ ] **Step 12.1: Create the module**

  Create `src/server/enrollment/createCartEnrollment.ts` with the same structure as `createEnrollment.ts` but wrapping `submit_cart_enrollment`. Extract `handleCartEnrollment`'s RPC call, error mapping, and form data update logic. The function signature:

  ```ts
  export async function createCartEnrollment(input: {
    items: { class_id: string; quantity: number }[];
    form_data?: Record<string, string> | null;
    messenger_psid?: string | null;
  }): Promise<CartEnrollmentOutcome>
  ```

  Follow the same pattern as `createEnrollment.ts`:
  - Validate items (UUID check)
  - Call `submit_cart_enrollment` RPC
  - Map errors
  - Update enrollment with form_data using `buildEnrollmentUpdatePayload`
  - Return `{ ok: true, result }` or `{ ok: false, status, error, message }`

- [ ] **Step 12.2: Write unit tests**

  Create `src/__tests__/enrollment/createCartEnrollment.test.ts` with the same mock structure as Task 11. Cover:
  - Empty items array → validation error
  - Invalid class_id in items → validation error
  - `NOT_ENOUGH_SEATS` → 409
  - Success → `ok: true` with `total_fee`

- [ ] **Step 12.3: Run tests**

  ```bash
  npx vitest run src/__tests__/enrollment/createCartEnrollment.test.ts 2>&1
  ```

- [ ] **Step 12.4: Commit**

  ```bash
  git add src/server/enrollment/createCartEnrollment.ts src/__tests__/enrollment/createCartEnrollment.test.ts
  git commit -m "feat(enrollment): extract createCartEnrollment service with unit tests"
  ```

---

## Task 13: Thin Out the Enroll Route

**Files:**
- Modify: `src/app/api/public/enroll/route.ts`

- [ ] **Step 13.1: Rewrite `src/app/api/public/enroll/route.ts`**

  Replace the entire file content with a thin orchestrator:

  ```ts
  import { NextRequest, NextResponse } from "next/server";
  import { createAdminClient } from "@/lib/supabase/admin";
  import { resolveTenantId } from "@/lib/api";
  import { formatCurrency } from "@/lib/utils";
  import { createEnrollment } from "@/server/enrollment/createEnrollment";
  import { createCartEnrollment } from "@/server/enrollment/createCartEnrollment";
  import { sendEnrollmentConfirmationEmail } from "@/server/enrollment/enrollmentEmails";
  import type { BankAccount } from "@/types/database";

  export async function POST(request: NextRequest) {
    const tenantId = await resolveTenantId();
    if (tenantId instanceof NextResponse) return tenantId;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Bad Request", message: "Request body must be valid JSON." },
        { status: 400 },
      );
    }

    const { class_id, form_data, idempotency_key, quantity, items, messenger_psid, __hp } =
      body as Record<string, unknown>;

    // Honeypot — fake success to fool bots
    if (__hp && typeof __hp === "string" && __hp.trim().length > 0) {
      return NextResponse.json({ enrollment_ref: "OK-0000-0000" }, { status: 200 });
    }

    const fd = form_data && typeof form_data === "object"
      ? (form_data as Record<string, string>)
      : null;

    const supabase = createAdminClient();

    // Cart checkout
    if (Array.isArray(items)) {
      const outcome = await createCartEnrollment({
        items: items as { class_id: string; quantity: number }[],
        form_data: fd,
        messenger_psid: typeof messenger_psid === "string" ? messenger_psid : null,
      });

      if (!outcome.ok) {
        // Preserve original API shape: validation errors use messages[] (array),
        // not message (string), to avoid breaking existing clients.
        const errBody: Record<string, unknown> = { error: outcome.error };
        if (outcome.error === "Validation Error") {
          errBody.messages = [outcome.message];
        } else {
          errBody.message = outcome.message;
          if (outcome.message_mm) errBody.message_mm = outcome.message_mm;
          if (outcome.extra) Object.assign(errBody, outcome.extra);
        }
        return NextResponse.json(errBody, { status: outcome.status });
      }

      const { result } = outcome;
      const tenantInfo = await fetchTenantInfo(supabase, result.tenant_id);
      const currency = tenantInfo?.currency ?? "MMK";

      const host = request.headers.get("host") ?? "localhost:3005";
      const proto = host.startsWith("localhost") ? "http" : "https";
      sendEnrollmentConfirmationEmail({
        fd,
        enrollmentRef: result.enrollment_ref,
        classLevel: result.items.map((i) => i.quantity > 1 ? `${i.class_level} x${i.quantity}` : i.class_level).join(", "),
        feeAmount: result.total_fee,
        baseUrl: `${proto}://${host}`,
        tenant: tenantInfo ?? { name: "", org_type: "", logo_url: null, email_on_enroll: false, currency },
      });

      const bankAccounts = await fetchBankAccounts(supabase, result.tenant_id);

      return NextResponse.json(
        {
          enrollment_ref: result.enrollment_ref,
          items: result.items,
          quantity: result.quantity,
          total_fee: result.total_fee,
          fee_formatted: formatCurrency(result.total_fee, currency),
          payment: {
            instructions_en: `Please transfer ${formatCurrency(result.total_fee, currency)} to one of the bank accounts below and quote your enrollment reference "${result.enrollment_ref}" as the payment remark.`,
            instructions_mm: `ကျောင်းလခ ${formatCurrency(result.total_fee, currency)} ကို အောက်ပါ ဘဏ်အကောင့်များသို့ လွှဲပြောင်းပေးပြီး "${result.enrollment_ref}" ကို ငွေလွှဲမှတ်ချက်တွင် ထည့်သွင်းရေးသားပေးပါ။`,
            bank_accounts: bankAccounts,
          },
        },
        { status: 201 },
      );
    }

    // Single class enrollment
    const outcome = await createEnrollment({
      class_id: typeof class_id === "string" ? class_id : "",
      form_data: fd,
      idempotency_key: typeof idempotency_key === "string" ? idempotency_key : null,
      quantity: typeof quantity === "number" ? quantity : 1,
      messenger_psid: typeof messenger_psid === "string" ? messenger_psid : null,
    });

    if (!outcome.ok) {
      // Preserve original API shape: validation errors use messages[] (array).
      const errBody: Record<string, unknown> = { error: outcome.error };
      if (outcome.error === "Validation Error") {
        errBody.messages = [outcome.message];
      } else {
        errBody.message = outcome.message;
        if (outcome.message_mm) errBody.message_mm = outcome.message_mm;
        if (outcome.extra) Object.assign(errBody, outcome.extra);
      }
      return NextResponse.json(errBody, { status: outcome.status });
    }

    const { result } = outcome;
    const tenantInfo = await fetchTenantInfo(supabase, result.tenant_id);
    const currency = tenantInfo?.currency ?? "MMK";

    const host = request.headers.get("host") ?? "localhost:3005";
    const proto = host.startsWith("localhost") ? "http" : "https";
    sendEnrollmentConfirmationEmail({
      fd,
      enrollmentRef: result.enrollment_ref,
      classLevel: result.class_level,
      feeAmount: result.fee_amount * (result.quantity ?? 1),
      baseUrl: `${proto}://${host}`,
      tenant: tenantInfo ?? { name: "", org_type: "", logo_url: null, email_on_enroll: false, currency },
    });

    const bankAccounts = await fetchBankAccounts(supabase, result.tenant_id);
    const enrolledQty = result.quantity ?? 1;
    const totalFee = result.fee_amount * enrolledQty;

    return NextResponse.json(
      {
        enrollment_ref: result.enrollment_ref,
        class_level: result.class_level,
        fee_amount: result.fee_amount,
        quantity: enrolledQty,
        total_fee: totalFee,
        fee_formatted: formatCurrency(totalFee, currency),
        payment: {
          instructions_en: `Please transfer ${formatCurrency(totalFee, currency)} to one of the bank accounts below and quote your enrollment reference "${result.enrollment_ref}" as the payment remark.`,
          instructions_mm: `ကျောင်းလခ ${formatCurrency(totalFee, currency)} ကို အောက်ပါ ဘဏ်အကောင့်များသို့ လွှဲပြောင်းပေးပြီး "${result.enrollment_ref}" ကို ငွေလွှဲမှတ်ချက်တွင် ထည့်သွင်းရေးသားပေးပါ။`,
          bank_accounts: bankAccounts,
        },
      },
      { status: 201 },
    );
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  async function fetchTenantInfo(supabase: ReturnType<typeof createAdminClient>, tenantId: string) {
    const { data } = await supabase
      .from("tenants")
      .select("name, org_type, logo_url, email_on_enroll, currency")
      .eq("id", tenantId)
      .single() as {
      data: { name: string; org_type: string; logo_url: string | null; email_on_enroll: boolean; currency: string } | null;
      error: unknown;
    };
    return data;
  }

  async function fetchBankAccounts(supabase: ReturnType<typeof createAdminClient>, tenantId: string) {
    const { data } = await supabase
      .from("bank_accounts")
      .select("bank_name, account_number, account_holder")
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .order("bank_name") as {
      data: Pick<BankAccount, "bank_name" | "account_number" | "account_holder">[] | null;
    };
    return data ?? [];
  }
  ```

- [ ] **Step 13.2: Run Phase A tests to verify behavior preserved**

  ```bash
  npx vitest run src/__tests__/enrollment/enroll.test.ts 2>&1
  ```

  Expected: all Phase A tests still pass.

- [ ] **Step 13.3: Run full build**

  ```bash
  npm run build 2>&1 | grep -E "(error|Error)" | head -20
  ```

  Expected: zero TypeScript errors.

- [ ] **Step 13.4: Commit**

  ```bash
  git add src/app/api/public/enroll/route.ts
  git commit -m "refactor(enrollment): thin out enroll route — delegate to server/enrollment/ modules"
  ```

---

## Task 14: Extract `seatRestoration.ts`

**Files:**
- Create: `src/server/payments/seatRestoration.ts`

- [ ] **Step 14.1: Create the module**

  Create `src/server/payments/seatRestoration.ts`:

  ```ts
  import { createAdminClient } from "@/lib/supabase/admin";

  interface EnrollmentRef {
    id: string;
    class_id: string | null;
    quantity: number | null;
  }

  /**
   * Restores seats to their classes after a payment rejection.
   * Handles both single-class and cart enrollments.
   * Safe to call only when enrollment.status !== 'rejected' to prevent double-restore.
   */
  export async function restoreSeats(enrollment: EnrollmentRef): Promise<void> {
    const admin = createAdminClient();
    const itemsToRestore: { class_id: string; quantity: number }[] = [];

    const isCart = enrollment.class_id === null;

    if (isCart) {
      const { data: items } = await admin
        .from("enrollment_items")
        .select("class_id, quantity")
        .eq("enrollment_id", enrollment.id) as {
        data: { class_id: string; quantity: number }[] | null;
        error: unknown;
      };
      if (items) itemsToRestore.push(...items);
    } else if (enrollment.class_id) {
      itemsToRestore.push({
        class_id: enrollment.class_id,
        quantity: enrollment.quantity ?? 1,
      });
    }

    for (const item of itemsToRestore) {
      const { data: cls } = await admin
        .from("classes")
        .select("seat_remaining")
        .eq("id", item.class_id)
        .single() as { data: { seat_remaining: number } | null; error: unknown };

      if (cls) {
        await admin
          .from("classes")
          .update({
            seat_remaining: cls.seat_remaining + item.quantity,
            status: "open",
          } as never)
          .eq("id", item.class_id);
      }
    }
  }
  ```

- [ ] **Step 14.2: Write unit tests**

  Create `src/__tests__/payments/seatRestoration.test.ts`:

  ```ts
  import { describe, it, expect, vi, beforeEach } from "vitest";

  const mockFrom = vi.fn();
  vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mockFrom }) }));

  const { restoreSeats } = await import("@/server/payments/seatRestoration");

  describe("restoreSeats", () => {
    beforeEach(() => vi.clearAllMocks());

    it("restores seats for a single-class enrollment", async () => {
      const updateSpy = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        update: updateSpy,
        single: vi.fn().mockResolvedValue({ data: { seat_remaining: 3 }, error: null }),
      });

      await restoreSeats({ id: "enroll-1", class_id: "class-1", quantity: 2 });

      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ seat_remaining: 5 }), // 3 + 2
      );
    });

    it("restores seats for each item in a cart enrollment", async () => {
      const updateSpy = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
      let callCount = 0;

      mockFrom.mockImplementation((table: string) => {
        if (table === "enrollment_items") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockResolvedValue({
              data: [
                { class_id: "class-1", quantity: 1 },
                { class_id: "class-2", quantity: 2 },
              ],
              error: null,
            }),
          };
        }
        if (table === "classes") {
          callCount++;
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({ data: { seat_remaining: 5 }, error: null }),
            update: updateSpy,
          };
        }
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
      });

      await restoreSeats({ id: "enroll-1", class_id: null, quantity: null });

      // Should have restored both classes
      expect(callCount).toBe(2);
      expect(updateSpy).toHaveBeenCalledTimes(2);
    });

    it("does nothing when class_id is null and no enrollment items", async () => {
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ data: [], error: null }),
      });

      await restoreSeats({ id: "enroll-1", class_id: null, quantity: null });
      // No update calls
    });
  });
  ```

- [ ] **Step 14.3: Run tests**

  ```bash
  npx vitest run src/__tests__/payments/seatRestoration.test.ts 2>&1
  ```

  Expected: all pass.

- [ ] **Step 14.4: Commit**

  ```bash
  git add src/server/payments/seatRestoration.ts src/__tests__/payments/seatRestoration.test.ts
  git commit -m "feat(payments): extract seatRestoration module with unit tests"
  ```

---

## Task 15: Extract `verifyPayment.ts` and Thin Out the Verify Route

**Files:**
- Create: `src/server/payments/verifyPayment.ts`
- Modify: `src/app/api/admin/payments/[id]/verify/route.ts`

- [ ] **Step 15.1: Create `verifyPayment.ts`**

  Create `src/server/payments/verifyPayment.ts`:

  ```ts
  import { createAdminClient } from "@/lib/supabase/admin";
  import { restoreSeats } from "./seatRestoration";
  import type { Enrollment, Payment, PaymentStatus, EnrollmentStatus } from "@/types/database";

  interface VerifierContext {
    verifiedByHuman: string | null;
    verifiedByAgent: number | null;
  }

  interface TenantContext {
    currency: string;
  }

  export interface VerifyPaymentInput {
    action: "approve" | "reject" | "request_remaining";
    payment: Payment;
    enrollment: Enrollment;
    tenantId: string;
    tenantInfo: TenantContext;
    verifier: VerifierContext;
    rejection_reason?: string;
    admin_note?: string;
    received_amount?: number;
    requestHost: string;
  }

  export interface VerifyPaymentResult {
    enrollment: Enrollment;
    payment: Partial<Payment>;
    rejection_reason?: string;
    // Class info needed by the route for notification dispatch
    classLevel: string;
    statusUrl: string;
    paymentUrl: string;
    feeFormatted?: string;
  }

  /**
   * Executes a payment verification action (approve / reject / request_remaining).
   * Updates payment and enrollment records in Supabase.
   * Does NOT send notifications — the calling route handles that.
   *
   * tenantId is a pre-resolved UUID. Do not re-resolve inside this function.
   */
  export async function verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    const {
      action, payment, enrollment, tenantInfo, verifier,
      rejection_reason, admin_note, received_amount, requestHost,
    } = input;

    const admin = createAdminClient();
    const now = new Date().toISOString();
    const proto = requestHost.startsWith("localhost") ? "http" : "https";
    const statusUrl = `${proto}://${requestHost}/status?ref=${enrollment.enrollment_ref}`;
    const paymentUrl = `${proto}://${requestHost}/enroll/payment/${enrollment.enrollment_ref}`;

    // ── Resolve class level and fee ─────────────────────────────────────────────
    const isCart = enrollment.class_id === null;
    let classLevel = "";
    let totalFee = 0;

    if (isCart) {
      const { data: items } = await admin
        .from("enrollment_items")
        .select("quantity, fee_amount, classes(level)")
        .eq("enrollment_id", enrollment.id) as {
        data: { quantity: number; fee_amount: number; classes: { level: string } | null }[] | null;
        error: unknown;
      };
      if (items && items.length > 0) {
        classLevel = items
          .map((i) => i.quantity > 1 ? `${i.classes?.level ?? "?"} x${i.quantity}` : (i.classes?.level ?? "?"))
          .join(", ");
        totalFee = items.reduce((sum, i) => sum + i.fee_amount * i.quantity, 0);
      }
    } else {
      const { data: cls } = await admin
        .from("classes")
        .select("level, fee_amount")
        .eq("id", enrollment.class_id!)
        .single() as { data: { level: string; fee_amount: number } | null; error: unknown };
      classLevel = cls?.level ?? "";
      totalFee = (cls?.fee_amount ?? 0) * (enrollment.quantity ?? 1);
    }

    const feeFormatted = totalFee > 0
      ? `${String(totalFee).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} ${tenantInfo.currency}`
      : undefined;

    // ── Approve ─────────────────────────────────────────────────────────────────
    if (action === "approve") {
      await admin
        .from("payments")
        .update({
          status: "verified" as PaymentStatus,
          verified_by: verifier.verifiedByHuman,
          verified_by_agent: verifier.verifiedByAgent,
          verified_at: now,
        } as never)
        .eq("id", payment.id);

      const { data: updatedEnrollment } = await admin
        .from("enrollments")
        .update({ status: "confirmed" as EnrollmentStatus } as never)
        .eq("id", enrollment.id)
        .select()
        .single() as { data: Enrollment | null; error: unknown };

      return {
        enrollment: updatedEnrollment ?? enrollment,
        payment: { ...payment, status: "verified" as PaymentStatus, verified_by: verifier.verifiedByHuman, verified_by_agent: verifier.verifiedByAgent, verified_at: now },
        classLevel,
        statusUrl,
        paymentUrl,
        feeFormatted,
      };
    }

    // ── Request Remaining (partial payment) ─────────────────────────────────────
    if (action === "request_remaining") {
      const paymentUpdate: Record<string, unknown> = {
        admin_note: admin_note!.trim(),
        verified_by: verifier.verifiedByHuman,
        verified_at: now,
      };
      if (typeof received_amount === "number") {
        paymentUpdate.received_amount = received_amount;
      }

      await admin
        .from("payments")
        .update(paymentUpdate as never)
        .eq("id", payment.id);

      const { data: updatedEnrollment } = await admin
        .from("enrollments")
        .update({ status: "partial_payment" as EnrollmentStatus } as never)
        .eq("id", enrollment.id)
        .select()
        .single() as { data: Enrollment | null; error: unknown };

      return {
        enrollment: updatedEnrollment ?? enrollment,
        payment: { ...payment, ...paymentUpdate },
        classLevel,
        statusUrl,
        paymentUrl,
        feeFormatted,
      };
    }

    // ── Reject ───────────────────────────────────────────────────────────────────
    await admin
      .from("payments")
      .update({
        status: "rejected" as PaymentStatus,
        verified_by: verifier.verifiedByHuman,
        verified_by_agent: verifier.verifiedByAgent,
        verified_at: now,
      } as never)
      .eq("id", payment.id);

    const enrollUpdatePayload: Record<string, unknown> = { status: "rejected" as EnrollmentStatus };
    if (typeof rejection_reason === "string") {
      enrollUpdatePayload.rejection_reason = rejection_reason;
    }

    const { data: updatedEnrollment } = await admin
      .from("enrollments")
      .update(enrollUpdatePayload as never)
      .eq("id", enrollment.id)
      .select()
      .single() as { data: Enrollment | null; error: unknown };

    // Restore seats only if enrollment was not already rejected
    if (enrollment.status !== "rejected") {
      await restoreSeats({
        id: enrollment.id,
        class_id: enrollment.class_id,
        quantity: enrollment.quantity,
      });
    }

    return {
      enrollment: updatedEnrollment ?? enrollment,
      payment: {
        ...payment,
        status: "rejected" as PaymentStatus,
        verified_by: verifier.verifiedByHuman,
        verified_by_agent: verifier.verifiedByAgent,
        verified_at: now,
      },
      rejection_reason: typeof rejection_reason === "string" ? rejection_reason : undefined,
      classLevel,
      statusUrl,
      paymentUrl,
      feeFormatted,
    };
  }
  ```

- [ ] **Step 15.2: Write unit tests for `verifyPayment.ts`**

  Create `src/__tests__/payments/verifyPayment.test.ts`. Cover:
  - `approve` action: DB updates payment to verified, enrollment to confirmed
  - `reject` action: calls `restoreSeats`, updates status to rejected
  - `reject` action with already-rejected enrollment: does NOT call restoreSeats
  - `request_remaining` without admin_note: handled at route level (not tested here)
  - `request_remaining` with received_amount: stores received_amount in payment

- [ ] **Step 15.3: Thin out the verify route**

  Replace the three action blocks in `src/app/api/admin/payments/[id]/verify/route.ts` with:

  ```ts
  const result = await verifyPayment({
    action,
    payment,
    enrollment,
    tenantId,
    tenantInfo: { currency },
    verifier: { verifiedByHuman, verifiedByAgent },
    rejection_reason: typeof rejection_reason === "string" ? rejection_reason : undefined,
    admin_note: typeof admin_note === "string" ? admin_note : undefined,
    received_amount: typeof received_amount === "number" ? received_amount : undefined,
    requestHost: request.headers.get("host") ?? "localhost:3005",
  });

  const { classLevel, statusUrl, paymentUrl, feeFormatted } = result;

  // ── Notifications (inline until Phase 5 extracts to dispatch functions) ──────
  // Use result.classLevel / result.statusUrl / result.paymentUrl / result.feeFormatted
  // in place of the old getClassAndUrls() return values.
  // Keep ALL existing notification code below here exactly as-is, substituting
  // the local variables classLevel, statusUrl, paymentUrl, feeFormatted from above.

  // ... (paste existing notification blocks from the original route here, unchanged)

  const responseBody: Record<string, unknown> = {
    enrollment: result.enrollment,
    payment: result.payment,
  };
  if (result.rejection_reason !== undefined) {
    responseBody.rejection_reason = result.rejection_reason;
  }
  return NextResponse.json(responseBody);
  ```

- [ ] **Step 15.4: Run Phase A tests to verify behavior preserved**

  ```bash
  npx vitest run src/__tests__/payments/verify.test.ts 2>&1
  ```

  Expected: all pass.

- [ ] **Step 15.5: Run full build**

  ```bash
  npm run build 2>&1 | grep -E "(error|Error)" | head -20
  ```

- [ ] **Step 15.6: Commit**

  ```bash
  git add src/server/payments/verifyPayment.ts \
          src/__tests__/payments/verifyPayment.test.ts \
          src/app/api/admin/payments/[id]/verify/route.ts
  git commit -m "refactor(payments): extract verifyPayment service and thin out route"
  ```

---

## Task 16: Centralize Notifications — `dispatchPaymentApproved.ts`

**Files:**
- Create: `src/server/notifications/dispatchPaymentApproved.ts`

**Audit first:** Before writing this function, review `src/app/api/public/payments/stripe/intent/status/route.ts` (added in PR #118) to confirm the Stripe success-page flow calls the correct notification path. If it uses `payment-notifications.ts`, `dispatchPaymentApproved` must cover the same channels.

- [ ] **Step 16.1: Audit `intent/status` route**

  Read `src/app/api/public/payments/stripe/intent/status/route.ts`. Note which notification calls it makes.

  **Expected finding:** This route (added in PR #118) currently sends **zero notifications** — it only verifies the Stripe payment intent and updates the DB. It does not call `sendPaymentNotifications` or any other notification helper. This is intentional: Stripe is a browser-driven flow where the user is already looking at the success page, so a push notification is redundant.

  **Remediation:** No action needed. `dispatchPaymentApproved` does not need to be wired into the `intent/status` route. Document this explicitly with a comment in that route:

  ```ts
  // Notifications intentionally omitted: Stripe checkout is browser-driven.
  // The user is already on the success page. No push notification is needed.
  ```

  Then proceed to Step 16.2.

- [ ] **Step 16.2: Create `dispatchPaymentApproved.ts`**

  Create `src/server/notifications/dispatchPaymentApproved.ts`:

  ```ts
  import { sendEmail, enrollmentApprovedEmail } from "@/lib/email";
  import { sendSms } from "@/lib/sms";
  import { sendStatusNotification } from "@/lib/messenger/notify";
  import { sendTelegramStatusNotification } from "@/lib/telegram/notify";
  import { sendChannelInviteIfEligible } from "@/lib/telegram/channel-invite";

  export interface ApprovalNotificationInput {
    tenantId: string;
    enrollmentId: string;
    enrollmentRef: string;
    studentName: string;
    classLevel: string;
    feeFormatted?: string;
    statusUrl: string;
    paymentUrl: string;
    currency: string;
    // Contact
    email?: string | null;
    phone?: string | null;
    messengerPsid?: string | null;
    telegramChatId?: string | null;
    classId?: string | null;
    // Tenant settings
    tenantName?: string;
    orgType?: string;
    logoUrl?: string;
    smsOnPayment?: boolean;
  }

  /**
   * Dispatches all approval notifications for a confirmed payment.
   * Runs all enabled channels concurrently (Promise.allSettled).
   * Errors in individual channels are logged but do not fail the dispatch.
   */
  export async function dispatchPaymentApproved(input: ApprovalNotificationInput): Promise<void> {
    const tasks: Promise<unknown>[] = [];

    if (input.email) {
      const emailData = enrollmentApprovedEmail({
        studentName: input.studentName,
        enrollmentRef: input.enrollmentRef,
        classLevel: input.classLevel,
        statusUrl: input.statusUrl,
        feeFormatted: input.feeFormatted,
        orgType: input.orgType,
        tenantName: input.tenantName,
        logoUrl: input.logoUrl,
      });
      tasks.push(
        sendEmail({ to: input.email, ...emailData }).catch((err) => {
          console.error("[dispatchPaymentApproved] Email failed:", err);
        }),
      );
    }

    if (input.phone && input.smsOnPayment !== false) {
      tasks.push(
        sendSms({
          to: input.phone,
          message: `Hi ${input.studentName}, your payment for ${input.enrollmentRef} has been confirmed. Welcome to class!`,
          clientReference: input.enrollmentRef,
        }).catch((err) => {
          console.error("[dispatchPaymentApproved] SMS failed:", err);
        }),
      );
    }

    if (input.messengerPsid) {
      tasks.push(
        sendStatusNotification({
          tenantId: input.tenantId,
          messengerPsid: input.messengerPsid,
          action: "approve",
          studentName: input.studentName,
          enrollmentRef: input.enrollmentRef,
          classLevel: input.classLevel,
          statusUrl: input.statusUrl,
          paymentUrl: input.paymentUrl,
          currency: input.currency,
        }).catch((err) => {
          console.error("[dispatchPaymentApproved] Messenger failed:", err);
        }),
      );
    }

    if (input.telegramChatId) {
      tasks.push(
        sendTelegramStatusNotification({
          tenantId: input.tenantId,
          telegramChatId: input.telegramChatId,
          action: "approve",
          studentName: input.studentName,
          enrollmentRef: input.enrollmentRef,
          classLevel: input.classLevel,
          statusUrl: input.statusUrl,
          paymentUrl: input.paymentUrl,
          currency: input.currency,
        }).catch((err) => {
          console.error("[dispatchPaymentApproved] Telegram failed:", err);
        }),
      );

      tasks.push(
        sendChannelInviteIfEligible({
          tenantId: input.tenantId,
          enrollmentId: input.enrollmentId,
          classId: input.classId ?? null,
          telegramChatId: input.telegramChatId,
          studentName: input.studentName,
        }).catch((err) => {
          console.error("[dispatchPaymentApproved] Channel invite failed:", err);
        }),
      );
    }

    await Promise.allSettled(tasks);
  }
  ```

- [ ] **Step 16.3: Write unit tests**

  Create `src/__tests__/notifications/dispatchPaymentApproved.test.ts`. Mock all channel senders. Verify:
  - All channels called when all contact info present
  - Email not called when no email
  - SMS not called when `smsOnPayment` is false
  - Messenger not called when no `messengerPsid`
  - Telegram not called when no `telegramChatId`
  - A channel failure does not throw (per `Promise.allSettled`)

- [ ] **Step 16.4: Run tests**

  ```bash
  npx vitest run src/__tests__/notifications/dispatchPaymentApproved.test.ts 2>&1
  ```

- [ ] **Step 16.5: Commit**

  ```bash
  git add src/server/notifications/dispatchPaymentApproved.ts \
          src/__tests__/notifications/dispatchPaymentApproved.test.ts
  git commit -m "feat(notifications): add dispatchPaymentApproved with unit tests"
  ```

---

## Task 17: Create Remaining Dispatch Functions

Create `dispatchPaymentRejected.ts` and `dispatchPartialPaymentRequested.ts` following the same pattern as Task 16. Then create `dispatchEnrollmentCreated.ts` to wrap `sendEnrollmentConfirmationEmail`.

- [ ] **Step 17.1: Create `dispatchPaymentRejected.ts`**

  Same structure as `dispatchPaymentApproved.ts` but for the rejection flow. Channels: email (`enrollmentRejectedEmail`), Messenger (`action: "reject"`), Telegram (`action: "reject"`). No SMS on rejection. No channel invite.

- [ ] **Step 17.2: Create `dispatchPartialPaymentRequested.ts`**

  Channels: email (`partialPaymentEmail`), Messenger (`action: "request_remaining"`), Telegram (`action: "request_remaining"`). Carries extra params: `adminNote`, `receivedAmount`, `remainingAmount`.

- [ ] **Step 17.3: Create `dispatchEnrollmentCreated.ts`**

  Thin wrapper that calls `sendEnrollmentConfirmationEmail`. This unifies the "enrollment created" notification behind the same `dispatch*` naming convention.

- [ ] **Step 17.4: Write unit tests for each**

  At minimum: verify the right channel senders are called, and that a channel failure does not throw.

- [ ] **Step 17.5: Run all notification tests**

  ```bash
  npx vitest run src/__tests__/notifications/ 2>&1
  ```

- [ ] **Step 17.6: Commit**

  ```bash
  git add src/server/notifications/ src/__tests__/notifications/
  git commit -m "feat(notifications): add dispatchPaymentRejected, dispatchPartial, dispatchEnrollmentCreated"
  ```

---

## Task 18: Wire Dispatch Functions Into Routes and Delete `payment-notifications.ts`

- [ ] **Step 18.1: Update verify route to use dispatch functions**

  In `src/app/api/admin/payments/[id]/verify/route.ts`, replace the inline notification blocks (email, SMS, Messenger, Telegram) in each action branch with:

  ```ts
  // approve
  await dispatchPaymentApproved({
    tenantId,
    enrollmentId: enrollment.id,
    enrollmentRef: enrollment.enrollment_ref,
    studentName: enrollment.student_name_en || "Student",
    classLevel,
    feeFormatted,
    statusUrl,
    paymentUrl,
    currency,
    email: enrollEmail,
    phone: enrollment.phone || resolvePhoneFromFormData(fd),
    messengerPsid: enrollment.messenger_psid,
    telegramChatId: enrollment.telegram_chat_id,
    classId: enrollment.class_id,
    tenantName,
    orgType,
    logoUrl,
    smsOnPayment: tenantInfo?.sms_on_payment,
  });
  ```

  Do the same for `reject` → `dispatchPaymentRejected` and `request_remaining` → `dispatchPartialPaymentRequested`.

- [ ] **Step 18.2: Update routes that use `payment-notifications.ts`**

  Search for all imports of `@/lib/payment-notifications`:

  ```bash
  grep -r "payment-notifications" src/ --include="*.ts" --include="*.tsx"
  ```

  For each route found, replace the `sendPaymentNotifications(...)` call with `dispatchPaymentApproved(...)` using the equivalent input.

- [ ] **Step 18.3: Delete `src/lib/payment-notifications.ts`**

  ```bash
  git rm src/lib/payment-notifications.ts
  ```

- [ ] **Step 18.4: Run full test suite**

  ```bash
  npx vitest run 2>&1 | tail -30
  ```

  Expected: all tests pass.

- [ ] **Step 18.5: Run full build**

  ```bash
  npm run build 2>&1 | grep -E "(error|Error)" | head -20
  ```

  Expected: zero errors.

- [ ] **Step 18.6: Commit**

  ```bash
  git add -p
  git commit -m "refactor(notifications): wire dispatch functions into routes, delete payment-notifications.ts"
  ```

---

## Phase B Complete

At this point:
- Enrollment route is a thin orchestrator
- Payment verify route is a thin orchestrator
- All notifications go through `dispatch*` functions
- Unit tests cover every extracted module
- Phase A regression tests still pass
- Build passes

**Run the full suite one final time:**

```bash
npx vitest run 2>&1
npm run build 2>&1 | grep -c "error"  # expected: 0
```

Then create a PR from your cleanup branch to `dev`.
