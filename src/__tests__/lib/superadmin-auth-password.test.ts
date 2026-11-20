import { describe, it, expect, vi, beforeEach } from "vitest";

function token(amr: unknown): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${enc({ alg: "HS256" })}.${enc({ sub: "s1", amr })}.sig`;
}

const client = {
  auth: { getUser: vi.fn(), getSession: vi.fn() },
  from: vi.fn(() => {
    const q: Record<string, unknown> = {};
    q.select = vi.fn(() => q);
    q.eq = vi.fn(() => q);
    q.single = vi.fn(async () => ({ data: { id: "s1", role: "superadmin" }, error: null }));
    return q;
  }),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: () => client }));

import { requireSuperadmin } from "@/lib/superadminAuth";

beforeEach(() => {
  vi.clearAllMocks();
  client.auth.getUser.mockResolvedValue({ data: { user: { id: "s1" } } });
});

describe("requireSuperadmin", () => {
  it("accepts a superadmin password session", async () => {
    client.auth.getSession.mockResolvedValue({
      data: { session: { access_token: token([{ method: "password" }]) } },
    });
    const auth = await requireSuperadmin();
    expect("profile" in auth).toBe(true);
  });

  it("returns 403 for an email-code session without reading the profile", async () => {
    client.auth.getSession.mockResolvedValue({
      data: { session: { access_token: token([{ method: "otp" }]) } },
    });
    const auth = await requireSuperadmin();
    expect("error" in auth && auth.error.status).toBe(403);
    expect("error" in auth && (await auth.error.json())).toMatchObject({ code: "PASSWORD_SIGN_IN_REQUIRED" });
    expect(client.from).not.toHaveBeenCalled();
  });
});
