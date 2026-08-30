import { createAdminClient } from "@/lib/supabase/admin";
import { mintPriorityToken, type MintedToken } from "@/lib/interest/token";
import { interestConfirmationEmail, sendEmail } from "@/lib/email";

// ─── Interest signup and resend ─────────────────────────────────────────────
//
// Two invariants govern every path below. They are the reason this module
// exists at all instead of living in the route.
//
// 1. PERSIST, THEN SEND. No token is ever emailed whose hash is not already
//    stored, so a link that reaches an inbox always works. A failed send costs
//    a *notification*, never a credential. A failed write is reported as an
//    error, never as a false success. The mirror of this rule is that a
//    rotation whose send failed is ROLLED BACK: an operation that did not
//    complete leaves no durable effect.
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
// (v11) sections "Signup and resend", "Ordering: persist, then send", and
// "Rotation is serialized before the send, not after".

/**
 * How long the token displaced by a rotation stays usable.
 *
 * Chosen, not derived — the design (v10) records it as such. It has to outlast
 * a slow mail delivery, since the whole point is that a recipient reading
 * yesterday's mail is not stranded. Cheap to revisit against real traffic.
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
// two-limit structure (narrow: one event; broad: a script walking events); the
// numbers are chosen, not derived, and the design (v10) records them as such —
// meant to be tuned against real traffic. This is a cost and reputation control
// on Resend spend, not an authorization boundary: the address is
// attacker-influenced.
const RATE_LIMIT_WINDOW = "1 hour";
const RATE_LIMIT_PER_INTAKE = 3;
const RATE_LIMIT_GLOBAL = 10;

/** PostgreSQL unique_violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * What this module does NOT check, and the caller therefore must, before
 * calling. None of it is enforced here or by the schema on every branch:
 *
 * - `intakeId` belongs to `tenantId`. The lookup below is tenant-scoped and
 *   the insert is covered by the composite FK, so a mismatch fails closed —
 *   but it fails as an opaque write error, not as the clear rejection a public
 *   endpoint owes a caller.
 * - `priority_open_at` is set and still in the future. Signup closes when the
 *   window opens; otherwise anyone can mint themselves a head start at the
 *   moment it starts, which defeats the feature.
 * - The intake is neither closed nor cancelled.
 * - At least one tier still has a future `enrollment_open_at`. If everything
 *   is already on sale there is nothing to be early for.
 * - Length bounds on name, email and phone. The CHECKs will reject an
 *   over-long value, again as a write error rather than a 400.
 */
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

/**
 * The response a resend produces, and the one a throttled call is given.
 *
 * Frozen because it is returned by reference from several paths: an
 * accidental mutation anywhere would rewrite what every other caller sees.
 */
const GENERIC_SUCCESS: RegisterInterestResult = Object.freeze({
  ok: true,
  emailed: false,
});

/** The columns the repeat path needs, beyond knowing the row exists. */
interface ExistingRow {
  id: string;
  token_prefix: string;
  revoked_at: string | null;
}

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
  const lookup = await findExisting(supabase, input.tenantId, input.intakeId, email);
  if (lookup === "ERROR") return { ok: false, reason: "LOOKUP_FAILED" };

  const minted = mintPriorityToken();

  if (lookup) return resendExisting(supabase, input, email, name, lookup, minted);

  // ── 3. FIRST SIGNUP — write, then send ────────────────────────────────────
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
      // The first send is an attempt like any other, so the cooldown applies
      // from the moment the row exists. Left null, it would read null on a
      // brand-new row and an immediate resend would rotate and send again for
      // free — one free rotation per address per event, with the griefing
      // case landing at its most effective on the record just created. The
      // one legitimate reason to resend immediately, mail that did not
      // arrive, is already covered: the link is on screen and already valid.
      last_link_attempt_at: new Date().toISOString(),
    } as never)
    .select("id")
    .single();

  if (insertError || !inserted) {
    // A double-submitted form produces two calls that both saw no row. The
    // loser hits the unique index — but the signup did succeed, so reporting
    // an error would show a failure over a record that exists. Re-read and
    // take the repeat path, which will find the winner's fresh attempt stamp
    // and answer COOLDOWN.
    if (insertError?.code === UNIQUE_VIOLATION) {
      const retry = await findExisting(supabase, input.tenantId, input.intakeId, email);
      if (retry === "ERROR") return { ok: false, reason: "LOOKUP_FAILED" };
      if (retry) return resendExisting(supabase, input, email, name, retry, minted);
    }

    // Nothing was created, so nothing may be emailed and nothing may be
    // reported as success. The raw token dies here, unused.
    console.error("[registerInterest] insert failed:", insertError?.message);
    return { ok: false, reason: "WRITE_FAILED" };
  }

  const emailed = await sendInterestEmail(input, name, email, minted.token, false);

  if (emailed) await stampSent(supabase, (inserted as { id: string }).id);

  // The token is returned whether or not the mail went out: it is already
  // persisted, so the on-screen link works either way. `emailed: false` is
  // what lets the page say the mail did not go out and offer a resend.
  return { ok: true, emailed, token: minted.token };
}

