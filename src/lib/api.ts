import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createClient as createBareClient, type SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractSubdomainFromHost, isPlatformRootHost } from "@/lib/tenant";
import { verifyAgentSignature } from "@/lib/agent-auth";
import type { User, Database } from "@/types/database";

export interface AuthContext {
  supabase: SupabaseClient<Database>;
  user: User;
  tenantId: string;
  isAgent: boolean;
  agentChatId: number | null;
}

/**
 * Validates the Supabase session and resolves the caller's tenant.
 * Returns an AuthContext on success, or a 401 NextResponse on failure.
 * Usage in a route handler:
 *
 *   const auth = await requireAuth();
 *   if (auth instanceof NextResponse) return auth;
 */
// rawBody: pass the pre-read request body text for POST/PATCH agent requests.
// For GET agent requests omit it (defaults to "").
export async function requireAuth(rawBody = ""): Promise<AuthContext | NextResponse> {
  const headersList = headers();

  // ── Agent HMAC auth ───────────────────────────────────────────────────────────
  // KuuNyi's bot service signs every request with:
  //   HMAC-SHA256(chatId + "." + rawBody, AGENT_SECRET)
  // chatId is included in the signed payload so it cannot be swapped in transit.
  const agentSignature = headersList.get("x-agent-signature");
  if (agentSignature) {
    const chatIdHeader = headersList.get("x-chat-id");
    if (!chatIdHeader) {
      return NextResponse.json(
        { error: "Bad Request", message: "x-chat-id header required." },
        { status: 400 },
      );
    }

    if (!verifyAgentSignature(chatIdHeader, rawBody, agentSignature)) {
      return NextResponse.json(
        { error: "Unauthorized", message: "Invalid agent signature." },
        { status: 401 },
      );
    }

    const chatId = Number(chatIdHeader);
    if (!Number.isFinite(chatId)) {
      return NextResponse.json(
        { error: "Bad Request", message: "x-chat-id must be a number." },
        { status: 400 },
      );
    }

    // ── Transitional telemetry (#164) ───────────────────────────────────────
    // Gates removal of the middleware allowlist: the absence of these events is
    // the evidence the bot has migrated to tenant hosts.
    //
    // Emitted only AFTER the signature verifies — a check keyed on the mere
    // presence of x-agent-signature would let anyone manufacture false "legacy
    // bot" events and keep the gate from ever clearing.
    //
    // Placed before the missing-slug 400 below so it still fires once Phase 2
    // deletes the header unconditionally and a regressed bot arrives with no
    // tenant context at all.
    //
    // A fixed route family, never the raw path: no slug, chat id, uuid, query
    // string, body or signature.
    const agentHost = headersList.get("host") ?? "";
    if (isPlatformRootHost(agentHost)) {
      // Set by middleware, which knows the pathname; requireAuth() sees only
      // headers(). "other" means the request reached here from outside the
      // transitional allowlist — worth seeing, since that is a route the bot
      // was not known to call.
      const routeFamily = headersList.get("x-agent-route-family") ?? "other";
      console.warn(`[agent-auth] platform-root agent request (routeFamily=${routeFamily})`);
    }

    const slug = headersList.get("x-tenant-slug");
    if (!slug) {
      return NextResponse.json(
        { error: "Bad Request", message: "x-tenant-slug header required." },
        { status: 400 },
      );
    }

    const adminSupabase = createAdminClient();

    // maybeSingle(), not single(): single() returns an ERROR for zero rows, so
    // "the query failed" and "no such tenant" would be indistinguishable and a
    // database incident would report 404.
    const { data: tenant, error: tenantError } = (await adminSupabase
      .from("tenants")
      .select("id")
      .eq("subdomain", slug)
      .maybeSingle()) as { data: { id: string } | null; error: unknown };

    if (tenantError) {
      console.error("[agent-auth] tenant lookup failed");
      return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }

    if (!tenant) {
      return NextResponse.json({ error: "Not Found", message: "Tenant not found." }, { status: 404 });
    }

    // Verify chat_id is still in allowed_chat_ids (revocation check)
    const { data: config, error: configError } = (await adminSupabase
      .from("tenant_telegram_configs")
      .select("allowed_chat_ids")
      .eq("tenant_id", tenant.id)
      .maybeSingle()) as { data: { allowed_chat_ids: number[] | null } | null; error: unknown };

    // Same reasoning: without this a database failure reports "agent access has
    // been revoked", which reads as a deliberate authorization decision.
    if (configError) {
      console.error("[agent-auth] telegram config lookup failed");
      return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }

    const allowed = (config?.allowed_chat_ids ?? []).map(Number);
    if (!allowed.includes(chatId)) {
      return NextResponse.json(
        { error: "Forbidden", message: "Agent access has been revoked." },
        { status: 403 },
      );
    }

    const agentUser: User = {
      id: "00000000-0000-0000-0000-000000000000",
      tenant_id: tenant.id,
      email: "agent@kuunyi.com",
      role: "owner",
      full_name: "KuuNyi Agent",
      phone: null,
      created_at: new Date().toISOString(),
    };

    return {
      supabase: adminSupabase,
      user: agentUser,
      tenantId: tenant.id,
      isAgent: true,
      agentChatId: chatId,
    };
  }

  // ── Supabase session auth (browser / Bearer token) ───────────────────────────
  // Prefer x-supabase-auth over Authorization:
  // Vercel Deployment Protection intercepts the Authorization header and returns
  // an HTML challenge page, even when x-vercel-protection-bypass is present.
  // The custom x-supabase-auth header bypasses this issue.
  const authHeader = headersList.get("x-supabase-auth") ?? headersList.get("authorization");

  let supabase: SupabaseClient<Database>;
  let authUser: { id: string } | null = null;

  if (authHeader?.startsWith("Bearer ")) {
    // Bearer token auth (API clients, CI) — create a client with the user's
    // token so RLS works correctly via auth.uid(). No service role key needed.
    const token = authHeader.substring(7);
    const tokenClient = createBareClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      },
    );
    const { data, error } = await tokenClient.auth.getUser(token);
    if (!error && data.user) {
      authUser = data.user;
    }
    supabase = tokenClient;
  } else {
    // Cookie-based auth (browser)
    supabase = createClient();
    const { data, error } = await supabase.auth.getUser();
    if (!error && data.user) {
      authUser = data.user;
    }
  }

  if (!authUser) {
    return NextResponse.json(
      { error: "Unauthorized", message: "Valid session required." },
      { status: 401 },
    );
  }

  const { data: profile } = await supabase
    .from("users")
    .select("*")
    .eq("id", authUser.id)
    .single() as { data: User | null; error: unknown };

  if (!profile) {
    return NextResponse.json(
      { error: "Forbidden", message: "User profile not found in tenant." },
      { status: 403 },
    );
  }

  return { supabase, user: profile, tenantId: profile.tenant_id, isAgent: false, agentChatId: null };
}

