import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { requireSuperadmin } from "@/lib/superadminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { MARKETING_CACHE_TAG } from "@/lib/marketing/content";
import { validateMarketingContent } from "@/lib/marketing/validate";
import { isNotConfigured, isStale, notConfigured, readJsonObject, readVersion, serverError, stale } from "@/lib/marketing/store";

// Every content change raises the revision, and the function rejects any other
// revision, so what gets promoted is exactly what was validated here.
export async function POST(request: Request) {
  const auth = await requireSuperadmin();
  if ("error" in auth) return auth.error;

  const body = await readJsonObject(request);
  const expectedRevision = body?.expectedRevision;
  if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
    return NextResponse.json({ error: "Save the draft before publishing." }, { status: 400 });
  }

  const admin = createAdminClient();
  const { row, error: readError } = await readVersion(admin, "draft");
  if (readError) {
    if (isNotConfigured(readError)) return notConfigured();
    console.error("[marketing] read failed:", readError.code, readError.message);
    return serverError();
  }
  if (!row || row.revision !== expectedRevision) return stale();

  const validated = validateMarketingContent(row.content);
  if (!validated.ok) {
    return NextResponse.json({ error: "Some content is invalid.", errors: validated.errors }, { status: 422 });
  }

  const { error } = (await admin.rpc("publish_marketing_draft", {
    p_expected_revision: expectedRevision,
    p_user_id: auth.profile.id,
  } as never)) as { error: { code?: string; message?: string } | null };
  if (error) {
    if (isStale(error)) return stale();
    if (isNotConfigured(error)) return notConfigured();
    console.error("[marketing] publish failed:", error.code, error.message);
    return serverError();
  }

  revalidateTag(MARKETING_CACHE_TAG);
  return NextResponse.json({ published: true });
}
