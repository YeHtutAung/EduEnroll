// Attempt lifecycle for the creation routes (Plan v18 §3a).
//
// Identity derives from the PREDECESSOR, never a fresh MAX(): both concurrent
// requests replacing the same predecessor derive the same attempt number and
// the same Stripe idempotency key, so Stripe returns the same object and the
// finalizer converges on one row.

import { createAdminClient } from "@/lib/supabase/admin";
import {
  recordConflict,
  recordCleanupConflict,
  completeCleanup,
  type ConflictSource,
  type ConflictType,
} from "./settlementConflicts";
import type { IntegrationFlow } from "@/lib/payments/stripeMetadata";

export type StripePaymentRow = {
  id: string;
  enrollment_id: string;
  tenant_id: string;
  status: string;
  attempt_seq: number;
  integration_flow: string;
  stripe_payment_intent_id: string | null;
  stripe_session_id: string | null;
};

export type AttemptContext =
  | {
      kind: "active";
      /** Exactly one active attempt — the caller checks its provider state. */
      row: StripePaymentRow;
    }
  | {
      kind: "create";
      attemptSeq: number;
      predecessorId: string | null;
      idempotencyKey: string;
    }
  | { kind: "retryable"; reason: string };

/**
 * Select the attempt context for an enrollment. All active Stripe rows are
 * selected — never the newest via LIMIT 1: more than one active row is a
 * reconcile-first state that fails closed here AND in the finalizer (ST001),
 * so even a buggy caller cannot retire one shield and leave another.
 *
 * With no active row, the LATEST attempt (any status) anchors identity: a
 * rejected attempt N is a legitimate anchor for attempt N+1 (L19), and having
 * no rows at all means a first attempt.
 */
export async function selectAttemptContext(
  enrollmentId: string,
  flow: IntegrationFlow,
): Promise<AttemptContext> {
  const supabase = createAdminClient();
  const { data: rows, error } = (await supabase
    .from("payments")
    .select(
      "id, enrollment_id, tenant_id, status, attempt_seq, integration_flow, stripe_payment_intent_id, stripe_session_id",
    )
    .eq("enrollment_id", enrollmentId)
    .eq("payment_method", "stripe")
    .order("attempt_seq", { ascending: false })) as unknown as {
    data: StripePaymentRow[] | null;
    error: { message: string } | null;
  };
  if (error) return { kind: "retryable", reason: `attempt lookup failed: ${error.message}` };

  const all = rows ?? [];
  const active = all.filter((r) => r.status === "awaiting_payment" || r.status === "pending");

  if (active.length > 1) {
    // Plan A shields: silently picking the newest would retire one and leave
    // the other. Reconciled by hand, never absorbed.
    return {
      kind: "retryable",
      reason: `enrollment ${enrollmentId} has ${active.length} active Stripe attempts; reconcile first`,
    };
  }
  if (active.length === 1) {
    return { kind: "active", row: active[0] };
  }

  const latest = all[0] ?? null;
  return {
    kind: "create",
    attemptSeq: latest ? latest.attempt_seq + 1 : 1,
    predecessorId: latest ? latest.id : null,
    idempotencyKey: idempotencyKeyFor(flow, enrollmentId, latest ? latest.id : null),
  };
}

/** Replacement of a known active row: identity anchored on THAT row. */
export function replacementPlan(
  flow: IntegrationFlow,
  row: StripePaymentRow,
): Extract<AttemptContext, { kind: "create" }> {
  return {
    kind: "create",
    attemptSeq: row.attempt_seq + 1,
    predecessorId: row.id,
    idempotencyKey: idempotencyKeyFor(flow, row.enrollment_id, row.id),
  };
}

/** `stripe:{flow}:{enrollment}:initial` or `…:after:{P.id}` — predecessor
 *  identity is stable; a MAX() is not. */
export function idempotencyKeyFor(
  flow: IntegrationFlow,
  enrollmentId: string,
  predecessorId: string | null,
): string {
  return `stripe:${flow}:${enrollmentId}:${predecessorId ? `after:${predecessorId}` : "initial"}`;
}

// ─────────────────────────────────────────────────────────────────────────────

export type FinalizeResult =
  | { kind: "ok"; row: StripePaymentRow }
  | { kind: "conflict"; conflictType: ConflictType }
  | { kind: "retryable"; reason: string };

const ST_TO_CONFLICT: Record<string, ConflictType> = {
  ST002: "replacement_after_verified",
  ST003: "attempt_contract_mismatch",
  ST004: "provider_object_owned",
};

/**
 * Finalize a created provider object into the attempt row, with the §3a
 * typed-failure flow:
 *
 *   ST001 → 500 (caller bug — a log line for us, never a buyer conflict)
 *   ST004 → record (shape i), NEVER cancel — another row owns the object
 *   ST002/ST003, no owner → record `pending` FIRST, cancel, conditional
 *     `pending → done`, only then return the conflict. If the pending write
 *     itself fails, the EMERGENCY branch cancels anyway: ownership already
 *     conclusively returned zero rows, and an unowned payable object with no
 *     record is invisible to every reconciliation query.
 */
