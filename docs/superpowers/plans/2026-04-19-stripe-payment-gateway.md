# Stripe Payment Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Stripe Checkout Sessions as a tenant-level payment option with auto-confirmation via webhooks.

**Architecture:** Extend the existing `payment_mode` toggle to include `'stripe'`. New API route creates Stripe Checkout Sessions with dynamic `price_data`. A webhook handler auto-confirms enrollment on successful payment. Frontend shows a "Pay with Card" button for Stripe tenants.

**Tech Stack:** Next.js 14 App Router, Stripe Node SDK, Supabase (PostgreSQL), TypeScript, Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-04-19-stripe-payment-gateway-design.md`

---

### Task 1: Install Stripe SDK & Add Environment Variables

**Files:**
- Modify: `package.json`
- Modify: `.env.local.example`

- [ ] **Step 1: Install stripe package**

Run: `npm install stripe`

- [ ] **Step 2: Add env var placeholders to `.env.local.example`**

Add these lines to the end of `.env.local.example`:

```
# ── Stripe (card payments) ─────────────────────────────────────────
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

- [ ] **Step 3: Add actual test keys to `.env.local`**

Add the real `sk_test_`, `pk_test_`, and `whsec_` values to `.env.local` (gitignored).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json .env.local.example
git commit -m "feat: install stripe SDK and add env var placeholders"
```

---

### Task 2: Database Migration — Stripe Payment Columns

**Files:**
- Create: `supabase/migrations/072_stripe_payment_fields.sql`

- [ ] **Step 1: Create migration file**

```sql
-- ─── Migration 072: Stripe payment fields ──────────────────────────────────────
-- Adds Stripe session tracking columns to payments table.
-- Extends payment_mode to support 'stripe'.

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS stripe_session_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;

