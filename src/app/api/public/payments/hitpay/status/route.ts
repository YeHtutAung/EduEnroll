import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";

// ─── GET /api/public/payments/hitpay/status?ref=<enrollmentRef> ───────────────
// Reads enrollment status from the local DB for the QR polling loop.
// Does NOT call HitPay's API — the webhook is the sole source of truth.
//
// Returns: { enrollmentStatus: "pending_payment" | "confirmed" | "rejected" | "cancelled" }
// Client polls every 3s:
//   - "pending_payment" → keep polling
//   - "confirmed"       → redirect to success
//   - "rejected"        → show error, stop polling
//   - other             → stop polling

export async function GET(request: NextRequest) {
  const ref = request.nextUrl.searchParams.get("ref");
  if (!ref) {
    return NextResponse.json(
      { error: "Bad Request", message: "ref is required." },
      { status: 400 },
    );
  }

  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  const supabase = createAdminClient();

  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select("status")
    .eq("enrollment_ref", ref.trim())
    .eq("tenant_id", tenantId)
    .single()) as { data: { status: string } | null; error: unknown };

  if (!enrollment) {
    return NextResponse.json(
      { error: "Not Found", message: "Enrollment not found." },
      { status: 404 },
    );
  }

  return NextResponse.json({ enrollmentStatus: enrollment.status });
}
