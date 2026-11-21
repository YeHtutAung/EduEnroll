import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), "utf8");
const UP = read("supabase", "migrations", "20261122120000_buyer_accounts.sql");
const DOWN = read("supabase", "rollbacks", "20261122120000_buyer_accounts.down.sql");

const FUNCTIONS = [
  "claim_buyer_profile",
  "buyer_profile_claim_held",
  "create_buyer_profile",
  "release_buyer_profile_claim",
  "consume_rate_limit",
  "sync_buyer_profile_email",
];

describe("buyer accounts migration", () => {
  it.each(["buyer_profiles", "buyer_profile_claims", "mobile_rate_limits"])(
    "turns RLS on for %s and grants API roles nothing",
    (table) => {
      expect(UP).toMatch(new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`, "i"));
      expect(UP).toMatch(new RegExp(`REVOKE ALL ON public\\.${table} FROM PUBLIC, anon, authenticated`, "i"));
      expect(UP).not.toMatch(new RegExp(`CREATE POLICY[^;]+ON public\\.${table}`, "i"));
    },
  );

  // The header of one function: from its CREATE to the start of its body.
  const header = (fn: string) => {
    const start = UP.search(new RegExp(`CREATE FUNCTION public\\.${fn}\\(`, "i"));
    expect(start).toBeGreaterThanOrEqual(0);
    return UP.slice(start, UP.indexOf("AS $$", start));
  };

  it("grants service_role DML on the three tables (local tables give it none by default)", () => {
    for (const t of ["buyer_profiles", "buyer_profile_claims", "mobile_rate_limits"]) {
      expect(UP).toMatch(new RegExp(`GRANT SELECT, INSERT, UPDATE, DELETE ON public\\.${t} TO service_role`, "i"));
    }
  });

  it.each(FUNCTIONS)("%s is SECURITY DEFINER with an empty search_path and no API-role execute", (fn) => {
    const body = header(fn);
    expect(body).toMatch(/SECURITY DEFINER/i);
    expect(body).toMatch(/SET search_path = ''/i);
    expect(UP).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated`, "i"));
  });

  it("lets only service_role run the RPCs (not the trigger function)", () => {
    for (const fn of FUNCTIONS.filter((f) => f !== "sync_buyer_profile_email")) {
      expect(UP).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO service_role`, "i"));
    }
    expect(UP).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.sync_buyer_profile_email/i);
  });

  it("sets a 5 s lock_timeout on the claim and create RPCs", () => {
    for (const fn of ["claim_buyer_profile", "create_buyer_profile"]) {
      expect(header(fn)).toMatch(/SET lock_timeout = '5s'/i);
    }
  });

  it("consume_rate_limit refuses bad arguments and sweeps old windows of every key", () => {
    const body = UP.slice(UP.search(/CREATE FUNCTION public\.consume_rate_limit\(/i));
    expect(body).toMatch(/p_window_seconds NOT BETWEEN 1 AND 86400/i);
    expect(body).toMatch(/ERRCODE = '22023'/i);
    // No per-key cleanup: rows of keys that never come back must expire too.
    expect(body.slice(0, body.indexOf("$$;"))).not.toMatch(/WHERE key = p_key AND window_start </i);
    expect(body).toMatch(/LIMIT 50/i);
    expect(UP).toMatch(/CREATE INDEX mobile_rate_limits_window_start_idx ON public\.mobile_rate_limits \(window_start\)/i);
  });

  it("syncs the profile email only when the auth email changes", () => {
    expect(UP).toMatch(/AFTER UPDATE OF email ON auth\.users/i);
    expect(UP).toMatch(/WHEN \(OLD\.email IS DISTINCT FROM NEW\.email/i);
  });

  it("rollback drops the trigger before its function, and every object", () => {
    expect(DOWN.search(/DROP TRIGGER/i)).toBeLessThan(DOWN.search(/DROP FUNCTION IF EXISTS public\.sync_buyer_profile_email/i));
    for (const name of [
      ...FUNCTIONS,
      "buyer_profiles",
      "buyer_profile_claims",
      "mobile_rate_limits",
      "mobile_rate_limits_window_start_idx",
    ]) {
      expect(DOWN).toContain(name);
    }
  });
});
