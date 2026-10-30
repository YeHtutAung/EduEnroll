import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import {
  buildReferenceNo,
  createDynamicQr,
  getCbMerchant,
  type CallBudget,
  type CbMerchant,
} from "@/lib/cbmmqr";
import { resolveCbmmqrOrder } from "@/server/payments/resolveCbmmqrOrder";
import {
  enrollmentDeadline,
  postCheck,
  preCheck,
  provisionalExpiry,
} from "@/server/payments/cbmmqrOrderWindow";
import { attachPackSizes, computeOrderTotal } from "@/server/payments/platformFee";

// Same 10s Vercel cap as the KBZPay route; declared so it is visible.
export const maxDuration = 10;
const GATEWAY_BUDGET_MS = 8_000;

/** CB's §4.2 code 0051: "The payment amount must be at least 1000." */
const CB_MIN_AMOUNT = 1000;

// ─── POST /api/public/payments/cbmmqr ───────────────────────────────────────
// Design: docs/superpowers/specs/2026-10-31-cb-mmqr-integration-design.md §5.1
//
// Body: { enrollmentRef: string }
// 200 { status: 'created', qr, orderId, amount, expiresAt } | { status: 'already_paid' }
// Every other answer is an error with a `message` the modal shows as is.

type EnrollmentRow = {
  id: string;
  enrollment_ref: string;
  tenant_id: string;
  class_id: string | null;
  quantity: number | null;
  status: string;
  enrolled_at: string | null;
  classes: { id: string; fee_amount: number; level: string } | null;
  enrollment_items: { class_id: string; quantity: number; fee_amount: number }[] | null;
};

type ClaimRow = {
  outcome: string;
  payment_id: string | null;
  ref: string | null;
  qr: string | null;
  merchant: string | null;
  expires_at: string | null;
  order_ref: string | null;
  created_at: string | null;
};
type ReplaceRow = { outcome: string; payment_id: string | null; merchant: string | null };

const fail = (status: number, message: string, error: string) =>
  NextResponse.json({ error, message }, { status });

const gatewayError = () => fail(502, "Failed to generate QR code. Please try again.", "Payment Gateway Error");
const notConfigured = () => fail(503, "Payment is not available for this event yet.", "Service Unavailable");
const notAwaiting = () => fail(409, "This enrollment is not awaiting payment.", "Conflict");
const belowMinimum = () => fail(422, "CB Bank QR payments need at least 1,000 MMK.", "Unprocessable Entity");
const aboveMaximum = () =>
  fail(422, "This amount is above CB Bank's QR payment limit. Please contact the organiser.", "Unprocessable Entity");
const deadlineConflict = () =>
  fail(409, "This booking expires too soon for a QR payment. Please start a new booking.", "Conflict");

