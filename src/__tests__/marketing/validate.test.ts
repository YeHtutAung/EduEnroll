import { describe, it, expect } from "vitest";
import { validateMarketingContent } from "@/lib/marketing/validate";
import { defaultContent } from "@/lib/marketing/defaultContent";

const clone = () => JSON.parse(JSON.stringify(defaultContent));
const UUID_PNG = "3f2b8c1e-6a4d-4e7b-9c0a-1d2e3f4a5b6c.png";
const expectBad = (c: unknown) => expect(validateMarketingContent(c).ok).toBe(false);

describe("validateMarketingContent", () => {
  it("accepts defaultContent and returns it unchanged", () => {
    const r = validateMarketingContent(clone());
    expect(r).toEqual({ ok: true, content: defaultContent });
  });

  it.each([null, "x", [], 7])("rejects non-object %s", (v) => expectBad(v));

  it("rejects an unknown top-level key", () => {
    expectBad({ ...clone(), extra: 1 });
  });

  it("rejects an unknown nested key", () => {
    const c = clone();
    c.hero.href = "javascript:alert(1)";
    expectBad(c);
  });

  it("rejects a missing key", () => {
    const c = clone();
    delete c.seo.title;
    expectBad(c);
  });

  it("rejects the wrong schema version", () => {
    expectBad({ ...clone(), schemaVersion: 2 });
  });

  it("rejects oversized and blank text", () => {
    const a = clone();
    a.seo.title = "x".repeat(121);
    expectBad(a);
    const b = clone();
    b.hero.eyebrow = "   ";
    expectBad(b);
  });

  it.each([
    "https://evil.example/x.png",
    "//evil.example/x.png",
    "/marketing/../secret.png",
    "/other/x.png",
    "javascript:alert(1)",
    "/marketing/x.svg",
  ])("rejects static path %s", (path) => {
    const c = clone();
    c.hero.image.path = path;
    expectBad(c);
  });

  it("accepts the known payment logo files only outside /marketing", () => {
    const c = clone();
    c.payments.items[0].images[0].path = "/visa.svg";
    expect(validateMarketingContent(c).ok).toBe(true);
  });

  it("accepts a bucket path in the shape the upload route generates", () => {
    const c = clone();
    c.hero.image = { kind: "bucket", path: UUID_PNG, width: 10, height: 10 };
    expect(validateMarketingContent(c).ok).toBe(true);
  });

  it.each(["a/b.png", "../x.png", "x.png", "3f2b8c1e-6a4d-4e7b-9c0a-1d2e3f4a5b6c.svg"])(
    "rejects bucket path %s",
    (path) => {
      const c = clone();
      c.hero.image = { kind: "bucket", path, width: 10, height: 10 };
      expectBad(c);
    },
  );

  it("rejects bad dimensions", () => {
    const c = clone();
    c.hero.image.width = 0;
    expectBad(c);
    const d = clone();
    d.hero.image.height = 6001;
    expectBad(d);
  });

  it("caps list lengths", () => {
    const c = clone();
    c.organizers.items = Array.from({ length: 25 }, (_, i) => ({
      ...c.organizers.items[0],
      id: `o${i}`,
    }));
    expectBad(c);
  });

  it("rejects duplicate ids", () => {
    const c = clone();
    c.organizers.items[1].id = c.organizers.items[0].id;
    expectBad(c);
  });

  it("keeps fixed-count lists fixed", () => {
    const c = clone();
    c.howItWorks.steps.pop();
    expectBad(c);
  });

  it("allows an empty organizer list, and a null image only on solutions", () => {
    const a = clone();
    a.organizers.items = [];
    expect(validateMarketingContent(a).ok).toBe(true);
    const b = clone();
    b.industries.items[0].image = null;
    expectBad(b);
  });

  it("requires at least one image per payment", () => {
    const c = clone();
    c.payments.items[0].images = [];
    expectBad(c);
  });
});
