import { NextRequest, NextResponse } from "next/server";
import { apiKeyMatches } from "@/lib/cbmmqr";
import { sweepInterruptedFulfilment } from "@/server/payments/repairFulfilment";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  // Checked for presence first, so "Bearer undefined" can never pass.
  if (!secret || !apiKeyMatches(request.headers.get("authorization"), `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const counts = await sweepInterruptedFulfilment();
    console.log("[fulfilment-repair] sweep", JSON.stringify(counts));
    if (counts.readFailed) {
      return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
    return NextResponse.json(counts);
  } catch (err) {
    console.error("[fulfilment-repair] sweep failed:", err instanceof Error ? err.name : "unknown");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
