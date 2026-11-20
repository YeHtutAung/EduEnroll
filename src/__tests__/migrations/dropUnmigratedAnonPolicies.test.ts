import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// Static checks on the migration text, so they run without a database.

const ROOT = process.cwd();
const SQL = fs.readFileSync(
  path.join(ROOT, "supabase", "migrations", "20261121130000_drop_unmigrated_anon_policies.sql"),
  "utf8",
);
const ROLLBACK = fs.readFileSync(
  path.join(ROOT, "supabase", "rollbacks", "20261121130000_drop_unmigrated_anon_policies.down.sql"),
  "utf8",
);

describe("drop unmigrated anon policies migration", () => {
  it.each([
    ["anon_read_enrollments", "enrollments"],
    ["anon_read_classes", "classes"],
    ["anon_read_tenants", "tenants"],
    ["Allow anon read tenants", "tenants"],
    ["anon_read_support_tickets", "support_tickets"],
    ["anon_insert_support_tickets", "support_tickets"],
  ])("drops %s on %s, tolerating its absence", (policy, table) => {
    expect(SQL).toMatch(
      new RegExp(`DROP POLICY IF EXISTS "${policy}"\\s+ON public\\.${table};`),
    );
  });

  it("guards support_tickets, which does not exist on production", () => {
    expect(SQL).toContain("to_regclass('public.support_tickets') IS NOT NULL");
  });

  it("keeps the migration-owned public reads", () => {
    expect(SQL).not.toContain("public_read_appearance");
    expect(SQL).not.toContain("intake_form_fields_public_read");
  });

  it("changes no grants and creates no policy", () => {
    expect(SQL).not.toMatch(/\b(GRANT|REVOKE)\b/);
    expect(SQL).not.toMatch(/CREATE POLICY/i);
  });

  it("rollback does not recreate any anon policy", () => {
    expect(ROLLBACK).not.toMatch(/CREATE POLICY/i);
  });
});
