import { createPrivateKey, createPublicKey, type KeyObject } from "crypto";

export function loadSigningKey(): { privateKey: KeyObject; kid: string } {
  const b64 = process.env.TICKET_SIGNING_KEY;
  const kid = process.env.TICKET_KID;
  if (!b64 || !kid) throw new Error("TICKET_SIGNING_KEY / TICKET_KID not configured");
  const privateKey = createPrivateKey({
    key: Buffer.from(b64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return { privateKey, kid };
}

export function getPublicKeyBase64Url(): string {
  const { privateKey } = loadSigningKey();
  const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return spki.subarray(-32).toString("base64url");
}
