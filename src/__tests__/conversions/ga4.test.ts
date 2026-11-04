import { describe, it, expect } from "vitest";
import {
  buildGa4Request,
  classifyResponse,
  describeRequest,
  fallbackGaClientId,
} from "@/lib/conversions/payloads";
import {
  gaSessionCookieName,
  parseGaClientId,
  parseGaSessionId,
} from "@/lib/conversions/clickData";
import { resolveSendMode } from "@/server/conversions/config";

const EVENT_ID = "eab2bab1118e00e3dcc437ca8d50e88cb394cb084c309e2a4b5d793a319382e9";
const NOW = Date.parse("2026-11-04T00:00:00.000Z");

const purchase = {
  measurementId: "G-TESTID123",
  apiSecret: "ga-secret-sentinel",
  validateOnly: false,
  eventId: EVENT_ID,
  occurredAt: "2026-11-03T23:00:00.000Z",
  value: 160000,
  currency: "MMK",
  clientId: "123456789.1700000000",
  sessionId: "1793716000",
  festivalName: "Sky Festival 2026",
  eventSlug: "november-2026",
  items: [{ id: "class-1", name: "All Day", price: 160000, quantity: 1 }],
};

const body = (over: Partial<typeof purchase> = {}, now = NOW) =>
  JSON.parse(buildGa4Request({ ...purchase, ...over }, now).body);

describe("parseGaClientId", () => {
  it("reads the two IDs after the version", () => {
    expect(parseGaClientId("GA1.1.123456789.1700000000")).toBe("123456789.1700000000");
    expect(parseGaClientId("GA1.2.123456789.1700000000")).toBe("123456789.1700000000");
    expect(parseGaClientId("GA1.2-2.123456789.1700000000")).toBe("123456789.1700000000");
  });
  it.each(["", "garbage", "GA1.1.abc.def", "GA1.1.123", "GA1.1.1.2<script>", null, undefined])(
    "gives null for %j",
    (raw) => {
      expect(parseGaClientId(raw)).toBeNull();
    },
  );
});

describe("parseGaSessionId", () => {
  it("reads the current cookie format", () => {
    expect(parseGaSessionId("GS2.1.s1793716000$o1$g1$t1793716100$j60$l0$h0")).toBe("1793716000");
  });
  it("reads the older cookie format", () => {
    expect(parseGaSessionId("GS1.1.1793716000.1.1.1793716100.0.0.0")).toBe("1793716000");
  });
  it.each(["", "garbage", "GA1.1.1.2", null, undefined])("gives null for %j", (raw) => {
    expect(parseGaSessionId(raw)).toBeNull();
  });
});

describe("gaSessionCookieName", () => {
  it("drops the G- prefix", () => expect(gaSessionCookieName("G-NV630DWXYP")).toBe("_ga_NV630DWXYP"));
});

describe("fallbackGaClientId", () => {
  it("has GA's two-number shape and stays the same on a retry", () => {
    const id = fallbackGaClientId(EVENT_ID);
    expect(id).toMatch(/^\d+\.\d+$/);
    expect(fallbackGaClientId(EVENT_ID)).toBe(id);
  });
  it("differs between orders", () => {
    expect(fallbackGaClientId("0".repeat(64))).not.toBe(fallbackGaClientId(EVENT_ID));
  });
});

