import { NextResponse } from "next/server";
import { requireSuperadmin } from "@/lib/superadminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { defaultContent } from "@/lib/marketing/defaultContent";
import { validateMarketingContent } from "@/lib/marketing/validate";
import { isNotConfigured, listArchived, notConfigured, readVersion, serverError } from "@/lib/marketing/store";

export const dynamic = "force-dynamic";

// Never writes. With no draft, the starting draft has revision 0 and names the
// published row it started from, which the first save must still match.
export async function GET() {
  const auth = await requireSuperadmin();
  if ("error" in auth) return auth.error;

  const admin = createAdminClient();
  const [draft, published, archived] = await Promise.all([
    readVersion(admin, "draft"),
    readVersion(admin, "published"),
    listArchived(admin),
  ]);

  const error = draft.error ?? published.error ?? archived.error;
  if (error) {
    if (isNotConfigured(error)) return notConfigured();
    console.error("[marketing] read failed:", error.code, error.message);
    return serverError();
  }

  const source = draft.row ?? published.row;
  const validated = source ? validateMarketingContent(source.content) : null;

  return NextResponse.json({
    draft: {
      content: validated?.ok ? validated.content : defaultContent,
      contentInvalid: validated ? !validated.ok : false,
      revision: draft.row?.revision ?? 0,
      basePublishedId: draft.row ? null : published.row?.id ?? null,
      updatedAt: draft.row?.updated_at ?? null,
    },
    published: published.row ? { id: published.row.id, publishedAt: published.row.published_at } : null,
    versions: archived.rows.map((v) => ({ id: v.id, publishedAt: v.published_at })),
  });
}
