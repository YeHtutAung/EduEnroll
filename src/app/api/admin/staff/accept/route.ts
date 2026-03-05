import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { StaffInvite } from "@/types/database";

// ─── GET /api/admin/staff/accept?token=xxx ──────────────────────────────────
// Public — no authentication required.
// Validates invite token, creates auth user + staff profile,
// redirects to login page with success message.

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token")?.trim();

  if (!token) {
    return NextResponse.redirect(new URL("/login?error=missing_token", request.url));
  }

  const supabase = createAdminClient();

  // Find the invite
  const { data: invite, error: inviteError } = await supabase
    .from("staff_invites")
    .select("*")
    .eq("token", token)
    .is("accepted_at", null)
    .single() as { data: StaffInvite | null; error: unknown };

  if (inviteError || !invite) {
    return NextResponse.redirect(
      new URL("/login?error=invalid_invite", request.url),
    );
  }

  // Check expiry
  if (new Date(invite.expires_at) < new Date()) {
    return NextResponse.redirect(
      new URL("/login?error=invite_expired", request.url),
    );
  }

  // Check if auth user already exists with this email
  const { data: existingUsers } = await supabase.auth.admin.listUsers();
  const existingUser = existingUsers?.users?.find(
    (u) => u.email === invite.email,
  );

  let userId: string;

  if (existingUser) {
    // User already has an auth account — just create the profile
    userId = existingUser.id;
  } else {
    // Create auth user with a temporary password (user will set their own)
    const tempPassword = `temp-${crypto.randomUUID().slice(0, 16)}`;
    const { data: authData, error: authError } =
      await supabase.auth.admin.createUser({
        email: invite.email,
        password: tempPassword,
        email_confirm: true,
      });

    if (authError || !authData.user) {
      console.error("[staff-accept] Auth error:", authError?.message);
      return NextResponse.redirect(
        new URL("/login?error=account_creation_failed", request.url),
      );
    }

    userId = authData.user.id;
  }

  // Check if profile already exists
  const { data: existingProfile } = await supabase
    .from("users")
    .select("id")
    .eq("id", userId)
    .maybeSingle() as { data: { id: string } | null; error: unknown };

  if (!existingProfile) {
    // Create user profile with staff role
    const { error: profileError } = await supabase
      .from("users")
      .insert({
        id: userId,
        tenant_id: invite.tenant_id,
        email: invite.email,
        role: "staff",
        full_name: invite.email.split("@")[0],
      } as never);

    if (profileError) {
      console.error("[staff-accept] Profile error:", profileError.message);
      return NextResponse.redirect(
        new URL("/login?error=profile_creation_failed", request.url),
      );
    }
  }

  // Mark invite as accepted
  await supabase
    .from("staff_invites")
    .update({ accepted_at: new Date().toISOString() } as never)
    .eq("id", invite.id);

  // Redirect to login with success message
  return NextResponse.redirect(
    new URL("/login?invite=accepted", request.url),
  );
}
