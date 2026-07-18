import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// ─── Storage buckets must exist on a fresh database ─────────────────────────
// A bucket that application code opens but no migration creates is invisible
// until runtime: `supabase db reset` succeeds, the app builds and deploys, and
// then uploads fail against a bucket that was never created.
//
// This happened. Emptying 009_create_storage_bucket.sql removed the only
// definition of `payment-proofs` while every schema check still passed, because
// the checks counted tables and types and never looked at storage.
//
// These assertions are static — no database required — so they run in CI on
// every change to either side of the contract.

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Bucket names the application actually opens. */
function bucketsUsedInCode(): Map<string, string[]> {
  const used = new Map<string, string[]>();
  const record = (bucket: string, file: string) => {
    const where = used.get(bucket) ?? [];
    if (!where.includes(file)) where.push(file);
    used.set(bucket, where);
  };

  for (const file of walk(SRC)) {
    // Tests describe buckets rather than depending on them.
    if (file.includes("__tests__")) continue;
    const source = fs.readFileSync(file, "utf8");
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");

    // storage.from("bucket-name")
    for (const m of source.matchAll(/storage\s*\.\s*from\(\s*["'`]([a-z][a-z0-9-]*)["'`]/g)) {
      record(m[1], rel);
    }
    // const SOMETHING_BUCKET = "bucket-name" — the indirection that hid
    // payment-proofs from a naive scan of storage.from() call sites.
    for (const m of source.matchAll(/const\s+[A-Z_]*BUCKET[A-Z_]*\s*=\s*["'`]([a-z][a-z0-9-]*)["'`]/g)) {
      record(m[1], rel);
    }
  }
  return used;
}

/** Bucket ids created by a migration, i.e. present on a fresh database. */
function bucketsCreatedInMigrations(): Map<string, string> {
  const created = new Map<string, string>();
  for (const name of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, name), "utf8");
    // Only an INSERT INTO storage.buckets creates one. Policy migrations
    // mention bucket names too, but a policy on a bucket that does not exist
    // does not bring it into being.
    for (const stmt of sql.matchAll(/INSERT\s+INTO\s+storage\.buckets\b([\s\S]*?);/gi)) {
      for (const lit of stmt[1].matchAll(/["']([a-z][a-z0-9-]*)["']/g)) {
        if (!created.has(lit[1])) created.set(lit[1], name);
      }
    }
  }
  return created;
}

describe("storage buckets", () => {
  it("creates every bucket the application code opens", () => {
    const used = bucketsUsedInCode();
    const created = bucketsCreatedInMigrations();

    expect(used.size).toBeGreaterThan(0);

    const missing = [...used.entries()]
      .filter(([bucket]) => !created.has(bucket))
      .map(([bucket, files]) => `  "${bucket}" used in ${files.join(", ")}`);

    expect(
      missing,
      `No migration creates these buckets, so a fresh database will not have them:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("creates payment-proofs, which only 009 defines", () => {
    // Called out by name because it is the one bucket with a single point of
    // definition, and the one that was lost. If 009 is ever emptied or removed
    // again, this fails immediately rather than at upload time in production.
    const created = bucketsCreatedInMigrations();
    expect(created.get("payment-proofs")).toBe("009_create_storage_bucket.sql");
  });
});
