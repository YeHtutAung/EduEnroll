import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// unstable_cache needs Next's incremental cache, which doesn't exist in Vitest.
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: (fn: unknown) => fn }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import { getPublishedMarketingContent } from "@/lib/marketing/published";
import { defaultContent } from "@/lib/marketing/defaultContent";

function mockRead(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const chain = { select: () => chain, eq: () => chain, maybeSingle };
  vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);
}

describe("getPublishedMarketingContent", () => {
  let err: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    err = vi.spyOn(console, "error").mockImplementation(() => {});
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    err.mockRestore();
    warn.mockRestore();
  });

  it("returns published content when it is valid", async () => {
    const published = { ...defaultContent, seo: { ...defaultContent.seo, title: "Published" } };
    mockRead({ data: { content: published }, error: null });
    expect((await getPublishedMarketingContent()).seo.title).toBe("Published");
  });

  it("falls back and warns when no row exists", async () => {
    mockRead({ data: null, error: null });
    expect(await getPublishedMarketingContent()).toEqual(defaultContent);
    expect(warn).toHaveBeenCalled();
  });

  it("falls back and logs on a query error, such as a missing table", async () => {
    mockRead({ data: null, error: { code: "42P01", message: "does not exist" } });
    expect(await getPublishedMarketingContent()).toEqual(defaultContent);
    expect(err).toHaveBeenCalled();
  });

  it("falls back and logs on invalid content", async () => {
    mockRead({ data: { content: { nope: true } }, error: null });
    expect(await getPublishedMarketingContent()).toEqual(defaultContent);
    expect(err).toHaveBeenCalled();
  });

  it("falls back when the client can't be created", async () => {
    vi.mocked(createAdminClient).mockImplementation(() => {
      throw new Error("no env");
    });
    expect(await getPublishedMarketingContent()).toEqual(defaultContent);
    expect(err).toHaveBeenCalled();
  });
});
