import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, BuyerProfile } from "@/types/database";

// ─── ensureBuyerProfile: the only path that creates a buyer profile ─────────
// Mobile spec 4.1 "No password a buyer didn't set". A password set before the
// buyer confirmed their email must never work: claim, reset the password to a
// random one nobody sees, end every other session, then create the profile.

vi.mock("@/server/buyers/adminClient", () => ({
  createTimedAdminClient: () => {
    throw new Error("tests must inject deps.admin");
  },
}));

import { ensureBuyerProfile } from "@/server/buyers/ensureBuyerProfile";

// Unsigned token with the given amr. isEmailCodeSession only decodes; the
// caller's getUser is what accepted it.
function token(methods: string[]): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const amr = methods.map((method) => ({ method, timestamp: 1 }));
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ sub: "u1", session_id: "s1", amr })}.sig`;
}
const OTP = token(["otp"]);
const PASSWORD = token(["password"]);

const EMAIL = "buyer.secret@example.test";
const CLAIM = "11111111-2222-4333-8444-555555555555";

const USER = { id: "u1", email: EMAIL, email_confirmed_at: "2026-11-21T00:00:00Z" };

function profile(over: Partial<BuyerProfile> = {}): BuyerProfile {
  return {
    id: "u1",
    email: EMAIL,
    phone_e164: null,
    name: null,
    locale: "my",
    is_reviewer: false,
    created_at: "2026-11-21T00:00:00Z",
    updated_at: "2026-11-21T00:00:00Z",
    deleted_at: null,
    ...over,
  };
}

type Result = { data: unknown; error: unknown };
type Outcome = Result | (() => never);
const ok = (data: unknown): Result => ({ data, error: null });
const fail = (code = "XX000"): Result => ({ data: null, error: { code, message: "boom" } });
const abort = () => {
  throw new DOMException("The operation was aborted.", "TimeoutError");
};

interface FakeOpts {
  users?: Outcome;
  profiles?: Outcome[]; // one per read, in order; the last repeats
  rpc?: Partial<Record<string, Outcome>>;
  update?: Outcome;
  signOut?: Outcome;
}

function makeFake(opts: FakeOpts = {}) {
  const calls: string[] = [];
  const profileReads = [...(opts.profiles ?? [ok(null)])];
  const run = (o: Outcome | undefined, fallback: Result): Result =>
    o === undefined ? fallback : typeof o === "function" ? o() : o;

  const from = vi.fn((table: string) => {
    const q: Record<string, unknown> = {};
    q.select = vi.fn(() => q);
    q.eq = vi.fn(() => q);
    q.maybeSingle = vi.fn(async () => {
      if (table === "users") {
        calls.push("read:users");
        return run(opts.users, ok(null));
      }
      calls.push("read:buyer_profiles");
      const next = profileReads.length > 1 ? profileReads.shift() : profileReads[0];
      return run(next, ok(null));
    });
    return q;
  });

  const rpcDefaults: Record<string, Result> = {
    claim_buyer_profile: ok(CLAIM),
    buyer_profile_claim_held: ok(true),
    create_buyer_profile: ok("created"),
    release_buyer_profile_claim: ok(null),
  };
  const rpc = vi.fn(async (name: string) => {
    calls.push(`rpc:${name}`);
    return run(opts.rpc?.[name], rpcDefaults[name] ?? fail());
  });

  const updateUserById = vi.fn(async () => {
    calls.push("auth:updateUserById");
    return run(opts.update, { data: { user: { id: "u1" } }, error: null });
  });
  const signOut = vi.fn(async () => {
    calls.push("auth:signOut");
    return run(opts.signOut, { data: null, error: null });
  });

  const admin = { from, rpc, auth: { admin: { updateUserById, signOut } } };
  return {
    calls,
    from,
    rpc,
    updateUserById,
    signOut,
    deps: { admin: admin as unknown as SupabaseClient<Database> },
  };
}

const rpcNames = (f: ReturnType<typeof makeFake>) => f.rpc.mock.calls.map((c) => c[0]);

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
});
afterEach(() => {
  consoleSpies.forEach((s) => s.mockRestore());
});

describe("ensureBuyerProfile", () => {
  it("staff account → 403 staff; no rpc or auth.admin call", async () => {
    const f = makeFake({ users: ok({ id: "u1" }) });
    const res = await ensureBuyerProfile({ user: USER, accessToken: OTP }, f.deps);
    expect(res).toEqual({ ok: false, status: 403, code: "FORBIDDEN", reason: "staff" });
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.updateUserById).not.toHaveBeenCalled();
    expect(f.signOut).not.toHaveBeenCalled();
  });

  it("users read error → 503", async () => {
    const f = makeFake({ users: fail() });
    const res = await ensureBuyerProfile({ user: USER, accessToken: OTP }, f.deps);
    expect(res).toEqual({ ok: false, status: 503, code: "SERVER" });
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it("unconfirmed email → 403 unconfirmed", async () => {
    const f = makeFake();
    const res = await ensureBuyerProfile(
      { user: { ...USER, email_confirmed_at: null }, accessToken: OTP },
      f.deps,
    );
    expect(res).toEqual({ ok: false, status: 403, code: "FORBIDDEN", reason: "unconfirmed" });
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.updateUserById).not.toHaveBeenCalled();
  });

  it("live profile → 200 and nothing else runs (a web session stays signed in)", async () => {
    const row = profile();
    const f = makeFake({ profiles: [ok(row)] });
    const res = await ensureBuyerProfile({ user: USER, accessToken: PASSWORD }, f.deps);
    expect(res).toEqual({ ok: true, status: 200, profile: row });
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.updateUserById).not.toHaveBeenCalled();
    expect(f.signOut).not.toHaveBeenCalled();
  });

  it("deleted profile → 409", async () => {
    const f = makeFake({ profiles: [ok(profile({ deleted_at: "2026-11-20T00:00:00Z" }))] });
    const res = await ensureBuyerProfile({ user: USER, accessToken: OTP }, f.deps);
    expect(res).toEqual({ ok: false, status: 409, code: "DELETION_IN_PROGRESS" });
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it("profile read error → 503", async () => {
    const f = makeFake({ profiles: [fail()] });
    const res = await ensureBuyerProfile({ user: USER, accessToken: OTP }, f.deps);
    expect(res).toEqual({ ok: false, status: 503, code: "SERVER" });
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it("password session with no profile → 403 not_email_code; never claims", async () => {
    const f = makeFake();
    const res = await ensureBuyerProfile({ user: USER, accessToken: PASSWORD }, f.deps);
    expect(res).toEqual({ ok: false, status: 403, code: "FORBIDDEN", reason: "not_email_code" });
    expect(rpcNames(f)).not.toContain("claim_buyer_profile");
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.updateUserById).not.toHaveBeenCalled();
  });

  it("claim NULL → 503, nothing else called", async () => {
    const f = makeFake({ rpc: { claim_buyer_profile: ok(null) } });
    const res = await ensureBuyerProfile({ user: USER, accessToken: OTP }, f.deps);
    expect(res).toEqual({ ok: false, status: 503, code: "SERVER" });
    expect(rpcNames(f)).toEqual(["claim_buyer_profile"]);
    expect(f.updateUserById).not.toHaveBeenCalled();
    expect(f.signOut).not.toHaveBeenCalled();
  });

  it("claim RPC error → 503, nothing else called", async () => {
    const f = makeFake({ rpc: { claim_buyer_profile: fail() } });
    const res = await ensureBuyerProfile({ user: USER, accessToken: OTP }, f.deps);
    expect(res).toEqual({ ok: false, status: 503, code: "SERVER" });
    expect(rpcNames(f)).toEqual(["claim_buyer_profile"]);
  });

  it("claim 'exists' → re-reads and returns 200 with no reset", async () => {
    const row = profile();
    const f = makeFake({
      profiles: [ok(null), ok(row)],
      rpc: { claim_buyer_profile: ok("exists") },
    });
    const res = await ensureBuyerProfile({ user: USER, accessToken: OTP }, f.deps);
    expect(res).toEqual({ ok: true, status: 200, profile: row });
    expect(f.calls.filter((c) => c === "read:buyer_profiles")).toHaveLength(2);
    expect(rpcNames(f)).toEqual(["claim_buyer_profile"]);
    expect(f.updateUserById).not.toHaveBeenCalled();
    expect(f.signOut).not.toHaveBeenCalled();
  });

  it("claim 'exists' and the re-read finds a deleted profile → 409", async () => {
    const f = makeFake({
      profiles: [ok(null), ok(profile({ deleted_at: "2026-11-20T00:00:00Z" }))],
      rpc: { claim_buyer_profile: ok("exists") },
    });
    const res = await ensureBuyerProfile({ user: USER, accessToken: OTP }, f.deps);
    expect(res).toEqual({ ok: false, status: 409, code: "DELETION_IN_PROGRESS" });
  });

  it("held false → 503 and release called with that token", async () => {
    const f = makeFake({ rpc: { buyer_profile_claim_held: ok(false) } });
    const res = await ensureBuyerProfile({ user: USER, accessToken: OTP }, f.deps);
    expect(res).toEqual({ ok: false, status: 503, code: "SERVER" });
    expect(f.rpc).toHaveBeenCalledWith("release_buyer_profile_claim", {
      p_user_id: "u1",
      p_token: CLAIM,
    });
    expect(f.updateUserById).not.toHaveBeenCalled();
    expect(f.signOut).not.toHaveBeenCalled();
    expect(rpcNames(f)).not.toContain("create_buyer_profile");
  });

  it("held RPC throws → 503 and release called", async () => {
    const f = makeFake({ rpc: { buyer_profile_claim_held: abort } });
    const res = await ensureBuyerProfile({ user: USER, accessToken: OTP }, f.deps);
    expect(res).toEqual({ ok: false, status: 503, code: "SERVER" });
    expect(f.rpc).toHaveBeenCalledWith("release_buyer_profile_claim", {
      p_user_id: "u1",
      p_token: CLAIM,
    });
  });

  it("updateUserById returns { error } → 503, release, no signOut, no create", async () => {
    const f = makeFake({ update: { data: { user: null }, error: { status: 500, message: "x" } } });
    const res = await ensureBuyerProfile({ user: USER, accessToken: OTP }, f.deps);
    expect(res).toEqual({ ok: false, status: 503, code: "SERVER" });
    expect(f.rpc).toHaveBeenCalledWith("release_buyer_profile_claim", {
      p_user_id: "u1",
      p_token: CLAIM,
    });
    expect(f.signOut).not.toHaveBeenCalled();
    expect(rpcNames(f)).not.toContain("create_buyer_profile");
  });

  it("updateUserById throws (abort after 5 s) → 503, release called", async () => {
    const f = makeFake({ update: abort });
    const res = await ensureBuyerProfile({ user: USER, accessToken: OTP }, f.deps);
    expect(res).toEqual({ ok: false, status: 503, code: "SERVER" });
    expect(f.rpc).toHaveBeenCalledWith("release_buyer_profile_claim", {
      p_user_id: "u1",
      p_token: CLAIM,
    });
    expect(f.signOut).not.toHaveBeenCalled();
    expect(rpcNames(f)).not.toContain("create_buyer_profile");
  });

  it("signOut returns { error } → 503, release called, no create", async () => {
    const f = makeFake({ signOut: { data: null, error: { status: 500, message: "x" } } });
    const res = await ensureBuyerProfile({ user: USER, accessToken: OTP }, f.deps);
    expect(res).toEqual({ ok: false, status: 503, code: "SERVER" });
    expect(f.rpc).toHaveBeenCalledWith("release_buyer_profile_claim", {
      p_user_id: "u1",
      p_token: CLAIM,
    });
    expect(rpcNames(f)).not.toContain("create_buyer_profile");
  });

  it("signOut throws → 503, release called, no create", async () => {
    const f = makeFake({ signOut: abort });
    const res = await ensureBuyerProfile({ user: USER, accessToken: OTP }, f.deps);
    expect(res).toEqual({ ok: false, status: 503, code: "SERVER" });
    expect(rpcNames(f)).toContain("release_buyer_profile_claim");
    expect(rpcNames(f)).not.toContain("create_buyer_profile");
  });

  it("create → 'lost' → 503 and release NOT called", async () => {
    const f = makeFake({ rpc: { create_buyer_profile: ok("lost") } });
    const res = await ensureBuyerProfile({ user: USER, accessToken: OTP }, f.deps);
    expect(res).toEqual({ ok: false, status: 503, code: "SERVER" });
    expect(rpcNames(f)).not.toContain("release_buyer_profile_claim");
  });

  it("happy path → exact order and 201 with the new row", async () => {
    const row = profile();
    const f = makeFake({ profiles: [ok(null), ok(row)] });
    const res = await ensureBuyerProfile({ user: USER, accessToken: OTP }, f.deps);
    expect(res).toEqual({ ok: true, status: 201, profile: row });

    expect(f.calls).toEqual([
      "read:users",
      "read:buyer_profiles",
      "rpc:claim_buyer_profile",
      "rpc:buyer_profile_claim_held",
      "auth:updateUserById",
      "auth:signOut",
      "rpc:create_buyer_profile",
      "read:buyer_profiles",
    ]);

    expect(f.rpc).toHaveBeenCalledWith("claim_buyer_profile", { p_user_id: "u1" });
    expect(f.rpc).toHaveBeenCalledWith("buyer_profile_claim_held", {
      p_user_id: "u1",
      p_token: CLAIM,
    });
    expect(f.rpc).toHaveBeenCalledWith("create_buyer_profile", {
      p_user_id: "u1",
      p_token: CLAIM,
      p_email: EMAIL,
    });
    expect(rpcNames(f)).not.toContain("release_buyer_profile_claim");

    const [uid, attrs] = f.updateUserById.mock.calls[0] as unknown as [string, { password: string }];
    expect(uid).toBe("u1");
    expect(typeof attrs.password).toBe("string");
    expect(attrs.password.length).toBeGreaterThanOrEqual(64);
    expect(JSON.stringify(res)).not.toContain(attrs.password);

    expect(f.signOut).toHaveBeenCalledWith(OTP, "others");
  });

  it("each run uses a fresh random password", async () => {
    const a = makeFake({ profiles: [ok(null), ok(profile())] });
    const b = makeFake({ profiles: [ok(null), ok(profile())] });
    await ensureBuyerProfile({ user: USER, accessToken: OTP }, a.deps);
    await ensureBuyerProfile({ user: USER, accessToken: OTP }, b.deps);
    const pa = (a.updateUserById.mock.calls[0] as unknown as [string, { password: string }])[1].password;
    const pb = (b.updateUserById.mock.calls[0] as unknown as [string, { password: string }])[1].password;
    expect(pa).not.toBe(pb);
  });

  it("create → 'created' but the row can't be read → 503", async () => {
    const f = makeFake({ profiles: [ok(null), ok(null)] });
    const res = await ensureBuyerProfile({ user: USER, accessToken: OTP }, f.deps);
    expect(res).toEqual({ ok: false, status: 503, code: "SERVER" });
  });

  it("create → 'existing' → 200 with the re-read row", async () => {
    const row = profile();
    const f = makeFake({
      profiles: [ok(null), ok(row)],
      rpc: { create_buyer_profile: ok("existing") },
    });
    const res = await ensureBuyerProfile({ user: USER, accessToken: OTP }, f.deps);
    expect(res).toEqual({ ok: true, status: 200, profile: row });
    expect(rpcNames(f)).not.toContain("release_buyer_profile_claim");
  });

  it("create → 'existing' with no row on re-read → 503", async () => {
    const f = makeFake({
      profiles: [ok(null), ok(null)],
      rpc: { create_buyer_profile: ok("existing") },
    });
    const res = await ensureBuyerProfile({ user: USER, accessToken: OTP }, f.deps);
    expect(res).toEqual({ ok: false, status: 503, code: "SERVER" });
  });

  it("create RPC returns { error } (23505) → 503, release called", async () => {
    const f = makeFake({ rpc: { create_buyer_profile: fail("23505") } });
    const res = await ensureBuyerProfile({ user: USER, accessToken: OTP }, f.deps);
    expect(res).toEqual({ ok: false, status: 503, code: "SERVER" });
    expect(f.rpc).toHaveBeenCalledWith("release_buyer_profile_claim", {
      p_user_id: "u1",
      p_token: CLAIM,
    });
  });

  it("create RPC throws → 503, release called", async () => {
    const f = makeFake({ rpc: { create_buyer_profile: abort } });
    const res = await ensureBuyerProfile({ user: USER, accessToken: OTP }, f.deps);
    expect(res).toEqual({ ok: false, status: 503, code: "SERVER" });
    expect(rpcNames(f)).toContain("release_buyer_profile_claim");
  });

  it("a failing release does not change the 503", async () => {
    const f = makeFake({
      rpc: { buyer_profile_claim_held: ok(false), release_buyer_profile_claim: abort },
    });
    const res = await ensureBuyerProfile({ user: USER, accessToken: OTP }, f.deps);
    expect(res).toEqual({ ok: false, status: 503, code: "SERVER" });
  });

  it("never puts the email, password or access token in the result or console", async () => {
    const scenarios: FakeOpts[] = [
      { profiles: [ok(null), ok(profile())] },
      { update: { data: { user: null }, error: { status: 500, message: "x" } } },
      { update: abort },
      { signOut: { data: null, error: { status: 500, message: "x" } } },
      { rpc: { create_buyer_profile: fail("23505") } },
      { rpc: { create_buyer_profile: ok("lost") } },
      { rpc: { buyer_profile_claim_held: ok(false) } },
    ];
    for (const opts of scenarios) {
      const f = makeFake(opts);
      const res = await ensureBuyerProfile({ user: USER, accessToken: OTP }, f.deps);
      const pw = (f.updateUserById.mock.calls[0] as unknown as [string, { password: string }] | undefined)?.[1]
        ?.password;

      // The happy-path result carries the profile (which holds the email by
      // design); every error result must not.
      if (!res.ok) expect(JSON.stringify(res)).not.toContain(EMAIL);
      if (pw) expect(JSON.stringify(res)).not.toContain(pw);
      expect(JSON.stringify(res)).not.toContain(OTP);

      const logged = JSON.stringify(consoleSpies.flatMap((s) => s.mock.calls));
      expect(logged).not.toContain(EMAIL);
      expect(logged).not.toContain(OTP);
      expect(logged).not.toContain(CLAIM);
      if (pw) expect(logged).not.toContain(pw);
    }
  });
});
