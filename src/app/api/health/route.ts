import { NextResponse } from "next/server";
import { headers } from "next/headers";

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
      has_authorization: !!authHeader,
      authorization_prefix: authHeader?.substring(0, 15) ?? null,
      has_x_supabase_auth: !!supabaseAuthHeader,
      has_x_tenant_slug: !!headersList.get("x-tenant-slug"),
      x_tenant_slug: headersList.get("x-tenant-slug"),
    },
  });
}
