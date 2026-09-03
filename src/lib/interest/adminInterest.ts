// ─── Admin-side interest helpers ─────────────────────────────────────────────
//
// Shared by the three admin routes under /api/admin/interest. Two things live
// here rather than in the routes:
//
//   1. The presentation context an interest email needs (event name, link base,
//      formatted window opening, covered tiers, tenant branding) — identical
//      work for a single-row resend and for a bulk invitation.
//
//   2. rotateAndSend(), which owns the ORDERING. It is the same discipline
//      @/server/interest/registerInterest enforces for the public paths, and
//      the reason it is centralised here is that the invitation loop runs it
//      once per row: rotate under the row lock, commit, THEN send, and roll the
//      rotation back when the send fails. Duplicating that sequence in two
//      routes would be two chances to get it subtly wrong.
//
// What is deliberately DIFFERENT from the public paths: the cooldown is zero.
// An admin acting deliberately on their own list is not the abuse case the
// public cooldown exists for. That is also why the admin UI needs to warn
// before rotating a record whose previous token is still inside its grace
// window — nothing else will stop it — and why the callers below surface
// `superseded_expires_at`.
//
// See docs/superpowers/specs/2026-08-26-event-interest-priority-window-design.md
// (v11), sections "Admin" and "Invitations".

import { createAdminClient } from "@/lib/supabase/admin";
import { mintPriorityToken } from "@/lib/interest/token";
import { tenantOrigin } from "@/lib/origin";
import {
  interestConfirmationEmail,
  priorityWindowReminderEmail,
  sendEmail,
} from "@/lib/email";
import type { Intake } from "@/types/database";

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * How long the token displaced by a rotation stays usable. Must match the
 * value @/server/interest/registerInterest uses — the grace period is a promise
 * made to recipients, and two code paths promising different things would be a
 * bug nobody sees until someone's link dies early.
 */
export const GRACE_INTERVAL = "24 hours";

/**
 * The admin bypass, expressed as an interval rather than a null.
 * rotate_interest_token refuses a null cooldown outright (it would compare to
 * NULL, never fire, and silently rotate every call — see
 * 20260828120100_rollback_interest_rotation.sql). Zero says the same thing
 * explicitly and keeps the guard live.
 */
export const NO_COOLDOWN = "0 seconds";

/** Display timezone, same convention and default as the public signup route. */
const DISPLAY_TZ = process.env.TICKET_TZ ?? "Asia/Yangon";

export type IntakeRow = Pick<Intake, "id" | "name" | "slug" | "status" | "priority_open_at">;

export interface InterestEmailContext {
  intake: IntakeRow;
  /** Everything before the `#pa=` fragment. */
  linkBase: string;
  /** Already formatted for display. */
  windowOpensAt: string;
  /**
   * Whether the window has already opened. Decided here, from the real
   * timestamp, because the reminder's copy branches on it — an invitation sent
   * after the window opens must not tell the recipient their working link is
   * dead. The email template takes the boolean rather than re-deriving it from
   * `windowOpensAt`, which is a localised display string by then.
   */
  windowIsOpen: boolean;
  coveredTiers: string[];
  tenantName?: string;
  logoUrl?: string;
}

/**
 * Resolves the intake and everything an interest email needs, or reports why
 * it could not.
 *
 * THE TENANT CHECK IS THE POINT. Every admin route calls this before it reads
 * or writes a single interest row: the intake lookup is scoped to the caller's
 * tenant, so an intakeId belonging to someone else finds nothing and the route
 * stops there — before any list, any export, and any rotation.
 *
 * maybeSingle(), not single(): single() errors on zero rows, so "no such
 * intake" and "the query failed" would be indistinguishable and a database
 * incident would report 404.
 */
