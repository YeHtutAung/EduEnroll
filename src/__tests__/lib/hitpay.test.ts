import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { default: hitpay } = await import("@/lib/hitpay");

const BODY_TEXT = JSON.stringify({ id: "req-1", status: "completed" });
const SALT = "test-salt-value";

describe("hitpay.verifyWebhook", () => {
  it("returns true for valid HMAC-SHA256 signature", async () => {
    const crypto = await import("crypto");
    const signature = crypto.createHmac("sha256", SALT).update(BODY_TEXT).digest("hex");

    // Temporarily set env
    process.env.HITPAY_SALT = SALT;
    expect(hitpay.verifyWebhook(BODY_TEXT, signature)).toBe(true);
  });

  it("returns false for invalid signature", () => {
    process.env.HITPAY_SALT = SALT;
    expect(hitpay.verifyWebhook(BODY_TEXT, "bad-signature")).toBe(false);
  });

  it("returns false (not throws) when signature is different length", () => {
    process.env.HITPAY_SALT = SALT;
    expect(hitpay.verifyWebhook(BODY_TEXT, "short")).toBe(false);
  });
});

describe("hitpay.parseWebhookPayload", () => {
  it("parses a completed payload", () => {
    const payload = JSON.stringify({
      id: "req-abc",
      status: "completed",
      payments: [{ payment_type: "paynow_online" }],
    });
    const result = hitpay.parseWebhookPayload(payload);
    expect(result.id).toBe("req-abc");
    expect(result.status).toBe("completed");
    expect(result.payments[0].payment_type).toBe("paynow_online");
  });

  it("throws on invalid JSON", () => {
    expect(() => hitpay.parseWebhookPayload("not-json")).toThrow();
  });
});

describe("hitpay.createPaymentRequest", () => {
  beforeEach(() => {
    process.env.HITPAY_API_KEY = "test-key";
    process.env.HITPAY_MODE = "sandbox";
    vi.clearAllMocks();
  });

  it("calls sandbox URL with correct headers for paynow_online", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "req-1", qr_code_data: { qr_code: "QR_STRING" }, url: "https://checkout.url" }),
    });

    const result = await hitpay.createPaymentRequest({
      amount: "50.00",
      currency: "SGD",
      method: "paynow_online",
      referenceNumber: "NM-2026-0001",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("sandbox"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-BUSINESS-API-KEY": "test-key" }),
      }),
    );
    expect(result.id).toBe("req-1");
    expect(result.qr_code_data?.qr_code).toBe("QR_STRING");
  });

  it("includes redirect_url for card method", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "req-2", url: "https://hitpay.checkout/pay" }),
    });

    await hitpay.createPaymentRequest({
      amount: "50.00",
      currency: "SGD",
      method: "card",
      referenceNumber: "NM-2026-0001",
      redirectUrl: "https://mysite.com/payment/NM-2026-0001?hitpay=success",
    });

    const callBody = new URLSearchParams(mockFetch.mock.calls[0][1].body as string);
    expect(callBody.getAll("payment_methods[]")).toEqual(["card"]);
    expect(callBody.get("redirect_url")).toBe("https://mysite.com/payment/NM-2026-0001?hitpay=success");
    expect(callBody.get("generate_qr")).toBeNull();
  });

  it("throws on non-OK response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });

    await expect(
      hitpay.createPaymentRequest({ amount: "50.00", currency: "SGD", method: "paynow_online", referenceNumber: "x" }),
    ).rejects.toThrow("401");
  });
});
