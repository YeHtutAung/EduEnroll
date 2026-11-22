// Browser-safe: no imports. The text a bound phone signs for a k2 QR (design 6.2).
// k2.ts (server) and deviceKey.ts (browser) both use this one definition.
export const k2SignedText = (jti: string, ts: string): string => `k2|${jti}|${ts}`;
