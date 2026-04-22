import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/api";
import { DEFAULT_APPEARANCE } from "@/types/database";

export async function GET() {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  const [appearanceResult, tenantResult] = await Promise.all([
    supabase.from("tenant_appearance").select("*").eq("tenant_id", tenantId).maybeSingle() as unknown as Promise<{ data: Record<string, unknown> | null; error: unknown }>,
    supabase.from("tenants").select("org_type").eq("id", tenantId).maybeSingle() as unknown as Promise<{ data: { org_type: string } | null; error: unknown }>,
  ]);

  if (appearanceResult.error) return NextResponse.json({ error: "Failed to fetch appearance." }, { status: 500 });

  const appearance = appearanceResult.data ?? { tenant_id: tenantId, ...DEFAULT_APPEARANCE };
  return NextResponse.json({ ...appearance, org_type: tenantResult.data?.org_type ?? "language_school" });
}

export async function PUT(request: Request) {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });

  const VALID_TEMPLATES = ["ls-classic", "ls-modern", "ls-warm", "ev-luxury", "ev-festival", "ev-corporate"];
  if (body.template_id && !VALID_TEMPLATES.includes(body.template_id)) {
    return NextResponse.json({ error: "Invalid template_id." }, { status: 400 });
  }

  const VALID_ADMIN_THEMES = ["minimal", "bold", "warm", "professional"];
  if (body.admin_theme && !VALID_ADMIN_THEMES.includes(body.admin_theme)) {
    return NextResponse.json({ error: "Invalid admin_theme." }, { status: 400 });
  }

  const patch: Record<string, unknown> = { tenant_id: tenantId, updated_at: new Date().toISOString() };
  const allowed = ["admin_theme", "template_id", "primary_color", "tagline", "cta_button_text", "logo_url", "hero_url"];
  for (const key of allowed) {
    if (key in body) patch[key] = body[key];
  }

  const { data, error } = (await supabase
    .from("tenant_appearance")
    .upsert(patch as never, { onConflict: "tenant_id" })
    .select()
    .single()) as { data: Record<string, unknown> | null; error: unknown };

  if (error) return NextResponse.json({ error: "Failed to save appearance." }, { status: 500 });

  return NextResponse.json(data);
}
