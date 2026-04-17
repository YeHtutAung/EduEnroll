import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createClient as createBareClient, type SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractSubdomainFromHost } from "@/lib/tenant";
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

    const slug = headersList.get("x-tenant-slug");
    if (!slug) {
      return NextResponse.json(
        { error: "Bad Request", message: "x-tenant-slug header required." },
        { status: 400 },
      );
    }

    const adminSupabase = createAdminClient();

    const { data: tenant } = (await adminSupabase
      .from("tenants")
      .select("id")
      .eq("subdomain", slug)
      .single()) as { data: { id: string } | null; error: unknown };

    if (!tenant) {
      return NextResponse.json({ error: "Not Found", message: "Tenant not found." }, { status: 404 });
    }

    // Verify chat_id is still in allowed_chat_ids (revocation check)
    const { data: config } = (await adminSupabase
      .from("tenant_telegram_configs")
      .select("allowed_chat_ids")
      .eq("tenant_id", tenant.id)
      .single()) as { data: { allowed_chat_ids: number[] | null } | null; error: unknown };

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
