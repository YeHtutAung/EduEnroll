import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";

vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));
vi.mock("@/lib/superadminAuth", () => ({ requireSuperadmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { revalidateTag } from "next/cache";
import { requireSuperadmin } from "@/lib/superadminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { GET } from "@/app/api/superadmin/marketing/route";
import { PUT } from "@/app/api/superadmin/marketing/draft/route";
import { POST as PUBLISH } from "@/app/api/superadmin/marketing/publish/route";
import { POST as RESTORE } from "@/app/api/superadmin/marketing/restore/route";
import { defaultContent } from "@/lib/marketing/defaultContent";
import { MARKETING_CACHE_TAG } from "@/lib/marketing/content";

const SUPER = "4f2b8c1e-6a4d-4e7b-9c0a-1d2e3f4a5b6c";
const BASE = "5f2b8c1e-6a4d-4e7b-9c0a-1d2e3f4a5b6c";
const ARCHIVED = "6f2b8c1e-6a4d-4e7b-9c0a-1d2e3f4a5b6c";
const NOT_CONFIGURED = { code: "PGRST205", message: "table not found" };

const req = (body: unknown, method = "POST") =>
  new Request("http://localhost/api/superadmin/marketing", {
    method,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as never;

const draftRow = (revision = 3, content: unknown = defaultContent) => ({
  id: "d1", status: "draft", content, revision, updated_at: "2026-11-02T00:00:00Z", published_at: null,
});

/** A fake table: filters are recorded and the terminal call returns what the test queued. */
function mockAdmin(opts: {
  rows?: Record<string, unknown>;
  archived?: unknown[];
  selectError?: unknown;
  update?: { data: unknown; error: unknown };
  rpc?: { data?: unknown; error: unknown };
} = {}) {
  const update = vi.fn();
  const rpc = vi.fn().mockResolvedValue(opts.rpc ?? { data: "new-id", error: null });

  const from = vi.fn(() => {
    const filters: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {
      select: () => chain,
      order: () => chain,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      },
      limit: async () => ({ data: opts.archived ?? [], error: opts.selectError ?? null }),
      maybeSingle: async () => {
        if (opts.selectError) return { data: null, error: opts.selectError };
        const key = (filters.id as string) ?? (filters.status as string);
        return { data: opts.rows?.[key] ?? null, error: null };
      },
      update: (values: unknown) => {
        update(values);
        return {
          eq: () => ({
            eq: () => ({
              select: async () => opts.update ?? { data: [{ id: "d1" }], error: null },
            }),
          }),
        };
      },
    };
    return chain;
  });
  vi.mocked(createAdminClient).mockReturnValue({ from, rpc } as never);
  return { from, rpc, update };
}

const HANDLERS: [string, () => Promise<Response>][] = [
  ["GET /", () => GET()],
  ["PUT /draft", () => PUT(req({ content: defaultContent, expectedRevision: 1 }, "PUT"))],
  ["POST /publish", () => PUBLISH(req({ expectedRevision: 1 }))],
  ["POST /restore", () => RESTORE(req({ versionId: ARCHIVED, expectedRevision: 1 }))],
];

describe("marketing routes", () => {
  let err: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(requireSuperadmin).mockResolvedValue({ profile: { id: SUPER } } as never);
  });
  afterEach(() => err.mockRestore());

  describe.each(HANDLERS)("%s auth", (_name, call) => {
    it.each([
      [401, "Unauthorized"],
      [403, "Forbidden"],
    ])("returns %i and touches no data", async (status, error) => {
      vi.mocked(requireSuperadmin).mockResolvedValue({
        error: NextResponse.json({ error }, { status }),
      } as never);
      expect((await call()).status).toBe(status);
      expect(createAdminClient).not.toHaveBeenCalled();
    });
  });

  describe("GET /", () => {
    it("returns a starting draft from defaults, without writing", async () => {
      const m = mockAdmin();
      const body = await (await GET()).json();
      expect(body.draft).toMatchObject({ revision: 0, basePublishedId: null });
      expect(body.draft.content).toEqual(defaultContent);
      expect(m.update).not.toHaveBeenCalled();
      expect(m.rpc).not.toHaveBeenCalled();
    });

    it("starts from published content with its id as the base", async () => {
      const published = { ...defaultContent, seo: { ...defaultContent.seo, title: "Live" } };
      mockAdmin({ rows: { published: { id: BASE, content: published, published_at: "t" } } });
      const body = await (await GET()).json();
      expect(body.draft).toMatchObject({ revision: 0, basePublishedId: BASE });
      expect(body.draft.content.seo.title).toBe("Live");
      expect(body.published).toEqual({ id: BASE, publishedAt: "t" });
    });

    it("returns the draft row when there is one", async () => {
      mockAdmin({ rows: { draft: draftRow(3) } });
      const body = await (await GET()).json();
      expect(body.draft.revision).toBe(3);
    });

    it("flags stored content it can't edit and offers defaults", async () => {
      mockAdmin({ rows: { draft: draftRow(3, { bad: true }) } });
      const body = await (await GET()).json();
      expect(body.draft.contentInvalid).toBe(true);
      expect(body.draft.revision).toBe(3);
      expect(body.draft.content).toEqual(defaultContent);
    });

    it("returns 503 when the migration isn't applied", async () => {
      mockAdmin({ selectError: NOT_CONFIGURED });
      expect((await GET()).status).toBe(503);
    });
  });

  describe("PUT /draft", () => {
    const put = (b: unknown) => PUT(req(b, "PUT"));

    it("400s on bad JSON and a bad revision", async () => {
      mockAdmin();
      expect((await put("{")).status).toBe(400);
      expect((await put({ content: defaultContent, expectedRevision: -1 })).status).toBe(400);
      expect((await put({ content: defaultContent, expectedRevision: 1.5 })).status).toBe(400);
    });

    it("400s on a first save with no base field", async () => {
      mockAdmin();
      expect((await put({ content: defaultContent, expectedRevision: 0 })).status).toBe(400);
    });

    it("422s on invalid content and writes nothing", async () => {
      const m = mockAdmin();
      const res = await put({ content: { bad: true }, expectedRevision: 1 });
      expect(res.status).toBe(422);
      expect((await res.json()).errors.length).toBeGreaterThan(0);
      expect(m.update).not.toHaveBeenCalled();
    });

    it("first save calls the create function with the base", async () => {
      const m = mockAdmin();
      const res = await put({ content: defaultContent, expectedRevision: 0, basePublishedId: BASE });
      expect(res.status).toBe(200);
      expect((await res.json()).revision).toBe(1);
      expect(m.rpc).toHaveBeenCalledWith("create_marketing_draft", {
        p_base_published_id: BASE,
        p_content: defaultContent,
        p_user_id: SUPER,
      });
    });

    it("409s when the first save is stale", async () => {
      mockAdmin({ rpc: { error: { message: "marketing_draft_stale" } } });
      const res = await put({ content: defaultContent, expectedRevision: 0, basePublishedId: null });
      expect(res.status).toBe(409);
    });

    it("a later save raises the revision", async () => {
      const m = mockAdmin();
      const res = await put({ content: defaultContent, expectedRevision: 3 });
      expect((await res.json()).revision).toBe(4);
      expect(m.update.mock.calls[0][0]).toMatchObject({ revision: 4 });
    });

    it("409s when a later save matches no row", async () => {
      mockAdmin({ update: { data: [], error: null } });
      expect((await put({ content: defaultContent, expectedRevision: 3 })).status).toBe(409);
    });

    it("503s when the migration isn't applied", async () => {
      mockAdmin({ update: { data: null, error: NOT_CONFIGURED } });
      expect((await put({ content: defaultContent, expectedRevision: 3 })).status).toBe(503);
    });
  });

  describe("POST /publish", () => {
    const publish = (b: unknown) => PUBLISH(req(b));

    it("400s without a saved revision", async () => {
      mockAdmin();
      expect((await publish({ expectedRevision: 0 })).status).toBe(400);
    });

    it("409s when the draft isn't at that revision, and doesn't call the function", async () => {
      const m = mockAdmin({ rows: { draft: draftRow(4) } });
      expect((await publish({ expectedRevision: 3 })).status).toBe(409);
      expect(m.rpc).not.toHaveBeenCalled();
    });

    it("422s on invalid stored content", async () => {
      const m = mockAdmin({ rows: { draft: draftRow(3, { bad: true }) } });
      expect((await publish({ expectedRevision: 3 })).status).toBe(422);
      expect(m.rpc).not.toHaveBeenCalled();
    });

    it("publishes, then clears the cache", async () => {
      const m = mockAdmin({ rows: { draft: draftRow(3) } });
      expect((await publish({ expectedRevision: 3 })).status).toBe(200);
      expect(m.rpc).toHaveBeenCalledWith("publish_marketing_draft", {
        p_expected_revision: 3,
        p_user_id: SUPER,
      });
      expect(revalidateTag).toHaveBeenCalledWith(MARKETING_CACHE_TAG);
    });

    it("409s if the function rejects it, and leaves the cache alone", async () => {
      mockAdmin({ rows: { draft: draftRow(3) }, rpc: { error: { message: "marketing_draft_stale" } } });
      expect((await publish({ expectedRevision: 3 })).status).toBe(409);
      expect(revalidateTag).not.toHaveBeenCalled();
    });
  });

  describe("POST /restore", () => {
    const restore = (b: unknown) => RESTORE(req(b));
    const archived = (content: unknown = defaultContent) => ({ [ARCHIVED]: { id: ARCHIVED, status: "archived", content } });

    it("400s on a bad version id", async () => {
      mockAdmin();
      expect((await restore({ versionId: "x", expectedRevision: 1 })).status).toBe(400);
    });

    it("404s on a version that isn't archived", async () => {
      mockAdmin({ rows: { [ARCHIVED]: { id: ARCHIVED, status: "published", content: defaultContent } } });
      expect((await restore({ versionId: ARCHIVED, expectedRevision: 1 })).status).toBe(404);
    });

    it("422s on an old version that no longer validates", async () => {
      const m = mockAdmin({ rows: archived({ old: true }) });
      expect((await restore({ versionId: ARCHIVED, expectedRevision: 1 })).status).toBe(422);
      expect(m.update).not.toHaveBeenCalled();
    });

    it("copies into the draft and never publishes", async () => {
      const m = mockAdmin({ rows: archived() });
      const res = await restore({ versionId: ARCHIVED, expectedRevision: 2 });
      expect(res.status).toBe(200);
      expect((await res.json()).revision).toBe(3);
      expect(m.rpc).not.toHaveBeenCalledWith("publish_marketing_draft", expect.anything());
      expect(revalidateTag).not.toHaveBeenCalled();
    });

    it("409s on a stale revision", async () => {
      mockAdmin({ rows: archived(), update: { data: [], error: null } });
      expect((await restore({ versionId: ARCHIVED, expectedRevision: 2 })).status).toBe(409);
    });

    it("with no draft, uses the create function and the base", async () => {
      const m = mockAdmin({ rows: archived() });
      await restore({ versionId: ARCHIVED, expectedRevision: 0, basePublishedId: BASE });
      expect(m.rpc).toHaveBeenCalledWith("create_marketing_draft", expect.objectContaining({ p_base_published_id: BASE }));
    });
  });
});
