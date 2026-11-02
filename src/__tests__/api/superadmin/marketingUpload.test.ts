import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/superadminAuth", () => ({ requireSuperadmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { requireSuperadmin } from "@/lib/superadminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { POST } from "@/app/api/superadmin/marketing/upload/route";
import { validateMarketingContent } from "@/lib/marketing/validate";
import { defaultContent } from "@/lib/marketing/defaultContent";

const MB = 1024 * 1024;

const pngBytes = (w = 100, h = 50, size = 24) => {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};

function form(files: { bytes: Uint8Array; name?: string; type?: string }[], headers: Record<string, string> = {}) {
  const fd = new FormData();
  for (const f of files) fd.append("file", new File([f.bytes as BlobPart], f.name ?? "logo.png", { type: f.type ?? "image/png" }));
  return new Request("http://localhost/api/superadmin/marketing/upload", { method: "POST", body: fd, headers }) as never;
}

function mockStorage(result: { error: unknown } = { error: null }) {
  const upload = vi.fn().mockResolvedValue(result);
  const from = vi.fn().mockReturnValue({ upload });
  vi.mocked(createAdminClient).mockReturnValue({ storage: { from } } as never);
  return { upload, from };
}

describe("POST /api/superadmin/marketing/upload", () => {
  let err: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(requireSuperadmin).mockResolvedValue({ profile: { id: "s" } } as never);
  });
  afterEach(() => err.mockRestore());

  it.each([
    [401, "Unauthorized"],
    [403, "Forbidden"],
  ])("returns %i and touches no data", async (status, error) => {
    vi.mocked(requireSuperadmin).mockResolvedValue({ error: NextResponse.json({ error }, { status }) } as never);
    expect((await POST(form([{ bytes: pngBytes() }]))).status).toBe(status);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("413s on a declared body over the ceiling, before parsing", async () => {
    const m = mockStorage();
    const req = new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-length": String(Math.ceil(4.25 * MB) + 1) },
      body: "x",
    });
    const spy = vi.spyOn(req, "formData");
    expect((await POST(req as never)).status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
    expect(m.upload).not.toHaveBeenCalled();
  });

  it("accepts exactly 4 MB, and 413s one byte over even with no usable header", async () => {
    const m = mockStorage();
    expect((await POST(form([{ bytes: pngBytes(100, 50, 4 * MB) }]))).status).toBe(200);
    m.upload.mockClear();
    expect((await POST(form([{ bytes: pngBytes(100, 50, 4 * MB + 1) }]))).status).toBe(413);
    expect(m.upload).not.toHaveBeenCalled();
  });

  it("400s on no file and on more than one", async () => {
    const m = mockStorage();
    expect((await POST(form([]))).status).toBe(400);
    expect((await POST(form([{ bytes: pngBytes() }, { bytes: pngBytes() }]))).status).toBe(400);
    expect(m.upload).not.toHaveBeenCalled();
  });

  it("rejects SVG even when declared as PNG", async () => {
    const m = mockStorage();
    const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    expect((await POST(form([{ bytes, name: "x.png", type: "image/png" }]))).status).toBe(415);
    expect(m.upload).not.toHaveBeenCalled();
  });

  it("rejects images over 6000 px", async () => {
    const m = mockStorage();
    expect((await POST(form([{ bytes: pngBytes(6001, 10) }]))).status).toBe(422);
    expect(m.upload).not.toHaveBeenCalled();
  });

  it("picks the path and type itself and never overwrites", async () => {
    const m = mockStorage();
    const res = await POST(form([{ bytes: pngBytes(100, 50), name: "../../evil.svg", type: "image/svg+xml" }]));
    expect(res.status).toBe(200);
    const { image } = await res.json();
    expect(image).toMatchObject({ kind: "bucket", width: 100, height: 50 });
    expect(image.path).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(m.from).toHaveBeenCalledWith("marketing-assets");
    const [path, , options] = m.upload.mock.calls[0];
    expect(path).toBe(image.path);
    expect(options).toMatchObject({ contentType: "image/png", upsert: false });
  });

  it("returns an image reference the validator accepts", async () => {
    mockStorage();
    const { image } = await (await POST(form([{ bytes: pngBytes() }]))).json();
    const c = { ...defaultContent, hero: { ...defaultContent.hero, image } };
    expect(validateMarketingContent(c).ok).toBe(true);
  });

  it.each([
    [{ message: "Bucket not found" }],
    [{ message: "not found", statusCode: "NoSuchBucket" }],
  ])("503s when the bucket doesn't exist: %j", async (error) => {
    mockStorage({ error });
    expect((await POST(form([{ bytes: pngBytes() }]))).status).toBe(503);
  });
});
