import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import { platformOrigin } from "@/lib/origin";
import { precreate, buildMerchOrderId, type CallBudget } from "@/lib/kbzpay";
import { resolveKbzpayOrder } from "@/server/payments/resolveKbzpayOrder";
import { orderWindow } from "@/server/payments/kbzpayOrderWindow";
import { computeOrderTotal } from "@/server/payments/platformFee";

// The Vercel plan caps a function at 10s and it cannot be raised, so declare
// it rather than inherit it silently. This route can make FOUR sequential
// gateway calls (queryorder, closeorder, queryorder, precreate), and the old
// 15s per-call timeout was longer than the whole function budget — so on a
// blocked connection the platform killed the function at ~10s and returned a
// raw 502, and the handled error below could never run. Seen twice on staging
// at 10.87s and 10.82s.
export const maxDuration = 10;

/**
 * How much of the function budget the gateway may consume, leaving room for
 * the database work and the response after it.
 */
const GATEWAY_BUDGET_MS = 8_000;

// ─── POST /api/public/payments/kbzpay ───────────────────────────────────────
// Creates a KBZPay MMQR order and returns a QR string for the user to scan.
// Design: docs/superpowers/specs/2026-08-20-kbzpay-mmqr-integration-design.md §5.1
//
// Body: { enrollmentRef: string }
//
// Two shapes come back, discriminated by `status` (§5.1a):
//   { status: 'created',      qr, orderId, amount }
//   { status: 'already_paid' }
//
// No settleMmqrPayment result object ever reaches the browser — the route
// translates, always.

/**
 * Origin KBZPay will POST its payment notification to.
 *
 * `KBZPAY_NOTIFY_ORIGIN` exists because the callback host has to be registered
 * with KBZPay per environment, and the host they register must match what we
 * send with each order. It is an operator-set, fixed value per deployment —
 * NOT derived from the request or from whichever tenant is checking out.
 *
 * That distinction is the point (spec §7). A tenant-derived host could be a
 * custom domain the tenant controls and might remove, which would strand
 * in-flight payments and would mean registering every new tenant domain with
 * KBZPay. `platformOrigin()` remains the fallback, so an unset variable is
 * safe rather than broken.
 */
function notifyOrigin(): string {
  const configured = process.env.KBZPAY_NOTIFY_ORIGIN;
  if (!configured) return platformOrigin();

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    // A malformed value must not silently become a relative or empty URL —
    // fall back to the known-good platform origin and say so.
    console.error("[kbzpay] KBZPAY_NOTIFY_ORIGIN is not a valid URL; using platformOrigin()");
    return platformOrigin();
  }

  // HTTPS only. `new URL()` happily accepts http:, ftp: and file:, and .origin
  // would return them unchanged — or the literal string "null" for opaque
  // schemes like file:, producing a notify_url of "null/api/webhooks/kbzmmqr".
  // The callback carries payment notifications and must not be delivered over
  // plaintext, so anything other than https falls back rather than being sent
  // to KBZPay.
  //
  // The platformOrigin() fallback is deliberately NOT scheme-checked: it is the
  // app's own configured origin, is http://localhost in local development, and
  // no provider can reach that host anyway.
  if (parsed.protocol !== "https:") {
    console.error(
      `[kbzpay] KBZPAY_NOTIFY_ORIGIN must use https (got ${parsed.protocol}); ` +
        `using platformOrigin()`,
    );
    return platformOrigin();
  }

  return parsed.origin;
}

type EnrollmentRow = {
  id: string;
  enrollment_ref: string;
  tenant_id: string;
  class_id: string | null;
  quantity: number | null;
  status: string;
  enrolled_at: string | null;
  student_name_en: string;
  classes: { id: string; fee_amount: number; level: string } | null;
  enrollment_items: { class_id: string; quantity: number; fee_amount: number }[] | null;
};

