import { NextRequest, NextResponse } from "next/server";
import { requireOwner, badRequest } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import type { User } from "@/types/database";

type UsersResult = { data: User[] | null; error: unknown };

// ─── GET /api/admin/staff ───────────────────────────────────────────────────
// List all staff/owner users for the tenant. Owner-only.

export async function GET() {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true }) as UsersResult;

  if (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }

  return NextResponse.json(data ?? []);
}

// ─── POST /api/admin/staff ──────────────────────────────────────────────────
// Create a staff invite. Owner-only.
// Body: { email: string }

export async function POST(request: NextRequest) {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { tenantId, user } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const { email } = body as Record<string, unknown>;

  if (!email || typeof email !== "string" || !email.includes("@")) {
    return badRequest("A valid email address is required.");
  }

  const trimmedEmail = email.trim().toLowerCase();

  // Check if user with this email already exists in tenant
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("users")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("email", trimmedEmail)
    .maybeSingle() as { data: { id: string } | null; error: unknown };

  if (existing) {
    return NextResponse.json(
      { error: "This email is already a member of your school." },
      { status: 409 },
    );
  }

  // Check for pending invite
  const { data: pendingInvite } = await admin
    .from("staff_invites")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("email", trimmedEmail)
    .is("accepted_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle() as { data: { id: string } | null; error: unknown };

  if (pendingInvite) {
    return NextResponse.json(
      { error: "An invite is already pending for this email." },
      { status: 409 },
    );
  }

  // Create invite
  const { data: invite, error: inviteError } = await admin
    .from("staff_invites")
    .insert({
      tenant_id: tenantId,
      email: trimmedEmail,
      invited_by: user.id,
    } as never)
    .select()
    .single();

  if (inviteError || !invite) {
    console.error("[staff] Invite insert error:", inviteError?.message);
    return NextResponse.json(
      { error: "Failed to create invite." },
      { status: 500 },
    );
  }

  // Return the invite (the frontend or a future email integration can use the token)
  return NextResponse.json(invite, { status: 201 });
}
