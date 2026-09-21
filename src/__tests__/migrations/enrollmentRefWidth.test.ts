import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// ─── The generated reference must stay parseable by the bots ────────────────
//
// `enrollment_ref` is produced by a database trigger, and the chat processors
// accept it back from users via one shared pattern in
// src/lib/enrollment/refPattern.ts, which pins the random part to a character
// range.
//
// Widening the reference in SQL without widening that pattern would leave the
// bots silently refusing to recognise newly issued references — a break with
// no build error and no failing query, visible only when a customer pastes
// their reference and gets no reply.
//
// These assertions are static, so they run without a database and fail on a
// change to either side of the contract.

const ROOT = process.cwd();
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
// Rollbacks live outside the applied path on purpose: a later-timestamped
// file in supabase/migrations would be applied in sequence and would undo
// the migration it exists to reverse.
const ROLLBACKS = path.join(ROOT, "supabase", "rollbacks");
const LIB = path.join(ROOT, "src", "lib");

/** The definition the database actually ends up with: the newest one wins. */
function activeGeneratorSql(): { file: string; sql: string } {
  const defining = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) =>
      fs.readFileSync(path.join(MIGRATIONS, f), "utf8").includes("FUNCTION public.generate_enrollment_ref"),
    )
    .sort();
  expect(defining.length).toBeGreaterThan(0);
  const file = defining[defining.length - 1];
  return { file, sql: fs.readFileSync(path.join(MIGRATIONS, file), "utf8") };
}

/** Random-part width the generator emits, declared so it can be asserted. */
function generatedWidth(sql: string): number {
  const m = sql.match(/v_len\s+constant\s+int\s*:=\s*(\d+)/i);
  expect(m, "the generator must declare its width as `v_len constant int := N`").not.toBeNull();
  return Number(m![1]);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * The single shared pattern's random-part range, plus a sweep for stray
 * copies. The reference shape is declared in one module; a second declaration
 * anywhere under src/lib is a copy that can drift, which is exactly how the
 * three chat processors diverged before.
 */
function refParsers(): { file: string; min: number; max: number }[] {
  const found: { file: string; min: number; max: number }[] = [];
  for (const file of walk(LIB)) {
    const src = fs.readFileSync(file, "utf8");
    const m = src.match(/\[A-Z0-9\]\{(\d+),(\d+)\}/);
    if (m)
      found.push({
        // Normalised: path.relative yields backslashes on Windows, which
        // would make this assertion pass on CI and fail locally.
        file: path.relative(ROOT, file).split(path.sep).join("/"),
        min: Number(m[1]),
        max: Number(m[2]),
      });
  }
  return found;
}

/** Declared cap on the tenant-initials prefix. */
function prefixCap(sql: string): number {
  const m = sql.match(/v_prefix_max\s+constant\s+int\s*:=\s*(\d+)/i);
  expect(m, "the generator must declare `v_prefix_max constant int := N`").not.toBeNull();
  return Number(m![1]);
}

/** Declared width of the enrollment_ref column. */
function columnWidth(): number {
  const schema = fs.readFileSync(path.join(MIGRATIONS, "000_combined_schema.sql"), "utf8");
  const m = schema.match(/enrollment_ref\s+varchar\((\d+)\)/i);
  expect(m).not.toBeNull();
  return Number(m![1]);
}

describe("enrollment_ref width contract", () => {
  it("finds exactly one declaration of the reference shape", () => {
    // Zero would make the rest of this suite pass vacuously; more than one is
    // a copy that can drift out of step with the generator.
    const parsers = refParsers();
    expect(parsers.map((p) => p.file)).toEqual(["src/lib/enrollment/refPattern.ts"]);
  });

  it("emits a random part every parser accepts", () => {
    const { file, sql } = activeGeneratorSql();
    const width = generatedWidth(sql);

    for (const parser of refParsers()) {
      expect(
        width,
        `${file} emits ${width} chars but ${parser.file} accepts ${parser.min}-${parser.max}`,
      ).toBeLessThanOrEqual(parser.max);
      expect(width).toBeGreaterThanOrEqual(parser.min);
    }
  });

  it("uses the widest random part the parsers allow", () => {
    // The reference is an access token, so entropy should be taken up to the
    // limit of the existing contract rather than left on the table.
    const width = generatedWidth(activeGeneratorSql().sql);
    const tightestMax = Math.min(...refParsers().map((p) => p.max));
    expect(width).toBe(tightestMax);
  });

  it("draws on strong randomness, not the PRNG", () => {
    // `random()` is a seeded PRNG. For a value that acts as an access token,
    // observing a few references should not help predict the next one.
    const { file, sql } = activeGeneratorSql();
    const body = sql.slice(sql.indexOf("FUNCTION public.generate_enrollment_ref"));
    expect(body, `${file} still uses random() for the reference`).not.toMatch(/\brandom\s*\(\s*\)/);
    expect(body).toMatch(/gen_random_uuid|gen_random_bytes/);
  });

  it("cannot generate a reference longer than the column accepts", () => {
    // Found by executing the migration against a real Postgres: a nine-word
    // tenant name produced a 21-character reference and the insert failed with
    // "value too long for type character varying(20)". The prefix has to be
    // bounded, and the bound has to leave room for the widened random part.
    const { file, sql } = activeGeneratorSql();
    const longest = prefixCap(sql) + 1 + 4 + 1 + generatedWidth(sql); // PREFIX-MMDD-RANDOM
    expect(
      longest,
      `${file} can emit ${longest} chars into a varchar(${columnWidth()}) column`,
    ).toBeLessThanOrEqual(columnWidth());
  });

  it("actually applies the prefix cap it declares", () => {
    const { sql } = activeGeneratorSql();
    expect(sql).toMatch(/left\s*\(\s*v_prefix\s*,\s*v_prefix_max\s*\)/i);
  });

  it("ships a rollback that is itself within the parsers' bounds", () => {
    // A rollback nobody can parse is not a rollback. It has to satisfy the
    // same contract as the migration it reverses.
    const { file } = activeGeneratorSql();
    const rollback = path.join(ROLLBACKS, file.replace(/\.sql$/, ".down.sql"));
    expect(fs.existsSync(rollback), `no rollback at supabase/rollbacks/ for ${file}`).toBe(true);

    const sql = fs.readFileSync(rollback, "utf8");
    const width = generatedWidth(sql);
    for (const parser of refParsers()) {
      expect(width).toBeLessThanOrEqual(parser.max);
      expect(width).toBeGreaterThanOrEqual(parser.min);
    }
  });

  it("ships a rollback that cannot overflow the column either", () => {
    const { file } = activeGeneratorSql();
    const sql = fs.readFileSync(path.join(ROLLBACKS, file.replace(/\.sql$/, ".down.sql")), "utf8");
    expect(prefixCap(sql) + 1 + 4 + 1 + generatedWidth(sql)).toBeLessThanOrEqual(columnWidth());
  });

  it("keeps ambiguous characters out of the alphabet", () => {
    // Customers read these aloud and type them back; I/O/0/1 were excluded
    // deliberately and must stay excluded.
    const { sql } = activeGeneratorSql();
    const alphabet = sql.match(/v_chars\s+text\s*:=\s*'([^']+)'/i);
    expect(alphabet).not.toBeNull();
    for (const ch of ["I", "O", "0", "1"]) {
      expect(alphabet![1]).not.toContain(ch);
    }
  });
});
