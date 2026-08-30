// Priority-access tokens. Deliberately a separate name from hashApiKey():
// this is not an API key, and a shared name makes the credential's purpose
// unreadable at the call site.
import { createHash, randomBytes } from "crypto";

/** Bytes of entropy per token. 32 is the same order as a session id. */
const TOKEN_BYTES = 32;

/** How much of the raw token is kept in the clear for admin display. */
const PREFIX_LENGTH = 8;

export function hashPriorityToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface MintedToken {
  token: string;
  tokenHash: string;
  tokenPrefix: string;
}

export function mintPriorityToken(): MintedToken {
  // base64url: safe in a URL fragment without escaping.
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return {
    token,
    tokenHash: hashPriorityToken(token),
    tokenPrefix: token.slice(0, PREFIX_LENGTH),
  };
}
