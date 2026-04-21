import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "NOT SET";
  const serviceKeySet = !!process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKeySet = !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // Show first/last 4 chars of keys to verify they're the right ones
  const sKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const aKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

  // Actually query the DB to see what tenants exist
  let tenants: string[] = [];
  let dbError: string | null = null;
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase.from("tenants").select("subdomain");
    if (error) dbError = error.message;
    else tenants = (data ?? []).map((t: { subdomain: string }) => t.subdomain);
  } catch (e) {
    dbError = String(e);
  }

  return NextResponse.json({
    supabase_url: url,
    service_key_set: serviceKeySet,
    anon_key_set: anonKeySet,
    service_key_hint: sKey ? `${sKey.slice(0, 8)}...${sKey.slice(-4)}` : "NOT SET",
    anon_key_hint: aKey ? `${aKey.slice(0, 8)}...${aKey.slice(-4)}` : "NOT SET",
    node_env: process.env.NODE_ENV,
    vercel_env: process.env.VERCEL_ENV,
    tenants_in_db: tenants,
    db_error: dbError,
  });
}
