import { createAdminClient } from "@/lib/supabase/admin";
import {
  buildMetaRequest,
  buildTiktokRequest,
  classifyResponse,
  describeRequest,
  hashEmail,
  hashPhone,
  hashCountryFromPhone,
  type ConversionPlatform,
  type PlatformRequest,
  type SendOutcome,
} from "@/lib/conversions/payloads";
import { resolveSendMode } from "@/server/conversions/config";

// See docs/superpowers/specs/2026-11-02-purchase-conversion-design.md, section 5.
//
// `skipped` and `failed` are permanent, so only a real answer may lead to them. A
// failed read leaves every row pending, and every status write is conditional on
// still holding the claim. Logs carry only a code or an error name.

const RUN_DEADLINE_MS = 6000;
const SEND_TIMEOUT_MS = 2500;
const CLAIM_STALE_MS = 5 * 60 * 1000;

interface Settings {
  enabled: boolean;
  config_id: string;
  meta_pixel_id: string | null;
  tiktok_pixel_code: string | null;
}
interface ContextIds {
  fbp: string | null;
  fbc: string | null;
  ttp: string | null;
  ttclid: string | null;
}
interface QueueRow {
  id: string;
  tenant_id: string;
  platform: ConversionPlatform;
  event_id: string;
  value: number;
  currency: string;
  occurred_at: string;
  attempts: number;
}
type DbError = { code?: string } | null;

export function decideRow(
  platform: ConversionPlatform,
  settings: Settings | null,
  enrollment: { status: string; internal_test_at: string | null } | null,
  context: ContextIds | null,
): "send" | "skip" {
  if (!enrollment || enrollment.status !== "confirmed" || enrollment.internal_test_at) return "skip";
  if (!settings || !settings.enabled) return "skip";
  if (!context) return "skip";
  if (platform === "meta") return settings.meta_pixel_id && (context.fbp || context.fbc) ? "send" : "skip";
  return settings.tiktok_pixel_code && (context.ttclid || context.ttp) ? "send" : "skip";
}

async function post(request: PlatformRequest, platform: ConversionPlatform): Promise<SendOutcome> {
  try {
    const res = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      // Next 14 can cache a POST fetch when the route has touched no dynamic data.
      cache: "no-store",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    // Only invalid JSON counts as no body. A stalled or broken body must reach the
    // catch below: read as no body, it would end a row on a status alone.
    const body = await res.json().catch((err: unknown) => {
      if (err instanceof SyntaxError) return null;
      throw err;
    });
    return classifyResponse(platform, res.status, body);
  } catch {
    return { status: "pending", code: "transport" };
  }
}