describe("buildGa4Request", () => {
  it("sends the purchase with the agreed fields", () => {
    expect(body()).toEqual({
      client_id: "123456789.1700000000",
      timestamp_micros: Date.parse(purchase.occurredAt) * 1000,
      events: [
        {
          name: "purchase",
          params: {
            session_id: "1793716000",
            engagement_time_msec: 1,
            transaction_id: EVENT_ID,
            value: 160000,
            currency: "MMK",
            festival_name: "Sky Festival 2026",
            event_slug: "november-2026",
            items: [{ item_id: "class-1", item_name: "All Day", price: 160000, quantity: 1 }],
          },
        },
      ],
    });
  });

  it("posts to the live endpoint with the measurement ID and secret", () => {
    const url = new URL(buildGa4Request(purchase, NOW).url);
    expect(url.origin + url.pathname).toBe("https://www.google-analytics.com/mp/collect");
    expect(url.searchParams.get("measurement_id")).toBe("G-TESTID123");
    expect(url.searchParams.get("api_secret")).toBe("ga-secret-sentinel");
  });

  it("uses the validation endpoint, which records nothing, outside production", () => {
    const url = new URL(buildGa4Request({ ...purchase, validateOnly: true }, NOW).url);
    expect(url.pathname).toBe("/debug/mp/collect");
  });

  it("uses a stable fallback ID when the buyer has no GA cookie", () => {
    expect(body({ clientId: null as never }).client_id).toBe(fallbackGaClientId(EVENT_ID));
  });

  it("leaves out a missing session ID", () => {
    expect(body({ sessionId: null as never }).events[0].params).not.toHaveProperty("session_id");
  });

  it("leaves the time out once it is too old for GA to backdate", () => {
    const fourDaysLater = Date.parse(purchase.occurredAt) + 4 * 24 * 60 * 60 * 1000;
    expect(body({}, fourDaysLater)).not.toHaveProperty("timestamp_micros");
  });

  it("carries no buyer data, even if it is passed in", () => {
    const leaky = { ...purchase, email: "buyer@example.com", phone: "0912345678", name: "Buyer", enrollmentRef: "SF2-1102-ABC" };
    const sent = buildGa4Request(leaky, NOW).body;
    for (const s of ["buyer@example.com", "0912345678", "Buyer", "SF2-1102-ABC", "user_data", "ga-secret-sentinel"]) {
      expect(sent).not.toContain(s);
    }
  });
});

describe("classifyResponse for GA4", () => {
  it("treats the live endpoint's empty 204 as sent", () => {
    expect(classifyResponse("ga4", 204, null)).toEqual({ status: "sent", code: null });
  });
  it("treats a clean validation reply as sent", () => {
    expect(classifyResponse("ga4", 200, { validationMessages: [] })).toEqual({ status: "sent", code: null });
  });
  it("fails on a validation message, keeping only its code", () => {
    const outcome = classifyResponse("ga4", 200, {
      validationMessages: [{ description: "secret-sentinel value", validationCode: "VALUE_INVALID" }],
    });
    expect(outcome).toEqual({ status: "failed", code: "ga4_VALUE_INVALID" });
  });
  it("retries a server error", () => expect(classifyResponse("ga4", 503, null).status).toBe("pending"));
  it("fails a bad request", () => expect(classifyResponse("ga4", 400, null).status).toBe("failed"));
});

describe("describeRequest for GA4", () => {
  it("names the fields only, and never the secret or IDs", () => {
    const line = describeRequest(buildGa4Request({ ...purchase, validateOnly: true }, NOW));
    expect(line).toBe("fields=client_id,session_id test_code=yes");
  });
  it("says when the send is live and has no session", () => {
    const line = describeRequest(buildGa4Request({ ...purchase, sessionId: null as never }, NOW));
    expect(line).toBe("fields=client_id test_code=no");
  });
});

describe("resolveSendMode for GA4", () => {
  const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;

  it("holds without a secret", () => {
    expect(resolveSendMode("SKY", "ga4", env({ VERCEL_ENV: "production" }))).toEqual({
      kind: "hold",
      reason: "missing CONVERSIONS_SKY_GA4_TOKEN",
    });
  });
  it("sends live on production", () => {
    expect(resolveSendMode("SKY", "ga4", env({ VERCEL_ENV: "production", CONVERSIONS_SKY_GA4_TOKEN: "S" }))).toEqual({
      kind: "send",
      token: "S",
      testCode: null,
    });
  });
  it("only validates outside production, with no test code to set up", () => {
    const mode = resolveSendMode("SKY", "ga4", env({ VERCEL_ENV: "preview", CONVERSIONS_SKY_GA4_TOKEN: "S" }));
    expect(mode.kind).toBe("send");
    expect(mode.kind === "send" && mode.testCode).toBeTruthy();
  });
});