export async function loadInterestEmailContext(
  supabase: AdminClient,
  tenantId: string,
  intakeId: string,
): Promise<InterestEmailContext | "NOT_FOUND" | "ERROR"> {
  const { data: intake, error: intakeError } = (await supabase
    .from("intakes")
    .select("id, name, slug, status, priority_open_at")
    .eq("id", intakeId)
    .eq("tenant_id", tenantId)
    .maybeSingle()) as { data: IntakeRow | null; error: { message: string } | null };

  if (intakeError) {
    console.error("[admin/interest] intake lookup failed:", intakeError.message);
    return "ERROR";
  }
  if (!intake) return "NOT_FOUND";

  const now = Date.now();

  // The tiers the head start actually covers — those not yet on public sale.
  // Restricted to publicly visible statuses so an admin-sent mail lists exactly
  // what the public page lists.
  const { data: classRows, error: classError } = (await supabase
    .from("classes")
    .select("level, enrollment_open_at")
    .eq("intake_id", intake.id)
    .eq("tenant_id", tenantId)
    .in("status", ["open", "full"])
    .order("level")) as {
    data: { level: string; enrollment_open_at: string | null }[] | null;
    error: { message: string } | null;
  };

  if (classError) {
    console.error("[admin/interest] class lookup failed:", classError.message);
    return "ERROR";
  }

  const coveredTiers = (classRows ?? [])
    .filter((c) => c.enrollment_open_at !== null && Date.parse(c.enrollment_open_at) > now)
    .map((c) => c.level);

  const { data: tenant } = (await supabase
    .from("tenants")
    .select("name, subdomain, logo_url")
    .eq("id", tenantId)
    .maybeSingle()) as {
    data: { name: string; subdomain: string | null; logo_url: string | null } | null;
    error: unknown;
  };

  return {
    intake,
    // Built from the tenant's own subdomain plus the configured app host, never
    // the inbound Host header — see @/lib/origin.
    linkBase: `${tenantOrigin(tenant?.subdomain)}/enroll/${intake.slug}`,
    windowOpensAt: intake.priority_open_at
      ? formatWindowOpensAt(intake.priority_open_at)
      : "a date that has not been scheduled yet",
    // An unscheduled window is not an open one. Date.parse of a malformed
    // value is NaN, and every comparison against NaN is false, so a junk
    // timestamp lands on "not open yet" — the copy that is merely early rather
    // than the copy that is wrong.
    windowIsOpen: intake.priority_open_at
      ? Date.parse(intake.priority_open_at) <= now
      : false,
    coveredTiers,
    tenantName: tenant?.name ?? undefined,
    logoUrl: tenant?.logo_url ?? undefined,
  };
}

/** The columns rotateAndSend needs. `token_prefix` is read BEFORE rotating. */
export interface RotatableRow {
  id: string;
  name: string;
  email: string;
  token_prefix: string;
}

export type RotateAndSendOutcome =
  /** Rotated, committed, mailed. `supersededExpiresAt` is the grace end of the
   *  link this rotation displaced. */
  | { outcome: "SENT"; supersededExpiresAt: string }
  /** Rotated and committed, the send failed, the rotation was rolled back. */
  | { outcome: "SEND_FAILED" }
  /** The row vanished between the read and the rotation. Nothing written. */
  | { outcome: "NOT_FOUND" }
  /** rotate_interest_token said COOLDOWN. Unreachable at zero cooldown, kept so
   *  a future non-zero caller cannot mistake it for a fault. Nothing written. */
  | { outcome: "COOLDOWN" }
  /** The rotation itself errored. Nothing was sent. */
  | { outcome: "ROTATE_FAILED" };

/**
 * One row's rotation and send, in the only order that is safe.
 *
 * PERSIST, THEN SEND: the new token's hash is stored before the raw token is
 * put in an email, so a link that reaches an inbox always works. A failed send
 * costs a notification, never a credential.
 *
 * THE ROTATION DECISION HAPPENS UNDER THE ROW LOCK, INSIDE THE RPC, BEFORE ANY
 * MAIL GOES OUT — see 20260828120000_rotate_interest_token.sql. And a rotation
 * whose send failed is UNDONE rather than merely un-cooled, so two failed sends
 * cannot walk the token forward twice and strand the link already in the
 * recipient's inbox.
 *
 * Each database call here is its own transaction. That is a requirement, not an
 * accident: redeeming a priority token takes a FOR UPDATE lock on the same row
 * and holds it to commit, so a bulk caller must NOT wrap its rows in one
 * transaction — it would sit in front of every checkout for the event.
 */
