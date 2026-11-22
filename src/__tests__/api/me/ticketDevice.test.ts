import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { generateKeyPairSync } from "crypto";

// ─── POST /api/me/tickets/[id]/device: bind this phone (plan Task 7) ────────
// Mocks requireBuyer, resolveTenantId, the admin client, the durable counter
// and sendEmail. The token is signed for real and checked with verifyTicketJwt.

const requireBuyer = vi.fn();
const resolveTenantId = vi.fn();
vi.mock("@/lib/api", () => ({
  requireBuyer: () => requireBuyer(),
  resolveTenantId: () => resolveTenantId(),
}));

const consumeRateLimit = vi.fn();
vi.mock("@/server/buyers/rateLimit", () => ({
  consumeRateLimit: (...a: unknown[]) => consumeRateLimit(...a),
}));

const sendEmail = vi.fn();
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendEmail: (...a: unknown[]) => sendEmail(...a) };
});

let activeRead: { data: unknown; error: unknown };
let ticketRead: { data: unknown; error: unknown };
let rpcResult: { data: unknown; error: unknown };
const filters: Record<string, unknown[][]> = {};
const rpc = vi.fn(async () => rpcResult);
const from = vi.fn((table: string) => {
  filters[table] = filters[table] ?? [];
  const q: Record<string, unknown> = {};
  q.select = vi.fn(() => q);
  q.eq = vi.fn((...a: unknown[]) => {
    filters[table].push(["eq", ...a]);
    return q;
  });
  q.is = vi.fn((...a: unknown[]) => {
    filters[table].push(["is", ...a]);
    return q;
  });
  q.maybeSingle = vi.fn(async () => activeRead);
  q.single = vi.fn(async () => ticketRead);
  return q;
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from, rpc }) }));

import { POST, dynamic } from "@/app/api/me/tickets/[id]/device/route";
import { verifyTicketJwt } from "@/lib/tickets/sign";
import { ticketNewPhoneEmail } from "@/lib/email";

const TICKET = "11111111-2222-4333-8444-555555555555";
const TENANT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BUYER = "99999999-8888-4777-8666-555555555555";
const BUYER_EMAIL = "leader@example.test";
const B64U = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function newDeviceKey(): { dk: string; raw: Buffer } {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const j = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, "base64url"), Buffer.from(j.y, "base64url")]);
  return { dk: raw.toString("base64url"), raw };
}

let DK: string;
let DK_RAW: Buffer;

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env.TICKET_SIGNING_KEY = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  process.env.TICKET_KID = "test-kid";
  ({ dk: DK, raw: DK_RAW } = newDeviceKey());
});

function post(opts: { id?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {}) {
  const id = opts.id ?? TICKET;
  const body = opts.rawBody ?? JSON.stringify(opts.body ?? { publicKey: DK });
  const req = new Request(`https://sky.kuunyi.com/api/me/tickets/${id}/device`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
  });
  return POST(req, { params: { id } });
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const json = await res.json();
  expect(json).toMatchObject({ error: { code } });
  return json;
}

function rateCalls(prefix: string) {
  return consumeRateLimit.mock.calls.filter((c) => String(c[1]).startsWith(prefix));
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(filters)) delete filters[k];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  requireBuyer.mockResolvedValue({ buyerId: BUYER, email: BUYER_EMAIL, isReviewer: false, sessionId: "s1" });
  resolveTenantId.mockResolvedValue(TENANT);
  consumeRateLimit.mockResolvedValue("ok");
  sendEmail.mockResolvedValue(true);
  activeRead = { data: null, error: null };
  ticketRead = {
    data: { id: TICKET, intake_id: "intake-1", tier: "VIP", admits: 2, exp: "2027-01-01T00:00:00Z" },
    error: null,
  };
  rpcResult = { data: "bound_first", error: null };
});

