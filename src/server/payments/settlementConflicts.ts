// Settlement-conflict recording (Plan v18 §1a) — thin, typed wrappers over the
// three SECURITY DEFINER functions in 20260722190000. Recording is atomic in
// the database; these wrappers only decide WHICH shape applies and translate
// rpc errors into thrown exceptions so callers fail closed.

import { createAdminClient } from "@/lib/supabase/admin";

export type ConflictType =
  | "rejected_enrollment"
  | "amount_mismatch"
  | "currency_mismatch"
  | "payment_already_rejected"
  | "missing_contract_snapshot"
  | "unexpected_payment_state"
  | "unexpected_enrollment_state"
  | "unknown_integration_flow"
  | "attempt_contract_mismatch"
  | "provider_object_owned"
  | "failure_after_verified"
  | "replacement_after_verified"
  | "unexpected_no_payment_required";

export type ConflictSource =
  | { type: "webhook_event"; id: string }
  | { type: "creation_request"; id: string };

export type ConflictRecord = {
  objectId: string;
  conflictType: ConflictType;
  source: ConflictSource;
  paymentId?: string | null;
  enrollmentId?: string | null;
  expectedAmountMinor?: number | null;
  actualAmountMinor?: number | null;
  expectedCurrency?: string | null;
  actualCurrency?: string | null;
};

function rpcArgs(c: ConflictRecord) {
  return {
    p_object_id: c.objectId,
    p_conflict_type: c.conflictType,
    p_source_type: c.source.type,
    p_source_id: c.source.id,
    p_payment_id: c.paymentId ?? null,
    p_enrollment_id: c.enrollmentId ?? null,
    p_expected_amount_minor: c.expectedAmountMinor ?? null,
    p_actual_amount_minor: c.actualAmountMinor ?? null,
    p_expected_currency: c.expectedCurrency ?? null,
    p_actual_currency: c.actualCurrency ?? null,
  };
}

/**
 * Shape (i): generic sighting. Never touches cleanup or resolution fields —
 * a replayed webhook must not reset a 'pending' cleanup or reopen a resolved
 * incident. Throws on write failure: the caller returns 500, because a
 * conflict that was not durably recorded was not handled.
 */
export async function recordConflict(c: ConflictRecord): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.rpc("record_stripe_conflict", rpcArgs(c) as never);
  if (error) {
    throw new Error(`conflict record failed for ${c.objectId}/${c.conflictType}: ${error.message}`);
  }
}

/**
 * Shape (ii): an unowned payable object exists NOW. Atomically (re)opens the
 * incident with cleanup_status='pending' — recording PRECEDES the cancel
 * attempt (§3a: the creation retry cannot be relied on to come back).
 */
export async function recordCleanupConflict(c: ConflictRecord): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.rpc("record_stripe_cleanup_conflict", rpcArgs(c) as never);
  if (error) {
    throw new Error(`cleanup-conflict record failed for ${c.objectId}/${c.conflictType}: ${error.message}`);
  }
}

/**
 * Conditional pending→done. Returns true iff THIS call won the transition;
 * false means another worker moved it or a new sighting re-pended it — the
 * caller re-reads, never assumes.
 */
export async function completeCleanup(
  objectId: string,
  conflictType: ConflictType,
): Promise<boolean> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("complete_stripe_cleanup", {
    p_object_id: objectId,
    p_conflict_type: conflictType,
  } as never);
  if (error) {
    throw new Error(`cleanup completion failed for ${objectId}/${conflictType}: ${error.message}`);
  }
  return data === true;
}
