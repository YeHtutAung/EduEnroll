import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const {
  buildReferenceNo, REFERENCE_PATTERN, parseCbTimestamp, normaliseCode,
  apiKeyMatches, currencyFromCb, isPendingCode,
} = await import("@/lib/cbmmqr");

describe("buildReferenceNo", () => {
  it("is CB + 23 base32 characters, 25 in all (CB's referenceNo limit)", () => {
    const ref = buildReferenceNo();
    expect(ref).toHaveLength(25);
    expect(ref).toMatch(REFERENCE_PATTERN);
  });

  it("does not repeat across 10,000 draws", () => {
    const seen = new Set(Array.from({ length: 10_000 }, buildReferenceNo));
    expect(seen.size).toBe(10_000);
  });

  it("cannot collide with another provider's format", () => {
    expect(buildReferenceNo().startsWith("KBZ_")).toBe(false);
  });
});

describe("parseCbTimestamp", () => {
  afterEach(() => { delete process.env.CBMMQR_UTC_OFFSET; });

  it("reads CB's format in Myanmar time (+06:30) by default", () => {
    expect(parseCbTimestamp("20261031 10:14:14")).toBe(Date.parse("2026-10-31T10:14:14+06:30"));
  });

  it("uses CBMMQR_UTC_OFFSET when set", () => {
    process.env.CBMMQR_UTC_OFFSET = "+00:00";
    expect(parseCbTimestamp("20261031 10:14:14")).toBe(Date.parse("2026-10-31T10:14:14Z"));
  });

  it("throws on a malformed offset rather than guessing", () => {
    process.env.CBMMQR_UTC_OFFSET = "Asia/Yangon";
    expect(() => parseCbTimestamp("20261031 10:14:14")).toThrow(/CBMMQR_UTC_OFFSET/);
  });

  it.each([undefined, null, "", "2026-10-31 10:14:14", "20261331 10:14:14", 20261031])(
    "returns null for %s", (v) => { expect(parseCbTimestamp(v)).toBeNull(); },
  );
});

describe("normaliseCode", () => {
  it.each([[0, "0000"], [6, "0006"], ["0006", "0006"], [" 52 ", "0052"], ["0000", "0000"]])(
    "%s → %s", (v, out) => { expect(normaliseCode(v)).toBe(out); },
  );
  it.each([undefined, null, "", "abc", "00001", 1.5])("%s → null", (v) => {
    expect(normaliseCode(v)).toBeNull();
  });
});

describe("isPendingCode", () => {
  it("0006 and 0008 are pending; nothing else is", () => {
    expect(isPendingCode("0006")).toBe(true);
    expect(isPendingCode("0008")).toBe(true);
    for (const c of ["0000", "0007", "0009", "0026", null]) expect(isPendingCode(c)).toBe(false);
  });
});

describe("apiKeyMatches", () => {
  it("matches only the exact key", () => {
    expect(apiKeyMatches("secret-key", "secret-key")).toBe(true);
    expect(apiKeyMatches("secret-kez", "secret-key")).toBe(false);
    expect(apiKeyMatches("secret", "secret-key")).toBe(false);
    expect(apiKeyMatches(undefined, "secret-key")).toBe(false);
    expect(apiKeyMatches(123, "secret-key")).toBe(false);
  });
});

describe("currencyFromCb", () => {
  it("104 is MMK; anything else is null", () => {
    expect(currencyFromCb("104")).toBe("MMK");
    expect(currencyFromCb(104)).toBe("MMK");
    for (const v of ["MMK", "840", "", null, undefined]) expect(currencyFromCb(v)).toBeNull();
  });
});

const { createDynamicQr, checkStatus, __resetTokenCacheForTests } = await import("@/lib/cbmmqr");

const MERCHANT = {
  id: "YOUNGMONEY", userId: "ym-user", password: "ym-password", sourceId: "ym-source",
  merchantId: "M0001", terminalId: "T0001", apiKey: "ym-api-key"
};

type Answer = { status?: number; body: unknown } | Error;
let answers: Record<string, Answer[]>;
let calls: { url: string; method: string; body: Record<string, unknown> }[];

const tokenOk = (minutes = 30): Answer => ({
  body: { token: "TOKEN-1", returnCode: "0000", message: "ok",
          expiredDateTime: cbTime(Date.now() + minutes * 60_000) },
});
const cbTime = (ms: number) => {
  const d = new Date(ms + 390 * 60_000); // +06:30 wall clock
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};
const route = (url: string) =>
  url.endsWith("/auth/token") ? "token" : url.endsWith("/dynamicqr") ? "create" : "status";

