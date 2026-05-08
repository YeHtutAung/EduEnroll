import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { getSmsBalance } from "@/lib/sms";

// ─── GET /api/admin/sms/balance ───────────────────────────────────────────────
// Returns the current SmsPoh account balance.
// Proxied server-side so API credentials never reach the client.

export async function GET() {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const balance = await getSmsBalance();
  if (!balance) {
    return NextResponse.json(
      { error: "SMS provider not configured or unavailable." },
      { status: 503 },
    );
  }

  return NextResponse.json(balance);
}
