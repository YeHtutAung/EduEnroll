import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockStatus = vi.fn();
vi.mock("@/lib/cbmmqr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cbmmqr")>();
  return { ...actual, checkStatus: (...a: unknown[]) => mockStatus(...a) };
});
const mockSettle = vi.fn();
vi.mock("@/server/payments/settleCbmmqrPayment", () => ({
  settleCbmmqrPayment: (...a: unknown[]) => mockSettle(...a),
}));

const mod = await import("@/server/payments/resolveCbmmqrOrder");
const { resolveCbmmqrOrder, isConfirmedDead, CB_CONFIRMED_DEAD_CODES } = mod;
const { CB_MAX_QR_MINUTES, CB_EXPIRY_MARGIN_MINUTES } = await import("@/server/payments/cbmmqrOrderWindow");

const MIN = 60_000;
const NOW = Date.parse("2026-10-31T04:00:00Z");
const MERCHANT = {
  id: "YOUNGMONEY", userId: "u", password: "p", sourceId: "s", merchantId: "M0001",
  terminalId: "T0001", apiKey: "k"
};
const row = (over: object = {}) => ({
  ref: "CBAAAAAAAAAAAAAAAAAAAAAAA", orderRef: "QR-1" as string | null,
  expiresAtMs: NOW - 10 * MIN as number | null, createdAtMs: NOW - 15 * MIN, displayed: true, ...over,
});
const run = (r = row()) => resolveCbmmqrOrder({ row: r, merchant: MERCHANT, source: "create", now: NOW });

beforeEach(() => {
  vi.clearAllMocks();
  mockStatus.mockResolvedValue({ kind: "answer", code: "0006", currency: null, amount: null });
});
afterEach(() => { (CB_CONFIRMED_DEAD_CODES as Set<string>).clear(); });

describe("isConfirmedDead", () => {
  const dead = { kind: "answer" as const, code: "0099", currency: null, amount: null };

  it("is false for every code while CB_CONFIRMED_DEAD_CODES is empty (gate G1)", () => {
    for (const code of ["0000", "0006", "0007", "0008", "0009", "0026", "0099"]) {
      expect(isConfirmedDead({ ...dead, code }, NOW - 60 * MIN, NOW)).toBe(false);
    }
  });

  it("needs both a confirmed code AND expiry + margin passed", () => {
    (CB_CONFIRMED_DEAD_CODES as Set<string>).add("0099");
    const margin = CB_EXPIRY_MARGIN_MINUTES * MIN;
    expect(isConfirmedDead(dead, NOW - margin - 1, NOW)).toBe(true);
    expect(isConfirmedDead(dead, NOW - margin, NOW)).toBe(false);
    expect(isConfirmedDead(dead, null, NOW)).toBe(false);
    expect(isConfirmedDead({ kind: "unreachable" }, NOW - 60 * MIN, NOW)).toBe(false);
  });
});

describe("resolveCbmmqrOrder — row with CB's reference", () => {
  it("already_paid when the status check shows success and settlement succeeds", async () => {
    mockStatus.mockResolvedValue({ kind: "answer", code: "0000", currency: "MMK", amount: 40000 });
    mockSettle.mockResolvedValue({ kind: "settled" });
    expect(await run()).toEqual({ kind: "already_paid" });
    expect(mockStatus).toHaveBeenCalledWith(MERCHANT, "QR-1", undefined);
    expect(mockSettle).toHaveBeenCalledWith(expect.objectContaining({
      payment: { payment_ref: row().ref, payment_method: "cb_mmqr", cbmmqr_merchant: "YOUNGMONEY" },
    }));
  });

  it("settlement_conflict when settlement refuses; blocked when it is retryable", async () => {
    mockStatus.mockResolvedValue({ kind: "answer", code: "0000", currency: "MMK", amount: 40000 });
    mockSettle.mockResolvedValue({ kind: "refused", reason: "x" });
    expect((await run()).kind).toBe("settlement_conflict");
    mockSettle.mockResolvedValue({ kind: "retryable", reason: "x" });
    expect((await run()).kind).toBe("blocked");
  });

  it("active, never retire, while no dead code is confirmed — however old the QR", async () => {
    expect(await run(row({ expiresAtMs: NOW - 600 * MIN }))).toEqual({
      kind: "active", retryAtMs: NOW + CB_EXPIRY_MARGIN_MINUTES * MIN,
    });
  });

  it("active with retryAt = expiry + margin for a QR not yet expired", async () => {
    expect(await run(row({ expiresAtMs: NOW + MIN }))).toEqual({
      kind: "active", retryAtMs: NOW + MIN + CB_EXPIRY_MARGIN_MINUTES * MIN,
    });
  });

  it("retire EXPIRED once a confirmed dead code is returned after expiry + margin", async () => {
    (CB_CONFIRMED_DEAD_CODES as Set<string>).add("0099");
    mockStatus.mockResolvedValue({ kind: "answer", code: "0099", currency: null, amount: null });
    expect(await run()).toEqual({ kind: "retire", reason: "EXPIRED" });
  });

  it("active when the status check is unreachable", async () => {
    mockStatus.mockResolvedValue({ kind: "unreachable" });
    expect((await run()).kind).toBe("active");
  });
});

describe("resolveCbmmqrOrder — row without CB's reference (lost create response, never displayed)", () => {
  const window = (CB_MAX_QR_MINUTES + CB_EXPIRY_MARGIN_MINUTES) * MIN;

  it("retire FAILED after created_at + max validity + margin, without calling CB", async () => {
    expect(await run(row({ orderRef: null, createdAtMs: NOW - window - 1 }))).toEqual({ kind: "retire", reason: "FAILED" });
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it("active before that", async () => {
    expect(await run(row({ orderRef: null, createdAtMs: NOW - window + 1000 }))).toEqual({
      kind: "active", retryAtMs: NOW + 1000,
    });
  });
});

describe("resolveCbmmqrOrder — CB's reference stored but QR withheld (never displayed)", () => {
  const window = (CB_MAX_QR_MINUTES + CB_EXPIRY_MARGIN_MINUTES) * MIN;

  it("checks status with the pinned merchant, then retires FAILED after the window", async () => {
    expect(await run(row({ displayed: false, createdAtMs: NOW - window - 1 }))).toEqual({ kind: "retire", reason: "FAILED" });
    expect(mockStatus).toHaveBeenCalledWith(MERCHANT, "QR-1", undefined);
  });

  it("checks status, then active until created_at + window", async () => {
    expect(await run(row({ displayed: false, createdAtMs: NOW - window + 1000 }))).toEqual({
      kind: "active", retryAtMs: NOW + 1000,
    });
    expect(mockStatus).toHaveBeenCalledTimes(1);
  });

  it("already_paid when the status check shows success, even after the window", async () => {
    mockStatus.mockResolvedValue({ kind: "answer", code: "0000", currency: "MMK", amount: 40000 });
    mockSettle.mockResolvedValue({ kind: "settled" });
    expect(await run(row({ displayed: false, createdAtMs: NOW - window - 1 }))).toEqual({ kind: "already_paid" });
  });

  it("an unreachable status check does not block the time rule", async () => {
    mockStatus.mockResolvedValue({ kind: "unreachable" });
    expect(await run(row({ displayed: false, createdAtMs: NOW - window - 1 }))).toEqual({ kind: "retire", reason: "FAILED" });
  });
});
