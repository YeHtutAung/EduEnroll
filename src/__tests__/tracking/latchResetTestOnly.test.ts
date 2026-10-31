import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// resetGtmDocumentLatchForTests starts a fresh "document" for the per-document
// GTM latch. Only tests may call it: in app code it would undo the latch.
// Static check: outside src/__tests__, the name appears only where it is
// defined, src/lib/tagManager.ts.

const ROOT = process.cwd();
const NAME = "resetGtmDocumentLatchForTests";
const DEFINED_IN = "src/lib/tagManager.ts";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      sourceFiles(full, out);
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) {
      out.push(relative(ROOT, full).split("\\").join("/"));
    }
  }
  return out;
}

describe(`${NAME} is test-only`, () => {
  it("is referenced outside src/__tests__ only where it is defined", () => {
    const users = sourceFiles(join(ROOT, "src")).filter(
      (f) => f !== DEFINED_IN && readFileSync(join(ROOT, f), "utf8").includes(NAME),
    );
    expect(users).toEqual([]);
  });

  it("is still defined where expected", () => {
    expect(readFileSync(join(ROOT, DEFINED_IN), "utf8")).toContain(`export function ${NAME}`);
  });
});