async function run(enrollmentId: string, pastDeadline: () => boolean): Promise<void> {
  const supabase = createAdminClient();
  const table = () => supabase.from("conversion_events" as never);

  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  const { data: pending, error: pendingError } = (await table()
    .select("id, tenant_id, platform, event_id, value, currency, occurred_at, attempts")
    .eq("enrollment_id", enrollmentId)
    .eq("status", "pending")
    .or(`last_attempt_at.is.null,last_attempt_at.lt."${staleBefore}"`)) as unknown as {
    data: QueueRow[] | null;
    error: DbError;
  };
  if (pendingError) {
    console.error("[conversions] queue read failed:", pendingError.code ?? "unknown");
    return;
  }
  if (!pending || pending.length === 0) return;

  const { data: settings, error: settingsError } = (await supabase
    .from("tenant_conversion_settings" as never)
    .select("enabled, config_id, meta_pixel_id, tiktok_pixel_code")
    .eq("tenant_id", pending[0].tenant_id)
    .maybeSingle()) as unknown as { data: Settings | null; error: DbError };
  if (settingsError) {
    // Not the same as "no settings", which skips rows for good.
    console.error("[conversions] settings read failed:", settingsError.code ?? "unknown");
    return;
  }
  if (pastDeadline()) return;

  // Only the run holding the latest claim may end a row. A run frozen past its
  // deadline can wake after a later run has taken the row over, and without this
  // its old outcome would overwrite the new one. If the write fails the row stays
  // pending, is sent again later, and the platform deduplicates on event_id.
  const finish = async (
    id: string,
    attempts: number,
    status: "sent" | "failed" | "skipped" | "pending",
    code: string | null,
  ): Promise<void> => {
    try {
      const { data, error } = (await table()
        .update({ status, last_error: code } as never)
        .eq("id", id)
        .eq("status", "pending")
        .eq("attempts", attempts)
        .select("id")) as unknown as { data: { id: string }[] | null; error: DbError };
      if (error) console.error("[conversions] status not recorded:", error.code ?? "unknown");
      else if (!data || data.length === 0) console.warn("[conversions] outcome dropped: claim no longer held");
    } catch (err) {
      console.error("[conversions] status not recorded:", err instanceof Error ? err.name : "unknown");
    }
  };

  const candidates: { row: QueueRow; token: string; testCode: string | null }[] = [];
  for (const row of pending) {
    // Before the mode check: turning a tenant off must stop queued rows, even
    // ones whose token has already been removed.
    if (!settings || !settings.enabled) {
      await finish(row.id, row.attempts, "skipped", "disabled");
      continue;
    }
    const mode = resolveSendMode(settings.config_id, row.platform);
    if (mode.kind === "hold") {
      // Names the variable, never a value. Stays pending, attempts unchanged.
      if (mode.reason !== "no_test_code") console.error(`[conversions] ${mode.reason}`);
      continue;
    }
    candidates.push({ row, token: mode.token, testCode: mode.testCode });
  }
  if (candidates.length === 0) return;

  // Read before claiming, so a failed read leaves attempts and last_attempt_at
  // untouched and the next run does not have to wait out a claim.
  const [
    { data: enrollment, error: enrollmentError },
    { data: context, error: contextError },
  ] = (await Promise.all([
    supabase.from("enrollments").select("status, internal_test_at, email, phone").eq("id", enrollmentId).maybeSingle(),
    supabase
      .from("enrollment_ad_context" as never)
      .select("fbp, fbc, ttp, ttclid, client_ip, user_agent, source_url")
      .eq("enrollment_id", enrollmentId)
      .maybeSingle(),
  ])) as unknown as [
    {
      data: { status: string; internal_test_at: string | null; email: string | null; phone: string | null } | null;
      error: DbError;
    },
    {
      data: (ContextIds & { client_ip: string | null; user_agent: string | null; source_url: string }) | null;
      error: DbError;
    },
  ];
  if (enrollmentError || contextError) {
    console.error(
      "[conversions] order read failed:",
      enrollmentError?.code ?? contextError?.code ?? "unknown",
    );
    return;
  }

  const claimed: typeof candidates = [];
  for (const candidate of candidates) {
    const { row } = candidate;
    if (decideRow(row.platform, settings, enrollment, context) === "skip") {
      await finish(row.id, row.attempts, "skipped", "not_eligible");
      continue;
    }
    if (pastDeadline()) return;
    // The attempts check is the claim: only one caller can move it on.
    const { data: won, error: claimError } = (await table()
      .update({ attempts: row.attempts + 1, last_attempt_at: new Date().toISOString() } as never)
      .eq("id", row.id)
      .eq("status", "pending")
      .eq("attempts", row.attempts)
      .select("id")) as unknown as { data: { id: string }[] | null; error: DbError };
    if (claimError) console.error("[conversions] claim failed:", claimError.code ?? "unknown");
    else if (won && won.length > 0) claimed.push(candidate);
  }
  if (claimed.length === 0 || !context || !settings || pastDeadline()) return;

  await Promise.all(
    claimed.map(async ({ row, token, testCode }) => {
      const event = {
        // Hashed here and never stored: a retry reads them from the order again.
        hashedEmail: hashEmail(enrollment?.email),
        hashedPhone: hashPhone(enrollment?.phone),
        hashedCountry: hashCountryFromPhone(enrollment?.phone),
        eventId: row.event_id,
        occurredAt: row.occurred_at,
        value: Number(row.value),
        currency: row.currency,
        sourceUrl: context.source_url,
        clientIp: context.client_ip,
        userAgent: context.user_agent,
        fbp: context.fbp,
        fbc: context.fbc,
        ttp: context.ttp,
        ttclid: context.ttclid,
      };
      const request =
        row.platform === "meta"
          ? buildMetaRequest({ pixelId: settings.meta_pixel_id!, token, testCode, event })
          : buildTiktokRequest({ pixelCode: settings.tiktok_pixel_code!, token, testCode, event });
      const outcome = await post(request, row.platform);
      console.log(`[conversions] ${row.platform} ${outcome.status} ${describeRequest(request)}`);
      await finish(row.id, row.attempts + 1, outcome.status, outcome.code);
    }),
  );
}

/** Never throws. A row left unfinished at the deadline is picked up by the cron. */
export async function sendPendingConversions(enrollmentId: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    await Promise.race([
      run(enrollmentId, () => expired),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          resolve();
        }, RUN_DEADLINE_MS);
      }),
    ]);
  } catch (err) {
    console.error("[conversions] send failed:", err instanceof Error ? err.name : "unknown");
  } finally {
    if (timer) clearTimeout(timer);
  }
}
