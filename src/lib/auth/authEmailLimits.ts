import { createHmac } from "crypto";

// ─── Send Email Hook: per-address caps ──────────────────────────────────────

export type AuthEmailType = "signup" | "magiclink" | "recovery" | "invite" | "reauthentication" | "email_change";
export type LimitGroup = "signin" | "staff" | "email_change";

export const GROUP: Record<AuthEmailType, LimitGroup> = {
  signup: "signin",
  magiclink: "signin",
  recovery: "staff",
  invite: "staff",
  reauthentication: "staff",
  email_change: "email_change",
};

export function isAuthEmailType(t: unknown): t is AuthEmailType {
  return typeof t === "string" && Object.prototype.hasOwnProperty.call(GROUP, t);
}

/** [windowSeconds, limit, label]: mobile spec 4.1. */
export const CAPS: Record<LimitGroup, Array<[number, number, string]>> = {
  signin: [
    [3600, 5, "h"],
    [86400, 20, "d"],
  ],
  staff: [
    [3600, 5, "h"],
    [86400, 20, "d"],
  ],
  email_change: [[86400, 3, "d"]],
};

/**
 * An HMAC, not a plain hash: a hash of an email address can be reversed by
 * hashing guesses. The caller passes the secret and must refuse to run without
 * one (createHmac with an undefined key throws).
 */
export function emailKey(email: string, secret: string): string {
  return createHmac("sha256", secret).update(email.trim().toLowerCase()).digest("hex");
}

/**
 * The Send Email Hook route's whole-request deadline: under GoTrue's 5 s hook
 * timeout, with room for the network. Lives here because a Next.js route file
 * may export only its handlers and route config.
 */
export const DEADLINE_MS = 4_000;
