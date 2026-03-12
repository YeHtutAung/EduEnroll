import { NextResponse } from "next/server";
import { headers } from "next/headers";

// Evaluated at build time — used to verify which deployment is serving
const BUILD_TIME = new Date().toISOString();

export async function GET() {
  const headersList = headers();
  const authHeader = headersList.get("authorization");
  const supabaseAuthHeader = headersList.get("x-supabase-auth");

  return NextResponse.json({
    status: "ok",
    build_time: BUILD_TIME,
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
    ref: process.env.VERCEL_GIT_COMMIT_REF ?? "unknown",
    debug: {
      supabase_url: process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/https?:\/\//, "").split(".")[0] ?? null,
      has_authorization: !!authHeader,
      authorization_prefix: authHeader?.substring(0, 15) ?? null,
      has_x_supabase_auth: !!supabaseAuthHeader,
      has_x_tenant_slug: !!headersList.get("x-tenant-slug"),
      x_tenant_slug: headersList.get("x-tenant-slug"),
    },
  });
}