export async function finalizeStripeAttempt(args: {
  enrollmentId: string;
  tenantId: string;
  flow: IntegrationFlow;
  attemptSeq: number;
  intentId: string | null;
  sessionId: string | null;
  amountMajor: number;
  amountMinor: number;
  /** The online platform fee included in amountMajor, recorded on the row. */
  platformFee: number;
  currency: string;
  predecessorId: string | null;
  source: ConflictSource;
  /** Cancels/expires the JUST-CREATED provider object. */
  cancelObject: () => Promise<void>;
}): Promise<FinalizeResult> {
  const supabase = createAdminClient();
  const objectId = (args.intentId ?? args.sessionId)!;

  const { data, error } = await supabase.rpc("finalize_stripe_payment_attempt", {
    p_enrollment_id: args.enrollmentId,
    p_tenant_id: args.tenantId,
    p_flow: args.flow,
    p_attempt_seq: args.attemptSeq,
    p_intent_id: args.intentId,
    p_session_id: args.sessionId,
    p_amount: args.amountMajor,
    p_amount_minor: args.amountMinor,
    p_platform_fee: args.platformFee,
    p_currency: args.currency,
    p_predecessor_payment_id: args.predecessorId,
  } as never);

  if (!error) {
    return { kind: "ok", row: data as unknown as StripePaymentRow };
  }

  const code = (error as { code?: string }).code ?? "";
  const conflictType = ST_TO_CONFLICT[code];

  if (code === "ST001" || !conflictType) {
    // Caller bug or ambiguous database failure. The object may or may not be
    // owned — ambiguity is "may be owned": leave it, 500, never cancel.
    return { kind: "retryable", reason: `finalize failed (${code || "unknown"}): ${error.message}` };
  }

  if (code === "ST004") {
    // Another row owns the object — it is someone's live payment. Never
    // cancel; record and surface. recordConflict throws on write failure →
    // route catch → 500.
    await recordConflict({
      objectId,
      conflictType,
      source: args.source,
      enrollmentId: args.enrollmentId,
      expectedAmountMinor: args.amountMinor,
      expectedCurrency: args.currency,
    });
    return { kind: "conflict", conflictType };
  }

  // ST002 / ST003 — resolve ownership of the just-created object.
  const { data: owner, error: ownerError } = (await supabase
    .from("payments")
    .select("id")
    .or(
      args.intentId
        ? `stripe_payment_intent_id.eq.${args.intentId}`
        : `stripe_session_id.eq.${args.sessionId}`,
    )
    .maybeSingle()) as unknown as {
    data: { id: string } | null;
    error: { message: string } | null;
  };
  if (ownerError) {
    // Unknowable ownership → may be owned → leave the object, 500.
    return { kind: "retryable", reason: `ownership lookup failed: ${ownerError.message}` };
  }

  if (owner) {
    // A row owns it (e.g. an earlier retry recorded it) — leave it, record.
    await recordConflict({
      objectId,
      conflictType,
      source: args.source,
      paymentId: owner.id,
      enrollmentId: args.enrollmentId,
      expectedAmountMinor: args.amountMinor,
      expectedCurrency: args.currency,
    });
    return { kind: "conflict", conflictType };
  }

  // Unowned payable object. Record `pending` FIRST — the creation retry
  // cannot be relied on to come back (the ST002 race confirms the enrollment,
  // so the retry 409s at eligibility and never reaches cleanup).
  try {
    await recordCleanupConflict({
      objectId,
      conflictType,
      source: args.source,
      enrollmentId: args.enrollmentId,
      expectedAmountMinor: args.amountMinor,
      expectedCurrency: args.currency,
    });
  } catch (recordErr) {
    // EMERGENCY branch: the write failed, but ownership conclusively returned
    // zero rows — the only argument against cancelling is disproved, and an
    // unowned payable object with no record is invisible. Cancel anyway,
    // return 500. Recovery evidence: this log plus the audit-H sweep.
    console.error(
      `[stripe-attempt] HIGH-SEVERITY: conflict record failed for unowned object ${objectId} (${conflictType}); attempting emergency cancel`,
    );
    try {
      await args.cancelObject();
      console.error(`[stripe-attempt] emergency cancel succeeded for ${objectId}`);
    } catch {
      console.error(
        `[stripe-attempt] emergency cancel FAILED for ${objectId} — unrecorded payable object; audit-H is the recovery path`,
      );
    }
    return {
      kind: "retryable",
      reason: `conflict record failed: ${(recordErr as Error).message}`,
    };
  }

  try {
    await args.cancelObject();
  } catch (cancelErr) {
    // Row stays 'pending' — the durable reconciliation hook. 500.
    return { kind: "retryable", reason: `cleanup cancel failed: ${(cancelErr as Error).message}` };
  }

  const done = await completeCleanup(objectId, conflictType); // throws → route 500
  if (!done) {
    // Another worker moved it or a new sighting re-pended it — re-read is the
    // caller's retry; do not report handled.
    return { kind: "retryable", reason: `cleanup completion lost the race for ${objectId}` };
  }

  return { kind: "conflict", conflictType };
}
