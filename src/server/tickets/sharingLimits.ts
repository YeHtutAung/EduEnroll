import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { clientIpFrom } from "@/lib/rateLimit";
import { consumeRateLimit, type RateLimitResult } from "@/server/buyers/rateLimit";

// Design 6.4 starting values. Durable counters only (Plan 2's RPC).
type Admin = SupabaseClient<Database>;

// A raw IP never goes into rate_limit_counters (decision 6).
const ipKey = (headers: Headers) =>
  `claimip:${createHash("sha256").update(clientIpFrom(headers)).digest("base64url").slice(0, 22)}`;

export const limitShare = (admin: Admin, buyerId: string) =>
  consumeRateLimit(admin, `share:${buyerId}`, 3600, 20);

export const limitGiveBack = (admin: Admin, buyerId: string) =>
  consumeRateLimit(admin, `giveback:${buyerId}`, 3600, 10);

async function buyerThenIp(
  admin: Admin,
  buyerKey: string,
  buyerLimit: number,
  headers: Headers,
): Promise<RateLimitResult> {
  const byBuyer = await consumeRateLimit(admin, buyerKey, 900, buyerLimit);
  if (byBuyer !== "ok") return byBuyer;
  return consumeRateLimit(admin, ipKey(headers), 900, 30);
}

export const limitClaim = (admin: Admin, buyerId: string, headers: Headers) =>
  buyerThenIp(admin, `claim:${buyerId}`, 10, headers);

// Separate buyer key so a reload after sign-in doesn't spend claim attempts
// (decision 12); the per-IP key is shared with the claim.
export const limitPreview = (admin: Admin, buyerId: string, headers: Headers) =>
  buyerThenIp(admin, `claimpreview:${buyerId}`, 30, headers);