function qrActive(retryAtMs: number) {
  const minutes = Math.max(1, Math.ceil((retryAtMs - Date.now()) / 60_000));
  return NextResponse.json(
    {
      error: "Conflict",
      status: "qr_active",
      retryAt: new Date(retryAtMs).toISOString(),
      message: `Your previous QR is still active. Scan it if you still have it, or try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    },
    { status: 409 },
  );
}

function resolveMerchant(id: string | null, context: string): CbMerchant | null {
  try {
    return getCbMerchant(id);
  } catch (err) {
    console.error(`[cbmmqr] merchant config error for ${context}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** As the KBZPay route: a budget only where a platform caps the request. */
function gatewayBudget(): CallBudget | undefined {
  if (!process.env.VERCEL) return undefined;
  return { deadlineMs: Date.now() + GATEWAY_BUDGET_MS };
}

export async function POST(request: NextRequest) {
  const budget = gatewayBudget();

  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  // ── 1. Parse ───────────────────────────────────────────────
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

  // ── 2. Enrollment ──────────────────────────────────────────
  const { data: enrollment, error: enrollmentError } = (await supabase
    .from("enrollments")
    .select("*, classes(id, fee_amount, level), enrollment_items(class_id, quantity, fee_amount)")
    .eq("enrollment_ref", enrollmentRef.trim())
    .eq("tenant_id", tenantId)
    .single()) as { data: EnrollmentRow | null; error: unknown };

  if (enrollmentError || !enrollment) return fail(404, "Enrollment not found.", "Not Found");

  // ── 3. Guard (re-proven under the claim's lock) ────────────
  if (enrollment.status !== "pending_payment" && enrollment.status !== "partial_payment") {
    return notAwaiting();
  }

  // ── 4. Tenant settings and the pre-check (spec §5.1 step 4) ─
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

  // Fail closed: without the tenant row we do not know the deadline.
  if (tenantError || !tenant) {
    console.error(`[cbmmqr] tenant ${enrollment.tenant_id} lookup failed; refusing to guess the deadline`);
    return gatewayError();
  }

  const deadline = enrollmentDeadline(tenant.auto_cancel_hours, enrollment.enrolled_at);
  const pre = preCheck(deadline, Date.now());
  if (pre === "unknown") {
    console.error(`[cbmmqr] cannot derive the deadline for ${enrollment.enrollment_ref}; refusing to guess`);
    return gatewayError();
  }
  if (pre === "too_close") return deadlineConflict();

  // ── 5. Total, exactly as the KBZPay route ──────────────────
  const isCart =
    !enrollment.class_id && enrollment.enrollment_items && enrollment.enrollment_items.length > 0;
  const orderItems = isCart
    ? enrollment.enrollment_items!.map((i) => ({ class_id: i.class_id, fee_amount: i.fee_amount, quantity: i.quantity }))
    : enrollment.classes
      ? [{ class_id: enrollment.classes.id, fee_amount: enrollment.classes.fee_amount, quantity: enrollment.quantity ?? 1 }]
      : null;
  if (!orderItems) return fail(500, "Class data not found.", "Internal Server Error");

  const order = computeOrderTotal(await attachPackSizes(supabase, orderItems, tenant), tenant);
  let totalFee = order.total;
  let recordedFee = order.platformFee;

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
      recordedFee = 0;
    }
  }

  // ── 6. CB's minimum, before any row or call ────────────────
  if (totalFee < CB_MIN_AMOUNT) return belowMinimum();

  // ── 7. Claim the slot ──────────────────────────────────────
  const claimed = await claimSlot();
  if (claimed instanceof NextResponse) return claimed;

  if (claimed.outcome === "no_merchant") {
    console.error(`[cbmmqr] tenant ${enrollment.tenant_id} has no CB merchant assigned`);
    return notConfigured();
  }

  // The pinned merchant, before ANY branch — including reuse: a merchant whose
  // config is broken must not keep handing out QRs we cannot verify.
  let merchant = resolveMerchant(claimed.merchant, claimed.ref ?? enrollment.enrollment_ref);
  if (!merchant) return notConfigured();

  if (claimed.outcome === "reuse") {
    return NextResponse.json({
      status: "created",
      qr: claimed.qr,
      orderId: claimed.ref,
      amount: totalFee,
      expiresAt: claimed.expires_at,
    });
  }

  if (claimed.outcome !== "created" && claimed.outcome !== "unresolved") {
    console.error(`[cbmmqr] unexpected claim outcome "${claimed.outcome}"; refusing to call CB`);
    return gatewayError();
  }

  let ref = claimed.ref;

  // ── 8. Unresolved → ask CB, never assume (spec §5.2) ───────
  if (claimed.outcome === "unresolved") {
    const oldRef = claimed.ref!;
    const resolution = await resolveCbmmqrOrder({
      row: {
        ref: oldRef,
        orderRef: claimed.order_ref,
        expiresAtMs: claimed.expires_at ? Date.parse(claimed.expires_at) : null,
        createdAtMs: claimed.created_at ? Date.parse(claimed.created_at) : Date.now(),
      },
      merchant,
      source: "create",
      budget,
    });

    if (resolution.kind === "already_paid") return NextResponse.json({ status: "already_paid" });
    if (resolution.kind === "settlement_conflict") {
      return fail(409, "A previous payment for this enrollment needs review. Please contact support.", "Conflict");
    }
    if (resolution.kind === "active") return qrActive(resolution.retryAtMs);
    if (resolution.kind === "blocked") {
      console.error(`[cbmmqr] resolve blocked for ${oldRef}: ${resolution.reason}`);
      return gatewayError();
    }

    // retire — CB proved the old QR dead (or it was never displayed).
    const newRef = buildReferenceNo();
    const { data, error } = (await supabase.rpc("complete_cbmmqr_replace", {
      p_enrollment_id: enrollment.id,
      p_tenant_id: enrollment.tenant_id,
      p_expected_old_ref: oldRef,
      p_reason: resolution.reason,
      p_new_ref: newRef,
      p_amount: totalFee,
      p_platform_fee: recordedFee,
      p_expires_at: new Date(provisionalExpiry(Date.now())).toISOString(),
    } as never)) as { data: ReplaceRow[] | null; error: { message: string } | null };

    if (error || !data?.length) {
      console.error(`[cbmmqr] replace failed for ${oldRef}: ${error?.message ?? "no rows"}`);
      return gatewayError();
    }
    const outcome = data[0].outcome;
    if (outcome === "already_settled") return NextResponse.json({ status: "already_paid" });
    if (outcome === "settling") {
      // CB reported the old order paid and settlement is finishing. Never a new QR.
      return fail(409, "We have received a payment for this booking and are confirming it. Please wait a moment.", "Conflict");
    }
    if (outcome === "not_payable" || outcome === "invalid_enrollment") return notAwaiting();
    if (outcome === "no_merchant") return notConfigured();
    if (outcome !== "replaced") {
      console.error(`[cbmmqr] replace returned ${outcome} for ${oldRef}`);
      return gatewayError();
    }

    ref = newRef;
    const next = resolveMerchant(data[0].merchant, newRef);
    if (!next) return notConfigured();
    merchant = next;
  }

  if (!ref) {
    console.error("[cbmmqr] no payment_ref after claim/replace; refusing to call CB");
    return gatewayError();
  }

  // ── 9. Ask CB for the QR. The row already exists (R2). ─────
  const created = await createDynamicQr(
    merchant,
    { referenceNo: ref, amount: totalFee, purpose: `Payment ${enrollment.enrollment_ref}` },
    budget,
  );

  if (created.kind === "ambiguous") {
    // NOT marked FAILED: CB may hold a QR under this reference (R13). §5.2
    // frees the slot later; the QR was never shown, so nobody can pay it.
    console.error(`[cbmmqr] create ambiguous for ${ref} (code ${created.code ?? "none"}); row left PENDING`);
    return gatewayError();
  }

  if (created.kind === "rejected") {
    // CB created nothing, so the slot can be freed now.
    const { error: markError } = (await supabase
      .from("payments")
      .update({ mmqr_status: "FAILED" } as never)
      .eq("payment_ref", ref)
      .eq("mmqr_status", "PENDING")) as { error: { message: string } | null };
    if (markError) console.error(`[cbmmqr] could not mark ${ref} FAILED: ${markError.message}`);
    console.error(`[cbmmqr] CB rejected ${ref} with ${created.code} (${created.reason})`);
    if (created.reason === "below_minimum") return belowMinimum();
    if (created.reason === "above_maximum") return aboveMaximum();
    return notConfigured();
  }

  // ── 10. Post-check, then store through the locking RPC ─────
  const displayable = postCheck(deadline, created.expiresAtMs) === "ok";
  const expiresAtIso = new Date(created.expiresAtMs ?? provisionalExpiry(Date.now())).toISOString();

  const { data: stored, error: storeError } = (await supabase.rpc("store_cbmmqr_qr", {
    p_payment_ref: ref,
    p_qr: displayable ? created.qr : null,
    p_order_ref: created.qrReferenceNo,
    p_expires_at: expiresAtIso,
  } as never)) as { data: string | null; error: { message: string } | null };

  if (storeError) {
    console.error(`[cbmmqr] store failed for ${ref}: ${storeError.message}; row left PENDING`);
    return gatewayError();
  }
  if (stored === "not_payable") return notAwaiting();
  if (stored !== "stored") {
    console.error(`[cbmmqr] store returned ${stored} for ${ref}`);
    return gatewayError();
  }
  if (!displayable) {
    console.error(`[cbmmqr] QR for ${ref} would outlive its enrollment; withheld`);
    return deadlineConflict();
  }

  return NextResponse.json({
    status: "created",
    qr: created.qr,
    orderId: ref,
    amount: totalFee,
    expiresAt: expiresAtIso,
  });

  // ── Claim with one retry on a lost unique-index race ───────
  async function claimSlot(): Promise<ClaimRow | NextResponse> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data, error } = (await supabase.rpc("claim_cbmmqr_order_slot", {
        p_enrollment_id: enrollment!.id,
        p_tenant_id: enrollment!.tenant_id,
        p_payment_ref: buildReferenceNo(),
        p_amount: totalFee,
        p_platform_fee: recordedFee,
        p_expires_at: new Date(provisionalExpiry(Date.now())).toISOString(),
      } as never)) as { data: ClaimRow[] | null; error: { message: string } | null };

      if (error) {
        if (attempt === 0 && /duplicate key|unique/i.test(error.message)) continue;
        console.error(`[cbmmqr] claim failed: ${error.message}`);
        return gatewayError();
      }
      if (!data?.length) {
        console.error("[cbmmqr] claim returned no rows");
        return gatewayError();
      }
      if (data[0].outcome === "invalid_enrollment") return notAwaiting();
      return data[0];
    }
    return gatewayError();
  }
}
