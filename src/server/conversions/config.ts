import type { ConversionPlatform } from "@/lib/conversions/payloads";

export type SendMode =
  | { kind: "send"; token: string; testCode: string | null }
  | { kind: "hold"; reason: string };

/**
 * The database does not separate environments (staging reads the dev database),
 * so only the deployment decides. Only production sends live events.
 */
export function resolveSendMode(
  configId: string,
  platform: ConversionPlatform,
  env: NodeJS.ProcessEnv = process.env,
): SendMode {
  const prefix = `CONVERSIONS_${configId}_${platform.toUpperCase()}`;
  const token = env[`${prefix}_TOKEN`]?.trim();
  if (!token) return { kind: "hold", reason: `missing ${prefix}_TOKEN` };
  if (env.VERCEL_ENV === "production") return { kind: "send", token, testCode: null };
  // GA4 has no test code. A non-null value sends to its validation endpoint,
  // which records nothing, so staging can't reach the real reports.
  if (platform === "ga4") return { kind: "send", token, testCode: "validate_only" };
  const testCode = env[`${prefix}_TEST_CODE`]?.trim();
  if (!testCode) return { kind: "hold", reason: "no_test_code" };
  return { kind: "send", token, testCode };
}
