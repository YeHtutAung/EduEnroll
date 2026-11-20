import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

// ─── requireAuth session path: password sessions only ───────────────────────
// The agent path is covered in api-auth.test.ts; nothing here sends
// x-agent-signature.

function token(amr: unknown): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${enc({ alg: "HS256" })}.${enc({ sub: "u1", amr })}.sig`;
}
const PASSWORD = token([{ method: "password", timestamp: 1 }]);
const CODE = token([{ method: "otp", timestamp: 1 }]);

const headerMap = new Map<string, string>();
vi.mock("next/headers", () => ({
  headers: () => ({ get: (k: string) => headerMap.get(k.toLowerCase()) ?? null }),
}));

const profile = { id: "u1", tenant_id: "t1", role: "owner", email: "o@example.test" };
function profileQuery() {
  const q: Record<string, unknown> = {};
  q.select = vi.fn(() => q);
  q.eq = vi.fn(() => q);
  q.single = vi.fn(async () => ({ data: profile, error: null }));
  return q;
}

const cookieClient = {
  auth: {
    getUser: vi.fn(),
    getSession: vi.fn(),
  },
  from: vi.fn(() => profileQuery()),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: () => cookieClient }));

const bearerClient = {
  auth: { getUser: vi.fn() },
  from: vi.fn(() => profileQuery()),
};
vi.mock("@supabase/supabase-js", () => ({ createClient: () => bearerClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

import { requireAuth } from "@/lib/api";

beforeEach(() => {
  vi.clearAllMocks();
  headerMap.clear();
  cookieClient.auth.getUser.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
  bearerClient.auth.getUser.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
});

describe("requireAuth — cookie session", () => {
  it("accepts a password session", async () => {
    cookieClient.auth.getSession.mockResolvedValue({ data: { session: { access_token: PASSWORD } } });
    const auth = await requireAuth();
    expect(auth).not.toBeInstanceOf(NextResponse);
  });

  it("returns 403 for an email-code session and never reads the profile", async () => {
    cookieClient.auth.getSession.mockResolvedValue({ data: { session: { access_token: CODE } } });
    const auth = await requireAuth();
    expect(auth).toBeInstanceOf(NextResponse);
    expect((auth as NextResponse).status).toBe(403);
    expect(await (auth as NextResponse).json()).toMatchObject({ code: "PASSWORD_SIGN_IN_REQUIRED" });
    expect(cookieClient.from).not.toHaveBeenCalled();
  });

  it("returns 403 when no session token can be read", async () => {
    cookieClient.auth.getSession.mockResolvedValue({ data: { session: null } });
    const auth = await requireAuth();
    expect((auth as NextResponse).status).toBe(403);
    expect(await (auth as NextResponse).json()).toMatchObject({ code: "PASSWORD_SIGN_IN_REQUIRED" });
  });

  it("still returns 401 when there is no user at all", async () => {
    cookieClient.auth.getUser.mockResolvedValue({ data: { user: null }, error: { status: 401 } });
    const auth = await requireAuth();
    expect((auth as NextResponse).status).toBe(401);
  });
});

describe("requireAuth — Bearer token", () => {
  it("accepts a password token", async () => {
    headerMap.set("x-supabase-auth", `Bearer ${PASSWORD}`);
    const auth = await requireAuth();
    expect(auth).not.toBeInstanceOf(NextResponse);
  });

  it("returns 403 for an email-code token", async () => {
    headerMap.set("authorization", `Bearer ${CODE}`);
    const auth = await requireAuth();
    expect((auth as NextResponse).status).toBe(403);
    expect(await (auth as NextResponse).json()).toMatchObject({ code: "PASSWORD_SIGN_IN_REQUIRED" });
    expect(bearerClient.from).not.toHaveBeenCalled();
  });
});
