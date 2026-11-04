import { NextResponse } from "next/server";
import { requireSuperadmin } from "@/lib/superadminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateMarketingContent } from "@/lib/marketing/validate";
import { errorResponse, parseWriteTarget, readJsonObject, writeDraft } from "@/lib/marketing/store";

export async function PUT(request: Request) {
  const auth = await requireSuperadmin();
  if ("error" in auth) return auth.error;

  const body = await readJsonObject(request);
  const target = body && parseWriteTarget(body);
  if (!body || !target) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  const validated = validateMarketingContent(body.content);
  if (!validated.ok) {
    return NextResponse.json({ error: "Some content is invalid.", errors: validated.errors }, { status: 422 });
  }

  const result = await writeDraft(createAdminClient(), {
    content: validated.content,
    ...target,
    userId: auth.profile.id,
  });
  if (!result.ok) return errorResponse(result.reason);
  return NextResponse.json({ revision: result.revision });
}
