import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), "utf8");
const UP = read("supabase", "migrations", "20261122130000_leaders_phone.sql");
const DOWN = read("supabase", "rollbacks", "20261122130000_leaders_phone.down.sql");

const FUNCTIONS = [
  "submit_enrollment(uuid, text, integer, text, uuid)",
  "submit_cart_enrollment(jsonb, uuid, text, text, uuid)",
  "bind_ticket_device(uuid, uuid, uuid, text)",
  "move_order_buyer(uuid, uuid, uuid, uuid, text)",
  "revoke_buyer_ticket_devices(uuid)",
];

describe("leaders_phone migration", () => {
  it.each(FUNCTIONS)("%s is service-role only", (sig) => {
    expect(UP).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`);
    expect(UP).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`);
  });

  it.each(["ticket_devices", "order_moves"])("%s has RLS on and no policies", (t) => {
    expect(UP).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
    expect(UP).toContain(`REVOKE ALL ON public.${t} FROM PUBLIC, anon, authenticated;`);
    expect(UP).not.toMatch(new RegExp(`CREATE POLICY[^;]*ON public\.${t}`));
  });

  it("drops the old submit signatures before creating the new ones", () => {
    expect(UP).toContain("DROP FUNCTION public.submit_enrollment(uuid, text, integer, text);");
    expect(UP).toContain("DROP FUNCTION public.submit_cart_enrollment(jsonb, uuid, text, text);");
  });

  it("fixes the protection to jwt intakes and locks it once ordered", () => {
    expect(UP).toMatch(/CHECK \(NOT ticket_protection OR ticket_qr_format = 'jwt'\)/);
    expect(UP).toContain("ticket_protection_locked");
  });

  it("the rollback restores the old submit signatures and drops everything new", () => {
    for (const s of ["submit_enrollment(uuid, text, integer, text)", "submit_cart_enrollment(jsonb, uuid, text, text)"]) {
      expect(DOWN).toContain(`GRANT EXECUTE ON FUNCTION public.${s} TO service_role;`);
    }
    for (const o of ["ticket_devices", "order_moves"]) expect(DOWN).toContain(`DROP TABLE public.${o}`);
    expect(DOWN).toContain("DROP COLUMN buyer_id");
    expect(DOWN).toContain("DROP COLUMN ticket_protection");
  });
});
