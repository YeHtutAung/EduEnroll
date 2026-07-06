# EvTrustedOfficial Enrollment Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a 4-screen "Trusted Official" (navy + gold) event ticketing flow for EduEnroll, with Stripe card and PayNow payment support, on dedicated routes isolated from the existing shared enrollment flow.

**Architecture:** New template (`EvTrustedOfficialTemplate`) renders on a dedicated `/enroll/[slug]/tickets/` route, creates a pending enrollment via existing API, then passes the ref through `/checkout/` (attendee details), `/checkout/payment/` (Stripe Elements), and `/checkout/success/` (e-ticket). All state is persisted server-side in the existing `enrollments`/`payments` tables; only `clientSecret` is held in `sessionStorage`.

**Tech Stack:** Next.js 14 App Router, TypeScript, Tailwind CSS, Supabase (admin client), Stripe (`@stripe/react-stripe-js`, `@stripe/stripe-js`), existing `getStripe()` helper.

**Spec:** `docs/superpowers/specs/2026-07-04-ev-trusted-official-enrollment-flow-design.md`

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `supabase/migrations/084_ev_trusted_official_payments.sql` | Add 3 columns to `payments` |
| Create | `src/app/api/public/enrollment/[ref]/route.ts` | GET enrollment summary + PATCH attendee details |
| Create | `src/app/api/public/payments/stripe/intent/route.ts` | POST create PaymentIntent |
| Create | `src/app/api/public/payments/stripe/intent/status/route.ts` | GET poll PaymentIntent status |
| Create | `src/components/enrollment/templates/EvTrustedOfficialTemplate.tsx` | Ticket selection UI + cart |
| Create | `src/components/enrollment/TrustedOfficialShell.tsx` | Brand row + progress bar wrapper |
| Create | `src/app/(public)/enroll/[slug]/tickets/page.tsx` | Screen 1 — renders template |
| Create | `src/app/(public)/enroll/[slug]/checkout/page.tsx` | Screen 2 — attendee details |
| Create | `src/app/(public)/enroll/[slug]/checkout/payment/page.tsx` | Screen 3 — card + PayNow |
| Create | `src/app/(public)/enroll/[slug]/checkout/success/page.tsx` | Screen 4 — e-ticket |
| Modify | `src/components/enrollment/templates/index.ts` | Export new template |
| Modify | `src/app/(public)/enroll/[slug]/page.tsx` | Add ev-trusted-official redirect |

---

## Task 1: DB Migration

**Files:**
- Create: `supabase/migrations/084_ev_trusted_official_payments.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 084_ev_trusted_official_payments.sql
-- Adds Stripe PaymentIntent tracking + card details to payments table

ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS card_brand text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS card_last4 text;

CREATE INDEX IF NOT EXISTS payments_stripe_payment_intent_id_idx
  ON payments(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
```

- [ ] **Step 2: Apply to dev DB**

```bash
npx supabase db push
```

Expected: migration applied, no errors.

- [ ] **Step 3: Verify columns exist**

```bash
npx supabase db diff
```

Expected: no diff (clean state after push).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/084_ev_trusted_official_payments.sql
git commit -m "feat(db): add stripe_payment_intent_id, card_brand, card_last4 to payments"
```

---

## Task 2: GET + PATCH /api/public/enrollment/[ref]

**Files:**
- Create: `src/app/api/public/enrollment/[ref]/route.ts`

Patterns to follow: `src/app/api/public/payments/stripe/route.ts` (tenant resolution, admin client, error shapes).

- [ ] **Step 1: Create the route file**

```ts
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import { getStripe } from "@/lib/stripe";

// ─── GET /api/public/enrollment/[ref] ────────────────────────────────────────
// Returns enrollment summary for the Trusted Official checkout flow.
// Public — enrollment_ref acts as the access token.

export async function GET(
  _request: NextRequest,
  { params }: { params: { ref: string } },
) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  const supabase = createAdminClient();

  const { data: enrollment, error } = (await supabase
    .from("enrollments")
    .select(`
      enrollment_ref, status, student_name_en, email,
      enrollment_items(quantity, fee_amount, classes(level)),
      classes(level, fee_amount, intakes(name, slug)),
      quantity, fee_amount,
      payments(stripe_payment_intent_id, status, payment_method)
    `)
    .eq("enrollment_ref", params.ref.trim())
    .eq("tenant_id", tenantId)
    .single()) as { data: EnrollmentRow | null; error: unknown };

  if (error || !enrollment) {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }

  if (enrollment.status === "cancelled") {
    return NextResponse.json({ error: "Gone", message: "This order has expired." }, { status: 410 });
  }

  // Build items list (cart or single class)
  const items =
    enrollment.enrollment_items && enrollment.enrollment_items.length > 0
      ? enrollment.enrollment_items.map((i) => ({
          level: (i.classes as { level: string } | null)?.level ?? "Ticket",
          quantity: i.quantity,
          fee_amount: i.fee_amount,
        }))
      : enrollment.classes
      ? [{ level: enrollment.classes.level, quantity: enrollment.quantity ?? 1, fee_amount: enrollment.classes.fee_amount }]
      : [];

  const totalAmount = items.reduce((s, i) => s + i.fee_amount * i.quantity, 0);

  // Conditionally retrieve stripe client_secret if an active PaymentIntent exists
  let stripeClientSecret: string | undefined;
  const activePayment = (enrollment.payments as PaymentRow[] | null)?.find(
    (p) => p.payment_method === "stripe" && p.status === "awaiting_payment" && p.stripe_payment_intent_id,
  );
  if (activePayment?.stripe_payment_intent_id) {
    try {
      const pi = await getStripe().paymentIntents.retrieve(activePayment.stripe_payment_intent_id);
      if (pi.status === "requires_payment_method" || pi.status === "requires_confirmation" || pi.status === "requires_action") {
        stripeClientSecret = pi.client_secret ?? undefined;
      }
    } catch {
      // Stripe API error — omit client_secret, client will handle
    }
  }

  return NextResponse.json({
    enrollment_ref: enrollment.enrollment_ref,
    status: enrollment.status,
    student_name_en: enrollment.student_name_en ?? "",
    email: enrollment.email ?? "",
    total_amount: totalAmount,
    items,
    event_name: enrollment.classes?.intakes?.name ?? "",
    ...(stripeClientSecret ? { stripe_client_secret: stripeClientSecret } : {}),
  });
}

// ─── PATCH /api/public/enrollment/[ref] ──────────────────────────────────────
// Updates attendee details on a pending enrollment. Idempotent.

