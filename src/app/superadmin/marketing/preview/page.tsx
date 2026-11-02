import type { Metadata } from "next";
import { redirect } from "next/navigation";
import MarketingPage from "@/components/marketing/MarketingPage";
import { requireSuperadmin } from "@/lib/superadminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { readVersion } from "@/lib/marketing/store";
import { validateMarketingContent } from "@/lib/marketing/validate";

// Reads the draft directly, never the public cache.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Draft preview",
  robots: { index: false, follow: false },
};

function Message({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6 py-16 text-center text-sm text-gray-600">{children}</div>;
}

export default async function MarketingPreviewPage() {
  // The layout checks this too, but this page reads with the service role.
  const auth = await requireSuperadmin();
  if ("error" in auth) redirect("/login");

  const { row, error } = await readVersion(createAdminClient(), "draft");
  if (error) return <Message>Couldn&apos;t load the draft.</Message>;
  if (!row) return <Message>There&apos;s no saved draft to preview.</Message>;

  const validated = validateMarketingContent(row.content);
  if (!validated.ok) return <Message>This draft has invalid content and can&apos;t be previewed.</Message>;

  return (
    <>
      <div role="status" className="bg-amber-400 px-4 py-2 text-center text-sm font-semibold text-amber-950">
        Draft preview. Visitors don&apos;t see this until it&apos;s published.
      </div>
      <MarketingPage content={validated.content} />
    </>
  );
}
