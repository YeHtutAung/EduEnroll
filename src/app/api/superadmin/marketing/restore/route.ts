import { NextResponse } from "next/server";
import { requireSuperadmin } from "@/lib/superadminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateMarketingContent } from "@/lib/marketing/validate";
import {
  errorResponse, isNotConfigured, isUuid, notConfigured, parseWriteTarget, readJsonObject, serverError, writeDraft,
} from "@/lib/marketing/store";
import type { MarketingPageVersion } from "@/types/database";

// Copies an archived version into the draft. It never publishes: a restore goes
// through preview and publish like any other edit.
export async function POST(request: Request) {
  const auth = await requireSuperadmin();
  if ("error" in auth) return auth.error;

  const body = await readJsonObject(request);
  const target = body && parseWriteTarget(body);
  if (!body || !target || !isUuid(body.versionId)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: version, error } = (await admin
    .from("marketing_page_versions")
    .select("id, status, content")
    .eq("id", body.versionId)
    .maybeSingle()) as {
    data: Pick<MarketingPageVersion, "id" | "status" | "content"> | null;
    error: { code?: string; message?: string } | null;
  };
  if (error) {
    if (isNotConfigured(error)) return notConfigured();
    console.error("[marketing] read failed:", error.code, error.message);
    return serverError();
  }
  if (!version || version.status !== "archived") {
    return NextResponse.json({ error: "Version not found." }, { status: 404 });
  }

  const validated = validateMarketingContent(version.content);
  if (!validated.ok) {
    return NextResponse.json({ error: "This version can't be restored.", errors: validated.errors }, { status: 422 });
  }

  const result = await writeDraft(admin, { content: validated.content, ...target, userId: auth.profile.id });
  if (!result.ok) return errorResponse(result.reason);
  return NextResponse.json({ revision: result.revision, content: validated.content });
}
