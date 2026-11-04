import { createAdminClient } from "@/lib/supabase/admin";
import { issueTicketsForEnrollment } from "@/server/tickets/issueTickets";
import { notifyEnrollmentConfirmed } from "@/server/payments/notifyEnrollmentConfirmed";

// ─── Repairing an interrupted settlement ────────────────────────────────────
//
// Recording a payment, issuing tickets and sending the confirmation share one
// request, capped at 10 seconds on the gateway routes. The trigger confirms the
// order when the payment is written, so a request cut off after that leaves a
// paid, confirmed order with no ticket and no email. Only a provider retry could
// reach it, and the status poll stops asking once a payment is verified.
//
// An order with no tickets at all is how that shows up. Partial sets can't happen
// here: tickets for an order go in with one insert.

/** A late email is a surprise, not a confirmation. The ticket is repaired regardless. */
const EMAIL_REPAIR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The gateways whose settlement sends through sendConfirmationOnce. The older
 * webhooks send their own email with no claim, so a repair racing one would be a
 * duplicate: those orders get their ticket here, and no email.
 */
const CLAIMED_CONFIRMATION_METHODS = new Set(["kbzpay_mmqr", "cb_mmqr", "stripe"]);

const SWEEP_ROWS = 1000;
const SWEEP_BUDGET_MS = 45_000;
const SWEEP_CONCURRENCY = 3;

type ClaimResult = "claimed" | "taken" | "unknown";

/**
 * One confirmation per settlement, across the winner and any repair.
 *
 * Compared against this payment's paid_at rather than null, because staff's
 * `request_remaining` also stamps status_notified_at, and that must not cost a
 * part-paid buyer the confirmation for their top-up.
 *
 * Claimed before sending: a request cut off mid-send loses the email rather than
 * risking duplicates from every later poll. The ticket is already on the order
 * page by then.
 */
async function claimConfirmation(enrollmentId: string, paidAt: string): Promise<ClaimResult> {
  try {
    const { data, error } = (await createAdminClient()
      .from("enrollments")
      .update({ status_notified_at: new Date().toISOString() } as never)
      .eq("id", enrollmentId)
      .or(`status_notified_at.is.null,status_notified_at.lt."${paidAt}"`)
      .select("id")) as unknown as { data: { id: string }[] | null; error: { message: string } | null };
    if (error) {
      console.error(`[fulfilment-repair] confirmation claim failed for ${enrollmentId}: ${error.message}`);
      return "unknown";
    }
    return (data?.length ?? 0) > 0 ? "claimed" : "taken";
  } catch (err) {
    console.error(`[fulfilment-repair] confirmation claim failed for ${enrollmentId}:`, err);
    return "unknown";
  }
}

/**
 * For the settlement's winner. A claim that can't be written still sends: the
 * winner has always sent this email, and a duplicate beats none.
 */
export async function sendConfirmationOnce(enrollmentId: string, paidAt: string): Promise<void> {
  if ((await claimConfirmation(enrollmentId, paidAt)) === "taken") return;
  await notifyEnrollmentConfirmed(enrollmentId);
}

