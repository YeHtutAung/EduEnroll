import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { ENROLLMENT_REF_PATTERN, isEnrollmentRef } from "@/lib/enrollment/refPattern";

// ─── One definition of what an enrollment reference looks like ──────────────
//
// Three chat processors accept a reference typed or pasted by a customer. They
// used to carry three copies of the pattern, and the copies drifted: two
// accepted a 1-5 character prefix and one only 1-4. The prefix is the tenant's
// name initials, so its length is a property of the tenant — a tenant whose
// name was long enough had references its own Messenger bot silently refused,
// with no error and no log.
//
// The pattern now lives in one module. These tests exercise it directly, and
// separately assert that no other file has grown its own copy.

const ROOT = process.cwd();
const LIB = path.join(ROOT, "src", "lib");
const SHARED = path.join(LIB, "enrollment", "refPattern.ts");

const CONSUMERS = [
  "src/lib/messenger/processor.ts",
  "src/lib/telegram/processor.ts",
  "src/lib/telegram/language-school-processor.ts",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** References every channel must recognise. */
const MUST_ACCEPT: [string, string][] = [
  ["LM-0902-3SJQ", "current format, 2-char prefix"],
  ["EN-0910-66VV8K", "6-char random part"],
  ["ABCDE-0910-3SJQ", "5-char prefix, a five-word tenant name"],
  ["ABCDEFGH-0910-R6ZJX2", "8-char prefix, the widest with a 6-char random part"],
  ["ABCDEFGHIJ-0910-3SJQ", "10-char prefix, the widest an existing row can carry"],
  ["NM-2026-00042", "legacy sequential format"],
  ["T-2026-00123", "the example in the bots' own help text"],
  ["lm-0902-3sjq", "lowercase, as a customer might type it"],
];

/** Text that must not be mistaken for a reference. */
const MUST_REJECT: [string, string][] = [
  ["hello", "a greeting"],
  ["/status", "a bare command"],
  ["LM-0902", "no random part"],
  ["LM-09-3SJQ", "wrong date width"],
  ["LM-0902-3SJQ-EXTRA", "trailing junk"],
  ["ABCDEFGHIJKLM-0902-3SJQ", "prefix longer than the column can hold"],
  ["", "empty"],
];

describe("enrollment reference pattern", () => {
  it.each(MUST_ACCEPT)("accepts %s (%s)", (ref) => {
    expect(isEnrollmentRef(ref)).toBe(true);
  });

  it.each(MUST_REJECT)("rejects %j (%s)", (text) => {
    expect(isEnrollmentRef(text)).toBe(false);
  });

  it("carries no g or y flag, which would make the shared regex stateful", () => {
    // One RegExp object is shared across every call site. With `g` or `y`,
    // RegExp.test() advances lastIndex, so a match in one processor would
    // change the result of the next call somewhere else.
    expect(ENROLLMENT_REF_PATTERN.flags).not.toContain("g");
    expect(ENROLLMENT_REF_PATTERN.flags).not.toContain("y");
  });

  it("is case-insensitive, since the Messenger processor tests raw customer text", () => {
    expect(ENROLLMENT_REF_PATTERN.flags).toContain("i");
  });

  it("gives a stable verdict when called repeatedly", () => {
    // Guards the statefulness failure above by behaviour, not just by flags.
    for (let i = 0; i < 5; i++) {
      expect(isEnrollmentRef("LM-0902-3SJQ")).toBe(true);
      expect(isEnrollmentRef("hello")).toBe(false);
    }
  });
});

describe("no channel keeps its own copy of the pattern", () => {
  it("has every chat processor import the shared module", () => {
    for (const rel of CONSUMERS) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      expect(src, `${rel} does not import the shared pattern`).toMatch(
        /from "@\/lib\/enrollment\/refPattern"/,
      );
    }
  });

  it("declares the reference shape in exactly one file", () => {
    // A second copy is how the three drifted in the first place. Any file that
    // spells out a reference-shaped character class is a new copy.
    const offenders = walk(LIB)
      .filter((f) => f !== SHARED)
      .filter((f) => /\[A-Z0-9\]\{\d+,\d+\}/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(ROOT, f));

    expect(offenders, `these files re-declare the reference shape: ${offenders.join(", ")}`).toEqual(
      [],
    );
  });
});
