import { NextRequest, NextResponse } from "next/server";
import { requireOwner, notFound } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadInterestEmailContext, rotateAndSend } from "@/lib/interest/adminInterest";

// ─── POST /api/admin/interest/[intakeId]/invite ──────────────────────────────
//
// Sends the priority-window reminder to everyone on an event's interest list
// who has not been invited yet.
//
// ── Why this loops instead of doing one bulk update ─────────────────────────
//
// COMMIT PER ROW. NEVER ONE TRANSACTION OVER THE INTAKE. This is a hard
// constraint and it comes from what the enrollment RPCs do: since
// 20260827120100, redeeming a priority token takes a FOR UPDATE row lock on
// that person's event_interest row and holds it to commit. A bulk rotation
// that touched every interest row for an intake in one transaction would
// therefore sit directly in front of EVERY CHECKOUT for that event.
//
// Buyers would not deadlock — they would queue. And if the admin transaction
// outlived the authenticator's statement_timeout, those queued buyers would get
// INTERNAL_ERROR at checkout. An organiser presses "send invitations" exactly
// when the window is opening, which is exactly the traffic burst, so the
// failure would land at the worst possible moment and look like the sale is
// broken.
//
// Each row below is therefore a separate RPC and a separate UPDATE, each its
// own transaction. That also buys resumability: a row whose send succeeded is
// durably stamped and never re-sent, whatever happens to the rest of the run.
//
// ── Why it rotates ──────────────────────────────────────────────────────────
//
// Only hashes are stored, so the link a recipient already holds cannot be
// reconstructed and cannot be put in an email. Rather than send a linkless
// reminder, each row mints a fresh token through the ordinary grace mechanism,
// so one click from the reminder gets the recipient in and their previous link
// keeps working through its grace period. This is what makes the invariant hold
// everywhere: a link is only ever created at the moment it is emailed.
//
// The per-row ordering — rotate under the row lock, commit, then send, and roll
// the rotation back if the send fails — lives in rotateAndSend().
//
// See docs/superpowers/specs/2026-08-26-event-interest-priority-window-design.md
// (v11), section "Invitations", and Task 12 of the implementation plan.

export const dynamic = "force-dynamic";

/**
 * Rows attempted per invocation. The caller drains a large list by calling
 * again while `remaining > 0` — a bound on the function's wall time is the
 * point, since each row costs a network round trip to Resend and Vercel kills
 * the invocation, mid-send, when it overruns.
 */
const CHUNK_SIZE = 25;

