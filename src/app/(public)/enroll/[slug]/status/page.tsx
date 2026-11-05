import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractSubdomainFromHost } from "@/lib/tenant";
import { statusPageCopy, type StatusPageTenant } from "@/lib/enrollment/statusPageCopy";
import StatusClient from "./StatusClient";

// Read here rather than from the status API because the lookup form renders before
// there is a reference to look up, and it has to use the tenant's wording too.
export default async function StatusPage() {
  const headersList = headers();
  const slug =
    headersList.get("x-tenant-slug") ||
    extractSubdomainFromHost(headersList.get("host") ?? "");

  let tenant: StatusPageTenant | null = null;
  if (slug) {
    const { data, error } = (await createAdminClient()
      .from("tenants")
      .select("org_type, label_class, label_fee")
      .eq("subdomain", slug)
      .maybeSingle()) as { data: StatusPageTenant | null; error: unknown };

    if (error) console.error("[status page] tenant lookup failed for", slug, error);
    tenant = data;
  }

  return <StatusClient copy={statusPageCopy(tenant)} />;
}
