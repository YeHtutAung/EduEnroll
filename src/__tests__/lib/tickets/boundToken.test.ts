import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPairSync } from "crypto";

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env.TICKET_SIGNING_KEY = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  process.env.TICKET_KID = "test-kid";
});

const DK = "B" + "A".repeat(86); // shape only; the token doesn't parse the point

describe("bound ticket token", () => {
  it("carries typ bound and dk, and verifies with the ticket key", async () => {
    const { signBoundTicket, verifyTicketJwt } = await import("@/lib/tickets/sign");
    const t = signBoundTicket({ jti: "t1", eid: "i1", tier: "VIP", admits: 1, exp: 2_000_000_000 }, DK);
    const c = verifyTicketJwt(t) as unknown as Record<string, unknown>;
    expect(c).toMatchObject({ jti: "t1", eid: "i1", typ: "bound", dk: DK });
  });

  it("plain tokens still have no typ", async () => {
    const { signTicketJwt, verifyTicketJwt } = await import("@/lib/tickets/sign");
    const c = verifyTicketJwt(signTicketJwt({ jti: "t1", eid: "i1", tier: "VIP", admits: 1, exp: 1 }));
    expect((c as unknown as Record<string, unknown>).typ).toBeUndefined();
  });
});
