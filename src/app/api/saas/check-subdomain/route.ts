import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// ─── GET /api/saas/check-subdomain?slug=xxx ────────────────────────────────
// Public — no authentication required.
// Returns { available: true/false } for subdomain availability.

export async function GET(request: NextRequest) {
  const slug = request.nextUrl.searchParams.get("slug")?.trim().toLowerCase();

  if (!slug || slug.length < 2) {
    return NextResponse.json(
      { error: "Slug must be at least 2 characters." },
      { status: 400 },
    );
  }

  // Only allow valid subdomain characters
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return NextResponse.json(
      { error: "Slug must contain only lowercase letters, numbers, and hyphens." },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("tenants")
    .select("id")
    .eq("subdomain", slug)
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: "Failed to check subdomain." },
      { status: 500 },
    );
  }

  return NextResponse.json({ available: data === null });
}
