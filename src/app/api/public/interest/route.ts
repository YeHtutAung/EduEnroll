import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import { tenantOrigin } from "@/lib/origin";
import { hashIp } from "@/lib/interest/ipHash";
import { registerInterest } from "@/server/interest/registerInterest";
import type { Intake } from "@/types/database";

// ─── POST /api/public/interest ───────────────────────────────────────────────
//
// Public — registers interest in an event before its tickets go on sale, and
// returns (first signup only) the raw priority-access token.
//
// This route is a thin caller. Every ordering guarantee — persist before send,
// rotation serialized under the row lock, rollback on a failed send — lives in
// @/server/interest/registerInterest. What lives HERE is the set of checks that
// module's docblock explicitly delegates to its caller, because none of them is
// enforced by the schema on every branch:
//
//   1. the intake belongs to the resolved tenant,
//   2. priority_open_at is set and still in the future,
//   3. the intake is not closed,
//   4. at least one tier still has a future enrollment_open_at,
//   5. name / email / phone are within the columns' CHECK bounds.
//
// SECURITY — the first-signup response body carries a live credential. Nothing
// on this route may log the request or response body, and the raw token must
// not appear in any log line. Every response is returned with
// `Cache-Control: no-store`.
//
// See docs/superpowers/specs/2026-08-26-event-interest-priority-window-design.md
// (v11) section "Signup and resend".

// Availability changes with the clock, so this must never be prerendered or
// cached at the framework layer either.
export const dynamic = "force-dynamic";

// Mirror the column CHECKs on event_interest
// (20260827120000_event_interest_priority_window.sql). Measured against the
// same normalisation the database applies, so a value that would pass there
// is never rejected here and vice versa. The point is that an over-long field
// gets a 400 rather than surfacing as an opaque write failure.
const NAME_MAX = 120;
const EMAIL_MIN = 3;
const EMAIL_MAX = 254;
const PHONE_MAX = 32;

/**
 * Display timezone for `windowOpensAt`. Same convention and default as ticket
 * expiry and the events feed — the recipient is in the event's timezone, not
 * the server's, and the server's is UTC on Vercel.
 */
const DISPLAY_TZ = process.env.TICKET_TZ ?? "Asia/Yangon";

/** Every response on this route, so a token can never be cached in transit. */
function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

type IntakeRow = Pick<Intake, "id" | "name" | "slug" | "status" | "priority_open_at">;