export async function rotateAndSend(
  supabase: AdminClient,
  row: RotatableRow,
  ctx: InterestEmailContext,
  kind: "resend" | "reminder",
): Promise<RotateAndSendOutcome> {
  const minted = mintPriorityToken();

  const { data: rotated, error: rotateError } = await supabase.rpc(
    "rotate_interest_token",
    {
      p_interest_id: row.id,
      p_new_hash: minted.tokenHash,
      p_new_prefix: minted.tokenPrefix,
      p_grace: GRACE_INTERVAL,
      // The admin bypass. See NO_COOLDOWN above.
      p_cooldown: NO_COOLDOWN,
    } as never,
  );

  if (rotateError) {
    console.error("[admin/interest] rotation failed:", rotateError.message);
    return { outcome: "ROTATE_FAILED" };
  }
  if (rotated === "COOLDOWN") return { outcome: "COOLDOWN" };
  if (rotated === "NOT_FOUND") return { outcome: "NOT_FOUND" };
  if (rotated !== "ROTATED") {
    console.error("[admin/interest] rotation returned:", rotated);
    return { outcome: "ROTATE_FAILED" };
  }

  const link = `${ctx.linkBase}#pa=${minted.token}`;
  const { subject, html } =
    kind === "reminder"
      ? priorityWindowReminderEmail({
          name: row.name,
          eventName: ctx.intake.name,
          link,
          windowOpensAt: ctx.windowOpensAt,
          windowIsOpen: ctx.windowIsOpen,
          coveredTiers: ctx.coveredTiers,
          tenantName: ctx.tenantName,
          logoUrl: ctx.logoUrl,
        })
      : interestConfirmationEmail({
          name: row.name,
          eventName: ctx.intake.name,
          link,
          windowOpensAt: ctx.windowOpensAt,
          coveredTiers: ctx.coveredTiers,
          isResend: true,
          tenantName: ctx.tenantName,
          logoUrl: ctx.logoUrl,
        });

  // sendEmail returns false on failure and does not throw, so a mail outage
  // cannot unwind a token that is already persisted.
  const sent = await sendEmail({ to: row.email, subject, html });

  if (!sent) {
    await rollbackRotation(supabase, row, minted.tokenHash);
    return { outcome: "SEND_FAILED" };
  }

  // Read back only for the UI's benefit: the grace end of the link this
  // rotation displaced, which is what a "the old link is still live" warning
  // is built from. A failure here is not a failure of the send.
  const { data: after } = (await supabase
    .from("event_interest")
    .select("superseded_expires_at")
    .eq("id", row.id)
    .maybeSingle()) as { data: { superseded_expires_at: string | null } | null; error: unknown };

  return { outcome: "SENT", supersededExpiresAt: after?.superseded_expires_at ?? "" };
}

/**
 * Restores the token this attempt displaced, under the same row lock.
 *
 * The hash is a compare-and-swap: if another request rotated in the gap between
 * our rotation committing and our send failing, its credential is live and may
 * already be in an inbox, so the database refuses. The prefix must be supplied
 * because it cannot be derived from a hash — see the migration.
 */
async function rollbackRotation(
  supabase: AdminClient,
  row: RotatableRow,
  expectedHash: string,
): Promise<void> {
  const { data, error } = await supabase.rpc("rollback_interest_rotation", {
    p_interest_id: row.id,
    p_expected_hash: expectedHash,
    p_restore_prefix: row.token_prefix,
  } as never);

  if (error) {
    // The previous token stays live for its grace period — bounded and
    // self-healing, not a stuck state.
    console.error("[admin/interest] rotation rollback failed:", error.message);
    return;
  }

  if (data !== true) {
    console.warn(
      "[admin/interest] rotation rollback skipped: superseded by a concurrent rotation",
    );
  }
}

/**
 * Explicit components rather than dateStyle/timeStyle: Intl rejects combining
 * those with timeZoneName, and the zone has to be shown or the reader is left
 * guessing which clock the time is on.
 */
export function formatWindowOpensAt(iso: string): string {
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
