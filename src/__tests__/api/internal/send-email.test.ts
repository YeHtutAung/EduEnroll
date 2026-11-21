import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash, createHmac } from "crypto";

// ─── /api/internal/auth/send-email: Supabase Send Email Hook ────────────────
// Signed by Supabase (Standard Webhooks). Caps each address per group through
// consume_rate_limit, then sends through Resend. Never answers success without
// sending, never logs a code, a token or an address.

const sendEmail = vi.fn();
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendEmail: (...a: unknown[]) => sendEmail(...a) };
});

const rpc = vi.fn();
vi.mock("@/server/buyers/adminClient", () => ({ createTimedAdminClient: () => ({ rpc }) }));

import { POST, dynamic } from "@/app/api/internal/auth/send-email/route";

// Throwaway test values, not real secrets.
const RAW_KEY = Buffer.from("throwaway-hook-key-for-tests-only");
const HOOK_SECRET = `v1,whsec_${RAW_KEY.toString("base64")}`;
const RL_SECRET = "throwaway-rate-limit-secret-for-tests";

function signedRequest(body: string, opts: { key?: Buffer; ts?: number } = {}): Request {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const id = "msg_1";
  const sig = createHmac("sha256", opts.key ?? RAW_KEY).update(`${id}.${ts}.${body}`).digest("base64");
  return new Request("http://localhost/api/internal/auth/send-email", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(ts),
      "webhook-signature": `v1,${sig}`,
    },
  });
}

function hookBody(type: string, over: Record<string, unknown> = {}, user: Record<string, unknown> = {}): string {
  return JSON.stringify({
    user: { id: "u1", email: "Buyer@Example.test", ...user },
    email_data: {
      token: "482913",
      token_hash: "hashabcdef0123",
      redirect_to: "https://app.example.test/x",
      email_action_type: type,
      site_url: "https://site.example.test",
      token_new: "",
      token_hash_new: "",
      old_email: "",
      old_phone: "",
      provider: "",
      factor_type: "",
      ...over,
    },
    metadata: {},
  });
}

const rlKeyHex = (email: string) => createHmac("sha256", RL_SECRET).update(email.trim().toLowerCase()).digest("hex");

let logs: unknown[][];
const spies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  sendEmail.mockReset().mockResolvedValue(true);
  rpc.mockReset().mockResolvedValue({ data: true, error: null });
  vi.stubEnv("SUPABASE_SEND_EMAIL_HOOK_SECRET", HOOK_SECRET);
  vi.stubEnv("RATE_LIMIT_HMAC_SECRET", RL_SECRET);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.test");
  logs = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    spies.push(vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a)));
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  spies.splice(0).forEach((s) => s.mockRestore());
});

