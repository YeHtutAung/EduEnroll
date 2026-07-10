import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPairSync } from "crypto";
import { signTicketJwt, verifyTicketJwt } from "@/lib/tickets/sign";

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env.TICKET_SIGNING_KEY = privateKey
    .export({ type: "pkcs8", format: "der" })
    .toString("base64");
  process.env.TICKET_KID = "test-kid";
});

it("signs and verifies an EdDSA ticket JWT", () => {
  const jwt = signTicketJwt({ jti: "t1", eid: "e1", tier: "GA", admits: 1, exp: 9999999999 });
  const parts = jwt.split(".");
  expect(parts).toHaveLength(3);
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  expect(header).toEqual({ alg: "EdDSA", kid: "test-kid" });
  const claims = verifyTicketJwt(jwt); // throws if signature invalid
  expect(claims).toMatchObject({ jti: "t1", eid: "e1", tier: "GA", admits: 1 });
});

it("rejects a tampered payload", () => {
  const jwt = signTicketJwt({ jti: "t1", eid: "e1", tier: "GA", admits: 1, exp: 9999999999 });
  const [h, , s] = jwt.split(".");
  const forged = Buffer.from(
    JSON.stringify({ jti: "t1", eid: "e1", tier: "VIP", admits: 9, exp: 9999999999 }),
  ).toString("base64url");
  expect(() => verifyTicketJwt(`${h}.${forged}.${s}`)).toThrow();
});
