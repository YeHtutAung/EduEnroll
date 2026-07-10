import { sign as edSign, verify as edVerify, createPublicKey } from "crypto";
import { loadSigningKey, getPublicKeyBase64Url } from "./keys";

const b64u = (b: Buffer) => b.toString("base64url");

export interface TicketClaims {
  jti: string;
  eid: string;
  tier: string;
  admits: number;
  exp: number;
}

export function signTicketJwt(claims: TicketClaims): string {
  const { privateKey, kid } = loadSigningKey();
  const header = b64u(Buffer.from(JSON.stringify({ alg: "EdDSA", kid })));
  const payload = b64u(Buffer.from(JSON.stringify(claims)));
  const data = Buffer.from(`${header}.${payload}`);
  const sig = edSign(null, data, privateKey); // Ed25519: algorithm arg is null
  return `${header}.${payload}.${b64u(sig)}`;
}

export function verifyTicketJwt(jwt: string): TicketClaims {
  const [h, p, s] = jwt.split(".");
  const rawPub = Buffer.from(getPublicKeyBase64Url(), "base64url");
  // Rebuild a KeyObject from the raw 32-byte key via the fixed Ed25519 SPKI prefix.
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawPub]);
  const pubKey = createPublicKey({ key: spki, format: "der", type: "spki" });
  const ok = edVerify(null, Buffer.from(`${h}.${p}`), pubKey, Buffer.from(s, "base64url"));
  if (!ok) throw new Error("invalid ticket signature");
  return JSON.parse(Buffer.from(p, "base64url").toString());
}
