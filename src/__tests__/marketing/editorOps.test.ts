import { describe, it, expect } from "vitest";
import { getAt, setAt, moveItem, removeAt } from "@/lib/marketing/editorOps";
import { textGroups } from "@/lib/marketing/textFields";
import { defaultContent } from "@/lib/marketing/defaultContent";

describe("editorOps", () => {
  it("reads and writes nested paths without mutating", () => {
    const before = { a: { b: [{ c: 1 }, { c: 2 }] } };
    const after = setAt(before, "a.b.1.c", 9);
    expect(getAt(after, "a.b.1.c")).toBe(9);
    expect(before.a.b[1].c).toBe(2);
    expect(Array.isArray((after as typeof before).a.b)).toBe(true);
    expect((after as typeof before).a.b[0]).toBe(before.a.b[0]);
  });

  it("moves within bounds and ignores moves past the ends", () => {
    expect(moveItem(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });

  it("removes by index", () => {
    expect(removeAt(["a", "b", "c"], 1)).toEqual(["a", "c"]);
  });
});

describe("textGroups", () => {
  it("every field points at text in the content", () => {
    for (const group of textGroups(defaultContent)) {
      for (const field of group.fields) {
        if (field.localized) {
          expect(typeof getAt(defaultContent, `${field.path}.en`), field.path).toBe("string");
          expect(typeof getAt(defaultContent, `${field.path}.mm`), field.path).toBe("string");
        } else {
          expect(typeof getAt(defaultContent, field.path), field.path).toBe("string");
        }
      }
    }
  });

  it("covers every text value in the content, except organizer and payment names", () => {
    const covered = new Set<string>();
    for (const g of textGroups(defaultContent)) {
      for (const f of g.fields) {
        if (f.localized) {
          covered.add(`${f.path}.en`);
          covered.add(`${f.path}.mm`);
        } else {
          covered.add(f.path);
        }
      }
    }
    const walk = (v: unknown, path: string, out: string[]) => {
      if (typeof v === "string") out.push(path);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}.${i}`, out));
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, out);
      }
      return out;
    };
    const missing = walk(defaultContent, "", []).filter(
      (p) =>
        !covered.has(p) &&
        !/\.(image|images)(\.|$)/.test(p) &&
        !/\.id$/.test(p) &&
        !/^seo\./.test(p) && // Sections & SEO tab
        !/^organizers\.items\.\d+\.name$/.test(p) && // Partner logos tab
        !/^payments\.items\.\d+\.name$/.test(p), // Accepted payments tab
    );
    expect(missing).toEqual([]);
  });
});
