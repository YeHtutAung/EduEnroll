# HitPay Embedded Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add HitPay as a `payment_mode` option giving students a PayNow QR code (embedded in UI) and Visa/Mastercard card payment (redirect to HitPay hosted checkout), both confirmed via webhook.

**Architecture:** Single `POST /api/public/payments/hitpay` route accepts `method: "paynow_online" | "card"` and creates the right HitPay payment request. QR flow polls `/api/public/payments/hitpay/status` (DB read only). Card flow redirects to HitPay URL. Webhook at `/api/webhooks/hitpay` confirms enrollment and dispatches notifications using existing `dispatchPaymentApproved`.

**Tech Stack:** Next.js 14 App Router, TypeScript, Supabase, Vitest, `qrcode` npm package (already installed), HitPay REST API v1.

**Spec:** `docs/superpowers/specs/2026-07-09-hitpay-integration-design.md`

**Reference patterns:** Mirror `src/lib/paypay.ts`, `src/app/api/public/payments/paypay/route.ts`, `src/app/api/webhooks/paypay/route.ts` throughout.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `supabase/migrations/087_hitpay_support.sql` | Create | Add `hitpay_payment_id` column + index, update comments |
| `src/types/database.ts` | Modify | Add `hitpay_payment_id` to `Payment` interface |
| `src/lib/hitpay.ts` | Create | HitPay API client: createPaymentRequest, verifyWebhook, parseWebhookPayload |
| `src/__tests__/lib/hitpay.test.ts` | Create | Unit tests for hitpay lib functions |
| `src/app/api/public/payments/hitpay/route.ts` | Create | POST handler: resolve enrollment, call HitPay, insert payment row |
| `src/__tests__/payments/hitpay-create.test.ts` | Create | Route tests: validation, duplicate guard, PayNow response, Card response |
| `src/app/api/public/payments/hitpay/status/route.ts` | Create | GET handler: read enrollment status from DB for QR polling |
| `src/__tests__/payments/hitpay-status.test.ts` | Create | Route tests: missing ref, enrollment not found, each status value |
| `src/app/api/webhooks/hitpay/route.ts` | Create | POST webhook: verify sig, completed→confirm enrollment, failed→reject |
| `src/__tests__/webhooks/hitpay-webhook.test.ts` | Create | Webhook tests: bad sig, completed flow, failed flow, replay guard |
| `src/app/admin/settings/page.tsx` | Modify | Add "hitpay" to paymentMode union + selector button + info card |
| `src/app/(public)/enroll/payment/[ref]/page.tsx` | Modify | Add HitPay UI block: tab selector, PayNow QR render + polling, Card redirect |

---

## Task 1: DB Migration + Types

**Files:**
- Create: `supabase/migrations/087_hitpay_support.sql`
- Modify: `src/types/database.ts`

- [ ] **Step 1: Create migration file**

```sql
-- supabase/migrations/087_hitpay_support.sql

-- 1. Add hitpay_payment_id to payments + index for fast webhook lookups
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS hitpay_payment_id text;

CREATE INDEX IF NOT EXISTS payments_hitpay_payment_id_idx
  ON public.payments (hitpay_payment_id)
  WHERE hitpay_payment_id IS NOT NULL;

-- 2. Update comments
COMMENT ON COLUMN public.tenants.payment_mode IS
  'bank_transfer | mmqr | stripe | paypay | hitpay';

-- Both PayNow and Card sub-flows share the "hitpay" payment_method value.
COMMENT ON COLUMN public.payments.payment_method IS
  'manual_upload | abank_mmqr | mmqr | stripe | paypay | hitpay';
```

- [ ] **Step 2: Apply migration to dev DB**

```bash
npx supabase db push
```

Expected: migration applies cleanly, no errors.

- [ ] **Step 3: Add `hitpay_payment_id` to the `Payment` interface in `src/types/database.ts`**

Find the `Payment` interface (around line 260). After the `verified_by_agent` line, add:

```ts
hitpay_payment_id: string | null;  // HitPay payment request ID
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npm run build 2>&1 | grep -E "Type error:|✓ Compiled"
```

Expected: `✓ Compiled successfully`

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/087_hitpay_support.sql src/types/database.ts
git commit -m "feat(hitpay): add hitpay_payment_id column, index, and Payment type"
```

---

## Task 2: HitPay API Client

**Files:**
- Create: `src/lib/hitpay.ts`
- Create: `src/__tests__/lib/hitpay.test.ts`

This is the low-level client. It has no Supabase dependency — pure HTTP + crypto.

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/lib/hitpay.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { default: hitpay } = await import("@/lib/hitpay");

const BODY_TEXT = JSON.stringify({ id: "req-1", status: "completed" });
const SALT = "test-salt-value";

describe("hitpay.verifyWebhook", () => {
  it("returns true for valid HMAC-SHA256 signature", async () => {
    const crypto = await import("crypto");
    const signature = crypto.createHmac("sha256", SALT).update(BODY_TEXT).digest("hex");

    // Temporarily set env
    process.env.HITPAY_SALT = SALT;
    expect(hitpay.verifyWebhook(BODY_TEXT, signature)).toBe(true);
  });

  it("returns false for invalid signature", () => {
    process.env.HITPAY_SALT = SALT;
    expect(hitpay.verifyWebhook(BODY_TEXT, "bad-signature")).toBe(false);
  });

  it("returns false (not throws) when signature is different length", () => {
    process.env.HITPAY_SALT = SALT;
    expect(hitpay.verifyWebhook(BODY_TEXT, "short")).toBe(false);
  });
});

describe("hitpay.parseWebhookPayload", () => {
  it("parses a completed payload", () => {
    const payload = JSON.stringify({
      id: "req-abc",
      status: "completed",
      payments: [{ payment_type: "paynow_online" }],
    });
    const result = hitpay.parseWebhookPayload(payload);
    expect(result.id).toBe("req-abc");
    expect(result.status).toBe("completed");
    expect(result.payments[0].payment_type).toBe("paynow_online");
  });

  it("throws on invalid JSON", () => {
    expect(() => hitpay.parseWebhookPayload("not-json")).toThrow();
  });
});

describe("hitpay.createPaymentRequest", () => {
  beforeEach(() => {
    process.env.HITPAY_API_KEY = "test-key";
    process.env.HITPAY_MODE = "sandbox";
    vi.clearAllMocks();
  });

  it("calls sandbox URL with correct headers for paynow_online", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "req-1", qr_code_data: { qr_code: "QR_STRING" }, url: "https://checkout.url" }),
    });

    const result = await hitpay.createPaymentRequest({
      amount: "50.00",
      currency: "SGD",
      method: "paynow_online",
      referenceNumber: "NM-2026-0001",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("sandbox"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-BUSINESS-API-KEY": "test-key" }),
      }),
    );
    expect(result.id).toBe("req-1");
    expect(result.qr_code_data?.qr_code).toBe("QR_STRING");
  });

  it("includes redirect_url for card method", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "req-2", url: "https://hitpay.checkout/pay" }),
    });

    await hitpay.createPaymentRequest({
      amount: "50.00",
      currency: "SGD",
      method: "card",
      referenceNumber: "NM-2026-0001",
      redirectUrl: "https://mysite.com/payment/NM-2026-0001?hitpay=success",
    });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(callBody.payment_methods).toEqual(["card"]);
    expect(callBody.redirect_url).toBe("https://mysite.com/payment/NM-2026-0001?hitpay=success");
    expect(callBody.generate_qr).toBeUndefined();
  });

  it("throws on non-OK response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });

    await expect(
      hitpay.createPaymentRequest({ amount: "50.00", currency: "SGD", method: "paynow_online", referenceNumber: "x" }),
    ).rejects.toThrow("401");
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
npx vitest run src/__tests__/lib/hitpay.test.ts
```

