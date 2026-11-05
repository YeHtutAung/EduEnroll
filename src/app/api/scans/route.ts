import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveScannerTenant } from "@/lib/scanner/apiKey";
import { verifyTicketJwt } from "@/lib/tickets/sign";
import { lastEventDate, todayInTz } from "@/lib/tickets/exp";

// ─── POST /api/scans ────────────────────────────────────────────────────────
// Called by the kuunyi-scanner app when a ticket QR is scanned.
// Enforces entry via a race-safe conditional update: only the scan that wins
// the UPDATE gets a 200; any concurrent/subsequent scan gets a 409 with the
// details of the winning scan.
//
// A ticket for a one-day event admits once. A ticket whose event ends on a later
// date admits once per calendar day in TICKET_TZ, so the day changes at midnight
// there. first_scan_* keeps its first entry; last_scan_* holds the latest.
//
// Body: { token: string, gate?: string, jti?: string, eid?: string }
//
// `token` is the compact JWT encoded in the QR and is REQUIRED: its signature
// is the admission credential. Identifying a ticket by `jti` alone — as this
// route used to — meant anyone who obtained or guessed a ticket id could burn
// an admission by calling this endpoint directly, since the client's offline
// check was the only signature verification anywhere in the system.
//
// `jti`/`eid` are optional and advisory. The verified claims are the source of
// truth; a body that contradicts them is a client bug and is rejected loudly
// rather than silently ignored.

interface TicketRow {
  id: string;
  intake_id: string;
  status: string;
  exp: string;
  first_scan_at: string | null;
  first_scan_gate: string | null;
  classes: { event_date: string | null; end_time: string | null } | null;
}

interface ScanBody {
  token?: string;
  jti?: string;
  eid?: string;
  gate?: string;
}

// Every rejection that means "this is not an admission" returns exactly this,
// so a caller cannot tell a forged signature from an unknown, voided, expired
// or wrong-event ticket. Operators see one "NOT VALID" state either way.
const notFound = () =>
  NextResponse.json({ error: "Not Found", message: "Ticket not found." }, { status: 404 });

// A database fault is never "invalid" or "already used": both tell the operator
// to turn the attendee away. The app shows a 500 as a server problem instead.
function scanUnavailable(step: string, error: unknown) {
  console.error(`[scans] ${step} failed`, error);
  return NextResponse.json(
    { error: "Internal Server Error", message: "Scan could not be processed." },
    { status: 500 },
  );
}

// PostgREST's "no rows" from .single(), and Postgres's bad uuid: both mean the
// ticket doesn't exist. Any other error means we don't know.
const TICKET_ABSENT_CODES = new Set(["PGRST116", "22P02"]);

