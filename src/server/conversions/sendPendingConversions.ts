import { createAdminClient } from "@/lib/supabase/admin";
import {
  buildGa4Request,
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
  ga4_measurement_id?: string | null;
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
  // Sales count in GA4 even with no ad data: it falls back to an anonymous ID.
  if (platform === "ga4") return settings.ga4_measurement_id ? "send" : "skip";
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

type Ga4Order = {
  items: { id: string; name: string; price: number; quantity: number }[];
  festivalName: string | null;
  eventSlug: string | null;
};
type ClassInfo = { level: string; intakes: { name: string | null; slug: string | null } | null } | null;

/**
 * The tickets, as the same IDs, names and prices the event page reports in
 * view_item and begin_checkout. A cart order has item rows; a single-ticket order
 * may only have class_id. Null when a read failed, so the row stays pending.
 */
async function readGa4Order(
  supabase: ReturnType<typeof createAdminClient>,
  enrollmentId: string,
  enrollment: { class_id?: string | null; quantity?: number | null } | null,
): Promise<Ga4Order | null> {
  const { data: rows, error } = (await supabase
    .from("enrollment_items")
    .select("class_id, quantity, fee_amount, classes(level, intakes(name, slug))")
    .eq("enrollment_id", enrollmentId)) as unknown as {
    data: { class_id: string; quantity: number; fee_amount: number; classes: ClassInfo }[] | null;
    error: DbError;
  };
  if (error) return null;

  let lines = (rows ?? []).map((r) => ({
    id: r.class_id,
    price: r.fee_amount,
    quantity: r.quantity,
    info: r.classes,
  }));
  if (lines.length === 0 && enrollment?.class_id) {
    const { data: cls, error: clsError } = (await supabase
      .from("classes")
      .select("id, level, fee_amount, intakes(name, slug)")
      .eq("id", enrollment.class_id)
      .maybeSingle()) as unknown as {
      data: { id: string; level: string; fee_amount: number; intakes: NonNullable<ClassInfo>["intakes"] } | null;
      error: DbError;
    };
    if (clsError) return null;
    if (cls) {
      lines = [{ id: cls.id, price: cls.fee_amount, quantity: enrollment.quantity ?? 1, info: cls }];
    }
  }

  return {
    items: lines.map((l) => ({ id: l.id, name: l.info?.level ?? l.id, price: l.price, quantity: l.quantity })),
    festivalName: lines[0]?.info?.intakes?.name ?? null,
    eventSlug: lines[0]?.info?.intakes?.slug ?? null,
  };
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
    .select("enabled, config_id, meta_pixel_id, tiktok_pixel_code, ga4_measurement_id")
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
    supabase
      .from("enrollments")
      .select("status, internal_test_at, email, phone, class_id, quantity")
      .eq("id", enrollmentId)
      .maybeSingle(),
    supabase
      .from("enrollment_ad_context" as never)
      .select("fbp, fbc, ttp, ttclid, client_ip, user_agent, source_url, referrer_url, ga_client_id, ga_session_id")
      .eq("enrollment_id", enrollmentId)
      .maybeSingle(),
  ])) as unknown as [
    {
      data: {
        status: string;
        internal_test_at: string | null;
        email: string | null;
        phone: string | null;
        class_id: string | null;
        quantity: number | null;
      } | null;
      error: DbError;
    },
    {
      data:
        | (ContextIds & {
            client_ip: string | null;
            user_agent: string | null;
            source_url: string;
            referrer_url: string | null;
            ga_client_id: string | null;
            ga_session_id: string | null;
          })
        | null;
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

  // Only when a GA4 row will go out. Before claiming, for the reason above.
  let ga4Order: Ga4Order | null = null;
  if (candidates.some(({ row }) => decideRow(row.platform, settings, enrollment, context) === "send" && row.platform === "ga4")) {
    ga4Order = await readGa4Order(supabase, enrollmentId, enrollment);
    if (!ga4Order) {
      console.error("[conversions] order read failed:", "ga4_items");
      return;
    }
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
  if (claimed.length === 0 || !settings || pastDeadline()) return;

  await Promise.all(
    claimed.map(async ({ row, token, testCode }) => {
      if (row.platform === "ga4") {
        const request = buildGa4Request({
          measurementId: settings.ga4_measurement_id!,
          apiSecret: token,
          validateOnly: testCode !== null,
          eventId: row.event_id,
          occurredAt: row.occurred_at,
          value: Number(row.value),
          currency: row.currency,
          clientId: context?.ga_client_id ?? null,
          sessionId: context?.ga_session_id ?? null,
          festivalName: ga4Order?.festivalName ?? null,
          eventSlug: ga4Order?.eventSlug ?? null,
          items: ga4Order?.items ?? [],
        });
        const outcome = await post(request, row.platform);
        console.log(`[conversions] ${row.platform} ${outcome.status} ${describeRequest(request)}`);
        await finish(row.id, row.attempts + 1, outcome.status, outcome.code);
        return;
      }
      // decideRow skips Meta and TikTok rows that have no ad data.
      if (!context) return;
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
        referrerUrl: context.referrer_url,
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
