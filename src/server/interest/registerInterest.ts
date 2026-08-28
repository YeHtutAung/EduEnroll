import { createAdminClient } from "@/lib/supabase/admin";
import { mintPriorityToken } from "@/lib/interest/token";
import { interestConfirmationEmail, sendEmail } from "@/lib/email";

// ─── Interest signup and resend ─────────────────────────────────────────────
//
// Two invariants govern every path below. They are the reason this module
// exists at all instead of living in the route.
//
// 1. PERSIST, THEN SEND. No token is ever emailed whose hash is not already
//    stored, so a link that reaches an inbox always works. A failed send costs
//    a *notification*, never a credential. A failed write is reported as an
//    error, never as a false success.
//
// 2. THE ENTIRE ROTATION DECISION HAPPENS UNDER THE ROW LOCK, BEFORE ANY MAIL
//    IS SENT. Locking only the write is not enough: two concurrent resends
//    would both read the old row, both mint, and both send — duplicate mail,
//    the cooldown bypassed, and the first freshly-emailed link demoted to the
//    superseded slot of the second. The two-slot model holds exactly one
//    superseded credential, so the loser's promised grace period would simply
//    vanish. That whole decision therefore lives inside rotate_interest_token
//    (20260828120000_rotate_interest_token.sql), and the send happens only
//    after it has committed.
//
// This module contains no NextRequest/NextResponse: the route is a thin
// caller, and the ordering is tested here without HTTP.
//
// See docs/superpowers/specs/2026-08-26-event-interest-priority-window-design.md
// sections "Signup and resend", "Ordering: persist, then send", and "Rotation
// is serialized before the send, not after".

/**
 * How long the token displaced by a rotation stays usable.
 *
 * The design fixes the *shape* of the grace period, not its length; this value
 * is chosen here. It has to outlast a slow mail delivery, since the whole point
 * is that a recipient reading yesterday's mail is not stranded.
 */
const GRACE_INTERVAL = "24 hours";

/**
 * Minimum gap between resends for one record. The design proposes 15 minutes.
 * Evaluated against last_link_attempt_at — the attempt, not the successful
 * send — which is what makes a concurrent second request back off rather than
 * send a duplicate.
 */
const COOLDOWN_INTERVAL = "15 minutes";

// Signup rate limits, per pseudonymised client address. The design fixes the
// two-limit structure (narrow: one event; broad: a script walking events) but
// not the numbers, which are chosen here and are meant to be tuned against
// real traffic. This is a cost and reputation control on Resend spend, not an
// authorization boundary — the address is attacker-influenced.
const RATE_LIMIT_WINDOW = "1 hour";
const RATE_LIMIT_PER_INTAKE = 3;
const RATE_LIMIT_GLOBAL = 10;

export interface RegisterInterestInput {
  intakeId: string;
  tenantId: string;
  name: string;
  email: string;
  phone?: string | null;
  /** HMAC of the canonicalised client address — see @/lib/interest/ipHash. */
  ipHash: string;
  /**
   * Everything in the access link before the fragment, e.g.
   * `https://acme.kuunyi.com/enroll/summer-fest`. The token is appended as
   * `#pa=<token>`: a fragment is never sent to the server, so it stays out of
   * request logs, Referer headers, and server-side analytics.
   */
  linkBase: string;
  eventName: string;
  /** Already formatted for display. This module does not format times. */
  windowOpensAt: string;
  /** The tiers the head start actually covers. */
  coveredTiers: string[];
  tenantName?: string;
  logoUrl?: string;
}

export type RegisterInterestFailure =
  | "RATE_LIMITER_UNAVAILABLE"
  | "LOOKUP_FAILED"
  | "WRITE_FAILED"
  | "ROTATE_FAILED";

export type RegisterInterestResult =
  | {
      ok: true;
      emailed: boolean;
      /**
       * Present ONLY on a first signup, where the submitter has just
       * demonstrated they are the person enrolling. Never on a repeat:
       * echoing it would let anyone harvest another person's link by typing
       * their address into the public form.
       */
      token?: string;
    }
  | { ok: false; reason: RegisterInterestFailure };

/** The response a resend produces, and the one a throttled call is given. */
const GENERIC_SUCCESS: RegisterInterestResult = { ok: true, emailed: false };

