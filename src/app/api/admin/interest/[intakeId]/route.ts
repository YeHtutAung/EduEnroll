import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadInterestEmailContext } from "@/lib/interest/adminInterest";

// ─── GET /api/admin/interest/[intakeId] ──────────────────────────────────────
//
// The organiser's view of who signed up for an event's priority window, as
// JSON or as a CSV export (`?format=csv`).
//
// Two controls govern this route.
//
// 1. TENANT SCOPE. The intake is looked up scoped to the caller's tenant
//    BEFORE the interest rows are read, and the interest query is itself
//    scoped by tenant_id as well as intake_id. event_interest has RLS enabled
//    with no policies and is reached through the service-role client, so
//    nothing below the application enforces this — the query is the boundary.
//
// 2. NO CREDENTIAL LEAVES THIS ROUTE. The select list is explicit and
//    enumerated in SAFE_COLUMNS; `token_hash` and `superseded_token_hash` are
//    absent from it, so neither can appear in the JSON. The CSV builds its
//    cells from a fixed column list, which is the second, independent guard —
//    an export is opened in spreadsheets, mailed around, and dropped in shared
//    drives, so a hash reaching it is a credential-adjacent leak that no
//    subsequent rotation can recall. `token_prefix` is fine: it is eight
//    characters of the raw token kept deliberately in the clear so an admin can
//    match a row against the link a recipient quotes at them.
//
// See docs/superpowers/specs/2026-08-26-event-interest-priority-window-design.md
// (v11), section "Admin".

// The listing is time-sensitive (first used, converted) and carries personal
// data. Never prerendered, never cached at the framework layer.
export const dynamic = "force-dynamic";

/**
 * Every column this route is allowed to read. Deliberately an allowlist rather
 * than `*`: a future column holding another secret would otherwise be exported
 * the moment it is added, with nothing in this file changing to say so.
 *
 * `superseded_expires_at` is here because the admin resend bypasses the public
 * cooldown — nothing stops an admin rotating a record whose previous link is
 * still inside its grace window, so the UI has to warn, and this is the value
 * the warning is built from. It is a timestamp, not a credential.
 */
const SAFE_COLUMNS = [
  "id",
  "name",
  "email",
  "phone",
  "token_prefix",
  "created_at",
  "last_link_attempt_at",
  "last_link_sent_at",
  "invited_at",
  "first_used_at",
  "first_converted_enrollment_id",
  "revoked_at",
  "superseded_expires_at",
].join(", ");

interface InterestListRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  token_prefix: string;
  created_at: string;
  last_link_attempt_at: string | null;
  last_link_sent_at: string | null;
  invited_at: string | null;
  first_used_at: string | null;
  first_converted_enrollment_id: string | null;
  revoked_at: string | null;
  superseded_expires_at: string | null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: { intakeId: string } },
) {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;

  const supabase = createAdminClient();

  // The ownership check, and it runs before a single interest row is read.
  const ctx = await loadInterestEmailContext(supabase, tenantId, params.intakeId);
  if (ctx === "ERROR") return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  if (ctx === "NOT_FOUND") {
    return NextResponse.json(
      { error: "Not Found", message: "Intake not found." },
      { status: 404 },
    );
  }

  const { data, error } = (await supabase
    .from("event_interest")
    .select(SAFE_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("intake_id", params.intakeId)
    .order("created_at", { ascending: true })) as {
    data: InterestListRow[] | null;
    error: { message: string } | null;
  };

  if (error) {
    console.error("[admin/interest] list failed:", error.message);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }

  const rows = data ?? [];

  // new URL(request.url) rather than request.nextUrl: the standard property is
  // present on a plain Request too, so the route is exercisable without
  // constructing a NextRequest. Same value either way.
  if (new URL(request.url).searchParams.get("format") === "csv") {
    return csvResponse(rows, ctx.intake.slug);
  }

  return NextResponse.json(
    {
      intake: {
        id: ctx.intake.id,
        name: ctx.intake.name,
        slug: ctx.intake.slug,
        priority_open_at: ctx.intake.priority_open_at,
      },
      count: rows.length,
      entries: rows,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

/**
 * The exported columns, fixed. Each cell is produced by an explicit accessor,
 * so adding a column to the table cannot add one to the export by accident —
 * which is the property that keeps a token hash out of a spreadsheet.
 */
const CSV_COLUMNS: { header: string; value: (r: InterestListRow) => string }[] = [
  { header: "Name", value: (r) => r.name },
  { header: "Email", value: (r) => r.email },
  { header: "Phone", value: (r) => r.phone ?? "" },
  { header: "Link prefix", value: (r) => r.token_prefix },
  { header: "Signed up", value: (r) => r.created_at },
  { header: "Last link sent", value: (r) => r.last_link_sent_at ?? "" },
  { header: "Invited", value: (r) => r.invited_at ?? "" },
  { header: "First used", value: (r) => r.first_used_at ?? "" },
  { header: "Converted enrollment", value: (r) => r.first_converted_enrollment_id ?? "" },
  { header: "Revoked", value: (r) => r.revoked_at ?? "" },
];

function csvResponse(rows: InterestListRow[], slug: string): NextResponse {
  const lines = [
    CSV_COLUMNS.map((c) => csvCell(c.header)).join(","),
    ...rows.map((r) => CSV_COLUMNS.map((c) => csvCell(c.value(r))).join(",")),
  ];

  // Leading BOM: Excel reads a BOM-less UTF-8 CSV as the system codepage, which
  // mangles every Myanmar name in the list.
  const body = `\ufeff${lines.join("\r\n")}\r\n`;

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="interest-${safeFilename(slug)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Quotes a cell, and neutralises spreadsheet formula injection.
 *
 * Name and email are attacker-supplied through a public form. A cell beginning
 * `=`, `+`, `-`, `@`, or a control character is executed as a formula by Excel
 * and Sheets on open — the classic path from "someone typed a name" to "the
 * organiser's machine ran something". Prefixing with an apostrophe forces the
 * cell to text; the leading quote is what makes the RFC 4180 quoting below
 * unambiguous either way.
 */
function csvCell(value: string): string {
  const dangerous = /^[=+\-@\t\r]/.test(value);
  const escaped = (dangerous ? `'${value}` : value).replace(/"/g, '""');
  return `"${escaped}"`;
}

/** Keeps a tenant-authored slug out of the Content-Disposition header grammar. */
function safeFilename(slug: string): string {
  const cleaned = slug.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
  return cleaned.length > 0 ? cleaned : "export";
}
