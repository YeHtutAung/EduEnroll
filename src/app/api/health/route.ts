import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractSubdomainFromHost } from "@/lib/tenant";

// Evaluated at build time — used to verify which deployment is serving
const BUILD_TIME = new Date().toISOString();

export async function GET() {
  const h = headers();
  const slug =
    h.get("x-tenant-slug") ||
    extractSubdomainFromHost(h.get("host") ?? "");

  let tenantResult = null;
  let tenantError = null;
  if (slug) {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("tenants")
      .select("id, name, subdomain")
      .eq("subdomain", slug)
      .maybeSingle();
    tenantResult = data;
    tenantError = error;
  }

  return NextResponse.json({
    status: "ok",
    build_time: BUILD_TIME,
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
    ref: process.env.VERCEL_GIT_COMMIT_REF ?? "unknown",
    supabase_url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "not set",
    debug: {
      host: h.get("host"),
      "x-tenant-slug": h.get("x-tenant-slug"),
      "x-forwarded-host": h.get("x-forwarded-host"),
      slug_resolved: slug,
      tenant: tenantResult,
      tenant_error: tenantError,
    },
  });
}
