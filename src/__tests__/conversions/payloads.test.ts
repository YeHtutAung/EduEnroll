import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  buildMetaRequest,
  buildTiktokRequest,
  classifyResponse,
  hashEmail,
  hashPhone,
} from "@/lib/conversions/payloads";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const event = {
  hashedEmail: "hashed-email",
  hashedPhone: "hashed-phone",
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

describe("hashEmail", () => {
  it("hashes the trimmed, lowercased address, as Meta requires", () => {
    expect(hashEmail("  Buyer@Example.COM ")).toBe(sha256("buyer@example.com"));
  });
  it.each(["", "   ", "not-an-email", null, undefined])("gives null for %j", (raw) => {
    expect(hashEmail(raw)).toBeNull();
  });
});

describe("hashPhone", () => {
  it.each([
    ["09123456789", "959123456789"],
    ["+959123456789", "959123456789"],
    ["+95 9 123-456-789", "959123456789"],
    ["00959123456789", "959123456789"],
    ["959123456789", "959123456789"],
    ["+81 90 1234 5678", "819012345678"],
    ["+66812345678", "66812345678"],
  ])("hashes %s as %s", (raw, normal) => {
    expect(hashPhone(raw)).toBe(sha256(normal));
  });
  it.each(["", "   ", "abc", "12345", "+1234567890123456", null, undefined])("gives null for %j", (raw) => {
    expect(hashPhone(raw)).toBeNull();
  });
});

// The owner ruled out names and order refs, and allows email and phone only as
// hashes and only to Meta (2026-11-03). The builders take an explicit field list,
// and this pins that nothing else can reach a payload.
describe("privacy", () => {
  const leaky = { ...event, email: "buyer@example.com", phone: "0912345678", name: "Buyer", enrollmentRef: "SF2-1102-ABC" };
  const meta = () => buildMetaRequest({ pixelId: "1", token: "T", testCode: null, event: leaky }).body;
  const tiktok = () => buildTiktokRequest({ pixelCode: "P", token: "T", testCode: null, event: leaky }).body;

  it("never includes raw buyer data, even if it is passed in", () => {
    const all = [meta(), tiktok()].join();
    for (const s of ["buyer@example.com", "0912345678", "Buyer", "SF2-1102-ABC", '"email"', '"phone"', '"fn"', '"ln"']) {
      expect(all).not.toContain(s);
    }
  });

  it("gives Meta the hashes", () => {
    expect(JSON.parse(meta()).data[0].user_data).toMatchObject({ em: ["hashed-email"], ph: ["hashed-phone"] });
  });

  it("leaves a missing hash out of Meta's request", () => {
    const body = buildMetaRequest({
      pixelId: "1",
      token: "T",
      testCode: null,
      event: { ...event, hashedEmail: null, hashedPhone: null },
    }).body;
    const { user_data: userData } = JSON.parse(body).data[0];
    expect(userData).not.toHaveProperty("em");
    expect(userData).not.toHaveProperty("ph");
  });

  it("never gives TikTok the hashes", () => {
    const sent = tiktok();
    for (const s of ["hashed-email", "hashed-phone", '"em"', '"ph"']) expect(sent).not.toContain(s);
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

describe("classifyResponse without a usable body code", () => {
  const bodies: [string, unknown][] = [["null", null], ["empty object", {}], ["a string", "<html>"], ["a number", 5], ["an array", []]];
  for (const platform of ["meta", "tiktok"] as const) {
    for (const status of [401, 403, 408, 429, 500, 503]) {
      for (const [label, body] of bodies) {
        it(`${platform} ${status} with ${label} is pending`, () => {
          expect(classifyResponse(platform, status, body).status).toBe("pending");
        });
      }
    }
    it(`${platform} fails other client errors with no code`, () => {
      for (const status of [400, 404, 422]) expect(classifyResponse(platform, status, {}).status).toBe("failed");
    });
  }
  it("never treats a TikTok 2xx with no code as sent", () => {
    for (const body of [null, {}, "ok", 5, []]) expect(classifyResponse("tiktok", 200, body).status).not.toBe("sent");
  });
  it("does not treat a Meta 2xx that carries an error as sent", () => {
    expect(classifyResponse("meta", 200, { error: { code: 100 } }).status).toBe("failed");
  });
});

describe("classifyResponse Meta setup mistakes", () => {
  it("retries code 613", () => expect(classifyResponse("meta", 400, { error: { code: 613 } }).status).toBe("pending"));
  it("retries code 100 with subcode 33 (no access to the pixel)", () => {
    expect(classifyResponse("meta", 400, { error: { code: 100, error_subcode: 33 } }).status).toBe("pending");
  });
  it("still fails plain code 100 and other subcodes", () => {
    expect(classifyResponse("meta", 400, { error: { code: 100 } })).toEqual({ status: "failed", code: "meta_100" });
    expect(classifyResponse("meta", 400, { error: { code: 100, error_subcode: 2804003 } }).status).toBe("failed");
  });
});

// Exact shapes, so any new key (an external_id, say) fails here.
describe("exact payload shape", () => {
  const nulls = {
    ...event,
    hashedEmail: null,
    hashedPhone: null,
    clientIp: null,
    userAgent: null,
    fbp: null,
    fbc: null,
    ttp: null,
    ttclid: null,
  };

  it("Meta, full", () => {
    expect(JSON.parse(buildMetaRequest({ pixelId: "1", token: "T", testCode: "TC", event }).body)).toEqual({
      access_token: "T",
      test_event_code: "TC",
      data: [
        {
          event_name: "Purchase",
          event_time: 1793577600,
          event_id: "hash123",
          action_source: "website",
          event_source_url: event.sourceUrl,
          user_data: {
            client_ip_address: "203.0.113.1",
            client_user_agent: "UA",
            fbp: "fb.1.1.1",
            fbc: "fb.1.1.abc",
            em: ["hashed-email"],
            ph: ["hashed-phone"],
          },
          custom_data: { value: 25, currency: "USD" },
        },
      ],
    });
  });
  it("Meta, null fields are omitted", () => {
    expect(JSON.parse(buildMetaRequest({ pixelId: "1", token: "T", testCode: null, event: nulls }).body).data[0]).toEqual({
      event_name: "Purchase",
      event_time: 1793577600,
      event_id: "hash123",
      action_source: "website",
      event_source_url: event.sourceUrl,
      user_data: {},
      custom_data: { value: 25, currency: "USD" },
    });
  });
  it("TikTok, full, with the test code at the top level", () => {
    const body = JSON.parse(buildTiktokRequest({ pixelCode: "PX", token: "T", testCode: "TC", event }).body);
    expect(body.test_event_code).toBe("TC");
    expect(body).toEqual({
      event_source: "web",
      event_source_id: "PX",
      test_event_code: "TC",
      data: [
        {
          event: "Purchase",
          event_time: 1793577600,
          event_id: "hash123",
          user: { ttclid: "tt1", ttp: "ttp1", ip: "203.0.113.1", user_agent: "UA" },
          page: { url: event.sourceUrl },
          properties: { value: 25, currency: "USD" },
        },
      ],
    });
  });
  it("TikTok, null fields are omitted and there is no test code", () => {
    const body = JSON.parse(buildTiktokRequest({ pixelCode: "PX", token: "T", testCode: null, event: nulls }).body);
    expect(body.test_event_code).toBeUndefined();
    expect(body.data[0]).toEqual({
      event: "Purchase",
      event_time: 1793577600,
      event_id: "hash123",
      user: {},
      page: { url: event.sourceUrl },
      properties: { value: 25, currency: "USD" },
    });
  });
});