/**
 * Consecutive send failures that abort the rest of the chunk.
 *
 * A mail outage makes every send fail, and each failure costs a rotation plus a
 * rollback on a live credential. Rolling back is safe but not free: a rollback
 * that loses its compare-and-swap leaves that row rotated with nothing
 * delivered. Three in a row is the provider being down, not three unlucky
 * addresses, and there is no reason to churn the other twenty-two rows to
 * confirm it. Reset by any success, so one bad address does not stop the run.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

interface CandidateRow {
  id: string;
  name: string;
  email: string;
  token_prefix: string;
  revoked_at: string | null;
}

export async function POST(
  _request: NextRequest,
  { params }: { params: { intakeId: string } },
) {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;

  const supabase = createAdminClient();

  // The ownership check, and it runs before a single row is read or rotated.
  const ctx = await loadInterestEmailContext(supabase, tenantId, params.intakeId);
  if (ctx === "ERROR") return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  if (ctx === "NOT_FOUND") return notFound("Intake");

  // A reminder about a window that was never scheduled would carry a link the
  // gate refuses for ever and a date that does not exist. Refused up front.
  if (!ctx.intake.priority_open_at) {
    return NextResponse.json(
      {
        error: "Conflict",
        message: "Schedule the priority window before sending invitations.",
        code: "PRIORITY_WINDOW_UNSET",
      },
      { status: 409 },
    );
  }

  // Not yet invited, not revoked. `invited_at IS NULL` is what makes a re-run
  // pick up only the remainder: it is stamped per row as each send succeeds, so
  // a partial run never re-mails anyone who already received their reminder.
  //
  // Oldest first, so repeated calls drain the list in a stable order rather
  // than revisiting the same rows.
  const { data, error } = (await supabase
    .from("event_interest")
    .select("id, name, email, token_prefix, revoked_at")
    .eq("tenant_id", tenantId)
    .eq("intake_id", params.intakeId)
    .is("revoked_at", null)
    .is("invited_at", null)
    .order("created_at", { ascending: true })
    .limit(CHUNK_SIZE)) as {
    data: CandidateRow[] | null;
    error: { message: string } | null;
  };

  if (error) {
    console.error("[admin/interest] invite candidate lookup failed:", error.message);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }

  const candidates = data ?? [];

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let consecutiveFailures = 0;
  let stoppedEarly = false;

  for (const row of candidates) {
    // Belt and braces. The query already excludes revoked rows; this repeats
    // the rule against the row actually in hand, so a revoked record can never
    // be rotated and mailed a link the gate will refuse — not if the filter is
    // edited, and not if the row was revoked between the read and here.
    if (row.revoked_at) {
      skipped += 1;
      continue;
    }

    // Awaited, deliberately and one at a time. Fire-and-forget is killed on
    // Vercel serverless the moment the response is returned, and the sends are
    // not parallelised because each one is followed by a write to the row it
    // just rotated.
    const result = await rotateAndSend(supabase, row, ctx, "reminder");

    if (result.outcome !== "SENT") {
      // Nothing durable was left behind: a failed send has already been rolled
      // back inside rotateAndSend, and every other outcome wrote nothing. The
      // row keeps invited_at NULL and is picked up by the next call.
      failed += 1;
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error("[admin/interest] invite aborted: consecutive send failures");
        stoppedEarly = true;
        break;
      }
      continue;
    }

    consecutiveFailures = 0;

    // STAMPED ONLY AFTER THE SEND SUCCEEDED, and only for this row. Stamping
    // the chunk up front would silently swallow every address the provider
    // rejected; stamping nothing until the end would re-mail everyone who
    // already got their reminder when the invocation times out halfway.
    const { error: stampError } = await supabase
      .from("event_interest")
      .update({
        invited_at: new Date().toISOString(),
        last_link_sent_at: new Date().toISOString(),
      } as never)
      .eq("id", row.id)
      .eq("tenant_id", tenantId);

    if (stampError) {
      // The mail is already delivered and the new link already works, so this
      // is not a failed send — but the row will be picked up again on the next
      // call and mailed a second time. Loud, because a duplicate reminder is
      // the visible symptom and this line is the explanation.
      console.error("[admin/interest] stamping invited_at failed:", stampError.message);
    }

    sent += 1;
  }

  return NextResponse.json(
    {
      ok: true,
      sent,
      failed,
      skipped,
      stopped_early: stoppedEarly,
      remaining: await countRemaining(supabase, tenantId, params.intakeId, candidates.length - sent),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * How many rows still need an invitation, counted fresh after the run.
 *
 * Rows whose send failed are still counted — they genuinely do still need one.
 * A caller draining the list must therefore loop on `sent > 0`, not on
 * `remaining > 0`, or a mail outage becomes an infinite loop.
 */
async function countRemaining(
  supabase: ReturnType<typeof createAdminClient>,
  tenantId: string,
  intakeId: string,
  fallback: number,
): Promise<number> {
  const { count, error } = (await supabase
    .from("event_interest")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("intake_id", intakeId)
    .is("revoked_at", null)
    .is("invited_at", null)) as { count: number | null; error: { message: string } | null };

  if (error || count === null || count === undefined) {
    // A lower bound rather than a lie: at minimum, the rows in this chunk that
    // were not stamped still need an invitation.
    if (error) console.error("[admin/interest] remaining count failed:", error.message);
    return Math.max(fallback, 0);
  }

  return count;
}
