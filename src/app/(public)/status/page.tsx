import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractSubdomainFromHost } from "@/lib/tenant";
import { statusLookupCopy, type StatusLookupTenant } from "@/lib/enrollment/orderWording";
import StatusLookupClient from "./StatusLookupClient";

// Read here rather than from the status API because the heading and form render
// before there is a reference to look up, and they use the tenant's wording too.
export default async function StatusPage() {
  const headersList = headers();
  const slug =
    headersList.get("x-tenant-slug") ||
    extractSubdomainFromHost(headersList.get("host") ?? "");

  let tenant: StatusLookupTenant | null = null;
  if (slug) {
    const { data, error } = (await createAdminClient()
      .from("tenants")
      .select("org_type, label_student")
      .eq("subdomain", slug)
      .maybeSingle()) as { data: StatusLookupTenant | null; error: unknown };

    if (error) console.error("[status lookup] tenant lookup failed for", slug, error);
    tenant = data;
  }

  return <StatusLookupClient copy={statusLookupCopy(tenant)} />;
}