export async function POST(request: NextRequest) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Bad Request", message: "Request body must be valid JSON." }, 400);
  }

  const { intake_id, name, email, phone, __hp } = body as Record<string, unknown>;

  // Honeypot — a filled hidden field means a bot. Fake success, nothing
  // written, no mail, and deliberately the same shape a repeat signup returns
  // so the bot cannot tell it was caught. Same convention as
  // src/app/api/public/enroll/route.ts.
  if (typeof __hp === "string" && __hp.trim().length > 0) {
    return json({ ok: true, emailed: true }, 200);
  }

  // ── Input shape and bounds ────────────────────────────────────────────────
  if (typeof intake_id !== "string" || intake_id.trim().length === 0) {
    return json({ error: "Bad Request", message: "intake_id is required." }, 400);
  }
  if (typeof name !== "string" || typeof email !== "string") {
    return json({ error: "Bad Request", message: "name and email are required." }, 400);
  }
  if (phone !== undefined && phone !== null && typeof phone !== "string") {
    return json({ error: "Bad Request", message: "phone must be a string." }, 400);
  }

  // registerInterest owns normalisation; these only MEASURE the normalised
  // form so the bound matches what the CHECK will see.
  const nameLen = name.trim().length;
  if (nameLen < 1 || nameLen > NAME_MAX) {
    return json(
      { error: "Bad Request", message: `name must be between 1 and ${NAME_MAX} characters.` },
      400,
    );
  }

  const emailLen = email.trim().length;
  if (emailLen < EMAIL_MIN || emailLen > EMAIL_MAX) {
    return json(
      { error: "Bad Request", message: `email must be between ${EMAIL_MIN} and ${EMAIL_MAX} characters.` },
      400,
    );
  }

  const phoneLen = typeof phone === "string" ? phone.trim().length : 0;
  if (phoneLen > PHONE_MAX) {
    return json(
      { error: "Bad Request", message: `phone must be at most ${PHONE_MAX} characters.` },
      400,
    );
  }

  const supabase = createAdminClient();

  // ── Eligibility ───────────────────────────────────────────────────────────
  // Tenant-scoped, and this is THE cross-tenant guard: the composite FK on
  // event_interest only guarantees a row is internally consistent, so a
  // foreign intake_id would be stored consistently with the WRONG tenant.
  //
  // maybeSingle(), not single(): single() errors on zero rows, which would make
  // "no such intake" and "the query failed" indistinguishable and report a
  // database incident as 404.
  const { data: intakeRow, error: intakeError } = (await supabase
    .from("intakes")
    .select("id, name, slug, status, priority_open_at")
    .eq("id", intake_id)
    .eq("tenant_id", tenantId)
    .maybeSingle()) as { data: IntakeRow | null; error: unknown };

  if (intakeError) {
    console.error("[interest] intake lookup failed");
    return json({ error: "Internal Server Error" }, 500);
  }
  if (!intakeRow) {
    return json({ error: "Not Found", message: "Intake not found.", code: "NOT_FOUND" }, 404);
  }

  // An allowlist rather than `status === "closed"`. Today intake_status is
  // ('draft','open','closed') and the two are equivalent; if a 'cancelled'
  // value is ever added, the allowlist fails closed and a denylist would not.
  if (intakeRow.status !== "open" && intakeRow.status !== "draft") {
    return json(
      { error: "Gone", message: "This event is no longer accepting interest.", code: "INTAKE_UNAVAILABLE" },
      410,
    );
  }

  if (!intakeRow.priority_open_at) {
    return json(
      {
        error: "Conflict",
        message: "This event has no priority window.",
        code: "PRIORITY_WINDOW_UNSET",
      },
      409,
    );
  }

  const now = Date.now();
  const priorityOpenMs = Date.parse(intakeRow.priority_open_at);

  // Signup closes the moment the window opens. Otherwise anyone could mint
  // themselves a token at that instant and the head start would be available
  // to the general public — which is the whole feature.
  if (!Number.isFinite(priorityOpenMs) || priorityOpenMs <= now) {
    return json(
      {
        error: "Conflict",
        message: "The priority window for this event has already opened.",
        code: "PRIORITY_WINDOW_OPEN",
      },
      409,
    );
  }

  // Tiers the head start actually covers — those with a future
  // enrollment_open_at. Restricted to publicly visible statuses so this matches
  // GET /api/public/enroll/[slug] exactly: the email must list the same tiers
  // the page showed when the visitor signed up.
  const { data: classRows, error: classError } = (await supabase
    .from("classes")
    .select("level, enrollment_open_at")
    .eq("intake_id", intakeRow.id)
    .eq("tenant_id", tenantId)
    .in("status", ["open", "full"])
    .order("level")) as {
    data: { level: string; enrollment_open_at: string | null }[] | null;
    error: unknown;
  };

  if (classError) {
    console.error("[interest] class lookup failed");
    return json({ error: "Internal Server Error" }, 500);
  }

  const coveredTiers = (classRows ?? [])
    .filter((c) => c.enrollment_open_at !== null && Date.parse(c.enrollment_open_at) > now)
    .map((c) => c.level);

  // Every tier is already on public sale, so there is nothing to be early for.
  if (coveredTiers.length === 0) {
    return json(
      {
        error: "Conflict",
        message: "Every ticket tier for this event is already on sale.",
        code: "NO_GATED_TIERS",
      },
      409,
    );
  }

  // ── Rate-limit identity ───────────────────────────────────────────────────
  // Pseudonymised, and a cost/reputation control only — a forwarded header is
  // attacker-influenced and this is not an authorization boundary.
  //
  // An unset INTEREST_IP_SECRET is a 500 at request time, NOT a module-level
  // throw. In Next.js a route module has no "startup": it is evaluated lazily
  // in the process that serves the first request, and `next build` also imports
  // route modules to collect metadata — so throwing at module scope turns a
  // missing variable into a BUILD failure on every environment that lacks it
  // (CI, previews) instead of an operational signal from the one that does.
  // The house convention is the same: createAdminClient() reads its env lazily.
  // Failing here is fail-closed — no row, no mail, no token — and hashIp's own
  // throw stays as the backstop for any other caller.
  const ipSecret = process.env.INTEREST_IP_SECRET;
  if (!ipSecret) {
    console.error("[interest] INTEREST_IP_SECRET is not set; refusing to accept signups");
    return json({ error: "Internal Server Error" }, 500);
  }

  const clientAddress = request.ip ?? request.headers.get("x-forwarded-for")?.split(",")[0];
  const ipHash = hashIp(clientAddress, ipSecret);

  // ── Presentation the orchestrator must not compute ────────────────────────
  const { data: tenantRow } = (await supabase
    .from("tenants")
    .select("name, subdomain, logo_url")
    .eq("id", tenantId)
    .maybeSingle()) as {
    data: { name: string; subdomain: string | null; logo_url: string | null } | null;
    error: unknown;
  };

  // Built from the tenant's own subdomain plus the configured app host, never
  // the inbound Host header — see @/lib/origin. The token is appended by
  // registerInterest as `#pa=<token>`; a fragment never reaches the server, so
  // it stays out of request logs and Referer headers.
  const linkBase = `${tenantOrigin(tenantRow?.subdomain)}/enroll/${intakeRow.slug}`;

  const result = await registerInterest({
    intakeId: intakeRow.id,
    tenantId,
    name,
    email,
    phone: typeof phone === "string" ? phone : null,
    ipHash,
    linkBase,
    eventName: intakeRow.name,
    windowOpensAt: formatWindowOpensAt(intakeRow.priority_open_at),
    coveredTiers,
    tenantName: tenantRow?.name ?? undefined,
    logoUrl: tenantRow?.logo_url ?? undefined,
  });

  if (!result.ok) {
    // The limiter being unreachable is transient and retryable; the rest are
    // faults. Neither is ever reported as a success — a signup that did not
    // happen must not look like one.
    const status = result.reason === "RATE_LIMITER_UNAVAILABLE" ? 503 : 500;
    return json({ error: "Internal Server Error", code: result.reason }, status);
  }

  // `token` is present ONLY on a first signup, where the submitter has just
  // demonstrated they are the person enrolling. registerInterest omits it on
  // every repeat and on a throttled call, and this spread must not add one
  // back: echoing it would let anyone harvest another person's link by typing
  // their address into the public form. A throttled call is likewise
  // indistinguishable from a permitted one — no extra field is added here.
  return json({ ok: true, emailed: result.emailed, ...(result.token ? { token: result.token } : {}) }, 200);
}

// ─── Private helpers ─────────────────────────────────────────────────────────

/**
 * Formats the window opening for display in the email. Kept here, not in
 * registerInterest, which takes an already-formatted string and does no
 * formatting of its own.
 *
 * Explicit components rather than dateStyle/timeStyle: Intl rejects combining
 * those with timeZoneName, and the zone has to be shown or the reader is left
 * guessing which clock the time is on.
 */
function formatWindowOpensAt(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_TZ,
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}