beforeEach(() => {
  process.env.CBMMQR_BASE_URL = "https://cbgw.test/api";
  delete process.env.CBMMQR_MODE;
  delete process.env.VERCEL_ENV;
  __resetTokenCacheForTests();
  answers = { token: [tokenOk()], create: [], status: [] };
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method!, body: JSON.parse(String(init.body)) });
    const a = answers[route(url)].shift() ?? new Error("no canned answer");
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.CBMMQR_BASE_URL; });

const createOk = {
  body: { returnCode: "0000", message: "ok", referenceNo: "CBREF", qrCodeInfo: "000201QR",
          qrReferenceNo: "QR-1", qrIssuedDateTime: "20261031 10:11:14", qrExpiredDateTime: "20261031 10:14:14" },
};
const params = { referenceNo: "CBAAAAAAAAAAAAAAAAAAAAAAA", amount: 40000, purpose: "Ticket payment" };

describe("createDynamicQr", () => {
  it("sends one token request, then the QR request with the merchant's ids", async () => {
    answers.create = [createOk];
    const r = await createDynamicQr(MERCHANT, params);
    expect(r).toEqual({ kind: "created", qr: "000201QR", qrReferenceNo: "QR-1",
                        expiresAtMs: Date.parse("2026-10-31T10:14:14+06:30") });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["POST", "https://cbgw.test/api/auth/token"],
      ["POST", "https://cbgw.test/api/dynamicqr"],
    ]);
    expect(calls[0].body).toEqual({ userId: "ym-user", password: "ym-password" });
    expect(calls[1].body).toEqual({
      token: "TOKEN-1", sourceId: "ym-source", transCurrency: "104", transAmount: 40000,
      purposeOfTransaction: "Ticket payment", referenceNo: params.referenceNo,
      merchantId: "M0001", terminalId: "T0001",
    });
  });

  it("reuses a cached token on the next call", async () => {
    answers.create = [createOk, createOk];
    await createDynamicQr(MERCHANT, params);
    await createDynamicQr(MERCHANT, params);
    expect(calls.filter((c) => route(c.url) === "token")).toHaveLength(1);
  });

  it("fetches one token for concurrent first calls (single-flight)", async () => {
    answers.create = [createOk, createOk];
    await Promise.all([createDynamicQr(MERCHANT, params), createDynamicQr(MERCHANT, params)]);
    expect(calls.filter((c) => route(c.url) === "token")).toHaveLength(1);
  });

  it.each(["0012", "0017"])("on %s refreshes the token and retries exactly once", async (code) => {
    answers.token = [tokenOk(), { body: { ...((tokenOk() as { body: object }).body), token: "TOKEN-2" } }];
    answers.create = [{ body: { returnCode: code } }, createOk];
    const r = await createDynamicQr(MERCHANT, params);
    expect(r.kind).toBe("created");
    expect(calls.filter((c) => route(c.url) === "create").map((c) => c.body.token)).toEqual(["TOKEN-1", "TOKEN-2"]);
  });

  it("does not retry a second token failure", async () => {
    answers.token = [tokenOk(), tokenOk()];
    answers.create = [{ body: { returnCode: "0012" } }, { body: { returnCode: "0012" } }];
    expect((await createDynamicQr(MERCHANT, params)).kind).toBe("ambiguous");
    expect(calls.filter((c) => route(c.url) === "create")).toHaveLength(2);
  });

  it.each([
    ["0051", "below_minimum"], ["0052", "above_maximum"], ["0001", "config"],
    ["0002", "config"], ["0016", "config"], ["0021", "config"],
  ])("%s is a definite rejection (%s)", async (code, reason) => {
    answers.create = [{ body: { returnCode: code } }];
    expect(await createDynamicQr(MERCHANT, params)).toEqual({ kind: "rejected", reason, code });
  });

  it.each([
    ["0003 (reference exists)", { body: { returnCode: "0003" } }],
    ["an unknown code", { body: { returnCode: "0099" } }],
    ["0000 without a QR", { body: { returnCode: "0000", qrReferenceNo: "QR-1" } }],
    ["0000 without a QR reference", { body: { returnCode: "0000", qrCodeInfo: "000201QR" } }],
    ["HTTP 500", { status: 500, body: {} }],
    ["a transport error", new Error("socket hang up")],
  ])("%s is ambiguous", async (_n, answer) => {
    answers.create = [answer as Answer];
    expect((await createDynamicQr(MERCHANT, params)).kind).toBe("ambiguous");
  });

  it("returns a null expiry when CB's expiry cannot be read", async () => {
    answers.create = [{ body: { ...createOk.body, qrExpiredDateTime: "soon" } }];
    expect(await createDynamicQr(MERCHANT, params)).toMatchObject({ kind: "created", expiresAtMs: null });
  });

  it("truncates the purpose to 25 characters", async () => {
    answers.create = [createOk];
    await createDynamicQr(MERCHANT, { ...params, purpose: "x".repeat(40) });
    expect(String(calls[1].body.purposeOfTransaction)).toHaveLength(25);
  });

  it("is ambiguous without calling CB when the token request fails", async () => {
    answers.token = [{ body: { returnCode: "0021" } }];
    expect((await createDynamicQr(MERCHANT, params)).kind).toBe("ambiguous");
    expect(calls.filter((c) => route(c.url) === "create")).toHaveLength(0);
  });

  it("never logs the password, token or API key", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    answers.create = [new Error("boom")];
    await createDynamicQr(MERCHANT, params);
    const logged = spy.mock.calls.flat().join(" ");
    for (const secret of ["ym-password", "TOKEN-1", "ym-api-key"]) expect(logged).not.toContain(secret);
    spy.mockRestore();
  });

  it("starts nothing when the request budget is spent", async () => {
    expect((await createDynamicQr(MERCHANT, params, { deadlineMs: Date.now() })).kind).toBe("ambiguous");
    expect(calls).toHaveLength(0);
  });
});