/**
 * Resolves tenant_id from the x-tenant-slug header injected by middleware.
 * For public API routes that don't require auth but need tenant scoping.
 * Returns the tenant_id string, or a 400/404 NextResponse on failure.
 */
export async function resolveTenantId(): Promise<string | NextResponse> {
  const headersList = headers();
  const slug =
    headersList.get("x-tenant-slug") ||
    extractSubdomainFromHost(headersList.get("host") ?? "");

  if (!slug) {
    return NextResponse.json(
      { error: "Bad Request", message: "Tenant could not be determined." },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("tenants")
    .select("id")
    .eq("subdomain", slug)
    .maybeSingle() as { data: { id: string } | null; error: unknown };

  if (error || !data) {
    return NextResponse.json(
      { error: "Not Found", message: "School not found." },
      { status: 404 },
    );
  }

  return data.id;
}

/**
 * Same as requireAuth but restricted to tenant owners only.
 * Returns 403 for all other roles including superadmin.
 */
export async function requireOwner(): Promise<AuthContext | NextResponse> {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  if (auth.user.role !== "owner") {
    return NextResponse.json(
      { error: "Forbidden", message: "Owner access required." },
      { status: 403 },
    );
  }

  return auth;
}

/** Convenience: 400 with a message */
export function badRequest(message: string) {
  return NextResponse.json({ error: "Bad Request", message }, { status: 400 });
}

/** Convenience: 404 */
export function notFound(resource = "Resource") {
  return NextResponse.json(
    { error: "Not Found", message: `${resource} not found.` },
    { status: 404 },
  );
}
