import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// ─── The chat bots must all recognise the same references ───────────────────
//
// Three processors accept an enrollment reference typed or pasted by a
// customer. Each carries its own copy of the pattern, and the copies had
// drifted: the Messenger one accepted a 1-4 character prefix while both
// Telegram ones accepted 1-5.
//
// The prefix is built from the tenant's name initials, so its length is a
// property of the tenant. A tenant whose name is five words long therefore had
// references its own Messenger bot silently refused to recognise — no error,
// no log, just a customer pasting a reference and getting the fallback help
// text instead of their status.
//
// `enrollments.enrollment_ref` is varchar(20) and a reference is
// PREFIX-MMDD-RANDOM. The shortest random part the generator has ever emitted
// is four characters, so an existing row can carry a prefix of up to
// 20 - 1 - 4 - 1 - 4 = 10 characters. Every parser has to accept that much.
//
// These assertions read the patterns out of the source and exercise them
// directly, so they need no mocks and fail if any copy drifts again.

const ROOT = process.cwd();

const PARSER_FILES = [
  "src/lib/messenger/processor.ts",
  "src/lib/telegram/processor.ts",
  "src/lib/telegram/language-school-processor.ts",
];

interface Parser {
  file: string;
  pattern: RegExp;
}

/** Rebuilds each processor's REF_PATTERN from source, without eval. */
function parsers(): Parser[] {
  return PARSER_FILES.map((rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const m = src.match(/const REF_PATTERN\s*=\s*\/(.+?)\/([gimsuy]*);/);
    expect(m, `${rel} must declare a REF_PATTERN regex literal`).not.toBeNull();
    return { file: rel, pattern: new RegExp(m![1], m![2]) };
  });
}

/** References that every parser must recognise. */
const MUST_ACCEPT = [
  ["LM-0902-3SJQ", "current format, 2-char prefix"],
  ["EN-0910-66VV8K", "6-char random part"],
  // The exact divergence: a five-word tenant name. The Telegram parsers took
  // a 5-char prefix and the Messenger one did not, so without this input the
  // agreement check below passes without ever meeting the disagreement.
  ["ABCDE-0910-3SJQ", "5-char prefix, a five-word tenant name"],
  ["ABCDEFGH-0910-R6ZJX2", "8-char prefix, the widest with a 6-char random part"],
  ["ABCDEFGHIJ-0910-3SJQ", "10-char prefix, the widest an existing row can carry"],
  ["NM-2026-00042", "legacy sequential format"],
  ["T-2026-00123", "the example in the bots' own help text"],
  ["lm-0902-3sjq", "lowercase, as a customer might type it"],
];

/** Text that must not be mistaken for a reference. */
const MUST_REJECT = [
  ["hello", "a greeting"],
  ["/status", "a bare command"],
  ["LM-0902", "no random part"],
  ["LM-09-3SJQ", "wrong date width"],
  ["LM-0902-3SJQ-EXTRA", "trailing junk"],
  ["ABCDEFGHIJKLM-0902-3SJQ", "prefix longer than the column can hold"],
  ["", "empty"],
];

describe("enrollment reference patterns", () => {
  it("finds all three chat parsers", () => {
    // Without this the rest of the suite could pass vacuously.
    expect(parsers()).toHaveLength(3);
  });

  it.each(MUST_ACCEPT)("every parser accepts %s (%s)", (ref) => {
    for (const { file, pattern } of parsers()) {
      // Two of the three uppercase before testing, so mirror that here: the
      // question is whether the pattern's shape accepts the reference.
      const candidate = pattern.flags.includes("i") ? ref : ref.toUpperCase();
      expect(pattern.test(candidate), `${file} rejects ${ref}`).toBe(true);
    }
  });

  it.each(MUST_REJECT)("every parser rejects %j (%s)", (text) => {
    for (const { file, pattern } of parsers()) {
      const candidate = pattern.flags.includes("i") ? text : text.toUpperCase();
      expect(pattern.test(candidate), `${file} accepts ${JSON.stringify(text)}`).toBe(false);
    }
  });

  it("agrees across every parser, so no bot recognises a reference another refuses", () => {
    const all = parsers();
    const inputs = [...MUST_ACCEPT, ...MUST_REJECT].map(([text]) => text);

    for (const input of inputs) {
      const verdicts = all.map(({ file, pattern }) => {
        const candidate = pattern.flags.includes("i") ? input : input.toUpperCase();
        return { file, accepted: pattern.test(candidate) };
      });
      const distinct = new Set(verdicts.map((v) => v.accepted));
      expect(
        distinct.size,
        `parsers disagree on ${JSON.stringify(input)}: ` +
          verdicts.map((v) => `${v.file}=${v.accepted}`).join(", "),
      ).toBe(1);
    }
  });
});
