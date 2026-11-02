import { NextResponse } from "next/server";
import type { createAdminClient } from "@/lib/supabase/admin";

// ─── Partial payments ───────────────────────────────────────────────────────
//
// `request_remaining` records received_amount on one row, and a top-up gets a
// row of its own holding only the remainder. So the latest row says nothing
// about what was received: an abandoned top-up leaves a newer row with a null
// received_amount, and reading only that row charges the whole order again.

interface PaymentHistoryRow {
  amount: number;
  received_amount: number | null;
  platform_fee?: number | null;
}

export interface PartialPaymentSummary {
  /** Total recorded across every row. Staff record per row, so these add up. */
  received: number;
  /** The amount on the first row with a recorded payment, or null if none has one. */
  orderTotal: number | null;
  /** The fee recorded on that same row, or null if none has one. */
  orderFee: number | null;
  remaining: number | null;
}

/** Rows oldest first: the first recorded payment is on the row holding the full total. */
export function summarisePartialPayment(rows: PaymentHistoryRow[]): PartialPaymentSummary {
  const recorded = rows.filter((row) => row.received_amount);
  if (recorded.length === 0) {
    return { received: 0, orderTotal: null, orderFee: null, remaining: null };
  }
  const received = recorded.reduce((sum, row) => sum + (row.received_amount ?? 0), 0);
  const first = recorded[0];
  return {
    received,
    orderTotal: first.amount,
    orderFee: first.platform_fee ?? 0,
    remaining: first.amount - received,
  };
}

/** Null when the history can't be read. A charge must not go ahead without it. */
export async function loadPartialPayment(
  supabase: ReturnType<typeof createAdminClient>,
  enrollmentId: string,
): Promise<PartialPaymentSummary | null> {
  const { data, error } = (await supabase
    .from("payments")
    .select("amount, received_amount, platform_fee")
    .eq("enrollment_id", enrollmentId)
    .order("created_at", { ascending: true })) as unknown as {
    data: PaymentHistoryRow[] | null;
    error: { message: string } | null;
  };
  if (error || !data) {
    console.error(`[partial-payment] history unavailable for ${enrollmentId}: ${error?.message ?? "no data"}`);
    return null;
  }
  return summarisePartialPayment(data);
}

export const partialHistoryUnavailable = () =>
  NextResponse.json(
    { error: "Internal Server Error", message: "Could not load payment history." },
    { status: 500 },
  );

export const noBalanceRemaining = () =>
  NextResponse.json(
    { error: "Conflict", message: "This order has no remaining balance. Please contact support." },
    { status: 409 },
  );
