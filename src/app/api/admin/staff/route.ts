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
// Create a staff account directly. Owner-only.
// Body: { email: string, password: string, full_name?: string }

export async function POST(request: NextRequest) {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const { email, password, full_name } = body as Record<string, unknown>;

  if (!email || typeof email !== "string" || !email.includes("@")) {
    return badRequest("A valid email address is required.");
  }
  if (!password || typeof password !== "string" || password.length < 6) {
    return badRequest("Password must be at least 6 characters.");
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

  // Create auth user
  const { data: authData, error: authError } =
    await admin.auth.admin.createUser({
      email: trimmedEmail,
      password: password as string,
      email_confirm: true,
    });

  if (authError || !authData.user) {
    console.error("[staff] Auth create error:", authError?.message);
    return NextResponse.json(
      { error: authError?.message ?? "Failed to create user account." },
      { status: 500 },
    );
  }

  // Create user profile with staff role
  const { data: profile, error: profileError } = await admin
    .from("users")
    .insert({
      id: authData.user.id,
      tenant_id: tenantId,
      email: trimmedEmail,
      role: "staff",
      full_name: typeof full_name === "string" && full_name.trim()
        ? full_name.trim()
        : trimmedEmail.split("@")[0],
    } as never)
    .select()
    .single() as { data: User | null; error: unknown };

  if (profileError || !profile) {
    console.error("[staff] Profile insert error:", (profileError as Error)?.message);
    // Clean up: remove the auth user we just created
    await admin.auth.admin.deleteUser(authData.user.id);
    return NextResponse.json(
      { error: "Failed to create staff profile." },
      { status: 500 },
    );
  }

  return NextResponse.json(profile, { status: 201 });
}