CREATE INDEX IF NOT EXISTS idx_payments_stripe_session
  ON public.payments (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;

COMMENT ON COLUMN public.tenants.payment_mode IS 'bank_transfer | mmqr | stripe';
COMMENT ON COLUMN public.payments.stripe_session_id IS 'Stripe Checkout Session ID';
COMMENT ON COLUMN public.payments.stripe_payment_intent_id IS 'Stripe Payment Intent ID (set by webhook)';
```

- [ ] **Step 2: Apply migration to dev DB**

Run: `npx supabase db push`

Verify the columns exist:
```bash
npx supabase db diff
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/072_stripe_payment_fields.sql
git commit -m "feat: add stripe_session_id and stripe_payment_intent_id columns"
```

---

### Task 3: Update TypeScript Types

**Files:**
- Modify: `src/types/database.ts` (lines 120-121, 226-241)

- [ ] **Step 1: Update `Tenant.payment_mode` union type**

In `src/types/database.ts`, line 120, change:

```typescript
payment_mode: "bank_transfer" | "mmqr";
```

to:

```typescript
payment_mode: "bank_transfer" | "mmqr" | "stripe";
```

- [ ] **Step 2: Add Stripe fields to `Payment` interface**

In `src/types/database.ts`, after `received_amount_mmk` (line 235), add:

```typescript
payment_method: string | null;        // 'manual_upload' | 'abank_mmqr' | 'mmqr' | 'stripe'
payment_ref: string | null;
mmqr_status: string | null;
paid_at: string | null;
stripe_session_id: string | null;
stripe_payment_intent_id: string | null;
```

- [ ] **Step 3: Verify build compiles**

Run: `npm run build`

- [ ] **Step 4: Commit**

```bash
git add src/types/database.ts
git commit -m "feat: update TypeScript types for Stripe payment fields"
```

---

### Task 4: Create Stripe Client Library

**Files:**
- Create: `src/lib/stripe.ts`

- [ ] **Step 1: Create the Stripe client module**

```typescript
import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY is not set");
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2025-03-31.basil",
  typescript: true,
});
```

Note: Omit `apiVersion` to use the SDK's bundled default, or check the installed version with `import Stripe from "stripe"; console.log(Stripe.LATEST_API_VERSION)`.

- [ ] **Step 2: Commit**

```bash
git add src/lib/stripe.ts
git commit -m "feat: add Stripe client library"
```

---

### Task 5: Create Stripe Checkout Session API Route

**Files:**
- Create: `src/app/api/public/payments/stripe/route.ts`

Reference the existing ABank route pattern at `src/app/api/public/payments/abank/route.ts`.

- [ ] **Step 1: Create the route file**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import { stripe } from "@/lib/stripe";

// ─── POST /api/public/payments/stripe ─────────────────────────────────────────
// Creates a Stripe Checkout Session and returns the URL.
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
    .select("*, classes(id, fee_mmk, level, intakes(name, slug)), enrollment_items(class_id, quantity, fee_mmk, classes(level))")
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
      classes: { id: string; fee_mmk: number; level: string; intakes: { name: string; slug: string } | null } | null;
      enrollment_items: { class_id: string; quantity: number; fee_mmk: number; classes: { level: string } | null }[] | null;
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

  // ── 4. Check for existing awaiting_payment Stripe session ──
  const { data: existingPayment } = (await supabase
    .from("payments")
    .select("stripe_session_id")
    .eq("enrollment_id", enrollment.id)
    .eq("payment_method", "stripe")
    .eq("status", "awaiting_payment")
    .order("created_at", { ascending: false })
    .limit(1)
    .single()) as { data: { stripe_session_id: string | null } | null; error: unknown };

  if (existingPayment?.stripe_session_id) {
    try {
      const existingSession = await stripe.checkout.sessions.retrieve(existingPayment.stripe_session_id);
      if (existingSession.status === "open" && existingSession.url) {
        return NextResponse.json({ url: existingSession.url });
      }
    } catch {
      // Session expired or invalid — continue to create new one
    }
  }

  // ── 5. Fetch tenant currency ───────────────────────────────
  const { data: tenant } = (await supabase
    .from("tenants")
    .select("currency, name")
    .eq("id", tenantId)
    .single()) as { data: { currency: string; name: string } | null; error: unknown };

  const currency = (tenant?.currency ?? "MMK").toLowerCase();

  // Stripe is for non-MMK tenants (SGD, USD, etc.).
  // MMK is a zero-decimal currency — multiplying by 100 would overcharge.
  if (currency === "mmk") {
    return NextResponse.json(
      { error: "Bad Request", message: "Stripe is not available for MMK currency. Use bank transfer or MMQR." },
      { status: 400 },
    );
  }

  // ── 6. Calculate total fee & build line items ──────────────
  const isCart =
    !enrollment.class_id &&
    enrollment.enrollment_items &&
    enrollment.enrollment_items.length > 0;

  let totalFee: number;
  let lineItems: { price_data: { currency: string; unit_amount: number; product_data: { name: string } }; quantity: number }[];

  if (isCart) {
    lineItems = enrollment.enrollment_items!.map((item) => ({
      price_data: {
        currency,
        unit_amount: item.fee_mmk * 100, // convert to smallest unit (cents)
        product_data: {
          name: item.classes?.level ?? "Class",
        },
      },
      quantity: item.quantity,
    }));
    totalFee = enrollment.enrollment_items!.reduce(
      (sum, item) => sum + item.fee_mmk * item.quantity,
      0,
    );
  } else if (enrollment.classes) {
    const qty = enrollment.quantity ?? 1;
    totalFee = enrollment.classes.fee_mmk * qty;
    lineItems = [
      {
        price_data: {
          currency,
          unit_amount: enrollment.classes.fee_mmk * 100,
          product_data: {
            name: `${enrollment.classes.level}${enrollment.classes.intakes ? ` — ${enrollment.classes.intakes.name}` : ""}`,
          },
        },
        quantity: qty,
      },
    ];
  } else {
    return NextResponse.json(
      { error: "Internal Server Error", message: "Class data not found." },
      { status: 500 },
    );
  }

  // ── 7. Adjust for partial payment ──────────────────────────
  if (enrollment.status === "partial_payment") {
    const { data: prevPayment } = (await supabase
      .from("payments")
      .select("received_amount_mmk")
      .eq("enrollment_id", enrollment.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single()) as { data: { received_amount_mmk: number | null } | null; error: unknown };

    if (prevPayment?.received_amount_mmk) {
      const remaining = totalFee - prevPayment.received_amount_mmk;
      totalFee = remaining;
      // Replace line items with single remaining balance item
      lineItems = [
        {
          price_data: {
            currency,
            unit_amount: remaining * 100,
            product_data: {
              name: "Remaining Balance",
            },
          },
          quantity: 1,
        },
      ];
    }
  }

  // ── 8. Build URLs ──────────────────────────────────────────
  const host = request.headers.get("host") ?? "localhost:3005";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const baseUrl = `${proto}://${host}`;

  try {
    // ── 9. Create Stripe Checkout Session ─────────────────────
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      success_url: `${baseUrl}/enroll/payment/${enrollment.enrollment_ref}?stripe=success`,
      cancel_url: `${baseUrl}/enroll/payment/${enrollment.enrollment_ref}?stripe=cancelled`,
      metadata: {
        tenant_id: enrollment.tenant_id,
        enrollment_id: enrollment.id,
        enrollment_ref: enrollment.enrollment_ref,
      },
    });

    // ── 10. Create payment record ────────────────────────────
    await supabase.from("payments").insert({
      enrollment_id: enrollment.id,
      tenant_id: enrollment.tenant_id,
      amount_mmk: totalFee,
      payment_method: "stripe",
      status: "awaiting_payment",
      stripe_session_id: session.id,
    } as never);

    return NextResponse.json({ url: session.url });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[stripe] createCheckoutSession error:", errMsg);
    return NextResponse.json(
      { error: "Payment Gateway Error", message: "Failed to create payment session. Please try again." },
      { status: 502 },
    );
  }
}
```

- [ ] **Step 2: Verify build compiles**

Run: `npm run build`

- [ ] **Step 3: Commit**

```bash
git add src/app/api/public/payments/stripe/route.ts
git commit -m "feat: add Stripe Checkout Session creation API route"
```

---

### Task 6: Update Middleware — Skip Tenant Detection for Stripe Webhook

**Files:**
- Modify: `src/middleware.ts` (line 7)

Stripe sends webhook requests from its own servers with no subdomain, cookies, or tenant context. The middleware must skip tenant detection for `/api/stripe/` routes.

- [ ] **Step 1: Add `/api/stripe/` to skip list**

In `src/middleware.ts`, line 7, change:

```typescript
const SKIP_TENANT_PREFIXES = ["/register", "/api/saas/", "/api/messenger/", "/superadmin", "/onboarding"];
```

to:

```typescript
const SKIP_TENANT_PREFIXES = ["/register", "/api/saas/", "/api/messenger/", "/api/stripe/", "/superadmin", "/onboarding"];
```

- [ ] **Step 2: Commit**

```bash
git add src/middleware.ts
git commit -m "feat: skip tenant detection for Stripe webhook routes"
```

---

### Task 7: Create Stripe Webhook Handler

**Files:**
- Create: `src/app/api/stripe/webhook/route.ts`

Reference the notification pattern from `src/app/api/public/payments/abank/callback/route.ts`.

- [ ] **Step 1: Create the webhook route**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { stripe } from "@/lib/stripe";
import { sendEmail, enrollmentApprovedEmail } from "@/lib/email";
import { sendTelegramStatusNotification } from "@/lib/telegram/notify";
import { sendChannelInviteIfEligible } from "@/lib/telegram/channel-invite";
import { resolveEmailFromFormData } from "@/lib/utils";
import type Stripe from "stripe";

// ─── POST /api/stripe/webhook ─────────────────────────────────────────────────
// Handles Stripe webhook events. Verifies signature, auto-confirms enrollment.
// IMPORTANT: Use request.text() (not request.json()) to get the raw body —
// Stripe signature verification requires the unmodified body string.

export async function POST(request: NextRequest) {
  const body = await request.text();
  const sig = request.headers.get("stripe-signature");

  if (!sig) {
    return NextResponse.json({ error: "Missing stripe-signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );
  } catch (err) {
    console.error("[stripe-webhook] Signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // ── Handle checkout.session.completed ───────────────────────
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    // Find payment by stripe_session_id
    const { data: payment } = (await supabase
      .from("payments")
      .select("id, enrollment_id, status")
      .eq("stripe_session_id", session.id)
      .single()) as {
      data: { id: string; enrollment_id: string; status: string } | null;
      error: unknown;
    };

    if (!payment) {
      console.warn("[stripe-webhook] Payment not found for session:", session.id);
      return NextResponse.json({ received: true });
    }

    // Idempotency: skip if already verified
    if (payment.status === "verified") {
      return NextResponse.json({ received: true });
    }

    // Update payment
    await supabase
      .from("payments")
      .update({
        status: "verified",
        stripe_payment_intent_id: session.payment_intent as string,
        paid_at: new Date().toISOString(),
      } as never)
      .eq("id", payment.id);

    // Update enrollment
    await supabase
      .from("enrollments")
      .update({ status: "confirmed" } as never)
      .eq("id", payment.enrollment_id);

    // ── Send notifications (copied from abank callback pattern) ──
    const { data: enrollment } = (await supabase
      .from("enrollments")
      .select("tenant_id, telegram_chat_id, email, enrollment_ref, student_name_en, class_id, quantity, form_data")
      .eq("id", payment.enrollment_id)
      .single()) as {
      data: {
        tenant_id: string;
        telegram_chat_id: string | null;
        email: string | null;
        enrollment_ref: string;
        student_name_en: string;
        class_id: string | null;
        quantity: number | null;
        form_data: Record<string, string> | null;
      } | null;
      error: unknown;
    };

    if (enrollment) {
      const enrollEmail = enrollment.email
        || resolveEmailFromFormData(enrollment.form_data as Record<string, string> | null);
      const host = request.headers.get("host") ?? "localhost:3005";
      const proto = host.startsWith("localhost") ? "http" : "https";
      const statusUrl = `${proto}://${host}/status?ref=${enrollment.enrollment_ref}`;

      // Resolve class level
      let classLevel = "Class";
      let feeFormatted: string | undefined;
      const isCart = enrollment.class_id === null;

      if (isCart) {
        const { data: items } = (await supabase
          .from("enrollment_items")
          .select("quantity, fee_mmk, classes(level)")
          .eq("enrollment_id", payment.enrollment_id)) as {
          data: { quantity: number; fee_mmk: number; classes: { level: string } | null }[] | null;
          error: unknown;
        };
        if (items && items.length > 0) {
          classLevel = items
            .map((i) => (i.quantity > 1 ? `${i.classes?.level ?? "?"} x${i.quantity}` : (i.classes?.level ?? "?")))
            .join(", ");
          const total = items.reduce((s, i) => s + i.fee_mmk * i.quantity, 0);
          feeFormatted = `${String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
        }
      } else {
        const { data: cls } = (await supabase
          .from("classes")
          .select("level, fee_mmk")
          .eq("id", enrollment.class_id!)
          .single()) as { data: { level: string; fee_mmk: number } | null; error: unknown };
        if (cls) {
          classLevel = cls.level;
          const total = cls.fee_mmk * (enrollment.quantity ?? 1);
          feeFormatted = `${String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
        }
      }

      // Fetch tenant info
      const { data: tenantInfo } = (await supabase
        .from("tenants")
        .select("name, org_type, logo_url, currency")
        .eq("id", enrollment.tenant_id)
        .single()) as {
        data: { name: string; org_type: string; logo_url: string | null; currency: string } | null;
        error: unknown;
      };

      // Append currency to fee
      if (feeFormatted && tenantInfo?.currency) {
        feeFormatted = `${feeFormatted} ${tenantInfo.currency}`;
      }

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
          }).catch((err) => {
            console.error("[stripe-webhook] Telegram notification failed:", err);
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
            console.error("[stripe-webhook] Approval email failed:", err);
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
            console.error("[stripe-webhook] Channel invite failed:", err);
          }),
        );
      }

      await Promise.allSettled(notifyTasks);
    }
  }

  // ── Handle checkout.session.expired ─────────────────────────
  if (event.type === "checkout.session.expired") {
    const session = event.data.object as Stripe.Checkout.Session;

    await supabase
      .from("payments")
      .update({ status: "rejected" } as never)
      .eq("stripe_session_id", session.id)
      .eq("status", "awaiting_payment");
  }

  return NextResponse.json({ received: true });
}
```

- [ ] **Step 2: Verify build compiles**

Run: `npm run build`

- [ ] **Step 3: Commit**

```bash
git add src/app/api/stripe/webhook/route.ts
git commit -m "feat: add Stripe webhook handler with auto-confirmation"
```

---

### Task 8: Update Admin Settings — Payment Mode UI

**Files:**
- Modify: `src/app/admin/settings/page.tsx`

- [ ] **Step 1: Update payment mode state type**

Line 520, change:

```typescript
const [paymentMode, setPaymentMode] = useState<"bank_transfer" | "mmqr">("bank_transfer");
```

to:

```typescript
const [paymentMode, setPaymentMode] = useState<"bank_transfer" | "mmqr" | "stripe">("bank_transfer");
```

- [ ] **Step 2: Update the cast on load**

Line 578, change:

```typescript
setPaymentMode((tenant.payment_mode as "bank_transfer" | "mmqr") ?? "bank_transfer");
```

to:

```typescript
setPaymentMode((tenant.payment_mode as "bank_transfer" | "mmqr" | "stripe") ?? "bank_transfer");
```

- [ ] **Step 3: Add Stripe button to payment mode selector**

After the MMQR button block (after the closing `</button>` around line 1237), add:

```tsx
<button
  onClick={() => setPaymentMode("stripe")}
  className={`flex-1 rounded-xl border-2 px-4 py-3 text-left transition-colors ${
    paymentMode === "stripe"
      ? "border-[#1a3f8a] bg-[#1a3f8a]/5"
      : "border-gray-200 hover:border-gray-300"
  }`}
