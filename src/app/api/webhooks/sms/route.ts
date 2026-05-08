import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// ─── SmsPoh delivery receipt payload ─────────────────────────────────────────

interface SmsPohDeliveryReceipt {
  messageId?: string;
  to?: string;
  status?: string;
  clientReference?: string;
  [key: string]: unknown;
}

// ─── GET /api/webhooks/sms ────────────────────────────────────────────────────
// Ping endpoint — SmsPoh or ops can verify the route is reachable.

export async function GET() {
  return NextResponse.json({ ok: true });
}

// ─── POST /api/webhooks/sms ───────────────────────────────────────────────────
// SmsPoh calls this URL with delivery status updates.
// Always returns 200 — SmsPoh retries on non-200.
//
// Register the callback URL in the SmsPoh dashboard as:
//   https://<your-domain>/api/webhooks/sms?secret=<SMSPOH_WEBHOOK_SECRET>

export async function POST(request: NextRequest) {
  // ── 1. Verify secret ────────────────────────────────────────────────────────
  const secret = request.nextUrl.searchParams.get("secret");
  const expectedSecret = process.env.SMSPOH_WEBHOOK_SECRET;

  if (expectedSecret && secret !== expectedSecret) {
    console.warn("[sms-webhook] Rejected request — invalid secret.");
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── 2. Parse payload ────────────────────────────────────────────────────────
  let payload: SmsPohDeliveryReceipt;
  try {
    payload = (await request.json()) as SmsPohDeliveryReceipt;
  } catch {
    console.warn("[sms-webhook] Could not parse JSON body.");
    return NextResponse.json({ ok: true });
  }

  const { messageId, to, status, clientReference } = payload;

  if (!messageId || !status || !to) {
    console.warn("[sms-webhook] Missing required fields:", { messageId, status, to });
    return NextResponse.json({ ok: true });
  }

  // ── 3. Resolve tenant_id + enrollment_id from client_reference ─────────────
  const admin = createAdminClient();
  let tenantId: string | null = null;
  let enrollmentId: string | null = null;

  if (clientReference) {
    const { data: enrollment } = (await admin
      .from("enrollments")
      .select("id, tenant_id")
      .eq("enrollment_ref", clientReference)
      .single()) as { data: { id: string; tenant_id: string } | null; error: unknown };

    if (enrollment) {
      tenantId = enrollment.tenant_id;
      enrollmentId = enrollment.id;
    }
  }

  // ── 4. Upsert delivery log ─────────────────────────────────────────────────
  const { error } = await admin
    .from("sms_logs")
    .upsert(
      {
        message_id: messageId,
        client_reference: clientReference ?? null,
        tenant_id: tenantId,
        enrollment_id: enrollmentId,
        to_number: to,
        status,
        raw_payload: payload,
        updated_at: new Date().toISOString(),
      } as never,
      { onConflict: "message_id" },
    );

  if (error) {
    const e = error as { message?: string };
    console.error("[sms-webhook] Failed to upsert sms_log:", e.message);
  } else {
    console.log(`[sms-webhook] ${messageId} → ${status} (ref: ${clientReference ?? "none"})`);
  }

  return NextResponse.json({ ok: true });
}
