import { describe, it, expect } from "vitest";
import { buildMetaRequest, buildTiktokRequest, classifyResponse } from "@/lib/conversions/payloads";

const event = {
  eventId: "hash123",
  occurredAt: "2026-11-02T00:00:00.000Z",
  value: 25,
  currency: "USD",
  sourceUrl: "https://tickets.example.com/enroll/event",
  clientIp: "203.0.113.1",
  userAgent: "UA",
  fbp: "fb.1.1.1",
  fbc: "fb.1.1.abc",
  ttp: "ttp1",
  ttclid: "tt1",
};

describe("buildMetaRequest", () => {
  it("sends a Purchase with the agreed fields", () => {
    const r = buildMetaRequest({ pixelId: "123", token: "TOKEN", testCode: null, event });
    const body = JSON.parse(r.body);
    expect(r.url).toContain("/123/events");
    expect(r.url).not.toContain("TOKEN");
    expect(body.data[0]).toMatchObject({
      event_name: "Purchase",
      event_id: "hash123",
      event_time: 1793577600,
      action_source: "website",
      event_source_url: event.sourceUrl,
      custom_data: { value: 25, currency: "USD" },
    });
    expect(body.test_event_code).toBeUndefined();
  });
  it("adds the test code when there is one", () => {
    expect(JSON.parse(buildMetaRequest({ pixelId: "1", token: "T", testCode: "TEST1", event }).body).test_event_code).toBe("TEST1");
  });
});

describe("buildTiktokRequest", () => {
  it("sends a Purchase with the token only in the header", () => {
    const r = buildTiktokRequest({ pixelCode: "PX", token: "TOKEN", testCode: null, event });
    expect(r.headers["Access-Token"]).toBe("TOKEN");
    expect(r.body).not.toContain("TOKEN");
    const body = JSON.parse(r.body);
    expect(body.event_source).toBe("web");
    expect(body.event_source_id).toBe("PX");
    expect(body.data[0].event).toBe("Purchase");
  });
});

// The owner ruled out buyer contact data. The builders take an explicit field
// list, and this pins that nothing else can reach a payload.
describe("privacy", () => {
  it("never includes buyer data, even if it is passed in", () => {
    const leaky = { ...event, email: "buyer@example.com", phone: "0912345678", name: "Buyer", enrollmentRef: "SF2-1102-ABC" };
    const all = [
      buildMetaRequest({ pixelId: "1", token: "T", testCode: null, event: leaky }).body,
      buildTiktokRequest({ pixelCode: "P", token: "T", testCode: null, event: leaky }).body,
    ].join();
    for (const s of ["buyer@example.com", "0912345678", "Buyer", "SF2-1102-ABC", '"em"', '"ph"', '"email"', '"phone"']) {
      expect(all).not.toContain(s);
    }
  });
});

describe("classifyResponse", () => {
  it("treats Meta 200 as sent", () => expect(classifyResponse("meta", 200, {}).status).toBe("sent"));
  it("retries Meta rate limit and auth errors", () => {
    expect(classifyResponse("meta", 400, { error: { code: 17 } }).status).toBe("pending");
    expect(classifyResponse("meta", 400, { error: { code: 190 } }).status).toBe("pending");
  });
  it("fails any other Meta rejection", () => {
    expect(classifyResponse("meta", 400, { error: { code: 100 } })).toEqual({ status: "failed", code: "meta_100" });
  });
  it("treats TikTok 200 with code 0 as sent", () => expect(classifyResponse("tiktok", 200, { code: 0 }).status).toBe("sent"));
  it("does not treat TikTok 200 with an error code as sent", () => {
    expect(classifyResponse("tiktok", 200, { code: 40002 }).status).toBe("failed");
    expect(classifyResponse("tiktok", 200, { code: 40100 }).status).toBe("pending");
  });
  it("judges TikTok by the body code, whatever the HTTP status", () => {
    // Its Events page lists rate limiting as HTTP 401.
    expect(classifyResponse("tiktok", 401, { code: 40100 })).toEqual({ status: "pending", code: "tiktok_40100" });
    expect(classifyResponse("tiktok", 400, { code: 40002 }).status).toBe("failed");
    expect(classifyResponse("tiktok", 400, { code: 0 }).status).toBe("sent");
  });
  it("retries TikTok auth and permission errors", () => {
    for (const code of [40102, 40105, 40001, 40125]) {
      expect(classifyResponse("tiktok", 200, { code }).status).toBe("pending");
    }
  });
  it("retries Meta's other documented limit and permission codes", () => {
    for (const code of [341, 80004, 102, 10, 294]) {
      expect(classifyResponse("meta", 400, { error: { code } }).status).toBe("pending");
    }
  });
  it("retries 5xx on both", () => {
    expect(classifyResponse("meta", 503, null).status).toBe("pending");
    expect(classifyResponse("tiktok", 503, null).status).toBe("pending");
  });
  it("records only a code, never the body", () => {
    expect(JSON.stringify(classifyResponse("meta", 400, { error: { code: 100, message: "secret detail" } }))).not.toContain("secret");
  });
});
