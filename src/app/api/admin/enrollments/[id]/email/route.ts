import { NextRequest, NextResponse } from "next/server";
import { requireAuth, badRequest, notFound } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidEmail, replaceEmailInFormData } from "@/lib/enrollment/emailAddress";
import { resolveEmailFromFormData } from "@/lib/utils";

// ─── PATCH /api/admin/enrollments/[id]/email ───────────────────────────────
// Corrects the buyer's address on an order. Body: { email: string }
// Sends nothing: the admin resends the email once they have checked the address.

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { tenantId, user, isAgent } = auth;

  // The address decides who receives a paid e-ticket, and the change record needs
  // the person who made it. The bot is not a person.
  if (isAgent) {
    return NextResponse.json(
      { error: "Forbidden", message: "Only a signed-in admin can change a buyer's email." },
      { status: 403 },
    );
  }

  let body: { email?: unknown };
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid JSON.");
  }

  const newEmail = typeof body.email === "string" ? body.email.trim() : "";
  if (!isValidEmail(newEmail)) return badRequest("Enter a valid email address.");

  const admin = createAdminClient();

  const { data: enrollment, error: lookupError } = (await admin
    .from("enrollments")
    .select("id, email, form_data")
    .eq("id", params.id)
    .eq("tenant_id", tenantId)
    .maybeSingle()) as {
    data: { id: string; email: string | null; form_data: Record<string, unknown> | null } | null;
    error: unknown;
  };

  if (lookupError) {
    console.error("[change-email] order lookup failed");
    return NextResponse.json({ error: "Could not change the email." }, { status: 500 });
  }
  if (!enrollment) return notFound("Enrollment");

  // Senders fall back to the saved answers when the column is empty, so that is
  // the address this order is really using.
  const currentEmail =
    enrollment.email ||
    resolveEmailFromFormData(enrollment.form_data as Record<string, string> | null);

  const formData = currentEmail
    ? replaceEmailInFormData(enrollment.form_data, currentEmail, newEmail)
    : (enrollment.form_data ?? {});

  if (currentEmail === newEmail && enrollment.email === newEmail) {
    return badRequest("That is already the email on this order.");
  }

  const { data: changed, error: changeError } = (await admin.rpc(
    "change_enrollment_email" as never,
    {
      p_enrollment_id: enrollment.id,
      p_tenant_id: tenantId,
      p_old_email: enrollment.email,
      p_new_email: newEmail,
      p_form_data: formData,
      p_changed_by: user.id,
    } as never,
  )) as unknown as { data: boolean | null; error: { code?: string } | null };

  if (changeError) {
    console.error("[change-email] update failed:", changeError.code ?? "unknown");
    return NextResponse.json({ error: "Could not change the email." }, { status: 500 });
  }
  if (!changed) {
    return NextResponse.json(
      { error: "This order's email was just changed. Reopen it and try again." },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, email: newEmail, form_data: formData });
}
