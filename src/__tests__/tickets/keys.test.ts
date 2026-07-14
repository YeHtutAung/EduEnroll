import { describe, it, expect } from "vitest";
import { loadSigningKey, getPublicKeyBase64Url } from "@/lib/tickets/keys";
import { generateKeyPairSync } from "crypto";

describe("keys", () => {
  it("derives raw base64url public key from the configured private key", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
    process.env.TICKET_SIGNING_KEY = pkcs8;
    process.env.TICKET_KID = "test-kid";
    const { kid } = loadSigningKey();
    expect(kid).toBe("test-kid");
    expect(getPublicKeyBase64Url()).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
  });
});