export async function POST(request: NextRequest) {
  // ── 1. Parse body ──────────────────────────────────────────────────────────
  let body: ScanBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Bad Request", message: "Invalid JSON body." },
      { status: 400 },
    );
  }

  // ── 2. Auth ─────────────────────────────────────────────────────────────────
  const tenantId = await resolveScannerTenant(request);
  if (!tenantId) {
    return NextResponse.json(
      { error: "Unauthorized", message: "Invalid or missing API key." },
      { status: 401 },
    );
  }

  // ── 3. Validate body ────────────────────────────────────────────────────────
  const { token, gate } = body;
  if (!token || typeof token !== "string") {
    return NextResponse.json(
      { error: "Bad Request", message: "token is required." },
      { status: 400 },
    );
  }

  // ── 4. Verify the token's signature ─────────────────────────────────────────
  // Checked before the configuration is trusted and before any query runs, so
  // a forged token cannot probe for ticket existence.
  //
  // A missing signing key is a 500, never a 404: reporting "not a valid ticket"
  // for a server that cannot verify anything would turn one misconfiguration
  // into every attendee being turned away at the gate, with nothing in the
  // response to say why.
  if (!process.env.TICKET_SIGNING_KEY || !process.env.TICKET_KID) {
    console.error("[scans] TICKET_SIGNING_KEY / TICKET_KID not configured — cannot verify tickets");
    return NextResponse.json(
      { error: "Internal Server Error", message: "Ticket verification is unavailable." },
      { status: 500 },
    );
  }

  let claims: ReturnType<typeof verifyTicketJwt>;
  try {
    claims = verifyTicketJwt(token);
  } catch {
    // Bad signature, wrong key, or not a ticket token at all (an operator
    // scanning some other QR). Indistinguishable to the caller by design.
    return notFound();
  }

  const jti = claims.jti;
  const eid = claims.eid;
  if (!jti || typeof jti !== "string" || !eid || typeof eid !== "string") {
    return notFound();
  }

  // A body that disagrees with the signed claims is a client bug worth
  // surfacing, not something to resolve silently in either direction.
  if (
    (body.jti !== undefined && body.jti !== jti) ||
    (body.eid !== undefined && body.eid !== eid)
  ) {
    return NextResponse.json(
      { error: "Bad Request", message: "Body does not match the token's claims." },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  // ── 5. Load and validate ticket ─────────────────────────────────────────────
  const { data: ticket, error: loadError } = (await supabase
    .from("tickets")
    .select("id, intake_id, status, exp, first_scan_at, first_scan_gate, classes(event_date, end_time)")
    .eq("id", jti)
    .eq("tenant_id", tenantId)
    .single()) as unknown as { data: TicketRow | null; error: { code?: string } | null };

  if (loadError && !TICKET_ABSENT_CODES.has(loadError.code ?? "")) {
    return scanUnavailable("ticket load", loadError);
  }

  if (
    !ticket ||
    ticket.intake_id !== eid ||
    ticket.status !== "valid" ||
    Date.parse(ticket.exp) < Date.now()
  ) {
    return notFound();
  }

  const now = new Date().toISOString();
  const startDate = ticket.classes?.event_date ?? null;
  const isMultiDay = lastEventDate(startDate, ticket.classes?.end_time) !== startDate;

  // ── 6. Race-safe claim ──────────────────────────────────────────────────────
  // Re-check status='valid' inside the conditional update so a ticket voided
  // between step 5 and here cannot still be claimed (validity + claim happen in
  // one atomic statement).
  if (isMultiDay) {
    const today = todayInTz(process.env.TICKET_TZ ?? "Asia/Yangon");
    const { data: claimedToday, error: claimError } = (await supabase
      .from("tickets")
      .update({
        // Only the scan that finds no first entry sets it. Two scans racing on
        // that are on the same day, so the filter below still lets one through.
        ...(ticket.first_scan_at ? {} : { first_scan_at: now, first_scan_gate: gate }),
        last_scan_date: today,
        last_scan_at: now,
        last_scan_gate: gate,
      } as never)
      .eq("id", jti)
      .eq("status", "valid")
      .or(`last_scan_date.is.null,last_scan_date.lt.${today}`)
      .select("id")) as unknown as { data: { id: string }[] | null; error: unknown };

    if (claimError) return scanUnavailable("daily claim", claimError);
    if (claimedToday && claimedToday.length > 0) {
      return NextResponse.json({ ok: true });
    }

    // Already in today: report today's scan, not the one from an earlier day.
    const { data: existingToday } = (await supabase
      .from("tickets")
      .select("last_scan_at, last_scan_gate")
      .eq("id", jti)
      .single()) as unknown as {
      data: { last_scan_at: string | null; last_scan_gate: string | null } | null;
    };

    return NextResponse.json(
      {
        firstScanTime: existingToday?.last_scan_at ?? null,
        firstScanGate: existingToday?.last_scan_gate ?? null,
      },
      { status: 409 },
    );
  }

  const { data: claimed, error: claimError } = (await supabase
    .from("tickets")
    .update({ first_scan_at: now, first_scan_gate: gate } as never)
    .eq("id", jti)
    .eq("status", "valid")
    .is("first_scan_at", null)
    .select("first_scan_at, first_scan_gate")) as unknown as {
    data: { first_scan_at: string; first_scan_gate: string | null }[] | null;
    error: unknown;
  };

  if (claimError) return scanUnavailable("claim", claimError);
  if (claimed && claimed.length > 0) {
    return NextResponse.json({ ok: true });
  }

  // Someone else already claimed the first scan — re-read and report it.
  const { data: existing } = (await supabase
    .from("tickets")
    .select("first_scan_at, first_scan_gate")
    .eq("id", jti)
    .single()) as unknown as {
    data: { first_scan_at: string | null; first_scan_gate: string | null } | null;
  };

  return NextResponse.json(
    {
      firstScanTime: existing?.first_scan_at ?? null,
      firstScanGate: existing?.first_scan_gate ?? null,
    },
    { status: 409 },
  );
}
