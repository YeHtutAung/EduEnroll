import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "NOT SET";
  const sKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const aKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

  // 1. Supabase JS client query
  let jsResult: unknown = null;
  let jsAllTenants: string[] = [];
  try {
    const supabase = createAdminClient();
    const { data } = await supabase.from("tenants").select("subdomain");
    jsAllTenants = (data ?? []).map((t: { subdomain: string }) => t.subdomain);

    const r = await supabase.from("tenants").select("id").eq("subdomain", "ideapro").maybeSingle();
    jsResult = { data: r.data, error: r.error?.message ?? null };
  } catch (e) {
    jsResult = { error: String(e) };
  }

  // 2. Raw fetch to PostgREST (bypass JS client entirely)
  let rawResult: unknown = null;
  try {
    const res = await fetch(
      `${url}/rest/v1/tenants?subdomain=eq.ideapro&select=id,subdomain`,
      {
        headers: {
          apikey: aKey,
          Authorization: `Bearer ${sKey}`,
          "Cache-Control": "no-cache",
        },
        cache: "no-store",
      },
    );
    rawResult = await res.json();
  } catch (e) {
    rawResult = { error: String(e) };
  }

  // 3. Raw fetch ALL tenants
  let rawAll: unknown = null;
  try {
    const res = await fetch(
      `${url}/rest/v1/tenants?select=subdomain&order=subdomain`,
      {
        headers: {
          apikey: aKey,
          Authorization: `Bearer ${sKey}`,
          "Cache-Control": "no-cache",
        },
        cache: "no-store",
      },
    );
    rawAll = await res.json();
  } catch (e) {
    rawAll = { error: String(e) };
  }

  return NextResponse.json({
    supabase_url: url,
    service_key_hint: sKey ? `${sKey.slice(0, 8)}...${sKey.slice(-4)}` : "NOT SET",
    anon_key_hint: aKey ? `${aKey.slice(0, 8)}...${aKey.slice(-4)}` : "NOT SET",
    vercel_env: process.env.VERCEL_ENV,
    js_client_all_tenants: jsAllTenants,
    js_client_ideapro: jsResult,
    raw_fetch_ideapro: rawResult,
    raw_fetch_all: rawAll,
  });
}