Expected: FAIL — `Cannot find module '@/lib/hitpay'`

- [ ] **Step 3: Create `src/lib/hitpay.ts`**

```ts
// ─── HitPay Embedded Payments client ────────────────────────────────────────
// Docs: https://docs.hitpayapp.com/apis/guide/embedded-qr-code-payments
// Auth: X-BUSINESS-API-KEY header
// Sandbox: https://api.sandbox.hit-pay.com/v1
// Prod:    https://api.hit-pay.com/v1

import crypto from "crypto";

const API_KEY  = () => process.env.HITPAY_API_KEY!;
const SALT     = () => process.env.HITPAY_SALT!;
const BASE_URL = () =>
  process.env.HITPAY_MODE === "production"
    ? "https://api.hit-pay.com/v1"
    : "https://api.sandbox.hit-pay.com/v1";

// ── Types ──────────────────────────────────────────────────────────────────

export interface CreatePaymentRequestParams {
  amount: string;           // decimal string e.g. "50.00"
  currency: string;         // "SGD"
  method: "paynow_online" | "card";
  referenceNumber: string;  // enrollmentRef
  redirectUrl?: string;     // required for card
  name?: string;
  email?: string;
}

export interface HitPayPaymentRequest {
  id: string;
  status: string;
  url: string;              // HitPay hosted checkout URL (always present)
  qr_code_data?: {
    qr_code: string;        // raw PayNow EMV string — convert to QR image client-side
  };
  [key: string]: unknown;
}

export interface HitPayWebhookPayload {
  id: string;
  status: "completed" | "pending" | "failed";
  payments: Array<{
    payment_type: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

// ── 1. Create Payment Request ──────────────────────────────────────────────

async function createPaymentRequest(
  params: CreatePaymentRequestParams,
): Promise<HitPayPaymentRequest> {
  const body: Record<string, unknown> = {
    amount: params.amount,
    currency: params.currency,
    payment_methods: [params.method],
    reference_number: params.referenceNumber,
  };

  if (params.method === "paynow_online") {
    body.generate_qr = true;
  } else {
    body.redirect_url = params.redirectUrl;
  }

  if (params.name)  body.name  = params.name;
  if (params.email) body.email = params.email;

  const bodyStr = new URLSearchParams(
    Object.entries(body).flatMap(([k, v]) =>
      Array.isArray(v) ? v.map((item) => [k + "[]", String(item)]) : [[k, String(v)]]
    )
  ).toString();

  const res = await fetch(`${BASE_URL()}/payment-requests`, {
    method: "POST",
    headers: {
      "X-BUSINESS-API-KEY": API_KEY(),
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: bodyStr,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HitPay createPaymentRequest failed (${res.status}): ${text}`);
  }

  return res.json();
}

// ── 2. Verify Webhook Signature ────────────────────────────────────────────
// HitPay signs the raw JSON body with HMAC-SHA256 using your Salt value.
// Header: Hitpay-Signature

