import { redirect } from "next/navigation";

// Sales Analytics now lives at /admin/analytics. Keep old links (and their
// filters) working.
export default function SalesAnalyticsRedirect({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") qs.set(key, value);
  }
  const query = qs.toString();
  redirect(query ? `/admin/analytics?${query}` : "/admin/analytics");
}