export async function registerInterest(
  input: RegisterInterestInput,
): Promise<RegisterInterestResult> {
  // Normalised before both the lookup and the insert. event_interest carries
  // CHECK (email = lower(btrim(email))) and a UNIQUE (intake_id, email) with no
  // lower() wrapper, so application-side normalisation and database truth
  // cannot drift: a miss here surfaces as a constraint violation, not as
  // duplicate rows nobody notices.
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  const rawPhone = typeof input.phone === "string" ? input.phone.trim() : null;
  const phone = rawPhone ? rawPhone : null;

  const supabase = createAdminClient();

  // ── 1. Rate limit, before any write and any send ──────────────────────────
  // One serialized database call: the check and the slot consumption are a
  // single operation under an advisory lock, because a count-then-insert from
  // here would let concurrent requests from one address each observe capacity
  // and all send.
  const { data: allowed, error: limitError } = await supabase.rpc(
    "consume_interest_signup_slot",
    {
      p_intake_id: input.intakeId,
      p_ip_hash: input.ipHash,
      p_per_intake_limit: RATE_LIMIT_PER_INTAKE,
      p_global_limit: RATE_LIMIT_GLOBAL,
      p_window: RATE_LIMIT_WINDOW,
    } as never,
  );

  if (limitError) {
    // Deliberately not treated as "throttled" and not treated as "allowed".
    // Failing open would defeat the limiter on exactly the fault an attacker
    // can provoke; reporting generic success would swallow a legitimate signup
    // in silence. The caller gets a retryable error instead.
    console.error("[registerInterest] rate limiter unavailable:", limitError.message);
    return { ok: false, reason: "RATE_LIMITER_UNAVAILABLE" };
  }

  if (allowed !== true) {
    // The same shape a permitted resend returns. Telling a script when it has
    // been throttled only helps it calibrate, so nothing here distinguishes
    // this from a real call — no flag, no separate reason code.
    return GENERIC_SUCCESS;
  }

  // ── 2. Existing record for this address on this event? ────────────────────
  const { data: existing, error: lookupError } = await supabase
    .from("event_interest")
    .select("id")
    .eq("intake_id", input.intakeId)
    .eq("email", email)
    .maybeSingle();

  if (lookupError) {
    // Guessing "first signup" here would send an insert straight into the
    // unique index, so the failure is reported rather than converted into a
    // confusing write error.
    console.error("[registerInterest] lookup failed:", lookupError.message);
    return { ok: false, reason: "LOOKUP_FAILED" };
  }

  const minted = mintPriorityToken();
  const link = `${input.linkBase}#pa=${minted.token}`;

  if (!existing) {
    // ── 3. FIRST SIGNUP — write, then send ──────────────────────────────────
    const { data: inserted, error: insertError } = await supabase
      .from("event_interest")
      .insert({
        tenant_id: input.tenantId,
        intake_id: input.intakeId,
        name,
        email,
        phone,
        token_hash: minted.tokenHash,
        token_prefix: minted.tokenPrefix,
      } as never)
      .select("id")
      .single();

    if (insertError || !inserted) {
      // Nothing was created, so nothing may be emailed and nothing may be
      // reported as success. The raw token dies here, unused.
      console.error("[registerInterest] insert failed:", insertError?.message);
      return { ok: false, reason: "WRITE_FAILED" };
    }

    const emailed = await sendInterestEmail(input, link, false);

    if (emailed) await stampSent(supabase, (inserted as { id: string }).id);

    // The token is returned whether or not the mail went out: it is already
    // persisted, so the on-screen link works either way. `emailed: false` is
    // what lets the page say the mail did not go out and offer a resend.
    return { ok: true, emailed, token: minted.token };
  }

  // ── 4. REPEAT SIGNUP — rotate under the lock, then send ───────────────────
  const existingId = (existing as { id: string }).id;

  const { data: rotated, error: rotateError } = await supabase.rpc(
    "rotate_interest_token",
    {
      p_interest_id: existingId,
      p_new_hash: minted.tokenHash,
      p_new_prefix: minted.tokenPrefix,
      p_grace: GRACE_INTERVAL,
      p_cooldown: COOLDOWN_INTERVAL,
    } as never,
  );

  if (rotateError) {
    console.error("[registerInterest] rotation failed:", rotateError.message);
    return { ok: false, reason: "ROTATE_FAILED" };
  }

  if (rotated === "COOLDOWN") {
    // Nothing was written and nothing minted was stored, so nothing may be
    // sent. Indistinguishable from a successful resend by design.
    return GENERIC_SUCCESS;
  }

  if (rotated !== "ROTATED") {
    // 'NOT_FOUND' — the row was located moments ago, so it was deleted (or its
    // intake cascaded) in between. Nothing was written and nothing was sent;
    // claiming a link is on its way would be a false success.
    console.error("[registerInterest] rotation returned:", rotated);
    return { ok: false, reason: "ROTATE_FAILED" };
  }

  const emailed = await sendInterestEmail(input, link, true);

  if (emailed) {
    await stampSent(supabase, existingId);
  } else {
    // The cooldown is stamped by the rotation, before the send. Clearing the
    // attempt on failure is what makes a retry immediate instead of leaving
    // the record locked out for the whole cooldown over mail that never
    // arrived. If the process dies before this runs, the record is simply in
    // cooldown until it expires — bounded and self-healing.
    await clearAttempt(supabase, existingId);
  }

  // Never the token. The recipient gets the new link at the address on file;
  // the submitter gets only the acknowledgement.
  return { ok: true, emailed };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

type AdminClient = ReturnType<typeof createAdminClient>;

async function sendInterestEmail(
  input: RegisterInterestInput,
  link: string,
  isResend: boolean,
): Promise<boolean> {
  const { subject, html } = interestConfirmationEmail({
    name: input.name.trim(),
    eventName: input.eventName,
    link,
    windowOpensAt: input.windowOpensAt,
    coveredTiers: input.coveredTiers,
    isResend,
    tenantName: input.tenantName,
    logoUrl: input.logoUrl,
  });

  // sendEmail returns false on failure and does not throw, so a mail outage
  // cannot unwind a token that is already persisted.
  return sendEmail({ to: input.email.trim().toLowerCase(), subject, html });
}

async function stampSent(supabase: AdminClient, id: string): Promise<void> {
  const { error } = await supabase
    .from("event_interest")
    .update({ last_link_sent_at: new Date().toISOString() } as never)
    .eq("id", id);

  // Bookkeeping only: the link is already delivered and already valid, so a
  // failure here must not turn a successful send into a reported failure.
  if (error) console.error("[registerInterest] stamping the send failed:", error.message);
}

async function clearAttempt(supabase: AdminClient, id: string): Promise<void> {
  const { error } = await supabase
    .from("event_interest")
    .update({ last_link_attempt_at: null } as never)
    .eq("id", id);

  if (error) console.error("[registerInterest] clearing the attempt failed:", error.message);
}
