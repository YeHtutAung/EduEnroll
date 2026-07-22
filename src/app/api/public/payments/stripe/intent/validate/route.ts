import { NextRequest, NextResponse } from "next/server";
import { resolveTenantId } from "@/lib/api";
import { validateStripeAttempt } from "@/server/payments/validateStripeAttempt";

export async function POST(request: NextRequest) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  let body: { enrollmentRef?: string; paymentIntentId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad Request", message: "Invalid JSON." }, { status: 400 });
  }
  if (!body.enrollmentRef || !body.paymentIntentId) {
    return NextResponse.json(
      { error: "Bad Request", message: "enrollmentRef and paymentIntentId are required." },
      { status: 400 },
    );
  }

  const result = await validateStripeAttempt({
    tenantId,
    enrollmentRef: body.enrollmentRef,
    paymentIntentId: body.paymentIntentId,
  });
  if (result.kind === "eligible") return NextResponse.json({ eligible: true });
  if (result.kind === "not_found") {
    return NextResponse.json({ error: "Not Found", message: "Enrollment not found." }, { status: 404 });
  }
  if (result.kind === "ineligible") {
    return NextResponse.json(
      { error: "Conflict", message: "This enrollment is no longer awaiting payment." },
      { status: 409 },
    );
  }
  console.error("[stripe/intent/validate] lookup failed:", result.reason);
  return NextResponse.json(
    { error: "Internal Server Error", message: "Could not verify payment eligibility." },
    { status: 500 },
  );
}
