import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "NOT SET";
  // Only show the project ref (safe to expose), not full keys
  const serviceKeySet = !!process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKeySet = !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  return NextResponse.json({
    supabase_url: url,
    service_key_set: serviceKeySet,
    anon_key_set: anonKeySet,
    node_env: process.env.NODE_ENV,
    vercel_env: process.env.VERCEL_ENV,
  });
}
