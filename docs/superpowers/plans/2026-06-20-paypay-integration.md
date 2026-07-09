# PayPay Payment Gateway Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PayPay as a payment gateway option so tenants targeting Japanese students can accept JPY payments via PayPay QR codes.

**Architecture:** PayPay follows the same QR-based payment pattern as ABank/MyanMyanPay — create QR code via API, student scans with PayPay app, webhook/polling confirms payment. We add a new `src/lib/paypay.ts` client, new API routes under `/api/public/payments/paypay/`, extend the `QRPaymentModal` to support PayPay branding, and add `'paypay'` as a new `payment_mode` option on tenants.

**Tech Stack:** Next.js 14 API routes, PayPay OPA Web Payment API (`/v2/codes`), HMAC-SHA256 auth, QR code rendering via `qrcode` library (already installed)

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/lib/paypay.ts` | PayPay API client (create QR, check status, verify webhook HMAC) |
| Create | `src/lib/payment-notifications.ts` | Shared notification helper (extracted to avoid route-file imports) |
| Create | `src/app/api/public/payments/paypay/route.ts` | POST — create PayPay QR payment order |
| Create | `src/app/api/public/payments/paypay/status/route.ts` | GET — poll PayPay payment status |
| Create | `src/app/api/public/payments/paypay/webhook/route.ts` | POST — receive PayPay webhook notifications |
| Create | `supabase/migrations/083_paypay_support.sql` | Add paypay columns to payments table |
| Modify | `src/components/payments/QRPaymentModal.tsx` | Add `"paypay"` provider with PayPay branding and URL-based QR |
| Modify | `src/app/(public)/enroll/payment/[ref]/page.tsx` | Add PayPay payment button/section |

---

### Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/083_paypay_support.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- Migration 083: PayPay payment gateway support
-- Adds PayPay-specific columns to payments table.

-- 1. Add paypay columns to payments table
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS paypay_code_id TEXT,
  ADD COLUMN IF NOT EXISTS paypay_status TEXT;

COMMENT ON COLUMN public.payments.paypay_code_id IS 'PayPay codeId returned from POST /v2/codes';
COMMENT ON COLUMN public.payments.paypay_status IS 'CREATED | COMPLETED | EXPIRED | CANCELED | FAILED';

-- 2. Add index for webhook lookups by paypay_code_id
CREATE INDEX IF NOT EXISTS idx_payments_paypay_code_id ON public.payments (paypay_code_id) WHERE paypay_code_id IS NOT NULL;

-- 3. Update payment_mode comment to include paypay
COMMENT ON COLUMN public.tenants.payment_mode IS 'bank_transfer | mmqr | stripe | paypay';
```

- [ ] **Step 2: Show migration diff and confirm before applying**

Run: `cat supabase/migrations/083_paypay_support.sql`
Then ask user to confirm before running `npx supabase db push`

- [ ] **Step 3: Apply migration to dev DB**

Run: `npx supabase db push --linked`
Expected: Migration applied successfully

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/083_paypay_support.sql
git commit -m "feat(db): add PayPay payment columns and index (migration 083)"
```

---

### Task 2: PayPay API Client Library

**Files:**
- Create: `src/lib/paypay.ts`
- Reference: `src/lib/abank.ts` (pattern to follow)

- [ ] **Step 1: Create the PayPay client library**

```typescript
// ─── PayPay Web Payment API client ──────────────────────────────────────────
// Docs: https://developer.paypay.ne.jp/products/docs/webpayment
// API:  https://www.paypay.ne.jp/opa/doc/v1.0/webcashier
//
// Sandbox: https://stg-api.sandbox.paypay.ne.jp
// Prod:    https://api.paypay.ne.jp

import crypto from "crypto";

const API_KEY = () => process.env.PAYPAY_API_KEY!;
const API_SECRET = () => process.env.PAYPAY_API_SECRET!;
const MERCHANT_ID = () => process.env.PAYPAY_MERCHANT_ID!;
const WEBHOOK_SECRET = () => process.env.PAYPAY_WEBHOOK_SECRET ?? API_SECRET();
const BASE_URL = () =>
  process.env.PAYPAY_MODE === "production"
    ? "https://api.paypay.ne.jp"
    : "https://stg-api.sandbox.paypay.ne.jp";

// ── HMAC-SHA256 Auth Headers ────────────────────────────────────────────────
// PayPay OPA uses HMAC authentication:
// Authorization: hmac OPA-Auth:{apiKey}:{hmacSignature}:{nonce}:{epoch}:{contentMD5}
// String to sign: {path}\n{contentType}\n{contentMD5}\n{epoch}\n{nonce}

