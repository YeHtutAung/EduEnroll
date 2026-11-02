import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { requireSuperadmin } from "@/lib/superadminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { STORAGE_CACHE_CONTROL } from "@/lib/storage/cache";
import { MARKETING_BUCKET, type ImageRef } from "@/lib/marketing/content";
import { detectImage } from "@/lib/marketing/imageBytes";
import { isNotConfigured, notConfigured, serverError } from "@/lib/marketing/store";

// Vercel caps request bodies at about 4.5 MB. Past that the caller gets a platform
// error, so the limit stays under it. Content-Length counts the whole multipart
// body, hence the separate ceiling, and it can be missing or wrong, hence the exact
// check on the parsed file.
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_BODY_BYTES = 4.25 * 1024 * 1024;
const MAX_SIDE = 6000;

const tooLarge = () => NextResponse.json({ error: "Images can be up to 4 MB." }, { status: 413 });

export async function POST(request: Request) {
  const auth = await requireSuperadmin();
  if ("error" in auth) return auth.error;

  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return tooLarge();

  const form = await request.formData().catch(() => null);
  const files = form?.getAll("file") ?? [];
  const file = files[0];
  if (files.length !== 1 || !(file instanceof File)) {
    return NextResponse.json({ error: "Send one image file." }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) return tooLarge();

  const bytes = new Uint8Array(await file.arrayBuffer());
  const detected = detectImage(bytes);
  if (!detected) {
    return NextResponse.json({ error: "Use a JPEG, PNG or WebP image." }, { status: 415 });
  }
  if (detected.width > MAX_SIDE || detected.height > MAX_SIDE) {
    return NextResponse.json({ error: `Images can be up to ${MAX_SIDE} px on a side.` }, { status: 422 });
  }

  // A new path per upload keeps older published versions working.
  const path = `${randomUUID()}.${detected.ext}`;
  const { error } = await createAdminClient()
    .storage.from(MARKETING_BUCKET)
    .upload(path, bytes, {
      contentType: detected.mime,
      cacheControl: STORAGE_CACHE_CONTROL,
      upsert: false,
    });
  if (error) {
    if (isNotConfigured(error)) return notConfigured();
    console.error("[marketing] upload failed:", error.message);
    return serverError();
  }

  const image: ImageRef = { kind: "bucket", path, width: detected.width, height: detected.height };
  return NextResponse.json({ image });
}