describe("checkStatus", () => {
  const paid = {
    body: { returnCode: "0000", referenceNo: "CBREF", qrReferenceNo: "QR-1", transactionId: "TXN-1",
            transCurrency: "104", transAmount: 40000, merchantId: "M0001", institutionName: "Wave Money" },
  };

  it("PATCHes /dynamicqr/{qrReferenceNo}/status and returns CB's fields", async () => {
    answers.status = [paid];
    const r = await checkStatus(MERCHANT, "QR 1/x");
    expect(calls[1]).toMatchObject({ method: "PATCH", url: "https://cbgw.test/api/dynamicqr/QR%201%2Fx/status",
                                     body: { token: "TOKEN-1", sourceId: "ym-source" } });
    expect(r).toEqual({
      kind: "answer", code: "0000", referenceNo: "CBREF", qrReferenceNo: "QR-1", transactionId: "TXN-1",
      currency: "MMK", amount: 40000, merchantId: "M0001", institutionName: "Wave Money",
    });
  });

  it("returns pending codes as answers", async () => {
    answers.status = [{ body: { returnCode: 6 } }];
    expect(await checkStatus(MERCHANT, "QR-1")).toMatchObject({ kind: "answer", code: "0006" });
  });

  it("is unreachable on a transport error or a body without a code", async () => {
    answers.status = [new Error("timeout")];
    expect(await checkStatus(MERCHANT, "QR-1")).toEqual({ kind: "unreachable" });
    answers.status = [{ body: { message: "?" } }];
    expect(await checkStatus(MERCHANT, "QR-1")).toEqual({ kind: "unreachable" });
  });
});

describe("mode and base URL", () => {
  it("refuses a production deployment without CBMMQR_MODE=production", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(createDynamicQr(MERCHANT, params)).rejects.toThrow(/CBMMQR_MODE/);
  });

  it("refuses an unrecognised CBMMQR_MODE", async () => {
    process.env.CBMMQR_MODE = "prod";
    await expect(createDynamicQr(MERCHANT, params)).rejects.toThrow(/unrecognised/);
  });

  it("refuses a plaintext base URL in production mode", async () => {
    process.env.CBMMQR_MODE = "production";
    process.env.CBMMQR_BASE_URL = "http://cbgw.test/api";
    await expect(createDynamicQr(MERCHANT, params)).rejects.toThrow(/https/);
  });

  it("refuses a missing base URL", async () => {
    delete process.env.CBMMQR_BASE_URL;
    await expect(createDynamicQr(MERCHANT, params)).rejects.toThrow(/CBMMQR_BASE_URL/);
  });
});
