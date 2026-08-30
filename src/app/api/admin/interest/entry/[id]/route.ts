import { NextRequest, NextResponse } from "next/server";
import { requireOwner, badRequest, notFound } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadInterestEmailContext, rotateAndSend } from "@/lib/interest/adminInterest";

// ─── PATCH /api/admin/interest/entry/[id] ────────────────────────────────────
//
// Per-row actions on one interest record: `{ action: "revoke" }` and
// `{ action: "resend" }`.
//
// TENANT SCOPE. The record is read scoped to the caller's tenant before
// anything is written, and every write repeats the tenant predicate. The row id
// is the only thing the caller supplies, event_interest has RLS enabled with no
// policies, and this route reaches it through the service-role client — so an
// id belonging to another tenant is stopped here or nowhere.
//
// RESEND BYPASSES THE PUBLIC COOLDOWN. The 15-minute gap exists to stop a
// stranger walking someone else's record forward from the public form; an
// organiser acting deliberately on their own list is not that case, and being
// throttled against your own attendees is the wrong answer when a link did not
// arrive. The cost of the bypass is that nothing stops an admin rotating a
// record whose previous link is still inside its grace window — so this route
// returns the record's `superseded_expires_at` after the action, alongside the
// same field the list route already exposes, which is what the UI's warning is
// built from.
//
// See docs/superpowers/specs/2026-08-26-event-interest-priority-window-design.md
// (v11), section "Admin".

export const dynamic = "force-dynamic";

/** Never token_hash, never superseded_token_hash. Same allowlist as the list route. */
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

type AdminClient = ReturnType<typeof createAdminClient>;

interface EntryRow {
  id: string;
  intake_id: string;
  name: string;
  email: string;
  token_prefix: string;
  revoked_at: string | null;
  superseded_expires_at: string | null;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const { action } = body as Record<string, unknown>;
  if (action !== "revoke" && action !== "resend") {
    return badRequest('action must be either "revoke" or "resend".');
  }

  const supabase = createAdminClient();

  // The ownership check. Before any write, on both branches.
  //
  // maybeSingle(), not single(): single() errors on zero rows, so "not yours"
  // and "the query failed" would be indistinguishable and a database incident
  // would report 404.
  const { data: entry, error: entryError } = (await supabase
    .from("event_interest")
    .select("id, intake_id, name, email, token_prefix, revoked_at, superseded_expires_at")
    .eq("id", params.id)
    .eq("tenant_id", tenantId)
    .maybeSingle()) as { data: EntryRow | null; error: { message: string } | null };

  if (entryError) {
    console.error("[admin/interest] entry lookup failed:", entryError.message);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
  if (!entry) return notFound("Interest record");

  if (action === "revoke") return revoke(supabase, tenantId, entry);
  return resend(supabase, tenantId, entry);
}

// ─── Revoke ───────────────────────────────────────────────────────────────────

async function revoke(
  supabase: AdminClient,
  tenantId: string,
  entry: EntryRow,
): Promise<NextResponse> {
  // Idempotent. A double-clicked revoke must not move the timestamp — the
  // moment access was withdrawn is the interesting fact, not the moment the
  // button was pressed a second time.
  if (entry.revoked_at) return respondWithEntry(supabase, tenantId, entry.id);

  const { error } = await supabase
    .from("event_interest")
    .update({ revoked_at: new Date().toISOString() } as never)
    .eq("id", entry.id)
    .eq("tenant_id", tenantId);

  if (error) {
    console.error("[admin/interest] revoke failed:", error.message);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }

  return respondWithEntry(supabase, tenantId, entry.id);
}

// ─── Resend ───────────────────────────────────────────────────────────────────

async function resend(
  supabase: AdminClient,
  tenantId: string,
  entry: EntryRow,
): Promise<NextResponse> {
  // A revoked record does not rotate. Rotating one would spend an email on a
  // link the gate refuses, and hand the recipient something that silently does
  // not work. Same rule the public resend path applies.
  if (entry.revoked_at) {
    return NextResponse.json(
      {
        error: "Conflict",
        message: "This record is revoked. Restore it before resending.",
        code: "REVOKED",
      },
      { status: 409 },
    );
  }

  const ctx = await loadInterestEmailContext(supabase, tenantId, entry.intake_id);
  if (ctx === "ERROR") return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  if (ctx === "NOT_FOUND") return notFound("Intake");

  const result = await rotateAndSend(supabase, entry, ctx, "resend");

  if (result.outcome === "SEND_FAILED") {
    // The rotation has been rolled back, so the recipient's existing link is
    // untouched. Reported as a failure, never as a success: a resend that did
    // not reach an inbox must not look like one.
    return NextResponse.json(
      {
        error: "Bad Gateway",
        message: "The email could not be sent. Nothing was changed — try again.",
        code: "SEND_FAILED",
      },
      { status: 502 },
    );
  }

  if (result.outcome === "NOT_FOUND") return notFound("Interest record");

  if (result.outcome !== "SENT") {
    console.error("[admin/interest] resend failed:", result.outcome);
    return NextResponse.json(
      { error: "Internal Server Error", code: result.outcome },
      { status: 500 },
    );
  }

  await stampSent(supabase, tenantId, entry.id);

  return respondWithEntry(supabase, tenantId, entry.id, { sent: true });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function stampSent(
  supabase: AdminClient,
  tenantId: string,
  id: string,
): Promise<void> {
  const { error } = await supabase
    .from("event_interest")
    .update({ last_link_sent_at: new Date().toISOString() } as never)
    .eq("id", id)
    .eq("tenant_id", tenantId);

  // Bookkeeping only: the link is already delivered and already valid, so a
  // failure here must not turn a successful send into a reported failure.
  if (error) console.error("[admin/interest] stamping the send failed:", error.message);
}

/**
 * Re-reads the row through the same allowlist the list route uses and returns
 * it, so the caller's copy — including `superseded_expires_at`, which is what
 * the "the previous link is still live" warning is built from — is current
 * after the action rather than one action stale.
 */
async function respondWithEntry(
  supabase: AdminClient,
  tenantId: string,
  id: string,
  extra: Record<string, unknown> = {},
): Promise<NextResponse> {
  const { data } = (await supabase
    .from("event_interest")
    .select(SAFE_COLUMNS)
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()) as { data: Record<string, unknown> | null; error: unknown };

  return NextResponse.json(
    { ok: true, ...extra, entry: data ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
