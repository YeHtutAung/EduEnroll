import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";

const ALLOWED_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];
const MAX_SIZE = 5 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;

  const formData = await request.formData().catch(() => null);
  if (!formData) return NextResponse.json({ error: "Invalid form data." }, { status: 400 });

  const file = formData.get("file") as File | null;
  const type = formData.get("type") as string | null;

  if (!file) return NextResponse.json({ error: "No file provided." }, { status: 400 });
  if (!["logo", "hero"].includes(type ?? "")) {
    return NextResponse.json({ error: "type must be 'logo' or 'hero'." }, { status: 400 });
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json({ error: "Invalid file type. Use JPEG, PNG, WebP, or GIF." }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: "File too large. Max 5 MB." }, { status: 400 });
  }

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "jpg";
  const path = `${tenantId}/${type}/${Date.now()}.${ext}`;
  const buffer = await file.arrayBuffer();

  const supabase = createAdminClient();
  const { error } = await supabase.storage
    .from("tenant-assets")
    .upload(path, buffer, { contentType: file.type, upsert: true });

  if (error) return NextResponse.json({ error: "Upload failed. Please try again." }, { status: 500 });

  const { data: urlData } = supabase.storage.from("tenant-assets").getPublicUrl(path);

  return NextResponse.json({ url: urlData.publicUrl });
}