export async function PATCH(
  request: NextRequest,
  { params }: { params: { ref: string } },
) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  let body: { student_name_en?: string; company?: string; email?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad Request", message: "Invalid JSON." }, { status: 400 });
  }

  const { student_name_en, company, email } = body;
  if (!student_name_en || !email) {
    return NextResponse.json({ error: "Bad Request", message: "student_name_en and email are required." }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select("id, status")
    .eq("enrollment_ref", params.ref.trim())
    .eq("tenant_id", tenantId)
    .single()) as { data: { id: string; status: string } | null; error: unknown };

  if (!enrollment) {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }
  if (enrollment.status !== "pending_payment") {
    return NextResponse.json({ error: "Conflict", message: "This order is no longer pending." }, { status: 409 });
  }

  await supabase
    .from("enrollments")
    .update({ student_name_en: student_name_en.trim(), email: email.trim(), ...(company ? { form_data: { company: company.trim() } } : {}) } as never)
    .eq("id", enrollment.id);

  return NextResponse.json({ enrollment_ref: params.ref, status: enrollment.status });
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface PaymentRow {
  stripe_payment_intent_id: string | null;
  status: string;
  payment_method: string;
}

interface EnrollmentRow {
  enrollment_ref: string;
  status: string;
  student_name_en: string | null;
  email: string | null;
  quantity: number | null;
  fee_amount: number | null;
  enrollment_items: { quantity: number; fee_amount: number; classes: { level: string } | null }[] | null;
  classes: { level: string; fee_amount: number; intakes: { name: string; slug: string } | null } | null;
  payments: PaymentRow[] | null;
}
```

- [ ] **Step 2: Type-check**

```bash
cd "C:/YHA/006_Claude_Workspace/EduEnroll" && npm run build 2>&1 | tail -20
```

Expected: no TypeScript errors in the new file. (Other pre-existing errors are acceptable.)

- [ ] **Step 3: Commit**

```bash
git add src/app/api/public/enrollment/
git commit -m "feat(api): GET+PATCH /api/public/enrollment/[ref] for Trusted Official flow"
```

---

## Task 3: POST /api/public/payments/stripe/intent

**Files:**
- Create: `src/app/api/public/payments/stripe/intent/route.ts`

- [ ] **Step 1: Create the route file**

```ts
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import { getStripe } from "@/lib/stripe";

// ─── POST /api/public/payments/stripe/intent ──────────────────────────────────
// Creates a Stripe PaymentIntent for the Trusted Official checkout flow.
// Supports card and paynow payment methods.
// Idempotent — returns existing active PaymentIntent if one exists.

export async function POST(request: NextRequest) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  let body: { enrollmentRef?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad Request", message: "Invalid JSON." }, { status: 400 });
  }

  const { enrollmentRef } = body;
  if (!enrollmentRef || typeof enrollmentRef !== "string") {
    return NextResponse.json({ error: "Bad Request", message: "enrollmentRef is required." }, { status: 400 });
  }

  const supabase = createAdminClient();

  // ── Look up enrollment ────────────────────────────────────────
  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select("id, status, tenant_id, enrollment_ref, enrollment_items(quantity, fee_amount), classes(fee_amount), quantity")
    .eq("enrollment_ref", enrollmentRef.trim())
    .eq("tenant_id", tenantId)
    .single()) as { data: EnrollmentRow | null; error: unknown };

  if (!enrollment) {
    return NextResponse.json({ error: "Not Found", message: "Enrollment not found." }, { status: 404 });
  }
  if (enrollment.status !== "pending_payment") {
    return NextResponse.json({ error: "Conflict", message: "This enrollment is not awaiting payment." }, { status: 409 });
  }

  // ── Currency guard — Stripe not available for MMK ─────────────
  const { data: tenant } = (await supabase
    .from("tenants")
    .select("currency")
    .eq("id", tenantId)
    .single()) as { data: { currency: string } | null; error: unknown };

  const currency = (tenant?.currency ?? "MMK").toLowerCase();
  if (currency === "mmk") {
    return NextResponse.json({ error: "Bad Request", message: "Stripe is not available for MMK. Use bank transfer." }, { status: 400 });
  }

  // ── Calculate total ───────────────────────────────────────────
  let totalCents: number;
  if (enrollment.enrollment_items && enrollment.enrollment_items.length > 0) {
    totalCents = enrollment.enrollment_items.reduce((s, i) => s + i.fee_amount * i.quantity, 0) * 100;
  } else if (enrollment.classes) {
    totalCents = enrollment.classes.fee_amount * (enrollment.quantity ?? 1) * 100;
  } else {
    return NextResponse.json({ error: "Internal Server Error", message: "Class data not found." }, { status: 500 });
  }

  // ── Idempotency — return existing active PaymentIntent if any ─
  const { data: existing } = (await supabase
    .from("payments")
    .select("stripe_payment_intent_id")
    .eq("enrollment_id", enrollment.id)
    .eq("payment_method", "stripe")
    .eq("status", "awaiting_payment")
    .not("stripe_payment_intent_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .single()) as { data: { stripe_payment_intent_id: string } | null; error: unknown };

  if (existing?.stripe_payment_intent_id) {
    try {
      const pi = await getStripe().paymentIntents.retrieve(existing.stripe_payment_intent_id);
      if (["requires_payment_method", "requires_confirmation", "requires_action"].includes(pi.status)) {
        return NextResponse.json({ clientSecret: pi.client_secret, paymentIntentId: pi.id });
      }
    } catch {
      // Expired or invalid — fall through to create new
    }
  }

  // ── Create new PaymentIntent ──────────────────────────────────
  try {
    const pi = await getStripe().paymentIntents.create({
      amount: totalCents,
      currency,
      payment_method_types: ["card", "paynow"],
      metadata: {
        tenant_id: tenantId,
        enrollment_id: enrollment.id,
        enrollment_ref: enrollment.enrollment_ref,
      },
    });

    await supabase.from("payments").insert({
      enrollment_id: enrollment.id,
      tenant_id: tenantId,
      amount: totalCents / 100,
      payment_method: "stripe",
      status: "awaiting_payment",
      stripe_payment_intent_id: pi.id,
    } as never);

    return NextResponse.json({ clientSecret: pi.client_secret, paymentIntentId: pi.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[stripe/intent] create error:", msg);
    return NextResponse.json({ error: "Payment Gateway Error", message: "Failed to create payment session." }, { status: 502 });
  }
}

interface EnrollmentRow {
  id: string;
  status: string;
  tenant_id: string;
  enrollment_ref: string;
  quantity: number | null;
  enrollment_items: { quantity: number; fee_amount: number }[] | null;
  classes: { fee_amount: number } | null;
}
```

- [ ] **Step 2: Type-check**

```bash
npm run build 2>&1 | tail -20
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/public/payments/stripe/intent/route.ts
git commit -m "feat(api): POST /api/public/payments/stripe/intent — create PaymentIntent for Trusted Official flow"
```

---

## Task 4: GET /api/public/payments/stripe/intent/status

**Files:**
- Create: `src/app/api/public/payments/stripe/intent/status/route.ts`

- [ ] **Step 1: Create the route file**

```ts
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe";

// ─── GET /api/public/payments/stripe/intent/status?pi=pi_xxx ─────────────────
// Polls Stripe for PaymentIntent status. Used by PayNow QR polling loop.
// No PII returned — PaymentIntent IDs are already client-side (in URL).
// Idempotent — safe to call on every poll tick.

export async function GET(request: NextRequest) {
  const piId = request.nextUrl.searchParams.get("pi");
  if (!piId) {
    return NextResponse.json({ error: "pi parameter is required." }, { status: 400 });
  }

  try {
    const pi = await getStripe().paymentIntents.retrieve(piId, { expand: ["payment_method"] });

    if (pi.status === "succeeded") {
      const supabase = createAdminClient();

      const { data: payment } = (await supabase
        .from("payments")
        .select("id, enrollment_id, status")
        .eq("stripe_payment_intent_id", piId)
        .single()) as { data: { id: string; enrollment_id: string; status: string } | null; error: unknown };

      if (payment && payment.status !== "verified") {
        // Extract card details if present
        const pm = pi.payment_method as import("stripe").Stripe.PaymentMethod | null;
        const cardBrand = pm?.card?.brand ?? null;
        const cardLast4 = pm?.card?.last4 ?? null;

        await supabase
          .from("payments")
          .update({
            status: "verified",
            paid_at: new Date().toISOString(),
            ...(cardBrand ? { card_brand: cardBrand } : {}),
            ...(cardLast4 ? { card_last4: cardLast4 } : {}),
          } as never)
          .eq("id", payment.id);

        await supabase
          .from("enrollments")
          .update({ status: "confirmed" } as never)
          .eq("id", payment.enrollment_id);
      }

      return NextResponse.json({ status: "succeeded" });
    }

    if (pi.status === "canceled") {
      return NextResponse.json({ status: "cancelled" });
    }

    return NextResponse.json({ status: "pending" });
  } catch (err) {
    console.error("[stripe/intent/status]", err);
    return NextResponse.json({ error: "Failed to retrieve payment status." }, { status: 500 });
  }
}
```

- [ ] **Step 2: Type-check**

```bash
npm run build 2>&1 | tail -20
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/public/payments/stripe/intent/status/route.ts
git commit -m "feat(api): GET /api/public/payments/stripe/intent/status — PayNow polling endpoint"
```

---

## Task 5: Install Stripe Client Packages

**Files:** none (package.json + lockfile)

- [ ] **Step 1: Install packages**

```bash
npm install @stripe/react-stripe-js @stripe/stripe-js
```

- [ ] **Step 2: Verify `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` env var exists**

Check `.env.local` — it must contain `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...`. If not, add it. The secret key (`STRIPE_SECRET_KEY`) should already be present (used by the existing Stripe Checkout route).

- [ ] **Step 3: Type-check**

```bash
npm run build 2>&1 | tail -20
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: install @stripe/react-stripe-js and @stripe/stripe-js"
```

---

## Task 6: EvTrustedOfficialTemplate Component

**Files:**
- Create: `src/components/enrollment/templates/EvTrustedOfficialTemplate.tsx`

Design tokens (from spec): navy `#0f1f42`, gold deep `#b7912b`, gold light `#d4af5a`, cream bg `#fbf8ee`, card border `#e3e0d6`, input inactive `#d8d5c9`, secondary text `#8b8f9a`.

- [ ] **Step 1: Create the component**

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { TenantAppearance } from "@/types/database";
import type { TemplateClass, TemplateIntake, TemplateLabels } from "./types";
import { getCardState } from "./types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EvTrustedOfficialTemplateProps {
  appearance: Omit<TenantAppearance, "id" | "tenant_id" | "updated_at">;
  intake: TemplateIntake;
  classes: TemplateClass[];
  labels: TemplateLabels;
  slug: string;
  currency: string;
}

// ─── TicketCard ───────────────────────────────────────────────────────────────

function TicketCard({
  cls,
  qty,
  onQtyChange,
  featured,
}: {
  cls: TemplateClass;
  qty: number;
  onQtyChange: (classId: string, delta: number) => void;
  featured: boolean;
}) {
  const { isDisabled, overlayState } = getCardState(cls);
  const max = cls.max_tickets_per_person ?? 10;

  const overlayLabel =
    overlayState === "full" ? "Sold Out" :
    overlayState === "not_open" ? "Coming Soon" :
    overlayState === "closed" ? "Sales Closed" : null;

  const subtotal = qty * cls.fee_amount;

  return (
    <div
      className="rounded-[10px] p-[13px] text-sm"
      style={{
        background: featured ? "#fbf8ee" : "#ffffff",
        border: featured ? "1.5px solid #d4af5a" : "1px solid #e3e0d6",
        boxShadow: "0 1px 2px rgba(15,31,66,.05)",
      }}
    >
      {/* Header row */}
      <div className="flex items-start justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="font-bold text-[13px]" style={{ color: "#0f1f42" }}>{cls.level}</span>
          {featured && (
            <span
              className="text-[8.5px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded text-white"
              style={{ background: "#b7912b", borderRadius: 4 }}
            >
              POPULAR
            </span>
          )}
        </div>
        <span className="text-[12.5px] font-bold" style={{ color: "#0f1f42" }}>
          SGD {cls.fee_amount.toLocaleString()}
        </span>
      </div>

      {/* Seats remaining */}
      <p className="text-[10.5px] mb-3" style={{ color: "#8b8f9a" }}>
        {cls.seat_remaining} seats remaining
      </p>

      {/* Controls */}
      {overlayLabel ? (
        <div className="text-center text-[11px] py-2 rounded" style={{ background: "#f5f5f5", color: "#9a9484" }}>
          {overlayLabel}
        </div>
      ) : isDisabled ? null : (
        <div className="flex items-center justify-between">
          {/* Stepper */}
          <div
            className="flex items-center overflow-hidden rounded-full"
            style={{ border: "1px solid #d8d5c9" }}
          >
            <button
              className="w-[26px] h-[26px] flex items-center justify-center text-sm font-bold hover:bg-gray-50"
              style={{ color: "#0f1f42" }}
              onClick={() => onQtyChange(cls.id, -1)}
              disabled={qty === 0}
            >
              −
            </button>
            <span
              className="w-[26px] text-center text-[12px] font-bold"
              style={{ color: "#0f1f42", borderLeft: "1px solid #d8d5c9", borderRight: "1px solid #d8d5c9" }}
            >
              {qty}
            </span>
            <button
              className="w-[26px] h-[26px] flex items-center justify-center text-sm font-bold hover:bg-gray-50"
              style={{ color: "#0f1f42" }}
              onClick={() => onQtyChange(cls.id, 1)}
              disabled={qty >= max}
            >
              +
            </button>
          </div>
          {/* Subtotal */}
          {qty > 0 && (
            <span className="text-[11.5px] font-semibold" style={{ color: "#0f1f42" }}>
              SGD {subtotal.toLocaleString()}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── EvTrustedOfficialTemplate ────────────────────────────────────────────────

export default function EvTrustedOfficialTemplate({
  appearance, intake, classes, slug,
}: EvTrustedOfficialTemplateProps) {
  const router = useRouter();
  const logoUrl = appearance.logo_url;
  const [cart, setCart] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cartCount = Object.values(cart).reduce((s, q) => s + q, 0);
  const cartTotal = classes.reduce((s, cls) => s + (cart[cls.id] ?? 0) * cls.fee_amount, 0);

  function handleQtyChange(classId: string, delta: number) {
    const cls = classes.find((c) => c.id === classId);
    if (!cls) return;
    const max = cls.max_tickets_per_person ?? 10;
    setCart((prev) => {
      const next = Math.max(0, Math.min(max, (prev[classId] ?? 0) + delta));
      if (next === 0) {
        const copy = { ...prev };
        delete copy[classId];
        return copy;
      }
      return { ...prev, [classId]: next };
    });
  }

  async function handleCheckout() {
    if (cartCount === 0 || loading) return;
    setLoading(true);
    setError(null);

    const items = classes
      .filter((cls) => (cart[cls.id] ?? 0) > 0)
      .map((cls) => ({ class_id: cls.id, quantity: cart[cls.id] }));

    try {
      const res = await fetch("/api/public/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // form_data intentionally omitted — email is collected on Screen 2
        body: JSON.stringify({ items }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? "Enrollment failed.");
      router.push(`/enroll/${slug}/checkout/?ref=${data.enrollment_ref}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen pb-32" style={{ background: "#f7f5ef" }}>
      {/* ── Brand row ────────────────────────────────────── */}
      <div className="px-5 pt-5 pb-4 flex items-center gap-2.5">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt="" className="w-[30px] h-[30px] rounded-[6px] object-cover" />
        ) : (
          <div
            className="w-[30px] h-[30px] rounded-[6px] flex items-center justify-center text-[11px] font-black"
            style={{ background: "#0f1f42", color: "#d4af5a" }}
          >
            {intake.name.charAt(0)}
          </div>
        )}
        <span className="text-[12.5px] font-semibold" style={{ color: "#0f1f42" }}>
          {intake.name}
        </span>
      </div>

      {/* ── Title block ──────────────────────────────────── */}
      <div
        className="mx-5 px-4 py-4 mb-5"
        style={{ borderTop: "1.5px solid #d4af5a", borderBottom: "1.5px solid #d4af5a" }}
      >
        <p className="text-[10px] font-bold uppercase tracking-[2.5px] mb-1" style={{ color: "#b7912b" }}>
          {intake.year}
        </p>
        <h1 className="text-[19px] font-extrabold leading-tight" style={{ color: "#0f1f42" }}>
          Select Your Ticket
        </h1>
      </div>

      {/* ── Ticket cards ─────────────────────────────────── */}
      <div className="px-5 flex flex-col gap-3">
        {classes.length === 0 ? (
          <p className="text-center py-12 text-sm" style={{ color: "#8b8f9a" }}>
            No tickets available at this time.
          </p>
        ) : (
          classes.map((cls, i) => (
            <TicketCard
              key={cls.id}
              cls={cls}
              qty={cart[cls.id] ?? 0}
              onQtyChange={handleQtyChange}
              featured={i === 0 && classes.length > 1}
            />
          ))
        )}
      </div>

      {/* ── Error ────────────────────────────────────────── */}
      {error && (
        <div className="mx-5 mt-4 p-3 rounded-lg border text-[12px]" style={{ background: "#fff5f5", borderColor: "#fca5a5", color: "#991b1b" }}>
          {error}
        </div>
      )}

      {/* ── Sticky cart bar ──────────────────────────────── */}
      {cartCount > 0 && (
        <div
          className="fixed bottom-0 left-0 right-0 z-50"
          style={{ background: "#ffffff", borderTop: "1px solid #e3e0d6", padding: "12px 22px 18px" }}
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11.5px] font-bold" style={{ color: "#0f1f42" }}>
              {cartCount} ticket{cartCount > 1 ? "s" : ""} selected
            </span>
            <span className="text-[12px] font-extrabold" style={{ color: "#0f1f42" }}>
              SGD {cartTotal.toLocaleString()}
            </span>
          </div>
          <button
            className="w-full py-2.5 rounded-[7px] text-[12px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            style={{ background: "#0f1f42" }}
            onClick={handleCheckout}
            disabled={loading}
          >
            {loading ? "Processing..." : "CONTINUE →"}
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Export from index**

In `src/components/enrollment/templates/index.ts`, add after the existing Ev exports:

```ts
export { default as EvTrustedOfficialTemplate } from "./EvTrustedOfficialTemplate";
export type { EvTrustedOfficialTemplateProps } from "./EvTrustedOfficialTemplate";
```

- [ ] **Step 3: Type-check**

```bash
npm run build 2>&1 | tail -20
```

- [ ] **Step 4: Commit**

```bash
git add src/components/enrollment/templates/EvTrustedOfficialTemplate.tsx src/components/enrollment/templates/index.ts
git commit -m "feat(ui): EvTrustedOfficialTemplate — ticket selection with cart and sticky bar"
```

---

## Task 7: TrustedOfficialShell Wrapper

**Files:**
- Create: `src/components/enrollment/TrustedOfficialShell.tsx`

- [ ] **Step 1: Create the component**

```tsx
// src/components/enrollment/TrustedOfficialShell.tsx
// Shared shell for Screens 2–4 of the Trusted Official checkout flow.
// Renders brand row + step progress bar + cream background.

interface TrustedOfficialShellProps {
  logoUrl?: string | null;
  orgName: string;
  step?: 1 | 2 | "complete";
  children: React.ReactNode;
}

export default function TrustedOfficialShell({
  logoUrl, orgName, step, children,
}: TrustedOfficialShellProps) {
  const seg1Gold = step === 1 || step === 2 || step === "complete";
  const seg2Gold = step === 2 || step === "complete";

  return (
    <div className="min-h-screen" style={{ background: "#f7f5ef" }}>
      {/* Brand row */}
      <div className="px-5 pt-5 pb-3 flex items-center gap-2.5">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt="" className="w-[30px] h-[30px] rounded-[6px] object-cover" />
        ) : (
          <div
            className="w-[30px] h-[30px] rounded-[6px] flex items-center justify-center text-[11px] font-black"
            style={{ background: "#0f1f42", color: "#d4af5a" }}
          >
            {orgName.charAt(0)}
          </div>
        )}
        <span className="text-[12.5px] font-semibold" style={{ color: "#0f1f42" }}>{orgName}</span>
      </div>

      {/* Step label + progress bar */}
      {step !== "complete" && (
        <div className="px-5 mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-bold uppercase tracking-[1.5px]" style={{ color: "#0f1f42" }}>
              Step {step} of 2
            </span>
            <span className="text-[10px]" style={{ color: "#8b8f9a" }}>
              {step === 1 ? "Attendee details" : "Payment"}
            </span>
          </div>
          <div className="flex gap-[5px]">
            <div className="h-[4px] flex-1 rounded-[2px]" style={{ background: seg1Gold ? "#b7912b" : "#e9e6dc" }} />
            <div className="h-[4px] flex-1 rounded-[2px]" style={{ background: seg2Gold ? "#b7912b" : "#e9e6dc" }} />
          </div>
        </div>
      )}

      {/* Screen content */}
      <div className="px-5 pb-10">{children}</div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
npm run build 2>&1 | tail -20
```

- [ ] **Step 3: Commit**

```bash
git add src/components/enrollment/TrustedOfficialShell.tsx
git commit -m "feat(ui): TrustedOfficialShell — shared brand row + progress bar for checkout flow"
```

---

## Task 8: Screen 1 — /enroll/[slug]/tickets/page.tsx

**Files:**
- Create: `src/app/(public)/enroll/[slug]/tickets/page.tsx`

This page fetches the same intake/class data as `/enroll/[slug]/page.tsx` and passes it to the new template.

- [ ] **Step 1: Create the page**

```tsx
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { EvTrustedOfficialTemplate } from "@/components/enrollment/templates";

interface ClassData {
  id: string; level: string; fee_amount: number; fee_formatted: string;
  seat_remaining: number; seat_total: number; status: string;
  enrollment_open_at: string | null; enrollment_close_at: string | null;
  max_tickets_per_person?: number;
}

interface PageData {
  intake: { id: string; name: string; year: number; status: string };
  classes: ClassData[];
  appearance: Record<string, unknown>;
  labels: { currency: string; orgType: string; intake: string; class: string; student: string; seat: string; fee: string };
}

export default function TicketsPage() {
  const params = useParams<{ slug: string }>();
  const [data, setData] = useState<PageData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/public/enroll/${params.slug}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setData(d);
      })
      .catch(() => setError("Failed to load event."));
  }, [params.slug]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#f7f5ef" }}>
        <p className="text-sm" style={{ color: "#8b8f9a" }}>{error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#f7f5ef" }}>
        <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: "#0f1f42", borderTopColor: "transparent" }} />
      </div>
    );
  }

  return (
    <EvTrustedOfficialTemplate
      appearance={data.appearance as never}
      intake={data.intake}
      classes={data.classes}
      labels={data.labels}
      slug={params.slug}
      currency={data.labels.currency}
    />
  );
}
```

- [ ] **Step 2: Type-check**

```bash
npm run build 2>&1 | tail -20
```

- [ ] **Step 3: Manual smoke test**

1. Set a test tenant's `template_id` to `"ev-trusted-official"` in dev Supabase.
2. Run `npm run dev`.
3. Visit `http://localhost:3005/enroll/[slug]/tickets/` — should see the navy/gold ticket selection UI.
4. Verify ticket cards render, quantity steppers work, sticky cart bar appears on selection.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(public)/enroll/[slug]/tickets/"
git commit -m "feat(ui): Screen 1 — tickets page renders EvTrustedOfficialTemplate"
```

---

## Task 9: Screen 2 — Attendee Details

**Files:**
- Create: `src/app/(public)/enroll/[slug]/checkout/page.tsx`

- [ ] **Step 1: Create the page**

```tsx
"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import TrustedOfficialShell from "@/components/enrollment/TrustedOfficialShell";

interface EnrollmentSummary {
  enrollment_ref: string;
  status: string;
  total_amount: number;
  items: { level: string; quantity: number; fee_amount: number }[];
  event_name: string;
}

function CheckoutForm() {
  const params = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const ref = searchParams.get("ref") ?? "";

  const [summary, setSummary] = useState<EnrollmentSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!ref) { setLoadError("Missing order reference."); return; }
    fetch(`/api/public/enrollment/${ref}`)
      .then((r) => {
        if (r.status === 404) throw new Error("Order not found.");
        if (r.status === 410) throw new Error("This order has expired.");
        return r.json();
      })
      .then((d) => setSummary(d))
      .catch((e) => setLoadError(e.message));
  }, [ref]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !email.trim()) {
      setFormError("Name and email are required.");
      return;
    }
    setSubmitting(true);
    setFormError(null);

    try {
      // 1. Save attendee details
      const patchRes = await fetch(`/api/public/enrollment/${ref}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ student_name_en: name.trim(), company: company.trim(), email: email.trim() }),
      });
      if (!patchRes.ok) {
        const d = await patchRes.json();
        if (patchRes.status === 409) throw new Error("This order has expired. Please start again.");
        throw new Error(d.message ?? "Failed to save details.");
      }

      // 2. Create PaymentIntent
      const intentRes = await fetch("/api/public/payments/stripe/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enrollmentRef: ref }),
      });
      if (!intentRes.ok) {
        const d = await intentRes.json();
        throw new Error(d.message ?? "Payment setup failed. Please try again.");
      }
      const { clientSecret, paymentIntentId } = await intentRes.json();

      // 3. Store clientSecret in sessionStorage for Screen 3
      sessionStorage.setItem(`cs_${ref}`, clientSecret);

      router.push(`/enroll/${params.slug}/checkout/payment/?ref=${ref}&pi=${paymentIntentId}`);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Something went wrong.");
      setSubmitting(false);
    }
  }

  if (loadError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-5" style={{ background: "#f7f5ef" }}>
        <p className="text-[13px] text-center" style={{ color: "#0f1f42" }}>{loadError}</p>
        <a href={`/enroll/${params.slug}/tickets/`} className="text-[12px] underline" style={{ color: "#b7912b" }}>
          Return to event page
        </a>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#f7f5ef" }}>
        <div className="w-5 h-5 border-2 rounded-full animate-spin" style={{ borderColor: "#0f1f42", borderTopColor: "transparent" }} />
      </div>
    );
  }

  return (
    <TrustedOfficialShell orgName={summary.event_name} step={1}>
      {/* Order summary card */}
      <div className="rounded-[10px] p-4 mb-5" style={{ background: "#fbf8ee", border: "1px solid rgba(212,175,90,.33)" }}>
        {summary.items.map((item, i) => (
          <div key={i} className="flex justify-between text-[12.5px] font-bold" style={{ color: "#0f1f42" }}>
            <span>{item.quantity} × {item.level}</span>
            <span>SGD {(item.fee_amount * item.quantity).toLocaleString()}</span>
          </div>
        ))}
        <p className="text-[10px] mt-1" style={{ color: "#9a9484" }}>{summary.event_name}</p>
      </div>

      {/* Attendee details form */}
      <p className="text-[11px] font-bold tracking-[1.2px] uppercase pb-1.5 mb-4" style={{ color: "#0f1f42", borderBottom: "1.5px solid #eee9dc" }}>
        Your Details
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label className="block text-[11px] font-semibold mb-1" style={{ color: "#43485a" }}>Full Name</label>
          <input
            className="w-full h-[33px] px-3 rounded-[7px] text-[12px] outline-none"
            style={{ border: `1.5px solid ${name ? "#0f1f42" : "#d8d5c9"}` }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your full name"
            required
          />
        </div>
        <div>
          <label className="block text-[11px] font-semibold mb-1" style={{ color: "#43485a" }}>Company <span className="font-normal" style={{ color: "#9a9484" }}>(optional)</span></label>
          <input
            className="w-full h-[33px] px-3 rounded-[7px] text-[12px] outline-none"
            style={{ border: "1.5px solid #d8d5c9" }}
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="Your company"
          />
        </div>
        <div>
          <label className="block text-[11px] font-semibold mb-1" style={{ color: "#43485a" }}>Email Address</label>
          <input
            type="email"
            className="w-full h-[33px] px-3 rounded-[7px] text-[12px] outline-none"
            style={{ border: "1.5px solid #d8d5c9" }}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
          />
          <p className="text-[9.5px] mt-1" style={{ color: "#9a9484" }}>E-ticket will be sent to this address.</p>
        </div>

        {formError && (
          <div className="p-3 rounded-lg border text-[12px]" style={{ background: "#fff5f5", borderColor: "#fca5a5", color: "#991b1b" }}>
            {formError}{" "}
            {formError.includes("expired") && (
              <a href={`/enroll/${params.slug}/tickets/`} className="underline">Start again</a>
            )}
          </div>
        )}

        <button
          type="submit"
          className="w-full py-3 rounded-[8px] text-[12.5px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          style={{ background: "#0f1f42" }}
          disabled={submitting}
        >
          {submitting ? "Please wait..." : "CONTINUE TO PAYMENT →"}
        </button>
      </form>
    </TrustedOfficialShell>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense>
      <CheckoutForm />
    </Suspense>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
npm run build 2>&1 | tail -20
```

- [ ] **Step 3: Manual smoke test**

1. From Screen 1, select tickets and click Continue.
2. Should land on `/enroll/[slug]/checkout/?ref=...` with the order summary card and form.
3. Fill in details and submit — should redirect to `/checkout/payment/?ref=...&pi=...`.
4. Check dev Supabase: `payments` table should have a new row with `stripe_payment_intent_id` set.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(public)/enroll/[slug]/checkout/page.tsx"
git commit -m "feat(ui): Screen 2 — attendee details form with PATCH + PaymentIntent creation"
```

---

## Task 10: Screen 3 — Payment (Card + PayNow)

**Files:**
- Create: `src/app/(public)/enroll/[slug]/checkout/payment/page.tsx`

- [ ] **Step 1: Create the page**

```tsx
"use client";

import { Suspense, useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import TrustedOfficialShell from "@/components/enrollment/TrustedOfficialShell";

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);

// ─── Card Payment Form ────────────────────────────────────────────────────────

function CardForm({ slug, enrollmentRef, totalAmount }: { slug: string; enrollmentRef: string; totalAmount: number }) {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePay(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setPaying(true);
    setError(null);

    const origin = window.location.origin;
    const { error: stripeError } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${origin}/enroll/${slug}/checkout/success/?ref=${enrollmentRef}`,
      },
    });

    if (stripeError) {
      setError(stripeError.message ?? "Payment failed. Please try again.");
      setPaying(false);
    }
    // On success, Stripe redirects to return_url — no manual redirect needed
  }

  return (
    <form onSubmit={handlePay} className="flex flex-col gap-4">
      <PaymentElement />
      {error && (
        <div className="p-3 rounded-lg border text-[12px]" style={{ background: "#fff5f5", borderColor: "#fca5a5", color: "#991b1b" }}>
          {error}
        </div>
      )}
      <button
        type="submit"
        className="w-full py-3 rounded-[8px] text-[12.5px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
        style={{ background: "#0f1f42" }}
        disabled={paying || !stripe}
      >
        {paying ? (
          <span className="flex items-center justify-center gap-2">
            <span className="w-4 h-4 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(255,255,255,.3)", borderTopColor: "#fff" }} />
            Processing...
          </span>
        ) : (
          `PAY SGD ${totalAmount.toLocaleString()}`
        )}
      </button>
      <p className="text-center text-[9.5px]" style={{ color: "#aca795" }}>
        Secured by <span className="font-bold" style={{ color: "#635bff" }}>stripe</span>
      </p>
    </form>
  );
}

// ─── PayNow Tab ───────────────────────────────────────────────────────────────

function PayNowTab({
  slug, enrollmentRef, piId, clientSecret, totalAmount,
}: { slug: string; enrollmentRef: string; piId: string; clientSecret: string; totalAmount: number }) {
  const router = useRouter();
  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null);
  const [uen, setUen] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(600); // 10 minute countdown
  const [expired, setExpired] = useState(false);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/public/payments/stripe/intent/status?pi=${piId}`);
        const { status } = await res.json();
        if (status === "succeeded") {
          clearInterval(pollRef.current!);
          router.push(`/enroll/${slug}/checkout/success/?ref=${enrollmentRef}`);
        } else if (status === "cancelled") {
          clearInterval(pollRef.current!);
          setError("Payment expired. Please return to the event page and try again.");
        }
      } catch { /* network error — keep polling */ }
    }, 3000);
  }, [piId, slug, enrollmentRef, router]);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // Countdown timer
  useEffect(() => {
    if (!qrImageUrl || expired) return;
    const t = setInterval(() => {
      setSeconds((s) => {
        if (s <= 1) { clearInterval(t); setExpired(true); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [qrImageUrl, expired]);

  async function handleGenerateQR() {
    setPaying(true);
    setError(null);
    setExpired(false);
    setSeconds(600);

    const stripe = await stripePromise;
    if (!stripe) { setError("Stripe not loaded."); setPaying(false); return; }

    const { paymentIntent, error: stripeError } = await stripe.confirmPayment({
      clientSecret,
      confirmParams: {
        return_url: `${window.location.origin}/enroll/${slug}/checkout/success/?ref=${enrollmentRef}`,
      },
      redirect: "if_required",
    });

    if (stripeError) {
      setError(stripeError.message ?? "Failed to generate QR. Please try again.");
      setPaying(false);
      return;
    }

    const qrData = paymentIntent?.next_action?.paynow_display_qr_code as
      | { image_url_svg?: string; hosted_instructions_url?: string } | undefined;

    if (qrData?.image_url_svg) {
      setQrImageUrl(qrData.image_url_svg);
      // Extract UEN from hosted_instructions_url if available (or show placeholder)
      setUen("See your banking app for UEN");
      startPolling();
    } else {
      setError("Could not generate PayNow QR. Please try card payment instead.");
    }
    setPaying(false);
  }

  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");

  if (qrImageUrl && !expired) {
    return (
      <div className="flex flex-col gap-4">
        {/* QR card */}
        <div className="rounded-[10px] p-[18px] text-center" style={{ border: "1px solid #e3e0d6" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qrImageUrl} alt="PayNow QR" className="w-[130px] h-[130px] mx-auto mb-2" />
          <p className="text-[10.5px]" style={{ color: "#8b8f9a" }}>Scan with your banking app</p>
          <p className="text-[9.5px]" style={{ color: "#aca795" }}>DBS · OCBC · UOB · and most PayNow banks</p>
        </div>

        {/* UEN row */}
        <div className="flex items-center justify-between px-3 py-2 rounded-[8px]" style={{ border: "1px solid #e3e0d6" }}>
          <span className="text-[10.5px]" style={{ color: "#8b8f9a" }}>PayNow UEN</span>
          <span className="text-[12px] font-bold tracking-wide" style={{ color: "#0f1f42" }}>{uen}</span>
        </div>

        {/* Waiting chip */}
        <div className="flex items-center justify-between px-3 py-2 rounded-[8px]" style={{ background: "#fdf3e0", border: "1px solid #eed9a3" }}>
          <span className="text-[10.5px]" style={{ color: "#8a6a1f" }}>Waiting for payment</span>
          <span className="text-[11.5px] font-extrabold" style={{ color: "#8a6a1f" }}>{mm}:{ss}</span>
        </div>

        {error && (
          <div className="p-3 rounded-lg border text-[12px]" style={{ background: "#fff5f5", borderColor: "#fca5a5", color: "#991b1b" }}>{error}</div>
        )}

        <p className="text-center text-[9.5px]" style={{ color: "#aca795" }}>
          Secured by <span className="font-bold" style={{ color: "#635bff" }}>stripe</span>
        </p>
      </div>
    );
  }

  if (expired) {
    return (
      <div className="flex flex-col gap-4 items-center text-center">
        <p className="text-[13px] font-semibold" style={{ color: "#0f1f42" }}>QR code expired</p>
        <p className="text-[11px]" style={{ color: "#8b8f9a" }}>The PayNow QR has expired. Generate a new one to continue.</p>
        <button
          className="w-full py-3 rounded-[8px] text-[12.5px] font-bold text-white"
          style={{ background: "#0f1f42" }}
          onClick={handleGenerateQR}
        >
          Generate New QR
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[12px] text-center" style={{ color: "#8b8f9a" }}>
        A PayNow QR code will be generated for SGD {totalAmount.toLocaleString()}.
      </p>
      {error && (
        <div className="p-3 rounded-lg border text-[12px]" style={{ background: "#fff5f5", borderColor: "#fca5a5", color: "#991b1b" }}>{error}</div>
      )}
      <button
        className="w-full py-3 rounded-[8px] text-[12.5px] font-bold text-white disabled:opacity-60"
        style={{ background: "#0f1f42" }}
        onClick={handleGenerateQR}
        disabled={paying}
      >
        {paying ? "Generating QR..." : "Pay via PayNow"}
      </button>
      <p className="text-center text-[9.5px]" style={{ color: "#aca795" }}>
        Secured by <span className="font-bold" style={{ color: "#635bff" }}>stripe</span>
      </p>
    </div>
  );
}

// ─── Payment Page ─────────────────────────────────────────────────────────────

function PaymentContent() {
  const params = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const ref = searchParams.get("ref") ?? "";
  const piId = searchParams.get("pi") ?? "";

  const [tab, setTab] = useState<"card" | "paynow">("card");
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [totalAmount, setTotalAmount] = useState(0);
  const [orgName, setOrgName] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    // Try sessionStorage first (set by Screen 2)
    const stored = sessionStorage.getItem(`cs_${ref}`);
    if (stored) { setClientSecret(stored); }

    // Always fetch summary for totalAmount + orgName (and clientSecret fallback)
    fetch(`/api/public/enrollment/${ref}`)
      .then((r) => r.json())
      .then((d) => {
        setTotalAmount(d.total_amount ?? 0);
        setOrgName(d.event_name ?? "");
        if (!stored && d.stripe_client_secret) setClientSecret(d.stripe_client_secret);
        if (!stored && !d.stripe_client_secret) setLoadError("Payment session not found. Please go back and try again.");
      })
      .catch(() => setLoadError("Failed to load payment details."));
  }, [ref]);

  if (loadError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-5" style={{ background: "#f7f5ef" }}>
        <p className="text-[13px]" style={{ color: "#0f1f42" }}>{loadError}</p>
        <a href={`/enroll/${params.slug}/tickets/`} className="text-[12px] underline" style={{ color: "#b7912b" }}>
          Return to event page
        </a>
      </div>
    );
  }

  if (!clientSecret) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#f7f5ef" }}>
        <div className="w-5 h-5 border-2 rounded-full animate-spin" style={{ borderColor: "#0f1f42", borderTopColor: "transparent" }} />
      </div>
    );
  }

  return (
    <TrustedOfficialShell orgName={orgName} step={2}>
      {/* Total due card */}
      <div className="flex items-center justify-between rounded-[10px] px-4 py-3 mb-5" style={{ border: "1px solid #e3e0d6", background: "#fbfaf6" }}>
        <span className="text-[11.5px]" style={{ color: "#8b8f9a" }}>Total due</span>
        <span className="text-[19px] font-extrabold" style={{ color: "#0f1f42" }}>SGD {totalAmount.toLocaleString()}</span>
      </div>

      {/* Method toggle */}
      <div className="flex rounded-[7px] overflow-hidden mb-5" style={{ border: "1.5px solid #d8d5c9" }}>
        {(["card", "paynow"] as const).map((t) => (
          <button
            key={t}
            className="flex-1 py-2 text-[11px] font-bold uppercase tracking-wide transition-colors"
            style={{
              background: tab === t ? "#0f1f42" : "transparent",
              color: tab === t ? "#ffffff" : "#43485a",
            }}
            onClick={() => setTab(t)}
          >
            {t === "card" ? "CARD" : "PAYNOW"}
          </button>
        ))}
      </div>

      {/* Payment UI */}
      {tab === "card" ? (
        <Elements stripe={stripePromise} options={{ clientSecret }}>
          <CardForm slug={params.slug} enrollmentRef={ref} totalAmount={totalAmount} />
        </Elements>
      ) : (
        <PayNowTab
          slug={params.slug}
          enrollmentRef={ref}
          piId={piId}
          clientSecret={clientSecret}
          totalAmount={totalAmount}
        />
      )}
    </TrustedOfficialShell>
  );
}

export default function PaymentPage() {
  return (
    <Suspense>
      <PaymentContent />
    </Suspense>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
npm run build 2>&1 | tail -20
```

- [ ] **Step 3: Manual smoke test**

1. Complete Screens 1–2 to reach the payment page.
2. **Card tab:** Stripe PaymentElement should render card fields. Use Stripe test card `4242 4242 4242 4242`, any future expiry, any CVC. Should redirect to success page.
3. **PayNow tab:** Click "Pay via PayNow" — should display QR and countdown. (PayNow cannot be tested in browser without a real SGD bank account; confirm QR renders.)
4. Check dev Supabase: on card success, `payments.status` = `verified`, `enrollments.status` = `confirmed`.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(public)/enroll/[slug]/checkout/payment/"
git commit -m "feat(ui): Screen 3 — card + PayNow payment with Stripe Elements"
```

---

## Task 11: Screen 4 — Success / E-Ticket

**Files:**
- Create: `src/app/(public)/enroll/[slug]/checkout/success/page.tsx`

- [ ] **Step 1: Create the page**

```tsx
"use client";

import { Suspense, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import TrustedOfficialShell from "@/components/enrollment/TrustedOfficialShell";

interface EnrollmentData {
  enrollment_ref: string;
  status: string;
  student_name_en: string;
  total_amount: number;
  items: { level: string; quantity: number; fee_amount: number }[];
  event_name: string;
  card_brand?: string | null;
  card_last4?: string | null;
  payment_method?: string;
}

function SuccessContent() {
  const params = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const ref = searchParams.get("ref") ?? "";
  const [data, setData] = useState<EnrollmentData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ref) { setError("Missing order reference."); return; }
    // Clean up sessionStorage
    sessionStorage.removeItem(`cs_${ref}`);

    fetch(`/api/public/enrollment/${ref}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setData(d);
      })
      .catch(() => setError("Failed to load order details."));
  }, [ref]);

  if (error || !data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-5" style={{ background: "#f7f5ef" }}>
        <p className="text-[13px]" style={{ color: "#0f1f42" }}>{error ?? "Loading..."}</p>
      </div>
    );
  }

  const isPayNow = data.payment_method === "paynow";
  const paymentLabel = isPayNow
    ? "PayNow"
    : data.card_brand && data.card_last4
    ? `${data.card_brand.charAt(0).toUpperCase() + data.card_brand.slice(1)} ••${data.card_last4}`
    : "Credit Card";

  const ticketSummary = data.items.map((i) => `${i.level} × ${i.quantity}`).join(", ");

  return (
    <TrustedOfficialShell orgName={data.event_name} step="complete">
      {/* Checkmark badge */}
      <div className="flex flex-col items-center mb-5 mt-2">
        <div
          className="w-[42px] h-[42px] rounded-full flex items-center justify-center mb-3"
          style={{ background: "#0f1f42" }}
        >
          <svg width="18" height="14" viewBox="0 0 18 14" fill="none">
            <path d="M1.5 7L6.5 12L16.5 2" stroke="#d4af5a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h1 className="text-[14px] font-extrabold" style={{ color: "#0f1f42" }}>
          {isPayNow ? "PayNow payment received" : "Payment successful"}
        </h1>
        <p className="text-[10.5px] mt-0.5" style={{ color: "#8b8f9a" }}>E-tickets sent to your email</p>
      </div>

      {/* Ticket stub */}
      <div
        className="rounded-[12px] p-4 mb-4 relative overflow-hidden"
        style={{ background: "#0f1f42" }}
      >
        {/* Perforation strip — right edge */}
        <div
          className="absolute right-0 top-0 bottom-0 w-[6px]"
          style={{
            background: "repeating-linear-gradient(to bottom, #f7f5ef 0px, #f7f5ef 8px, #0f1f42 8px, #0f1f42 14px)",
          }}
        />
        <p className="text-[9px] font-bold tracking-[1.8px] uppercase mb-2" style={{ color: "#d4af5a" }}>
          {data.event_name}
        </p>
        <p className="text-[14px] font-extrabold text-white mb-1">{ticketSummary}</p>
        <hr className="my-3" style={{ borderColor: "rgba(255,255,255,.25)", borderStyle: "dashed" }} />
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[8.5px] mb-0.5" style={{ color: "#8a90a5" }}>ORDER REF</p>
            <p className="text-[13px] font-extrabold text-white">{data.enrollment_ref}</p>
          </div>
          {/* QR placeholder */}
          <div
            className="w-[42px] h-[42px] rounded-[4px]"
            style={{
              background: "repeating-linear-gradient(45deg, #fff 0px, #fff 4px, #0f1f42 4px, #0f1f42 8px)",
              opacity: 0.2,
            }}
          />
        </div>
      </div>

      {/* Payment summary */}
      <div className="rounded-[9px] p-4 mb-5" style={{ background: "#ffffff", border: "1px solid #e3e0d6" }}>
        <div className="flex justify-between text-[12px] mb-2">
          <span style={{ color: "#8b8f9a" }}>Amount paid</span>
          <span className="font-bold" style={{ color: "#0f1f42" }}>SGD {data.total_amount.toLocaleString()}</span>
        </div>
        <div className="flex justify-between text-[12px]">
          <span style={{ color: "#8b8f9a" }}>Payment method</span>
          <span className="font-bold" style={{ color: "#0f1f42" }}>{paymentLabel}</span>
        </div>
      </div>

      {/* Download CTA */}
      <button
        className="w-full py-3 rounded-[8px] text-[11.5px] font-bold cursor-not-allowed"
        style={{ border: "1.5px solid #0f1f42", color: "#0f1f42", background: "transparent" }}
        disabled
        title="Coming soon"
      >
        DOWNLOAD E-TICKET
      </button>
    </TrustedOfficialShell>
  );
}

export default function SuccessPage() {
  return (
    <Suspense>
      <SuccessContent />
    </Suspense>
  );
}
```

**Note:** The `GET /api/public/enrollment/[ref]` response does not currently return `payment_method`, `card_brand`, or `card_last4`. Update the GET route to also select from `payments` and include these fields in the response. Add to the SELECT in Task 2's GET handler:

```ts
// In the GET route, expand the payments select to include card fields:
payments(stripe_payment_intent_id, status, payment_method, card_brand, card_last4)

// And add to the response JSON:
payment_method: (enrollment.payments as PaymentRow[] | null)?.find((p) => p.status === "verified")?.payment_method ?? null,
card_brand: (enrollment.payments as PaymentRow[] | null)?.find((p) => p.status === "verified")?.card_brand ?? null,
card_last4: (enrollment.payments as PaymentRow[] | null)?.find((p) => p.status === "verified")?.card_last4 ?? null,
```

- [ ] **Step 2: Update GET route to return payment method + card details**

Edit `src/app/api/public/enrollment/[ref]/route.ts`:
- Add `card_brand`, `card_last4` to `PaymentRow` type.
- Expand the `payments(...)` select to include `card_brand, card_last4`.
- Add `payment_method`, `card_brand`, `card_last4` fields to the `NextResponse.json(...)` return.

- [ ] **Step 3: Type-check**

```bash
npm run build 2>&1 | tail -20
```

- [ ] **Step 4: Manual smoke test**

1. Complete a full card payment flow (Screens 1→2→3→4).
2. Screen 4 should show: checkmark, "Payment successful", ticket stub with correct ref, payment summary with "Visa ••4242".
3. "DOWNLOAD E-TICKET" button should be visible but disabled.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(public)/enroll/[slug]/checkout/success/" src/app/api/public/enrollment/
git commit -m "feat(ui): Screen 4 — success/e-ticket page + GET route returns card details"
```

---

## Task 12: Wire Template Detection in /enroll/[slug]/page.tsx

**Files:**
- Modify: `src/app/(public)/enroll/[slug]/page.tsx`

- [ ] **Step 1: Add redirect before the `newStyleIds` block (around line 295)**

Find the comment `// Determine which template to render.` (around line 295). Add the redirect check immediately before it:

```ts
// Redirect ev-trusted-official to its dedicated ticket-selection page
if (appearance.template_id === "ev-trusted-official") {
  router.replace(`/enroll/${params.slug}/tickets/`);
  return null;
}

// Determine which template to render.
// If appearance has a new-style template_id use it; otherwise fall back by org type.
const newStyleIds = [...];
```

- [ ] **Step 2: Type-check**

```bash
npm run build 2>&1 | tail -20
```

- [ ] **Step 3: Set template_id in dev Supabase**

In Supabase dashboard → `tenant_appearance` → find your test tenant → set `template_id = 'ev-trusted-official'`.

- [ ] **Step 4: Manual end-to-end test**

1. Visit `http://localhost:3005/enroll/[slug]/` — should redirect to `/enroll/[slug]/tickets/`.
2. Complete full flow: tickets → checkout → payment (test card `4242 4242 4242 4242`) → success.
3. Verify in Supabase: `enrollments.status = 'confirmed'`, `payments.status = 'verified'`, `payments.card_brand = 'visa'`, `payments.card_last4 = '4242'`.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(public)/enroll/[slug]/page.tsx"
git commit -m "feat: detect ev-trusted-official template and redirect to /tickets/ route"
```

---

## Task 13: Final Build Verification + Checklist

- [ ] **Step 1: Clean build**

```bash
npm run build
```

Expected: build succeeds with no TypeScript errors in the new files.

- [ ] **Step 2: End-to-end manual checklist**

Run `npm run dev` and verify each screen against the design spec:

**Screen 1 (Ticket Selection)**
- [ ] Cream background `#f7f5ef`
- [ ] Brand row: logo mark + org name
- [ ] Gold-ruled title block with "Select Your Ticket"
- [ ] Standard ticket cards: white bg, neutral border
- [ ] First card (when >1 ticket type): cream bg, gold border, "POPULAR" badge
- [ ] Quantity steppers: bordered pill −/qty/+, live subtotal
- [ ] Sticky cart bar appears when qty > 0: ticket count + total + "CONTINUE →"
- [ ] "CONTINUE →" creates enrollment and redirects to `/checkout/`

**Screen 2 (Attendee Details)**
- [ ] "STEP 1 OF 2" label + 1 gold segment progress bar
- [ ] Order summary card: cream bg, gold border, line items
- [ ] "YOUR DETAILS" section label with bottom border
- [ ] Full Name, Company (optional), Email fields with correct border behavior
- [ ] "CONTINUE TO PAYMENT →" saves details and redirects

**Screen 3 (Payment)**
- [ ] "STEP 2 OF 2" label + both segments gold
- [ ] Total due card: cream bg, large amount
- [ ] Card/PayNow toggle: navy active, white inactive
- [ ] Card tab: Stripe PaymentElement renders, pay button works
- [ ] PayNow tab: "Pay via PayNow" button → QR + countdown + polling
- [ ] Stripe security note visible on both tabs

**Screen 4 (Success)**
- [ ] Navy checkmark badge
- [ ] Correct heading ("Payment successful" vs "PayNow payment received")
- [ ] Navy ticket stub with ref and perforation effect
- [ ] Payment summary: amount + payment method
- [ ] "DOWNLOAD E-TICKET" button: disabled, no cursor-pointer

**Existing flows (regression check)**
- [ ] Visit `/enroll/[another-slug]/` for a non–trusted-official tenant — should render existing template as before
- [ ] `/enroll/form/` still works (MMQR flow unaffected)
- [ ] `/enroll/payment/[ref]/` still works

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: EvTrustedOfficial enrollment flow — complete 4-screen Stripe card + PayNow"
```

---

## Notes for the Implementer

- **PayNow in test mode:** Stripe's test mode does not fully simulate PayNow QR scanning. The QR will render, but you cannot complete payment without a real SGD PayNow-enabled account. Card payment testing works fully with test card `4242 4242 4242 4242`.
- **PayNow `next_action` shape:** The `paynow_display_qr_code` object shape is defined in Stripe's types but may require `as unknown as ...` casting if TypeScript complains — follow the existing `as never` pattern in this codebase.
- **`auto_cancel_minutes`:** Ensure the test tenant has `auto_cancel_minutes` set to at least 15 (minutes) so enrollments aren't cancelled before you finish testing the flow.
- **Stripe publishable key:** Must be set in `.env.local` as `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`. The secret key (`STRIPE_SECRET_KEY`) must also be present.
- **Migration to prod:** Once tested on dev, apply migration 084 to the prod DB by temporarily linking Supabase CLI to the prod project ref — follow the dual-DB procedure in MEMORY.md.
