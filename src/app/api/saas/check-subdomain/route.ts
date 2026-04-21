import { NextRequest, NextResponse } from "next/server";

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

  // Use raw fetch to PostgREST to avoid Supabase JS client caching issues
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/tenants?subdomain=eq.${encodeURIComponent(slug)}&select=id&limit=1`,
      {
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${serviceKey}`,
        },
        cache: "no-store",
      },
    );

    if (!res.ok) {
      return NextResponse.json(
        { error: "Failed to check subdomain." },
        { status: 500 },
      );
    }

    const data = await res.json();
    return NextResponse.json({ available: data.length === 0 });
  } catch {
    return NextResponse.json(
      { error: "Failed to check subdomain." },
      { status: 500 },
    );
  }
}