/** Never throws: callers are answering a buyer, and the money is already recorded. */
export async function repairInterruptedFulfilment(enrollmentId: string): Promise<void> {
  try {
    const supabase = createAdminClient();

    const { data: enrollment, error: enrollmentError } = (await supabase
      .from("enrollments")
      .select("id, status, internal_test_at, tenants(org_type)")
      .eq("id", enrollmentId)
      .maybeSingle()) as unknown as {
      data: { status: string; internal_test_at: string | null; tenants: { org_type: string | null } | null } | null;
      error: { message: string } | null;
    };
    if (enrollmentError) throw new Error(enrollmentError.message);
    if (
      !enrollment ||
      enrollment.status !== "confirmed" ||
      enrollment.internal_test_at ||
      enrollment.tenants?.org_type !== "event"
    ) {
      return;
    }

    // Any row counts, voided ones included: a voided ticket was voided on purpose.
    const { count, error: ticketsError } = (await supabase
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .eq("enrollment_id", enrollmentId)) as unknown as {
      count: number | null;
      error: { message: string } | null;
    };
    if (ticketsError) throw new Error(ticketsError.message);
    if (count !== 0) return;

    const { data: payment, error: paymentError } = (await supabase
      .from("payments")
      .select("paid_at, payment_method")
      .eq("enrollment_id", enrollmentId)
      .eq("status", "verified")
      .order("paid_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()) as unknown as {
      data: { paid_at: string | null; payment_method: string | null } | null;
      error: { message: string } | null;
    };
    if (paymentError) throw new Error(paymentError.message);
    if (!payment) return;

    await issueTicketsForEnrollment(enrollmentId);
    console.warn(`[fulfilment-repair] issued missing tickets for ${enrollmentId}`);

    // Staff approval records no paid_at and sends its own email.
    if (!payment.paid_at) return;
    if (!CLAIMED_CONFIRMATION_METHODS.has(payment.payment_method ?? "")) return;
    if (Date.now() - Date.parse(payment.paid_at) > EMAIL_REPAIR_WINDOW_MS) return;

    // Unlike the winner, this may be a poll racing it, so only a real claim sends.
    if ((await claimConfirmation(enrollmentId, payment.paid_at)) !== "claimed") return;
    await notifyEnrollmentConfirmed(enrollmentId);
  } catch (err) {
    console.error(
      `[fulfilment-repair] repair failed for ${enrollmentId}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

export interface FulfilmentSweepCounts {
  checked: number;
  repaired: number;
  readFailed: boolean;
}

/** The backstop for a buyer who closed the page. Looks back as far as an email would still go. */
export async function sweepInterruptedFulfilment(): Promise<FulfilmentSweepCounts> {
  const started = Date.now();
  const supabase = createAdminClient();
  const failed: FulfilmentSweepCounts = { checked: 0, repaired: 0, readFailed: true };

  const { data: paid, error: paidError } = (await supabase
    .from("payments")
    .select("enrollment_id, enrollments!inner(status, internal_test_at, tenants!inner(org_type))")
    .eq("status", "verified")
    .gte("paid_at", new Date(started - EMAIL_REPAIR_WINDOW_MS).toISOString())
    .eq("enrollments.status", "confirmed")
    .is("enrollments.internal_test_at", null)
    .eq("enrollments.tenants.org_type", "event")
    .order("paid_at", { ascending: false })
    .limit(SWEEP_ROWS)) as unknown as {
    data: { enrollment_id: string }[] | null;
    error: { message: string } | null;
  };
  if (paidError) {
    console.error(`[fulfilment-repair] paid orders read failed: ${paidError.message}`);
    return failed;
  }

  const ids = Array.from(new Set((paid ?? []).map((p) => p.enrollment_id)));
  if (ids.length === 0) return { checked: 0, repaired: 0, readFailed: false };

  const { data: ticketed, error: ticketsError } = (await supabase
    .from("tickets")
    .select("enrollment_id")
    .in("enrollment_id", ids)) as unknown as {
    data: { enrollment_id: string }[] | null;
    error: { message: string } | null;
  };
  if (ticketsError) {
    console.error(`[fulfilment-repair] tickets read failed: ${ticketsError.message}`);
    return failed;
  }

  const hasTickets = new Set((ticketed ?? []).map((t) => t.enrollment_id));
  const missing = ids.filter((id) => !hasTickets.has(id));

  let repaired = 0;
  for (let i = 0; i < missing.length && Date.now() - started < SWEEP_BUDGET_MS; i += SWEEP_CONCURRENCY) {
    const chunk = missing.slice(i, i + SWEEP_CONCURRENCY);
    await Promise.all(chunk.map((id) => repairInterruptedFulfilment(id)));
    repaired += chunk.length;
  }
  return { checked: ids.length, repaired, readFailed: false };
}
