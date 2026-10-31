import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// gtm_container_id is read in its own query in these files, so a database that
// does not have the column yet degrades to "GTM off" instead of losing the
// tenant name, logo, org type or settings defaults. Static check: every
// `.from("tenants").select(...)` that names gtm_container_id must name only it.

const FILES = ["src/app/(public)/layout.tsx", "src/app/admin/settings/page.tsx"];

function tenantSelects(src: string): string[] {
  const out: string[] = [];
  const re = /\.from\(\s*["']tenants["']\s*\)\s*\.select\(\s*["'`]([^"'`]*)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

describe("gtm_container_id is read separately", () => {
  it.each(FILES)("%s: the main tenant select does not mention gtm_container_id", (file) => {
    const src = readFileSync(join(process.cwd(), file), "utf8");
    const selects = tenantSelects(src);
    expect(selects.length).toBeGreaterThan(0);
    for (const cols of selects) {
      if (cols.includes("gtm_container_id")) {
        expect(cols.trim(), `${file}: ${cols}`).toBe("gtm_container_id");
      }
    }
    // And the column is still read somewhere, on its own.
    expect(selects.map((s) => s.trim())).toContain("gtm_container_id");
  });

  it("the extractor sees a combined select", () => {
    expect(
      tenantSelects(`x.from("tenants")\n  .select("name, gtm_container_id")`),
    ).toEqual(["name, gtm_container_id"]);
  });
});