describe("dynamic", () => {
  it("is force-dynamic", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});

describe("guards before any RPC", () => {
  it("1. not signed in → requireBuyer's 401, no RPC", async () => {
    requireBuyer.mockResolvedValue(
      NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Sign in required." } }, { status: 401 }),
    );
    await expectError(await post(), 401, "UNAUTHENTICATED");
    expect(rpc).not.toHaveBeenCalled();
    expect(consumeRateLimit).not.toHaveBeenCalled();
  });

  it.each(["cross-site", "same-site"])("2. sec-fetch-site: %s → 403 FORBIDDEN, no RPC", async (site) => {
    await expectError(await post({ headers: { "sec-fetch-site": site } }), 403, "FORBIDDEN");
    expect(rpc).not.toHaveBeenCalled();
    expect(requireBuyer).not.toHaveBeenCalled();
  });

  it("2. an Origin that isn't this host (sibling tenant subdomain) → 403", async () => {
    const res = await post({ headers: { origin: "https://evil.kuunyi.com", host: "sky.kuunyi.com" } });
    await expectError(res, 403, "FORBIDDEN");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("2. Origin \"null\" → 403", async () => {
    await expectError(await post({ headers: { origin: "null", host: "sky.kuunyi.com" } }), 403, "FORBIDDEN");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("2. same-origin browser request is allowed", async () => {
    const res = await post({
      headers: { origin: "https://sky.kuunyi.com", host: "sky.kuunyi.com", "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(200);
  });

  it.each(["not-a-uuid", "11111111-2222-4333-8444-55555555555", `${TICKET}x`, "' or 1=1 --"])(
    "3. id %s → 404 NOT_FOUND, no RPC",
    async (id) => {
      const json = await expectError(await post({ id }), 404, "NOT_FOUND");
      expect(json).toEqual({ error: { code: "NOT_FOUND", message: "Ticket not found." } });
      expect(rpc).not.toHaveBeenCalled();
      expect(from).not.toHaveBeenCalled();
    },
  );

  it("passes resolveTenantId's error through, no RPC", async () => {
    resolveTenantId.mockResolvedValue(NextResponse.json({ error: "Not Found" }, { status: 404 }));
    const res = await post();
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("4. device key validation → 400 VALIDATION, no RPC", () => {
  const bad: [string, () => unknown][] = [
    ["missing body key", () => ({})],
    ["a number", () => ({ publicKey: 42 })],
    ["86 chars", () => ({ publicKey: DK.slice(0, 86) })],
    ["88 chars", () => ({ publicKey: DK + "A" })],
    ["padding / non-base64url chars", () => ({ publicKey: DK.slice(0, 86) + "=" })],
    ["standard base64 chars", () => ({ publicKey: "+" + DK.slice(1) })],
    ["not starting 0x04", () => ({ publicKey: Buffer.concat([Buffer.from([2]), DK_RAW.subarray(1)]).toString("base64url") })],
    [
      "off the curve",
      () => {
        const raw = Buffer.from(DK_RAW);
        raw[64] ^= 1;
        return { publicKey: raw.toString("base64url") };
      },
    ],
    [
      "non-canonical: last char's low bit flipped",
      () => ({ publicKey: DK.slice(0, 86) + B64U[B64U.indexOf(DK[86]) ^ 1] }),
    ],
  ];

  it.each(bad)("%s", async (_name, body) => {
    await expectError(await post({ body: body() }), 400, "VALIDATION");
    expect(rpc).not.toHaveBeenCalled();
    expect(consumeRateLimit).not.toHaveBeenCalled();
  });

  it("the flipped key decodes to the same bytes (so only the re-encode check catches it)", () => {
    const flipped = DK.slice(0, 86) + B64U[B64U.indexOf(DK[86]) ^ 1];
    expect(flipped).not.toBe(DK);
    expect(Buffer.from(flipped, "base64url").equals(DK_RAW)).toBe(true);
  });

  it("invalid JSON", async () => {
    await expectError(await post({ rawBody: "{not json" }), 400, "VALIDATION");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("5. the rate limit counts only key changes", () => {
  it("the buyer's own active key for this ticket → no counter call; unchanged → 200", async () => {
    activeRead = { data: { public_key: DK }, error: null };
    rpcResult = { data: "unchanged", error: null };
    const res = await post();
    expect(res.status).toBe(200);
    expect(consumeRateLimit).not.toHaveBeenCalled();
    // The pre-read is scoped to this buyer, this ticket, the active row.
    expect(filters.ticket_devices).toEqual(
      expect.arrayContaining([
        ["eq", "ticket_id", TICKET],
        ["eq", "buyer_id", BUYER],
        ["is", "revoked_at", null],
      ]),
    );
  });

  it("a different active key → counted under bind:<buyerId>, 30 per hour", async () => {
    activeRead = { data: { public_key: newDeviceKey().dk }, error: null };
    await post();
    expect(rateCalls("bind:")).toHaveLength(1);
    expect(rateCalls("bind:")[0].slice(1)).toEqual([`bind:${BUYER}`, 3600, 30]);
  });

  it("no active key → counted", async () => {
    await post();
    expect(rateCalls("bind:")).toHaveLength(1);
  });

  it("\"limited\" → 429 RATE_LIMITED, no RPC", async () => {
    consumeRateLimit.mockResolvedValue("limited");
    await expectError(await post(), 429, "RATE_LIMITED");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("\"unavailable\" → 503 SERVER, no RPC", async () => {
    consumeRateLimit.mockResolvedValue("unavailable");
    await expectError(await post(), 503, "SERVER");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("the pre-read failing → 503 SERVER, no RPC", async () => {
    activeRead = { data: null, error: { code: "57014" } };
    await expectError(await post(), 503, "SERVER");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("6. refused", () => {
  it("refused → 404 with the generic body, no token, no email", async () => {
    rpcResult = { data: "refused", error: null };
    const res = await post();
    const json = await expectError(res, 404, "NOT_FOUND");
    expect(json).toEqual({ error: { code: "NOT_FOUND", message: "Ticket not found." } });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("'not your ticket', 'no such ticket' and 'deleted profile' look identical (all refused by the RPC)", async () => {
    const bodies: unknown[] = [];
    const statuses: number[] = [];
    for (const _case of ["someone else's ticket", "no such ticket", "deleted profile"]) {
      void _case;
      rpcResult = { data: "refused", error: null };
      const res = await post();
      statuses.push(res.status);
      bodies.push(await res.json());
    }
    expect(new Set(statuses)).toEqual(new Set([404]));
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
    // ...and the same as a malformed id.
    const malformed = await (await post({ id: "nope" })).json();
    expect(malformed).toEqual(bodies[0]);
  });

  it("an unexpected RPC value issues no token → 404", async () => {
    for (const v of [null, 42, "something_else"]) {
      rpcResult = { data: v, error: null };
      await expectError(await post(), 404, "NOT_FOUND");
    }
    expect(from).not.toHaveBeenCalledWith("tickets");
  });

  it("an RPC error → 503 SERVER, logs a fixed string and the code only", async () => {
    rpcResult = { data: null, error: { code: "40001", message: `secret ${DK}` } };
    await expectError(await post(), 503, "SERVER");
    for (const call of vi.mocked(console.error).mock.calls) {
      expect(JSON.stringify(call)).not.toContain(DK);
    }
  });

  it("the ticket load failing after a bind → 503 SERVER", async () => {
    ticketRead = { data: null, error: { code: "PGRST116" } };
    await expectError(await post(), 503, "SERVER");
  });
});

describe("7. bound_first and unchanged → 200 { token, jti, serverTime }", () => {
  it.each(["bound_first", "unchanged"])("%s", async (result) => {
    if (result === "unchanged") activeRead = { data: { public_key: DK }, error: null };
    rpcResult = { data: result, error: null };
    const before = Math.floor(Date.now() / 1000);
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const json = (await res.json()) as { token: string; jti: string; serverTime: number };
    expect(json.jti).toBe(TICKET);
    expect(json.serverTime).toBeGreaterThanOrEqual(before);
    const claims = verifyTicketJwt(json.token) as unknown as Record<string, unknown>;
    expect(claims).toEqual({
      jti: TICKET,
      eid: "intake-1",
      tier: "VIP",
      admits: 2,
      exp: Math.floor(Date.parse("2027-01-01T00:00:00Z") / 1000),
      typ: "bound",
      dk: DK,
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(rateCalls("bindmail:")).toHaveLength(0);
  });

  it("the ticket is loaded within the host's tenant", async () => {
    await post();
    expect(filters.tickets).toEqual(
      expect.arrayContaining([
        ["eq", "id", TICKET],
        ["eq", "tenant_id", TENANT],
      ]),
    );
  });
});

describe("8. bound_again → the new-phone email, once per 10-minute window", () => {
  beforeEach(() => {
    rpcResult = { data: "bound_again", error: null };
    activeRead = { data: { public_key: newDeviceKey().dk }, error: null };
  });

  it("sends one email to the buyer's address", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const arg = sendEmail.mock.calls[0][0] as { to: string; subject: string; html: string };
    expect(arg.to).toBe(BUYER_EMAIL);
    expect(arg.subject).toBe(ticketNewPhoneEmail({ tier: "VIP" }).subject);
    expect(rateCalls("bindmail:").map((c) => c.slice(1))).toEqual([[`bindmail:${BUYER}`, 600, 1]]);
  });

  it("a second bound_again in the same window sends no further email", async () => {
    // Fixed-window counter: first consume ok, then limited.
    const counts = new Map<string, number>();
    consumeRateLimit.mockImplementation(async (_admin: unknown, key: string, _w: number, limit: number) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return n > limit ? "limited" : "ok";
    });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("the counter unavailable → still sends (the only anti-takeover signal)", async () => {
    consumeRateLimit.mockImplementation(async (_a: unknown, key: string) =>
      key.startsWith("bindmail:") ? "unavailable" : "ok",
    );
    expect((await post()).status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("the counter limited → skipped", async () => {
    consumeRateLimit.mockImplementation(async (_a: unknown, key: string) =>
      key.startsWith("bindmail:") ? "limited" : "ok",
    );
    expect((await post()).status).toBe(200);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a failed send (false) is still a 200, with a fixed-string log", async () => {
    sendEmail.mockResolvedValue(false);
    const res = await post();
    expect(res.status).toBe(200);
    expect(console.error).toHaveBeenCalledWith("[me/tickets/device] new-phone email not sent");
  });

  it("a thrown send is still a 200", async () => {
    sendEmail.mockRejectedValue(new Error(`boom ${BUYER_EMAIL}`));
    const res = await post();
    expect(res.status).toBe(200);
    expect(console.error).toHaveBeenCalledWith("[me/tickets/device] new-phone email not sent");
  });
});

describe("9. the RPC takes the host's tenant and ctx.buyerId, never the body", () => {
  it("ignores tenant and buyer ids in the body", async () => {
    await post({
      body: {
        publicKey: DK,
        tenantId: "00000000-0000-4000-8000-000000000000",
        p_tenant_id: "00000000-0000-4000-8000-000000000000",
        buyerId: "00000000-0000-4000-8000-000000000001",
        p_buyer_id: "00000000-0000-4000-8000-000000000001",
        ticketId: "00000000-0000-4000-8000-000000000002",
      },
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("bind_ticket_device", {
      p_ticket_id: TICKET,
      p_tenant_id: TENANT,
      p_buyer_id: BUYER,
      p_public_key: DK,
    });
  });
});

describe("10. no-store and no secrets in logs", () => {
  it("every path logs neither the token nor the key", async () => {
    const tokens: string[] = [];
    for (const r of ["bound_first", "bound_again", "unchanged", "refused"]) {
      rpcResult = { data: r, error: null };
      sendEmail.mockResolvedValue(false);
      const res = await post();
      expect(res.headers.get("cache-control")).toBe("no-store");
      if (res.status === 200) tokens.push(((await res.json()) as { token: string }).token);
    }
    expect(tokens.length).toBe(3);
    const logged = [console.error, console.warn, console.log]
      .flatMap((f) => vi.mocked(f).mock.calls)
      .map((c) => JSON.stringify(c))
      .join("\n");
    expect(logged).not.toContain(DK);
    for (const t of tokens) expect(logged).not.toContain(t);
  });
});

describe("ticketNewPhoneEmail", () => {
  it("is bilingual and says how to move it back", () => {
    const m = ticketNewPhoneEmail({ tier: "VIP", tenantName: "Sky Festival" });
    expect(m.subject).toMatch(/new phone/i);
    expect(m.html).toContain(
      "Your ticket was opened on a new phone. If this wasn't you, sign in and open your ticket again to move it back.",
    );
    expect(m.html).toMatch(/[က-႟]/); // Myanmar script
    expect(m.html).toContain("Sky Festival");
    expect(m.html).toContain("VIP");
  });

  it("escapes the tier", () => {
    const m = ticketNewPhoneEmail({ tier: "<script>x</script>" });
    expect(m.html).not.toContain("<script>x</script>");
    expect(m.html).toContain("&lt;script&gt;");
  });
});
