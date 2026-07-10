import { createHash, timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function resolveScannerTenant(request: NextRequest): Promise<string | null> {
  const auth = request.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const hash = hashApiKey(m[1].trim());
  const supabase = createAdminClient();
  const { data } = (await supabase
    .from("scanner_api_keys")
    .select("tenant_id, revoked_at, key_hash")
    .eq("key_hash", hash)
    .is("revoked_at", null)
    .single()) as unknown as {
    data: { tenant_id: string; revoked_at: string | null; key_hash: string } | null;
  };
  if (!data) return null;
  // constant-time re-check
  const a = Buffer.from(hash);
  const b = Buffer.from(data.key_hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  void supabase
    .from("scanner_api_keys")
    .update({ last_used_at: new Date().toISOString() } as never)
    .eq("key_hash", hash);
  return data.tenant_id;
}