function verifyWebhook(bodyText: string, signature: string): boolean {
  const computed = crypto.createHmac("sha256", SALT()).update(bodyText).digest("hex");
  const computedBuf = Buffer.from(computed);
  const signatureBuf = Buffer.from(signature);
  // Guard against length mismatch (timingSafeEqual throws on different lengths)
  if (computedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(computedBuf, signatureBuf);
}

// ── 3. Parse Webhook Payload ───────────────────────────────────────────────

function parseWebhookPayload(bodyText: string): HitPayWebhookPayload {
  return JSON.parse(bodyText) as HitPayWebhookPayload;
}

// ── Export ──────────────────────────────────────────────────────────────────

const hitpay = { createPaymentRequest, verifyWebhook, parseWebhookPayload };
export default hitpay;
```

> **Note on Content-Type:** HitPay's API uses `application/x-www-form-urlencoded` (not JSON). Arrays are encoded as `payment_methods[]=paynow_online`. The `new URLSearchParams` with the flatMap handles this correctly.

- [ ] **Step 4: Run tests — confirm they pass**

```bash
npx vitest run src/__tests__/lib/hitpay.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/hitpay.ts src/__tests__/lib/hitpay.test.ts
git commit -m "feat(hitpay): add HitPay API client with unit tests"
```

---

## Task 3: POST /api/public/payments/hitpay — Create Payment Request

**Files:**
- Create: `src/app/api/public/payments/hitpay/route.ts`
- Create: `src/__tests__/payments/hitpay-create.test.ts`

This route resolves the enrollment, guards status, calculates fee, applies duplicate guard, calls HitPay, inserts payment row.

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/payments/hitpay-create.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ─────────────────────────────────────────────────────────────────

const mockAdminFrom = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockAdminFrom }),
}));

vi.mock("@/lib/api", () => ({
  resolveTenantId: vi.fn().mockResolvedValue("tenant-1"),
}));

const mockCreatePaymentRequest = vi.fn();
vi.mock("@/lib/hitpay", () => ({
  default: {
    createPaymentRequest: (...args: unknown[]) => mockCreatePaymentRequest(...args),
  },
}));

const { POST } = await import("@/app/api/public/payments/hitpay/route");

// ── Fixtures ──────────────────────────────────────────────────────────────

const ENROLLMENT = {
  id: "enroll-1",
  tenant_id: "tenant-1",
  enrollment_ref: "NM-2026-0001",
  status: "pending_payment",
  student_name_en: "Aung Aung",
  email: "student@test.com",
  class_id: "class-1",
  quantity: 1,
  enrollment_items: null,
  classes: { id: "class-1", fee_amount: 50, level: "N5" },
};

// ── Helper ────────────────────────────────────────────────────────────────

function makeRequest(body: object) {
  return new NextRequest("http://localhost/api/public/payments/hitpay", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", host: "localhost:3005" },
  });
}

function setupMocks(opts?: {
  enrollment?: object | null;
  existingPayment?: object | null;
  hitpayResult?: object;
}) {
  const enrollment = opts?.enrollment !== undefined ? opts.enrollment : ENROLLMENT;
  const hitpayResult = opts?.hitpayResult ?? {
    id: "hp-req-1",
    url: "https://checkout.hitpay.com/pay",
    qr_code_data: { qr_code: "QR_STRING" },
  };

  mockAdminFrom.mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    chain["select"] = vi.fn().mockReturnThis();
    chain["eq"] = vi.fn().mockReturnThis();
    chain["order"] = vi.fn().mockReturnThis();
    chain["limit"] = vi.fn().mockReturnThis();
    chain["single"] = vi.fn().mockResolvedValue({ data: enrollment, error: null });

    if (table === "payments") {
      // First call: duplicate guard — return null (no existing payment)
      // Second call: insert
      const existingPayment = opts?.existingPayment !== undefined ? opts.existingPayment : null;
      chain["single"] = vi.fn().mockResolvedValue({ data: existingPayment, error: null });
      chain["insert"] = vi.fn().mockResolvedValue({ error: null });
    }

    if (table === "enrollments") {
      chain["single"] = vi.fn().mockResolvedValue({ data: enrollment, error: null });
    }

    return chain;
  });

  mockCreatePaymentRequest.mockResolvedValue(hitpayResult);
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("POST /api/public/payments/hitpay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it("returns 400 when enrollmentRef is missing", async () => {
    const res = await POST(makeRequest({ method: "paynow_online" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when method is invalid", async () => {
    const res = await POST(makeRequest({ enrollmentRef: "NM-2026-0001", method: "invalid" }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when enrollment not found", async () => {
    setupMocks({ enrollment: null });
    const res = await POST(makeRequest({ enrollmentRef: "NM-2026-0001", method: "paynow_online" }));
    expect(res.status).toBe(404);
  });

  it("returns 409 when enrollment status is confirmed", async () => {
    setupMocks({ enrollment: { ...ENROLLMENT, status: "confirmed" } });
    const res = await POST(makeRequest({ enrollmentRef: "NM-2026-0001", method: "paynow_online" }));
    expect(res.status).toBe(409);
  });

  it("returns 200 with qrCode for paynow_online", async () => {
    const res = await POST(makeRequest({ enrollmentRef: "NM-2026-0001", method: "paynow_online" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.qrCode).toBe("QR_STRING");
    expect(body.paymentRequestId).toBe("hp-req-1");
  });

  it("returns 200 with url for card", async () => {
    const res = await POST(makeRequest({ enrollmentRef: "NM-2026-0001", method: "card" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe("https://checkout.hitpay.com/pay");
    expect(body.paymentRequestId).toBe("hp-req-1");
  });

  it("returns existing paymentRequestId without calling HitPay when duplicate guard triggers", async () => {
    setupMocks({
      existingPayment: { hitpay_payment_id: "hp-existing", status: "awaiting_payment" },
    });
    const res = await POST(makeRequest({ enrollmentRef: "NM-2026-0001", method: "paynow_online" }));
    expect(res.status).toBe(200);
    expect(mockCreatePaymentRequest).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.paymentRequestId).toBe("hp-existing");
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
npx vitest run src/__tests__/payments/hitpay-create.test.ts
```

Expected: FAIL — route module not found.

- [ ] **Step 3: Create `src/app/api/public/payments/hitpay/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import hitpay from "@/lib/hitpay";

// ─── POST /api/public/payments/hitpay ─────────────────────────────────────────
// Creates a HitPay payment request for PayNow QR or Card.
// Body: { enrollmentRef: string, method: "paynow_online" | "card" }

const ALLOWED_METHODS = ["paynow_online", "card"] as const;
type HitPayMethod = (typeof ALLOWED_METHODS)[number];

export async function POST(request: NextRequest) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  // ── 1. Parse body ──────────────────────────────────────────────────────────
  let body: { enrollmentRef?: string; method?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad Request", message: "Invalid JSON body." }, { status: 400 });
  }

  const { enrollmentRef, method } = body;

  if (!enrollmentRef || typeof enrollmentRef !== "string") {
    return NextResponse.json({ error: "Bad Request", message: "enrollmentRef is required." }, { status: 400 });
  }
  if (!method || !ALLOWED_METHODS.includes(method as HitPayMethod)) {
    return NextResponse.json(
      { error: "Bad Request", message: `method must be one of: ${ALLOWED_METHODS.join(", ")}` },
      { status: 400 },
    );
  }

  const hitpayMethod = method as HitPayMethod;
  const supabase = createAdminClient();

  // ── 2. Look up enrollment ──────────────────────────────────────────────────
  const { data: enrollment, error: enrollmentError } = (await supabase
    .from("enrollments")
    .select("id, enrollment_ref, tenant_id, status, student_name_en, email, class_id, quantity, classes(id, fee_amount, level), enrollment_items(class_id, quantity, fee_amount)")
    .eq("enrollment_ref", enrollmentRef.trim())
    .eq("tenant_id", tenantId)
    .single()) as {
    data: {
      id: string;
      enrollment_ref: string;
      tenant_id: string;
      status: string;
      student_name_en: string;
      email: string | null;
      class_id: string | null;
      quantity: number | null;
      classes: { id: string; fee_amount: number; level: string } | null;
      enrollment_items: { class_id: string; quantity: number; fee_amount: number }[] | null;
    } | null;
    error: unknown;
  };

  if (enrollmentError || !enrollment) {
    return NextResponse.json({ error: "Not Found", message: "Enrollment not found." }, { status: 404 });
  }

  // ── 3. Guard: only pending_payment or partial_payment ──────────────────────
  if (enrollment.status !== "pending_payment" && enrollment.status !== "partial_payment") {
    return NextResponse.json(
      { error: "Conflict", message: "This enrollment is not awaiting payment." },
      { status: 409 },
    );
  }

  // ── 4. Calculate total fee ─────────────────────────────────────────────────
  const isCart = !enrollment.class_id && enrollment.enrollment_items && enrollment.enrollment_items.length > 0;
  let totalFee: number;

  if (isCart) {
    totalFee = enrollment.enrollment_items!.reduce((s, i) => s + i.fee_amount * i.quantity, 0);
  } else if (enrollment.classes) {
    totalFee = enrollment.classes.fee_amount * (enrollment.quantity ?? 1);
  } else {
    return NextResponse.json({ error: "Internal Server Error", message: "Class data not found." }, { status: 500 });
  }

  // ── 5. Adjust for partial payment ──────────────────────────────────────────
  if (enrollment.status === "partial_payment") {
    const { data: existingPayment } = (await supabase
      .from("payments")
      .select("received_amount")
      .eq("enrollment_id", enrollment.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single()) as { data: { received_amount: number | null } | null; error: unknown };

    if (existingPayment?.received_amount) {
      totalFee = totalFee - existingPayment.received_amount;
    }
  }

  // ── 6. Duplicate guard ─────────────────────────────────────────────────────
  // Return existing payment request if one is already awaiting payment.
  const { data: existingHitPay } = (await supabase
    .from("payments")
    .select("hitpay_payment_id")
    .eq("enrollment_id", enrollment.id)
    .eq("payment_method", "hitpay")
    .eq("status", "awaiting_payment")
    .single()) as { data: { hitpay_payment_id: string | null } | null; error: unknown };

  if (existingHitPay?.hitpay_payment_id) {
    return NextResponse.json({
      paymentRequestId: existingHitPay.hitpay_payment_id,
      amount: totalFee,
      // qrCode and url not included — client should have these from first call
    });
  }

  // ── 7. Build redirect URL (card only) ──────────────────────────────────────
  const host = request.headers.get("host") ?? "localhost:3005";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const redirectUrl = `${proto}://${host}/enroll/payment/${encodeURIComponent(enrollmentRef)}?hitpay=success`;

  // ── 8. Call HitPay API ─────────────────────────────────────────────────────
  try {
    const result = await hitpay.createPaymentRequest({
      amount: totalFee.toFixed(2),  // fee_amount stored as whole SGD units e.g. 50 → "50.00"
      currency: "SGD",
      method: hitpayMethod,
      referenceNumber: enrollment.enrollment_ref,
      name: enrollment.student_name_en || undefined,
      email: enrollment.email || undefined,
      redirectUrl: hitpayMethod === "card" ? redirectUrl : undefined,
    });

    // ── 9. Insert payment record ───────────────────────────────────────────────
    await supabase.from("payments").insert({
      enrollment_id: enrollment.id,
      tenant_id: enrollment.tenant_id,
      amount: totalFee,
      payment_method: "hitpay",
      hitpay_payment_id: result.id,
      status: "awaiting_payment",
    } as never);

    if (hitpayMethod === "paynow_online") {
      return NextResponse.json({
        qrCode: result.qr_code_data?.qr_code ?? null,
        paymentRequestId: result.id,
        amount: totalFee,
      });
    } else {
      return NextResponse.json({
        url: result.url,
        paymentRequestId: result.id,
        amount: totalFee,
      });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[hitpay] createPaymentRequest error:", errMsg);
    return NextResponse.json(
      { error: "Payment Gateway Error", message: "Failed to create HitPay payment. Please try again.", detail: errMsg },
      { status: 502 },
    );
  }
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
npx vitest run src/__tests__/payments/hitpay-create.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/public/payments/hitpay/route.ts src/__tests__/payments/hitpay-create.test.ts
git commit -m "feat(hitpay): add POST /api/public/payments/hitpay route with tests"
```

---

## Task 4: GET /api/public/payments/hitpay/status — QR Polling

**Files:**
- Create: `src/app/api/public/payments/hitpay/status/route.ts`
- Create: `src/__tests__/payments/hitpay-status.test.ts`

DB-only read. No call to HitPay API — webhook is the sole source of truth.

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/payments/hitpay-status.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockAdminFrom = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockAdminFrom }),
}));

vi.mock("@/lib/api", () => ({
  resolveTenantId: vi.fn().mockResolvedValue("tenant-1"),
}));

const { GET } = await import("@/app/api/public/payments/hitpay/status/route");

function makeRequest(ref?: string) {
  const url = ref
    ? `http://localhost/api/public/payments/hitpay/status?ref=${encodeURIComponent(ref)}`
    : "http://localhost/api/public/payments/hitpay/status";
  return new NextRequest(url);
}

function setupEnrollmentMock(status: string | null) {
  mockAdminFrom.mockImplementation(() => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({
      data: status !== null ? { status } : null,
      error: null,
    }),
  }));
}

