import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// Static checks, so they run without a database. The local stack does not
// reproduce hosted grants faithfully, so the live check was done on the dev
// project; these pin the migration text and the code that depends on it.

const ROOT = process.cwd();
const MIGRATION = fs.readFileSync(
  path.join(ROOT, "supabase", "migrations", "20261121120000_tighten_payments_read_access.sql"),
  "utf8",
);
const ROLLBACK = fs.readFileSync(
  path.join(ROOT, "supabase", "rollbacks", "20261121120000_tighten_payments_read_access.down.sql"),
  "utf8",
);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : walk(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

const SOURCES = walk(path.join(ROOT, "src")).map((file) => ({
  file: path.relative(ROOT, file).replace(/\\/g, "/"),
  text: fs.readFileSync(file, "utf8"),
}));
const READS_PAYMENTS = /\.from\(\s*["']payments["']\s*\)/;

describe("tighten payments read access migration", () => {
  it("drops the anon read policy, tolerating its absence", () => {
    expect(MIGRATION).toMatch(/DROP POLICY IF EXISTS "anon_read_payments" ON public\.payments;/);
  });

  it("removes anon's table privileges on payments", () => {
    expect(MIGRATION).toMatch(/REVOKE ALL ON TABLE public\.payments FROM anon;/);
  });

  it("creates no new policy for anon", () => {
    expect(MIGRATION).not.toMatch(/CREATE POLICY/i);
    expect(MIGRATION).not.toMatch(/GRANT\s/i);
  });

  it("runs in one transaction", () => {
    expect(MIGRATION).toMatch(/^BEGIN;/m);
    expect(MIGRATION).toMatch(/^COMMIT;/m);
  });

  it("rollback restores privileges but not the open policy", () => {
    expect(ROLLBACK).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER\s+ON TABLE public\.payments TO anon;/);
    expect(ROLLBACK).not.toMatch(/CREATE POLICY/i);
  });
});

describe("payments is never read by the browser client", () => {
  it("found the payments readers (sanity)", () => {
    expect(SOURCES.filter((s) => READS_PAYMENTS.test(s.text)).length).toBeGreaterThan(10);
  });

  it("no file that reads payments imports the browser Supabase client", () => {
    const offenders = SOURCES.filter(
      (s) => READS_PAYMENTS.test(s.text) && /@\/lib\/supabase\/client["']/.test(s.text),
    ).map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it("public API routes that read payments use the service-role client", () => {
    const publicReaders = SOURCES.filter(
      (s) => s.file.startsWith("src/app/api/public/") && READS_PAYMENTS.test(s.text),
    );
    expect(publicReaders.length).toBeGreaterThan(0);
    const offenders = publicReaders
      .filter((s) => !/createAdminClient/.test(s.text))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });
});