function authHeaders(
  method: string,
  path: string,
  contentType: string,
  body?: string,
): Record<string, string> {
  const nonce = crypto.randomUUID();
  const epoch = Math.floor(Date.now() / 1000).toString();

  // Content-MD5: hash of body for POST, empty string for GET (no body)
  const contentMD5 = body
    ? crypto.createHash("md5").update(body, "utf8").digest("base64")
    : "";

  // String to sign
  const message = `${path}\n${contentType}\n${contentMD5}\n${epoch}\n${nonce}`;
  const hmac = crypto
    .createHmac("sha256", API_SECRET())
    .update(message)
    .digest("base64");

  return {
    "Content-Type": contentType,
    Authorization: `hmac OPA-Auth:${API_KEY()}:${hmac}:${nonce}:${epoch}:${contentMD5}`,
    "X-ASSUME-MERCHANT": MERCHANT_ID(),
  };
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface CreateQRParams {
  merchantPaymentId: string; // unique per transaction, <=64 chars
  amount: number; // in JPY (integer, no decimals)
  orderDescription?: string; // <=255 chars
  redirectUrl: string; // where to redirect after payment
}

export interface CreateQRResponse {
  resultInfo: { code: string; message: string };
  data: {
    codeId: string;
    url: string; // PayPay payment page URL
    deeplink: string; // PayPay app deeplink
    expiryDate: number; // epoch ms
    merchantPaymentId: string;
    amount: { amount: number; currency: string };
    [key: string]: unknown;
  };
}

export interface PaymentStatusResponse {
  resultInfo: { code: string; message: string };
  data: {
    paymentId: string;
    status: "CREATED" | "COMPLETED" | "CANCELED" | "EXPIRED" | "FAILED";
    merchantPaymentId: string;
    amount: { amount: number; currency: string };
    [key: string]: unknown;
  };
}

export interface WebhookPayload {
  notification_type: string; // "Transaction"
  merchant_id: string;
  store_id?: string;
  notification_id: string;
  notification_data: string; // JSON string containing payment details
  notification_timestamp: number;
}

export interface WebhookNotificationData {
  merchantPaymentId: string;
  paymentId: string;
  state: "COMPLETED" | "AUTHORIZED" | "CANCELED" | "EXPIRED" | "FAILED";
  amount: { amount: number; currency: string };
  paidAt?: string;
  [key: string]: unknown;
}

// ── 1. Create QR Code ───────────────────────────────────────────────────────

async function createQR(params: CreateQRParams): Promise<CreateQRResponse> {
  const path = "/v2/codes";
  const body = JSON.stringify({
    merchantPaymentId: params.merchantPaymentId,
    amount: { amount: params.amount, currency: "JPY" },
    codeType: "ORDER_QR",
    orderDescription: params.orderDescription ?? "",
    redirectUrl: params.redirectUrl,
    redirectType: "WEB_LINK",
  });

  const headers = authHeaders("POST", path, "application/json;charset=UTF-8", body);

  const res = await fetch(`${BASE_URL()}${path}`, {
    method: "POST",
    headers,
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPay createQR failed (${res.status}): ${text}`);
  }

  return res.json();
}

// ── 2. Get Payment Status ───────────────────────────────────────────────────

async function getPaymentStatus(merchantPaymentId: string): Promise<PaymentStatusResponse> {
  const path = `/v2/codes/payments/${encodeURIComponent(merchantPaymentId)}`;
  const headers = authHeaders("GET", path, "application/json;charset=UTF-8");

  const res = await fetch(`${BASE_URL()}${path}`, {
    method: "GET",
    headers,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPay getPaymentStatus failed (${res.status}): ${text}`);
  }

  return res.json();
}

// ── 3. Parse & Verify Webhook ───────────────────────────────────────────────
// PayPay webhook verification: HMAC-SHA256 of raw body using webhook secret.
// If PayPay does not provide a separate webhook secret, falls back to API_SECRET.

function verifyWebhook(bodyText: string, signature: string): boolean {
  const expected = crypto
    .createHmac("sha256", WEBHOOK_SECRET())
    .update(bodyText, "utf8")
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function parseWebhookPayload(bodyText: string): {
  webhook: WebhookPayload;
  data: WebhookNotificationData;
} {
  const webhook: WebhookPayload = JSON.parse(bodyText);
  const data: WebhookNotificationData = JSON.parse(webhook.notification_data);
  return { webhook, data };
}

// ── Export ──────────────────────────────────────────────────────────────────

const paypay = {
  createQR,
  getPaymentStatus,
  verifyWebhook,
  parseWebhookPayload,
};

export default paypay;
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit src/lib/paypay.ts 2>&1 | head -20`
Expected: No errors (or only unrelated project-wide errors)

- [ ] **Step 3: Commit**

```bash
git add src/lib/paypay.ts
git commit -m "feat(paypay): add PayPay OPA Web Payment API client with HMAC auth"
```

---

### Task 3: Shared Payment Notification Helper

**Files:**
- Create: `src/lib/payment-notifications.ts`
- Reference: Notification block in `src/app/api/public/payments/abank/status/route.ts` and `src/app/api/public/payments/mmpay/webhook/route.ts`

This extracts the duplicated notification logic into a shared utility so both the status polling route and webhook route can use it without importing from a Next.js route file (which is an anti-pattern).

- [ ] **Step 1: Create the shared notification helper**

```typescript
// ─── Shared payment success notification helper ─────────────────────────────
// Used by PayPay status polling and webhook routes.
// Same notification pattern as abank/status and mmpay/webhook.

import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail, enrollmentApprovedEmail } from "@/lib/email";
import { sendTelegramStatusNotification } from "@/lib/telegram/notify";
import { sendChannelInviteIfEligible } from "@/lib/telegram/channel-invite";
import { resolveEmailFromFormData, resolvePhoneFromFormData } from "@/lib/utils";
import { sendSms } from "@/lib/sms";

export async function sendPaymentNotifications(
  supabase: ReturnType<typeof createAdminClient>,
  payment: { id: string; enrollment_id: string },
  request: NextRequest,
) {
  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select("tenant_id, telegram_chat_id, email, phone, enrollment_ref, student_name_en, class_id, quantity, form_data")
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
    } | null;
    error: unknown;
  };

  if (!enrollment) return;

  const enrollEmail = enrollment.email
    || resolveEmailFromFormData(enrollment.form_data as Record<string, string> | null);
  const host = request.headers.get("host") ?? "localhost:3005";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const statusUrl = `${proto}://${host}/status?ref=${enrollment.enrollment_ref}`;

  // Resolve class level
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
      feeFormatted = String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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
      feeFormatted = String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }
  }

  // Fetch tenant info
  const { data: tenantInfo } = (await supabase
    .from("tenants")
    .select("name, org_type, logo_url, currency, sms_on_payment")
    .eq("id", enrollment.tenant_id)
    .single()) as {
    data: { name: string; org_type: string; logo_url: string | null; currency: string; sms_on_payment: boolean } | null;
    error: unknown;
  };
  const tenantCurrency = tenantInfo?.currency ?? "JPY";
  if (feeFormatted) feeFormatted = `${feeFormatted} ${tenantCurrency}`;

  const notifyTasks: Promise<unknown>[] = [];

  // Telegram notification
  if (enrollment.telegram_chat_id) {
    notifyTasks.push(
      sendTelegramStatusNotification({
        tenantId: enrollment.tenant_id,
        telegramChatId: enrollment.telegram_chat_id,
        action: "approve",
        studentName: enrollment.student_name_en || "Student",
        enrollmentRef: enrollment.enrollment_ref,
        classLevel,
        statusUrl,
        paymentUrl: statusUrl,
        currency: tenantCurrency,
      }).catch((err) => {
        console.error("[paypay] Telegram notification failed:", err);
      }),
    );
  }

  // Email notification
  if (enrollEmail) {
    const emailData = enrollmentApprovedEmail({
      studentName: enrollment.student_name_en || "Student",
      enrollmentRef: enrollment.enrollment_ref,
      classLevel,
      statusUrl,
      feeFormatted,
      orgType: tenantInfo?.org_type,
      tenantName: tenantInfo?.name,
      logoUrl: tenantInfo?.logo_url ?? undefined,
    });
    notifyTasks.push(
      sendEmail({ to: enrollEmail, ...emailData }).catch((err) => {
        console.error("[paypay] Approval email failed:", err);
      }),
    );
  }

  // SMS notification
  const enrollPhone = enrollment.phone
    || resolvePhoneFromFormData(enrollment.form_data as Record<string, string> | null);
  if (enrollPhone && tenantInfo?.sms_on_payment !== false) {
    const name = enrollment.student_name_en || "Student";
    notifyTasks.push(
      sendSms({
        to: enrollPhone,
        message: `Hi ${name}, your payment for ${enrollment.enrollment_ref} has been confirmed. Welcome to class!`,
        clientReference: enrollment.enrollment_ref,
      }).catch((err) => {
        console.error("[paypay] Approval SMS failed:", err);
      }),
    );
  }

  // Channel invite
  if (enrollment.telegram_chat_id) {
    notifyTasks.push(
      sendChannelInviteIfEligible({
        tenantId: enrollment.tenant_id,
        enrollmentId: payment.enrollment_id,
        classId: enrollment.class_id,
        telegramChatId: enrollment.telegram_chat_id,
        studentName: enrollment.student_name_en || "Student",
      }).catch((err) => {
        console.error("[paypay] Channel invite failed:", err);
      }),
    );
  }

  await Promise.allSettled(notifyTasks);
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | grep payment-notifications`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/payment-notifications.ts
git commit -m "refactor: extract shared payment notification helper"
```

