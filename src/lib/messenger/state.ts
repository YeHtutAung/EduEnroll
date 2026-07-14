// ─── Signed OAuth state for Messenger Page connection ───────────────────────
//
// The Meta OAuth `state` parameter used to be the raw tenant slug. Because the
// callback trusted it verbatim, anyone could start the flow with someone else's
// slug and bind their own Facebook Page to that tenant. We instead issue a
// short-lived HMAC-signed token, minted only for the authenticated owner's own
// tenant at connect time and verified in the callback.
//
// Format: base64url(payload) + "." + base64url(HMAC-SHA256(payload)).
// HMAC key is MESSENGER_APP_SECRET (already required for the OAuth exchange).

import { createHmac, randomBytes, timingSafeEqual } from "crypto";

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface OAuthStatePayload {
  tenantId: string;
  slug: string;
  nonce: string;
  exp: number; // epoch ms
}

function secret(): string {
  const s = process.env.MESSENGER_APP_SECRET;
  if (!s) throw new Error("MESSENGER_APP_SECRET is not set.");
  return s;
}

function sign(body: string): string {
  return createHmac("sha256", secret()).update(body).digest("base64url");
}

export function signOAuthState(tenantId: string, slug: string): string {
  const payload: OAuthStatePayload = {
    tenantId,
    slug,
    nonce: randomBytes(9).toString("base64url"),
    exp: Date.now() + STATE_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifyOAuthState(token: string | null): OAuthStatePayload | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  const expectedSig = sign(body);
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as OAuthStatePayload;
    if (
      typeof payload.exp !== "number" ||
      Date.now() > payload.exp ||
      !payload.tenantId ||
      !payload.slug
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