>
  <p className="font-semibold text-sm">Stripe</p>
  <p className="text-xs text-gray-500 mt-0.5">Card Payment (SGD, USD, etc.)</p>
</button>
```

- [ ] **Step 4: Add Stripe info note**

After the existing MMQR info note block, add:

```tsx
{paymentMode === "stripe" && (
  <div className="flex items-start gap-2 rounded-lg bg-purple-50 px-3 py-2.5">
    <svg className="mt-0.5 h-4 w-4 shrink-0 text-purple-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" />
    </svg>
    <p className="text-xs text-purple-700">
      Students will be redirected to Stripe Checkout to pay by card. Payment is auto-confirmed — no manual verification needed.
    </p>
  </div>
)}
```

- [ ] **Step 5: Verify build compiles**

Run: `npm run build`

- [ ] **Step 6: Commit**

```bash
git add src/app/admin/settings/page.tsx
git commit -m "feat: add Stripe option to payment mode settings"
```

---

### Task 9: Update Payment Page — Stripe Flow

**Files:**
- Modify: `src/app/(public)/enroll/payment/[ref]/page.tsx`

- [ ] **Step 1: Update `EnrollmentInfo.payment_mode` type**

Line 35, change:

```typescript
payment_mode?: "bank_transfer" | "mmqr";
```

to:

```typescript
payment_mode?: "bank_transfer" | "mmqr" | "stripe";
```

- [ ] **Step 2: Add Stripe state variables**

After the existing state declarations (around line 75), add:

```typescript
const [stripeLoading, setStripeLoading] = useState(false);
const [stripeError, setStripeError] = useState<string | null>(null);
```

- [ ] **Step 3: Add Stripe checkout handler function**

Add this function near the other payment handlers:

```typescript
async function handleStripeCheckout() {
  if (!info) return;
  setStripeLoading(true);
  setStripeError(null);
  try {
    const res = await fetch("/api/public/payments/stripe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enrollmentRef: info.enrollment_ref }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStripeError(data.message || "Failed to create payment session.");
      return;
    }
    if (data.url) {
      window.location.href = data.url;
    }
  } catch {
    setStripeError("Something went wrong. Please try again.");
  } finally {
    setStripeLoading(false);
  }
}
```

- [ ] **Step 4: Add Stripe return state and query param handling**

Add a state variable:

```typescript
const [stripeReturn, setStripeReturn] = useState<"success" | "cancelled" | null>(null);
```

In the `useEffect` that runs on mount (or where search params are read), add:

```typescript
// Handle Stripe return
const stripeParam = new URLSearchParams(window.location.search).get("stripe");
if (stripeParam === "success") {
  setStripeReturn("success");
  // Remove query param from URL without reload
  window.history.replaceState({}, "", window.location.pathname);
} else if (stripeParam === "cancelled") {
  setStripeReturn("cancelled");
  window.history.replaceState({}, "", window.location.pathname);
}
```

- [ ] **Step 5: Add Stripe payment UI block**

In the JSX, find the section that renders based on `payment_mode`. Add a Stripe block. When `info.payment_mode === "stripe"` and status is `pending_payment` or `partial_payment`, show:

```tsx
{info.payment_mode === "stripe" && (info.status === "pending_payment" || info.status === "partial_payment") && (
  <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
    {/* Show processing state when returning from Stripe */}
    {stripeReturn === "success" ? (
      <div className="text-center py-4">
        <div className="mx-auto mb-3 h-10 w-10 animate-spin rounded-full border-4 border-gray-200 border-t-[#635bff]" />
        <h3 className="text-base font-bold text-gray-900 mb-1">Verifying Payment...</h3>
        <p className="text-sm text-gray-500">Your payment is being confirmed. This usually takes a few seconds.</p>
      </div>
    ) : (
      <>
        <h3 className="text-base font-bold text-gray-900 mb-1">
          Pay with Card
        </h3>
        <p className="text-sm text-gray-500 mb-4">
          You will be redirected to a secure payment page.
        </p>

        {stripeReturn === "cancelled" && (
          <div className="mb-3 rounded-lg bg-yellow-50 px-3 py-2 text-sm text-yellow-700">
            Payment was cancelled. You can try again below.
          </div>
        )}

        {stripeError && (
          <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {stripeError}
          </div>
        )}

        <button
          onClick={handleStripeCheckout}
          disabled={stripeLoading}
          className="w-full rounded-xl bg-[#635bff] px-4 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#5347d9] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {stripeLoading ? "Redirecting..." : "Pay Now"}
        </button>

        <p className="mt-2 text-center text-xs text-gray-400">
          Powered by Stripe — secure card payment
        </p>
      </>
    )}
  </div>
)}
```

- [ ] **Step 6: Hide bank transfer / MMQR UI when payment_mode is stripe**

Wrap the existing bank transfer and MMQR sections with a guard:

```typescript
{info.payment_mode !== "stripe" && (
  // ... existing bank transfer / MMQR UI ...
)}
```

- [ ] **Step 7: Verify build compiles**

Run: `npm run build`

- [ ] **Step 8: Commit**

```bash
git add "src/app/(public)/enroll/payment/[ref]/page.tsx"
git commit -m "feat: add Stripe Checkout flow to payment page"
```

---

### Task 10: Update Status API — Include Stripe Payment Mode

**Files:**
- Modify: `src/app/api/public/status/route.ts`

- [ ] **Step 1: Verify status route already returns `payment_mode`**

Check line 219 of `src/app/api/public/status/route.ts`. It already returns:

```typescript
payment_mode: tenantInfo?.payment_mode ?? "bank_transfer",
```

This will automatically return `"stripe"` for Stripe tenants. No code change needed — just verify.

- [ ] **Step 2: Commit** (skip if no changes)

---

### Task 11: Manual Integration Test

**Files:** None (testing only)

- [ ] **Step 1: Set dev tenant to Stripe mode**

In the admin settings page (`/admin/settings`), select "Stripe" payment mode and save.

- [ ] **Step 2: Create a test enrollment**

Submit an enrollment through the public form. Verify it goes to `pending_payment` status.

- [ ] **Step 3: Test Stripe Checkout redirect**

On the payment page, click "Pay Now". Verify redirect to Stripe Checkout with correct:
- Currency (matching tenant's currency)
- Amount (matching class fee)
- Product name (class level)

- [ ] **Step 4: Complete test payment**

Use Stripe test card `4242 4242 4242 4242` (any future expiry, any CVC).
Verify redirect back to payment page with `?stripe=success`.

- [ ] **Step 5: Test webhook locally**

Install Stripe CLI and forward webhooks:

```bash
stripe listen --forward-to localhost:3005/api/stripe/webhook
```

Verify:
- Payment status changes to `verified`
- Enrollment status changes to `confirmed`
- Payment page shows confirmed status

- [ ] **Step 6: Test cancelled payment**

Start a new checkout session, then click "Back" on Stripe page.
Verify return to payment page with retry option.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "test: verify Stripe integration end-to-end"
```
