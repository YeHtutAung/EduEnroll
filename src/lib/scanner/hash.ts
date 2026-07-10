// src/lib/scanner/hash.ts
// Pure key-hashing helper, deliberately free of "@/..." and "next/*" imports
// so it can be loaded directly by plain `node --experimental-strip-types`
// ops scripts (see scripts/create-scanner-key.ts) without a bundler.
import { createHash } from "crypto";

export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