type ClaimRow = { outcome: string; payment_id: string | null; ref: string | null; qr: string | null };
type SupersedeRow = { outcome: string; payment_id: string | null };

const fail = (status: number, message: string, error: string) =>
  NextResponse.json({ error, message }, { status });

const gatewayError = () =>
  fail(502, "Failed to generate QR code. Please try again.", "Payment Gateway Error");

/**
 * The request budget, or none when nothing is capping the request.
 *
 * The budget exists solely to respect a serverless function limit. Running
 * locally there is no such limit, and clamping to an imaginary one is actively
 * harmful: the first gateway call of a session pays a ~9.5s connection cost,
 * and an 8s budget aborts it. That broke local UAT until it was measured.
 *
 * VERCEL is set on every Vercel runtime and unset locally, which is exactly
 * the distinction that matters here.
 */
function gatewayBudget(): CallBudget | undefined {
  if (!process.env.VERCEL) return undefined;
  return { deadlineMs: Date.now() + GATEWAY_BUDGET_MS };
}

export async function POST(request: NextRequest) {
  const budget = gatewayBudget();

  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  // ── 1. Parse body ──────────────────────────────────────────
  let body: { enrollmentRef?: string };
  try {
    body = await request.json();
  } catch {
    return fail(400, "Invalid JSON body.", "Bad Request");
  }

  const { enrollmentRef } = body;
  if (!enrollmentRef || typeof enrollmentRef !== "string") {
    return fail(400, "enrollmentRef is required.", "Bad Request");
  }

  const supabase = createAdminClient();

  // ── 2. Look up enrollment ──────────────────────────────────
  const { data: enrollment, error: enrollmentError } = (await supabase
    .from("enrollments")
    .select("*, classes(id, fee_amount, level), enrollment_items(class_id, quantity, fee_amount)")
    .eq("enrollment_ref", enrollmentRef.trim())
    .eq("tenant_id", tenantId)
    .single()) as { data: EnrollmentRow | null; error: unknown };

  if (enrollmentError || !enrollment) {
    return fail(404, "Enrollment not found.", "Not Found");
  }

  // ── 3. Guard ───────────────────────────────────────────────
  // A first-pass check only. The claim function re-proves this under its own
  // row lock, because an admin rejection can land between here and there.
  if (enrollment.status !== "pending_payment" && enrollment.status !== "partial_payment") {
    return fail(409, "This enrollment is not awaiting payment.", "Conflict");
  }

  // ── 3a. Order window, from the tenant's auto-cancel setting ─
  const { data: tenant, error: tenantError } = (await supabase
    .from("tenants")
    .select("auto_cancel_hours, payment_mode, platform_fee_mode, platform_fee_amount")
    .eq("id", enrollment.tenant_id)
    .maybeSingle()) as {
    data: {
      auto_cancel_hours: number | null;
      payment_mode: string | null;
      platform_fee_mode: string | null;
      platform_fee_amount: number | null;
    } | null;
    error: { message: string } | null;
  };

  // Fail closed. Falling back to 120m on a failed lookup would silently
  // recreate the exact window this derivation exists to close: a tenant with a
  // 15-minute deadline would get a QR payable for two hours, and the failure
  // would be invisible — a working QR, and money taken later against a rejected
  // enrollment.
  //
  // This is deliberately NOT the same as `auto_cancel_hours: null`. That means
  // the row was read and auto-cancel is disabled, which is a valid state where
  // KBZPay's 120-minute maximum is correct. An absent row or a read error means
  // we do not KNOW the deadline, and guessing it is what causes the harm.
  if (tenantError || !tenant) {
    console.error(
      `[kbzpay] tenant ${enrollment.tenant_id} lookup failed ` +
        `(${tenantError?.message ?? "no row"}); refusing to guess the order window`,
    );
    return gatewayError();
  }

  const win = orderWindow(tenant.auto_cancel_hours, enrollment.enrolled_at, Date.now());

  if (win.kind === "unknown") {
    console.error(
      `[kbzpay] cannot derive the order window for ${enrollment.enrollment_ref} ` +
        `(enrolled_at=${enrollment.enrolled_at ?? "null"}); refusing to guess`,
    );
    return gatewayError();
  }

  // Under a minute left before auto-cancel. Issuing anything here guarantees a
  // QR that outlives its enrollment, so let the expiry process win.
  if (win.kind === "expired") {
    return fail(
      409,
      "This enrollment has expired or is about to. Please start a new one.",
      "Conflict",
    );
  }

  const windowMinutes = win.timeoutMinutes;
  const expiresAtIso = win.expiresAt.toISOString();

  // ── 4. Total fee ───────────────────────────────────────────
  const isCart =
    !enrollment.class_id && enrollment.enrollment_items && enrollment.enrollment_items.length > 0;

  const orderItems = isCart
    ? enrollment.enrollment_items!.map((i) => ({ fee_amount: i.fee_amount, quantity: i.quantity }))
    : enrollment.classes
      ? [{ fee_amount: enrollment.classes.fee_amount, quantity: enrollment.quantity ?? 1 }]
      : null;

  if (!orderItems) return fail(500, "Class data not found.", "Internal Server Error");

  // The online platform fee is added here, never as a second transaction: the
  // gateway is sent one combined amount and settlement compares against it.
  // computeOrderTotal is shared with every other payment route so no two can
  // disagree about the figure — a disagreement means the payer is charged and
  // then refused with amount_mismatch.
  let totalFee = computeOrderTotal(orderItems, tenant ?? {}).total;

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

  // ── 5. Claim the order slot ────────────────────────────────
  const claimed = await claimSlot();
  if (claimed instanceof NextResponse) return claimed;

  let { ref: merchOrderId } = claimed;

  // ── 6. reuse → hand back the stored QR, no provider call ───
  if (claimed.outcome === "reuse") {
    return NextResponse.json({
      status: "created",
      qr: claimed.qr,
      orderId: claimed.ref,
      amount: totalFee,
    });
  }

  // ── 7. unresolved → resolve against KBZPay, then swap ──────
  if (claimed.outcome === "unresolved") {
    const oldRef = claimed.ref!;
    const resolution = await resolveKbzpayOrder({ oldRef, source: "create", budget });

    if (resolution.kind === "already_paid") {
      // §5.1a — the browser contract, not the settlement object (R10/R11/R12).
      return NextResponse.json({ status: "already_paid" });
    }
    if (resolution.kind === "settlement_conflict") {
      return fail(
        409,
        "A previous payment for this enrollment needs review. Please contact support.",
        "Conflict",
      );
    }
    if (resolution.kind === "blocked") {
      console.error(`[kbzpay] resolve blocked for ${oldRef}: ${resolution.reason}`);
      return gatewayError();
    }

    // resolution.kind === 'retire' — the provider confirmed the old order dead.
    const newRef = buildMerchOrderId(enrollment.id);
    const { data, error } = (await supabase.rpc("complete_kbzpay_supersede", {
      p_enrollment_id: enrollment.id,
      p_tenant_id: enrollment.tenant_id,
      p_expected_old_ref: oldRef,
      p_reason: resolution.reason,
      p_new_ref: newRef,
      p_amount: totalFee,
      p_expires_at: expiresAtIso,
      // `as never` matches the convention for RPCs absent from the generated
      // Database types — see settlementConflicts.ts.
    } as never)) as { data: SupersedeRow[] | null; error: { message: string } | null };

    if (error || !data?.length) {
      console.error(`[kbzpay] supersede failed for ${oldRef}: ${error?.message ?? "no rows"}`);
      return gatewayError();
    }

    const outcome = data[0].outcome;

    // A callback settled the old order between the provider query and this
    // transition. Same browser contract as every other already-paid branch.
    if (outcome === "already_settled") {
      return NextResponse.json({ status: "already_paid" });
    }
    if (outcome === "invalid_enrollment") {
      return fail(409, "This enrollment is not awaiting payment.", "Conflict");
    }
    if (outcome !== "replaced") {
      // not_live / not_found — someone else moved it. Never guess; let the
      // student retry, which re-claims from a clean read.
      console.error(`[kbzpay] supersede returned ${outcome} for ${oldRef}`);
      return gatewayError();
    }

    merchOrderId = newRef;
  }

  // ── 8. Create the order at KBZPay ──────────────────────────
  // The local row already exists (step 5 or 7), so the worst case from here is
  // a row with no QR — which nobody can pay — rather than a payable order we
  // have no record of (R2).
  // Both writing branches return a reference; an absent one means the function
  // returned something we do not understand. Fail closed rather than calling
  // KBZPay with an undefined order id.
  if (!merchOrderId) {
    console.error("[kbzpay] no payment_ref after claim/supersede; refusing to call precreate");
    return gatewayError();
  }

  const notifyUrl = `${notifyOrigin()}/api/webhooks/kbzmmqr`;

  const created = await precreate({
    merchOrderId,
    amount: totalFee,
    title: `Payment for ${enrollment.enrollment_ref}`,
    notifyUrl,
    timeoutMinutes: windowMinutes,
  }, budget);

  if (!created.ok) {
    // Deliberately NOT marked FAILED. A failed call proves our REQUEST failed,
    // never that KBZPay created nothing; the response may simply have been
    // lost. Marking it terminal would free the slot and permit a second order
    // beside one KBZPay may already hold. The row stays PENDING and the next
    // request resolves it against the provider (R13).
    console.error(`[kbzpay] precreate failed for ${merchOrderId}; row left PENDING`);
    return gatewayError();
  }

  // ── 9. Store the QR, re-anchored to the response time ──────
  // Anchored here rather than before the request: KBZPay starts its own window
  // when it accepts, so ours must not begin earlier than theirs (R8).
  const { error: qrError } = (await supabase
    .from("payments")
    .update({
      provider_qr: created.qrCode,
      provider_order_expires_at: expiresAtIso,
    } as never)
    .eq("payment_ref", merchOrderId)) as { error: { message: string } | null };

  if (qrError) {
    // Same reasoning as above: the order is live at KBZPay but we could not
    // store its QR, so the slot must stay held and the row stays PENDING.
    console.error(`[kbzpay] provider_qr write failed for ${merchOrderId}: ${qrError.message}`);
    return gatewayError();
  }

  return NextResponse.json({
    status: "created",
    qr: created.qrCode,
    orderId: merchOrderId,
    amount: totalFee,
  });

  // ── Slot claim, with one retry on a lost unique-index race ──
  async function claimSlot(): Promise<ClaimRow | NextResponse> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data, error } = (await supabase.rpc("claim_kbzpay_order_slot", {
        p_enrollment_id: enrollment!.id,
        p_tenant_id: enrollment!.tenant_id,
        p_payment_ref: buildMerchOrderId(enrollment!.id),
        p_amount: totalFee,
        p_expires_at: expiresAtIso,
      } as never)) as { data: ClaimRow[] | null; error: { message: string } | null };

      if (error) {
        // A unique violation means a concurrent request won the slot; re-claim
        // once and we will see their row. Anything else is a real failure.
        if (attempt === 0 && /duplicate key|unique/i.test(error.message)) continue;
        console.error(`[kbzpay] claim failed: ${error.message}`);
        return gatewayError();
      }
      if (!data?.length) {
        console.error("[kbzpay] claim returned no rows");
        return gatewayError();
      }

      const row = data[0];
      if (row.outcome === "invalid_enrollment") {
        // The enrollment stopped being a legal payment target between the
        // guard above and the function's lock (P1 review).
        return fail(409, "This enrollment is not awaiting payment.", "Conflict");
      }
      return row;
    }
    return gatewayError();
  }
}
