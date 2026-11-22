import { createPublicKey, verify as nodeVerify } from "crypto";
import { verifyTicketJwt, type TicketClaims } from "./sign";
import { k2SignedText } from "./k2Text";

// Design 6.2 / 7: k2.<bound token (3 segments)>.<ts>.<devsig>. Pure: no I/O.
// Every failure is null, so the caller answers one indistinguishable 404.

export const K2_PAST_SECONDS = 20;
export const K2_FUTURE_SECONDS = 10;
const TS = /^(0|[1-9][0-9]{0,11})$/; // canonical decimal, no sign, no leading zero
const DK = /^[A-Za-z0-9_-]{87}$/; // 65-byte raw point, base64url

export const isK2 = (token: string): boolean => token.startsWith("k2.");

/** The text the phone signs. Defined in k2Text.ts so the browser module can't drift from it. */
export { k2SignedText };

export interface VerifiedK2 {
  claims: TicketClaims;
  dk: string;
}

function p256Key(dk: string) {
  const raw = Buffer.from(dk, "base64url");
  if (raw.length !== 65 || raw[0] !== 0x04) return null;
  try {
    return createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: raw.subarray(1, 33).toString("base64url"),
        y: raw.subarray(33, 65).toString("base64url"),
      },
      format: "jwk",
    });
  } catch {
    return null; // not a point on the curve
  }
}

export function verifyK2(qr: string, nowSeconds: number): VerifiedK2 | null {
  // A NaN clock would make both window comparisons false and accept any ts.
  if (!Number.isFinite(nowSeconds)) return null;
  const parts = qr.split(".");
  if (parts.length !== 6 || parts[0] !== "k2") return null;
  const [, h, p, s, ts, devsig] = parts;

  let claims: TicketClaims & { typ?: unknown; dk?: unknown };
  try {
    claims = verifyTicketJwt(`${h}.${p}.${s}`) as TicketClaims & { typ?: unknown; dk?: unknown };
  } catch {
    return null;
  }
  // A signed payload of JSON null (or any non-object) must refuse, not throw.
  if (claims === null || typeof claims !== "object") return null;
  if (claims.typ !== "bound" || typeof claims.dk !== "string" || !DK.test(claims.dk)) return null;
  if (typeof claims.jti !== "string" || typeof claims.eid !== "string") return null;

  if (!TS.test(ts)) return null;
  const t = Number(ts);
  if (t < nowSeconds - K2_PAST_SECONDS || t > nowSeconds + K2_FUTURE_SECONDS) return null;

  const key = p256Key(claims.dk);
  if (!key) return null;
  let ok = false;
  try {
    ok = nodeVerify(
      "sha256",
      Buffer.from(k2SignedText(claims.jti, ts), "utf8"),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(devsig, "base64url"),
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  const { jti, eid, tier, admits, exp } = claims;
  return { claims: { jti, eid, tier, admits, exp }, dk: claims.dk };
}