// ─── The repeat path ────────────────────────────────────────────────────────

async function resendExisting(
  supabase: AdminClient,
  input: RegisterInterestInput,
  email: string,
  name: string,
  existing: ExistingRow,
  minted: MintedToken,
): Promise<RegisterInterestResult> {
  // A revoked record does not rotate. Rotating one would spend an email on a
  // link the gate refuses, and hand the recipient something that silently does
  // not work. Generic success, exactly like a cooldown.
  if (existing.revoked_at) return GENERIC_SUCCESS;

  const { data: rotated, error: rotateError } = await supabase.rpc(
    "rotate_interest_token",
    {
      p_interest_id: existing.id,
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

  const emailed = await sendInterestEmail(input, name, email, minted.token, true);

  if (emailed) {
    await stampSent(supabase, existing.id);
  } else {
    // The rotation is UNDONE, not merely un-cooled. Clearing the cooldown
    // alone would let a second failed send walk the token forward again, and
    // the original — the link actually sitting in the recipient's inbox —
    // would end up in neither slot while neither replacement was delivered.
    // Since sendEmail returns false rather than throwing whenever the provider
    // is unreachable or unconfigured, a mail outage makes that the normal path.
    await rollbackRotation(supabase, existing, minted.tokenHash);
  }

  // Never the token. The recipient gets the new link at the address on file;
  // the submitter gets only the acknowledgement.
  return { ok: true, emailed };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Returns the row, `null` when there is none, or `"ERROR"` when the read
 * itself failed — which must not be mistaken for "no row", since that would
 * send an insert straight into the unique index.
 *
 * Scoped to the tenant as well as the intake. Without that, a caller passing
 * another tenant's `intakeId` would find that tenant's record and rotate it,
 * mailing a fresh link to its owner and killing the live token they hold. The
 * first-signup branch is covered by the composite FK because it writes; this
 * branch writes nothing of its own, so no constraint is ever consulted. A
 * foreign intake now finds no row, falls through to the insert, and is
 * rejected by the FK — fail-closed on both branches.
 */
async function findExisting(
  supabase: AdminClient,
  tenantId: string,
  intakeId: string,
  email: string,
): Promise<ExistingRow | null | "ERROR"> {
  const { data, error } = await supabase
    .from("event_interest")
    .select("id, token_prefix, revoked_at")
    .eq("tenant_id", tenantId)
    .eq("intake_id", intakeId)
    .eq("email", email)
    .maybeSingle();

  if (error) {
    console.error("[registerInterest] lookup failed:", error.message);
    return "ERROR";
  }

  return (data as ExistingRow | null) ?? null;
}

async function sendInterestEmail(
  input: RegisterInterestInput,
  name: string,
  email: string,
  token: string,
  isResend: boolean,
): Promise<boolean> {
  const { subject, html } = interestConfirmationEmail({
    name,
    eventName: input.eventName,
    link: `${input.linkBase}#pa=${token}`,
    windowOpensAt: input.windowOpensAt,
    coveredTiers: input.coveredTiers,
    isResend,
    tenantName: input.tenantName,
    logoUrl: input.logoUrl,
  });

  // sendEmail returns false on failure and does not throw, so a mail outage
  // cannot unwind a token that is already persisted.
  return sendEmail({ to: email, subject, html });
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

/**
 * Restores the token this attempt displaced, under the same row lock.
 *
 * `expectedHash` is a compare-and-swap: if another request rotated in the gap
 * between our rotation committing and our send failing, its credential is live
 * and may already be in an inbox, so the database refuses and returns false.
 * The prefix has to be supplied because it cannot be derived from a hash —
 * see the migration.
 */
async function rollbackRotation(
  supabase: AdminClient,
  existing: ExistingRow,
  expectedHash: string,
): Promise<void> {
  const { data, error } = await supabase.rpc("rollback_interest_rotation", {
    p_interest_id: existing.id,
    p_expected_hash: expectedHash,
    p_restore_prefix: existing.token_prefix,
  } as never);

  if (error) {
    // The record is left in cooldown until it expires, and the previous token
    // stays live for its grace — bounded and self-healing, not a stuck state.
    console.error("[registerInterest] rotation rollback failed:", error.message);
    return;
  }

  if (data !== true) {
    // Lost the race. Someone else's rotation is current; undoing it is not
    // ours to do, and the user is not worse off — a live link exists either way.
    console.warn("[registerInterest] rotation rollback skipped: superseded by a concurrent rotation");
  }
}
