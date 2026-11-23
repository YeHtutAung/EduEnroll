import type { createAdminClient } from "@/lib/supabase/admin";

// What the seat-claimed and seat-given-back emails need (design 6.4): the
// leader's live profile address, the seat's tier and the tenant's branding.
// null when any is missing or unreadable: the move has already happened, so
// the caller skips the email and still answers success. Logs nothing itself.

type Admin = ReturnType<typeof createAdminClient>;
type Read<T> = { data: T | null; error: { code?: string } | null };

export interface LeaderNotice {
  to: string;
  tier: string;
  tenantName: string;
  logoUrl?: string;
}

export async function loadLeaderNotice(
  admin: Admin,
  ids: { leaderId: string; ticketId: string; tenantId: string },
): Promise<LeaderNotice | null> {
  const [profile, ticket, tenant] = await Promise.all([
    admin
      .from("buyer_profiles")
      .select("email")
      .eq("id", ids.leaderId)
      .is("deleted_at", null)
      .maybeSingle() as unknown as Promise<Read<{ email: string | null }>>,
    admin
      .from("tickets")
      .select("tier")
      .eq("id", ids.ticketId)
      .eq("tenant_id", ids.tenantId)
      .maybeSingle() as unknown as Promise<Read<{ tier: string }>>,
    admin
      .from("tenants")
      .select("name, logo_url")
      .eq("id", ids.tenantId)
      .maybeSingle() as unknown as Promise<Read<{ name: string; logo_url: string | null }>>,
  ]);
  if (profile.error || ticket.error || tenant.error) return null;
  if (!profile.data?.email || !ticket.data || !tenant.data) return null;
  return {
    to: profile.data.email,
    tier: ticket.data.tier,
    tenantName: tenant.data.name,
    logoUrl: tenant.data.logo_url ?? undefined,
  };
}
