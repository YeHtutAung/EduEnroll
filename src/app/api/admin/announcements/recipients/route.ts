import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAnnouncementRecipients } from "@/lib/announcements/announcementRecipients";

// ─── GET /api/admin/announcements/recipients ──────────────────────────────────
// Returns count of unique Telegram recipients for a given intake + class_level.
// Query params: intake_id (required), class_level (optional)

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;

  const intakeId = request.nextUrl.searchParams.get("intake_id");
  if (!intakeId) {
    return NextResponse.json({ count: 0 });
  }

  // The same client and query as the send, so the count matches who gets it.
  const recipients = await getAnnouncementRecipients(createAdminClient(), {
    tenantId,
    intakeId,
    classLevel: request.nextUrl.searchParams.get("class_level"),
  });

  if (!recipients) {
    return NextResponse.json({ error: "Could not read the recipients." }, { status: 500 });
  }

  return NextResponse.json({ count: recipients.length });
}