describe("GET /api/public/payments/hitpay/status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 when ref is missing", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
  });

  it("returns 404 when enrollment not found", async () => {
    setupEnrollmentMock(null);
    const res = await GET(makeRequest("NM-2026-0001"));
    expect(res.status).toBe(404);
  });

  it("returns enrollmentStatus=pending_payment while waiting", async () => {
    setupEnrollmentMock("pending_payment");
    const res = await GET(makeRequest("NM-2026-0001"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enrollmentStatus).toBe("pending_payment");
  });

  it("returns enrollmentStatus=confirmed when payment approved", async () => {
    setupEnrollmentMock("confirmed");
    const res = await GET(makeRequest("NM-2026-0001"));
    const body = await res.json();
    expect(body.enrollmentStatus).toBe("confirmed");
  });

  it("returns enrollmentStatus=rejected when payment failed", async () => {
    setupEnrollmentMock("rejected");
    const res = await GET(makeRequest("NM-2026-0001"));
    const body = await res.json();
    expect(body.enrollmentStatus).toBe("rejected");
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
npx vitest run src/__tests__/payments/hitpay-status.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/app/api/public/payments/hitpay/status/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";

// ─── GET /api/public/payments/hitpay/status?ref=<enrollmentRef> ───────────────
// Reads enrollment status from the local DB for the QR polling loop.
// Does NOT call HitPay's API — the webhook is the sole source of truth.
//
// Returns: { enrollmentStatus: "pending_payment" | "confirmed" | "rejected" | "cancelled" }
// Client polls every 3s:
//   - "pending_payment" → keep polling
//   - "confirmed"       → redirect to success
//   - "rejected"        → show error, stop polling
//   - other             → stop polling

export async function GET(request: NextRequest) {
  const ref = request.nextUrl.searchParams.get("ref");
  if (!ref) {
    return NextResponse.json({ error: "Bad Request", message: "ref is required." }, { status: 400 });
  }

  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  const supabase = createAdminClient();

  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select("status")
    .eq("enrollment_ref", ref.trim())
    .eq("tenant_id", tenantId)
    .single()) as { data: { status: string } | null; error: unknown };

  if (!enrollment) {
    return NextResponse.json({ error: "Not Found", message: "Enrollment not found." }, { status: 404 });
  }

  return NextResponse.json({ enrollmentStatus: enrollment.status });
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
npx vitest run src/__tests__/payments/hitpay-status.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/public/payments/hitpay/status/route.ts src/__tests__/payments/hitpay-status.test.ts
git commit -m "feat(hitpay): add GET /api/public/payments/hitpay/status polling route"
```

---

## Task 5: POST /api/webhooks/hitpay — Webhook Handler

**Files:**
- Create: `src/app/api/webhooks/hitpay/route.ts`
- Create: `src/__tests__/webhooks/hitpay-webhook.test.ts`

Mirrors `src/app/api/webhooks/paypay/route.ts` closely.

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/webhooks/hitpay-webhook.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import crypto from "crypto";

// ── Mocks ─────────────────────────────────────────────────────────────────

const mockAdminFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockAdminFrom }),
}));

const mockVerifyWebhook = vi.fn().mockReturnValue(true);
const mockParseWebhookPayload = vi.fn();
vi.mock("@/lib/hitpay", () => ({
  default: {
    verifyWebhook: (...args: unknown[]) => mockVerifyWebhook(...args),
    parseWebhookPayload: (...args: unknown[]) => mockParseWebhookPayload(...args),
  },
}));

vi.mock("@/server/notifications/dispatchPaymentApproved", () => ({
  dispatchPaymentApproved: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/utils", () => ({
  resolveEmailFromFormData: vi.fn().mockReturnValue(null),
  resolvePhoneFromFormData: vi.fn().mockReturnValue(null),
}));

const { POST } = await import("@/app/api/webhooks/hitpay/route");

// ── Fixtures ──────────────────────────────────────────────────────────────

const COMPLETED_PAYLOAD = {
  id: "hp-req-1",
  status: "completed",
  payments: [{ payment_type: "paynow_online" }],
};

const FAILED_PAYLOAD = {
  id: "hp-req-1",
  status: "failed",
  payments: [],
};

const PAYMENT = { id: "payment-1", enrollment_id: "enroll-1", amount: 50, status: "awaiting_payment" };
const ENROLLMENT = {
  tenant_id: "tenant-1", telegram_chat_id: null, email: "s@t.com", phone: null,
  enrollment_ref: "NM-2026-0001", student_name_en: "Aung", class_id: "class-1",
  quantity: 1, form_data: null,
};
const TENANT = { name: "School", org_type: "language_school", logo_url: null, currency: "SGD", sms_on_payment: false };
const CLASS = { level: "N5", fee_amount: 50 };

// ── Helper ────────────────────────────────────────────────────────────────

function makeRequest(body: object, signature = "valid-sig") {
  return new NextRequest("http://localhost/api/webhooks/hitpay", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "hitpay-signature": signature,
      host: "localhost:3005",
    },
  });
}

function setupMocks(opts?: { paymentStatus?: string; payload?: object }) {
  const payload = opts?.payload ?? COMPLETED_PAYLOAD;
  mockParseWebhookPayload.mockReturnValue(payload);

  mockAdminFrom.mockImplementation((table: string) => {
    const makeChain = (data: unknown) => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      neq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data, error: null }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
    });

    if (table === "payments") return makeChain({ ...PAYMENT, status: opts?.paymentStatus ?? "awaiting_payment" });
    if (table === "enrollments") return makeChain(ENROLLMENT);
    if (table === "tenants") return makeChain(TENANT);
    if (table === "classes") return makeChain(CLASS);
    if (table === "enrollment_items") return makeChain([]);
    return makeChain(null);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("POST /api/webhooks/hitpay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it("returns 403 when Hitpay-Signature header is missing", async () => {
    const req = new NextRequest("http://localhost/api/webhooks/hitpay", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("returns 403 when signature is invalid", async () => {
    mockVerifyWebhook.mockReturnValueOnce(false);
    const res = await POST(makeRequest(COMPLETED_PAYLOAD));
    expect(res.status).toBe(403);
  });

  it("returns 200 for non-completed, non-failed status (idempotent)", async () => {
    setupMocks({ payload: { ...COMPLETED_PAYLOAD, status: "pending" } });
    const res = await POST(makeRequest({ ...COMPLETED_PAYLOAD, status: "pending" }));
    expect(res.status).toBe(200);
  });

  it("returns 200 and skips processing when payment already verified (replay guard)", async () => {
    setupMocks({ paymentStatus: "verified" });
    const res = await POST(makeRequest(COMPLETED_PAYLOAD));
    expect(res.status).toBe(200);
  });

  it("returns 200 and confirms enrollment on completed status", async () => {
    const res = await POST(makeRequest(COMPLETED_PAYLOAD));
    expect(res.status).toBe(200);
  });

  it("updates payment to rejected on failed status", async () => {
    setupMocks({ payload: FAILED_PAYLOAD });
    const res = await POST(makeRequest(FAILED_PAYLOAD));
    expect(res.status).toBe(200);
  });

  it("returns 200 (not 404) when payment not found — may belong to another system", async () => {
    mockAdminFrom.mockImplementation((table: string) => {
      if (table === "payments") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
      };
    });
    const res = await POST(makeRequest(COMPLETED_PAYLOAD));
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
npx vitest run src/__tests__/webhooks/hitpay-webhook.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/app/api/webhooks/hitpay/route.ts`**

Model this closely on `src/app/api/webhooks/paypay/route.ts`. Key differences:
- Signature header: `Hitpay-Signature` (not `x-paypay-signature`)
- Reject missing signature always (no sandbox bypass)
- Lookup by `.eq("hitpay_payment_id", payload.id)` (not `payment_ref`)
- `failed` status → update payment `status: "rejected"`
- Payload parsed with `hitpay.parseWebhookPayload(bodyText)` returning `{ id, status, payments }`

```ts
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import hitpay from "@/lib/hitpay";
import { dispatchPaymentApproved } from "@/server/notifications/dispatchPaymentApproved";
import { resolveEmailFromFormData, resolvePhoneFromFormData } from "@/lib/utils";

// ─── POST /api/webhooks/hitpay ────────────────────────────────────────────────
// HitPay payment webhook. Verifies HMAC-SHA256 signature, confirms enrollment.
// Always returns 200 — HitPay retries on non-200.

export async function POST(request: NextRequest) {
  const bodyText = await request.text();
  const signature = request.headers.get("hitpay-signature");

  // ── 1. Verify signature ────────────────────────────────────────────────────
  if (!signature) {
    console.warn("[hitpay-webhook] Missing Hitpay-Signature header");
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const isValid = hitpay.verifyWebhook(bodyText, signature);
    if (!isValid) {
      console.warn("[hitpay-webhook] Invalid signature");
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } catch {
    console.warn("[hitpay-webhook] Signature verification error");
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── 2. Parse payload ───────────────────────────────────────────────────────
  let payload: ReturnType<typeof hitpay.parseWebhookPayload>;
  try {
    payload = hitpay.parseWebhookPayload(bodyText);
  } catch {
    console.warn("[hitpay-webhook] Failed to parse payload");
    return NextResponse.json({ ok: true });
  }

  const supabase = createAdminClient();

  // ── 3. Handle failed status ────────────────────────────────────────────────
  if (payload.status === "failed") {
    const { data: payment } = (await supabase
      .from("payments")
      .select("id")
      .eq("hitpay_payment_id", payload.id)
      .single()) as { data: { id: string } | null; error: unknown };

    if (payment) {
      await supabase
        .from("payments")
        .update({ status: "rejected" } as never)
        .eq("id", payment.id);
    }
    return NextResponse.json({ ok: true });
  }

  // ── 4. Only process completed ──────────────────────────────────────────────
  if (payload.status !== "completed") {
    return NextResponse.json({ ok: true });
  }

  // ── 5. Find payment by hitpay_payment_id ──────────────────────────────────
  const { data: payment } = (await supabase
    .from("payments")
    .select("id, enrollment_id, amount, status")
    .eq("hitpay_payment_id", payload.id)
    .single()) as {
    data: { id: string; enrollment_id: string; amount: number; status: string } | null;
    error: unknown;
  };

  if (!payment) {
    console.warn("[hitpay-webhook] Payment not found for hitpay_payment_id:", payload.id);
    return NextResponse.json({ ok: true });
  }

  // ── 6. Replay guard ────────────────────────────────────────────────────────
  if (payment.status === "verified" || payment.status === "rejected") {
    return NextResponse.json({ ok: true });
  }

  // ── 7. Confirm payment + enrollment ───────────────────────────────────────
  const now = new Date().toISOString();

  await supabase
    .from("payments")
    .update({ status: "verified", verified_at: now, received_amount: payment.amount } as never)
    .eq("id", payment.id);

  await supabase
    .from("enrollments")
    .update({ status: "confirmed" } as never)
    .eq("id", payment.enrollment_id);

  // ── 8. Fetch notification data ─────────────────────────────────────────────
  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select("tenant_id, telegram_chat_id, email, phone, enrollment_ref, student_name_en, class_id, quantity, form_data, messenger_psid")
    .eq("id", payment.enrollment_id)
    .single()) as {
    data: {
      tenant_id: string;
      telegram_chat_id: string | null;
      email: string | null;
      phone: string | null;
      enrollment_ref: string;
      student_name_en: string;
      class_id: string | null;
      quantity: number | null;
      form_data: Record<string, string> | null;
      messenger_psid: string | null;
    } | null;
    error: unknown;
  };

  if (!enrollment) return NextResponse.json({ ok: true });

  const host = request.headers.get("host") ?? "localhost:3005";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const statusUrl = `${proto}://${host}/status?ref=${enrollment.enrollment_ref}`;

  const { data: tenantInfo } = (await supabase
    .from("tenants")
    .select("name, org_type, logo_url, currency, sms_on_payment")
    .eq("id", enrollment.tenant_id)
    .single()) as {
    data: { name: string; org_type: string; logo_url: string | null; currency: string; sms_on_payment: boolean } | null;
    error: unknown;
  };

  const tenantCurrency = tenantInfo?.currency ?? "SGD";
  let classLevel = "Ticket";
  let feeFormatted: string | undefined;
  const isCart = enrollment.class_id === null;

  if (isCart) {
    const { data: items } = (await supabase
      .from("enrollment_items")
      .select("quantity, fee_amount, classes(level)")
      .eq("enrollment_id", payment.enrollment_id)) as {
      data: { quantity: number; fee_amount: number; classes: { level: string } | null }[] | null;
      error: unknown;
    };
    if (items && items.length > 0) {
      classLevel = items
        .map((i) => (i.quantity > 1 ? `${i.classes?.level ?? "?"} x${i.quantity}` : (i.classes?.level ?? "?")))
        .join(", ");
      const total = items.reduce((s, i) => s + i.fee_amount * i.quantity, 0);
      feeFormatted = `${String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} ${tenantCurrency}`;
    }
  } else {
    const { data: cls } = (await supabase
      .from("classes")
      .select("level, fee_amount")
      .eq("id", enrollment.class_id!)
      .single()) as { data: { level: string; fee_amount: number } | null; error: unknown };
    if (cls) {
      classLevel = cls.level;
      const total = cls.fee_amount * (enrollment.quantity ?? 1);
      feeFormatted = `${String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} ${tenantCurrency}`;
    }
  }

  // ── 9. Dispatch notifications ──────────────────────────────────────────────
  await dispatchPaymentApproved({
    tenantId: enrollment.tenant_id,
    enrollmentId: payment.enrollment_id,
    enrollmentRef: enrollment.enrollment_ref,
    studentName: enrollment.student_name_en || "Student",
    classLevel,
    feeFormatted,
    statusUrl,
    paymentUrl: statusUrl,
    currency: tenantCurrency,
    email: enrollment.email || resolveEmailFromFormData(enrollment.form_data),
    phone: enrollment.phone || resolvePhoneFromFormData(enrollment.form_data),
    messengerPsid: enrollment.messenger_psid,
    telegramChatId: enrollment.telegram_chat_id,
    classId: enrollment.class_id,
    tenantName: tenantInfo?.name,
    orgType: tenantInfo?.org_type,
    logoUrl: tenantInfo?.logo_url ?? undefined,
    smsOnPayment: tenantInfo?.sms_on_payment,
  });

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
npx vitest run src/__tests__/webhooks/hitpay-webhook.test.ts
```

Expected: all pass.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/webhooks/hitpay/route.ts src/__tests__/webhooks/hitpay-webhook.test.ts
git commit -m "feat(hitpay): add POST /api/webhooks/hitpay handler with tests"
```

---

## Task 6: Admin Settings — Add HitPay Mode

**Files:**
- Modify: `src/app/admin/settings/page.tsx`

No tests for this task — it's a UI-only change to an existing large page.

- [ ] **Step 1: Update paymentMode type union**

Find (around line 525):
```ts
const [paymentMode, setPaymentMode] = useState<"bank_transfer" | "mmqr" | "stripe" | "paypay">("bank_transfer");
```

Replace with:
```ts
const [paymentMode, setPaymentMode] = useState<"bank_transfer" | "mmqr" | "stripe" | "paypay" | "hitpay">("bank_transfer");
```

Also update the cast on the line that reads from DB (around line 587):
```ts
setPaymentMode((tenant.payment_mode as "bank_transfer" | "mmqr" | "stripe" | "paypay" | "hitpay") ?? "bank_transfer");
```

- [ ] **Step 2: Add HitPay button to the payment mode selector grid**

Find the existing PayPay button block and add after it:

```tsx
<button
  onClick={() => setPaymentMode("hitpay")}
  className={`flex-1 rounded-xl border-2 px-4 py-3 text-left transition-colors ${
    paymentMode === "hitpay"
      ? "border-[#1a3f8a] bg-[#1a3f8a]/5"
      : "border-gray-200 hover:border-gray-300"
  }`}
>
  <p className="font-semibold text-sm">HitPay</p>
  <p className="text-xs text-gray-500 mt-0.5">PayNow QR + Card (SGD)</p>
</button>
```

- [ ] **Step 3: Add info card for HitPay mode**

After the PayPay info card block, add:

```tsx
{paymentMode === "hitpay" && (
  <div className="flex items-start gap-2 rounded-lg bg-blue-50 px-3 py-2.5">
    <svg className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 013.75 9.375v-4.5zM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5zM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0113.5 9.375v-4.5z" />
    </svg>
    <p className="text-xs text-blue-700">
      Students can pay via PayNow QR or Visa/Mastercard (SGD). Auto-confirmed via webhook — no manual verification needed. Set <code className="font-mono">HITPAY_API_KEY</code> and <code className="font-mono">HITPAY_SALT</code> in your environment variables.
    </p>
  </div>
)}
```

- [ ] **Step 4: Verify build passes**

```bash
npm run build 2>&1 | grep -E "Type error:|✓ Compiled"
```

Expected: `✓ Compiled successfully`

- [ ] **Step 5: Commit**

```bash
git add src/app/admin/settings/page.tsx
git commit -m "feat(hitpay): add HitPay payment mode option in admin settings"
```

---

## Task 7: Payment Page UI — HitPay Tab Selector

**Files:**
- Modify: `src/app/(public)/enroll/payment/[ref]/page.tsx`

This is a large file (1889 lines). Make targeted, minimal additions — do not restructure existing code.

- [ ] **Step 1: Add state variables for HitPay**

Find the existing state declarations block (around line 1004–1013). Add after the existing state:

```ts
// ── HitPay state ─────────────────────────────────────────────────────────
const [hitpayTab, setHitpayTab] = useState<"paynow" | "card">("paynow");
const [hitpayQrCode, setHitpayQrCode] = useState<string | null>(null);
const [hitpayQrImage, setHitpayQrImage] = useState<string | null>(null);
const [hitpayLoading, setHitpayLoading] = useState(false);
const [hitpayError, setHitpayError] = useState<string | null>(null);
const [hitpayReturn, setHitpayReturn] = useState<"success" | null>(null);
const [hitpayPolling, setHitpayPolling] = useState(false);
```

Also add `QRCode` import at the top of the file:
```ts
import QRCode from "qrcode";
```

- [ ] **Step 2: Detect `?hitpay=success` on page load**

Find the block that handles `?stripe=` and `?paypay=` params (around line 1041). Add alongside them:

```ts
const hitpayParam = params_.get("hitpay");
if (hitpayParam === "success") {
  setHitpayReturn("success");
  window.history.replaceState({}, "", window.location.pathname);
}
```

- [ ] **Step 3: Add PayNow QR handler**

Add a new function after `handleStripeCheckout`:

```ts
async function handleHitPayPayNow() {
  if (hitpayLoading) return;
  setHitpayLoading(true);
  setHitpayError(null);
  setHitpayQrCode(null);
  setHitpayQrImage(null);

  try {
    const res = await fetch("/api/public/payments/hitpay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enrollmentRef: params.ref, method: "paynow_online" }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message ?? "Failed to generate QR.");

    const qrCode: string = data.qrCode;
    setHitpayQrCode(qrCode);

    const dataUrl = await QRCode.toDataURL(qrCode, { width: 280, margin: 2 });
    setHitpayQrImage(dataUrl);
    setHitpayPolling(true);
  } catch (err) {
    setHitpayError(err instanceof Error ? err.message : "Something went wrong.");
  } finally {
    setHitpayLoading(false);
  }
}

async function handleHitPayCard() {
  if (hitpayLoading) return;
  setHitpayLoading(true);
  setHitpayError(null);

  try {
    const res = await fetch("/api/public/payments/hitpay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enrollmentRef: params.ref, method: "card" }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message ?? "Failed to initiate card payment.");
    window.location.href = data.url;
  } catch (err) {
    setHitpayError(err instanceof Error ? err.message : "Something went wrong.");
    setHitpayLoading(false);
  }
}
```

- [ ] **Step 4: Add PayNow QR polling effect**

Add a new `useEffect` for HitPay polling after the existing polling effects:

```ts
// ── HitPay QR polling ─────────────────────────────────────────────────────
useEffect(() => {
  if (!hitpayPolling || !params.ref) return;

  const interval = setInterval(async () => {
    try {
      const res = await fetch(
        `/api/public/payments/hitpay/status?ref=${encodeURIComponent(params.ref)}`,
      );
      const data = await res.json();

      if (data.enrollmentStatus === "confirmed") {
        clearInterval(interval);
        setHitpayPolling(false);
        router.push(`/enroll/${slug}/checkout/success`);
      } else if (data.enrollmentStatus === "rejected" || data.enrollmentStatus === "cancelled") {
        clearInterval(interval);
        setHitpayPolling(false);
        setHitpayQrImage(null);
        setHitpayError("Payment failed. Please try again.");
      }
    } catch {
      // network error — keep polling
    }
  }, 3000);

  return () => clearInterval(interval);
}, [hitpayPolling, params.ref, router, slug]);
```

> **Note:** `slug` is already available in this component from the page params.

- [ ] **Step 5: Add HitPay UI block in the JSX**

Find the Stripe payment block (around line 1463). Add the HitPay block right after it:

```tsx
{/* ── Pay via HitPay ──────────────────────────────────────── */}
{enrollment.payment_mode === "hitpay" && (enrollment.status === "pending_payment" || enrollment.status === "partial_payment") && (
  <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">

    {/* Return banner */}
    {hitpayReturn === "success" && (
      <div className="mb-4 rounded-lg bg-blue-50 px-3 py-2.5 text-sm text-blue-700 text-center">
        Payment received — confirming your enrollment…
      </div>
    )}

    {/* Tab selector */}
    <div className="flex gap-2 mb-4">
      <button
        onClick={() => { setHitpayTab("paynow"); setHitpayQrImage(null); setHitpayError(null); setHitpayPolling(false); }}
        className={`flex-1 rounded-lg py-2 text-sm font-semibold transition-colors ${
          hitpayTab === "paynow"
            ? "bg-[#1a3f8a] text-white"
            : "bg-gray-100 text-gray-600 hover:bg-gray-200"
        }`}
      >
        PayNow
      </button>
      <button
        onClick={() => { setHitpayTab("card"); setHitpayQrImage(null); setHitpayError(null); setHitpayPolling(false); }}
        className={`flex-1 rounded-lg py-2 text-sm font-semibold transition-colors ${
          hitpayTab === "card"
            ? "bg-[#1a3f8a] text-white"
            : "bg-gray-100 text-gray-600 hover:bg-gray-200"
        }`}
      >
        Card
      </button>
    </div>

    {/* Error */}
    {hitpayError && (
      <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
        {hitpayError}
      </div>
    )}

    {/* PayNow tab */}
    {hitpayTab === "paynow" && (
      <>
        {hitpayQrImage ? (
          <div className="text-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={hitpayQrImage} alt="PayNow QR Code" className="mx-auto rounded-lg" width={280} height={280} />
            <p className="mt-2 text-xs text-gray-500">Scan with your banking app (PayNow)</p>
            <button
              onClick={() => { setHitpayQrImage(null); setHitpayQrCode(null); setHitpayPolling(false); }}
              className="mt-3 text-xs text-gray-400 underline"
            >
              Cancel
            </button>
          </div>
        ) : (
          <>
            <p className="text-sm text-gray-500 mb-4">
              Generate a PayNow QR code and scan it with your banking app to pay instantly.
            </p>
            <button
              onClick={handleHitPayPayNow}
              disabled={hitpayLoading}
              className="w-full rounded-xl bg-[#1a3f8a] px-4 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-900 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {hitpayLoading ? "Generating QR…" : "Generate PayNow QR"}
            </button>
          </>
        )}
      </>
    )}

    {/* Card tab */}
    {hitpayTab === "card" && (
      <>
        <p className="text-sm text-gray-500 mb-4">
          You will be redirected to a secure payment page to pay by Visa or Mastercard.
        </p>
        <button
          onClick={handleHitPayCard}
          disabled={hitpayLoading}
          className="w-full rounded-xl bg-[#1a3f8a] px-4 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-900 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {hitpayLoading ? "Redirecting…" : "Pay by Card"}
        </button>
        <p className="mt-2 text-center text-xs text-gray-400">
          Powered by HitPay — secure card payment
        </p>
      </>
    )}
  </div>
)}
```

- [ ] **Step 6: Verify build passes**

```bash
npm run build 2>&1 | grep -E "Type error:|✓ Compiled"
```

Expected: `✓ Compiled successfully`

- [ ] **Step 7: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/app/\(public\)/enroll/payment/\[ref\]/page.tsx
git commit -m "feat(hitpay): add HitPay payment UI — PayNow QR tab and Card tab"
```

---

## Final Verification

- [ ] **Run full build + tests**

```bash
npm run build && npm test
```

Expected: clean build, all tests pass.

- [ ] **Set env vars in `.env.local`**

```
HITPAY_API_KEY=<from HitPay sandbox dashboard>
HITPAY_SALT=<from HitPay sandbox dashboard>
HITPAY_MODE=sandbox
```

- [ ] **Register webhook in HitPay sandbox dashboard**

Navigate to Developers → Webhook Endpoints → New Webhook:
- URL: `https://<your-ngrok-or-tunnel>/api/webhooks/hitpay`
- Event: `payment_request.completed`

- [ ] **Create a test tenant with `payment_mode = hitpay` and test the full flow**

1. Admin settings → set payment mode to HitPay → save
2. Enroll a student → proceed to payment page
3. PayNow tab → Generate QR → sandbox: QR value may be a URL, visit it directly to simulate payment
4. Confirm webhook fires → enrollment status → confirmed
5. Card tab → Pay by Card → redirects to HitPay sandbox checkout → complete payment
6. Confirm webhook fires → enrollment confirmed

- [ ] **Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix(hitpay): post-testing fixes"
```
