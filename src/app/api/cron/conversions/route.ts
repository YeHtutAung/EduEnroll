import { NextRequest, NextResponse } from "next/server";
import { apiKeyMatches } from "@/lib/cbmmqr";
import { sweepConversions } from "@/server/conversions/sweep";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  // Checked for presence first, so "Bearer undefined" can never pass.
  if (!secret || !apiKeyMatches(request.headers.get("authorization"), `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const counts = await sweepConversions();
    console.log("[conversions] sweep", JSON.stringify(counts));
    // A run can't look healthy while IP data isn't being deleted.
    if (counts.cleanupFailed) {
      return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
    return NextResponse.json(counts);
  } catch (err) {
    console.error("[conversions] sweep failed:", err instanceof Error ? err.name : "unknown");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