---

### Task 4: Create Payment API Route

**Files:**
- Create: `src/app/api/public/payments/paypay/route.ts`
- Reference: `src/app/api/public/payments/abank/route.ts` (exact pattern)

- [ ] **Step 1: Create the PayPay payment creation route**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import paypay from "@/lib/paypay";

// ─── POST /api/public/payments/paypay ───────────────────────────────────────
// Creates a PayPay QR payment order and returns the payment URL.
//
// Body: { enrollmentRef: string }

export async function POST(request: NextRequest) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  // ── 1. Parse body ──────────────────────────────────────────
  let body: { enrollmentRef?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Bad Request", message: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const { enrollmentRef } = body;
  if (!enrollmentRef || typeof enrollmentRef !== "string") {
    return NextResponse.json(
      { error: "Bad Request", message: "enrollmentRef is required." },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  // ── 2. Look up enrollment ──────────────────────────────────
  const { data: enrollment, error: enrollmentError } = (await supabase
    .from("enrollments")
    .select("*, classes(id, fee_amount, level), enrollment_items(class_id, quantity, fee_amount)")
    .eq("enrollment_ref", enrollmentRef.trim())
    .eq("tenant_id", tenantId)
    .single()) as {
    data: {
      id: string;
      enrollment_ref: string;
      tenant_id: string;
      class_id: string | null;
      quantity: number | null;
      status: string;
      student_name_en: string;
      classes: { id: string; fee_amount: number; level: string } | null;
      enrollment_items: { class_id: string; quantity: number; fee_amount: number }[] | null;
    } | null;
    error: unknown;
  };

  if (enrollmentError || !enrollment) {
    return NextResponse.json(
      { error: "Not Found", message: "Enrollment not found." },
      { status: 404 },
    );
  }

  // ── 3. Guard: only pending_payment or partial_payment ──────
  if (enrollment.status !== "pending_payment" && enrollment.status !== "partial_payment") {
    return NextResponse.json(
      { error: "Conflict", message: "This enrollment is not awaiting payment." },
      { status: 409 },
    );
  }

  // ── 4. Calculate total fee ─────────────────────────────────
  const isCart =
    !enrollment.class_id &&
    enrollment.enrollment_items &&
    enrollment.enrollment_items.length > 0;

  let totalFee: number;

  if (isCart) {
    totalFee = enrollment.enrollment_items!.reduce(
      (sum, item) => sum + item.fee_amount * item.quantity,
      0,
    );
  } else if (enrollment.classes) {
    const qty = enrollment.quantity ?? 1;
    totalFee = enrollment.classes.fee_amount * qty;
  } else {
    return NextResponse.json(
      { error: "Internal Server Error", message: "Class data not found." },
      { status: 500 },
    );
  }

  // ── 5. Adjust for partial payment ──────────────────────────
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

  // ── 6. Build merchantPaymentId (<=64 chars) ────────────────
  const ts = Date.now().toString(36);
  const shortEnroll = enrollment.id.replace(/-/g, "").slice(0, 12);
  const merchantPaymentId = `PY-${shortEnroll}-${ts}`;

  // ── Build redirect URL ─────────────────────────────────────
  const host = request.headers.get("host") ?? "localhost:3005";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const redirectUrl = `${proto}://${host}/enroll/payment/${encodeURIComponent(enrollmentRef)}?paypay=success`;

  try {
    const result = await paypay.createQR({
      merchantPaymentId,
      amount: totalFee,
      orderDescription: `Payment for ${enrollment.enrollment_ref}`,
      redirectUrl,
    });

    // ── 7. Create payment record ─────────────────────────────
    await supabase.from("payments").insert({
      enrollment_id: enrollment.id,
      tenant_id: enrollment.tenant_id,
      amount: totalFee,
      payment_ref: merchantPaymentId,
      payment_method: "paypay",
      paypay_code_id: result.data?.codeId ?? null,
      paypay_status: "CREATED",
      status: "awaiting_payment",
    } as never);

    return NextResponse.json({
      url: result.data?.url ?? null,
      deeplink: result.data?.deeplink ?? null,
      orderId: merchantPaymentId,
      codeId: result.data?.codeId ?? null,
      amount: totalFee,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[paypay] createQR error:", errMsg);
    return NextResponse.json(
      { error: "Payment Gateway Error", message: "Failed to create PayPay payment. Please try again." },
      { status: 502 },
    );
  }
}
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `npx tsc --noEmit 2>&1 | grep -i paypay`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/app/api/public/payments/paypay/route.ts
git commit -m "feat(paypay): add payment creation API route"
```

---

### Task 5: Status Polling API Route

**Files:**
- Create: `src/app/api/public/payments/paypay/status/route.ts`
- Reference: `src/app/api/public/payments/abank/status/route.ts` (pattern)

- [ ] **Step 1: Create the PayPay status polling route**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import paypay from "@/lib/paypay";
import { sendPaymentNotifications } from "@/lib/payment-notifications";

// ─── GET /api/public/payments/paypay/status?ref=PY-xxx ──────────────────────
// Polls PayPay API and updates local payment record.
// Returns: { paypay_status: "CREATED" | "COMPLETED" | "EXPIRED" | "CANCELED" | "FAILED" }

export async function GET(request: NextRequest) {
  const paymentRef = request.nextUrl.searchParams.get("ref");
  if (!paymentRef) {
    return NextResponse.json(
      { error: "Bad Request", message: "ref is required." },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  // Check local DB first — if already finalized, skip API call
  const { data: payment } = (await supabase
    .from("payments")
    .select("id, enrollment_id, amount, paypay_status, status")
    .eq("payment_ref", paymentRef)
    .single()) as {
    data: { id: string; enrollment_id: string; amount: number; paypay_status: string; status: string } | null;
    error: unknown;
  };

  if (!payment) {
    return NextResponse.json({ paypay_status: "CREATED" });
  }

  // Already finalized locally
  if (payment.paypay_status === "COMPLETED" || payment.status === "verified") {
    return NextResponse.json({ paypay_status: "COMPLETED" });
  }
  if (payment.paypay_status === "FAILED" || payment.paypay_status === "CANCELED") {
    return NextResponse.json({ paypay_status: payment.paypay_status });
  }
  if (payment.paypay_status === "EXPIRED") {
    return NextResponse.json({ paypay_status: "EXPIRED" });
  }

  // Poll PayPay API
  try {
    const result = await paypay.getPaymentStatus(paymentRef);
    const status = result.data?.status ?? "CREATED";

    if (status === "COMPLETED") {
      // Update payment + enrollment
      await supabase
        .from("payments")
        .update({
          paypay_status: "COMPLETED",
          status: "verified",
          paid_at: new Date().toISOString(),
          bank_reference: result.data?.paymentId ?? null,
          received_amount: payment.amount,
        } as never)
        .eq("id", payment.id);

      await supabase
        .from("enrollments")
        .update({ status: "confirmed" } as never)
        .eq("id", payment.enrollment_id);

      // Send notifications
      await sendPaymentNotifications(supabase, payment, request);
    } else if (status === "FAILED") {
      await supabase
        .from("payments")
        .update({ paypay_status: "FAILED" } as never)
        .eq("id", payment.id);
    } else if (status === "EXPIRED") {
      await supabase
        .from("payments")
        .update({ paypay_status: "EXPIRED" } as never)
        .eq("id", payment.id);
    } else if (status === "CANCELED") {
      await supabase
        .from("payments")
        .update({ paypay_status: "CANCELED", status: "rejected" } as never)
        .eq("id", payment.id);
    }

    return NextResponse.json({ paypay_status: status });
  } catch (err) {
    console.error("[paypay-status] poll error:", err);
    return NextResponse.json({ paypay_status: payment.paypay_status ?? "CREATED" });
  }
}
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `npx tsc --noEmit 2>&1 | grep -i paypay`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/app/api/public/payments/paypay/status/route.ts
git commit -m "feat(paypay): add payment status polling route"
```

---

### Task 6: Webhook API Route

**Files:**
- Create: `src/app/api/public/payments/paypay/webhook/route.ts`
- Reference: `src/app/api/public/payments/mmpay/webhook/route.ts` (pattern)

- [ ] **Step 1: Create the PayPay webhook route**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import paypay from "@/lib/paypay";
import { sendPaymentNotifications } from "@/lib/payment-notifications";

// ─── POST /api/public/payments/paypay/webhook ───────────────────────────────
// PayPay transaction webhook handler.
// Verifies webhook signature, then updates payment + enrollment status.

export async function POST(request: NextRequest) {
  // ── 1. Read headers and body ─────────────────────────────────
  const signature = request.headers.get("x-paypay-signature") ?? "";
  const bodyText = await request.text();

  // ── 2. Verify webhook signature ──────────────────────────────
  // Note: If PayPay uses a different header name for the signature,
  // update the header key above. Check PayPay webhook docs for exact header.
  if (signature) {
    try {
      const isValid = paypay.verifyWebhook(bodyText, signature);
      if (!isValid) {
        console.warn("[paypay-webhook] Invalid signature");
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    } catch {
      console.warn("[paypay-webhook] Signature verification error");
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else {
    // If no signature header present, log warning but still process
    // (PayPay sandbox may not send signatures — remove this fallback in production)
    console.warn("[paypay-webhook] No signature header — processing anyway (sandbox mode?)");
  }

  // ── 3. Parse webhook payload ─────────────────────────────────
  let data: ReturnType<typeof paypay.parseWebhookPayload>["data"];
  try {
    const parsed = paypay.parseWebhookPayload(bodyText);
    data = parsed.data;
  } catch {
    console.warn("[paypay-webhook] Failed to parse payload");
    return NextResponse.json({ error: "Bad Request" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // ── 4. Find payment by merchantPaymentId ─────────────────────
  const { data: payment } = (await supabase
    .from("payments")
    .select("id, enrollment_id, amount, status")
    .eq("payment_ref", data.merchantPaymentId)
    .single()) as {
    data: { id: string; enrollment_id: string; amount: number; status: string } | null;
    error: unknown;
  };

  if (!payment) {
    console.warn("[paypay-webhook] Payment not found for merchantPaymentId:", data.merchantPaymentId);
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }

  // Skip if already finalized (idempotent)
  if (payment.status === "verified" || payment.status === "rejected") {
    return NextResponse.json({ message: "Already processed" }, { status: 200 });
  }

  // ── 5. Update based on state ─────────────────────────────────
  if (data.state === "COMPLETED") {
    await supabase
      .from("payments")
      .update({
        paypay_status: "COMPLETED",
        status: "verified",
        paid_at: new Date().toISOString(),
        bank_reference: data.paymentId,
        received_amount: payment.amount,
      } as never)
      .eq("id", payment.id);

    await supabase
      .from("enrollments")
      .update({ status: "confirmed" } as never)
      .eq("id", payment.enrollment_id);

    // Send notifications
    await sendPaymentNotifications(supabase, payment, request);
  } else if (data.state === "FAILED") {
    await supabase
      .from("payments")
      .update({ paypay_status: "FAILED" } as never)
      .eq("id", payment.id);
  } else if (data.state === "CANCELED") {
    await supabase
      .from("payments")
      .update({ paypay_status: "CANCELED", status: "rejected" } as never)
      .eq("id", payment.id);
  } else if (data.state === "EXPIRED") {
    await supabase
      .from("payments")
      .update({ paypay_status: "EXPIRED" } as never)
      .eq("id", payment.id);
  }

  // PayPay expects 200 OK response
  return NextResponse.json({ message: "OK" }, { status: 200 });
}
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `npx tsc --noEmit 2>&1 | grep -i paypay`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/app/api/public/payments/paypay/webhook/route.ts
git commit -m "feat(paypay): add webhook handler with signature verification"
```

---

### Task 7: Update QRPaymentModal for PayPay

**Files:**
- Modify: `src/components/payments/QRPaymentModal.tsx`

PayPay returns a **payment URL** (not an EMVCo QR string like ABank/MyanMyanPay). We generate a QR code from that URL and also provide a direct "Open PayPay" link for mobile users.

- [ ] **Step 1: Update QRProvider type**

Change the `QRProvider` type definition (search for `type QRProvider`):

```typescript
type QRProvider = "mmpay" | "abank" | "paypay";
```

- [ ] **Step 2: Update apiBase routing**

Replace the existing `apiBase` assignment (search for `const apiBase`):

```typescript
const apiBase =
  provider === "abank" ? "/api/public/payments/abank"
  : provider === "paypay" ? "/api/public/payments/paypay"
  : "/api/public/payments/mmpay";
```

- [ ] **Step 3: Update createPayment to handle PayPay URL response**

In the `createPayment` async function inside the `useEffect` (search for `async function createPayment`), after `const data = await res.json()`, update the QR generation logic:

```typescript
const data = await res.json();
console.log("[QRPaymentModal] API response:", data);

// PayPay returns a URL, MMQR returns a QR string
const qrSource = data.qr ?? data.url;
setQrData(qrSource);
setOrderId(data.orderId);

// Generate QR image from either EMVCo string or PayPay URL
if (qrSource) {
  try {
    const dataUrl = await QRCode.toDataURL(qrSource, { width: 280, margin: 2 });
    setQrImageUrl(dataUrl);
  } catch {
    console.error("[QRPaymentModal] QR render failed");
  }
}

// Store PayPay URL and deeplink for direct-open button
if (data.url) setPaypayUrl(data.url);
if (data.deeplink) setPaypayDeeplink(data.deeplink);

setState("qr");
startPolling(data.orderId);
```

Add state variables at the top of the component (after other `useState` calls):

```typescript
const [paypayUrl, setPaypayUrl] = useState<string | null>(null);
const [paypayDeeplink, setPaypayDeeplink] = useState<string | null>(null);
```

- [ ] **Step 4: Update handleRetry with same QR logic**

In `handleRetry` (search for `function handleRetry`), apply the same qrSource logic:

```typescript
const data = await res.json();
const qrSource = data.qr ?? data.url;
setQrData(qrSource);
setOrderId(data.orderId);
if (qrSource) {
  try {
    const dataUrl = await QRCode.toDataURL(qrSource, { width: 280, margin: 2 });
    setQrImageUrl(dataUrl);
  } catch {
    console.error("[QRPaymentModal] QR render failed");
  }
}
if (data.url) setPaypayUrl(data.url);
if (data.deeplink) setPaypayDeeplink(data.deeplink);
setState("qr");
startPolling(data.orderId);
```

- [ ] **Step 5: Update polling status check**

In the `pollFn` callback inside `startPolling` (search for `const pollFn`), update the status check to handle both MMQR and PayPay response keys:

```typescript
const pollFn = async () => {
  try {
    const res = await fetch(
      `${apiBase}/status?ref=${encodeURIComponent(paymentRef)}`,
    );
    if (!res.ok) return;
    const data = await res.json();

    // PayPay returns paypay_status, MMQR returns mmqr_status
    const status = data.paypay_status ?? data.mmqr_status;

    if (status === "SUCCESS" || status === "COMPLETED") {
      if (pollRef.current) clearInterval(pollRef.current);
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
      setState("success");
      onSuccess();
    } else if (status === "FAILED" || status === "CANCELED" || status === "EXPIRED") {
      if (pollRef.current) clearInterval(pollRef.current);
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
      setState("error");
      setErrorMsg(
        status === "EXPIRED"
          ? "Payment has expired. Please try again."
          : "Payment was declined. Please try again.",
      );
    }
  } catch {
    // Ignore polling errors — will retry next interval
  }
};
```

- [ ] **Step 6: Update QR state UI for PayPay branding**

In the `{state === "qr" && (...)}` JSX section (search for `{state === "qr"`), replace the logo and header to be provider-aware:

```tsx
{/* Header — provider-specific branding */}
{provider === "paypay" ? (
  <>
    <div className="mb-2 flex h-14 items-center justify-center">
      <span className="text-3xl font-bold text-[#ff0033]">PayPay</span>
    </div>
    <h3 className="text-lg font-semibold text-gray-900">Pay with PayPay</h3>
  </>
) : (
  <>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src="/mmqr-logo.png" alt="MyanmarPay MMQR" className="mb-2 h-14 w-auto" />
    <h3 className="text-lg font-semibold text-gray-900">Pay with MMQR</h3>
    <p className="font-myanmar mt-0.5 text-sm text-gray-500">MMQR ဖြင့် ငွေပေးချေပါ</p>
  </>
)}
```

After the QR image and save button, add an "Open PayPay" button for mobile (only shown for PayPay provider):

```tsx
{/* Open in PayPay app (mobile) */}
{provider === "paypay" && paypayUrl && (
  <a
    href={paypayDeeplink || paypayUrl}
    target="_blank"
    rel="noopener noreferrer"
    className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-[#ff0033] px-4 py-3 text-sm font-semibold text-white hover:bg-[#e6002e] transition-colors"
  >
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
    Open in PayPay App
  </a>
)}
```

Update the instructions banner to be provider-aware (search for `Scan with`):

```tsx
{provider === "paypay" ? (
  <div className="mt-4 w-full rounded-lg bg-red-50 border border-red-200 px-4 py-3">
    <div className="flex items-start gap-2">
      <svg className="mt-0.5 h-4 w-4 shrink-0 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
      </svg>
      <div>
        <p className="text-xs font-medium text-red-800">
          Scan with the <span className="font-semibold">PayPay</span> app, or tap "Open in PayPay App" below
        </p>
      </div>
    </div>
  </div>
) : (
  /* existing MMQR instructions banner */
  <div className="mt-4 w-full rounded-lg bg-blue-50 border border-blue-200 px-4 py-3">
    ...existing content...
  </div>
)}
```

- [ ] **Step 7: Test visually**

Run: `npm run dev` and navigate to payment page.
Verify: QR modal renders correctly for `provider="paypay"` (can test by temporarily hardcoding in the payment page).

- [ ] **Step 8: Commit**

```bash
git add src/components/payments/QRPaymentModal.tsx
git commit -m "feat(paypay): add PayPay provider support to QRPaymentModal"
```

---

### Task 8: Update Payment Page for PayPay

**Files:**
- Modify: `src/app/(public)/enroll/payment/[ref]/page.tsx`

- [ ] **Step 1: Add PayPay to EnrollmentInfo type**

Find the `payment_mode` property in the `EnrollmentInfo` interface (search for `payment_mode?:`) and extend it:

```typescript
payment_mode?: "bank_transfer" | "mmqr" | "stripe" | "paypay";
```

- [ ] **Step 2: Add PayPay payment section**

After the Stripe payment section (search for `{/* ── Pay via Stripe */}` closing `</div>`) and before the MMQR section (search for `{/* ── Pay via MMQR */}`), add:

```tsx
{/* ── Pay via PayPay ──────────────────────────────────── */}
{showUpload && paymentMode === "paypay" && (
  <div className={`mb-6 rounded-xl border-2 p-5 text-center shadow-sm ${
    timerExpired
      ? "border-gray-300 bg-gray-400"
      : "border-[#ff0033] bg-[#ff0033]"
  }`}>
    <p className="text-sm text-white/80">
      {timerExpired
        ? "Payment time has expired"
        : "Pay to complete your enrollment"}
    </p>
    <p className="mt-1 text-3xl font-bold font-mono text-white">
      {isPartialReUpload && enrollment.payment?.remaining_amount
        ? formatCurrencySimple(enrollment.payment.remaining_amount, currency)
        : formatCurrencySimple(totalFee, currency)}
    </p>
    <button
      onClick={() => setShowQRModal(true)}
      disabled={timerExpired}
      className={`mt-4 flex w-full items-center justify-center gap-3 rounded-lg py-3.5 text-base font-semibold transition-colors ${
        timerExpired
          ? "bg-white/50 text-gray-400 cursor-not-allowed"
          : "bg-white text-[#ff0033] hover:bg-white/90"
      }`}
    >
      <span className="text-xl font-bold">PayPay</span>
      <div>
        <span className="block">{timerExpired ? "Payment Expired" : "Pay with PayPay"}</span>
      </div>
    </button>
    {timerExpired && enrollment.intake_slug && (
      <div className="mt-4 rounded-lg bg-white/20 px-4 py-3">
        <p className="text-sm text-white">
          Your spot has been released. Enroll again to secure a new one.
        </p>
        <a
          href={`/enroll/${encodeURIComponent(enrollment.intake_slug)}`}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-white py-3 text-sm font-semibold text-[#1a6b3c] hover:bg-white/90 transition-colors"
        >
          Enroll Again
        </a>
      </div>
    )}
  </div>
)}
```

- [ ] **Step 3: Update QRPaymentModal invocation**

Find the `<QRPaymentModal` component (search for `<QRPaymentModal`). Update the `provider` prop:

```tsx
{showQRModal && enrollment && (
  <QRPaymentModal
    enrollmentRef={enrollment.enrollment_ref}
    amount={isPartialReUpload && enrollment.payment?.remaining_amount
      ? enrollment.payment.remaining_amount
      : totalFee}
    currency={currency}
    studentName={enrollment.student_name_en}
    provider={paymentMode === "paypay" ? "paypay" : mmqrProvider}
    onSuccess={() => {
      setShowQRModal(false);
      handleUploadSuccess();
    }}
    onClose={() => setShowQRModal(false)}
  />
)}
```

- [ ] **Step 4: Add PayPay auto-open polling for redirect returns**

Find the Stripe redirect handling block (search for `const stripeParam`). Add PayPay redirect handling nearby:

```typescript
const paypayParam = params_.get("paypay");
if (paypayParam === "success") {
  // PayPay redirected back after payment — the page's enrollment status
  // polling will detect the status change (confirmed) automatically.
  // No extra action needed here.
}
```

- [ ] **Step 5: Update page-level polling for PayPay mode**

Find the page-level polling useEffect (search for `const isMMQR = enrollment?.payment_mode === "mmqr"`). Add PayPay to the condition:

```typescript
const isMMQR = enrollment?.payment_mode === "mmqr";
const isPayPay = enrollment?.payment_mode === "paypay";

if ((isMMQR || isPayPay) && isPending && !showQRModal) {
```

- [ ] **Step 6: Test visually**

Run: `npm run dev` and verify:
- PayPay button shows when `payment_mode === "paypay"`
- QRPaymentModal opens with PayPay provider
- Stripe/MMQR/bank_transfer modes still work

- [ ] **Step 7: Commit**

```bash
git add "src/app/(public)/enroll/payment/[ref]/page.tsx"
git commit -m "feat(paypay): add PayPay payment option to enrollment payment page"
```

---

### Task 9: Verify Public Status API

**Files:**
- Check: `src/app/api/public/status/route.ts`

- [ ] **Step 1: Verify payment_mode flows correctly**

Since `payment_mode` is a free-text `TEXT` column (not an enum), setting it to `"paypay"` in the tenant's DB row should automatically flow through to the client. Verify this:

Run: `grep -n "payment_mode" src/app/api/public/status/route.ts`

If already included in the tenant select query, no code change needed. If not, add `payment_mode` to the select list.

- [ ] **Step 2: Check admin settings page**

Run: `grep -rn "payment_mode" src/app/admin/settings/`

Verify that the admin settings UI allows selecting payment mode. If it currently only shows `bank_transfer | mmqr | stripe`, add `paypay` as an option in the dropdown.

- [ ] **Step 3: Commit (if changes needed)**

```bash
git add src/app/api/public/status/route.ts src/app/admin/settings/
git commit -m "feat(paypay): add paypay option to admin settings and status API"
```

---

### Task 10: Environment Variables

**Files:**
- Modify: `.env.local` (add dev/sandbox keys)

- [ ] **Step 1: Add PayPay env vars to `.env.local`**

```
# PayPay (sandbox)
PAYPAY_API_KEY=
PAYPAY_API_SECRET=
PAYPAY_MERCHANT_ID=
PAYPAY_WEBHOOK_SECRET=
PAYPAY_MODE=sandbox
```

Note: Actual sandbox credentials must be obtained from PayPay developer portal at https://developer.paypay.ne.jp. Leave blank until merchant account is set up.

- [ ] **Step 2: Document for production**

Production env vars to be added to Vercel dashboard:
- `PAYPAY_API_KEY` — production API key
- `PAYPAY_API_SECRET` — production API secret
- `PAYPAY_MERCHANT_ID` — production merchant ID
- `PAYPAY_WEBHOOK_SECRET` — webhook verification secret
- `PAYPAY_MODE` — set to `production`

PayPay webhook URL to register in PayPay merchant dashboard:
`https://<domain>/api/public/payments/paypay/webhook`

- [ ] **Step 3: Commit (env.local changes only — no secrets)**

```bash
git add .env.local
git commit -m "feat(paypay): add PayPay env var placeholders"
```

---

### Task 11: Build Verification & Final Test

- [ ] **Step 1: Run full build**

Run: `npm run build`
Expected: Build succeeds with no TypeScript errors

- [ ] **Step 2: Verify all payment modes still work**

Manual checklist:
- [ ] `payment_mode=bank_transfer` — receipt upload flow works
- [ ] `payment_mode=mmqr` — QR modal opens, polls correctly
- [ ] `payment_mode=stripe` — redirects to Stripe checkout
- [ ] `payment_mode=paypay` — PayPay button shows, QR modal opens with PayPay branding

- [ ] **Step 3: Set a test tenant to `payment_mode=paypay`**

```sql
UPDATE tenants SET payment_mode = 'paypay', currency = 'JPY' WHERE slug = 'your-test-tenant';
```

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(paypay): address build/integration issues"
```

---

## Summary of env vars needed

| Variable | Dev value | Prod value |
|----------|-----------|------------|
| `PAYPAY_API_KEY` | From PayPay sandbox | From PayPay production |
| `PAYPAY_API_SECRET` | From PayPay sandbox | From PayPay production |
| `PAYPAY_MERCHANT_ID` | From PayPay sandbox | From PayPay production |
| `PAYPAY_WEBHOOK_SECRET` | From PayPay sandbox | From PayPay production |
| `PAYPAY_MODE` | `sandbox` | `production` |

## Key differences from ABank/MyanMyanPay

1. **No EMVCo QR string** — PayPay returns a payment URL; we generate a QR from that URL
2. **Currency is JPY** — integer amounts, no decimals
3. **HMAC auth** — full `hmac OPA-Auth:{key}:{sig}:{nonce}:{epoch}:{md5}` format (not simple secretKey header)
4. **Webhook format** — nested JSON (`notification_data` is a JSON string inside the webhook body)
5. **Redirect-based flow** — PayPay redirects back to merchant site after payment (like Stripe)
6. **Mobile deeplink** — PayPay provides an app deeplink for direct mobile opening
