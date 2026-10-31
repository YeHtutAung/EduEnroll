import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// Static assertions on the migration text, so they run without a database.
// The owner-facing guard is the only thing stopping a tenant owner (who can
// UPDATE their own tenants row through RLS) from injecting a GTM container
// into the public pages, so its shape is pinned here.

const SQL = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "20261031130000_tenant_gtm_container.sql",
  ),
  "utf8",
);

describe("tenant gtm_container_id migration", () => {
  it("adds the nullable column", () => {
    expect(SQL).toMatch(
      /ALTER TABLE public\.tenants\s+ADD COLUMN IF NOT EXISTS gtm_container_id TEXT;/,
    );
  });

  it("pins the container id format with the exact regex", () => {
    expect(SQL).toContain("tenants_gtm_container_id_format");
    expect(SQL).toContain("'^GTM-[0-9A-Z]{4,12}$'");
  });

  it("guards changes with a BEFORE UPDATE OF gtm_container_id trigger", () => {
    expect(SQL).toMatch(
      /CREATE TRIGGER trg_tenants_guard_gtm\s+BEFORE INSERT OR UPDATE OF gtm_container_id ON public\.tenants/,
    );
  });

  it("covers insert as well as update", () => {
    expect(SQL).toContain("TG_OP = 'INSERT'");
    expect(SQL).toContain("TG_OP = 'UPDATE'");
  });

  it("pins the function search_path", () => {
    expect(SQL).toMatch(/SET search_path = ''/);
  });

  it("no longer trusts current_user alone", () => {
    expect(SQL).not.toContain("current_user NOT IN");
    expect(SQL).toMatch(/current_user IN \('postgres', 'supabase_admin'\)/);
  });

  it("rejects non-platform changes with errcode 42501", () => {
    expect(SQL).toMatch(/ERRCODE\s*=\s*'42501'/);
    expect(SQL).toContain("service_role");
  });
});
