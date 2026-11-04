import { cache } from "react";
import { unstable_cache } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { MARKETING_CACHE_TAG, MARKETING_SCHEMA_VERSION, type MarketingContent } from "./content";
import { defaultContent } from "./defaultContent";
import { validateMarketingContent } from "./validate";

// Failures throw inside the cached function so they aren't cached. The key
// carries the database host because environments can share a Vercel data cache
// while reading different databases.
const readPublished = unstable_cache(
  async (): Promise<MarketingContent | null> => {
    const { data, error } = (await createAdminClient()
      .from("marketing_page_versions")
      .select("content")
      .eq("status", "published")
      .maybeSingle()) as {
      data: { content: unknown } | null;
      error: { code?: string; message?: string } | null;
    };
    if (error) throw new Error(`read failed: ${error.code ?? ""} ${error.message ?? ""}`);
    if (!data) return null;
    const result = validateMarketingContent(data.content);
    if (!result.ok) throw new Error(`invalid content: ${result.errors.slice(0, 5).join("; ")}`);
    return result.content;
  },
  ["marketing-published", String(MARKETING_SCHEMA_VERSION), process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""],
  { tags: [MARKETING_CACHE_TAG], revalidate: 300 },
);

/** Never throws: the public page must not fail because of this feature. */
export const getPublishedMarketingContent = cache(async (): Promise<MarketingContent> => {
  try {
    const content = await readPublished();
    if (content) return content;
    console.warn("[marketing] nothing published yet, using defaultContent");
  } catch (e) {
    console.error("[marketing] using defaultContent:", e instanceof Error ? e.message : e);
  }
  return defaultContent;
});
