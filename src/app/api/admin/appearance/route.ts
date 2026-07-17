import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/api";
import { DEFAULT_APPEARANCE } from "@/types/database";
import type { Sponsor, SponsorMark, SponsorPlacements } from "@/types/database";

const SPONSOR_MARKS = new Set<SponsorMark>(["square", "circle", "diamond", "ring"]);

function validAssetUrl(value: string): boolean {
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function sanitizeSponsor(value: unknown, label: string): { sponsor?: Sponsor; error?: string } {
  if (!value || typeof value !== "object") return { error: `${label} must be an object.` };
  const input = value as Record<string, unknown>;
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 100) {
    return { error: `${label} needs a name of 100 characters or fewer.` };
  }

  const sponsor: Sponsor = { name: input.name.trim() };
  for (const key of ["logo_url", "url"] as const) {
    const field = input[key];
    if (field === null || field === undefined || field === "") continue;
    if (typeof field !== "string" || field.length > 2048 || !validAssetUrl(field)) {
      return { error: `${label} has an invalid ${key}.` };
    }
    sponsor[key] = field;
  }

  if (input.mark !== undefined) {
    if (typeof input.mark !== "string" || !SPONSOR_MARKS.has(input.mark as SponsorMark)) {
      return { error: `${label} has an invalid placeholder mark.` };
    }
    sponsor.mark = input.mark as SponsorMark;
  }
  if (input.mark_color !== undefined) {
    if (typeof input.mark_color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(input.mark_color)) {
      return { error: `${label} has an invalid placeholder color.` };
    }
    sponsor.mark_color = input.mark_color;
  }
  return { sponsor };
}

function sanitizeSponsorConfig(value: unknown): { config?: SponsorPlacements; error?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "sponsor_config must be an object." };
  }
  const input = value as Record<string, unknown>;
  let presenting: Sponsor | null = null;
  if (input.presenting !== null && input.presenting !== undefined) {
    const result = sanitizeSponsor(input.presenting, "Presenting sponsor");
    if (result.error) return { error: result.error };
    presenting = result.sponsor ?? null;
  }

  const sanitizeList = (key: "partners" | "supported_by", limit: number) => {
    const list = input[key];
    if (!Array.isArray(list)) return { error: `${key} must be an array.` };
    if (list.length > limit) return { error: `${key} supports at most ${limit} sponsors.` };
    const sponsors: Sponsor[] = [];
    for (let index = 0; index < list.length; index += 1) {
      const result = sanitizeSponsor(list[index], `${key} sponsor ${index + 1}`);
      if (result.error) return { error: result.error };
      if (result.sponsor) sponsors.push(result.sponsor);
    }
    return { sponsors };
  };

  const partners = sanitizeList("partners", 12);
  if (partners.error) return { error: partners.error };
  const supportedBy = sanitizeList("supported_by", 6);
  if (supportedBy.error) return { error: supportedBy.error };
  return {
    config: {
      presenting,
      partners: partners.sponsors ?? [],
      supported_by: supportedBy.sponsors ?? [],
    },
  };
}

export async function GET() {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  const [appearanceResult, tenantResult] = await Promise.all([
    supabase
      .from("tenant_appearance")
      .select("*")
      .eq("tenant_id", tenantId)
      .maybeSingle() as unknown as Promise<{
      data: Record<string, unknown> | null;
      error: unknown;
    }>,
    supabase
      .from("tenants")
      .select("org_type")
      .eq("id", tenantId)
      .maybeSingle() as unknown as Promise<{ data: { org_type: string } | null; error: unknown }>,
  ]);

  if (appearanceResult.error)
    return NextResponse.json({ error: "Failed to fetch appearance." }, { status: 500 });

  const appearance = appearanceResult.data ?? { tenant_id: tenantId, ...DEFAULT_APPEARANCE };
  return NextResponse.json({
    ...appearance,
    org_type: tenantResult.data?.org_type ?? "language_school",
  });
}

export async function PUT(request: Request) {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });

  const VALID_TEMPLATES = [
    "ls-classic",
    "ls-modern",
    "ls-warm",
    "ev-luxury",
    "ev-festival",
    "ev-corporate",
    "ev-trusted-official",
  ];
  if (body.template_id && !VALID_TEMPLATES.includes(body.template_id)) {
    return NextResponse.json({ error: "Invalid template_id." }, { status: 400 });
  }

  const VALID_ADMIN_THEMES = ["minimal", "bold", "warm", "professional"];
  if (body.admin_theme && !VALID_ADMIN_THEMES.includes(body.admin_theme)) {
    return NextResponse.json({ error: "Invalid admin_theme." }, { status: 400 });
  }

  let sponsorConfig: SponsorPlacements | undefined;
  if ("sponsor_config" in body) {
    const result = sanitizeSponsorConfig(body.sponsor_config);
    if (result.error) return NextResponse.json({ error: result.error }, { status: 400 });
    sponsorConfig = result.config;
  }

  const patch: Record<string, unknown> = {
    tenant_id: tenantId,
    updated_at: new Date().toISOString(),
  };
  const allowed = [
    "admin_theme",
    "template_id",
    "primary_color",
    "tagline",
    "cta_button_text",
    "logo_url",
    "hero_url",
    "sponsor_config",
  ];
  for (const key of allowed) {
    if (key in body) patch[key] = key === "sponsor_config" ? sponsorConfig : body[key];
  }

  const { data, error } = (await supabase
    .from("tenant_appearance")
    .upsert(patch as never, { onConflict: "tenant_id" })
    .select()
    .single()) as { data: Record<string, unknown> | null; error: unknown };

  if (error) return NextResponse.json({ error: "Failed to save appearance." }, { status: 500 });

  return NextResponse.json(data);
}