/** Nothing logged carries a code, a token_hash or an address. */
function expectCleanLogs(...secrets: string[]) {
  const text = logs.map((a) => a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")).join("\n");
  for (const s of ["482913", "hashabcdef0123", "Buyer@Example.test", "buyer@example.test", ...secrets]) {
    expect(text.toLowerCase()).not.toContain(s.toLowerCase());
  }
}

describe("send-email hook route", () => {
  it("is dynamic", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("bad signature → 401, nothing sent, no rate-limit call", async () => {
    const res = await POST(signedRequest(hookBody("signup"), { key: Buffer.from("wrong") }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.http_code).toBe(401);
    expect(typeof json.error.message).toBe("string");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expectCleanLogs();
  });

  it("stale timestamp → 401", async () => {
    const res = await POST(signedRequest(hookBody("signup"), { ts: Math.floor(Date.now() / 1000) - 600 }));
    expect(res.status).toBe(401);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("hook secret unset → 503, nothing sent (an empty key would let anyone sign)", async () => {
    vi.stubEnv("SUPABASE_SEND_EMAIL_HOOK_SECRET", "");
    const res = await POST(signedRequest(hookBody("signup"), { key: Buffer.alloc(0) }));
    expect(res.status).toBe(503);
    expect((await res.json()).error.http_code).toBe(503);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("RATE_LIMIT_HMAC_SECRET unset → 503, nothing sent", async () => {
    vi.stubEnv("RATE_LIMIT_HMAC_SECRET", "");
    const res = await POST(signedRequest(hookBody("signup")));
    expect(res.status).toBe(503);
    expect((await res.json()).error.http_code).toBe(503);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("unlisted type → 400, nothing sent, logs the type only", async () => {
    const res = await POST(signedRequest(hookBody("password_changed_notification")));
    expect(res.status).toBe(400);
    expect((await res.json()).error.http_code).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expectCleanLogs();
  });

  it("body that isn't JSON → 400", async () => {
    const res = await POST(signedRequest("not json"));
    expect(res.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("signup within limits → 200 {}, one email to user.email containing the code", async () => {
    const res = await POST(signedRequest(hookBody("signup")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const arg = sendEmail.mock.calls[0][0] as { to: string; html: string; subject: string };
    expect(arg.to).toBe("Buyer@Example.test");
    expect(arg.html).toContain("482913");
    expect(arg.html).not.toContain("/auth/v1/verify");
    expectCleanLogs();
  });

  it("signin caps: hour 5 and day 20, keyed by HMAC of the lowercased email, not the email or its SHA-256", async () => {
    await POST(signedRequest(hookBody("magiclink")));
    const hex = rlKeyHex("Buyer@Example.test");
    expect(rpc).toHaveBeenCalledWith("consume_rate_limit", {
      p_key: `authmail:signin:h:${hex}`,
      p_window_seconds: 3600,
      p_limit: 5,
    });
    expect(rpc).toHaveBeenCalledWith("consume_rate_limit", {
      p_key: `authmail:signin:d:${hex}`,
      p_window_seconds: 86400,
      p_limit: 20,
    });
    const keys = rpc.mock.calls.map((c) => (c[1] as { p_key: string }).p_key).join(" ");
    expect(keys.toLowerCase()).not.toContain("buyer@example.test");
    expect(keys).not.toContain(createHash("sha256").update("buyer@example.test").digest("hex"));
    expect(keys).not.toContain(createHash("sha256").update("Buyer@Example.test").digest("hex"));
  });

  it("hour cap reached → 429, nothing sent", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    const res = await POST(signedRequest(hookBody("signup")));
    expect(res.status).toBe(429);
    expect((await res.json()).error.http_code).toBe(429);
    expect(sendEmail).not.toHaveBeenCalled();
    expectCleanLogs();
  });

  it("rate-limit RPC error → 503, never treated as allowed", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "22023", message: "bad rate limit args" } });
    const res = await POST(signedRequest(hookBody("signup")));
    expect(res.status).toBe(503);
    expect((await res.json()).error.http_code).toBe(503);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("rate-limit RPC throws (timeout) → 503", async () => {
    rpc.mockRejectedValueOnce(new Error("aborted"));
    const res = await POST(signedRequest(hookBody("signup")));
    expect(res.status).toBe(503);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("rate-limit RPC answers null data → 503", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(signedRequest(hookBody("signup")));
    expect(res.status).toBe(503);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("recovery counts under staff, not signin", async () => {
    const res = await POST(signedRequest(hookBody("recovery")));
    expect(res.status).toBe(200);
    const keys = rpc.mock.calls.map((c) => (c[1] as { p_key: string }).p_key);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.startsWith("authmail:staff:"))).toBe(true);
    const html = (sendEmail.mock.calls[0][0] as { html: string }).html;
    expect(html).toContain("https://proj.supabase.test/auth/v1/verify?token=hashabcdef0123");
  });

  it("email_change: token to user.email, token_new to user.new_email, each counted under its own email_change key (3 per day)", async () => {
    const body = hookBody(
      "email_change",
      { token: "111111", token_new: "222222", token_hash_new: "hashnew999" },
      { email: "old@example.test", new_email: "new@example.test" },
    );
    const res = await POST(signedRequest(body));
    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    const sent = sendEmail.mock.calls.map((c) => c[0] as { to: string; html: string });
    const toOld = sent.find((m) => m.to === "old@example.test")!;
    const toNew = sent.find((m) => m.to === "new@example.test")!;
    expect(toOld.html).toContain("111111");
    expect(toOld.html).not.toContain("222222");
    expect(toNew.html).toContain("222222");
    expect(toNew.html).not.toContain("111111");

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith("consume_rate_limit", {
      p_key: `authmail:email_change:d:${rlKeyHex("old@example.test")}`,
      p_window_seconds: 86400,
      p_limit: 3,
    });
    expect(rpc).toHaveBeenCalledWith("consume_rate_limit", {
      p_key: `authmail:email_change:d:${rlKeyHex("new@example.test")}`,
      p_window_seconds: 86400,
      p_limit: 3,
    });
    expectCleanLogs("111111", "222222", "old@example.test", "new@example.test", "hashnew999");
  });

  it("email_change without token_new → 400, nothing sent", async () => {
    const body = hookBody("email_change", { token: "111111", token_new: "" }, { email: "old@example.test", new_email: "new@example.test" });
    const res = await POST(signedRequest(body));
    expect(res.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("sendEmail returns false → 500, never success", async () => {
    sendEmail.mockResolvedValueOnce(false);
    const res = await POST(signedRequest(hookBody("signup")));
    expect(res.status).toBe(500);
    expect((await res.json()).error.http_code).toBe(500);
    expectCleanLogs();
  });

  it("no console call carries the code or the address, on any path", async () => {
    sendEmail.mockResolvedValueOnce(false);
    await POST(signedRequest(hookBody("signup")));
    rpc.mockResolvedValueOnce({ data: false, error: null });
    await POST(signedRequest(hookBody("magiclink")));
    rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000" } });
    await POST(signedRequest(hookBody("recovery")));
    await POST(signedRequest(hookBody("bogus_type")));
    await POST(signedRequest(hookBody("signup"), { key: Buffer.from("wrong") }));
    expect(logs.length).toBeGreaterThan(0);
    expectCleanLogs();
  });
});
