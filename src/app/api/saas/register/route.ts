import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// ─── POST /api/saas/register ────────────────────────────────────────────────
// Public — no authentication required.
// Creates a new tenant, Supabase auth user, and owner profile.

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const { school_name_en, school_name_mm, subdomain, admin_email, password } =
    body as Record<string, unknown>;

  // ── Validate ────────────────────────────────────────────────────────────────

  const errors: string[] = [];

  if (!school_name_en || typeof school_name_en !== "string" || school_name_en.trim() === "") {
    errors.push("school_name_en is required.");
  }
  if (!school_name_mm || typeof school_name_mm !== "string" || school_name_mm.trim() === "") {
    errors.push("school_name_mm is required.");
  }
  if (!subdomain || typeof subdomain !== "string") {
    errors.push("subdomain is required.");
  } else if (!SLUG_RE.test(subdomain)) {
    errors.push("subdomain must be 3-30 lowercase letters, numbers, or hyphens (cannot start/end with hyphen).");
  }
  if (!admin_email || typeof admin_email !== "string" || !admin_email.includes("@")) {
    errors.push("admin_email must be a valid email.");
  }
  if (!password || typeof password !== "string" || password.length < 6) {
    errors.push("password must be at least 6 characters.");
  }

  if (errors.length > 0) {
    return NextResponse.json({ error: errors.join(" "), messages: errors }, { status: 400 });
  }

  const supabase = createAdminClient();

  // ── Check subdomain uniqueness ──────────────────────────────────────────────

  const { data: existing } = await supabase
    .from("tenants")
    .select("id")
    .eq("subdomain", (subdomain as string).trim())
    .maybeSingle();

  if (existing) {
    return NextResponse.json(
      {
        error: "This subdomain is already taken.",
        error_mm: "ဤ subdomain ကို အသုံးပြုပြီးဖြစ်သည်။",
      },
      { status: 409 },
    );
  }

  // ── Create tenant ───────────────────────────────────────────────────────────

  const { data: tenant, error: tenantError } = await supabase
    .from("tenants")
    .insert({
      name: (school_name_en as string).trim(),
      subdomain: (subdomain as string).trim().toLowerCase(),
      currency: "MMK",
      language: "my+en",
      plan: "starter",
    } as never)
    .select()
    .single();

  if (tenantError || !tenant) {
    console.error("[register] Tenant insert error:", tenantError?.message);
    return NextResponse.json(
      { error: "Failed to create school. Please try again." },
      { status: 500 },
    );
  }

  // ── Create Supabase auth user ───────────────────────────────────────────────

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email: (admin_email as string).trim(),
    password: password as string,
    email_confirm: true,
  });

  if (authError || !authData.user) {
    // Rollback: delete the tenant
    await supabase.from("tenants").delete().eq("id", (tenant as { id: string }).id);
    console.error("[register] Auth user error:", authError?.message);
    return NextResponse.json(
      {
        error: authError?.message ?? "Failed to create admin account.",
        error_mm: "အက်မင် အကောင့် ဖန်တီးခြင်း မအောင်မြင်ပါ။",
      },
      { status: 400 },
    );
  }

  // ── Create user profile ─────────────────────────────────────────────────────

  const { error: profileError } = await supabase
    .from("users")
    .insert({
      id: authData.user.id,
      tenant_id: (tenant as { id: string }).id,
      email: (admin_email as string).trim(),
      role: "owner",
      full_name: (school_name_en as string).trim(),
    } as never);

  if (profileError) {
    // Rollback: delete auth user and tenant
    await supabase.auth.admin.deleteUser(authData.user.id);
    await supabase.from("tenants").delete().eq("id", (tenant as { id: string }).id);
    console.error("[register] Profile insert error:", profileError.message);
    return NextResponse.json(
      { error: "Failed to create user profile." },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      tenant_id: (tenant as { id: string }).id,
      subdomain: (tenant as { subdomain: string }).subdomain,
      user_id: authData.user.id,
      email: authData.user.email,
    },
    { status: 201 },
  );
}
