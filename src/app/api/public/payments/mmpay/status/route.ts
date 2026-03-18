import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// ─── GET /api/public/payments/mmqr/status?ref=KNY-xxx ───────────────────────
// Public polling endpoint for MMQR payment status.

export async function GET(request: NextRequest) {
  const paymentRef = request.nextUrl.searchParams.get("ref");
  if (!paymentRef) {
    return NextResponse.json(
      { error: "Bad Request", message: "ref is required." },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  const { data, error } = (await supabase
    .from("payments")
    .select("mmqr_status")
    .eq("payment_ref", paymentRef)
    .single()) as { data: { mmqr_status: string } | null; error: unknown };

  if (error || !data) {
    return NextResponse.json({ mmqr_status: "PENDING" });
  }

  return NextResponse.json({ mmqr_status: data.mmqr_status });
}
