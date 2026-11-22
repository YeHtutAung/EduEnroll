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

function signPayload(payload: object): string {
  const { privateKey, kid } = loadSigningKey();
  const header = b64u(Buffer.from(JSON.stringify({ alg: "EdDSA", kid })));
  const body = b64u(Buffer.from(JSON.stringify(payload)));
  const data = Buffer.from(`${header}.${body}`);
  const sig = edSign(null, data, privateKey); // Ed25519: algorithm arg is null
  return `${header}.${body}.${b64u(sig)}`;
}

export function signTicketJwt(claims: TicketClaims): string {
  return signPayload(claims);
}

export interface BoundTicketClaims extends TicketClaims {
  typ: "bound";
  /** The device's raw P-256 public key, base64url (87 chars). */
  dk: string;
}

/** Design 6.1: the token a bound phone keeps. Same key and format as a plain ticket token. */
export function signBoundTicket(claims: TicketClaims, dk: string): string {
  const payload: BoundTicketClaims = { ...claims, typ: "bound", dk };
  return signPayload(payload);
}

// Verifies signature only — does NOT check exp/kid. Callers (scan endpoint) enforce exp/tenant via the DB.
export function verifyTicketJwt(jwt: string): TicketClaims {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("malformed ticket token");
  const [h, p, s] = parts;
  const rawPub = Buffer.from(getPublicKeyBase64Url(), "base64url");
  // Rebuild a KeyObject from the raw 32-byte key via the fixed Ed25519 SPKI prefix.
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawPub]);
  const pubKey = createPublicKey({ key: spki, format: "der", type: "spki" });
  const ok = edVerify(null, Buffer.from(`${h}.${p}`), pubKey, Buffer.from(s, "base64url"));
  if (!ok) throw new Error("invalid ticket signature");
  return JSON.parse(Buffer.from(p, "base64url").toString());
}
