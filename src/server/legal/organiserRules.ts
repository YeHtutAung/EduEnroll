// ─── Organiser rules: fingerprint and acceptance check ──────────────────────
//
// An order records WHICH wording of the organiser's event rules the buyer saw.
// Organisers can edit their rules at any time, so the buyer's page carries the
// fingerprint it was served and the order is refused if the rules have changed
// since — the acceptance would otherwise be of text the buyer never read.

import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { normaliseOrganiserTerms, TERMS_VERSION } from "@/lib/legal/terms";

type RulesRow = { id: string; organiser_terms: string | null };

/**
 * sha256 over every event's non-empty rules, keyed by event id and sorted, so
 * the result depends only on WHAT the rules are. Null when no event has any.
 */
export function organiserRulesFingerprint(rows: RulesRow[]): string | null {
  const withRules = rows
    .map((r) => ({ id: r.id, terms: normaliseOrganiserTerms(r.organiser_terms) }))
    .filter((r): r is { id: string; terms: string } => r.terms !== null)
    .sort((a, b) => a.id.localeCompare(b.id));

  if (withRules.length === 0) return null;
  return createHash("sha256").update(JSON.stringify(withRules)).digest("hex");
}

/** What is written to the order once it exists. */
export type TermsEvidence = {
  terms_accepted_at: string;
  terms_version: string;
  organiser_terms_sha256: string | null;
};

type Refusal = {
  ok: false;
  status: 400 | 409 | 503;
  body: { error: string; code: string; message: string; message_mm: string };
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RELOAD = {
  code: "TERMS_CHANGED",
  error: "Terms Changed",
  message: "The terms or event rules were updated. Please reload the page, review them and try again.",
  message_mm: "စည်းကမ်းချက်များ ပြောင်းလဲထားပါသည်။ စာမျက်နှာကို ပြန်ဖွင့်ပြီး ပြန်လည်စစ်ဆေးကာ ထပ်မံကြိုးစားပါ။",
};

/**
 * Checks, BEFORE any seat is reserved, that the order accepts the current
 * terms and the organiser rules currently set for every event in it.
 *
 * Class ids that are not UUIDs are skipped: the enrollment code rejects them
 * with its own 400, and there is no event to look up for them.
 */
export async function checkTermsAcceptance(
  body: Record<string, unknown>,
  classIds: unknown[],
): Promise<{ ok: true; evidence: Omit<TermsEvidence, "terms_accepted_at"> } | Refusal> {
  // Strictly boolean true: "true", 1 or a missing field are not an agreement.
  if (body.terms_accepted !== true) {
    return {
      ok: false,
      status: 400,
      body: {
        code: "TERMS_REQUIRED",
        error: "Terms Required",
        message: "Please agree to the Terms of Sale, Privacy Policy and event rules to continue.",
        message_mm: "ဆက်လက်ဆောင်ရွက်ရန် ရောင်းချမှုစည်းကမ်းချက်များ၊ ကိုယ်ရေးအချက်အလက်မူဝါဒနှင့် ပွဲစည်းကမ်းများကို သဘောတူကြောင်း အမှတ်ခြစ်ပါ။",
      },
    };
  }

  if (body.terms_version !== TERMS_VERSION) {
    return { ok: false, status: 409, body: RELOAD };
  }

  const ids = [...new Set(classIds.filter((id): id is string => typeof id === "string" && UUID_RE.test(id)))];
  if (ids.length === 0) {
    return { ok: true, evidence: { terms_version: TERMS_VERSION, organiser_terms_sha256: null } };
  }

  const supabase = createAdminClient();
  const unavailable: Refusal = {
    ok: false,
    status: 503,
    body: {
      code: "TERMS_UNAVAILABLE",
      error: "Service Unavailable",
      message: "We could not confirm the event rules. Please try again.",
      message_mm: "ပွဲစည်းကမ်းများကို အတည်မပြုနိုင်ပါ။ ထပ်မံကြိုးစားပါ။",
    },
  };

  const { data: classes, error: classError } = (await supabase
    .from("classes")
    .select("id, intake_id")
    .in("id", ids)) as unknown as { data: { id: string; intake_id: string }[] | null; error: unknown };
  if (classError || !classes) {
    console.error("[terms] class lookup failed:", (classError as { code?: string } | null)?.code ?? "no data");
    return unavailable;
  }

  const intakeIds = [...new Set(classes.map((c) => c.intake_id))];
  let rules: RulesRow[] = [];
  if (intakeIds.length > 0) {
    const { data, error } = (await supabase
      .from("intakes")
      .select("id, organiser_terms")
      .in("id", intakeIds)) as unknown as { data: RulesRow[] | null; error: unknown };
    // Unknown rules are not "no rules": accepting here would record consent to
    // wording nobody checked.
    if (error || !data) {
      console.error("[terms] organiser rules lookup failed:", (error as { code?: string } | null)?.code ?? "no data");
      return unavailable;
    }
    rules = data;
  }

  const expected = organiserRulesFingerprint(rules);
  const sent = typeof body.organiser_terms_sha256 === "string" ? body.organiser_terms_sha256 : null;
  if (sent !== expected) {
    return { ok: false, status: 409, body: RELOAD };
  }

  return { ok: true, evidence: { terms_version: TERMS_VERSION, organiser_terms_sha256: expected } };
}
