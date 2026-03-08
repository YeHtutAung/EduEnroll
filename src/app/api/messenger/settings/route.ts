import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";

// ─── GET /api/messenger/settings ────────────────────────────────────────────
// Returns messenger config for the current tenant (no secrets exposed).

export async function GET() {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const { supabase, tenantId } = auth;
  const { data: tenant } = await supabase
    .from("tenants")
    .select("messenger_enabled, messenger_page_id, messenger_greeting, subdomain, handoff_timeout_min")
    .eq("id", tenantId)
    .single() as {
    data: {
      messenger_enabled: boolean;
      messenger_page_id: string | null;
      messenger_greeting: string | null;
      subdomain: string;
      handoff_timeout_min: number;
    } | null;
    error: unknown;
  };

  if (!tenant) {
    return NextResponse.json({ error: "Tenant not found." }, { status: 404 });
  }

  // Fetch page name from Meta if connected (cached in page_id presence)
  let pageName: string | null = null;
  if (tenant.messenger_page_id) {
    // We don't expose the page token, just indicate connection status
    pageName = `Page ID: ${tenant.messenger_page_id}`;
  }

  return NextResponse.json({
    enabled: tenant.messenger_enabled,
    connected: !!tenant.messenger_page_id,
    pageId: tenant.messenger_page_id,
    pageName,
    greeting: tenant.messenger_greeting,
    subdomain: tenant.subdomain,
    handoffTimeoutMin: tenant.handoff_timeout_min,
  });
}

// ─── PATCH /api/messenger/settings ──────────────────────────────────────────
// Update messenger settings (enable/disable, greeting, disconnect).

export async function PATCH(request: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const { supabase, tenantId } = auth;
  const body = await request.json();

  const updates: Record<string, unknown> = {};

  if (typeof body.enabled === "boolean") {
    updates.messenger_enabled = body.enabled;
  }
  if (typeof body.greeting === "string") {
    updates.messenger_greeting = body.greeting.trim() || null;
  }
  if (typeof body.handoffTimeoutMin === "number" && body.handoffTimeoutMin >= 1 && body.handoffTimeoutMin <= 120) {
    updates.handoff_timeout_min = body.handoffTimeoutMin;
  }
  if (body.disconnect === true) {
    updates.messenger_enabled = false;
    updates.messenger_page_id = null;
    updates.messenger_page_token = null;
    updates.messenger_verify_token = null;
    updates.messenger_greeting = null;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No updates provided." }, { status: 400 });
  }

  const { error } = await supabase
    .from("tenants")
    .update(updates as never)
    .eq("id", tenantId);

  if (error) {
    return NextResponse.json({ error: "Failed to update." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
